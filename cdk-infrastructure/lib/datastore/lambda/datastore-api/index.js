const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
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

// F21: exact per-datastore read authorization for the id-bearing routes
// (detail, statistics, content). The IAM authorizer grants GET /datastores/*
// to anyone with ANY datastore read, so without this a user holding read on
// datastore A could read B's detail/stats/physical object inventory by naming
// B's id. '*' is the admin "All Datastores" grant. Returns true if allowed.
function canReadDatastore(event, datastoreId) {
  let privileges = [];
  try { privileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]'); } catch { privileges = []; }
  return privileges.some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canRead === true // nosec - '*' is admin "All Datastores"
  );
}

// Standard 404 (not 403) so a caller cannot distinguish "exists but forbidden"
// from "does not exist" — no datastore-id enumeration.
function notFound() {
  return {
    statusCode: 404,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Datastore not found' } })
  };
}

// F22: write-class grant (canStore) on this datastore, or '*' admin wildcard.
// Used to gate the sync/re-index action, which triggers work on a datastore.
function canStoreDatastore(event, datastoreId) {
  let privileges = [];
  try { privileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]'); } catch { privileges = []; }
  return privileges.some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canStore === true // nosec - '*' is admin "All Datastores"
  );
}

// Destructive grant (canDelete) on this datastore, or '*' admin wildcard.
// Used to gate DEREGISTER / DELETE_ALL; canStore alone must not allow deletion.
function canDeleteDatastore(event, datastoreId) {
  let privileges = [];
  try { privileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]'); } catch { privileges = []; }
  return privileges.some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canDelete === true // nosec - '*' is admin "All Datastores"
  );
}

async function listDatastores(event) {
  const queryParams = event.queryStringParameters || {};
  const pageSize = parseInt(queryParams.pageSize) || 100;
  const currentPage = parseInt(queryParams.page) || 1;
  const offset = (currentPage - 1) * pageSize;

  // Get user's datastore privileges from authorizer context
  const datastorePrivileges = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]');
  const hasWildcard = datastorePrivileges.some(p => p.datastoreId === '*' && p.canRead); // nosec - intentional wildcard for admin "All Datastores" privilege
  const allowedIds = datastorePrivileges.filter(p => p.canRead && p.datastoreId !== '*').map(p => p.datastoreId);

  let datastores;
  let totalCount;

  if (hasWildcard) {
    // Explicit admin wildcard ('*' with canRead) — return all. A caller with NO
    // privileges does NOT land here: it must fall through to the deny `else`
    // below. Granting all datastores on an empty privilege set was a fail-open
    // (a missing/empty authorizer context read as admin); access is now
    // fail-closed and only an explicit wildcard privilege opens everything.
    datastores = await query(
      `SELECT d.*, 
        ds.study_count, ds.series_count, ds.instance_count, ds.total_size_bytes
      FROM datastores d
      LEFT JOIN (
        SELECT s1.datastore_id, s1.study_count, s1.series_count, s1.instance_count, s1.total_size_bytes
        FROM datastore_statistics s1
        JOIN (
          SELECT datastore_id, MAX(last_updated) AS mx
          FROM datastore_statistics WHERE latest = TRUE GROUP BY datastore_id
        ) s2 ON s1.datastore_id = s2.datastore_id AND s1.last_updated = s2.mx
        WHERE s1.latest = TRUE
        GROUP BY s1.datastore_id
      ) ds ON d.id = ds.datastore_id
      WHERE d.deleted = false
      ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    const countResults = await query('SELECT COUNT(*) as total FROM datastores WHERE deleted = false');
    totalCount = countResults[0]?.total || countResults[0]?.column_0 || datastores.length;
  } else if (allowedIds.length > 0) {
    // Filter by allowed datastore IDs
    const placeholders = allowedIds.map(() => '?').join(',');
    datastores = await query(
      `SELECT d.*, 
        ds.study_count, ds.series_count, ds.instance_count, ds.total_size_bytes
      FROM datastores d
      LEFT JOIN (
        SELECT s1.datastore_id, s1.study_count, s1.series_count, s1.instance_count, s1.total_size_bytes
        FROM datastore_statistics s1
        JOIN (
          SELECT datastore_id, MAX(last_updated) AS mx
          FROM datastore_statistics WHERE latest = TRUE GROUP BY datastore_id
        ) s2 ON s1.datastore_id = s2.datastore_id AND s1.last_updated = s2.mx
        WHERE s1.latest = TRUE
        GROUP BY s1.datastore_id
      ) ds ON d.id = ds.datastore_id
      WHERE d.deleted = false AND d.id IN (${placeholders})
      ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
      [...allowedIds, pageSize, offset]
    );
    const countResults = await query(
      `SELECT COUNT(*) as total FROM datastores WHERE deleted = false AND id IN (${placeholders})`,
      allowedIds
    );
    totalCount = countResults[0]?.total || countResults[0]?.column_0 || datastores.length;
  } else {
    // No access
    datastores = [];
    totalCount = 0;
  }

  const totalPages = Math.ceil(totalCount / pageSize);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        items: datastores.map(toCamelCase),
        totalCount,
        pageSize,
        currentPage,
        totalPages
      }
    })
  };
}

