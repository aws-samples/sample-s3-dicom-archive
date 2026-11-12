import { useEffect, useState, useCallback } from 'react';
import {
  Header, Table, Button, SpaceBetween, Box, Modal, FormField, Input, Textarea,
  Multiselect, Alert, Badge,
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';

type VF = { id: string; name: string; deidProfileId?: string | null };

/**
 * Fresh de-identification manager scoped to this Index-Attributes hub.
 * - Create / delete de-id profiles (backed by /virtual-folders/deid-profiles).
 * - Assign a profile to MANY virtual folders (multi-select). The data model is
 *   one profile per VF (virtual_folders.deid_profile_id), so "many VFs per
 *   profile" is applied by setting deid_profile_id on each selected VF (and
 *   clearing it on VFs deselected from this profile).
 * De-id applies to virtual folders ONLY.
 */
export default function DeidProfiles() {
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [profiles, setProfiles] = useState<any[]>([]);
  const [vfs, setVfs] = useState<VF[]>([]);
  const [loading, setLoading] = useState(false);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Assign modal
  const [assignFor, setAssignFor] = useState<any | null>(null);
  const [assignVfs, setAssignVfs] = useState<any[]>([]);
  const [assigning, setAssigning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p: any = await apiClient.makeRequest<any[]>('/virtual-folders/deid-profiles');
      setProfiles((p?.data || p || []) as any[]);
      const vf: any = await apiClient.getVirtualFolders({ page: 1, pageSize: 200 } as any);
      const items = (vf?.data?.items || vf?.data || []).map((f: any) => ({
        id: f.id, name: f.name, deidProfileId: f.deidProfileId ?? f.deid_profile_id ?? null,
      }));
      setVfs(items);
    } catch (e: any) { setError(e.message || 'Failed to load de-id profiles'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createProfile = async () => {
    setSaving(true); setError('');
    try {
      // Minimal profile; tag-action editing remains in the VF profiles page.
      await apiClient.makeRequest('/virtual-folders/deid-profiles', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), description: description.trim(), tag_actions: [], drop_private_tags: false }),
      });
      setSuccess(`Created de-id profile '${name}'.`);
      setShowCreate(false); setName(''); setDescription('');
      await load();
    } catch (e: any) { setError(e.response?.data?.error || e.message || 'Failed to create profile'); }
    finally { setSaving(false); }
  };

  const deleteProfile = async (p: any) => {
    try {
      await apiClient.makeRequest(`/virtual-folders/deid-profiles/${p.id}`, { method: 'DELETE' });
      setSuccess(`Deleted profile '${p.name}'.`);
      await load();
    } catch (e: any) { setError(e.response?.data?.error || e.message || 'Failed to delete profile'); }
  };

  const openAssign = (p: any) => {
    setAssignFor(p);
    // Pre-select VFs currently pointing at this profile.
    const current = vfs.filter(v => v.deidProfileId === p.id)
      .map(v => ({ label: v.name, value: v.id }));
    setAssignVfs(current);
  };

  const saveAssign = async () => {
    if (!assignFor) return;
    setAssigning(true); setError('');
    try {
      const selectedIds = new Set(assignVfs.map(o => o.value));
      const wasAssigned = new Set(vfs.filter(v => v.deidProfileId === assignFor.id).map(v => v.id));
      // Assign newly-selected VFs; clear VFs removed from this profile.
      const toSet = [...selectedIds].filter(id => !wasAssigned.has(id));
      const toClear = [...wasAssigned].filter(id => !selectedIds.has(id));
      for (const id of toSet) {
        await apiClient.updateVirtualFolder(id, { deidProfileId: assignFor.id } as any);
      }
      for (const id of toClear) {
        await apiClient.updateVirtualFolder(id, { deidProfileId: null } as any);
      }
      setSuccess(`Updated assignments for '${assignFor.name}' (${toSet.length} added, ${toClear.length} removed).`);
      setAssignFor(null);
      await load();
    } catch (e: any) { setError(e.response?.data?.error || e.message || 'Failed to update assignments'); }
    finally { setAssigning(false); }
  };

  const assignedCount = (p: any) => vfs.filter(v => v.deidProfileId === p.id).length;

  return (
    <SpaceBetween size="l">
      {error && <Alert type="error" dismissible onDismiss={() => setError('')}>{error}</Alert>}
      {success && <Alert type="success" dismissible onDismiss={() => setSuccess('')}>{success}</Alert>}
      <Table
        header={
          <Header variant="h2" counter={`(${profiles.length})`}
            description="De-identification profiles apply to virtual folders only. Assign a profile to one or more virtual folders."
            actions={<Button variant="primary" iconName="add-plus" onClick={() => { setName(''); setDescription(''); setShowCreate(true); }}>Create profile</Button>}
          >De-identification Profiles</Header>
        }
        loading={loading}
        items={profiles}
        columnDefinitions={[
          { id: 'name', header: 'Name', cell: (p: any) => p.name },
          { id: 'description', header: 'Description', cell: (p: any) => p.description || '—' },
          { id: 'assigned', header: 'Assigned VFs', cell: (p: any) => <Badge color={assignedCount(p) ? 'blue' : 'grey'}>{assignedCount(p)}</Badge> },
          {
            id: 'actions', header: 'Actions',
            cell: (p: any) => (
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="normal" iconName="share" onClick={() => openAssign(p)}>Assign to virtual folders</Button>
                <Button variant="normal" iconName="remove" onClick={() => deleteProfile(p)}>Delete</Button>
              </SpaceBetween>
            ),
          },
        ]}
        empty={<Box textAlign="center" color="inherit" padding="l"><b>No de-id profiles</b><Box variant="p" color="inherit">Create one to de-identify virtual folders.</Box></Box>}
      />

      {/* Create profile */}
      <Modal visible={showCreate} onDismiss={() => setShowCreate(false)} header="Create de-id profile"
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => setShowCreate(false)}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!name.trim() || saving} onClick={createProfile}>Create</Button>
        </SpaceBetween></Box>}>
        <SpaceBetween size="m">
          <FormField label="Name"><Input value={name} onChange={({ detail }) => setName(detail.value)} placeholder="e.g. Research anonymization" /></FormField>
          <FormField label="Description (optional)"><Textarea value={description} onChange={({ detail }) => setDescription(detail.value)} /></FormField>
          <Alert type="info">Configure the profile's tag actions in Virtual Folders → Profiles after creating it.</Alert>
        </SpaceBetween>
      </Modal>

      {/* Assign to VFs */}
      <Modal visible={!!assignFor} onDismiss={() => setAssignFor(null)} header={`Assign '${assignFor?.name}' to virtual folders`}
        footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => setAssignFor(null)}>Cancel</Button>
          <Button variant="primary" loading={assigning} onClick={saveAssign}>Save assignments</Button>
        </SpaceBetween></Box>}>
        <FormField label="Virtual folders" description="Selected folders use this profile. A folder can have only one profile — selecting it here moves it to this one; deselecting clears it.">
          <Multiselect
            selectedOptions={assignVfs}
            onChange={({ detail }) => setAssignVfs([...detail.selectedOptions])}
            options={vfs.map(v => ({
              label: v.name, value: v.id,
              description: v.deidProfileId && v.deidProfileId !== assignFor?.id ? 'currently uses another profile' : undefined,
            }))}
            placeholder="Select virtual folders"
            filteringType="auto"
          />
        </FormField>
      </Modal>
    </SpaceBetween>
  );
}
