/**
 * PHI notice: this module handles Protected Health Information (patient name, ID,
 * birth date, sex, accession number and other DICOM identifiers). Deployers are
 * responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
 * responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
 */
import { authService } from './authService';
import { configService } from './configService';

export interface DICOMStudy {
  studyInstanceUID: string;
  patientID: string;
  patientName: string;
  studyDate: string;
  studyTime: string;
  accessionNumber: string;
  studyDescription: string;
  modality: string;
  modalitiesInStudy: string[];
  referringPhysicianName: string;
  patientBirthDate: string;
  numberOfStudyRelatedSeries: number;
  numberOfStudyRelatedInstances: number;
}

export interface DICOMSeries {
  seriesInstanceUID: string;
  seriesNumber: string;
  seriesDescription: string;
  modality: string;
  numberOfSeriesRelatedInstances: number;
  bodyPartExamined?: string;
  studyInstanceUID?: string;
  specificCharacterSet?: string;
}

export interface DICOMInstance {
  sopInstanceUID: string;
  instanceNumber: string;
  sopClassUID: string;
  rows?: number;
  columns?: number;
}

export interface StudySearchParams {
  PatientID?: string;
  PatientName?: string;
  StudyDate?: string;
  AccessionNumber?: string;
  StudyDescription?: string;
  ModalitiesInStudy?: string;
  ReferringPhysicianName?: string;
  limit?: number;
  offset?: number;
}

class DICOMwebService {
  // sourceId -> server verdict on canDownload. Cleared on sign-out.
  private downloadAccess = new Map<string, Promise<boolean>>();

  /** Whether the signed-in user may download from this storage/folder.
   *  Advice for the UI only: the download route enforces the privilege. */
  canDownload(sourceId: string): Promise<boolean> {
    let verdict = this.downloadAccess.get(sourceId);
    if (!verdict) {
      verdict = (async () => {
        try {
          const headers = await this.getAuthHeaders('application/json');
          const resp = await fetch(`${this.datastoreBaseUrl(sourceId)}/download-access`, { method: 'GET', headers });
          if (!resp.ok) return false;
          const body = await resp.json();
          return body?.canDownload === true;
        } catch {
          return false;
        }
      })();
      this.downloadAccess.set(sourceId, verdict);
    }
    return verdict;
  }

  clearDownloadAccess(): void {
    this.downloadAccess.clear();
  }