async function getDatastore(event) {
  const datastoreId = event.pathParameters?.id;

  if (!datastoreId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Datastore ID is required' }
      })
    };
  }

  const [datastore] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);

  if (!datastore || !canReadDatastore(event, datastoreId)) {
    return notFound();
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(datastore) })
  };
}

async function createDatastore(event) {
  const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

  const sfnClient = new SFNClient({ region: process.env.AWS_REGION });

  const body = JSON.parse(event.body);
  const { name, description, createAccessRoles } = body;

  if (!name) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'name is required' }
      })
    };
  }

  // S3-only: every datastore is backed by a per-datastore S3 archive bucket.
  // Files are kept in their native transfer syntax (no transcode format), so
  // transcode/lossless options are rejected.
  if (body.losslessFormat || body.transcodeTo) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'transcode format is not supported for S3 storage datastores' }
      })
    };
  }

  let s3Prefix = null;
  if (body.s3Prefix !== undefined && body.s3Prefix !== null && body.s3Prefix !== '') {
    if (typeof body.s3Prefix !== 'string'
      || !/^[A-Za-z0-9._/-]{1,512}$/.test(body.s3Prefix)
      || body.s3Prefix.startsWith('/')
      || body.s3Prefix.includes('..')) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 's3Prefix must be a relative key prefix containing only letters, numbers, dots, hyphens, underscores and slashes' }
        })
      };
    }
    s3Prefix = body.s3Prefix.replace(/\/+$/, '');
  }

  // Name validation
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Name must be 1-32 characters and contain only letters, numbers, dots, hyphens, and underscores' }
    })};
  }

  const datastoreId = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username || 'system';

  // S3-native datastore: the s3_bucket_name is written by the creation workflow
  // once the archive bucket exists.
  await query(
    `INSERT INTO datastores (id, name, description, status, created_by, s3_prefix)
     VALUES (?, ?, ?, 'CREATING', ?, ?)`,
    [datastoreId, name, description || null, createdBy, s3Prefix]
  );

  // Create privilege groups if requested
  if (createAccessRoles) {
    const readOnlyGroupId = randomUUID();
    const storeGroupId = randomUUID();

    await query(
      `INSERT INTO privilege_groups (id, name, description, datastore_privileges, management_privileges, locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [
        readOnlyGroupId,
        `${name} - Read Only`,
        `Read-only access to ${name} datastore`,
        JSON.stringify([{ datastoreId, canRead: true, canStore: false, canUpdate: false, canDelete: false }]),
        JSON.stringify({
          interfaces: { canEdit: false, canDelete: false, canList: false },
          dicomEntities: { canEdit: false, canDelete: false, canList: false },
          datastores: { canEdit: false, canDelete: false, canList: false },
          privilegeGroups: { canEdit: false, canDelete: false, canList: false },
          users: { canEdit: false, canDelete: false, canList: false }
        })
      ]
    );

    await query(
      `INSERT INTO privilege_groups (id, name, description, datastore_privileges, management_privileges, locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [
        storeGroupId,
        `${name} - Store`,
        `Store access to ${name} datastore`,
        JSON.stringify([{ datastoreId, canRead: true, canStore: true, canUpdate: false, canDelete: false }]),
        JSON.stringify({
          interfaces: { canEdit: false, canDelete: false, canList: false },
          dicomEntities: { canEdit: false, canDelete: false, canList: false },
          datastores: { canEdit: false, canDelete: false, canList: false },
          privilegeGroups: { canEdit: false, canDelete: false, canList: false },
          users: { canEdit: false, canDelete: false, canList: false }
        })
      ]
    );
  }

  // Trigger Step Function workflow (S3 bucket provisioning)
  if (process.env.CREATION_STATE_MACHINE_ARN) {
    try {
      await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: process.env.CREATION_STATE_MACHINE_ARN,
        input: JSON.stringify({
          id: datastoreId,
          name,
          description,
          createAccessRoles,
          s3Prefix: s3Prefix || ''
        })
      }));
    } catch (error) {
      console.error('Failed to start workflow:', error.message);
      await query(
        `UPDATE datastores SET status = 'ERROR', status_description = ? WHERE id = ?`,
        ['Failed to start workflow: ' + error.message, datastoreId]
      );
    }
  }

  const [newDatastore] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username: event.requestContext?.authorizer?.claims?.['cognito:username'] || createdBy,
    action: AUDIT_ACTIONS.CREATE_DATASTORE,
    resourceType: RESOURCE_TYPES.DATASTORE,
    resourceId: datastoreId,
    resourceName: name,
    newValues: {
      name,
      description,
      imported: false,
      s3Prefix,
      createAccessRoles
    },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(newDatastore) })
  };
}

