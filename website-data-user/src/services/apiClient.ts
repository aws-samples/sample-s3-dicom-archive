import axios, { AxiosInstance } from 'axios';
import { authService } from './authService';
import { configService } from './configService';

export interface Datastore {
  id: string;
  name: string;
  status: string;
  datastoreArn: string;
}

export interface VirtualFolder {
  id: string;
  name: string;
  status: string;
}

class ApiClient {
  private client: AxiosInstance | null = null;

  private getClient(): AxiosInstance {
    if (!this.client) {
      const config = configService.getConfig();
      this.client = axios.create({
        baseURL: config.apiUrl
      });

      this.client.interceptors.request.use(async (config) => {
        const token = await authService.getAccessToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      });
    }
    return this.client;
  }

  async getDatastores(): Promise<Datastore[]> {
    try {
      const response = await this.getClient().get('/datastores');
      return response.data?.data?.items || [];
    } catch (error) {
      console.error('Failed to fetch datastores:', { errorType: error.name });
      return [];
    }
  }

  async getVirtualFolders(): Promise<VirtualFolder[]> {
    try {
      const response = await this.getClient().get('/virtual-folders');
      return response.data?.data?.items || [];
    } catch (error) {
      console.error('Failed to fetch virtual folders:', { errorType: error.name });
      return [];
    }
  }

  async queryStudies(datastoreId: string, params: any): Promise<any[]> {
    try {
      const response = await this.getClient().get(`/datastores/${datastoreId}/studies`, { params });
      return response.data.data || response.data || [];
    } catch (error) {
      console.error('Failed to query studies:', { errorType: error.name });
      return [];
    }
  }

  async queryVirtualFolderStudies(folderId: string, params: any): Promise<any[]> {
    try {
      const response = await this.getClient().get(`/${folderId}/studies`, { params });
      return response.data.data || response.data || [];
    } catch (error) {
      console.error('Failed to query virtual folder studies:', { errorType: error.name });
      return [];
    }
  }
}

export const apiClient = new ApiClient();
