import React, { useState, useEffect } from 'react';
import { formatTimestamp } from '../utils/dateUtils';
import {
  Container,
  Header,
  SpaceBetween,
  Box,
  Cards,
  Badge,
  StatusIndicator,
  ColumnLayout,
  Button,
  Modal,
  Table,
  Pagination,
  TextFilter,
  CollectionPreferences,
  Alert
} from '@cloudscape-design/components';
import { interfaceServerService, InterfaceServerRecord } from '../services/interfaceServerService';

interface InterfaceServerMonitorProps {
  refreshInterval?: number;
}

const InterfaceServerMonitor: React.FC<InterfaceServerMonitorProps> = ({ 
  refreshInterval = 30000 
}) => {
  const [servers, setServers] = useState<InterfaceServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [selectedServer, setSelectedServer] = useState<InterfaceServerRecord | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortingColumn, setSortingColumn] = useState({ sortingField: 'last_heartbeat' });
  const [sortingDescending, setSortingDescending] = useState(true);
  const [groupByLocation, setGroupByLocation] = useState(() => {
    const saved = localStorage.getItem('interfaceServerMonitorGrouped');
    return saved === 'true';
  });
  const [expandedLocations, setExpandedLocations] = useState<Set<string>>(new Set());

  // Fetch interface servers data
  const fetchServers = async () => {
    try {
      setLoading(true);
      const response = await interfaceServerService.getInterfaceServers();
      setServers(response.servers || []);
    } catch (error) {
      console.error('Error fetching interface servers:', { errorType: error.name });
      // For development, show mock data if API fails
      setServers([]);
    } finally {
      setLoading(false);
    }
  };

  // Auto-refresh data
  useEffect(() => {
    fetchServers();
    const interval = setInterval(fetchServers, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval]);

  // Persist groupByLocation preference
  useEffect(() => {
    localStorage.setItem('interfaceServerMonitorGrouped', String(groupByLocation));
  }, [groupByLocation]);

  // Auto-expand all locations when grouping is enabled
  useEffect(() => {
    if (groupByLocation && expandedLocations.size === 0 && servers.length > 0) {
      const groups = new Set<string>();
      servers.forEach(server => {
        const groupKey = server.locationId || 'unassigned';
        groups.add(groupKey);
      });
      setExpandedLocations(groups);
    }
  }, [groupByLocation, servers, expandedLocations.size]);

  // Group servers by type
  const serversByType = servers.reduce((acc, server) => {
    const type = server.interfaceType || 'UNKNOWN';
    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(server);
    return acc;
  }, {} as Record<string, InterfaceServerRecord[]>);

  // Filter servers based on search text
  const filteredServers = servers.filter(server =>
    server.clientId?.toLowerCase().includes(filterText.toLowerCase()) ||
    server.locationId?.toLowerCase().includes(filterText.toLowerCase()) ||
    server.locationName?.toLowerCase().includes(filterText.toLowerCase()) ||
    server.ipAddress?.includes(filterText) ||
    server.hostname?.toLowerCase().includes(filterText.toLowerCase())
  );

  // Group servers by location
  const groupedServers = groupByLocation ? (() => {
    const groups: { [key: string]: InterfaceServerRecord[] } = {};
    filteredServers.forEach(server => {
      const groupKey = server.locationId || 'unassigned';
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(server);
    });
    return groups;
  })() : {};

  const toggleLocation = (groupKey: string) => {
    const newExpanded = new Set(expandedLocations);
    if (newExpanded.has(groupKey)) {
      newExpanded.delete(groupKey);
    } else {
      newExpanded.add(groupKey);
    }
    setExpandedLocations(newExpanded);
  };

  const displayItems = groupByLocation ? 
    Object.entries(groupedServers).sort(([a], [b]) => a.localeCompare(b)).flatMap(([groupKey, items]) => {
      const locationName = groupKey === 'unassigned' ? 'Unassigned' : (items[0]?.locationName || groupKey);
      const locationRow = {
        isLocationHeader: true,
        locationId: groupKey,
        locationName: locationName,
        groupKey: groupKey,
        serverCount: items.length
      };
      const serverRows = expandedLocations.has(groupKey) ? items.map(r => ({ ...r, isLocationHeader: false })) : [];
      return [locationRow, ...serverRows];
    }) : filteredServers.map(s => ({ ...s, isLocationHeader: false }));

  const paginatedServers = displayItems.slice(
    (currentPageIndex - 1) * pageSize,
    currentPageIndex * pageSize
  );

  // Get status indicator
  const getStatusIndicator = (server: InterfaceServerRecord) => {
    const dbStatus = server.status?.toUpperCase();
    const metadata = (server as any).metadata || {};
    const serviceStatus = metadata.service_status?.toLowerCase();
    
    // Check if server is stale (no heartbeat for 5+ minutes)
    if (server.isStale || dbStatus === 'DISCONNECTED') {
      return <StatusIndicator type="error">Disconnected</StatusIndicator>;
    }
    
    // Prioritize service_status from metadata if available
    if (serviceStatus) {
      if (serviceStatus === 'active') {
        return <StatusIndicator type="success">Active</StatusIndicator>;
      } else if (serviceStatus === 'starting') {
        return <StatusIndicator type="in-progress">Starting</StatusIndicator>;
      } else if (serviceStatus === 'stopping') {
        return <StatusIndicator type="warning">Stopping</StatusIndicator>;
      } else if (serviceStatus === 'error') {
        return <StatusIndicator type="error">Error</StatusIndicator>;
      }
    }
    
    // Fall back to database status
    if (dbStatus === 'ACTIVE') {
      return <StatusIndicator type="success">Active</StatusIndicator>;
    } else if (dbStatus === 'INACTIVE') {
      return <StatusIndicator type="stopped">Inactive</StatusIndicator>;
    } else if (dbStatus === 'SHUTDOWN') {
      return <StatusIndicator type="stopped">Shutting down</StatusIndicator>;
    } else if (dbStatus === 'ERROR') {
      return <StatusIndicator type="error">Error</StatusIndicator>;
    }
    
    return <StatusIndicator type="pending">Unknown</StatusIndicator>;
  };

  // Get service type badge
  const getServiceTypeBadge = (serviceType: string) => {
    const colors = {
      'DICOM': 'blue',
      'HL7': 'green',
      'MIXED': 'red'
    } as const;
    
    return (
      <Badge color={colors[serviceType as keyof typeof colors] || 'grey'}>
        {serviceType}
      </Badge>
    );
  };

  // Format time ago from seconds
  const formatTimeAgo = (seconds: number) => {
    if (seconds === undefined || seconds === null) return 'Never';
    
    const mins = Math.floor(seconds / 60);
    
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  // Table columns
  const tableColumns = groupByLocation ? [
    {
      id: 'clientId',
      header: 'Location / Client ID',
      cell: (item: any) => {
        if (item.isLocationHeader) {
          return (
            <Box>
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="icon"
                  iconName={expandedLocations.has(item.groupKey) ? 'angle-down' : 'angle-right'}
                  onClick={() => toggleLocation(item.groupKey)}
                />
                <Box fontWeight="bold">{item.locationName}</Box>
                <Badge>{item.serverCount} {item.serverCount === 1 ? 'server' : 'servers'}</Badge>
              </SpaceBetween>
            </Box>
          );
        }
        return (
          <Box padding={{ left: 'xxl' }}>
            <Button
              variant="link"
              onClick={() => {
                setSelectedServer(item);
                setShowDetails(true);
              }}
            >
              {item.clientId}
            </Button>
          </Box>
        );
      },
      sortingField: 'clientId'
    },
    {
      id: 'interfaceType',
      header: 'Type',
      cell: (item: any) => item.isLocationHeader ? null : getServiceTypeBadge(item.interfaceType),
      sortingField: 'interfaceType'
    },
    {
      id: 'serviceVersion',
      header: 'Version',
      cell: (item: any) => item.isLocationHeader ? null : (item.serviceVersion || 'N/A'),
      sortingField: 'serviceVersion'
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: any) => item.isLocationHeader ? null : getStatusIndicator(item),
      sortingField: 'status'
    },
    {
      id: 'connection',
      header: 'Connection',
      cell: (item: any) => {
        if (item.isLocationHeader) return null;
        const metadata = (item as any).metadata || {};
        return (
          <div>
            <div>{metadata.local_ip_address || item.ipAddress}:{metadata.service_port || item.port || 'N/A'}</div>
          </div>
        );
      }
    },
    {
      id: 'hostname',
      header: 'Hostname',
      cell: (item: any) => {
        if (item.isLocationHeader) return null;
        const metadata = (item as any).metadata || {};
        return metadata.hostname || item.hostname || 'N/A';
      },
      sortingField: 'hostname'
    },
    {
      id: 'lastHeartbeat',
      header: 'Last Heartbeat',
      cell: (item: any) => item.isLocationHeader ? null : formatTimeAgo(item.timeSinceLastHeartbeat),
      sortingField: 'lastHeartbeat'
    },
    {
      id: 'uptime',
      header: 'Uptime',
      cell: (item: any) => {
        if (item.isLocationHeader) return null;
        const metadata = (item as any).metadata || {};
        if (metadata.startup_time) {
          const uptimeSeconds = Math.floor(Date.now() / 1000) - metadata.startup_time;
          const hours = Math.floor(uptimeSeconds / 3600);
          const minutes = Math.floor((uptimeSeconds % 3600) / 60);
          return `${hours}h ${minutes}m`;
        }
        return 'N/A';
      }
    }
  ] : [
    {
      id: 'clientId',
      header: 'Client ID',
      cell: (server: InterfaceServerRecord) => (
        <Button
          variant="link"
          onClick={() => {
            setSelectedServer(server);
            setShowDetails(true);
          }}
        >
          {server.clientId}
        </Button>
      ),
      sortingField: 'clientId'
    },
    {
      id: 'interfaceType',
      header: 'Type',
      cell: (server: InterfaceServerRecord) => getServiceTypeBadge(server.interfaceType),
      sortingField: 'interfaceType'
    },
    {
      id: 'serviceVersion',
      header: 'Version',
      cell: (server: InterfaceServerRecord) => server.serviceVersion || 'N/A',
      sortingField: 'serviceVersion'
    },
    {
      id: 'status',
      header: 'Status',
      cell: (server: InterfaceServerRecord) => getStatusIndicator(server),
      sortingField: 'status'
    },
    {
      id: 'connection',
      header: 'Connection',
      cell: (server: InterfaceServerRecord) => {
        const metadata = (server as any).metadata || {};
        return (
          <div>
            <div>{metadata.local_ip_address || server.ipAddress}:{metadata.service_port || server.port || 'N/A'}</div>
          </div>
        );
      }
    },
    {
      id: 'hostname',
      header: 'Hostname',
      cell: (server: InterfaceServerRecord) => {
        const metadata = (server as any).metadata || {};
        return metadata.hostname || server.hostname || 'N/A';
      },
      sortingField: 'hostname'
    },
    {
      id: 'lastHeartbeat',
      header: 'Last Heartbeat',
      cell: (server: InterfaceServerRecord) => formatTimeAgo(server.timeSinceLastHeartbeat),
      sortingField: 'lastHeartbeat'
    },
    {
      id: 'uptime',
      header: 'Uptime',
      cell: (server: InterfaceServerRecord) => {
        const metadata = (server as any).metadata || {};
        if (metadata.startup_time) {
          const uptimeSeconds = Math.floor(Date.now() / 1000) - metadata.startup_time;
          const hours = Math.floor(uptimeSeconds / 3600);
          const minutes = Math.floor((uptimeSeconds % 3600) / 60);
          return `${hours}h ${minutes}m`;
        }
        return 'N/A';
      }
    }
  ];

  return (
    <SpaceBetween direction="vertical" size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
              <Button
                iconName={groupByLocation ? 'view-horizontal' : 'view-vertical'}
                onClick={() => setGroupByLocation(!groupByLocation)}
              >
                {groupByLocation ? 'Ungroup' : 'Group by Location'}
              </Button>
              <Button
                iconName="refresh"
                onClick={() => { setIsManualRefresh(true); fetchServers().finally(() => setIsManualRefresh(false)); }}
                loading={isManualRefresh && loading}
              >
                Refresh
              </Button>
            </SpaceBetween>
          }
          counter={`(${servers.length})`}
        >
          Interface Server Monitor
        </Header>

        {/* Detailed Table */}
        <Table
          columnDefinitions={tableColumns}
          items={paginatedServers}
          loading={loading}
          loadingText="Loading interface servers..."
          sortingColumn={sortingColumn}
          sortingDescending={sortingDescending}
          onSortingChange={({ detail }) => {
            setSortingColumn({ sortingField: detail.sortingColumn.sortingField || 'last_heartbeat' });
            setSortingDescending(detail.isDescending || false);
          }}
          pagination={
            <Pagination
              currentPageIndex={currentPageIndex}
              pagesCount={Math.ceil(displayItems.length / pageSize)}
              onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
            />
          }
          filter={
            <TextFilter
              filteringText={filterText}
              onChange={({ detail }) => setFilterText(detail.filteringText)}
              filteringPlaceholder="Search servers..."
            />
          }
          preferences={
            <CollectionPreferences
              title="Preferences"
              confirmLabel="Confirm"
              cancelLabel="Cancel"
              pageSizePreference={{
                title: "Page size",
                options: [
                  { value: 10, label: "10 servers" },
                  { value: 20, label: "20 servers" },
                  { value: 50, label: "50 servers" }
                ]
              }}
              onConfirm={({ detail }) => {
                setPageSize(detail.pageSize || 10);
              }}
            />
          }
          empty={
            <Box textAlign="center" color="inherit">
              <b>No servers match the filter</b>
              <Box variant="p" color="inherit">
                Try adjusting your search criteria.
              </Box>
            </Box>
          }
        />

        {/* Server Details Modal */}
        <Modal
          visible={showDetails}
          onDismiss={() => setShowDetails(false)}
          header={`Server Details: ${selectedServer?.clientId}`}
          size="large"
        >
          {selectedServer && (() => {
            const metadata = (selectedServer as any).metadata || {};
            return (
              <SpaceBetween direction="vertical" size="m">
                <ColumnLayout columns={2} variant="text-grid">
                  <div>
                    <Box variant="awsui-key-label">Client ID</Box>
                    <div>{selectedServer.clientId}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Interface ID</Box>
                    <div>{selectedServer.locationId}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Service Type</Box>
                    <div>{getServiceTypeBadge(selectedServer.interfaceType)}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Version</Box>
                    <div>{selectedServer.serviceVersion || 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Protocol</Box>
                    <div>{metadata.protocol || 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Status</Box>
                    <div>{getStatusIndicator(selectedServer)}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Service Status</Box>
                    <div>{metadata.service_status || 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Local IP Address</Box>
                    <div>{metadata.local_ip_address || selectedServer.ipAddress || 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Hostname</Box>
                    <div>{metadata.hostname || selectedServer.hostname || 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Service Port</Box>
                    <div>{metadata.service_port || selectedServer.port || 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Environment</Box>
                    <div>{metadata.deployment_environment || 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Updated At</Box>
                    <div>{formatTimestamp(selectedServer.updatedAt)}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Last Heartbeat</Box>
                    <div>{formatTimestamp(selectedServer.lastHeartbeat)}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Time Since Heartbeat</Box>
                    <div>{selectedServer.timeSinceLastHeartbeat ? `${selectedServer.timeSinceLastHeartbeat}s` : 'N/A'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Is Stale</Box>
                    <div>{selectedServer.isStale ? 'Yes' : 'No'}</div>
                  </div>
                  <div>
                    <Box variant="awsui-key-label">Startup Time</Box>
                  <div>{metadata.startup_time ? new Date(metadata.startup_time * 1000).toLocaleString() : 'N/A'}</div>
                    <div>{metadata.startup_time ? new Date(metadata.startup_time * 1000).toLocaleString() : 'N/A'}</div>
                  </div>
                </ColumnLayout>
              </SpaceBetween>
            );
          })()}
        </Modal>
      </SpaceBetween>
  );
};

export default InterfaceServerMonitor;
