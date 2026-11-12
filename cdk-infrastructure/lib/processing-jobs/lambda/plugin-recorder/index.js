/**
 * plugin-recorder: records plugin step results.
 *
 * Triggered by EventBridge "Batch Job State Change" events for the plugin job
 * queue with status SUCCEEDED or FAILED. Containers never touch the database:
 * they write steps/<n>/result.json to the plugin-io bucket, and this function
 * turns that file (or its absence) into the processing_job_steps row and rolls
 * the run up when its last step lands.
 *
 * Event shapes handled:
 *   - array child   (detail.arrayProperties.index set)   -> one step
 *   - plain job     (no arrayProperties)                  -> step 0
 *   - array parent  (arrayProperties.size, no index)      -> reconcile every
 *                                                            step still open
 *                                                            (covers children
 *                                                            whose own event
 *                                                            was missed)
 * Step updates are guarded on the step not already being terminal, so a
 * duplicate or out-of-order event never double-counts.
 *
 * Two follow-ups hang off a recorded step / finished run:
 *   - write-back: when the run has writeBack 'source' or 'datastore', a COMPLETED step's DICOM
 *     outputs are checked (Part 10 preamble, a SOP Instance UID that is not one
 *     of the step's inputs) and copied into the step's write-back bucket (its
 *     source datastore, or the run's destination datastore) under
 *     plugin-derived/<runId>/<step>/, where the normal ingest pipeline indexes
 *     them like any upload.
 *   - chaining: when a run that has pipeline.next finishes with at least one
 *     COMPLETED step, the next stage's run row is created and the runner is
 *     invoked on target { mode: 'upstream', runId }. The launch is claimed with
 *     a conditional update, so duplicate events start it once.
 */

const { S3Client, GetObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const { BatchClient, DescribeJobsCommand } = require('@aws-sdk/client-batch');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { query, execute } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');

const IO_BUCKET = process.env.PLUGIN_IO_BUCKET || '';
const ARCHIVE_BUCKET_PREFIX = process.env.ARCHIVE_BUCKET_PREFIX || '';
const RUNNER_ARN = process.env.PLUGIN_RUNNER_ARN || '';
const MAX_WRITEBACK_FILES = 1000;
const s3 = new S3Client({});
const batch = new BatchClient({});
const lambdaClient = new LambdaClient({});
const TERMINAL = ['COMPLETED', 'FAILED', 'SKIPPED'];

async function readResult(runId, index) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: IO_BUCKET, Key: `runs/${runId}/steps/${index}/result.json` }));
    const text = await r.Body.transformToString();
    if (text.length > 1_000_000) return { error: 'result.json exceeds 1 MB' };
    return { result: JSON.parse(text) };
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return { missing: true };
    if (e instanceof SyntaxError) return { error: 'result.json is not valid JSON' };
    throw e;
  }
}

function sanitizeOutputs(outputs) {
  if (!Array.isArray(outputs)) return [];
  return outputs.slice(0, 200).filter(o => o && typeof o.key === 'string').map(o => ({
    key: o.key.replace(/^\/+/, '').slice(0, 512),
    contentType: typeof o.contentType === 'string' ? o.contentType.slice(0, 100) : undefined,
    label: typeof o.label === 'string' ? o.label.slice(0, 200) : undefined,
  })).filter(o => o.key.startsWith('output/') && !o.key.includes('..'));
}

// ---------------------------------------------------------------------------
// DICOM write-back
// ---------------------------------------------------------------------------

/**
 * Read (0002,0003) MediaStorageSOPInstanceUID from a Part 10 header. The file
 * meta group is always explicit VR little endian, so this needs no DICOM
 * library. Returns { sopInstanceUid } or { error }.
 */
function parsePart10Meta(buf) {
  if (!buf || buf.length < 144 || buf.toString('latin1', 128, 132) !== 'DICM') return { error: 'not a DICOM Part 10 file (no DICM preamble)' };
  let off = 132;
  while (off + 8 <= buf.length) {
    const group = buf.readUInt16LE(off);
    if (group !== 0x0002) break;
    const element = buf.readUInt16LE(off + 2);
    const vr = buf.toString('latin1', off + 4, off + 6);
    let len, hdr;
    if (['OB', 'OW', 'OF', 'SQ', 'UT', 'UN'].includes(vr)) { len = buf.readUInt32LE(off + 8); hdr = 12; }
    else { len = buf.readUInt16LE(off + 6); hdr = 8; }
    if (element === 0x0003) {
      const uid = buf.toString('latin1', off + hdr, off + hdr + len).replace(/[\0 ]+$/, '');
      return /^[0-9.]{1,64}$/.test(uid) ? { sopInstanceUid: uid } : { error: 'MediaStorageSOPInstanceUID is not a valid UID' };
    }
    off += hdr + len;
  }
  return { error: 'file meta has no MediaStorageSOPInstanceUID' };
}