async function updateDatastore(event) {
  const datastoreId = event.pathParameters?.id;
  const body = JSON.parse(event.body);
  const { name, description, status } = body;
  const username = event.requestContext?.authorizer?.claims?.['cognito:username'] || 'system';

  if (!datastoreId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Datastore ID is required' }
      })
    };
  }

  // Per-object authz: updating a datastore (name/description/status) is a
  // write-class action — require canStore on THIS datastore (or '*' admin). The
  // authorizer only scopes the route to /datastores/*, so the per-datastore
  // check MUST happen here. 404 (not 403) so existence is not leaked.
  if (!canStoreDatastore(event, datastoreId)) {
    return notFound();
  }

  const [existing] = await query('SELECT * FROM datastores WHERE id = ? AND deleted = false', [datastoreId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Datastore not found' }
      })
    };
  }

  const newValues = {};
  if (name !== undefined) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(name)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Name must be 1-32 characters and contain only letters, numbers, dots, hyphens, and underscores' }
      })};
    }
    newValues.name = name;
  }
  if (description !== undefined) newValues.description = description;
  if (status !== undefined) newValues.status = status;

  if (Object.keys(newValues).length > 0) {
    await saveVersionAndUpdate('datastores', datastoreId, existing, newValues, username, query);
  }

  const [updatedDatastore] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username,
    action: AUDIT_ACTIONS.UPDATE_DATASTORE,
    resourceType: RESOURCE_TYPES.DATASTORE,
    resourceId: datastoreId,
    resourceName: existing.name,
    oldValues: {
      name: existing.name,
      description: existing.description
    },
    newValues: newValues,
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    oldValues: { name: existing.name, description: existing.description, status: existing.status },
    newValues: { name, description, status },
    status: 'SUCCESS'
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: toCamelCase(updatedDatastore) })
  };
}

