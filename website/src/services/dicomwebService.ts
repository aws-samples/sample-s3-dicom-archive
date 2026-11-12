/**
 * DICOMweb Service for S3 datastores
 * Implements QIDO-RS (Query based on ID for DICOM Objects) functionality
 *
 * Every datastore is served by the self-hosted DICOMweb container at
 * /dicomweb/{internal datastore UUID} on the same CloudFront origin as this app,
 * authenticated with `Authorization: Bearer <Cognito access token>`. The path
 * suffixes are the standard DICOMweb ones (/studies, /studies/{uid}/series,
 * .../metadata, .../frames/{n}).
 */

import { Datastore } from '../types';
import { amplifyAuthService } from './amplifyAuthService';

/** Storage backend behind a datastore. Every datastore is S3-backed. */
export type DatastoreStorageType = 'S3';

/**
 * Which DICOMweb backend a datastore uses, and the id that backend is keyed on.
 *
 * Every datastore is S3-backed: the DICOMweb container is addressed by the
 * internal datastore UUID (datastore.id), and storageType is always 'S3'.
 */
export const getDatastoreTarget = (
  datastore: Pick<Datastore, 'id' | 'storageType'> | null | undefined
): { pathId: string; storageType: DatastoreStorageType } => {
  return {
    pathId: datastore?.id || '',
    storageType: 'S3'
  };
};

// Relative on purpose: the DICOMweb container is served from the same CloudFront
// distribution as this app, so requests are same-origin (no CORS, no preflight) and
// cannot be repointed at the internal ALB, which would bypass the distribution.
const S3_DICOMWEB_BASE_PATH = '/dicomweb';

// Explicit VR Little Endian - the only syntax the raw-pixel renderer here understands.
const EXPLICIT_VR_LITTLE_ENDIAN = '1.2.840.10008.1.2.1';

// DICOMweb Response Types
export interface DICOMwebStudy {
  '0020000D': { Value: [string] }; // StudyInstanceUID
  '00100020': { Value: [string] }; // PatientID
  '00100010': { Value: [{ Alphabetic: string }] }; // PatientName
  '00100030': { Value: [string] }; // PatientBirthDate
  '00100040': { Value: [string] }; // PatientSex
  '00080020': { Value: [string] }; // StudyDate
  '00080030': { Value: [string] }; // StudyTime
  '00080050': { Value: [string] }; // AccessionNumber
  '00081030': { Value: [string] }; // StudyDescription
  '00080061': { Value: [string] }; // ModalitiesInStudy
  '00080090': { Value: [string] }; // ReferringPhysicianName
  '00201206': { Value: [number] }; // NumberOfStudyRelatedSeries
  '00200010'?: { Value: [string] }; // StudyID
  '00201208': { Value: [number] }; // NumberOfStudyRelatedInstances
}

export interface DICOMwebSeries {
  '0020000E': { Value: [string] }; // SeriesInstanceUID
  '0020000D': { Value: [string] }; // StudyInstanceUID
  '00200011': { Value: [number] }; // SeriesNumber
  '0008103E': { Value: [string] }; // SeriesDescription
  '00080060': { Value: [string] }; // Modality
  '00201209': { Value: [number] }; // NumberOfSeriesRelatedInstances
  '00080021': { Value: [string] }; // SeriesDate
  '00080031': { Value: [string] }; // SeriesTime
}

export interface DICOMwebInstance {
  '00080018': { Value: [string] }; // SOPInstanceUID
  '0020000E': { Value: [string] }; // SeriesInstanceUID
  '0020000D': { Value: [string] }; // StudyInstanceUID
  '00200013': { Value: [number] }; // InstanceNumber
  '00080016': { Value: [string] }; // SOPClassUID
  '00020010': { Value: [string] }; // TransferSyntaxUID
  '00280010': { Value: [number] }; // Rows
  '00280011': { Value: [number] }; // Columns
  '00280100': { Value: [number] }; // BitsAllocated
  '00280101': { Value: [number] }; // BitsStored
  '00280102': { Value: [number] }; // HighBit
  '00280103': { Value: [number] }; // PixelRepresentation
}

