// RDS Proxy migration (P2): connect to Aurora through the RDS Proxy via mysql2
// (shared layer at /opt/nodejs/database), NOT the RDS Data API. The shared layer
// reads DB_HOST(proxy)/DB_SECRET_ARN/DB_NAME from the environment. Named `:param`
// placeholders are translated to positional `?`; `{ isNull: true }` -> null.
const { execute } = require('/opt/nodejs/database');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambdaClient = new LambdaClient({});

// Translate named `:param` placeholders to positional `?` (first-seen order,
// repeats expanded) using a { name: value } map, and run via the shared pool.
async function executeStatement(sql, params = {}) {
  const args = [];
  const outSql = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name) => {
    if (!(name in params)) return m;
    args.push(params[name]);
    return '?';
  });
  return execute(outSql, args);
}

exports.handler = async (event) => {
  console.log('Heartbeat Updater Lambda invoked');
  
  try {
    let heartbeatData;
    
    if (event.Records && event.Records.length > 0) {
      // SQS event
      const results = [];
      for (const record of event.Records) {
        try {
          const messageBody = JSON.parse(record.body);
          const result = await processHeartbeat(messageBody);
          results.push(result);
        } catch (error) {
          console.error('Error processing SQS record:', error.message);
          results.push({ success: false, error: error.message });
        }
      }
      return { statusCode: 200, body: JSON.stringify({ message: 'Processed SQS heartbeat messages', results }) };
    } else if (event.httpMethod) {
      // API Gateway event
      if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
      }
      heartbeatData = JSON.parse(event.body || '{}');
    } else {
      // Direct invocation
      heartbeatData = event;
    }
    
    const result = await processHeartbeat(heartbeatData);
    
    if (event.httpMethod) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ message: 'Heartbeat processed successfully', result })
      };
    }
    return result;
  } catch (error) {
    console.error('Error:', error.message);
    if (event.httpMethod) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Internal server error', message: error.message })
      };
    }
    throw error;
  }
};

async function processHeartbeat(heartbeatData) {
  console.log('Processing heartbeat for client:', heartbeatData.client_id, 'location:', heartbeatData.location_id || heartbeatData.interface_id);
  
  // Support both location_id (new) and interface_id (legacy) for backward compatibility
  const location_id = heartbeatData.location_id || heartbeatData.interface_id;
  const client_id = heartbeatData.client_id;
  
  if (!location_id || !client_id) {
    throw new Error('location_id (or interface_id) and client_id are required');
  }
  
  const metadata = heartbeatData.metadata || {};
  const status = metadata.service_status === 'healthy' || metadata.service_status === 'active' ? 'ACTIVE' : 'ERROR';
  
  // Extract hostname, IP, and port from metadata
  const hostname = metadata.hostname || null;
  const ipAddress = metadata.local_ip_address || null;
  const port = metadata.service_port || null;
  const serviceVersion = metadata.service_version || null;
  
  await executeStatement(
    `INSERT INTO interface_servers (client_id, location_id, interface_type, hostname, ip_address, port, status, last_heartbeat, server_metadata, service_version)
          VALUES (:clientId, :locationId, 'DICOM', :hostname, :ipAddress, :port, :status, CURRENT_TIMESTAMP, :metadata, :serviceVersion)
          ON DUPLICATE KEY UPDATE
            location_id = VALUES(location_id),
            hostname = VALUES(hostname),
            ip_address = VALUES(ip_address),
            port = VALUES(port),
            status = VALUES(status),
            last_heartbeat = CURRENT_TIMESTAMP,
            server_metadata = VALUES(server_metadata),
            service_version = VALUES(service_version)`,
    {
      clientId: client_id,
      locationId: location_id,
      hostname: hostname,
      ipAddress: ipAddress,
      port: port,
      status: status,
      metadata: JSON.stringify(metadata),
      serviceVersion: serviceVersion
    }
  );

  console.log('Successfully updated interface server record');

  // Graceful shutdown: mark SHUTDOWN and trigger targeted cleanup
  if (metadata.shutdown === true) {
    await executeStatement(
      `UPDATE interface_servers SET status = 'SHUTDOWN' WHERE client_id = :clientId`,
      { clientId: client_id }
    );
    if (process.env.CLEANUP_LAMBDA_ARN) {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: process.env.CLEANUP_LAMBDA_ARN,
        InvocationType: 'Event',
        Payload: JSON.stringify({ client_id })
      }));
      console.log(`Triggered cleanup for client_id: ${client_id}`);
    }
    return { success: true, client_id, location_id, status: 'SHUTDOWN' };
  }

  return {
    success: true,
    client_id,
    location_id,
    status
  };
}
