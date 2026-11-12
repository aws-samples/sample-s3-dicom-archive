const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS } = require('/opt/nodejs/audit-helper');
const { softDelete } = require('/opt/nodejs/versioning-helper');
const { reservedParamKey } = require('/opt/nodejs/job-params');
const { randomUUID } = require('crypto');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const PLUGIN_IO_BUCKET = process.env.PLUGIN_IO_BUCKET;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function toCamelCase(obj) {
  const result = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    result[camelKey] = obj[key];
  }
  return result;
}

function parseRow(r) {
  return { ...toCamelCase(r), config: JSON.parse(r.config || '{}') };
}

// F10: read the caller's datastore/VF read grants from the authorizer context.
// The api-authorizer threads these into requestContext.authorizer as JSON strings
// for every management route (confirmed for processing-jobs).
function readerScope(event) {
  const auth = event.requestContext?.authorizer || {};
  const parse = (v, d) => {
    try { return typeof v === 'string' ? JSON.parse(v) : (v || d); } catch { return d; }
  };
  const ds = parse(auth.datastorePrivileges, []);
  const vf = parse(auth.virtualFolderPrivileges, []);
  return {
    user: auth.username || 'system',
    // A datastore/VF id the caller may READ. '*' (wildcard grant) means all.
    canReadDatastoreIds: Array.isArray(ds)
      ? ds.filter(p => p && p.canRead).map(p => p.datastoreId)
      : [],
    canReadVfIds: Array.isArray(vf)
      ? vf.filter(p => p && (p.canRead || p.canList)).map(p => p.virtualFolderId)
      : [],
    // Write-class grants, for descriptor-declared destinations (future write-jobs).
    canWriteDatastoreIds: Array.isArray(ds)
      ? ds.filter(p => p && p.canStore).map(p => p.datastoreId)
      : [],
    canWriteVfIds: Array.isArray(vf)
      ? vf.filter(p => p && p.canStore === true).map(p => p.virtualFolderId)
      : [],
  };
}

function grantsAllow(ids, targetId) {
  return ids.includes('*') || ids.includes(targetId);
}

/**
 * Apply a plugin manifest's parameter declarations to the submitted params.
 * Unknown params are dropped (the container only sees declared names).
 * Returns { values } or { error }.
 */
function coercePluginParams(decls, raw) {
  const values = {};
  for (const d of decls) {
    let v = raw[d.name];
    if (v === undefined || v === null || v === '') v = d.default;
    if (v === undefined || v === null || v === '') {
      if (d.required) return { error: `Parameter '${d.name}' is required` };
      continue;
    }
    switch (d.type) {
      case 'integer':
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n) || (d.type === 'integer' && !Number.isInteger(n)))
          return { error: `Parameter '${d.name}' must be ${d.type === 'integer' ? 'an integer' : 'a number'}` };
        if (d.min != null && n < d.min) return { error: `Parameter '${d.name}' must be >= ${d.min}` };
        if (d.max != null && n > d.max) return { error: `Parameter '${d.name}' must be <= ${d.max}` };
        values[d.name] = n;
        break;
      }
      case 'boolean':
        values[d.name] = v === true || ['yes', 'true', '1', 'y'].includes(String(v).toLowerCase());
        break;
      case 'enum':
        if (!(d.options || []).includes(String(v))) return { error: `Parameter '${d.name}' must be one of ${(d.options || []).join(', ')}` };
        values[d.name] = String(v);
        break;
      default:
        if (String(v).length > 4000) return { error: `Parameter '${d.name}' is too long` };
        values[d.name] = String(v);
    }
  }
  return { values };
}

const MAX_CHAIN_STAGES = 4;

/**
 * Validate one plugin stage: { pluginId, params, writeBack }. Returns
 * { stage } or { status, code, message }. Used for every stage after the first
 * (the first is the plugin being executed and goes through the normal path).
 */
