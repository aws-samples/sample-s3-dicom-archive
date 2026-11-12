/**
 * plugin-runner: fan-out for a PLUGIN processing job run.
 *
 * Invoked asynchronously by the processing-jobs API with
 *   { jobId, parentJobId, target, ...params }
 * where jobId is the run row (child of the plugin row).
 *
 * 1. Expands the target (explicit study/series selection or an Analytics SQL
 *    query) into steps: one per series, or one per study for study-granularity
 *    plugins.
 * 2. Re-checks every source datastore against the caller's authorized scope
 *    persisted on the run row (F10), so sql-mode sources are enforced too.
 * 3. Writes runs/<runId>/steps/<n>/input.json to the plugin-io bucket. Each
 *    instance is a presigned GET URL, so the container gets no archive IAM and
 *    no database credentials.
 * 4. Submits one AWS Batch job (array job when there are 2+ steps) using the
 *    plugin's registered job definition, on the Fargate queue or, for a
 *    manifest that asks for GPUs, on the EC2 GPU queue.
 *
 * Chained runs (a pipeline stage after the first) arrive with
 * target { mode: 'upstream', runId }: the steps the upstream run COMPLETED
 * become this run's selection, and each step's input.json also carries the
 * matching upstream step's outputs as presigned URLs (`upstream`).
 *
 * Write-back: run config writeBack = 'source' needs store permission on each
 * step's source datastore (steps without it are skipped with the reason);
 * writeBack = 'datastore' sends every step's DICOM to writeBackDatastoreId,
 * which must be ACTIVE and writable by the caller, or the run fails.
 */

const { BatchClient, SubmitJobCommand } = require('@aws-sdk/client-batch');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { query, queryReadOnly, execute } = require('/opt/nodejs/database');
const { guardSql } = require('/opt/nodejs/sql-ast-guard');
const { randomUUID } = require('crypto');

const JOB_QUEUE = process.env.PLUGIN_JOB_QUEUE || '';
const GPU_JOB_QUEUE = process.env.PLUGIN_GPU_JOB_QUEUE || '';
const IO_BUCKET = process.env.PLUGIN_IO_BUCKET || '';
const ARCHIVE_BUCKET_PREFIX = process.env.ARCHIVE_BUCKET_PREFIX || '';
const PAGE_SIZE = 50;
const MAX_URL_TTL_SECONDS = 7 * 24 * 3600; // SigV4 presign ceiling
const READABLE_AVAILABILITY = new Set(['ONLINE', null, undefined, '']);

const batch = new BatchClient({});
const s3 = new S3Client({});

// ---------------------------------------------------------------------------
// Target expansion (same shapes as the NIfTI expander)
// ---------------------------------------------------------------------------

// Plug-in "sql" targets are untrusted SQL (typed by the caller or produced by
// Analytics). They go through the shared AST guard with the run's persisted read
// scope, which injects `datastore_id IN (<readable ids>)` onto every base-table
// read, enforces the analytics table allowlist over the whole query, and returns
// a re-serialized query that is the only text executed. The query then runs as
// the read-only analytics DB user (queryReadOnly fails closed when that user is
// not configured). EdgeSwarm D-1.
const SQL_TARGET_TABLES = new Set(['storage_index', 'patient', 'study', 'series', 'instance']);

// An error whose message is safe to store on the run row and show to users.
// Anything else (DB errors, which can echo SQL fragments and row values; AWS SDK
// errors) is replaced by a generic message.
class TargetError extends Error {}
function publicMessage(err) {
  if (err instanceof TargetError) return err.message;
  if (err && (err.sqlState || err.errno || err.sqlMessage)) return 'The selection query could not be run';
  return 'The run could not be started';
}

function guardTargetSql(userSql, readableDatastoreIds) {
  const baseSql = String(userSql || '').replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*;?\s*$/i, '');
  const g = guardSql(baseSql, { allowTables: SQL_TARGET_TABLES, scope: { kind: 'storage', ids: readableDatastoreIds || [] } });
  if (!g.ok) throw new TargetError(`The selection query was refused: ${g.message}`);
  return g.sql;
}

