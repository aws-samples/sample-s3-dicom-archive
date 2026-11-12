// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. executeSQL keeps
// its old signature — named `:param` placeholders + a Data-API-shaped result — so
// every downstream `record[i][j].stringValue/longValue/doubleValue` read below is
// left unchanged. It translates named params to positional `?` and wraps mysql2's
// plain row objects back into the Data-API `{ records, numberOfRecordsUpdated }`
// shape (each cell object exposes the value under every *Value accessor).
const { query, execute } = require('/opt/nodejs/database');

function _wrapCell(v) {
  if (v === null || v === undefined) {
    return { isNull: true, stringValue: null, longValue: null, doubleValue: null, booleanValue: null };
  }
  return { stringValue: v, longValue: v, doubleValue: v, booleanValue: v };
}

// Convert named `:param` placeholders to positional `?`, in first-seen order with
// repeats expanded, using the Data-API `[{ name, value: { stringValue|longValue|
// doubleValue|booleanValue|isNull } }]` parameter array.
function _toPositional(sql, parameters) {
  const byName = {};
  for (const p of (parameters || [])) {
    const val = p.value || {};
    byName[p.name] = ('isNull' in val && val.isNull) ? null
      : ('stringValue' in val) ? val.stringValue
      : ('longValue' in val) ? val.longValue
      : ('doubleValue' in val) ? val.doubleValue
      : ('booleanValue' in val) ? val.booleanValue
      : null;
  }
  const args = [];
  const outSql = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name) => {
    if (!(name in byName)) return m; // leave `::cast` / unknown tokens alone
    args.push(byName[name]);
    return '?';
  });
  return { outSql, args };
}

async function executeSQL(sql, parameters = []) {
  const { outSql, args } = _toPositional(sql, parameters);
  const result = await execute(outSql, args);
  if (Array.isArray(result)) {
    return { records: result.map(row => Object.values(row).map(_wrapCell)) };
  }
  return { records: [], numberOfRecordsUpdated: result?.affectedRows || 0 };
}

/**
 * Resolve the datastore IDs the caller may READ, unioned across all their
 * privilege groups. Returns { wildcard: true } for an admin ('*' canRead), else
 * { ids: [...] } (possibly empty). Every dashboard query MUST scope to this so a
 * caller with the statistics management privilege but access to only a subset of
 * datastores cannot see aggregate size/growth/utilization spanning datastores
 * they cannot read (cross-datastore info leak). `statistics.canList` gates the
 * ROUTE; this gates the DATA.
 */
async function resolveReadableDatastores(userId) {
  if (!userId) return { ids: [] };
  const privResult = await executeSQL(
    `SELECT pg.datastore_privileges
       FROM users u
       JOIN user_privilege_groups upg ON upg.user_id = u.id
       JOIN privilege_groups pg ON upg.privilege_group_id = pg.id
      WHERE u.id = :userId AND pg.deleted = FALSE`,
    [{ name: 'userId', value: { stringValue: userId } }]
  );
  const privileges = (privResult.records || []).flatMap(rec => {
    try { return JSON.parse(rec[0]?.stringValue || '[]'); } catch { return []; }
  });
  if (privileges.some(p => p.datastoreId === '*' && p.canRead)) return { wildcard: true };
  return { ids: privileges.filter(p => p.canRead).map(p => p.datastoreId) };
}

