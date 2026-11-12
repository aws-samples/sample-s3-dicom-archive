// datastore-backfill: bulk-index the EXISTING objects of an imported S3 bucket.
//
// Invoked asynchronously (InvocationType='Event') by import-datastore with
// { datastoreId, bucketName, prefix }. It ListObjectsV2-paginates over
// bucket/prefix and, for every object key, enqueues one SYNTHETIC classic S3
// notification record onto the live ingest queue:
//
//     { Records: [{ eventName: 'ObjectCreated:Backfill',
//                   s3: { bucket: { name }, object: { key } } }] }
//
// The s3-ingest Lambda's _normalize_classic_record treats any 'ObjectCreated*'
// eventName as a CREATED action, so this reuses the EXACT live ingest path
// (DICOM parse -> storage_index + query tree; non-DICOM -> NON_DICOM row) with
// zero duplicate logic and the ingest pool's own concurrency.
//
// Progress tracking reuses the import_jobs table (source_type='S3'):
//   * We create ONE job row up front, then set total_files to the count of
//     enqueued objects.
//   * Because ingest's import_jobs.match_job credits any object of the
//     datastore whose prefix-stripped key starts with the job's s3_input_uri
//     prefix, we set s3_input_uri = s3://{bucket}/ (the root, which matches
//     every object of the datastore) so the SAME live ingest that indexes each
//     backfilled object also
//     increments processed_files / instances_imported and flips the job to
//     COMPLETED when the queue drains. So the job reflects INDEXED progress,
//     not merely queued — better than the design's minimum (I6), at no extra
//     code, and it is what already drives the live ingest import path.
//
// Idempotency: re-running is safe. storage_index upserts on
// (datastore_id, s3_key, s3_key_version), so re-queuing an already-indexed
// object updates the row in place rather than duplicating it. A fresh job row
// is created per run (progress of the latest run); prior runs' rows remain.

const { query } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const REGION = process.env.AWS_REGION;
const s3Client = new S3Client({ region: REGION });
const sqsClient = new SQSClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

const INGEST_QUEUE_URL = process.env.S3_INGEST_QUEUE_URL;
const SQS_BATCH_SIZE = 10; // SendMessageBatch hard limit
// When less than this much execution time remains, checkpoint the current S3
// ContinuationToken and re-invoke ourselves (async) to resume the crawl in a
// fresh 15-min window. A single Lambda cannot page a very large bucket to
// completion, so the crawl self-continues across invocations. The S3
// ContinuationToken IS the checkpoint; the one import_jobs row + the datastore
// SYNCING status persist across segments.
const CONTINUE_THRESHOLD_MS = 90 * 1000;

// The import grants this role read on the bucket (a per-bucket inline policy)
// and invokes this backfill straight away. IAM applies a new policy within
// seconds to a minute or more, not instantly (about 60 s was measured on qa3),
// so the first listing can be refused AccessDenied although the grant is in
// place. Retry an AccessDenied for about 3 minutes before failing the job; any
// other error fails at once.
const ACCESS_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000, 30000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listPage(input, delays = ACCESS_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await s3Client.send(new ListObjectsV2Command(input));
    } catch (error) {
      const denied = error?.name === 'AccessDenied' || error?.Code === 'AccessDenied'
        || error?.$metadata?.httpStatusCode === 403;
      if (!denied || attempt >= delays.length) throw error;
      console.warn(`ListObjectsV2 on ${input.Bucket} refused (attempt ${attempt + 1}); ` +
        `waiting ${delays[attempt]} ms for the read grant to apply`);
      await sleep(delays[attempt]);
    }
  }
}

function syntheticRecord(bucketName, key) {
  return JSON.stringify({
    Records: [{
      eventName: 'ObjectCreated:Backfill',
      s3: {
        bucket: { name: bucketName },
        object: { key }
      }
    }]
  });
}

async function sendBatch(entries) {
  // entries: [{ Id, MessageBody }]. Retry the ones SQS reports as Failed once.
  const resp = await sqsClient.send(new SendMessageBatchCommand({
    QueueUrl: INGEST_QUEUE_URL,
    Entries: entries
  }));
  const failed = (resp.Failed || []).filter((f) => f.SenderFault !== true);
  if (failed.length > 0) {
    const retryIds = new Set(failed.map((f) => f.Id));
    const retryEntries = entries.filter((e) => retryIds.has(e.Id));
    const retryResp = await sqsClient.send(new SendMessageBatchCommand({
      QueueUrl: INGEST_QUEUE_URL,
      Entries: retryEntries
    }));
    return (resp.Successful?.length || 0) + (retryResp.Successful?.length || 0);
  }
  return resp.Successful?.length || 0;
}

