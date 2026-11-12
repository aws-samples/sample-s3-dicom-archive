const {
  S3Client,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand
} = require('@aws-sdk/client-s3');
const { deleteResource } = require('/opt/nodejs/resource-tracker');
// RDS Proxy migration (P2): read storage_index through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API.
const { query } = require('/opt/nodejs/database');

const s3Client = new S3Client({});

// ---------------------------------------------------------------------------
// Empties (and finally deletes) a datastore's S3 archive bucket.
//
// DB-DRIVEN: instead of crawling the whole bucket, we read the object keys to
// delete straight from storage_index (scoped to this datastore_id) - the index
// is the authoritative record of what this datastore put in the bucket. Keys
// are deleted in several concurrent DeleteObjects batches per invocation to
// accelerate large deletes. The Step Function loops on isEmpty=false, resuming
// from a content_pkey cursor carried in the event.
//
// PHASE 1 (db-keys): page storage_index by content_pkey, delete those keys.
// PHASE 2 (sweep):   once the DB is exhausted, crawl remaining object versions
//                    + delete markers (versioning is ON, so permanent deletes
//                    leave markers; also catches any un-indexed/orphan object)
//                    and finally DeleteBucket.
//
// The permanent version deletes emit s3 ObjectRemoved events, so the ingest
// pipeline soft-deletes the index rows and the GC sweep hard-deletes them.
// ---------------------------------------------------------------------------

const DB_PAGE_SIZE = 5000;          // storage_index rows read per invocation
const DELETE_BATCH = 1000;          // S3 DeleteObjects hard cap per request
const MAX_CONCURRENT_BATCHES = 5;   // parallel DeleteObjects requests

async function deleteObjectsBatched(bucket, objects) {
  // objects: [{ Key, VersionId? }]. Split into DELETE_BATCH chunks and run
  // MAX_CONCURRENT_BATCHES at a time. Returns { deleted, errors, firstError }.
  const chunks = [];
  for (let i = 0; i < objects.length; i += DELETE_BATCH) {
    chunks.push(objects.slice(i, i + DELETE_BATCH));
  }

  let deleted = 0;
  let errors = 0;
  let firstError = null;

  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_BATCHES) {
    const wave = chunks.slice(i, i + MAX_CONCURRENT_BATCHES);
    const results = await Promise.all(wave.map(chunk =>
      s3Client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk, Quiet: true }
      }))
    ));
    for (let w = 0; w < results.length; w++) {
      const errCount = results[w].Errors?.length || 0;
      errors += errCount;
      deleted += wave[w].length - errCount;
      if (errCount > 0 && !firstError) firstError = results[w].Errors[0]?.Code;
    }
  }
  return { deleted, errors, firstError };
}

