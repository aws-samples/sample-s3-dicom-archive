// RDS Proxy migration (P3d): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. executeSQL keeps
// its Data-API-shaped result ({ records }) so the downstream record[i].stringValue/
// longValue reads are unchanged; parameters keep the [{ name, value:{...} }] shape.
// Named `:param` placeholders are translated to positional `?`. The shared layer
// reads DB_HOST(proxy)/DB_SECRET_ARN/DB_NAME from the environment; DB_CLUSTER_ARN
// is no longer used.
const { query } = require('/opt/nodejs/database');

function _wrapCell(v) {
  if (v === null || v === undefined) {
    return { isNull: true, stringValue: null, longValue: null, doubleValue: null, booleanValue: null };
  }
  return { stringValue: v, longValue: v, doubleValue: v, booleanValue: v };
}

async function executeSQL(sql, parameters = []) {
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
    if (!(name in byName)) return m;
    args.push(byName[name]);
    return '?';
  });
  const rows = await query(outSql, args);
  return { records: (rows || []).map(row => Object.values(row).map(_wrapCell)) };
}

exports.handler = async (event) => {
  console.log('Starting hourly statistics snapshot...');
  
  // Get current hour rounded timestamp
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const hourTimestamp = now.toISOString().slice(0, 19).replace('T', ' ');
  
  console.log(`Creating snapshots for hour: ${hourTimestamp}`);
  
  // Get all latest statistics
  const selectSql = `
    SELECT datastore_id, study_count, series_count, instance_count,
           total_size_bytes, modality_breakdown
    FROM datastore_statistics
    WHERE latest = TRUE
  `;
  
  const result = await executeSQL(selectSql);
  
  if (!result.records || result.records.length === 0) {
    console.log('No statistics to snapshot');
    return { statusCode: 200, body: 'No statistics to snapshot' };
  }
  
  console.log(`Found ${result.records.length} datastores to snapshot`);
  
  // Create snapshot for each datastore
  for (const record of result.records) {
    const datastoreId = record[0].stringValue;
    const studyCount = parseInt(record[1]?.longValue || 0);
    const seriesCount = parseInt(record[2]?.longValue || 0);
    const instanceCount = parseInt(record[3]?.longValue || 0);
    const totalSizeBytes = parseInt(record[4]?.longValue || 0);
    const modalityBreakdown = record[5]?.stringValue || '{}';
    
    const insertSql = `
      INSERT INTO datastore_statistics (
        id, datastore_id, study_count, series_count, instance_count,
        total_size_bytes, modality_breakdown, latest, last_updated
      ) VALUES (
        UUID(), :datastoreId, :studyCount, :seriesCount, :instanceCount,
        :totalSizeBytes, :modalityBreakdown, FALSE, :timestamp
      )
    `;
    
    await executeSQL(insertSql, [
      { name: 'datastoreId', value: { stringValue: datastoreId } },
      { name: 'studyCount', value: { longValue: studyCount } },
      { name: 'seriesCount', value: { longValue: seriesCount } },
      { name: 'instanceCount', value: { longValue: instanceCount } },
      { name: 'totalSizeBytes', value: { longValue: totalSizeBytes } },
      { name: 'modalityBreakdown', value: { stringValue: modalityBreakdown } },
      { name: 'timestamp', value: { stringValue: hourTimestamp } }
    ]);
    
    console.log(`Created snapshot for datastore: ${datastoreId}`);
  }
  
  console.log(`Successfully created ${result.records.length} snapshots`);
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: 'Statistics snapshots created',
      count: result.records.length,
      timestamp: hourTimestamp
    })
  };
};
