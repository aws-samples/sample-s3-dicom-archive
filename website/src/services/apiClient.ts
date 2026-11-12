import {
  ApiResponse,
  PaginatedResponse,
  ListParams,
  Datastore,
  CreateDatastoreRequest,
  UpdateDatastoreRequest,
  DicomInterface,
  DicomInterfaceListResponse,
  CreateDicomInterfaceRequest,
  UpdateDicomInterfaceRequest,
  Hl7Interface,
  CreateHl7InterfaceRequest,
  UpdateHl7InterfaceRequest,
  Study,
  StudyFilters,
  User,
  CreateUserRequest,
  UpdateUserRequest,
  RecentActivity,
  AuditEntry,
  AuditFilters
} from '../types';

import { amplifyAuthService } from './amplifyAuthService';

/** One owner-side step to prepare an existing bucket for import. */
export interface ImportSetupStep {
  title: string;
  required: boolean;
  why: string;
  /** The JSON this step adds (notification rule, policy statement), when any. */
  json?: unknown;
  commands: string[];
}

/** GET /datastores/import/bucket-policy: what the bucket owner runs before import. */
export interface ImportSetup {
  bucketName: string;
  accessLevel: 'read-only';
  deploymentTag: string;
  ingestQueueArn: string;
  prefix: string | null;
  steps: ImportSetupStep[];
  /** IAM policy the person running the commands needs. */
  operatorPolicy: unknown;
  instructions: string;
}

// Configuration - Prioritize runtime config over environment variables
const config = (window as any).REACT_APP_CONFIG || {};
const API_BASE_URL = config.API_BASE_URL || 'http://localhost:3001/api';
const VDS_API_URL = config.VIRTUAL_FOLDER_API_URL || API_BASE_URL;

console.log('API Client Configuration:', {
  'API_BASE_URL': API_BASE_URL,
  'VDS_API_URL': VDS_API_URL
});

// Generic API client class
class ApiClient {
  private baseUrl: string;
  private vdsUrl: string;

  constructor() {
    this.baseUrl = API_BASE_URL;
    this.vdsUrl = VDS_API_URL;
  }

  private async getAuthToken(): Promise<string | null> {
    return await amplifyAuthService.getToken();
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    baseUrl?: string
  ): Promise<ApiResponse<T>> {
    try {
      const token = await this.getAuthToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string> || {}),
      };
      
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const url = (baseUrl || this.baseUrl) + endpoint;
      
      // Compress large request bodies
      if (options.body && typeof options.body === 'string' && options.body.length > 100_000) {
        const encoder = new TextEncoder();
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(encoder.encode(options.body));
        writer.close();
        const compressed = await new Response(cs.readable).arrayBuffer();
        const base64 = btoa(Array.from(new Uint8Array(compressed), b => String.fromCharCode(b)).join(''));
        options = { ...options, body: JSON.stringify({ compressed: true, data: base64 }) };
      }