async function getDashboardStats(userId) {
  // Scope to the caller's readable datastores (see resolveReadableDatastores).
  const allowed = await resolveReadableDatastores(userId);
  let scope = '';
  let params = [];
  if (!allowed.wildcard) {
    if (!allowed.ids || allowed.ids.length === 0) return [];
    const ph = allowed.ids.map((_, i) => `:ds${i}`).join(',');
    scope = ` AND d.id IN (${ph})`;
    params = allowed.ids.map((id, i) => ({ name: `ds${i}`, value: { stringValue: id } }));
  }
  const sql = `
    SELECT 
      d.id,
      d.name,
      d.status,
      ds.study_count,
      ds.series_count,
      ds.instance_count,
      ds.total_size_bytes,
      ds.modality_breakdown,
      ds.last_updated
    FROM datastores d
    LEFT JOIN (
      SELECT s1.datastore_id, s1.instance_count, s1.total_size_bytes, s1.study_count, s1.series_count, s1.modality_breakdown, s1.last_updated
      FROM datastore_statistics s1
      JOIN (SELECT datastore_id, MAX(last_updated) AS mx FROM datastore_statistics WHERE latest = TRUE GROUP BY datastore_id) s2
        ON s1.datastore_id = s2.datastore_id AND s1.last_updated = s2.mx
      WHERE s1.latest = TRUE GROUP BY s1.datastore_id
    ) ds ON d.id = ds.datastore_id
    WHERE d.deleted = FALSE${scope}
    ORDER BY d.name
  `;
  
  const result = await executeSQL(sql, params);
  
  return result.records.map(row => ({
    datastoreId: row[0].stringValue,
    datastoreName: row[1].stringValue,
    status: row[2].stringValue,
    studyCount: parseInt(row[3]?.longValue || 0),
    seriesCount: parseInt(row[4]?.longValue || 0),
    instanceCount: parseInt(row[5]?.longValue || 0),
    totalSizeBytes: parseInt(row[6]?.longValue || 0),
    modalityBreakdown: row[7]?.stringValue ? JSON.parse(row[7].stringValue) : {},
    lastUpdated: row[8]?.stringValue
  }));
}

async function getModalityData(datastoreId, userId) {
  // Get user's datastore privileges across ALL groups they belong to
  // (user_privilege_groups is a many-to-many join). One row per group.
  const privSql = `
    SELECT pg.datastore_privileges
    FROM users u
    JOIN user_privilege_groups upg ON upg.user_id = u.id
    JOIN privilege_groups pg ON upg.privilege_group_id = pg.id
    WHERE u.id = :userId AND pg.deleted = FALSE
  `;
  
  const privResult = await executeSQL(privSql, [
    { name: 'userId', value: { stringValue: userId } }
  ]);
  
  if (!privResult.records || privResult.records.length === 0) {
    return [];
  }
  
  // Union the datastore privileges from every group the user belongs to.
  const privileges = privResult.records.flatMap(rec => {
    try { return JSON.parse(rec[0]?.stringValue || '[]'); } catch { return []; }
  });
  const hasWildcard = privileges.some(p => p.datastoreId === '*' && p.canRead); // nosec - intentional wildcard for admin "All Datastores" privilege
  
  // Build list of allowed datastore IDs
  let allowedDatastoreIds = [];
  if (hasWildcard) {
    const allDsSql = 'SELECT id FROM datastores WHERE status = "ACTIVE" AND deleted = FALSE';
    const allDsResult = await executeSQL(allDsSql);
    allowedDatastoreIds = allDsResult.records.map(r => r[0].stringValue);
  } else {
    allowedDatastoreIds = privileges
      .filter(p => p.canRead)
      .map(p => p.datastoreId);
  }
  
  if (allowedDatastoreIds.length === 0) {
    return [];
  }
  
  // Filter by specific datastore if requested
  const targetDatastores = datastoreId 
    ? [datastoreId].filter(id => allowedDatastoreIds.includes(id))
    : allowedDatastoreIds;
  
  if (targetDatastores.length === 0) {
    return [];
  }
  
  const placeholders = targetDatastores.map((_, i) => `:ds${i}`).join(',');
  const params = targetDatastores.map((id, i) => ({
    name: `ds${i}`,
    value: { stringValue: id }
  }));
  
  const sql = `
    SELECT 
      ds.datastore_id,
      d.name as datastore_name,
      ds.modality_breakdown
    FROM datastore_statistics ds
    JOIN datastores d ON ds.datastore_id = d.id
    WHERE ds.datastore_id IN (${placeholders})
    AND (ds.datastore_id, ds.last_updated) IN (
      SELECT datastore_id, MAX(last_updated)
      FROM datastore_statistics
      WHERE datastore_id IN (${placeholders})
      GROUP BY datastore_id
    )
  `;
  
  const result = await executeSQL(sql, params);
  
  return result.records.map(record => ({
    datastoreId: record[0].stringValue,
    datastoreName: record[1].stringValue,
    modalityBreakdown: record[2].stringValue ? JSON.parse(record[2].stringValue) : {}
  }));
}