async function resolveChainStage(raw, granularity, index) {
  const at = `chain[${index}]`;
  if (!raw || typeof raw !== 'object' || typeof raw.pluginId !== 'string')
    return { status: 400, code: 'VALIDATION_ERROR', message: `${at}.pluginId is required` };
  const rows = await query(
    "SELECT id, name, config FROM processing_jobs WHERE id = ? AND type = 'PLUGIN' AND parent_job_id IS NULL AND deleted = FALSE",
    [raw.pluginId]);
  if (!rows.length) return { status: 404, code: 'NOT_FOUND', message: `${at}: plugin ${raw.pluginId} not found` };
  const cfg = JSON.parse(rows[0].config || '{}');
  const m = cfg.plugin?.manifest || {};
  if (cfg.plugin?.enabled === false) return { status: 409, code: 'PLUGIN_DISABLED', message: `${at}: plugin "${rows[0].name}" is disabled` };
  if ((m.granularity || 'series') !== granularity)
    return { status: 400, code: 'VALIDATION_ERROR', message: `${at}: "${rows[0].name}" runs per ${m.granularity || 'series'}, but the pipeline runs per ${granularity}` };
  const rawParams = raw.params && typeof raw.params === 'object' ? raw.params : {};
  const reservedKey = reservedParamKey(rawParams);
  if (reservedKey) return { status: 400, code: 'VALIDATION_ERROR', message: `${at}: parameter name '${reservedKey}' is reserved` };
  const coerced = coercePluginParams(m.parameters || [], rawParams);
  if (coerced.error) return { status: 400, code: 'VALIDATION_ERROR', message: `${at}: ${coerced.error}` };
  const writeBack = parseWriteBack(raw.writeBack ?? rawParams.writeBack, m, raw.writeBackDatastoreId ?? rawParams.writeBackDatastoreId);
  if (writeBack.error) return { status: 400, code: 'VALIDATION_ERROR', message: `${at}: ${writeBack.error}` };
  return { stage: { pluginId: rows[0].id, name: rows[0].name, params: coerced.values, writeBack: writeBack.value,
    ...(writeBack.datastoreId ? { writeBackDatastoreId: writeBack.datastoreId } : {}) } };
}

/**
 * 'no' | 'source' | 'datastore'. Only plugins whose manifest says producesDicom
 * may write back. 'datastore' sends every step's DICOM to one destination
 * datastore, named by writeBackDatastoreId; 'source' to each step's own.
 */
function parseWriteBack(v, manifest, datastoreId) {
  const value = v == null || v === '' ? 'no' : String(v).toLowerCase();
  if (!['no', 'source', 'datastore'].includes(value)) return { error: "writeBack must be 'no', 'source' or 'datastore'" };
  if (value !== 'no' && !manifest.producesDicom) return { error: 'This plugin does not declare producesDicom, so it cannot write back to the archive' };
  if (value === 'datastore') {
    if (typeof datastoreId !== 'string' || !/^[0-9a-f-]{36}$/i.test(datastoreId))
      return { error: "writeBack 'datastore' needs writeBackDatastoreId, the id of the destination datastore" };
    return { value, datastoreId };
  }
  return { value };
}

/** The destination datastore must exist, be ACTIVE, and the caller must be able to store into it. */
async function checkWriteBackDestination(datastoreId, scope) {
  const rows = await query('SELECT id, name, status, s3_bucket_name AS bucket FROM datastores WHERE id = ? AND deleted = FALSE', [datastoreId]);
  if (!rows.length) return { status: 404, code: 'NOT_FOUND', message: `Destination datastore ${datastoreId} not found` };
  if (rows[0].status !== 'ACTIVE') return { status: 409, code: 'DATASTORE_NOT_ACTIVE', message: `Destination datastore "${rows[0].name}" is ${rows[0].status}` };
  if (!grantsAllow(scope.canWriteDatastoreIds, datastoreId))
    return { status: 403, code: 'FORBIDDEN', message: `Writing back needs store permission on datastore "${rows[0].name}"` };
  return { ok: true, name: rows[0].name };
}

