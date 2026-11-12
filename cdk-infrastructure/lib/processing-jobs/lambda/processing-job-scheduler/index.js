/**
 * processing-job-scheduler — EventBridge-ticked lambda that fires due processing
 * jobs based on last_updated (item 7).
 *
 * Invoked two ways:
 *   - EventBridge rule every SCHEDULER_TICK (e.g. 5 min): {} -> scan all due.
 *   - run-now from the schedules API: { scheduleId, forced:true } -> that one.
 *
 * For each due schedule it:
 *   1. computes the window [last_run_at (or NOW-period) .. NOW];
 *   2. finds rows at action_level with last_updated >= window start, scoped to
 *      the schedule's storages/VFs, optionally filtered by a VF assignment rule;
 *   3. executes the schedule's processing-job template with target = the matched
 *      pkeys/UIDs (same code path as the API's /execute: start SFN or invoke the
 *      expander);
 *   4. advances last_run_at / next_run_at / last_status / last_matched.
 */
const { query } = require('/opt/nodejs/database');
// A user may belong to several privilege groups; their effective scope is the
// union of all groups (shared layer).
const { mergeResourceLists } = require('/opt/nodejs/privilege-merge');
const { randomUUID } = require('crypto');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const sfn = new SFNClient({});
const lambdaClient = new LambdaClient({});

const LEVEL_TABLE = { PATIENT: 'patient', STUDY: 'study', SERIES: 'series', INSTANCE: 'instance' };
const LEVEL_PKEY = { PATIENT: 'patient_pkey', STUDY: 'study_pkey', SERIES: 'series_pkey', INSTANCE: 'instance_pkey' };

// Attribute -> column, mirroring the ingest matcher + preview-count. Used only
// when a schedule is filtered by a VF assignment rule.
const ATTR_COL = {
  StudyInstanceUID: 'si.study_instance_uid', SeriesInstanceUID: 'si.series_instance_uid',
  SOPInstanceUID: 'si.sop_instance_uid', ContentKind: 'si.content_kind',
  SOPClassUID: 'i.sopclassuid', Modality: 'se.modality', SeriesDescription: 'se.seriesdescription',
  StudyDescription: 'st.studydescription', StudyDate: 'st.studydate', AccessionNumber: 'st.accessionnumber',
  PatientID: 'p.patientid', PatientName: 'p.patientname',
};

async function dueSchedules(event) {
  if (event && event.scheduleId) {
    return query('SELECT * FROM processing_job_schedules WHERE id = ? AND deleted = FALSE', [event.scheduleId]);
  }
  return query(
    'SELECT * FROM processing_job_schedules WHERE deleted = FALSE AND enabled = TRUE AND (next_run_at IS NULL OR next_run_at <= NOW())');
}

// F11 run-time re-validation: re-check that the schedule's CREATOR still holds
// read grants for every datastore/VF in the schedule's scope, resolving their
// CURRENT privileges from the DB (same source the api-authorizer uses). A grant
// revoked after the schedule was created therefore stops it from running,
// instead of the schedule persisting an authorization the creator no longer has.
// Returns null when authorized, or a reason string when it must be blocked.
// The creator's CURRENT read/write scope, in the same shape processing-jobs-api
// persists on a user-started run. Null when the creator is gone or unknown.
async function creatorScope(createdBy) {
  if (!createdBy || createdBy === 'system' || createdBy === 'scheduler') return null;
  const rows = await query(
    `SELECT pg.datastore_privileges, pg.virtual_folder_privileges
       FROM users u
       JOIN user_privilege_groups upg ON upg.user_id = u.id
       JOIN privilege_groups pg ON upg.privilege_group_id = pg.id
      WHERE u.cognito_username = ? AND u.deleted = FALSE AND (u.status IS NULL OR u.status = 'ACTIVE')
        AND pg.deleted = FALSE`, [createdBy]);
  if (!rows.length) return null;
  const parse = (v, d) => {
    if (v === null || v === undefined) return d;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return d; } }
    return v;
  };
  // Union across all of the creator's groups.
  const ds = mergeResourceLists(rows.map(r => parse(r.datastore_privileges, [])), 'datastoreId');
  const vf = mergeResourceLists(rows.map(r => parse(r.virtual_folder_privileges, [])), 'virtualFolderId');
  return {
    user: createdBy,
    canReadDatastoreIds: Array.isArray(ds) ? ds.filter(p => p && p.canRead).map(p => p.datastoreId) : [],
    canReadVfIds: Array.isArray(vf) ? vf.filter(p => p && (p.canRead || p.canList)).map(p => p.virtualFolderId) : [],
    canWriteDatastoreIds: Array.isArray(ds) ? ds.filter(p => p && p.canStore).map(p => p.datastoreId) : [],
    scheduleCreator: true,
  };
}

