// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API.
const { query, execute } = require('/opt/nodejs/database');

exports.handler = async (event) => {
  const { datastoreId, deletionType } = event;

  // Get datastore details for later use. All datastores are S3-backed, so we
  // read the bucket name and prefix. (The former cloud-imaging role-ARN
  // columns read_only_role_arn/store_role_arn were removed in the S3-only port.)
  const rows = await query(
    'SELECT s3_bucket_name, s3_prefix FROM datastores WHERE id = ?',
    [datastoreId]
  );

  const s3BucketName = rows?.[0]?.s3_bucket_name;
  const s3Prefix = rows?.[0]?.s3_prefix;

  // Set status to DELETING
  await execute(
    'UPDATE datastores SET status = ?, status_description = ? WHERE id = ?',
    [
      'DELETING',
      deletionType === 'DEREGISTER' ? 'Deregistering datastore' : 'Deleting datastore and all content',
      datastoreId
    ]
  );

  return { datastoreId, deletionType, s3BucketName, s3Prefix };
};
