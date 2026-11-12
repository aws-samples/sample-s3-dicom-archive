import React, { useState, useEffect } from 'react';
import {
  Header,
  Table,
  Box,
  SpaceBetween,
  Button,
  Modal,
  FormField,
  Input,
  Select,
  Alert,
  StatusIndicator,
  Badge
} from '@cloudscape-design/components';

interface LifecycleRule {
  id: string;
  name: string;
  description?: string;
  datastoreId: string;
  datastoreName: string;
  status: 'ACTIVE' | 'INACTIVE';
  conditions: {
    ageInDays?: number;
    studyDate?: string;
    modality?: string[];
  };
  actions: {
    transition?: 'ARCHIVE' | 'DELETE';
    targetDatastore?: string;
  };
  createdAt: string;
  updatedAt: string;
}

const LifecycleManagement: React.FC = () => {
  const [lifecycleRules, setLifecycleRules] = useState<LifecycleRule[]>([]);
  const [selectedItems, setSelectedItems] = useState<LifecycleRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [editingRule, setEditingRule] = useState<LifecycleRule | null>(null);
  
  // Form states
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    datastoreId: '',
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE',
    ageInDays: '',
    action: 'ARCHIVE' as 'ARCHIVE' | 'DELETE',
    targetDatastore: ''
  });

  // Load lifecycle rules
  const loadLifecycleRules = async () => {
    try {
      setLoading(true);
      setError(null);
      // TODO: Replace with actual API call
      // const response = await lifecycleService.getAll();
      // setLifecycleRules(response.items || []);
      
      // Mock data for now
      setLifecycleRules([
        {
          id: '1',
          name: 'Archive Old Studies',
          description: 'Archive studies older than 365 days',
          datastoreId: 'ds-1',
          datastoreName: 'Primary Datastore',
          status: 'ACTIVE',
          conditions: { ageInDays: 365 },
          actions: { transition: 'ARCHIVE', targetDatastore: 'archive-ds' },
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z'
        }
      ]);
    } catch (err) {
      setError('Failed to load lifecycle rules');
      console.error('Error loading lifecycle rules:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLifecycleRules();
  }, []);

  const handleCreate = () => {
    setFormData({
      name: '',
      description: '',
      datastoreId: '',
      status: 'ACTIVE',
      ageInDays: '',
      action: 'ARCHIVE',
      targetDatastore: ''
    });
    setShowCreateModal(true);
  };

  const handleEdit = (rule: LifecycleRule) => {
    setEditingRule(rule);
    setFormData({
      name: rule.name,
      description: rule.description || '',
      datastoreId: rule.datastoreId,
      status: rule.status,
      ageInDays: rule.conditions.ageInDays?.toString() || '',
      action: rule.actions.transition || 'ARCHIVE',
      targetDatastore: rule.actions.targetDatastore || ''
    });
    setShowEditModal(true);
  };

  const handleDelete = () => {
    setShowDeleteModal(true);
  };

  const confirmCreate = async () => {
    try {
      // TODO: Implement actual API call
      // await lifecycleService.create(formData);
      console.log('Creating lifecycle rule:', formData);
      setShowCreateModal(false);
      loadLifecycleRules();
    } catch (err) {
      console.error('Error creating lifecycle rule:', err);
    }
  };

  const confirmEdit = async () => {
    try {
      // TODO: Implement actual API call
      // await lifecycleService.update(editingRule.id, formData);
      console.log('Updating lifecycle rule:', editingRule?.id, formData);
      setShowEditModal(false);
      setEditingRule(null);
      loadLifecycleRules();
    } catch (err) {
      console.error('Error updating lifecycle rule:', err);
    }
  };

  const confirmDelete = async () => {
    try {
      // TODO: Implement actual API call
      // await Promise.all(selectedItems.map(item => lifecycleService.delete(item.id)));
      console.log('Deleting lifecycle rules:', selectedItems.map(item => item.id));
      setShowDeleteModal(false);
      setSelectedItems([]);
      loadLifecycleRules();
    } catch (err) {
      console.error('Error deleting lifecycle rules:', err);
    }
  };

  const tableColumns = [
    {
      id: 'name',
      header: 'Rule Name',
      cell: (item: LifecycleRule) => item.name,
      sortingField: 'name'
    },
    {
      id: 'datastore',
      header: 'Datastore',
      cell: (item: LifecycleRule) => item.datastoreName
    },
    {
      id: 'status',
      header: 'Status',
      cell: (item: LifecycleRule) => (
        <StatusIndicator type={item.status === 'ACTIVE' ? 'success' : 'stopped'}>
          {item.status}
        </StatusIndicator>
      )
    },
    {
      id: 'conditions',
      header: 'Conditions',
      cell: (item: LifecycleRule) => (
        <SpaceBetween direction="vertical" size="xs">
          {item.conditions.ageInDays && (
            <Badge>Age: {item.conditions.ageInDays} days</Badge>
          )}
        </SpaceBetween>
      )
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: (item: LifecycleRule) => (
        <Badge color={item.actions.transition === 'ARCHIVE' ? 'blue' : 'red'}>
          {item.actions.transition}
        </Badge>
      )
    },
    {
      id: 'description',
      header: 'Description',
      cell: (item: LifecycleRule) => item.description || '-'
    }
  ];

  return (
    <SpaceBetween direction="vertical" size="l">
      {error && (
        <Alert type="error" dismissible onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Table
        columnDefinitions={tableColumns}
        items={lifecycleRules}
        loading={loading}
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
        selectionType="multi"
        header={
          <Header
            counter={`(${lifecycleRules.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={handleCreate}>Create Rule</Button>
                <Button
                  onClick={() => handleEdit(selectedItems[0])}
                  disabled={selectedItems.length !== 1}
                >
                  Edit
                </Button>
                <Button
                  onClick={handleDelete}
                  disabled={selectedItems.length === 0}
                >
                  Delete
                </Button>
              </SpaceBetween>
            }
          >
            Lifecycle Rules
          </Header>
        }
        empty={
          <Box textAlign="center" color="inherit">
            <b>No lifecycle rules</b>
            <Box padding={{ bottom: "s" }} variant="p" color="inherit">
              No lifecycle rules found.
            </Box>
            <Button onClick={handleCreate}>Create Rule</Button>
          </Box>
        }
      />

      {/* Create Modal */}
      <Modal
        visible={showCreateModal}
        onDismiss={() => setShowCreateModal(false)}
        size="medium"
        header="Create Lifecycle Rule"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowCreateModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirmCreate}>
                Create
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          <FormField label="Rule Name" errorText={!formData.name ? "Name is required" : undefined}>
            <Input
              value={formData.name}
              onChange={({ detail }) => setFormData({ ...formData, name: detail.value })}
              placeholder="Enter rule name"
            />
          </FormField>
          
          <FormField label="Description">
            <Input
              value={formData.description}
              onChange={({ detail }) => setFormData({ ...formData, description: detail.value })}
              placeholder="Enter rule description"
            />
          </FormField>

          <FormField label="Status">
            <Select
              selectedOption={{ label: formData.status, value: formData.status }}
              onChange={({ detail }) => setFormData({ ...formData, status: detail.selectedOption?.value as 'ACTIVE' | 'INACTIVE' })}
              options={[
                { label: 'ACTIVE', value: 'ACTIVE' },
                { label: 'INACTIVE', value: 'INACTIVE' }
              ]}
            />
          </FormField>

          <FormField label="Age Condition (Days)">
            <Input
              type="number"
              value={formData.ageInDays}
              onChange={({ detail }) => setFormData({ ...formData, ageInDays: detail.value })}
              placeholder="Enter age in days"
            />
          </FormField>

          <FormField label="Action">
            <Select
              selectedOption={{ label: formData.action, value: formData.action }}
              onChange={({ detail }) => setFormData({ ...formData, action: detail.selectedOption?.value as 'ARCHIVE' | 'DELETE' })}
              options={[
                { label: 'ARCHIVE', value: 'ARCHIVE' },
                { label: 'DELETE', value: 'DELETE' }
              ]}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Edit Modal */}
      <Modal
        visible={showEditModal}
        onDismiss={() => setShowEditModal(false)}
        size="medium"
        header="Edit Lifecycle Rule"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowEditModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirmEdit}>
                Save Changes
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          <FormField label="Rule Name" errorText={!formData.name ? "Name is required" : undefined}>
            <Input
              value={formData.name}
              onChange={({ detail }) => setFormData({ ...formData, name: detail.value })}
              placeholder="Enter rule name"
            />
          </FormField>
          
          <FormField label="Description">
            <Input
              value={formData.description}
              onChange={({ detail }) => setFormData({ ...formData, description: detail.value })}
              placeholder="Enter rule description"
            />
          </FormField>

          <FormField label="Status">
            <Select
              selectedOption={{ label: formData.status, value: formData.status }}
              onChange={({ detail }) => setFormData({ ...formData, status: detail.selectedOption?.value as 'ACTIVE' | 'INACTIVE' })}
              options={[
                { label: 'ACTIVE', value: 'ACTIVE' },
                { label: 'INACTIVE', value: 'INACTIVE' }
              ]}
            />
          </FormField>

          <FormField label="Age Condition (Days)">
            <Input
              type="number"
              value={formData.ageInDays}
              onChange={({ detail }) => setFormData({ ...formData, ageInDays: detail.value })}
              placeholder="Enter age in days"
            />
          </FormField>

          <FormField label="Action">
            <Select
              selectedOption={{ label: formData.action, value: formData.action }}
              onChange={({ detail }) => setFormData({ ...formData, action: detail.selectedOption?.value as 'ARCHIVE' | 'DELETE' })}
              options={[
                { label: 'ARCHIVE', value: 'ARCHIVE' },
                { label: 'DELETE', value: 'DELETE' }
              ]}
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Delete Modal */}
      <Modal
        visible={showDeleteModal}
        onDismiss={() => setShowDeleteModal(false)}
        size="medium"
        header="Delete Lifecycle Rules"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirmDelete}>
                Delete
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween direction="vertical" size="l">
          <Alert type="warning">
            Are you sure you want to delete {selectedItems.length} lifecycle rule{selectedItems.length > 1 ? 's' : ''}?
            This action cannot be undone.
          </Alert>
          
          {selectedItems.map(rule => (
            <Box key={rule.id}>
              <strong>{rule.name}</strong> - {rule.datastoreName}
            </Box>
          ))}
        </SpaceBetween>
      </Modal>
    </SpaceBetween>
  );
};

export default LifecycleManagement;
