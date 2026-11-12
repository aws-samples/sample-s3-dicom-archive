/**
 * index-attributes-backfill: fill a STORAGE index-attribute column for rows that
 * were indexed BEFORE the attribute existed, from the DICOM headers already in
 * the database (Instancemetadata.metadata, gzipped DICOM-JSON). No S3 reads.
 *
 * DRIVER: an SQS self-requeue chain, one message in flight per job. A message
 * is { defId, token }; the job row (index_attribute_backfill_jobs) holds the
 * live chain_token. Each invocation runs bounded batches until its time budget
 * is spent, then hands off by rotating the token and sending ONE next message.
 * A message whose token no longer matches (duplicate delivery, a superseded
 * run, a restart) does nothing, so the chain cannot fork or loop.
 *
 * HARD STOPS: the walk is bounded by max_pkey (snapshot of MAX(pkey) on first
 * run; rows above it were written by ingest after the def existed); a batch
 * that does not advance the cursor fails the job; hops (self-requeues) are
 * capped by BACKFILL_MAX_HOPS; a message that keeps failing marks the job FAILED
 * on its BACKFILL_MAX_ATTEMPTS-th receive (the queue's DLQ is the backstop).
 *
 * WHAT IS WRITTEN, per level (same table, column and value rules as ingest,
 * see values.js):
 *   INSTANCE  each live instance row, from its own header (ingest: inline on
 *             the instance's own row).
 *   SERIES    each live series row, from its latest live instance's header
 *             (ingest: the post-commit settle pass reads one representative
 *             instance of the series).
 *   STUDY     each live study row, from the representative instance of its
 *             latest live series.
 *   PATIENT   each live patient row, from the representative instance of its
 *             latest live study.
 * Only global STORAGE defs (virtual_folder_id IS NULL) are back-filled: those are
 * the defs ingest populates. VF defs are filled by the folder's re-index.
 *
 * TRANSACTIONS: one per batch. It sets a short innodb_lock_wait_timeout, moves
 * the job cursor (conditional on the chain token and the cursor it started
 * from) and writes the batch's values in one multi-row UPDATE by primary key.
 * Cursor and values commit together, so a resumed job neither skips nor repeats
 * a batch. A deadlock (1213) or lock-wait timeout (1205) rolls the batch back and
 * retries it with backoff; after BACKFILL_DEADLOCK_RETRIES it is re-thrown,
 * never swallowed.
 */
const { query, transaction } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { valueFromBlob } = require('./values');

const int = (v, d, lo, hi) => {
  const n = parseInt(v === undefined ? '' : v, 10);
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : d));
};
const CFG = {
  queueUrl: process.env.BACKFILL_QUEUE_URL || '',
  instanceBatch: int(process.env.BACKFILL_INSTANCE_BATCH, 200, 1, 1000),
  parentBatch: int(process.env.BACKFILL_PARENT_BATCH, 500, 1, 2000),
  lockWaitS: int(process.env.BACKFILL_LOCK_WAIT_S, 5, 1, 30),
  deadlockRetries: int(process.env.BACKFILL_DEADLOCK_RETRIES, 5, 0, 20),
  maxAttempts: int(process.env.BACKFILL_MAX_ATTEMPTS, 3, 1, 10),
  maxHops: int(process.env.BACKFILL_MAX_HOPS, 100000, 1, 10000000),
  maxBatchesPerInvocation: int(process.env.BACKFILL_MAX_BATCHES_PER_INVOCATION, 200, 1, 100000),
  // Stop starting new batches when less than this is left of the invocation.
  reserveMs: int(process.env.BACKFILL_RESERVE_MS, 60000, 5000, 600000),
};

const LEVEL = {
  INSTANCE: { table: 'instance', pk: 'instance_pkey' },
  SERIES: { table: 'series', pk: 'series_pkey' },
  STUDY: { table: 'study', pk: 'study_pkey' },
  PATIENT: { table: 'patient', pk: 'patient_pkey' },
};
const COLUMN_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RETRYABLE = new Set([1213, 1205]);

let _sqs = null;
const sqs = () => _sqs || (_sqs = new SQSClient({}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ph = (n) => new Array(n).fill('?').join(',');

function isRetryable(e) {
  return !!e && (RETRYABLE.has(e.errno) || e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT');
}

// Run fn, retrying ONLY a deadlock / lock-wait timeout, with jittered backoff.
// Anything else, and the last retryable failure, propagates.
async function withDeadlockRetry(fn, retries = CFG.deadlockRetries, baseMs = 200) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= retries) throw e;
      const wait = baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
      console.warn(`back-fill: ${e.code || e.errno} on batch, retry ${attempt + 1}/${retries} in ${wait}ms`);
      await sleep(wait);
    }
  }
}

