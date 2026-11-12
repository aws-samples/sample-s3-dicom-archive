const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');

const sqsClient = new SQSClient({});
const QUEUE_URL = process.env.JOB_QUEUE_URL;

// F22: does the caller hold an EXACT canDelete grant on this datastore (or the
// '*' admin wildcard)? datastorePrivileges is threaded by the api-authorizer.
function callerCanDelete(event, datastoreId) {
  let privileges = [];
  try { privileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]'); } catch { privileges = []; }
  return privileges.some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canDelete === true // nosec - '*' is admin "All Datastores"
  );
}

exports.handler = async (event) => {
  try {
    const { storageId, studyInstanceUID } = event.pathParameters;

    // F22: require an EXACT delete grant on this datastore before enqueueing.
    // Without it, a caller holding canDelete on datastore A could delete studies
    // from datastore B by naming B's id. '*' is the admin "All Datastores" grant.
    if (!callerCanDelete(event, storageId)) {
      return respond(403, { error: 'You do not have delete permission for this datastore' });
    }

    // s3-only: the legacy per-datastore imaging id column is gone. Confirm the datastore exists; the downstream delete worker keys off internalDatastoreId.
    const dsResult = await query('SELECT id FROM datastores WHERE id = ?', [storageId]);
    if (!dsResult.length) return respond(404, { error: 'Datastore not found' });

    const initiatedBy = event.requestContext?.authorizer?.username || 'unknown';
    const userId = event.requestContext?.authorizer?.userId || 'unknown';

    const jobId = randomUUID();
    await query(
      `INSERT INTO study_modification_jobs (id, datastore_id, study_instance_uid, series_instance_uid, operation_type, status, initiated_by)
       VALUES (?, ?, ?, NULL, 'DELETE_STUDY', 'PENDING', ?)`,
      [jobId, storageId, studyInstanceUID, initiatedBy]
    );
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ jobId, datastoreId: storageId, studyInstanceUID, operationType: 'DELETE_STUDY', level: 'STUDY', scope: 'STORAGE', internalDatastoreId: storageId, username: initiatedBy, userId }),
      MessageGroupId: studyInstanceUID,
      MessageDeduplicationId: jobId,
    }));

    await sendAuditEvent({
      user: userId,
      username: initiatedBy,
      action: AUDIT_ACTIONS.DELETE_SERIES_REQUESTED,
      resourceType: RESOURCE_TYPES.SERIES,
      resourceId: studyInstanceUID,
      resourceName: `Study ${studyInstanceUID}`,
      newValues: { jobId, studyInstanceUID, datastoreId: storageId, operationType: 'DELETE_STUDY' },
      apiEndpoint: event.path,
      httpMethod: event.httpMethod,
      status: 'SUCCESS'
    });

    return respond(202, { jobs: [{ jobId, studyInstanceUID, status: 'PENDING' }] });
  } catch (error) {
    console.error('Error:', error.message);
    return respond(500, { error: error.message });
  }
};

function respond(code, body) {
  return { statusCode: code, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify(code < 400 ? { success: true, data: body } : { success: false, ...body }) };
}