async function revalidateScope(schedule) {
  const scope = JSON.parse(schedule.scope_json || '[]');
  if (!scope.length) return null;
  const createdBy = schedule.created_by;
  // A schedule with no recorded creator predates F11 — fail closed rather than
  // run an unauthorized scope on a timer.
  if (!createdBy || createdBy === 'system') return `schedule has no creator to authorize (created_by=${createdBy || 'null'})`;

  const rows = await query(
    `SELECT pg.datastore_privileges, pg.virtual_folder_privileges
       FROM users u
       JOIN user_privilege_groups upg ON upg.user_id = u.id
       JOIN privilege_groups pg ON upg.privilege_group_id = pg.id
      WHERE u.cognito_username = ? AND u.deleted = FALSE AND (u.status IS NULL OR u.status = 'ACTIVE')
        AND pg.deleted = FALSE`, [createdBy]);
  if (!rows.length) return `creator ${createdBy} is deleted or not active`;

  const parse = (v, d) => {
    if (v === null || v === undefined) return d;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return d; } }
    return v;
  };
  // Union across all of the creator's groups.
  const ds = mergeResourceLists(rows.map(r => parse(r.datastore_privileges, [])), 'datastoreId');
  const vf = mergeResourceLists(rows.map(r => parse(r.virtual_folder_privileges, [])), 'virtualFolderId');
  const dsIds = Array.isArray(ds) ? ds.filter(p => p && p.canRead).map(p => p.datastoreId) : [];
  const vfIds = Array.isArray(vf) ? vf.filter(p => p && (p.canRead || p.canList)).map(p => p.virtualFolderId) : [];
  const ok = (ids, id) => ids.includes('*') || ids.includes(id);

  for (const s of scope) {
    if (s.kind === 'DATASTORE' && !ok(dsIds, s.id)) return `creator ${createdBy} lost read on datastore ${s.id}`;
    if (s.kind === 'VF' && !ok(vfIds, s.id)) return `creator ${createdBy} lost read on virtual folder ${s.id}`;
  }
  return null;
}

// Build the target set at action_level within scope, optionally filtered by a VF
// assignment rule. The TIME predicate depends on the schedule's data_range_mode:
//   SINCE_LAST_RUN  — last_updated >= windowStart (data changed since last run)
//   ALL_UNPROCESSED — no time filter (all data in scope; job idempotency skips
//                     already-processed work)
//   BYPASS_RECENT   — last_updated < NOW() - INTERVAL n unit (skip data changed
//                     within the settling window)
async function computeTarget(schedule, windowStart) {
  const level = schedule.action_level;
  const table = LEVEL_TABLE[level];
  const pkeyCol = LEVEL_PKEY[level];
  const scope = JSON.parse(schedule.scope_json || '[]');
  const dsIds = scope.filter(s => s.kind === 'DATASTORE').map(s => s.id);
  const vfIds = scope.filter(s => s.kind === 'VF').map(s => s.id);

  // The time predicate + its bound param, from the data-range mode.
  const mode = schedule.data_range_mode || 'SINCE_LAST_RUN';
  const UNIT_SQL = { minute: 'MINUTE', hour: 'HOUR', day: 'DAY', month: 'MONTH' };
  let timeClause, timeParam = null;
  if (mode === 'ALL_UNPROCESSED') {
    timeClause = '1=1';
  } else if (mode === 'BYPASS_RECENT') {
    const unit = UNIT_SQL[schedule.bypass_unit] || 'DAY';
    const n = Number(schedule.bypass_value) || 0;
    // Interval unit is a fixed allowlisted keyword (not user free-text), value
    // is a coerced integer — safe to inline; no injection surface.
    timeClause = `t.last_updated < (NOW() - INTERVAL ${n} ${unit})`;
  } else {
    timeClause = 't.last_updated >= ?';
    timeParam = windowStart;
  }

  const params = [];
  const scopeClauses = [];
  if (dsIds.length) {
    scopeClauses.push(`t.datastore_id IN (${dsIds.map(() => '?').join(',')})`);
    params.push(...dsIds);
  }
  // For VF scope we constrain to content_pkeys in virtual_folder_assignments,
  // resolved to the action level through instance.content_pkey (subquery — no
  // fragile join against the action-level table).
  if (vfIds.length) {
    scopeClauses.push(`t.${pkeyCol} IN (
      SELECT ${levelPkeyFromContent(level)} FROM instance i2
      JOIN virtual_folder_assignments vfa ON vfa.content_pkey = i2.content_pkey
      WHERE vfa.virtual_folder_id IN (${vfIds.map(() => '?').join(',')}))`);
    params.push(...vfIds);
  }
  const scopeSql = scopeClauses.length ? `(${scopeClauses.join(' OR ')})` : '1=1';

  // Optional rule filter.
  let ruleSql = '';
  let joinSql = '';
  if (schedule.rule_id) {
    const built = await buildRuleFilter(schedule.rule_id, level, params);
    if (built) { ruleSql = built.sql; joinSql = built.join; }
  }

  const sql =
    `SELECT DISTINCT t.${pkeyCol} AS pk FROM \`${table}\` t ${joinSql}
     WHERE t.deleted_at IS NULL AND ${timeClause} AND ${scopeSql} ${ruleSql}
     LIMIT 100000`;
  const queryParams = timeParam !== null ? [timeParam, ...params] : [...params];
  const rows = await query(sql, queryParams);
  const pkeys = rows.map(r => r.pk);
  return pkeys;
}

