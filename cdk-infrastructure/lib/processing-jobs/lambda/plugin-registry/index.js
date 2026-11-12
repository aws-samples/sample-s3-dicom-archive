/**
 * plugin-registry: CRUD for processing-job plugins.
 *
 *   GET    /processing-jobs/plugins                 list plugins
 *   POST   /processing-jobs/plugins                 register  { manifest }
 *   POST   /processing-jobs/plugins/validate        dry-run validation { manifest }
 *   GET    /processing-jobs/plugins/{id}            one plugin
 *   PUT    /processing-jobs/plugins/{id}            replace manifest (re-registers the job definition)
 *   POST   /processing-jobs/plugins/{id}/enable     enable
 *   POST   /processing-jobs/plugins/{id}/disable    disable
 *   DELETE /processing-jobs/plugins/{id}            soft-delete + deregister job definition
 *   GET    /processing-jobs/runs/{runId}/outputs    outputs of a plugin run (presigned download URLs)
 *   DELETE /processing-jobs/runs/{runId}/outputs    delete every file the run left in the I/O bucket
 *   DELETE /processing-jobs/runs/{runId}/outputs?key=<key>   delete one output file (key as listed by GET)
 *
 * A plugin is a processing_jobs row with type 'PLUGIN'. Its config carries
 *   descriptor        - the parameter form the existing job modal renders
 *   expanderFunctionArn - the shared plugin-runner (so execute works like BATCH)
 *   plugin            - { manifest, jobDefinitionArn, enabled, imageUri }
 *
 * Only images from this account's ECR, in repositories named
 * `<stackPrefix>-plugin-*`, are accepted: a plugin cannot pull arbitrary code
 * from a public registry, and an operator controls which repos exist.
 */

const { BatchClient, RegisterJobDefinitionCommand, DeregisterJobDefinitionCommand } = require('@aws-sdk/client-batch');
const { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS } = require('/opt/nodejs/audit-helper');
const { softDelete } = require('/opt/nodejs/versioning-helper');
const { randomUUID } = require('crypto');

const STACK_PREFIX = (process.env.STACK_PREFIX || '').toLowerCase();
const ACCOUNT = process.env.AWS_ACCOUNT_ID || '';
const REGION = process.env.AWS_REGION || '';
const RUNNER_ARN = process.env.PLUGIN_RUNNER_ARN || '';
const JOB_ROLE_ARN = process.env.PLUGIN_JOB_ROLE_ARN || '';
const EXEC_ROLE_ARN = process.env.PLUGIN_EXEC_ROLE_ARN || '';
const IO_BUCKET = process.env.PLUGIN_IO_BUCKET || '';
const LOG_GROUP = process.env.PLUGIN_LOG_GROUP || '';
// Exact image URIs allowed in addition to the <prefix>-plugin-* repositories:
// the bundled sample plugin, which CDK builds into its own asset repository.
const EXTRA_ALLOWED_IMAGES = (process.env.PLUGIN_EXTRA_ALLOWED_IMAGES || '').split(',').map(s => s.trim()).filter(Boolean);

const batch = new BatchClient({});
const s3 = new S3Client({});

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
const respond = (statusCode, body) => ({ statusCode, headers: CORS, body: JSON.stringify(body) });
const err = (statusCode, code, message, details) =>
  respond(statusCode, { success: false, error: { code, message, ...(details ? { details } : {}) } });

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

// Valid Fargate vCPU -> memory (MiB) combinations.
const FARGATE_MEMORY = {
  0.25: [512, 1024, 2048],
  0.5: [1024, 2048, 3072, 4096],
  1: [2048, 3072, 4096, 5120, 6144, 7168, 8192],
  2: range(4096, 16384, 1024),
  4: range(8192, 30720, 1024),
  8: range(16384, 61440, 4096),
  16: range(32768, 122880, 8192),
};
function range(a, b, step) { const r = []; for (let x = a; x <= b; x += step) r.push(x); return r; }

const PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'enum']);
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const RESERVED_PARAMS = new Set(['jobId', 'parentJobId', 'target', 'maxSeries', 'writeBack', 'writeBackDatastoreId', 'chain']);
// GPU plugins run on the EC2 GPU queue (g4dn/g5/g6). Batch's GPU AMI is x86_64
// only, so a GPU plugin must ship an x86_64 image.
const MAX_GPUS = 4;
const GPU_MAX_VCPU = 32;
const GPU_MAX_MEMORY_MIB = 122880;