function buildPageQuery(guardedSql, offset, limit) {
  return `SELECT /*+ MAX_EXECUTION_TIME(60000) */ datastore_id, study_instance_uid, series_instance_uid
  FROM (
    SELECT DISTINCT datastore_id, study_instance_uid, series_instance_uid
    FROM (${guardedSql}) _user_query
    WHERE series_instance_uid IS NOT NULL
  ) _distinct_series
  ORDER BY datastore_id ASC, study_instance_uid ASC, series_instance_uid ASC
  LIMIT ${parseInt(limit, 10) || PAGE_SIZE} OFFSET ${parseInt(offset, 10) || 0}`;
}

const datastoreCache = new Map();
async function resolveDatastore(id) {
  if (!id) return null;
  if (datastoreCache.has(id)) return datastoreCache.get(id);
  const rows = await query('SELECT id, name, status, s3_bucket_name AS bucket FROM datastores WHERE id = ? AND deleted = FALSE', [id]);
  const ds = rows.length ? rows[0] : null;
  datastoreCache.set(id, ds);
  return ds;
}

const SERIES_COLUMNS = `s.series_pkey AS seriesPkey, s.seriesinstanceuid AS seriesInstanceUid,
       s.modality AS modality, s.seriesdescription AS seriesDescription,
       s.availability AS availability, st.studyinstanceuid AS studyInstanceUid`;

async function findSeries(datastoreId, seriesUid) {
  return query(
    `SELECT ${SERIES_COLUMNS} FROM series s JOIN study st ON st.study_pkey = s.study_pkey
      WHERE s.datastore_id = ? AND s.seriesinstanceuid = ? AND s.deleted_at IS NULL`,
    [datastoreId, seriesUid]);
}

async function findStudySeries(datastoreId, studyUid) {
  return query(
    `SELECT ${SERIES_COLUMNS} FROM series s JOIN study st ON st.study_pkey = s.study_pkey
      WHERE s.datastore_id = ? AND st.studyinstanceuid = ? AND s.deleted_at IS NULL
      ORDER BY s.seriesnumber, s.seriesinstanceuid`,
    [datastoreId, studyUid]);
}

/** Flat list of { datastoreId, studyInstanceUid, seriesInstanceUid|null }. */
async function expandTarget(target, maxItems, readableDatastoreIds) {
  const out = [];
  let truncated = false;
  const push = (x) => { if (out.length >= maxItems) { truncated = true; return false; } out.push(x); return true; };

  if (target.mode === 'sql') {
    if (!target.sql) throw new TargetError('target.mode is "sql" but no sql was supplied');
    const guarded = guardTargetSql(target.sql, readableDatastoreIds);
    let offset = 0;
    for (;;) {
      const limit = Math.min(PAGE_SIZE, maxItems - out.length);
      if (limit <= 0) { truncated = true; break; }
      // Guarded SQL, run as the read-only analytics DB user.
      const rows = await queryReadOnly(buildPageQuery(guarded, offset, limit));
      if (!rows.length) break;
      for (const r of rows) {
        if (!push({ datastoreId: r.datastore_id, studyInstanceUid: r.study_instance_uid || null, seriesInstanceUid: r.series_instance_uid })) break;
      }
      offset += rows.length;
      if (rows.length < limit) break;
    }
  } else if (target.mode === 'explicit') {
    for (const e of (target.entries || [])) {
      if (!push({
        datastoreId: e.datastoreId,
        studyInstanceUid: e.studyInstanceUID || e.studyInstanceUid || null,
        seriesInstanceUid: e.seriesInstanceUID || e.seriesInstanceUid || null,
      })) break;
    }
  } else {
    throw new TargetError('Unsupported target mode');
  }
  return { items: out, truncated };
}

// ---------------------------------------------------------------------------
// Chained runs: the upstream run's completed steps are this run's target
// ---------------------------------------------------------------------------

const groupKey = (granularity, datastoreId, studyUid, seriesUid) =>
  granularity === 'study' ? `${datastoreId}|study|${studyUid}` : `${datastoreId}|series|${seriesUid}`;

/**
 * Returns { target, upstreamByKey } for target { mode: 'upstream', runId }.
 * upstreamByKey maps a step's group key to the upstream step that produced it.
 */