// Resolve the matched action-level pkeys into the { datastoreId, studyInstanceUID,
// seriesInstanceUID } entry shape the BATCH-job expanders (e.g. nifti-expander's
// 'explicit' mode) already understand. This is what lets the scheduler drive the
// EXISTING processing-job templates instead of needing a bespoke one:
//   INSTANCE/SERIES level -> series-grained entries (study+series UID)
//   STUDY level           -> study-grained entries (study UID, series expanded downstream)
//   PATIENT level         -> every study under the patient
async function resolveEntries(level, pkeys) {
  if (!pkeys.length) return [];
  const ph = pkeys.map(() => '?').join(',');
  let sql;
  if (level === 'INSTANCE') {
    sql = `SELECT DISTINCT se.datastore_id AS ds, st.studyinstanceuid AS study, se.seriesinstanceuid AS series
           FROM instance i JOIN series se ON se.series_pkey = i.series_pkey
           JOIN study st ON st.study_pkey = se.study_pkey
           WHERE i.instance_pkey IN (${ph})`;
  } else if (level === 'SERIES') {
    sql = `SELECT DISTINCT se.datastore_id AS ds, st.studyinstanceuid AS study, se.seriesinstanceuid AS series
           FROM series se JOIN study st ON st.study_pkey = se.study_pkey
           WHERE se.series_pkey IN (${ph})`;
  } else if (level === 'STUDY') {
    sql = `SELECT DISTINCT datastore_id AS ds, studyinstanceuid AS study, NULL AS series
           FROM study WHERE study_pkey IN (${ph})`;
  } else { // PATIENT
    sql = `SELECT DISTINCT st.datastore_id AS ds, st.studyinstanceuid AS study, NULL AS series
           FROM study st WHERE st.patient_pkey IN (${ph})`;
  }
  const rows = await query(sql, pkeys);
  return rows.map(r => ({ datastoreId: r.ds, studyInstanceUID: r.study, seriesInstanceUID: r.series || undefined }));
}

// Map a content_pkey (storage_index) to a tree pkey at the given level, via the
// instance row. Returns the column expression selected in the VF subquery.
function levelPkeyFromContent(level) {
  switch (level) {
    case 'INSTANCE': return 'i2.instance_pkey';
    case 'SERIES': return 'i2.series_pkey';
    case 'STUDY': return '(SELECT s.study_pkey FROM series s WHERE s.series_pkey = i2.series_pkey)';
    case 'PATIENT': return '(SELECT st.patient_pkey FROM series se JOIN study st ON st.study_pkey = se.study_pkey WHERE se.series_pkey = i2.series_pkey)';
    default: return 'i2.instance_pkey';
  }
}

