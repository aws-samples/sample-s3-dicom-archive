const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { sanitizeError } = require('/opt/nodejs/log-utils');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');
const { storageWriteRefusal } = require('/opt/nodejs/writable-destination');
const { randomUUID } = require('crypto');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

function toCamelCase(obj) {
  const camelObj = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    camelObj[camelKey] = obj[key];
  }
  return camelObj;
}

// --- F15: ownership + datastore-scope authorization ------------------------
// Jobs carry datastore_id + created_by. A caller may see/act on a job when they
// hold the matching datastore grant (canRead to view, canStore to mutate/delete)
// OR they created it. '*' is the admin "All Datastores" grant. The authorizer
// threads datastorePrivileges + username into event.requestContext.authorizer.
function parsePrivileges(event) {
  const raw = event.requestContext?.authorizer?.datastorePrivileges;
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function callerUsername(event) {
  return event.requestContext?.authorizer?.username || null;
}
// Datastore ids the caller may READ (includes '*' sentinel when admin).
function readableDatastoreIds(event) {
  return parsePrivileges(event)
    .filter(p => p.canRead || p.canStore) // store implies the ability to see one's target
    .map(p => p.datastoreId);
}
function hasGrant(event, datastoreId, kind /* 'read' | 'write' */) {
  return parsePrivileges(event).some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') &&
    (kind === 'write' ? p.canStore : (p.canRead || p.canStore)) // nosec - '*' is admin "All Datastores"
  );
}
// May the caller act on this specific job row? Datastore grant OR creator match.
function canAccessJob(event, job, kind) {
  if (!job) return false;
  if (hasGrant(event, job.datastore_id, kind)) return true;
  const me = callerUsername(event);
  return !!me && job.created_by === me;
}

function mapImportJob(job) {
  const camel = toCamelCase(job);
  
  // Derive jobType from source_type, association_id, and job_name
  let jobType = 'BULK_IMPORT';
  if (camel.associationId) {
    jobType = 'DIMSE_IMPORT';
  } else if (camel.sourceType === 'STOW') {
    jobType = 'STOW_IMPORT';
  } else if (camel.sourceType === 'S3') {
    if (camel.jobName && camel.jobName.startsWith('UserUpload')) {
      jobType = 'UPLOAD_IMPORT';
    } else {
      jobType = 'BULK_IMPORT';
    }
  } else if (camel.sourceType === 'DICOM_SCP') {
    jobType = 'DICOM_IMPORT';
  }
  
  // Build dicomContext if we have DICOM association data
  let dicomContext = null;
  if (camel.callingAeTitle || camel.calledAeTitle) {
    dicomContext = {
      interfaceId: camel.interfaceId || 'unknown',
      interfaceName: camel.interfaceName || 'DICOM Interface',
      aeTitle: camel.calledAeTitle || 'N/A',
      callingAeTitle: camel.callingAeTitle || 'N/A'
    };
  }
  
  // Convert timestamp strings to UTC ISO format
  if (camel.createdAt && !camel.createdAt.endsWith('Z')) {
    camel.createdAt = camel.createdAt.replace(' ', 'T') + 'Z';
  }
  if (camel.updatedAt && !camel.updatedAt.endsWith('Z')) {
    camel.updatedAt = camel.updatedAt.replace(' ', 'T') + 'Z';
  }
  if (camel.startedAt && !camel.startedAt.endsWith('Z')) {
    camel.startedAt = camel.startedAt.replace(' ', 'T') + 'Z';
  }
  if (camel.completedAt && !camel.completedAt.endsWith('Z')) {
    camel.completedAt = camel.completedAt.replace(' ', 'T') + 'Z';
  }
  
  // Parse error_details JSON if it's a string
  if (camel.errorDetails && typeof camel.errorDetails === 'string') {
    try {
      camel.errorDetails = JSON.parse(camel.errorDetails);
    } catch (e) {
      console.warn('Failed to parse error_details', { error: e.message });
      camel.errorDetails = null;
    }
  }
  
  return {
    ...camel,
    jobType,
    dicomContext
  };
}

