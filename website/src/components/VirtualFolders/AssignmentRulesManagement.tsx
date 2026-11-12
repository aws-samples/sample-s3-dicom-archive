import React, { useState, useEffect } from 'react';
import {
  Container,
  Header,
  Table,
  Box,
  SpaceBetween,
  Button,
  Modal,
  FormField,
  Input,
  Textarea,
  Multiselect,
  Toggle,
  Alert,
  Badge
} from '@cloudscape-design/components';
import { apiClient } from '../../services/apiClient';
import { ConditionEditor } from './ConditionEditor';

interface AssignmentRule {
  id: string;
  name: string;
  description: string;
  virtualFolderId: string;
  enabled: boolean;
  conditions: RuleCondition[];
  datastoreIds: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface RuleCondition {
  id?: string;
  attributeName: string;
  operator: string;
  value: string;
  valueEnd?: string;
  attributeVr?: string;
  logicOperator: string;
  isExclusion: boolean;
}

interface AssignmentRulesProps {
  virtualFolderId: string;
  onClose: () => void;
}

export const AssignmentRulesManagement: React.FC<AssignmentRulesProps> = ({ virtualFolderId, onClose }) => {
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [datastores, setDatastores] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [editingRule, setEditingRule] = useState<AssignmentRule | null>(null);
  const [deletingRule, setDeletingRule] = useState<AssignmentRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Form state
  const [ruleName, setRuleName] = useState('');
  const [ruleDescription, setRuleDescription] = useState('');
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [ruleConditions, setRuleConditions] = useState<RuleCondition[]>([
    { attributeName: '', operator: 'EQUALS', value: '', logicOperator: 'AND', isExclusion: false }
  ]);
  const [selectedDatastores, setSelectedDatastores] = useState<any[]>([]);

  // Dry-run match count for the rule currently being edited.
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Attributes/operators the indexer actually honors when translating a rule to a
  // WHERE over storage_index. Anything outside this set is silently ignored by the
  // indexer (it narrows nothing), so surfacing it here prevents no-op rules.
  // Attributes the ingest matcher + preview-count honor (see s3-ingest
  // _VF_RULE_ATTR_TAG and assignment-rules-api preview-count ATTR_COL). Custom
  // index attributes referenced by their raw d<GGGGEEEE> column are also honored.
  const INDEXER_ATTRIBUTES = [
    'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'ContentKind',
    'SOPClassUID', 'Modality', 'SeriesDescription', 'StudyDescription',
    'StudyDate', 'AccessionNumber', 'PatientID', 'PatientName',
  ];
  const INDEXER_OPERATORS = ['EQUALS', '=', 'CONTAINS', 'LIKE', 'IN', 'IN_LIST'];
  const isDTag = (n?: string) => /^d[0-9a-fA-F]{8}$/.test(String(n || ''));
  const usesUnsupported = ruleConditions.some(
    c => c.attributeName && (
      (!INDEXER_ATTRIBUTES.includes(c.attributeName) && !isDTag(c.attributeName)) ||
      !INDEXER_OPERATORS.includes((c.operator || '').toUpperCase())
    )
  );

  const handlePreviewCount = async () => {
    setPreviewing(true);
    setPreviewError(null);
    setPreviewCount(null);
    try {
      const resp = await apiClient.previewAssignmentRuleCount(virtualFolderId, {
        conditions: ruleConditions.filter(c => c.attributeName && c.value),
        datastoreIds: selectedDatastores.map(ds => ds.value)
      });
      if (resp.success && resp.data) {
        setPreviewCount(resp.data.matchCount);
      } else {
        setPreviewError('Preview unavailable');
      }
    } catch (err: any) {
      setPreviewError(err.message || 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  useEffect(() => {
    loadRules();
    loadDatastores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualFolderId]);

  const loadRules = async () => {
    try {
      setLoading(true);
      const response = await apiClient.get(`/virtual-folders/${virtualFolderId}/assignment-rules`);
      if (response.success) {
        setRules(response.data || []);
      }
    } catch (err) {
      setError('Failed to load assignment rules');
    } finally {
      setLoading(false);
    }
  };

  const loadDatastores = async () => {
    try {
      const response = await apiClient.getDatastores({ page: 1, pageSize: 100 });
      if (response.success && response.data) {
        setDatastores(response.data.items || []);
      }
    } catch (err) {
      console.error('Failed to load datastores:', err);
    }
  };

  const handleCreate = () => {
    setEditingRule(null);
    setRuleName('');
    setRuleDescription('');
    setRuleEnabled(true);
    setRuleConditions([{ attributeName: '', operator: 'EQUALS', value: '', logicOperator: 'AND', isExclusion: false }]);
    setSelectedDatastores([]);
    setPreviewCount(null);
    setPreviewError(null);
    setShowModal(true);
  };

  const handleEdit = (rule: AssignmentRule) => {
    setEditingRule(rule);
    setRuleName(rule.name);
    setRuleDescription(rule.description);
    setRuleEnabled(rule.enabled);
    setRuleConditions(rule.conditions.length > 0 ? rule.conditions : [{ attributeName: '', operator: 'EQUALS', value: '', logicOperator: 'AND', isExclusion: false }]);
    setSelectedDatastores(
      datastores.filter(ds => rule.datastoreIds.includes(ds.id)).map(ds => ({ label: ds.name, value: ds.id }))
    );
    setPreviewCount(null);
    setPreviewError(null);
    setShowModal(true);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      const data = {
        name: ruleName,
        description: ruleDescription,
        enabled: ruleEnabled,
        conditions: ruleConditions.filter(c => c.attributeName && c.value),
        datastoreIds: selectedDatastores.map(ds => ds.value)
      };

      if (editingRule) {
        await apiClient.put(`/virtual-folders/${virtualFolderId}/assignment-rules/${editingRule.id}`, data);
      } else {
        await apiClient.post(`/virtual-folders/${virtualFolderId}/assignment-rules`, data);
      }

      setShowModal(false);
      loadRules();
    } catch (err: any) {
      setError(err.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingRule) return;

    try {
      setDeleting(true);
      await apiClient.delete(`/virtual-folders/${virtualFolderId}/assignment-rules/${deletingRule.id}`);
      setShowDeleteModal(false);
      setDeletingRule(null);
      loadRules();
    } catch (err) {
      setError('Failed to delete rule');
    } finally {
      setDeleting(false);
    }
  };

  const addCondition = (isExclusion: boolean) => {
    setRuleConditions([...ruleConditions, { attributeName: '', operator: 'EQUALS', value: '', logicOperator: 'AND', isExclusion }]);
  };

  const removeCondition = (index: number) => {
    setRuleConditions(ruleConditions.filter((_, i) => i !== index));
  };

  const updateCondition = (index: number, condition: RuleCondition) => {
    const updated = [...ruleConditions];
    updated[index] = condition;
    setRuleConditions(updated);
  };

  const inclusionConditions = ruleConditions.filter(c => !c.isExclusion);
  const exclusionConditions = ruleConditions.filter(c => c.isExclusion);

  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={loadRules}>Refresh</Button>
              <Button variant="primary" onClick={handleCreate}>Create Rule</Button>
            </SpaceBetween>
          }
        >
          Assignment Rules
        </Header>
      }
    >
      {error && <Alert type="error" dismissible onDismiss={() => setError(null)}>{error}</Alert>}
      
      <Table
        loading={loading}
        items={rules}
        columnDefinitions={[
          {
            id: 'name',
            header: 'Name',
            cell: (item) => item.name
          },
          {
            id: 'conditions',
            header: 'Conditions',
            cell: (item) => {
              const inc = item.conditions.filter(c => !c.isExclusion).length;
              const exc = item.conditions.filter(c => c.isExclusion).length;
              return `${inc} inclusion, ${exc} exclusion`;
            }
          },
          {
            id: 'datastores',
            header: 'Datastores',
            cell: (item) => item.datastoreIds.length === 0 ? 'All' : `${item.datastoreIds.length} selected`
          },
          {
            id: 'enabled',
            header: 'Status',
            cell: (item) => <Badge color={item.enabled ? 'green' : 'grey'}>{item.enabled ? 'Enabled' : 'Disabled'}</Badge>
          },
          {
            id: 'actions',
            header: 'Actions',
            cell: (item) => (
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => handleEdit(item)}>Edit</Button>
                <Button onClick={() => {
                  setDeletingRule(item);
                  setShowDeleteModal(true);
                }}>Delete</Button>
              </SpaceBetween>
            )
          }
        ]}
        empty={
          <Box textAlign="center">
            <b>No assignment rules</b>
            <Box padding={{ bottom: 's' }}>Create a rule to automatically assign studies to this virtual folder.</Box>
            <Button onClick={handleCreate}>Create Rule</Button>
          </Box>
        }
      />

      <Modal
        visible={showModal}
        onDismiss={() => setShowModal(false)}
        header={editingRule ? 'Edit Assignment Rule' : 'Create Assignment Rule'}
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSave} loading={saving}>Save</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          <Alert type="info" header="How this rule is materialized">
            This virtual folder is a rule-based index over your storages. On save, the indexer
            evaluates each enabled rule against your storages across the selected datastores and
            materializes the matching DICOM objects into the folder. You can match on{' '}
            <strong>any DICOM attribute</strong> — pick it from the dictionary in each condition
            (e.g. Modality, Study Description, Accession Number, Patient ID) — as well as any{' '}
            <strong>custom index attribute</strong> you have configured. Operators:{' '}
            <strong>Equals, Contains/Like, and In-list</strong>. Use “Preview match count” to see how
            many objects a rule matches before saving.
          </Alert>
          {usesUnsupported && (
            <Alert type="warning">
              One or more conditions use an operator that isn’t supported yet (only Equals,
              Contains/Like and In-list are honored). Those conditions will be ignored during
              materialization — adjust the operator, or use “Preview match count” to confirm the
              rule matches what you expect.
            </Alert>
          )}
          <FormField label="Rule Name">
            <Input value={ruleName} onChange={({ detail }) => setRuleName(detail.value)} />
          </FormField>

