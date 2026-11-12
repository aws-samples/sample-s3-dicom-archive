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
  Multiselect,
  Alert
} from '@cloudscape-design/components';
import { IndexingProfile, DicomTagsReference } from '../../types/virtualFolder';
import apiClient from '../../services/apiClient';

interface FormData {
  name: string;
  description: string;
  patient_attributes: string[];
  study_attributes: string[];
  series_attributes: string[];
  instance_attributes: string[];
}

export const IndexingProfileManager: React.FC = () => {
  const [profiles, setProfiles] = useState<IndexingProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<IndexingProfile | null>(null);
  const [dicomTags, setDicomTags] = useState<DicomTagsReference | null>(null);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletingProfile, setDeletingProfile] = useState<IndexingProfile | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [editingProfile, setEditingProfile] = useState<IndexingProfile | null>(null);
  const [formData, setFormData] = useState<FormData>({ name: '', description: '', patient_attributes: [], study_attributes: [], series_attributes: [], instance_attributes: [] });
  const [error, setError] = useState('');

  useEffect(() => {
    loadProfiles();
    loadDicomTags();
  }, []);

  const loadProfiles = async () => {
    setLoading(true);
    try {
      const response = await apiClient.makeRequest<IndexingProfile[]>('/virtual-folders/indexing-profiles');
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
    setFormData({ name: '', description: '', patient_attributes: [], study_attributes: [], series_attributes: [], instance_attributes: [] });
    setShowModal(true);
  };

  const handleEdit = (profile: IndexingProfile) => {
    setEditingProfile(profile);
    setFormData({
      name: profile.name,
      description: profile.description || '',
      patient_attributes: Array.isArray(profile.patient_attributes) ? profile.patient_attributes : JSON.parse(profile.patient_attributes || '[]'),
      study_attributes: Array.isArray(profile.study_attributes) ? profile.study_attributes : JSON.parse(profile.study_attributes || '[]'),
      series_attributes: Array.isArray(profile.series_attributes) ? profile.series_attributes : JSON.parse(profile.series_attributes || '[]'),
      instance_attributes: Array.isArray(profile.instance_attributes) ? profile.instance_attributes : JSON.parse(profile.instance_attributes || '[]')
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    setLoading(true);
    setError('');
    try {
      if (editingProfile) {
        await apiClient.makeRequest(`/virtual-folders/indexing-profiles/${editingProfile.id}`, { method: 'PUT', body: JSON.stringify(formData) });
      } else {
        await apiClient.makeRequest('/virtual-folders/indexing-profiles', { method: 'POST', body: JSON.stringify(formData) });
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
      await apiClient.makeRequest(`/virtual-folders/indexing-profiles/${deletingProfile.id}`, { method: 'DELETE' });
      setShowDeleteModal(false);
      setDeletingProfile(null);
      loadProfiles();
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const getTagOptions = (level: string) => {
    if (!dicomTags) return [];
    return Object.values(dicomTags.tags)
      .filter(tag => tag.level === level)
      .map(tag => ({ label: `${tag.name} (${tag.tag})`, value: tag.tag }));
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
        Indexing Profiles
      </Header>
      
      <Table
        header={
          <Header
            counter={`(${profiles.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button onClick={() => selectedProfile && handleEdit(selectedProfile)} disabled={!selectedProfile}>Edit</Button>
                <Button onClick={() => {
                  setDeletingProfile(selectedProfile);
                  setShowDeleteModal(true);
                }} disabled={!selectedProfile}>Delete</Button>
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
            { id: 'tags', header: 'Tag Count', cell: item => {
              const parseAttr = (attr: any) => Array.isArray(attr) ? attr : JSON.parse(attr || '[]');
              const p = parseAttr(item.patient_attributes).length;
              const st = parseAttr(item.study_attributes).length;
              const se = parseAttr(item.series_attributes).length;
              const i = parseAttr(item.instance_attributes).length;
              return `${p}/${st}/${se}/${i}`;
            }}
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

            <FormField label="Patient Attributes">
              <Multiselect
                selectedOptions={formData.patient_attributes.map(t => ({ label: dicomTags?.tags[t]?.name || t, value: t }))}
                options={getTagOptions('PATIENT')}
                onChange={e => setFormData({ ...formData, patient_attributes: e.detail.selectedOptions.map(o => o.value!) })}
                placeholder="Select patient-level tags"
              />
            </FormField>

            <FormField label="Study Attributes">
              <Multiselect
                selectedOptions={formData.study_attributes.map(t => ({ label: dicomTags?.tags[t]?.name || t, value: t }))}
                options={getTagOptions('STUDY')}
                onChange={e => setFormData({ ...formData, study_attributes: e.detail.selectedOptions.map(o => o.value!) })}
                placeholder="Select study-level tags"
              />
            </FormField>

            <FormField label="Series Attributes">
              <Multiselect
                selectedOptions={formData.series_attributes.map(t => ({ label: dicomTags?.tags[t]?.name || t, value: t }))}
                options={getTagOptions('SERIES')}
                onChange={e => setFormData({ ...formData, series_attributes: e.detail.selectedOptions.map(o => o.value!) })}
                placeholder="Select series-level tags"
              />
            </FormField>

            <FormField label="Instance Attributes">
              <Multiselect
                selectedOptions={formData.instance_attributes.map(t => ({ label: dicomTags?.tags[t]?.name || t, value: t }))}
                options={getTagOptions('INSTANCE')}
                onChange={e => setFormData({ ...formData, instance_attributes: e.detail.selectedOptions.map(o => o.value!) })}
                placeholder="Select instance-level tags"
              />
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
          header="Delete Indexing Profile"
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
              Are you sure you want to delete the indexing profile <strong>{deletingProfile?.name}</strong>? This action cannot be undone.
            </Box>
          </SpaceBetween>
        </Modal>
      </SpaceBetween>
  );
};
