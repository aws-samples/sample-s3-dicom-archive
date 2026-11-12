const { query } = require('/opt/nodejs/database');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');

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

function generateChanges(oldValues, newValues) {
  if (!oldValues && !newValues) return null;
  
  const changes = [];
  
  // For creation, show all new values
  if (!oldValues && newValues) {
    Object.keys(newValues).forEach(key => {
      if (newValues[key] !== null && newValues[key] !== undefined) {
        changes.push({
          field: key,
          action: 'added',
          oldValue: null,
          newValue: newValues[key]
        });
      }
    });
    return changes;
  }
  
  // For updates, compare old and new values
  if (oldValues && newValues) {
    const allKeys = new Set([...Object.keys(oldValues), ...Object.keys(newValues)]);
    
    allKeys.forEach(key => {
      const oldVal = oldValues[key];
      const newVal = newValues[key];
      
      if (oldVal !== newVal) {
        changes.push({
          field: key,
          action: 'changed',
          oldValue: oldVal,
          newValue: newVal
        });
      }
    });
    return changes;
  }
  
  // For deletion, show all removed values
  if (oldValues && !newValues) {
    Object.keys(oldValues).forEach(key => {
      if (oldValues[key] !== null && oldValues[key] !== undefined) {
        changes.push({
          field: key,
          action: 'removed',
          oldValue: oldValues[key],
          newValue: null
        });
      }
    });
    return changes;
  }
  
  return null;
}

function generateDescription(action, resourceType, resourceName, oldValues, newValues) {
  const name = resourceName || 'unknown';
  
  switch (action) {
    case 'CREATE_USER':
      return `User "${name}" created`;
    case 'UPDATE_USER':
      return `User "${name}" updated`;
    case 'DELETE_USER':
      return `User "${name}" deleted`;
    case 'CREATE_DATASTORE':
      return `Storage "${name}" created`;
    case 'UPDATE_DATASTORE':
      return `Storage "${name}" updated`;
    case 'DELETE_DATASTORE':
      return `Storage "${name}" deleted`;
    case 'CREATE_INTERFACE':
      return `DICOM Interface "${name}" created`;
    case 'UPDATE_INTERFACE':
      return `DICOM Interface "${name}" updated`;
    case 'DELETE_INTERFACE':
      return `DICOM Interface "${name}" deleted`;
    case 'CREATE_ENTITY':
      return `DICOM Entity "${name}" created`;
    case 'UPDATE_ENTITY':
      return `DICOM Entity "${name}" updated`;
    case 'DELETE_ENTITY':
      return `DICOM Entity "${name}" deleted`;
    case 'CREATE_PRIVILEGE_GROUP':
      return `Privilege Group "${name}" created`;
    case 'UPDATE_PRIVILEGE_GROUP':
      return `Privilege Group "${name}" updated`;
    case 'DELETE_PRIVILEGE_GROUP':
      return `Privilege Group "${name}" deleted`;
    case 'CREATE_LOCATION':
      return `Location "${name}" created`;
    case 'UPDATE_LOCATION':
      return `Location "${name}" updated`;
    case 'DELETE_LOCATION':
      return `Location "${name}" deleted`;
    case 'DELETE_SERIES_REQUESTED':
      return `Series deletion requested: "${name}"`;
    case 'DELETE_SERIES':
      return `Series deleted: "${name}"`;
    case 'DELETE_SERIES_FAILED':
      return `Series deletion failed: "${name}"`;
    default:
      return `${action.replace(/_/g, ' ').toLowerCase()} on ${resourceType}`;
  }
}

function parseMaybeJson(value) {
  // mysql2 auto-parses JSON columns into JS objects; the legacy Data API layer
  // returned them as strings. Handle both, and never throw on malformed data.
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function mapAuditEntry(entry) {
  const camel = toCamelCase(entry);
  const oldValues = parseMaybeJson(camel.oldValues);
  const newValues = parseMaybeJson(camel.newValues);
  
  // Sanitize location values
  const sanitizedOldValues = camel.resourceType === 'LOCATION' ? sanitizeLocationValues(oldValues) : oldValues;
  const sanitizedNewValues = camel.resourceType === 'LOCATION' ? sanitizeLocationValues(newValues) : newValues;
  
  return {
    id: camel.id,
    user: camel.username || camel.userId || 'unknown',
    action: camel.action,
    description: generateDescription(camel.action, camel.resourceType, camel.resourceName, sanitizedOldValues, sanitizedNewValues),
    timestamp: camel.timestamp,
    resourceId: camel.resourceId,
    resourceType: camel.resourceType,
    resourceName: camel.resourceName,
    // Tenancy dimension, promoted for display/column use. Prefer the explicit
    // new_values.datastoreId (data-plane events); fall back to resource_id when
    // the row IS a datastore (management events). It is a datastore id (non-PHI).
    datastoreId: (sanitizedNewValues && sanitizedNewValues.datastoreId)
      || (camel.resourceType === 'datastore' ? camel.resourceId : null)
      || null,
    ipAddress: camel.userIp,
    requestId: camel.requestId,
    status: camel.status,
    errorMessage: camel.errorMessage,
    oldValues: sanitizedOldValues,
    newValues: sanitizedNewValues,
    changes: generateChanges(sanitizedOldValues, sanitizedNewValues)
  };
}

function sanitizeLocationValues(values) {
  if (!values) return null;
  
  const sanitized = { ...values };
  const sensitiveFields = [
    'certificate_data', 'certificateData',
    's3_bucket_name', 's3BucketName',
    's3_bucket_arn', 's3BucketArn',
    'trust_anchor_arn', 'trustAnchorArn',
    'dicom_role_arn', 'dicomRoleArn',
    'hl7_role_arn', 'hl7RoleArn',
    'dicom_profile_arn', 'dicomProfileArn',
    'hl7_profile_arn', 'hl7ProfileArn'
  ];
  
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[value hidden]';
    }
  });
  
  return sanitized;
}

