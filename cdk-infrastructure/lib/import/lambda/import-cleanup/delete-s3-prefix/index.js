const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client();

exports.handler = async (event) => {
  const { bucket, prefix, jobId } = event;

  // Safety guard: import cleanup only ever deletes STAGING objects - it must
  // never target a per-datastore archive bucket ('{stackPrefix}-ds-*')
  const stackPrefix = process.env.STACK_PREFIX;
  if (!stackPrefix) {
    throw new Error('STACK_PREFIX environment variable is required');
  }
  if (bucket.startsWith(`${stackPrefix}-ds-`)) {
    throw new Error(`Refusing to delete from archive bucket ${bucket}`);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- Error message string, not SQL; no query is built here (audited)
  }

  const listResponse = await s3Client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1000
  }));

  if (!listResponse.Contents || listResponse.Contents.length === 0) {
    return { bucket, prefix, jobId, isEmpty: true, deleted: 0 };
  }

  const deleteResponse = await s3Client.send(new DeleteObjectsCommand({
    Bucket: bucket,
    Delete: {
      Objects: listResponse.Contents.map(obj => ({ Key: obj.Key }))
    }
  }));

  return { 
    bucket, 
    prefix, 
    jobId, 
    isEmpty: false, 
    deleted: deleteResponse.Deleted?.length || 0 
  };
};