async function getStorageGrowthData(params, userId) {
  const { datastoreIds, startDate, endDate } = params;

  // Scope to the caller's readable datastores. A requested datastoreIds list is
  // INTERSECTED with the readable set (a caller cannot widen their view by
  // naming datastores they cannot read); with no list, default to the readable
  // set. Admin ('*' canRead) keeps the unrestricted view.
  const allowed = await resolveReadableDatastores(userId);
  const requested = datastoreIds ? datastoreIds.split(',').filter(Boolean) : null;
  let effectiveIds = null; // null => no datastore filter (admin, all)
  if (!allowed.wildcard) {
    const readable = new Set(allowed.ids || []);
    effectiveIds = (requested ? requested.filter(id => readable.has(id)) : [...readable]);
    if (effectiveIds.length === 0) return [];
  } else if (requested) {
    effectiveIds = requested; // admin narrowing to a requested subset
  }

  const sqlParams = [];
  let datastoreFilter = '';
  if (effectiveIds) {
    const ids = effectiveIds;
    datastoreFilter = ` AND ds.datastore_id IN (${ids.map((_, i) => `:id${i}`).join(',')})`;
    ids.forEach((id, i) => sqlParams.push({ name: `id${i}`, value: { stringValue: id } }));
  }

  const selectCols = `
      d.id as datastoreId,
      d.name as datastoreName,
      ds.last_updated as timestamp,
      ds.total_size_bytes / (1024 * 1024 * 1024) as sizeGB`;

  // Daily downsample via a GROUP BY derived table (one pass, index-backed):
  // pick the latest snapshot timestamp per (datastore_id, calendar day), then
  // join back to the row for its size. This collapses 100k+ snapshots to ~one
  // row per datastore per day (measured 2s vs a 30s+ timeout for the naive
  // per-row correlated MAX(DATE()) form).
  let dayFilter = `WHERE latest = FALSE${datastoreFilter.replace(/ds\.datastore_id/g, 'datastore_id')}`;
  if (startDate) dayFilter += ' AND last_updated >= :startDate';
  if (endDate) dayFilter += ' AND last_updated <= :endDate';
  if (startDate) sqlParams.push({ name: 'startDate', value: { stringValue: startDate } });
  if (endDate) sqlParams.push({ name: 'endDate', value: { stringValue: endDate } });

  let sql = `
    SELECT ${selectCols}
    FROM datastore_statistics ds
    JOIN (
      SELECT datastore_id, MAX(last_updated) AS mx
      FROM datastore_statistics
      ${dayFilter}
      GROUP BY datastore_id, DATE(last_updated)
    ) g ON ds.datastore_id = g.datastore_id AND ds.last_updated = g.mx
    JOIN datastores d ON ds.datastore_id = d.id
    WHERE d.deleted = FALSE`;

  // Baseline: the most recent snapshot for each datastore strictly BEFORE the
  // window start, so the frontend can carry the value forward from the start of
  // the selected period (one row per datastore, not the whole history).
  if (startDate) {
    sql += `
    UNION ALL
    SELECT ${selectCols}
    FROM datastore_statistics ds
    JOIN datastores d ON ds.datastore_id = d.id
    WHERE ds.latest = FALSE AND d.deleted = FALSE${datastoreFilter}
      AND ds.last_updated < :startDate
      AND ds.last_updated = (
        SELECT MAX(s2.last_updated)
        FROM datastore_statistics s2
        WHERE s2.datastore_id = ds.datastore_id
          AND s2.latest = FALSE
          AND s2.last_updated < :startDate
      )`;
    sqlParams.push({ name: 'startDate', value: { stringValue: startDate } });
  }

  sql += `
    ORDER BY timestamp, datastoreName`;

  const result = await executeSQL(sql, sqlParams);

  return result.records.map(record => ({
    datastoreId: record[0].stringValue,
    datastoreName: record[1].stringValue,
    timestamp: record[2].stringValue,
    sizeGB: parseFloat(record[3].stringValue || record[3].doubleValue || 0)
  }));
}

