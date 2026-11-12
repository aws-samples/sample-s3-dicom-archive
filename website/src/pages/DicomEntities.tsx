import React, { useState, useEffect, useCallback } from 'react';
import { formatTimestampDate } from '../utils/dateUtils';
import {
  Header,
  SpaceBetween,
  Button,
  Table,
  Box,
  TextFilter,
  Pagination,
  CollectionPreferences,
  Modal,
  Alert,
  StatusIndicator,
  Badge,
  Flashbar,
  TableProps,
  FlashbarProps
} from '@cloudscape-design/components';
import { apiClient } from '../utils/apiClient';
import { DicomEntity, CreateDicomEntityRequest, UpdateDicomEntityRequest } from '../types/dicom';
import DicomEntityModal from '../components/DicomEntityModal';
import PrivilegeDisplay from '../components/PrivilegeDisplay';

// Types
interface DicomInterface {
  id: string;
  name: string;
  aeTitle: string;
  description?: string;
}

const DicomEntities: React.FC = () => {
  // State management
  const [entities, setEntities] = useState<DicomEntity[]>([]);
  const [interfaces, setInterfaces] = useState<DicomInterface[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<DicomEntity[]>([]);
  const [preferences, setPreferences] = useState({
    pageSize: 20,
    visibleContent: ['name', 'aeTitle', 'hostname', 'entityType', 'status', 'privileges', 'createdAt']
  });
  
  // Filtering and pagination
  const [filteringText, setFilteringText] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [nextToken, setNextToken] = useState<string | null>(null);
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [editingEntity, setEditingEntity] = useState<DicomEntity | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string>('');
  
  // Flash messages
  const [flashMessages, setFlashMessages] = useState<FlashbarProps.MessageDefinition[]>([]);

  // Table column definitions
  const columnDefinitions: TableProps.ColumnDefinition<DicomEntity>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: item => item.name,
      sortingField: 'name',
      isRowHeader: true
    },
    {
      id: 'aeTitle',
      header: 'AE Title',
      cell: item => <Badge color="blue">{item.aeTitle}</Badge>,
      sortingField: 'aeTitle'
    },
    {
      id: 'entityType',
      header: 'Type',
      cell: item => item.entityType,
      sortingField: 'entityType'
    },
    {
      id: 'status',
      header: 'Status',
      cell: item => (
        <StatusIndicator type={
          item.status === 'ACTIVE' ? 'success' :
          item.status === 'INACTIVE' ? 'stopped' : 'pending'
        }>
          {item.status}
        </StatusIndicator>
      ),
      sortingField: 'status'
    },
    {
      id: 'privileges',
      header: 'Privileges',
      cell: item => (
        <PrivilegeDisplay 
          privileges={item.dicomPrivileges || []} 
          interfaces={interfaces}
        />
      ),
      minWidth: 200
    },
    {
      id: 'hostname',
      header: 'Network',
      cell: item => {
        const host = item.host || item.hostname;
        return host ? `${host}${item.port ? `:${item.port}` : ''}` : '-';
      }
    },
    {
      id: 'description',
      header: 'Description',
      cell: item => (
        <div style={{
          maxWidth: '200px',
          wordWrap: 'break-word',
          whiteSpace: 'normal',
          lineHeight: '1.4'
        }}>
          {item.description || '-'}
        </div>
      ),
      width: 200
    },
    {
      id: 'createdAt',
      header: 'Created',
      cell: item => formatTimestampDate(item.createdAt),
      sortingField: 'createdAt'
    }
  ];

  // Load DICOM interfaces
  const loadInterfaces = useCallback(async () => {
    try {
      const response = await apiClient.get('/dicom-interfaces');
      if (response.success && response.data) {
        setInterfaces(response.data.items || []);
      }
    } catch (error) {
      console.error('Error loading DICOM interfaces:', error.message);
      // Don't show error message for interfaces as it's not critical
    }
  }, []);

  // Load DICOM entities
  const loadEntities = useCallback(async (token: string | null = null) => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        pageSize: preferences.pageSize.toString(),
        ...(token && { nextToken: token }),
        ...(filteringText && { search: filteringText })
      });

      const response = await apiClient.get(`/dicom-entities?${params}`);
      
      if (response.success) {
        setEntities(response.data.items);
        setTotalCount(response.data.totalCount);
        setNextToken(response.data.nextToken);
      } else {
        throw new Error(response.error?.message || 'Failed to load DICOM entities');
      }
    } catch (error: any) {
      console.error('Error loading DICOM entities:', error.message);
      addFlashMessage({
        type: 'error',
        content: `Failed to load DICOM entities: ${error.message}`,
        dismissible: true
      });
    } finally {
      setLoading(false);
    }
  }, [preferences.pageSize, filteringText]);

  // Initial load
  useEffect(() => {
    loadInterfaces();
    loadEntities();
  }, [loadInterfaces, loadEntities]);

  // Flash message helper
  const addFlashMessage = (message: Omit<FlashbarProps.MessageDefinition, 'id'>) => {
    const id = Date.now().toString();
    setFlashMessages(prev => [...prev, { ...message, id }]);
    if (message.dismissible) {
      setTimeout(() => {
        setFlashMessages(prev => prev.filter(msg => msg.id !== id));
      }, 5000);
    }
  };

  // Handle entity submission (create or update)
  const handleEntitySubmit = async (data: CreateDicomEntityRequest | UpdateDicomEntityRequest) => {
    setModalLoading(true);
    setModalError('');
    
    try {
      if (editingEntity) {
        // Update existing entity
        const response = await apiClient.put(`/dicom-entities/${editingEntity.id}`, data);
        if (response.success) {
          addFlashMessage({
            type: 'success',
            content: `DICOM entity "${data.name}" updated successfully`,
            dismissible: true
          });
          setShowEditModal(false);
          setEditingEntity(null);
          setSelectedItems([]);
          loadEntities();
        } else {
          if (response.error?.code === 'CONFLICT') {
            setModalError(response.error.message);
          } else {
            throw new Error(response.error?.message || 'Failed to update DICOM entity');
          }
        }
      } else {
        // Create new entity
        const response = await apiClient.post('/dicom-entities', data);
        if (response.success) {
          addFlashMessage({
            type: 'success',
            content: `DICOM entity "${data.name}" created successfully`,
            dismissible: true
          });
          setShowCreateModal(false);
          loadEntities();
        } else {
          if (response.error?.code === 'CONFLICT') {
            setModalError(response.error.message);
          } else {
            throw new Error(response.error?.message || 'Failed to create DICOM entity');
          }
        }
      }
    } catch (error: any) {
      console.error('Error submitting entity:', error.message);
      addFlashMessage({
        type: 'error',
        content: `Failed to ${editingEntity ? 'update' : 'create'} DICOM entity: ${error.message}`,
        dismissible: true
      });
    } finally {
      setModalLoading(false);
    }
  };

  // Handle create entity
  const handleCreate = () => {
    setEditingEntity(null);
    setModalError('');
    setShowCreateModal(true);
  };

  // Handle edit entity
  const handleEdit = async (entity: DicomEntity) => {
    setEditingEntity(entity);
    setModalError('');
    setShowEditModal(true);
  };

  // Handle delete entity
  const handleDelete = async () => {
    if (!selectedItems[0]) return;
    
    setModalLoading(true);
    try {
      const response = await apiClient.delete(`/dicom-entities/${selectedItems[0].id}`);
      
      if (response.success) {
        addFlashMessage({
          type: 'success',
          content: `DICOM entity "${selectedItems[0].name}" deleted successfully`,
          dismissible: true
        });
        setShowDeleteModal(false);
        setSelectedItems([]);
        loadEntities();
      } else {
        throw new Error(response.error?.message || 'Failed to delete DICOM entity');
      }
    } catch (error: any) {
      console.error('Error deleting DICOM entity:', error.message);
      addFlashMessage({
        type: 'error',
        content: `Failed to delete DICOM entity: ${error.message}`,
        dismissible: true
      });
    } finally {
      setModalLoading(false);
    }
  };

  return (
    <SpaceBetween size="l">
      {flashMessages.length > 0 && <Flashbar items={flashMessages} />}
      
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              iconName="refresh"
              onClick={() => loadEntities()}
              loading={loading}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              iconName="add-plus"
              onClick={handleCreate}
            >
              Create DICOM Entity
            </Button>
          </SpaceBetween>
        }
      >
        DICOM Entities
      </Header>
      
      <Table
              columnDefinitions={columnDefinitions}
              items={entities}
              loading={loading}
              loadingText="Loading DICOM entities..."
              selectedItems={selectedItems}
              onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
              selectionType="single"
                ariaLabels={{
                  selectionGroupLabel: "Items selection",
                  allItemsSelectionLabel: ({ selectedItems }) =>
                    `${selectedItems.length} ${selectedItems.length === 1 ? "item" : "items"} selected`,
                  itemSelectionLabel: ({ selectedItems }, item) => item.name
                }}
                header={
                  <Header
                    counter={`(${totalCount})`}
                    actions={
                      <SpaceBetween direction="horizontal" size="xs">
                        <Button
                          disabled={selectedItems.length !== 1}
                          onClick={() => handleEdit(selectedItems[0])}
                        >
                          Edit
                        </Button>
                        <Button
                          disabled={selectedItems.length !== 1}
                          onClick={() => setShowDeleteModal(true)}
                        >
                          Delete
                        </Button>
                      </SpaceBetween>
                    }
                  />
                }
                filter={
                  <TextFilter
                    filteringText={filteringText}
                    onChange={({ detail }) => setFilteringText(detail.filteringText)}
                    onDelayedChange={() => loadEntities()}
                    filteringPlaceholder="Search entities..."
                  />
                }
                pagination={
                  <Pagination
                    currentPageIndex={currentPageIndex}
                    onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
                    pagesCount={Math.ceil(totalCount / preferences.pageSize)}
                    ariaLabels={{
                      nextPageLabel: "Next page",
                      previousPageLabel: "Previous page",
                      pageLabel: pageNumber => `Page ${pageNumber} of all pages`
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
                      pageSize: detail.pageSize || 20,
                      visibleContent: [...(detail.visibleContent || ['name', 'aeTitle', 'entityType', 'status', 'privilegeCount', 'createdAt'])]
                    })}
                    pageSizePreference={{
                      title: "Page size",
                      options: [
                        { value: 10, label: "10 entities" },
                        { value: 20, label: "20 entities" },
                        { value: 50, label: "50 entities" }
                      ]
                    }}
                  />
                }
                empty={
                  <Box textAlign="center" color="inherit">
                    <b>No DICOM entities</b>
                    <Box padding={{ bottom: "s" }} variant="p" color="inherit">
                      No DICOM entities found.
                    </Box>
                    <Button
                      variant="primary"
                      iconName="add-plus"
                      onClick={handleCreate}
                    >
                    Create DICOM Entity
                  </Button>
                </Box>
              }
            />

            {/* Create Modal */}
            <DicomEntityModal
              visible={showCreateModal}
              onDismiss={() => setShowCreateModal(false)}
              onSubmit={handleEntitySubmit}
              loading={modalLoading}
              error={modalError}
            />

            {/* Edit Modal */}
            <DicomEntityModal
              visible={showEditModal}
              onDismiss={() => {
                setShowEditModal(false);
                setEditingEntity(null);
              }}
              onSubmit={handleEntitySubmit}
              entity={editingEntity}
              loading={modalLoading}
              error={modalError}
            />

            {/* Delete Modal */}
            <Modal
              visible={showDeleteModal}
              onDismiss={() => setShowDeleteModal(false)}
              header="Delete DICOM Entity"
              footer={
                <Box float="right">
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button
                      variant="link"
                      onClick={() => setShowDeleteModal(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleDelete}
                      loading={modalLoading}
                    >
                      Delete
                    </Button>
                  </SpaceBetween>
                </Box>
              }
            >
              <SpaceBetween size="m">
                <Box variant="span">
                  Are you sure you want to delete the DICOM entity <strong>{selectedItems[0]?.name}</strong>?
                </Box>
                <Alert type="warning">
                  This action cannot be undone. The entity will be permanently removed from the system.
                </Alert>
              </SpaceBetween>
            </Modal>
          </SpaceBetween>
  );
};

export default DicomEntities;