// ── representative-instance resolution (parent levels) ──────────────────────

// series_pkey -> its latest live instance_pkey (backward index scan, stops at
// the first live row).
async function repInstanceForSeries(seriesPkeys) {
  if (!seriesPkeys.length) return new Map();
  const rows = await query(
    `SELECT se.series_pkey AS pk,
            (SELECT i.instance_pkey FROM instance i
              WHERE i.series_pkey = se.series_pkey AND i.deleted_at IS NULL
              ORDER BY i.instance_pkey DESC LIMIT 1) AS rep
       FROM series se WHERE se.series_pkey IN (${ph(seriesPkeys.length)})`,
    seriesPkeys);
  return new Map(rows.filter((r) => r.rep != null).map((r) => [String(r.pk), r.rep]));
}

async function latestChild(parentPkeys, childTable, childPk, fk) {
  if (!parentPkeys.length) return new Map();
  const parentTable = fk === 'study_pkey' ? 'study' : 'patient';
  const rows = await query(
    `SELECT p.${fk} AS pk,
            (SELECT c.${childPk} FROM ${childTable} c
              WHERE c.${fk} = p.${fk} AND c.deleted_at IS NULL
              ORDER BY c.${childPk} DESC LIMIT 1) AS rep
       FROM ${parentTable} p WHERE p.${fk} IN (${ph(parentPkeys.length)})`,
    parentPkeys);
  return new Map(rows.filter((r) => r.rep != null).map((r) => [String(r.pk), r.rep]));
}

// pk (of the def's level) -> representative instance_pkey.
async function representativeInstances(level, pks) {
  if (level === 'SERIES') return repInstanceForSeries(pks);
  let seriesOf;
  if (level === 'STUDY') {
    seriesOf = await latestChild(pks, 'series', 'series_pkey', 'study_pkey');
  } else {
    const studyOf = await latestChild(pks, 'study', 'study_pkey', 'patient_pkey');
    const seriesOfStudy = await latestChild([...new Set(studyOf.values())], 'series', 'series_pkey', 'study_pkey');
    seriesOf = new Map();
    for (const [p, st] of studyOf) if (seriesOfStudy.has(String(st))) seriesOf.set(p, seriesOfStudy.get(String(st)));
  }
  const instOfSeries = await repInstanceForSeries([...new Set(seriesOf.values())]);
  const out = new Map();
  for (const [p, se] of seriesOf) if (instOfSeries.has(String(se))) out.set(p, instOfSeries.get(String(se)));
  return out;
}

async function metadataFor(instancePkeys) {
  if (!instancePkeys.length) return new Map();
  const rows = await query(
    `SELECT instance_pkey AS ipk, metadata FROM Instancemetadata WHERE instance_pkey IN (${ph(instancePkeys.length)})`,
    instancePkeys);
  return new Map(rows.map((r) => [String(r.ipk), r.metadata]));
}

// ── one batch ────────────────────────────────────────────────────────────────

/**
 * Read the next batch above `cursor` (<= maxPkey) and compute its values.
 * Returns { scanned, nextCursor, writes: [[pk, value], ...] }. Reads take no
 * locks (consistent snapshot); the headers are immutable once stored.
 */
async function planBatch(job, cursor, maxPkey) {
  const { table, pk } = LEVEL[job.dicom_level];
  const limit = job.dicom_level === 'INSTANCE' ? CFG.instanceBatch : CFG.parentBatch;
  const writes = [];
  if (job.dicom_level === 'INSTANCE') {
    const rows = await query(
      `SELECT i.instance_pkey AS pk, im.metadata
         FROM instance i LEFT JOIN Instancemetadata im ON im.instance_pkey = i.instance_pkey
        WHERE i.instance_pkey > ? AND i.instance_pkey <= ? AND i.deleted_at IS NULL
        ORDER BY i.instance_pkey LIMIT ?`,
      [cursor, maxPkey, limit]);
    for (const r of rows) {
      const v = valueFromBlob(r.metadata, job.dicom_tag, job.data_type);
      if (v.write) writes.push([r.pk, v.value]);
    }
    return { scanned: rows.length, nextCursor: rows.length ? rows[rows.length - 1].pk : cursor, writes };
  }
  const rows = await query(
    `SELECT ${pk} AS pk FROM \`${table}\`
      WHERE ${pk} > ? AND ${pk} <= ? AND deleted_at IS NULL
      ORDER BY ${pk} LIMIT ?`,
    [cursor, maxPkey, limit]);
  const pks = rows.map((r) => r.pk);
  const rep = await representativeInstances(job.dicom_level, pks);
  const blobs = await metadataFor([...new Set(rep.values())]);
  for (const p of pks) {
    const ipk = rep.get(String(p));
    if (ipk == null) continue; // no live instance: ingest would not write it either
    const v = valueFromBlob(blobs.get(String(ipk)), job.dicom_tag, job.data_type);
    if (v.write) writes.push([p, v.value]);
  }
  return { scanned: rows.length, nextCursor: pks.length ? pks[pks.length - 1] : cursor, writes };
}

