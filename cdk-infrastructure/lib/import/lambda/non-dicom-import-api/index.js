const { query } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');
const { checkStorageWritable } = require('/opt/nodejs/writable-destination');

const sqsClient = new SQSClient({});
const QUEUE_URL = process.env.ENCAPSULATION_QUEUE_URL;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
};

function ok(data, statusCode = 200) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data }) };
}

function fail(message, statusCode = 400) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message } }) };
}

// --- F15: ownership + datastore-scope authorization ------------------------
function parsePrivileges(event) {
  const raw = event.requestContext?.authorizer?.datastorePrivileges;
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function callerUsername(event) {
  return event.requestContext?.authorizer?.username || null;
}
function readableDatastoreIds(event) {
  return parsePrivileges(event).filter(p => p.canRead || p.canStore).map(p => p.datastoreId);
}
function hasGrant(event, datastoreId, kind /* 'read' | 'write' */) {
  return parsePrivileges(event).some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') &&
    (kind === 'write' ? p.canStore : (p.canRead || p.canStore)) // nosec - '*' is admin "All Datastores"
  );
}
function canAccessJob(event, job, kind) {
  if (!job) return false;
  if (hasGrant(event, job.datastore_id, kind)) return true;
  const me = callerUsername(event);
  return !!me && job.created_by === me;
}

async function createJob(event) {
  const body = JSON.parse(event.body || '{}');
  const { datastoreId, s3InputKeys, patientAttrs, studyAttrs, seriesAssignments } = body;

  if (!datastoreId || !s3InputKeys || !Array.isArray(s3InputKeys) || s3InputKeys.length === 0) {
    return fail('datastoreId and s3InputKeys array are required');
  }
  if (!patientAttrs || !studyAttrs || !seriesAssignments) {
    return fail('patientAttrs, studyAttrs, and seriesAssignments are required');
  }

  // Check write permission
  const datastorePrivileges = event.requestContext?.authorizer?.datastorePrivileges
    ? JSON.parse(event.requestContext.authorizer.datastorePrivileges)
    : [];
  const hasWrite = datastorePrivileges.some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canStore // nosec - intentional wildcard for admin "All Datastores" privilege
  );
  if (!hasWrite) {
    return fail('You do not have write permission for this datastore', 403);
  }

  // s3-only: the legacy per-datastore imaging id column is gone. Confirm the
  // datastore exists AND may be written to (shared writable-destination rule:
  // not deleted, ACTIVE, access_level NULL or 'read-write'). An unknown id keeps
  // its historical 400; a read-only or inactive storage is 403.
  const writable = await checkStorageWritable(query, datastoreId);
  if (!writable.ok) {
    return writable.statusCode === 404 ? fail('Datastore not found') : fail(writable.message, writable.statusCode);
  }

  const jobId = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username || 'unknown';

  // F16: every staged key MUST live under the caller's own prefix
  // ({username}/...), the shape the presigner writes. This stops a caller from
  // naming another user's staged objects (s3InputKeys) and having the privileged
  // encapsulator read them into the caller's datastore. The authorized prefix is
  // the authenticated principal; a bad/foreign/traversing key is rejected.
  if (!createdBy || createdBy === 'unknown') {
    return fail('Authenticated user context required', 403);
  }
  const prefix = `${createdBy}/`;
  const unsafe = (k) => {
    const s = String(k == null ? '' : k);
    return !s.startsWith(prefix) || s.includes('..') || s.startsWith('/');
  };
  const badKey = s3InputKeys.find(unsafe);
  if (badKey !== undefined) {
    return fail('s3InputKeys must reference your own uploaded objects', 403);
  }
  // F17: the encapsulator worker actually reads seriesAssignments[].s3Key (a
  // DIFFERENT field from s3InputKeys), so it must be bound to the caller's own
  // prefix too — otherwise a caller could pass clean s3InputKeys but point a
  // seriesAssignment at another user's staged object. Validate every s3Key.
  if (Array.isArray(seriesAssignments)) {
    const badAssignment = seriesAssignments.find(a => unsafe(a && a.s3Key));
    if (badAssignment !== undefined) {
      return fail('seriesAssignments must reference your own uploaded objects', 403);
    }
  }

  await query(
    `INSERT INTO non_dicom_imports
      (id, datastore_id, status, s3_input_keys, patient_attrs, study_attrs, series_assignments, created_by)
     VALUES (?, ?, 'SUBMITTED', ?, ?, ?, ?, ?)`,
    [jobId, datastoreId,
     JSON.stringify(s3InputKeys), JSON.stringify(patientAttrs),
     JSON.stringify(studyAttrs), JSON.stringify(seriesAssignments), createdBy]
  );

  // Send to encapsulation queue
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({ jobId })
  }));

  const [job] = await query('SELECT * FROM non_dicom_imports WHERE id = ?', [jobId]);

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || createdBy,
    username: createdBy,
    action: AUDIT_ACTIONS.CREATE_NON_DICOM_IMPORT,
    resourceType: RESOURCE_TYPES.NON_DICOM_IMPORT,
    resourceId: jobId,
    // Do not embed PHI (PatientID, StudyDescription) in the audit payload. The
    // audit row references the job by resourceId=jobId; the PHI lives on the
    // non_dicom_imports record and is reachable only via an authorized lookup.
    newValues: { datastoreId, fileCount: s3InputKeys.length, status: 'SUBMITTED', hasPatientId: !!patientAttrs?.PatientID, hasStudyDescription: !!studyAttrs?.StudyDescription },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  return ok(job, 201);
}