// Enumerate the SOURCE datastore/VF ids an execute request references, per the
// target shape (mirrors nifti-expander's expandTarget modes). Returns null for
// modes whose sources are only known after a query runs (sql) — those are
// enforced in the expander against the persisted scope instead.
function explicitSourceIds(target) {
  if (!target || typeof target !== 'object') return { datastoreIds: [], vfIds: [], deferred: false };
  if (target.mode === 'explicit') {
    const dsIds = [...new Set((target.entries || []).map(e => e && e.datastoreId).filter(Boolean))];
    return { datastoreIds: dsIds, vfIds: [], deferred: false };
  }
  if (target.mode === 'sql') {
    // Sources are query-determined; cannot enumerate at submit time.
    return { datastoreIds: [], vfIds: [], deferred: true };
  }
  // Unknown/absent mode: nothing enumerable here; expander will reject unknowns.
  return { datastoreIds: [], vfIds: [], deferred: false };
}

// Security: runs are visible only to their starter or to callers who can read
// everything the run touched (shared rule, also used by plugin-registry).
const { callerReadScope, canSeeRun } = require('/opt/nodejs/run-visibility');
const NOT_FOUND = () => respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Processing job not found' } });

async function listJobs(event) {
  const scope = callerReadScope(event);
  const rows = await query('SELECT * FROM processing_jobs WHERE deleted = FALSE ORDER BY created_at DESC');
  return respond(200, { success: true, data: rows.filter(r => canSeeRun(r, scope)).map(parseRow) });
}

async function getJob(id, event) {
  const rows = await query('SELECT * FROM processing_jobs WHERE id = ? AND deleted = FALSE', [id]);
  if (!rows.length || !canSeeRun(rows[0], callerReadScope(event))) return NOT_FOUND();
  return respond(200, { success: true, data: parseRow(rows[0]) });
}

async function getSteps(id, event) {
  const job = await query('SELECT id, config, created_by, parent_job_id FROM processing_jobs WHERE id = ? AND deleted = FALSE', [id]);
  if (!job.length || !canSeeRun(job[0], callerReadScope(event))) return NOT_FOUND();
  const rows = await query('SELECT * FROM processing_job_steps WHERE processing_job_id = ? ORDER BY step_number', [id]);
  return respond(200, { success: true, data: rows.map(r => ({ ...toCamelCase(r), input: JSON.parse(r.input || '{}'), output: JSON.parse(r.output || '{}') })) });
}