/** Commit one planned batch + the cursor move in one short transaction. */
async function commitBatch(job, token, cursor, plan) {
  const { table, pk } = LEVEL[job.dicom_level];
  const col = job.physical_column;
  const stmts = [
    { sql: `SET SESSION innodb_lock_wait_timeout = ${CFG.lockWaitS}` },
    // Job row first: concurrent duplicates of a message serialize here.
    {
      sql: `UPDATE index_attribute_backfill_jobs
               SET cursor_pkey = ?, rows_scanned = rows_scanned + ?, rows_written = rows_written + ?,
                   batches = batches + 1
             WHERE def_id = ? AND chain_token = ? AND cursor_pkey = ? AND status = 'RUNNING'`,
      parameters: [plan.nextCursor, plan.scanned, plan.writes.length, job.def_id, token, cursor],
    },
  ];
  if (plan.writes.length) {
    const cases = plan.writes.map(() => 'WHEN ? THEN ?').join(' ');
    const params = [];
    for (const [k, v] of plan.writes) params.push(k, v);
    for (const [k] of plan.writes) params.push(k);
    stmts.push({
      sql: `UPDATE \`${table}\` SET \`${col}\` = CASE ${pk} ${cases} ELSE \`${col}\` END
             WHERE ${pk} IN (${ph(plan.writes.length)})`,
      parameters: params,
    });
  }
  stmts.push({ sql: 'SET SESSION innodb_lock_wait_timeout = DEFAULT' });
  await transaction(stmts);
}

// ── job state ────────────────────────────────────────────────────────────────

async function loadJob(defId) {
  const [j] = await query(
    `SELECT j.def_id, j.status, j.chain_token, j.cursor_pkey, j.max_pkey, j.hops,
            d.target_type, d.virtual_folder_id, d.dicom_tag, d.dicom_level, d.physical_column, d.data_type
       FROM index_attribute_backfill_jobs j
       JOIN index_attribute_defs d ON d.id = j.def_id
      WHERE j.def_id = ?`,
    [defId]);
  return j || null;
}

async function setStatus(defId, token, status, error) {
  await query(
    `UPDATE index_attribute_backfill_jobs
        SET status = ?, error = ?, finished_at = IF(? IN ('DONE','FAILED'), NOW(), finished_at)
      WHERE def_id = ? AND chain_token = ?`,
    [status, error ? String(error).slice(0, 2000) : null, status, defId, token]);
}

/**
 * Process one chain message. Returns a short outcome string (for logs/tests):
 * 'gone' | 'superseded' | 'inactive' | 'failed' | 'done' | 'continued' | 'handed-off'.
 */