function imageRepoPattern() {
  // <acct>.dkr.ecr.<region>.amazonaws.com/<prefix>-plugin-<name>[:tag|@sha256:...]
  const acct = ACCOUNT.replace(/[^0-9]/g, '');
  const region = REGION.replace(/[^a-z0-9-]/g, '');
  const prefix = STACK_PREFIX.replace(/[^a-z0-9-]/g, '');
  return new RegExp(`^${acct}\\.dkr\\.ecr\\.${region}\\.amazonaws\\.com/${prefix}-plugin-[a-z0-9._/-]{1,200}(:[A-Za-z0-9._-]{1,128}|@sha256:[a-f0-9]{64})$`);
}

function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest must be a JSON object'] };

  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 200) errors.push('name is required (1-200 chars)');
  if (m.description != null && (typeof m.description !== 'string' || m.description.length > 2000)) errors.push('description must be a string up to 2000 chars');

  if (typeof m.image !== 'string' || !(imageRepoPattern().test(m.image) || EXTRA_ALLOWED_IMAGES.includes(m.image)))
    errors.push(`image must be an ECR image in this account and region, in a repository named ${STACK_PREFIX}-plugin-*, with a tag or digest`);
  if (m.slug != null && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(m.slug))) errors.push('slug must be lowercase letters, digits and hyphens (max 63)');

  if (m.granularity != null && !['series', 'study'].includes(m.granularity)) errors.push('granularity must be "series" or "study"');
  if (m.architecture != null && !['X86_64', 'ARM64'].includes(m.architecture)) errors.push('architecture must be X86_64 or ARM64');

  const r = m.resources || {};
  const vcpu = r.vcpu == null ? 1 : Number(r.vcpu);
  const mem = r.memoryMiB == null ? 2048 : Number(r.memoryMiB);
  const timeout = r.timeoutMinutes == null ? 60 : Number(r.timeoutMinutes);
  const gpu = r.gpu == null ? 0 : Number(r.gpu);
  const ephemeralGiB = r.ephemeralGiB == null ? 21 : Number(r.ephemeralGiB);
  if (!Number.isInteger(gpu) || gpu < 0 || gpu > MAX_GPUS) errors.push(`resources.gpu must be an integer from 0 to ${MAX_GPUS}`);
  if (gpu > 0) {
    if ((m.architecture || 'X86_64') !== 'X86_64') errors.push('GPU plugins must use architecture X86_64 (the Batch GPU AMI is x86_64 only)');
    if (!Number.isInteger(vcpu) || vcpu < 1 || vcpu > GPU_MAX_VCPU) errors.push(`resources.vcpu must be an integer from 1 to ${GPU_MAX_VCPU} for GPU plugins`);
    if (!Number.isInteger(mem) || mem < 1024 || mem > GPU_MAX_MEMORY_MIB) errors.push(`resources.memoryMiB must be an integer from 1024 to ${GPU_MAX_MEMORY_MIB} for GPU plugins`);
  } else if (!FARGATE_MEMORY[vcpu]) errors.push(`resources.vcpu must be one of ${Object.keys(FARGATE_MEMORY).join(', ')}`);
  else if (!FARGATE_MEMORY[vcpu].includes(mem)) errors.push(`resources.memoryMiB ${mem} is not valid for ${vcpu} vCPU on Fargate`);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 720) errors.push('resources.timeoutMinutes must be an integer from 1 to 720');
  if (!Number.isInteger(ephemeralGiB) || ephemeralGiB < 21 || ephemeralGiB > 200) errors.push('resources.ephemeralGiB must be an integer from 21 to 200');
  if (m.producesDicom != null && typeof m.producesDicom !== 'boolean') errors.push('producesDicom must be true or false');

  if (m.maxSteps != null && (!Number.isInteger(m.maxSteps) || m.maxSteps < 1 || m.maxSteps > 5000)) errors.push('maxSteps must be an integer from 1 to 5000');

  const params = m.parameters == null ? [] : m.parameters;
  if (!Array.isArray(params)) errors.push('parameters must be an array');
  else {
    const names = new Set();
    params.forEach((p, i) => {
      const at = `parameters[${i}]`;
      if (!p || typeof p !== 'object') { errors.push(`${at} must be an object`); return; }
      if (!NAME_RE.test(p.name || '')) errors.push(`${at}.name must match ${NAME_RE}`);
      else if (RESERVED_PARAMS.has(p.name)) errors.push(`${at}.name "${p.name}" is reserved`);
      else if (names.has(p.name)) errors.push(`${at}.name "${p.name}" is duplicated`);
      names.add(p.name);
      if (!PARAM_TYPES.has(p.type)) errors.push(`${at}.type must be one of ${[...PARAM_TYPES].join(', ')}`);
      if (p.type === 'enum' && (!Array.isArray(p.options) || !p.options.length || p.options.some(o => typeof o !== 'string')))
        errors.push(`${at}.options must be a non-empty array of strings for enum`);
      if (p.type === 'enum' && p.default != null && Array.isArray(p.options) && !p.options.includes(p.default))
        errors.push(`${at}.default must be one of options`);
      if ((p.min != null || p.max != null) && !['integer', 'number'].includes(p.type)) errors.push(`${at}.min/max only apply to integer and number`);
    });
    if (params.length > 30) errors.push('at most 30 parameters');
  }
  return {
    ok: errors.length === 0, errors,
    normalized: errors.length ? null : {
      ...m,
      granularity: m.granularity || 'series',
      architecture: m.architecture || 'X86_64',
      resources: { vcpu, memoryMiB: mem, timeoutMinutes: timeout, gpu, ephemeralGiB },
      producesDicom: m.producesDicom === true,
      maxSteps: m.maxSteps || 500,
      parameters: params,
    },
  };
}

