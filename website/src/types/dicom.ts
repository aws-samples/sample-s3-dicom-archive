// DICOM Entity Types - Represents clients/applications that connect to DICOM interfaces
export interface DicomEntity {
  id: string;
  entityType: DicomEntityType;
  name: string;
  aeTitle: string;
  description?: string;
  host?: string;
  hostname?: string;
  port?: number;
  status: DicomEntityStatus;
  dicomPrivileges: DicomInterfacePrivilege[];
  privilegeCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  tags?: Record<string, string>;
}

export type DicomEntityType = 'CLIENT' | 'APPLICATION' | 'WORKSTATION' | 'PACS' | 'VIEWER' | 'OTHER';

export type DicomEntityStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING_APPROVAL';

// Privilege types that can be granted to entities per interface
export type DicomPrivilegeType = 'STORE' | 'QUERY' | 'RETRIEVE';

export interface DicomInterfacePrivilege {
  id: string;
  interfaceId: string;
  canStore: boolean;
  canQuery: boolean;
  canRetrieve: boolean;
}

// Request format for privileges in CREATE operations (no ID needed)
export interface DicomPrivilegeRequest {
  interfaceId: string;
  store: boolean;
  query: boolean;
  retrieve: boolean;
}

// Request format for privileges in UPDATE operations (ID optional for new interfaces)
export interface DicomPrivilegeUpdateRequest {
  id?: string; // Optional - empty/missing for new privileges on new interfaces, present for existing ones
  interfaceId: string;
  store: boolean;
  query: boolean;
  retrieve: boolean;
}

export interface CreateDicomEntityRequest {
  entityType: DicomEntityType;
  name: string;
  aeTitle: string;
  description?: string;
  hostname?: string;
  port?: string;
  tags?: Record<string, string>;
  dicomPrivileges?: DicomPrivilegeRequest[]; // Added privileges to create request
}

export interface UpdateDicomEntityRequest {
  entityType?: DicomEntityType;
  name?: string;
  aeTitle?: string;
  description?: string;
  hostname?: string;
  port?: string;
  status?: DicomEntityStatus;
  tags?: Record<string, string>;
  dicomPrivileges?: DicomPrivilegeUpdateRequest[]; // Use update version with required IDs
}

export interface DicomEntitySummary {
  id: string;
  entityType: DicomEntityType;
  name: string;
  aeTitle: string;
  status: DicomEntityStatus;
  privilegeCount: number;
  createdAt: string;
}

export interface UpdateEntityPrivilegesRequest {
  privileges: DicomPrivilegeType[];
  expiresAt?: string;
}

export interface ListDicomEntitiesResponse {
  entities: DicomEntitySummary[];
  nextToken?: string;
  totalCount: number;
}

// DICOM Study and Series Types
export interface DicomStudy {
  studyInstanceUID: string;
  patientID: string;
  patientName: string;
  studyDate: string;
  studyTime: string;
  studyDescription: string;
  modality: string;
  accessionNumber: string;
  seriesCount: number;
  instanceCount: number;
  studySize: number;
  datastoreId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DicomSeries {
  seriesInstanceUID: string;
  studyInstanceUID: string;
  seriesNumber: string;
  seriesDescription: string;
  modality: string;
  instanceCount: number;
  seriesSize: number;
  createdAt: string;
}

export interface DicomInstance {
  sopInstanceUID: string;
  seriesInstanceUID: string;
  studyInstanceUID: string;
  instanceNumber: string;
  sopClassUID: string;
  transferSyntaxUID: string;
  instanceSize: number;
  s3Key: string;
  createdAt: string;
}

// Standard DICOM SOP Classes
export const STANDARD_SOP_CLASSES = [
  { uid: '1.2.840.10008.5.1.4.1.1.2', name: 'CT Image Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.4', name: 'MR Image Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.1', name: 'Computed Radiography Image Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.6.1', name: 'Ultrasound Image Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.12.1', name: 'X-Ray Angiographic Image Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.20', name:'Nuclear Medicine Image Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.481.1', name: 'RT Image Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.481.2', name: 'RT Dose Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.481.3', name: 'RT Structure Set Storage' },
  { uid: '1.2.840.10008.5.1.4.1.1.481.5', name: 'RT Plan Storage' }
];

// Standard Transfer Syntaxes
export const STANDARD_TRANSFER_SYNTAXES = [
  { uid: '1.2.840.10008.1.2', name: 'Implicit VR Little Endian' },
  { uid: '1.2.840.10008.1.2.1', name: 'Explicit VR Little Endian' },
  { uid: '1.2.840.10008.1.2.2', name: 'Explicit VR Big Endian' },
  { uid: '1.2.840.10008.1.2.4.50', name: 'JPEG Baseline (Process 1)' },
  { uid: '1.2.840.10008.1.2.4.51', name: 'JPEG Extended (Process 2 & 4)' },
  { uid: '1.2.840.10008.1.2.4.57', name: 'JPEG Lossless, Non-Hierarchical (Process 14)' },
  { uid: '1.2.840.10008.1.2.4.70', name: 'JPEG Lossless, Non-Hierarchical, First-Order Prediction' },
  { uid: '1.2.840.10008.1.2.4.80', name: 'JPEG-LS Lossless Image Compression' },
  { uid: '1.2.840.10008.1.2.4.81', name: 'JPEG-LS Lossy (Near-Lossless) Image Compression' },
  { uid: '1.2.840.10008.1.2.5', name: 'RLE Lossless' }
];

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  requestId?: string;
}

export interface AsyncJobResponse {
  success: boolean;
  jobId: string;
  status: 'initiated';
  message: string;
  statusEndpoint: string;
  estimatedDuration: string;
}
