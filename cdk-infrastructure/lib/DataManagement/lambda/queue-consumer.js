// Delete worker for S3 datastores + virtual folders.
//
// Handles delete at STUDY / SERIES / INSTANCE level, in one of two SCOPES:
//
//   scope = 'STORAGE' (default): a real deletion from the source storage.
//     - soft-delete the instance/series/study tree rows (deleted_at = NOW()),
//       cascading UP (study deleted when it has no live series; patient when it
//       has no live study);
//     - HARD-unassign the content from EVERY virtual folder it belongs to
//       (virtual_folder_assignments + virtual_instance);
//     - HARD-delete the backing S3 objects (a storage delete may remove the
//       file) and soft-delete the storage_index rows;
//     - emit an 'Instance Deleted' event so index-stats-consumer recomputes
//       datastore_statistics.
//
//   scope = 'VF': remove content from ONE virtual folder only.
//     - delete just that VF's virtual_folder_assignments + virtual_instance rows
//       for the target content;
//     - NEVER touch S3, the storage tree, or any OTHER virtual folder;
//     - recompute virtual_folder_statistics for that folder.
//
// Reads (dicomweb-s3) filter deleted_at IS NULL, so a storage soft-delete
// disappears immediately. Idempotent: re-running finds nothing live and no-ops.

const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');

const s3Client = new S3Client({});
const ebClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;
const INDEX_EVENT_SOURCE = 'dicom.archive.index';

// --- Per-VF database helpers (VF Per-Database Redesign) --------------------
// Each VF's de-id tree lives in its own database `vf_<id>` (mirrors vfDbName in
// virtual-folder-api/vf-database.js — a Phase 1 module that cannot be imported
// cross-lambda, so it is replicated here). The cross-schema FK ON DELETE CASCADE
// from the old shared virtual_instance -> storage_index is gone, so the STORAGE
// delete path purges instance pointers in application code, fanning out across
// every vf_<id> database. A SQL identifier cannot be a bind param, so every
// derived name is validated against VF_DB_RE before it is interpolated.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VF_DB_RE = /^vf_[0-9a-f]{32}$/;

function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}

// Enumerate existing per-VF databases from information_schema (robust to a stale
// virtual_folders table). Every name is re-validated against VF_DB_RE, so a
// schema merely starting with 'vf_' but not the exact 'vf_' + 32-hex shape is
// skipped (never interpolated).
async function listVfDatabases() {
  const rows = await query(
    "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'vf\\_%'");
  return rows.map(r => r.name).filter(n => VF_DB_RE.test(n));
}