async function deleteDatastore(event) {
  const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
  const sfnClient = new SFNClient({ region: process.env.AWS_REGION });
  
  const datastoreId = event.pathParameters?.id;
  const body = event.body ? JSON.parse(event.body) : {};
  const deletionType = body.deletionType || 'DEREGISTER'; // Default to DEREGISTER

  if (!datastoreId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Datastore ID is required' }
      })
    };
  }

  if (!['DEREGISTER', 'DELETE_ALL'].includes(deletionType)) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'deletionType must be DEREGISTER or DELETE_ALL' }
      })
    };
  }

  // Per-object authz: deleting/deregistering a datastore is destructive —
  // require canDelete on THIS datastore (or '*' admin).
  // 404 (not 403) so existence is not leaked.
  if (!canDeleteDatastore(event, datastoreId)) {
    return notFound();
  }

  const [existing] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Datastore not found' }
      })
    };
  }

  // Check if datastore is used in any routing rules
  const routingRules = await query(
    `SELECT name FROM routing_rules 
     WHERE deleted = FALSE 
     AND JSON_EXTRACT(action, '$.datastoreId') = ?`,
    [datastoreId]
  );

  if (routingRules.length > 0) {
    const ruleNames = routingRules.map(r => r.name).join(', ');
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { 
          code: 'DATASTORE_IN_USE', 
          message: `Cannot delete datastore. It is used in the following routing rules: ${ruleNames}` 
        }
      })
    };
  }

  // Trigger Step Function workflow (status will be set to DELETING by the workflow)
  if (process.env.DELETION_STATE_MACHINE_ARN) {
    try {
      await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: process.env.DELETION_STATE_MACHINE_ARN,
        input: JSON.stringify({ datastoreId, deletionType })
      }));
    } catch (error) {
      console.error('Failed to start deletion workflow:', error.message);
      await query(
        `UPDATE datastores SET status = 'ERROR', status_description = ? WHERE id = ?`,
        ['Failed to start deletion workflow: ' + error.message, datastoreId]
      );
    }
  }

  const deletedBy = event.requestContext?.authorizer?.username || 'system';

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username: event.requestContext?.authorizer?.claims?.['cognito:username'] || deletedBy,
    action: AUDIT_ACTIONS.DELETE_DATASTORE,
    resourceType: RESOURCE_TYPES.DATASTORE,
    resourceId: datastoreId,
    resourceName: existing.name,
    oldValues: {
      name: existing.name,
      description: existing.description,
      status: existing.status
    },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    oldValues: { name: existing.name, status: existing.status },
    status: 'SUCCESS'
  });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, message: `Datastore ${deletionType === 'DEREGISTER' ? 'deregistration' : 'deletion'} initiated` })
  };
}

async function getStatistics(event) {
  // The API exposes GET /datastores/statistics (no {id} segment), so the id
  // comes from ?datastoreId=; a path id is still honoured if a route adds one.
  const datastoreId = event.pathParameters?.id || event.queryStringParameters?.datastoreId;

  if (!datastoreId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Datastore ID is required' }
      })
    };
  }

  const [datastore] = await query('SELECT * FROM datastores WHERE id = ?', [datastoreId]);

  if (!datastore || !canReadDatastore(event, datastoreId)) {
    return notFound();
  }

  const [studyCount] = await query('SELECT COUNT(*) as count FROM study WHERE datastore_id = ? AND deleted_at IS NULL', [datastoreId]);
  const [seriesCount] = await query('SELECT COUNT(*) as count FROM series WHERE datastore_id = ? AND deleted_at IS NULL', [datastoreId]);
  const [instanceCount] = await query('SELECT COUNT(*) as count FROM instance WHERE datastore_id = ? AND deleted_at IS NULL', [datastoreId]);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        datastoreId,
        studyCount: studyCount?.count || 0,
        seriesCount: seriesCount?.count || 0,
        instanceCount: instanceCount?.count || 0
      }
    })
  };
}

