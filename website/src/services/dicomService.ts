import { 
  DicomEntity, 
  DicomEntitySummary, 
  CreateDicomEntityRequest, 
  UpdateDicomEntityRequest,
  UpdateEntityPrivilegesRequest,
  ListDicomEntitiesResponse,
  ApiResponse,
  AsyncJobResponse,
  DicomStudy,
  DicomSeries,
  DicomInstance,
  DicomPrivilegeType
} from '../types/dicom';
import { amplifyAuthService } from './amplifyAuthService';

// Configuration - Prioritize runtime config over environment variables
const config = (window as any).REACT_APP_CONFIG || {};
const API_BASE_URL = config.API_BASE_URL || '';

class DicomService {
  private async makeRequest<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const token = await amplifyAuthService.getToken();
    
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` }),
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  // DICOM Entity CRUD Operations
  async createDicomEntity(request: CreateDicomEntityRequest): Promise<ApiResponse<DicomEntity>> {
    return this.makeRequest<DicomEntity>('/api/dicom-entities', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getDicomEntity(id: string): Promise<ApiResponse<DicomEntity>> {
    return this.makeRequest<DicomEntity>(`/api/dicom-entities/${id}`);
  }

  async updateDicomEntity(id: string, request: UpdateDicomEntityRequest): Promise<ApiResponse<DicomEntity>> {
    return this.makeRequest<DicomEntity>(`/api/dicom-entities/${id}`, {
      method: 'PUT',
      body: JSON.stringify(request),
    });
  }

  async deleteDicomEntity(id: string): Promise<ApiResponse<void>> {
    return this.makeRequest<void>(`/api/dicom-entities/${id}`, {
      method: 'DELETE',
    });
  }

  async listDicomEntities(
    limit?: number, 
    nextToken?: string, 
    entityType?: string,
    status?: string
  ): Promise<ApiResponse<ListDicomEntitiesResponse>> {
    const params = new URLSearchParams();
    if (limit) params.append('limit', limit.toString());
    if (nextToken) params.append('nextToken', nextToken);
    if (entityType) params.append('entityType', entityType);
    if (status) params.append('status', status);

    const queryString = params.toString();
    const endpoint = `/api/dicom-entities${queryString ? `?${queryString}` : ''}`;
    
    return this.makeRequest<ListDicomEntitiesResponse>(endpoint);
  }

  // DICOM Entity Privilege Management
  async updateEntityPrivileges(
    entityId: string, 
    interfaceId: string, 
    request: UpdateEntityPrivilegesRequest
  ): Promise<ApiResponse<void>> {
    return this.makeRequest<void>(`/api/dicom-entities/${entityId}/privileges/${interfaceId}`, {
      method: 'PUT',
      body: JSON.stringify(request),
    });
  }

  async removeEntityPrivileges(entityId: string, interfaceId: string): Promise<ApiResponse<void>> {
    return this.makeRequest<void>(`/api/dicom-entities/${entityId}/privileges/${interfaceId}`, {
      method: 'DELETE',
    });
  }

  // DICOM Studies Operations
  async listStudies(
    datastoreId?: string,
    patientId?: string,
    studyDate?: string,
    modality?: string,
    limit?: number,
    nextToken?: string
  ): Promise<ApiResponse<{ studies: DicomStudy[], nextToken?: string, totalCount: number }>> {
    const params = new URLSearchParams();
    if (datastoreId) params.append('datastoreId', datastoreId);
    if (patientId) params.append('patientId', patientId);
    if (studyDate) params.append('studyDate', studyDate);
    if (modality) params.append('modality', modality);
    if (limit) params.append('limit', limit.toString());
    if (nextToken) params.append('nextToken', nextToken);

    const queryString = params.toString();
    const endpoint = `/api/studies${queryString ? `?${queryString}` : ''}`;
    
    return this.makeRequest<{ studies: DicomStudy[], nextToken?: string, totalCount: number }>(endpoint);
  }

  async getStudy(studyInstanceUID: string): Promise<ApiResponse<DicomStudy>> {
    return this.makeRequest<DicomStudy>(`/api/studies/${studyInstanceUID}`);
  }

  async deleteStudy(studyInstanceUID: string): Promise<ApiResponse<AsyncJobResponse>> {
    return this.makeRequest<AsyncJobResponse>(`/api/studies/${studyInstanceUID}`, {
      method: 'DELETE',
    });
  }

  // DICOM Series Operations
  async listSeries(studyInstanceUID: string): Promise<ApiResponse<{ series: DicomSeries[] }>> {
    return this.makeRequest<{ series: DicomSeries[] }>(`/api/studies/${studyInstanceUID}/series`);
  }

  async getSeries(studyInstanceUID: string, seriesInstanceUID: string): Promise<ApiResponse<DicomSeries>> {
    return this.makeRequest<DicomSeries>(`/api/studies/${studyInstanceUID}/series/${seriesInstanceUID}`);
  }

  async deleteSeries(studyInstanceUID: string, seriesInstanceUID: string): Promise<ApiResponse<AsyncJobResponse>> {
    return this.makeRequest<AsyncJobResponse>(`/api/studies/${studyInstanceUID}/series/${seriesInstanceUID}`, {
      method: 'DELETE',
    });
  }

  // DICOM Instance Operations
  async listInstances(studyInstanceUID: string, seriesInstanceUID: string): Promise<ApiResponse<{ instances: DicomInstance[] }>> {
    return this.makeRequest<{ instances: DicomInstance[] }>(`/api/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances`);
  }

  async getInstance(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string): Promise<ApiResponse<DicomInstance>> {
    return this.makeRequest<DicomInstance>(`/api/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}`);
  }

  async deleteInstance(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string): Promise<ApiResponse<AsyncJobResponse>> {
    return this.makeRequest<AsyncJobResponse>(`/api/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}`, {
      method: 'DELETE',
    });
  }

  // NOTE: getImageUrl/getThumbnailUrl were removed. They baked the bearer token
  // into the URL query string (`?token=...`), which leaks the credential into
  // browser history, Referer headers and server access logs. They had no callers.
  // Image/thumbnail retrieval must send the token in the Authorization header
  // (as the other dicomService methods do), not the URL.

  // DICOM Metadata Operations
  async getStudyMetadata(studyInstanceUID: string): Promise<ApiResponse<any>> {
    return this.makeRequest<any>(`/api/studies/${studyInstanceUID}/metadata`);
  }

  async getSeriesMetadata(studyInstanceUID: string, seriesInstanceUID: string): Promise<ApiResponse<any>> {
    return this.makeRequest<any>(`/api/studies/${studyInstanceUID}/series/${seriesInstanceUID}/metadata`);
  }

  async getInstanceMetadata(studyInstanceUID: string, seriesInstanceUID: string, sopInstanceUID: string): Promise<ApiResponse<any>> {
    return this.makeRequest<any>(`/api/studies/${studyInstanceUID}/series/${seriesInstanceUID}/instances/${sopInstanceUID}/metadata`);
  }

  // DICOM Statistics
  async getDicomStatistics(): Promise<ApiResponse<{
    totalStudies: number;
    totalSeries: number;
    totalInstances: number;
    totalSize: number;
    modalityBreakdown: Record<string, number>;
    dailyIngestion: Array<{ date: string; count: number; size: number }>;
  }>> {
    return this.makeRequest<{
      totalStudies: number;
      totalSeries: number;
      totalInstances: number;
      totalSize: number;
      modalityBreakdown: Record<string, number>;
      dailyIngestion: Array<{ date: string; count: number; size: number }>;
    }>('/api/dicom/statistics');
  }

  // Job Status Monitoring
  async getJobStatus(jobId: string): Promise<ApiResponse<{
    jobId: string;
    status: 'in-progress' | 'completed' | 'failed';
    progress?: number;
    message?: string;
    result?: any;
    error?: any;
    startTime: string;
    estimatedCompletion?: string;
  }>> {
    return this.makeRequest<{
      jobId: string;
      status: 'in-progress' | 'completed' | 'failed';
      progress?: number;
      message?: string;
      result?: any;
      error?: any;
      startTime: string;
      estimatedCompletion?: string;
    }>(`/api/jobs/${jobId}`);
  }
}

export const dicomService = new DicomService();
export default dicomService;
