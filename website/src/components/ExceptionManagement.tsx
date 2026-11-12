import React, { useState, useEffect, useCallback } from 'react';
import { formatTimestamp } from '../utils/dateUtils';
import { getModalityOptions } from '../constants/dicomModalities';
import { ModalityBadge } from './ModalityBadge';
import {
  Container,
  Header,
  Box,
  SpaceBetween,
  Table,
  Button,
  TextFilter,
  Pagination,
  StatusIndicator,
  Badge,
  ColumnLayout,
  KeyValuePairs,
  Alert,
  Spinner,
  Select,
  FormField,
  Modal,
  Tabs,
  TabsProps
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';

interface NonPrimaryImageset {
  id: string;
  imagesetId: string;
  datastoreId: string;
  patientId: string;
  patientName?: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  studyDate: string;
  studyDescription?: string;
  seriesDescription?: string;
  modality: string;
  instanceCount: number;
  storageUsed: number;
  imageSetState: string;
  imageSetWorkflowStatus: string;
  createdAt: string;
  updatedAt: string;
  // Additional DICOM metadata
  studyTime?: string;
  seriesNumber?: string;
  acquisitionDate?: string;
  institutionName?: string;
  manufacturerModelName?: string;
  bodyPartExamined?: string;
  viewPosition?: string;
  imageType?: string[];
  pixelSpacing?: number[];
  sliceThickness?: number;
  repetitionTime?: number;
  echoTime?: number;
  flipAngle?: number;
}

const ExceptionManagement: React.FC = () => {
  const [nonPrimaryImagesets, setNonPrimaryImagesets] = useState<NonPrimaryImageset[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedItems, setSelectedItems] = useState<NonPrimaryImageset[]>([]);
  const [filteringText, setFilteringText] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [sortingColumn, setSortingColumn] = useState<any>({ sortingField: 'createdAt' });
  const [sortingDescending, setSortingDescending] = useState(true);
  const [preferences] = useState({
    pageSize: 20,
    visibleContent: ['patientId', 'studyDate', 'modality', 'studyDescription', 'seriesDescription', 'instanceCount', 'storageUsed', 'imageSetState'],
    wrapLines: false
  });
  const [selectedImageset, setSelectedImageset] = useState<NonPrimaryImageset | null>(null);
  const [detailModalVisible, setDetailModalVisible] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  
  // Filters
  const [datastoreFilter, setDatastoreFilter] = useState<any>({ selectedOption: null });
  const [modalityFilter, setModalityFilter] = useState<any>({ selectedOption: null });
  const [activeTabId, setActiveTabId] = useState('non-primary-imagesets');

  // Load non-primary studies
  const loadNonPrimaryImagesets = useCallback(async (resetData = false) => {
    setLoading(true);
    setError(null);
    
    try {
      const params: any = {
        limit: preferences.pageSize.toString(),
      };
      
      if (datastoreFilter.selectedOption?.value) {
        params.datastoreId = datastoreFilter.selectedOption.value;
      }
      if (modalityFilter.selectedOption?.value) {
        params.modality = modalityFilter.selectedOption.value;
      }
      if (!resetData && nextToken) {
        params.nextToken = nextToken;
      }
      
      const queryString = new URLSearchParams(params).toString();
      const response = await apiClient.makeRequest<{data: {items: NonPrimaryImageset[], nextToken?: string, count: number, scannedCount: number}}>(`/exceptions/non-primary-imagesets?${queryString}`, {
        method: 'GET'
      });
      
      if (response.success && response.data) {
        if (resetData) {
          setNonPrimaryImagesets(response.data.data.items || []);
          setCurrentPageIndex(1);
        } else {
          setNonPrimaryImagesets(prev => [...prev, ...(response.data.data.items || [])]);
        }
        
        setNextToken(response.data.data.nextToken);
        setHasMore(!!response.data.data.nextToken);
      } else {
        throw new Error(response.message || 'Failed to load non-primary studies');
      }
      
    } catch (err: any) {
      console.error('Error loading non-primary studies:', err);
      setError(err.message || 'Failed to load non-primary studies');
    } finally {
      setLoading(false);
    }
  }, [preferences.pageSize, datastoreFilter.selectedOption?.value, modalityFilter.selectedOption?.value, nextToken]);

  // Load detailed information for a specific study
  const loadImagesetDetail = async (id: string) => {
    setDetailLoading(true);
    try {
      const response = await apiClient.makeRequest<{data: NonPrimaryImageset}>(`/exceptions/non-primary-imagesets/${id}`, {
        method: 'GET'
      });
      
      if (response.success && response.data) {
        setSelectedImageset(response.data.data);
      } else {
        throw new Error(response.message || 'Failed to load study details');
      }
    } catch (err: any) {
      console.error('Error loading study detail:', err);
      setError(err.message || 'Failed to load study details');
    } finally {
      setDetailLoading(false);
    }
  };

  // Format file size
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Format date
  const formatDate = (dateString: string): string => {
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateString;
    }
  };

  // Get status indicator type
  const getStatusType = (state: string): 'success' | 'warning' | 'error' | 'info' => {
    switch (state) {
      case 'ACTIVE': return 'success';
      case 'CREATING': return 'info';
      case 'UPDATING': return 'warning';
      case 'DELETING': return 'warning';
      case 'DELETED': return 'error';
      default: return 'info';
    }
  };

  // Filter items based on search text
  const filteredItems = nonPrimaryImagesets.filter(item =>
    !filteringText || 
    item.patientId.toLowerCase().includes(filteringText.toLowerCase()) ||
    item.studyDescription?.toLowerCase().includes(filteringText.toLowerCase()) ||
    item.seriesDescription?.toLowerCase().includes(filteringText.toLowerCase()) ||
    item.modality.toLowerCase().includes(filteringText.toLowerCase())
  );

  // Sort items
  const sortedItems = [...filteredItems].sort((a, b) => {
    const aValue = a[sortingColumn.sortingField as keyof NonPrimaryImageset];
    const bValue = b[sortingColumn.sortingField as keyof NonPrimaryImageset];
    
    if (aValue === bValue) return 0;
    const result = aValue! < bValue! ? -1 : 1;
    return sortingDescending ? -result : result;
  });

  // Paginate items
  const paginatedItems = sortedItems.slice(
    (currentPageIndex - 1) * preferences.pageSize,
    currentPageIndex * preferences.pageSize
  );

  // Table columns
  const columnDefinitions = [
    {
      id: 'patientId',
      header: 'Patient ID',
      cell: (item: NonPrimaryImageset) => (
        <div>
          <div style={{ fontWeight: 'bold' }}>{item.patientId}</div>
          {item.patientName && (
            <div style={{ fontSize: '0.85em', color: '#666' }}>{item.patientName}</div>
          )}
        </div>
      ),
      sortingField: 'patientId',
      isRowHeader: true,
    },
    {
      id: 'studyDate',
      header: 'Study Date',
      cell: (item: NonPrimaryImageset) => formatDate(item.studyDate),
      sortingField: 'studyDate',
    },
    {
      id: 'modality',
      header: 'Modality',
      cell: (item: NonPrimaryImageset) => (
        <ModalityBadge modality={item.modality} />
      ),
      sortingField: 'modality',
    },
    {
      id: 'studyDescription',
      header: 'Study Description',
      cell: (item: NonPrimaryImageset) => item.studyDescription || 'N/A',
      sortingField: 'studyDescription',
    },
    {
      id: 'seriesDescription',
      header: 'Series Description',
      cell: (item: NonPrimaryImageset) => item.seriesDescription || 'N/A',
      sortingField: 'seriesDescription',
    },
    {
      id: 'instanceCount',
      header: 'Instances',
      cell: (item: NonPrimaryImageset) => item.instanceCount.toLocaleString(),
      sortingField: 'instanceCount',
    },
    {
      id: 'storageUsed',
      header: 'Size',
      cell: (item: NonPrimaryImageset) => formatFileSize(item.storageUsed),
      sortingField: 'storageUsed',
    },
    {
      id: 'imageSetState',
      header: 'Status',
      cell: (item: NonPrimaryImageset) => (
        <StatusIndicator type={getStatusType(item.imageSetState)}>
          {item.imageSetState}
        </StatusIndicator>
      ),
      sortingField: 'imageSetState',
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (item: NonPrimaryImageset) => (
        <Button
          variant="inline-link"
          onClick={() => {
            setSelectedImageset(item);
            loadImagesetDetail(item.id);
            setDetailModalVisible(true);
          }}
        >
          View Details
        </Button>
      ),
    },
  ];

  // Initial load
  useEffect(() => {
    if (activeTabId === 'non-primary-imagesets') {
      loadNonPrimaryImagesets(true);
    }
  }, [activeTabId, datastoreFilter, modalityFilter, preferences.pageSize, loadNonPrimaryImagesets]);

  // Clear selections on manual refresh (keep only items still in list)
  useEffect(() => {
    setSelectedItems(prev => 
      prev.filter(selected => 
        nonPrimaryImagesets.some(item => item.id === selected.id)
      )
    );
  }, [nonPrimaryImagesets]);

  // Tab content
  const tabs: TabsProps.Tab[] = [
    {
      label: 'Non-Primary Studies',
      id: 'non-primary-imagesets',
      content: (
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}

          {/* Filters */}
          <Container header={<Header variant="h3">Filters</Header>}>
            <ColumnLayout columns={3}>
              <FormField label="Datastore">
                <Select
                  selectedOption={datastoreFilter.selectedOption}
                  onChange={({ detail }) => setDatastoreFilter({ selectedOption: detail.selectedOption })}
                  options={[
                    { label: 'All Datastores', value: '' },
                    // Add datastore options dynamically
                  ]}
                  placeholder="Select datastore"
                />
              </FormField>
              <FormField label="Modality">
                <Select
                  selectedOption={modalityFilter.selectedOption}
                  onChange={({ detail }) => setModalityFilter({ selectedOption: detail.selectedOption })}
                  options={getModalityOptions()}
                  placeholder="Select modality"
                />
              </FormField>
              <FormField label="Actions">
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={() => loadNonPrimaryImagesets(true)} loading={loading}>
                    Refresh
                  </Button>
                  <Button 
                    onClick={() => {
                      setDatastoreFilter({ selectedOption: null });
                      setModalityFilter({ selectedOption: null });
                      setFilteringText('');
                      loadNonPrimaryImagesets(true);
                    }}
                  >
                    Clear Filters
                  </Button>
                </SpaceBetween>
              </FormField>
            </ColumnLayout>
          </Container>

          {/* Results Table */}
          <Table
            columnDefinitions={columnDefinitions}
            items={paginatedItems}
            loadingText="Loading non-primary studies..."
            loading={loading}
            selectedItems={selectedItems}
            onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
            empty={
              <Box textAlign="center" color="inherit">
                <b>No non-primary studies found</b>
                <Box variant="p" color="inherit">
                  No non-primary studies match the current filters. Try adjusting your search criteria.
                </Box>
              </Box>
            }
            filter={
              <TextFilter
                filteringText={filteringText}
                onChange={({ detail }) => setFilteringText(detail.filteringText)}
                filteringPlaceholder="Search studies..."
                countText={`${filteredItems.length} matches`}
              />
            }
            header={
              <Header
                counter={`(${filteredItems.length})`}
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    {hasMore && (
                      <Button onClick={() => loadNonPrimaryImagesets(false)} loading={loading}>
                        Load More
                      </Button>
                    )}
                  </SpaceBetween>
                }
              >
                Non-Primary Studies
              </Header>
            }
            pagination={
              <Pagination
                currentPageIndex={currentPageIndex}
                onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
                pagesCount={Math.ceil(filteredItems.length / preferences.pageSize)}
                ariaLabels={{
                  nextPageLabel: 'Next page',
                  previousPageLabel: 'Previous page',
                  pageLabel: (pageNumber) => `Page ${pageNumber} of all pages`,
                }}
              />
            }
            sortingColumn={sortingColumn}
            sortingDescending={sortingDescending}
            onSortingChange={({ detail }) => {
              setSortingColumn(detail.sortingColumn);
              setSortingDescending(detail.isDescending || false);
            }}
            selectionType="multi"
            trackBy="id"
            variant="container"
          />
        </SpaceBetween>
      ),
    },
    {
      label: 'Other Exceptions',
      id: 'other-exceptions',
      content: (
        <Container>
          <Box>
            <Alert type="info">
              Other exception types (failed imports, processing errors, etc.) will be implemented here.
            </Alert>
          </Box>
        </Container>
      ),
    },
  ];

  return (
    <SpaceBetween direction="vertical" size="l">
      <Header
        variant="h1"
        description="Manage and review exceptional cases that require attention, including non-primary studies and processing errors."
        actions={
          <Button variant="primary" onClick={() => loadNonPrimaryImagesets(true)} loading={loading}>
            Refresh All
          </Button>
        }
      >
        Exception Management
      </Header>

      <Tabs
        tabs={tabs}
        activeTabId={activeTabId}
        onChange={({ detail }) => setActiveTabId(detail.activeTabId)}
      />

      {/* Detail Modal */}
      <Modal
        onDismiss={() => setDetailModalVisible(false)}
        visible={detailModalVisible}
        size="large"
        header="Non-Primary Study Details"
      >
        {detailLoading ? (
          <Box textAlign="center">
            <Spinner size="large" />
          </Box>
        ) : selectedImageset ? (
          <SpaceBetween direction="vertical" size="l">
            <ColumnLayout columns={2}>
              <Container header={<Header variant="h3">Basic Information</Header>}>
                <KeyValuePairs
                  columns={1}
                  items={[
                    { label: 'Study ID', value: selectedImageset.imagesetId },
                    { label: 'Datastore ID', value: selectedImageset.datastoreId },
                    { label: 'Patient ID', value: selectedImageset.patientId },
                    { label: 'Patient Name', value: selectedImageset.patientName || 'N/A' },
                    { label: 'Study UID', value: selectedImageset.studyInstanceUid },
                    { label: 'Series UID', value: selectedImageset.seriesInstanceUid },
                    { label: 'Created', value: formatTimestamp(selectedImageset.createdAt) },
                    { label: 'Updated', value: formatTimestamp(selectedImageset.updatedAt) },
                  ]}
                />
              </Container>

              <Container header={<Header variant="h3">Study Information</Header>}>
                <KeyValuePairs
                  columns={1}
                  items={[
                    { label: 'Study Date', value: formatDate(selectedImageset.studyDate) },
                    { label: 'Study Time', value: selectedImageset.studyTime || 'N/A' },
                    { label: 'Study Description', value: selectedImageset.studyDescription || 'N/A' },
                    { label: 'Series Description', value: selectedImageset.seriesDescription || 'N/A' },
                    { label: 'Series Number', value: selectedImageset.seriesNumber || 'N/A' },
                    { label: 'Modality', value: selectedImageset.modality },
                    { label: 'Instance Count', value: selectedImageset.instanceCount.toLocaleString() },
                    { label: 'Storage Used', value: formatFileSize(selectedImageset.storageUsed) },
                  ]}
                />
              </Container>
            </ColumnLayout>

            {/* Technical Details */}
            {(selectedImageset.institutionName || selectedImageset.manufacturerModelName || 
              selectedImageset.bodyPartExamined || selectedImageset.pixelSpacing) && (
              <Container header={<Header variant="h3">Technical Details</Header>}>
                <ColumnLayout columns={2}>
                  <KeyValuePairs
                    columns={1}
                    items={[
                      { label: 'Institution', value: selectedImageset.institutionName || 'N/A' },
                      { label: 'Scanner Model', value: selectedImageset.manufacturerModelName || 'N/A' },
                      { label: 'Body Part', value: selectedImageset.bodyPartExamined || 'N/A' },
                      { label: 'View Position', value: selectedImageset.viewPosition || 'N/A' },
                    ]}
                  />
                  <KeyValuePairs
                    columns={1}
                    items={[
                      { 
                        label: 'Pixel Spacing', 
                        value: selectedImageset.pixelSpacing ? 
                          `${selectedImageset.pixelSpacing.join(' × ')} mm` : 'N/A' 
                      },
                      { 
                        label: 'Slice Thickness', 
                        value: selectedImageset.sliceThickness ? 
                          `${selectedImageset.sliceThickness} mm` : 'N/A' 
                      },
                      { 
                        label: 'TR', 
                        value: selectedImageset.repetitionTime ? 
                          `${selectedImageset.repetitionTime} ms` : 'N/A' 
                      },
                      { 
                        label: 'TE', 
                        value: selectedImageset.echoTime ? 
                          `${selectedImageset.echoTime} ms` : 'N/A' 
                      },
                    ]}
                  />
                </ColumnLayout>
              </Container>
            )}

            {/* Status Information */}
            <Container header={<Header variant="h3">Status Information</Header>}>
              <KeyValuePairs
                columns={2}
                items={[
                  { 
                    label: 'State', 
                    value: (
                      <StatusIndicator type={getStatusType(selectedImageset.imageSetState)}>
                        {selectedImageset.imageSetState}
                      </StatusIndicator>
                    )
                  },
                  { label: 'Workflow Status', value: selectedImageset.imageSetWorkflowStatus },
                ]}
              />
            </Container>
          </SpaceBetween>
        ) : (
          <Box>No details available</Box>
        )}
      </Modal>
    </SpaceBetween>
  );
};

export default ExceptionManagement;
