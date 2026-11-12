// Common types used across the application

export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
  errors?: string[];
}

export interface PaginatedResponse<T> {
  items: T[];
  totalCount: number;
  pageSize: number;
  currentPage: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// Datastore types
export interface Datastore {
  id: string;
  name: string;
  dicomInterfaces: string[];
  status: 'active' | 'inactive' | 'maintenance';
  studies: number;
  storage: string;
  createdDate: string;
  createdAt?: string; // API returns this field
  s3BucketName: string;
  s3BucketArn: string;
  imported?: boolean;
  // Access level for an imported bucket: 'read-only' (archive never writes) or
  // 'read-write'. Undefined/null for a normal app-owned S3 datastore.
  accessLevel?: 'read-only' | 'read-write' | null;
  access_level?: 'read-only' | 'read-write' | null;
  datastoreArn?: string;
  datastore_arn?: string;
  kmsKeyId?: string;
  description?: string;
  readOnlyRoleArn?: string;
  read_only_role_arn?: string;
  storeRoleArn?: string;
  store_role_arn?: string;
  // Statistics fields
  studyCount?: number;
  study_count?: number;
  seriesCount?: number;
  series_count?: number;
  instanceCount?: number;
  instance_count?: number;
  totalSizeBytes?: number;
  total_size_bytes?: number;
  losslessFormat?: 'JPEG2000' | 'HTJ2K';
  lossless_format?: 'JPEG2000' | 'HTJ2K';
  // Every datastore is S3-backed now. Retained (optional) because several
  // components still read it; it is always 'S3' when present.
  storageType?: 'S3';
  s3Prefix?: string | null;
  s3_prefix?: string | null;
}

export interface CreateDatastoreRequest {
  name: string;
  description?: string;
  createAccessRoles?: boolean;
  losslessFormat?: 'JPEG2000' | 'HTJ2K';
  /** Every datastore is S3-backed; always 'S3' when present. */
  storageType?: 'S3';
  /** Relative key prefix inside the per-datastore archive bucket. */
  s3Prefix?: string;
}

export interface UpdateDatastoreRequest extends Partial<CreateDatastoreRequest> {
  status?: 'active' | 'inactive' | 'maintenance';
}

// Interface Infrastructure types
export interface InterfaceInfrastructure {
  id: string;
  name: string;
  infrastructureType: 'FARGATE' | 'ON_PREMISE';
  status: 'active' | 'inactive' | 'deploying' | 'error' | 'warning';
  ports: {
    dicomPort: number;
    hl7Port: number;
  };
  location: string;
  deploymentDetails: {
    region?: string;
    availabilityZones?: string[];
    greengrassGroupId?: string;
    deviceId?: string;
  };
  monitoringConfig: {
    heartbeatInterval: number;
    lastHeartbeat?: string;
    healthStatus: 'healthy' | 'warning' | 'critical';
  };
  dicomInterfaceCount: number;
  hl7InterfaceCount: number;
  createdDate: string;
  lastUpdated: string;
}

export interface CreateInfrastructureRequest {
  name: string;
  infrastructureType: 'FARGATE' | 'ON_PREMISE';
  ports: {
    dicomPort: number;
    hl7Port: number;
  };
  location: string;
  deploymentDetails?: {
    region?: string;
    availabilityZones?: string[];
    greengrassGroupId?: string;
    deviceId?: string;
  };
}

export interface UpdateInfrastructureRequest extends Partial<CreateInfrastructureRequest> {
  status?: 'active' | 'inactive' | 'warning';
}

// DICOM Interface API Response types
export interface DicomInterfaceListResponse extends PaginatedResponse<DicomInterface> {}
export interface DicomInterface {
  id: string;
  interfaceName: string;
  aeTitle: string;
  description: string;
  status: 'ACTIVE' | 'INACTIVE' | 'CREATING' | 'DELETING' | 'ERROR';
  serviceType: 'SCP' | 'SCU';
  protocol: 'DIMSE';
  hostname: string;
  locationId?: string;
  locationName?: string;
  accessibleDatastores?: string[];
  sopClasses: string[];
  transferSyntaxes: string[];
  configuration: {
    logLevel: string;
    threadCount: number;
    storageThrottle: number;
    storageOor: number;
    s3TransferAcceleration: boolean;
  };
  infrastructure: {
    type: 'ECS_FARGATE';
    clusterName: string;
    serviceName: string;
    loadBalancerDns: string;
    queueUrl: string;
    bucketName: string;
  };
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface CreateDicomInterfaceRequest {
  name: string;
  aeTitle: string;
  description?: string;
  serviceType: 'SCP' | 'SCU';
  protocol: 'DIMSE';
  locationId?: string;
  accessibleDatastores?: string[];
  sopClasses: string[];
  transferSyntaxes: string[];
  configuration: {
    logLevel: string;
    threadCount: number;
    storageThrottle: number;
    storageOor: number;
    s3TransferAcceleration: boolean;
  };
}

export interface UpdateDicomInterfaceRequest extends Partial<CreateDicomInterfaceRequest> {
  status?: 'ACTIVE' | 'INACTIVE' | 'ERROR';
}

// HL7 Interface types (updated for two-layer architecture)
export interface Hl7Interface {
  id: string;
  name: string;
  application: string;
  facility: string;
  description: string;
  infrastructureId: string;
  infrastructureName: string;
  status: 'active' | 'inactive' | 'deploying' | 'error';
  messageProfilingRules: string[];
  associatedDatastores: string[];
  messageTypes: string[];
  createdDate: string;
  lastUpdated: string;
}

export interface CreateHl7InterfaceRequest {
  name: string;
  application: string;
  facility: string;
  description: string;
  infrastructureId: string;
  messageTypes: string[];
  messageProfilingRules: string[];
  associatedDatastores: string[];
}

export interface UpdateHl7InterfaceRequest extends Partial<CreateHl7InterfaceRequest> {
  status?: 'active' | 'inactive';
}

// Study types
export interface Study {
  id: string;
  studyInstanceUID: string;
  patientId: string;
  patientName: string;
  studyDate: string;
  studyTime: string;
  modality: string;
  studyDescription: string;
  accessionNumber: string;
  referringPhysician: string;
  seriesCount: number;
  instanceCount: number;
  datastoreId: string;
  datastoreName: string;
  status: 'available' | 'importing' | 'error';
  createdDate: string;
  lastUpdated: string;
}

export interface StudyFilters extends ListParams {
  patientId?: string;
  modality?: string;
  studyDateFrom?: string;
  studyDateTo?: string;
  datastoreId?: string;
  status?: string;
}

// User types
export interface User {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  groups: string[];
  status: 'active' | 'inactive' | 'pending';
  mfaEnabled?: boolean;
  lastLogin?: string;
  createdDate: string;
  lastUpdated: string;
}

export interface CreateUserRequest {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  groups: string[];
  temporaryPassword?: string;
  mfaEnabled?: boolean;
}

export interface UpdateUserRequest extends Partial<CreateUserRequest> {
  status?: 'active' | 'inactive';
}

// HL7 Entity types
export interface Hl7Entity {
  id: string;
  name: string;
  application: string;
  facility: string;
  description: string;
  ipAddress: string;
  port: number;
  protocol: 'MLLP' | 'HTTP' | 'HTTPS';
  status: 'active' | 'inactive';
  messageTypes: string[];
  createdDate: string;
  lastUpdated: string;
}

export interface CreateHl7EntityRequest {
  name: string;
  application: string;
  facility: string;
  description: string;
  ipAddress: string;
  port: number;
  protocol: 'MLLP' | 'HTTP' | 'HTTPS';
  messageTypes: string[];
}

export interface UpdateHl7EntityRequest extends Partial<CreateHl7EntityRequest> {
  status?: 'active' | 'inactive';
}

// Import Job types
export interface ImportJob {
  id: string;
  jobName: string;
  jobType: 'DICOM_IMPORT' | 'BULK_IMPORT' | 'SCHEDULED_IMPORT' | 'DIMSE_IMPORT' | 'STOW_IMPORT' | 'UPLOAD_IMPORT';
  status: 'PENDING' | 'TRIGGERED' | 'IN_PROGRESS' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PAUSED' | 'COMPLETED_WITH_FAILURES';
  statusDescription?: string;
  