// Processed interfaces for UI consumption (matching existing interfaces)
export interface ProcessedDicomStudy {
  studyInstanceUID: string;
  studyID: string;
  patientID: string;
  patientName: string;
  patientBirthDate: string;
  patientSex: string;
  studyDate: string;
  studyTime: string;
  accessionNumber: string;
  studyDescription: string;
  modality: string; // Keep for backward compatibility (first modality)
  modalitiesInStudy: string[]; // Array of all modalities in the study
  referringPhysicianName: string;
  numberOfStudyRelatedSeries: number;
  numberOfStudyRelatedInstances: number;
  datastoreId: string;
}

export interface ProcessedDicomSeries {
  seriesInstanceUID: string;
  seriesNumber: number;
  seriesDescription: string;
  modality: string;
  numberOfSeriesRelatedInstances: number;
  seriesDate: string;
  seriesTime: string;
  studyInstanceUID: string;
  datastoreId: string;
}

export interface ProcessedDicomInstance {
  sopInstanceUID: string;
  instanceNumber: number;
  sopClassUID: string;
  transferSyntaxUID: string;
  rows: number;
  columns: number;
  bitsAllocated: number;
  bitsStored: number;
  highBit: number;
  pixelRepresentation: number;
  seriesInstanceUID: string;
  studyInstanceUID: string;
  datastoreId: string;
}

// Search Parameters for QIDO-RS queries
export interface StudySearchParams {
  PatientID?: string;
  PatientName?: string;
  PatientSex?: string;
  StudyDate?: string;
  StudyTime?: string;
  AccessionNumber?: string;
  StudyInstanceUID?: string;
  StudyDescription?: string;
  ModalitiesInStudy?: string;
  ReferringPhysicianName?: string;
  limit?: number;
  offset?: number;
  includefield?: string[];
}

export interface SeriesSearchParams {
  SeriesInstanceUID?: string;
  SeriesNumber?: string;
  SeriesDescription?: string;
  Modality?: string;
  SeriesDate?: string;
  SeriesTime?: string;
  limit?: number;
  offset?: number;
  includefield?: string[];
}

export interface InstanceSearchParams {
  SOPInstanceUID?: string;
  InstanceNumber?: string;
  SOPClassUID?: string;
  limit?: number;
  offset?: number;
  includefield?: string[];
}

// API Response wrapper (matching existing interface)
export interface DicomwebApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  metadata?: {
    transferSyntax?: string;
    contentType?: string;
    isRawPixelData?: boolean;
  };
}

export interface DicomPixelMetadata {
  rows: number;
  columns: number;
  bitsAllocated: number;
  bitsStored: number;
  samplesPerPixel: number;
  photometricInterpretation: string;
  planarConfiguration: number;
  pixelRepresentation: number;
  transferSyntaxUID?: string;
  windowCenter?: number;
  windowWidth?: number;
  rescaleIntercept?: number;
  rescaleSlope?: number;
}

/**
 * DICOMweb Service Class
 * Provides methods to search for studies, series, and instances using the DICOMweb API
 */
