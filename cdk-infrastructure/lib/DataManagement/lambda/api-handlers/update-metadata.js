const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { randomUUID } = require('crypto');
const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');

const sqsClient = new SQSClient({});
const QUEUE_URL = process.env.UPDATE_QUEUE_URL;

const PATIENT_FIELDS = ['PatientName', 'PatientID', 'PatientBirthDate', 'PatientSex', 'IssuerOfPatientID'];
const STUDY_FIELDS = ['StudyDate', 'StudyDescription', 'AccessionNumber', 'ReferringPhysicianName', 'StudyID'];
const SERIES_FIELDS = ['SeriesNumber', 'SeriesDescription', 'SeriesDate'];

function canUpdateDatastore(event, datastoreId) {
  let privileges = [];
  try { privileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]'); } catch { privileges = []; }
  return !!datastoreId && privileges.some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canUpdate === true // nosec - '*' is admin "All Datastores"
  );
}

exports.handler = async (event) => {
  try {
    const { storageId, studyInstanceUID } = event.pathParameters;
    const { mode, seriesInstanceUID, modifications } = JSON.parse(event.body);

    // Validate mode
    if (!['PATIENT_STUDY', 'SERIES'].includes(mode)) {
      return respond(400, { error: 'mode must be PATIENT_STUDY or SERIES' });
    }

    if (!modifications || typeof modifications !== 'object' || Object.keys(modifications).length === 0) {
      return respond(400, { error: 'modifications object required with at least one field' });
    }

    // Validate seriesInstanceUID required for SERIES mode
    if (mode === 'SERIES' && !seriesInstanceUID) {
      return respond(400, { error: 'seriesInstanceUID required for SERIES mode' });
    }

    // Validate fields match mode
    const modKeys = Object.keys(modifications);
    if (mode === 'PATIENT_STUDY') {
      const invalid = modKeys.filter(k => !PATIENT_FIELDS.includes(k) && !STUDY_FIELDS.includes(k));
      if (invalid.length) return respond(400, { error: `Invalid fields for PATIENT_STUDY mode: ${invalid.join(', ')}` });
    } else {
      const invalid = modKeys.filter(k => !SERIES_FIELDS.includes(k));
      if (invalid.length) return respond(400, { error: `Invalid fields for SERIES mode: ${invalid.join(', ')}` });
    }

    // Determine operation type
    let operationType;
    if (mode === 'SERIES') {
      operationType = 'UPDATE_SERIES';
    } else if (modKeys.some(k => PATIENT_FIELDS.includes(k))) {
      operationType = 'UPDATE_PATIENT';
    } else {
      operationType = 'UPDATE_STUDY';
    }

    // Per-datastore authz: the route-level grant only proves canUpdate on SOME
    // datastore. Require canUpdate on THIS one (or the '*' admin grant). 404, not
    // 403, so a caller cannot probe which datastore ids exist.
    if (!canUpdateDatastore(event, storageId)) return respond(404, { error: 'Datastore not found' });

    // s3-only: the legacy per-datastore imaging id column is gone. Confirm the datastore exists; the downstream update worker keys off internalDatastoreId.
    const dsResult = await query('SELECT id FROM datastores WHERE id = ?', [storageId]);
    if (!dsResult.length) return respond(404, { error: 'Datastore not found' });

    const initiatedBy = event.requestContext?.authorizer?.username || 'unknown';
    const userId = event.requestContext?.authorizer?.userId || 'unknown';
    const jobId = randomUUID();

    // Insert job record
    await query(
      `INSERT INTO study_modification_jobs (id, datastore_id, study_instance_uid, series_instance_uid, operation_type, modifications, status, initiated_by)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [jobId, storageId, studyInstanceUID, seriesInstanceUID || null, operationType, JSON.stringify(modifications), initiatedBy]
    );

    // Send to SQS
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        jobId, datastoreId: storageId, studyInstanceUID,
        seriesInstanceUID: seriesInstanceUID || null,
        operationType, modifications,
        internalDatastoreId: storageId, username: initiatedBy, userId
      }),
      MessageGroupId: studyInstanceUID,
      MessageDeduplicationId: jobId,
    }));

    // Audit
    await sendAuditEvent({
      user: userId,
      username: initiatedBy,
      action: AUDIT_ACTIONS.UPDATE_METADATA_REQUESTED || 'UPDATE_METADATA_REQUESTED',
      resourceType: RESOURCE_TYPES.STUDY || 'STUDY',
      resourceId: studyInstanceUID,
      resourceName: `Study ${studyInstanceUID}`,
      newValues: { jobId, operationType, modifications, datastoreId: storageId, seriesInstanceUID },
      apiEndpoint: event.path,
      httpMethod: event.httpMethod,
      status: 'SUCCESS'
    });

    return respond(202, { jobId, studyInstanceUID, seriesInstanceUID, operationType, status: 'PENDING' });
  } catch (error) {
    console.error('Error:', error.message);
    return respond(500, { error: error.message });
  }
};

function respond(code, body) {
  return {
    statusCode: code,
    headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
    body: JSON.stringify(code < 400 ? { success: true, data: body } : { success: false, ...body })
  };
}
