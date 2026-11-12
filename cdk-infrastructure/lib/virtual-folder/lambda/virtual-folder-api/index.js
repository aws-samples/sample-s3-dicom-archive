const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { isWritableAccessLevel } = require('/opt/nodejs/writable-destination');
const { randomUUID, createHash } = require('crypto');
const { provisionVfDatabase, deprovisionVfDatabase } = require('./vf-database');

// Optional distinct MySQL app user to grant cross-DB CRUD on each vf_<id>.*. When
// unset the Data-API/app connection uses the master cluster user (already full
// privileges), so no per-VF app grant is required. See VF-PER-DATABASE-REDESIGN.md.

// The SHARED analytics read-only MySQL user (e.g. 'analytics_ro', provisioned by
// database-schema-init). When set, each vf_<id> grants it SELECT so the analytics
// API — which runs generated VF-scoped SELECTs as this single least-privilege
// user — can read the VF de-id tree (Phase 4B). Unset => analytics VF queries
// cannot reach the tree; document via the env in analytics/VF stack wiring.

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

function toCamelCase(obj) {
  if (!obj) return obj;
  const camelObj = {};
  for (const key in obj) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    camelObj[camelKey] = obj[key];
  }
  return camelObj;
}

// Default de-identification attributes (common HIPAA identifiers)
const DEFAULT_DEIDENT_ATTRIBUTES = [
  { tag: '00100010', name: 'PatientName', action: 'hash' },
  { tag: '00100020', name: 'PatientID', action: 'hash' },
  { tag: '00100030', name: 'PatientBirthDate', action: 'remove' },
  { tag: '00080050', name: 'AccessionNumber', action: 'hash' },
  { tag: '00080090', name: 'ReferringPhysicianName', action: 'remove' },
  { tag: '00081070', name: 'OperatorsName', action: 'remove' },
];

async function listVirtualFolders(event) {
  const queryParams = event.queryStringParameters || {};
  const pageSize = parseInt(queryParams.pageSize) || 100;
  const currentPage = parseInt(queryParams.page) || 1;
  const offset = (currentPage - 1) * pageSize;

  // Get user's virtual folder privileges from authorizer context
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  
  // If user has wildcard access, return all folders
  const hasWildcardAccess = virtualFolderPrivileges.some(p => p.virtualFolderId === '*' && p.canRead); // nosec - intentional wildcard for admin "All Virtual Folders" privilege
  
  let datastores;
  let totalCount;
  
  if (hasWildcardAccess) {
    // User has access to all virtual folders
    datastores = await query(
      `SELECT vd.*, vds.patient_count, vds.study_count, vds.series_count, vds.instance_count,
              d.name as write_datastore_name, d.status as write_datastore_status
       FROM virtual_folders vd
       LEFT JOIN virtual_folder_statistics vds ON vd.id = vds.virtual_folder_id
       LEFT JOIN datastores d ON vd.write_datastore_id = d.id
       WHERE vd.deleted = FALSE
       ORDER BY vd.created_at DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );

    const [countResult] = await query('SELECT COUNT(*) as total FROM virtual_folders WHERE deleted = FALSE');
    totalCount = countResult?.total || 0;
  } else {
    // Filter by user's specific virtual folder access
    const accessibleFolderIds = virtualFolderPrivileges
      .filter(p => p.canRead)
      .map(p => p.virtualFolderId);
    
    if (accessibleFolderIds.length === 0) {
      // User has no virtual folder access
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          success: true,
          data: { items: [], totalCount: 0, pageSize, currentPage, totalPages: 0 }
        })
      };
    }
    
    const placeholders = accessibleFolderIds.map(() => '?').join(',');
    datastores = await query(
      `SELECT vd.*, vds.patient_count, vds.study_count, vds.series_count, vds.instance_count,
              d.name as write_datastore_name, d.status as write_datastore_status
       FROM virtual_folders vd
       LEFT JOIN virtual_folder_statistics vds ON vd.id = vds.virtual_folder_id
       LEFT JOIN datastores d ON vd.write_datastore_id = d.id
       WHERE vd.deleted = FALSE AND vd.id IN (${placeholders})
       ORDER BY vd.created_at DESC LIMIT ? OFFSET ?`,
      [...accessibleFolderIds, pageSize, offset]
    );

    const [countResult] = await query(
      `SELECT COUNT(*) as total FROM virtual_folders WHERE deleted = FALSE AND id IN (${placeholders})`,
      accessibleFolderIds
    );
    totalCount = countResult?.total || 0;
  }

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
        totalPages: Math.ceil(totalCount / pageSize)
      }
    })
  };
}

async function getVirtualFolder(event) {
  const id = event.pathParameters?.id;
  if (!id) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'ID required' } }) };
  }

  // F24: require canRead on THIS virtual folder (or '*' admin). Without it, any
  // authenticated user could read another folder's metadata/stats by id.
  const virtualFolderPrivileges = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  const canReadVf = virtualFolderPrivileges.some(p =>
    (p.virtualFolderId === id || p.virtualFolderId === '*') && p.canRead === true // nosec - '*' is admin "All Virtual Folders"
  );
  if (!canReadVf) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  }

  const [datastore] = await query(
    `SELECT vd.*, vds.patient_count, vds.study_count, vds.series_count, vds.instance_count,
            d.name as write_datastore_name, d.status as write_datastore_status
     FROM virtual_folders vd
     LEFT JOIN virtual_folder_statistics vds ON vd.id = vds.virtual_folder_id
     LEFT JOIN datastores d ON vd.write_datastore_id = d.id
     WHERE vd.id = ? AND vd.deleted = FALSE`,
    [id]
  );

  if (!datastore) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  }

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: toCamelCase(datastore) }) };
}

function validateVirtualFolderName(name) {
  if (!name) return 'name is required';
  if (!/^[A-Za-z0-9._\- ]{1,28}$/.test(name)) return 'Name must be 1-28 characters and contain only letters, numbers, dots, hyphens, underscores, and spaces';
  return null;
}

/**
 * The dedicated storage carries the folder's own name. Storage names cannot
 * contain spaces (datastore-api: [A-Za-z0-9._-]{1,32}), so a space becomes a
 * hyphen; every other character a folder name allows is already valid.
 */
function dedicatedDatastoreName(vfName) {
  return String(vfName).trim().replace(/\s+/g, '-');
}

async function createDedicatedDatastore(name, createdBy, vfId) {
  const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
  const dsId = randomUUID();
  const dsName = dedicatedDatastoreName(name);
  const [clash] = await query('SELECT id FROM datastores WHERE name = ? AND deleted = FALSE', [dsName]);
  if (clash) throw new Error(`A storage named "${dsName}" already exists; rename the virtual folder or choose "Write to existing storage"`);
  await query(
    `INSERT INTO datastores (id, name, description, status, created_by) VALUES (?, ?, ?, 'CREATING', ?)`,
    [dsId, dsName,
      `Dedicated storage of virtual folder "${name}" (${vfId}). Data sent to that folder's STOW-RS endpoint is stored here.`,
      createdBy]
  );
  if (process.env.CREATION_STATE_MACHINE_ARN) {
    const sfn = new SFNClient({});
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: process.env.CREATION_STATE_MACHINE_ARN,
      input: JSON.stringify({ id: dsId, name: dsName, createAccessRoles: true })
    }));
  }
  return dsId;
}

