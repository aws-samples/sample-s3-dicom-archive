const { query } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');

let hasResourceNameColumn = null;

async function checkResourceNameColumn() {
  if (hasResourceNameColumn === null) {
    try {
      const columns = await query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'audit_logs' 
        AND COLUMN_NAME = 'resource_name'
      `);
      hasResourceNameColumn = columns.length > 0;
      console.log('resource_name column exists:', hasResourceNameColumn);
    } catch (error) {
      console.error('Error checking resource_name column:', error.message);
      hasResourceNameColumn = false;
    }
  }
  return hasResourceNameColumn;
}

exports.handler = async (event) => {
  console.log('Audit Trail Lambda invoked', { recordCount: event.Records.length });

  // Check if resource_name column exists
  const hasResourceName = await checkResourceNameColumn();

  for (const record of event.Records) {
    try {
      let auditEvent;
      
      // Parse the SQS message body
      const messageBody = JSON.parse(record.body);
      
      // Check if this is an EventBridge event (has 'detail' field) or direct SQS message
      if (messageBody.detail && messageBody['detail-type']) {
        // EventBridge event wrapped in SQS - detail is already an object
        auditEvent = typeof messageBody.detail === 'string' 
          ? JSON.parse(messageBody.detail) 
          : messageBody.detail;
        console.log('Processing EventBridge audit event', {
          detailType: messageBody['detail-type'],
          action: auditEvent.action,
          user: auditEvent.user
        });
      } else {
        // Direct SQS message (backward compatibility)
        auditEvent = messageBody;
        console.log('Processing direct audit event', {
          action: auditEvent.action,
          user: auditEvent.user
        });
      }
      
      // Callers name the actor `user` or `username` (processing jobs, plugins,
      // schedules and analytics send only `username`), and some put their
      // payload in `details` rather than `newValues`. Accept both, so those
      // events are recorded instead of being dropped here.
      if (!auditEvent.user && auditEvent.username) auditEvent.user = auditEvent.username;
      if (auditEvent.newValues == null && auditEvent.details != null) auditEvent.newValues = auditEvent.details;

      // Validate required fields
      if (!auditEvent.user || !auditEvent.action) {
        console.error('Invalid audit event - missing required fields');
        continue;
      }

      // Convert ISO timestamp to MySQL datetime format
      const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

      // Map old field names to new schema
      const auditEntry = {
        id: randomUUID(),
        timestamp: timestamp,
        action: auditEvent.action,
        resource_type: auditEvent.resourceType || 'unknown',
        resource_id: auditEvent.resourceId,
        user_id: auditEvent.user,
        username: auditEvent.username || auditEvent.user,
        user_ip: auditEvent.ipAddress,
        request_id: auditEvent.requestId,
        api_endpoint: auditEvent.apiEndpoint,
        http_method: auditEvent.httpMethod,
        old_values: auditEvent.oldValues ? JSON.stringify(auditEvent.oldValues) : null,
        new_values: auditEvent.newValues ? JSON.stringify(auditEvent.newValues) : null,
        status: mapStatus(auditEvent.status),
        error_message: auditEvent.errorMessage
      };

      // Add resource_name if column exists
      if (hasResourceName) {
        auditEntry.resource_name = auditEvent.resourceName;
      }

      // Build dynamic SQL based on available columns
      const columns = Object.keys(auditEntry).join(', ');
      const placeholders = Object.keys(auditEntry).map(() => '?').join(', ');
      const values = Object.values(auditEntry);

      await query(
        `INSERT INTO audit_logs (${columns}) VALUES (${placeholders})`,  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
        values
      );

      console.log('Audit entry stored', { id: auditEntry.id });

    } catch (error) {
      console.error('Error processing audit event', { error: error.message });
      throw error;
    }
  }
};

function mapStatus(status) {
  const statusMap = {
    'SUCCESS': 'SUCCESS',
    'FAILED': 'FAILURE',
    'FAILURE': 'FAILURE',
    'PENDING': 'PARTIAL'
  };
  return statusMap[status] || 'SUCCESS';
}
