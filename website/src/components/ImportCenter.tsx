import React, { useState, useEffect, useCallback } from 'react';
import {
  Container,
  Header,
  Tabs,
  SpaceBetween,
  Box,
  Button,
  FormField,
  Select,
  Flashbar,
  Alert
} from '@cloudscape-design/components';

import { Datastore } from '../types';
import { datastoreService } from '../services';
import { usePrivileges } from '../contexts/PrivilegesContext';

import FileUploader from './FileUploader';
// NonDicomImport (V1) is retained on disk but no longer rendered — V2 is the
// sole non-DICOM import experience.
import NonDicomImportV2 from './NonDicomImportV2';
import ImportManagement from './ImportManagement';

export type ImportTabId = 'dicom' | 'non-dicom' | 'jobs';

interface ImportCenterProps {
  /** Which tab to open on mount (deep-link target). Defaults to 'dicom'. */
  defaultTab?: ImportTabId;
  /**
   * STORAGE datastore id to preselect in the DICOM tab (deep-link from the
   * Studies page's Upload shortcut). Ignored if it is not an accessible
   * storage datastore (e.g. a VF index has no bucket to upload into).
   */
  initialDatastoreId?: string;
}

/**
 * ImportCenter — the single home for every way DICOM/non-DICOM data enters an
 * S3 datastore. It COMPOSES the existing flows (does not reimplement them):
 *   • DICOM files       → FileUploader (modal) targeting a chosen STORAGE datastore
 *   • Non-DICOM files   → NonDicomImport (its own datastore picker + workspace)
 *   • Jobs              → ImportManagement (the import-jobs monitor)
 *
 * Registering an existing S3 bucket as a datastore lives in the Storage menu
 * (DatastoreManagement), so it is intentionally NOT a tab here.
 *
 * Upload targets are STORAGE datastores only — a virtual-folder index has no
 * bucket, so it is never an upload destination (this is the class of bug that
 * broke "Upload from Computer" once the Studies selector started listing VF
 * indexes alongside storage datastores).
 */