          <FormField label="Description">
            <Textarea value={ruleDescription} onChange={({ detail }) => setRuleDescription(detail.value)} />
          </FormField>

          <FormField label="Enabled">
            <Toggle checked={ruleEnabled} onChange={({ detail }) => setRuleEnabled(detail.checked)}>
              Rule is {ruleEnabled ? 'enabled' : 'disabled'}
            </Toggle>
          </FormField>

          <FormField 
            label="Inclusion Conditions" 
            description="Studies must match these conditions to be assigned to this virtual folder"
          >
            <SpaceBetween size="s">
              {inclusionConditions.map((condition, index) => {
                const globalIndex = ruleConditions.indexOf(condition);
                return (
                  <ConditionEditor
                    key={globalIndex}
                    condition={condition}
                    onChange={(updated) => updateCondition(globalIndex, updated)}
                    onRemove={() => removeCondition(globalIndex)}
                    showLogicOperator={index > 0}
                  />
                );
              })}
              <Button iconName="add-plus" onClick={() => addCondition(false)}>Add Inclusion Condition</Button>
            </SpaceBetween>
          </FormField>

          <FormField 
            label="Exclusion Conditions" 
            description="Studies matching these conditions will NOT be assigned, even if inclusion conditions match"
          >
            <SpaceBetween size="s">
              {exclusionConditions.map((condition, index) => {
                const globalIndex = ruleConditions.indexOf(condition);
                return (
                  <ConditionEditor
                    key={globalIndex}
                    condition={condition}
                    onChange={(updated) => updateCondition(globalIndex, updated)}
                    onRemove={() => removeCondition(globalIndex)}
                    showLogicOperator={index > 0}
                  />
                );
              })}
              <Button iconName="add-plus" onClick={() => addCondition(true)}>Add Exclusion Condition</Button>
            </SpaceBetween>
          </FormField>

