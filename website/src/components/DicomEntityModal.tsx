import React, { useState, useEffect } from 'react';
import {
  Modal,
  Header,
  SpaceBetween,
  Box,
  Button,
  Form,
  FormField,
  Input,
  Select,
  Textarea,
  ColumnLayout,
  Table,
  Checkbox,
  Container,
  Alert
} from '@cloudscape-design/components';

import { 
  DicomEntity,
  CreateDicomEntityRequest, 
  UpdateDicomEntityRequest,
  DicomEntityType,
  DicomEntityStatus,
  DicomPrivilegeRequest,
  DicomPrivilegeUpdateRequest
} from '../types/dicom';
import { DicomInterface } from '../types';
import dicomInterfaceService from '../services/dicomInterfaceService';

interface DicomEntityModalProps {
  visible: boolean;
  onDismiss: () => void;
  onSubmit: (data: CreateDicomEntityRequest | UpdateDicomEntityRequest) => Promise<void>;
  entity?: DicomEntity | null; // If provided, this is an edit modal
  loading?: boolean;
  title?: string;
  error?: string; // Error message to display in modal
}

// Form data type that can handle both create and update modes
type FormData = {
  entityType: DicomEntityType;
  name: string;
  aeTitle: string;
  description: string;
  hostname: string;
  port: string;
  clientCertificate: string;
  tlsEnabled: boolean;
  dicomPrivileges: (DicomPrivilegeRequest | DicomPrivilegeUpdateRequest)[];
};