async function loadUpstream(upstreamRunId, granularity) {
  const run = await query("SELECT id, name FROM processing_jobs WHERE id = ? AND type = 'PLUGIN' AND deleted = FALSE", [upstreamRunId]);
  if (!run.length) throw new TargetError(`Upstream run ${upstreamRunId} not found`);
  const steps = await query(
    "SELECT step_number, input, output FROM processing_job_steps WHERE processing_job_id = ? AND status = 'COMPLETED' ORDER BY step_number",
    [upstreamRunId]);
  const entries = [];
  const upstreamByKey = new Map();
  for (const st of steps) {
    const input = JSON.parse(st.input || '{}');
    const output = JSON.parse(st.output || '{}');
    const ref = { runId: upstreamRunId, runName: run[0].name, step: st.step_number - 1, summary: output.summary || null, outputs: output.outputs || [] };
    if (granularity === 'study') {
      entries.push({ datastoreId: input.datastoreId, studyInstanceUID: input.studyInstanceUid });
      upstreamByKey.set(groupKey('study', input.datastoreId, input.studyInstanceUid), ref);
    } else {
      for (const uid of (input.seriesInstanceUids || [])) {
        entries.push({ datastoreId: input.datastoreId, seriesInstanceUID: uid });
        upstreamByKey.set(groupKey('series', input.datastoreId, null, uid), ref);
      }
    }
  }
  return { target: { mode: 'explicit', entries }, upstreamByKey };
}

async function presignUpstream(ref, ttlSeconds) {
  if (!ref) return null;
  const outputs = [];
  for (const o of ref.outputs.slice(0, 200)) {
    const key = `runs/${ref.runId}/steps/${ref.step}/${String(o.key).replace(/^\/+/, '')}`;
    if (key.includes('..')) continue;
    outputs.push({ ...o, url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: IO_BUCKET, Key: key }), { expiresIn: ttlSeconds }) });
  }
  return { runId: ref.runId, runName: ref.runName, step: ref.step, summary: ref.summary, outputs };
}

// ---------------------------------------------------------------------------
// Instances + presigning
// ---------------------------------------------------------------------------

async function loadInstances(datastoreId, seriesPkey) {
  return query(
    `SELECT i.sopinstanceuid AS sopInstanceUid, i.instancenumber AS instanceNumber,
            i.instanceavailability AS availability,
            l.s3_bucket_name AS bucket, l.s3_key AS s3Key, l.member_offset AS memberOffset, l.member_length AS memberLength,
            m.metadataendoffset AS metadataEndOffset, m.jpeg_tables_offset AS jpegTablesOffset
       FROM instance i
       JOIN storage_index l ON l.content_pkey = i.content_pkey AND l.deleted_at IS NULL
       LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey
      WHERE i.datastore_id = ? AND i.series_pkey = ? AND i.deleted_at IS NULL
      ORDER BY i.instancenumber, i.sopinstanceuid`,
    [datastoreId, seriesPkey]);
}

async function presignInstances(rows, ttlSeconds) {
  const instances = [];
  let skipped = 0;
  for (const r of rows) {
    // Same exclusions as the NIfTI converter: offline objects, synthesised
    // WSI pyramid levels (no Part 10 stream on disk), and anything outside
    // the archive bucket prefix.
    if (!READABLE_AVAILABILITY.has(r.availability)) { skipped++; continue; }
    if (r.metadataEndOffset === 0 || r.jpegTablesOffset != null) { skipped++; continue; }
    if (!r.bucket || !r.bucket.startsWith(ARCHIVE_BUCKET_PREFIX)) { skipped++; continue; }
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: r.bucket, Key: r.s3Key }), { expiresIn: ttlSeconds });
    const range = (r.memberOffset != null && r.memberLength != null)
      ? { start: Number(r.memberOffset), length: Number(r.memberLength) } : null;
    instances.push({ sopInstanceUid: r.sopInstanceUid, instanceNumber: r.instanceNumber, url, range });
  }
  return { instances, skipped };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function failRun(runId, message) {
  await query(
    "UPDATE processing_jobs SET status = 'FAILED', config = JSON_SET(COALESCE(config, '{}'), '$.error', ?) WHERE id = ?",
    [String(message).slice(0, 500), runId]);
}

