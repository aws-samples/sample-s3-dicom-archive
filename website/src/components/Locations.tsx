import React, { useState, useEffect } from 'react';
import {
  Container,
  Header,
  Table,
  Box,
  ColumnLayout,
  SpaceBetween,
  Button,
  Modal,
  FormField,
  Input,
  Textarea,
  StatusIndicator,
  Alert,
  TextFilter,
  Tabs,
  Checkbox,
  Toggle,
  Badge
} from '@cloudscape-design/components';
import { getLocations, createLocation, updateLocation, deleteLocation, activateDicomNode, activateHl7Node } from '../services/apiClient';

interface Location {
  id: string;
  name: string;
  description?: string;
  dicomPort: number;
  dicomTlsPort?: number;
  tlsVerifyClient?: boolean;
  hl7Port?: number;
  address?: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt?: string;
  // Service counts
  dicomServicesCount?: number;
  hl7ServicesCount?: number;
  totalServicesCount?: number;
  // Fargate config
  config?: {
    hostingType?: 'fargate' | 'remote';
    minTasks?: number;
    maxTasks?: number;
    desiredCount?: number;
    allowedIpAddresses?: Array<{ cidr: string; enabled: boolean; description?: string; ports?: number[] }>;
    allowAllSources?: boolean;
    ecsClusterName?: string;
    ecsServiceName?: string;
    nlbDnsName?: string;
    useS3Direct?: boolean;
  };
}