const DicomEntityModal: React.FC<DicomEntityModalProps> = ({
  visible,
  onDismiss,
  onSubmit,
  entity,
  loading = false,
  title,
  error
}) => {
  const isEdit = !!entity;
  const modalTitle = title || (isEdit ? 'Edit DICOM Entity' : 'Create DICOM Entity');

  // Form state
  const [formData, setFormData] = useState<FormData>({
    entityType: 'CLIENT',
    name: '',
    aeTitle: '',
    description: '',
    hostname: '',
    port: '',
    clientCertificate: '',
    tlsEnabled: false,
    dicomPrivileges: []
  });

  // Available DICOM interfaces
  const [interfaces, setInterfaces] = useState<DicomInterface[]>([]);

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Load DICOM interfaces
  useEffect(() => {
    if (visible) {
      loadInterfaces();
    }
  }, [visible]);

  const loadInterfaces = async () => {
    try {
      const response = await dicomInterfaceService.listDicomInterfaces(100, undefined, 'ACTIVE');
      if (response.success && response.data) {
        setInterfaces(response.data.items);
      } else {
        setInterfaces([]);
        console.error('Failed to load DICOM interfaces:', response);
      }
    } catch (error) {
      console.error('Error loading DICOM interfaces:', error.message);
      setInterfaces([]);
    }
  };

  // Initialize form when modal opens or entity changes
  useEffect(() => {
    if (visible) {
      if (entity) {
        // Edit mode - populate form with entity data
        const privileges: DicomPrivilegeUpdateRequest[] = interfaces.map(iface => {
          const existingPrivilege = entity.dicomPrivileges.find(p => p.interfaceId === iface.id);
          return {
            id: existingPrivilege?.id, // Will be undefined for new interfaces, which is fine
            interfaceId: iface.id,
            store: existingPrivilege?.canStore || false,
            query: existingPrivilege?.canQuery || false,
            retrieve: existingPrivilege?.canRetrieve || false
          };
        });

        setFormData({
          entityType: entity.entityType,
          name: entity.name,
          aeTitle: entity.aeTitle,
          description: entity.description || '',
          hostname: entity.host || entity.hostname || '',
          port: String(entity.port || ''),
          clientCertificate: (entity as any).clientCertificate || '',
          tlsEnabled: (entity as any).tlsEnabled || false,
          dicomPrivileges: privileges
        });
      } else {
        // Create mode - initialize with defaults
        const defaultPrivileges: DicomPrivilegeRequest[] = interfaces.map(iface => ({
          interfaceId: iface.id,
          store: false,
          query: false,
          retrieve: false
        }));

        setFormData({
          entityType: 'CLIENT',
          name: '',
          aeTitle: '',
          description: '',
          hostname: '',
          port: '',
          clientCertificate: '',
          tlsEnabled: false,
          dicomPrivileges: defaultPrivileges
        });
      }
      setFormErrors({});
    }
  }, [visible, entity, interfaces]);

  // Form validation
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = 'Name is required';
    }

    if (!formData.aeTitle.trim()) {
      errors.aeTitle = 'AE Title is required';
    } else if (formData.aeTitle.length > 16) {
      errors.aeTitle = 'AE Title must be 16 characters or less';
    } else if (!/^[A-Z0-9_-]+$/.test(formData.aeTitle)) {
      errors.aeTitle = 'AE Title must contain only uppercase letters, numbers, underscores, and hyphens';
    }

    if (!formData.hostname.trim()) {
      errors.hostname = 'Hostname/IP address is required';
    }

    if (!formData.port.trim()) {
      errors.port = 'Port number is required';
    } else if (isNaN(Number(formData.port)) || Number(formData.port) < 1 || Number(formData.port) > 65535) {
      errors.port = 'Port must be a number between 1 and 65535';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Check if form is valid for button state
  const isFormValid = (): boolean => {
    return formData.name.trim() !== '' &&
           formData.aeTitle.trim() !== '' &&
           formData.hostname.trim() !== '' &&
           formData.port.trim() !== '' &&
           !isNaN(Number(formData.port)) &&
           Number(formData.port) >= 1 &&
           Number(formData.port) <= 65535;
  };

  // Handle form submission
  const handleSubmit = async () => {
    if (!validateForm()) {
      return;
    }

    try {
      // For edit mode, include all privileges (with IDs) to allow proper updates
      // For create mode, only include active privileges
      const privilegesToSend = isEdit 
        ? formData.dicomPrivileges || [] // Include all privileges for edit (with IDs)
        : (formData.dicomPrivileges?.filter(p => p.store || p.query || p.retrieve) || []); // Only active for create

      const submitData = {
        entityType: formData.entityType,
        name: formData.name,
        aeTitle: formData.aeTitle,
        description: formData.description || '',
        hostname: formData.hostname || '',
        port: formData.port || '',
        clientCertificate: formData.clientCertificate || undefined,
        tlsEnabled: formData.tlsEnabled,
        dicomPrivileges: privilegesToSend
      };

      // Do not log the submit payload (contains patient/study fields = PHI).
      console.log('Submitting DICOM entity form');
      await onSubmit(submitData);
    } catch (error) {
      console.error('Error submitting form:', error.message);
    }
  };

  // Handle privilege checkbox changes
  const handlePrivilegeChange = (interfaceId: string, privilege: 'store' | 'query' | 'retrieve', checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      dicomPrivileges: prev.dicomPrivileges?.map(p => 
        p.interfaceId === interfaceId 
          ? { ...p, [privilege]: checked }
          : p
      ) || []
    }));
  };

  // Get interface name by ID
  const getInterfaceName = (interfaceId: string): string => {
    const iface = interfaces.find(i => i.id === interfaceId);
    return iface ? iface.interfaceName : interfaceId;
  };

  // Table columns for privileges
  const privilegeColumns = [
    {
      id: 'interface',
      header: 'DICOM Interface',
      cell: (item: DicomPrivilegeRequest) => (
        <SpaceBetween direction="vertical" size="xs">
          <Box variant="strong">{getInterfaceName(item.interfaceId)}</Box>
          <Box variant="small" color="text-body-secondary">
            {interfaces.find(i => i.id === item.interfaceId)?.aeTitle || 'N/A'}
          </Box>
        </SpaceBetween>
      ),
      width: 300
    },
    {
      id: 'store',
      header: 'STORE',
      cell: (item: DicomPrivilegeRequest) => (
        <Checkbox
          checked={item.store}
          onChange={({ detail }) => handlePrivilegeChange(item.interfaceId, 'store', detail.checked)}
        />
      ),
      width: 80
    },
    {
      id: 'query', 
      header: 'QUERY',
      cell: (item: DicomPrivilegeRequest) => (
        <Checkbox
          checked={item.query}
          onChange={({ detail }) => handlePrivilegeChange(item.interfaceId, 'query', detail.checked)}
        />
      ),
      width: 80
    },
    {
      id: 'retrieve',
      header: 'RETRIEVE', 
      cell: (item: DicomPrivilegeRequest) => (
        <Checkbox
          checked={item.retrieve}
          onChange={({ detail }) => handlePrivilegeChange(item.interfaceId, 'retrieve', detail.checked)}
        />
      ),
      width: 120
    }
  ];

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={modalTitle}
      size="max"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              loading={loading}
              disabled={!isFormValid()}
            >
              {isEdit ? 'Update' : 'Create'}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <Form>
        <SpaceBetween size="l">
          {error && (
            <Alert type="error" dismissible={false}>
              {error}
            </Alert>
          )}
          <ColumnLayout columns={2} variant="text-grid">
            {/* Left Column - DICOM Parameters */}
            <Container header={<Header variant="h3">DICOM Parameters</Header>}>
              <SpaceBetween size="l">
                <ColumnLayout columns={2}>
                  <FormField
                    label="Name"
                    errorText={formErrors.name}
                    description="Unique name for this DICOM entity"
                  >
                    <Input
                      value={formData.name}
                      onChange={({ detail }) => setFormData(prev => ({ ...prev, name: detail.value }))}
                      placeholder="Enter entity name"
                    />
                  </FormField>

                  <FormField
                    label="AE Title"
                    errorText={formErrors.aeTitle}
                    description="DICOM Application Entity Title (max 16 chars)"
                  >
                    <Input
                      value={formData.aeTitle}
                      onChange={({ detail }) => setFormData(prev => ({ ...prev, aeTitle: detail.value.toUpperCase() }))}
                      placeholder="Enter AE Title"
                    />
                  </FormField>
                </ColumnLayout>

                <ColumnLayout columns={2}>
                  <FormField label="Entity Type">
                    <Select
                      selectedOption={{ label: formData.entityType, value: formData.entityType }}
                      onChange={({ detail }) => setFormData(prev => ({ 
                        ...prev, 
                        entityType: detail.selectedOption.value as DicomEntityType 
                      }))}
                      options={[
                        { label: 'Client', value: 'CLIENT' },
                        { label: 'Application', value: 'APPLICATION' },
                        { label: 'Workstation', value: 'WORKSTATION' },
                        { label: 'PACS', value: 'PACS' },
                        { label: 'Viewer', value: 'VIEWER' },
                        { label: 'Other', value: 'OTHER' }
                      ]}
                    />
                  </FormField>

                  <FormField label="Status">
                    <Select
                      selectedOption={{ 
                        label: (formData as any).status === 'ACTIVE' ? 'Active' :
                               (formData as any).status === 'INACTIVE' ? 'Inactive' :
                               (formData as any).status === 'SUSPENDED' ? 'Suspended' :
                               (formData as any).status === 'PENDING_APPROVAL' ? 'Pending Approval' : 'Active',
                        value: (formData as any).status || 'ACTIVE' 
                      }}
                      onChange={({ detail }) => setFormData(prev => ({ 
                        ...prev, 
                        status: detail.selectedOption.value as DicomEntityStatus 
                      } as any))}
                      options={[
                        { label: 'Active', value: 'ACTIVE' },
                        { label: 'Inactive', value: 'INACTIVE' },
                        { label: 'Suspended', value: 'SUSPENDED' },
                        { label: 'Pending Approval', value: 'PENDING_APPROVAL' }
                      ]}
                    />
                  </FormField>
                </ColumnLayout>

                <FormField
                  label="Description"
                  description="Optional description for this entity"
                >
                  <Textarea
                    value={formData.description || ''}
                    onChange={({ detail }) => setFormData(prev => ({ ...prev, description: detail.value }))}
                    placeholder="Enter description"
                    rows={3}
                  />
                </FormField>

                <ColumnLayout columns={2}>
                  <FormField
                    label="Hostname"
                    errorText={formErrors.hostname}
                    description="Hostname or IP address (required)"
                  >
                    <Input
                      value={formData.hostname || ''}
                      onChange={({ detail }) => setFormData(prev => ({ ...prev, hostname: detail.value }))}
                      placeholder="Enter hostname or IP"
                    />
                  </FormField>

                  <FormField
                    label="Port"
                    errorText={formErrors.port}
                    description="Port number (required, 1-65535)"
                  >
                    <Input
                      value={formData.port || ''}
                      onChange={({ detail }) => setFormData(prev => ({ ...prev, port: detail.value }))}
                      placeholder="Enter port number"
                      type="number"
                    />
                  </FormField>
                </ColumnLayout>

                <FormField label="Outbound TLS" description="Enable TLS when our service connects to this entity (e.g., C-MOVE delivery, C-STORE SCU).">
                  <Checkbox
                    checked={formData.tlsEnabled}
                    onChange={({ detail }) => setFormData(prev => ({ ...prev, tlsEnabled: detail.checked }))}
                  >
                    Connect to this entity using TLS
                  </Checkbox>
                </FormField>

                <FormField
                  label="Client Certificate (PEM)"
                  description="Optional. Upload a PEM-encoded certificate for mTLS verification. Only needed when the location has 'Verify Client Certificates' enabled."
                >
                  <Textarea
                    value={formData.clientCertificate || ''}
                    onChange={({ detail }) => setFormData(prev => ({ ...prev, clientCertificate: detail.value }))}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                    rows={4}
                  />
                </FormField>
              </SpaceBetween>
            </Container>

            {/* Right Column - Interface Privileges */}
            <Container header={<Header variant="h3">Interface Privileges</Header>}>
              <Table
                columnDefinitions={privilegeColumns}
                items={formData.dicomPrivileges || []}
                variant="embedded"
                empty={
                  <Box textAlign="center" color="inherit">
                    <b>No interfaces available</b>
                    <Box padding={{ bottom: 's' }} variant="p" color="inherit">
                      No DICOM interfaces are currently configured.
                    </Box>
                  </Box>
                }
              />
            </Container>
          </ColumnLayout>
        </SpaceBetween>
      </Form>
    </Modal>
  );
};

export default DicomEntityModal;
