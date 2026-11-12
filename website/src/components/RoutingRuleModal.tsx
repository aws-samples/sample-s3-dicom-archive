import React, { useState, useEffect } from 'react';
import {
  Modal, Box, SpaceBetween, FormField, Input, Select, Button, Toggle,
  Container, Header, ColumnLayout, Textarea, Autosuggest, Alert, RadioGroup
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';

interface RoutingRuleModalProps {
  visible: boolean;
  onDismiss: () => void;
  onSuccess: () => void;
  rule?: any;
  defaultInterfaceId?: string;
}

interface Condition {
  dicomTag: string;
  dicomName: string;
  dicomVr?: string;
  operator: string;
  value: string;
  logic?: 'AND' | 'OR';
}

const STRING_OPERATORS = [
  { label: 'Equals', value: 'EQUALS' },
  { label: 'Not Equals', value: 'NOT_EQUALS' },
  { label: 'Contains', value: 'CONTAINS' },
  { label: 'Not Contains', value: 'NOT_CONTAINS' },
  { label: 'Starts With', value: 'STARTS_WITH' },
  { label: 'Ends With', value: 'ENDS_WITH' },
  { label: 'Exists', value: 'EXISTS' },
  { label: 'Not Exists', value: 'NOT_EXISTS' }
];

const DATE_OPERATORS = [
  { label: 'Equals', value: 'EQUALS' },
  { label: 'Not Equals', value: 'NOT_EQUALS' },
  { label: 'Before', value: 'BEFORE' },
  { label: 'After', value: 'AFTER' },
  { label: 'Between', value: 'BETWEEN' },
  { label: 'Last N Days', value: 'LAST_N_DAYS' },
  { label: 'Exists', value: 'EXISTS' },
  { label: 'Not Exists', value: 'NOT_EXISTS' }
];

const getOperatorsForVR = (vr: string) => {
  if (vr === 'DA' || vr === 'DT') {
    return DATE_OPERATORS;
  }
  return STRING_OPERATORS;
};

export const RoutingRuleModal: React.FC<RoutingRuleModalProps> = ({
  visible,
  onDismiss,
  onSuccess,
  rule,
  defaultInterfaceId
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [interfaceId, setInterfaceId] = useState<any>(null);
  const [enabled, setEnabled] = useState(true);
  const [datastoreId, setDatastoreId] = useState<any>(null);
  const [conditions, setConditions] = useState<Condition[]>([]);
  
  const [interfaces, setInterfaces] = useState<any[]>([]);
  const [datastores, setDatastores] = useState<any[]>([]);
  const [accessibleDatastores, setAccessibleDatastores] = useState<any[]>([]);
  const [dicomTags, setDicomTags] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      loadData();
    }
  }, [visible]);

  // Separate useEffect to handle rule loading after data is loaded
  useEffect(() => {
    if (visible && rule && datastores.length > 0 && interfaces.length > 0) {
      setName(rule.name);
      setDescription(rule.description || '');
      
      // Find interface by ID and use its name
      const selectedInterface = interfaces.find(i => i.id === rule.interfaceId);
      if (selectedInterface) {
        setInterfaceId({ label: selectedInterface.interfaceName, value: selectedInterface.id });
      }
      
      setEnabled(rule.enabled);
      
      // Find datastore by ID and use its name
      const selectedDatastore = datastores.find(d => d.id === rule.action?.datastoreId);
      if (selectedDatastore) {
        setDatastoreId({ label: selectedDatastore.name, value: selectedDatastore.id });
      }
      
      setConditions(rule.conditions?.conditions || []);
      
      // Load accessible datastores for the selected interface
      if (rule.interfaceId) {
        loadAccessibleDatastores(rule.interfaceId);
      }
    } else if (visible && !rule && interfaces.length > 0) {
      resetForm();
      // Set default interface if provided
      if (defaultInterfaceId) {
        const defaultInterface = interfaces.find(i => i.id === defaultInterfaceId);
        if (defaultInterface) {
          setInterfaceId({ label: defaultInterface.interfaceName, value: defaultInterface.id });
          loadAccessibleDatastores(defaultInterfaceId);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rule, datastores, interfaces, defaultInterfaceId]);

  const loadData = async () => {
    try {
      const [interfacesRes, datastoresRes, tagsRes] = await Promise.all([
        apiClient.getDicomInterfaces(),
        apiClient.getDatastores(),
        apiClient.getDicomTags()
      ]);
      
      setInterfaces((interfacesRes as any).data?.items || []);
      setDatastores((datastoresRes as any).data?.items || []);
      const allTags = (tagsRes as any).data?.dicom_attributes || [];
      const filteredTags = allTags
        .filter((tag: any) => ['patient', 'study', 'series'].includes(tag.level))
        .sort((a: any, b: any) => a.tag.localeCompare(b.tag));
      setDicomTags(filteredTags);
    } catch (error) {
      console.error('Failed to load data:', error.message);
    }
  };

  const loadAccessibleDatastores = async (interfaceId: string) => {
    try {
      const response = await apiClient.getDicomInterface(interfaceId);
      if (response.success && response.data) {
        const accessibleIds = response.data.accessibleDatastores || [];
        const accessible = datastores.filter(ds => 
          accessibleIds.includes(ds.id) && ds.status === 'ACTIVE'
        );
        setAccessibleDatastores(accessible);
        
        // Reset datastore selection if current selection is not accessible
        if (datastoreId && !accessibleIds.includes(datastoreId.value)) {
          setDatastoreId(null);
        }
      }
    } catch (error) {
      console.error('Failed to load accessible datastores:', error.message);
      setAccessibleDatastores([]);
    }
  };

  const handleInterfaceChange = (selectedInterface: any) => {
    setInterfaceId(selectedInterface);
    if (selectedInterface?.value) {
      loadAccessibleDatastores(selectedInterface.value);
    } else {
      setAccessibleDatastores([]);
      setDatastoreId(null);
    }
  };

  const resetForm = () => {
    setName('');
    setDescription('');
    setInterfaceId(null);
    setEnabled(true);
    setDatastoreId(null);
    setAccessibleDatastores([]);
    setConditions([]);
    setError(null);
  };

  const addCondition = () => {
    setConditions([...conditions, {
      dicomTag: '',
      dicomName: '',
      operator: 'EQUALS',
      value: '',
      logic: conditions.length > 0 ? 'AND' : undefined
    }]);
  };

  const updateCondition = (index: number, field: string, value: any) => {
    const updated = [...conditions];
    if (field === 'tag') {
      const tag = dicomTags.find(t => t.tag === value || t.name === value);
      if (tag) {
        updated[index].dicomTag = tag.tag;
        updated[index].dicomName = tag.name;
        updated[index].dicomVr = tag.vr;
      } else {
        updated[index].dicomTag = value;
        updated[index].dicomName = value;
        updated[index].dicomVr = undefined;
      }
    } else {
      (updated[index] as any)[field] = value;
    }
    setConditions(updated);
  };

  const removeCondition = (index: number) => {
    setConditions(conditions.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    setError(null);
    
    if (!name || !interfaceId || !datastoreId) {
      setError('Please fill in all required fields');
      return;
    }

    setLoading(true);
    try {
      const data = {
        name,
        description,
        interfaceId: interfaceId.value,
        priority: rule ? rule.priority : 100,
        enabled,
        conditions: {
          conditions: conditions.filter(c => c.dicomTag && c.operator)
        },
        action: {
          type: 'STORE',
          datastoreId: datastoreId.value
        }
      };

      if (rule) {
        await apiClient.updateRoutingRule(rule.id, data);
      } else {
        await apiClient.createRoutingRule(data);
      }

      onSuccess();
      onDismiss();
      resetForm();
    } catch (err: any) {
      console.error('Failed to save rule:', err);
      setError(err.message || 'Failed to save rule');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      header={rule ? 'Edit Routing Rule' : 'Create Routing Rule'}
      size="large"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} loading={loading}>
              {rule ? 'Update' : 'Create'}
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {error && (
          <Alert type="error" dismissible onDismiss={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Container header={<Header variant="h2">Basic Information</Header>}>
          <SpaceBetween size="m">
            <FormField label="Rule Name" stretch>
              <Input value={name} onChange={({ detail }) => setName(detail.value)} />
            </FormField>

            <FormField label="Description" stretch>
              <Textarea value={description} onChange={({ detail }) => setDescription(detail.value)} />
            </FormField>

            <ColumnLayout columns={2}>
              <FormField label="Interface">
                <Select
                  selectedOption={interfaceId}
                  onChange={({ detail }) => handleInterfaceChange(detail.selectedOption)}
                  options={(interfaces || []).map(i => ({ label: i.interfaceName, value: i.id }))}
                  placeholder="Select interface"
                />
              </FormField>

              <FormField label="Enabled">
                <Toggle checked={enabled} onChange={({ detail }) => setEnabled(detail.checked)} />
              </FormField>
            </ColumnLayout>
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">Conditions (Optional)</Header>}>
          <SpaceBetween size="m">
            {conditions.map((condition, index) => (
              <SpaceBetween key={index} size="s">
                {index > 0 && (
                  <Box textAlign="center" padding={{ vertical: 's' }}>
                    <Select
                      selectedOption={{ label: condition.logic || 'AND', value: condition.logic || 'AND' }}
                      onChange={({ detail }) => {
                        const updated = [...conditions];
                        updated[index].logic = detail.selectedOption.value as 'AND' | 'OR';
                        setConditions(updated);
                      }}
                      options={[
                        { label: 'AND', value: 'AND' },
                        { label: 'OR', value: 'OR' }
                      ]}
                    />
                  </Box>
                )}
                <Container>
                  <SpaceBetween size="s">
                    <FormField label="DICOM Tag">
                      <Autosuggest
                        value={condition.dicomName || condition.dicomTag}
                        onChange={({ detail }) => updateCondition(index, 'tag', detail.value)}
                        options={(dicomTags || []).map(t => ({ value: t.tag, label: `${t.tag} - ${t.name}` }))}
                        placeholder="Search by tag or name..."
                        enteredTextLabel={value => `Use: "${value}"`}
                        filteringType="auto"
                      />
                    </FormField>

                    <ColumnLayout columns={2}>
                      <FormField label="Operator">
                        <Select
                          selectedOption={getOperatorsForVR(condition.dicomVr || '').find(o => o.value === condition.operator) || getOperatorsForVR(condition.dicomVr || '')[0]}
                          onChange={({ detail }) => updateCondition(index, 'operator', detail.selectedOption.value)}
                          options={getOperatorsForVR(condition.dicomVr || '')}
                        />
                      </FormField>

                      <FormField label="Value">
                        <Input
                          value={condition.value}
                          onChange={({ detail }) => updateCondition(index, 'value', detail.value)}
                          disabled={condition.operator === 'EXISTS' || condition.operator === 'NOT_EXISTS'}
                        />
                      </FormField>
                    </ColumnLayout>

                    <Button onClick={() => removeCondition(index)} variant="link">
                      Remove Condition
                    </Button>
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ))}

            <Button onClick={addCondition} iconName="add-plus">
              Add Condition
            </Button>
          </SpaceBetween>
        </Container>

        <Container header={<Header variant="h2">Action</Header>}>
          <FormField label="Destination Datastore">
            <Select
              selectedOption={datastoreId}
              onChange={({ detail }) => setDatastoreId(detail.selectedOption)}
              options={accessibleDatastores.map(d => ({ label: d.name, value: d.id }))}
              placeholder={interfaceId ? "Select datastore" : "Select interface first"}
              disabled={!interfaceId || accessibleDatastores.length === 0}
            />
          </FormField>
        </Container>
      </SpaceBetween>
    </Modal>
  );
};

export default RoutingRuleModal;