const WRITE_MODES = ['NONE', 'EXISTING', 'DEDICATED'];

function canStoreDatastore(event, datastoreId) {
  let privs = [];
  try { privs = JSON.parse(event.requestContext?.authorizer?.datastorePrivileges || '[]'); } catch { privs = []; }
  return privs.some(p => (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canStore === true); // nosec - '*' is the admin "All Datastores" grant
}

/** Creating a storage is gated by managementPrivileges.datastores.canEdit (same as POST /datastores). */
function canCreateDatastore(event) {
  let mp = {};
  try { mp = JSON.parse(event.requestContext?.authorizer?.managementPrivileges || '{}'); } catch { mp = {}; }
  return mp?.datastores?.canEdit === true;
}

/**
 * Resolve the storage a folder writes to.
 *   NONE      -> null (read-only folder; STOW-RS to it is refused)
 *   EXISTING  -> writeDatastoreId, which must be ACTIVE, writable (access_level
 *                NULL or 'read-write', never 'read-only') and storable by the CALLER:
 *                choosing it lets anyone with store access on the folder write
 *                into that storage, so the person wiring it up must hold that
 *                right themselves.
 *   DEDICATED -> a new storage named after the folder, created once; kept when
 *                the folder is already DEDICATED. The caller must be allowed to
 *                create storages, since this is a storage creation by proxy.
 */
async function resolveWriteDatastoreId(event, writeMode, writeDatastoreId, name, createdBy, vfId, existing) {
  if (!WRITE_MODES.includes(writeMode)) throw new Error("writeMode must be 'NONE', 'EXISTING' or 'DEDICATED'");
  if (writeMode === 'EXISTING') {
    if (!writeDatastoreId) throw new Error('writeDatastoreId is required when writeMode is EXISTING');
    const [ds] = await query('SELECT id, name, status, access_level FROM datastores WHERE id = ? AND deleted = FALSE', [writeDatastoreId]);
    if (!ds) throw new Error('Datastore not found');
    // Writable-destination rule (shared layer): a folder may only write into a
    // writable storage. A read-only (imported) storage is refused with 400.
    if (!isWritableAccessLevel(ds.access_level)) {
      throw new Error(`Storage "${ds.name}" is read-only; a folder can only write to a writable storage`);
    }
    if (ds.status !== 'ACTIVE') throw new Error(`Storage "${ds.name}" is ${ds.status}`);
    if (!canStoreDatastore(event, writeDatastoreId)) {
      const e = new Error(`You need store permission on storage "${ds.name}" to make this folder write to it`);
      e.statusCode = 403;
      throw e;
    }
    return writeDatastoreId;
  }
  if (writeMode === 'DEDICATED') {
    if (existing && existing.write_mode === 'DEDICATED' && existing.write_datastore_id) return existing.write_datastore_id;
    if (!canCreateDatastore(event)) {
      const e = new Error('You need the storage create permission (Storage: Edit) to give this folder a dedicated storage');
      e.statusCode = 403;
      throw e;
    }
    return await createDedicatedDatastore(name, createdBy, vfId);
  }
  return null;
}

// The de-identification config carries the folder's hashSalt, a secret: with it,
// pseudonymised patient identifiers can be re-linked. Never put it in an audit event.
function auditSafeDeidConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const { hashSalt, ...rest } = config;
  return hashSalt === undefined ? rest : { ...rest, hashSalt: '[REDACTED]' };
}

