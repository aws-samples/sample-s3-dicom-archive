/**
 * processing-job-schedules-api — CRUD for scheduled processing jobs (item 7).
 *
 * A schedule periodically triggers a processing-job TEMPLATE against the set of
 * data modified within the run window, at a chosen action level
 * (patient/study/series/instance), scoped to one or more storages and/or virtual
 * folders, optionally filtered by a VF assignment rule.
 *
 * Routes (mounted under /processing-job-schedules):
 *   GET    /processing-job-schedules            list
 *   POST   /processing-job-schedules            create
 *   GET    /processing-job-schedules/{id}       get
 *   PUT    /processing-job-schedules/{id}       update
 *   DELETE /processing-job-schedules/{id}       delete (soft)
 *   POST   /processing-job-schedules/{id}/run-now   fire immediately (async)
 *
 * The actual execution + target computation lives in the scheduler lambda
 * (SCHEDULER_FUNCTION_ARN); run-now async-invokes it for a single schedule.
 */
const { query } = require('/opt/nodejs/database');
const { reservedParamKey } = require('/opt/nodejs/job-params');
const { randomUUID } = require('crypto');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambdaClient = new LambdaClient({});
const SCHEDULER_FUNCTION_ARN = process.env.SCHEDULER_FUNCTION_ARN;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
const LEVELS = ['PATIENT', 'STUDY', 'SERIES', 'INSTANCE'];

function resp(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
function toCamel(obj) {
  const o = {};
  for (const k in obj) o[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = obj[k];
  return o;
}
function parseRow(r) {
  const c = toCamel(r);
  c.scope = JSON.parse(r.scope_json || '[]');
  c.jobParams = JSON.parse(r.job_params_json || '{}');
  delete c.scopeJson; delete c.jobParamsJson;
  return c;
}

// F11: read the caller's datastore/VF read grants from the authorizer context
// (threaded as JSON strings by api-authorizer). A schedule may only be scoped to
// data the creator can read.
function readerGrants(event) {
  const auth = event.requestContext?.authorizer || {};
  const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; } };
  const ds = parse(auth.datastorePrivileges, []);
  const vf = parse(auth.virtualFolderPrivileges, []);
  return {
    datastoreIds: Array.isArray(ds) ? ds.filter(p => p && p.canRead).map(p => p.datastoreId) : [],
    vfIds: Array.isArray(vf) ? vf.filter(p => p && (p.canRead || p.canList)).map(p => p.virtualFolderId) : [],
  };
}
function allowed(ids, id) { return ids.includes('*') || ids.includes(id); }

// The caller's username, in the form stored in created_by and matched against
// users.cognito_username by the scheduler. Null when the request carries none.
function callerName(event) {
  const a = event.requestContext?.authorizer || {};
  return a.claims?.['cognito:username'] || a.username || null;
}

// Review 3: who may see / change a schedule. A schedule runs with the access of
// the user in created_by, so only that user, or a caller who can read the whole
// scope, may see it; edits re-check the scope against the EDITOR and make the
// editor the owner, so a schedule never runs on someone else's access after a
// change they did not make.
function canSeeSchedule(row, event) {
  const me = callerName(event);
  if (me && row.created_by === me) return true;
  return authorizeScope(JSON.parse(row.scope_json || '[]'), readerGrants(event)) === null;
}

// Return an error string if the caller is not authorized for every scope entry,
// else null. Used on create AND update so a schedule can never persist a scope
// its creator cannot read.
function authorizeScope(scope, grants) {
  for (const s of (scope || [])) {
    if (s.kind === 'DATASTORE' && !allowed(grants.datastoreIds, s.id))
      return `Not authorized to read datastore ${s.id}`;
    if (s.kind === 'VF' && !allowed(grants.vfIds, s.id))
      return `Not authorized to read virtual folder ${s.id}`;
  }
  return null;
}

