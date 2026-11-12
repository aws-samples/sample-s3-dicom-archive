/**
 * PHI notice: this module handles Protected Health Information (patient name, ID,
 * birth date, sex, accession number and other DICOM identifiers). Deployers are
 * responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
 * responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
 */
const { query } = require('/opt/nodejs/database');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');

const sqsClient = new SQSClient({});
const INDEXER_QUEUE_URL = process.env.INDEXER_QUEUE_URL;
const VF_DEID_QUEUE_URL = process.env.VF_DEID_QUEUE_URL;

// Per-VF de-id tree lives in its OWN database `vf_<sanitized-uuid>` (tables
// vf_<db>_patient/study/series/instance) — the shared virtual_* tables were
// retired. Naming is identical to virtual-folder-api/vf-database.js vfDbName and
// dicomweb-s3 vf_db_name: 'vf_' + lowercased-uuid with hyphens stripped. The db
// name is derived ONLY from a validated UUID and re-asserted before it is
// interpolated into SQL, so user input never reaches the SQL text.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}
// Fully-qualified, backtick-quoted VF tree table: `vf_x`.`vf_x_study`.
function vfTable(vfDb, leaf) {
  if (!/^vf_[0-9a-f]{32}$/.test(vfDb)) {
    throw new Error(`Refusing to interpolate unexpected vf-db name: ${vfDb}`);
  }
  return `\`${vfDb}\`.\`${vfDb}_${leaf}\``;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
};

function checkDatastoreAccess(datastorePrivileges, datastoreId, requiredAccess) {
  if (!datastorePrivileges) return false;
  const priv = datastorePrivileges.find(p => p.datastoreId === datastoreId || p.datastoreId === '*'); // nosec - intentional wildcard for admin "All Datastores" privilege
  return priv && priv[requiredAccess];
}

function checkVirtualFolderAccess(virtualFolderPrivileges, virtualFolderId, requiredAccess) {
  if (!virtualFolderPrivileges) return false;
  const priv = virtualFolderPrivileges.find(p => p.virtualFolderId === virtualFolderId || p.virtualFolderId === '*'); // nosec - intentional wildcard for admin "All Virtual Folders" privilege
  return priv && priv[requiredAccess];
}

// Emit one per-series de-id message to the standalone VF de-id module's queue for
// each (VF, series) touched by a manual assign. The vf-deid-consumer reads the
// series' originals, applies the VF de-id profile, and upserts virtual_* with
// ONLY swapped values (per-series, atomic). Source-agnostic: the rule path emits
// the same message shape from vf-assign-consumer. Best-effort: a send failure is
// logged, not fatal (the assignment rows are already committed).
async function enqueueVfDeid(virtualFolderId, datastoreId, seriesUnits) {
  if (!VF_DEID_QUEUE_URL) {
    console.warn('VF_DEID_QUEUE_URL not set; VF de-id tree will not be built after assign');
    return;
  }
  // seriesUnits: array of { seriesUid, studyUid } (deduped by caller).
  for (const u of seriesUnits) {
    try {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: VF_DEID_QUEUE_URL,
        MessageBody: JSON.stringify({
          op: 'deid',
          virtual_folder_id: virtualFolderId,
          datastore_id: datastoreId,
          series_instance_uid: u.seriesUid,
          study_instance_uid: u.studyUid,
        }),
      }));
    } catch (e) {
      console.error(`VF de-id enqueue failed (series=${u.seriesUid}):`, e.message);
    }
  }
}