const isDicomOutput = (o) => o.contentType === 'application/dicom' || /\.dcm$/i.test(o.key);

async function readJson(bucket, key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await r.Body.transformToString());
}

/** Copy a completed step's DICOM outputs into its source datastore bucket. */
async function writeBackStep(runId, index, output, stepInput) {
  const bucket = stepInput.writeBackBucket;
  const res = { stored: 0, rejected: [] };
  if (!bucket || !bucket.startsWith(ARCHIVE_BUCKET_PREFIX)) {
    res.rejected.push({ key: '*', reason: 'step has no archive bucket to write back to' });
    return res;
  }
  const candidates = (output.outputs || []).filter(isDicomOutput).slice(0, MAX_WRITEBACK_FILES);
  if (!candidates.length) return res;
  // A plugin must mint new UIDs: writing an input's SOP Instance UID back would
  // replace the source instance in the index.
  const input = await readJson(IO_BUCKET, `runs/${runId}/steps/${index}/input.json`);
  const sourceUids = new Set([
    ...(input.instances || []),
    ...((input.series || []).flatMap(x => x.instances || [])),
  ].map(i => i.sopInstanceUid));
  const seen = new Set();
  for (const o of candidates) {
    const srcKey = `runs/${runId}/steps/${index}/${o.key}`;
    try {
      const head = await s3.send(new GetObjectCommand({ Bucket: IO_BUCKET, Key: srcKey, Range: 'bytes=0-65535' }));
      const meta = parsePart10Meta(Buffer.from(await head.Body.transformToByteArray()));
      if (meta.error) { res.rejected.push({ key: o.key, reason: meta.error }); continue; }
      if (sourceUids.has(meta.sopInstanceUid)) { res.rejected.push({ key: o.key, reason: 'reuses the SOP Instance UID of an input instance' }); continue; }
      if (seen.has(meta.sopInstanceUid)) { res.rejected.push({ key: o.key, reason: 'duplicate SOP Instance UID within the step' }); continue; }
      seen.add(meta.sopInstanceUid);
      const name = o.key.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '_');
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: `plugin-derived/${runId}/${index}/${name}`,
        CopySource: `${IO_BUCKET}/${srcKey.split('/').map(encodeURIComponent).join('/')}`,
        ContentType: 'application/dicom',
        MetadataDirective: 'REPLACE',
        Metadata: { 'plugin-run-id': runId, 'plugin-step': String(index) },
      }));
      res.stored++;
    } catch (e) {
      res.rejected.push({ key: o.key, reason: `${e.name || 'Error'}: ${e.message}`.slice(0, 300) });
    }
  }
  return res;
}