          <FormField label="Datastores" description="Source storages this rule scopes to. A rule with no datastores selected matches nothing — pick at least one.">
            <Multiselect
              selectedOptions={selectedDatastores}
              onChange={({ detail }) => { setSelectedDatastores([...detail.selectedOptions]); setPreviewCount(null); }}
              options={datastores.map(ds => ({ label: ds.name, value: ds.id }))}
              placeholder="Select source storages"
            />
          </FormField>

          <FormField
            label="Preview match count"
            description="Dry-run: how many DICOM objects this rule matches right now across the selected storages. Does not save or change the folder."
          >
            <SpaceBetween size="xs" direction="horizontal">
              <Button
                iconName="search"
                loading={previewing}
                disabled={selectedDatastores.length === 0}
                onClick={handlePreviewCount}
              >
                Preview match count
              </Button>
              {previewCount !== null && !previewError && (
                <Box variant="strong" padding={{ top: 'xxs' }}>
                  {previewCount.toLocaleString()} object{previewCount === 1 ? '' : 's'} match
                </Box>
              )}
              {previewError && (
                <Box color="text-status-error" padding={{ top: 'xxs' }}>{previewError}</Box>
              )}
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={showDeleteModal}
        onDismiss={() => {
          setShowDeleteModal(false);
          setDeletingRule(null);
        }}
        header="Delete Assignment Rule"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => {
                setShowDeleteModal(false);
                setDeletingRule(null);
              }}>Cancel</Button>
              <Button variant="primary" onClick={handleDelete} loading={deleting}>Delete</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <Box>
          Are you sure you want to delete the assignment rule <strong>{deletingRule?.name}</strong>? This action cannot be undone.
        </Box>
      </Modal>
    </Container>
  );
};