exports.handler = async (event, context) => {
  const { datastoreId, bucketName, prefix, mode: rawMode } = event || {};
  // mode: 'full' re-enqueues every crawled key (original behavior). 'delta'
  // (default) skips keys already indexed in storage_index AND unchanged (same
  // ETag). Anything else normalizes to 'delta'.
  const mode = rawMode === 'full' ? 'full' : 'delta';
  // Self-continuation state (present on a resumed segment, absent on the first):
  // resumeToken picks up S3 pagination; resumeJobId keeps the same job row;
  // the running queued/skipped tallies carry across segments.
  const resumeToken = event?.continuationToken || undefined;
  const resumeJobId = event?.jobId || undefined;
  const segment = (event?.segment || 0);
  console.log('datastore-backfill invoked:', JSON.stringify({ datastoreId, bucketName, prefix, mode, segment, resuming: !!resumeToken }));

  if (!datastoreId || !bucketName) {
    throw new Error('datastore-backfill requires datastoreId and bucketName');
  }
  if (!INGEST_QUEUE_URL) {
    throw new Error('S3_INGEST_QUEUE_URL not configured');
  }

  const normalizedPrefix = (prefix || '').replace(/^\/+|\/+$/g, '');
  const listPrefix = normalizedPrefix ? `${normalizedPrefix}/` : '';

  let jobId = resumeJobId;
  if (!jobId) {
    // FIRST segment: create the progress job AND flip the datastore to SYNCING.
    // s3_input_uri must name the bucket ROOT: ingest's match_job strips the
    // datastore prefix from each key before comparing it with the job's prefix,
    // so a job prefix of '<datastore prefix>/' never matches a stripped key and a
    // prefixed storage's backfill would stay IN_PROGRESS (and the datastore
    // SYNCING, which DICOMweb does not serve) forever. The root matches every
    // object of this datastore. source_location keeps the real listing prefix.
    jobId = randomUUID();
    await query(
      `INSERT INTO import_jobs (id, datastore_id, job_name, source_type, source_location,
          s3_input_uri, status, total_files, started_at, created_by)
       VALUES (?, ?, ?, 'S3', ?, ?, 'IN_PROGRESS', 0, NOW(), 'backfill')`,
      [
        jobId,
        datastoreId,
        `${mode === 'delta' ? 'Sync (delta)' : 'Sync (full)'} for ${bucketName}`,
        `s3://${bucketName}/${listPrefix}`,
        `s3://${bucketName}/`
      ]
    );
    // Mark the datastore SYNCING while the crawl + ingest run. Only flip from a
    // steady state (ACTIVE/ERROR) so we never clobber CREATING/DELETING. Cleared
    // back to ACTIVE by maybe_complete_job when the job drains.
    await query(
      "UPDATE datastores SET status = 'SYNCING', updated_at = NOW() " +
      "WHERE id = ? AND status IN ('ACTIVE', 'ERROR')",
      [datastoreId]
    );
  }

  let continuationToken = resumeToken;
  let queued = event?.queued || 0;
  let skipped = event?.skipped || 0;
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    queued += await sendBatch(batch);
    batch = [];
  };

  // Delta mode: for a page of crawled objects, return the set of keys that are
  // ALREADY indexed with an ETag that matches S3's current ETag — those are the
  // ones we skip. A key that is absent, or present with a NULL/differing ETag,
  // is NOT returned (so it re-enqueues): NULL means we can't prove it's
  // unchanged, so we err toward re-ingesting (correct, just less efficient).
  // The lookup is scoped to this page (WHERE s3_key IN (...)) so memory stays
  // bounded regardless of bucket size. content_kind is not filtered: a NON_DICOM
  // row also counts as "indexed" for its key.
  const unchangedKeysForPage = async (pageObjects) => {
    const skipSet = new Set();
    if (mode !== 'delta' || pageObjects.length === 0) return skipSet;
    // ETag by key from S3 (quotes stripped). ListObjectsV2 returns ETag per key.
    const s3EtagByKey = new Map();
    for (const o of pageObjects) {
      s3EtagByKey.set(o.Key, (o.ETag || '').replace(/"/g, '') || null);
    }
    const keys = [...s3EtagByKey.keys()];
    // Chunk the IN(...) list defensively (RDS Data API param cap); 200 is safe.
    const CHUNK = 200;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const slice = keys.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = await query(
        `SELECT s3_key, s3_etag FROM storage_index
         WHERE datastore_id = ? AND s3_key_version = '' AND deleted_at IS NULL
           AND s3_key IN (${placeholders})`,
        [datastoreId, ...slice]
      );
      for (const r of rows) {
        const indexedEtag = r.s3_etag || null;
        const currentEtag = s3EtagByKey.get(r.s3_key);
        // Skip only when we can prove unchanged: both ETags present and equal.
        if (indexedEtag && currentEtag && indexedEtag === currentEtag) {
          skipSet.add(r.s3_key);
        }
      }
    }
    return skipSet;
  };

  try {
    do {
      const page = await listPage({
        Bucket: bucketName,
        Prefix: listPrefix || undefined,
        ContinuationToken: continuationToken
      });

      const contents = page.Contents || [];
      // Candidate object keys on this page (folder markers dropped).
      const objects = contents.filter((o) => o.Key && !o.Key.endsWith('/'));
      skipped += contents.length - objects.length; // folder markers
      const skipSet = await unchangedKeysForPage(objects);

      for (const obj of objects) {
        const key = obj.Key;
        if (skipSet.has(key)) {
          skipped += 1; // delta: already indexed and unchanged
          continue;
        }
        batch.push({ Id: String((queued + batch.length) % 1000000), MessageBody: syntheticRecord(bucketName, key) });
        if (batch.length === SQS_BATCH_SIZE) {
          await flush();
        }
      }

      // Flush this page's leftover (< SQS_BATCH_SIZE) NOW, at the page boundary,
      // so the ingest queue is fed after EVERY page and ingestion runs
      // concurrently with the ongoing crawl — a large bucket starts indexing
      // immediately instead of waiting for the whole crawl to finish.
      await flush();

      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;

      // Self-continuation: if the crawl still has pages but we're low on
      // execution time, checkpoint the token and hand off to a fresh invocation
      // so a very large bucket cannot exceed the 15-min ceiling mid-crawl.
      if (continuationToken && context &&
          context.getRemainingTimeInMillis() < CONTINUE_THRESHOLD_MS) {
        await flush();
        await query(
          'UPDATE import_jobs SET total_files = ?, updated_at = NOW() WHERE id = ?',
          [queued, jobId]
        );
        await lambdaClient.send(new InvokeCommand({
          FunctionName: context.invokedFunctionArn,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({
            datastoreId, bucketName, prefix, mode,
            continuationToken, jobId, queued, skipped, segment: segment + 1,
          })),
        }));
        console.log(`Backfill segment ${segment} handing off at ${queued} queued (${skipped} skipped); resuming in a new invocation.`);
        return { datastoreId, jobId, mode, queued, skipped, continued: true, segment };
      }
    } while (continuationToken);

    await flush();

    // total_files = objects actually enqueued. When it drains, ingest's
    // maybe_complete_job flips this job to COMPLETED (or _WITH_FAILURES).
    // An empty bucket (0 objects) has no drain event to complete it, so
    // mark it COMPLETED here.
    if (queued === 0) {
      await query(
        `UPDATE import_jobs SET total_files = 0, status = 'COMPLETED',
            progress_percentage = 100.00, completed_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [jobId]
      );
    } else {
      await query(
        'UPDATE import_jobs SET total_files = ?, updated_at = NOW() WHERE id = ?',
        [queued, jobId]
      );
    }

    console.log(`Backfill (${mode}) queued ${queued} object(s) (${skipped} skipped) for datastore ${datastoreId} (job ${jobId})`);
    return { datastoreId, jobId, mode, queued, skipped };
  } catch (error) {
    console.error('Backfill failed:', error.message);
    await query(
      `UPDATE import_jobs SET status = 'FAILED', error_message = ?, failed_at = NOW(), updated_at = NOW()
       WHERE id = ?`,
      [(error.message || 'backfill failed').slice(0, 1024), jobId]
    );
    throw error;
  }
};
