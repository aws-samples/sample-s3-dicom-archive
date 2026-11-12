/**
 * Non-DICOM Import V2 API client (plans/NON-DICOM-IMPORT-V2-CONTRACT.md).
 *
 * Same auth as services/apiClient.ts (Cognito access token as a Bearer header
 * against config.apiUrl), kept in its own module so V2 can be removed without
 * touching the V1 / browse client.
 */
import axios, { AxiosInstance } from 'axios';
import { authService } from './authService';
import { configService } from './configService';

export type DestinationKind = 'datastore' | 'virtualFolder';
export type V2Modality = 'DOC' | 'SC' | 'XC';

export interface Destination {
  kind: DestinationKind;
  id: string;
  name: string;
  writeDatastoreId?: string;
  deidentified: boolean;
  canAnalyze: boolean;
}

export interface UploadUrlFile { name: string; s3Key: string; uploadUrl: string }
export interface UploadUrlsResult { uploadId: string; files: UploadUrlFile[]; expiresIn?: number }

export interface ExtractedField { value: string; confidence: number; evidence?: string }
export type FieldKey = 'patientName' | 'patientId' | 'birthDate' | 'sex' | 'documentDate' | 'documentType'
  | 'documentTitle' | 'referringPhysician' | 'institution' | 'accessionNumber';

export interface StudyRef {
  studyInstanceUID: string;
  studyDate?: string;
  description?: string;
  accessionNumber?: string;
  modalities?: string[];
}

export interface PatientRecord {
  patientId: string;
  patientName?: string;
  birthDate?: string;
  sex?: string;
  studies?: StudyRef[];
}

export interface Candidate extends PatientRecord {
  score: number;
  reasons?: string[];
}

export interface AnalyzeResult {
  status: 'ANALYSED' | 'NOT_ANALYSED';
  reason?: string;
  fields?: Partial<Record<FieldKey, ExtractedField | null>>;
  candidates?: Candidate[];
  printedIdentifiers?: string[];
  model?: string;
  escalated?: boolean;
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

const BASE = '/non-dicom-import/v2';

/** Readable message from an axios error carrying the V2 `{success:false, error:{message}}` envelope. */
export function apiErrorMessage(error: any, fallback = 'Request failed.'): string {
  const data = error?.response?.data;
  const msg = data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : '');
  if (msg) return String(msg);
  const status = error?.response?.status;
  if (status === 403) return 'You do not have permission for this destination.';
  if (status === 404) return 'Destination not found.';
  if (status === 413) return 'The request is too large.';
  return error?.message || fallback;
}

function unwrap<T>(response: any): T {
  const body = response?.data;
  if (body && typeof body === 'object' && 'success' in body) {
    if (body.success === false) {
      const err: any = new Error(body?.error?.message || 'Request failed.');
      err.response = response;
      throw err;
    }
    return body.data as T;
  }
  return body as T;
}

function asList<T>(data: any): T[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

class NonDicomImportV2Service {
  private client: AxiosInstance | null = null;
  private flag: Promise<boolean> | null = null;
  private destinations: Promise<Destination[]> | null = null;

  private getClient(): AxiosInstance {
    if (!this.client) {
      const config = configService.getConfig();
      this.client = axios.create({ baseURL: config.apiUrl });
      this.client.interceptors.request.use(async (cfg) => {
        const token = await authService.getAccessToken();
        if (token) cfg.headers.Authorization = `Bearer ${token}`;
        return cfg;
      });
    }
    return this.client;
  }

  /** Non-DICOM Import V2 is always available (the `nonDicomImportV2` config gate
   * was removed). Whether the entry actually shows still depends on the user
   * having at least one import destination (GET /destinations). */
  isEnabled(): Promise<boolean> {
    if (!this.flag) {
      this.flag = Promise.resolve(true);
    }
    return this.flag;
  }

  /** Writable destinations the caller can store into. Cached for the page; reset() on sign-out. */
  getDestinations(force = false): Promise<Destination[]> {
    if (!this.destinations || force) {
      this.destinations = (async () => {
        try {
          const resp = await this.getClient().get(`${BASE}/destinations`);
          return asList<any>(unwrap<any>(resp)).map((d): Destination => ({
            kind: d.kind === 'virtualFolder' ? 'virtualFolder' : 'datastore',
            id: String(d.id),
            name: String(d.name ?? d.id),
            writeDatastoreId: d.writeDatastoreId,
            deidentified: d.deidentified === true,
            canAnalyze: d.canAnalyze === true,
          }));
        } catch (error: any) {
          console.error('Failed to load import destinations:', { status: error?.response?.status });
          // Do not cache a failure: the next caller retries.
          this.destinations = null;
          return [];
        }
      })();
    }
    return this.destinations;
  }

  reset(): void {
    this.destinations = null;
    this.client = null;
  }

  async getUploadUrls(destinationKind: DestinationKind, destinationId: string,
    files: Array<{ name: string; contentType: string; size: number }>): Promise<UploadUrlsResult> {
    const resp = await this.getClient().post(`${BASE}/upload-urls`, { destinationKind, destinationId, files });
    return unwrap<UploadUrlsResult>(resp);
  }

  async analyze(destinationKind: DestinationKind, destinationId: string, s3Key: string): Promise<AnalyzeResult> {
    // The Lambda answers NOT_ANALYSED (reason "timeout") before API Gateway's
    // 29 s limit; the client timeout only guards against a stalled connection.
    const resp = await this.getClient().post(`${BASE}/analyze`, { destinationKind, destinationId, s3Key }, { timeout: 45_000 });
    return unwrap<AnalyzeResult>(resp);
  }

  async searchPatients(destinationKind: DestinationKind, destinationId: string, q: string): Promise<PatientRecord[]> {
    const resp = await this.getClient().get(`${BASE}/patients`, { params: { destinationKind, destinationId, q } });
    return asList<PatientRecord>(unwrap<any>(resp));
  }

  async createImport(body: CreateImportBody): Promise<{ importId: string; patientId?: string | null }> {
    // The base path itself, without a trailing slash.
    const resp = await this.getClient().post(BASE, body);
    return unwrap<{ importId: string; patientId?: string | null }>(resp);
  }

  async getImport(importId: string): Promise<ImportDetail> {
    const resp = await this.getClient().get(`${BASE}/${encodeURIComponent(importId)}`);
    return unwrap<ImportDetail>(resp);
  }
}

export const nonDicomImportV2Service = new NonDicomImportV2Service();

/**
 * PUT a file to its presigned URL. The URL signs Content-Type and
 * Content-Length, so the Content-Type sent must be exactly the one declared
 * to /upload-urls (the browser sets Content-Length from the body).
 */
export function putToPresignedUrl(url: string, file: Blob, contentType: string,
  onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(xhr.status === 403 ? 'Upload refused (the upload link expired or the file changed).' : `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    if (signal) {
      if (signal.aborted) { reject(new Error('Upload cancelled.')); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}
