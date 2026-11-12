import React, { useState, useEffect, useCallback } from 'react';
import { formatTimestamp, formatTimestampDate, formatTimestampTime, parseUtcTimestamp } from '../utils/dateUtils';
import {
  Container,
  Header,
  Table,
  Box,
  SpaceBetween,
  Button,
  Pagination,
  TextFilter,
  Select,
  Multiselect,
  DatePicker,
  FormField,
  Grid,
  StatusIndicator,
  Badge,
  Modal,
  Alert,
  KeyValuePairs,
  CollectionPreferences
} from '@cloudscape-design/components';

import { AuditEntry, AuditFilters } from '../types';
import { apiClient } from '../services/apiClient';

const AuditTrail: React.FC = () => {
  // State management
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [facets, setFacets] = useState<{ actions: string[]; resourceTypes: string[]; datastores: { id: string; name: string }[] }>({
    actions: [], resourceTypes: [], datastores: []
  });
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  
  // Pagination state
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  
  // Table preferences state
  const [preferences, setPreferences] = useState({
    pageSize: 20,
    visibleContent: ['timestamp', 'user', 'category', 'action', 'description', 'status'],
    wrapLines: false
  });
  
  // Filter state
  const [filters, setFilters] = useState<AuditFilters>({
    search: '',
    user: '',
    action: '',
    actionPrefix: '',
    category: '',
    resourceType: '',
    datastoreId: '',
    status: '',
    timestampFrom: '',
    timestampTo: '',
    sortBy: 'timestamp',
    sortOrder: 'desc'
  });

  // Search input state (separate from applied filters)
  const [searchInput, setSearchInput] = useState('');
  
  // Modal state
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [showEntryDetails, setShowEntryDetails] = useState(false);
  
  // Error state
  const [error, setError] = useState<string | null>(null);

  // Load users for filter dropdown
  const loadUsers = useCallback(async () => {
    try {
      const response = await apiClient.getUsers({ page: 1, pageSize: 1000 });
      if (response.success) {
        setUsers(response.data.items || []);
      }
    } catch (err) {
      console.error('Error loading users:', err);
    }
  }, []);

  // Load data-driven filter facets (distinct actions / resource types /
  // datastore ids actually present in the trail). Keeps the dropdowns from
  // going stale as new audited actions appear.
  const loadFacets = useCallback(async () => {
    try {
      const response = await apiClient.getAuditFacets();
      if (response.success && response.data) {
        const d: any = response.data;
        setFacets({
          actions: d.actions || [],
          resourceTypes: d.resourceTypes || [],
          // Prefer the resolved {id,name} list; fall back to bare ids (older API).
          datastores: Array.isArray(d.datastores) && d.datastores.length
            ? d.datastores
            : (d.datastoreIds || []).map((id: string) => ({ id, name: id }))
        });
      }
    } catch (err) {
      console.error('Error loading audit facets:', err);
    }
  }, []);

  // Load audit entries
  const loadAuditEntries = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Prepare API parameters
      const apiParams = {
        ...filters,
        page: currentPageIndex,
        pageSize: pageSize
      };
      
      // Do not log query params (may include patient/identity filter values).
      console.log('Loading audit entries');
      
      // Call the real audit API
      const response = await apiClient.getAuditEntries(apiParams);
      
      if (response.success) {
        setAuditEntries(response.data.items || []);
        setTotalPages(response.data.totalPages || 1);
        setTotalItems(response.data.totalCount || 0);
      } else {
        throw new Error(response.message || response.errors?.[0] || 'Failed to load audit entries');
      }
      
    } catch (err) {
      console.error('Failed to load audit entries:', err);
      setError(err instanceof Error ? err.message : 'Failed to load audit entries');
      setAuditEntries([]);
      setTotalPages(1);
      setTotalItems(0);
    } finally {
      setLoading(false);
    }
  }, [filters, currentPageIndex, pageSize]);

  // Initial load
  useEffect(() => {
    loadAuditEntries();
    loadUsers();
    loadFacets();
  }, [loadAuditEntries, loadUsers, loadFacets]);
  // Handle filter changes
  const handleFilterChange = (filterKey: keyof AuditFilters, value: string) => {
    setFilters(prev => ({ 
      ...prev, 
      [filterKey]: value 
    }));
    setCurrentPageIndex(1); // Reset to first page when filtering
  };

  // Handle search
  const handleSearch = () => {
    setFilters(prev => ({ 
      ...prev, 
      search: searchInput.trim()
    }));
    setCurrentPageIndex(1);
  };

  // Handle search clear
  const handleClearSearch = () => {
    setSearchInput('');
    setFilters(prev => ({ 
      ...prev, 
      search: ''
    }));
    setCurrentPageIndex(1);
  };

  // Handle reset all filters
  const handleResetAllFilters = () => {
    setSearchInput('');
    setFilters({
      search: '',
      user: '',
      action: '',
      actionPrefix: '',
      category: '',
      resourceType: '',
      datastoreId: '',
      status: '',
      timestampFrom: '',
      timestampTo: '',
      sortBy: 'timestamp',
      sortOrder: 'desc'
    });
    setCurrentPageIndex(1);
  };

  // Apply a preset quick-filter (common compliance lenses). Each preset REPLACES
  // the current filter set so the lens is unambiguous.
  const applyPreset = (preset: 'denials' | 'deletes' | 'dicomwebReads' | 'last24h') => {
    const base = {
      search: '', user: '', action: '', actionPrefix: '', category: '',
      resourceType: '', datastoreId: '', status: '', timestampFrom: '',
      timestampTo: '', sortBy: 'timestamp', sortOrder: 'desc'
    } as AuditFilters;
    setSearchInput('');
    if (preset === 'denials') {
      setFilters({ ...base, status: 'FAILURE' });
    } else if (preset === 'deletes') {
      setFilters({ ...base, actionPrefix: 'delete_' });
    } else if (preset === 'dicomwebReads') {
      // Study/series DICOMweb reads that ARE audited (QUERY_STUDIES + metadata).
      setFilters({ ...base, action: 'QUERY_STUDIES,RETRIEVE_METADATA' });
    } else if (preset === 'last24h') {
      const d = new Date(Date.now() - 24 * 3600 * 1000);
      setFilters({ ...base, timestampFrom: d.toISOString().slice(0, 10) });
    }
    setCurrentPageIndex(1);
  };

  // Handle refresh
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleRefresh = () => {
    loadAuditEntries();
  };

  // Handle page size change
  // const handlePageSizeChange = (newPageSize: number) => {
  //   setPageSize(newPageSize);
  //   setPreferences(prev => ({ ...prev, pageSize: newPageSize }));
  //   setCurrentPageIndex(1);
  // };

  // Handle preferences change
  const handlePreferencesChange = (newPreferences: any) => {
    setPreferences(newPreferences);
    
    if (newPreferences.pageSize !== pageSize) {
      setPageSize(newPreferences.pageSize);
      setCurrentPageIndex(1);
    }
  };

  // Status indicator helper
  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'SUCCESS':
        return <StatusIndicator type="success">Success</StatusIndicator>;
      case 'FAILURE':
      case 'FAILED':
        return <StatusIndicator type="error">Failed</StatusIndicator>;
      case 'PENDING':
        return <StatusIndicator type="pending">Pending</StatusIndicator>;
      default:
        return <StatusIndicator type="info">{status}</StatusIndicator>;
    }
  };

  // Category badge helper
  const getCategoryBadge = (category: string) => {
    if (!category) {
      return <Badge color="grey">SYSTEM</Badge>;
    }
    
    const colorMap: Record<string, "blue" | "green" | "grey" | "red"> = {
      'DICOM': 'blue',
      'HL7': 'green', 
      'SYSTEM': 'grey',
      'USER': 'blue',
      'API': 'grey'
    };
    
    const color = colorMap[category.toUpperCase()] || 'grey';
    return <Badge color={color}>{category}</Badge>;
  };

  // User badge helper
  const getUserBadge = (user: string) => {
    if (user === 'system') {
      return <Badge color="grey">System</Badge>;
    }
    return <Badge color="blue">{user}</Badge>;
  };

  // Action badge helper
  const getActionBadge = (action: string) => {
    const colorMap: Record<string, "blue" | "green" | "grey" | "red"> = {
      'CREATE': 'green',
      'UPDATE': 'blue',
      'DELETE': 'red',
      'LOGIN': 'blue',
      'LOGOUT': 'grey',
      'DIMSE:Import': 'green'  // Make DIMSE import actions green
    };
    
    // Check for exact match first (for actions like DIMSE:Import)
    if (colorMap[action]) {
      return <Badge color={colorMap[action]}>{action.replace(/_/g, ' ')}</Badge>;
    }
    
    // Determine color based on action prefix for other actions
    const actionPrefix = action.split('_')[0];
    const color = colorMap[actionPrefix] || 'grey';
    
    return <Badge color={color}>{action.replace(/_/g, ' ')}</Badge>;
  };

  // Handle entry details
  const handleShowDetails = (entry: AuditEntry) => {
    setSelectedEntry(entry);
    setShowEntryDetails(true);
  };

  // Helper function to format relative time
  const getRelativeTime = (dateString: string) => {
    const date = parseUtcTimestamp(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d ago`;
    return `${Math.floor(diffInSeconds / 2592000)}mo ago`;
  };

  // Table columns definition
  const columnDefinitions = [
    {
      id: 'timestamp',
      header: 'Timestamp',
      cell: (item: AuditEntry) => (
        <Box>
          <Box fontSize="body-s">{formatTimestampDate(item.timestamp)}</Box>
          <Box fontSize="body-s" color="text-status-info">
            {formatTimestampTime(item.timestamp)} ({getRelativeTime(item.timestamp)})
          </Box>
        </Box>
      ),
      sortingField: 'timestamp',
      width: 180
    },
    {
      id: 'user',
      header: 'User',
      cell: (item: AuditEntry) => getUserBadge(item.user),
      sortingField: 'user',
      width: 120
    },
    {
      id: 'category',
      header: 'Category',
      cell: (item: AuditEntry) => getCategoryBadge(item.category || 'SYSTEM'),
      sortingField: 'category',
      width: 100
    },
    {
      id: 'action',
      header: 'Action',
      cell: (item: AuditEntry) => getActionBadge(item.action),
      sortingField: 'action',
      width: 150
    },
    {
      id: 'description',
      header: 'Description',
      cell: (item: AuditEntry) => (
        <Box>
          <Box fontSize="body-s">{item.description}</Box>
          {item.resourceType && item.resourceId && (
            <Box fontSize="body-s" color="text-status-info">
              {item.resourceType}: {item.resourceId.substring(0, 8)}...
            </Box>
          )}
        </Box>
      ),
      width: 300
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: AuditEntry) => item.status ? getStatusIndicator(item.status) : <Box color="text-status-inactive">N/A</Box>,
      sortingField: 'status',
      width: 100
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (item: AuditEntry) => (
        <Button
          variant="inline-link"
          onClick={() => handleShowDetails(item)}
        >
          View Details
        </Button>
      ),
      width: 100
    }
  ];

  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="Track all system and user actions for compliance and monitoring"
      >
        Audit Trail
      </Header>
      {error && (
        <Alert
          type="error"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}
        {/* Filters */}
        <Container 
          header={
            <Header 
              variant="h2"
              counter={
                (filters.user || filters.action || filters.actionPrefix || filters.resourceType ||
                 filters.datastoreId || filters.status || filters.timestampFrom || filters.timestampTo ||
                 filters.search)
                  ? `(${[filters.user, filters.action, filters.actionPrefix, filters.resourceType,
                         filters.datastoreId, filters.status, filters.timestampFrom, filters.timestampTo,
                         filters.search].filter(Boolean).length} active)`
                  : undefined
              }
            >
              Filters
            </Header>
          }
        >
          <Grid gridDefinition={[
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } },
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } },
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } },
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } },
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } },
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } },
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } }
          ]}>
            <FormField label="User">
              <Select
                selectedOption={
                  filters.user
                    ? (() => {
                        const u = users.find(x => (x.username || x.email) === filters.user);
                        return {
                          label: u ? `${u.firstName} ${u.lastName} (${u.email})`
                                   : (filters.user === 'system' ? 'System' : filters.user),
                          value: filters.user,
                        };
                      })()
                    : null
                }
                onChange={({ detail }) =>
                  handleFilterChange('user', detail.selectedOption?.value || '')
                }
                options={[
                  { label: 'All Users', value: '' },
                  { label: 'System', value: 'system' },
                  ...users.map(user => ({
                    // Label = human display name; VALUE = the stored identifier.
                    // audit_logs.username holds the cognito username (mapped from
                    // the token's cognito:username), NOT the email — so the filter
                    // must send user.username or the equality never matches (this
                    // is why "System Administrator" returned zero events when the
                    // value was user.email). Fall back to email only if a user
                    // record has no username.
                    label: `${user.firstName} ${user.lastName} (${user.email})`,
                    value: user.username || user.email
                  }))
                ]}
                placeholder="Select a user"
              />
            </FormField>

            <FormField label="Action">
              <Multiselect
                selectedOptions={
                  filters.action
                    ? filters.action.split(',').filter(Boolean).map(v => ({ label: v.replace(/_/g, ' '), value: v }))
                    : []
                }
                onChange={({ detail }) =>
                  handleFilterChange('action', detail.selectedOptions.map(o => o.value).filter(Boolean).join(','))
                }
                // Data-driven: options are the DISTINCT actions actually present
                // in the trail (from /audit/facets), so new audited actions
                // (QUERY_STUDIES, RETRIEVE_METADATA, ACCESS_DENIED, …) appear
                // automatically and the list never goes stale.
                options={facets.actions.map(a => ({ label: a.replace(/_/g, ' '), value: a }))}
                placeholder="All actions"
                filteringType="auto"
                empty="No actions recorded yet"
              />
            </FormField>

            <FormField label="Datastore">
              <Select
                selectedOption={
                  filters.datastoreId
                    ? {
                        label: (facets.datastores.find(d => d.id === filters.datastoreId)?.name) || filters.datastoreId,
                        value: filters.datastoreId
                      }
                    : null
                }
                onChange={({ detail }) =>
                  handleFilterChange('datastoreId', detail.selectedOption?.value || '')
                }
                // Tenancy dimension. Options are LIVE datastores referenced in
                // the trail, shown BY NAME (value is the id the server filters on
                // via a bound JSON_EXTRACT equality). Deleted datastores are
                // excluded server-side so the list is not cluttered with UUIDs
                // of stores that no longer exist.
                options={[
                  { label: 'All datastores', value: '' },
                  ...facets.datastores.map(d => ({ label: d.name, value: d.id, description: d.id }))
                ]}
                placeholder="All datastores"
                filteringType="auto"
                empty="No datastore-scoped events yet"
              />
            </FormField>

            <FormField label="Resource Type">
              <Multiselect
                selectedOptions={
                  filters.resourceType 
                    ? filters.resourceType.split(',').map(v => ({ label: v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), value: v }))
                    : []
                }
                onChange={({ detail }) => {
                  const selected = detail.selectedOptions;
                  if (selected.length === 0) {
                    handleFilterChange('resourceType', '');
                    return;
                  }
                  const hasAll = selected.some(opt => opt.value === '');
                  const hasOthers = selected.some(opt => opt.value !== '');
                  
                  if (hasAll && hasOthers) {
                    // If "All" and others are selected, keep only the others
                    handleFilterChange('resourceType', selected.filter(opt => opt.value !== '').map(opt => opt.value).join(','));
                  } else if (hasAll) {
                    // Only "All" is selected
                    handleFilterChange('resourceType', '');
                  } else {
                    // Only specific types are selected
                    handleFilterChange('resourceType', selected.map(opt => opt.value).join(','));
                  }
                }}
                options={[
                  { label: 'All resource types', value: '' },
                  ...facets.resourceTypes.map(rt => ({
                    label: rt.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                    value: rt
                  }))
                ]}
                placeholder="All resource types"
              />
            </FormField>

            <FormField label="Status">
              <Select
                selectedOption={
                  filters.status ? { label: filters.status, value: filters.status } : null
                }
                onChange={({ detail }) =>
                  handleFilterChange('status', detail.selectedOption?.value || '')
                }
                options={[
                  { label: 'All Statuses', value: '' },
                  { label: 'Success', value: 'SUCCESS' },
                  { label: 'Failure', value: 'FAILURE' },
                  { label: 'Pending', value: 'PENDING' }
                ]}
                placeholder="Select status"
              />
            </FormField>

            <FormField label="From Date">
              <DatePicker
                value={filters.timestampFrom || ''}
                onChange={({ detail }) =>
                  handleFilterChange('timestampFrom', detail.value)
                }
                placeholder="YYYY-MM-DD"
              />
            </FormField>

            <FormField label="To Date">
              <DatePicker
                value={filters.timestampTo || ''}
                onChange={({ detail }) =>
                  handleFilterChange('timestampTo', detail.value)
                }
                placeholder="YYYY-MM-DD"
              />
            </FormField>
          </Grid>
          
          {/* Filter Actions */}
          <Box margin={{ top: 'm' }}>
            <SpaceBetween direction="horizontal" size="xs">
              <Box variant="awsui-key-label" padding={{ right: 'xs', top: 'xxs' }}>Quick views:</Box>
              <Button onClick={() => applyPreset('denials')}>Denials only</Button>
              <Button onClick={() => applyPreset('deletes')}>Deletes</Button>
              <Button onClick={() => applyPreset('dicomwebReads')}>DICOMweb reads</Button>
              <Button onClick={() => applyPreset('last24h')}>Last 24h</Button>
              {(filters.user || filters.action || filters.actionPrefix || filters.resourceType ||
                filters.datastoreId || filters.status || filters.timestampFrom || filters.timestampTo ||
                filters.search) && (
                <Button onClick={handleResetAllFilters}>
                  Reset All Filters
                </Button>
              )}
            </SpaceBetween>
          </Box>
        </Container>

        {/* Audit Trail Table */}
        <Table
          columnDefinitions={columnDefinitions}
          items={auditEntries}
          loading={loading}
          loadingText="Loading audit entries..."
          preferences={
            <CollectionPreferences
              title="Preferences"
              confirmLabel="Confirm"
              cancelLabel="Cancel"
              preferences={preferences}
              onConfirm={({ detail }) => handlePreferencesChange(detail)}
              pageSizePreference={{
                title: "Page size",
                options: [
                  { value: 10, label: "10 items" },
                  { value: 20, label: "20 items" },
                  { value: 50, label: "50 items" },
                  { value: 100, label: "100 items" }
                ]
              }}
              wrapLinesPreference={{
                label: "Wrap lines",
                description: "Wrap text content in table cells"
              }}
              visibleContentPreference={{
                title: "Select visible columns",
                options: [
                  {
                    label: "Audit entry properties",
                    options: [
                      { id: "timestamp", label: "Timestamp" },
                      { id: "user", label: "User" },
                      { id: "category", label: "Category" },
                      { id: "action", label: "Action" },
                      { id: "description", label: "Description" },
                      { id: "status", label: "Status" },
                      { id: "actions", label: "Actions" }
                    ]
                  }
                ]
              }}
            />
          }
          ariaLabels={{
            tableLabel: "Audit entries"
          }}
          renderAriaLive={({ firstIndex, lastIndex, totalItemsCount }) =>
            `Displaying items ${firstIndex} to ${lastIndex} of ${totalItemsCount}`
          }
          sortingDisabled={false}
          empty={
            <Box textAlign="center" color="inherit">
              <Box variant="strong" textAlign="center" color="inherit">
                No audit entries found
              </Box>
              <Box variant="p" padding={{ bottom: "s" }} color="inherit">
                No audit entries match the current filters.
              </Box>
            </Box>
          }
          filter={
            <SpaceBetween direction="horizontal" size="xs">
              <TextFilter
                filteringText={searchInput}
                onChange={({ detail }) => setSearchInput(detail.filteringText)}
                filteringPlaceholder="Search audit entries..."
              />
              <Button 
                onClick={handleSearch} 
                disabled={!searchInput.trim()}
              >
                Search
              </Button>
              {filters.search && (
                <Button onClick={handleClearSearch}>
                  Clear
                </Button>
              )}
            </SpaceBetween>
          }
          header={
            <Header
              counter={
                totalItems > 0 ? (
                  `(${((currentPageIndex - 1) * pageSize) + 1}-${Math.min(currentPageIndex * pageSize, totalItems)} of ${totalItems})`
                ) : (
                  `(${totalItems})`
                )
              }
              description={
                totalPages > 1 ? `Page ${currentPageIndex} of ${totalPages}` : undefined
              }
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={() => { setIsManualRefresh(true); loadAuditEntries().finally(() => setIsManualRefresh(false)); }} loading={isManualRefresh && loading}>
                    Refresh
                  </Button>
                </SpaceBetween>
              }
            >
              Audit Entries
            </Header>
          }
          pagination={
            <Pagination
              currentPageIndex={currentPageIndex}
              onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
              pagesCount={totalPages}
              ariaLabels={{
                nextPageLabel: 'Next page',
                previousPageLabel: 'Previous page',
                pageLabel: pageNumber => `Page ${pageNumber} of ${totalPages}`
              }}
            />
          }
        />

        {/* Entry Details Modal */}
        {selectedEntry && (
          <Modal
            visible={showEntryDetails}
            onDismiss={() => {
              setShowEntryDetails(false);
              setSelectedEntry(null);
            }}
            header={`Audit Entry Details - ${selectedEntry.action}`}
            size="large"
            footer={
              <Box float="right">
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    variant="link"
                    onClick={() => {
                      setShowEntryDetails(false);
                      setSelectedEntry(null);
                    }}
                  >
                    Close
                  </Button>
                </SpaceBetween>
              </Box>
            }
          >
            <SpaceBetween size="l">
              <KeyValuePairs
                columns={2}
                items={[
                  { label: 'Entry ID', value: selectedEntry.id },
                  { label: 'Timestamp', value: formatTimestamp(selectedEntry.timestamp) },
                  { label: 'User', value: selectedEntry.user },
                  { label: 'Action', value: selectedEntry.action },
                  { label: 'Status', value: selectedEntry.status ? getStatusIndicator(selectedEntry.status) : 'N/A' },
                  { label: 'Resource Type', value: selectedEntry.resourceType || 'N/A' },
                  { label: 'Resource ID', value: selectedEntry.resourceId || 'N/A' },
                  { label: 'Datastore', value: selectedEntry.datastoreId
                      ? ((facets.datastores.find(d => d.id === selectedEntry.datastoreId)?.name) || selectedEntry.datastoreId)
                      : 'N/A' },
                  { label: 'IP Address', value: selectedEntry.ipAddress || 'N/A' },
                  { label: 'User Agent', value: selectedEntry.userAgent || 'N/A' },
                  { label: 'Request ID', value: selectedEntry.requestId || 'N/A' }
                ]}
              />
              
              <Box>
                <Header variant="h3">Description</Header>
                <Box padding={{ top: 's' }}>
                  {selectedEntry.description}
                </Box>
              </Box>

              {selectedEntry.changes && selectedEntry.changes.length > 0 && (
                <Box>
                  <Header variant="h3">Changes</Header>
                  <Box padding={{ top: 's' }}>
                    <Table
                      items={selectedEntry.changes}
                      columnDefinitions={[
                        {
                          id: 'field',
                          header: 'Field',
                          cell: (item: any) => item.field
                        },
                        {
                          id: 'action',
                          header: 'Action',
                          cell: (item: any) => (
                            <Badge 
                              color={
                                item.action === 'added' ? 'green' : 
                                item.action === 'changed' ? 'blue' : 'red'
                              }
                            >
                              {item.action}
                            </Badge>
                          )
                        },
                        {
                          id: 'oldValue',
                          header: 'Previous Value',
                          cell: (item: any) => {
                            if (item.oldValue === null || item.oldValue === undefined) return '-';
                            if (typeof item.oldValue === 'object') return JSON.stringify(item.oldValue, null, 2);
                            return String(item.oldValue);
                          }
                        },
                        {
                          id: 'newValue',
                          header: 'New Value',
                          cell: (item: any) => {
                            if (item.newValue === null || item.newValue === undefined) return '-';
                            if (typeof item.newValue === 'object') return JSON.stringify(item.newValue, null, 2);
                            return String(item.newValue);
                          }
                        }
                      ]}
                      variant="embedded"
                    />
                  </Box>
                </Box>
              )}

              {selectedEntry.errorMessage && (
                <Box>
                  <Header variant="h3">Error Message</Header>
                  <Box padding={{ top: 's' }} color="text-status-error">
                    {selectedEntry.errorMessage}
                  </Box>
                </Box>
              )}
            </SpaceBetween>
          </Modal>
        )}
      </SpaceBetween>
  );
};

export default AuditTrail;
