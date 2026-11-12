import React, { useState, useEffect } from 'react';
import { formatTimestamp } from '../utils/dateUtils';
import {
  Container,
  Header,
  Table,
  Box,
  SpaceBetween,
  Button,
  Pagination,
  TextFilter,
  StatusIndicator,
  Modal,
  FormField,
  Input,
  Form,
  Textarea,
  Alert,
  Checkbox,
  ColumnLayout,
  RadioGroup
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { Datastore, CreateDatastoreRequest } from '../types';
import ImportDatastoreModal from './ImportDatastoreModal';

const DatastoreManagement: React.FC = () => {
  const [selectedItems, setSelectedItems] = useState<Datastore[]>([]);
  const [filterText, setFilterText] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [newDatastoreName, setNewDatastoreName] = useState('');
  const [newDatastoreDescription, setNewDatastoreDescription] = useState('');
  const [createAccessRoles, setCreateAccessRoles] = useState(true);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [deletionType, setDeletionType] = useState('DEREGISTER');
  const [datastores, setDatastores] = useState<Datastore[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  
  // Edit modal state
  const [editingDatastore, setEditingDatastore] = useState<Datastore | null>(null);
  const [editDatastoreName, setEditDatastoreName] = useState('');
  const [editDatastoreDescription, setEditDatastoreDescription] = useState('');

  const validateDatastoreName = (name: string): string | undefined => {
    if (name.trim() === '') return 'Name is required';
    
    if (name.length > 32) return 'Name must be 32 characters or less';
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return 'Name can only contain letters, numbers, dots, hyphens, and underscores';
    
    return undefined;
  };
  const [updating, setUpdating] = useState(false);

  // Details modal state
  const [selectedDatastoreForDetails, setSelectedDatastoreForDetails] = useState<Datastore | null>(null);

  // Sync modal state
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [syncDatastoreTarget, setSyncDatastoreTarget] = useState<Datastore | null>(null);
  const [syncMode, setSyncMode] = useState<'delta' | 'full'>('delta');
  const [syncPrefixesText, setSyncPrefixesText] = useState('');
  const [syncing, setSyncing] = useState(false);

  const loadDatastores = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.getDatastores({ page: 1, pageSize: 100 });
      
      if (response.success && response.data) {
        setDatastores(response.data.items || []);
      } else {
        setError('Failed to load datastores');
      }
    } catch (err) {
      setError('Failed to load datastores');
      console.error('Error loading datastores:', err);
    } finally {
      setLoading(false);
    }
  };

  // Load datastores on component mount
  useEffect(() => {
    loadDatastores();
  }, []);

  // Clear selections when filter changes
  useEffect(() => {
    setSelectedItems([]);
  }, [filterText]);

  // Check if any selected datastores are in DELETING status
  const hasDatastoresBeingDeleted = selectedItems.some(datastore => 
    (datastore.status as string).toLowerCase() === 'deleting'
  );

  // Filter datastores based on filter text
  const filteredDatastores = datastores.filter(
    datastore => datastore.name && datastore.name.toLowerCase().includes(filterText.toLowerCase())
  );

  const handleCreateDatastore = async () => {
    try {
      setSaving(true);
      setModalError(null);

      if (!newDatastoreName) {
        setModalError('Storage name is required');
        return;
      }

      // S3-only: every datastore is created as an S3 storage location.
      const createRequest: CreateDatastoreRequest = {
        name: newDatastoreName,
        description: newDatastoreDescription,
        createAccessRoles: createAccessRoles,
        storageType: 'S3' as const
      };

      const response = await apiClient.createDatastore(createRequest);

      if (response.success) {
        setShowCreateModal(false);
        resetCreateModal();
        await loadDatastores();
      } else {
        const errorMessage = (response as any).error?.message || 'Failed to create storage location';
        setModalError(errorMessage);
      }
    } catch (err: any) {
      const errorMessage = err?.response?.data?.error?.message || err?.message || 'Failed to create storage location';
      setModalError(errorMessage);
      console.error('Error:', err);
    } finally {
      setSaving(false);
    }
  };

  const resetCreateModal = () => {
    setNewDatastoreName('');
    setNewDatastoreDescription('');
    setCreateAccessRoles(true);
  };

  // Surface import-modal outcomes on this page: errors -> the error Alert,
  // success/warning -> the success/info notice line.
  const handleImportNotify = (type: 'success' | 'error' | 'warning', header: string, content?: string) => {
    const msg = content ? `${header}: ${content}` : header;
    if (type === 'error') {
      setError(msg);
      setSuccessNotice(null);
    } else {
      setSuccessNotice(msg);
      setError(null);
    }
  };

  const handleDeleteDatastores = async () => {
    if (selectedItems.length === 0) return;
    
    // Show confirmation modal
    setShowDeleteModal(true);
  };

  const confirmDeleteDatastores = async () => {
    if (selectedItems.length === 0) return;
    
    // Validate confirmation text
    const expectedText = selectedItems.length === 1 
      ? selectedItems[0].id 
      : `${selectedItems.length} storages`;
    
    if (deleteConfirmationText !== expectedText) {
      setError(`Please type "${expectedText}" to confirm deletion`);
      return;
    }

    try {
      setDeleting(true);
      setError(null);
      
      // Delete selected datastores
      for (const datastore of selectedItems) {
        console.log('Deleting datastore:', datastore.id, 'Type:', deletionType);
        const response = await apiClient.deleteDatastore(datastore.id, deletionType);
        
        if (!response.success) {
          const errorMessage = (response as any).error?.message || 'Failed to delete datastore';
          throw new Error(errorMessage);
        }
      }
      
      // Close modal and reset state
      setShowDeleteModal(false);
      setDeleteConfirmationText('');
      setDeletionType('DEREGISTER');
      setSelectedItems([]);
      
      // Reload datastores
      await loadDatastores();
      
      console.log('Datastores deleted successfully');
    } catch (err) {
      setError(`${err instanceof Error ? err.message : 'Unknown error'}`);
      console.error('Error deleting datastores:', err);
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setShowDeleteModal(false);
    setDeleteConfirmationText('');
    setDeletionType('DEREGISTER');
    setError(null);
  };

  // Edit datastore handlers
  const handleEditDatastore = () => {
    if (selectedItems.length !== 1) return;
    
    const datastore = selectedItems[0];
    setEditingDatastore(datastore);
    setEditDatastoreName(datastore.name);
    setEditDatastoreDescription(datastore.description || '');
    
    setShowEditModal(true);
  };

  const handleUpdateDatastore = async () => {
    if (!editingDatastore) return;
    
    try {
      setUpdating(true);
      setError(null);
      
      const updateRequest = {
        name: editDatastoreName,
        description: editDatastoreDescription
      };

      const response = await apiClient.updateDatastore(editingDatastore.id, updateRequest);
      
      if (response.success) {
        // Close the modal and reset form
        setShowEditModal(false);
        setEditingDatastore(null);
        setEditDatastoreName('');
        setEditDatastoreDescription('');
        setSelectedItems([]);
        
        // Reload datastores to show the updated data
        await loadDatastores();
      } else {
        const errorMessage = (response as any).error?.message || 'Failed to update datastore';
        setError(errorMessage);
      }
    } catch (err: any) {
      const errorMessage = err?.response?.data?.error?.message || err?.message || 'Failed to update datastore';
      setError(errorMessage);
      console.error('Error updating datastore:', err);
    } finally {
      setUpdating(false);
    }
  };

  const cancelEdit = () => {
    setShowEditModal(false);
    setEditingDatastore(null);
    setEditDatastoreName('');
    setEditDatastoreDescription('');
    setError(null);
  };

  // Details modal handlers
  const handleShowDetails = () => {
    if (selectedItems.length !== 1) return;
    
    setSelectedDatastoreForDetails(selectedItems[0]);
    setShowDetailsModal(true);
  };

  const handleCloseDetails = () => {
    setShowDetailsModal(false);
    setSelectedDatastoreForDetails(null);
  };

  // Sync handlers: re-index a datastore's bucket against the index. Opens a
  // modal to pick prefixes + mode, then POSTs /datastores/{id}/sync.
  const handleOpenSync = () => {
    if (selectedItems.length !== 1) return;
    setSyncDatastoreTarget(selectedItems[0]);
    setSyncMode('delta');
    setSyncPrefixesText('');
    setShowSyncModal(true);
  };

  const handleCloseSync = () => {
    setShowSyncModal(false);
    setSyncDatastoreTarget(null);
    setSyncPrefixesText('');
    setSyncMode('delta');
  };

  const handleSubmitSync = async () => {
    if (!syncDatastoreTarget) return;
    try {
      setSyncing(true);
      setError(null);
      // One prefix per non-empty line; empty list => whole bucket (backend
      // defaults to ['']).
      const prefixes = syncPrefixesText
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const response = await apiClient.syncDatastore(syncDatastoreTarget.id, {
        mode: syncMode,
        prefixes: prefixes.length > 0 ? prefixes : undefined
      });
      if (response.success && response.data) {
        setSuccessNotice(response.data.message || 'Sync started. Track progress in Imports.');
        handleCloseSync();
        setSelectedItems([]);
      } else {
        setError((response as any).error?.message || 'Failed to start sync');
      }
    } catch (err: any) {
      setError(err?.response?.data?.error?.message || err?.message || 'Failed to start sync');
      console.error('Error starting sync:', err);
    } finally {
      setSyncing(false);
    }
  };

  // Helper function to format bytes to human readable format
  const formatBytes = (bytes: number | undefined): string => {
    if (!bytes || bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Helper function to format date
  const formatDate = (dateString: string | undefined): string => {
    return formatTimestamp(dateString);
  };

  return (
    <SpaceBetween size="l">
      {error && (
        <Alert
          type="error"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}
      {successNotice && (
        <Alert
          type="info"
          dismissible
          onDismiss={() => setSuccessNotice(null)}
        >
          {successNotice}
        </Alert>
      )}
      
      <Header
        variant="h1"
        actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="normal"
                  onClick={() => {
                    setIsManualRefresh(true);
                    loadDatastores().finally(() => setIsManualRefresh(false));
                  }}
                  loading={isManualRefresh && loading}
                  iconName="refresh"
                >
                  Refresh
                </Button>
                <Button
                  variant="normal"
                  iconName="add-plus"
                  onClick={() => setShowImportModal(true)}
                >
                  Import S3 bucket
                </Button>
                <Button
                  variant="primary"
                  onClick={() => setShowCreateModal(true)}
                >
                  Create Storage
                </Button>
              </SpaceBetween>
          }
        >
          Storage
        </Header>
      {hasDatastoresBeingDeleted && (
        <Alert
          statusIconAriaLabel="Info"
          header="Storage deletion in progress"
        >
          One or more selected storage locations are currently being deleted. 
          The Delete button is disabled until the deletion process completes.
          </Alert>
        )}
        <Table
          header={
            <Header
              counter={`(${datastores.length})`}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    disabled={selectedItems.length !== 1}
                    onClick={handleShowDetails}
                  >
                    Details
                  </Button>
                  <Button
                    disabled={selectedItems.length !== 1}
                    onClick={handleEditDatastore}
                  >
                    Edit
                  </Button>
                  <Button
                    disabled={
                      selectedItems.length !== 1 ||
                      (selectedItems[0]?.status as string)?.toLowerCase() !== 'active'
                    }
                    iconName="refresh"
                    onClick={handleOpenSync}
                  >
                    Sync
                  </Button>
                  <Button
                    disabled={selectedItems.length === 0 || hasDatastoresBeingDeleted}
                    onClick={handleDeleteDatastores}
                  >
                    Delete
                  </Button>
                </SpaceBetween>
              }
            />
          }
          columnDefinitions={[
            {
              id: 'name',
              header: 'Name',
              cell: item => item.name,
              sortingField: 'name'
            },
            {
              id: 'description',
              header: 'Description',
              cell: item => item.description || '-'
            },
            {
              id: 'status',
              header: 'Status',
              cell: item => (
                <StatusIndicator
                  type={
                    (item.status as string).toLowerCase() === 'active' ? 'success' :
                    (item.status as string).toLowerCase() === 'syncing' ? 'in-progress' :
                    ['creating', 'deleting', 'pending'].includes((item.status as string).toLowerCase()) ? 'pending' :
                    ['error', 'create_failed'].includes((item.status as string).toLowerCase()) ? 'error' :
                    'info'
                  }
                >
                  {(item.status as string).toUpperCase()}
                </StatusIndicator>
              )
            },
            {
              id: 'studies',
              header: 'Studies',
              cell: item => (item.studyCount != null ? item.studyCount.toLocaleString() : '0'),
              sortingField: 'studyCount'
            },
            {
              id: 'series',
              header: 'Series',
              cell: item => (item.seriesCount != null ? item.seriesCount.toLocaleString() : '0'),
              sortingField: 'seriesCount'
            },

            {
              id: 'storage',
              header: 'Storage Used',
              cell: item => item.totalSizeBytes != null ? formatBytes(item.totalSizeBytes) : '0 B'
            },
            {
              id: 'createdDate',
              header: 'Created',
              cell: item => formatDate(item.createdAt),
              sortingField: 'createdAt'
            }
          ]}
          items={filteredDatastores}
          selectionType="multi"
          selectedItems={selectedItems}
          trackBy="id"
          onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems as Datastore[])}
          loading={loading}
          filter={
            <TextFilter
              filteringText={filterText}
              filteringPlaceholder="Find storage"
              filteringAriaLabel="Filter storage"
              onChange={({ detail }) => setFilterText(detail.filteringText)}
            />
          }
          pagination={
            <Pagination
              currentPageIndex={currentPageIndex}
              onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
              pagesCount={Math.ceil(filteredDatastores.length / 10)}
              ariaLabels={{
                nextPageLabel: 'Next page',
                previousPageLabel: 'Previous page',
                pageLabel: pageNumber => `Page ${pageNumber} of ${Math.ceil(filteredDatastores.length / 10)}`
              }}
            />
          }
          empty={
            <Box textAlign="center" color="inherit">
              <b>No storage</b>
              <Box padding={{ bottom: 's' }} variant="p" color="inherit">
              No storage locations to display.
            </Box>
            <Button onClick={() => setShowCreateModal(true)}>Create Storage</Button>
          </Box>
        }
      />

      {/* Create Datastore Modal */}
      <Modal
        visible={showCreateModal}
        onDismiss={() => {
          setShowCreateModal(false);
          resetCreateModal();
        }}
        header={<Header variant="h2">Create Storage</Header>}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => {
                setShowCreateModal(false);
                resetCreateModal();
              }}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleCreateDatastore}
                disabled={
                  !newDatastoreName ||
                  !!validateDatastoreName(newDatastoreName) ||
                  saving
                }
                loading={saving}
              >
                Create
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween direction="vertical" size="l">
            {modalError && (
              <Alert
                type="error"
                dismissible
                onDismiss={() => setModalError(null)}
              >
                {modalError}
              </Alert>
            )}
            
            <FormField
              label="Storage Name"
              description="Enter a name for the storage location (max 32 chars: A-Z, a-z, 0-9, ._-)"
              errorText={validateDatastoreName(newDatastoreName)}
            >
              <Input
                value={newDatastoreName}
                onChange={({ detail }) => setNewDatastoreName(detail.value)}
                placeholder="Enter storage name"
              />
            </FormField>

            <FormField
              label="Description"
              description="Enter a description for the storage location (optional)"
            >
              <Textarea
                value={newDatastoreDescription}
                onChange={({ detail }) => setNewDatastoreDescription(detail.value)}
              />
            </FormField>

            <FormField
              label="Access Roles"
              // S3-only: the creation workflow makes the read-only and store
              // privilege groups the DICOMweb service checks on every request.
              description="Automatically create privilege groups for read-only and store access"
            >
              <Checkbox
                checked={createAccessRoles}
                onChange={({ detail }) => setCreateAccessRoles(detail.checked)}
              >
                Create read-only and store privilege groups
              </Checkbox>
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>

      {/* Edit Datastore Modal */}
      <Modal
        visible={showEditModal}
        onDismiss={cancelEdit}
        header={<Header variant="h2">Edit Storage</Header>}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleUpdateDatastore}
                disabled={!editDatastoreName || !!validateDatastoreName(editDatastoreName) || updating}
                loading={updating}
              >
                Update
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween direction="vertical" size="l">
            <FormField
              label="Storage Name"
              description="Enter a name for the storage location"
              errorText={validateDatastoreName(editDatastoreName)}
            >
              <Input
                value={editDatastoreName}
                onChange={({ detail }) => setEditDatastoreName(detail.value)}
              />
            </FormField>

            <FormField
              label="Description"
              description="Enter a description for the storage location (optional)"
            >
              <Textarea
                value={editDatastoreDescription}
                onChange={({ detail }) => setEditDatastoreDescription(detail.value)}
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        onDismiss={cancelDelete}
        header={
          <Header variant="h2">
            Delete Storage{selectedItems.length > 1 ? 's' : ''}
          </Header>
        }
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={cancelDelete}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={confirmDeleteDatastores}
                disabled={
                  deleting || 
                  deleteConfirmationText !== (
                    selectedItems.length === 1 
                      ? selectedItems[0].id 
                      : `${selectedItems.length} storages`
                  )
                }
                loading={deleting}
              >
                {deleting ? (deletionType === 'DEREGISTER' ? 'Deregistering...' : 'Deleting...') : (deletionType === 'DEREGISTER' ? 'Deregister' : 'Delete All')}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          {error && (
            <Alert type="error" dismissible onDismiss={() => setError(null)}>
              {error}
            </Alert>
          )}
          
          <FormField
            label="Deletion Type"
            description="Choose how to handle this storage"
          >
            <RadioGroup
              value={deletionType}
              onChange={({ detail }) => setDeletionType(detail.value)}
              items={[
                {
                  value: 'DEREGISTER',
                  label: 'Only deregister the storage location',
                  description: 'Removes the storage location from this application but leaves the underlying S3 data intact.'
                },
                {
                  value: 'DELETE_ALL',
                  label: 'Delete the storage location and all its content',
                  description: 'Permanently deletes all DICOM data in S3 and the storage location itself. This action cannot be undone.'
                }
              ]}
            />
          </FormField>

          <Alert type={deletionType === 'DELETE_ALL' ? 'error' : 'warning'}>
            <strong>Warning:</strong> {deletionType === 'DEREGISTER' ? 'The following resources will be affected:' : 'This action cannot be undone. The following resources will be permanently deleted:'}
            <ul>
              <li>Database entry will be {deletionType === 'DEREGISTER' ? 'marked as deleted' : 'removed'}</li>
              {deletionType === 'DELETE_ALL' && <li><strong>All DICOM data in S3 will be permanently deleted</strong></li>}
              {deletionType === 'DEREGISTER' && <li>Underlying S3 data will remain intact (not deleted)</li>}
            </ul>
          </Alert>

          {selectedItems.length === 1 ? (
            <Container>
              <SpaceBetween direction="vertical" size="s">
                <Box>
                  <strong>Storage to be {deletionType === 'DEREGISTER' ? 'deregistered' : 'deleted'}:</strong>
                </Box>
                <Box>
                  <strong>Name:</strong> {selectedItems[0].name}
                </Box>
                <Box>
                  <strong>ID:</strong> {selectedItems[0].id}
                </Box>
                <Box>
                  <strong>Studies:</strong> {selectedItems[0].studyCount?.toLocaleString() || '0'}
                </Box>
                <Box>
                  <strong>Storage:</strong> {selectedItems[0].storage}
                </Box>
              </SpaceBetween>
            </Container>
          ) : (
            <Container>
              <SpaceBetween direction="vertical" size="s">
                <Box>
                  <strong>{selectedItems.length} storages will be {deletionType === 'DEREGISTER' ? 'deregistered' : 'deleted'}:</strong>
                </Box>
                {selectedItems.map((datastore, index) => (
                  <Box key={datastore.id}>
                    {index + 1}. {datastore.name} (ID: {datastore.id})
                  </Box>
                ))}
              </SpaceBetween>
            </Container>
          )}

          <FormField
            label={`Type "${selectedItems.length === 1 ? selectedItems[0].id : `${selectedItems.length} storages`}" to confirm`}
            description="This confirmation is required to prevent accidental deletions"
            errorText={
              deleteConfirmationText && 
              deleteConfirmationText !== (selectedItems.length === 1 ? selectedItems[0].id : `${selectedItems.length} storages`)
                ? `Please type exactly: ${selectedItems.length === 1 ? selectedItems[0].id : `${selectedItems.length} storages`}`
                : undefined
            }
          >
            <Input
              value={deleteConfirmationText}
              onChange={({ detail }) => setDeleteConfirmationText(detail.value)}
              placeholder={selectedItems.length === 1 ? selectedItems[0].id : `${selectedItems.length} storages`}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Datastore Details Modal */}
      <Modal
        visible={showDetailsModal}
        onDismiss={handleCloseDetails}
        size="large"
        header={
          <Header variant="h2">
            Storage Details: {selectedDatastoreForDetails?.name}
          </Header>
        }
        footer={
          <Box float="right">
            <Button variant="primary" onClick={handleCloseDetails}>
              Close
            </Button>
          </Box>
        }
      >
        {selectedDatastoreForDetails && (
          <ColumnLayout columns={2} variant="text-grid">
            <SpaceBetween size="xs">
              <div><strong>ID:</strong> {selectedDatastoreForDetails.id}</div>
              <div><strong>Name:</strong> {selectedDatastoreForDetails.name}</div>
              <div><strong>Description:</strong> {selectedDatastoreForDetails.description || 'No description'}</div>
              <div>
                <strong>Status:</strong>{' '}
                <StatusIndicator
                  type={
                    (selectedDatastoreForDetails.status as string).toLowerCase() === 'active' ? 'success' :
                    (selectedDatastoreForDetails.status as string).toLowerCase() === 'syncing' ? 'in-progress' :
                    ['creating', 'deleting', 'pending'].includes((selectedDatastoreForDetails.status as string).toLowerCase()) ? 'pending' :
                    (selectedDatastoreForDetails.status as string).toLowerCase() === 'error' ? 'error' :
                    'info'
                  }
                >
                  {(selectedDatastoreForDetails.status as string).toUpperCase()}
                </StatusIndicator>
              </div>
              <div><strong>Created:</strong> {formatDate(selectedDatastoreForDetails.createdAt || selectedDatastoreForDetails.createdDate)}</div>
              <div><strong>Studies:</strong> {selectedDatastoreForDetails.studyCount?.toLocaleString() || '0'}</div>
              <div><strong>Series:</strong> {selectedDatastoreForDetails.seriesCount?.toLocaleString() || '0'}</div>
              <div><strong>Instances:</strong> {selectedDatastoreForDetails.instanceCount?.toLocaleString() || '0'}</div>
              <div><strong>Storage:</strong> {selectedDatastoreForDetails.totalSizeBytes != null ? formatBytes(selectedDatastoreForDetails.totalSizeBytes) : (selectedDatastoreForDetails.storage || '0 B')}</div>
              <div><strong>Storage Type:</strong> S3</div>
              <div><strong>Lossless Format:</strong> Native (stored as received)</div>
            </SpaceBetween>
            <SpaceBetween size="xs">
              {/* S3-only: a datastore is addressed by its S3 bucket / prefix. */}
              <div>
                <strong>S3 Bucket:</strong>
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    iconName="copy"
                    variant="inline-icon"
                    onClick={() => navigator.clipboard.writeText(selectedDatastoreForDetails.s3BucketName || '')}
                  />
                  <Box variant="code">{selectedDatastoreForDetails.s3BucketName || 'N/A'}</Box>
                </SpaceBetween>
              </div>
              <div><strong>S3 Prefix:</strong> {selectedDatastoreForDetails.s3Prefix || '(bucket root)'}</div>
              {(selectedDatastoreForDetails.read_only_role_arn || selectedDatastoreForDetails.readOnlyRoleArn) && (
                <div>
                  <strong>Read-Only Role ARN:</strong>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      iconName="copy"
                      variant="inline-icon"
                      onClick={() => navigator.clipboard.writeText(selectedDatastoreForDetails.read_only_role_arn || selectedDatastoreForDetails.readOnlyRoleArn || '')}
                    />
                    <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '12px' }}>
                      {selectedDatastoreForDetails.read_only_role_arn || selectedDatastoreForDetails.readOnlyRoleArn}
                    </div>
                  </SpaceBetween>
                </div>
              )}
              {(selectedDatastoreForDetails.store_role_arn || selectedDatastoreForDetails.storeRoleArn) && (
                <div>
                  <strong>Store Role ARN:</strong>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      iconName="copy"
                      variant="inline-icon"
                      onClick={() => navigator.clipboard.writeText(selectedDatastoreForDetails.store_role_arn || selectedDatastoreForDetails.storeRoleArn || '')}
                    />
                    <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '12px' }}>
                      {selectedDatastoreForDetails.store_role_arn || selectedDatastoreForDetails.storeRoleArn}
                    </div>
                  </SpaceBetween>
                </div>
              )}
              {selectedDatastoreForDetails.kmsKeyId && (
                <div><strong>KMS Key ID:</strong> {selectedDatastoreForDetails.kmsKeyId}</div>
              )}
            </SpaceBetween>
          </ColumnLayout>
        )}
      </Modal>

      {/* Sync / re-index modal */}
      <Modal
        visible={showSyncModal}
        onDismiss={handleCloseSync}
        header={<Header variant="h2">Sync storage with index</Header>}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={handleCloseSync}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSubmitSync}
                loading={syncing}
                disabled={syncing}
              >
                Start sync
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Form>
          <SpaceBetween direction="vertical" size="l">
            <Box variant="p">
              Re-scan{' '}
              <strong>{syncDatastoreTarget?.name}</strong>
              {syncDatastoreTarget?.s3BucketName ? (
                <>
                  {' '}(<Box variant="code" display="inline">{syncDatastoreTarget.s3BucketName}</Box>)
                </>
              ) : null}{' '}
              and re-index its S3 objects. Progress is tracked in the Imports view.
            </Box>

            <FormField
              label="Mode"
              description="How to handle objects that are already indexed."
            >
              <RadioGroup
                value={syncMode}
                onChange={({ detail }) => setSyncMode(detail.value as 'delta' | 'full')}
                items={[
                  {
                    value: 'delta',
                    label: 'Sync new & changed (recommended)',
                    description: 'Skips objects already indexed and unchanged (same S3 ETag). Only new or modified objects are re-ingested.'
                  },
                  {
                    value: 'full',
                    label: 'Force full re-index',
                    description: 'Re-ingests every object regardless of whether it is already indexed. Safe (idempotent) but does redundant work.'
                  }
                ]}
              />
            </FormField>

            <FormField
              label="Prefixes (optional)"
              description="One key prefix per line to limit the scan (e.g. a study/series subtree). Leave empty to scan the whole bucket. Multiple prefixes run in parallel, each as its own import job."
            >
              <Textarea
                value={syncPrefixesText}
                onChange={({ detail }) => setSyncPrefixesText(detail.value)}
                placeholder={'incoming/\narchive/2024/'}
                rows={3}
              />
            </FormField>

            <Alert type="warning">
              A large bucket can enqueue many messages and take a while to fully
              index. Force full re-index re-ingests every object.
            </Alert>
          </SpaceBetween>
        </Form>
      </Modal>

      {/* Import existing S3 bucket (v2) — the primary home for the import flow. */}
      <ImportDatastoreModal
        visible={showImportModal}
        onDismiss={() => setShowImportModal(false)}
        onSuccess={loadDatastores}
        onNotify={handleImportNotify}
      />
    </SpaceBetween>
  );
};

export default DatastoreManagement;