// Sync / re-index a datastore's S3 bucket against the index.
// POST /datastores/{id}/sync  body: { prefixes?: string[], mode?: 'delta'|'full' }
//
// Reuses the datastore-backfill lambda (ListObjectsV2 crawl -> synthetic S3
// events onto the ingest queue). One async (Event) invocation per prefix, each
// getting its own import_jobs row for progress. Default prefix is the whole
// bucket (['']). Mode is passed through: 'delta' (default) skips objects
// already indexed and unchanged; 'full' re-enqueues everything.
async function syncDatastore(event) {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

  const datastoreId = event.pathParameters?.id;
  if (!datastoreId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Datastore ID is required' } })
    };
  }

  const backfillArn = process.env.BACKFILL_FUNCTION_ARN;
  if (!backfillArn) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'CONFIG_ERROR', message: 'Sync is not configured (BACKFILL_FUNCTION_ARN missing)' } })
    };
  }

  const [datastore] = await query(
    'SELECT id, name, s3_bucket_name, status FROM datastores WHERE id = ? AND deleted = false',
    [datastoreId]
  );
  if (!datastore) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Datastore not found' } })
    };
  }
  // F22: sync re-indexes the datastore — a write-class action. Require canStore
  // on this specific datastore (or '*'), not merely the canEdit route grant.
  // Return 404 (notFound), NOT 403: a 403 here distinguishes "exists but
  // forbidden" from the 404 "does not exist" above, which lets a caller
  // enumerate valid datastore IDs. The other datastore handlers already use
  // notFound() uniformly for this reason.
  if (!canStoreDatastore(event, datastoreId)) {
    return notFound();
  }
  if (!datastore.s3_bucket_name) {
    return {
      statusCode: 409,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'NO_BUCKET', message: 'Datastore has no S3 bucket to sync (still provisioning?)' } })
    };
  }

  const body = event.body ? JSON.parse(event.body) : {};

  // Mode: delta (default) skips objects already indexed & unchanged; full
  // re-enqueues every object.
  const mode = body.mode === 'full' ? 'full' : 'delta';

  // Prefixes: default the whole bucket ('' == no prefix filter). Validate each
  // as a relative key prefix (same shape create/import accept for s3Prefix).
  let prefixes = Array.isArray(body.prefixes) ? body.prefixes : [];
  prefixes = prefixes
    .filter((p) => typeof p === 'string')
    .map((p) => p.trim());
  for (const p of prefixes) {
    if (p !== '' && (!/^[A-Za-z0-9._/-]{1,512}$/.test(p) || p.startsWith('/') || p.includes('..'))) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `Invalid prefix "${p}": must be a relative key prefix (letters, numbers, dots, hyphens, underscores, slashes)` }
        })
      };
    }
  }
  if (prefixes.length === 0) prefixes = ['']; // whole bucket
  // De-dup.
  prefixes = [...new Set(prefixes)];

  const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

  // One async backfill invocation per prefix; each creates its own import_jobs
  // row. Event invocation (fire-and-forget) so a large crawl doesn't block the
  // API response.
  const invoked = [];
  for (const prefix of prefixes) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: backfillArn,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          datastoreId,
          bucketName: datastore.s3_bucket_name,
          prefix,
          mode
        }))
      }));
      invoked.push(prefix);
    } catch (error) {
      console.error(`Failed to invoke backfill for prefix "${prefix}":`, error.message);
      return {
        statusCode: 502,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: false,
          error: { code: 'INVOKE_FAILED', message: `Failed to start sync for prefix "${prefix}": ${error.message}` }
        })
      };
    }
  }

  try {
    await sendAuditEvent({
      user: event.requestContext?.authorizer?.claims?.sub || 'system',
      username: event.requestContext?.authorizer?.claims?.['cognito:username']
        || event.requestContext?.authorizer?.username || 'system',
      action: AUDIT_ACTIONS.UPDATE_DATASTORE,
      resourceType: RESOURCE_TYPES.DATASTORE,
      resourceId: datastoreId,
      resourceName: datastore.name,
      newValues: { sync: { mode, prefixes: invoked } },
      apiEndpoint: event.path,
      httpMethod: event.httpMethod,
      status: 'SUCCESS'
    });
  } catch (e) {
    // Audit is best-effort; never fail the sync trigger on an audit error.
    console.error('sync audit event failed:', e.message);
  }

  return {
    statusCode: 202,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        datastoreId,
        bucketName: datastore.s3_bucket_name,
        mode,
        prefixes: invoked,
        message: `Sync started (${mode}) for ${invoked.length} prefix(es). Track progress in Imports.`
      }
    })
  };
}