// Assign a study (all series) to a virtual folder
async function assignStudy(event) {
  const { virtualFolderId, studyInstanceUid, datastoreId } = JSON.parse(event.body);

  if (!virtualFolderId || !studyInstanceUid || !datastoreId) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'virtualFolderId, studyInstanceUid, and datastoreId required' } }) };
  }

  // Check privileges
  const datastorePrivileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]');
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');

  if (!checkDatastoreAccess(datastorePrivileges, datastoreId, 'canRead')) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'No read access to source datastore' } }) };
  }

  if (!checkVirtualFolderAccess(virtualFolderPrivileges, virtualFolderId, 'canStore')) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'No write access to virtual folder' } }) };
  }

  // Get virtual folder
  const [vf] = await query('SELECT * FROM virtual_folders WHERE id = ? AND deleted = FALSE', [virtualFolderId]);
  if (!vf) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Virtual folder not found' } }) };
  }

  // s3-only: the legacy per-datastore imaging id column is gone. Confirm the datastore exists.
  const [ds] = await query('SELECT id FROM datastores WHERE id = ?', [datastoreId]);
  if (!ds) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Datastore not found' } }) };
  }

  // S3-only: resolve the study's physical files (storage_index content_pkey) via
  // the DICOMweb query tree, then insert them directly as VF-index membership
  // rows. Replaces the legacy path (query the removed `imagesets` table + push
  // per-imageset SQS messages to the indexer).
  const rows = await query(
    `SELECT DISTINCT i.content_pkey, i.datastore_id,
            st.studyinstanceuid, se.seriesinstanceuid AS series_uid, i.sopinstanceuid AS sop_uid
     FROM study st
     JOIN series se ON se.study_pkey = st.study_pkey AND se.deleted_at IS NULL
     JOIN instance i ON i.series_pkey = se.series_pkey AND i.deleted_at IS NULL
     WHERE st.datastore_id = ? AND st.studyinstanceuid = ? AND st.deleted_at IS NULL
       AND i.content_pkey IS NOT NULL`,
    [datastoreId, studyInstanceUid]
  );

  if (rows.length === 0) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'No indexed instances found for study' } }) };
  }

  // Insert membership rows (idempotent on the unique (virtual_folder_id, content_pkey)).
  let assigned = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO virtual_folder_assignments
         (virtual_folder_id, datastore_id, content_pkey, study_instance_uid, series_instance_uid, sop_instance_uid)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE datastore_id = VALUES(datastore_id)`,
      [virtualFolderId, r.datastore_id, r.content_pkey, r.studyinstanceuid, r.series_uid, r.sop_uid]
    );
    assigned++;
  }

  const username = event.requestContext?.authorizer?.username || 'system';
  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username,
    action: AUDIT_ACTIONS.ASSIGN_STUDY_TO_VIRTUAL_FOLDER,
    resourceType: RESOURCE_TYPES.VIRTUAL_FOLDER_ASSIGNMENT,
    resourceId: virtualFolderId,
    resourceName: vf.name,
    newValues: { virtualFolderId, virtualFolderName: vf.name, studyInstanceUid, datastoreId, instancesAssigned: assigned },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  // Hydrate the de-id tree (virtual_*) from the new assignments so the folder's
  // de-id profile is applied — without this the VF content view falls back to
  // the shared source tree and leaks original demographics.
  const seriesUnits = [...new Map(
    rows.map(r => [r.series_uid, { seriesUid: r.series_uid, studyUid: r.studyinstanceuid }])
  ).values()];
  await enqueueVfDeid(virtualFolderId, datastoreId, seriesUnits);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        instancesAssigned: assigned
      }
    })
  };
}

// Assign a series to a virtual folder
async function assignSeries(event) {
  const { virtualFolderId, seriesInstanceUid, datastoreId, imagesetId } = JSON.parse(event.body);

  if (!virtualFolderId || !seriesInstanceUid || !datastoreId) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'virtualFolderId, seriesInstanceUid, and datastoreId required' } }) };
  }

  // Check privileges
  const datastorePrivileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]');
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');

  if (!checkDatastoreAccess(datastorePrivileges, datastoreId, 'canRead')) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'No read access to source datastore' } }) };
  }

  if (!checkVirtualFolderAccess(virtualFolderPrivileges, virtualFolderId, 'canStore')) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'No write access to virtual folder' } }) };
  }

  // Get virtual folder
  const [vf] = await query('SELECT * FROM virtual_folders WHERE id = ? AND deleted = FALSE', [virtualFolderId]);
  if (!vf) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Virtual folder not found' } }) };
  }

  // s3-only: the legacy per-datastore imaging id column is gone. Confirm the datastore exists.
  const [ds] = await query('SELECT id FROM datastores WHERE id = ?', [datastoreId]);
  if (!ds) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Datastore not found' } }) };
  }

  // S3-only: resolve the series' physical files via the query tree and insert
  // membership rows directly (replaces the legacy imagesetId SQS push).
  const rows = await query(
    `SELECT DISTINCT i.content_pkey, i.datastore_id,
            st.studyinstanceuid, se.seriesinstanceuid AS series_uid, i.sopinstanceuid AS sop_uid
     FROM series se
     JOIN study st ON st.study_pkey = se.study_pkey
     JOIN instance i ON i.series_pkey = se.series_pkey AND i.deleted_at IS NULL
     WHERE se.datastore_id = ? AND se.seriesinstanceuid = ? AND se.deleted_at IS NULL
       AND i.content_pkey IS NOT NULL`,
    [datastoreId, seriesInstanceUid]
  );

  if (rows.length === 0) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'No indexed instances found for series' } }) };
  }

  let assigned = 0;
  for (const r of rows) {
    await query(
      `INSERT INTO virtual_folder_assignments
         (virtual_folder_id, datastore_id, content_pkey, study_instance_uid, series_instance_uid, sop_instance_uid)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE datastore_id = VALUES(datastore_id)`,
      [virtualFolderId, r.datastore_id, r.content_pkey, r.studyinstanceuid, r.series_uid, r.sop_uid]
    );
    assigned++;
  }

  const username = event.requestContext?.authorizer?.username || 'system';
  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username,
    action: AUDIT_ACTIONS.ASSIGN_SERIES_TO_VIRTUAL_FOLDER,
    resourceType: RESOURCE_TYPES.VIRTUAL_FOLDER_ASSIGNMENT,
    resourceId: virtualFolderId,
    resourceName: vf.name,
    newValues: { seriesInstanceUid, datastoreId, instancesAssigned: assigned },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  // Hydrate the de-id tree (virtual_*) so the folder's de-id profile is applied.
  await enqueueVfDeid(virtualFolderId, datastoreId, [
    { seriesUid: seriesInstanceUid, studyUid: rows[0]?.studyinstanceuid }
  ]);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        instancesAssigned: assigned
      }
    })
  };
}

// Get assignments for a virtual folder
async function getAssignments(event) {
  const { id } = event.pathParameters;

  // F24: require canRead membership on THIS virtual folder before returning its
  // studies. Without this, a user with access to ANY VF — or a data user — could
  // read another folder's patient/study attributes by naming its id.
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  if (!checkVirtualFolderAccess(virtualFolderPrivileges, id, 'canRead')) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Virtual folder not found' } }) };
  }

  // The de-id tree lives in this VF's OWN database (vf_<id>); the database is
  // the scope, so there is no virtual_folder_id predicate. If the VF has no
  // assignments yet the tree db/tables may not exist -> return an empty list.
  const vfDb = vfDbName(id);
  let studies = [];
  try {
    studies = await query(
      `SELECT
        vs.study_pkey,
        vs.studyinstanceuid,
        vs.studydate,
        vs.studytime,
        vs.studydescription,
        vs.modalitiesinstudy,
        vs.numberofstudyrelatedseries,
        vs.numberofstudyrelatedinstances,
        vp.patientid,
        vp.patientname
       FROM ${vfTable(vfDb, 'study')} vs
       LEFT JOIN ${vfTable(vfDb, 'patient')} vp ON vs.patient_pkey = vp.patient_pkey
       ORDER BY vs.studydate DESC, vs.studytime DESC`,
      []
    );
  } catch (e) {
    // ER_NO_SUCH_TABLE / ER_BAD_DB_ERROR: VF has no hydrated tree yet.
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_DB_ERROR' || e.errno === 1146 || e.errno === 1049)) {
      studies = [];
    } else {
      throw e;
    }
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: studies
    })
  };
}

// Get a folder's studies (de-identified values only)
async function getStudies(event) {
  const { id } = event.pathParameters;
  const queryParams = event.queryStringParameters || {};

  // F24: require canRead membership on THIS virtual folder.
  // Security: the folder tree no longer stores original identifiers, so this
  // returns de-identified values only and `searchOriginal` is no longer
  // supported (searching by original values is done on the source storage).
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  if (!checkVirtualFolderAccess(virtualFolderPrivileges, id, 'canRead')) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Virtual folder not found' } }) };
  }

  if (queryParams.searchOriginal === 'true') {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Searching a virtual folder by original values is not supported; search the source storage instead' } }) };
  }

  // Build WHERE clause based on search parameters
  // SECURITY NOTE: Column names below are hardcoded string literals selected by a boolean flag,
  // never derived from user input. All user-supplied values use parameterized queries (?).
  // The de-id tree is in this VF's OWN database (vf_<id>) — the database is the
  // scope, so there is NO virtual_folder_id predicate (that column/table was retired).
  const vfDb = vfDbName(id);
  const conditions = [];
  const values = [];
  
  // Helper to handle wildcard matching
  const processWildcard = (value) => {
    if (!value) return value;
    return value.replace(/\*/g, '%');
  };
  
  // Search fields (de-identified columns)
  if (queryParams.PatientID) {
    const col = 'vp.patientid';
    const value = processWildcard(queryParams.PatientID);
    conditions.push(`${col} LIKE ?`);
    values.push(value.includes('%') ? value : `%${value}%`);
  }
  if (queryParams.PatientName) {
    const col = 'vp.patientname';
    const value = processWildcard(queryParams.PatientName);
    conditions.push(`${col} LIKE ?`);
    values.push(value.includes('%') ? value : `%${value}%`);
  }
  if (queryParams.StudyDate) {
    const col = 'vs.studydate';
    const dateValue = queryParams.StudyDate;
    // Support DICOM date range format: YYYYMMDD-YYYYMMDD
    if (dateValue.includes('-')) {
      const [startDate, endDate] = dateValue.split('-');
      if (startDate) {
        conditions.push(`${col} >= ?`);
        values.push(startDate);
      }
      if (endDate) {
        conditions.push(`${col} <= ?`);
        values.push(endDate);
      }
    } else {
      conditions.push(`${col} = ?`);
      values.push(dateValue);
    }
  }
  if (queryParams.StudyDescription) {
    const col = 'vs.studydescription';
    const value = processWildcard(queryParams.StudyDescription);
    conditions.push(`${col} LIKE ?`);
    values.push(value.includes('%') ? value : `%${value}%`);
  }
  if (queryParams.AccessionNumber) {
    const col = 'vs.accessionnumber';
    const value = processWildcard(queryParams.AccessionNumber);
    conditions.push(`${col} LIKE ?`);
    values.push(value.includes('%') ? value : `%${value}%`);
  }
  if (queryParams.ModalitiesInStudy) {
    const value = processWildcard(queryParams.ModalitiesInStudy);
    conditions.push('vs.modalitiesinstudy LIKE ?');
    values.push(value.includes('%') ? value : `%${value}%`);
  }

  const whereClause = conditions.length ? conditions.join(' AND ') : '1=1';

  const page = parseInt(queryParams.page) || 1;
  const pageSize = parseInt(queryParams.pageSize) || 20;
  const offset = (page - 1) * pageSize;

  let countResult, studies;
  try {
    [countResult] = await query(
      `SELECT COUNT(*) as total FROM ${vfTable(vfDb, 'study')} vs
       LEFT JOIN ${vfTable(vfDb, 'patient')} vp ON vs.patient_pkey = vp.patient_pkey
       WHERE ${whereClause}`,
      values
    );
  } catch (e) {
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_DB_ERROR' || e.errno === 1146 || e.errno === 1049)) {
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: { items: [], totalCount: 0, page, pageSize, totalPages: 1 } }) };
    }
    throw e;
  }
  const totalCount = countResult?.total || 0;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;

  studies = await query(
    `SELECT 
      vs.study_pkey,
      vs.studyinstanceuid AS deidentified_studyinstanceuid,
      vs.studydate AS deidentified_studydate,
      vs.studytime AS deidentified_studytime,
      vs.studydescription AS deidentified_studydescription,
      vs.accessionnumber AS deidentified_accessionnumber,
      vs.studyid AS deidentified_studyid,
      vs.referringphysicianname AS deidentified_referringphysicianname,
      vs.modalitiesinstudy,
      vs.numberofstudyrelatedseries,
      vs.numberofstudyrelatedinstances,
      vp.patientid AS deidentified_patientid,
      vp.patientname AS deidentified_patientname,
      vp.patientbirthdate,
      vp.patientsex
     FROM ${vfTable(vfDb, 'study')} vs
     LEFT JOIN ${vfTable(vfDb, 'patient')} vp ON vs.patient_pkey = vp.patient_pkey
     WHERE ${whereClause}
     ORDER BY vs.studydate DESC, vs.studytime DESC
     LIMIT ? OFFSET ?`,
    [...values, pageSize, offset]
  );

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        items: studies.map(s => ({ ...s, modalitiesinstudy: s.modalitiesinstudy ? s.modalitiesinstudy.split(/[\\,\s]+/).filter(Boolean) : [] })),
        totalCount, page, pageSize, totalPages
      }
    })
  };
}

// Remove assignments
async function removeAssignments(event) {
  const { id } = event.pathParameters;
  const body = JSON.parse(event.body || '{}');
  const { studyInstanceUids, seriesInstanceUids } = body;

  // Check privileges
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');

  if (!checkVirtualFolderAccess(virtualFolderPrivileges, id, 'canStore')) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'No write access to virtual folder' } }) };
  }

  const [vf] = await query('SELECT * FROM virtual_folders WHERE id = ? AND deleted = FALSE', [id]);
  if (!vf) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Virtual folder not found' } }) };
  }

  let removedStudies = 0;
  let removedSeries = 0;

  try {
    // The de-id tree was retired as shared tables; membership now lives in the
    // shared `virtual_folder_assignments` table, and the per-VF de-id tree
    // (vf_<id>_*) is rebuilt by the vf-deid-consumer. Removal therefore = delete
    // the membership rows for the target study/series (by their ORIGINAL source
    // UIDs) + enqueue one {op:'delete'} per affected series so the consumer
    // purges that series from this VF's tree.
    const datastoreId = body.datastoreId || null; // needed for the delete op
    const seriesToPurge = new Map(); // series_uid -> { seriesUid, datastoreId }

    if (studyInstanceUids && studyInstanceUids.length > 0) {
      for (const studyUid of studyInstanceUids) {
        // Find the series (+ their datastore) this study contributes before deleting.
        const affected = await query(
          `SELECT DISTINCT series_instance_uid AS seriesUid, datastore_id AS datastoreId
             FROM virtual_folder_assignments
            WHERE virtual_folder_id = ? AND study_instance_uid = ?`,
          [id, studyUid]
        );
        const result = await query(
          'DELETE FROM virtual_folder_assignments WHERE virtual_folder_id = ? AND study_instance_uid = ?',
          [id, studyUid]
        );
        if (result.affectedRows > 0) removedStudies++;
        for (const a of affected) {
          if (a.seriesUid) seriesToPurge.set(a.seriesUid, { seriesUid: a.seriesUid, datastoreId: a.datastoreId });
        }
      }
    } else if (seriesInstanceUids && seriesInstanceUids.length > 0) {
      for (const seriesUid of seriesInstanceUids) {
        const affected = await query(
          `SELECT DISTINCT datastore_id AS datastoreId FROM virtual_folder_assignments
            WHERE virtual_folder_id = ? AND series_instance_uid = ?`,
          [id, seriesUid]
        );
        const result = await query(
          'DELETE FROM virtual_folder_assignments WHERE virtual_folder_id = ? AND series_instance_uid = ?',
          [id, seriesUid]
        );
        if (result.affectedRows > 0) removedSeries++;
        for (const a of affected) {
          seriesToPurge.set(seriesUid, { seriesUid, datastoreId: a.datastoreId });
        }
      }
    } else {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'studyInstanceUids or seriesInstanceUids required' } }) };
    }

    // Purge each affected series from this VF's de-id tree (best-effort).
    if (VF_DEID_QUEUE_URL) {
      for (const u of seriesToPurge.values()) {
        if (!u.datastoreId) continue; // delete op requires datastore_id
        try {
          await sqsClient.send(new SendMessageCommand({
            QueueUrl: VF_DEID_QUEUE_URL,
            MessageBody: JSON.stringify({
              op: 'delete',
              virtual_folder_id: id,
              datastore_id: u.datastoreId,
              series_instance_uid: u.seriesUid,
            }),
          }));
        } catch (e) {
          console.error(`VF de-id delete enqueue failed (series=${u.seriesUid}):`, e.message);
        }
      }
    }

    // Recompute VF statistics from the authoritative membership table.
    await query(`
      INSERT INTO virtual_folder_statistics (id, virtual_folder_id, patient_count, study_count, series_count, instance_count, last_updated)
      SELECT UUID(), ?,
        0,
        (SELECT COUNT(DISTINCT study_instance_uid) FROM virtual_folder_assignments WHERE virtual_folder_id = ?),
        (SELECT COUNT(DISTINCT series_instance_uid) FROM virtual_folder_assignments WHERE virtual_folder_id = ?),
        (SELECT COUNT(*) FROM virtual_folder_assignments WHERE virtual_folder_id = ?),
        NOW()
      ON DUPLICATE KEY UPDATE
        study_count = VALUES(study_count),
        series_count = VALUES(series_count),
        instance_count = VALUES(instance_count),
        last_updated = NOW()
    `, [id, id, id, id]);

    const username = event.requestContext?.authorizer?.username || 'system';
    await sendAuditEvent({
      user: event.requestContext?.authorizer?.claims?.sub || 'system',
      username,
      action: AUDIT_ACTIONS.REMOVE_ASSIGNMENT_FROM_VIRTUAL_FOLDER,
      resourceType: RESOURCE_TYPES.VIRTUAL_FOLDER_ASSIGNMENT,
      resourceId: id,
      resourceName: vf.name,
      oldValues: { 
        removedStudies,
        removedSeries,
        studyInstanceUids: studyInstanceUids || [],
        seriesInstanceUids: seriesInstanceUids || []
      },
      apiEndpoint: event.path,
      httpMethod: event.httpMethod,
      status: 'SUCCESS'
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ 
        success: true,
        data: { removedStudies, removedSeries }
      })
    };
  } catch (error) {
    console.error('Error removing assignments:', error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { message: 'Internal server error' } })
    };
  }
}

// Re-sync: re-apply the VF's enabled assignment rules over ALL existing content.
// Enqueues {virtualFolderId} to the indexer queue, which does a full DELETE+rebuild
// of this VF's rule-based assignments (using the extended match engine).
async function resyncVirtualFolder(event) {
  const { id } = event.pathParameters;
  if (!INDEXER_QUEUE_URL) {
    return { statusCode: 500, headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { message: 'Indexer queue not configured' } }) };
  }
  // F23: resync does a full DELETE+rebuild of this VF's rule-based assignments —
  // a mutation. It must require canStore on THIS specific virtual folder (or the
  // '*' admin wildcard), not merely the ability to reach the route. Without this
  // a user with no write on the folder could rebuild/alter its contents.
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  if (!checkVirtualFolderAccess(virtualFolderPrivileges, id, 'canStore')) {
    return { statusCode: 403, headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { message: 'No write access to virtual folder' } }) };
  }
  const [vf] = await query('SELECT id, name FROM virtual_folders WHERE id = ? AND deleted = FALSE', [id]);
  if (!vf) {
    return { statusCode: 404, headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { message: 'Virtual folder not found' } }) };
  }
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: INDEXER_QUEUE_URL,
    MessageBody: JSON.stringify({ virtualFolderId: id, reason: 'resync' }),
  }));
  return { statusCode: 202, headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: { virtualFolderId: id,
      message: `Re-sync started for '${vf.name}'. Assignments are rebuilt from the current rules.` } }) };
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify({ httpMethod: event.httpMethod, path: event.path, pathParameters: event.pathParameters }));

  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    const path = event.resource;

    if (path === '/api/virtual-folders/assign-study' && event.httpMethod === 'POST') {
      return await assignStudy(event);
    }
    if (path === '/api/virtual-folders/assign-series' && event.httpMethod === 'POST') {
      return await assignSeries(event);
    }
    if (path === '/api/virtual-folders/{id}/assignments' && event.httpMethod === 'GET') {
      return await getAssignments(event);
    }
    if (path === '/api/virtual-folders/{id}/studies' && event.httpMethod === 'GET') {
      return await getStudies(event);
    }
    if (path === '/api/virtual-folders/{id}/assignments' && event.httpMethod === 'DELETE') {
      return await removeAssignments(event);
    }
    if (path === '/api/virtual-folders/{id}/resync' && event.httpMethod === 'POST') {
      return await resyncVirtualFolder(event);
    }

    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Not found' }) };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { message: 'Internal server error' } })
    };
  }
};