async function getDatastoreUtilization(userId) {
  // Scope to the caller's readable datastores (see resolveReadableDatastores).
  const allowed = await resolveReadableDatastores(userId);
  let scope = '';
  const params = [];
  if (!allowed.wildcard) {
    if (!allowed.ids || allowed.ids.length === 0) return [];
    const ph = allowed.ids.map((_, i) => `:du${i}`).join(',');
    scope = ` AND d.id IN (${ph})`;
    allowed.ids.forEach((id, i) => params.push({ name: `du${i}`, value: { stringValue: id } }));
  }
  const sql = `
    SELECT 
      d.name,
      d.id,
      COALESCE(ds.series_count, 0) as series,
      COALESCE(ds.total_size_bytes, 0) as totalBytes,
      COALESCE(ds.total_size_bytes * 100.0 / NULLIF((SELECT SUM(total_size_bytes) FROM datastore_statistics ds2 WHERE (ds2.datastore_id, ds2.last_updated) IN (SELECT datastore_id, MAX(last_updated) FROM datastore_statistics GROUP BY datastore_id)), 0), 0) as used
    FROM datastores d
    LEFT JOIN (
      SELECT datastore_id, series_count, total_size_bytes
      FROM datastore_statistics ds1
      WHERE (datastore_id, last_updated) IN (
        SELECT datastore_id, MAX(last_updated)
        FROM datastore_statistics
        GROUP BY datastore_id
      )
    ) ds ON d.id = ds.datastore_id
    WHERE d.status = 'ACTIVE'${scope}
    ORDER BY used DESC
  `;
  
  const result = await executeSQL(sql, params);
  
  return result.records.map(record => ({
    name: record[0].stringValue,
    id: record[1].stringValue,
    series: parseInt(record[2].longValue || 0),
    totalBytes: parseInt(record[3].longValue || 0),
    used: Math.min(100, Math.round(parseFloat(record[4].doubleValue || 0)))
  }));
}

exports.handler = async (event) => {
  console.log('Dashboard API:', event.httpMethod, event.path);
  
  try {
    // Use the actual request path; under the {proxy+} integration event.resource
    // is the route template ('/api/dashboard/{proxy+}'), not the concrete path.
    const path = event.path;
    const method = event.httpMethod;
    const userId = event.requestContext?.authorizer?.userId;
    
    let response;
    
    if (path === '/api/dashboard/stats' && method === 'GET') {
      response = await getDashboardStats(userId);
    } else if (path === '/api/dashboard/modality' && method === 'GET') {
      const datastoreId = event.queryStringParameters?.datastoreId;
      response = await getModalityData(datastoreId, userId);
    } else if (path === '/api/dashboard/storage-growth' && method === 'GET') {
      response = await getStorageGrowthData(event.queryStringParameters || {}, userId);
    } else if (path === '/api/dashboard/utilization' && method === 'GET') {
      response = await getDatastoreUtilization(userId);
    } else {
      return {
        statusCode: 404,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
          'Access-Control-Allow-Methods': 'GET,OPTIONS'
        },
        body: JSON.stringify({ message: 'Not found' })
      };
    }
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
      },
      body: JSON.stringify({
        success: true,
        data: response
      })
    };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Methods': 'GET,OPTIONS'
      },
      body: JSON.stringify({ message: 'Internal server error' })
    };
  }
};
