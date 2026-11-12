import { apiRequest } from './api';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

class ApiClient {
  async get(url: string): Promise<ApiResponse> {
    try {
      const response = await apiRequest(url, { method: 'GET' });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'REQUEST_FAILED',
          message: error.message || 'Request failed'
        }
      };
    }
  }

  async post(url: string, data?: any): Promise<ApiResponse> {
    try {
      const response = await apiRequest(url, { 
        method: 'POST',
        body: data
      });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'REQUEST_FAILED',
          message: error.message || 'Request failed'
        }
      };
    }
  }

  async put(url: string, data?: any): Promise<ApiResponse> {
    try {
      const response = await apiRequest(url, { 
        method: 'PUT',
        body: data
      });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'REQUEST_FAILED',
          message: error.message || 'Request failed'
        }
      };
    }
  }

  async delete(url: string): Promise<ApiResponse> {
    try {
      const response = await apiRequest(url, { method: 'DELETE' });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'REQUEST_FAILED',
          message: error.message || 'Request failed'
        }
      };
    }
  }

  async patch(url: string, data?: any): Promise<ApiResponse> {
    try {
      const response = await apiRequest(url, { 
        method: 'PATCH',
        body: data
      });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: {
          code: 'REQUEST_FAILED',
          message: error.message || 'Request failed'
        }
      };
    }
  }
}

export const apiClient = new ApiClient();