      const response = await fetch(url, { headers, ...options });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`API error (${response.status})`);
        
        if (response.status === 401) {
          window.dispatchEvent(new CustomEvent('authError', { 
            detail: { status: 401, message: 'Authentication required' } 
          }));
        }
        
        let errorData: any = { message: errorText };
        try { errorData = JSON.parse(errorText); } catch {}
        
        const error: any = new Error(errorData.error?.message || errorData.message || errorText);
        error.response = { data: errorData, status: response.status };
        throw error;
      }

      const result = await response.json();
      if (result.compressed && typeof result.data === 'string') {
        const binary = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(binary);
        writer.close();
        const decompressed = await new Response(ds.readable).text();
        result.data = JSON.parse(decompressed);
      }
      return result;
    } catch (error) {
      console.error('API request failed:', error.message);
      throw error;
    }
  }

  private vdsRequest<T>(endpoint: string, method: string = 'GET', body?: any): Promise<ApiResponse<T>> {
    const options: RequestInit = {
      method,
      ...(body && { body: JSON.stringify(body) })
    };
    return this.request<T>(endpoint, options, this.vdsUrl);
  }

  // Public VDS request method
  async makeVdsRequest<T>(endpoint: string, method: string = 'GET', body?: any): Promise<ApiResponse<T>> {
    return this.vdsRequest<T>(endpoint, method, body);
  }

  // Public request method for custom API calls
  async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, options);
  }

  // Dashboard API
  async getDashboardStats(): Promise<ApiResponse<any[]>> {
    return this.request<any[]>('/dashboard/stats');
  }

  async getRecentActivity(): Promise<ApiResponse<RecentActivity[]>> {
    return this.request<RecentActivity[]>('/dashboard/activity');
  }

  async getModalityData(datastoreId?: string): Promise<ApiResponse<any[]>> {
    const params = datastoreId ? `?datastoreId=${datastoreId}` : '';
    return this.request<any[]>(`/dashboard/modality${params}`);
  }

  async getAcquisitionTrendData(): Promise<ApiResponse<any[]>> {
    return this.request<any[]>('/dashboard/acquisition-trend');
  }

  async getStorageGrowthData(params?: { datastoreIds?: string; startDate?: string; endDate?: string }): Promise<ApiResponse<any[]>> {
    const queryParams = new URLSearchParams();
    if (params?.datastoreIds) queryParams.append('datastoreIds', params.datastoreIds);
    if (params?.startDate) queryParams.append('startDate', params.startDate);
    if (params?.endDate) queryParams.append('endDate', params.endDate);
    const queryString = queryParams.toString();
    return this.request<any[]>(`/dashboard/storage-growth${queryString ? `?${queryString}` : ''}`);
  }

  async getDatastoreUtilization(): Promise<ApiResponse<any[]>> {
    return this.request<any[]>('/dashboard/utilization');
  }

  async getExceptionStats(): Promise<ApiResponse<any>> {
    return this.request<any>('/dashboard/exception-stats');
  }

  // Location API
  async getLocations(): Promise<ApiResponse<any[]>> {
    return this.request<any[]>('/locations');
  }

  async getLocation(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/locations/${id}`);
  }

  async activateDicomNode(locationId: string): Promise<ApiResponse<any>> {
    // Special handling for binary zip download
    const token = await this.getAuthToken();
    const headers: Record<string, string> = {
      'Accept': 'application/zip'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const url = this.baseUrl + `/locations/${locationId}/certificates/dicom`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to download certificates: ${response.statusText}`);
    }

    const blob = await response.blob();
    return { success: true, data: blob };
  }

  async activateHl7Node(locationId: string): Promise<ApiResponse<any>> {
    // Special handling for binary zip download
    const token = await this.getAuthToken();
    const headers: Record<string, string> = {
      'Accept': 'application/zip'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const url = this.baseUrl + `/locations/${locationId}/certificates/hl7`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(`Failed to download certificates: ${response.statusText}`);
    }

    const blob = await response.blob();
    return { success: true, data: blob };
  }

  // System Monitor API
  async getSystemMonitor(): Promise<ApiResponse<any>> {
    return this.request<any>('/system-monitor');
  }

  // Routing Rules API
  async getRoutingRules(interfaceId?: string): Promise<ApiResponse<any[]>> {
    const query = interfaceId ? `?interfaceId=${interfaceId}` : '';
    return this.request<any[]>(`/routing-rules${query}`);
  }

  async getRoutingRule(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/routing-rules/${id}`);
  }

  async createRoutingRule(data: any): Promise<ApiResponse<any>> {
    return this.request<any>('/routing-rules', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateRoutingRule(id: string, data: any): Promise<ApiResponse<any>> {
    return this.request<any>(`/routing-rules/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteRoutingRule(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/routing-rules/${id}`, { method: 'DELETE' });
  }

  async moveRulePriorityUp(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/routing-rules/${id}/priority/up`, { method: 'PATCH' });
  }

  async moveRulePriorityDown(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/routing-rules/${id}/priority/down`, { method: 'PATCH' });
  }

  // DICOM Tags API
  async getDicomTags(searchQuery?: string): Promise<ApiResponse<any>> {
    const query = searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : '';
    return this.request<any>(`/dicom-tags${query}`);
  }

  async createLocation(data: any): Promise<ApiResponse<any>> {
    return this.request<any>('/locations', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateLocation(id: string, data: any): Promise<ApiResponse<any>> {
    return this.request<any>(`/locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  async deleteLocation(id: string): Promise<ApiResponse<void>> {
    return this.request<void>(`/locations/${id}`, {
      method: 'DELETE'
    });
  }

  // Datastore API
  async getDatastores(params?: ListParams): Promise<ApiResponse<PaginatedResponse<Datastore>>> {
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<PaginatedResponse<Datastore>>(`/datastores?${queryString}`);
  }

  async getDatastore(id: string): Promise<ApiResponse<Datastore>> {
    return this.request<Datastore>(`/datastores/${id}`);
  }

  // ── Index Attributes: user-defined DICOM tags as indexed columns ──
  // Table-structure model: STORAGE defs are a single global structure; VF defs
  // are per-virtual-folder (pass virtualFolderId). Every defined column is
  // populated by ingest unconditionally — there is no per-scope opt-in.
  async listIndexAttributeDefs(targetType: 'STORAGE' | 'VF', virtualFolderId?: string): Promise<ApiResponse<any[]>> {
    const qs = `targetType=${encodeURIComponent(targetType)}` +
      (virtualFolderId ? `&virtualFolderId=${encodeURIComponent(virtualFolderId)}` : '');
    return this.request<any[]>(`/index-attributes/defs?${qs}`);
  }
  async createIndexAttributeDef(body: {
    targetType: 'STORAGE' | 'VF'; virtualFolderId?: string; dicomTag: string; dicomLevel: string;
    columnName: string; dataType?: string; isIndexed?: boolean; description?: string;
  }): Promise<ApiResponse<any>> {
    return this.request<any>('/index-attributes/defs', { method: 'POST', body: JSON.stringify(body) });
  }
  async deleteIndexAttributeDef(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/index-attributes/defs/${id}`, { method: 'DELETE' });
  }
  // (Re)start the back-fill of an existing STORAGE attribute from the stored
  // headers. A failed/stalled run resumes; restart=true starts over.
  async backfillIndexAttributeDef(id: string, restart = false): Promise<ApiResponse<any>> {
    return this.request<any>('/index-attributes/defs', {
      method: 'POST', body: JSON.stringify({ action: 'backfill', id, ...(restart ? { restart: true } : {}) }),
    });
  }
  async getDicomTags(search?: string): Promise<ApiResponse<{ dicom_attributes: any[] }>> {
    const q = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.request<{ dicom_attributes: any[] }>(`/dicom-tags${q}`);
  }

  // Raw storage-content listing: physical objects (storage_index) for a datastore,
  // DICOM + NON_DICOM. Optional contentKind filter ('DICOM' | 'NON_DICOM').
  async getStorageContent(
    id: string,
    params?: { page?: number; pageSize?: number; contentKind?: 'DICOM' | 'NON_DICOM' }
  ): Promise<ApiResponse<{ items: any[]; total: number; page: number; pageSize: number }>> {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
    ).toString();
    return this.request(`/datastores/${id}/content${qs ? `?${qs}` : ''}`);
  }

  // Analytics Conversations API — per-user persisted AI chat history for an
  // analytics project. Routed through analytics-api (index.js /conversations).
  async listAnalyticsConversations(projectId: string): Promise<ApiResponse<any[]>> {
    return this.request<any[]>(`/analytics-projects/${projectId}/conversations`);
  }

  async createAnalyticsConversation(projectId: string, title?: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/analytics-projects/${projectId}/conversations`, {
      method: 'POST',
      body: JSON.stringify(title ? { title } : {})
    });
  }

  async getAnalyticsConversation(projectId: string, conversationId: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/analytics-projects/${projectId}/conversations/${conversationId}`);
  }

  async deleteAnalyticsConversation(projectId: string, conversationId: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/analytics-projects/${projectId}/conversations/${conversationId}`, {
      method: 'DELETE'
    });
  }

  // Append a user message: server loads persisted history, calls text-to-sql,
  // and returns the generated SQL (execution stays a separate /query call).
  // `source` carries the selected index scope ({kind,ids}) so the server can
  // scope generation without an analytics_projects row (no-projects model).
  async sendAnalyticsConversationMessage(
    projectId: string,
    conversationId: string,
    body: { text: string; pageSize?: number; pageOffset?: number; source?: { kind: 'storage' | 'vf'; ids: string[] } }
  ): Promise<ApiResponse<any>> {
    return this.request<any>(`/analytics-projects/${projectId}/conversations/${conversationId}/message`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async createDatastore(data: CreateDatastoreRequest): Promise<ApiResponse<Datastore>> {
    return this.request<Datastore>('/datastores', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // Import an EXISTING S3 bucket as a datastore. Same-account (bucketArn/
  // bucketName) or cross-account (crossAccount=true, register+policy only).
  // Imported storages are always read-only: the archive never writes to, or
  // changes the settings of, a bucket it imports.
  // POST /datastores/import. Response data: { datastore, notificationAttached, backfill, crossAccount? }.
  async importDatastore(data: {
    name: string;
    bucketArn?: string;
    bucketName?: string;
    description?: string;
    prefix?: string;
    indexExisting?: boolean;
    crossAccount?: boolean;
    sourceAccountId?: string;
  }): Promise<ApiResponse<{ datastore: Datastore; notificationAttached: boolean; backfill: any; crossAccount?: boolean; ready?: boolean; missing?: { step: string; message: string }[]; adminSetup?: any; ownerSetup?: any; sourceAccountId?: string }>> {
    return this.request('/datastores/import', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // POST /datastores/import/recheck: re-verify a PENDING_SETUP cross-account
  // import after the admin + owner applied their steps.
  async recheckImport(data: { datastoreId: string; sourceAccountId: string }):
    Promise<ApiResponse<{ datastore: Datastore; ready: boolean; missing: { step: string; message: string }[]; backfill: any; adminSetup?: any; ownerSetup?: any }>> {
    return this.request('/datastores/import/recheck', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  // List the account's own S3 buckets eligible to import (minus the solution's
  // own + already-registered). Drives the "This account" bucket picker.
  // GET /datastores/import/list-buckets.
  async listImportBuckets(): Promise<ApiResponse<{ buckets: { name: string; arn: string }[] }>> {
    return this.request('/datastores/import/list-buckets');
  }

  // The steps the bucket owner runs BEFORE import (tag, event notification, and
  // only when needed bucket-policy / KMS key-policy statements), with the CLI
  // commands and the IAM permissions needed to run them.
  async getImportSetup(
    bucketArn: string,
    prefix?: string
  ): Promise<ApiResponse<ImportSetup>> {
    const p = prefix ? `&prefix=${encodeURIComponent(prefix)}` : '';
    return this.request(`/datastores/import/bucket-policy?bucketArn=${encodeURIComponent(bucketArn)}${p}`);
  }

  async updateDatastore(id: string, data: UpdateDatastoreRequest): Promise<ApiResponse<Datastore>> {
    return this.request<Datastore>(`/datastores/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  // Sync / re-index a datastore's S3 bucket against the index. Fans out one
  // async backfill crawl per prefix on the backend (default whole bucket).
  // mode='delta' (default) skips already-indexed, unchanged objects (ETag
  // match); mode='full' re-enqueues everything. POST /datastores/{id}/sync ->
  // 202 { datastoreId, bucketName, mode, prefixes, message }. Track progress
  // in the Imports view (each prefix gets its own import_jobs row).
  async syncDatastore(
    id: string,
    data?: { prefixes?: string[]; mode?: 'delta' | 'full' }
  ): Promise<ApiResponse<{ datastoreId: string; bucketName: string; mode: 'delta' | 'full'; prefixes: string[]; message: string }>> {
    return this.request(`/datastores/${id}/sync`, {
      method: 'POST',
      body: JSON.stringify(data || {})
    });
  }

  async getAvailableDatastores(): Promise<ApiResponse<{ datastores: any[] }>> {
    return this.request<{ datastores: any[] }>('/datastores/import');
  }

  async deleteDatastore(id: string, deletionType: string = 'DEREGISTER'): Promise<ApiResponse<void>> {
    return this.request<void>(`/datastores/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ deletionType })
    });
  }

  // DICOM Interface API
  async getDicomInterfaces(params?: ListParams): Promise<ApiResponse<DicomInterfaceListResponse>> {
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<DicomInterfaceListResponse>(`/dicom-interfaces?${queryString}`);
  }

  async getDicomInterface(id: string): Promise<ApiResponse<DicomInterface>> {
    return this.request<DicomInterface>(`/dicom-interfaces/${id}`);
  }

  async createDicomInterface(data: CreateDicomInterfaceRequest): Promise<ApiResponse<DicomInterface>> {
    return this.request<DicomInterface>('/dicom-interfaces', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateDicomInterface(id: string, data: UpdateDicomInterfaceRequest): Promise<ApiResponse<DicomInterface>> {
    return this.request<DicomInterface>(`/dicom-interfaces/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  async deleteDicomInterface(id: string): Promise<ApiResponse<void>> {
    return this.request<void>(`/dicom-interfaces/${id}`, {
      method: 'DELETE'
    });
  }

  async getDicomInterfaceDeleteImpact(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/dicom-interfaces/${id}/delete-impact`);
  }

  // DICOM Entity API
  async getDicomEntities(params?: ListParams): Promise<ApiResponse<any>> {
    const queryString = params ? new URLSearchParams(params as Record<string, string>).toString() : '';
    return this.request<any>(`/dicom-entities${queryString ? '?' + queryString : ''}`);
  }

  // HL7 Interface API
  async getHl7Interfaces(params?: ListParams): Promise<ApiResponse<PaginatedResponse<Hl7Interface>>> {
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<PaginatedResponse<Hl7Interface>>(`/hl7-interfaces?${queryString}`);
  }

  async getHl7Interface(id: string): Promise<ApiResponse<Hl7Interface>> {
    return this.request<Hl7Interface>(`/hl7-interfaces/${id}`);
  }

  async createHl7Interface(data: CreateHl7InterfaceRequest): Promise<ApiResponse<Hl7Interface>> {
    return this.request<Hl7Interface>('/hl7-interfaces', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateHl7Interface(id: string, data: UpdateHl7InterfaceRequest): Promise<ApiResponse<Hl7Interface>> {
    return this.request<Hl7Interface>(`/hl7-interfaces/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  async deleteHl7Interface(id: string): Promise<ApiResponse<void>> {
    return this.request<void>(`/hl7-interfaces/${id}`, {
      method: 'DELETE'
    });
  }

  // Studies API
  async getStudies(filters?: StudyFilters): Promise<ApiResponse<PaginatedResponse<Study>>> {
    const queryString = new URLSearchParams(filters as Record<string, string>).toString();
    return this.request<PaginatedResponse<Study>>(`/studies?${queryString}`);
  }

  async getStudy(id: string): Promise<ApiResponse<Study>> {
    return this.request<Study>(`/studies/${id}`);
  }

  // Users API
  async getUsers(params?: ListParams): Promise<ApiResponse<PaginatedResponse<User>>> {
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    return this.request<PaginatedResponse<User>>(`/users?${queryString}`);
  }

  async getUser(id: string): Promise<ApiResponse<User>> {
    return this.request<User>(`/users/${id}`);
  }

  async createUser(data: CreateUserRequest): Promise<ApiResponse<User>> {
    return this.request<User>('/users', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateUser(id: string, data: UpdateUserRequest): Promise<ApiResponse<User>> {
    return this.request<User>(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  async deleteUser(id: string): Promise<ApiResponse<void>> {
    return this.request<void>(`/users/${id}`, {
      method: 'DELETE'
    });
  }

  // Interface Servers API
  async getInterfaceServers(params?: any): Promise<ApiResponse<any>> {
    const queryString = params ? new URLSearchParams(params).toString() : '';
    return this.request<any>(`/interface-servers${queryString ? '?' + queryString : ''}`);
  }

  async getInterfaceServer(clientId: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/interface-servers/${clientId}`);
  }

  async getInterfaceServerStats(): Promise<ApiResponse<any>> {
    return this.request<any>('/interface-servers/stats');
  }

  // Audit Trail methods
  async getAuditEntries(params: AuditFilters): Promise<ApiResponse<PaginatedResponse<AuditEntry>>> {
    const queryParams = new URLSearchParams();
    
    if (params.page) queryParams.append('page', params.page.toString());
    if (params.pageSize) queryParams.append('pageSize', params.pageSize.toString());
    if (params.search) queryParams.append('search', params.search);
    if (params.user) queryParams.append('user', params.user);
    if (params.action) queryParams.append('action', params.action);
    if (params.resourceType) queryParams.append('resourceType', params.resourceType);
    if (params.datastoreId) queryParams.append('datastoreId', params.datastoreId);
    if (params.actionPrefix) queryParams.append('actionPrefix', params.actionPrefix);
    if (params.status) queryParams.append('status', params.status);
    if (params.timestampFrom) queryParams.append('timestampFrom', params.timestampFrom);
    if (params.timestampTo) queryParams.append('timestampTo', params.timestampTo);
    if (params.sortBy) queryParams.append('sortBy', params.sortBy);
    if (params.sortOrder) queryParams.append('sortOrder', params.sortOrder);

    const queryString = queryParams.toString();
    return this.request<PaginatedResponse<AuditEntry>>(`/audit${queryString ? '?' + queryString : ''}`);
  }

  // Distinct, non-PHI filter values actually present in the trail (data-driven
  // dropdowns). Returns { actions, resourceTypes, datastoreIds }.
  async getAuditFacets(): Promise<ApiResponse<{ actions: string[]; resourceTypes: string[]; datastores?: { id: string; name: string }[]; datastoreIds?: string[] }>> {
    return this.request('/audit/facets');
  }

  async createAuditEntry(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<ApiResponse<AuditEntry>> {
    return this.request<AuditEntry>('/audit', {
      method: 'POST',
      body: JSON.stringify(entry),
    });
  }

  // Privilege Groups API
  async getPrivilegeGroups(): Promise<ApiResponse<any[]>> {
    return this.request<any[]>('/privilege-groups');
  }

  async getPrivilegeGroup(id: string): Promise<ApiResponse<any>> {
    return this.request<any>(`/privilege-groups/${id}`);
  }

  async createPrivilegeGroup(data: any): Promise<ApiResponse<any>> {
    return this.request<any>('/privilege-groups', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updatePrivilegeGroup(id: string, data: any): Promise<ApiResponse<any>> {
    return this.request<any>(`/privilege-groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  }

  async deletePrivilegeGroup(id: string): Promise<ApiResponse<void>> {
    return this.request<void>(`/privilege-groups/${id}`, {
      method: 'DELETE'
    });
  }

  // Virtual Folders (separate API due to CloudFormation 500 resource limit)
  async getVirtualFolders(params?: ListParams): Promise<ApiResponse<PaginatedResponse<any>>> {
    const queryParams = new URLSearchParams();
    if (params?.page) queryParams.append('page', params.page.toString());
    if (params?.pageSize) queryParams.append('pageSize', params.pageSize.toString());
    const queryString = queryParams.toString();
    return this.vdsRequest<PaginatedResponse<any>>(`/virtual-folders${queryString ? `?${queryString}` : ''}`, 'GET');
  }

  async getVirtualFolder(id: string): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>(`/virtual-folders/${id}`, 'GET');
  }

  async createVirtualFolder(data: any): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>('/virtual-folders', 'POST', data);
  }

  async updateVirtualFolder(id: string, data: any): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>(`/virtual-folders/${id}`, 'PUT', data);
  }

  async deleteVirtualFolder(id: string): Promise<ApiResponse<void>> {
    return this.vdsRequest<void>(`/virtual-folders/${id}`, 'DELETE');
  }

  async resyncVirtualFolder(id: string): Promise<ApiResponse<{ virtualFolderId: string; message: string }>> {
    return this.vdsRequest<{ virtualFolderId: string; message: string }>(`/virtual-folders/${id}/resync`, 'POST', {});
  }

  async assignStudyToVirtualFolder(data: { virtualFolderId: string; studyInstanceUid: string; datastoreId: string }): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>('/virtual-folders/assign-study', 'POST', data);
  }

  async assignSeriesToVirtualFolder(data: { virtualFolderId: string; seriesInstanceUid: string; datastoreId: string; imagesetId: string }): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>('/virtual-folders/assign-series', 'POST', data);
  }

  async getVirtualFolderAssignments(virtualFolderId: string): Promise<ApiResponse<any[]>> {
    return this.vdsRequest<any[]>(`/virtual-folders/${virtualFolderId}/assignments`, 'GET');
  }

  async removeVirtualFolderAssignment(virtualFolderId: string, studyInstanceUid?: string, seriesInstanceUid?: string): Promise<ApiResponse<void>> {
    const params = new URLSearchParams({ virtualFolderId });
    if (studyInstanceUid) params.append('studyInstanceUid', studyInstanceUid);
    if (seriesInstanceUid) params.append('seriesInstanceUid', seriesInstanceUid);
    return this.vdsRequest<void>(`/virtual-folders/${virtualFolderId}/assignments?${params.toString()}`, 'DELETE');
  }

  async getVirtualFolderRules(virtualFolderId: string): Promise<ApiResponse<any[]>> {
    return this.vdsRequest<any[]>(`/virtual-folders/${virtualFolderId}/rules`, 'GET');
  }

  async createVirtualFolderRule(virtualFolderId: string, data: any): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>(`/virtual-folders/${virtualFolderId}/rules`, 'POST', data);
  }

  async updateVirtualFolderRule(virtualFolderId: string, ruleId: string, data: any): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>(`/virtual-folders/${virtualFolderId}/rules/${ruleId}`, 'PUT', data);
  }

  async deleteVirtualFolderRule(virtualFolderId: string, ruleId: string): Promise<ApiResponse<void>> {
    return this.vdsRequest<void>(`/virtual-folders/${virtualFolderId}/rules/${ruleId}`, 'DELETE');
  }

  // Dry-run: how many storage_index rows an UNSAVED assignment rule would match.
  // Mirrors the indexer's rule->WHERE translation server-side. Read-only.
  async previewAssignmentRuleCount(
    virtualFolderId: string,
    data: { conditions: any[]; datastoreIds: string[] }
  ): Promise<ApiResponse<{ matchCount: number; datastoreCount: number; conditionsApplied?: number; scope?: string }>> {
    return this.vdsRequest(`/virtual-folders/${virtualFolderId}/assignment-rules/preview-count`, 'POST', data);
  }

  // Generic methods for profile APIs
  async get(path: string): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>(path, 'GET');
  }

  async post(path: string, data: any): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>(path, 'POST', data);
  }

  async put(path: string, data: any): Promise<ApiResponse<any>> {
    return this.vdsRequest<any>(path, 'PUT', data);
  }

  async delete(path: string): Promise<ApiResponse<void>> {
    return this.vdsRequest<void>(path, 'DELETE');
  }
}

// Create and export a singleton instance
export const apiClient = new ApiClient();
export default apiClient;

// Export convenience functions
export const getLocations = () => apiClient.getLocations();
export const getLocation = (id: string) => apiClient.getLocation(id);
export const createLocation = (data: any) => apiClient.createLocation(data);
export const updateLocation = (id: string, data: any) => apiClient.updateLocation(id, data);
export const deleteLocation = (id: string) => apiClient.deleteLocation(id);
export const activateDicomNode = (locationId: string) => apiClient.activateDicomNode(locationId);
export const activateHl7Node = (locationId: string) => apiClient.activateHl7Node(locationId);
export const getSystemMonitor = () => apiClient.getSystemMonitor();
