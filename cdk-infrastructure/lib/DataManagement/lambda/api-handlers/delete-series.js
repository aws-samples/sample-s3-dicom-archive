const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');

const sqsClient = new SQSClient({});
const QUEUE_URL = process.env.JOB_QUEUE_URL;

// F22: exact per-datastore delete authorization (or '*' admin wildcard).
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
    const { seriesInstanceUIDs } = JSON.parse(event.body);

    if (!Array.isArray(seriesInstanceUIDs) || seriesInstanceUIDs.length === 0) {
      return respond(400, { error: 'seriesInstanceUIDs array required' });
    }

    // F22: require an exact delete grant on this datastore before enqueueing.
    if (!callerCanDelete(event, storageId)) {
      return respond(403, { error: 'You do not have delete permission for this datastore' });
    }

    // s3-only: the legacy per-datastore imaging id column is gone. Confirm the datastore exists; the downstream series-delete worker keys off internalDatastoreId.
    const dsResult = await query('SELECT id FROM datastores WHERE id = ?', [storageId]);
    if (!dsResult.length) return respond(404, { error: 'Datastore not found' });

    const initiatedBy = event.requestContext?.authorizer?.username || 'unknown';
    const userId = event.requestContext?.authorizer?.userId || 'unknown';
    const jobs = [];

    for (const seriesUID of seriesInstanceUIDs) {
      const jobId = randomUUID();
      await query(
        `INSERT INTO study_modification_jobs (id, datastore_id, study_instance_uid, series_instance_uid, operation_type, status, initiated_by)
         VALUES (?, ?, ?, ?, 'DELETE_SERIES', 'PENDING', ?)`,
        [jobId, storageId, studyInstanceUID, seriesUID, initiatedBy]
      );
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify({ jobId, datastoreId: storageId, studyInstanceUID, seriesInstanceUID: seriesUID, operationType: 'DELETE_SERIES', level: 'SERIES', internalDatastoreId: storageId, username: initiatedBy, userId }),
        MessageGroupId: studyInstanceUID,
        MessageDeduplicationId: jobId,
      }));
      jobs.push({ jobId, seriesInstanceUID: seriesUID, status: 'PENDING' });
    }

    for (const job of jobs) {
      await sendAuditEvent({
        user: userId,
        username: initiatedBy,
        action: AUDIT_ACTIONS.DELETE_SERIES_REQUESTED,
        resourceType: RESOURCE_TYPES.SERIES,
        resourceId: job.seriesInstanceUID,
        resourceName: `Series ${job.seriesInstanceUID}`,
        newValues: { jobId: job.jobId, studyInstanceUID, datastoreId: storageId },
        apiEndpoint: event.path,
        httpMethod: event.httpMethod,
        status: 'SUCCESS'
      });
    }

    return respond(202, { jobs });
  } catch (error) {
    console.error('Error:', error.message);
    return respond(500, { error: error.message });
  }
};

function respond(code, body) {
  return { statusCode: code, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: JSON.stringify(code < 400 ? { success: true, data: body } : { success: false, ...body }) };
}