class DICOMwebService {
  /**
   * RFC 3986 compliant URI encoding
   */
  private encodeRFC3986(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  /**
   * Build query string from search parameters
   */
  private buildQueryString(params: Record<string, any>): string {
    const encodedParams = Object.entries(params)
      .filter(([_, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => {
        const encodedKey = this.encodeRFC3986(key);
        const encodedValue = this.encodeRFC3986(value.toString());
        return `${encodedKey}=${encodedValue}`;
      })
      .join('&');

    return encodedParams;
  }

  /**
   * Make authenticated request to the DICOMweb API.
   *
   * Every datastore is S3-backed: the request goes to the self-hosted DICOMweb
   * container keyed on the internal datastore UUID.
   */
  private async makeRequest(datastoreId: string, endpoint: string, queryParams?: Record<string, any>, internalDatastoreId?: string, storageType?: DatastoreStorageType): Promise<any> {
    try {
      // The container keys on the internal datastore UUID.
      return await this.makeS3Request(internalDatastoreId || datastoreId, endpoint, queryParams);
    } catch (error) {
      console.error('❌ Error making DICOMweb request:', { errorType: error.name });
      throw error;
    }
  }

  /**
   * DELETE a study / series / instance via the DICOMweb DELETE verb on the
   * self-hosted container. Hierarchical only (no query filters). Works for BOTH
   * a storage index (real deletion: soft-delete tree + S3 hard-delete + stats)
   * and a virtual-folder index (unassign from that folder only, never touching
   * S3) — the container disambiguates by the {scopeId} in the path exactly like
   * the read routes, so the caller passes the same pathId it uses for QIDO/WADO.
   * Returns void on 204 (success, including an idempotent no-op).
   */
  async deleteDicomweb(
    scopeId: string,
    studyInstanceUID: string,
    seriesInstanceUID?: string,
    sopInstanceUID?: string
  ): Promise<void> {
    const token = await amplifyAuthService.getToken();
    if (!token) {
      throw new Error('No authentication token available. Please log in.');
    }
    let endpoint = `/studies/${encodeURIComponent(studyInstanceUID)}`;
    if (seriesInstanceUID) endpoint += `/series/${encodeURIComponent(seriesInstanceUID)}`;
    if (sopInstanceUID) endpoint += `/instances/${encodeURIComponent(sopInstanceUID)}`;
    const url = `${S3_DICOMWEB_BASE_PATH}/${encodeURIComponent(scopeId)}${endpoint}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      throw new Error(`DICOMweb DELETE failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
  }

  /**
   * Make request to the self-hosted DICOMweb container backing an S3 datastore.
   * No SigV4 and no scoped credentials: the container authenticates the Cognito
   * access token itself and checks datastore read access per request.
   */
  private async makeS3Request(internalDatastoreId: string, endpoint: string, queryParams?: Record<string, any>): Promise<any> {
    const token = await amplifyAuthService.getToken();
    if (!token) {
      throw new Error('No authentication token available. Please log in.');
    }

    let url = `${S3_DICOMWEB_BASE_PATH}/${encodeURIComponent(internalDatastoreId)}${endpoint}`;
    if (queryParams) {
      const queryString = this.buildQueryString(queryParams);
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    // Do not log the full URL (it carries study/series/SOP UIDs = PHI).
    console.log('Making DICOMweb request to S3 datastore container');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/dicom+json',
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('📥 S3 DICOMweb Response:', response.status, response.statusText);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ S3 DICOMweb request failed:', response.status); // body may echo query values
      throw new Error(`S3 DICOMweb request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // 204 No Content is how QIDO-RS reports "no matches".
    if (response.status === 204) {
      console.log('✅ S3 DICOMweb returned 204 No Content (empty result)');
      return [];
    }

    const data = await response.json();
    console.log('✅ S3 DICOMweb response data received:', Array.isArray(data) ? `${data.length} items` : 'Single item');

    return data;
  }

  /**
   * Utility functions to extract values from DICOMweb responses
   */
  private getString(element: any): string {
    return element?.Value?.[0] || '';
  }

  private getStringArray(element: any): string[] {
    return element?.Value || [];
  }

  private getNumber(element: any): number {
    return element?.Value?.[0] || 0;
  }

  private getPatientName(element: any): string {
    return element?.Value?.[0]?.Alphabetic || '';
  }

  /**
   * Format study date for display
   */
  private formatStudyDate(dateString: string): string {
    if (!dateString || dateString.length !== 8) return dateString;
    
    const year = dateString.substring(0, 4);
    const month = dateString.substring(4, 6);
    const day = dateString.substring(6, 8);
    
    return `${year}-${month}-${day}`;
  }

  /**
   * Format study time for display
   */
  private formatStudyTime(timeString: string): string {
    if (!timeString || timeString.length < 6) return timeString;
    
    const hours = timeString.substring(0, 2);
    const minutes = timeString.substring(2, 4);
    const seconds = timeString.substring(4, 6);
    
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Convert DICOMweb study to display format
   */
  private convertStudyForDisplay(study: DICOMwebStudy, datastoreId: string): ProcessedDicomStudy {
    const modalitiesInStudy = this.getStringArray(study['00080061']);
    return {
      studyInstanceUID: this.getString(study['0020000D']),
      studyID: this.getString(study['00200010']),
      patientID: this.getString(study['00100020']),
      patientName: this.getPatientName(study['00100010']),
      patientBirthDate: this.getString(study['00100030']),
      patientSex: this.getString(study['00100040']),
      studyDate: this.getString(study['00080020']),
      studyTime: this.getString(study['00080030']),
      accessionNumber: this.getString(study['00080050']),
      studyDescription: this.getString(study['00081030']),
      modality: modalitiesInStudy[0] || '', // Keep for backward compatibility
      modalitiesInStudy: modalitiesInStudy, // Full array of modalities
      referringPhysicianName: this.getPatientName(study['00080090']),
      numberOfStudyRelatedSeries: this.getNumber(study['00201206']),
      numberOfStudyRelatedInstances: this.getNumber(study['00201208']),
      datastoreId: datastoreId
    };
  }

  /**
   * Convert DICOMweb series to display format
   */
  private convertSeriesForDisplay(series: DICOMwebSeries, datastoreId: string): ProcessedDicomSeries {
    return {
      seriesInstanceUID: this.getString(series['0020000E']),
      studyInstanceUID: this.getString(series['0020000D']),
      seriesNumber: this.getNumber(series['00200011']),
      seriesDescription: this.getString(series['0008103E']),
      modality: this.getString(series['00080060']),
      numberOfSeriesRelatedInstances: this.getNumber(series['00201209']),
      seriesDate: this.getString(series['00080021']),
      seriesTime: this.getString(series['00080031']),
      datastoreId: datastoreId
    };
  }

  /**
   * Convert DICOMweb instance to display format
   */
  private convertInstanceForDisplay(instance: DICOMwebInstance, datastoreId: string): ProcessedDicomInstance {
    return {
      sopInstanceUID: this.getString(instance['00080018']),
      seriesInstanceUID: this.getString(instance['0020000E']),
      studyInstanceUID: this.getString(instance['0020000D']),
      instanceNumber: this.getNumber(instance['00200013']),
      sopClassUID: this.getString(instance['00080016']),
      transferSyntaxUID: this.getString(instance['00020010']),
      rows: this.getNumber(instance['00280010']),
      columns: this.getNumber(instance['00280011']),
      bitsAllocated: this.getNumber(instance['00280100']),
      bitsStored: this.getNumber(instance['00280101']),
      highBit: this.getNumber(instance['00280102']),
      pixelRepresentation: this.getNumber(instance['00280103']),
      datastoreId: datastoreId
    };
  }

  /**
   * Search for studies using QIDO-RS
   * GET /studies
   */
  async searchStudies(
    datastoreId: string,
    searchParams: StudySearchParams = {},
    internalDatastoreId?: string,
    storageType?: DatastoreStorageType
  ): Promise<DicomwebApiResponse<ProcessedDicomStudy[]>> {
    try {
      const response = await this.makeRequest(datastoreId, '/studies', searchParams, internalDatastoreId, storageType);
      
      // Convert DICOMweb response to processed format
      const processedStudies: ProcessedDicomStudy[] = [];
      if (Array.isArray(response)) {
        console.log(`✅ Processing ${response.length} studies from DICOMweb API`);
        for (const study of response) {
          processedStudies.push(this.convertStudyForDisplay(study, datastoreId));
        }
      } else {
        console.warn('⚠️ Unexpected response format from DICOMweb API:', typeof response);
      }

      console.log(`✅ DICOMweb searchStudies completed: ${processedStudies.length} studies processed`);
      
      return {
        success: true,
        data: processedStudies,
        message: `Found ${processedStudies.length} studies via DICOMweb API`
      };

    } catch (error) {
      console.error('❌ Error in DICOMweb searchStudies:', { errorType: error.name });
      
      // Handle authentication errors
      if (error instanceof Error && (
        error.message.includes('403') || 
        error.message.includes('401') || 
        error.message.includes('UnauthorizedOperation') || 
        error.message.includes('AccessDenied')
      )) {
        return {
          success: false,
          error: 'Authentication failed. Please log in again.',
          message: 'Your session may have expired. Please refresh the page and log in again.'
        };
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to search studies using DICOMweb API'
      };
    }
  }

  /**
   * Get specific study by StudyInstanceUID
   * GET /studies/{StudyInstanceUID}
   */
  async getStudy(datastoreId: string, studyInstanceUID: string): Promise<DicomwebApiResponse<ProcessedDicomStudy[]>> {
    try {
      console.log('Getting study'); // UIDs are patient-linkable; not logged
      
      const response = await this.makeRequest(datastoreId, `/studies/${encodeURIComponent(studyInstanceUID)}`);
      
      const processedStudies: ProcessedDicomStudy[] = [];
      if (Array.isArray(response)) {
        for (const study of response) {
          processedStudies.push(this.convertStudyForDisplay(study, datastoreId));
        }
      }

      return {
        success: true,
        data: processedStudies
      };

    } catch (error) {
      console.error('Error getting study:', { errorType: error.name });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to get study using DICOMweb API'
      };
    }
  }

  /**
   * Search for series within a study
   * GET /studies/{StudyInstanceUID}/series
   */
  async searchSeries(
    datastoreId: string,
    studyInstanceUID: string,
    searchParams: SeriesSearchParams = {},
    internalDatastoreId?: string,
    storageType?: DatastoreStorageType
  ): Promise<DicomwebApiResponse<ProcessedDicomSeries[]>> {
    try {
      const response = await this.makeRequest(
        datastoreId,
        `/studies/${encodeURIComponent(studyInstanceUID)}/series`,
        searchParams,
        internalDatastoreId,
        storageType
      );
      
      const processedSeries: ProcessedDicomSeries[] = [];
      if (Array.isArray(response)) {
        for (const series of response) {
          processedSeries.push(this.convertSeriesForDisplay(series, datastoreId));
        }
      }

      return {
        success: true,
        data: processedSeries
      };

    } catch (error) {
      console.error('Error searching series:', { errorType: error.name });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to search series using DICOMweb API'
      };
    }
  }

  /**
   * Search for instances within a series
   * GET /studies/{StudyInstanceUID}/series/{SeriesInstanceUID}/instances
   */
  async searchInstances(
    datastoreId: string,
    studyInstanceUID: string,
    seriesInstanceUID: string,
    searchParams: InstanceSearchParams = {},
    internalDatastoreId?: string,
    storageType?: DatastoreStorageType
  ): Promise<DicomwebApiResponse<ProcessedDicomInstance[]>> {
    try {
      const response = await this.makeRequest(
        datastoreId,
        `/studies/${encodeURIComponent(studyInstanceUID)}/series/${encodeURIComponent(seriesInstanceUID)}/instances`,
        searchParams,
        internalDatastoreId,
        storageType
      );
      
      const processedInstances: ProcessedDicomInstance[] = [];
      if (Array.isArray(response)) {
        for (const instance of response) {
          processedInstances.push(this.convertInstanceForDisplay(instance, datastoreId));
        }
      }

      return {
        success: true,
        data: processedInstances
      };

    } catch (error) {
      console.error('Error searching instances:', { errorType: error.name });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to search instances using DICOMweb API'
      };
    }
  }

  /**
   * Search for all series across all studies
   * GET /series
   */
  async searchAllSeries(datastoreId: string, searchParams: SeriesSearchParams = {}): Promise<DicomwebApiResponse<ProcessedDicomSeries[]>> {
    try {
      console.log('Searching all series', { filterCount: Object.keys(searchParams || {}).length }); // filter values can hold PHI
      
      const response = await this.makeRequest(datastoreId, '/series', searchParams);
      
      const processedSeries: ProcessedDicomSeries[] = [];
      if (Array.isArray(response)) {
        for (const series of response) {
          processedSeries.push(this.convertSeriesForDisplay(series, datastoreId));
        }
      }

      return {
        success: true,
        data: processedSeries
      };

    } catch (error) {
      console.error('Error searching all series:', { errorType: error.name });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to search all series using DICOMweb API'
      };
    }
  }

  /**
   * Search for all instances across all studies and series
   * GET /instances
   */
  async searchAllInstances(datastoreId: string, searchParams: InstanceSearchParams = {}): Promise<DicomwebApiResponse<ProcessedDicomInstance[]>> {
    try {
      console.log('Searching all instances', { filterCount: Object.keys(searchParams || {}).length }); // filter values can hold PHI
      
      const response = await this.makeRequest(datastoreId, '/instances', searchParams);
      
      const processedInstances: ProcessedDicomInstance[] = [];
      if (Array.isArray(response)) {
        for (const instance of response) {
          processedInstances.push(this.convertInstanceForDisplay(instance, datastoreId));
        }
      }

      return {
        success: true,
        data: processedInstances
      };

    } catch (error) {
      console.error('Error searching all instances:', { errorType: error.name });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to search all instances using DICOMweb API'
      };
    }
  }

  // Legacy method names for compatibility with existing code
  async getStudyMetadata(datastoreId: string, studyInstanceUID: string): Promise<DicomwebApiResponse<any>> {
    const result = await this.getStudy(datastoreId, studyInstanceUID);
    return {
      success: result.success,
      data: result.data?.[0] || null,
      error: result.error,
      message: result.message
    };
  }

  async getSeriesMetadata(datastoreId: string, studyInstanceUID: string, seriesInstanceUID: string): Promise<DicomwebApiResponse<any>> {
    const result = await this.searchSeries(datastoreId, studyInstanceUID, { SeriesInstanceUID: seriesInstanceUID });
    return {
      success: result.success,
      data: result.data?.[0] || null,
      error: result.error,
      message: result.message
    };
  }

  async getInstanceMetadata(datastoreId: string, studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string, internalDatastoreId?: string, storageType?: DatastoreStorageType): Promise<DicomwebApiResponse<any>> {
    const result = await this.searchInstances(datastoreId, studyInstanceUID, seriesInstanceUID, { SOPInstanceUID: sopInstanceUID }, internalDatastoreId, storageType);
    return {
      success: result.success,
      data: result.data?.[0] || null,
      error: result.error,
      message: result.message
    };
  }

  /**
   * Get full instance metadata via WADO-RS endpoint.
   * Returns pixel-level DICOM attributes needed for correct image rendering.
   */
  async getInstanceWadoMetadata(
    datastoreId: string,
    studyInstanceUID: string,
    seriesInstanceUID: string,
    sopInstanceUID: string,
    internalDatastoreId?: string,
    storageType?: DatastoreStorageType
  ): Promise<DicomwebApiResponse<DicomPixelMetadata>> {
    try {
      const endpoint = `/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/metadata`;
      const response = await this.makeRequest(datastoreId, endpoint, undefined, internalDatastoreId, storageType);

      const item = Array.isArray(response) ? response[0] : response;
      if (!item) {
        return { success: false, error: 'No metadata returned from WADO-RS endpoint' };
      }

      const data: DicomPixelMetadata = {
        rows: this.getNumber(item['00280010']),
        columns: this.getNumber(item['00280011']),
        bitsAllocated: this.getNumber(item['00280100']) || 16,
        bitsStored: this.getNumber(item['00280101']) || 16,
        samplesPerPixel: this.getNumber(item['00280002']) || 1,
        photometricInterpretation: this.getString(item['00280004']) || 'MONOCHROME2',
        planarConfiguration: this.getNumber(item['00280006']),
        pixelRepresentation: this.getNumber(item['00280103']),
        transferSyntaxUID: this.getString(item['00020010']) || undefined,
        windowCenter: this.getNumber(item['00281050']) || undefined,
        windowWidth: this.getNumber(item['00281051']) || undefined,
        rescaleIntercept: this.getNumber(item['00281052']) || undefined,
        rescaleSlope: this.getNumber(item['00281053']) || undefined,
      };

      console.log('📊 WADO-RS pixel metadata received'); // DICOM metadata carries PHI; not logged
      return { success: true, data };
    } catch (error) {
      console.error('❌ Error fetching WADO-RS instance metadata:', { errorType: error.name });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to retrieve WADO-RS instance metadata'
      };
    }
  }

  /**
   * Request one frame from the S3 datastore container.
   *
   * The container serves frames as-stored unless the Accept header names a transfer
   * syntax, and the raw-pixel renderer in this app can only read uncompressed
   * pixels - so ask for Explicit VR Little Endian explicitly. Lossy syntaxes are
   * still returned as-stored (re-encoding them would add loss); those parts arrive
   * as image/jpeg and the multipart parser hands them to the browser decoder.
   */
  private async fetchS3Frame(internalDatastoreId: string, endpoint: string): Promise<Response> {
    const token = await amplifyAuthService.getToken();
    if (!token) {
      throw new Error('No authentication token available. Please log in.');
    }

    const url = `${S3_DICOMWEB_BASE_PATH}/${encodeURIComponent(internalDatastoreId)}${endpoint}`;

    return await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': `multipart/related; type="application/octet-stream"; transfer-syntax=${EXPLICIT_VR_LITTLE_ENDIAN}`,
        'Authorization': `Bearer ${token}`
      }
    });
  }

  /**
   * Get a specific frame from a DICOM instance
   * Uses the DICOMweb WADO-RS API to retrieve rendered frames
   */
  async getFrame(datastoreId: string, studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string, frameNumber: number, internalDatastoreId?: string, storageType?: DatastoreStorageType): Promise<DicomwebApiResponse<ArrayBuffer>> {
    try {
      const endpoint = `/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/frames/${frameNumber}`;

      const response = await this.fetchS3Frame(internalDatastoreId || datastoreId, endpoint);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Handle multipart response
      const contentType = response.headers.get('content-type') || '';
      console.log('Response Content-Type:', contentType);

      if (contentType.includes('multipart/related')) {
        // Parse multipart response to extract the image data
        const arrayBuffer = await response.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // Extract boundary from content-type header
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);
        if (!boundaryMatch) {
          throw new Error('No boundary found in multipart response');
        }

        const boundary = boundaryMatch[1].replace(/"/g, ''); // Remove quotes if present
        const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
        console.log('Multipart boundary:', boundary);

        // Find boundary positions in the binary data
        const boundaryPositions: number[] = [];
        for (let i = 0; i <= uint8Array.length - boundaryBytes.length; i++) {
          let match = true;
          for (let j = 0; j < boundaryBytes.length; j++) {
            if (uint8Array[i + j] !== boundaryBytes[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            boundaryPositions.push(i);
          }
        }

        console.log('Found boundary positions:', boundaryPositions);

        // Process each part
        for (let i = 0; i < boundaryPositions.length - 1; i++) {
          const partStart = boundaryPositions[i] + boundaryBytes.length;
          const partEnd = boundaryPositions[i + 1];
          const partData = uint8Array.slice(partStart, partEnd);

          // Convert part to string to check headers
          const partText = new TextDecoder().decode(partData.slice(0, Math.min(500, partData.length)));

          // The part header carries the transfer syntax actually returned, which for an
          // S3 datastore is not always the one asked for: the container refuses to
          // re-encode lossy syntaxes and streams those as-stored instead.
          const partTransferSyntax = partText.match(/transfer-syntax="?([^\s";\r\n]+)/)?.[1] || '';
          const isRawPart = partText.includes('Content-Type: application/octet-stream');
          const isJpegPart = partText.includes('Content-Type: image/jpeg');

          if (isRawPart || isJpegPart) {
            console.log(isRawPart ? 'Found raw pixel data part' : 'Found JPEG-encoded frame part');
            console.log('Transfer syntax info:', partTransferSyntax || 'not found');

            // Find the end of headers (double CRLF: \r\n\r\n)
            let headerEndIndex = -1;

            for (let j = 0; j <= partData.length - 4; j++) {
              if (partData[j] === 13 && partData[j + 1] === 10 &&
                  partData[j + 2] === 13 && partData[j + 3] === 10) {
                headerEndIndex = j + 4;
                break;
              }
            }

            if (headerEndIndex !== -1) {
              // Extract raw pixel data
              const pixelData = partData.slice(headerEndIndex);

              console.log('✅ Successfully extracted DICOM frame payload');
              console.log('Frame payload size:', pixelData.byteLength, 'bytes');
              console.log('Transfer syntax:', partTransferSyntax || EXPLICIT_VR_LITTLE_ENDIAN);

              // Raw pixel data needs windowing and photometric handling before it can
              // be displayed; a JPEG part goes straight to the browser decoder.
              return {
                success: true,
                data: pixelData.buffer,
                metadata: {
                  transferSyntax: partTransferSyntax || EXPLICIT_VR_LITTLE_ENDIAN,
                  contentType: isRawPart ? 'application/octet-stream' : 'image/jpeg',
                  isRawPixelData: isRawPart
                }
              };
            }
          }
        }

        throw new Error('Could not find pixel data in multipart response');
      } else {
        // Handle as direct binary response (fallback)
        const arrayBuffer = await response.arrayBuffer();

        console.log('✅ Successfully retrieved DICOM frame (direct response)');

        return {
          success: true,
          data: arrayBuffer
        };
      }

    } catch (error) {
      console.error('❌ Error getting DICOM frame:', error.message);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
        message: 'Failed to retrieve DICOM frame'
      };
    }
  }
}

// Create and export a singleton instance
export const dicomwebService = new DICOMwebService();
export default dicomwebService;
