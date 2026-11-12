// Assign analytics query RESULTS to a virtual folder — DIRECT MySQL (Athena +
// Step Function removed). The analytics query already runs synchronously against
// the live index tables and every query exposes content_pkey; assigning those
// rows to a VF is just INSERTing their content_pkeys into
// virtual_folder_assignments (the same membership table the VF indexer writes).
// Idempotent via the (virtual_folder_id, content_pkey) unique key.

const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS } = require('/opt/nodejs/audit-helper');
const { respond, cleanSql } = require('./helpers');
const { validateReadOnlySql, runScopedQuery, resolveScope, assertScopeReadable } = require('./query');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const sqsClient = new SQSClient({});
// Set by the analytics stack; the VF indexer queue. Enqueuing {virtualFolderId}
// makes the indexer rebuild the per-VF DE-ID tree from current assignments.
const INDEXER_QUEUE_URL = process.env.VF_INDEXER_QUEUE_URL || '';

const MAX_ASSIGN_ROWS = 100000; // hard cap on a single assign operation

// A DICOM UID is digits and dots only. Reject anything else so a UID value can
// be safely inlined into the generated SELECT (defense in depth — the query
// still passes through validateReadOnlySql + the scope predicate).
const UID_RE = /^[0-9.]{1,64}$/;

// Build a scoped SELECT from UID lists. Selects content_pkey + datastore_id +
// the UID columns (what the assign INSERT and runScopedQuery both need). The
// datastore/scope predicate is added by runScopedQuery from the session scope,
// NOT here — this only narrows by the requested UIDs. Returns null if no valid
// UID is supplied.
function buildSqlFromUids(uids) {
  const clauses = [];
  const pick = (arr, col) => {
    const vals = (Array.isArray(arr) ? arr : []).filter(v => UID_RE.test(String(v)));
    if (vals.length) clauses.push(`${col} IN (${vals.map(v => `'${v}'`).join(',')})`);
  };
  pick(uids.studyInstanceUIDs, 'st.studyinstanceuid');
  pick(uids.seriesInstanceUIDs, 's.seriesinstanceuid');
  pick(uids.sopInstanceUIDs, 'i.sopinstanceuid');
  if (!clauses.length) return null;
  // instance is the row that carries content_pkey + datastore_id; join up to
  // study so any of the three UID levels can filter. deleted_at filters keep
  // soft-deleted rows out.
  return (
    `SELECT i.content_pkey, i.datastore_id, st.studyinstanceuid AS study_instance_uid, ` +
    `s.seriesinstanceuid AS series_instance_uid, i.sopinstanceuid AS sop_instance_uid ` +
    `FROM instance i ` +
    `JOIN series s ON s.series_pkey = i.series_pkey ` +
    `JOIN study st ON st.study_pkey = s.study_pkey ` +
    `WHERE i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL ` +
    `AND (${clauses.join(' OR ')})`
  );
}

function hasCanStore(virtualFolderPrivileges, virtualFolderId) {
  return virtualFolderPrivileges.some(p =>
    (p.virtualFolderId === virtualFolderId || p.virtualFolderId === '*') && p.canStore // nosec - intentional wildcard for admin "All Virtual Folders" privilege
  );
}

