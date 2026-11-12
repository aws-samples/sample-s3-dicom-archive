import React, { useState, useEffect } from 'react';
import { formatTimestampDate } from '../utils/dateUtils';
import { usePrivileges } from '../hooks/usePrivileges';
import {
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
  Select,
  Alert,
  RadioGroup
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { AssignmentRulesManagement } from './VirtualFolders/AssignmentRulesManagement';

interface VirtualFolder {
  id: string;
  name: string;
  description?: string;
  status: 'ACTIVE' | 'DISABLED' | 'DELETING';
  deidentificationConfig?: {
    enabled: boolean;
    hashSalt?: string;
    attributes?: Array<{ tag: string; name: string; action: string }>;
  };
  writeMode?: 'NONE' | 'EXISTING' | 'DEDICATED';
  writeDatastoreId?: string;
  writeDatastoreName?: string;
  writeDatastoreStatus?: string;
  patientCount?: number;
  studyCount?: number;
  seriesCount?: number;
  instanceCount?: number;
  createdAt: string;
  createdBy: string;
}

interface AssignmentRule {
  id: string;
  virtualFolderId: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  conditions: Array<{ attribute: string; operator: string; value: string }>;
}

const DEFAULT_DEIDENT_ATTRIBUTES = [
  { tag: '00100010', name: 'PatientName', action: 'hash' },
  { tag: '00100020', name: 'PatientID', action: 'hash' },
  { tag: '00100030', name: 'PatientBirthDate', action: 'remove' },
  { tag: '00080050', name: 'AccessionNumber', action: 'hash' },
  { tag: '00080090', name: 'ReferringPhysicianName', action: 'remove' },
  { tag: '00081070', name: 'OperatorsName', action: 'remove' },
];

const VirtualFolderManagement: React.FC = () => {
  // The server checks the same two rules (virtual-folder-api): a folder may only
  // write to a storage the user can store into, and only a user who may create
  // storages can give it a dedicated one.
  const { hasDatastoreAccess, hasManagementAccess } = usePrivileges();
  const canCreateStorage = hasManagementAccess('datastores', 'canEdit');
  const [datastores, setDatastores] = useState<VirtualFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [selectedItems, setSelectedItems] = useState<VirtualFolder[]>([]);
  const [filterText, setFilterText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  
  // Datastore modal state
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [saving, setSaving] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  
  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formDeidentEnabled, setFormDeidentEnabled] = useState(false);
  const [formAttributes, setFormAttributes] = useState(DEFAULT_DEIDENT_ATTRIBUTES);
  const [formIndexingProfileId, setFormIndexingProfileId] = useState<string>('');
  const [formDeidProfileId, setFormDeidProfileId] = useState<string>('');
  const [indexingProfiles, setIndexingProfiles] = useState<any[]>([]);
  const [deidProfiles, setDeidProfiles] = useState<any[]>([]);

  // Write mode state
  const [formWriteMode, setFormWriteMode] = useState<string>('NONE');
  const [formWriteDatastoreId, setFormWriteDatastoreId] = useState<string>('');
  const [availableDatastores, setAvailableDatastores] = useState<any[]>([]);
  // false until the first /datastores answer, so the form does not claim
  // "no storage" while the list is still loading.
  const [datastoresLoaded, setDatastoresLoaded] = useState(false);

  const validateVirtualFolderName = (name: string): string | undefined => {
    if (!name.trim()) return 'Name is required';
    if (!/^[A-Za-z0-9._\- ]{1,28}$/.test(name)) return 'Name must be 1-28 characters: letters, numbers, dots, hyphens, underscores, and spaces';
    return undefined;
  };

  // Rules state
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [ruleModalMode, setRuleModalMode] = useState<'create' | 'edit'>('create');
  const [selectedRule, setSelectedRule] = useState<AssignmentRule | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [ruleSaving, setRuleSaving] = useState(false);
  
  // Rule form state
  const [ruleName, setRuleName] = useState('');
  const [ruleDescription, setRuleDescription] = useState('');
  const [ruleEnabled, setRuleEnabled] = useState(true);

  const loadDatastores = async () => {
    try {
      setLoading(true);
      const response = await apiClient.getVirtualFolders({ page: currentPage, pageSize: 20 });
      if (response.success && response.data) {
        setDatastores(response.data.items || []);
        setTotalPages(response.data.totalPages || 1);
      }
    } catch (err) {
      console.error('Error loading virtual datastores:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDatastores();
    loadProfiles(); // Load profiles on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  // Clear selections when filter changes
  useEffect(() => {
    setSelectedItems([]);
  }, [filterText]);

  // Clear selections on manual refresh (keep only items still in list)
  useEffect(() => {
    setSelectedItems(prev => 
      prev.filter(selected => 
        datastores.some(item => item.id === selected.id)
      )
    );
  }, [datastores]);

  const [rulePriority, setRulePriority] = useState(0);
  const [ruleConditions, setRuleConditions] = useState<Array<{ attribute: string; operator: string; value: string }>>([]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const loadProfiles = async () => {
    try {
      const [indexing, deid] = await Promise.all([
        apiClient.get('/virtual-folders/indexing-profiles'),
        apiClient.get('/virtual-folders/deid-profiles')
      ]);
      setIndexingProfiles(indexing.data || []);
      setDeidProfiles(deid.data || []);
    } catch (error) {
      console.error('Error loading profiles:', error.message);
    }
  };

  const loadAvailableDatastores = async () => {
    try {
      const response = await apiClient.get('/datastores');
      const items = response?.data?.items || [];
      setAvailableDatastores(items.filter((d: any) => d.status === 'ACTIVE'));
    } catch (error) {
      console.error('Error loading datastores:', error.message);
    } finally {
      setDatastoresLoaded(true);
    }
  };

  const loadRules = async (virtualFolderId: string) => {
    setRulesLoading(true);
    try {
      const response = await apiClient.getVirtualFolderRules(virtualFolderId);
      if (response.success && response.data) {
        setRules(response.data);
      }
    } catch (err) {
      console.error('Error loading rules:', err);
    } finally {
      setRulesLoading(false);
    }
  };

  const openCreateModal = () => {
    setModalMode('create');
    setFormName('');
    setFormDescription('');
    setFormDeidentEnabled(false);
    setFormAttributes(DEFAULT_DEIDENT_ATTRIBUTES);
    setFormIndexingProfileId('default-full-index');
    setFormDeidProfileId('');
    setFormWriteMode('NONE');
    setFormWriteDatastoreId('');
    loadAvailableDatastores();
    setShowModal(true);
  };

  const openEditModal = (ds: VirtualFolder) => {
    setModalMode('edit');
    setFormName(ds.name);
    setFormDescription(ds.description || '');
    setFormDeidentEnabled(ds.deidentificationConfig?.enabled || false);
    setFormAttributes(ds.deidentificationConfig?.attributes || DEFAULT_DEIDENT_ATTRIBUTES);
    setFormIndexingProfileId((ds as any).indexing_profile_id || (ds as any).indexingProfileId || 'default-full-index');
    setFormDeidProfileId((ds as any).deid_profile_id || (ds as any).deidProfileId || '');
    setFormWriteMode((ds as any).writeMode || (ds as any).write_mode || 'NONE');
    setFormWriteDatastoreId((ds as any).writeDatastoreId || (ds as any).write_datastore_id || '');
    loadAvailableDatastores();
    setSelectedItems([ds]);
    setShowModal(true);
  };

  const openRulesModal = (ds: VirtualFolder) => {
    setSelectedItems([ds]);
    loadRules(ds.id);
    setShowRulesModal(true);
  };

  const handleResync = async (ds: VirtualFolder) => {
    setResyncing(true);
    setResyncMsg(null);
    try {
      const resp = await apiClient.resyncVirtualFolder(ds.id);
      setResyncMsg({ type: 'success', text: resp.data?.message || `Re-sync started for '${ds.name}'.` });
    } catch (err: any) {
      setResyncMsg({ type: 'error', text: err.response?.data?.error?.message || err.message || 'Re-sync failed' });
    } finally {
      setResyncing(false);
    }
  };

  const openCreateRuleModal = () => {
    setRuleModalMode('create');
    setRuleName('');
    setRuleDescription('');
    setRuleEnabled(true);
    setRulePriority(rules.length);
    setRuleConditions([{ attribute: 'Modality', operator: '=', value: '' }]);
    setShowRuleModal(true);
  };

  const openEditRuleModal = (rule: AssignmentRule) => {
    setRuleModalMode('edit');
    setSelectedRule(rule);
    setRuleName(rule.name);
    setRuleDescription(rule.description || '');
    setRuleEnabled(rule.enabled);
    setRulePriority(rule.priority);
    setRuleConditions(rule.conditions || []);
    setShowRuleModal(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: any = {
        name: formName,
        description: formDescription || undefined,
        indexingProfileId: formIndexingProfileId || undefined,
        deidProfileId: formDeidProfileId || undefined,
        deidentificationConfig: { enabled: formDeidentEnabled, attributes: formAttributes },
        writeMode: formWriteMode,
      };
      if (formWriteMode === 'EXISTING') payload.writeDatastoreId = formWriteDatastoreId;
      if (modalMode === 'create') {
        const resp = await apiClient.createVirtualFolder(payload);
        setShowModal(false);
        await loadDatastores();
        // Guided next step: a VF is only useful once it has assignment rules, so
        // drop the user straight into the rules editor for the folder just made.
        const createdId = (resp as any)?.data?.id;
        if (createdId) {
          setSelectedItems([{ id: createdId, name: formName } as VirtualFolder]);
          loadRules(createdId);
          setShowRulesModal(true);
        }
        return;
      } else {
        await apiClient.updateVirtualFolder(selectedItems[0].id, payload);
      }
      setShowModal(false);
      if (modalMode === 'edit') setSelectedItems([]);
      loadDatastores();
    } catch (err) {
      console.error('Error saving virtual folder:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      for (const item of selectedItems) {
        await apiClient.deleteVirtualFolder(item.id);
      }
      setShowDeleteModal(false);
      setSelectedItems([]);
      loadDatastores();
    } catch (err) {
      console.error('Error deleting virtual datastore:', err);
    } finally {
      setDeleting(false);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleSaveRule = async () => {
    if (!selectedItems[0]) return;
    setRuleSaving(true);
    try {
      const payload = { name: ruleName, description: ruleDescription, enabled: ruleEnabled, priority: rulePriority, conditions: ruleConditions };
      if (ruleModalMode === 'create') {
        await apiClient.createVirtualFolderRule(selectedItems[0].id, payload);
      } else if (selectedRule) {
        await apiClient.updateVirtualFolderRule(selectedItems[0].id, selectedRule.id, payload);
      }
      setShowRuleModal(false);
      loadRules(selectedItems[0].id);
    } catch (err) {
      console.error('Error saving rule:', err);
    } finally {
      setRuleSaving(false);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!selectedItems[0]) return;
    try {
      await apiClient.deleteVirtualFolderRule(selectedItems[0].id, ruleId);
      loadRules(selectedItems[0].id);
    } catch (err) {
      console.error('Error deleting rule:', err);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const addCondition = () => {
    setRuleConditions([...ruleConditions, { attribute: 'Modality', operator: '=', value: '' }]);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const removeCondition = (index: number) => {
    setRuleConditions(ruleConditions.filter((_, i) => i !== index));
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const updateCondition = (index: number, field: string, value: string) => {
    const updated = [...ruleConditions];
    updated[index] = { ...updated[index], [field]: value };
    setRuleConditions(updated);
  };

  const storableDatastores = availableDatastores.filter(d => hasDatastoreAccess(d.id, 'canStore'));
  const editingItem = modalMode === 'edit' ? (selectedItems[0] as any) : null;
  const keepsDedicated = !!(editingItem && (editingItem.writeMode || editingItem.write_mode) === 'DEDICATED' && editingItem.writeDatastoreId);
  const filteredDatastores = datastores.filter(ds => ds.name.toLowerCase().includes(filterText.toLowerCase()));

  return (
    <>
      <SpaceBetween size="l">
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="normal" iconName="refresh" onClick={() => { setIsManualRefresh(true); loadDatastores().finally(() => setIsManualRefresh(false)); }} loading={isManualRefresh && loading}>Refresh</Button>
              <Button variant="primary" onClick={openCreateModal}>Create</Button>
            </SpaceBetween>
          }
        >
          Virtual Folders
        </Header>
        {resyncMsg && (
          <Alert type={resyncMsg.type} dismissible onDismiss={() => setResyncMsg(null)}>{resyncMsg.text}</Alert>
        )}
        
        <Table
          header={
            <Header
              counter={`(${filteredDatastores.length})`}
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={() => selectedItems[0] && openRulesModal(selectedItems[0])} disabled={selectedItems.length !== 1}>Rules</Button>
                  <Button iconName="refresh" loading={resyncing} onClick={() => selectedItems[0] && handleResync(selectedItems[0])} disabled={selectedItems.length !== 1}>Re-sync</Button>
                  <Button onClick={() => selectedItems[0] && openEditModal(selectedItems[0])} disabled={selectedItems.length !== 1}>Edit</Button>
                  <Button onClick={() => setShowDeleteModal(true)} disabled={selectedItems.length === 0}>Delete</Button>
                </SpaceBetween>
              }
            />
          }
          loading={loading}
          loadingText="Loading virtual datastores..."
          items={filteredDatastores}
          selectedItems={selectedItems}
          onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
          selectionType="multi"
          trackBy="id"
          filter={<TextFilter filteringText={filterText} onChange={({ detail }) => setFilterText(detail.filteringText)} filteringPlaceholder="Find virtual datastore" />}
          pagination={<Pagination currentPageIndex={currentPage} pagesCount={totalPages} onChange={({ detail }) => setCurrentPage(detail.currentPageIndex)} />}
          columnDefinitions={[
            { id: 'name', header: 'Name', cell: item => item.name },
            { id: 'description', header: 'Description', cell: item => (item as any).description || '-' },
            { id: 'status', header: 'Status', cell: item => <StatusIndicator type={item.status === 'ACTIVE' ? 'success' : 'stopped'}>{item.status}</StatusIndicator> },
            { id: 'deident', header: 'De-identification', cell: item => {
              const profileId = (item as any).deid_profile_id || (item as any).deidProfileId;
              if (profileId) {
                const profile = deidProfiles.find((p: any) => p.id === profileId);
                return <StatusIndicator type="success">{profile?.name || profileId}</StatusIndicator>;
              }
              return <StatusIndicator type="stopped">Disabled</StatusIndicator>;
            }},
            { id: 'writeMode', header: 'Write Mode', cell: item => {
              const mode = (item as any).writeMode || (item as any).write_mode || 'NONE';
              if (mode === 'NONE') return <StatusIndicator type="stopped">Read-only</StatusIndicator>;
              if (mode === 'EXISTING') {
                const dsName = (item as any).writeDatastoreName || (item as any).write_datastore_name;
                return <StatusIndicator type="success">{dsName || 'Existing storage'}</StatusIndicator>;
              }
              if (mode === 'DEDICATED') {
                const dsStatus = (item as any).writeDatastoreStatus || (item as any).write_datastore_status;
                if (dsStatus === 'ACTIVE') return <StatusIndicator type="success">Dedicated storage</StatusIndicator>;
                if (dsStatus === 'CREATING') return <StatusIndicator type="pending">Creating storage...</StatusIndicator>;
                if (dsStatus === 'ERROR') return <StatusIndicator type="error">Storage error</StatusIndicator>;
                return <StatusIndicator type="pending">Dedicated storage</StatusIndicator>;
              }
              return <StatusIndicator type="stopped">Read-only</StatusIndicator>;
            }},
            { id: 'studies', header: 'Studies', cell: item => item.studyCount || 0 },
            { id: 'series', header: 'Series', cell: item => item.seriesCount || 0 },
            { id: 'createdAt', header: 'Created', cell: item => formatTimestampDate(item.createdAt) },
          ]}
          empty={<Box textAlign="center" color="inherit"><b>No virtual datastores</b><Box padding={{ bottom: 's' }} variant="p" color="inherit">Create a virtual datastore to aggregate studies.</Box></Box>}
        />
      </SpaceBetween>

      {/* Create/Edit Datastore Modal */}
      <Modal visible={showModal} onDismiss={() => setShowModal(false)} header={modalMode === 'create' ? 'Create Virtual Folder' : 'Edit Virtual Folder'}
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={() => setShowModal(false)}>Cancel</Button><Button variant="primary" onClick={handleSave} loading={saving} disabled={!!validateVirtualFolderName(formName) || (formWriteMode === 'EXISTING' && !formWriteDatastoreId)}>{modalMode === 'create' ? 'Create' : 'Save'}</Button></SpaceBetween></Box>}>
        <Form>
          <SpaceBetween size="m">
            <Alert type="info">
              A virtual folder is a <strong>rule-based index across your storages</strong>, not a
              physical copy. You define which source storages it draws from and assignment rules
              that select matching DICOM objects; the indexer materializes those into the folder.
              Optionally attach a de-identification profile to control how identifying tags are
              transformed. {modalMode === 'create' && 'After you create it, you\u2019ll be taken straight to the rules editor to define what it indexes.'}
            </Alert>
            <FormField label="Name" errorText={formName ? validateVirtualFolderName(formName) : undefined} constraintText="Max 28 characters: letters, numbers, dots, hyphens, underscores, spaces"><Input value={formName} onChange={({ detail }) => setFormName(detail.value)} placeholder="e.g., Research Studies" /></FormField>
            <FormField label="Description"><Textarea value={formDescription} onChange={({ detail }) => setFormDescription(detail.value)} /></FormField>
            <FormField label="Write Mode" description="Choose whether this virtual folder can receive DICOM data">
              <RadioGroup
                value={formWriteMode}
                onChange={({ detail }) => setFormWriteMode(detail.value)}
                items={[
                  { value: 'NONE', label: 'Read-only', description: 'Virtual folder is read-only, no data can be stored' },
                  { value: 'EXISTING', label: 'Write to existing storage',
                    description: !datastoresLoaded ? 'Loading storages\u2026'
                      : storableDatastores.length
                        ? 'Data sent to this folder\u2019s STOW-RS endpoint is stored in the storage you pick, then added to the folder'
                        : 'You have store permission on no active storage',
                    disabled: datastoresLoaded && !storableDatastores.length },
                  { value: 'DEDICATED', label: 'Create dedicated storage',
                    description: keepsDedicated ? 'Using this folder\u2019s existing dedicated storage'
                      : canCreateStorage ? `A new storage named "${(formName || '').trim().replace(/\s+/g, '-') || 'after this folder'}" is created; data sent to the folder is stored there`
                      : 'Needs the storage create permission (Storage: Edit)',
                    disabled: !keepsDedicated && !canCreateStorage },
                ]}
              />
            </FormField>
            {formWriteMode === 'EXISTING' && (
              <FormField label="Target Storage">
                <Select
                  selectedOption={storableDatastores.find(d => d.id === formWriteDatastoreId) ? { value: formWriteDatastoreId, label: storableDatastores.find(d => d.id === formWriteDatastoreId)?.name } : null}
                  options={storableDatastores.map(d => ({ value: d.id, label: d.name }))}
                  onChange={({ detail }) => setFormWriteDatastoreId(detail.selectedOption?.value || '')}
                  placeholder="Select a storage"
                  filteringType="auto"
                />
              </FormField>
            )}
            {formWriteMode === 'DEDICATED' && modalMode === 'edit' && (selectedItems[0] as any)?.writeDatastoreId && (
              <Alert type="info">This virtual folder already has a dedicated storage. It will be reused.</Alert>
            )}
            <FormField label="Indexing Profile" description="Determines which DICOM attributes are indexed">
              <Select
                selectedOption={indexingProfiles.find(p => p.id === formIndexingProfileId) ? { value: formIndexingProfileId, label: indexingProfiles.find(p => p.id === formIndexingProfileId)?.name } : null}
                options={indexingProfiles.map(p => ({ value: p.id, label: p.name }))}
                onChange={({ detail }) => setFormIndexingProfileId(detail.selectedOption?.value || '')}
                placeholder="Select indexing profile"
              />
            </FormField>
            <FormField label="De-identification Profile" description="Optional. Controls how identifying DICOM tags are transformed for this folder. Manage profiles under Virtual Folders → Profiles → De-identification Profiles.">
              <Select
                selectedOption={deidProfiles.find(p => p.id === formDeidProfileId) ? { value: formDeidProfileId, label: deidProfiles.find(p => p.id === formDeidProfileId)?.name } : { value: '', label: 'None (no de-identification)' }}
                options={[{ value: '', label: 'None (no de-identification)' }, ...deidProfiles.map(p => ({ value: p.id, label: p.name, description: p.description || undefined }))]}
                onChange={({ detail }) => setFormDeidProfileId(detail.selectedOption?.value || '')}
                placeholder="Select de-identification profile (optional)"
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        onDismiss={() => setShowDeleteModal(false)}
        header={`Delete ${selectedItems.length === 1 ? 'Virtual Folder' : `${selectedItems.length} Virtual Folders`}`}
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={() => setShowDeleteModal(false)}>Cancel</Button><Button variant="primary" onClick={handleDelete} loading={deleting}>Delete</Button></SpaceBetween></Box>}
      >
        <SpaceBetween size="s">
          <Box>Are you sure you want to delete the following virtual folder{selectedItems.length > 1 ? 's' : ''}? This will remove all study assignments.</Box>
          <ul style={{ margin: 0, paddingLeft: '1.5em' }}>
            {selectedItems.map(item => <li key={item.id}><b>{item.name}</b></li>)}
          </ul>
        </SpaceBetween>
      </Modal>

      {/* Rules Management Modal */}
      {showRulesModal && selectedItems[0] && (
        <Modal visible={showRulesModal} onDismiss={() => setShowRulesModal(false)} size="large">
          <AssignmentRulesManagement 
            virtualFolderId={selectedItems[0].id} 
            onClose={() => setShowRulesModal(false)} 
          />
        </Modal>
      )}
    </>
  );
};

export default VirtualFolderManagement;