async function executeJob(id, event) {
  const jobs = await query('SELECT * FROM processing_jobs WHERE id = ? AND deleted = FALSE', [id]);
  if (!jobs.length) return respond(404, { success: false, error: { code: 'NOT_FOUND', message: 'Processing job not found' } });

  const job = jobs[0];
  const config = JSON.parse(job.config || '{}');
  const isPlugin = job.type === 'PLUGIN';
  // PLUGIN runs start the same way as BATCH ones: an async invoke of the
  // expander (the shared plugin-runner), which fans out and submits to Batch.
  const isBatch = job.type === 'BATCH' || isPlugin;
  if (isPlugin && job.parent_job_id)
    return respond(400, { success: false, error: { code: 'INVALID_TARGET', message: 'Execute the plugin, not one of its runs' } });
  if (isPlugin && config.plugin && config.plugin.enabled === false)
    return respond(409, { success: false, error: { code: 'PLUGIN_DISABLED', message: 'This plugin is disabled' } });

  // Each job type is started differently: STEP_FUNCTION jobs by StartExecution,
  // BATCH jobs by an async invoke of their expander, which fans the target out
  // into steps and submits the Batch job.
  if (isBatch) {
    if (!config.expanderFunctionArn)
      return respond(400, { success: false, error: { code: 'INVALID_CONFIG', message: 'Job has no expander function configured' } });
  } else if (!config.stepFunctionArn) {
    return respond(400, { success: false, error: { code: 'INVALID_CONFIG', message: 'Job has no step function configured' } });
  }

  // Validate required params from descriptor
  const body = JSON.parse(event.body || '{}');
  const params = body.params || {};
  const reservedKey = reservedParamKey(params);
  if (reservedKey)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: `Parameter name '${reservedKey}' is reserved` } });
  const target = body.target;
  const descriptor = config.descriptor || {};
  for (const p of (descriptor.parameters || [])) {
    if (p.required && !params[p.name])
      return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: `Parameter '${p.name}' is required` } });
  }
  // Plugins declare typed parameters in their manifest: apply defaults, coerce
  // the modal's string values to the declared type and enforce bounds, so the
  // container receives exactly what its manifest promises.
  let writeBack = 'no';
  let writeBackDatastoreId = null;
  let chainStages = [];
  if (isPlugin) {
    const manifest = config.plugin?.manifest || {};
    const wb = parseWriteBack(params.writeBack, manifest, params.writeBackDatastoreId);
    if (wb.error) return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: wb.error } });
    writeBack = wb.value;
    writeBackDatastoreId = wb.datastoreId || null;
    if (body.chain != null) {
      if (!Array.isArray(body.chain) || body.chain.length > MAX_CHAIN_STAGES)
        return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: `chain must be an array of at most ${MAX_CHAIN_STAGES} stages` } });
      for (let i = 0; i < body.chain.length; i++) {
        const r = await resolveChainStage(body.chain[i], manifest.granularity || 'series', i);
        if (!r.stage) return respond(r.status, { success: false, error: { code: r.code, message: r.message } });
        chainStages.push(r.stage);
      }
    }
    const coerced = coercePluginParams(manifest.parameters || [], params);
    if (coerced.error)
      return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: coerced.error } });
    for (const k of Object.keys(params)) delete params[k];
    Object.assign(params, coerced.values);
  }
  // A job that operates on a selection cannot be started without one; without
  // this check the expander would create an execution row that resolves to
  // nothing and immediately fails.
  if (descriptor.acceptsTarget && !target)
    return respond(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'This job runs on a selection and requires a target' } });

  // F10: authorize the data this job will touch against the CALLER's own grants,
  // not just the global canRun that let them reach this route. A job may only run
  // over datastores/VFs the caller can read (source), and write only to those the
  // caller can write (destination, declared by the descriptor). Without this, any
  // canRun user could point a job at another tenant's data.
  const scope = readerScope(event);
  const { datastoreIds: srcDs, vfIds: srcVf, deferred } = explicitSourceIds(target);

  // Sources enumerable at submit time (explicit mode): authorize each now.
  for (const dsId of srcDs) {
    if (!grantsAllow(scope.canReadDatastoreIds, dsId))
      return respond(403, { success: false, error: { code: 'FORBIDDEN', message: `Not authorized to read datastore ${dsId}` } });
  }
  for (const vfId of srcVf) {
    if (!grantsAllow(scope.canReadVfIds, vfId))
      return respond(403, { success: false, error: { code: 'FORBIDDEN', message: `Not authorized to read virtual folder ${vfId}` } });
  }
  // Write-back stores derived DICOM in the source datastore: needs store there.
  // sql-mode sources are checked by the runner against the persisted scope.
  if ([writeBack, ...chainStages.map(c => c.writeBack)].includes('source')) {
    for (const dsId of srcDs) {
      if (!grantsAllow(scope.canWriteDatastoreIds, dsId))
        return respond(403, { success: false, error: { code: 'FORBIDDEN', message: `Writing back needs store permission on datastore ${dsId}` } });
    }
  }
  // A destination datastore is checked here for every stage; the runner checks it again at run time.
  const destinationNames = {};
  for (const destId of [writeBackDatastoreId, ...chainStages.map(c => c.writeBackDatastoreId)].filter(Boolean)) {
    const chk = await checkWriteBackDestination(destId, scope);
    if (!chk.ok) return respond(chk.status, { success: false, error: { code: chk.code, message: chk.message } });
    destinationNames[destId] = chk.name;
  }

  // Destination (future write-jobs): the descriptor declares a destination param
  // + required write access. Authorize it against the caller's write grants.
  const destinations = [];
  const destSpec = descriptor.scope && descriptor.scope.destination;
  if (destSpec && destSpec.paramName) {
    const destId = params[destSpec.paramName];
    if (destId) {
      const ok = destSpec.resourceType === 'vf'
        ? grantsAllow(scope.canWriteVfIds, destId) // writing into a VF requires canStore on it, not just read
        : grantsAllow(scope.canWriteDatastoreIds, destId);
      if (!ok)
        return respond(403, { success: false, error: { code: 'FORBIDDEN', message: `Not authorized to write to ${destSpec.resourceType || 'datastore'} ${destId}` } });
      destinations.push({ type: destSpec.resourceType || 'datastore', id: destId, access: 'write' });
    }
  }

  // Persist the caller's authorized scope on the execution as an IMMUTABLE
  // snapshot. The expander re-validates every resolved source (including
  // sql-mode rows that could not be enumerated here) against it, and a privilege
  // revoked between submit and run is therefore still enforced at run time.
  const authorizedScope = {
    user: scope.user,
    canReadDatastoreIds: scope.canReadDatastoreIds,
    canReadVfIds: scope.canReadVfIds,
    canWriteDatastoreIds: scope.canWriteDatastoreIds,
    sources: [
      ...srcDs.map(id => ({ type: 'datastore', id })),
      ...srcVf.map(id => ({ type: 'vf', id })),
    ],
    destinations,
    sqlSourcesDeferred: deferred,
  };

  // Create execution record
  const executionId = randomUUID();
  const username = event.requestContext?.authorizer?.username || 'system';
  // The target is persisted alongside the params so a completed run still shows
  // what it was asked to operate on - the expander does not keep it anywhere else.
  const executionConfig = { ...config, runtimeParams: params, authorizedScope, ...(target ? { target } : {}) };
  if (isPlugin) {
    executionConfig.writeBack = writeBack;
    if (writeBackDatastoreId) {
      executionConfig.writeBackDatastoreId = writeBackDatastoreId;
      executionConfig.writeBackDatastoreName = destinationNames[writeBackDatastoreId];
    }
    for (const c of chainStages) if (c.writeBackDatastoreId) c.writeBackDatastoreName = destinationNames[c.writeBackDatastoreId];
    // The recorder starts each next stage on the steps this one completed.
    if (chainStages.length) executionConfig.pipeline = { rootRunId: executionId, stage: 1, totalStages: chainStages.length + 1, next: chainStages };
  }

  await query(
    `INSERT INTO processing_jobs (id, name, type, status, description, config, parent_job_id, created_by) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
    [executionId, `${job.name} - ${params.exportName || new Date().toISOString().slice(0, 10)}`, job.type, job.description, JSON.stringify(executionConfig), id, username]
  );

  if (isBatch) {
    // Event invocation: expansion can page Athena for minutes, far longer than
    // the caller should wait on an HTTP request.
    const lambdaClient = new LambdaClient({});
    await lambdaClient.send(new InvokeCommand({
      FunctionName: config.expanderFunctionArn,
      InvocationType: 'Event',
      // System keys come last so a caller-supplied param can never replace them.
      Payload: JSON.stringify({ ...params, jobId: executionId, parentJobId: id, target }),
    }));
  } else {
    const sfn = new SFNClient({});
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: config.stepFunctionArn,
      name: executionId,
      input: JSON.stringify({ ...params, jobId: executionId, parentJobId: id }),
    }));
  }
  // The row was inserted as PENDING. No status write here: the runner claims the
  // run asynchronously, and a late write would move a claimed run back.

  await sendAuditEvent({
    action: AUDIT_ACTIONS.CREATE, resourceType: 'PROCESSING_JOB_EXECUTION', resourceId: executionId,
    resourceName: job.name, username, details: { parentJobId: id, params, target, ...(chainStages.length ? { chain: chainStages.map(c => c.pluginId) } : {}), ...(writeBack !== 'no' ? { writeBack } : {}), ...(writeBackDatastoreId ? { writeBackDatastoreId } : {}) },
    httpMethod: event.httpMethod, path: event.path,
  });

  return respond(201, { success: true, data: { id: executionId, status: 'PENDING' } });
}

// A plugin run's files live under runs/<runId>/ in the plugin I/O bucket and
// never expire, so deleting the run deletes them too.
async function deletePluginRunFiles(runId) {
  if (!PLUGIN_IO_BUCKET) throw new Error('PLUGIN_IO_BUCKET is not configured');
  let deleted = 0;
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: PLUGIN_IO_BUCKET, Prefix: `runs/${runId}/`, ContinuationToken: token }));
    const keys = (page.Contents || []).map(c => ({ Key: c.Key }));
    if (keys.length) {
      const r = await s3.send(new DeleteObjectsCommand({ Bucket: PLUGIN_IO_BUCKET, Delete: { Objects: keys, Quiet: true } }));
      if (r.Errors?.length) throw new Error(`Could not delete ${r.Errors.length} run file(s): ${r.Errors[0].Code}`);
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

async function deleteJob(id, event) {
  const username = event.requestContext?.authorizer?.username || 'system';
  const rows = await query('SELECT * FROM processing_jobs WHERE id = ? AND deleted = FALSE', [id]);
  // Same run-visibility rule as getJob/getSteps/listJobs: a caller who cannot
  // see the run cannot delete it (404, so existence is not leaked).
  if (!rows.length || !canSeeRun(rows[0], callerReadScope(event))) return NOT_FOUND();
  const isPluginRun =rows[0].type === 'PLUGIN' && !!rows[0].parent_job_id;
  let filesDeleted;
  if (isPluginRun) {
    if (['PENDING', 'RUNNING'].includes(rows[0].status)) {
      return respond(409, { success: false, error: { code: 'CONFLICT', message: 'The run is still in progress; delete it once it has finished' } });
    }
    // The next pipeline stage downloads this run's outputs while it runs.
    const next = JSON.parse(rows[0].config || '{}').pipeline?.nextRunId;
    if (next) {
      const n = await query('SELECT status FROM processing_jobs WHERE id = ?', [next]);
      if (n.length && ['PENDING', 'RUNNING'].includes(n[0].status)) {
        return respond(409, { success: false, error: { code: 'CONFLICT', message: 'The next pipeline stage is still reading this run\'s files; delete it once that stage has finished' } });
      }
    }
    // Files first: if this fails the run stays listed and the user can retry.
    filesDeleted = await deletePluginRunFiles(id);
  }
  await softDelete('processing_jobs', id, username);
  await sendAuditEvent({
    action: AUDIT_ACTIONS.DELETE, resourceType: 'PROCESSING_JOB', resourceId: id,
    resourceName: rows[0].name, username, httpMethod: event.httpMethod, path: event.path,
    ...(isPluginRun ? { details: { filesDeleted } } : {}),
  });
  return respond(200, { success: true, data: { id } });
}

exports._internal = { coercePluginParams, parseWriteBack, resolveChainStage };

exports.handler = async (event, context) => {
  try {
    const method = event.httpMethod;
    const path = event.path || '';
    const segments = (event.pathParameters?.proxy || '').split('/');
    const id = segments[0] || undefined;

    if (path.includes('/steps') && method === 'GET' && id) return await getSteps(id, event);
    if (path.includes('/execute') && method === 'POST' && id) return await executeJob(id, event);
    if (method === 'GET' && !id) return await listJobs(event);
    if (method === 'GET' && id) return await getJob(id, event);
    if (method === 'DELETE' && id) return await deleteJob(id, event);

    return respond(405, { success: false, error: { code: 'METHOD_NOT_ALLOWED' } });
  } catch (error) {
    console.error('Error:', error.message);
    return respond(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  }
};
