/**
 * PHI notice: this module handles Protected Health Information (patient name, ID,
 * birth date, sex, accession number and other DICOM identifiers). Deployers are
 * responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
 * responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
 */
import { apiRequest } from '../utils/api';

/**
 * Studies Service - API Gateway Integration
 * 
 * NOTE: This service calls the API Gateway /api/studies endpoint.
 * For direct access to S3 datastores, use dicomwebService instead.
 * The DICOM Browser component uses dicomwebService.searchStudies() to query
 * datastores directly via the DICOMweb API without going through API Gateway.
 */

export interface Study {
  id: string;
  studyInstanceUID: string;
  patientId: string;
  patientName: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate: string;
  studyTime?: string;
  studyDescription?: string;
  studyId?: string;
  accessionNumber?: string;
  modalities: string[];
  seriesCount: number;
  instanceCount: number;
  datastoreId: string;
  datastoreName: string;
  status: 'AVAILABLE' | 'DELETING' | 'DELETED' | 'ERROR';
  createdAt: string;
  updatedAt: string;
  sizeInBytes: number;
  series?: any[];
  metadata?: any;
}

export interface StudyFilters {
  datastoreId?: string;
  patientId?: string;
  studyDate?: string;
  modality?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface StudyListResponse {
  items: Study[];
  totalCount: number;
  scannedCount: number;
  pageSize: number;
  nextToken?: string;
  hasNextPage: boolean;
  filters: StudyFilters;
}

export const studiesService = {
  // List studies with optional filtering
  async listStudies(filters: StudyFilters = {}, limit: number = 50, nextToken?: string): Promise<StudyListResponse> {
    const params = new URLSearchParams();
    
    if (filters.datastoreId) params.append('datastoreId', filters.datastoreId);
    if (filters.patientId) params.append('patientId', filters.patientId);
    if (filters.studyDate) params.append('studyDate', filters.studyDate);
    if (filters.modality) params.append('modality', filters.modality);
    if (filters.sortBy) params.append('sortBy', filters.sortBy);
    if (filters.sortOrder) params.append('sortOrder', filters.sortOrder);
    if (limit) params.append('limit', limit.toString());
    if (nextToken) params.append('nextToken', nextToken);

    const queryString = params.toString();
    const url = queryString ? `/api/studies?${queryString}` : '/api/studies';
    
    const response = await apiRequest(url, {
      method: 'GET',
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch studies');
    }

    return response.data;
  },

  // Get a specific study by ID
  async getStudy(studyId: string): Promise<Study> {
    const response = await apiRequest(`/api/studies/${studyId}`, {
      method: 'GET',
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to fetch study');
    }

    return response.data;
  },

  // Delete a study (async operation)
  async deleteStudy(studyId: string): Promise<{ success: boolean; message: string; data: any }> {
    const response = await apiRequest(`/api/studies/${studyId}`, {
      method: 'DELETE',
    });

    if (!response.success) {
      throw new Error(response.error || 'Failed to delete study');
    }

    return response;
  },

  // Get studies by datastore
  async getStudiesByDatastore(datastoreId: string, limit: number = 50): Promise<StudyListResponse> {
    return this.listStudies({ datastoreId }, limit);
  },

  // Search studies by patient
  async searchStudiesByPatient(patientId: string, limit: number = 50): Promise<StudyListResponse> {
    return this.listStudies({ patientId }, limit);
  },

  // Get studies by modality
  async getStudiesByModality(modality: string, limit: number = 50): Promise<StudyListResponse> {
    return this.listStudies({ modality }, limit);
  },

  // Get studies by date range
  async getStudiesByDate(studyDate: string, limit: number = 50): Promise<StudyListResponse> {
    return this.listStudies({ studyDate }, limit);
  }
};