/** Map manifest parameters to the descriptor shape the existing job modal renders. */
function toDescriptor(m) {
  const writeBack = m.producesDicom ? [{
    // Not a manifest parameter: the platform handles it (see plugin-recorder).
    name: 'writeBack', type: 'select', label: 'Write DICOM outputs back to the archive', required: false,
    default: 'no', options: ['no', 'source', 'datastore'],
    description: "'source' stores the plugin's DICOM outputs in each step's source datastore; 'datastore' stores them all in the destination datastore below. Either way they are indexed like any upload, and you need store permission there.",
  }, {
    name: 'writeBackDatastoreId', type: 'datastore-select', label: 'Destination datastore', required: false,
    showWhen: { param: 'writeBack', equals: 'datastore' },
    description: 'Used when write-back is "datastore".',
  }] : [];
  return {
    acceptsTarget: true,
    granularity: m.granularity,
    parameters: [...m.parameters.map(p => ({
      name: p.name,
      // The modal renders text/select inputs; booleans become yes/no selects.
      type: p.type === 'enum' ? 'select' : p.type === 'boolean' ? 'select' : 'text',
      label: p.label || p.name,
      required: !!p.required,
      default: p.default == null ? '' : String(p.type === 'boolean' ? (p.default ? 'yes' : 'no') : p.default),
      ...(p.type === 'enum' ? { options: p.options } : {}),
      ...(p.type === 'boolean' ? { options: ['yes', 'no'] } : {}),
      description: p.description || '',
      pluginType: p.type,
      ...(p.min != null ? { min: p.min } : {}),
      ...(p.max != null ? { max: p.max } : {}),
    })), ...writeBack],
  };
}

