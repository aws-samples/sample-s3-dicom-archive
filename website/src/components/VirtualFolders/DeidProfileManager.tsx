import React, { useState, useEffect } from 'react';
import {
  Header,
  SpaceBetween,
  Button,
  Table,
  Box,
  Modal,
  FormField,
  Input,
  Textarea,
  Select,
  Alert,
  ColumnLayout,
  Checkbox
} from '@cloudscape-design/components';
import { TagAction, DeidProfile, DicomTagsReference, DeidAction } from '../../types/virtualFolder';
import apiClient from '../../services/apiClient';

// Tag Action Editor Component
const TagActionEditor: React.FC<{
  dicomTags: DicomTagsReference;
  onAdd: (action: TagAction) => void;
}> = ({ dicomTags, onAdd }) => {
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedAction, setSelectedAction] = useState<DeidAction | null>(null);
  const [replacement, setReplacement] = useState('');
  const [shiftDaysMin, setShiftDaysMin] = useState<number>(0);
  const [shiftDaysMax, setShiftDaysMax] = useState<number>(0);

  const selectedTagInfo = selectedTag ? dicomTags.tags[selectedTag] : null;
  const isUidTag = selectedTagInfo?.isUid === true;

  // Filter actions based on tag type
  const availableActions = Object.keys(dicomTags.actions).filter(action => {
    if (isUidTag) return action === 'REPLACE';
    return true;
  });

  const handleAdd = () => {
    if (!selectedTag || !selectedAction) return;
    
    const action: TagAction = { tag: selectedTag, action: selectedAction };
    if (selectedAction === 'REPLACE') action.replacement = replacement;
    if (selectedAction === 'SHIFT_DATE') {
      action.shiftDaysMin = shiftDaysMin;
      action.shiftDaysMax = shiftDaysMax;
    }
    
    onAdd(action);
    
    // Reset
    setSelectedTag(null);
    setSelectedAction(null);
    setReplacement('');
    setShiftDaysMin(0);
    setShiftDaysMax(0);
  };

  return (
    <SpaceBetween size="s">
      <ColumnLayout columns={2}>
        <FormField label="DICOM Tag">
          <Select
            selectedOption={selectedTag ? { label: `${dicomTags.tags[selectedTag].name} (${selectedTag})`, value: selectedTag } : null}
            onChange={({ detail }) => {
              setSelectedTag(detail.selectedOption?.value || null);
              setSelectedAction(null);
            }}
            options={Object.values(dicomTags.tags).map(tag => ({
              label: `${tag.name} (${tag.tag})`,
              value: tag.tag,
              description: `${tag.vr} - ${tag.level}`
            }))}
            placeholder="Select DICOM tag"
            filteringType="auto"
          />
        </FormField>

        <FormField label="Action">
          <Select
            selectedOption={selectedAction ? { label: selectedAction, value: selectedAction } : null}
            onChange={({ detail }) => setSelectedAction(detail.selectedOption?.value as DeidAction || null)}
            options={availableActions.map(action => ({
              label: action,
              value: action
            }))}
            placeholder="Select action"
            disabled={!selectedTag}
          />
        </FormField>
      </ColumnLayout>

      {selectedAction === 'REPLACE' && (
        <FormField label="Replacement Value">
          <Input value={replacement} onChange={({ detail }) => setReplacement(detail.value)} />
        </FormField>
      )}

      {selectedAction === 'SHIFT_DATE' && (
        <ColumnLayout columns={2}>
          <FormField label="Min Days to Shift">
            <Input
              type="number"
              value={String(shiftDaysMin)}
              onChange={({ detail }) => setShiftDaysMin(parseInt(detail.value) || 0)}
            />
          </FormField>
          <FormField label="Max Days to Shift">
            <Input
              type="number"
              value={String(shiftDaysMax)}
              onChange={({ detail }) => setShiftDaysMax(parseInt(detail.value) || 0)}
            />
          </FormField>
        </ColumnLayout>
      )}

      <Button onClick={handleAdd} disabled={!selectedTag || !selectedAction}>
        Add Tag Action
      </Button>
    </SpaceBetween>
  );
};

