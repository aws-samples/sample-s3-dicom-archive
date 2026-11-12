# Heartbeat Updater Lambda Function

This Lambda function processes heartbeat messages from DICOM interface services and updates the `interface-servers` DynamoDB table to track service responsiveness.

## Purpose

The heartbeat updater is a critical component of the DICOM interface monitoring system:

1. **Receives heartbeat messages** from DICOM interface services
2. **Updates DynamoDB table** (`interface-servers`) with latest status
3. **Tracks service health** and responsiveness
4. **Supports multiple event sources** (API Gateway, SQS, direct invocation)

## Event Sources

### API Gateway (HTTP POST)
```json
{
  "httpMethod": "POST",
  "body": "{\"interfaceId\":\"default-dicom-interface\",\"clientId\":\"client-123\",\"status\":\"healthy\"}"
}
```

### SQS Messages
```json
{
  "Records": [
    {
      "body": "{\"interfaceId\":\"default-dicom-interface\",\"clientId\":\"client-123\",\"status\":\"healthy\"}"
    }
  ]
}
```

### Direct Invocation
```json
{
  "interfaceId": "default-dicom-interface",
  "clientId": "client-123",
  "timestamp": "2024-07-29T17:00:00.000Z",
  "status": "healthy",
  "metadata": {
    "dicomPort": 11112,
    "aeTitle": "EDGEDEVICE",
    "version": "1.0.0"
  }
}
```

## Required Fields

- **interfaceId**: Unique identifier for the DICOM interface
- **clientId**: Client identifier from the configuration service

## Optional Fields

- **timestamp**: ISO timestamp (defaults to current time)
- **status**: Service status (defaults to "healthy")
- **metadata**: Additional service information (DICOM port, AE title, etc.)

## Environment Variables

- **INTERFACE_SERVERS_TABLE_NAME**: Name of the DynamoDB table to update

## DynamoDB Table Structure

The function updates the `interface-servers` table with the following structure:

```json
{
  "interfaceId": "default-dicom-interface",
  "clientId": "client-123",
  "lastHeartbeat": "2024-07-29T17:00:00.000Z",
  "status": "healthy",
  "metadata": {
    "dicomPort": 11112,
    "aeTitle": "EDGEDEVICE",
    "version": "1.0.0"
  },
  "updatedAt": "2024-07-29T17:00:00.000Z"
}
```

## Response Format

### Success Response
```json
{
  "success": true,
  "interfaceId": "default-dicom-interface",
  "clientId": "client-123",
  "timestamp": "2024-07-29T17:00:00.000Z",
  "status": "healthy",
  "updatedItem": { ... }
}
```

### Error Response
```json
{
  "error": "Error message",
  "message": "Detailed error description"
}
```

## Integration with DICOM Service

The DICOM interface service sends heartbeat messages using the `SimpleHeartbeatService`:

1. Service starts and gets `clientId` from configuration
2. Periodically sends heartbeat messages (every 60 seconds)
3. Messages include interface status and metadata
4. This Lambda function processes the messages and updates DynamoDB

## Monitoring and Alerting

The updated `interface-servers` table can be monitored to:

- Detect unresponsive DICOM interfaces
- Track service health over time
- Generate alerts for failed services
- Provide dashboards for operational visibility

## Error Handling

The function includes comprehensive error handling:

- Validates required fields
- Handles different event source formats
- Provides detailed error messages
- Supports retry mechanisms (via SQS DLQ)

## Testing

Test the function with different event types:

```bash
# API Gateway test
aws lambda invoke --function-name heartbeat-updater \
  --payload '{"httpMethod":"POST","body":"{\"interfaceId\":\"test\",\"clientId\":\"test-client\"}"}' \
  response.json

# Direct invocation test
aws lambda invoke --function-name heartbeat-updater \
  --payload '{"interfaceId":"test","clientId":"test-client","status":"healthy"}' \
  response.json
```
