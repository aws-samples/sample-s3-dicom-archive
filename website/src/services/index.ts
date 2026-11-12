// Service layer that components will use
// This provides a clean interface and can handle error handling, caching, etc.

import apiClient from './apiClient';
import { importJobsService } from './importJobsService';
import {
  Datastore,
  CreateDatastoreRequest,
  UpdateDatastoreRequest,
  DicomInterface,
  DicomInterfaceListResponse,
  CreateDicomInterfaceRequest,
  UpdateDicomInterfaceRequest,
  User,
  CreateUserRequest,
  UpdateUserRequest,
  RecentActivity,
  ListParams,
  PaginatedResponse
} from '../types';

export { apiClient };

// Dashboard Services
export const dashboardService = {
  async getStats(): Promise<any[]> {
    const response = await apiClient.getDashboardStats();
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch dashboard stats');
    }
    return response.data;
  },

  async getRecentActivity(): Promise<RecentActivity[]> {
    const response = await apiClient.getRecentActivity();
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch recent activity');
    }
    return response.data;
  },

  async getModalityData(): Promise<any[]> {
    const response = await apiClient.getModalityData();
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch modality data');
    }
    return response.data;
  },

  async getAcquisitionTrendData(): Promise<any[]> {
    const response = await apiClient.getAcquisitionTrendData();
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch acquisition trend data');
    }
    return response.data;
  },

  async getStorageGrowthData(): Promise<any[]> {
    const response = await apiClient.getStorageGrowthData();
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch storage growth data');
    }
    return response.data;
  },

  async getDatastoreUtilization(): Promise<any[]> {
    const response = await apiClient.getDatastoreUtilization();
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch datastore utilization');
    }
    return response.data;
  }
};

// Datastore Services
export const datastoreService = {
  async getAll(params?: ListParams): Promise<PaginatedResponse<Datastore>> {
    const response = await apiClient.getDatastores(params);
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch datastores');
    }
    return response.data;
  },

  async getById(id: string): Promise<Datastore> {
    const response = await apiClient.getDatastore(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch datastore');
    }
    return response.data;
  },

  async create(data: CreateDatastoreRequest): Promise<Datastore> {
    const response = await apiClient.createDatastore(data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to create datastore');
    }
    return response.data;
  },

  async update(id: string, data: UpdateDatastoreRequest): Promise<Datastore> {
    const response = await apiClient.updateDatastore(id, data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to update datastore');
    }
    return response.data;
  },

  async delete(id: string): Promise<void> {
    const response = await apiClient.deleteDatastore(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to delete datastore');
    }
  },

  async deleteMultiple(ids: string[]): Promise<void> {
    // For now, delete one by one. In real implementation, this could be a batch operation
    await Promise.all(ids.map(id => this.delete(id)));
  }
};

// DICOM Interface Services
export const dicomInterfaceService = {
  async getAll(params?: ListParams): Promise<DicomInterfaceListResponse> {
    const response = await apiClient.getDicomInterfaces(params);
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch DICOM interfaces');
    }
    return response.data;
  },

  async getById(id: string): Promise<DicomInterface> {
    const response = await apiClient.getDicomInterface(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch DICOM interface');
    }
    return response.data;
  },

  async create(data: CreateDicomInterfaceRequest): Promise<DicomInterface> {
    const response = await apiClient.createDicomInterface(data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to create DICOM interface');
    }
    return response.data;
  },

  async update(id: string, data: UpdateDicomInterfaceRequest): Promise<DicomInterface> {
    const response = await apiClient.updateDicomInterface(id, data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to update DICOM interface');
    }
    return response.data;
  },

  async delete(id: string): Promise<void> {
    const response = await apiClient.deleteDicomInterface(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to delete DICOM interface');
    }
  },

  async deleteMultiple(ids: string[]): Promise<void> {
    await Promise.all(ids.map(id => this.delete(id)));
  }
};

// User Services
export const userService = {
  async getAll(params?: ListParams): Promise<PaginatedResponse<User>> {
    const response = await apiClient.getUsers(params);
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch users');
    }
    return response.data;
  },

  async getById(id: string): Promise<User> {
    const response = await apiClient.getUser(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch user');
    }
    return response.data;
  },

  async create(data: CreateUserRequest): Promise<User> {
    const response = await apiClient.createUser(data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to create user');
    }
    return response.data;
  },

  async update(id: string, data: UpdateUserRequest): Promise<User> {
    const response = await apiClient.updateUser(id, data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to update user');
    }
    return response.data;
  },

  async delete(id: string): Promise<void> {
    const response = await apiClient.deleteUser(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to delete user');
    }
  },

  async deleteMultiple(ids: string[]): Promise<void> {
    await Promise.all(ids.map(id => this.delete(id)));
  }
};

// Import Jobs Service
export const importJobService = {
  async getAll(filters = {}) {
    return await importJobsService.getImportJobs(filters);
  },

  async getById(id: string) {
    return await importJobsService.getImportJob(id);
  },

  async create(data: any) {
    return await importJobsService.createImportJob(data);
  },

  async update(id: string, data: any) {
    return await importJobsService.updateImportJob(id, data);
  },

  async cancel(id: string) {
    return await importJobsService.cancelImportJob(id);
  },

  async retry(id: string) {
    return await importJobsService.retryImportJob(id);
  },

  async delete(id: string) {
    return await importJobsService.deleteImportJob(id);
  },

  async getStats() {
    return await importJobsService.getImportJobStats();
  }
};

// Privilege Groups Service
export const privilegeGroupService = {
  async getAll() {
    const response = await apiClient.getPrivilegeGroups();
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch privilege groups');
    }
    return response.data;
  },

  async getById(id: string) {
    const response = await apiClient.getPrivilegeGroup(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to fetch privilege group');
    }
    return response.data;
  },

  async create(data: any) {
    const response = await apiClient.createPrivilegeGroup(data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to create privilege group');
    }
    return response.data;
  },

  async update(id: string, data: any) {
    const response = await apiClient.updatePrivilegeGroup(id, data);
    if (!response.success) {
      throw new Error(response.message || 'Failed to update privilege group');
    }
    return response.data;
  },

  async delete(id: string) {
    const response = await apiClient.deletePrivilegeGroup(id);
    if (!response.success) {
      throw new Error(response.message || 'Failed to delete privilege group');
    }
    return response.data;
  }
};