async function listJobs(event) {
  const queryParams = event.queryStringParameters || {};
  const limit = parseInt(queryParams.pageSize) || 100;
  const offset = parseInt(queryParams.offset) || 0;
  const datastoreId = queryParams.datastoreId;
  const status = queryParams.status;
  const jobType = queryParams.jobType;
  const calledAeTitle = queryParams.calledAeTitle;
  const callingAeTitle = queryParams.callingAeTitle;
  const createdDateFrom = queryParams.createdDateFrom;
  const createdDateTo = queryParams.createdDateTo;

  let sql = 'SELECT ij.*, ds.name as datastore_name FROM import_jobs ij LEFT JOIN datastores ds ON ij.datastore_id = ds.id WHERE 1=1';
  const params = [];

  // F15: restrict the result set to jobs the caller is authorized to see —
  // jobs on a datastore they can read, or jobs they created. Admins (datastore
  // '*') skip the filter. Built once and reused for the count query below.
  const readable = readableDatastoreIds(event);
  const me = callerUsername(event);
  const isAdmin = readable.includes('*');
  let scopeClause = '';
  const scopeParams = [];
  if (!isAdmin) {
    const ids = readable.filter(id => id && id !== '*');
    const ors = [];
    if (ids.length) {
      ors.push(`datastore_id IN (${ids.map(() => '?').join(',')})`);
      scopeParams.push(...ids);
    }
    if (me) {
      ors.push('created_by = ?');
      scopeParams.push(me);
    }
    // No readable datastores and no identity -> match nothing.
    scopeClause = ors.length ? ` AND (${ors.join(' OR ')})` : ' AND 1=0';
  }
  sql += scopeClause.replace(/datastore_id|created_by/g, m => 'ij.' + m);
  params.push(...scopeParams);

  if (datastoreId) {
    sql += ' AND ij.datastore_id = ?';
    params.push(datastoreId);
  }
  if (status) {
    sql += ' AND ij.status = ?';
    params.push(status);
  }
  if (jobType) {
    // Job type is derived from source_type and association_id, so we need to filter accordingly
    if (jobType === 'DIMSE_IMPORT') {
      sql += ' AND association_id IS NOT NULL';
    } else if (jobType === 'STOW_IMPORT') {
      sql += ' AND source_type = ?';
      params.push('STOW');
    } else if (jobType === 'BULK_IMPORT') {
      sql += ' AND source_type = ? AND association_id IS NULL AND (job_name NOT LIKE ?)';
      params.push('S3', 'UserUpload%');
    } else if (jobType === 'UPLOAD_IMPORT') {
      sql += ' AND source_type = ? AND job_name LIKE ?';
      params.push('S3', 'UserUpload%');
    } else if (jobType === 'DICOM_IMPORT') {
      sql += ' AND source_type = ?';
      params.push('DICOM_SCP');
    }
  }
  if (calledAeTitle) {
    sql += ' AND ij.called_ae_title = ?';
    params.push(calledAeTitle);
  }
  if (callingAeTitle) {
    sql += ' AND ij.calling_ae_title = ?';
    params.push(callingAeTitle);
  }
  if (createdDateFrom) {
    sql += ' AND ij.created_at >= ?';
    params.push(createdDateFrom);
  }
  if (createdDateTo) {
    sql += ' AND ij.created_at <= ?';
    params.push(createdDateTo);
  }

  sql += ' ORDER BY ij.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  // S13: do NOT log raw SQL/params — a MySQL query string and its bound params
  // can carry PHI (patient ids/names in filters). Log only a non-sensitive marker.
  console.log('Executing import jobs query', { paramCount: Array.isArray(params) ? params.length : 0 });

  let jobs;
  try {
    jobs = await query(sql, params);
  } catch (error) {
    // S13: log name/code only — never the SQL, params, stack, or the raw
    // driver message (which can echo SQL fragments / PHI values).
    console.error('Query execution failed:', { name: error.name, code: error.code });
    throw error;
  }

  let countSql = 'SELECT COUNT(*) as total FROM import_jobs WHERE 1=1';
  const countParams = [];
  // F15: identical scope filter on the count (unaliased table here).
  countSql += scopeClause;
  countParams.push(...scopeParams);
  if (datastoreId) {
    countSql += ' AND datastore_id = ?';
    countParams.push(datastoreId);
  }
  if (status) {
    countSql += ' AND status = ?';
    countParams.push(status);
  }
  if (jobType) {
    // Apply same job type filtering logic for count query
    if (jobType === 'DIMSE_IMPORT') {
      countSql += ' AND association_id IS NOT NULL';
    } else if (jobType === 'STOW_IMPORT') {
      countSql += ' AND source_type = ?';
      countParams.push('STOW');
    } else if (jobType === 'BULK_IMPORT') {
      countSql += ' AND source_type = ? AND association_id IS NULL AND (job_name NOT LIKE ?)';
      countParams.push('S3', 'UserUpload%');
    } else if (jobType === 'UPLOAD_IMPORT') {
      countSql += ' AND source_type = ? AND job_name LIKE ?';
      countParams.push('S3', 'UserUpload%');
    } else if (jobType === 'DICOM_IMPORT') {
      countSql += ' AND source_type = ?';
      countParams.push('DICOM_SCP');
    }
  }
  if (calledAeTitle) {
    countSql += ' AND called_ae_title = ?';
    countParams.push(calledAeTitle);
  }
  if (callingAeTitle) {
    countSql += ' AND calling_ae_title = ?';
    countParams.push(callingAeTitle);
  }
  if (createdDateFrom) {
    countSql += ' AND created_at >= ?';
    countParams.push(createdDateFrom);
  }
  if (createdDateTo) {
    countSql += ' AND created_at <= ?';
    countParams.push(createdDateTo);
  }

  // S13: no raw SQL/params in logs (PHI in filters). Marker only.
  console.log('Executing count query', { paramCount: Array.isArray(countParams) ? countParams.length : 0 });

  let countResult;
  try {
    [countResult] = await query(countSql, countParams);
  } catch (error) {
    // S13: name/code only — no SQL, params, stack, or raw driver message.
    console.error('Count query execution failed:', { name: error.name, code: error.code });
    throw error;
  }

  const totalCount = countResult?.total || countResult?.column_0 || 0;
  const totalPages = Math.ceil(totalCount / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        items: jobs.map(mapImportJob),
        totalCount,
        totalPages,
        currentPage,
        pageSize: limit,
        hasNextPage: currentPage < totalPages,
        hasPreviousPage: currentPage > 1
      }
    })
  };
}