  /** Save one study as <StudyInstanceUID>.zip. The archive is streamed to disk
   *  where the browser can (File System Access API), otherwise buffered and
   *  saved; the server caps its size. Throws an Error with a user-facing message. */
  async downloadStudy(sourceId: string, studyInstanceUID: string): Promise<void> {
    const fileName = `${studyInstanceUID}.zip`;
    const picker = (window as any).showSaveFilePicker;
    // Ask for the file first: the picker needs the click's user activation.
    let fileHandle: any = null;
    if (typeof picker === 'function') {
      try {
        fileHandle = await picker({ suggestedName: fileName,
          types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
      } catch (e: any) {
        if (e?.name === 'AbortError') return; // the user cancelled
        fileHandle = null;
      }
    }
    const headers = await this.getAuthHeaders('application/zip');
    const url = `${this.datastoreBaseUrl(sourceId)}/studies/${encodeURIComponent(studyInstanceUID)}/download`;
    const resp = await fetch(url, { method: 'GET', headers });
    if (!resp.ok) {
      const reason = resp.status === 403 ? 'You do not have download access to this storage or folder.'
        : resp.status === 404 ? 'Study not found.'
        : resp.status === 413 ? ((await resp.text().catch(() => '')) || 'The study is too large to download.')
        : resp.status === 503 ? 'Some files of this study are not available right now (archived or de-identification unavailable).'
        : `Download failed (HTTP ${resp.status}).`;
      throw new Error(reason);
    }
    try {
      if (fileHandle && resp.body) {
        const writable = await fileHandle.createWritable();
        await resp.body.pipeTo(writable); // aborts (discards) the file on a broken transfer
        return;
      }
      const blob = await resp.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
    } catch {
      // The server aborts the body when the study exceeds its size limit or a
      // file cannot be read; the archive is then incomplete and not saved.
      throw new Error('The download was interrupted (the study may exceed the download size limit).');
    }
  }

  private async getAuthHeaders(accept: string = 'application/dicom+json'): Promise<Record<string, string>> {
    const token = await authService.getAccessToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': accept
    };
  }

  // S3-backed DICOMweb base. Every datastore is served under {dicomWebUrl}/dicomweb/{datastoreId}.
  private datastoreBaseUrl(datastoreId: string): string {
    const base = configService.getConfig().dicomWebUrl.replace(/\/$/, '');
    return `${base}/dicomweb/${datastoreId}`;
  }

  private buildQueryString(params: Record<string, any>): string {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        queryParams.append(key, value.toString());
      }
    });
    return queryParams.toString();
  }

  private parseStudyResponse(data: any[]): DICOMStudy[] {
    return data.map(item => ({
      studyInstanceUID: item['0020000D']?.Value?.[0] || '',
      patientID: item['00100020']?.Value?.[0] || '',
      patientName: item['00100010']?.Value?.[0]?.Alphabetic || item['00100010']?.Value?.[0] || '',
      studyDate: item['00080020']?.Value?.[0] || '',
      studyTime: item['00080030']?.Value?.[0] || '',
      accessionNumber: item['00080050']?.Value?.[0] || '',
      studyDescription: item['00081030']?.Value?.[0] || '',
      modality: (item['00080061']?.Value || [item['00080060']?.Value?.[0]].filter(Boolean)).join(', ') || '',
      modalitiesInStudy: item['00080061']?.Value || [],
      referringPhysicianName: item['00080090']?.Value?.[0]?.Alphabetic || item['00080090']?.Value?.[0] || '',
      patientBirthDate: item['00100030']?.Value?.[0] || '',
      numberOfStudyRelatedSeries: item['00201206']?.Value?.[0] || 0,
      numberOfStudyRelatedInstances: item['00201208']?.Value?.[0] || 0
    }));
  }

  private parseSeriesResponse(data: any[]): DICOMSeries[] {
    return data.map(item => ({
      seriesInstanceUID: item['0020000E']?.Value?.[0] || '',
      seriesNumber: item['00200011']?.Value?.[0] || '',
      seriesDescription: item['0008103E']?.Value?.[0] || '',
      modality: item['00080060']?.Value?.[0] || '',
      numberOfSeriesRelatedInstances: item['00201209']?.Value?.[0] || 0,
      bodyPartExamined: item['00180015']?.Value?.[0] || '',
      studyInstanceUID: item['0020000D']?.Value?.[0] || '',
      specificCharacterSet: item['00080005']?.Value?.[0] || ''
    }));
  }

  private parseInstanceResponse(data: any[]): DICOMInstance[] {
    return data.map(item => ({
      sopInstanceUID: item['00080018']?.Value?.[0] || '',
      instanceNumber: item['00200013']?.Value?.[0] || '',
      sopClassUID: item['00080016']?.Value?.[0] || '',
      rows: item['00280010']?.Value?.[0],
      columns: item['00280011']?.Value?.[0]
    }));
  }

  // S3-only: every datastore is served from S3 via /dicomweb/{datastoreId}.
  async searchStudies(datastoreId: string, params: StudySearchParams = {}): Promise<DICOMStudy[]> {
    try {
      const queryString = this.buildQueryString(params);
      const url = `${this.datastoreBaseUrl(datastoreId)}/studies${queryString ? `?${queryString}` : ''}`;
      const headers = await this.getAuthHeaders();
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        if (response.status === 204) return [];
        throw new Error(`DICOMweb request failed: ${response.status}`);
      }
      const data = await response.json();
      return this.parseStudyResponse(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to search studies:', { errorType: error.name });
      return [];
    }
  }

  // Virtual folders are served on the SAME S3 DICOMweb route as datastores:
  // {dicomWebUrl}/dicomweb/{vfId}. The old /virtual-folders/{name} path was a
  // route the dicomweb-s3 container does not serve, producing the
  // "Invalid path format. Expected /dicomweb/{datastoreId}/..." error. The
  // vfDicomWebUrl arg is retained for signature compatibility but ignored.
  async searchVirtualFolderStudies(virtualFolderId: string, _vfDicomWebUrl: string, params: StudySearchParams = {}): Promise<DICOMStudy[]> {
    try {
      const headers = await this.getAuthHeaders();
      const queryString = this.buildQueryString(params);

      const url = `${this.datastoreBaseUrl(virtualFolderId)}/studies${queryString ? `?${queryString}` : ''}`;

      const response = await fetch(url, { method: 'GET', headers });
      
      if (!response.ok) {
        if (response.status === 204) return [];
        throw new Error(`Virtual folder DICOMweb request failed: ${response.status}`);
      }
      
      const data = await response.json();
      return this.parseStudyResponse(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to search virtual folder studies:', { errorType: error.name });
      return [];
    }
  }

  async searchSeries(datastoreId: string, studyInstanceUID: string): Promise<DICOMSeries[]> {
    try {
      const url = `${this.datastoreBaseUrl(datastoreId)}/studies/${studyInstanceUID}/series`;
      const headers = await this.getAuthHeaders();
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        if (response.status === 204) return [];
        throw new Error(`DICOMweb series request failed: ${response.status}`);
      }
      const data = await response.json();
      return this.parseSeriesResponse(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to search series:', { errorType: error.name });
      return [];
    }
  }

  async searchVirtualFolderSeries(virtualFolderId: string, _vfDicomWebUrl: string, studyInstanceUID: string): Promise<DICOMSeries[]> {
    try {
      const headers = await this.getAuthHeaders();

      const url = `${this.datastoreBaseUrl(virtualFolderId)}/studies/${studyInstanceUID}/series`;

      const response = await fetch(url, { method: 'GET', headers });
      
      if (!response.ok) {
        if (response.status === 204) return [];
        throw new Error(`Virtual folder series request failed: ${response.status}`);
      }
      
      const data = await response.json();
      return this.parseSeriesResponse(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to search virtual folder series:', { errorType: error.name });
      return [];
    }
  }

  async searchInstances(datastoreId: string, studyInstanceUID: string, seriesInstanceUID: string): Promise<DICOMInstance[]> {
    try {
      const url = `${this.datastoreBaseUrl(datastoreId)}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances`;
      const headers = await this.getAuthHeaders();
      const response = await fetch(url, { method: 'GET', headers });
      if (!response.ok) {
        if (response.status === 204) return [];
        throw new Error(`DICOMweb instances request failed: ${response.status}`);
      }
      const data = await response.json();
      return this.parseInstanceResponse(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to search instances:', { errorType: error.name });
      return [];
    }
  }

  async searchVirtualFolderInstances(virtualFolderId: string, _vfDicomWebUrl: string, studyInstanceUID: string, seriesInstanceUID: string): Promise<DICOMInstance[]> {
    try {
      const headers = await this.getAuthHeaders();

      const url = `${this.datastoreBaseUrl(virtualFolderId)}/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances`;

      const response = await fetch(url, { method: 'GET', headers });
      
      if (!response.ok) {
        if (response.status === 204) return [];
        throw new Error(`Virtual folder instances request failed: ${response.status}`);
      }
      
      const data = await response.json();
      return this.parseInstanceResponse(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Failed to search virtual folder instances:', { errorType: error.name });
      return [];
    }
  }

  async getInstanceWadoMetadata(datastoreId: string,
    studyUID: string, seriesUID: string, sopUID: string): Promise<PixelMetadata | null> {
    try {
      const url = `${this.datastoreBaseUrl(datastoreId)}/studies/${studyUID}/series/${seriesUID}/instances/${sopUID}/metadata`;
      const headers = await this.getAuthHeaders();
      const resp = await fetch(url, { method: 'GET', headers });
      if (!resp.ok) return null;
      const data = await resp.json();
      const item = Array.isArray(data) ? data[0] : data;
      if (!item) return null;
      return {
        rows: item['00280010']?.Value?.[0] || 0, columns: item['00280011']?.Value?.[0] || 0,
        bitsAllocated: item['00280100']?.Value?.[0] || 16, samplesPerPixel: item['00280002']?.Value?.[0] || 1,
        photometricInterpretation: item['00280004']?.Value?.[0] || 'MONOCHROME2',
        planarConfiguration: item['00280006']?.Value?.[0] || 0,
        transferSyntaxUID: item['00020010']?.Value?.[0] || '',
        windowCenter: item['00281050']?.Value?.[0], windowWidth: item['00281051']?.Value?.[0],
      };
    } catch (e) { console.error('Failed to get WADO-RS metadata:', e); return null; }
  }

  async getFrame(datastoreId: string,
    studyUID: string, seriesUID: string, sopUID: string, frame: number = 1): Promise<{ data: ArrayBuffer; isRaw: boolean } | null> {
    try {
      const url = `${this.datastoreBaseUrl(datastoreId)}/studies/${studyUID}/series/${seriesUID}/instances/${sopUID}/frames/${frame}`;
      const headers = await this.getAuthHeaders('multipart/related; type=application/octet-stream');
      const resp = await fetch(url, { method: 'GET', headers });
      if (!resp.ok) return null;
      const contentType = resp.headers.get('content-type') || '';
      const ab = await resp.arrayBuffer();
      if (!contentType.includes('multipart/related')) return { data: ab, isRaw: false };
      const uint8 = new Uint8Array(ab);
      const bm = contentType.match(/boundary=([^;]+)/);
      if (!bm) return null;
      const bb = new TextEncoder().encode(`--${bm[1].replace(/"/g, '')}`);
      const pos: number[] = [];
      for (let i = 0; i <= uint8.length - bb.length; i++) {
        let m = true;
        for (let j = 0; j < bb.length; j++) { if (uint8[i+j] !== bb[j]) { m = false; break; } }
        if (m) pos.push(i);
      }
      for (let i = 0; i < pos.length - 1; i++) {
        const part = uint8.slice(pos[i] + bb.length, pos[i+1]);
        const hdr = new TextDecoder().decode(part.slice(0, Math.min(500, part.length)));
        if (hdr.includes('application/octet-stream')) {
          for (let j = 0; j <= part.length - 4; j++) {
            if (part[j]===13 && part[j+1]===10 && part[j+2]===13 && part[j+3]===10)
              return { data: part.slice(j+4).buffer, isRaw: true };
          }
        }
      }
      return null;
    } catch (e) { console.error('Failed to get frame:', e); return null; }
  }
}

export interface PixelMetadata {
  rows: number; columns: number; bitsAllocated: number; samplesPerPixel: number;
  photometricInterpretation: string; planarConfiguration: number; transferSyntaxUID: string;
  windowCenter?: number; windowWidth?: number;
}

export const dicomwebService = new DICOMwebService();
