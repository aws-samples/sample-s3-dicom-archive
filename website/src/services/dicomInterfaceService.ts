import { ApiResponse } from '../types/dicom';
import { DicomInterfaceListResponse, DicomInterface } from '../types';
import { amplifyAuthService } from './amplifyAuthService';

// Configuration - Prioritize runtime config over environment variables
const config = (window as any).REACT_APP_CONFIG || {};
const API_BASE_URL = config.API_BASE_URL || '';

class DicomInterfaceService {
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
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  async listDicomInterfaces(
    limit?: number, 
    nextToken?: string,
    status?: string
  ): Promise<ApiResponse<DicomInterfaceListResponse>> {
    const params = new URLSearchParams();
    if (limit) params.append('limit', limit.toString());
    if (nextToken) params.append('nextToken', nextToken);
    if (status) params.append('status', status);

    const queryString = params.toString();
    const endpoint = `/dicom-interfaces${queryString ? `?${queryString}` : ''}`;
    
    return this.makeRequest<DicomInterfaceListResponse>(endpoint);
  }

  async getDicomInterface(id: string): Promise<ApiResponse<DicomInterface>> {
    return this.makeRequest<DicomInterface>(`/dicom-interfaces/${id}`);
  }
}

export const dicomInterfaceService = new DicomInterfaceService();
export default dicomInterfaceService;
