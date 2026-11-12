import React from 'react';
import { Header, SpaceBetween } from '@cloudscape-design/components';
import { DeidProfileManager } from './VirtualFolders/DeidProfileManager';

// De-identification Profiles page. Indexing Profiles were removed — the Index
// Attributes menu now covers what VF indexing profiles used to do — so this
// page shows only the de-id profile manager (no tabs).
const VirtualFolderProfiles: React.FC = () => {
  return (
    <SpaceBetween direction="vertical" size="l">
      <Header variant="h1">De-identification Profiles</Header>
      <DeidProfileManager />
    </SpaceBetween>
  );
};

export default VirtualFolderProfiles;