const Locations: React.FC = () => {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Location[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [filteringText, setFilteringText] = useState('');
  const [showInstallModal, setShowInstallModal] = useState(false);
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    dicom_port: '11112',
    hl7_port: '2575',
    dicom_tls_port: '2762',
    tls_verify_client: false
  });
  
  const [nameError, setNameError] = useState<string | null>(null);
  const [activeTabId, setActiveTabId] = useState('general');
  // DICOM DIMSE retrieval mode: S3-direct (default ON) vs. dicomweb-s3 WADO. Applies to all locations.
  const [useS3Direct, setUseS3Direct] = useState<boolean>(true);
  const [serviceConfig, setServiceConfig] = useState<{
    minTasks: number;
    maxTasks: number;
    desiredCount: number;
    allowAllSources: boolean;
    allowedIpAddresses: Array<{ cidr: string; enabled: boolean; description?: string; ports?: number[] }>;
  }>({
    minTasks: 1,
    maxTasks: 5,
    desiredCount: 1,
    allowAllSources: false,
    allowedIpAddresses: [],
  });
  const [newIpInput, setNewIpInput] = useState('');
  const [newIpDescription, setNewIpDescription] = useState('');
  const [newIpPlain, setNewIpPlain] = useState(true);
  const [newIpTls, setNewIpTls] = useState(true);
  const [ipError, setIpError] = useState<string | null>(null);

  const validateName = (name: string): string | null => {
    if (!name || name.trim().length === 0) {
      return 'Name is required';
    }
    // Keep location names to a simple, display-safe character set.
    if (!/^[a-zA-Z0-9\s\-]+$/.test(name)) {
      return 'Name can only contain letters, numbers, spaces, and hyphens';
    }
    if (name.length > 50) {
      return 'Name must be 50 characters or less';
    }
    return null;
  };

  useEffect(() => {
    loadLocations();
  }, []);

  const loadLocations = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getLocations();
      setLocations(response.data || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load locations');
    } finally {
      setLoading(false);
    }
  };

  const activateNode = async (locationId: string, serviceType: 'dicom' | 'hl7') => {
    setDownloadingId(locationId);
    try {
      const response = serviceType === 'dicom' 
        ? await activateDicomNode(locationId)
        : await activateHl7Node(locationId);
      
      const blob = response.data as Blob;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${serviceType}-certificates-${locationId.substring(0, 8)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(`Failed to download ${serviceType.toUpperCase()} certificates: ${err.message}`);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleCreate = () => {
    setModalMode('create');
    setFormData({ name: '', description: '', dicom_port: '11112', hl7_port: '2575', dicom_tls_port: '2762', tls_verify_client: false });
    setUseS3Direct(true);
    setModalError(null);
    setNameError(null);
    setShowModal(true);
  };

  const handleEdit = () => {
    if (selectedItems.length === 1) {
      setModalMode('edit');
      const loc = selectedItems[0];
      setFormData({
        name: loc.name,
        description: loc.description || '',
        dicom_port: loc.dicomPort.toString(),
        hl7_port: loc.hl7Port?.toString() || '2575',
        dicom_tls_port: loc.dicomTlsPort?.toString() || '2762',
        tls_verify_client: loc.tlsVerifyClient || false
      });
      
      // DIMSE S3-direct retrieval mode (default ON when unset)
      setUseS3Direct(loc.config?.useS3Direct !== false);
      
      // Load service config if Fargate location
      if (loc.config?.hostingType === 'fargate') {
        setServiceConfig({
          minTasks: loc.config.minTasks ?? 1,
          maxTasks: loc.config.maxTasks ?? 5,
          desiredCount: loc.config.desiredCount ?? loc.config.minTasks ?? 0,
          allowAllSources: loc.config.allowAllSources || false,
          allowedIpAddresses: loc.config.allowedIpAddresses || [],
        });
      }
      
      setModalError(null);
      setNameError(null);
      setActiveTabId('general');
      setShowModal(true);
    }
  };

  const handleDelete = () => {
    if (selectedItems.length === 1) {
      setDeleteConfirmName('');
      setShowDeleteModal(true);
    }
  };

  const confirmDelete = async () => {
    if (selectedItems.length === 1 && deleteConfirmName === selectedItems[0].name) {
      try {
        setSubmitting(true);
        setError(null);
        await deleteLocation(selectedItems[0].id);
        await loadLocations();
        setSelectedItems([]);
        setShowDeleteModal(false);
        setDeleteConfirmName('');
      } catch (err: any) {
        if (err.response?.data?.associatedInterfaces) {
          const interfaces = err.response.data.associatedInterfaces.join(', ');
          setError(`Cannot delete location. It is still associated with the following DICOM interfaces: ${interfaces}`);
        } else {
          setError(err.response?.data?.message || err.message || 'Failed to delete location');
        }
      } finally {
        setSubmitting(false);
      }
    }
  };

  const validateCidr = (cidr: string): string | null => {
    const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
    if (!cidrRegex.test(cidr)) {
      return 'Invalid IP or CIDR format (e.g., 192.168.1.100 or 10.0.0.0/8)';
    }
    return null;
  };

  const handleAddIp = () => {
    const error = validateCidr(newIpInput);
    if (error) {
      setIpError(error);
      return;
    }
    
    setServiceConfig({
      ...serviceConfig,
      allowedIpAddresses: [...serviceConfig.allowedIpAddresses, { cidr: newIpInput, enabled: true, description: newIpDescription, ports: [...(newIpPlain ? [11112] : []), ...(newIpTls ? [2762] : [])] }],
    });
    setNewIpInput('');
    setNewIpDescription('');
    setNewIpPlain(true);
    setNewIpTls(true);
    setIpError(null);
  };

  const handleRemoveIp = (index: number) => {
    setServiceConfig({
      ...serviceConfig,
      allowedIpAddresses: serviceConfig.allowedIpAddresses.filter((_, i) => i !== index),
    });
  };

  const handleToggleIp = (index: number) => {
    const updated = [...serviceConfig.allowedIpAddresses];
    updated[index] = { ...updated[index], enabled: !updated[index].enabled };
    setServiceConfig({ ...serviceConfig, allowedIpAddresses: updated });
  };

  const handleSubmit = async () => {
    setModalError(null);
    
    // Validate name
    const nameValidationError = validateName(formData.name);
    if (nameValidationError) {
      setNameError(nameValidationError);
      return;
    }
    
    try {
      setSubmitting(true);
      const payload: any = {
        name: formData.name,
        description: formData.description || undefined,
        dicom_port: parseInt(formData.dicom_port),
        hl7_port: formData.hl7_port ? parseInt(formData.hl7_port) : undefined,
        dicom_tls_port: formData.dicom_tls_port ? parseInt(formData.dicom_tls_port) : undefined,
        tls_verify_client: formData.tls_verify_client
      };

      // Include config for Fargate locations (edit mode only)
      if (modalMode === 'edit' && selectedItems[0]?.config?.hostingType === 'fargate') {
        payload.config = {
          ...selectedItems[0].config,
          minTasks: serviceConfig.minTasks,
          maxTasks: serviceConfig.maxTasks,
          desiredCount: serviceConfig.desiredCount,
          allowAllSources: serviceConfig.allowAllSources,
          allowedIpAddresses: serviceConfig.allowedIpAddresses,
          useS3Direct,
        };
      } else {
        // All other locations: still persist the DIMSE S3-direct flag.
        // Merge onto any existing config so unrelated fields are preserved.
        payload.config = {
          ...(selectedItems[0]?.config || {}),
          useS3Direct,
        };
      }

      let response;
      if (modalMode === 'create') {
        response = await createLocation(payload);
      } else {
        response = await updateLocation(selectedItems[0].id, payload);
      }
      
      // Check if the response indicates an error
      if (!response.success || response.errors) {
        const errorMessage = response.message || response.errors?.[0] || 'Failed to save location';
        setModalError(errorMessage);
        return; // Keep modal open
      }
      
      // Success - close modal and refresh
      setShowModal(false);
      await loadLocations();
      setSelectedItems([]);
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to save location';
      setModalError(errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  // Filter locations based on search text
  const filteredLocations = locations.filter(location =>
    location.name.toLowerCase().includes(filteringText.toLowerCase()) ||
    location.description?.toLowerCase().includes(filteringText.toLowerCase()) ||
    location.id.toLowerCase().includes(filteringText.toLowerCase())
  );

  return (
    <SpaceBetween direction="vertical" size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => setShowInstallModal(true)} iconName="status-info">Install Instructions</Button>
            <Button onClick={loadLocations} iconName="refresh">Refresh</Button>
            <Button variant="primary" onClick={handleCreate}>Create Location</Button>
          </SpaceBetween>
        }
      >
        Locations
      </Header>
      
      {error && <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>}
      
      <Table
          header={
            <Header
              counter={`(${filteredLocations.length})`}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={handleEdit} disabled={selectedItems.length !== 1}>Edit</Button>
                  <Button 
                    onClick={handleDelete} 
                    disabled={selectedItems.length !== 1 || selectedItems[0]?.config?.hostingType === 'fargate'}
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
              filteringPlaceholder="Search locations..."
            />
          }
          columnDefinitions={[
            {
              id: 'id',
              header: 'Location ID',
              cell: (item) => item.id,
              width: 300
            },
            {
              id: 'name',
              header: 'Name',
              cell: (item) => (
                <SpaceBetween direction="horizontal" size="xs">
                  <span>{item.name}</span>
                  {item.config?.hostingType === 'fargate' && <Badge color="blue">Fargate</Badge>}
                </SpaceBetween>
              )
            },
            {
              id: 'description',
              header: 'Description',
              cell: (item) => {
                if (item.config?.hostingType === 'fargate' && item.config?.nlbDnsName) {
                  return (
                    <Box>
                      <Box fontSize="body-s" fontWeight="bold">
                        {item.config.nlbDnsName}
                      </Box>
                      <Box fontSize="body-s" color="text-status-info">
                        {item.description || 'Fargate-hosted DICOM service'}
                      </Box>
                    </Box>
                  );
                }
                return item.description || '-';
              }
            },
            {
              id: 'dicomPort',
              header: 'DICOM Port',
              cell: (item) => item.dicomPort
            },
            {
              id: 'dicomTlsPort',
              header: 'TLS Port',
              cell: (item) => item.dicomTlsPort || '-'
            },
            {
              id: 'hl7Port',
              header: 'HL7 Port',
              cell: (item) => item.hl7Port || '-'
            },
            {
              id: 'services',
              header: 'Active Services',
              cell: (item) => {
                const dicom = item.dicomServicesCount || 0;
                const hl7 = item.hl7ServicesCount || 0;
                const total = item.totalServicesCount || 0;
                
                if (total === 0) {
                  return <StatusIndicator type="stopped">No services</StatusIndicator>;
                }
                
                return (
                  <SpaceBetween direction="horizontal" size="xs">
                    <StatusIndicator type="success">{total} total</StatusIndicator>
                    {dicom > 0 && <span>({dicom} DICOM)</span>}
                    {hl7 > 0 && <span>({hl7} HL7)</span>}
                  </SpaceBetween>
                );
              }
            },
            {
              id: 'certificates',
              header: 'Downloads',
              cell: (item) => (
                item.config?.hostingType === 'fargate' ? null : (
                <Button
                  onClick={() => activateNode(item.id, 'dicom')}
                  iconName="download"
                  loading={downloadingId === item.id}
                >
                  Config
                </Button>
                )
              )
            },
            {
              id: 'status',
              header: 'Status',
              cell: (item) => (
                <StatusIndicator type={item.status === 'ACTIVE' ? 'success' : 'stopped'}>
                  {item.status}
                </StatusIndicator>
              )
            }
          ]}
          items={filteredLocations}
          loading={loading}
          loadingText="Loading locations"
          selectionType="single"
          selectedItems={selectedItems}
          onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
          empty={
            <Box textAlign="center" color="inherit">
              <b>No locations</b>
              <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                No locations to display.
              </Box>
              <Button onClick={handleCreate}>Create Location</Button>
            </Box>
          }
        />

        <Modal
          visible={showModal}
          onDismiss={() => setShowModal(false)}
          header={modalMode === 'create' ? 'Create Location' : 'Edit Location'}
          size="medium"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowModal(false)} disabled={submitting}>Cancel</Button>
                <Button 
                  variant="primary" 
                  onClick={handleSubmit} 
                  loading={submitting}
                  disabled={!!nameError || !formData.name.trim()}
                >
                  {modalMode === 'create' ? 'Create' : 'Save'}
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          {modalError && <Alert type="error" dismissible onDismiss={() => setModalError(null)}>{modalError}</Alert>}
          
          {modalMode === 'edit' && selectedItems[0]?.config?.hostingType === 'fargate' ? (
            <Tabs
              activeTabId={activeTabId}
              onChange={({ detail }) => setActiveTabId(detail.activeTabId)}
              tabs={[
                {
                  id: 'general',
                  label: 'General',
                  content: (
                    <SpaceBetween size="m">
                      <FormField 
                        label="Name" 
                        constraintText="Required. Letters, numbers, spaces, and hyphens only (max 50 characters)"
                        errorText={nameError || undefined}
                      >
                        <Input
                          value={formData.name}
                          onChange={({ detail }) => {
                            setFormData({ ...formData, name: detail.value });
                            setNameError(validateName(detail.value));
                          }}
                          invalid={!!nameError}
                        />
                      </FormField>
                      
                      <FormField label="Description">
                        <Textarea
                          value={formData.description}
                          onChange={({ detail }) => setFormData({ ...formData, description: detail.value })}
                        />
                      </FormField>
                      
                      <ColumnLayout columns={2}>
                        <FormField label="DICOM Port" constraintText="Managed by infrastructure">
                          <Input type="number" value={formData.dicom_port} onChange={({ detail }) => setFormData({ ...formData, dicom_port: detail.value })} disabled={true} />
                        </FormField>
                        <FormField label="DICOM TLS Port" constraintText="Managed by infrastructure">
                          <Input type="number" value={formData.dicom_tls_port} onChange={({ detail }) => setFormData({ ...formData, dicom_tls_port: detail.value })} disabled={true} />
                        </FormField>
                      </ColumnLayout>
                      
                      <FormField label="Client Certificate Verification" description="When enabled, connecting DICOM clients must present a valid certificate (mTLS). Upload client certificates on each DICOM Entity.">
                        <Checkbox
                          checked={formData.tls_verify_client}
                          onChange={({ detail }) => setFormData({ ...formData, tls_verify_client: detail.checked })}
                        >
                          Require client certificates (mutual TLS)
                        </Checkbox>
                      </FormField>

                      <FormField label="DICOM DIMSE Retrieval" description="When enabled, the DIMSE service fetches objects directly from S3 (using S3 keys from the DICOMweb QIDO response). When disabled, it retrieves via the dicomweb-s3 WADO service.">
                        <Toggle
                          checked={useS3Direct}
                          onChange={({ detail }) => setUseS3Direct(detail.checked)}
                        >
                          DICOM DIMSE services uses S3 direct
                        </Toggle>
                      </FormField>
                    </SpaceBetween>
                  ),
                },
                {
                  id: 'service',
                  label: 'Service Configuration',
                  content: (
                    <SpaceBetween size="m">
                      <FormField label="DICOM Service Endpoint" description="Network Load Balancer DNS name">
                        <Input
                          value={selectedItems[0]?.config?.nlbDnsName || 'Not available'}
                          readOnly
                        />
                      </FormField>

                      <FormField label="Min Tasks" constraintText="Minimum number of running tasks (0-10)">
                        <Input
                          type="number"
                          value={serviceConfig.minTasks.toString()}
                          onChange={({ detail }) => {
                            const val = parseInt(detail.value);
                            setServiceConfig({ ...serviceConfig, minTasks: Math.max(0, Math.min(10, isNaN(val) ? 0 : val)) });
                          }}
                          inputMode="numeric"
                        />
                      </FormField>

                      <FormField label="Desired Tasks" description="Set the current number of running tasks immediately" constraintText="0-10">
                        <Input
                          type="number"
                          value={serviceConfig.desiredCount.toString()}
                          onChange={({ detail }) => {
                            const val = parseInt(detail.value);
                            setServiceConfig({ ...serviceConfig, desiredCount: Math.max(0, Math.min(10, isNaN(val) ? 0 : val)) });
                          }}
                          inputMode="numeric"
                        />
                      </FormField>
                      
                      <FormField label="Max Tasks" constraintText="Maximum number of running tasks (1-10)">
                        <Input
                          type="number"
                          value={serviceConfig.maxTasks.toString()}
                          onChange={({ detail }) => {
                            const val = parseInt(detail.value) || 1;
                            setServiceConfig({ ...serviceConfig, maxTasks: Math.max(serviceConfig.minTasks, Math.min(10, val)) });
                          }}
                          inputMode="numeric"
                        />
                      </FormField>
                      
                      <FormField label="Network Access" description="Controls which IP addresses can connect to the NLB on DICOM ports">
                        {/* DISABLED: 0.0.0.0/0 access is no longer permitted. Use IP allowlisting instead.
                        <Checkbox
                          checked={serviceConfig.allowAllSources}
                          onChange={({ detail }) => setServiceConfig({ ...serviceConfig, allowAllSources: detail.checked })}
                          description="Warning: Opens DICOM ports (11112, 2762) to the public internet. Use IP allowlisting for production deployments."
                        >
                          Allow All Sources (0.0.0.0/0)
                        </Checkbox>
                        */}
                      </FormField>
                      
                      <FormField 
                        label="Allowed IP Addresses" 
                        description="Manage IP addresses allowed to access the DICOM service"
                        constraintText={undefined}
                      >
                        <SpaceBetween size="s">
                          <Table
                            items={serviceConfig.allowedIpAddresses}
                            columnDefinitions={[
                              {
                                id: 'enabled',
                                header: 'Enabled',
                                cell: (item) => (
                                  <Checkbox
                                    checked={item.enabled}
                                    onChange={() => {
                                      const index = serviceConfig.allowedIpAddresses.indexOf(item);
                                      handleToggleIp(index);
                                    }}
                                  />
                                )
                              },
                              {
                                id: 'cidr',
                                header: 'IP Address / CIDR',
                                cell: (item) => item.cidr
                              },
                              {
                                id: 'description',
                                header: 'Description',
                                cell: (item) => item.description || '-'
                              },
                              {
                                id: 'ports',
                                header: 'Ports',
                                cell: (item: any) => (item.ports || [11112, 2762]).map((p: number) => p === 2762 ? 'TLS (2762)' : 'Plain (11112)').join(', ')
                              },
                              {
                                id: 'actions',
                                header: 'Actions',
                                cell: (item) => (
                                  <Button 
                                    iconName="remove" 
                                    variant="inline-icon" 
                                    ariaLabel={`Remove ${item.cidr}`}
                                    onClick={() => {
                                      const index = serviceConfig.allowedIpAddresses.indexOf(item);
                                      handleRemoveIp(index);
                                    }} 
                                  />
                                )
                              }
                            ]}
                            empty={<Box textAlign="center">No IP addresses configured</Box>}
                          />
                          
                          <SpaceBetween direction="horizontal" size="xs">
                            <Input
                              value={newIpInput}
                              onChange={({ detail }) => {
                                setNewIpInput(detail.value);
                                setIpError(null);
                              }}
                              placeholder="192.168.1.100 or 10.0.0.0/8"
                              invalid={!!ipError}
                            />
                            <Input
                              value={newIpDescription}
                              onChange={({ detail }) => setNewIpDescription(detail.value)}
                              placeholder="Description (optional)"
                            />
                            <Button onClick={handleAddIp} disabled={!newIpPlain && !newIpTls}>Add</Button>
                          </SpaceBetween>
                          <SpaceBetween direction="horizontal" size="xs">
                            <Checkbox checked={newIpPlain} onChange={({ detail }) => setNewIpPlain(detail.checked)}>DICOM (11112)</Checkbox>
                            <Checkbox checked={newIpTls} onChange={({ detail }) => setNewIpTls(detail.checked)}>DICOM TLS (2762)</Checkbox>
                          </SpaceBetween>
                          {ipError && <Alert type="error">{ipError}</Alert>}
                        </SpaceBetween>
                      </FormField>
                    </SpaceBetween>
                  ),
                },
              ]}
            />
          ) : (
            <SpaceBetween size="m">
              <FormField 
                label="Name" 
                constraintText="Required. Letters, numbers, spaces, and hyphens only (max 50 characters)"
                errorText={nameError || undefined}
              >
                <Input
                  value={formData.name}
                  onChange={({ detail }) => {
                    setFormData({ ...formData, name: detail.value });
                    setNameError(validateName(detail.value));
                  }}
                  invalid={!!nameError}
                />
              </FormField>
              
              <FormField label="Description">
                <Textarea
                  value={formData.description}
                  onChange={({ detail }) => setFormData({ ...formData, description: detail.value })}
                />
              </FormField>
              
              <ColumnLayout columns={2}>
                <FormField label="DICOM Port" constraintText="Required (1-65535)">
                  <Input type="number" value={formData.dicom_port} onChange={({ detail }) => setFormData({ ...formData, dicom_port: detail.value })} />
                </FormField>
                <FormField label="DICOM TLS Port" constraintText="Standard DICOM TLS port is 2762 (1-65535)">
                  <Input type="number" value={formData.dicom_tls_port} onChange={({ detail }) => setFormData({ ...formData, dicom_tls_port: detail.value })} />
                </FormField>
              </ColumnLayout>
              
              <FormField label="Client Certificate Verification" description="When enabled, connecting DICOM clients must present a valid certificate (mTLS).">
                <Checkbox
                  checked={formData.tls_verify_client}
                  onChange={({ detail }) => setFormData({ ...formData, tls_verify_client: detail.checked })}
                >
                  Require client certificates (mutual TLS)
                </Checkbox>
              </FormField>

              <FormField label="DICOM DIMSE Retrieval" description="When enabled, the DIMSE service fetches objects directly from S3 (using S3 keys from the DICOMweb QIDO response). When disabled, it retrieves via the dicomweb-s3 WADO service.">
                <Toggle
                  checked={useS3Direct}
                  onChange={({ detail }) => setUseS3Direct(detail.checked)}
                >
                  DICOM DIMSE services uses S3 direct
                </Toggle>
              </FormField>
              
              <FormField label="HL7 Port" constraintText="Optional (1-65535)">
                <Input
                  type="number"
                  value={formData.hl7_port}
                  onChange={({ detail }) => setFormData({ ...formData, hl7_port: detail.value })}
                />
              </FormField>
            </SpaceBetween>
          )}
        </Modal>

        <Modal
          visible={showDeleteModal}
          onDismiss={() => {
            setShowDeleteModal(false);
            setError(null);
            setDeleteConfirmName('');
          }}
          header="Delete Location"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => {
                  setShowDeleteModal(false);
                  setError(null);
                  setDeleteConfirmName('');
                }} disabled={submitting}>Cancel</Button>
                <Button 
                  variant="primary" 
                  onClick={confirmDelete} 
                  loading={submitting}
                  disabled={deleteConfirmName !== selectedItems[0]?.name}
                >
                  Delete
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            {error && (
              <Alert type="error" header="Deletion Failed">
                {error}
              </Alert>
            )}
            <Box>
              Are you sure you want to delete the location <strong>{selectedItems[0]?.name}</strong>?
            </Box>
            <FormField label={`Type "${selectedItems[0]?.name}" to confirm`}>
              <Input
                value={deleteConfirmName}
                onChange={({ detail }) => setDeleteConfirmName(detail.value)}
                placeholder="Enter location name"
              />
            </FormField>
          </SpaceBetween>
        </Modal>

        <Modal
          visible={showInstallModal}
          onDismiss={() => setShowInstallModal(false)}
          header="DICOM Service Installation Instructions"
          size="large"
          footer={
            <Box float="right">
              <Button variant="primary" onClick={() => setShowInstallModal(false)}>Close</Button>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <Alert type="info">
              These installation instructions are for remote/on-premises DICOM services only.
            </Alert>
            
            <Box variant="p">
              Follow these steps to install the DICOM service on your on-premises server:
            </Box>
            
            <FormField label="Installation Commands">
              <Box padding={{ vertical: 's', horizontal: 's' }} variant="code">
                <pre >
{`# 1. Download installer
wget -O install-dimse-service.sh ${window.location.origin}/installers/install-dimse-service.sh

# 2. Make executable
chmod +x ./install-dimse-service.sh

# 3. Run installer
./install-dimse-service.sh`}
                </pre>
              </Box>
              <Box padding={{ top: 'xs' }}>
                <Button
                  iconName="copy"
                  onClick={() => navigator.clipboard.writeText(`# 1. Download installer\nwget -O install-dimse-service.sh ${window.location.origin}/installers/install-dimse-service.sh\n\n# 2. Make executable\nchmod +x ./install-dimse-service.sh\n\n# 3. Run installer\n./install-dimse-service.sh`)}
                >
                  Copy All Commands
                </Button>
              </Box>
            </FormField>
          </SpaceBetween>
        </Modal>
    </SpaceBetween>
  );
};

export default Locations;
