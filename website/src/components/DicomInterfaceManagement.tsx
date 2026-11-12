import React, { useState, useEffect } from 'react';
import { formatTimestampDate } from '../utils/dateUtils';
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
  Multiselect,
  Select,
  Spinner,
  Checkbox
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { DicomInterface, CreateDicomInterfaceRequest } from '../types';

const DicomInterfaceManagement: React.FC = () => {
  const [selectedItems, setSelectedItems] = useState<DicomInterface[]>([]);
  const [filterText, setFilterText] = useState('');
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedInterface, setSelectedInterface] = useState<DicomInterface | null>(null);
  
  // Form state
  const [newInterfaceName, setNewInterfaceName] = useState('');
  const [newInterfaceDescription, setNewInterfaceDescription] = useState('');
  const [newInterfaceAeTitle, setNewInterfaceAeTitle] = useState('');
  const [newInterfaceServiceType, setNewInterfaceServiceType] = useState<any>({ label: 'SCP & SCU', value: 'SCP_SCU' });
  const [newInterfaceProtocol, setNewInterfaceProtocol] = useState<any>({ label: 'DIMSE', value: 'DIMSE' });
  const [newInterfaceLogLevel, setNewInterfaceLogLevel] = useState<any>({ label: 'INFO', value: 'INFO' });
  const [newInterfaceThreadCount, setNewInterfaceThreadCount] = useState('4');
  const [newInterfaceStorageThrottle, setNewInterfaceStorageThrottle] = useState('1000');
  const [newInterfaceS3TransferAcceleration, setNewInterfaceS3TransferAcceleration] = useState(false);
  const [newInterfaceLocation, setNewInterfaceLocation] = useState<any>(null);
  
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [interfaces, setInterfaces] = useState<DicomInterface[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [datastores, setDatastores] = useState<any[]>([]);
  const [selectedDatastores, setSelectedDatastores] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [createDefaultRule, setCreateDefaultRule] = useState(false);
  const [deleteImpact, setDeleteImpact] = useState<{ routingRules: any[], dicomEntities: any[] }>({ routingRules: [], dicomEntities: [] });
  const [loadingImpact, setLoadingImpact] = useState(false);

  const loadInterfaces = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiClient.getDicomInterfaces({ page: 1, pageSize: 100 });
      
      if (response.success && response.data) {
        setInterfaces(response.data.items || []);
      } else {
        setError('Failed to load DICOM interfaces');
      }
    } catch (err) {
      console.error('Error loading DICOM interfaces:', { errorType: err.name });
      setError('Failed to load DICOM interfaces');
    } finally {
      setLoading(false);
    }
  };

  // Load interfaces on component mount
  useEffect(() => {
    loadInterfaces();
    loadLocations();
    loadDatastores();
  }, []);

  // Clear selections when filter changes
  useEffect(() => {
    setSelectedItems([]);
  }, [filterText]);

  // Clear selections on manual refresh (keep only items still in list)
  useEffect(() => {
    setSelectedItems(prev => 
      prev.filter(selected => 
        interfaces.some(item => item.id === selected.id)
      )
    );
  }, [interfaces]);

  // Auto-check default rule when exactly 1 datastore selected
  useEffect(() => {
    setCreateDefaultRule(selectedDatastores.length === 1);
  }, [selectedDatastores]);

  const loadDatastores = async () => {
    try {
      const response = await apiClient.getDatastores({ page: 1, pageSize: 100 });
      if (response.success && response.data) {
        setDatastores(response.data.items || []);
      }
    } catch (err) {
      console.error('Error loading datastores:', err);
    }
  };

  const loadLocations = async () => {
    try {
      const response = await apiClient.getLocations();
      if (response.success && response.data) {
        setLocations((response.data as any).items || response.data || []);
      }
    } catch (err) {
      console.error('Error loading locations:', err);
    }
  };

  const handleCreateInterface = async () => {
    try {
      setSaving(true);
      setModalError(null);
      
      if (selectedInterface) {
        // Update existing interface
        const updateRequest = {
          name: newInterfaceName,
          description: newInterfaceDescription,
          aeTitle: newInterfaceAeTitle,
          locationId: newInterfaceLocation?.value,
          accessibleDatastores: selectedDatastores.map(ds => ds.value)
        };

        const response = await apiClient.updateDicomInterface(selectedInterface.id, updateRequest);
        
        if (response.success) {
          setShowCreateModal(false);
          setSelectedInterface(null);
          setSelectedItems([]);
          resetCreateForm();
          await loadInterfaces();
        } else {
          setModalError('Failed to update DICOM interface');
        }
      } else {
        // Create new interface
        const request: CreateDicomInterfaceRequest = {
          name: newInterfaceName,
          description: newInterfaceDescription,
          aeTitle: newInterfaceAeTitle,
          serviceType: newInterfaceServiceType.value as 'SCP' | 'SCU',
          protocol: newInterfaceProtocol.value as 'DIMSE',
          locationId: newInterfaceLocation?.value,
          accessibleDatastores: selectedDatastores.map(ds => ds.value),
          configuration: {
            logLevel: newInterfaceLogLevel.value,
            threadCount: parseInt(newInterfaceThreadCount),
            storageThrottle: parseInt(newInterfaceStorageThrottle),
            storageOor: 100,
            s3TransferAcceleration: newInterfaceS3TransferAcceleration
          },
          sopClasses: ['*'], // Accept all SOP classes by default
          transferSyntaxes: ['*'] // Accept all transfer syntaxes by default
        };

        const response = await apiClient.createDicomInterface(request);
        
        if (response.success) {
          const interfaceId = response.data?.id;
          if (createDefaultRule && selectedDatastores.length === 1 && interfaceId) {
            try {
              await apiClient.createRoutingRule({
                interfaceId,
                name: 'Route ALL',
                ruleType: 'DESTINATION',
                conditions: {},
                action: { datastoreId: selectedDatastores[0].value },
                enabled: true
              });
            } catch (ruleErr) {
              console.error('Failed to create default routing rule:', ruleErr);
              setModalError('Interface created but failed to create default routing rule');
            }
          }
          setShowCreateModal(false);
          resetCreateForm();
          await loadInterfaces();
        } else {
          setModalError('Failed to create DICOM interface');
        }
      }
    } catch (err) {
      console.error('Error saving DICOM interface:', err);
      setModalError('Failed to save DICOM interface');
    } finally {
      setSaving(false);
    }
  };

  const resetCreateForm = () => {
    setNewInterfaceName('');
    setNewInterfaceDescription('');
    setNewInterfaceAeTitle('');
    setNewInterfaceServiceType({ label: 'SCP & SCU', value: 'SCP_SCU' });
    setNewInterfaceProtocol({ label: 'DIMSE', value: 'DIMSE' });
    setNewInterfaceLogLevel({ label: 'INFO', value: 'INFO' });
    setNewInterfaceThreadCount('4');
    setNewInterfaceStorageThrottle('1000');
    setNewInterfaceS3TransferAcceleration(false);
    setSelectedDatastores([]);
    setCreateDefaultRule(false);
  };

  const handleDeleteInterfaces = async () => {
    if (selectedItems.length > 0) {
      // Show modal immediately
      setShowDeleteModal(true);
      setLoadingImpact(true);
      setDeleteImpact({ routingRules: [], dicomEntities: [] });
      
      // Load impact data from server
      try {
        const interfaceId = selectedItems[0].id;
        const response = await apiClient.getDicomInterfaceDeleteImpact(interfaceId);
        
        if (response.data) {
          setDeleteImpact({
            routingRules: response.data.routingRules || [],
            dicomEntities: response.data.dicomEntities || []
          });
        }
      } catch (err) {
        console.error('Error loading delete impact:', err);
        setDeleteImpact({ routingRules: [], dicomEntities: [] });
      } finally {
        setLoadingImpact(false);
      }
    }
  };

  const confirmDeleteInterfaces = async () => {
    if (deleteConfirmationText !== 'delete') {
      return;
    }

    try {
      setDeleting(true);
      
      for (const interfaceItem of selectedItems) {
        const response = await apiClient.deleteDicomInterface(interfaceItem.id);
        if (!response.success) {
          throw new Error(`Failed to delete interface ${interfaceItem.interfaceName}: ${response.message}`);
        }
      }

      setShowDeleteModal(false);
      setDeleteConfirmationText('');
      setSelectedItems([]);
      await loadInterfaces();
    } catch (err) {
      console.error('Error deleting DICOM interfaces:', err);
      setError('Failed to delete DICOM interfaces');
    } finally {
      setDeleting(false);
    }
  };

  const cancelDelete = () => {
    setShowDeleteModal(false);
    setDeleteConfirmationText('');
  };

  const handleEdit = async () => {
    if (selectedItems.length === 1) {
      const iface = selectedItems[0];
      
      // Fetch full interface details including accessible datastores
      try {
        const response = await apiClient.getDicomInterface(iface.id);
        if (response.success && response.data) {
          const fullInterface: any = response.data;
          setSelectedInterface(fullInterface);
          setNewInterfaceName(fullInterface.name || fullInterface.interfaceName);
          setNewInterfaceDescription(fullInterface.description || '');
          setNewInterfaceAeTitle(fullInterface.aeTitle);
          setNewInterfaceServiceType({ label: fullInterface.interfaceType === 'SCP' ? 'SCP (Receiver)' : 'SCU (Sender)', value: fullInterface.interfaceType });
          
          // Find and set location
          const location = locations.find(loc => loc.id === fullInterface.locationId);
          if (location) {
            setNewInterfaceLocation({ label: location.name, value: location.id });
          }
          
          // Set selected datastores
          if (fullInterface.accessibleDatastores && Array.isArray(fullInterface.accessibleDatastores)) {
            const selectedOptions = fullInterface.accessibleDatastores.map((dsId: string) => {
              const ds = datastores.find(d => d.id === dsId);
              return ds ? { 
                label: `${ds.name} (${ds.status})`, 
                value: ds.id,
                description: ds.description || 'No description'
              } : null;
            }).filter(Boolean);
            setSelectedDatastores(selectedOptions);
          } else {
            setSelectedDatastores([]);
          }
          
          setModalError(null);
          setShowCreateModal(true);
        }
      } catch (error) {
        console.error('Failed to fetch interface details:', error.message);
        setModalError('Failed to load interface details');
      }
    }
  };

  // Filter interfaces based on search text
  const filteredInterfaces = interfaces.filter(interfaceItem =>
    interfaceItem.interfaceName.toLowerCase().includes(filterText.toLowerCase()) ||
    interfaceItem.aeTitle.toLowerCase().includes(filterText.toLowerCase()) ||
    interfaceItem.description.toLowerCase().includes(filterText.toLowerCase())
  );

  const serviceTypeOptions = [
    { label: 'SCP & SCU', value: 'SCP_SCU' },
    { label: 'SCP (Receiver)', value: 'SCP' },
    { label: 'SCU (Sender)', value: 'SCU' }
  ];

  const protocolOptions = [
    { label: 'DIMSE', value: 'DIMSE' }
  ];

  return (
    <SpaceBetween direction="vertical" size="l">
      {error && (
        <Alert
          type="error"
          dismissible
          onDismiss={() => setError(null)}
        >
          {error}
        </Alert>
      )}
      <Header
        variant="h1"
        actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  variant="normal"
                  onClick={() => { setIsManualRefresh(true); loadInterfaces().finally(() => setIsManualRefresh(false)); }}
                  loading={isManualRefresh && loading}
                  iconName="refresh"
                >
                  Refresh
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setModalError(null);
                    setShowCreateModal(true);
                  }}
                >
                  Create DICOM Interface
                </Button>
              </SpaceBetween>
            }
        >
          DICOM Interfaces
        </Header>
      
      <Table
        header={
          <Header
            counter={`(${filteredInterfaces.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={handleEdit} disabled={selectedItems.length !== 1}>Edit</Button>
                <Button onClick={handleDeleteInterfaces} disabled={selectedItems.length !== 1}>Delete</Button>
              </SpaceBetween>
            }
          />
        }
        columnDefinitions={[
          {
            id: 'id',
            header: 'Interface ID',
            cell: item => item.id,
            sortingField: 'id'
          },
            {
              id: 'name',
              header: 'Name',
              cell: item => item.interfaceName,
              sortingField: 'interfaceName'
            },
            {
              id: 'aeTitle',
              header: 'AE Title',
              cell: item => item.aeTitle,
              sortingField: 'aeTitle'
            },
            {
              id: 'location',
              header: 'Location',
              cell: item => item.locationName || '-',
              sortingField: 'locationName'
            },
            {
              id: 'status',
              header: 'Status',
              cell: item => (
                <StatusIndicator
                  type={
                    item.status === 'ACTIVE' ? 'success' :
                    ['CREATING', 'DELETING', 'PENDING'].includes(item.status) ? 'pending' :
                    item.status === 'ERROR' ? 'error' :
                    item.status === 'INACTIVE' ? 'warning' :
                    'info'
                  }
                >
                  {item.status}
                </StatusIndicator>
              )
            },
            {
              id: 'protocol',
              header: 'Protocol',
              cell: item => item.protocol
            },
            {
              id: 'routingRules',
              header: 'Routing Rules',
              cell: item => {
                const count = (item as any).routingRulesCount || 0;
                return count === 0 ? (
                  <StatusIndicator type="warning">No routing rules</StatusIndicator>
                ) : (
                  <Box>{count}</Box>
                );
              }
            },
            {
              id: 'createdAt',
              header: 'Created',
              cell: item => formatTimestampDate(item.createdAt),
              sortingField: 'createdAt'
            }
          ]}
          items={filteredInterfaces}
          selectionType="single"
          trackBy="id"
          selectedItems={selectedItems}
          onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
          loading={loading}
          filter={
            <TextFilter
              filteringText={filterText}
              onChange={({ detail }) => setFilterText(detail.filteringText)}
              filteringPlaceholder="Search DICOM interfaces..."
            />
          }
          pagination={
            <Pagination
              currentPageIndex={currentPageIndex}
              pagesCount={Math.ceil(filteredInterfaces.length / 25)}
              onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
            />
          }
          empty={
            <Box textAlign="center" color="inherit">
              <b>No DICOM interfaces</b>
              <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                No DICOM interfaces to display.
            </Box>
            <Button onClick={() => setShowCreateModal(true)}>Create DICOM Interface</Button>
          </Box>
        }
      />

      {/* Create/Edit DICOM Interface Modal */}
      <Modal
        visible={showCreateModal}
        onDismiss={() => {
          setShowCreateModal(false);
          setSelectedInterface(null);
        }}
        header={<Header variant="h2">{selectedInterface ? 'Edit' : 'Create'} DICOM Interface</Header>}
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => {
                setShowCreateModal(false);
                setSelectedInterface(null);
              }}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleCreateInterface}
                disabled={!newInterfaceName || !newInterfaceAeTitle || !newInterfaceLocation || saving}
                loading={saving}
              >
                {selectedInterface ? 'Save Changes' : 'Create Interface'}
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
              label="Interface Name"
              description="A unique name for this DICOM interface"
            >
              <Input
                value={newInterfaceName}
                onChange={({ detail }) => setNewInterfaceName(detail.value)}
                placeholder="Enter interface name"
              />
            </FormField>

            <FormField
              label="Description"
              description="Optional description for this interface"
            >
              <Textarea
                value={newInterfaceDescription}
                onChange={({ detail }) => setNewInterfaceDescription(detail.value)}
                placeholder="Enter description"
                rows={3}
              />
            </FormField>

            <FormField
              label="Location"
              description="Select the location for this interface"
            >
              <Select
                selectedOption={newInterfaceLocation}
                onChange={({ detail }) => setNewInterfaceLocation(detail.selectedOption)}
                options={locations.map(loc => ({ label: loc.name, value: loc.id }))}
                placeholder="Select a location"
              />
            </FormField>

            <FormField
              label="Accessible Datastores"
              description="Select which datastores can be accessed for DICOM query and retrieve operations"
            >
              <Multiselect
                selectedOptions={selectedDatastores}
                onChange={({ detail }) => setSelectedDatastores([...detail.selectedOptions])}
                options={datastores.map(ds => ({ 
                  label: `${ds.name} (${ds.status})`, 
                  value: ds.id,
                  description: ds.description || 'No description'
                }))}
                placeholder="Select datastores for retrieval access"
                filteringType="auto"
              />
            </FormField>

            <FormField label="Default Routing Rule">
              <Checkbox
                checked={createDefaultRule}
                disabled={selectedDatastores.length !== 1 || !!selectedInterface}
                onChange={({ detail }) => setCreateDefaultRule(detail.checked)}
              >
                Create default "Route ALL" routing rule to selected datastore
              </Checkbox>
            </FormField>

            <FormField
              label="AE Title"
              description="Application Entity Title for DICOM communication"
            >
              <Input
                value={newInterfaceAeTitle}
                onChange={({ detail }) => setNewInterfaceAeTitle(detail.value)}
                placeholder="Enter AE Title (e.g., EDGEDEVICE)"
              />
            </FormField>

            <FormField label="Service Type">
              <Select
                selectedOption={newInterfaceServiceType}
                onChange={({ detail }) => setNewInterfaceServiceType(detail.selectedOption)}
                options={serviceTypeOptions}
              />
            </FormField>

            <FormField label="Protocol">
              <Select
                selectedOption={newInterfaceProtocol}
                onChange={({ detail }) => setNewInterfaceProtocol(detail.selectedOption)}
                options={protocolOptions}
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
            Delete DICOM Interface{selectedItems.length > 1 ? 's' : ''}
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
                onClick={confirmDeleteInterfaces}
                disabled={deleteConfirmationText !== 'delete' || deleting}
                loading={deleting}
              >
                Delete
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween direction="vertical" size="m">
          <Box>
            Are you sure you want to delete the following DICOM interface{selectedItems.length > 1 ? 's' : ''}?
          </Box>
          <ul>
            {selectedItems.map(item => (
              <li key={item.id}><strong>{item.interfaceName}</strong> ({item.aeTitle})</li>
            ))}
          </ul>
          
          {loadingImpact ? (
            <Alert type="warning">
              <SpaceBetween direction="horizontal" size="s" alignItems="center">
                <Spinner />
                <Box>Loading impact analysis...</Box>
              </SpaceBetween>
            </Alert>
          ) : (deleteImpact.routingRules.length > 0 || deleteImpact.dicomEntities.length > 0) ? (
            <Alert type="warning">
              <SpaceBetween direction="vertical" size="s">
                <Box variant="strong">This deletion will have the following impacts:</Box>
                
                {deleteImpact.routingRules.length > 0 && (
                  <Box>
                    <Box variant="strong">{deleteImpact.routingRules.length} Routing Rule{deleteImpact.routingRules.length > 1 ? 's' : ''} will be deleted:</Box>
                    <ul>
                      {deleteImpact.routingRules.map((rule: any) => (
                        <li key={rule.id}>{rule.name}</li>
                      ))}
                    </ul>
                  </Box>
                )}
                
                {deleteImpact.dicomEntities.length > 0 && (
                  <Box>
                    <Box variant="strong">{deleteImpact.dicomEntities.length} DICOM Entit{deleteImpact.dicomEntities.length > 1 ? 'ies' : 'y'} will be reconfigured:</Box>
                    <ul>
                      {deleteImpact.dicomEntities.map((entity: any) => (
                        <li key={entity.id}>{entity.name} ({entity.aeTitle}) - privileges for this interface will be removed</li>
                      ))}
                    </ul>
                  </Box>
                )}
              </SpaceBetween>
            </Alert>
          ) : null}
          
          <Alert type="error">
            This action cannot be undone.
          </Alert>
          
          <FormField
            label={`Type "delete" to confirm deletion of ${selectedItems.length} interface${selectedItems.length > 1 ? 's' : ''}`}
          >
            <Input
              value={deleteConfirmationText}
              onChange={({ detail }) => setDeleteConfirmationText(detail.value)}
              placeholder="delete"
            />
          </FormField>
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
};

export default DicomInterfaceManagement;