// Translate a VF assignment rule into a WHERE fragment that constrains the
// action-level pkey to rows whose backing content matches the rule. Robust at
// ANY action level: it resolves matching content_pkeys via a storage_index/tree
// join (mirroring preview-count), then maps them to the level pkey the same way
// VF scope does. Returns { sql, join } where join is always '' (all work is in a
// subquery, so it composes with any level table without cross-level join bugs).
async function buildRuleFilter(ruleId, level, params) {
  const conds = await query(
    'SELECT attribute_name, operator, value, logic_operator, is_exclusion FROM virtual_folder_assignment_rule_conditions WHERE rule_id = ?',
    [ruleId]);
  if (!conds.length) return null;
  const subParams = [];
  const clauses = [];
  for (const c of conds) {
    const col = ATTR_COL[c.attribute_name];
    if (!col || c.value == null || c.value === '') continue;
    const neg = c.is_exclusion ? 'NOT ' : '';
    const op = String(c.operator || '').toUpperCase();
    if (op === 'EQUALS' || op === '=') { clauses.push(`${neg}(${col} = ?)`); subParams.push(String(c.value)); }
    else if (op === 'LIKE' || op === 'CONTAINS') { clauses.push(`${neg}(${col} LIKE ?)`); subParams.push(`%${c.value}%`); }
    else if (op === 'IN' || op === 'IN_LIST') {
      const vals = String(c.value).split(',').map(s => s.trim()).filter(Boolean);
      if (vals.length) { clauses.push(`${neg}(${col} IN (${vals.map(() => '?').join(',')}))`); subParams.push(...vals); }
    }
  }
  if (!clauses.length) return { sql: '', join: '' };
  const logic = (conds[0].logic_operator === 'OR') ? ' OR ' : ' AND ';
  const pkeyCol = LEVEL_PKEY[level];
  // Matching content -> its instance -> the level pkey (same mapping as VF scope).
  const sql = ` AND t.${pkeyCol} IN (
    SELECT ${levelPkeyFromContent(level)} FROM instance i2
    JOIN storage_index si ON si.content_pkey = i2.content_pkey
    JOIN series se ON se.series_pkey = i2.series_pkey
    JOIN study  st ON st.study_pkey  = se.study_pkey
    JOIN patient p ON p.patient_pkey = st.patient_pkey
    JOIN instance i ON i.instance_pkey = i2.instance_pkey
    WHERE (${clauses.join(logic)}))`;
  params.push(...subParams);
  return { sql, join: '' };
}

// Execute the schedule's processing-job template against the computed target.
async function executeJob(schedule, targetPkeys, entries) {
  const jobs = await query('SELECT * FROM processing_jobs WHERE id = ? AND deleted = FALSE', [schedule.processing_job_id]);
  if (!jobs.length) throw new Error(`processing job ${schedule.processing_job_id} not found`);
  const job = jobs[0];
  const config = JSON.parse(job.config || '{}');
  // PLUGIN definitions run through their expander like BATCH (as in processing-jobs-api).
  const isBatch = job.type === 'BATCH' || job.type === 'PLUGIN';
  const params = JSON.parse(schedule.job_params_json || '{}');
  // The target is BOTH the expander-compatible explicit-entries shape (so the
  // existing BATCH expanders consume it unchanged) AND the raw level/pkeys +
  // scheduleId (so a bespoke job can use them). mode='explicit' + entries is
  // exactly what nifti-expander and the other expanders already parse.
  const target = {
    mode: 'explicit',
    entries: entries || [],
    level: schedule.action_level,
    pkeys: targetPkeys,
    scheduleId: schedule.id,
  };

  // A scheduled run is authorized exactly like a run its creator started by hand:
  // the creator's current grants are persisted as its authorizedScope. The runner
  // no longer trusts created_by='scheduler' (a user can be NAMED scheduler).
  const authorizedScope = await creatorScope(schedule.created_by);
  if (!authorizedScope) throw new Error(`schedule creator ${schedule.created_by || 'unknown'} cannot be authorized`);
  // What the run touches, for run visibility (same shape as a user-started run).
  // A folder-scoped schedule still processes the folder's SOURCE (identified)
  // objects, so the run records the datastores those objects live in as well as
  // the folder. Run visibility then requires read on those datastores, and a
  // folder-only reader cannot see the source UIDs or the outputs.
  const scopeSources = JSON.parse(schedule.scope_json || '[]')
    .map(x => ({ type: x.kind === 'VF' ? 'vf' : 'datastore', id: x.id }));
  const touchedDs = [...new Set((entries || []).map(e => e.datastoreId).filter(Boolean))];
  authorizedScope.sources = [
    ...scopeSources,
    ...touchedDs.filter(id => !scopeSources.some(x => x.type === 'datastore' && x.id === id))
      .map(id => ({ type: 'datastore', id })),
  ];
  authorizedScope.destinations = [];
  const executionId = randomUUID();
  const executionConfig = { ...config, runtimeParams: params, target, authorizedScope };
  await query(
    `INSERT INTO processing_jobs (id, name, type, status, description, config, parent_job_id, created_by)
     VALUES (?, ?, ?, 'PENDING', ?, ?, ?, 'scheduler')`,
    [executionId, `${job.name} - scheduled ${new Date().toISOString().slice(0, 16)}`, job.type, job.description,
     JSON.stringify(executionConfig), schedule.processing_job_id]);

  if (isBatch) {
    if (!config.expanderFunctionArn) throw new Error('job has no expander configured');
    await lambdaClient.send(new InvokeCommand({
      FunctionName: config.expanderFunctionArn, InvocationType: 'Event',
      Payload: JSON.stringify({ ...params, jobId: executionId, parentJobId: schedule.processing_job_id, target }),
    }));
  } else {
    if (!config.stepFunctionArn) throw new Error('job has no step function configured');
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: config.stepFunctionArn, name: executionId,
      input: JSON.stringify({ ...params, jobId: executionId, parentJobId: schedule.processing_job_id, target }),
    }));
  }
  return executionId;
}

