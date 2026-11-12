import { amplifyAuthService } from '../services/amplifyAuthService';

// Configuration
const config = (window as any).REACT_APP_CONFIG || {};
const API_BASE_URL = config.API_BASE_URL || 'http://localhost:3001/api';

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: any;
}

export async function apiRequest(url: string, options: ApiRequestOptions = {}): Promise<any> {
  const { method = 'GET', headers = {}, body } = options;
  
  try {
    // Get auth token
    const token = await amplifyAuthService.getToken();
    
    // Prepare headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };
    
    if (token) {
      requestHeaders['Authorization'] = `Bearer ${token}`;
    }
    
    // Prepare request options
    const requestOptions: RequestInit = {
      method,
      headers: requestHeaders,
    };
    
    if (body && method !== 'GET') {
      requestOptions.body = JSON.stringify(body);
    }
    
    // Make the request
    const fullUrl = url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
    const response = await fetch(fullUrl, requestOptions);
    
    // Handle response
    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.message || errorMessage;
      } catch {
        // If not JSON, use the text as is
        if (errorText) {
          errorMessage = errorText;
        }
      }
      
      throw new Error(errorMessage);
    }
    
    // Parse JSON response
    const data = await response.json();
    return data;
    
  } catch (error) {
    console.error('API Request failed:', error.message);
    throw error;
  }
}