  // Source Configuration
  sourceLocation: string;
  sourceType: 'S3' | 'LOCAL' | 'PACS' | 'URL' | 'DICOM_ASSOCIATION';
  inputS3Uri?: string;
  outputS3Uri?: string;
  
  // DICOM Context
  dicomContext?: {
    interfaceId: string;
    interfaceName: string;
    aeTitle: string;          // Interface AE Title (called AE)
    callingAeTitle: string;   // Client AE Title (calling AE)
    studyInstanceUid?: string;
    seriesInstanceUid?: string;
  };
  
  // Destination
  datastoreId: string;
  datastoreName: string;
  
  // Statistics (from API)
  totalFiles?: number;
  processedFiles?: number;
  failedFiles?: number;
  imagesetsCreated?: number;
  instancesImported?: number;
  errorMessage?: string;
  failureMessage?: string;
  errorDetails?: Array<{
    message: string;
    count: number;
    severity: 'warning' | 'failure';
  }>;
  s3CleanupStatus?: string;
  s3CleanupDate?: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  
  // Progress Tracking
  progress: {
    totalFiles: number;
    processedFiles: number;
    successfulFiles: number;
    failedFiles: number;
    skippedFiles: number;
    currentFile?: string;
    estimatedCompletion?: string;
    throughputMbps?: number;
  };
  
