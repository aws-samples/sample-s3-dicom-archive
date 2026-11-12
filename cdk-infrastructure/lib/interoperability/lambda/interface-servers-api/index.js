const { query } = require('/opt/nodejs/database');
const { sendAuditEvent, AUDIT_ACTIONS, RESOURCE_TYPES } = require('/opt/nodejs/audit-helper');
const { normalizePathParameters } = require('/opt/nodejs/proxy-path');

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

exports.handler = async (event) => {
  console.log('Interface Servers API:', event.httpMethod, event.path);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const method = event.httpMethod;
    event.pathParameters = normalizePathParameters(event);
    const pathParams = event.pathParameters || {};
    const clientId = pathParams.id;

    let result;
    switch (method) {
      case 'GET':
        result = clientId ? await getServer(clientId) : await listServers(event);
        break;
      case 'POST':
        result = await registerServer(event);
        break;
      case 'PUT':
        result = await updateServer(clientId, event);
        break;
      case 'DELETE':
        result = await deleteServer(clientId);
        break;
      default:
        throw new Error(`Unsupported method: ${method}`);
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: error.statusCode || 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        success: false,
        error: { message: error.message }
      })
    };
  }
};

async function listServers(event) {
  const queryParams = event.queryStringParameters || {};
  const locationId = queryParams.locationId;
  const interfaceType = queryParams.interfaceType;
  const status = queryParams.status;

  let sql = `SELECT interface_servers.*, locations.name as location_name 
             FROM interface_servers 
             LEFT JOIN locations ON locations.id = interface_servers.location_id 
             WHERE 1=1`;
  const params = [];

  if (locationId) {
    sql += ' AND interface_servers.location_id = ?';
    params.push(locationId);
  }
  if (interfaceType) {
    sql += ' AND interface_servers.interface_type = ?';
    params.push(interfaceType);
  }
  if (status) {
    sql += ' AND interface_servers.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY interface_servers.updated_at DESC';

  const servers = await query(sql, params);

  const now = new Date();
  const enhancedServers = servers.map(server => {
    let timeSinceLastHeartbeat = null;
    let isStale = true;

    if (server.last_heartbeat) {
      const lastHeartbeatTime = new Date(server.last_heartbeat);
      timeSinceLastHeartbeat = Math.round((now - lastHeartbeatTime) / 1000);
      isStale = timeSinceLastHeartbeat > 300;
    }

    return {
      clientId: server.client_id,
      locationId: server.location_id,
      locationName: server.location_name || null,
      interfaceType: server.interface_type,
      hostname: server.hostname,
      ipAddress: server.ip_address,
      port: server.port,
      status: server.status,
      serviceVersion: server.service_version || null,
      lastHeartbeat: server.last_heartbeat,
      serverMetadata: server.server_metadata,
      createdAt: server.created_at,
      updatedAt: server.updated_at,
      timeSinceLastHeartbeat,
      isStale
    };
  });

  return {
    success: true,
    data: {
      interfaceServers: enhancedServers,
      count: enhancedServers.length
    }
  };
}

async function getServer(clientId) {
  const [server] = await query('SELECT * FROM interface_servers WHERE client_id = ?', [clientId]);

  if (!server) {
    const error = new Error('Interface server not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    success: true,
    data: {
      clientId: server.client_id,
      locationId: server.location_id,
      interfaceType: server.interface_type,
      hostname: server.hostname,
      ipAddress: server.ip_address,
      port: server.port,
      status: server.status,
      lastHeartbeat: server.last_heartbeat,
      serverMetadata: server.server_metadata,
      createdAt: server.created_at,
      updatedAt: server.updated_at
    }
  };
}

async function registerServer(event) {
  const body = JSON.parse(event.body);
  const { clientId, locationId, interfaceType, hostname, ipAddress, port, serverMetadata } = body;

  if (!clientId || !interfaceType) {
    const error = new Error('clientId and interfaceType are required');
    error.statusCode = 400;
    throw error;
  }

  await query(
    `INSERT INTO interface_servers (client_id, location_id, interface_type, hostname, ip_address, port, server_metadata, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
     ON DUPLICATE KEY UPDATE
       location_id = VALUES(location_id),
       hostname = VALUES(hostname),
       ip_address = VALUES(ip_address),
       port = VALUES(port),
       server_metadata = VALUES(server_metadata),
       last_heartbeat = CURRENT_TIMESTAMP,
       status = 'ACTIVE'`,
    [clientId, locationId, interfaceType, hostname, ipAddress, port, JSON.stringify(serverMetadata || {})]
  );

  return {
    success: true,
    message: 'Interface server registered successfully',
    data: { clientId }
  };
}

async function updateServer(clientId, event) {
  const body = JSON.parse(event.body);
  const { status, serverMetadata } = body;

  const updates = [];
  const params = [];

  if (status) {
    updates.push('status = ?');
    params.push(status);
  }
  if (serverMetadata) {
    updates.push('server_metadata = ?');
    params.push(JSON.stringify(serverMetadata));
  }

  updates.push('last_heartbeat = CURRENT_TIMESTAMP');

  if (updates.length === 0) {
    const error = new Error('No fields to update');
    error.statusCode = 400;
    throw error;
  }

  params.push(clientId);

  const result = await query(
    `UPDATE interface_servers SET ${updates.join(', ')} WHERE client_id = ?`,
    params
  );

  if (result.affectedRows === 0) {
    const error = new Error('Interface server not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    success: true,
    message: 'Interface server updated successfully'
  };
}

async function deleteServer(clientId) {
  const result = await query('DELETE FROM interface_servers WHERE client_id = ?', [clientId]);

  if (result.affectedRows === 0) {
    const error = new Error('Interface server not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    success: true,
    message: 'Interface server deleted successfully'
  };
}