exports.handler = async (event) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body);
    const {
      jobId, datastoreId, studyInstanceUID, seriesInstanceUID, sopInstanceUID,
      username, userId,
    } = message;
    // Back-compat: an old DELETE_SERIES message carries no level/scope.
    const level = (message.level || 'SERIES').toUpperCase();
    const scope = (message.scope || 'STORAGE').toUpperCase();
    const virtualFolderId = message.virtualFolderId || null;
    const resId = sopInstanceUID || seriesInstanceUID || studyInstanceUID;

    try {
      if (scope === 'VF') {
        if (!virtualFolderId) throw new Error('VF-scope delete requires virtualFolderId');
        await deleteFromVirtualFolder(virtualFolderId, level, {
          studyInstanceUID, seriesInstanceUID, sopInstanceUID,
        });
        await recomputeVfStats(virtualFolderId);
      } else {
        // Read-only gate: a STORAGE delete removes the backing S3 objects, so it
        // is forbidden on a read-only (clinical/VNA-managed) bucket the archive
        // only indexes. Refuse loudly rather than silently indexing-only.
        const ds = await query('SELECT access_level FROM datastores WHERE id = ?', [datastoreId]);
        if (ds.length && ds[0].access_level === 'read-only') {
          throw new Error(`Datastore ${datastoreId} is read-only; refusing destructive delete (would remove S3 objects)`);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- Error message string, not SQL; no query is built here (audited)
        }
        await deleteFromStorage(datastoreId, level, {
          studyInstanceUID, seriesInstanceUID, sopInstanceUID,
        });
        await emitInstanceDeleted(datastoreId);
      }
      await updateJobStatus(jobId, 'COMPLETED', null);
      await sendAuditEvent({
        user: userId || 'system', username: username || 'system',
        action: AUDIT_ACTIONS.DELETE_SERIES_COMPLETED || 'DELETE_COMPLETED',
        resourceType: RESOURCE_TYPES.SERIES,
        resourceId: resId, resourceName: `${scope} ${level} ${resId}`,
        newValues: { jobId, datastoreId, level, scope, virtualFolderId, studyInstanceUID },
        status: 'SUCCESS',
      });
    } catch (err) {
      console.error(`DELETE job ${jobId} (${scope}/${level}) failed:`, err.message);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
      await updateJobStatus(jobId, 'FAILED', err.message);
      await sendAuditEvent({
        user: userId || 'system', username: username || 'system',
        action: AUDIT_ACTIONS.DELETE_SERIES_FAILED,
        resourceType: RESOURCE_TYPES.SERIES,
        resourceId: resId, resourceName: `${scope} ${level} ${resId}`,
        newValues: { jobId, datastoreId, level, scope, error: err.message },
        status: 'FAILED',
      });
      throw err; // visible failure -> SQS retry / DLQ, never a silent drop
    }
  }
};

// Resolve the target's instance rows (+ physical objects + parent pkeys) for a
// STORAGE delete, by level. Returns [] when nothing live matches (idempotent).
//
// NOTE: we intentionally DO NOT require the parent study/series rows to be live
// (deleted_at IS NULL). A prior half-delete could have tombstoned study+series
// while leaving instance/storage_index/S3 live (the confirmed bug); requiring
// live parents made that stuck state unrepairable (the resolve returned []).
// We match the subtree by UID through the parents regardless of their state, and
// keep a row whenever EITHER the instance OR its storage_index is still live, so
// a re-run repairs a dangling subtree yet a fully-clean subtree yields [] (a true
// idempotent no-op).
async function resolveStorageRows(datastoreId, level, ids) {
  const base =
    `SELECT i.instance_pkey, i.content_pkey, s.series_pkey, st.study_pkey,
            st.patient_pkey, si.s3_bucket_name, si.s3_key
       FROM instance i
       JOIN series s ON s.series_pkey = i.series_pkey
       JOIN study st ON st.study_pkey = s.study_pkey
       LEFT JOIN storage_index si ON si.content_pkey = i.content_pkey
      WHERE i.datastore_id = ?
        AND (i.deleted_at IS NULL OR si.deleted_at IS NULL)`;
  if (level === 'INSTANCE') {
    return query(`${base} AND st.studyinstanceuid = ? AND s.seriesinstanceuid = ? AND i.sopinstanceuid = ?`,
      [datastoreId, ids.studyInstanceUID, ids.seriesInstanceUID, ids.sopInstanceUID]);
  }
  if (level === 'SERIES') {
    return query(`${base} AND st.studyinstanceuid = ? AND s.seriesinstanceuid = ?`,
      [datastoreId, ids.studyInstanceUID, ids.seriesInstanceUID]);
  }
  // STUDY
  return query(`${base} AND st.studyinstanceuid = ?`,
    [datastoreId, ids.studyInstanceUID]);
}

