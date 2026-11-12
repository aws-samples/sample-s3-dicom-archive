// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API.
const { execute } = require('/opt/nodejs/database');
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
const eventBridge = new EventBridgeClient({});

exports.handler = async (event) => {
  let { datastoreId, status, statusDescription, s3BucketName, s3Prefix } = event;
  
  // Extract errorMessage from Step Functions Cause JSON
  if (statusDescription) {
    try {
      const parsed = JSON.parse(statusDescription);
      if (parsed.errorMessage) statusDescription = parsed.errorMessage;
    } catch (e) { /* not JSON, use as-is */ }
  }
  
  // Build the UPDATE with positional `?` placeholders (mysql2). The `id`
  // placeholder is appended LAST to match its WHERE position at the end.
  let setSql = 'UPDATE datastores SET status = ?';
  const params = [status];
  
  if (statusDescription) {
    setSql += ', status_description = ?';
    params.push(statusDescription);
    if (status === 'ERROR') {
      setSql += ', description = ?';
      params.push(statusDescription);
    }
  }
  if (s3BucketName) {
    setSql += ', s3_bucket_name = ?';
    params.push(s3BucketName);
  }
  if (s3Prefix) {
    setSql += ', s3_prefix = ?';
    params.push(s3Prefix);
  }
  setSql += ' WHERE id = ?';
  params.push(datastoreId);
  
  await execute(setSql, params);

  // Trigger OHIF config update when datastore becomes ACTIVE
  if (status === 'ACTIVE' && process.env.EVENT_BUS_NAME) {
    await eventBridge.send(new PutEventsCommand({
      Entries: [{
        Source: 'dicom.archive',
        DetailType: 'DatastoreCreated',
        Detail: JSON.stringify({
          datastoreId,
          s3BucketName,
          status: 'ACTIVE'
        }),
        EventBusName: process.env.EVENT_BUS_NAME
      }]
    }));
  }
  
  return { success: true, datastoreId };
};
