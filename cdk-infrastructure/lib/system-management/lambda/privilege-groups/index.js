const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { query } = require('/opt/nodejs/database');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');

// RDS Proxy migration (P2): all DB access now goes through the shared mysql2
// layer (/opt/nodejs/database -> RDS Proxy over MySQL). executeQuery is a thin
// wrapper over query() so existing call sites keep working; SQL uses positional
// `?` placeholders and rows are plain {column: value} objects.
async function executeQuery(sql, parameters = []) {
  return await query(sql, parameters);
}

// --- F19 / Security: privilege-escalation guard -------------------------
// A caller may only grant privileges it holds itself. The payload is first
// normalised to strict booleans (allowlisted keys only), and the normalised
// copy is both what is checked and what is stored, so a truthy non-boolean
// ({"canEdit": 1}) can no longer pass the check and then be honoured by the
// authorizer. Shared with users-api (group assignment, A-2).
const { normalizePrivileges, callerPrivileges, escalationViolations } = require('/opt/nodejs/privilege-guard');

function parseCtxJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

/** Body with its four privilege sets replaced by their normalised form. */
function withNormalizedPrivileges(data) {
  const out = { ...data };
  const n = normalizePrivileges(data);
  for (const k of Object.keys(n)) {
    if (data[k] !== undefined) out[k] = n[k];
  }
  return out;
}

