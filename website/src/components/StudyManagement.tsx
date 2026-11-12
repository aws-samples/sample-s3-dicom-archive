/**
 * StudyManagement Component - DICOM Browser
 *
 * PHI notice: this component collects and displays patient identifiers (PHI).
 * Deployers are responsible for HIPAA (and, where applicable, GDPR) controls
 * under the AWS shared responsibility model; use only synthetic data for
 * testing. See PHI-HANDLING.md.
 *
 * S3-only build: every datastore is S3-backed. This component browses DICOM
 * studies through the studies service / DICOMweb QIDO-RS, addressing each
 * storage location by its internal datastore id.
 */

import React, { useState, useEffect } from 'react';
import { getModalityOptions } from '../constants/dicomModalities';
import { ModalityBadges } from './ModalityBadge';
import {
  Container,
  Header,
  Table,
  Button,
  SpaceBetween,
  Box,
  TextFilter,
  Pagination,
  CollectionPreferences,
  StatusIndicator,
  Badge,
  Modal,
  Alert,
  FormField,
  Select,
  Input,
  DatePicker,
  Flashbar,
  FlashbarProps,
  Link,
  ColumnLayout,
  KeyValuePairs
} from '@cloudscape-design/components';
import { studiesService, Study, StudyFilters } from '../services/studiesService';
import { datastoreService } from '../services';

