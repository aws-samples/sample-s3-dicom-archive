/**
 * DICOM Privileges API
 * 
 * STATUS: CURRENTLY DISABLED (Not deployed)
 * 
 * This standalone API for managing DICOM privileges is not currently used by any clients.
 * Privileges are managed inline through the DICOM Entity API (/api/dicom-entities).
 * 
 * When creating or updating a DICOM entity, privileges are included in the request body
 * as a `dicomPrivileges` array, and the Entity API handles all privilege CRUD operations.
 * 
 * This code is preserved for potential future use cases where managing privileges
 * independently of entities might be needed.
 * 
 * To re-enable:
 * 1. Uncomment the Lambda function in interoperability-stack.ts
 * 2. Uncomment the API Gateway routes in interoperability-stack.ts
 * 3. Uncomment the authorization rules in api-authorizer/index.js
 * 4. Deploy the stack
 */

const { query } = require('/opt/nodejs/database');
const { saveVersionAndUpdate, softDelete } = require('/opt/nodejs/versioning-helper');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { publishConfigUpdate } = require('/opt/nodejs/config-notifier');
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

async function listPrivileges(event) {
  const queryParams = event.queryStringParameters || {};
  const interfaceId = queryParams.interfaceId;
  const entityId = queryParams.entityId;

  let sql = 'SELECT * FROM dicom_privileges WHERE deleted = false';
  const params = [];

  if (interfaceId) {
    sql += ' AND dicom_interface_id = ?';
    params.push(interfaceId);
  }
  if (entityId) {
    sql += ' AND dicom_entity_id = ?';
    params.push(entityId);
  }

  sql += ' ORDER BY created_at DESC';

  const privileges = await query(sql, params);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        privileges: privileges.map(p => ({
          ...toCamelCase(p),
          canStore: Boolean(p.can_store),
          canQuery: Boolean(p.can_query),
          canRetrieve: Boolean(p.can_retrieve)
        }))
      }
    })
  };
}

async function getPrivilege(event) {
  const privilegeId = event.pathParameters?.id;

  if (!privilegeId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Privilege ID is required' }
      })
    };
  }

  const [privilege] = await query('SELECT * FROM dicom_privileges WHERE id = ? AND deleted = false', [privilegeId]);

  if (!privilege) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Privilege not found' }
      })
    };
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        ...toCamelCase(privilege),
        canStore: Boolean(privilege.can_store),
        canQuery: Boolean(privilege.can_query),
        canRetrieve: Boolean(privilege.can_retrieve)
      }
    })
  };
}