  // Results & Statistics
  results?: {
    importedStudies: number;
    importedSeries: number;
    importedInstances: number;
    totalSizeMb: number;
    processingTimeMs: number;
    errors: Array<{
      file: string;
      error: string;
      timestamp: string;
    }>;
  };
  
  // Processing Configuration
  processingOptions: {
    validateDicom: boolean;
    generateThumbnails: boolean;
    extractMetadata: boolean;
    overwriteExisting: boolean;
    batchSize: number;
    maxRetries: number;
  };
  
  // Scheduling (for scheduled imports)
  schedule?: {
    cronExpression: string;
    nextRun?: string;
    lastRun?: string;
    isActive: boolean;
  };
  
  // Metadata
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  tags: Record<string, string>;
}

export interface ImportJobFilters extends ListParams {
  status?: string;
  jobType?: string;
  datastoreId?: string;
  calledAeTitle?: string;
  callingAeTitle?: string;
  createdDateFrom?: string;
  createdDateTo?: string;
  createdBy?: string;
}

export interface CreateImportJobRequest {
  jobName: string;
  jobType: 'DICOM_IMPORT' | 'BULK_IMPORT' | 'SCHEDULED_IMPORT';
  sourceLocation: string;
  sourceType: 'S3' | 'LOCAL' | 'PACS' | 'URL';
  datastoreId: string;
  processingOptions: {
    validateDicom: boolean;
    generateThumbnails: boolean;
    extractMetadata: boolean;
    overwriteExisting: boolean;
    batchSize: number;
    maxRetries: number;
  };
  schedule?: {
    cronExpression: string;
    isActive: boolean;
  };
  tags?: Record<string, string>;
}

export interface UpdateImportJobRequest extends Partial<CreateImportJobRequest> {
  status?: 'PENDING' | 'TRIGGERED' | 'IN_PROGRESS' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'PAUSED' | 'COMPLETED_WITH_FAILURES';
}

// Dashboard types
export interface DashboardStats {
  totalDatastores: number;
  totalStudies: number;
  totalStorage: string;
  activeInterfaces: number;
  recentImports: number;
  systemHealth: 'healthy' | 'warning' | 'critical';
}

export interface RecentActivity {
  id: string;
  type: 'import' | 'export' | 'error' | 'system';
  message: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'error';
}

export interface ChartDataPoint {
  title: string;
  value: number;
  color: string;
}

export interface TimeSeriesDataPoint {
  x: Date;
  y: number;
}

export interface UtilizationDataPoint {
  name: string;
  value: number;
  color: string;
}

// Audit Trail types
export interface AuditEntry {
  id: string;
  user: string; // Username or 'system' for system-initiated actions
  action: string; // The action performed (e.g., 'CREATE_DATASTORE', 'DELETE_STUDY', etc.)
  category?: string; // Category of the action (e.g., 'DICOM', 'HL7', 'SYSTEM', etc.)
  description: string; // Free text description of the action
  timestamp: string; // ISO timestamp of when the action occurred
  // Optional additional fields for context
  resourceId?: string; // ID of the resource affected (datastore ID, study ID, etc.)
  resourceType?: string; // Type of resource (datastore, study, interface, etc.)
  resourceName?: string; // Name of the resource
  ipAddress?: string; // IP address of the user/system
  userAgent?: string; // User agent string for UI actions
  requestId?: string; // Request ID for tracing
  status?: 'SUCCESS' | 'FAILURE' | 'FAILED' | 'PENDING'; // Status (backend stores SUCCESS/FAILURE)
  errorMessage?: string; // Error message if action failed
  datastoreId?: string; // Tenancy dimension (from new_values.datastoreId on data-plane rows)
  oldValues?: any; // Previous values for change tracking
  newValues?: any; // New values for change tracking
  changes?: Array<{
    field: string;
    action: 'added' | 'changed' | 'removed';
    oldValue: any;
    newValue: any;
  }>; // Detailed field changes
}

export interface AuditFilters extends ListParams {
  user?: string;
  action?: string;
  actionPrefix?: string;
  category?: string;
  resourceType?: string;
  datastoreId?: string;
  status?: string;
  timestampFrom?: string;
  timestampTo?: string;
}
