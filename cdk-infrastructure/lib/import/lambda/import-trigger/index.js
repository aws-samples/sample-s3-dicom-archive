const {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCopyCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { query } = require('/opt/nodejs/database');
const { isWritableAccessLevel, MESSAGES: WRITABLE_MESSAGES } = require('/opt/nodejs/writable-destination');

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});

const IMPORT_TRIGGER_QUEUE_URL = process.env.IMPORT_TRIGGER_QUEUE_URL;
const S3_CLEANUP_QUEUE_URL = process.env.S3_CLEANUP_QUEUE_URL;
const UPLOAD_BUCKET_NAME = process.env.UPLOAD_BUCKET_NAME;

// Retry delays in seconds
const RETRY_DELAYS = [60, 120, 300, 600, 1800, 3600]; // 1min, 2min, 5min, 10min, 30min, 1hr

// Number of staged objects copied in parallel for S3-storage datastores
const COPY_CONCURRENCY = 8;

// CopyObject supports sources up to 5 GiB; larger objects need a multipart copy
const MULTIPART_COPY_THRESHOLD = 5 * 1024 * 1024 * 1024;
const MULTIPART_COPY_PART_SIZE = 512 * 1024 * 1024;

function parseS3Uri(uri) {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri || '');
  if (!match) return null;
  let prefix = match[2] || '';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { bucket: match[1], prefix };
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  return error;
}

// Server-side copy of a single staged object; objects above the CopyObject
// 5 GiB source limit are copied via multipart UploadPartCopy ranges.
async function copyObjectToArchive(sourceBucket, key, destBucket, destKey, size) {
  const copySource = encodeURIComponent(`${sourceBucket}/${key}`);

  if (size <= MULTIPART_COPY_THRESHOLD) {
    await s3Client.send(new CopyObjectCommand({
      Bucket: destBucket,
      Key: destKey,
      CopySource: copySource,
      MetadataDirective: 'COPY',
      TaggingDirective: 'COPY'
    }));
    return;
  }

  const { UploadId } = await s3Client.send(new CreateMultipartUploadCommand({
    Bucket: destBucket,
    Key: destKey
  }));

  try {
    const parts = [];
    let partNumber = 1;
    for (let offset = 0; offset < size; offset += MULTIPART_COPY_PART_SIZE) {
      const end = Math.min(offset + MULTIPART_COPY_PART_SIZE, size) - 1;
      const { CopyPartResult } = await s3Client.send(new UploadPartCopyCommand({
        Bucket: destBucket,
        Key: destKey,
        UploadId,
        PartNumber: partNumber,
        CopySource: copySource,
        CopySourceRange: `bytes=${offset}-${end}`
      }));
      parts.push({ ETag: CopyPartResult.ETag, PartNumber: partNumber });
      partNumber++;
    }

    await s3Client.send(new CompleteMultipartUploadCommand({
      Bucket: destBucket,
      Key: destKey,
      UploadId,
      MultipartUpload: { Parts: parts }
    }));
  } catch (error) {
    try {
      await s3Client.send(new AbortMultipartUploadCommand({ Bucket: destBucket, Key: destKey, UploadId }));
    } catch (abortError) {
      console.error('Failed to abort multipart copy', { destKey, error: abortError.message });
    }
    throw error;
  }
}

// A non-DICOM import stages its encapsulated DICOM in the deployment's upload
// bucket under encapsulated/<nonDicomJobId>/, then creates this import job. That
// source is accepted only when it is exactly that prefix of the upload bucket
// AND a non_dicom_imports row for the same datastore links to this import job
// and recorded that same URI. A free-form s3_input_uri pointing anywhere else in
// the upload bucket (another job's files, or a user's raw uploads) still fails.
async function isNonDicomStagingSource(job, source) {
  if (!UPLOAD_BUCKET_NAME || source.bucket !== UPLOAD_BUCKET_NAME) return false;
  const [link] = await query(
    'SELECT id, s3_encapsulated_uri FROM non_dicom_imports WHERE import_job_id = ? AND datastore_id = ?',
    [job.id, job.datastore_id]
  );
  if (!link) return false;
  const recorded = parseS3Uri(link.s3_encapsulated_uri);
  return source.prefix === `encapsulated/${link.id}/`
    && !!recorded
    && recorded.bucket === source.bucket
    && recorded.prefix === source.prefix;
}

