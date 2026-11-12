import React, { useState, useEffect, useCallback } from 'react';
import { formatTimestamp, formatTimestampDate, formatTimestampTime, parseUtcTimestamp } from '../utils/dateUtils';
import {
  Container,
  Header,
  Table,
  Box,
  SpaceBetween,
  Button,
  ButtonDropdown,
  TextFilter,
  Select,
  DatePicker,
  FormField,
  Grid,
  StatusIndicator,
  Badge,
  Modal,
  Alert,
  ColumnLayout,
  KeyValuePairs,
  Input,
  CollectionPreferences,
  Toggle,
  Tabs
} from '@cloudscape-design/components';

import { ImportJob, ImportJobFilters, Datastore, DicomInterface } from '../types';
import { importJobService, datastoreService, dicomInterfaceService } from '../services';
import { useAutoRefresh } from '../hooks/useAutoRefresh';

interface ImportManagementProps {}

const ImportManagement: React.FC<ImportManagementProps> = () => {
  // State management
  const [importJobs, setImportJobs] = useState<ImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<ImportJob[]>([]);
  
  // Pagination state
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [goToPageInput, setGoToPageInput] = useState('');
  
  // Backend pagination flags
  const [hasNextPage, setHasNextPage] = useState(false);
  const [hasPreviousPage, setHasPreviousPage] = useState(false);
  
  // Table preferences state
  const [preferences, setPreferences] = useState({
    pageSize: 20,
    visibleContent: ['jobName', 'status', 'statistics', 'jobType', 'createdAt', 'dicomContext', 'datastore'],
    wrapLines: false
  });
  
  // Filter state
  const [filters, setFilters] = useState<ImportJobFilters>({
    status: '',
    jobType: '',
    datastoreId: '',
    calledAeTitle: '',
    callingAeTitle: '',
    createdDateFrom: '',
    createdDateTo: '',
    sortBy: 'createdAt',
    sortOrder: 'desc'
  });

  // Filter input state (separate from applied filters - only applied on Search click)
  const [filterInputs, setFilterInputs] = useState({
    status: '',
    jobType: '',
    datastoreId: '',
    calledAeTitle: '',
    callingAeTitle: '',
    createdDateFrom: '',
    createdDateTo: ''
  });
  
  // Modal state
  const [selectedJob, setSelectedJob] = useState<ImportJob | null>(null);
  const [showJobDetails, setShowJobDetails] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showRetryModal, setShowRetryModal] = useState(false);
  
  // Manual refresh state (for showing loading spinner only on manual refresh)
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  
  // Options for dropdowns
  const [datastoreOptions, setDatastoreOptions] = useState<Array<{ label: string; value: string }>>([]);
  
  // Error state
  const [error, setError] = useState<string | null>(null);

  // Load dropdown options
  const loadOptions = useCallback(async () => {
    try {
      const datastoresResponse = await datastoreService.getAll({ pageSize: 100 });
      
      setDatastoreOptions([
        { label: 'All Storage', value: '' },
        ...datastoresResponse.items.map((ds: Datastore) => ({
          label: ds.name,
          value: ds.id
        }))
      ]);
    } catch (err) {
      console.error('Failed to load options:', err);
    }
  }, []);

  // Load import jobs
  const loadImportJobs = useCallback(async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      
      // Prepare API parameters
      const apiParams = {
        ...filters,
        page: currentPageIndex,
        pageSize: pageSize
      };
      
      // Debug logging
      console.log('🚀 Loading import jobs with params:', apiParams);
      console.log('📄 Current page index:', currentPageIndex);
      
      const response = await importJobService.getAll(apiParams);
      
      // Debug logging
      console.log('📥 Import jobs response:', {
        itemsCount: response.items?.length || 0,
        totalPages: response.totalPages,
        totalCount: response.totalCount,
        currentPage: response.currentPage,
        requestedPage: currentPageIndex,
        pageMatch: response.currentPage === currentPageIndex,
        pageSize: pageSize,
        hasNextPage: response.hasNextPage,
        hasPreviousPage: response.hasPreviousPage
      });
      
      // Check if backend is returning the correct page
      if (response.currentPage !== currentPageIndex) {
        console.warn('⚠️ Backend returned wrong page!', {
          requested: currentPageIndex,
          returned: response.currentPage,
          message: 'Backend may be ignoring page parameter'
        });
      }
      
      // Use backend response directly
      setImportJobs(response.items || []);
      setTotalPages(response.totalPages || 1);
      setTotalItems(response.totalCount || 0);
      
      // Set backend pagination flags
      setHasNextPage(response.hasNextPage || false);
      setHasPreviousPage(response.hasPreviousPage || false);
      
      // Validate pagination state
      if (currentPageIndex > (response.totalPages || 1) && (response.totalPages || 1) > 0) {
        console.warn('Current page exceeds total pages, resetting to page 1');
        setCurrentPageIndex(1);
      }
      
    } catch (err) {
      console.error('❌ Failed to load import jobs:', err);
      setError(err instanceof Error ? err.message : 'Failed to load import jobs');
      setImportJobs([]);
      setTotalPages(1);
      setTotalItems(0);
      setHasNextPage(false);
      setHasPreviousPage(false);
    } finally {
      setLoading(false);
    }
  }, [filters, currentPageIndex, pageSize]);

  // Initial load
  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    loadImportJobs();
  }, [loadImportJobs]);

  // Auto-refresh with seamless updates (only when jobs are active)
  const shouldAutoRefresh = importJobs.some(job => 
    job.status === 'PENDING' || 
    job.status === 'IN_PROGRESS' || 
    job.status === 'RUNNING'
  );
  
  const { autoRefresh, setAutoRefresh, autoRefreshError, clearError } = useAutoRefresh(
    loadImportJobs,
    5000
  );
  
  // Only enable auto-refresh when there are active jobs
  useEffect(() => {
    if (autoRefresh && !shouldAutoRefresh) {
      // Keep auto-refresh on, but it won't do anything if no active jobs
    }
  }, [autoRefresh, shouldAutoRefresh]);

  // Clear selections on manual refresh only (keep only items still in list)
  useEffect(() => {
    if (!autoRefresh) {
      setSelectedItems(prev => 
        prev.filter(selected => 
          importJobs.some(item => item.id === selected.id)
        )
      );
    }
  }, [importJobs, autoRefresh]);



  // Clear cached dataset when filters change
  useEffect(() => {
    // No longer needed - we removed client-side caching
  }, [filters.status, filters.jobType, filters.datastoreId, filters.calledAeTitle, filters.callingAeTitle, filters.createdDateFrom, filters.createdDateTo]);

  // Keyboard navigation for pagination
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle keyboard shortcuts when not typing in an input field
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        switch (event.key) {
          case 'ArrowLeft':
            event.preventDefault();
            if (hasPreviousPage) {
              setCurrentPageIndex(currentPageIndex - 1);
            }
            break;
          case 'ArrowRight':
            event.preventDefault();
            if (hasNextPage) {
              setCurrentPageIndex(currentPageIndex + 1);
            }
            break;
          case 'Home':
            event.preventDefault();
            setCurrentPageIndex(1);
            break;
          case 'End':
            event.preventDefault();
            // Only go to last page if we know the exact total
            if (totalPages !== 999) {
              setCurrentPageIndex(totalPages);
            }
            break;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [currentPageIndex, totalPages, hasNextPage, hasPreviousPage]);

  // Handle search button click - apply all filter inputs
  const handleSearch = () => {
    setFilters(prev => ({ 
      ...prev,
      status: filterInputs.status,
      jobType: filterInputs.jobType,
      datastoreId: filterInputs.datastoreId,
      calledAeTitle: filterInputs.calledAeTitle,
      callingAeTitle: filterInputs.callingAeTitle,
      createdDateFrom: filterInputs.createdDateFrom,
      createdDateTo: filterInputs.createdDateTo
    }));
    setCurrentPageIndex(1);
  };

  // Handle search input clear - clears applied filters but keeps input values
  const handleClearSearch = () => {
    setFilters(prev => ({ 
      ...prev,
      status: '',
      jobType: '',
      datastoreId: '',
      calledAeTitle: '',
      callingAeTitle: '',
      createdDateFrom: '',
      createdDateTo: ''
    }));
    setCurrentPageIndex(1);
  };

  // Handle all filters reset
  const handleResetAllFilters = () => {
    const resetInputs = {
      status: '',
      jobType: '',
      datastoreId: '',
      calledAeTitle: '',
      callingAeTitle: '',
      createdDateFrom: '',
      createdDateTo: ''
    };
    setFilterInputs(resetInputs);
    setFilters({
      status: '',
      jobType: '',
      datastoreId: '',
      calledAeTitle: '',
      callingAeTitle: '',
      createdDateFrom: '',
      createdDateTo: '',
      sortBy: 'createdAt',
      sortOrder: 'desc'
    });
    setCurrentPageIndex(1);
  };

  // Handle refresh button - force reload
  const handleRefresh = () => {
    // Force reload
    loadImportJobs();
  };

  // Handle filter changes (for dropdowns and date pickers) - only update input state
  const handleFilterChange = (filterKey: keyof typeof filterInputs, value: string) => {
    setFilterInputs(prev => ({ 
      ...prev, 
      [filterKey]: value 
    }));
  };

  // Handle preferences change
  const handlePreferencesChange = (newPreferences: any) => {
    console.log('Preferences changed:', newPreferences);
    
    setPreferences(newPreferences);
    
    // Handle page size change
    if (newPreferences.pageSize !== pageSize) {
      console.log(`Page size changed from ${pageSize} to ${newPreferences.pageSize}`);
      setPageSize(newPreferences.pageSize);
      setCurrentPageIndex(1); // Reset to first page when changing page size
    }
    
    // Note: Column visibility and text wrapping are handled automatically by the Table component
  };

  // Handle go to page
  const handleGoToPage = () => {
    const pageNumber = parseInt(goToPageInput);
    if (pageNumber >= 1 && pageNumber <= totalPages) {
      setCurrentPageIndex(pageNumber);
      setGoToPageInput('');
    }
  };

  // Status indicator helper
  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <StatusIndicator type="success">Completed</StatusIndicator>;
      case 'COMPLETED_WITH_FAILURES':
        return <StatusIndicator type="warning">Completed with Failures</StatusIndicator>;
      case 'RUNNING':
      case 'IN_PROGRESS':
        return <StatusIndicator type="in-progress">In Progress</StatusIndicator>;
      case 'TRIGGERED':
        return <StatusIndicator type="loading">Triggered</StatusIndicator>;
      case 'PENDING':
        return <StatusIndicator type="pending">Pending</StatusIndicator>;
      case 'FAILED':
        return <StatusIndicator type="error">Failed</StatusIndicator>;
      case 'CANCELLED':
        return <StatusIndicator type="stopped">Cancelled</StatusIndicator>;
      case 'PAUSED':
        return <StatusIndicator type="warning">Paused</StatusIndicator>;
      default:
        return <StatusIndicator type="info">{status}</StatusIndicator>;
    }
  };

  // Job type badge helper
  const getJobTypeBadge = (jobType: string) => {
    // Handle undefined or null jobType
    if (!jobType) {
      return <Badge color="grey">Unknown</Badge>;
    }

    // Special handling for DIMSE_IMPORT with custom dark purple color
    if (jobType === 'DIMSE_IMPORT') {
      return (
        <span 
          style={{ 
            backgroundColor: '#4A148C', 
            color: 'white',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: '500',
            border: '1px solid #4A148C',
            display: 'inline-block'
          }}
        >
          {jobType.replace('_', ' ')}
        </span>
      );
    }

    // Special handling for STOW_IMPORT with custom orange color
    if (jobType === 'STOW_IMPORT') {
      return (
        <span 
          style={{ 
            backgroundColor: '#FF8C00', 
            color: 'white',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: '500',
            border: '1px solid #FF8C00',
            display: 'inline-block'
          }}
        >
          STOW Import
        </span>
      );
    }

    // Special handling for UPLOAD_IMPORT with custom teal color
    if (jobType === 'UPLOAD_IMPORT') {
      return (
        <span 
          style={{ 
            backgroundColor: '#008B8B', 
            color: 'white',
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: '500',
            border: '1px solid #008B8B',
            display: 'inline-block'
          }}
        >
          Upload Import
        </span>
      );
    }
    
    // Standard color mapping for other job types
    const colorMap: Record<string, "blue" | "green" | "grey" | "red"> = {
      'DICOM_IMPORT': 'blue',
      'BULK_IMPORT': 'green',
      'SCHEDULED_IMPORT': 'blue',
      'STOW_IMPORT': 'red'
    };
    return <Badge color={colorMap[jobType] || 'grey'}>{jobType.replace(/_/g, ' ').replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase())}</Badge>;
  };

  // Handle actions
  const handleCancelJob = async () => {
    if (!selectedJob) return;
    
    try {
      await importJobService.cancel(selectedJob.id);
      setShowCancelModal(false);
      setSelectedJob(null);
      loadImportJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    }
  };

  const handleRetryJob = async () => {
    if (!selectedJob) return;
    
    try {
      await importJobService.retry(selectedJob.id);
      setShowRetryModal(false);
      setSelectedJob(null);
      loadImportJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry job');
    }
  };

  const handleDeleteJob = async (job: ImportJob) => {
    try {
      await importJobService.delete(job.id);
      loadImportJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete job');
    }
  };

  // Get available actions for selected items
  const getAvailableActions = () => {
    if (selectedItems.length === 0) return [];
    
    const actions = [];
    
    // Details action - always available for single selection
    if (selectedItems.length === 1) {
      actions.push({
        id: 'details',
        text: 'View Details',
        disabled: false
      });
    }
    
    // Cancel action - available if any selected item can be cancelled
    const canCancel = selectedItems.some(item => 
      item.status === 'RUNNING' || item.status === 'IN_PROGRESS' || 
      item.status === 'PENDING' || item.status === 'TRIGGERED'
    );
    if (canCancel) {
      actions.push({
        id: 'cancel',
        text: selectedItems.length === 1 ? 'Cancel Job' : `Cancel Jobs (${selectedItems.filter(item => 
          item.status === 'RUNNING' || item.status === 'IN_PROGRESS' || 
          item.status === 'PENDING' || item.status === 'TRIGGERED'
        ).length})`,
        disabled: false
      });
    }
    
    // Retry action - available if any selected item can be retried
    const canRetry = selectedItems.some(item => item.status === 'FAILED');
    if (canRetry) {
      actions.push({
        id: 'retry',
        text: selectedItems.length === 1 ? 'Retry Job' : `Retry Jobs (${selectedItems.filter(item => item.status === 'FAILED').length})`,
        disabled: false
      });
    }
    
    // Delete action - available if any selected item can be deleted
    const canDelete = selectedItems.some(item => 
      item.status === 'COMPLETED' || item.status === 'COMPLETED_WITH_FAILURES' || 
      item.status === 'FAILED' || item.status === 'CANCELLED'
    );
    if (canDelete) {
      actions.push({
        id: 'delete',
        text: selectedItems.length === 1 ? 'Delete Job' : `Delete Jobs (${selectedItems.filter(item => 
          item.status === 'COMPLETED' || item.status === 'COMPLETED_WITH_FAILURES' || 
          item.status === 'FAILED' || item.status === 'CANCELLED'
        ).length})`,
        disabled: false
      });
    }
    
    return actions;
  };

  // Handle action selection
  const handleActionSelection = ({ detail }: { detail: { id: string } }) => {
    const actionId = detail.id;
    
    switch (actionId) {
      case 'details':
        if (selectedItems.length === 1) {
          setSelectedJob(selectedItems[0]);
          setShowJobDetails(true);
        }
        break;
        
      case 'cancel':
        if (selectedItems.length === 1) {
          setSelectedJob(selectedItems[0]);
          setShowCancelModal(true);
        } else {
          // Handle bulk cancel - you can implement this later
          console.log('Bulk cancel not implemented yet');
        }
        break;
        
      case 'retry':
        if (selectedItems.length === 1) {
          setSelectedJob(selectedItems[0]);
          setShowRetryModal(true);
        } else {
          // Handle bulk retry - you can implement this later
          console.log('Bulk retry not implemented yet');
        }
        break;
        
      case 'delete':
        if (selectedItems.length === 1) {
          handleDeleteJob(selectedItems[0]);
        } else {
          // Handle bulk delete - you can implement this later
          console.log('Bulk delete not implemented yet');
        }
        break;
    }
  };

  // Helper function to format relative time
  const getRelativeTime = (dateString: string) => {
    const date = parseUtcTimestamp(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    const absDiff = Math.abs(diffInSeconds);
    
    if (absDiff < 60) return `${absDiff}s ago`;
    if (absDiff < 3600) return `${Math.floor(absDiff / 60)}m ago`;
    if (absDiff < 86400) return `${Math.floor(absDiff / 3600)}h ago`;
    if (absDiff < 2592000) return `${Math.floor(absDiff / 86400)}d ago`;
    return `${Math.floor(absDiff / 2592000)}mo ago`;
  };

  // Table columns definition
  const columnDefinitions = [
    {
      id: 'jobName',
      header: 'Job Name',
      cell: (item: ImportJob) => (
        <Box>
          <Box fontSize="body-s" fontWeight="bold">{item.jobName}</Box>
          <Box fontSize="body-s" color="text-status-info">{item.id.substring(0, 8)}...</Box>
        </Box>
      ),
      sortingField: 'jobName',
      width: 250
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: ImportJob) => getStatusIndicator(item.status),
      sortingField: 'status',
      width: 120
    },
    {
      id: 'statistics',
      header: 'Statistics',
      cell: (item: ImportJob) => (
        <SpaceBetween direction="horizontal" size="xs">
          {(item.totalFiles || 0) > 0 && (
            <Badge color="grey">{item.totalFiles}</Badge>
          )}
          {(item.processedFiles || 0) > 0 && (
            <Badge color="blue">{item.processedFiles}</Badge>
          )}
          {(item.failedFiles || 0) > 0 && (
            <Badge color="red">{item.failedFiles}</Badge>
          )}
        </SpaceBetween>
      ),
      width: 180
    },
    {
      id: 'jobType',
      header: 'Type',
      cell: (item: ImportJob) => getJobTypeBadge(item.jobType),
      sortingField: 'jobType',
      width: 140
    },
    {
      id: 'createdAt',
      header: 'Created',
      cell: (item: ImportJob) => (
        <Box>
          <Box fontSize="body-s">{formatTimestampDate(item.createdAt)}</Box>
          <Box fontSize="body-s" color="text-status-info">
            {formatTimestampTime(item.createdAt)} ({getRelativeTime(item.createdAt)})
          </Box>
        </Box>
      ),
      sortingField: 'createdAt',
      width: 180
    },
    {
      id: 'dicomContext',
      header: 'DICOM Origin',
      cell: (item: ImportJob) => (
        <Box>
          {item.dicomContext ? (
            <>
              <Box fontSize="body-s">{item.dicomContext.interfaceName}</Box>
              <Box fontSize="body-s" color="text-status-info">
                {item.dicomContext.callingAeTitle} → {item.dicomContext.aeTitle}
              </Box>
            </>
          ) : (
            <Box color="text-status-inactive">N/A</Box>
          )}
        </Box>
      ),
      width: 200
    },
    {
      id: 'datastore',
      header: 'Destination',
      cell: (item: ImportJob) => (
        <Box>
          <Box fontSize="body-s" fontWeight="bold">{item.datastoreName}</Box>
          <Box fontSize="body-s" color="text-status-info">{item.datastoreId}</Box>
        </Box>
      ),
      width: 180
    }
  ];

  const visibleColumnDefs = columnDefinitions.filter(col => preferences.visibleContent.includes(col.id));

  return (
    <SpaceBetween direction="vertical" size="l">
      <Header
        variant="h1"
        description="Monitor and manage DICOM import jobs"
      >
        Import Jobs
      </Header>
      {autoRefreshError && (
        <Alert
          type="warning"
          dismissible
          onDismiss={clearError}
          header="Auto-refresh Error"
        >
          {autoRefreshError}
        </Alert>
      )}
      
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
                (filters.status || filters.jobType || filters.datastoreId || filters.calledAeTitle || 
                 filters.createdDateFrom || filters.createdDateTo || filters.search || filters.callingAeTitle) 
                  ? `(${Object.values(filters).filter(v => v && v !== 'createdAt' && v !== 'desc').length} active)`
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
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } },
            { colspan: { default: 12, xs: 6, s: 4, m: 3 } }
          ]}>
            <FormField label="Status">
              <Select
                selectedOption={
                  filterInputs.status ? { label: filterInputs.status, value: filterInputs.status } : null
                }
                onChange={({ detail }) =>
                  handleFilterChange('status', detail.selectedOption?.value || '')
                }
                options={[
                  { label: 'All Statuses', value: '' },
                  { label: 'Pending', value: 'PENDING' },
                  { label: 'Triggered', value: 'TRIGGERED' },
                  { label: 'In Progress', value: 'IN_PROGRESS' },
                  { label: 'Running', value: 'RUNNING' },
                  { label: 'Completed', value: 'COMPLETED' },
                  { label: 'Completed with Failures', value: 'COMPLETED_WITH_FAILURES' },
                  { label: 'Failed', value: 'FAILED' },
                  { label: 'Cancelled', value: 'CANCELLED' },
                  { label: 'Paused', value: 'PAUSED' }
                ]}
                placeholder="Select status"
              />
            </FormField>

            <FormField label="Job Type">
              <Select
                selectedOption={
                  filterInputs.jobType ? { label: filterInputs.jobType.replace('_', ' '), value: filterInputs.jobType } : null
                }
                onChange={({ detail }) =>
                  handleFilterChange('jobType', detail.selectedOption?.value || '')
                }
                options={[
                  { label: 'All Types', value: '' },
                  { label: 'DICOM Import', value: 'DICOM_IMPORT' },
                  { label: 'Bulk Import', value: 'BULK_IMPORT' },
                  { label: 'Scheduled Import', value: 'SCHEDULED_IMPORT' },
                  { label: 'DIMSE Import', value: 'DIMSE_IMPORT' },
                  { label: 'STOW Import', value: 'STOW_IMPORT' },
                  { label: 'Upload Import', value: 'UPLOAD_IMPORT' }
                ]}
                placeholder="Select type"
              />
            </FormField>

            <FormField label="Storage">
              <Select
                selectedOption={
                  filterInputs.datastoreId 
                    ? datastoreOptions.find(opt => opt.value === filterInputs.datastoreId) || null
                    : null
                }
                onChange={({ detail }) =>
                  handleFilterChange('datastoreId', detail.selectedOption?.value || '')
                }
                options={datastoreOptions}
                placeholder="Select storage"
              />
            </FormField>

            <FormField label="Called AE Title">
              <TextFilter
                filteringText={filterInputs.calledAeTitle}
                onChange={({ detail }) => handleFilterChange('calledAeTitle', detail.filteringText)}
                filteringPlaceholder="Enter called AE title"
              />
            </FormField>

            <FormField label="Calling AE Title">
              <TextFilter
                filteringText={filterInputs.callingAeTitle}
                onChange={({ detail }) => handleFilterChange('callingAeTitle', detail.filteringText)}
                filteringPlaceholder="Enter calling AE title"
              />
            </FormField>

            <FormField label="Created From">
              <DatePicker
                value={filterInputs.createdDateFrom || ''}
                onChange={({ detail }) =>
                  handleFilterChange('createdDateFrom', detail.value)
                }
                placeholder="YYYY-MM-DD"
              />
            </FormField>

            <FormField label="Created To">
              <DatePicker
                value={filterInputs.createdDateTo || ''}
                onChange={({ detail }) =>
                  handleFilterChange('createdDateTo', detail.value)
                }
                placeholder="YYYY-MM-DD"
              />
            </FormField>
          </Grid>
          
          {/* Search Actions */}
          <Box margin={{ top: 'm' }}>
            <SpaceBetween direction="horizontal" size="xs">
              <Button 
                onClick={handleSearch}
              >
                Search
              </Button>
              {(filters.status || filters.jobType || filters.datastoreId || filters.calledAeTitle || 
                filters.callingAeTitle || filters.createdDateFrom || filters.createdDateTo) && (
                <Button onClick={handleClearSearch}>
                  Clear
                </Button>
              )}
              <Button onClick={handleResetAllFilters}>
                Reset All Filters
            </Button>
          </SpaceBetween>
        </Box>
      </Container>

      {/* Import Jobs Table */}
      <Table
        columnDefinitions={visibleColumnDefs}
        items={importJobs}
        loading={loading}
        loadingText="Loading import jobs..."
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
        selectionType="multi"
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
                    label: "Import job properties",
                    options: [
                      { id: "jobName", label: "Job Name" },
                      { id: "status", label: "Status" },
                      { id: "statistics", label: "Statistics" },
                      { id: "jobType", label: "Job Type" },
                      { id: "createdAt", label: "Created" },
                      { id: "dicomContext", label: "DICOM Origin" },
                      { id: "datastore", label: "Storage" }
                    ]
                  }
                ]
              }}
            />
          }
          ariaLabels={{
            selectionGroupLabel: "Items selection",
            allItemsSelectionLabel: ({ selectedItems }) =>
              `${selectedItems.length} ${selectedItems.length === 1 ? "item" : "items"} selected`,
            itemSelectionLabel: ({ selectedItems }, item) => {
              const isItemSelected = selectedItems.filter(i => i.id === item.id).length;
              return `${item.jobName} is ${isItemSelected ? "" : "not"} selected`;
            }
          }}
          renderAriaLive={({ firstIndex, lastIndex, totalItemsCount }) =>
            `Displaying items ${firstIndex} to ${lastIndex} of ${totalItemsCount}`
          }
          sortingDisabled={true}
          empty={
            <Box textAlign="center" color="inherit">
              <Box variant="strong" textAlign="center" color="inherit">
                No import jobs found
              </Box>
              <Box variant="p" padding={{ bottom: "s" }} color="inherit">
                No import jobs match the current filters.
              </Box>
            </Box>
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
                  <Toggle
                    checked={autoRefresh}
                    onChange={({ detail }) => setAutoRefresh(detail.checked)}
                  >
                    Auto-refresh
                  </Toggle>
                  <Button onClick={handleRefresh} loading={loading}>
                    Refresh
                  </Button>
                  <ButtonDropdown
                    items={getAvailableActions()}
                    disabled={selectedItems.length === 0}
                    onItemClick={handleActionSelection}
                  >
                    Actions
                  </ButtonDropdown>
                </SpaceBetween>
              }
            >
              Import Jobs
            </Header>
          }
          pagination={
            <SpaceBetween direction="horizontal" size="m" alignItems="center">
              {/* Custom pagination using backend flags */}
              <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                <Button
                  disabled={!hasPreviousPage || loading}
                  onClick={() => setCurrentPageIndex(Math.max(1, currentPageIndex - 1))}
                  iconName="angle-left"
                  variant="icon"
                  ariaLabel="Previous page"
                />
                
                <Box variant="awsui-key-label">
                  Page {currentPageIndex}
                  {totalPages > 1 && totalPages !== 999 && ` of ${totalPages}`}
                  {hasNextPage && totalPages === 999 && '+'}
                </Box>
                
                <Button
                  disabled={!hasNextPage || loading}
                  onClick={() => setCurrentPageIndex(currentPageIndex + 1)}
                  iconName="angle-right"
                  variant="icon"
                  ariaLabel="Next page"
                />
              </SpaceBetween>
              
              {totalPages > 5 && totalPages !== 999 && (
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  <Box variant="awsui-key-label">Go to page:</Box>
                  <Input
                    value={goToPageInput}
                    onChange={({ detail }) => setGoToPageInput(detail.value)}
                    placeholder={`1-${totalPages}`}
                    type="number"
                    onKeyDown={(event) => {
                      if (event.detail.key === 'Enter') {
                        handleGoToPage();
                      }
                    }}
                    inputMode="numeric"
                  />
                  <Button 
                    onClick={handleGoToPage}
                    disabled={!goToPageInput || parseInt(goToPageInput) < 1 || parseInt(goToPageInput) > totalPages}
                  >
                    Go
                  </Button>
                </SpaceBetween>
              )}
              
              <Box variant="awsui-key-label">
                {totalItems > 0 ? (
                  <>
                    Showing {((currentPageIndex - 1) * pageSize) + 1}-{Math.min(currentPageIndex * pageSize, totalItems)} 
                    {totalPages === 999 ? ' of 100+' : ` of ${totalItems}`} items
                  </>
                ) : (
                  'No items'
              )}
            </Box>
          </SpaceBetween>
        }
      />

      {/* Job Details Modal */}
      {selectedJob && (
        <Modal
          visible={showJobDetails}
            onDismiss={() => {
              setShowJobDetails(false);
              setSelectedJob(null);
            }}
            header={`Import Job Details - ${selectedJob.jobName}`}
            size="large"
          >
            <Tabs
              tabs={[
                {
                  label: "Details",
                  id: "details",
                  content: (
                    <SpaceBetween size="l">
                      {/* Failure Message Alert */}
                      {selectedJob.failureMessage && (
                        <Alert type="error" header="Failure Reason">
                          {selectedJob.failureMessage}
                        </Alert>
                      )}

                      {/* Job Information */}
                      <Container header={<Header variant="h3">Job Information</Header>}>
                        <ColumnLayout columns={2}>
                          <KeyValuePairs
                            columns={1}
                            items={[
                              { label: 'Job ID', value: selectedJob.id },
                              { label: 'Job Name', value: selectedJob.jobName },
                              { label: 'Status', value: getStatusIndicator(selectedJob.status) },
                              { label: 'Type', value: getJobTypeBadge(selectedJob.jobType) }
                            ]}
                          />
                          <KeyValuePairs
                            columns={1}
                            items={[
                              { label: 'Created', value: formatTimestamp(selectedJob.createdAt) },
                              { label: 'Updated', value: formatTimestamp(selectedJob.updatedAt) },
                              { label: 'Created By', value: selectedJob.createdBy || 'System' }
                            ]}
                          />
                        </ColumnLayout>
                      </Container>

                      {/* Source & Destination */}
                      <Container header={<Header variant="h3">Source & Destination</Header>}>
                        <ColumnLayout columns={2}>
                          <KeyValuePairs
                            columns={1}
                            items={[
                              { label: 'Source Type', value: selectedJob.sourceType },
                              { label: 'Source Location', value: selectedJob.sourceLocation || 'N/A' },
                              { label: 'Input S3 URI', value: selectedJob.inputS3Uri || 'N/A' }
                            ]}
                          />
                          <KeyValuePairs
                            columns={1}
                            items={[
                              { label: 'Storage', value: selectedJob.datastoreName },
                              { label: 'Storage ID', value: selectedJob.datastoreId },
                              { label: 'Output S3 URI', value: selectedJob.outputS3Uri || 'N/A' }
                            ]}
                          />
                        </ColumnLayout>
                      </Container>

                      {/* DICOM Context */}
                      {selectedJob.dicomContext && (
                        <Container header={<Header variant="h3">DICOM Context</Header>}>
                          <KeyValuePairs
                            columns={2}
                            items={[
                              { label: 'Interface ID', value: selectedJob.dicomContext.interfaceId },
                              { label: 'Interface Name', value: selectedJob.dicomContext.interfaceName },
                              { label: 'Called AE Title (Interface)', value: selectedJob.dicomContext.aeTitle },
                              { label: 'Calling AE Title (Client)', value: selectedJob.dicomContext.callingAeTitle }
                            ]}
                          />
                        </Container>
                      )}

                      {/* Progress & Statistics */}
                      <Container header={<Header variant="h3">Progress & Statistics</Header>}>
                        <ColumnLayout columns={2}>
                          <KeyValuePairs
                            columns={1}
                            items={[
                              { label: 'Processed Files', value: (selectedJob.processedFiles || 0).toLocaleString() },
                              { label: 'Failed Files', value: (selectedJob.failedFiles || 0).toLocaleString() }
                            ]}
                          />
                          <KeyValuePairs
                            columns={1}
                            items={[
                              { label: 'Instances Created', value: (selectedJob.imagesetsCreated || 0).toLocaleString() },
                              { label: 'Instances Imported', value: (selectedJob.instancesImported || 0).toLocaleString() }
                            ]}
                          />
                        </ColumnLayout>
                      </Container>
                    </SpaceBetween>
                  )
                },
                ...((selectedJob.failedFiles && selectedJob.failedFiles > 0) || selectedJob.errorDetails ? [{
                  label: "Errors",
                  id: "errors",
                  content: (
                    <Container>
                      {selectedJob.errorDetails && selectedJob.errorDetails.length > 0 ? (
                        <Table
                          columnDefinitions={[
                            {
                              id: 'severity',
                              header: 'Severity',
                              cell: (item: any) => (
                                <Badge color={item.severity === 'failure' ? 'red' : 'blue'}>
                                  {item.severity === 'failure' ? 'Failure' : 'Warning'}
                                </Badge>
                              ),
                              width: 120
                            },
                            {
                              id: 'message',
                              header: 'Error Message',
                              cell: (item: any) => item.message
                            },
                            {
                              id: 'count',
                              header: 'Count',
                              cell: (item: any) => (item.count || 0).toLocaleString(),
                              width: 100
                            }
                          ]}
                          items={selectedJob.errorDetails}
                          variant="embedded"
                          empty={
                            <Box textAlign="center" color="inherit">
                              <b>No errors</b>
                              <Box padding={{ bottom: "s" }} variant="p" color="inherit">
                                No error details available for this job.
                              </Box>
                            </Box>
                          }
                        />
                      ) : (
                        <Box textAlign="center" padding="l">
                          <Box variant="p" color="text-body-secondary">
                            Error details are being processed or not available yet.
                          </Box>
                        </Box>
                      )}
                    </Container>
                  )
                }] : [])
              ]}
            />
          </Modal>
        )}

        {/* Cancel Job Modal */}
        <Modal
          visible={showCancelModal}
          onDismiss={() => {
            setShowCancelModal(false);
            setSelectedJob(null);
          }}
          header="Cancel Import Job"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="link"
                  onClick={() => {
                    setShowCancelModal(false);
                    setSelectedJob(null);
                  }}
                >
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleCancelJob}>
                  Confirm Cancel
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <Box>
            Are you sure you want to cancel the import job "{selectedJob?.jobName}"?
            This action cannot be undone.
          </Box>
        </Modal>

        {/* Retry Job Modal */}
        <Modal
          visible={showRetryModal}
          onDismiss={() => {
            setShowRetryModal(false);
            setSelectedJob(null);
          }}
          header="Retry Import Job"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="link"
                  onClick={() => {
                    setShowRetryModal(false);
                    setSelectedJob(null);
                  }}
                >
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleRetryJob}>
                  Retry Job
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <Box>
            Are you sure you want to retry the import job "{selectedJob?.jobName}"?
        </Box>
      </Modal>
    </SpaceBetween>
  );
};

export default ImportManagement;