// Every run carries the scope it was authorized with: user-started runs from
// processing-jobs-api, scheduled runs from the scheduler (the schedule creator's
// grants). created_by is a username and is never trusted as a privilege.
function scopeChecker(createdBy, authorizedScope, field = 'canReadDatastoreIds') {
  return (dsId) => {
    if (!authorizedScope) return false;         // legacy row: fail closed
    const ids = authorizedScope[field] || [];
    return ids.includes('*') || ids.includes(dsId);
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Claim the run before doing anything with its authorization (review 3, F1).
// The runner acts on the scope stored on the run row it is handed, so it only
// accepts a PLUGIN run that is still PENDING, has never been claimed, and whose
// parent is the plug-in named in the request (a live plug-in definition). The
// claim is one conditional UPDATE, so a replayed or forged jobId pointing at
// someone else's run (already claimed, running, finished, or under another
// parent) matches nothing and is refused.
async function claimRun(runId, parentJobId) {
  if (!runId || !parentJobId) return false;
  const res = await execute(
    `UPDATE processing_jobs r
       JOIN processing_jobs p ON p.id = r.parent_job_id
        SET r.config = JSON_SET(COALESCE(r.config, '{}'), '$.runnerClaimedAt', ?)
      WHERE r.id = ? AND r.parent_job_id = ? AND r.type = 'PLUGIN' AND r.status = 'PENDING'
        AND r.deleted = FALSE AND JSON_EXTRACT(r.config, '$.runnerClaimedAt') IS NULL
        AND p.type = 'PLUGIN' AND p.parent_job_id IS NULL AND p.deleted = FALSE`,
    [new Date().toISOString(), runId, parentJobId]);
  return !!res && res.affectedRows === 1;
}

exports.handler = async (event) => {
  const { jobId: runId, parentJobId, target, ...params } = event;
  if (!runId) throw new Error('jobId is required');
  if (!(await claimRun(runId, parentJobId))) {
    // Never touch the named row: it is not ours to fail.
    console.warn(`plugin-runner: refused run ${runId} (parent ${parentJobId}): not an unclaimed PENDING run of that plug-in`);
    return { refused: true };
  }

  const runRows = await query('SELECT created_by, config FROM processing_jobs WHERE id = ?', [runId]);
  if (!runRows.length) throw new Error(`Run ${runId} not found`);
  const createdBy = runRows[0].created_by;
  const runConfig = JSON.parse(runRows[0].config || '{}');
  const plugin = runConfig.plugin || {};
  const manifest = plugin.manifest || {};

  try {
    if (!plugin.jobDefinitionArn) throw new TargetError('Plugin has no registered job definition');
    if (plugin.enabled === false) throw new TargetError('Plugin is disabled');

    const granularity = manifest.granularity === 'study' ? 'study' : 'series';
    const maxSteps = Math.min(Math.max(1, parseInt(manifest.maxSteps, 10) || 500), 5000);
    const timeoutMinutes = Math.min(Math.max(1, parseInt(manifest.resources?.timeoutMinutes, 10) || 60), 720);
    // URLs must outlive queueing + the task itself; cap at the SigV4 maximum.
    const ttl = Math.min(MAX_URL_TTL_SECONDS, (timeoutMinutes + 120) * 60);
    const allowed = scopeChecker(createdBy, runConfig.authorizedScope);
    const toSource = runConfig.writeBack === 'source';
    const writeBack = toSource || runConfig.writeBack === 'datastore';
    const canWrite = scopeChecker(createdBy, runConfig.authorizedScope, 'canWriteDatastoreIds');
    let destination = null;
    if (runConfig.writeBack === 'datastore') {
      destination = await resolveDatastore(runConfig.writeBackDatastoreId);
      if (!destination) throw new TargetError('The write-back destination datastore no longer exists');
      if (destination.status !== 'ACTIVE') throw new TargetError(`The write-back destination "${destination.name}" is ${destination.status}`);
      if (!canWrite(destination.id)) throw new TargetError(`Write-back needs store permission on "${destination.name}"`);
      if (!(destination.bucket && destination.bucket.startsWith(ARCHIVE_BUCKET_PREFIX))) throw new TargetError(`"${destination.name}" has no archive bucket to write back to`);
    }
    const gpu = parseInt(manifest.resources?.gpu, 10) || 0;
    const queue = gpu > 0 ? GPU_JOB_QUEUE : JOB_QUEUE;
    if (!queue) throw new TargetError(gpu > 0 ? 'This deployment has no GPU queue' : 'No plugin job queue configured');

    let effectiveTarget = target || {};
    let upstreamByKey = null;
    if (effectiveTarget.mode === 'upstream') {
      ({ target: effectiveTarget, upstreamByKey } = await loadUpstream(effectiveTarget.runId, granularity));
      if (!effectiveTarget.entries.length) throw new TargetError('The upstream run completed no steps, so there is nothing to chain');
    }
    // The guard needs the concrete datastores this run may read. A legacy run
    // without a persisted scope gets none, so its sql target fails closed.
    const readableIds = (runConfig.authorizedScope || {}).canReadDatastoreIds || [];
    const { items, truncated } = await expandTarget(effectiveTarget, maxSteps * 20, readableIds);

    // Resolve items to concrete series, de-duplicated, scope-checked.
    const seen = new Set();
    const resolved = []; // { datastore, series[] , studyInstanceUid }
    // Skip reasons are stored on the run and shown to anyone who can list jobs,
    // so they never quote values taken from the target (a sql target can project
    // any column into datastore_id or the UID columns). Only counts and names
    // read from the datastores table are recorded.
    const skippedReasons = [];
    const skipCounts = new Map();
    const skipCounted = (reason) => { skipCounts.set(reason, (skipCounts.get(reason) || 0) + 1); };
    for (const it of items) {
      if (!allowed(it.datastoreId)) { skipCounted('outside your authorized datastores'); continue; }
      const ds = await resolveDatastore(it.datastoreId);
      if (!ds) { skipCounted('datastore not found'); continue; }
      if (ds.status !== 'ACTIVE') { skippedReasons.push(`${ds.name}: datastore is ${ds.status}`); continue; }
      if (toSource && !canWrite(ds.id)) { skippedReasons.push(`${ds.name}: write-back needs store permission on this datastore`); continue; }
      if (toSource && !(ds.bucket && ds.bucket.startsWith(ARCHIVE_BUCKET_PREFIX))) { skippedReasons.push(`${ds.name}: datastore has no archive bucket to write back to`); continue; }
      let seriesRows;
      if (it.seriesInstanceUid) seriesRows = await findSeries(ds.id, it.seriesInstanceUid);
      else if (it.studyInstanceUid) seriesRows = await findStudySeries(ds.id, it.studyInstanceUid);
      else { skipCounted('entry names neither a study nor a series'); continue; }
      if (!seriesRows.length) { skipCounted(`${ds.name}: study or series not in index`); continue; }
      for (const s of seriesRows) {
        const key = `${ds.id}|${s.seriesInstanceUid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (s.availability && s.availability !== 'ONLINE') { skippedReasons.push(`${s.seriesInstanceUid}: availability ${s.availability}`); continue; }
        resolved.push({ datastore: ds, series: s });
      }
    }
    for (const [reason, n] of skipCounts) skippedReasons.push(`${n} item(s): ${reason}`);

    // Group into steps.
    let groups;
    if (granularity === 'study') {
      const byStudy = new Map();
      for (const r of resolved) {
        const k = `${r.datastore.id}|${r.series.studyInstanceUid}`;
        if (!byStudy.has(k)) byStudy.set(k, { datastore: r.datastore, studyInstanceUid: r.series.studyInstanceUid, series: [] });
        byStudy.get(k).series.push(r.series);
      }
      groups = [...byStudy.values()];
    } else {
      groups = resolved.map(r => ({ datastore: r.datastore, studyInstanceUid: r.series.studyInstanceUid, series: [r.series] }));
    }
    const stepTruncated = groups.length > maxSteps;
    groups = groups.slice(0, maxSteps);

    if (!groups.length) {
      const msg = skippedReasons.length
        ? `Nothing to process: ${skippedReasons.length} item(s) skipped (${skippedReasons.slice(0, 3).join('; ')})`
        : 'The selection resolved to no series';
      await failRun(runId, msg);
      return { runId, submitted: false, steps: 0, message: msg };
    }

    const prefix = `runs/${runId}`;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const seriesOut = [];
      let instanceCount = 0;
      for (const s of g.series) {
        const rows = await loadInstances(g.datastore.id, s.seriesPkey);
        const { instances, skipped } = await presignInstances(rows, ttl);
        instanceCount += instances.length;
        seriesOut.push({
          seriesInstanceUid: s.seriesInstanceUid, modality: s.modality,
          seriesDescription: s.seriesDescription, skippedInstances: skipped, instances,
        });
      }
      const input = {
        runId, step: i, granularity,
        datastoreId: g.datastore.id, datastoreName: g.datastore.name,
        studyInstanceUid: g.studyInstanceUid,
        // Series granularity: flatten the single series to the top level.
        ...(granularity === 'series'
          ? { seriesInstanceUid: seriesOut[0].seriesInstanceUid, modality: seriesOut[0].modality,
              seriesDescription: seriesOut[0].seriesDescription, instances: seriesOut[0].instances }
          : { series: seriesOut }),
        params,
        writeBack,
        // Where write-back sends this step's DICOM: 'source' or 'datastore'.
        ...(writeBack ? { writeBackTarget: destination ? 'datastore' : 'source', writeBackDatastoreId: (destination || g.datastore).id } : {}),
        upstream: upstreamByKey
          ? await presignUpstream(upstreamByKey.get(groupKey(granularity, g.datastore.id, g.studyInstanceUid, g.series[0].seriesInstanceUid)), ttl)
          : null,
        expiresAt,
      };
      await s3.send(new PutObjectCommand({
        Bucket: IO_BUCKET, Key: `${prefix}/steps/${i}/input.json`,
        Body: JSON.stringify(input), ContentType: 'application/json',
      }));
      const stepSummary = {
        datastoreId: g.datastore.id, studyInstanceUid: g.studyInstanceUid,
        seriesInstanceUids: g.series.map(s => s.seriesInstanceUid),
        modality: g.series[0].modality, instanceCount,
        inputKey: `${prefix}/steps/${i}/input.json`,
        ...(writeBack ? { writeBackBucket: (destination || g.datastore).bucket,
          writeBackDatastoreId: (destination || g.datastore).id } : {}),
        ...(input.upstream ? { upstreamStep: input.upstream.step } : {}),
      };
      await query(
        `INSERT INTO processing_job_steps (id, processing_job_id, step_number, status, input)
         VALUES (?, ?, ?, 'PENDING', ?)`,
        [randomUUID(), runId, i + 1, JSON.stringify(stepSummary)]);
    }

    await query("UPDATE processing_jobs SET status = 'RUNNING', total_steps_count = ? WHERE id = ?", [groups.length, runId]);

    // Batch rejects array jobs of size 1: single-step runs are a plain job.
    const isArray = groups.length >= 2;
    const submission = await batch.send(new SubmitJobCommand({
      jobName: `plugin-${runId}`.slice(0, 128),
      jobQueue: queue,
      jobDefinition: plugin.jobDefinitionArn,
      ...(isArray ? { arrayProperties: { size: groups.length } } : {}),
      tags: { PluginRunId: runId, PluginId: String(parentJobId || '') },
      containerOverrides: {
        environment: [
          { name: 'PLUGIN_RUN_ID', value: runId },
          { name: 'PLUGIN_IO_BUCKET', value: IO_BUCKET },
          { name: 'PLUGIN_RUN_PREFIX', value: `${prefix}/` },
          { name: 'PLUGIN_PARAMS', value: JSON.stringify(params).slice(0, 8000) },
          ...(isArray ? [] : [{ name: 'AWS_BATCH_JOB_ARRAY_INDEX', value: '0' }]),
        ],
      },
    }));

    const notes = [];
    if (truncated || stepTruncated) notes.push(`Selection exceeded maxSteps (${maxSteps}); only the first ${groups.length} steps run`);
    if (skippedReasons.length) notes.push(`${skippedReasons.length} item(s) skipped: ${skippedReasons.slice(0, 5).join('; ')}`);
    await query(
      `UPDATE processing_jobs SET config = JSON_SET(COALESCE(config, '{}'), '$.batchJobId', ?, '$.runNotes', CAST(? AS JSON)) WHERE id = ?`,
      [submission.jobId, JSON.stringify(notes), runId]);

    console.log(`plugin-runner: run=${runId} batch=${submission.jobId} steps=${groups.length} skipped=${skippedReasons.length}`);
    return { runId, submitted: true, batchJobId: submission.jobId, steps: groups.length };
  } catch (error) {
    // Log the error class/code only: a DB error message can echo SQL and values.
    console.error('plugin-runner failed:', error && error.name, error && (error.code || error.errno), error instanceof TargetError ? error.message : '');
    await failRun(runId, publicMessage(error));
    throw new Error(publicMessage(error));
  }
};

// Exposed for unit tests.
exports._internal = { claimRun, buildPageQuery, guardTargetSql, publicMessage, TargetError, expandTarget, scopeChecker, loadUpstream, groupKey };