// Keeps a linked non-DICOM import's status in step with its import job. The
// success side is written by the ingest path when the import job completes.
async function failLinkedNonDicomImport(importJobId, message) {
  try {
    await query(
      `UPDATE non_dicom_imports SET status = 'FAILED', status_description = ?, updated_at = NOW()
       WHERE import_job_id = ? AND status IN ('PROCESSING', 'IMPORTING')`,
      [`Import failed: ${message}`.slice(0, 1000), importJobId]
    );
  } catch (e) {
    console.error('Failed to mark linked non-DICOM import FAILED', { importJobId, error: e.message });
  }
}

// Copies every staged object under the job's s3_input_uri into the datastore's
// archive bucket (keys preserved under the datastore s3_prefix). Indexing then
// happens via the archive bucket's S3 events. Returns the number of objects
// copied; throws if any copy fails, so a partial copy never looks complete.
async function copyStagedObjectsToArchive(job, datastore) {
  const source = parseS3Uri(job.s3_input_uri);
  if (!source) {
    throw validationError('Import job has an invalid or missing s3_input_uri');
  }
  if (!datastore.s3_bucket_name) {
    throw validationError('Datastore has no s3_bucket_name configured');
  }

  // F16 (worker re-validation): the source MUST be this datastore's own archive
  // bucket. The create API already enforces this, but a tampered or stale
  // s3_input_uri row must not be able to make this privileged worker copy from
  // an arbitrary service-readable bucket. Fail closed on any mismatch.
  // The one other accepted source is a non-DICOM import's encapsulated output
  // (see isNonDicomStagingSource).
  if (source.bucket !== datastore.s3_bucket_name
      && !(await isNonDicomStagingSource(job, source))) {
    throw validationError('Import source bucket is not the datastore archive bucket');
  }

  const destBucket = datastore.s3_bucket_name;
  const destPrefix = datastore.s3_prefix
    ? datastore.s3_prefix.replace(/^\/+|\/+$/g, '') + '/'
    : '';
  // Never re-ingest anything the pipeline itself wrote under {input}/output/
  const outputPrefix = `${source.prefix}output/`;

  let continuationToken;
  let copied = 0;

  do {
    const listResponse = await s3Client.send(new ListObjectsV2Command({
      Bucket: source.bucket,
      Prefix: source.prefix,
      ContinuationToken: continuationToken
    }));

    const keys = (listResponse.Contents || [])
      .map(obj => obj.Key)
      .filter(key => !key.endsWith('/') && !key.startsWith(outputPrefix));

    for (let i = 0; i < keys.length; i += COPY_CONCURRENCY) {
      const chunk = keys.slice(i, i + COPY_CONCURRENCY);
      await Promise.all(chunk.map(key => s3Client.send(new CopyObjectCommand({
        Bucket: destBucket,
        Key: `${destPrefix}${key}`,
        CopySource: encodeURIComponent(`${source.bucket}/${key}`),
        MetadataDirective: 'COPY',
        TaggingDirective: 'COPY'
      }))));
      copied += chunk.length;
    }

    continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
  } while (continuationToken);

  return copied;
}

