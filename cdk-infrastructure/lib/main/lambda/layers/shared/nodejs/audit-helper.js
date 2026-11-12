const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');

const eventBridgeClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME;

// F06 backstop: audit records must never carry certificate/private-key material,
// even if a caller forgets to sanitize its payload. Any object key matching one
// of these (case-insensitive substring) is replaced with '[REDACTED]' before the
// event is serialized. This is a defense-in-depth net at the shared boundary; the
// primary responsibility still lies with callers passing already-scrubbed values.
const SENSITIVE_KEY_PATTERNS = [
  'certificate_data', 'certificatedata',
  'private_key', 'privatekey',
  'certificate.pem', 'private_key.pem',
  'ca_certificate', 'ca-certificate', 'cacertificate',
  'zippassword', 'zip_password', 'config_zip_password',
  'secret', 'password', 'passphrase',
];

function scrubSensitive(value, depth = 0) {
  // Bound recursion so a cyclic/huge payload cannot wedge the audit path.
  if (value === null || value === undefined || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => scrubSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const kl = k.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => kl.includes(p))) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = scrubSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// Map AUDIT_ACTIONS to EventBridge detail-types
const ACTION_TO_DETAIL_TYPE = {
  CREATE_USER: 'UserCreated',
  UPDATE_USER: 'UserUpdated',
  RESET_USER_PASSWORD: 'UserPasswordReset',
  RESET_USER_MFA: 'UserMfaReset',
  DELETE_USER: 'UserDeleted',
  CREATE_DATASTORE: 'DatastoreCreated',
  UPDATE_DATASTORE: 'DatastoreUpdated',
  DELETE_DATASTORE: 'DatastoreDeleted',
  CREATE_INTERFACE: 'InterfaceCreated',
  UPDATE_INTERFACE: 'InterfaceUpdated',
  DELETE_INTERFACE: 'InterfaceDeleted',
  CREATE_IMPORT_JOB: 'ImportJobCreated',
  START_IMPORT_JOB: 'ImportJobStarted',
  COMPLETE_IMPORT_JOB: 'ImportJobCompleted',
  FAIL_IMPORT_JOB: 'ImportJobFailed',
  CREATE_ENTITY: 'EntityCreated',
  UPDATE_ENTITY: 'EntityUpdated',
  DELETE_ENTITY: 'EntityDeleted',
  CREATE_PRIVILEGE: 'PrivilegeCreated',
  UPDATE_PRIVILEGE: 'PrivilegeUpdated',
  DELETE_PRIVILEGE: 'PrivilegeDeleted',
  CREATE_PRIVILEGE_GROUP: 'PrivilegeGroupCreated',
  UPDATE_PRIVILEGE_GROUP: 'PrivilegeGroupUpdated',
  DELETE_PRIVILEGE_GROUP: 'PrivilegeGroupDeleted',
  CREATE_LOCATION: 'LocationCreated',
  UPDATE_LOCATION: 'LocationUpdated',
  DELETE_LOCATION: 'LocationDeleted',
  CREATE_ROUTING_RULE: 'RoutingRuleCreated',
  UPDATE_ROUTING_RULE: 'RoutingRuleUpdated',
  DELETE_ROUTING_RULE: 'RoutingRuleDeleted',
  CREATE_VIRTUAL_FOLDER: 'VirtualFolderCreated',
  UPDATE_VIRTUAL_FOLDER: 'VirtualFolderUpdated',
  DELETE_VIRTUAL_FOLDER: 'VirtualFolderDeleted',
  CREATE_ASSIGNMENT_RULE: 'AssignmentRuleCreated',
  UPDATE_ASSIGNMENT_RULE: 'AssignmentRuleUpdated',
  DELETE_ASSIGNMENT_RULE: 'AssignmentRuleDeleted',
  CREATE_DEID_PROFILE: 'DeidProfileCreated',
  UPDATE_DEID_PROFILE: 'DeidProfileUpdated',
  DELETE_DEID_PROFILE: 'DeidProfileDeleted',
  CREATE_INDEXING_PROFILE: 'IndexingProfileCreated',
  UPDATE_INDEXING_PROFILE: 'IndexingProfileUpdated',
  DELETE_INDEXING_PROFILE: 'IndexingProfileDeleted',
  ASSIGN_STUDY_TO_VIRTUAL_FOLDER: 'StudyAssignedToVirtualFolder',
  ASSIGN_SERIES_TO_VIRTUAL_FOLDER: 'SeriesAssignedToVirtualFolder',
  REMOVE_ASSIGNMENT_FROM_VIRTUAL_FOLDER: 'AssignmentRemovedFromVirtualFolder',
  CREATE_NON_DICOM_IMPORT: 'NonDicomImportCreated',
  DELETE_NON_DICOM_IMPORT: 'NonDicomImportDeleted',
  PROCESS_NON_DICOM_IMPORT: 'NonDicomImportProcessing',
  COMPLETE_NON_DICOM_IMPORT: 'NonDicomImportCompleted',
  FAIL_NON_DICOM_IMPORT: 'NonDicomImportFailed',
  // Non-DICOM Import V2: AI analysis of one uploaded file. Emitted by the
  // Python non-dicom-import-v2-api (its audit.py uses the same names).
  ANALYZE_DOCUMENT: 'DocumentAnalyzed',
  DELETE_SERIES: 'SeriesDeleted',
  DELETE_SERIES_REQUESTED: 'SeriesDeletionRequested',
  DELETE_SERIES_FAILED: 'SeriesDeletionFailed',
  DOWNLOAD_STUDY: 'StudyDownloaded',
  ACCESS_DENIED: 'AccessDenied'
};

