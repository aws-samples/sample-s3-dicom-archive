#!/usr/bin/env node

/**
 * Test Event Generator for EventBridge Audit Trail
 * 
 * This script sends a test audit event directly to EventBridge
 * to verify the audit trail pipeline is working correctly.
 * 
 * Usage:
 *   node test-audit-event.js <event-bus-name> <region>
 * 
 * Example:
 *   node test-audit-event.js myarchive-event-bus us-east-1
 */

const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');

const eventBusName = process.argv[2] || 'myarchive-event-bus';
const region = process.argv[3] || 'us-east-1';

const client = new EventBridgeClient({ region });

const testEvent = {
  action: 'CREATE_USER',
  resourceType: 'user',
  resourceId: 'test-user-' + Date.now(),
  resourceName: 'test.user',
  user: 'test-admin',
  username: 'test-admin',
  oldValues: null,
  newValues: {
    email: 'test.user@example.com',
    firstName: 'Test',
    lastName: 'User',
    privilegeGroupId: 'test-group-123'
  },
  status: 'SUCCESS',
  ipAddress: '127.0.0.1',
  requestId: 'test-request-' + Date.now(),
  apiEndpoint: '/users',
  httpMethod: 'POST'
};

async function sendTestEvent() {
  console.log('🚀 Sending test audit event to EventBridge...');
  console.log('   Event Bus:', eventBusName);
  console.log('   Region:', region);
  console.log('');

  try {
    const command = new PutEventsCommand({
      Entries: [{
        Source: 'dicom.archive',
        DetailType: 'UserCreated',
        Detail: JSON.stringify(testEvent),
        EventBusName: eventBusName
      }]
    });

    const response = await client.send(command);

    if (response.FailedEntryCount > 0) {
      console.error('❌ Failed to send event:');
      console.error(JSON.stringify(response.Entries, null, 2));
      process.exit(1);
    }

    console.log('✅ Test event sent successfully!');
    console.log('');
    console.log('📋 Event Details:');
    console.log('   Source: dicom.archive');
    console.log('   DetailType: UserCreated');
    console.log('   Action:', testEvent.action);
    console.log('   Resource:', testEvent.resourceName);
    console.log('   User:', testEvent.username);
    console.log('');
    console.log('🔍 Next Steps:');
    console.log('   1. Check EventBridge metrics in CloudWatch');
    console.log('   2. Verify message appears in SQS audit queue');
    console.log('   3. Check audit_logs table in database');
    console.log('   4. View entry in audit trail UI');
    console.log('');
    console.log('💡 Query to check database:');
    console.log(`   SELECT * FROM audit_logs WHERE resource_id = '${testEvent.resourceId}' ORDER BY timestamp DESC LIMIT 1;`);

  } catch (error) {
    console.error('❌ Error sending test event:');
    console.error(error.message);
    process.exit(1);
  }
}

sendTestEvent();
