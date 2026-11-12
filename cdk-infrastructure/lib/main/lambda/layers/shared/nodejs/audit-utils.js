const { SQSClient, SendMessageCommand  } = require('@aws-sdk/client-sqs');

const sqsClient = new SQSClient({});

/**
 * Send an audit event to the audit trail SQS queue
 */
export async function sendAuditEvent(auditEvent, queueUrl?: string) {
  const auditQueueUrl = queueUrl || process.env.AUDIT_QUEUE_URL;
  
  if (!auditQueueUrl) {
    console.warn('AUDIT_QUEUE_URL not configured, skipping audit event');
    return;
  }

  try {
    const auditEntry = {
      id: generateAuditId(),
      timestamp: new Date().toISOString(),
      ...auditEvent
    };

    console.log('📋 Sending audit event:', {
      action: auditEntry.action,
      category: auditEntry.category,
      status: auditEntry.status
    });

    await sqsClient.send(new SendMessageCommand({
      QueueUrl,
      MessageBody: JSON.stringify(auditEntry),
      MessageGroupId: auditEntry.action, // Use action group for FIFO
      MessageDeduplicationId: `${auditEntry.id}-${Date.now()}` // Ensure uniqueness
    }));

    console.log('✅ Audit event sent successfully');

  } catch (error) {
    console.error('❌ Failed to send audit event:', error.message);
    // Don't throw error - audit failures shouldn't break main functionality
  }
}

/**
 * Generate a unique audit ID
 */
function generateAuditId() {
  return `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Helper function to create storage creation audit event
 */
export function createStorageCreationAuditEvent(
  user,
  storageName,
  datastoreId,
  s3BucketName,
  status: 'SUCCESS' | 'FAILED',
  errorMessage?: string
) {
  const description = status === 'SUCCESS'
    ? `Successfully created storage "${storageName}" with datastore ID ${datastoreId} and S3 bucket ${s3BucketName}`
    : `Failed to create storage "${storageName}": ${errorMessage || 'Unknown error'}`;

  return {
    user,
    action: 'storage:create',
    category: 'storage',
    description,
    resourceId,
    resourceType: 'datastore',
    status,
    errorMessage,
    metadata,
      s3BucketName,
      operation: 'create'
    }
  };
}

/**
 * Helper function to create storage deletion audit event
 */
export function createStorageDeletionAuditEvent(
  user,
  storageName,
  datastoreId,
  s3BucketName,
  status: 'SUCCESS' | 'FAILED',
  errorMessage?: string
) {
  const description = status === 'SUCCESS'
    ? `Successfully deleted storage "${storageName}" with datastore ID ${datastoreId} and S3 bucket ${s3BucketName}`
    : `Failed to delete storage "${storageName}": ${errorMessage || 'Unknown error'}`;

  return {
    user,
    action: 'storage:delete',
    category: 'storage',
    description,
    resourceId,
    resourceType: 'datastore',
    status,
    errorMessage,
    metadata,
      s3BucketName,
      operation: 'delete'
    }
  };
}

/**
 * Helper function to create DICOM interface creation audit event
 */
export function createDicomInterfaceCreationAuditEvent(
  user,
  interfaceName,
  interfaceId,
  status: 'SUCCESS' | 'FAILED',
  errorMessage?: string,
  metadata?: Record<string, any>
) {
  const description = status === 'SUCCESS'
    ? `Successfully created DICOM interface "${interfaceName}" with ID ${interfaceId}`
    : `Failed to create DICOM interface "${interfaceName}": ${errorMessage || 'Unknown error'}`;

  return {
    user,
    action: 'dicom-interface:create',
    category: 'configuration',
    description,
    resourceId,
    resourceType: 'dicom_interface',
    status,
    errorMessage,
    metadata,
      operation: 'create',
      ...metadata
    }
  };
}

/**
 * Helper function to create DICOM interface deletion audit event
 */
export function createDicomInterfaceDeletionAuditEvent(
  user,
  interfaceName,
  interfaceId,
  status: 'SUCCESS' | 'FAILED',
  errorMessage?: string,
  metadata?: Record<string, any>
) {
  const description = status === 'SUCCESS'
    ? `Successfully deleted DICOM interface "${interfaceName}" with ID ${interfaceId}`
    : `Failed to delete DICOM interface "${interfaceName}": ${errorMessage || 'Unknown error'}`;

  return {
    user,
    action: 'dicom-interface:delete',
    category: 'configuration',
    description,
    resourceId,
    resourceType: 'dicom_interface',
    status,
    errorMessage,
    metadata,
      operation: 'delete',
      ...metadata
    }
  };
}

/**
 * Helper function to create DICOM entity creation audit event
 */
export function createDicomEntityCreationAuditEvent(
  user,
  entityTitle,
  entityId,
  status: 'SUCCESS' | 'FAILED',
  errorMessage?: string,
  metadata?: Record<string, any>
) {
  const description = status === 'SUCCESS'
    ? `Successfully created DICOM entity "${entityTitle}" with ID ${entityId}`
    : `Failed to create DICOM entity "${entityTitle}": ${errorMessage || 'Unknown error'}`;

  return {
    user,
    action: 'dicom-entity:create',
    category: 'configuration',
    description,
    resourceId,
    resourceType: 'dicom_entity',
    status,
    errorMessage,
    metadata,
      operation: 'create',
      ...metadata
    }
  };
}

/**
 * Helper function to create DICOM entity deletion audit event
 */
export function createDicomEntityDeletionAuditEvent(
  user,
  entityTitle,
  entityId,
  status: 'SUCCESS' | 'FAILED',
  errorMessage?: string,
  metadata?: Record<string, any>
) {
  const description = status === 'SUCCESS'
    ? `Successfully deleted DICOM entity "${entityTitle}" with ID ${entityId}`
    : `Failed to delete DICOM entity "${entityTitle}": ${errorMessage || 'Unknown error'}`;

  return {
    user,
    action: 'dicom-entity:delete',
    category: 'configuration',
    description,
    resourceId,
    resourceType: 'dicom_entity',
    status,
    errorMessage,
    metadata,
      operation: 'delete',
      ...metadata
    }
  };
}

/**
 * Helper function to create DICOM entity update audit event
 */
export function createDicomEntityUpdateAuditEvent(
  user,
  entityTitle,
  entityId,
  attributesDiff,
  privilegesDiff,
  currentState,
  status: 'SUCCESS' | 'FAILED',
  errorMessage?: string
) {
  const changes = [];
  
  if (Object.keys(attributesDiff).length > 0) {
    changes.push('DICOM attributes');
  }
  
  if (Object.keys(privilegesDiff).length > 0) {
    changes.push('privileges');
  }

  const description = status === 'SUCCESS'
    ? `Successfully updated DICOM entity "${entityTitle}" - Changed: ${changes.join(', ')}`
    : `Failed to update DICOM entity "${entityTitle}": ${errorMessage || 'Unknown error'}`;

  return {
    user,
    action: 'dicom-entity:update',
    category: 'configuration',
    description,
    resourceId,
    resourceType: 'dicom_entity',
    status,
    errorMessage,
    metadata,
      operation: 'update',
      attributesDiff,
      privilegesDiff,
      currentState,
      changedFields: changes
    }
  };
}