async function createVirtualFolder(event) {
  const body = JSON.parse(event.body);
  const { name, description, indexingProfileId, deidProfileId, deidentificationConfig, writeMode, writeDatastoreId } = body;

  const nameError = validateVirtualFolderName(name);
  if (nameError) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: nameError } }) };
  }

  const id = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username || 'system';
  
  // Generate hash salt for de-identification (backward compatibility)
  const hashSalt = randomUUID();
  const config = deidentificationConfig || {
    enabled: false,
    hashSalt,
    attributes: DEFAULT_DEIDENT_ATTRIBUTES
  };
  if (!config.hashSalt) config.hashSalt = hashSalt;

  // Resolve write mode
  const effectiveWriteMode = writeMode || 'NONE';
  let resolvedWriteDatastoreId = null;
  try {
    resolvedWriteDatastoreId = await resolveWriteDatastoreId(event, effectiveWriteMode, writeDatastoreId, name, createdBy, id, null);
  } catch (err) {
    return { statusCode: err.statusCode || 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: err.message } }) };
  }

  await query(
    `INSERT INTO virtual_folders (id, name, description, indexing_profile_id, deid_profile_id, deidentification_config, write_mode, write_datastore_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name, description || null, indexingProfileId || null, deidProfileId || null, JSON.stringify(config), effectiveWriteMode, resolvedWriteDatastoreId, createdBy]
  );

  // Provision the VF's own database (vf_<id>) + de-id tree + RO user/grant. If
  // this fails, do NOT leave a half-made VF: hard-delete the row we just inserted
  // and best-effort deprovision any partial DB/user, then surface the error.
  try {
    await provisionVfDatabase(id, query);
  } catch (provErr) {
    console.error('provisionVfDatabase failed, rolling back VF row:', provErr.message);
    try { await deprovisionVfDatabase(id, query); } catch (cleanupErr) {
      console.error('vf database cleanup after failed provision also failed:', cleanupErr.message);
    }
    try { await query('DELETE FROM virtual_folders WHERE id = ?', [id]); } catch (delErr) {
      console.error('failed to remove half-made virtual_folders row:', delErr.message);
    }
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: `Failed to provision virtual folder database: ${provErr.message}` } }) };
  }

  // Initialize statistics
  await query(
    `INSERT INTO virtual_folder_statistics (id, virtual_folder_id) VALUES (?, ?)`,
    [randomUUID(), id]
  );

  const [newDatastore] = await query('SELECT * FROM virtual_folders WHERE id = ?', [id]);

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username: createdBy,
    action: AUDIT_ACTIONS.CREATE_VIRTUAL_FOLDER,
    resourceType: RESOURCE_TYPES.VIRTUAL_FOLDER,
    resourceId: id,
    resourceName: name,
    newValues: { name, description, deidentificationConfig: auditSafeDeidConfig(config) },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: toCamelCase(newDatastore) }) };
}

async function updateVirtualFolder(event) {
  const id = event.pathParameters?.id;
  const body = JSON.parse(event.body);
  const { name, description, status, indexingProfileId, deidProfileId, deidentificationConfig, writeMode, writeDatastoreId } = body;

  if (!id) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'ID required' } }) };
  }

  // Per-object authz: editing a virtual folder (name/status/deid/write-mode) is
  // a WRITE, so require canStore on THIS folder (or the '*' admin grant). The
  // API authorizer only scopes the route to /virtual-folders/*/… so the
  // per-folder check MUST happen here — without it any authenticated user could
  // modify any folder by id. Return 404 (not 403) so folder existence is not
  // leaked to a caller with no access.
  const vfPrivs = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  const canStoreVf = vfPrivs.some(p =>
    (p.virtualFolderId === id || p.virtualFolderId === '*') && p.canStore === true // nosec - '*' is admin "All Virtual Folders"
  );
  if (!canStoreVf) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  }

  if (name !== undefined) {
    const nameError = validateVirtualFolderName(name);
    if (nameError) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: nameError } }) };
    }
  }

  const [existing] = await query('SELECT * FROM virtual_folders WHERE id = ? AND deleted = FALSE', [id]);
  if (!existing) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;
  if (status !== undefined) updateData.status = status;
  if (indexingProfileId !== undefined) updateData.indexing_profile_id = indexingProfileId;
  if (deidProfileId !== undefined) updateData.deid_profile_id = deidProfileId;
  if (deidentificationConfig !== undefined) updateData.deidentification_config = JSON.stringify(deidentificationConfig);

  // Handle write mode changes
  if (writeMode !== undefined) {
    const username = event.requestContext?.authorizer?.username || 'system';
    try {
      const resolvedId = await resolveWriteDatastoreId(event, writeMode, writeDatastoreId, name || existing.name, username, id, existing);
      updateData.write_mode = writeMode;
      // NONE clears the link, so a read-only folder never points at a storage.
      updateData.write_datastore_id = writeMode === 'NONE' ? null : resolvedId;
    } catch (err) {
      return { statusCode: err.statusCode || 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: err.message } }) };
    }
  }

  const username = event.requestContext?.authorizer?.username || 'system';
  
  if (Object.keys(updateData).length > 0) {
    await saveVersionAndUpdate('virtual_folders', id, existing, updateData, username, query);
  }

  const [updated] = await query('SELECT * FROM virtual_folders WHERE id = ?', [id]);
  
  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username,
    action: AUDIT_ACTIONS.UPDATE_VIRTUAL_FOLDER,
    resourceType: RESOURCE_TYPES.VIRTUAL_FOLDER,
    resourceId: id,
    resourceName: updated.name,
    oldValues: { name: existing.name, description: existing.description, status: existing.status },
    newValues: { name, description, status, deidentificationConfig: auditSafeDeidConfig(deidentificationConfig) },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });
  
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: toCamelCase(updated) }) };
}

async function deleteVirtualFolder(event) {
  const id = event.pathParameters?.id;
  if (!id) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'ID required' } }) };
  }

  // Per-object authz (consistent with updateVirtualFolder): deleting a folder is
  // write-class — require canStore on THIS folder (or '*' admin). 404 if not,
  // so folder existence is not leaked.
  const vfPrivs = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]');
  const canStoreVf = vfPrivs.some(p =>
    (p.virtualFolderId === id || p.virtualFolderId === '*') && p.canStore === true // nosec - '*' is admin "All Virtual Folders"
  );
  if (!canStoreVf) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  }

  const [existing] = await query('SELECT * FROM virtual_folders WHERE id = ? AND deleted = FALSE', [id]);
  if (!existing) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  }

  const username = event.requestContext?.authorizer?.username || 'system';
  const deleted = await softDelete('virtual_folders', id, username);
  
  if (!deleted) {
    return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  }

  // Tear down the VF's own database + RO user (idempotent). Best-effort: the VF
  // is already soft-deleted; a deprovision failure is logged but does not fail
  // the API response (a later delete/GC can retry — DROP ... IF EXISTS is safe).
  try {
    await deprovisionVfDatabase(id, query);
  } catch (deprovErr) {
    console.error('deprovisionVfDatabase failed (VF already soft-deleted):', deprovErr.message);
  }

  await sendAuditEvent({
    user: event.requestContext?.authorizer?.claims?.sub || 'system',
    username,
    action: AUDIT_ACTIONS.DELETE_VIRTUAL_FOLDER,
    resourceType: RESOURCE_TYPES.VIRTUAL_FOLDER,
    resourceId: id,
    resourceName: existing.name,
    oldValues: { name: existing.name, description: existing.description },
    apiEndpoint: event.path,
    httpMethod: event.httpMethod,
    status: 'SUCCESS'
  });

  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, message: 'Deleted' }) };
}

// Per-folder grant check for the rules routes, same model as get/update/delete
// above: canRead to list, canStore to create/update/delete ('*' is admin).
function hasVfGrant(event, vfId, field) {
  let vfPrivs = [];
  try { vfPrivs = JSON.parse(event.requestContext?.authorizer?.virtualFolderPrivileges || '[]'); } catch { vfPrivs = []; }
  return !!vfId && vfPrivs.some(p =>
    (p.virtualFolderId === vfId || p.virtualFolderId === '*') && p[field] === true // nosec - '*' is admin "All Virtual Folders"
  );
}

// Returns a 404 response when the caller may not act on the folder's rules, or
// when a ruleId does not belong to the folder named in the path; else null.
async function authorizeRulesRequest(event) {
  const notFound = { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Not found' } }) };
  const vfId = event.pathParameters?.id;
  const ruleId = event.pathParameters?.ruleId;
  if (!hasVfGrant(event, vfId, event.httpMethod === 'GET' ? 'canRead' : 'canStore')) return notFound;
  if (ruleId) {
    const [owner] = await query(
      'SELECT virtual_folder_id FROM virtual_assignment_rules WHERE id = ? AND deleted = FALSE', [ruleId]);
    if (!owner || owner.virtual_folder_id !== vfId) return notFound;
  }
  return null;
}

// Assignment Rules CRUD
async function listRules(event) {
  const virtualFolderId = event.pathParameters?.id;
  const rules = await query(
    `SELECT * FROM virtual_assignment_rules WHERE virtual_folder_id = ? AND deleted = FALSE ORDER BY priority`,
    [virtualFolderId]
  );
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: rules.map(toCamelCase) }) };
}

async function createRule(event) {
  const virtualFolderId = event.pathParameters?.id;
  const body = JSON.parse(event.body);
  const { name, description, conditions, priority, enabled } = body;

  if (!name || !conditions) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'name and conditions required' } }) };
  }

  const id = randomUUID();
  await query(
    `INSERT INTO virtual_assignment_rules (id, virtual_folder_id, name, description, conditions, priority, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, virtualFolderId, name, description || null, JSON.stringify(conditions), priority || 0, enabled !== false]
  );

  const [rule] = await query('SELECT * FROM virtual_assignment_rules WHERE id = ?', [id]);
  return { statusCode: 201, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: toCamelCase(rule) }) };
}