/** Record one step. Returns true when the step row actually changed. */
async function recordStep(runId, index, batchStatus, statusReason, runConfig = {}) {
  const { result, missing, error } = await readResult(runId, index);
  let status, output = null, message = null;
  if (result) {
    const s = String(result.status || '').toUpperCase();
    status = s === 'SUCCEEDED' ? 'COMPLETED' : s === 'SKIPPED' ? 'SKIPPED' : 'FAILED';
    output = {
      summary: typeof result.summary === 'string' ? result.summary.slice(0, 2000) : null,
      outputs: sanitizeOutputs(result.outputs),
      metrics: result.metrics && typeof result.metrics === 'object' ? result.metrics : null,
    };
    if (status === 'FAILED') message = (result.error || result.summary || 'Plugin reported failure').toString().slice(0, 4000);
    // A container that exited non-zero but wrote SUCCEEDED is a contract break:
    // trust the exit status.
    if (batchStatus === 'FAILED' && status !== 'FAILED') {
      status = 'FAILED';
      message = `Container exited with failure (${statusReason || 'no reason'}) after writing status ${s}`;
    }
  } else {
    status = 'FAILED';
    message = error || (batchStatus === 'SUCCEEDED'
      ? 'Container exited 0 without writing result.json'
      : `Container failed before writing result.json: ${statusReason || 'no reason given by Batch'}`);
  }

  const res = await execute(
    `UPDATE processing_job_steps
        SET status = ?, output = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP
      WHERE processing_job_id = ? AND step_number = ? AND status NOT IN ('COMPLETED','FAILED','SKIPPED')`,
    [status, output ? JSON.stringify(output) : null, message, runId, index + 1]);
  const changed = (res && res.affectedRows) > 0;
  if (changed) {
    await query('UPDATE processing_jobs SET processed_steps_count = processed_steps_count + 1 WHERE id = ?', [runId]);
    // Only the event that closed the step writes back, so a duplicate event
    // does not copy (and re-ingest) the same files twice.
    if (status === 'COMPLETED' && ['source', 'datastore'].includes(runConfig.writeBack) && output) {
      const rows = await query('SELECT input FROM processing_job_steps WHERE processing_job_id = ? AND step_number = ?', [runId, index + 1]);
      const wb = await writeBackStep(runId, index, output, JSON.parse(rows[0]?.input || '{}'));
      await query(
        "UPDATE processing_job_steps SET output = JSON_SET(COALESCE(output, '{}'), '$.writeBack', CAST(? AS JSON)) WHERE processing_job_id = ? AND step_number = ?",
        [JSON.stringify(wb), runId, index + 1]);
      console.log(`write-back run=${runId} step=${index} stored=${wb.stored} rejected=${wb.rejected.length}`);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Chaining
// ---------------------------------------------------------------------------

async function launchNextStage(runId) {
  const rows = await query('SELECT status, config, created_by FROM processing_jobs WHERE id = ?', [runId]);
  if (!rows.length) return null;
  const run = rows[0];
  const cfg = JSON.parse(run.config || '{}');
  const pipeline = cfg.pipeline;
  if (!pipeline || !Array.isArray(pipeline.next) || !pipeline.next.length) return null;
  if (run.status === 'FAILED') {
    await query("UPDATE processing_jobs SET config = JSON_SET(config, '$.pipeline.error', ?) WHERE id = ? AND JSON_EXTRACT(config, '$.pipeline.error') IS NULL",
      ['Pipeline stopped: this stage completed no steps', runId]);
    return null;
  }
  if (!['COMPLETED', 'PARTIAL'].includes(run.status)) return null;

  const nextRunId = randomUUID();
  // Claim: only one event gets to start the next stage.
  const claim = await execute(
    "UPDATE processing_jobs SET config = JSON_SET(config, '$.pipeline.nextRunId', ?) WHERE id = ? AND JSON_EXTRACT(config, '$.pipeline.nextRunId') IS NULL",
    [nextRunId, runId]);
  if (!(claim && claim.affectedRows > 0)) return null;

  const [stage, ...rest] = pipeline.next;
  const note = async (msg) => query("UPDATE processing_jobs SET config = JSON_SET(config, '$.pipeline.error', ?) WHERE id = ?", [msg, runId]);
  const plugins = await query("SELECT * FROM processing_jobs WHERE id = ? AND type = 'PLUGIN' AND parent_job_id IS NULL AND deleted = FALSE", [stage.pluginId]);
  if (!plugins.length) { await note(`Next stage not started: plugin ${stage.pluginId} no longer exists`); return null; }
  const plugin = plugins[0];
  const pcfg = JSON.parse(plugin.config || '{}');
  if (pcfg.plugin?.enabled === false) { await note(`Next stage not started: plugin "${plugin.name}" is disabled`); return null; }

  const stageNo = (pipeline.stage || 1) + 1;
  const config = {
    ...pcfg,
    runtimeParams: stage.params || {},
    // Same caller, same grants: the snapshot taken when the pipeline was submitted.
    authorizedScope: cfg.authorizedScope,
    target: { mode: 'upstream', runId },
    writeBack: stage.writeBack || 'no',
    ...(stage.writeBackDatastoreId ? { writeBackDatastoreId: stage.writeBackDatastoreId, writeBackDatastoreName: stage.writeBackDatastoreName } : {}),
    pipeline: { rootRunId: pipeline.rootRunId, stage: stageNo, totalStages: pipeline.totalStages, upstreamRunId: runId, next: rest },
  };
  await query(
    `INSERT INTO processing_jobs (id, name, type, status, description, config, parent_job_id, created_by) VALUES (?, ?, 'PLUGIN', 'PENDING', ?, ?, ?, ?)`,
    [nextRunId, `${plugin.name} - stage ${stageNo}/${pipeline.totalStages}`, plugin.description, JSON.stringify(config), plugin.id, run.created_by]);
  await lambdaClient.send(new InvokeCommand({
    FunctionName: RUNNER_ARN,
    InvocationType: 'Event',
    Payload: JSON.stringify({ ...(stage.params || {}), jobId: nextRunId, parentJobId: plugin.id, target: config.target }),
  }));
  console.log(`pipeline ${pipeline.rootRunId}: stage ${stageNo} run=${nextRunId} after ${runId}`);
  return nextRunId;
}

async function rollUp(runId) {
  // Last step in closes the run. Any failure makes it PARTIAL, all failed FAILED.
  await query(
    `UPDATE processing_jobs j
        JOIN (SELECT processing_job_id,
                     SUM(status = 'FAILED') AS failed,
                     SUM(status IN ('COMPLETED','SKIPPED')) AS ok,
                     COUNT(*) AS total
                FROM processing_job_steps WHERE processing_job_id = ? GROUP BY processing_job_id) s
          ON s.processing_job_id = j.id
        SET j.status = CASE WHEN s.failed = 0 THEN 'COMPLETED' WHEN s.ok = 0 THEN 'FAILED' ELSE 'PARTIAL' END
      WHERE j.id = ? AND j.status IN ('PENDING','RUNNING') AND s.failed + s.ok = s.total AND s.total > 0`,
    [runId, runId]);
}

function runIdFrom(detail) {
  const env = detail.container?.environment || [];
  const fromEnv = env.find(e => e.name === 'PLUGIN_RUN_ID');
  if (fromEnv) return fromEnv.value;
  const m = /^plugin-([0-9a-f-]{36})$/.exec(detail.jobName || '');
  return m ? m[1] : null;
}

exports.handler = async (event) => {
  const d = event.detail || {};
  const status = d.status;
  if (!['SUCCEEDED', 'FAILED'].includes(status)) return { ignored: status };
  const runId = runIdFrom(d);
  if (!runId) { console.warn('No plugin run id in event', d.jobName); return { ignored: 'no-run-id' }; }
  const runRows = await query('SELECT config FROM processing_jobs WHERE id = ?', [runId]);
  const runConfig = JSON.parse(runRows[0]?.config || '{}');

  const ap = d.arrayProperties || {};
  if (ap.size && ap.index === undefined) {
    // Array parent finished. EventBridge does not order events, so the
    // parent's event can arrive before some children's: ask Batch for each
    // still-open child's real outcome instead of assuming it failed. A child
    // whose own event lands later finds its step already terminal and no-ops.
    const open = await query(
      `SELECT step_number FROM processing_job_steps
        WHERE processing_job_id = ? AND status NOT IN ('COMPLETED','FAILED','SKIPPED')`, [runId]);
    const ids = open.map(r => `${d.jobId}:${r.step_number - 1}`);
    const childStatus = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const res = await batch.send(new DescribeJobsCommand({ jobs: ids.slice(i, i + 100) }));
      for (const j of res.jobs || []) childStatus.set(j.jobId, { status: j.status, reason: j.statusReason });
    }
    for (const r of open) {
      const c = childStatus.get(`${d.jobId}:${r.step_number - 1}`);
      if (c && !['SUCCEEDED', 'FAILED'].includes(c.status)) continue; // still running: its own event will record it
      const st = c ? c.status : status;
      await recordStep(runId, r.step_number - 1, st, (c && c.reason) || d.statusReason || 'array job finished without this child reporting', runConfig);
    }
  } else {
    const index = ap.index !== undefined ? Number(ap.index) : 0;
    await recordStep(runId, index, status, d.statusReason, runConfig);
  }
  await rollUp(runId);
  const nextRunId = runConfig.pipeline ? await launchNextStage(runId) : null;
  return { runId, status, ...(nextRunId ? { nextRunId } : {}) };
};

exports._internal = { sanitizeOutputs, runIdFrom, TERMINAL, parsePart10Meta, isDicomOutput };