export const DeidProfileManager: React.FC = () => {
  const [profiles, setProfiles] = useState<DeidProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<DeidProfile | null>(null);
  const [dicomTags, setDicomTags] = useState<DicomTagsReference | null>(null);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingProfile, setDeletingProfile] = useState<DeidProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [editingProfile, setEditingProfile] = useState<DeidProfile | null>(null);
  const [formData, setFormData] = useState({ 
    name: '', 
    description: '', 
    tag_actions: [] as TagAction[],
    drop_private_tags: false
  });
  const [error, setError] = useState('');

  useEffect(() => {
    loadProfiles();
    loadDicomTags();
  }, []);

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const response = await apiClient.makeRequest<DeidProfile[]>('/virtual-folders/deid-profiles');
      if (response.success) setProfiles(response.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadDicomTags = async () => {
    try {
      const response = await apiClient.makeRequest<DicomTagsReference>('/virtual-folders/dicom-tags');
      if (response.success) setDicomTags(response.data);
    } catch (err: any) {
      console.error('Failed to load DICOM tags:', err);
    }
  };

  const handleCreate = () => {
    setEditingProfile(null);
    setFormData({ name: '', description: '', tag_actions: [], drop_private_tags: false });
    setShowModal(true);
  };

  const handleEdit = (profile: DeidProfile) => {
    setEditingProfile(profile);
    setFormData({
      name: profile.name,
      description: profile.description || '',
      tag_actions: profile.tag_actions,
      drop_private_tags: profile.drop_private_tags || false
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    setLoading(true);
    setError('');
    try {
      if (editingProfile) {
        await apiClient.makeRequest(`/virtual-folders/deid-profiles/${editingProfile.id}`, { method: 'PUT', body: JSON.stringify(formData) });
      } else {
        await apiClient.makeRequest('/virtual-folders/deid-profiles', { method: 'POST', body: JSON.stringify(formData) });
      }
      setShowModal(false);
      loadProfiles();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingProfile) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await apiClient.makeRequest(`/virtual-folders/deid-profiles/${deletingProfile.id}`, { method: 'DELETE' });
      setShowDeleteModal(false);
      setDeletingProfile(null);
      loadProfiles();
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const addTagAction = (action: TagAction) => {
    setFormData(prev => ({
      ...prev,
      // Replace an existing action for the same tag rather than duplicating it.
      tag_actions: [...prev.tag_actions.filter(a => a.tag !== action.tag), action]
    }));
  };

  // Common HIPAA patient-identifier tags, mapped to the actions the indexer
  // supports (REMOVE / HASH / REPLACE / SHIFT_DATE). UID tags are REPLACE-only.
  const COMMON_PRESETS: { label: string; actions: TagAction[] }[] = [
    {
      label: 'Patient identifiers',
      actions: [
        { tag: '00100010', action: 'HASH' as DeidAction },   // PatientName
        { tag: '00100020', action: 'HASH' as DeidAction },   // PatientID
        { tag: '00100030', action: 'REMOVE' as DeidAction }, // PatientBirthDate
        { tag: '00101040', action: 'REMOVE' as DeidAction }, // PatientAddress
        { tag: '00102154', action: 'REMOVE' as DeidAction }, // PatientTelephoneNumbers
      ]
    },
    {
      label: 'Referring / operators',
      actions: [
        { tag: '00080090', action: 'REMOVE' as DeidAction }, // ReferringPhysicianName
        { tag: '00081070', action: 'REMOVE' as DeidAction }, // OperatorsName
        { tag: '00081050', action: 'REMOVE' as DeidAction }, // PerformingPhysicianName
      ]
    },
    {
      label: 'Accession / study IDs',
      actions: [
        { tag: '00080050', action: 'HASH' as DeidAction },   // AccessionNumber
        { tag: '00200010', action: 'HASH' as DeidAction },   // StudyID
      ]
    }
  ];

  const applyPreset = (actions: TagAction[]) => {
    // Only apply presets whose tags the server knows about (fail-safe).
    const known = actions.filter(a => !dicomTags || dicomTags.tags[a.tag]);
    setFormData(prev => {
      const others = prev.tag_actions.filter(a => !known.some(k => k.tag === a.tag));
      return { ...prev, tag_actions: [...others, ...known] };
    });
  };

  const removeTagAction = (index: number) => {
    setFormData(prev => ({
      ...prev,
      tag_actions: prev.tag_actions.filter((_, i) => i !== index)
    }));
  };

  const getTagName = (tagId: string) => {
    return dicomTags?.tags[tagId]?.name || tagId;
  };

  return (
    <SpaceBetween size="l">
      {error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
      
      <Header
        variant="h2"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button iconName="refresh" onClick={() => { loadProfiles(); loadDicomTags(); }}>Refresh</Button>
            <Button variant="primary" onClick={handleCreate}>Create Profile</Button>
          </SpaceBetween>
        }
      >
        De-identification Profiles
      </Header>
      
      <Table
        header={
          <Header
            counter={`(${profiles.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button disabled={!selectedProfile} onClick={() => handleEdit(selectedProfile!)}>Edit</Button>
                <Button disabled={!selectedProfile} onClick={() => {
                  setDeletingProfile(selectedProfile);
                  setShowDeleteModal(true);
                }}>Delete</Button>
              </SpaceBetween>
            }
          />
        }
        loading={loading}
        items={profiles}
        selectionType="single"
        selectedItems={selectedProfile ? [selectedProfile] : []}
        onSelectionChange={({ detail }) => setSelectedProfile(detail.selectedItems[0] || null)}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: item => item.name },
          { id: 'description', header: 'Description', cell: item => item.description || '-' },
          { id: 'actions', header: 'Tag Actions', cell: item => item.tag_actions.length },
          { id: 'private', header: 'Drop Private Tags', cell: item => item.drop_private_tags ? 'Yes' : 'No' }
        ]}
      />

        <Modal
          visible={showModal}
          onDismiss={() => setShowModal(false)}
          header={editingProfile ? 'Edit Profile' : 'Create Profile'}
          size="large"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setShowModal(false)}>Cancel</Button>
                <Button variant="primary" onClick={handleSave} loading={loading}>Save</Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <FormField label="Name">
              <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.detail.value })} />
            </FormField>
            
            <FormField label="Description">
              <Textarea value={formData.description} onChange={e => setFormData({ ...formData, description: e.detail.value })} />
            </FormField>

            <FormField label="Privacy Options">
              <Checkbox
                checked={formData.drop_private_tags}
                onChange={({ detail }) => setFormData({ ...formData, drop_private_tags: detail.checked })}
              >
                Drop Private Tags (remove all tags with odd group numbers)
              </Checkbox>
            </FormField>

            <FormField label="Tag Actions" description="Configure de-identification actions for specific DICOM tags. Supported actions: REMOVE, EMPTY, HASH, HASH_8/16/32, KEEP, REPLACE, SHIFT_DATE. UID tags support REPLACE only.">
              <SpaceBetween size="s">
                <Box>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Box variant="awsui-key-label" padding={{ top: 'xxs' }}>Presets:</Box>
                    {COMMON_PRESETS.map(preset => (
                      <Button key={preset.label} onClick={() => applyPreset(preset.actions)}>
                        + {preset.label}
                      </Button>
                    ))}
                  </SpaceBetween>
                </Box>

                <Table
                  variant="embedded"
                  items={formData.tag_actions}
                  columnDefinitions={[
                    { id: 'tag', header: 'Tag', cell: (a: TagAction) => `${getTagName(a.tag)} (${a.tag})` },
                    { id: 'vr', header: 'VR', cell: (a: TagAction) => dicomTags?.tags[a.tag]?.vr || '-' },
                    { id: 'action', header: 'Action', cell: (a: TagAction) => a.action },
                    {
                      id: 'detail',
                      header: 'Replacement / Shift',
                      cell: (a: TagAction) =>
                        a.action === 'REPLACE'
                          ? (a.replacement || '(none)')
                          : a.action === 'SHIFT_DATE'
                          ? `${a.shiftDaysMin ?? 0}–${a.shiftDaysMax ?? 0} days`
                          : '-'
                    },
                    {
                      id: 'remove',
                      header: '',
                      cell: (_a: TagAction) => {
                        const idx = formData.tag_actions.indexOf(_a);
                        return <Button iconName="close" variant="icon" onClick={() => removeTagAction(idx)} />;
                      }
                    }
                  ]}
                  empty={<Box textAlign="center" color="inherit">No tag actions yet. Add a preset above or a single tag below.</Box>}
                />

                {dicomTags && <TagActionEditor dicomTags={dicomTags} onAdd={addTagAction} />}
              </SpaceBetween>
            </FormField>
          </SpaceBetween>
        </Modal>

        <Modal
          visible={showDeleteModal}
          onDismiss={() => {
            setShowDeleteModal(false);
            setDeletingProfile(null);
            setDeleteError('');
          }}
          header="Delete De-identification Profile"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => {
                  setShowDeleteModal(false);
                  setDeletingProfile(null);
                  setDeleteError('');
                }}>Cancel</Button>
                <Button variant="primary" onClick={handleDelete} loading={deleting}>Delete</Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            {deleteError && (
              <Alert type="error" header="Cannot delete profile">
                {deleteError}
              </Alert>
            )}
            <Box>
              Are you sure you want to delete the de-identification profile <strong>{deletingProfile?.name}</strong>? This action cannot be undone.
            </Box>
          </SpaceBetween>
        </Modal>
      </SpaceBetween>
  );
};
