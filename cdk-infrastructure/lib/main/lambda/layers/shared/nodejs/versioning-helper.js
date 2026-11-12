// RDS Proxy migration (P1): versioning-helper now uses the shared mysql2 database
// layer (RDS Proxy), not the RDS Data API. Exported contract unchanged.
const { query, execute } = require('./database');

const VERSIONED_TABLES = new Set([
  'dicom_privileges', 'virtual_folders', 'users', 'privilege_groups',
  'dicom_interfaces', 'routing_rules', 'analytics_projects',
  'processing_jobs', 'locations', 'datastores', 'dicom_entities',
]);

function validateTableName(table) {
  if (!VERSIONED_TABLES.has(table)) throw new Error(`Invalid table name: ${table}`);
}

function validateColumnName(col) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) throw new Error(`Invalid column name: ${col}`);
}

/**
 * Save current version and update record with versioning.
 * queryFn is the caller's query function (positional `?` params) — unchanged.
 */
async function saveVersionAndUpdate(tableName, id, currentRecord, updateData, username, queryFn) {
  validateTableName(tableName);
  const previousVersions = currentRecord.previous_versions
    ? (typeof currentRecord.previous_versions === 'string'
        ? JSON.parse(currentRecord.previous_versions)
        : currentRecord.previous_versions)
    : [];

  // Add current state to previous versions (exclude updated_at, previous_versions, current_version)
  const { updated_at, previous_versions: _, current_version: __, ...recordData } = currentRecord;
  const currentVersion = {
    version: currentRecord.current_version,
    data: recordData,
    updated_at: new Date().toISOString()
  };
  previousVersions.push(currentVersion);

  const versionedUpdateData = {
    ...updateData,
    current_version: (currentRecord.current_version || 1) + 1,
    previous_versions: JSON.stringify(previousVersions)
  };

  const keys = Object.keys(versionedUpdateData);
  keys.forEach(validateColumnName);
  const setClause = keys.map(key => `${key} = ?`).join(', ') + ', updated_at = NOW()';
  const values = Object.values(versionedUpdateData);
  values.push(id);

  const sql = `UPDATE ${tableName} SET ${setClause} WHERE id = ?`;
  await queryFn(sql, values);

  return versionedUpdateData;
}

/**
 * Soft delete a record. Returns true if a row was updated.
 */
async function softDelete(tableName, id, deletedBy = 'system') {
  validateTableName(tableName);
  const sql = `
    UPDATE ${tableName}
    SET deleted = true, deleted_at = NOW(), deleted_by = ?, updated_at = NOW()
    WHERE id = ? AND deleted = false
  `;
  const result = await execute(sql, [deletedBy, id]);
  return (result?.affectedRows || 0) > 0;
}

/**
 * Execute SQL with positional params (returns row array via shared query()).
 */
async function executeSQL(sql, parameters = []) {
  return await query(sql, parameters);
}

module.exports = {
  saveVersionAndUpdate,
  softDelete,
  executeSQL
};