async function runSchedule(schedule) {
  // Overlap guard: skip if a prior run of THIS schedule is still marked running.
  if (schedule.running) {
    console.log(`schedule ${schedule.id} still running; skipping this tick`);
    return { skipped: 'running' };
  }

  // F11: re-authorize the scope against the creator's CURRENT grants before every
  // run. If access was revoked, disable the schedule (so it stops firing) and
  // record why — a persistent schedule must not outlive the authorization that
  // created it.
  const scopeErr = await revalidateScope(schedule);
  if (scopeErr) {
    console.warn(`schedule ${schedule.id} blocked: ${scopeErr} — disabling`);
    await query(
      'UPDATE processing_job_schedules SET enabled = FALSE, last_status = ? WHERE id = ?',
      [`BLOCKED: ${scopeErr}`.slice(0, 64), schedule.id]);
    return { scheduleId: schedule.id, status: 'BLOCKED', reason: scopeErr };
  }

  const now = new Date();
  const periodMs = (schedule.period_seconds || 0) * 1000;
  const windowStart = schedule.last_run_at ? new Date(schedule.last_run_at) : new Date(now.getTime() - periodMs);
  const windowStartStr = windowStart.toISOString().slice(0, 19).replace('T', ' ');

  await query('UPDATE processing_job_schedules SET running = TRUE WHERE id = ?', [schedule.id]);
  let status = 'OK', matched = 0, executionId = null;
  try {
    const target = await computeTarget(schedule, windowStartStr);
    matched = target.length;
    if (matched > 0) {
      const entries = await resolveEntries(schedule.action_level, target);
      executionId = await executeJob(schedule, target, entries);
    } else {
      status = 'NO_DATA';
    }
  } catch (e) {
    console.error(`schedule ${schedule.id} failed:`, e.message);
    status = `ERROR: ${e.message}`.slice(0, 64);
  } finally {
    const nextRun = new Date(now.getTime() + periodMs).toISOString().slice(0, 19).replace('T', ' ');
    await query(
      'UPDATE processing_job_schedules SET running = FALSE, last_run_at = ?, next_run_at = ?, last_status = ?, last_matched = ? WHERE id = ?',
      [now.toISOString().slice(0, 19).replace('T', ' '), nextRun, status, matched, schedule.id]);
  }
  return { scheduleId: schedule.id, status, matched, executionId };
}

exports.handler = async (event) => {
  const schedules = await dueSchedules(event || {});
  console.log(`scheduler tick: ${schedules.length} due schedule(s)`);
  const results = [];
  for (const s of schedules) {
    try { results.push(await runSchedule(s)); }
    catch (e) { console.error(`runSchedule ${s.id}:`, e.message); results.push({ scheduleId: s.id, status: `ERROR: ${e.message}` }); }
  }
  return { processed: results.length, results };
};