async function updateRule(event) {
  const ruleId = event.pathParameters?.ruleId;
  const body = JSON.parse(event.body);
  const { name, description, conditions, priority, enabled } = body;

  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (conditions !== undefined) { updates.push('conditions = ?'); params.push(JSON.stringify(conditions)); }
  if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
  if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled); }

  if (updates.length > 0) {
    params.push(ruleId);
    await query(`UPDATE virtual_assignment_rules SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [rule] = await query('SELECT * FROM virtual_assignment_rules WHERE id = ?', [ruleId]);
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, data: toCamelCase(rule) }) };
}

async function deleteRule(event) {
  const ruleId = event.pathParameters?.ruleId;
  await query('UPDATE virtual_assignment_rules SET deleted = TRUE WHERE id = ?', [ruleId]);
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ success: true, message: 'Deleted' }) };
}

exports.handler = async (event) => {
  console.log('Virtual Datastore API:', event.httpMethod, event.path, event.pathParameters);

  try {
    const method = event.httpMethod;
    const path = event.path || '';
    const pathParams = event.pathParameters || {};

    // Rules endpoints: /virtual-folders/{id}/rules[/{ruleId}]
    if (path.includes('/rules')) {
      const denied = await authorizeRulesRequest(event);
      if (denied) return denied;
      if (method === 'GET') return await listRules(event);
      if (method === 'POST') return await createRule(event);
      if (method === 'PUT' && pathParams.ruleId) return await updateRule(event);
      if (method === 'DELETE' && pathParams.ruleId) return await deleteRule(event);
    }

    // Virtual datastore CRUD
    if (method === 'GET' && !pathParams.id) return await listVirtualFolders(event);
    if (method === 'GET' && pathParams.id) return await getVirtualFolder(event);
    if (method === 'POST') return await createVirtualFolder(event);
    if (method === 'PUT') return await updateVirtualFolder(event);
    if (method === 'DELETE') return await deleteVirtualFolder(event);

    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Method not allowed' } }) };
  } catch (error) {
    console.error('Error:', error.message);
    console.error('virtual-folder-api error:', { name: error.name, code: error.code });
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message: 'Internal server error' } }) };
  }
};

exports._internal = { auditSafeDeidConfig };
