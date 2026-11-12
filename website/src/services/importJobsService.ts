import {
  ApiResponse,
  PaginatedResponse,
  ImportJob,
  ImportJobFilters,
  CreateImportJobRequest,
  UpdateImportJobRequest
} from '../types';

import { amplifyAuthService } from './amplifyAuthService';

// Configuration - Prioritize runtime config over environment variables
const config = (window as any).REACT_APP_CONFIG || {};
const API_BASE_URL = config.API_BASE_URL || 'http://localhost:3001/api';

class ImportJobsService {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private async getAuthToken(): Promise<string | null> {
    return await amplifyAuthService.getToken();
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = await this.getAuthToken();
    
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
    }

    return response.json();
  }

  // Get paginated list of import jobs with filters
  async getImportJobs(filters: ImportJobFilters = {}): Promise<PaginatedResponse<ImportJob>> {
    const params = new URLSearchParams();
    
    // Handle pagination parameters - calculate offset from page
    const pageSize = filters.pageSize || 20;
    if (filters.page) {
      const offset = (filters.page - 1) * pageSize;
      params.append('offset', offset.toString());
      console.log('📄 Offset parameter being sent:', offset, '(page:', filters.page, ', pageSize:', pageSize, ')');
    }
    if (filters.pageSize) {
      params.append('pageSize', filters.pageSize.toString());
      console.log('📏 PageSize parameter being sent:', filters.pageSize);
    }
    
    // Handle filter parameters
    if (filters.sortBy) params.append('sortBy', filters.sortBy);
    if (filters.sortOrder) params.append('sortOrder', filters.sortOrder);
    if (filters.status) params.append('status', filters.status);
    if (filters.jobType) params.append('jobType', filters.jobType);
    if (filters.datastoreId) params.append('datastoreId', filters.datastoreId);
    if (filters.calledAeTitle) params.append('calledAeTitle', filters.calledAeTitle);
    if (filters.callingAeTitle) params.append('callingAeTitle', filters.callingAeTitle);
    if (filters.createdDateFrom) params.append('createdDateFrom', filters.createdDateFrom);
    if (filters.createdDateTo) params.append('createdDateTo', filters.createdDateTo);
    if (filters.createdBy) params.append('createdBy', filters.createdBy);

    const queryString = params.toString();
    const endpoint = `/import-jobs${queryString ? `?${queryString}` : ''}`;
    
    // Debug logging (development only, non-sensitive fields)
    if (import.meta.env.DEV) {
      console.log('🔍 API Call:', {
        endpoint: endpoint,
        pageRequested: filters.page
      });
    }
    
    const response = await this.request<ApiResponse<PaginatedResponse<ImportJob>>>(endpoint);
    
    // Debug the raw response (development only, non-sensitive fields)
    if (import.meta.env.DEV) {
      console.log('🔍 API Response:', {
        endpoint: endpoint,
        itemsLength: response.data?.items?.length || 0,
        totalCount: response.data?.totalCount
      });
    }
    
    // Check if the backend is actually respecting the page parameter
    if (filters.page && response.data?.currentPage && filters.page !== response.data.currentPage) {
      console.warn('⚠️ Page parameter mismatch!', {
        requested: filters.page,
        returned: response.data.currentPage,
        message: 'Backend may not be handling page parameter correctly'
      });
    }
    
    return response.data;
  }

  // Get a specific import job by ID
  async getImportJob(id: string): Promise<ImportJob> {
    const response = await this.request<ApiResponse<ImportJob>>(`/import-jobs/${id}`);
    return response.data;
  }

  // Create a new import job
  async createImportJob(importJob: CreateImportJobRequest): Promise<ImportJob> {
    const response = await this.request<ApiResponse<ImportJob>>('/import-jobs', {
      method: 'POST',
      body: JSON.stringify(importJob),
    });
    return response.data;
  }

  // Update an existing import job
  async updateImportJob(id: string, updates: UpdateImportJobRequest): Promise<ImportJob> {
    const response = await this.request<ApiResponse<ImportJob>>(`/import-jobs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
    return response.data;
  }

  // Cancel an import job
  async cancelImportJob(id: string): Promise<ImportJob> {
    const response = await this.request<ApiResponse<ImportJob>>(`/import-jobs/${id}/cancel`, {
      method: 'POST',
    });
    return response.data;
  }

  // Retry a failed import job
  async retryImportJob(id: string): Promise<ImportJob> {
    const response = await this.request<ApiResponse<ImportJob>>(`/import-jobs/${id}/retry`, {
      method: 'POST',
    });
    return response.data;
  }

  // Delete an import job
  async deleteImportJob(id: string): Promise<void> {
    await this.request<ApiResponse<void>>(`/import-jobs/${id}`, {
      method: 'DELETE',
    });
  }

  // Get import job statistics
  async getImportJobStats(): Promise<{
    totalJobs: number;
    runningJobs: number;
    completedJobs: number;
    failedJobs: number;
    totalFilesProcessed: number;
    totalDataProcessedMB: number;
  }> {
    const response = await this.request<ApiResponse<any>>('/import-jobs/stats');
    return response.data;
  }
}

export const importJobsService = new ImportJobsService();