// Self-heal: create the schedules table + the last_updated tree columns on a
// persistent DB (schema-init uses CREATE TABLE IF NOT EXISTS, so a new table /
// column is not applied to an existing DB). Idempotent + cheap; runs once per
// warm container. MySQL 8 has no ADD COLUMN IF NOT EXISTS, so we probe
// information_schema first.
let _ensured = false;
async function ensureSchema() {
  if (_ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS processing_job_schedules (
      id                CHAR(36) NOT NULL,
      name              VARCHAR(255) NOT NULL,
      processing_job_id CHAR(36) NOT NULL,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      period_seconds    INT NOT NULL,
      action_level      ENUM('PATIENT','STUDY','SERIES','INSTANCE') NOT NULL,
      scope_json        JSON NOT NULL,
      rule_id           CHAR(36) NULL,
      job_params_json   JSON NOT NULL,
      -- Data range (item 7 follow-up): which rows a run processes.
      --   SINCE_LAST_RUN  (default) — data modified since the previous run.
      --   ALL_UNPROCESSED — all data in scope (job idempotency skips done work).
      --   BYPASS_RECENT   — data modified OLDER than bypass_value * bypass_unit
      --                     ago (a settling window; skip freshly-changed data).
      data_range_mode   VARCHAR(32) NOT NULL DEFAULT 'SINCE_LAST_RUN',
      bypass_value      INT NULL,
      bypass_unit       VARCHAR(16) NULL,
      last_run_at       TIMESTAMP NULL DEFAULT NULL,
      next_run_at       TIMESTAMP NULL DEFAULT NULL,
      last_status       VARCHAR(64) NULL,
      last_matched      INT NULL,
      running           BOOLEAN NOT NULL DEFAULT FALSE,
      created_by        VARCHAR(255) NULL,
      created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      deleted           BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (id),
      KEY idx_pjs_due (enabled, next_run_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // last_updated on the four tree tables (idempotent).
  for (const [table, pkeyCol] of [['patient', 'patient_pkey'], ['study', 'study_pkey'], ['series', 'series_pkey'], ['instance', 'instance_pkey']]) {
    const col = await query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE table_schema=DATABASE() AND table_name=? AND column_name='last_updated'",
      [table]);
    if (!col.length) {
      await query(`ALTER TABLE \`${table}\` ADD COLUMN last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`);
      // Best-effort index for the scheduler's window scan.
      try { await query(`CREATE INDEX idx_${table}_ds_updated ON \`${table}\` (datastore_id, last_updated)`); }
      catch (e) { console.warn(`idx_${table}_ds_updated not created: ${e.message}`); }
    }
    void pkeyCol;
  }

  // Data-range columns on an ALREADY-EXISTING schedules table (CREATE TABLE IF
  // NOT EXISTS above won't add them). Idempotent per column.
  for (const [c, ddl] of [
    ['data_range_mode', "ADD COLUMN data_range_mode VARCHAR(32) NOT NULL DEFAULT 'SINCE_LAST_RUN'"],
    ['bypass_value', 'ADD COLUMN bypass_value INT NULL'],
    ['bypass_unit', 'ADD COLUMN bypass_unit VARCHAR(16) NULL'],
  ]) {
    const has = await query(
      "SELECT 1 FROM information_schema.COLUMNS WHERE table_schema=DATABASE() AND table_name='processing_job_schedules' AND column_name=?",
      [c]);
    if (!has.length) await query(`ALTER TABLE processing_job_schedules ${ddl}`);
  }
  _ensured = true;
}

function validate(b) {
  if (!b.name || !b.processingJobId) return 'name and processingJobId are required';
  if (!Number.isInteger(b.periodSeconds) || b.periodSeconds < 60) return 'periodSeconds must be an integer >= 60';
  if (!LEVELS.includes(b.actionLevel)) return 'actionLevel must be PATIENT/STUDY/SERIES/INSTANCE';
  if (!Array.isArray(b.scope) || !b.scope.length) return 'scope must be a non-empty array of {kind,id}';
  for (const s of b.scope) {
    if (!s || !['DATASTORE', 'VF'].includes(s.kind) || !s.id) return "each scope entry must be {kind:'DATASTORE'|'VF', id}";
  }
  const reservedKey = reservedParamKey(b.jobParams);
  if (reservedKey) return `jobParams: parameter name '${reservedKey}' is reserved`;
  const mode = b.dataRangeMode || 'SINCE_LAST_RUN';
  if (!['SINCE_LAST_RUN', 'ALL_UNPROCESSED', 'BYPASS_RECENT'].includes(mode))
    return 'dataRangeMode must be SINCE_LAST_RUN, ALL_UNPROCESSED, or BYPASS_RECENT';
  if (mode === 'BYPASS_RECENT') {
    if (!Number.isInteger(b.bypassValue) || b.bypassValue < 0) return 'bypassValue must be a non-negative integer for BYPASS_RECENT';
    if (!['minute', 'hour', 'day', 'month'].includes(b.bypassUnit)) return 'bypassUnit must be minute/hour/day/month';
  }
  return null;
}

async function listSchedules(event) {
  const rows = await query('SELECT * FROM processing_job_schedules WHERE deleted = FALSE ORDER BY created_at DESC');
  return resp(200, { success: true, data: rows.filter(r => canSeeSchedule(r, event)).map(parseRow) });
}
async function getSchedule(id, event) {
  const rows = await query('SELECT * FROM processing_job_schedules WHERE id = ? AND deleted = FALSE', [id]);
  if (!rows.length || !canSeeSchedule(rows[0], event)) return resp(404, { success: false, error: 'Schedule not found' });
  return resp(200, { success: true, data: parseRow(rows[0]) });
}
async function createSchedule(event) {
  const b = JSON.parse(event.body || '{}');
  const err = validate(b);
  if (err) return resp(400, { success: false, error: err });
  // F11: the creator must be able to read every datastore/VF in the scope.
  const scopeErr = authorizeScope(b.scope, readerGrants(event));
  if (scopeErr) return resp(403, { success: false, error: scopeErr });
  const id = randomUUID();
  const username = callerName(event);
  if (!username) return resp(403, { success: false, error: 'A schedule needs a signed-in owner' });
  await query(
    `INSERT INTO processing_job_schedules
       (id, name, processing_job_id, enabled, period_seconds, action_level, scope_json, rule_id, job_params_json,
        data_range_mode, bypass_value, bypass_unit, next_run_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?, ?,?,?, NOW(), ?)`,
    [id, b.name, b.processingJobId, b.enabled !== false, b.periodSeconds, b.actionLevel,
     JSON.stringify(b.scope), b.ruleId || null, JSON.stringify(b.jobParams || {}),
     b.dataRangeMode || 'SINCE_LAST_RUN', (b.dataRangeMode === 'BYPASS_RECENT' ? b.bypassValue : null),
     (b.dataRangeMode === 'BYPASS_RECENT' ? b.bypassUnit : null), username]);
  const [row] = await query('SELECT * FROM processing_job_schedules WHERE id = ?', [id]);
  return resp(201, { success: true, data: parseRow(row) });
}
async function updateSchedule(id, event) {
  const b = JSON.parse(event.body || '{}');
  const rows = await query('SELECT * FROM processing_job_schedules WHERE id = ? AND deleted = FALSE', [id]);
  if (!rows.length || !canSeeSchedule(rows[0], event)) return resp(404, { success: false, error: 'Schedule not found' });
  const editor = callerName(event);
  if (!editor) return resp(403, { success: false, error: 'A schedule needs a signed-in owner' });
  const err = validate({ ...parseRow(rows[0]), ...b });
  if (err) return resp(400, { success: false, error: err });
  // F11: re-authorize the scope that WILL be persisted (the incoming scope, or
  // the existing one when the update doesn't change it) against the caller's
  // grants — an update must not let a scope the caller cannot read survive.
  const effectiveScope = b.scope ?? JSON.parse(rows[0].scope_json || '[]');
  const scopeErr = authorizeScope(effectiveScope, readerGrants(event));
  if (scopeErr) return resp(403, { success: false, error: scopeErr });
  await query(
    `UPDATE processing_job_schedules SET
       name = ?, processing_job_id = ?, enabled = ?, period_seconds = ?, action_level = ?,
       scope_json = ?, rule_id = ?, job_params_json = ?,
       data_range_mode = ?, bypass_value = ?, bypass_unit = ?, created_by = ? WHERE id = ?`,
    [b.name ?? rows[0].name, b.processingJobId ?? rows[0].processing_job_id,
     b.enabled ?? !!rows[0].enabled, b.periodSeconds ?? rows[0].period_seconds,
     b.actionLevel ?? rows[0].action_level,
     JSON.stringify(b.scope ?? JSON.parse(rows[0].scope_json)),
     (b.ruleId !== undefined ? b.ruleId : rows[0].rule_id),
     JSON.stringify(b.jobParams ?? JSON.parse(rows[0].job_params_json || '{}')),
     b.dataRangeMode ?? rows[0].data_range_mode ?? 'SINCE_LAST_RUN',
     (b.dataRangeMode === 'BYPASS_RECENT' ? b.bypassValue : (b.dataRangeMode ? null : rows[0].bypass_value)),
     (b.dataRangeMode === 'BYPASS_RECENT' ? b.bypassUnit : (b.dataRangeMode ? null : rows[0].bypass_unit)),
     editor, id]);
  const [row] = await query('SELECT * FROM processing_job_schedules WHERE id = ?', [id]);
  return resp(200, { success: true, data: parseRow(row) });
}
async function deleteSchedule(id, event) {
  const rows = await query('SELECT * FROM processing_job_schedules WHERE id = ? AND deleted = FALSE', [id]);
  if (!rows.length || !canSeeSchedule(rows[0], event)) return resp(404, { success: false, error: 'Schedule not found' });
  await query('UPDATE processing_job_schedules SET deleted = TRUE WHERE id = ?', [id]);
  return resp(200, { success: true });
}
async function runNow(id, event) {
  const rows = await query('SELECT * FROM processing_job_schedules WHERE id = ? AND deleted = FALSE', [id]);
  if (!rows.length || !canSeeSchedule(rows[0], event)) return resp(404, { success: false, error: 'Schedule not found' });
  // Run-now fires on the OWNER's access, so only the owner may fire it. Anyone
  // else who can read the scope may edit the schedule, which makes them owner.
  if (rows[0].created_by !== callerName(event))
    return resp(403, { success: false, error: 'Only the schedule owner can run it now; save the schedule to take ownership' });
  if (!SCHEDULER_FUNCTION_ARN) return resp(500, { success: false, error: 'Scheduler function not configured' });
  await lambdaClient.send(new InvokeCommand({
    FunctionName: SCHEDULER_FUNCTION_ARN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ scheduleId: id, forced: true })),
  }));
  return resp(202, { success: true, data: { id, triggered: true } });
}

exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || '';
  const id = event.pathParameters?.id || (event.pathParameters?.proxy || '').split('/')[0] || undefined;
  if (method === 'OPTIONS') return resp(200, {});
  try {
    await ensureSchema();
    if (method === 'POST' && path.endsWith('/run-now') && id) return await runNow(id, event);
    if (method === 'GET' && !id) return await listSchedules(event);
    if (method === 'GET' && id) return await getSchedule(id, event);
    if (method === 'POST') return await createSchedule(event);
    if (method === 'PUT' && id) return await updateSchedule(id, event);
    if (method === 'DELETE' && id) return await deleteSchedule(id, event);
    return resp(405, { success: false, error: `Method ${method} not allowed` });
  } catch (e) {
    console.error('SchedulesAPI error:', e.message);
    return resp(500, { success: false, error: e.message });
  }
};
