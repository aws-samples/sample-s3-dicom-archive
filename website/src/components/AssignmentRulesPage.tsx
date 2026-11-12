import React, { useState, useEffect } from 'react';
import { Container, Header, Select, SpaceBetween, Alert } from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';
import { AssignmentRulesManagement } from './VirtualFolders/AssignmentRulesManagement';

export const AssignmentRulesPage: React.FC = () => {
  const [virtualFolders, setVirtualFolders] = useState<any[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadVirtualFolders();
  }, []);

  const loadVirtualFolders = async () => {
    try {
      setLoading(true);
      const response = await apiClient.getVirtualFolders({ page: 1, pageSize: 100 });
      if (response.success && response.data) {
        const folders = response.data.items || [];
        setVirtualFolders(folders);
        if (folders.length > 0) {
          setSelectedFolder({ label: folders[0].name, value: folders[0].id });
        }
      }
    } catch (err) {
      console.error('Failed to load virtual folders:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="Automatically assign studies to virtual folders based on DICOM attributes">
        Virtual Folder Assignment Rules
      </Header>
      <SpaceBetween size="m">
        <Select
          selectedOption={selectedFolder}
          onChange={({ detail }) => setSelectedFolder(detail.selectedOption)}
          options={virtualFolders.map(vf => ({ label: vf.name, value: vf.id }))}
          placeholder="Select a virtual folder"
          loadingText="Loading virtual folders..."
          statusType={loading ? 'loading' : 'finished'}
        />
          
        {!selectedFolder && !loading && virtualFolders.length === 0 && (
          <Alert type="info">
            No virtual folders found. Create a virtual folder first to manage assignment rules.
          </Alert>
        )}
      </SpaceBetween>

      {selectedFolder && (
        <AssignmentRulesManagement 
          virtualFolderId={selectedFolder.value} 
          onClose={() => {}} 
        />
      )}
    </SpaceBetween>
  );
};