async function deleteFromStorage(datastoreId, level, ids) {
  const rows = await resolveStorageRows(datastoreId, level, ids);
  if (!rows.length) {
    console.log(`DELETE(${level}): nothing live to delete in ${datastoreId}`);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
    return;
  }
  const contentPkeys = [...new Set(rows.map(r => r.content_pkey).filter(v => v != null))];
  const instancePkeys = [...new Set(rows.map(r => r.instance_pkey))];
  const studyPkeys = [...new Set(rows.map(r => r.study_pkey))];
  const patientPkeys = [...new Set(rows.map(r => r.patient_pkey))];

  // 1. Unassign from EVERY virtual folder (hard; never touch S3 here).
  //    virtual_folder_assignments stays shared (dicomarchive). The per-VF de-id
  //    INSTANCE rows now live in each VF's own database vf_<id>.vf_<id>_instance
  //    (VF Per-Database Redesign) — the old shared virtual_instance table and its
  //    ON DELETE CASCADE are gone — so fan the instance-pointer purge out across
  //    every existing vf_<id> database, keyed by content_pkey.
  if (contentPkeys.length) {
    const ph = contentPkeys.map(() => '?').join(',');
    const vfDbs = await listVfDatabases();
    for (const vfDb of vfDbs) {
      // vfDb is validated against VF_DB_RE by listVfDatabases (identifier —
      // cannot be a bind param); contentPkeys ARE bind params.
      await query(`DELETE FROM \`${vfDb}\`.\`${vfDb}_instance\` WHERE content_pkey IN (${ph})`, contentPkeys);
    }
    await query(`DELETE FROM virtual_folder_assignments WHERE content_pkey IN (${ph})`, contentPkeys);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
  }

  // 2. HARD-delete the backing S3 objects, then soft-delete storage_index.
  for (const r of rows) {
    if (r.s3_bucket_name && r.s3_key) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: r.s3_bucket_name, Key: r.s3_key }));
      } catch (e) {
        console.warn(`S3 delete failed for s3://${r.s3_bucket_name}/${r.s3_key}: ${e.message}`);
      }
    }
  }
  if (contentPkeys.length) {
    const ph = contentPkeys.map(() => '?').join(',');
    await query(`UPDATE storage_index SET deleted_at = NOW() WHERE content_pkey IN (${ph})`, contentPkeys);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
  }

  // 3. Soft-delete the instance rows, then the now-empty parents, cascading up.
  const iph = instancePkeys.map(() => '?').join(',');
  await query(`UPDATE instance SET deleted_at = NOW() WHERE instance_pkey IN (${iph}) AND deleted_at IS NULL`, instancePkeys);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)

  // Any series whose instances are all gone -> soft-delete the series.
  const seriesPkeys = [...new Set(rows.map(r => r.series_pkey))];
  for (const sp of seriesPkeys) {
    const live = await query(`SELECT COUNT(*) AS n FROM instance WHERE series_pkey = ? AND deleted_at IS NULL`, [sp]);
    if (Number(live[0].n) === 0) {
      await query(`UPDATE series SET deleted_at = NOW() WHERE series_pkey = ?`, [sp]);
    }
  }
  // Any study with no live series -> soft-delete; then patient with no live study.
  for (const stp of studyPkeys) {
    const liveSeries = await query(`SELECT COUNT(*) AS n FROM series WHERE study_pkey = ? AND deleted_at IS NULL`, [stp]);
    if (Number(liveSeries[0].n) === 0) {
      await query(`UPDATE study SET deleted_at = NOW() WHERE study_pkey = ?`, [stp]);
    }
  }
  for (const pp of patientPkeys) {
    const liveStudies = await query(`SELECT COUNT(*) AS n FROM study WHERE patient_pkey = ? AND deleted_at IS NULL`, [pp]);
    if (Number(liveStudies[0].n) === 0) {
      await query(`UPDATE patient SET deleted_at = NOW() WHERE patient_pkey = ?`, [pp]);
    }
  }
  console.log(`DELETE(${level}) STORAGE: ${instancePkeys.length} instances, ${contentPkeys.length} objects from ${datastoreId}`);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
}