exports.handler = async (event) => {
  console.log('Import Trigger started', { recordCount: event.Records.length });

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      const { importJobId } = message;
      const retryCount = message.retryCount || 0;

      console.log('Processing import job', { importJobId, retryCount });

      // Get import job from database
      const [job] = await query('SELECT * FROM import_jobs WHERE id = ?', [importJobId]);

      if (!job) {
        console.error('Import job not found', { importJobId });
        continue;
      }

      if (job.status !== 'PENDING') {
        console.log('Import job not in PENDING status, skipping', { importJobId, status: job.status });
        continue;
      }

      // Resolve the owning datastore for its archive bucket/prefix. All
      // datastores are S3-storage now, so there is no storage-type branch.
      const [datastore] = await query(
        'SELECT s3_bucket_name, s3_prefix, access_level FROM datastores WHERE id = ?',
        [job.datastore_id]
      );

      try {
        if (!datastore) {
          throw validationError('Datastore not found for import job');
        }
        // Worker-side writable-destination check (the create APIs check too):
        // never copy into a read-only storage, e.g. a job queued before the
        // storage was made read-only, or a retried job. Not retryable.
        if (!isWritableAccessLevel(datastore.access_level)) {
          throw validationError(WRITABLE_MESSAGES.STORAGE_READ_ONLY);
        }

        // Copy staged objects into the datastore's archive bucket; the
        // s3-ingest pipeline indexes the objects from the archive bucket's
        // S3 events and completes the job.
        const copied = await copyStagedObjectsToArchive(job, datastore);

        if (copied === 0) {
          throw validationError('No staged objects found under s3_input_uri');
        }

        await query(
          `UPDATE import_jobs
           SET status = 'IN_PROGRESS',
               total_files = ?,
               started_at = NOW(),
               updated_at = NOW()
           WHERE id = ?`,
          [copied, importJobId]
        );

        console.log('Copied staged objects to archive bucket', { importJobId, totalFiles: copied });

        // Every staged object now has a verified copy in the archive bucket,
        // so the staging copy is safe to clean up regardless of indexing
        // outcome. A cleanup-trigger failure must not fail the import itself.
        if (S3_CLEANUP_QUEUE_URL && job.s3_input_uri) {
          try {
            await sqsClient.send(new SendMessageCommand({
              QueueUrl: S3_CLEANUP_QUEUE_URL,
              MessageBody: JSON.stringify({
                inputS3Uri: job.s3_input_uri,
                jobId: importJobId
              })
            }));

            await query(
              `UPDATE import_jobs SET s3_cleanup_status = 'IN_PROGRESS' WHERE id = ?`,
              [importJobId]
            );

            console.log('Triggered staging cleanup after verified copy', { importJobId });
          } catch (cleanupError) {
            console.error('Failed to trigger S3 cleanup', { importJobId, error: cleanupError.message });
          }
        }

      } catch (error) {
        console.error('Error starting import', { importJobId, error: error.message, code: error.name });

        // Check if error is retryable (S3 transient errors)
        const isRetryable = [
          'ThrottlingException',
          'TooManyRequestsException',
          'ServiceUnavailableException',
          'LimitExceededException',
          'SlowDown',
          'ServiceUnavailable',
          'InternalError',
          'RequestTimeout'
        ].includes(error.name);

        if (isRetryable && retryCount < RETRY_DELAYS.length) {
          // Re-queue with delay
          const delaySeconds = RETRY_DELAYS[retryCount];
          console.log('Re-queuing with delay', { importJobId, retryCount: retryCount + 1, delaySeconds });

          await sqsClient.send(new SendMessageCommand({
            QueueUrl: IMPORT_TRIGGER_QUEUE_URL,
            MessageBody: JSON.stringify({
              importJobId,
              retryCount: retryCount + 1
            }),
            DelaySeconds: Math.min(delaySeconds, 900) // SQS max delay is 15 minutes
          }));

          // Update retry count in database
          await query(
            `UPDATE import_jobs
             SET retry_count = ?,
                 last_error = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [retryCount + 1, error.message, importJobId]
          );

        } else {
          // Mark as failed
          console.error('Import job failed', { importJobId, retryCount });
          await query(
            `UPDATE import_jobs
             SET status = 'FAILED',
                 error_message = ?,
                 failed_at = NOW(),
                 updated_at = NOW()
             WHERE id = ?`,
            [error.message, importJobId]
          );
          await failLinkedNonDicomImport(importJobId, error.message);
        }
      }

    } catch (error) {
      console.error('Error processing record', { error: error.message });
      throw error;
    }
  }
};