// Raw storage-content listing: physical objects (storage_index) for one datastore,
// DICOM and NON_DICOM alike. Powers the UI's storage-content view and manual
// association. Paginated; excludes soft-deleted rows by default.
async function getStorageContent(event) {
  const datastoreId = event.pathParameters?.id;
  if (!datastoreId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Datastore ID is required' } })
    };
  }

  const qp = event.queryStringParameters || {};
  const pageSize = Math.min(parseInt(qp.pageSize, 10) || 50, 500);
  const page = Math.max(parseInt(qp.page, 10) || 1, 1);
  const offset = (page - 1) * pageSize;

  // F21: require an exact read grant on THIS datastore before exposing its
  // physical object inventory (S3 keys, UIDs, transfer syntax). 404 on miss.
  if (!canReadDatastore(event, datastoreId)) {
    return notFound();
  }

  // Optional filter by content kind ('DICOM' | 'NON_DICOM').
  const kind = (qp.contentKind || '').toUpperCase();
  const kindClause = (kind === 'DICOM' || kind === 'NON_DICOM') ? ' AND content_kind = ?' : '';
  const kindParam = kindClause ? [kind] : [];

  const [{ total }] = await query(
    `SELECT COUNT(*) as total FROM storage_index WHERE datastore_id = ? AND deleted_at IS NULL${kindClause}`,
    [datastoreId, ...kindParam]);

  const items = await query(
    `SELECT content_pkey, content_kind, non_dicom_type, s3_bucket_name, s3_key,
            s3_key_version, study_instance_uid, series_instance_uid, sop_instance_uid,
            transfer_syntax, size_bytes, created_at
     FROM storage_index
     WHERE datastore_id = ? AND deleted_at IS NULL${kindClause}
     ORDER BY created_at DESC, content_pkey DESC
     LIMIT ? OFFSET ?`,
    [datastoreId, ...kindParam, pageSize, offset]);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: { items, total: total || 0, page, pageSize }
    })
  };
}

exports.handler = async (event) => {
  console.log('Datastore API:', event.httpMethod, event.path);

  try {
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const path = event.path || event.requestContext?.http?.path;
    const pathParameters = event.pathParameters;

    if (path?.includes('/statistics')) {
      return await getStatistics(event);
    }

    // Sync/re-index: POST /datastores/{id}/sync — fan out one async backfill
    // invocation per prefix to re-enqueue the datastore's objects for ingest.
    if (httpMethod === 'POST' && path?.endsWith('/sync') && pathParameters?.id) {
      return await syncDatastore(event);
    }

    // Raw storage-content listing: every physical object indexed for this
    // datastore (storage_index), DICOM and NON_DICOM alike, for the UI's
    // storage-content view and manual association.
    if (path?.includes('/content') && pathParameters?.id) {
      return await getStorageContent(event);
    }

    if (httpMethod === 'GET' && !pathParameters?.id) {
      return await listDatastores(event);
    } else if (httpMethod === 'GET' && pathParameters?.id) {
      return await getDatastore(event);
    } else if (httpMethod === 'POST') {
      return await createDatastore(event);
    } else if (httpMethod === 'PUT') {
      return await updateDatastore(event);
    } else if (httpMethod === 'DELETE') {
      return await deleteDatastore(event);
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