async function createPrivilege(event) {
  const body = JSON.parse(event.body);
  const { dicomInterfaceId, dicomEntityId, canStore, canQuery, canRetrieve } = body;

  if (!dicomInterfaceId || !dicomEntityId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'dicomInterfaceId and dicomEntityId are required' }
      })
    };
  }

  const [existing] = await query(
    'SELECT id FROM dicom_privileges WHERE dicom_interface_id = ? AND dicom_entity_id = ?',
    [dicomInterfaceId, dicomEntityId]
  );

  if (existing) {
    return {
      statusCode: 409,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'CONFLICT', message: 'Privilege already exists for this interface and entity' }
      })
    };
  }

  const privilegeId = randomUUID();
  const createdBy = event.requestContext?.authorizer?.username || 'system';
  const userId = event.requestContext?.authorizer?.userId || 'system';

  await query(
    `INSERT INTO dicom_privileges (id, dicom_interface_id, dicom_entity_id, can_store, can_query, can_retrieve, created_by) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [privilegeId, dicomInterfaceId, dicomEntityId, canStore ? 1 : 0, canQuery ? 1 : 0, canRetrieve ? 1 : 0, createdBy]
  );

  await sendAuditEvent({
    user: userId,
    username: createdBy,
    action: AUDIT_ACTIONS.CREATE_PRIVILEGE,
    resourceType: RESOURCE_TYPES.DICOM_PRIVILEGE,
    resourceId: privilegeId,
    resourceName: `${dicomInterfaceId}-${dicomEntityId}`,
    newValues: { dicomInterfaceId, dicomEntityId, canStore, canQuery, canRetrieve },
    status: 'SUCCESS'
  });

  // Get location_id and publish config update
  const [iface] = await query('SELECT location_id FROM dicom_interfaces WHERE id = ?', [dicomInterfaceId]);
  if (iface?.location_id) {
    await publishConfigUpdate([iface.location_id]);
  }

  const [newPrivilege] = await query('SELECT * FROM dicom_privileges WHERE id = ? AND deleted = false', [privilegeId]);

  return {
    statusCode: 201,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        ...toCamelCase(newPrivilege),
        canStore: Boolean(newPrivilege.can_store),
        canQuery: Boolean(newPrivilege.can_query),
        canRetrieve: Boolean(newPrivilege.can_retrieve)
      }
    })
  };
}

async function updatePrivilege(event) {
  const privilegeId = event.pathParameters?.id;
  const body = JSON.parse(event.body);
  const { canStore, canQuery, canRetrieve } = body;

  if (!privilegeId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Privilege ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM dicom_privileges WHERE id = ? AND deleted = false', [privilegeId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Privilege not found' }
      })
    };
  }

  const username = event.requestContext?.authorizer?.username || 'system';
  const userId = event.requestContext?.authorizer?.userId || 'system';
  
  const newValues = {};
  if (canStore !== undefined) newValues.can_store = canStore ? 1 : 0;
  if (canQuery !== undefined) newValues.can_query = canQuery ? 1 : 0;
  if (canRetrieve !== undefined) newValues.can_retrieve = canRetrieve ? 1 : 0;

  if (Object.keys(newValues).length > 0) {
    await saveVersionAndUpdate('dicom_privileges', privilegeId, existing, newValues, username, query);
    
    await sendAuditEvent({
      user: userId,
      username,
      action: AUDIT_ACTIONS.UPDATE_PRIVILEGE,
      resourceType: RESOURCE_TYPES.DICOM_PRIVILEGE,
      resourceId: privilegeId,
      resourceName: `${existing.dicom_interface_id}-${existing.dicom_entity_id}`,
      oldValues: existing,
      newValues,
      status: 'SUCCESS'
    });

    // Get location_id and publish config update
    const [iface] = await query('SELECT location_id FROM dicom_interfaces WHERE id = ?', [existing.dicom_interface_id]);
    if (iface?.location_id) {
      await publishConfigUpdate([iface.location_id]);
    }
  }

  const [updatedPrivilege] = await query('SELECT * FROM dicom_privileges WHERE id = ? AND deleted = false', [privilegeId]);

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      success: true,
      data: {
        ...toCamelCase(updatedPrivilege),
        canStore: Boolean(updatedPrivilege.can_store),
        canQuery: Boolean(updatedPrivilege.can_query),
        canRetrieve: Boolean(updatedPrivilege.can_retrieve)
      }
    })
  };
}

async function deletePrivilege(event) {
  const privilegeId = event.pathParameters?.id;

  if (!privilegeId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Privilege ID is required' }
      })
    };
  }

  const [existing] = await query('SELECT * FROM dicom_privileges WHERE id = ? AND deleted = false', [privilegeId]);

  if (!existing) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Privilege not found' }
      })
    };
  }

  const username = event.requestContext?.authorizer?.username || 'system';
  const userId = event.requestContext?.authorizer?.userId || 'system';
  
  await softDelete('dicom_privileges', privilegeId, username, query);
  
  await sendAuditEvent({
    user: userId,
    username,
    action: AUDIT_ACTIONS.DELETE_PRIVILEGE,
    resourceType: RESOURCE_TYPES.DICOM_PRIVILEGE,
    resourceId: privilegeId,
    resourceName: `${existing.dicom_interface_id}-${existing.dicom_entity_id}`,
    oldValues: existing,
    status: 'SUCCESS'
  });

  // Get location_id and publish config update
  const [iface] = await query('SELECT location_id FROM dicom_interfaces WHERE id = ?', [existing.dicom_interface_id]);
  if (iface?.location_id) {
    await publishConfigUpdate([iface.location_id]);
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, message: 'Privilege deleted successfully' })
  };
}

exports.handler = async (event) => {
  console.log('DICOM Privileges API:', event.httpMethod, event.path);

  try {
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters;

    if (httpMethod === 'GET' && !pathParameters?.id) {
      return await listPrivileges(event);
    } else if (httpMethod === 'GET' && pathParameters?.id) {
      return await getPrivilege(event);
    } else if (httpMethod === 'POST') {
      return await createPrivilege(event);
    } else if (httpMethod === 'PUT') {
      return await updatePrivilege(event);
    } else if (httpMethod === 'DELETE') {
      return await deletePrivilege(event);
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
