import React, { useEffect, useState, useRef, useCallback } from 'react';
import '@cloudscape-design/global-styles/index.css';
import { Spinner, Box, Modal, SpaceBetween, Button, FormField, Multiselect, Select } from '@cloudscape-design/components';
import { DataUserShell, ShellSource } from './ui/data-user-shell';
import { getModalityOptions } from './constants/dicomModalities';
import { applyMode, applyDensity, Density } from '@cloudscape-design/global-styles';
import { configService } from './services/configService';
import { authService } from './services/authService';
import { apiClient } from './services/apiClient';
import { dicomwebService } from './services/dicomwebService';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import LoginPage from './components/LoginPage';
import ResetPasswordPage from './components/ResetPasswordPage';
import StudyBrowser from './components/StudyBrowser';
import { DataSource } from './types';
import { useSplitPanel } from './hooks/useSplitPanel';
import { useNonDicomImportV2 } from './hooks/useNonDicomImportV2';
import { nonDicomImportV2Service } from './services/nonDicomImportV2Service';
import NonDicomImportV2 from './components/NonDicomImportV2';

const AppContent: React.FC = () => {
  const { theme, customTheme, toggleTheme, colorTheme, setColorTheme, colorThemes } = useTheme();
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState<string>('');
  const [userId, setUserId] = useState<string>('');
  const [showPreferencesModal, setShowPreferencesModal] = useState(false);
  const [modalityAppPrefs, setModalityAppPrefs] = useState<Record<string, string[]>>(
    () => JSON.parse(localStorage.getItem('modalityAppPreferences2') || '{}')
  );
  const [sources, setSources] = useState<ShellSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  // True once any storage/folder grants canDownload: only then is a 'download'
  // app offered as a per-modality default in Preferences.
  const [anyDownload, setAnyDownload] = useState(false);
  const [activeSource, setActiveSource] = useState<DataSource | undefined>(undefined);
  const [splitPanelContent, setSplitPanelContent] = useState<React.ReactNode>(null);
  const studyBrowserRef = useRef<any>(null);
  // 'import' shows Non-DICOM Import V2; the study browser stays mounted underneath.
  const [view, setView] = useState<'browse' | 'import'>('browse');
  // Kept mounted while the user browses, so unsubmitted uploads survive a source click.
  const [importMounted, setImportMounted] = useState(false);
  const { available: importAvailable } = useNonDicomImportV2(authenticated);

  const { splitPanelOpen, onSplitPanelToggle, splitPanelSize, onSplitPanelResize } = useSplitPanel(splitPanelContent);

  useEffect(() => {
    initializeApp();
  }, []);

  useEffect(() => {
    applyMode(theme);
    applyDensity(Density.Compact);
  }, [theme]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    (async () => {
      setSourcesLoading(true);
      try {
        const config = configService.getConfig();
        const [datastores, folders] = await Promise.all([
          apiClient.getDatastores(),
          config.virtualFolderEnabled ? apiClient.getVirtualFolders() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const loaded = [
          ...datastores.map(ds => ({ id: ds.id, name: ds.name, type: 'datastore' as const })),
          ...folders.map(vf => ({ id: vf.id, name: vf.name, type: 'virtualFolder' as const })),
        ];
        setSources(loaded);
        if (config.applications.some(a => a.type === 'download')) {
          Promise.all(loaded.map(src => dicomwebService.canDownload(src.id)))
            .then(verdicts => { if (!cancelled) setAnyDownload(verdicts.some(Boolean)); });
        }
      } catch (error: any) {
        console.error('Failed to load sources:', error?.message);
      } finally {
        if (!cancelled) setSourcesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authenticated]);

  const handleActiveSourceChange = useCallback((source?: DataSource) => setActiveSource(source), []);

  // Handle /reset-password route (after hooks)
  if (window.location.pathname === '/reset-password') {
    return <ResetPasswordPage />;
  }

  const initializeApp = async () => {
    try {
      const config = await configService.loadConfig();
      authService.configure({
        region: config.region,
        userPoolId: config.userPoolId,
        userPoolWebClientId: config.userPoolWebClientId
      });

      const user = await authService.initialize();
      if (user) {
        console.log('Found existing session');
        setAuthenticated(true);
        setUsername(user.username);
        setUserId(user.userId);
      }
    } catch (error: any) {
      console.error('Failed to initialize app:', error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async () => {
    const user = await authService.getCurrentUser();
    if (user) {
      setAuthenticated(true);
      setUsername(user.username);
      setUserId(user.userId);
    }
  };

  const handleLogout = async () => {
    await authService.logout();
    dicomwebService.clearDownloadAccess();
    nonDicomImportV2Service.reset();
    setView('browse');
    setImportMounted(false);
    setAnyDownload(false);
    setAuthenticated(false);
    setUsername('');
    setUserId('');
  };

  const handleOpenSource = (source: ShellSource) => {
    setView('browse');
    if (studyBrowserRef.current?.handleAddTab) {
      studyBrowserRef.current.handleAddTab(source);
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  }

  if (!authenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const config = configService.getConfig();

  const preferencesModal = (
    <Modal
      visible={showPreferencesModal}
      onDismiss={() => setShowPreferencesModal(false)}
      header="Preferences"
      footer={<Box float="right"><Button variant="primary" onClick={() => setShowPreferencesModal(false)}>Close</Button></Box>}
    >
      <SpaceBetween size="m">
        <FormField
          label="Theme"
          description="Color theme for the whole interface. The sun/moon button switches between your last light and last dark theme."
        >
          <Select
            selectedOption={{ label: colorTheme.label, value: colorTheme.id }}
            onChange={({ detail }) => {
              if (detail.selectedOption.value) setColorTheme(detail.selectedOption.value);
            }}
            options={colorThemes.map(t => ({ label: t.label, value: t.id }))}
          />
        </FormField>

        <FormField label="Default app per modality">
          <SpaceBetween size="s">
            {(configService.getConfig()?.applications || [])
              .filter((app: any) => app.type !== 'download' || anyDownload)
              .map((app: any) => {
              const selected = modalityAppPrefs[app.id] || [];
              const isAll = selected.includes('__ALL__');
              const selectedOptions = isAll
                ? [{ label: 'All', value: '__ALL__' }]
                : selected.map(v => ({ label: v, value: v }));
              return (
                <FormField key={app.id} label={app.name}>
                  <Multiselect
                    selectedOptions={selectedOptions}
                    placeholder="None"
                    options={[{ label: 'All', value: '__ALL__' }, ...getModalityOptions()]}
                    onChange={({ detail }) => {
                      const values = detail.selectedOptions.map(o => o.value as string);
                      const hasAll = values.includes('__ALL__');
                      const updated = { ...modalityAppPrefs };
                      if (hasAll) {
                        Object.keys(updated).forEach(id => {
                          if (id !== app.id && updated[id]?.includes('__ALL__')) {
                            updated[id] = [];
                          }
                        });
                        updated[app.id] = ['__ALL__'];
                      } else {
                        updated[app.id] = values;
                      }
                      setModalityAppPrefs(updated);
                      localStorage.setItem('modalityAppPreferences2', JSON.stringify(updated));
                    }}
                  />
                </FormField>
              );
            })}
          </SpaceBetween>
        </FormField>
      </SpaceBetween>
    </Modal>
  );

  return (
    <>
      <DataUserShell
        sources={sources}
        sourcesLoading={sourcesLoading}
        activeSourceId={activeSource?.id}
        onOpenSource={handleOpenSource}
        title={view === 'import' ? 'Import files' : activeSource?.name}
        currentUser={{ username }}
        onOpenPreferences={() => setShowPreferencesModal(true)}
        onSignout={handleLogout}
        toggleTheme={toggleTheme}
        customTheme={customTheme}
        version={config?.version}
        importEntry={importAvailable ? { active: view === 'import', onOpen: () => { setImportMounted(true); setView('import'); } } : undefined}
        splitPanel={{
          content: view === 'import' ? null : splitPanelContent,
          open: splitPanelOpen,
          size: splitPanelSize,
          onToggle: open => onSplitPanelToggle?.({ detail: { open } } as any),
          onResize: size => onSplitPanelResize?.({ detail: { size } } as any),
        }}
      >
        <div style={{ display: view === 'import' ? 'none' : undefined }}>
          <StudyBrowser
            ref={studyBrowserRef}
            onSplitPanelChange={setSplitPanelContent}
            onActiveSourceChange={handleActiveSourceChange}
          />
        </div>
        {importMounted && importAvailable && (
          <div style={{ display: view === 'import' ? undefined : 'none' }}>
            <NonDicomImportV2 onClose={() => { setView('browse'); setImportMounted(false); }} />
          </div>
        )}
      </DataUserShell>
      {preferencesModal}
    </>
  );
};

const App: React.FC = () => (
  <ThemeProvider>
    <AppContent />
  </ThemeProvider>
);

export default App;