async function getJob(event) {
  const jobId = event.pathParameters?.id;

  if (!jobId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Job ID is required' }
      })
    };
  }

  const [job] = await query('SELECT * FROM import_jobs WHERE id = ?', [jobId]);

  if (!job || !canAccessJob(event, job, 'read')) {
    // F15: 404 (not 403) so an unauthorized caller cannot distinguish
    // "exists but forbidden" from "does not exist" — no job-id enumeration.
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Import job not found' }
      })
    };
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: mapImportJob(job) })
  };
}

async function createJob(event) {
  const body = JSON.parse(event.body);
  const { datastoreId, inputS3Uri, outputS3Uri, sourceType, jobName } = body;

  console.log('createJob called:', { datastoreId, inputS3Uri, sourceType, jobName });

  if (!datastoreId || !inputS3Uri) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'datastoreId and inputS3Uri are required' }
      })
    };
  }

  // Check user write permissions from authorizer context
  const datastorePrivileges = event.requestContext?.authorizer?.datastorePrivileges 
    ? JSON.parse(event.requestContext.authorizer.datastorePrivileges) 
    : [];
  
  const hasWriteAccess = datastorePrivileges.some(p => 
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canStore // nosec - intentional wildcard for admin "All Datastores" privilege
  );
  
  if (!hasWriteAccess) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have write permission for this datastore' }
      })
    };
  }

  // s3-only: the legacy per-datastore imaging id column is gone. Confirm the
  // datastore exists and fetch its archive location for source validation.
  const [datastore] = await query(
    'SELECT id, s3_bucket_name, s3_prefix, status, access_level, deleted FROM datastores WHERE id = ?',
    [datastoreId]
  );

  if (!datastore || datastore.deleted) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Datastore not found' }
      })
    };
  }

  // An import job copies objects INTO this datastore's archive bucket
  // (import-trigger), so the shared writable-destination rule applies: a
  // read-only (imported) or non-ACTIVE storage is refused.
  const refused = storageWriteRefusal(datastore);
  if (refused) {
    return {
      statusCode: refused.statusCode,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: refused.message } })
    };
  }

  // F16: the only supported source for a create-job import is the datastore's
  // OWN archive location (server-generated backfill-style imports:
  // s3://{s3_bucket_name}/{s3_prefix}...). A free-form, caller-chosen inputS3Uri
  // pointing anywhere else is the confused-deputy vector — the privileged
  // import worker would copy from any bucket its role can read into this
  // datastore. Reject anything that is not this datastore's own bucket. DICOM
  // uploads no longer use this path at all (they presign direct-to-archive).
  {
    const srcMatch = /^s3:\/\/([^/]+)\/?(.*)$/.exec(inputS3Uri || '');
    if (!srcMatch) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid inputS3Uri' } })
      };
    }
    const srcBucket = srcMatch[1];
    const srcPrefix = srcMatch[2] || '';
    const dsPrefix = datastore.s3_prefix ? datastore.s3_prefix.replace(/^\/+|\/+$/g, '') : '';
    const bucketOk = !!datastore.s3_bucket_name && srcBucket === datastore.s3_bucket_name;
    // Exact match or a path-segment-bounded descendant only. The trailing
    // `startsWith(dsPrefix)` WITHOUT a boundary was removed: it let a datastore
    // scoped to prefix `ds1` accept a source under `ds10/...`, crossing into a
    // sibling datastore's objects. The `dsPrefix + '/'` form is the correct
    // containment check.
    const prefixOk = dsPrefix === '' || srcPrefix === dsPrefix || srcPrefix.startsWith(dsPrefix + '/');
    if (!bucketOk || !prefixOk) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error: { code: 'FORBIDDEN', message: 'inputS3Uri must reference this datastore\'s own storage location' }
        })
      };
    }
  }

  const jobId = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username || 'system';
  
  // Use provided jobName if given, otherwise generate: username-uuid
  let validJobName;
  if (jobName) {
    validJobName = jobName;
  } else {
    const username = createdBy.replace(/[^A-Za-z0-9._/#-]/g, '').slice(0, 23);
    const uuidShort = jobId.split('-')[0];
    validJobName = `${username}-${uuidShort}`;
  }

  // Generate output S3 URI at bucket root to avoid FILE_CONTENT_CHANGE errors
  let finalOutputS3Uri = outputS3Uri;
  if (!finalOutputS3Uri && inputS3Uri) {
    const bucketMatch = inputS3Uri.match(/^s3:\/\/([^\/]+)\//);
    if (bucketMatch) {
      finalOutputS3Uri = `s3://${bucketMatch[1]}/output/`;
    } else {
      finalOutputS3Uri = `${inputS3Uri}output/`;
    }
  }

  await query(
    `INSERT INTO import_jobs (
      id, datastore_id, s3_input_uri, s3_output_uri, 
      source_type, source_location, job_name, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    [
      jobId, 
      datastoreId, 
      inputS3Uri, 
      finalOutputS3Uri,
      sourceType || 'S3',
      inputS3Uri,
      validJobName,
      createdBy
    ]
  );

  // Send to import trigger queue
  const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
  const sqsClient = new SQSClient({});
  const queueUrl = process.env.IMPORT_TRIGGER_QUEUE_URL;

  if (queueUrl) {
    try {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ importJobId: jobId })
      }));
    } catch (err) {
      console.error('Failed to send to import trigger queue:', sanitizeError(err));
    }
  }

  const [newJob] = await query('SELECT * FROM import_jobs WHERE id = ?', [jobId]);

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username: event.requestContext?.authorizer?.claims?.['cognito:username'] || createdBy,
    action: AUDIT_ACTIONS.CREATE_IMPORT_JOB,
    resourceType: RESOURCE_TYPES.IMPORT_JOB,
    resourceId: jobId,
    resourceName: validJobName,
    newValues: { datastoreId, inputS3Uri, outputS3Uri, sourceType, jobName: validJobName },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: mapImportJob(newJob) })
  };
}

async function updateJob(event) {
  const jobId = event.pathParameters?.id;
  const body = JSON.parse(event.body);
  const { status, message, progress } = body;

  if (!jobId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Job ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM import_jobs WHERE id = ?', [jobId]);

  if (!existing || !canAccessJob(event, existing, 'write')) {
    // F15: write requires canStore on the job's datastore (or creator); 404 to
    // avoid revealing the existence of jobs the caller may not touch.
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Import job not found' }
      })
    };
  }

  const updates = [];
  const params = [];

  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (message !== undefined) { updates.push('message = ?'); params.push(message); }
  if (progress !== undefined) { updates.push('progress = ?'); params.push(progress); }

  if (updates.length > 0) {
    params.push(jobId);
    await query(`UPDATE import_jobs SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [updatedJob] = await query('SELECT * FROM import_jobs WHERE id = ?', [jobId]);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(updatedJob) })
  };
}

async function deleteJob(event) {
  const jobId = event.pathParameters?.id;

  if (!jobId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Job ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM import_jobs WHERE id = ?', [jobId]);

  if (!existing || !canAccessJob(event, existing, 'write')) {
    // F15: delete requires canStore on the job's datastore (or creator); 404.
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Import job not found' }
      })
    };
  }

  await query('DELETE FROM import_jobs WHERE id = ?', [jobId]);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, message: 'Import job deleted successfully' })
  };
}

exports.handler = async (event) => {
  console.log('Import Jobs API:', event.httpMethod, event.path);

  try {
    event.pathParameters = normalizePathParameters(event);
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters;

    // Handle OPTIONS for CORS preflight
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: ''
      };
    }

    if (httpMethod === 'GET' && !pathParameters?.id) {
      return await listJobs(event);
    } else if (httpMethod === 'GET' && pathParameters?.id) {
      return await getJob(event);
    } else if (httpMethod === 'POST') {
      return await createJob(event);
    } else if (httpMethod === 'PUT') {
      return await updateJob(event);
    } else if (httpMethod === 'DELETE') {
      return await deleteJob(event);
    }

    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } })
    };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
    };
  }
};
