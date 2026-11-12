import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Tabs, Box, SpaceBetween, Button } from '@cloudscape-design/components';
import { authService } from '../services/authService';
import { apiClient } from '../services/apiClient';
import { configService } from '../services/configService';
import { tabStorageService } from '../services/tabStorageService';
import { Tab, DataSource } from '../types';
import StudyTable from './StudyTable';
import { KnownSource, kindOf } from './dataUserPrefs';
import SourceSettingsModal, { SourceSettingsTarget } from './SourceSettingsModal';

interface StudyBrowserProps {
  onSplitPanelChange?: (content: React.ReactNode) => void;
  /** Called with the source of the active tab (undefined when no tab is open). */
  onActiveSourceChange?: (source?: DataSource) => void;
}

const StudyBrowser = forwardRef<any, StudyBrowserProps>(({ onSplitPanelChange, onActiveSourceChange }, ref) => {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  // Every storage/VF the user can access — for the per-source "apply as default".
  const [knownSources, setKnownSources] = useState<KnownSource[]>([]);
  // The source whose cog was clicked, or null when the settings dialog is closed.
  const [settingsTarget, setSettingsTarget] = useState<SourceSettingsTarget | null>(null);

  useEffect(() => {
    initializeTabs();
  }, []);

  useEffect(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    onActiveSourceChange?.(tab ? { id: tab.sourceId, name: tab.sourceName, type: tab.sourceType } : undefined);
  }, [tabs, activeTabId, onActiveSourceChange]);

  const initializeTabs = async () => {
    const user = await authService.getCurrentUser();
    if (user) {
      setUserId(user.userId);
      const savedTabs = tabStorageService.loadTabs(user.userId);
      
      // Filter out tabs for sources the user no longer has access to
      const [datastores, virtualFolders] = await Promise.all([
        apiClient.getDatastores(),
        apiClient.getVirtualFolders(),
      ]);
      const accessibleIds = new Set([
        ...datastores.map((d: any) => d.id),
        ...virtualFolders.map((vf: any) => vf.id),
      ]);
      setKnownSources([
        ...datastores.map((d: any): KnownSource => ({ kind: kindOf('datastore'), id: d.id })),
        ...virtualFolders.map((vf: any): KnownSource => ({ kind: kindOf('virtualFolder'), id: vf.id })),
      ]);
      const validTabs = savedTabs.filter(t => accessibleIds.has(t.sourceId));
      if (validTabs.length !== savedTabs.length) {
        tabStorageService.saveTabs(user.userId, validTabs);
      }
      
      setTabs(validTabs);
      if (validTabs.length > 0) {
        setActiveTabId(validTabs[0].id);
      }
    }
  };

  const handleAddTab = (source: DataSource) => {
    const existingTab = tabs.find(t => t.sourceId === source.id && t.sourceType === source.type);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    const newTab: Tab = {
      id: `${source.type}-${source.id}-${Date.now()}`,
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type
    };

    const updatedTabs = [...tabs, newTab];
    setTabs(updatedTabs);
    setActiveTabId(newTab.id);
    
    if (userId) {
      tabStorageService.saveTabs(userId, updatedTabs);
    }
  };

  const handleCloseTab = (tabId: string) => {
    const updatedTabs = tabs.filter(t => t.id !== tabId);
    setTabs(updatedTabs);
    
    if (activeTabId === tabId) {
      setActiveTabId(updatedTabs.length > 0 ? updatedTabs[0].id : '');
    }
    
    if (userId) {
      tabStorageService.saveTabs(userId, updatedTabs);
    }
  };

  useImperativeHandle(ref, () => ({
    handleAddTab
  }));

  const config = configService.getConfig();
  // Tool ids/labels the Default-tools picker offers — the configured apps plus the
  // optional VolView / Attach-files tools, matching the ids StudyTable stars by.
  const toolCatalogue: { id: string; label: string }[] = [
    ...(config?.applications || []).map((a: any) => ({ id: a.id, label: a.name })),
    ...(config?.volviewViewerUrl ? [{ id: 'volview', label: 'VolView' }] : []),
    { id: 'attach-files', label: 'Attach files' },
  ];

  return (
    <SpaceBetween size="l">
      {tabs.length === 0 ? (
        <Box textAlign="center" padding="xxl" color="text-body-secondary">
          <p>Select a storage or virtual folder in the sidebar to browse its studies.</p>
        </Box>
      ) : (
        <Tabs
          activeTabId={activeTabId}
          onChange={({ detail }) => setActiveTabId(detail.activeTabId)}
          tabs={tabs.map(tab => ({
            id: tab.id,
            label: tab.sourceName,
            dismissible: true,
            onDismiss: () => handleCloseTab(tab.id),
            action: (
              <Button
                variant="inline-icon"
                iconName="settings"
                ariaLabel={`Settings for ${tab.sourceName}`}
                onClick={() => setSettingsTarget({ id: tab.sourceId, name: tab.sourceName, type: tab.sourceType })}
              />
            ),
            content: <StudyTable 
              sourceId={tab.sourceId} 
              sourceType={tab.sourceType}
              sourceName={tab.sourceName}
              userId={userId}
              onSplitPanelChange={onSplitPanelChange}
            />
          }))}
        />
      )}
      <SourceSettingsModal
        target={settingsTarget}
        userId={userId}
        knownSources={knownSources}
        toolCatalogue={toolCatalogue}
        onClose={() => setSettingsTarget(null)}
      />
    </SpaceBetween>
  );
});

StudyBrowser.displayName = 'StudyBrowser';

export default StudyBrowser;