async function getJob(event) {
  const jobId = event.pathParameters?.id;
  if (!jobId) return fail('Job ID is required');

  // C04-GEN-01: the V1 and V2 importers share the non_dicom_imports table.
  // A V2 import into a de-identified folder resolves and stores the real source
  // identity in patient_attrs/study_attrs for the encapsulator; the V1 routes
  // (SELECT *) must never hand those V2 rows — and their columns — back. V1 rows
  // are version = 1 (NOT NULL DEFAULT 1); V2 rows are version = 2.
  const [job] = await query('SELECT * FROM non_dicom_imports WHERE id = ? AND version = 1', [jobId]);
  if (!job || !canAccessJob(event, job, 'read')) return fail('Job not found', 404);
  return ok(job);
}

async function listJobs(event) {
  const params = event.queryStringParameters || {};
  const limit = parseInt(params.pageSize) || 50;
  const offset = parseInt(params.offset) || 0;
  const status = params.status;
  const datastoreId = params.datastoreId;

  let sql = 'SELECT ndi.*, ds.name as datastore_name FROM non_dicom_imports ndi LEFT JOIN datastores ds ON ndi.datastore_id = ds.id WHERE ndi.version = 1';
  const qp = [];

  if (status) { sql += ' AND ndi.status = ?'; qp.push(status); }
  if (datastoreId) { sql += ' AND ndi.datastore_id = ?'; qp.push(datastoreId); }

  // F15: restrict to jobs the caller can read (by datastore grant) or created.
  // Admins (datastore '*') skip the filter. Added before countSql is derived so
  // the count matches the page.
  const readable = readableDatastoreIds(event);
  const me = callerUsername(event);
  if (!readable.includes('*')) {
    const ids = readable.filter(id => id && id !== '*');
    const ors = [];
    if (ids.length) { ors.push(`ndi.datastore_id IN (${ids.map(() => '?').join(',')})`); qp.push(...ids); }
    if (me) { ors.push('ndi.created_by = ?'); qp.push(me); }
    sql += ors.length ? ` AND (${ors.join(' OR ')})` : ' AND 1=0';
  }

  let countSql = sql.replace('SELECT ndi.*, ds.name as datastore_name', 'SELECT COUNT(*) as total');

  sql += ' ORDER BY ndi.created_at DESC LIMIT ? OFFSET ?';
  qp.push(limit, offset);

  const jobs = await query(sql, qp);
  const countParams = qp.slice(0, -2);
  const [countResult] = await query(countSql, countParams);
  const totalCount = countResult?.total || countResult?.column_0 || 0;

  return ok({
    items: jobs,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    currentPage: Math.floor(offset / limit) + 1,
    pageSize: limit
  });
}

async function deleteJob(event) {
  const jobId = event.pathParameters?.id;
  if (!jobId) return fail('Job ID is required');

  // C04-GEN-01: V1 routes operate only on V1 rows (version = 1); V2 imports are
  // managed by the V2 API.
  const [job] = await query('SELECT * FROM non_dicom_imports WHERE id = ? AND version = 1', [jobId]);
  if (!job || !canAccessJob(event, job, 'write')) return fail('Job not found', 404);
  if (job.status === 'PROCESSING' || job.status === 'IMPORTING') {
    return fail('Cannot delete a job that is in progress');
  }

  await query('DELETE FROM non_dicom_imports WHERE id = ?', [jobId]);

  const deletedBy = event.requestContext?.authorizer?.username || 'unknown';
  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || deletedBy,
    username: deletedBy,
    action: AUDIT_ACTIONS.DELETE_NON_DICOM_IMPORT,
    resourceType: RESOURCE_TYPES.NON_DICOM_IMPORT,
    resourceId: jobId,
    newValues: { datastoreId: job.datastore_id, status: job.status },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  return ok({ message: 'Job deleted' });
}

exports.handler = async (event) => {
  try {
    event.pathParameters = normalizePathParameters(event);
    const method = event.httpMethod;
    const hasId = !!event.pathParameters?.id;

    if (method === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    if (method === 'POST' && !hasId) return await createJob(event);
    if (method === 'GET' && hasId) return await getJob(event);
    if (method === 'GET' && !hasId) return await listJobs(event);
    if (method === 'DELETE' && hasId) return await deleteJob(event);

    return fail('Method not allowed', 405);
  } catch (error) {
    console.error('Error:', { errorType: error.name });
    return fail('Internal server error', 500);
  }
};
