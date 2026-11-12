const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');

const sqsClient = new SQSClient({});
const QUEUE_URL = process.env.JOB_QUEUE_URL;

// Security: the route is open to anyone holding canStore on ANY folder, so the
// handler must require canStore on THIS folder (exact id or the '*' wildcard),
// as the folder API's own removeAssignments does.
function callerCanStoreOnFolder(event, virtualFolderId) {
  let privileges = [];
  try { privileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]'); } catch { privileges = []; }
  return Array.isArray(privileges) && privileges.some(p =>
    (p.virtualFolderId === virtualFolderId || p.virtualFolderId === '*') && p.canStore === true // nosec - '*' is the admin "All folders" grant
  );
}

exports.handler = async (event) => {
  try {
    const { virtualFolderId } = event.pathParameters;
    const { level, studyInstanceUID, seriesInstanceUID, sopInstanceUID } = JSON.parse(event.body);

    if (!['STUDY', 'SERIES', 'INSTANCE'].includes(level)) {
      return respond(400, { error: "level must be one of 'STUDY', 'SERIES', 'INSTANCE'" });
    }
    if (!studyInstanceUID) {
      return respond(400, { error: 'studyInstanceUID required' });
    }

    // 404, not 403, so a caller cannot probe which folders exist.
    if (!callerCanStoreOnFolder(event, virtualFolderId)) {
      return respond(404, { error: 'Virtual folder not found' });
    }

    // VF-scoped unassign (never deletes S3): confirm the virtual folder exists; the downstream worker keys off virtualFolderId.
    const vfResult = await query('SELECT id FROM virtual_folders WHERE id = ?', [virtualFolderId]);
    if (!vfResult.length) return respond(404, { error: 'Virtual folder not found' });

    const initiatedBy = event.requestContext?.authorizer?.username || 'unknown';
    const userId = event.requestContext?.authorizer?.userId || 'unknown';
    const jobs = [];

    const jobId = randomUUID();
    await query(
      `INSERT INTO study_modification_jobs (id, datastore_id, study_instance_uid, series_instance_uid, operation_type, status, initiated_by)
       VALUES (?, ?, ?, ?, 'VF_UNASSIGN', 'PENDING', ?)`,
      [jobId, null, studyInstanceUID, seriesInstanceUID || null, initiatedBy]
    );
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ jobId, virtualFolderId, studyInstanceUID, seriesInstanceUID, sopInstanceUID, operationType: 'VF_UNASSIGN', level, scope: 'VF', username: initiatedBy, userId }),
      MessageGroupId: virtualFolderId,
      MessageDeduplicationId: jobId,
    }));
    jobs.push({ jobId, status: 'PENDING' });

    for (const job of jobs) {
      await sendAuditEvent({
        user: userId,
        username: initiatedBy,
        action: AUDIT_ACTIONS.DELETE_SERIES_REQUESTED,
        resourceType: RESOURCE_TYPES.SERIES,
        resourceId: seriesInstanceUID || studyInstanceUID,
        resourceName: `VF ${virtualFolderId} unassign ${level}`,
        newValues: { jobId: job.jobId, virtualFolderId, studyInstanceUID, seriesInstanceUID, sopInstanceUID, level },
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