async function runStep(msg, remainingMs) {
  const { defId, token } = msg || {};
  if (!defId || !token) return 'gone';
  let job = await loadJob(defId);
  if (!job) return 'gone'; // def deleted (job row cascades) or never armed
  if (job.chain_token !== token) return 'superseded';
  if (job.status !== 'PENDING' && job.status !== 'RUNNING') return 'inactive';

  if (job.target_type !== 'STORAGE' || job.virtual_folder_id) {
    await setStatus(defId, token, 'FAILED', 'Only storage attributes are back-filled');
    return 'failed';
  }
  if (!LEVEL[job.dicom_level] || !COLUMN_RE.test(job.physical_column || '')) {
    await setStatus(defId, token, 'FAILED', `Invalid level/column on the definition (${job.dicom_level}/${job.physical_column})`);
    return 'failed';
  }
  if (Number(job.hops) >= CFG.maxHops) {
    await setStatus(defId, token, 'FAILED', `Stopped after ${CFG.maxHops} hand-offs (hard stop). Use Back-fill to resume.`);
    return 'failed';
  }

  const { table, pk } = LEVEL[job.dicom_level];
  if (job.max_pkey == null) {
    const [m] = await query(`SELECT COALESCE(MAX(${pk}), 0) AS m FROM \`${table}\``);
    await query(
      `UPDATE index_attribute_backfill_jobs
          SET status = 'RUNNING', max_pkey = ?, started_at = COALESCE(started_at, NOW())
        WHERE def_id = ? AND chain_token = ? AND max_pkey IS NULL`,
      [m.m, defId, token]);
    job = await loadJob(defId);
    if (!job || job.chain_token !== token) return 'superseded';
  } else if (job.status === 'PENDING') {
    await query("UPDATE index_attribute_backfill_jobs SET status = 'RUNNING' WHERE def_id = ? AND chain_token = ?", [defId, token]);
  }

  const maxPkey = Number(job.max_pkey);
  let cursor = Number(job.cursor_pkey);
  const deadline = Date.now() + Math.max(0, remainingMs - CFG.reserveMs);
  let done = cursor >= maxPkey;
  let batches = 0;
  while (!done && batches < CFG.maxBatchesPerInvocation && (batches === 0 || Date.now() < deadline)) {
    const plan = await planBatch(job, cursor, maxPkey);
    if (plan.scanned === 0) { done = true; break; }
    if (!(plan.nextCursor > cursor)) throw new Error(`back-fill cursor did not advance past ${cursor}`);
    await withDeadlockRetry(() => commitBatch(job, token, cursor, plan));
    batches++;
    // Re-read: a restart/resume (new token) or a duplicate message may have moved the job.
    const [now] = await query(
      'SELECT chain_token, status, cursor_pkey FROM index_attribute_backfill_jobs WHERE def_id = ?', [defId]);
    if (!now || now.chain_token !== token) return 'superseded';
    if (now.status !== 'RUNNING') return 'inactive';
    cursor = Math.max(cursor, Number(now.cursor_pkey));
    if (cursor >= maxPkey) done = true;
  }

  if (done) {
    await setStatus(defId, token, 'DONE', null);
    console.log(`back-fill ${defId}: DONE at cursor ${cursor}/${maxPkey}`);
    return 'done';
  }

  // Hand off: rotate the token first, so only ONE holder of the old token can
  // continue the chain, then send the next message.
  const next = randomUUID();
  const res = await transaction([{
    sql: `UPDATE index_attribute_backfill_jobs SET chain_token = ?, hops = hops + 1
           WHERE def_id = ? AND chain_token = ? AND status = 'RUNNING'`,
    parameters: [next, defId, token],
  }, {
    sql: 'SELECT chain_token FROM index_attribute_backfill_jobs WHERE def_id = ?',
    parameters: [defId],
  }]);
  const after = res[1] && res[1][0];
  if (!after || after.chain_token !== next) return 'superseded';
  try {
    await sqs().send(new SendMessageCommand({ QueueUrl: CFG.queueUrl, MessageBody: JSON.stringify({ defId, token: next }) }));
  } catch (e) {
    // Give the token back so the redelivered current message can continue.
    await query('UPDATE index_attribute_backfill_jobs SET chain_token = ? WHERE def_id = ? AND chain_token = ?',
      [token, defId, next]).catch(() => {});
    throw e;
  }
  console.log(`back-fill ${defId}: handed off at cursor ${cursor}/${maxPkey} after ${batches} batch(es)`);
  return 'handed-off';
}

exports.handler = async (event, context) => {
  for (const record of event.Records || []) {
    let msg = null;
    try { msg = JSON.parse(record.body); } catch { console.error('back-fill: unparseable message dropped'); continue; }
    const attempt = parseInt(record.attributes?.ApproximateReceiveCount || '1', 10) || 1;
    const remainingMs = context && typeof context.getRemainingTimeInMillis === 'function'
      ? context.getRemainingTimeInMillis() : 300000;
    try {
      const outcome = await runStep(msg, remainingMs);
      console.log(`back-fill ${msg && msg.defId}: ${outcome}`);
    } catch (e) {
      console.error(`back-fill ${msg && msg.defId} attempt ${attempt} failed:`, e.message);
      if (attempt >= CFG.maxAttempts) {
        // Final attempt: record it and drop the message (resumable from the cursor).
        await setStatus(msg.defId, msg.token, 'FAILED',
          `${e.code || 'Error'}: ${e.message} (after ${attempt} attempts; Back-fill resumes from where it stopped)`).catch(() => {});
        continue;
      }
      throw e; // SQS redelivers after the visibility timeout; the cursor makes it resume.
    }
  }
};

exports._test = { runStep, planBatch, commitBatch, withDeadlockRetry, representativeInstances, CFG };