exports.handler = async (event) => {
  const { datastoreId, s3BucketName } = event;
  const cursor = event.contentPkeyCursor || 0;   // resume point across loop
  const dbExhausted = event.dbExhausted || false; // PHASE 1 done?
  const STACK_NAME = process.env.STACK_NAME;

  if (!STACK_NAME) {
    throw new Error('STACK_NAME environment variable is required');
  }

  if (!s3BucketName) {
    // Datastore row never got a bucket (creation failed early) - nothing to empty
    return { ...event, isEmpty: true, deletedCount: 0, bucketDeleted: false };
  }

  // Safety guard: only this deployment's archive buckets may ever be emptied
  if (!s3BucketName.startsWith(`${STACK_NAME}-ds-`)) {
    throw new Error(`Refusing to empty bucket ${s3BucketName}: not a '${STACK_NAME}-ds-' archive bucket`);
  }

  // -------------------------------------------------------------------------
  // PHASE 1: delete objects listed in storage_index for this datastore.
  // -------------------------------------------------------------------------
  if (!dbExhausted) {
    let rows;
    try {
      // DISTINCT s3_key: a tar can be indexed as many member rows sharing one
      // object; we delete the object once. Cursor on MAX(content_pkey) per key.
      // LIMIT is inlined (constant int) — mysql2 does not bind LIMIT placeholders.
      rows = await query(
        `SELECT s3_key, MAX(content_pkey) AS max_pkey
              FROM storage_index
              WHERE datastore_id = ? AND content_pkey > ?
              GROUP BY s3_key
              ORDER BY max_pkey
              LIMIT ${DB_PAGE_SIZE}`,
        [datastoreId, cursor]
      );
    } catch (error) {
      // Index tables gone (already cleaned) - fall through to the sweep phase
      if (/doesn't exist|Unknown table|Table.*doesn't/i.test(error.message || '')) {
        console.log('storage_index unavailable, moving to sweep phase');
        return { ...event, isEmpty: false, dbExhausted: true, contentPkeyCursor: 0, deletedCount: 0, bucketDeleted: false };
      }
      throw error;
    }

    if (rows.length > 0) {
      const objects = rows.map(r => ({ Key: r.s3_key }));
      const maxPkey = rows.reduce((m, r) => Math.max(m, r.max_pkey || 0), cursor);

      const { deleted, errors, firstError } = await deleteObjectsBatched(s3BucketName, objects);
      if (errors > 0) {
        console.error('Some keys failed to delete', { failed: errors, firstError });
        if (deleted === 0) {
          throw new Error(`Failed to delete any of ${objects.length} keys from ${s3BucketName}: ${firstError}`);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- Error message string, not SQL; no query is built here (audited)
        }
      }
      console.log(`PHASE1 deleted ${deleted}/${objects.length} keys, cursor -> ${maxPkey}`);

      const moreLikely = rows.length === DB_PAGE_SIZE;
      return {
        ...event,
        isEmpty: false,
        dbExhausted: !moreLikely,     // if a short page, DB is drained next loop -> sweep
        contentPkeyCursor: maxPkey,
        deletedCount: deleted,
        bucketDeleted: false
      };
    }

    // No more DB rows for this datastore - move to the version/marker sweep.
    console.log('PHASE1 complete (storage_index drained), moving to sweep phase');
    return { ...event, isEmpty: false, dbExhausted: true, contentPkeyCursor: 0, deletedCount: 0, bucketDeleted: false };
  }

  // -------------------------------------------------------------------------
  // PHASE 2: sweep remaining object versions + delete markers, then delete
  // the bucket. Versioning is ON, so PHASE 1's key deletes left delete markers;
  // this also catches any object never recorded in storage_index.
  // -------------------------------------------------------------------------
  let listResponse;
  try {
    listResponse = await s3Client.send(new ListObjectVersionsCommand({
      Bucket: s3BucketName,
      MaxKeys: 1000
    }));
  } catch (error) {
    if (error.name === 'NoSuchBucket') {
      console.log(`Bucket ${s3BucketName} already deleted`);
      return { ...event, isEmpty: true, deletedCount: 0, bucketDeleted: true };
    }
    throw error;
  }

  const objects = [
    ...(listResponse.Versions || []).map(v => ({ Key: v.Key, VersionId: v.VersionId })),
    ...(listResponse.DeleteMarkers || []).map(m => ({ Key: m.Key, VersionId: m.VersionId }))
  ];

  if (objects.length === 0) {
    // Bucket is empty - remove the bucket itself and its resource-tracking row
    try {
      await s3Client.send(new DeleteBucketCommand({ Bucket: s3BucketName }));
      console.log(`Deleted S3 archive bucket for datastore ${datastoreId}`);
    } catch (error) {
      if (error.name === 'BucketNotEmpty') {
        console.log(`Bucket ${s3BucketName} not empty yet, continuing loop`);
        return { ...event, isEmpty: false, deletedCount: 0, bucketDeleted: false };
      }
      if (error.name !== 'NoSuchBucket') {
        throw error;
      }
    }
    await deleteResource(`arn:aws:s3:::${s3BucketName}`);
    return { ...event, isEmpty: true, deletedCount: 0, bucketDeleted: true };
  }

  const { deleted, errors, firstError } = await deleteObjectsBatched(s3BucketName, objects);
  if (errors > 0) {
    console.error('Some object versions failed to delete', { failed: errors, firstError });
    if (deleted === 0) {
      throw new Error(`Failed to delete any of ${objects.length} object versions from ${s3BucketName}: ${firstError}`);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- Error message string, not SQL; no query is built here (audited)
    }
  }

  return {
    ...event,
    isEmpty: false,
    deletedCount: deleted,
    bucketDeleted: false
  };
};