async function listAuditLogs(event) {
  const queryParams = event.queryStringParameters || {};
  // Bound pageSize so a caller cannot request an unbounded scan of a PHI-
  // adjacent table (DoS / data-exfil guard). Default 100, hard cap 500.
  const rawPageSize = parseInt(queryParams.pageSize);
  const limit = Math.min(Math.max(Number.isFinite(rawPageSize) ? rawPageSize : 100, 1), 500);
  const rawPage = parseInt(queryParams.page);
  const page = Math.max(Number.isFinite(rawPage) ? rawPage : 1, 1);
  const offset = (page - 1) * limit;

  // Build the WHERE clause + bound params ONCE and reuse it for both the page
  // query and the COUNT query. Keeping a single source of truth is what prevents
  // the list/count divergence class of bug (e.g. multi-value resourceType that
  // the count query used to mis-handle), and every value is a bound `?` — no
  // user input is ever concatenated into SQL.
  const { whereSql, whereParams } = buildAuditWhere(queryParams);

  const sql = `SELECT * FROM audit_logs ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  const logs = await query(sql, [...whereParams, limit, offset]);

  const countSql = `SELECT COUNT(*) as total FROM audit_logs ${whereSql}`;
  const [countResult] = await query(countSql, whereParams);
  const totalCount = countResult?.total || countResult?.column_0 || 0;
  const totalPages = Math.ceil(totalCount / limit);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        items: logs.map(mapAuditEntry),
        totalCount,
        pageSize: limit,
        currentPage: page,
        totalPages
      }
    })
  };
}

// Whitelisted action-prefix groups. A caller passes a GROUP KEY, never a raw
// LIKE pattern, so no `%`/`_` wildcard can be injected and the match is bounded
// to a known, index-friendly prefix. Anything not in this map is ignored.
const ACTION_PREFIX_GROUPS = {
  retrieve: 'RETRIEVE\\_%',   // RETRIEVE_METADATA / _INSTANCE / _FRAMES / ...
  create: 'CREATE\\_%',
  delete_: 'DELETE\\_%',
  update: 'UPDATE\\_%',
  query: 'QUERY\\_%'
};

/**
 * Build a parameterized WHERE clause from the audit query params. Every value is
 * pushed as a bound parameter; the only string interpolation is of fixed `?`
 * placeholders and constant SQL fragments. Returns {whereSql, whereParams}.
 */
function buildAuditWhere(queryParams) {
  const conditions = ['1=1'];
  const params = [];

  const user = queryParams.user;
  const action = queryParams.action;
  const actionPrefix = queryParams.actionPrefix;
  const resourceType = queryParams.resourceType;
  const datastoreId = queryParams.datastoreId;
  const status = queryParams.status;
  const search = queryParams.search;
  const timestampFrom = queryParams.timestampFrom;
  const timestampTo = queryParams.timestampTo;

  if (user) {
    conditions.push('username = ?');
    params.push(user);
  }
  // Exact action list (comma-separated) OR a whitelisted prefix group — not both.
  if (action) {
    const actions = String(action).split(',').map(a => a.trim()).filter(Boolean);
    if (actions.length === 1) {
      conditions.push('action = ?');
      params.push(actions[0]);
    } else if (actions.length > 1) {
      conditions.push(`action IN (${actions.map(() => '?').join(',')})`);
      params.push(...actions);
    }
  } else if (actionPrefix && ACTION_PREFIX_GROUPS[actionPrefix]) {
    // ESCAPE '\\' so the group pattern's literal underscore is not a wildcard.
    conditions.push("action LIKE ? ESCAPE '\\\\'");
    params.push(ACTION_PREFIX_GROUPS[actionPrefix]);
  }
  if (resourceType) {
    const types = String(resourceType).split(',').map(t => t.trim()).filter(Boolean);
    if (types.length > 0) {
      conditions.push(`resource_type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }
  // Tenancy filter: a datastore id appears either in resource_id (management
  // events, resource_type='datastore') or in new_values.datastoreId (data-plane
  // events). Match EITHER so the filter is consistent with the facets dropdown.
  // JSON path + column names are constants; the compared value is bound.
  if (datastoreId) {
    conditions.push("((resource_type = 'datastore' AND resource_id = ?) OR JSON_UNQUOTE(JSON_EXTRACT(new_values, '$.datastoreId')) = ?)");
    params.push(datastoreId, datastoreId);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (search) {
    // Escape LIKE metacharacters in user-supplied search so '%'/'_' are literal.
    const safe = String(search).replace(/[\\%_]/g, ch => '\\' + ch);
    conditions.push("(action LIKE ? ESCAPE '\\\\' OR resource_type LIKE ? ESCAPE '\\\\' OR username LIKE ? ESCAPE '\\\\')");
    const term = `%${safe}%`;
    params.push(term, term, term);
  }
  if (timestampFrom) {
    conditions.push('timestamp >= ?');
    params.push(timestampFrom + ' 00:00:00');
  }
  if (timestampTo) {
    conditions.push('timestamp <= ?');
    params.push(timestampTo + ' 23:59:59');
  }

  return { whereSql: 'WHERE ' + conditions.join(' AND '), whereParams: params };
}