async function registerJobDefinition(pluginId, m) {
  const name = `${STACK_PREFIX}-plugin-${pluginId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
  const res = await batch.send(new RegisterJobDefinitionCommand(jobDefinitionInput(name, pluginId, m)));
  return res.jobDefinitionArn;
}

/** Fargate for CPU plugins; EC2 (GPU queue) when the manifest asks for GPUs. */
function jobDefinitionInput(name, pluginId, m) {
  const gpu = m.resources.gpu || 0;
  const logConfiguration = {
    logDriver: 'awslogs',
    options: { 'awslogs-group': LOG_GROUP, 'awslogs-region': REGION, 'awslogs-stream-prefix': `plugin-${pluginId}` },
  };
  const common = {
    jobDefinitionName: name,
    type: 'container',
    timeout: { attemptDurationSeconds: m.resources.timeoutMinutes * 60 },
    // One retry covers task-start failures (image pull hiccups, capacity).
    retryStrategy: { attempts: 2 },
    propagateTags: true,
    tags: { Deployment: STACK_PREFIX, PluginId: pluginId },
  };
  if (gpu > 0) {
    return {
      ...common,
      platformCapabilities: ['EC2'],
      containerProperties: {
        image: m.image,
        jobRoleArn: JOB_ROLE_ARN,
        executionRoleArn: EXEC_ROLE_ARN,
        resourceRequirements: [
          { type: 'VCPU', value: String(m.resources.vcpu) },
          { type: 'MEMORY', value: String(m.resources.memoryMiB) },
          { type: 'GPU', value: String(gpu) },
        ],
        logConfiguration,
        environment: [{ name: 'PLUGIN_ID', value: pluginId }],
      },
    };
  }
  return {
    ...common,
    platformCapabilities: ['FARGATE'],
    timeout: { attemptDurationSeconds: m.resources.timeoutMinutes * 60 },
    // One retry covers task-start failures (image pull hiccups, capacity).
    retryStrategy: { attempts: 2 },
    propagateTags: true,
    tags: { Deployment: STACK_PREFIX, PluginId: pluginId },
    containerProperties: {
      image: m.image,
      jobRoleArn: JOB_ROLE_ARN,
      executionRoleArn: EXEC_ROLE_ARN,
      resourceRequirements: [
        { type: 'VCPU', value: String(m.resources.vcpu) },
        { type: 'MEMORY', value: String(m.resources.memoryMiB) },
      ],
      runtimePlatform: { cpuArchitecture: m.architecture, operatingSystemFamily: 'LINUX' },
      networkConfiguration: { assignPublicIp: 'DISABLED' },
      ephemeralStorage: { sizeInGiB: Math.min(200, Math.max(21, parseInt(m.resources.ephemeralGiB, 10) || 21)) },
      logConfiguration,
      environment: [{ name: 'PLUGIN_ID', value: pluginId }],
    },
  };
}

async function deregister(arn) {
  if (!arn) return;
  try { await batch.send(new DeregisterJobDefinitionCommand({ jobDefinition: arn })); }
  catch (e) { console.warn(`deregister ${arn} failed: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function toPlugin(row) {
  const cfg = JSON.parse(row.config || '{}');
  const p = cfg.plugin || {};
  return {
    id: row.id, name: row.name, description: row.description, status: row.status,
    enabled: p.enabled !== false, manifest: p.manifest || null, jobDefinitionArn: p.jobDefinitionArn || null,
    createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by,
  };
}

async function loadPlugin(id) {
  const rows = await query("SELECT * FROM processing_jobs WHERE id = ? AND type = 'PLUGIN' AND parent_job_id IS NULL AND deleted = FALSE", [id]);
  return rows[0] || null;
}

const username = (event) => event.requestContext?.authorizer?.username || 'system';

// Plugin management uses the existing processing-jobs management privileges
// (the same ones the authorizer gates the routes with): canCreate to register,
// replace, enable or disable; canDelete to delete. Checked here as well so the
// rule holds even if a route policy is widened later.
function canManage(event, action) {
  const a = event.requestContext?.authorizer || {};
  try {
    const mp = typeof a.managementPrivileges === 'string' ? JSON.parse(a.managementPrivileges) : (a.managementPrivileges || {});
    const pj = mp.processingJobs || {};
    return action === 'delete' ? !!pj.canDelete : !!pj.canCreate;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function list() {
  const rows = await query("SELECT * FROM processing_jobs WHERE type = 'PLUGIN' AND parent_job_id IS NULL AND deleted = FALSE ORDER BY created_at DESC");
  return respond(200, { success: true, data: rows.map(toPlugin) });
}

async function create(event, body) {
  const v = validateManifest(body.manifest);
  if (!v.ok) return err(400, 'VALIDATION_ERROR', 'Manifest is not valid', v.errors);
  const m = v.normalized;
  // upsert: a manifest with a slug that matches an existing plugin replaces it.
  // Used by the deploy-time seed so redeploys update the sample instead of
  // duplicating it.
  if (body.upsert && m.slug) {
    const existing = await query(
      `SELECT id FROM processing_jobs WHERE type = 'PLUGIN' AND parent_job_id IS NULL AND deleted = FALSE
         AND JSON_UNQUOTE(JSON_EXTRACT(config, '$.plugin.manifest.slug')) = ? LIMIT 1`, [m.slug]);
    if (existing.length) return replace(event, existing[0].id, body);
  }
  const id = randomUUID();
  const jobDefinitionArn = await registerJobDefinition(id, m);
  const config = {
    descriptor: toDescriptor(m),
    expanderFunctionArn: RUNNER_ARN,
    plugin: { manifest: m, jobDefinitionArn, enabled: true, imageUri: m.image },
  };
  await query(
    `INSERT INTO processing_jobs (id, name, type, status, description, config, created_by)
     VALUES (?, ?, 'PLUGIN', 'DEFINED', ?, ?, ?)`,
    [id, m.name, m.description || null, JSON.stringify(config), username(event)]);
  await sendAuditEvent({
    action: AUDIT_ACTIONS.CREATE, resourceType: 'PROCESSING_JOB_PLUGIN', resourceId: id, resourceName: m.name,
    username: username(event), details: { image: m.image }, httpMethod: event.httpMethod, path: event.path,
  });
  return respond(201, { success: true, data: toPlugin((await query('SELECT * FROM processing_jobs WHERE id = ?', [id]))[0]) });
}

async function replace(event, id, body) {
  const row = await loadPlugin(id);
  if (!row) return err(404, 'NOT_FOUND', 'Plugin not found');
  const v = validateManifest(body.manifest);
  if (!v.ok) return err(400, 'VALIDATION_ERROR', 'Manifest is not valid', v.errors);
  const m = v.normalized;
  const cfg = JSON.parse(row.config || '{}');
  const old = cfg.plugin?.jobDefinitionArn;
  const jobDefinitionArn = await registerJobDefinition(id, m);
  cfg.descriptor = toDescriptor(m);
  cfg.expanderFunctionArn = RUNNER_ARN;
  cfg.plugin = { ...(cfg.plugin || {}), manifest: m, jobDefinitionArn, imageUri: m.image };
  await query('UPDATE processing_jobs SET name = ?, description = ?, config = ?, current_version = current_version + 1 WHERE id = ?',
    [m.name, m.description || null, JSON.stringify(cfg), id]);
  // Runs already submitted keep their revision; Batch resolves the ARN at submit time.
  await deregister(old);
  await sendAuditEvent({
    action: AUDIT_ACTIONS.UPDATE, resourceType: 'PROCESSING_JOB_PLUGIN', resourceId: id, resourceName: m.name,
    username: username(event), details: { image: m.image }, httpMethod: event.httpMethod, path: event.path,
  });
  return respond(200, { success: true, data: toPlugin((await query('SELECT * FROM processing_jobs WHERE id = ?', [id]))[0]) });
}

async function setEnabled(event, id, enabled) {
  const row = await loadPlugin(id);
  if (!row) return err(404, 'NOT_FOUND', 'Plugin not found');
  await query("UPDATE processing_jobs SET config = JSON_SET(config, '$.plugin.enabled', CAST(? AS JSON)) WHERE id = ?",
    [enabled ? 'true' : 'false', id]);
  await sendAuditEvent({
    action: AUDIT_ACTIONS.UPDATE, resourceType: 'PROCESSING_JOB_PLUGIN', resourceId: id, resourceName: row.name,
    username: username(event), details: { enabled }, httpMethod: event.httpMethod, path: event.path,
  });
  return respond(200, { success: true, data: { id, enabled } });
}

async function remove(event, id) {
  const row = await loadPlugin(id);
  if (!row) return err(404, 'NOT_FOUND', 'Plugin not found');
  await softDelete('processing_jobs', id, username(event));
  await deregister(JSON.parse(row.config || '{}').plugin?.jobDefinitionArn);
  await sendAuditEvent({
    action: AUDIT_ACTIONS.DELETE, resourceType: 'PROCESSING_JOB_PLUGIN', resourceId: id, resourceName: row.name,
    username: username(event), httpMethod: event.httpMethod, path: event.path,
  });
  return respond(200, { success: true, data: { id } });
}

// Deletes every object a run left in the I/O bucket (inputs, results, outputs).
// Files are kept until a user deletes them: there is no expiry on runs/.
async function deleteRunFiles(runId) {
  let deleted = 0;
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: IO_BUCKET, Prefix: `runs/${runId}/`, ContinuationToken: token }));
    const keys = (page.Contents || []).map(c => ({ Key: c.Key }));
    if (keys.length) {
      const r = await s3.send(new DeleteObjectsCommand({ Bucket: IO_BUCKET, Delete: { Objects: keys, Quiet: true } }));
      if (r.Errors?.length) throw new Error(`Could not delete ${r.Errors.length} file(s): ${r.Errors[0].Code}`);
      deleted += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

// Why a run's files cannot be deleted right now, or null. A running step still
// reads its input and writes its output, and the next pipeline stage downloads
// this run's outputs while it is pending or running.
async function filesBusyReason(row) {
  if (['PENDING', 'RUNNING'].includes(row.status)) return 'The run is still in progress; delete its files once it has finished';
  const next = JSON.parse(row.config || '{}').pipeline?.nextRunId;
  if (next) {
    const n = await query('SELECT status FROM processing_jobs WHERE id = ?', [next]);
    if (n.length && ['PENDING', 'RUNNING'].includes(n[0].status)) return 'The next pipeline stage is still reading these files; delete them once it has finished';
  }
  return null;
}

// Output keys of a run, exactly as GET .../outputs lists them.
async function listedOutputKeys(runId) {
  const steps = await query('SELECT step_number, output FROM processing_job_steps WHERE processing_job_id = ?', [runId]);
  const keys = new Set();
  for (const s of steps) {
    for (const f of (JSON.parse(s.output || '{}').outputs || [])) {
      if (!f.key) continue;
      const key = `runs/${runId}/steps/${s.step_number - 1}/${String(f.key).replace(/^\/+/, '')}`;
      if (!key.includes('..')) keys.add(key);
    }
  }
  return keys;
}

async function deleteOneOutput(event, row, key) {
  if (!(await listedOutputKeys(row.id)).has(key)) return err(404, 'NOT_FOUND', 'No such output file in this run');
  await s3.send(new DeleteObjectCommand({ Bucket: IO_BUCKET, Key: key }));
  await query(`UPDATE processing_jobs SET config = JSON_SET(COALESCE(config, JSON_OBJECT()), '$.deletedOutputKeys',
      JSON_ARRAY_APPEND(COALESCE(JSON_EXTRACT(config, '$.deletedOutputKeys'), JSON_ARRAY()), '$', ?)) WHERE id = ?`, [key, row.id]);
  await sendAuditEvent({
    action: AUDIT_ACTIONS.DELETE, resourceType: 'PROCESSING_JOB_RUN_OUTPUTS', resourceId: row.id, resourceName: row.name,
    username: username(event), details: { key, filesDeleted: 1 }, httpMethod: event.httpMethod, path: event.path,
  });
  return respond(200, { success: true, data: { runId: row.id, key, filesDeleted: 1 } });
}

async function deleteRunOutputs(event, runId) {
  const rows = await query("SELECT id, name, status, config, parent_job_id, created_by FROM processing_jobs WHERE id = ? AND type = 'PLUGIN' AND deleted = FALSE", [runId]);
  if (!rows.length || !rows[0].parent_job_id || !canSeeRun(rows[0], callerReadScope(event))) return err(404, 'NOT_FOUND', 'Plugin run not found');
  const busy = await filesBusyReason(rows[0]);
  if (busy) return err(409, 'CONFLICT', busy);
  const key = event.queryStringParameters?.key;
  if (key) return deleteOneOutput(event, rows[0], key);
  const deleted = await deleteRunFiles(runId);
  await query("UPDATE processing_jobs SET config = JSON_SET(COALESCE(config, JSON_OBJECT()), '$.outputsDeletedAt', ?, '$.outputsDeletedBy', ?) WHERE id = ?",
    [new Date().toISOString(), username(event), runId]);
  await sendAuditEvent({
    action: AUDIT_ACTIONS.DELETE, resourceType: 'PROCESSING_JOB_RUN_OUTPUTS', resourceId: runId, resourceName: rows[0].name,
    username: username(event), details: { filesDeleted: deleted }, httpMethod: event.httpMethod, path: event.path,
  });
  return respond(200, { success: true, data: { runId, filesDeleted: deleted } });
}

const { callerReadScope, canSeeRun } = require('/opt/nodejs/run-visibility');

async function runOutputs(runId, event) {
  const rows = await query("SELECT id, status, config, parent_job_id, created_by FROM processing_jobs WHERE id = ? AND type = 'PLUGIN' AND deleted = FALSE", [runId]);
  // Security: no presigned links for a run the caller may not see.
  if (!rows.length || !rows[0].parent_job_id || !canSeeRun(rows[0], callerReadScope(event))) return err(404, 'NOT_FOUND', 'Plugin run not found');
  const cfg = JSON.parse(rows[0].config || '{}');
  const outputsDeleted = cfg.outputsDeletedAt ? { at: cfg.outputsDeletedAt, by: cfg.outputsDeletedBy || null } : null;
  const deletedKeys = new Set(cfg.deletedOutputKeys || []);
  const steps = await query('SELECT id, step_number, status, input, output, error_message FROM processing_job_steps WHERE processing_job_id = ? ORDER BY step_number', [runId]);
  const out = [];
  for (const s of steps) {
    const o = JSON.parse(s.output || '{}');
    const files = [];
    for (const f of (outputsDeleted ? [] : (o.outputs || []))) {
      if (!f.key) continue;
      const key = `runs/${runId}/steps/${s.step_number - 1}/${String(f.key).replace(/^\/+/, '')}`;
      if (key.includes('..') || deletedKeys.has(key)) continue;
      files.push({ ...f, key, url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: IO_BUCKET, Key: key }), { expiresIn: 900 }) });
    }
    out.push({ stepNumber: s.step_number, status: s.status, input: JSON.parse(s.input || '{}'), summary: o.summary || null,
      metrics: o.metrics || null, writeBack: o.writeBack || null, error: s.error_message, files });
  }
  return respond(200, { success: true, data: { runId, status: rows[0].status, outputsDeleted, steps: out } });
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod;
    // Path is /api/processing-jobs/<plugins|runs>/...; take everything after processing-jobs/.
    const m = /\/processing-jobs\/(.*)$/.exec(event.path || '');
    const seg = (m ? m[1] : '').split('/').filter(Boolean);
    const body = event.body ? JSON.parse(event.body) : {};

    if (seg[0] === 'runs' && seg[2] === 'outputs' && method === 'GET') return await runOutputs(seg[1], event);
    if (seg[0] === 'runs' && seg[2] === 'outputs' && method === 'DELETE') {
      if (!canManage(event, 'delete')) return err(403, 'FORBIDDEN', 'Not authorized to delete processing-job files');
      return await deleteRunOutputs(event, seg[1]);
    }
    if (seg[0] !== 'plugins') return err(404, 'NOT_FOUND', 'Unknown route');

    if (method === 'GET' && seg.length === 1) return await list();
    if (method === 'GET' && seg.length === 2) {
      const row = await loadPlugin(seg[1]);
      return row ? respond(200, { success: true, data: toPlugin(row) }) : err(404, 'NOT_FOUND', 'Plugin not found');
    }
    if (method === 'POST' && seg[1] === 'validate') {
      const v = validateManifest(body.manifest);
      return respond(200, { success: true, data: { valid: v.ok, errors: v.errors, normalized: v.normalized } });
    }

    const action = method === 'DELETE' ? 'delete' : 'manage';
    if (!canManage(event, action)) return err(403, 'FORBIDDEN', 'Not authorized to manage processing-job plugins');
    if (method === 'POST' && seg.length === 1) return await create(event, body);
    if (method === 'PUT' && seg.length === 2) return await replace(event, seg[1], body);
    if (method === 'POST' && seg[2] === 'enable') return await setEnabled(event, seg[1], true);
    if (method === 'POST' && seg[2] === 'disable') return await setEnabled(event, seg[1], false);
    if (method === 'DELETE' && seg.length === 2) return await remove(event, seg[1]);
    return err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  } catch (e) {
    if (e instanceof SyntaxError) return err(400, 'BAD_REQUEST', 'Body is not valid JSON');
    console.error('plugin-registry error:', e);
    return err(500, 'INTERNAL_ERROR', 'Internal server error');
  }
};

exports._internal = { validateManifest, toDescriptor, imageRepoPattern, jobDefinitionInput };