const StudyManagement: React.FC = () => {
  const [studies, setStudies] = useState<Study[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedStudies, setSelectedStudies] = useState<Study[]>([]);
  const [filteringText, setFilteringText] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [totalCount, setTotalCount] = useState(0);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [hasNextPage, setHasNextPage] = useState(false);
  const [notifications, setNotifications] = useState<FlashbarProps.MessageDefinition[]>([]);
  
  // Filters
  const [filters, setFilters] = useState<StudyFilters>({});
  const [datastores, setDatastores] = useState<any[]>([]);
  
  // Modals
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showStudyDetails, setShowStudyDetails] = useState(false);
  const [selectedStudy, setSelectedStudy] = useState<Study | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Table preferences
  const [preferences, setPreferences] = useState({
    pageSize: 25,
    visibleContent: ['patientName', 'patientId', 'studyDate', 'modalities', 'seriesCount', 'datastoreName', 'status'],
    wrapLines: false,
  });

  const columnDefinitions = [
    {
      id: 'patientName',
      header: 'Patient Name',
      cell: (study: Study) => (
        <Link onFollow={() => handleViewStudy(study)}>
          {study.patientName || 'Unknown'}
        </Link>
      ),
      sortingField: 'patientName',
      isRowHeader: true,
    },
    {
      id: 'patientId',
      header: 'Patient ID',
      cell: (study: Study) => study.patientId || '-',
      sortingField: 'patientId',
    },
    {
      id: 'studyDate',
      header: 'Study Date',
      cell: (study: Study) => {
        if (!study.studyDate) return '-';
        const date = new Date(study.studyDate);
        return date.toLocaleDateString();
      },
      sortingField: 'studyDate',
    },
    {
      id: 'studyDescription',
      header: 'Description',
      cell: (study: Study) => study.studyDescription || '-',
      sortingField: 'studyDescription',
    },
    {
      id: 'modalities',
      header: 'Modalities',
      cell: (study: Study) => (
        <ModalityBadges modalities={study.modalities} />
      ),
    },
    {
      id: 'seriesCount',
      header: 'Series',
      cell: (study: Study) => study.seriesCount.toString(),
      sortingField: 'seriesCount',
    },
    {
      id: 'instanceCount',
      header: 'Instances',
      cell: (study: Study) => study.instanceCount.toString(),
      sortingField: 'instanceCount',
    },
    {
      id: 'datastoreName',
      header: 'Storage',
      cell: (study: Study) => study.datastoreName,
      sortingField: 'datastoreName',
    },
    {
      id: 'sizeInBytes',
      header: 'Size',
      cell: (study: Study) => formatBytes(study.sizeInBytes),
      sortingField: 'sizeInBytes',
    },
    {
      id: 'status',
      header: 'Status',
      cell: (study: Study) => (
        <StatusIndicator type={getStatusType(study.status)}>
          {study.status}
        </StatusIndicator>
      ),
      sortingField: 'status',
    },
  ];

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusType = (status: string) => {
    switch (status) {
      case 'AVAILABLE': return 'success';
      case 'DELETING': return 'in-progress';
      case 'ERROR': return 'error';
      case 'DELETED': return 'stopped';
      default: return 'info';
    }
  };

  const loadStudies = async (resetPagination = false) => {
    try {
      setLoading(true);
      
      // Check if a datastore is selected
      if (!filters.datastoreId) {
        addNotification({
          type: 'warning',
          header: 'Storage Required',
          content: 'Please select a storage location to browse studies.',
          dismissible: true,
        });
        setStudies([]);
        setTotalCount(0);
        return;
      }

      console.log('🔍 Loading studies for datastore:', filters.datastoreId);
      
      // For now, use the API Gateway approach until Identity Pool is configured
      console.log('📡 Using API Gateway endpoint (temporary approach)');
      
      const token = resetPagination ? undefined : nextToken;
      const response = await studiesService.listStudies(filters, pageSize, token);
      
      setStudies(response.items);
      setTotalCount(response.totalCount);
      setNextToken(response.nextToken);
      setHasNextPage(response.hasNextPage);
      
      if (resetPagination) {
        setCurrentPageIndex(1);
      }

      console.log(`✅ Loaded ${response.items.length} studies via API Gateway`);
      
      // Show informational message about the current approach
      if (response.items.length > 0) {
        addNotification({
          type: 'info',
          header: 'Studies Loaded',
          content: `Successfully loaded ${response.items.length} studies. Note: Direct DICOMweb API access will be available once the Cognito Identity Pool is configured.`,
          dismissible: true,
        });
      }
      
    } catch (error) {
      console.error('❌ Error loading studies:', { errorType: error.name });
      addNotification({
        type: 'error',
        header: 'Error loading studies',
        content: error instanceof Error ? error.message : 'Unknown error occurred',
        dismissible: true,
      });
      setStudies([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  };

  const loadDatastores = async () => {
    try {
      const response = await datastoreService.getAll();
      setDatastores(response.items);
    } catch (error) {
      console.error('Error loading datastores:', { errorType: error.name });
    }
  };

  useEffect(() => {
    loadStudies(true);
    loadDatastores();
  }, [filters, pageSize]);

  const addNotification = (notification: FlashbarProps.MessageDefinition) => {
    setNotifications(prev => [...prev, { ...notification, id: Date.now().toString() }]);
  };

  const handleViewStudy = (study: Study) => {
    setSelectedStudy(study);
    setShowStudyDetails(true);
  };

  const handleDeleteStudy = async () => {
    if (!selectedStudy) return;

    try {
      setDeleteLoading(true);
      await studiesService.deleteStudy(selectedStudy.id);
      
      addNotification({
        type: 'success',
        header: 'Study deletion initiated',
        content: `Study "${selectedStudy.patientName}" is being deleted. This may take a few minutes.`,
        dismissible: true,
      });
      
      setShowDeleteModal(false);
      setSelectedStudy(null);
      loadStudies(true);
    } catch (error) {
      console.error('Error deleting study:', { errorType: error.name });
      addNotification({
        type: 'error',
        header: 'Error deleting study',
        content: error instanceof Error ? error.message : 'Unknown error occurred',
        dismissible: true,
      });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedStudies.length === 0) return;

    try {
      setDeleteLoading(true);
      const deletePromises = selectedStudies.map(study => 
        studiesService.deleteStudy(study.id)
      );
      
      await Promise.all(deletePromises);
      
      addNotification({
        type: 'success',
        header: 'Bulk deletion initiated',
        content: `${selectedStudies.length} studies are being deleted. This may take a few minutes.`,
        dismissible: true,
      });
      
      setSelectedStudies([]);
      loadStudies(true);
    } catch (error) {
      console.error('Error deleting studies:', { errorType: error.name });
      addNotification({
        type: 'error',
        header: 'Error deleting studies',
        content: error instanceof Error ? error.message : 'Unknown error occurred',
        dismissible: true,
      });
    } finally {
      setDeleteLoading(false);
    }
  };

  const filteredStudies = studies.filter(study =>
    study.patientName?.toLowerCase().includes(filteringText.toLowerCase()) ||
    study.patientId?.toLowerCase().includes(filteringText.toLowerCase()) ||
    study.studyDescription?.toLowerCase().includes(filteringText.toLowerCase())
  );

  return (
    <Container
      header={
        <Header
          variant="h1"
          description="Manage DICOM studies stored in your storage locations"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button
                disabled={selectedStudies.length === 0}
                onClick={handleBulkDelete}
                loading={deleteLoading}
              >
                Delete Selected ({selectedStudies.length})
              </Button>
              <Button
                iconName="refresh"
                onClick={() => loadStudies(true)}
                loading={loading}
              >
                Refresh
              </Button>
            </SpaceBetween>
          }
        >
          Study Management
        </Header>
      }
    >
      <SpaceBetween direction="vertical" size="l">
        <Flashbar items={notifications} />
        
        {/* Filters */}
        <Container header={<Header variant="h2">Filters</Header>}>
          <ColumnLayout columns={4}>
            <FormField label="Storage">
              <Select
                selectedOption={
                  filters.datastoreId 
                    ? { label: datastores.find(d => d.id === filters.datastoreId)?.name || filters.datastoreId, value: filters.datastoreId }
                    : null
                }
                onChange={({ detail }) => 
                  setFilters(prev => ({ ...prev, datastoreId: detail.selectedOption?.value }))
                }
                options={[
                  { label: 'All Storage', value: '' },
                  ...datastores.map(ds => ({ label: ds.name, value: ds.id }))
                ]}
                placeholder="Select storage"
              />
            </FormField>
            
            <FormField label="Patient ID">
              <Input
                value={filters.patientId || ''}
                onChange={({ detail }) => 
                  setFilters(prev => ({ ...prev, patientId: detail.value }))
                }
                placeholder="Enter patient ID"
              />
            </FormField>
            
            <FormField label="Study Date">
              <DatePicker
                value={filters.studyDate || ''}
                onChange={({ detail }) => 
                  setFilters(prev => ({ ...prev, studyDate: detail.value }))
                }
                placeholder="YYYY-MM-DD"
              />
            </FormField>
            
            <FormField label="Modality">
              <Select
                selectedOption={
                  filters.modality 
                    ? { label: filters.modality, value: filters.modality }
                    : null
                }
                onChange={({ detail }) => 
                  setFilters(prev => ({ ...prev, modality: detail.selectedOption?.value }))
                }
                options={getModalityOptions()}
                placeholder="Select modality"
              />
            </FormField>
          </ColumnLayout>
        </Container>

        {/* Studies Table */}
        <Table
          columnDefinitions={columnDefinitions}
          items={filteredStudies}
          loading={loading}
          loadingText="Loading studies..."
          selectedItems={selectedStudies}
          onSelectionChange={({ detail }) => setSelectedStudies(detail.selectedItems)}
          selectionType="multi"
          ariaLabels={{
            selectionGroupLabel: "Items selection",
            allItemsSelectionLabel: ({ selectedItems }) =>
              `${selectedItems.length} ${selectedItems.length === 1 ? "item" : "items"} selected`,
            itemSelectionLabel: ({ selectedItems }, item) => {
              const isItemSelected = selectedItems.filter(i => i.id === item.id).length;
              return `${item.patientName} is ${isItemSelected ? "" : "not"} selected`;
            }
          }}
          columnDisplay={preferences.visibleContent.map(id => ({ id, visible: true }))}
          wrapLines={preferences.wrapLines}
          stripedRows
          contentDensity="compact"
          stickyHeader
          filter={
            <TextFilter
              filteringText={filteringText}
              onChange={({ detail }) => setFilteringText(detail.filteringText)}
              countText={`${filteredStudies.length} matches`}
              filteringAriaLabel="Filter studies"
              filteringPlaceholder="Search studies..."
            />
          }
          pagination={
            <Pagination
              currentPageIndex={currentPageIndex}
              onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
              pagesCount={Math.ceil(totalCount / pageSize)}
              ariaLabels={{
                nextPageLabel: "Next page",
                previousPageLabel: "Previous page",
                pageLabel: (pageNumber) => `Page ${pageNumber} of all pages`
              }}
            />
          }
          preferences={
            <CollectionPreferences
              title="Preferences"
              confirmLabel="Confirm"
              cancelLabel="Cancel"
              preferences={preferences}
              onConfirm={({ detail }) => setPreferences({
                pageSize: detail.pageSize || 25,
                visibleContent: [...(detail.visibleContent || ['patientName', 'patientId', 'studyDate', 'modalities', 'seriesCount', 'datastoreName', 'status'])],
                wrapLines: detail.wrapLines || false
              })}
              pageSizePreference={{
                title: "Page size",
                options: [
                  { value: 10, label: "10 studies" },
                  { value: 25, label: "25 studies" },
                  { value: 50, label: "50 studies" },
                  { value: 100, label: "100 studies" }
                ]
              }}
              wrapLinesPreference={{
                label: "Wrap lines",
                description: "Check to see all the text and wrap the lines"
              }}
            />
          }
          empty={
            <Box textAlign="center" color="inherit">
              <b>No studies found</b>
              <Box padding={{ bottom: "s" }} variant="p" color="inherit">
                No studies match the current filter criteria.
              </Box>
            </Box>
          }
        />

        {/* Delete Confirmation Modal */}
        <Modal
          onDismiss={() => setShowDeleteModal(false)}
          visible={showDeleteModal}
          closeAriaLabel="Close modal"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowDeleteModal(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleDeleteStudy}
                  loading={deleteLoading}
                >
                  Delete Study
                </Button>
              </SpaceBetween>
            </Box>
          }
          header="Delete Study"
        >
          <Alert type="warning" statusIconAriaLabel="Warning">
            <Box>
              <strong>This action cannot be undone.</strong>
            </Box>
            <Box>
              Are you sure you want to delete the study "{selectedStudy?.patientName}" 
              (Patient ID: {selectedStudy?.patientId})? This will permanently remove all 
              DICOM data associated with this study.
            </Box>
          </Alert>
        </Modal>

        {/* Study Details Modal */}
        <Modal
          onDismiss={() => setShowStudyDetails(false)}
          visible={showStudyDetails}
          closeAriaLabel="Close modal"
          size="large"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowStudyDetails(false)}>
                  Close
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setShowStudyDetails(false);
                    setShowDeleteModal(true);
                  }}
                >
                  Delete Study
                </Button>
              </SpaceBetween>
            </Box>
          }
          header={`Study Details - ${selectedStudy?.patientName}`}
        >
          {selectedStudy && (
            <SpaceBetween direction="vertical" size="l">
              <ColumnLayout columns={2}>
                <KeyValuePairs
                  columns={1}
                  items={[
                    { label: 'Patient Name', value: selectedStudy.patientName || '-' },
                    { label: 'Patient ID', value: selectedStudy.patientId || '-' },
                    { label: 'Patient Birth Date', value: selectedStudy.patientBirthDate || '-' },
                    { label: 'Patient Sex', value: selectedStudy.patientSex || '-' },
                  ]}
                />
                <KeyValuePairs
                  columns={1}
                  items={[
                    { label: 'Study Date', value: selectedStudy.studyDate ? new Date(selectedStudy.studyDate).toLocaleDateString() : '-' },
                    { label: 'Study Time', value: selectedStudy.studyTime || '-' },
                    { label: 'Study Description', value: selectedStudy.studyDescription || '-' },
                    { label: 'Accession Number', value: selectedStudy.accessionNumber || '-' },
                  ]}
                />
              </ColumnLayout>
              
              <KeyValuePairs
                columns={3}
                items={[
                  { label: 'Study Instance UID', value: selectedStudy.studyInstanceUID },
                  { label: 'Series Count', value: selectedStudy.seriesCount.toString() },
                  { label: 'Instance Count', value: selectedStudy.instanceCount.toString() },
                  { label: 'Size', value: formatBytes(selectedStudy.sizeInBytes) },
                  { label: 'Storage', value: selectedStudy.datastoreName },
                  { label: 'Status', value: selectedStudy.status },
                ]}
              />
              
              <Box>
                <Header variant="h3">Modalities</Header>
                <ModalityBadges modalities={selectedStudy.modalities} />
              </Box>
            </SpaceBetween>
          )}
        </Modal>
      </SpaceBetween>
    </Container>
  );
};

export default StudyManagement;