/**
 * GET /audit/facets — distinct, NON-PHI filter values actually present in the
 * trail, so the UI dropdowns are data-driven and never go stale. Returns ONLY
 * safe identifier columns (action, resource_type, datastoreId); never
 * resource_name or new_values content, which can carry patient context.
 */
async function getAuditFacets() {
  const [actions, resourceTypes, datastores] = await Promise.all([
    query('SELECT DISTINCT action FROM audit_logs WHERE action IS NOT NULL ORDER BY action'),
    query('SELECT DISTINCT resource_type FROM audit_logs WHERE resource_type IS NOT NULL ORDER BY resource_type'),
    // Resolve datastore ids referenced anywhere in the trail to their NAME.
    // The id appears in TWO places depending on the event family:
    //   - management events (CREATE/DELETE_DATASTORE, ...): resource_id, with
    //     resource_type = 'datastore'
    //   - data-plane events (QUERY_STUDIES, RETRIEVE_METADATA, ...):
    //     new_values.datastoreId
    // We UNION both, then INNER JOIN live datastores so deleted/gone ones are
    // excluded (the dropdown offers only live, named datastores). Audit ROWS for
    // deleted datastores are untouched; this governs only the convenience list.
    query(`
      SELECT d.id, d.name
      FROM (
        SELECT DISTINCT resource_id AS id
        FROM audit_logs
        WHERE resource_type = 'datastore' AND resource_id IS NOT NULL
        UNION
        SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(new_values, '$.datastoreId')) AS id
        FROM audit_logs
        WHERE JSON_EXTRACT(new_values, '$.datastoreId') IS NOT NULL
      ) ids
      JOIN datastores d ON d.id = ids.id AND d.deleted = false
      ORDER BY d.name
      LIMIT 500
    `)
  ]);
  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        actions: actions.map(r => r.action).filter(Boolean),
        resourceTypes: resourceTypes.map(r => r.resource_type).filter(Boolean),
        // datastores: [{id, name}] — LIVE datastores only, name for display.
        datastores: datastores
          .filter(r => r.id && r.name)
          .map(r => ({ id: r.id, name: r.name })),
        // Back-compat: flat id list (older bundles read datastoreIds).
        datastoreIds: datastores.map(r => r.id).filter(Boolean)
      }
    })
  };
}

async function getAuditLog(event) {
  const logId = event.pathParameters?.id;

  if (!logId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Log ID is required' }
      })
    };
  }

  const [log] = await query('SELECT * FROM audit_logs WHERE id = ?', [logId]);

  if (!log) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Audit log not found' }
      })
    };
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: mapAuditEntry(log) })
  };
}

exports.handler = async (event) => {
  console.log('Audit API:', event.httpMethod, event.path);

  try {
    event.pathParameters = normalizePathParameters(event);
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters;

    if (httpMethod === 'GET' && pathParameters?.id === 'facets') {
      // /audit/facets — distinct filter values. Reserved literal segment; it can
      // never collide with a real log id, and it is gated by the SAME
      // auditTrail.canList privilege as /audit (authorizer grants */api/audit/*).
      return await getAuditFacets();
    } else if (httpMethod === 'GET' && !pathParameters?.id) {
      return await listAuditLogs(event);
    } else if (httpMethod === 'GET' && pathParameters?.id) {
      return await getAuditLog(event);
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