// routeId = the selected index id (datastore/vf) used as the scope key; scope
// itself comes from body.source (see query.js resolveScope).
async function startVirtualFolderAssign(routeId, event) {
  const body = JSON.parse(event.body || '{}');
  let { sql, virtualFolderId } = body;
  // Back-compat: maxImagesets was the old cap name; accept maxRows too.
  const maxRows = Math.min(parseInt(body.maxRows || body.maxImagesets, 10) || MAX_ASSIGN_ROWS, MAX_ASSIGN_ROWS);

  // UID-based selector: instead of hand-writing SQL, the caller may pass
  // { uids: { studyInstanceUIDs?, seriesInstanceUIDs?, sopInstanceUIDs? } }.
  // The server builds the scoped SELECT itself (still run through the same
  // validate + scope-enforcement + content_pkey machinery), so a user can
  // assign by UID + datastore_id without writing analytics SQL. `sql` still
  // works for advanced queries; `uids` takes precedence when present.
  if (!sql && body.uids) {
    sql = buildSqlFromUids(body.uids);
    if (!sql)
      return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'uids must include at least one of studyInstanceUIDs / seriesInstanceUIDs / sopInstanceUIDs' } });
  }

  if (!sql || !virtualFolderId)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Either sql or uids, plus virtualFolderId, are required' } });

  // canStore on the target VF (fail-closed).
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  if (!hasCanStore(virtualFolderPrivileges, virtualFolderId))
    return respond(403, { success: false, error: { code: 'FORBIDDEN', message: 'No write access to the selected virtual folder' } });

  // The target VF must exist + be active.
  const vfRows = await query("SELECT id, name FROM virtual_folders WHERE id = ? AND status = 'ACTIVE' AND deleted_at IS NULL", [virtualFolderId]);
  if (!vfRows.length)
    return respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Target virtual folder not found or not active' } });

  // Resolve the source scope FIRST so validation uses the right table allowlist.
  const { scope } = await resolveScope(routeId, body);
  if (!scope || !(scope.ids || []).length)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'A source index (storage or virtual folder) is required to scope the assignment.' } });

  // F25: the SOURCE scope is client-supplied, so authorize the caller's canRead
  // on every source id — the SAME mandatory check the query path uses. Without
  // this the route validated only the DESTINATION VF (canStore) and would copy
  // rows from a source the caller cannot read into a folder they can write
  // (confused deputy). Reused from query.js so the two paths cannot drift.
  const sourceDenied = assertScopeReadable(scope, event);
  if (sourceDenied) return sourceDenied;

  // A virtual folder cannot be the SOURCE of an assignment into another virtual
  // folder — only a storage index may feed a VF.
  if (scope.kind === 'vf')
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Studies from a virtual folder cannot be assigned to another virtual folder; use a storage index as the source.' } });

  // Validate + scope the SELECT the SAME way the query path does (SELECT-only,
  // table allowlist, enforced scope predicate). No Athena.
  const v = validateReadOnlySql(cleanSql(sql), scope);
  if (!v.ok)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: v.message } });

  let result;
  try {
    result = await runScopedQuery(v.sql, scope, maxRows, 0);
  } catch (err) {
    // A DB error message can echo SQL fragments and row values: never return it.
    console.error('[AnalyticsAPI] VF assign query FAILED |', err && err.name, err && (err.code || err.errno));
    return respond(400, { success: false, error: { code: 'QUERY_ERROR', message: 'The query could not be run. Check the query and try again.' } });
  }

  const rows = result.rows || [];
  if (!rows.length)
    return respond(200, { success: true, data: { assigned: 0, message: 'Query returned no rows; nothing to assign.' } });

  // SERVER-SIDE content_pkey resolution. The query result is gathered here (not
  // client-side): every row of the FULL scoped result set (up to maxRows) is
  // considered, not just the page the browser rendered. A query may expose
  // content_pkey directly (instance/storage_index level) or only UID columns
  // (study/series level) — in the latter case we resolve content_pkey by
  // joining the exposed UIDs down to `instance` server-side, so a study- or
  // series-level selection expands to all its instances' content_pkeys.
  // EdgeSwarm D-4: nothing a row PROJECTS is trusted. A query can alias any
  // value as datastore_id / content_pkey, so a projected content_pkey is only a
  // CANDIDATE: every one is looked up again below, restricted to the source
  // datastores, and the stored datastore_id and UIDs are the database's own.
  const pick = (r, ...keys) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return undefined; };
  const directPkeys = new Set(); // candidate content_pkeys
  const uidStudies = new Set();
  const uidSeries = new Set();
  const uidSops = new Set();
  for (const r of rows) {
    const cp = pick(r, 'content_pkey', 'contentPkey');
    if (cp != null) {
      directPkeys.add(cp);
      continue;
    }
    const sop = pick(r, 'sop_instance_uid', 'sopinstanceuid');
    const se = pick(r, 'series_instance_uid', 'seriesinstanceuid');
    const st = pick(r, 'study_instance_uid', 'studyinstanceuid');
    if (sop != null && UID_RE.test(String(sop))) uidSops.add(String(sop));
    else if (se != null && UID_RE.test(String(se))) uidSeries.add(String(se));
    else if (st != null && UID_RE.test(String(st))) uidStudies.add(String(st));
  }

  // Resolve UID-only rows to content_pkeys server-side (one query, scoped to the
  // source datastores). Uses the most specific UID present per row.
  const resolved = [];
  const dsIds = (scope.ids || []).filter(Boolean);
  const dsPh = dsIds.map(() => '?').join(',');
  // nosemgrep: javascript.express.security.injection.tainted-sql-string -- Parameterized query; interpolated parts are constant SQL fragments or ?-placeholder lists, not user values (audited)
  const resolveSql = (where) =>
    `SELECT i.content_pkey AS cp, i.datastore_id AS ds,
            st.studyinstanceuid AS st, s.seriesinstanceuid AS se, i.sopinstanceuid AS sop
     FROM instance i
     JOIN series s ON s.series_pkey = i.series_pkey
     JOIN study  st ON st.study_pkey = s.study_pkey
     WHERE i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL
       AND i.datastore_id IN (${dsPh})
       AND ${where}`;
  const cps = [...directPkeys];
  for (let i = 0; i < cps.length; i += 1000) {
    const chunk = cps.slice(i, i + 1000);
    const rowsCp = await query(resolveSql(`i.content_pkey IN (${chunk.map(() => '?').join(',')})`), [...dsIds, ...chunk]);
    for (const rr of rowsCp) resolved.push({ cp: rr.cp, ds: rr.ds, st: rr.st ?? null, se: rr.se ?? null, sop: rr.sop ?? null });
  }
  const uidClauses = [];
  const uidParams = [];
  if (uidStudies.size) { uidClauses.push(`st.studyinstanceuid IN (${[...uidStudies].map(() => '?').join(',')})`); uidParams.push(...uidStudies); }
  if (uidSeries.size)  { uidClauses.push(`s.seriesinstanceuid IN (${[...uidSeries].map(() => '?').join(',')})`);  uidParams.push(...uidSeries); }
  if (uidSops.size)    { uidClauses.push(`i.sopinstanceuid IN (${[...uidSops].map(() => '?').join(',')})`);       uidParams.push(...uidSops); }
  if (uidClauses.length) {
    const resolveRows = await query(resolveSql(`(${uidClauses.join(' OR ')})`), [...dsIds, ...uidParams]);
    for (const rr of resolveRows) resolved.push({ cp: rr.cp, ds: rr.ds, st: rr.st ?? null, se: rr.se ?? null, sop: rr.sop ?? null });
  }

  // De-dup by content_pkey (the unique key target).
  const byPkey = new Map();
  for (const e of resolved) if (e.cp != null && !byPkey.has(e.cp)) byPkey.set(e.cp, e);

  const values = [];
  const params = [];
  for (const e of byPkey.values()) {
    values.push('(?, ?, ?, ?, ?, ?)');
    params.push(virtualFolderId, e.ds, e.cp, e.st, e.se, e.sop);
  }
  if (!values.length)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Query results expose no content_pkey or DICOM UID (studyinstanceuid / seriesinstanceuid / sopinstanceuid) that resolves to an instance in the source storage.' } });

  // Idempotent insert: the unique (virtual_folder_id, content_pkey) key makes a
  // re-assign a no-op update rather than a duplicate.
  await query(
    `INSERT INTO virtual_folder_assignments
       (virtual_folder_id, datastore_id, content_pkey, study_instance_uid, series_instance_uid, sop_instance_uid)
     VALUES ${values.join(', ')}
     ON DUPLICATE KEY UPDATE assigned_at = CURRENT_TIMESTAMP`,
    params
  );

  const username = event.requestContext?.authorizer?.username || 'system';
  await sendAuditEvent({
    action: AUDIT_ACTIONS.CREATE,
    resourceType: 'ANALYTICS_VF_ASSIGNMENT',
    resourceId: virtualFolderId,
    resourceName: vfRows[0].name,
    username,
    details: { assigned: values.length, sourceKind: scope.kind, sourceIds: scope.ids },
    httpMethod: event.httpMethod,
    path: event.path,
  });

  // Trigger the VF indexer to (re)build the per-VF DE-ID tree from the current
  // assignments — otherwise the freshly-assigned studies exist as membership
  // rows but are never de-identified (virtual_* tree not hydrated), so QIDO/WADO
  // for the folder would show the SOURCE demographics. The indexer's rule pass
  // is additive (ON DUPLICATE KEY) so it never drops these manual assignments,
  // then hydrateVfTree rebuilds the de-id'd tree from ALL of them.
  try {
    if (INDEXER_QUEUE_URL) {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: INDEXER_QUEUE_URL,
        MessageBody: JSON.stringify({ virtualFolderId, reason: 'analytics-assign' }),
      }));
    } else {
      console.warn('VF_INDEXER_QUEUE_URL not set; de-id tree will not be rebuilt after analytics assign');
    }
  } catch (e) {
    console.warn(`failed to enqueue VF indexer after analytics assign: ${e.message}`);
  }

  return respond(200, {
    success: true,
    data: { assigned: values.length, message: `Assigned ${values.length} object(s) to virtual folder '${vfRows[0].name}'.` }
  });
}

module.exports = { startVirtualFolderAssign };