const ImportCenter: React.FC<ImportCenterProps> = ({ defaultTab = 'dicom', initialDatastoreId }) => {
  const { hasDatastoreAccess } = usePrivileges();

  const [activeTabId, setActiveTabId] = useState<ImportTabId>(defaultTab);
  const [notifications, setNotifications] = useState<any[]>([]);

  // STORAGE datastores only (datastoreService.getAll returns storage datastores,
  // never VF indexes). These are the valid DICOM-upload destinations.
  const [datastores, setDatastores] = useState<Datastore[]>([]);
  const [selectedDatastore, setSelectedDatastore] = useState<Datastore | null>(null);
  const [datastoresLoading, setDatastoresLoading] = useState(true);

  // Modal visibility
  const [showUploader, setShowUploader] = useState(false);

  const addNotification = useCallback((type: 'success' | 'error' | 'warning' | 'info', header: string, content?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setNotifications(prev => [...prev, { type, header, content, id, dismissible: true, onDismiss: () => setNotifications(p => p.filter(n => n.id !== id)) }]);
    if (type === 'success') {
      setTimeout(() => setNotifications(p => p.filter(n => n.id !== id)), 4000);
    }
  }, []);

  const loadDatastores = useCallback(async () => {
    setDatastoresLoading(true);
    try {
      const resp = await datastoreService.getAll({ pageSize: 100 });
      const active = (resp.items || []).filter(ds =>
        (ds.status?.toString().toUpperCase() === 'ACTIVE') &&
        (hasDatastoreAccess(ds.id, 'canRead') || hasDatastoreAccess('*', 'canRead'))
      );
      setDatastores(active);
      // Preselect: deep-link target if it is a valid storage datastore, else first.
      const preselect = initialDatastoreId
        ? active.find(d => d.id === initialDatastoreId)
        : undefined;
      setSelectedDatastore(prev => prev || preselect || active[0] || null);
    } catch (e) {
      console.error('Failed to load datastores:', e);
      addNotification('error', 'Failed to load datastores', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setDatastoresLoading(false);
    }
  }, [hasDatastoreAccess, initialDatastoreId, addNotification]);

  useEffect(() => { loadDatastores(); }, [loadDatastores]);

  // React to a deep-link change (e.g. navigating from a different study datastore).
  useEffect(() => { setActiveTabId(defaultTab); }, [defaultTab]);
  useEffect(() => {
    if (initialDatastoreId) {
      const match = datastores.find(d => d.id === initialDatastoreId);
      if (match) setSelectedDatastore(match);
    }
  }, [initialDatastoreId, datastores]);

  const canUpload = !!selectedDatastore
    && hasDatastoreAccess(selectedDatastore.id, 'canStore')
    // A read-only imported bucket is never writable, so it is not an upload
    // target even for a user with store privilege (upload copies INTO the bucket).
    && (selectedDatastore as any).accessLevel !== 'read-only';

  const dicomTab = (
    <SpaceBetween size="l">
      <Alert type="info">
        Upload DICOM files from your computer into a storage datastore. Files are staged, then
        imported and indexed into the selected datastore's archive bucket.
      </Alert>
      <FormField
        label="Target storage datastore"
        description="DICOM uploads land in a storage datastore's S3 bucket. Virtual-folder indexes are not upload targets."
      >
        <Select
          selectedOption={
            selectedDatastore
              ? { label: `${selectedDatastore.name} (${selectedDatastore.id})`, value: selectedDatastore.id }
              : null
          }
          onChange={({ detail }) => {
            const ds = datastores.find(d => d.id === detail.selectedOption?.value);
            setSelectedDatastore(ds || null);
          }}
          options={datastores.map(ds => ({
            label: `${ds.name} (${ds.id})`,
            value: ds.id,
            description: (ds as any).accessLevel === 'read-only'
              ? 'Imported bucket (read-only — upload disabled)'
              : (ds as any).imported ? 'Imported bucket' : 'Storage datastore',
            tags: (ds as any).accessLevel === 'read-only'
              ? ['imported', 'read-only']
              : (ds as any).imported ? ['imported'] : undefined
          }))}
          placeholder="Select a storage datastore"
          empty="No active storage datastores available"
          disabled={datastoresLoading}
          loadingText="Loading datastores..."
          statusType={datastoresLoading ? 'loading' : 'finished'}
        />
      </FormField>
      <Box>
        <Button
          variant="primary"
          iconName="upload"
          disabled={!canUpload}
          onClick={() => setShowUploader(true)}
        >
          Upload DICOM files
        </Button>
        {selectedDatastore && !canUpload && (
          <Box variant="small" color="text-status-inactive" padding={{ top: 'xs' }}>
            {(selectedDatastore as any).accessLevel === 'read-only'
              ? 'This is a read-only imported bucket — uploads into it are disabled.'
              : 'You do not have store permission for this datastore.'}
          </Box>
        )}
      </Box>
    </SpaceBetween>
  );

  return (
    <div style={{ width: '100%', maxWidth: '100vw', boxSizing: 'border-box' }}>
      <Flashbar items={notifications} />
      <SpaceBetween size="l">
        <Header variant="h1" description="Upload DICOM and non-DICOM files and monitor import jobs — all in one place.">
          Import
        </Header>

        <Container>
          <Tabs
            activeTabId={activeTabId}
            onChange={({ detail }) => setActiveTabId(detail.activeTabId as ImportTabId)}
            tabs={[
              { id: 'dicom', label: 'DICOM files', content: dicomTab },
              // Non-DICOM import is the guided V2 experience (always on). The
              // legacy V1 component (NonDicomImport) is retained on disk but no
              // longer wired here.
              { id: 'non-dicom', label: 'Non-DICOM files', content: <NonDicomImportV2 /> },
              { id: 'jobs', label: 'Jobs', content: <ImportManagement /> }
            ]}
          />
        </Container>
      </SpaceBetween>

      {/* DICOM upload modal — composed unchanged, always targeting a STORAGE datastore. */}
      {selectedDatastore && (
        <FileUploader
          visible={showUploader}
          onDismiss={() => setShowUploader(false)}
          datastoreId={selectedDatastore.id}
          datastoreName={selectedDatastore.name}
          onUploadComplete={(s3Paths: string[]) => {
            addNotification('success', 'Upload complete', `${s3Paths.length} series uploaded to ${selectedDatastore.name}. Import jobs created — track them in the Jobs tab.`);
          }}
        />
      )}
    </div>
  );
};

export default ImportCenter;