async function sendAuditEvent(event) {
  if (!EVENT_BUS_NAME) {
    console.warn('EVENT_BUS_NAME not set, skipping audit event');
    return;
  }

  try {
    const detailType = ACTION_TO_DETAIL_TYPE[event.action] || event.action;
    // Defense-in-depth: strip any certificate/key/secret fields before persisting.
    const safeEvent = scrubSensitive(event);

    if (!event || typeof event !== 'object' || !event.action) {
      // Security: a malformed call is reported loudly instead of producing an
      // event the audit writer silently drops.
      console.error('Audit event rejected: sendAuditEvent needs one object with an action', { type: typeof event });
      return;
    }
    const result = await eventBridgeClient.send(new PutEventsCommand({
      Entries: [{
        Source: 'dicom.archive',
        DetailType: detailType,
        Detail: JSON.stringify(safeEvent),
        EventBusName: EVENT_BUS_NAME
      }]
    }));
    if (result && result.FailedEntryCount) {
      console.error('Audit event NOT accepted by EventBridge', { action: event.action, entries: result.Entries });
    }
    
    console.log('Audit event sent to EventBridge', { action: event.action, detailType });
  } catch (error) {
    console.error('Failed to send audit event to EventBridge', { error: error.message });
  }
}

const AUDIT_ACTIONS = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  CREATE_DATASTORE: 'CREATE_DATASTORE',
  UPDATE_DATASTORE: 'UPDATE_DATASTORE',
  DELETE_DATASTORE: 'DELETE_DATASTORE',
  CREATE_INTERFACE: 'CREATE_INTERFACE',
  UPDATE_INTERFACE: 'UPDATE_INTERFACE',
  DELETE_INTERFACE: 'DELETE_INTERFACE',
  CREATE_IMPORT_JOB: 'CREATE_IMPORT_JOB',
  START_IMPORT_JOB: 'START_IMPORT_JOB',
  COMPLETE_IMPORT_JOB: 'COMPLETE_IMPORT_JOB',
  FAIL_IMPORT_JOB: 'FAIL_IMPORT_JOB',
  CREATE_ENTITY: 'CREATE_ENTITY',
  UPDATE_ENTITY: 'UPDATE_ENTITY',
  DELETE_ENTITY: 'DELETE_ENTITY',
  CREATE_PRIVILEGE: 'CREATE_PRIVILEGE',
  UPDATE_PRIVILEGE: 'UPDATE_PRIVILEGE',
  DELETE_PRIVILEGE: 'DELETE_PRIVILEGE',
  CREATE_PRIVILEGE_GROUP: 'CREATE_PRIVILEGE_GROUP',
  UPDATE_PRIVILEGE_GROUP: 'UPDATE_PRIVILEGE_GROUP',
  DELETE_PRIVILEGE_GROUP: 'DELETE_PRIVILEGE_GROUP',
  CREATE_USER: 'CREATE_USER',
  UPDATE_USER: 'UPDATE_USER',
  RESET_USER_PASSWORD: 'RESET_USER_PASSWORD',
  RESET_USER_MFA: 'RESET_USER_MFA',
  DELETE_USER: 'DELETE_USER',
  CREATE_LOCATION: 'CREATE_LOCATION',
  UPDATE_LOCATION: 'UPDATE_LOCATION',
  DELETE_LOCATION: 'DELETE_LOCATION',
  CREATE_ROUTING_RULE: 'CREATE_ROUTING_RULE',
  UPDATE_ROUTING_RULE: 'UPDATE_ROUTING_RULE',
  DELETE_ROUTING_RULE: 'DELETE_ROUTING_RULE',
  CREATE_VIRTUAL_FOLDER: 'CREATE_VIRTUAL_FOLDER',
  UPDATE_VIRTUAL_FOLDER: 'UPDATE_VIRTUAL_FOLDER',
  DELETE_VIRTUAL_FOLDER: 'DELETE_VIRTUAL_FOLDER',
  ASSIGN_STUDY_TO_VIRTUAL_FOLDER: 'ASSIGN_STUDY_TO_VIRTUAL_FOLDER',
  ASSIGN_SERIES_TO_VIRTUAL_FOLDER: 'ASSIGN_SERIES_TO_VIRTUAL_FOLDER',
  REMOVE_ASSIGNMENT_FROM_VIRTUAL_FOLDER: 'REMOVE_ASSIGNMENT_FROM_VIRTUAL_FOLDER',
  CREATE_NON_DICOM_IMPORT: 'CREATE_NON_DICOM_IMPORT',
  DELETE_NON_DICOM_IMPORT: 'DELETE_NON_DICOM_IMPORT',
  PROCESS_NON_DICOM_IMPORT: 'PROCESS_NON_DICOM_IMPORT',
  COMPLETE_NON_DICOM_IMPORT: 'COMPLETE_NON_DICOM_IMPORT',
  FAIL_NON_DICOM_IMPORT: 'FAIL_NON_DICOM_IMPORT',
  ANALYZE_DOCUMENT: 'ANALYZE_DOCUMENT',
  DELETE_SERIES: 'DELETE_SERIES',
  DELETE_SERIES_REQUESTED: 'DELETE_SERIES_REQUESTED',
  DELETE_SERIES_FAILED: 'DELETE_SERIES_FAILED',
  // A study exported as a .zip (canDownload). Emitted by the DICOMweb service
  // (interface-container/dicomweb-s3/audit_events.py ACTION_DOWNLOAD, same string).
  DOWNLOAD_STUDY: 'DOWNLOAD_STUDY',
  // S14: authorization denial (recorded by the API authorizer on a blocked request).
  ACCESS_DENIED: 'ACCESS_DENIED'
};

const RESOURCE_TYPES = {
  DATASTORE: 'datastore',
  DICOM_INTERFACE: 'dicom_interface',
  IMPORT_JOB: 'import_job',
  DICOM_ENTITY: 'dicom_entity',
  DICOM_PRIVILEGE: 'dicom_privilege',
  PRIVILEGE_GROUP: 'privilege_group',
  USER: 'user',
  LOCATION: 'location',
  ROUTING_RULE: 'routing_rule',
  VIRTUAL_FOLDER: 'virtual_folder',
  VIRTUAL_FOLDER_ASSIGNMENT: 'virtual_folder_assignment',
  NON_DICOM_IMPORT: 'non_dicom_import',
  SERIES: 'series',
  ACCESS_CONTROL: 'access_control'

};

module.exports = {
  sendAuditEvent,
  AUDIT_ACTIONS,
  RESOURCE_TYPES
};