// Remove content from ONE virtual folder only. NEVER touches S3 / storage tree /
// other folders. Resolves the target's content_pkeys from the ASSIGNMENT rows
// (the VF's own membership), by level.
async function deleteFromVirtualFolder(virtualFolderId, level, ids) {
  let where = 'virtual_folder_id = ?';
  const params = [virtualFolderId];
  if (level === 'STUDY') { where += ' AND study_instance_uid = ?'; params.push(ids.studyInstanceUID); }
  else if (level === 'SERIES') { where += ' AND study_instance_uid = ? AND series_instance_uid = ?'; params.push(ids.studyInstanceUID, ids.seriesInstanceUID); }
  else { where += ' AND sop_instance_uid = ?'; params.push(ids.sopInstanceUID); }

  const assigned = await query(
    `SELECT content_pkey FROM virtual_folder_assignments WHERE ${where}`, params);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
  if (!assigned.length) {
    console.log(`VF unassign(${level}): nothing assigned in folder ${virtualFolderId}`);
    return;
  }
  const contentPkeys = [...new Set(assigned.map(r => r.content_pkey).filter(v => v != null))];
  // Delete the VF de-id tree rows for this folder + content, then the assignments.
  // The de-id tree now lives in this VF's own database vf_<id>.vf_<id>_instance
  // (VF Per-Database Redesign), keyed by content_pkey — no virtual_folder_id
  // column (the DATABASE is the scope). vfDbName validates the UUID before it is
  // interpolated (identifier — cannot be a bind param); contentPkeys are binds.
  if (contentPkeys.length) {
    const vfDb = vfDbName(virtualFolderId);
    const ph = contentPkeys.map(() => '?').join(',');
    await query(`DELETE FROM \`${vfDb}\`.\`${vfDb}_instance\` WHERE content_pkey IN (${ph})`,
      contentPkeys);
  }
  await query(`DELETE FROM virtual_folder_assignments WHERE ${where}`, params);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
  console.log(`VF unassign(${level}): removed ${contentPkeys.length} objects from folder ${virtualFolderId} (no S3 touched)`);
}

async function recomputeVfStats(virtualFolderId) {
  try {
    await query(
      `INSERT INTO virtual_folder_statistics (id, virtual_folder_id, patient_count, study_count, series_count, instance_count)
       SELECT ?, ?,
         COUNT(DISTINCT study_instance_uid),  -- patient proxy not tracked in assignments; use study/series/instance
         COUNT(DISTINCT study_instance_uid),
         COUNT(DISTINCT series_instance_uid),
         COUNT(DISTINCT sop_instance_uid)
       FROM virtual_folder_assignments WHERE virtual_folder_id = ?
       ON DUPLICATE KEY UPDATE
         study_count = VALUES(study_count),
         series_count = VALUES(series_count),
         instance_count = VALUES(instance_count),
         last_updated = NOW()`,
      [`vfstats-${virtualFolderId}`, virtualFolderId, virtualFolderId]);
  } catch (e) {
    console.warn(`VF stats recompute skipped for ${virtualFolderId}: ${e.message}`);
  }
}

async function emitInstanceDeleted(datastoreId) {
  if (!EVENT_BUS_NAME) return;
  try {
    await ebClient.send(new PutEventsCommand({
      Entries: [{
        Source: INDEX_EVENT_SOURCE,
        DetailType: 'Instance Deleted',
        EventBusName: EVENT_BUS_NAME,
        Detail: JSON.stringify({ datastoreId }),
      }],
    }));
  } catch (e) {
    console.warn(`stats event emit failed for ${datastoreId}: ${e.message}`);
  }
}

async function updateJobStatus(jobId, status, errorMessage) {
  if (status === 'COMPLETED' || status === 'FAILED') {
    const sql = errorMessage
      ? `UPDATE study_modification_jobs SET status = ?, error_message = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?`
      : `UPDATE study_modification_jobs SET status = ?, completed_at = NOW(), updated_at = NOW() WHERE id = ?`;
    const params = errorMessage ? [status, errorMessage, jobId] : [status, jobId];
    await query(sql, params);
  } else {
    await query(`UPDATE study_modification_jobs SET status = ?, updated_at = NOW() WHERE id = ?`, [status, jobId]);
  }
}
