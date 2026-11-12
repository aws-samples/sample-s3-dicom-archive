/**
 * Non-DICOM Import V2: API client and types.
 *
 * Binding contract: plans/NON-DICOM-IMPORT-V2-CONTRACT.md. All routes live under
 * `${API_BASE_URL}/non-dicom-import/v2` and answer `{success, data}` or
 * `{success:false, error:{message}}`, the same envelope as V1.
 */
import { amplifyAuthService } from '../../services/amplifyAuthService';

export type DestinationKind = 'datastore' | 'virtualFolder';
export type V2Modality = 'DOC' | 'SC' | 'XC' | 'SM';

export interface V2Destination {
  kind: DestinationKind;
  id: string;
  name: string;
  writeDatastoreId: string;
  deidentified: boolean;
  canAnalyze: boolean;
}

export interface UploadUrlFile { name: string; s3Key: string; uploadUrl: string }
export interface UploadUrlsResponse { uploadId: string; files: UploadUrlFile[]; expiresIn?: number }

export interface ExtractedField { value: string | null; confidence: number; evidence?: string | null }
export type ExtractedFieldKey =
  | 'patientName' | 'patientId' | 'birthDate' | 'sex' | 'documentDate' | 'documentType'
  | 'documentTitle' | 'referringPhysician' | 'institution' | 'accessionNumber';
export const EXTRACTED_FIELD_KEYS: ExtractedFieldKey[] = [
  'patientName', 'patientId', 'birthDate', 'sex', 'documentDate', 'documentType',
  'documentTitle', 'referringPhysician', 'institution', 'accessionNumber',
];
export const FIELD_LABELS: Record<string, string> = {
  patientName: 'Patient name', patientId: 'Patient ID', birthDate: 'Birth date', sex: 'Sex',
  documentDate: 'Document date', documentType: 'Document type', documentTitle: 'Document title',
  referringPhysician: 'Referring physician', institution: 'Institution', accessionNumber: 'Accession number',
};

export interface CandidateStudy { studyInstanceUID: string; studyDate?: string; description?: string; accessionNumber?: string; modalities?: string[] }
export interface Candidate {
  patientId: string; patientName: string; birthDate?: string; sex?: string;
  score: number; reasons: string[]; studies: CandidateStudy[];
}

export interface AnalyzeResponse {
  status: 'ANALYSED' | 'NOT_ANALYSED';
  reason?: string;
  fields?: Partial<Record<ExtractedFieldKey, ExtractedField | null>>;
  candidates?: Candidate[];
  printedIdentifiers?: string[];
  model?: string;
  escalated?: boolean;
}

export interface PatientSearchResult {
  patientId: string; patientName: string; birthDate?: string; sex?: string;
  studies: CandidateStudy[];
}

export interface CreateImportBody {
  destinationKind: DestinationKind;
  destinationId: string;
  acknowledgedContentNotDeidentified: boolean;
  patient: { mode: 'existing' | 'new'; patientId: string; patientName: string; birthDate: string; sex: string };
  study: {
    mode: 'existing' | 'new'; studyInstanceUID: string; studyDescription: string; studyDate: string;
    accessionNumber: string; referringPhysician: string;
  };
  series: Array<{ ref: string; mode: 'new' | 'existing'; seriesInstanceUID: string; modality: V2Modality; description: string }>;
  files: Array<{
    s3Key: string; fileName: string; seriesRef: string; documentTitle: string; contentDate: string; institutionName: string;
    /** Video (XC) only, read in the browser; omitted when it cannot decode the file. */
    videoWidth?: number; videoHeight?: number; numberOfFrames?: number; frameTime?: number;
  }>;
}

export type ImportStatus = 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | string;
export type ImportFileStatus = 'PENDING' | 'ENCAPSULATING' | 'WRITTEN' | 'INDEXED' | 'FAILED' | string;

export interface ImportDetail {
  import: {
    id: string; status: ImportStatus; destinationKind: DestinationKind; destinationId: string;
    createdBy?: string; createdAt?: string; studyInstanceUID?: string;
  };
  files: Array<{
    id: string; fileName: string; status: ImportFileStatus; sopInstanceUID?: string | null;
    seriesInstanceUID?: string | null; errorMessage?: string | null;
  }>;
}

export interface ImportSummary {
  id: string; status: ImportStatus; destinationKind?: DestinationKind; destinationId?: string;
  createdBy?: string; createdAt?: string; studyInstanceUID?: string; fileCount?: number;
}

const BASE = '/non-dicom-import/v2';

function apiBaseUrl(): string {
  const config = (window as any).REACT_APP_CONFIG || {};
  return config.API_BASE_URL || '';
}

/**
 * True when the runtime config enables the V2 import. The contract names the key
 * `nonDicomImportV2`; the CI-written admin config.js uses upper-case string flags
 * (e.g. VIRTUAL_FOLDER: "true"), so both spellings are accepted.
 */
export function isNonDicomImportV2Enabled(): boolean {
  // Non-DICOM Import V2 is now the only non-DICOM import experience and is
  // always available — the former `nonDicomImportV2` config gate was removed.
  return true;
}

export class V2ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await amplifyAuthService.getToken();
  const res = await fetch(`${apiBaseUrl()}${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || !body || body.success === false) {
    const msg = body?.error?.message || body?.message || defaultMessage(res.status);
    throw new V2ApiError(msg, res.status);
  }
  return body.data as T;
}

function defaultMessage(status: number): string {
  if (status === 403) return 'You do not have permission for this action on the selected destination.';
  if (status === 404) return 'The destination or import was not found.';
  if (status === 400) return 'The request was rejected as invalid.';
  if (status === 0 || !status) return 'The server could not be reached.';
  return `The server returned an error (HTTP ${status}).`;
}

export const nonDicomV2Api = {
  getDestinations: () => request<V2Destination[]>('/destinations'),

  getUploadUrls: (destinationKind: DestinationKind, destinationId: string, files: Array<{ name: string; contentType: string; size: number }>) =>
    request<UploadUrlsResponse>('/upload-urls', { method: 'POST', body: JSON.stringify({ destinationKind, destinationId, files }) }),

  analyze: (destinationKind: DestinationKind, destinationId: string, s3Key: string) =>
    request<AnalyzeResponse>('/analyze', { method: 'POST', body: JSON.stringify({ destinationKind, destinationId, s3Key }) }),

  searchPatients: (destinationKind: DestinationKind, destinationId: string, q: string) => {
    const qs = new URLSearchParams({ destinationKind, destinationId, q });
    return request<PatientSearchResult[]>(`/patients?${qs.toString()}`);
  },

  // Create and list are the base path itself, without a trailing slash.
  createImport: (body: CreateImportBody) =>
    request<{ importId: string; patientId?: string | null }>('', { method: 'POST', body: JSON.stringify(body) }),

  getImport: (importId: string) => request<ImportDetail>(`/${encodeURIComponent(importId)}`),

  listImports: async (): Promise<ImportSummary[]> => {
    const data: any = await request<any>('');
    // Contract: an array. Accept a {items} page too, in case the list is paged later.
    return Array.isArray(data) ? data : (data?.items || []);
  },
};

/**
 * PUT one file to its presigned URL. The URL signs Content-Type and
 * Content-Length; the browser sets Content-Length from the body, so only
 * Content-Type is sent explicitly. XHR (not fetch) for upload progress.
 */
export function putFile(url: string, file: File, contentType: string, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(xhr.status === 403 ? 'The upload link was refused or has expired.' : `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(file);
  });
}
