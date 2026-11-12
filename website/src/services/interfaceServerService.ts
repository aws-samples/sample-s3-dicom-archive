import { apiClient } from './apiClient';

export interface InterfaceServerRecord {
  clientId: string;
  locationId: string;
  locationName: string | null;
  interfaceType: string;
  hostname: string | null;
  ipAddress: string | null;
  port: number | null;
  status: string;
  serviceVersion: string | null;
  lastHeartbeat: string;
  serverMetadata: string;
  createdAt: string;
  updatedAt: string;
  timeSinceLastHeartbeat: number;
  isStale: boolean;
}

export interface InterfaceServerResponse {
  servers: InterfaceServerRecord[];
  total: number;
  active_count: number;
  inactive_count: number;
}

class InterfaceServerService {
  /**
   * Get all interface servers
   */
  async getInterfaceServers(): Promise<InterfaceServerResponse> {
    try {
      const response = await apiClient.getInterfaceServers();
      // Do not log the full response (interface configs can include tokens/TLS material).
      console.log('Loaded interface servers');
      
      if (response.success && response.data) {
        // Handle the new API response structure
        const apiData = response.data;
        const servers = (apiData.interfaceServers || []).map((server: any) => {
          // Parse serverMetadata JSON string
          let metadata = {};
          try {
            metadata = JSON.parse(server.serverMetadata || '{}');
          } catch (e) {
            console.warn('Failed to parse serverMetadata:', e);
          }
          
          return {
            ...server,
            metadata
          };
        });
        
        // Calculate active/inactive counts
        const activeCount = servers.filter((s: any) => 
          s.status === 'ACTIVE'
        ).length;
        const inactiveCount = servers.length - activeCount;
        
        return {
          servers: servers,
          total: apiData.count || servers.length,
          active_count: activeCount,
          inactive_count: inactiveCount
        };
      } else {
        console.warn('API response not successful'); // no response body (may hold host/IP/TLS details)
        return {
          servers: [],
          total: 0,
          active_count: 0,
          inactive_count: 0
        };
      }
    } catch (error) {
      console.error('Error fetching interface servers:', error.message);
      return {
        servers: [],
        total: 0,
        active_count: 0,
        inactive_count: 0
      };
    }
  }

  /**
   * Get interface server by client ID
   */
  async getInterfaceServer(clientId: string): Promise<InterfaceServerRecord | null> {
    try {
      const response = await apiClient.getInterfaceServer(clientId);
      if (response.success && response.data) {
        return response.data;
      }
      return null;
    } catch (error) {
      console.error(`Error fetching interface server ${clientId}:`, error.message);
      return null;
    }
  }

  /**
   * Get interface servers by type
   */
  async getInterfaceServersByType(serviceType: 'DICOM' | 'HL7' | 'MIXED'): Promise<InterfaceServerResponse> {
    try {
      const response = await apiClient.getInterfaceServers({ service_type: serviceType });
      if (response.success && response.data) {
        return response.data;
      }
      return { servers: [], total: 0, active_count: 0, inactive_count: 0 };
    } catch (error) {
      console.error(`Error fetching ${serviceType} interface servers:`, error.message);
      return { servers: [], total: 0, active_count: 0, inactive_count: 0 };
    }
  }

  /**
   * Get interface server statistics
   */
  async getInterfaceServerStats(): Promise<{
    total: number;
    active: number;
    inactive: number;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
    avg_heartbeat_count: number;
    last_updated: string;
  }> {
    try {
      const response = await apiClient.getInterfaceServerStats();
      if (response.success && response.data) {
        return response.data;
      }
      return {
        total: 0,
        active: 0,
        inactive: 0,
        by_type: {},
        by_status: {},
        avg_heartbeat_count: 0,
        last_updated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error fetching interface server stats:', error.message);
      return {
        total: 0,
        active: 0,
        inactive: 0,
        by_type: {},
        by_status: {},
        avg_heartbeat_count: 0,
        last_updated: new Date().toISOString()
      };
    }
  }
}

export const interfaceServerService = new InterfaceServerService();
export default interfaceServerService;
