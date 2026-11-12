// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API.
const { execute } = require('/opt/nodejs/database');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const sqs = new SQSClient({});

exports.handler = async (event) => {
  const { datastoreId, deletionType } = event;
  
  // Soft delete privilege groups that reference this datastore
  await execute(
    `UPDATE privilege_groups 
          SET deleted = TRUE, deleted_at = NOW() 
          WHERE JSON_SEARCH(datastore_privileges, 'one', ?, NULL, '$[*].datastoreId') IS NOT NULL
          AND deleted = FALSE`,
    [datastoreId]
  );
  
  // Mark datastore as deleted
  await execute(
    'UPDATE datastores SET deleted = TRUE, deleted_at = NOW(), status = ? WHERE id = ?',
    ['DELETED', datastoreId]
  );

  // Trigger OHIF config update after datastore deletion
  if (process.env.OHIF_CONFIG_QUEUE_URL) {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.OHIF_CONFIG_QUEUE_URL,
      MessageBody: JSON.stringify({ action: 'datastore_deleted', datastoreId })
    }));
  }
  
  return { success: true, datastoreId, deletionType };
};