exports.handler = async (event) => {
  console.log('Privilege Groups API:', event.httpMethod, event.path);

  const httpMethod = event.httpMethod;
  const path = event.path;
  event.pathParameters = normalizePathParameters(event);
  const pathParams = event.pathParameters;
  const userId = event.requestContext?.authorizer?.userId || event.requestContext?.authorizer?.claims?.sub || 'system';
  const username = event.requestContext?.authorizer?.username || event.requestContext?.authorizer?.username || 'system';

  try {
    switch (httpMethod) {
      case 'GET':
        if (pathParams && pathParams.id) {
          return await getPrivilegeGroup(pathParams.id);
        }
        return await listPrivilegeGroups(event.queryStringParameters);

      case 'POST':
        return await createPrivilegeGroup(withNormalizedPrivileges(parseCtxJson(event.body, {})), userId, username, event);

      case 'PUT':
        return await updatePrivilegeGroup(pathParams.id, withNormalizedPrivileges(parseCtxJson(event.body, {})), userId, username, event);

      case 'DELETE':
        return await deletePrivilegeGroup(pathParams.id, userId, username);

      default:
        return response(405, { message: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error.message);
    return response(500, { message: 'Internal server error' });
  }
};

async function listPrivilegeGroups(queryParams) {
  const sql = `
    SELECT id, name, description, user_mode, datastore_privileges, virtual_folder_privileges, management_privileges, 
           deployment_privileges, locked, created_at, updated_at
    FROM privilege_groups
    WHERE deleted = false
    ORDER BY name
  `;
  
  const result = await executeQuery(sql);
  const groups = result.map(record => ({
    id: record.id,
    name: record.name,
    description: record.description || '',
    userMode: record.user_mode || 'SYSTEM_USER',
    datastorePrivileges: JSON.parse(record.datastore_privileges || '[]'),
    virtualFolderPrivileges: JSON.parse(record.virtual_folder_privileges || '[]'),
    managementPrivileges: JSON.parse(record.management_privileges || '{}'),
    deploymentPrivileges: JSON.parse(record.deployment_privileges || '[]'),
    locked: !!record.locked,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  }));

  return response(200, { success: true, data: groups });
}

async function getPrivilegeGroup(id) {
  const sql = `
    SELECT id, name, description, user_mode, datastore_privileges, virtual_folder_privileges, management_privileges,
           deployment_privileges, locked, created_at, updated_at
    FROM privilege_groups
    WHERE id = ? AND deleted = false
  `;
  
  const result = await executeQuery(sql, [id]);

  if (result.length === 0) {
    return response(404, { message: 'Privilege group not found' });
  }

  const record = result[0];
  const group = {
    id: record.id,
    name: record.name,
    description: record.description || '',
    userMode: record.user_mode || 'SYSTEM_USER',
    datastorePrivileges: JSON.parse(record.datastore_privileges || '[]'),
    virtualFolderPrivileges: JSON.parse(record.virtual_folder_privileges || '[]'),
    managementPrivileges: JSON.parse(record.management_privileges || '{}'),
    deploymentPrivileges: JSON.parse(record.deployment_privileges || '[]'),
    locked: !!record.locked,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };

  // Enrich virtual folder privileges with names
  if (group.virtualFolderPrivileges.length > 0) {
    const vfIds = group.virtualFolderPrivileges.map(vf => vf.virtualFolderId).filter(id => id !== '*');
    if (vfIds.length > 0) {
      const vfSql = `SELECT id, name FROM virtual_folders WHERE id IN (${vfIds.map(() => '?').join(',')}) AND deleted = false`;
      const vfResult = await executeQuery(vfSql, vfIds);
      const vfMap = {};
      vfResult.forEach(r => {
        vfMap[r.id] = r.name;
      });
      group.virtualFolderPrivileges = group.virtualFolderPrivileges.map(vf => ({
        ...vf,
        virtualFolderName: vf.virtualFolderId === '*' ? 'All Virtual Folders' : vfMap[vf.virtualFolderId] || vf.virtualFolderId
      }));
    }
  }

  // Get associated users (via the many-to-many membership table)
  const usersSql = `
    SELECT u.email, u.first_name, u.last_name, u.status
    FROM users u
    JOIN user_privilege_groups upg ON upg.user_id = u.id
    WHERE upg.privilege_group_id = ? AND u.deleted = false
    ORDER BY u.email
  `;
  
  const usersResult = await executeQuery(usersSql, [id]);

  group.users = usersResult.map(userRecord => ({
    email: userRecord.email || '',
    firstName: userRecord.first_name || '',
    lastName: userRecord.last_name || '',
    status: userRecord.status || 'ACTIVE'
  }));

  return response(200, { success: true, data: group });
}

async function createPrivilegeGroup(data, userId, username, event) {
  // Input validation: reject a missing/empty body or a blank name with a 400
  // (a NULL name previously reached the NOT NULL column and surfaced as a 500).
  if (!data || typeof data !== 'object') {
    return response(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Request body is required' } });
  }
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    return response(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
  }

  // F19: a caller cannot create a group granting privileges they do not hold.
  const violations = escalationViolations(data, callerPrivileges(event));
  if (violations.length > 0) {
    return response(403, {
      message: 'You cannot grant privileges you do not hold',
      details: violations
    });
  }

  const id = `pg-${Date.now()}`;
  const sql = `
    INSERT INTO privilege_groups 
    (id, name, description, user_mode, datastore_privileges, virtual_folder_privileges, management_privileges, deployment_privileges)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await executeQuery(sql, [
    id,
    data.name,
    data.description || '',
    data.userMode || 'SYSTEM_USER',
    JSON.stringify(data.datastorePrivileges || []),
    JSON.stringify(data.virtualFolderPrivileges || []),
    JSON.stringify(data.managementPrivileges || {}),
    JSON.stringify(data.deploymentPrivileges || [])
  ]);

  await sendAuditEvent({
    action: AUDIT_ACTIONS.CREATE_PRIVILEGE_GROUP,
    resourceType: RESOURCE_TYPES.PRIVILEGE_GROUP,
    resourceId: id,
    resourceName: data.name,
    user: userId,
    username: username,
    newValues: {
      name: data.name,
      description: data.description,
      userMode: data.userMode,
      datastorePrivileges: data.datastorePrivileges,
      virtualFolderPrivileges: data.virtualFolderPrivileges,
      managementPrivileges: data.managementPrivileges,
      deploymentPrivileges: data.deploymentPrivileges
    },
    details: { name: data.name, description: data.description }
  });

  return response(201, { 
    success: true, 
    data: { id, ...data },
    message: 'Privilege group created successfully' 
  });
}

async function updatePrivilegeGroup(id, data, userId, username, event) {
  // Get complete current record with versioning fields
  const fetchSql = `SELECT * FROM privilege_groups WHERE id = ? AND deleted = false`;
  const fetchResult = await query(fetchSql, [id]);
  
  if (!fetchResult || fetchResult.length === 0) {
    return response(404, { message: 'Privilege group not found' });
  }
  
  const existing = fetchResult[0];
  
  if (existing.locked) {
    return response(403, { message: 'Cannot update locked privilege group' });
  }

  // F19: a caller cannot ADD privileges they do not hold. We diff against the
  // existing group so a legitimate edit (e.g. rename) of a group that already
  // carries broad privileges is not blocked — only privileges NEWLY introduced
  // by this update and not held by the caller are rejected.
  {
    const caller = callerPrivileges(event);
    const existingPayload = {
      managementPrivileges: JSON.parse(existing.management_privileges || '{}'),
      datastorePrivileges: JSON.parse(existing.datastore_privileges || '[]'),
      virtualFolderPrivileges: JSON.parse(existing.virtual_folder_privileges || '[]'),
      deploymentPrivileges: JSON.parse(existing.deployment_privileges || '[]')
    };
    const already = new Set(escalationViolations(existingPayload, caller));
    // Security: a group that already grants privileges the caller lacks
    // (e.g. a full admin's group) is out of the caller's reach entirely;
    // otherwise a delegated admin could demote full admins by editing it.
    if (already.size > 0) {
      return response(403, {
        message: 'You cannot modify a privilege group that grants privileges you do not hold',
        details: [...already]
      });
    }
    const newlyAdded = escalationViolations(data, caller).filter(v => !already.has(v));
    if (newlyAdded.length > 0) {
      return response(403, {
        message: 'You cannot grant privileges you do not hold',
        details: newlyAdded
      });
    }
  }

  const oldValues = {
    name: existing.name,
    description: existing.description,
    userMode: existing.user_mode,
    datastorePrivileges: JSON.parse(existing.datastore_privileges || '[]'),
    virtualFolderPrivileges: JSON.parse(existing.virtual_folder_privileges || '[]'),
    managementPrivileges: JSON.parse(existing.management_privileges || '{}'),
    deploymentPrivileges: JSON.parse(existing.deployment_privileges || '[]')
  };

  const updateData = {
    name: data.name,
    description: data.description || '',
    user_mode: data.userMode || 'SYSTEM_USER',
    datastore_privileges: JSON.stringify(data.datastorePrivileges || []),
    virtual_folder_privileges: JSON.stringify(data.virtualFolderPrivileges || []),
    management_privileges: JSON.stringify(data.managementPrivileges || {}),
    deployment_privileges: JSON.stringify(data.deploymentPrivileges || [])
  };

  await saveVersionAndUpdate('privilege_groups', id, existing, updateData, username, query);

  await sendAuditEvent({
    action: AUDIT_ACTIONS.UPDATE_PRIVILEGE_GROUP,
    resourceType: RESOURCE_TYPES.PRIVILEGE_GROUP,
    resourceId: id,
    resourceName: oldValues.name,
    user: userId,
    username: username,
    oldValues: oldValues,
    newValues: {
      name: data.name,
      description: data.description,
      userMode: data.userMode,
      datastorePrivileges: data.datastorePrivileges,
      virtualFolderPrivileges: data.virtualFolderPrivileges,
      managementPrivileges: data.managementPrivileges,
      deploymentPrivileges: data.deploymentPrivileges
    },
    details: { name: data.name, description: data.description }
  });

  return response(200, { 
    success: true, 
    data: { id, ...data },
    message: 'Privilege group updated successfully' 
  });
}

async function deletePrivilegeGroup(id, userId, username) {
  // Get old values and check if group is locked
  const checkSql = `SELECT name, description, user_mode, datastore_privileges, virtual_folder_privileges, management_privileges, locked FROM privilege_groups WHERE id = ? AND deleted = false`;
  const checkResult = await executeQuery(checkSql, [id]);

  if (checkResult.length === 0) {
    return response(404, { message: 'Privilege group not found' });
  }

  const oldValues = {
    name: checkResult[0].name,
    description: checkResult[0].description,
    userMode: checkResult[0].user_mode || 'SYSTEM_USER',
    datastorePrivileges: JSON.parse(checkResult[0].datastore_privileges || '[]'),
    virtualFolderPrivileges: JSON.parse(checkResult[0].virtual_folder_privileges || '[]'),
    managementPrivileges: JSON.parse(checkResult[0].management_privileges || '{}')
  };

  if (checkResult[0].locked) {
    return response(403, { message: 'Cannot delete locked privilege group' });
  }

  // Check if privilege group is associated with any users (via membership table)
  const userCheckSql = `
    SELECT u.cognito_username
    FROM users u
    JOIN user_privilege_groups upg ON upg.user_id = u.id
    WHERE upg.privilege_group_id = ? AND u.deleted = false`;
  const userCheckResult = await executeQuery(userCheckSql, [id]);

  if (userCheckResult.length > 0) {
    const associatedUsers = userCheckResult.map(record => record.cognito_username);
    return response(400, { 
      message: 'Cannot delete privilege group that is associated with users',
      associatedUsers: associatedUsers
    });
  }

  const deleted = await softDelete('privilege_groups', id, username);
  
  if (!deleted) {
    return response(404, { message: 'Privilege group not found' });
  }

  await sendAuditEvent({
    action: AUDIT_ACTIONS.DELETE_PRIVILEGE_GROUP,
    resourceType: RESOURCE_TYPES.PRIVILEGE_GROUP,
    resourceId: id,
    resourceName: oldValues.name,
    user: userId,
    username: username,
    oldValues: oldValues
  });

  return response(200, { 
    success: true, 
    message: 'Privilege group deleted successfully' 
  });
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}
