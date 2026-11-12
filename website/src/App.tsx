import React, { useState, useEffect } from 'react';
import ChangelogMarkdown from './components/ChangelogMarkdown';
import {
  AppLayout,
  SideNavigation,
  TopNavigation,
  SideNavigationProps,
  Flashbar,
  Modal,
  Header,
  SpaceBetween,
  Box,
  Button,
  Form,
  FormField,
  Toggle,
  Container,
  ColumnLayout,
  Badge,
  StatusIndicator,
  Spinner,
  Select,
  Input,
  Alert
} from '@cloudscape-design/components';
import ResizeObserverErrorBoundary from './components/ResizeObserverErrorBoundary';
import ErrorBoundary from './components/ErrorBoundary';
import '@cloudscape-design/global-styles/index.css';
import './App.css';
// website: the Cloudscape nav skin stylesheet is not used (src/ui/layout.tsx is the shell).
import CommandPalette, { CommandItem } from './components/CommandPalette';
import { AppShell } from './ui/layout';
import { applyMode, applyDensity, Mode, Density } from '@cloudscape-design/global-styles';

// Import contexts
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';

// Import login modal
import LoginModal from './components/LoginModal';

// Import all feature components
import Dashboard from './components/Dashboard';
import DatastoreManagement from './components/DatastoreManagement';
import DicomEntities from './pages/DicomEntities';
import DicomStudiesManagement from './components/DicomStudiesManagement';
import DicomInterfaceManagement from './components/DicomInterfaceManagement';
import Hl7EntityManagement from './components/Hl7EntityManagement';
import Hl7InterfaceManagement from './components/Hl7InterfaceManagement';
import Locations from './components/Locations';
import IndexAttributes from './components/IndexAttributes';import InterfaceServerMonitor from './components/InterfaceServerMonitor';
import SystemMonitor from './components/SystemMonitor';
import PrivilegeGroups from './components/PrivilegeGroups';
import Users from './components/Users';
import ImportCenter, { ImportTabId } from './components/ImportCenter';
import ExceptionManagement from './components/ExceptionManagement';
import RoutingRulesManagement from './components/RoutingRulesManagement';
import AuditTrail from './components/AuditTrail';
// AnalyticsProjects removed from the UI (NO-PROJECTS model). The component file
// and its backend create/list APIs remain in place (dead-but-harmless).
import AnalyticsQuery from './components/AnalyticsQuery';
import ProcessingJobs from './components/ProcessingJobs';
import ProcessingJobSchedules from './components/ProcessingJobSchedules';
import LifecycleManagement from './components/LifecycleManagement';
import AuthToken from './components/AuthToken';
import AwsResources from './components/AwsResources';
import VirtualFolderManagement from './components/VirtualFolderManagement';
import VirtualFolderProfiles from './components/VirtualFolderProfiles';
import { AssignmentRulesPage } from './components/AssignmentRulesPage';
import { usePrivileges } from './contexts/PrivilegesContext';
import { PrivilegesProvider } from './contexts/PrivilegesContext';
import { ConfigProvider } from './contexts/ConfigContext';


// Configuration from runtime config or environment variables
const config = (window as any).REACT_APP_CONFIG || {};
const UI_DEBUG = config.UI_DEBUG;
const VIRTUAL_FOLDER = config.VIRTUAL_FOLDER === 'true';

const AppContent: React.FC = () => {
  const { theme, customTheme, toggleTheme, colorTheme, setColorTheme, colorThemes } = useTheme();
  const { isAuthenticated, user, loading, login, logout } = useAuth();
  const { 
    privileges,
    hasManagementAccess, 
    canAccessDataManagement, 
    canAccessConfiguration, 
    canAccessUserManagement 
  } = usePrivileges();
  
  const [activeHref, setActiveHref] = useState('/dashboard');
  // Deep-link state for the unified Import center: which tab to open and which
  // storage datastore to preselect (set by the Studies page's Upload shortcut).
  const [importDeepLink, setImportDeepLink] = useState<{ tab: ImportTabId; datastoreId?: string }>({ tab: 'dicom' });
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('navCollapsed') === 'true');
  const [showPreferencesModal, setShowPreferencesModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showChangelogModal, setShowChangelogModal] = useState(false);
  const [changelog, setChangelog] = useState('');
  const [showLoginModal, setShowLoginModal] = useState(!isAuthenticated);
  const [showChangePasswordConfirm, setShowChangePasswordConfirm] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  // Load changelog
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}CHANGELOG.md`)
      .then(res => res.text())
      .then(text => setChangelog(text))
      .catch(() => setChangelog('Changelog not available'));
  }, []);

  // Apply theme and density to Cloudscape
  useEffect(() => {
    applyMode(theme);
  }, [theme]);

  useEffect(() => {
    applyDensity(Density.Compact);
  }, []);

  // ⌘K / Ctrl-K opens the command palette (Modern skin enhancement).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Collapse the sidebar to an icon rail (Modern skin only): toggles a body
  // class the skin stylesheet keys off; persisted like the other prefs.
  useEffect(() => {
    localStorage.setItem('navCollapsed', String(navCollapsed));
    document.body.classList.toggle('nav-collapsed', navCollapsed);
  }, [navCollapsed]);

  // Show login modal when not authenticated
  useEffect(() => {
    if (!loading && !isAuthenticated) {
      setShowLoginModal(true);
    } else {
      setShowLoginModal(false);
    }
  }, [isAuthenticated, loading]);

  const handleLogin = async (username: string, password: string) => {
    await login(username, password);
  };

  const handleLogout = () => {
    logout();
    setShowLoginModal(true);
  };

  const handleChangePassword = async () => {
    // Validate passwords
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All fields are required');
      return;
    }
    
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    
    if (newPassword.length < 12) {
      setPasswordError('Password must be at least 12 characters long');
      return;
    }
    
    setChangingPassword(true);
    setPasswordError('');
    
    try {
      const { updatePassword } = await import('aws-amplify/auth');
      await updatePassword({ oldPassword: currentPassword, newPassword: newPassword });
      
      setShowChangePasswordConfirm(false);
      setShowProfileModal(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error: any) {
      console.error('Error changing password:', error.message);
      setPasswordError(error.message || 'Failed to change password. Please check your current password and try again.');
    } finally {
      setChangingPassword(false);
    }
  };

  const navigationItems: SideNavigationProps.Item[] = [
    { type: 'link', text: 'Dashboard', href: '/dashboard' },
    ...(canAccessDataManagement() ? [{ 
      type: 'section' as const,
      text: 'Data Management',
      items: [
        { type: 'link' as const, text: 'DICOM Studies', href: '/dicom-studies' },
        ...(hasManagementAccess('datastores', 'canEdit') || privileges?.datastorePrivileges.some(p => p.canStore) ? [
          { type: 'link' as const, text: 'Import', href: '/import' }
        ] : []),
        ...(hasManagementAccess('analytics', 'canList') || hasManagementAccess('analytics', 'canQuery') ? [{
          type: 'link' as const,
          text: 'Analytics',
          href: '/analytics-query',
        }] : []),
        ...(hasManagementAccess('processingJobs', 'canRead') ? [{
          type: 'link' as const, text: 'Processing Jobs', href: '/processing-jobs'
        }] : []),
        ...(hasManagementAccess('processingJobs', 'canRead') ? [{
          type: 'link' as const, text: 'Job Schedules', href: '/processing-job-schedules'
        }] : [])
      ]
    }] : []),
    ...(canAccessConfiguration() ? [{
      type: 'section' as const,
      text: 'Configuration',
      items: [
        ...(hasManagementAccess('datastores', 'canList') ? [{ type: 'link' as const, text: 'Storage', href: '/datastores' }] : []),
        ...(hasManagementAccess('indexAttributes', 'canList') ? [{ type: 'link' as const, text: 'Searchable Attributes', href: '/index-attributes' }] : []),
        ...(VIRTUAL_FOLDER && hasManagementAccess('virtualFolders', 'canList') ? [
          {
            type: 'expandable-link-group' as const,
            text: 'Virtual Folders',
            href: '/virtual-folders',
            items: [
              { type: 'link' as const, text: 'Folders', href: '/virtual-folders' },
              { type: 'link' as const, text: 'De-identification Profiles', href: '/virtual-folder-profiles' },
              { type: 'link' as const, text: 'Assignment Rules', href: '/virtual-folder-assignment-rules' }
            ]
          }
        ] : []),
        // TODO: Re-enable when HL7 implementation is ready
        // { type: 'link' as const, text: 'HL7 Entities', href: '/hl7-entities' },
        ...(hasManagementAccess('locations', 'canList') ? [{ type: 'link' as const, text: 'Locations', href: '/locations' }] : []),
        ...((hasManagementAccess('dicomEntities', 'canList') || hasManagementAccess('interfaces', 'canList') || hasManagementAccess('routingRules', 'canList')) ? [
          { 
            type: 'expandable-link-group' as const, 
            text: 'DICOM', 
            href: '/dicom-entities',
            items: [
              ...(hasManagementAccess('dicomEntities', 'canList') ? [{ type: 'link' as const, text: 'DICOM Entities', href: '/dicom-entities' }] : []),
              ...(hasManagementAccess('interfaces', 'canList') ? [{ type: 'link' as const, text: 'DICOM Interfaces', href: '/dicom-interfaces' }] : []),
              ...(hasManagementAccess('routingRules', 'canList') ? [{ type: 'link' as const, text: 'Routing Rules', href: '/routing' }] : []),
              // TODO: Re-enable when HL7 implementation is ready
              // { type: 'link' as const, text: 'HL7 Interfaces', href: '/hl7-interfaces' }
            ]
          }
        ] : []),
      ]
    }] : []),
    ...(canAccessUserManagement() ? [{
      type: 'section' as const,
      text: 'Management',
      items: [
        ...(hasManagementAccess('users', 'canList') ? [{ type: 'link' as const, text: 'Users', href: '/users' }] : []),
        ...(hasManagementAccess('privilegeGroups', 'canList') ? [{ type: 'link' as const, text: 'Privilege Groups', href: '/groups' }] : []),
        ...(hasManagementAccess('auditTrail', 'canList') ? [{ type: 'link' as const, text: 'Audit Trail', href: '/audit' }] : [])
      ]
    }] : []),
    ...(hasManagementAccess('systemMonitor', 'canList') ? [{
      type: 'section' as const,
      text: 'System',
      items: [
        ...(hasManagementAccess('interfaces', 'canList') ? [{ type: 'link' as const, text: 'Interface Server Monitor', href: '/interface-servers' }] : []),
        { type: 'link' as const, text: 'Queues Monitor', href: '/system-monitor' },
        { type: 'link' as const, text: 'AWS Resources', href: '/aws-resources' }
      ]
    }] : []),
    ...(UI_DEBUG === 'true' ? [{
      type: 'section' as const,
      text: 'Debugging',
      items: [
        { type: 'link' as const, text: 'Auth Token', href: '/debug/auth-token' }
      ]
    }] : [])
  ];

  const renderContent = () => {
    // Show loading spinner while authentication is being checked
    if (loading) {
      return (
        <Box textAlign="center" padding="xxl">
          <SpaceBetween direction="vertical" size="m">
            <Spinner size="large" />
            <Box variant="h3">Loading...</Box>
          </SpaceBetween>
        </Box>
      );
    }

    // If not authenticated, don't render content (login modal will show)
    if (!isAuthenticated) {
      return (
        <Box textAlign="center" padding="xxl">
          <SpaceBetween direction="vertical" size="m">
            <Box variant="h2">Please sign in to access the application</Box>
          </SpaceBetween>
        </Box>
      );
    }

    // Render content based on active route
    switch (activeHref) {
      case '/dashboard':
        if (privileges && !canAccessDataManagement() && !canAccessConfiguration() && !canAccessUserManagement()) {
          return (
            <SpaceBetween size="m">
              <Alert type="info">You are not privileged to view dashboard data. Contact an administrator to request access.</Alert>
              <Dashboard />
            </SpaceBetween>
          );
        }
        return <Dashboard />;
      case '/datastores':
        return <DatastoreManagement />;
      case '/virtual-folders':
        return <VirtualFolderManagement />;
      case '/virtual-folder-profiles':
        return (
          <ErrorBoundary>
            <VirtualFolderProfiles />
          </ErrorBoundary>
        );
      case '/dicom-entities':
        return <DicomEntities />;
      case '/dicom-studies':
        return (
          <DicomStudiesManagement
            onNavigateToImport={(datastoreId?: string) => {
              setImportDeepLink({ tab: 'dicom', datastoreId });
              setActiveHref('/import');
            }}
          />
        );
      case '/locations':
        return (
          <ResizeObserverErrorBoundary>
            <Locations />
          </ResizeObserverErrorBoundary>
        );
      case '/index-attributes':
        return (
          <ResizeObserverErrorBoundary>
            <IndexAttributes />
          </ResizeObserverErrorBoundary>
        );
      case '/system-monitor':
        return <SystemMonitor />;
      case '/interface-servers':
        return (
          <ResizeObserverErrorBoundary>
            <InterfaceServerMonitor />
          </ResizeObserverErrorBoundary>
        );
      case '/dicom-interfaces':
        return (
          <ResizeObserverErrorBoundary>
            <DicomInterfaceManagement />
          </ResizeObserverErrorBoundary>
        );
      case '/hl7-entities':
        return <Hl7EntityManagement />;
      case '/hl7-interfaces':
        return (
          <ResizeObserverErrorBoundary>
            <Hl7InterfaceManagement />
          </ResizeObserverErrorBoundary>
        );
      case '/users':
        return <Users />;
      case '/groups':
        return <PrivilegeGroups />;
      case '/aws-resources':
        return <AwsResources />;
      case '/imports':
        // Legacy route preserved: the import-jobs monitor now lives in the
        // unified Import center's Jobs tab.
        return <ImportCenter defaultTab="jobs" />;
      case '/non-dicom-import':
        // Legacy route preserved: non-DICOM import now lives in the unified
        // Import center's Non-DICOM files tab.
        return <ImportCenter defaultTab="non-dicom" />;
      case '/import':
        return <ImportCenter defaultTab={importDeepLink.tab} initialDatastoreId={importDeepLink.datastoreId} />;
      case '/exceptions':
        return <ExceptionManagement />;
      case '/routing':
        return <RoutingRulesManagement />;
      case '/audit':
        return <AuditTrail />;
      case '/lifecycle':
        return <LifecycleManagement />;
      case '/virtual-folder-assignment-rules':
        return <AssignmentRulesPage />;
      case '/debug/auth-token':
        // Debug-only page (shows the caller's own tokens). Served only when the
        // deployment is built with debugUi=true; otherwise show the default view.
        return UI_DEBUG === 'true' ? <AuthToken /> : <Dashboard />;
      case '/analytics-projects':
        // NO-PROJECTS: the Projects view is gone; keep the path as a back-compat
        // redirect to the standalone Query view.
        return <AnalyticsQuery />;
      case '/analytics-query':
        return <AnalyticsQuery />;
      case '/processing-jobs':
        return <ProcessingJobs />;
      case '/processing-job-schedules':
        return <ProcessingJobSchedules />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <>
      <AppShell
        navItems={navigationItems}
        activeHref={activeHref}
        onNavigate={(href) => setActiveHref(href)}
        currentUser={user}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenPreferences={() => setShowPreferencesModal(true)}
        onOpenProfile={() => setShowProfileModal(true)}
        onOpenChangelog={() => setShowChangelogModal(true)}
        onSignout={handleLogout}
        toggleTheme={toggleTheme}
        customTheme={customTheme}
        dataUserUrl={
          (window as any).REACT_APP_CONFIG?.VIRTUAL_FOLDER === 'true'
            ? (window as any).REACT_APP_CONFIG?.DATA_USER_UI_URL || undefined
            : undefined
        }
        version={import.meta.env.VITE_VERSION}
        stackName={(window as any).REACT_APP_CONFIG?.STACK_NAME || 'default'}
        fullWidth={activeHref === '/analytics-query' || activeHref === '/analytics-projects'}
      >
        {renderContent()}
      </AppShell>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(href) => setActiveHref(href)}
        items={[
          { group: 'Go to', label: 'Dashboard', href: '/dashboard' },
          { group: 'Go to', label: 'DICOM Studies', href: '/dicom-studies', keywords: 'images series' },
          { group: 'Go to', label: 'Virtual Folders', href: '/virtual-folders', keywords: 'vf' },
          { group: 'Go to', label: 'Analytics', href: '/analytics-projects' },
          { group: 'Go to', label: 'Processing Jobs', href: '/processing-jobs' },
          { group: 'Go to', label: 'Storage', href: '/datastores', keywords: 'datastore' },
          { group: 'Go to', label: 'Locations', href: '/locations' },
          { group: 'Go to', label: 'Users', href: '/users' },
          { group: 'Go to', label: 'Privilege Groups', href: '/groups' },
          { group: 'Go to', label: 'Audit Trail', href: '/audit' },
          { group: 'Actions', label: 'Import DICOM files…', href: '/import', keywords: 'upload dicom' },
          { group: 'Actions', label: 'Non-DICOM Import…', href: '/import', keywords: 'non-dicom pdf image video' },
        ] as CommandItem[]}
      />

      {/* Login Modal */}
      <LoginModal
        visible={showLoginModal}
        onLogin={handleLogin}
        onDismiss={() => {
          // Only allow dismissing if already authenticated
          if (isAuthenticated) {
            setShowLoginModal(false);
          }
        }}
      />

      {/* Changelog Modal */}
      <Modal
        onDismiss={() => setShowChangelogModal(false)}
        visible={showChangelogModal}
        closeAriaLabel="Close changelog"
        size="max"
        footer={
          <Box float="right">
            <Button variant="primary" onClick={() => setShowChangelogModal(false)}>
              Close
            </Button>
          </Box>
        }
        header="Version History & Changelog"
      >
        <Container>
          <div style={{ fontSize: '14px', lineHeight: '1.6' }}>
            <ChangelogMarkdown>{changelog}</ChangelogMarkdown>
          </div>
        </Container>
      </Modal>

      {/* User Profile Modal */}
      <Modal
        onDismiss={() => setShowProfileModal(false)}
        visible={showProfileModal}
        closeAriaLabel="Close profile modal"
        size="medium"
        footer={
          <Box float="right">
            <Button variant="primary" onClick={() => setShowProfileModal(false)}>
              Close
            </Button>
          </Box>
        }
        header="User Profile"
      >
        <SpaceBetween direction="vertical" size="l">
          <Container>
            <ColumnLayout columns={2}>
              <SpaceBetween direction="vertical" size="s">
                <Box>
                  <Box variant="awsui-key-label">Username</Box>
                  <Box variant="strong">{user?.username || 'N/A'}</Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Email</Box>
                  <Box>{user?.email || 'N/A'}</Box>
                </Box>
              </SpaceBetween>
              <SpaceBetween direction="vertical" size="s">
                <Box>
                  <Box variant="awsui-key-label">Groups</Box>
                  <Badge color="blue">{user?.groups?.join(', ') || 'N/A'}</Badge>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Status</Box>
                  <StatusIndicator type="success">Active</StatusIndicator>
                </Box>
              </SpaceBetween>
            </ColumnLayout>
          </Container>

          <Container header={<Header variant="h3">Group Memberships</Header>}>
            <SpaceBetween direction="horizontal" size="xs">
              {user?.groups?.map(group => (
                <Badge key={group} color="grey">{group}</Badge>
              )) || <Box>No groups assigned</Box>}
            </SpaceBetween>
          </Container>

          <Container header={<Header variant="h3">Security</Header>}>
            <FormField
              label="Password"
              description="Reset your password. You will be logged out and required to set a new password on next login."
            >
              <Button onClick={() => setShowChangePasswordConfirm(true)}>
                Change Password
              </Button>
            </FormField>
          </Container>
        </SpaceBetween>
      </Modal>

      {/* User Preferences Modal */}
      <Modal
        onDismiss={() => setShowPreferencesModal(false)}
        visible={showPreferencesModal}
        closeAriaLabel="Close preferences modal"
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowPreferencesModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setShowPreferencesModal(false)}>
                Save Preferences
              </Button>
            </SpaceBetween>
          </Box>
        }
        header="User Preferences"
      >
        <Form>
          <SpaceBetween direction="vertical" size="l">
            <Container header={<Header variant="h3">Appearance</Header>}>
              <SpaceBetween direction="vertical" size="m">
              <FormField
                label="Theme"
                description="Color theme for the whole interface. The sun/moon button switches between your last light and last dark theme."
              >
                <Select
                  selectedOption={{ label: colorTheme.label, value: colorTheme.id }}
                  onChange={({ detail }) => {
                    if (detail.selectedOption.value) {
                      setColorTheme(detail.selectedOption.value);
                    }
                  }}
                  options={colorThemes.map(t => ({ label: t.label, value: t.id }))}
                />
              </FormField>
              </SpaceBetween>
            </Container>

            <Container header={<Header variant="h3">Data Display</Header>}>
              <SpaceBetween direction="vertical" size="m">
                <FormField
                  label="Default Page Size"
                  description="Number of items to display per page in tables"
                >
                  <Box variant="small" color="text-status-inactive">
                    Currently set to 25 items per page
                  </Box>
                </FormField>
                
                <FormField
                  label="Date Format"
                  description="Preferred date format for displaying study dates"
                >
                  <Box variant="small" color="text-status-inactive">
                    Currently set to MM/DD/YYYY
                  </Box>
                </FormField>
              </SpaceBetween>
            </Container>

            <Container header={<Header variant="h3">Notifications</Header>}>
              <SpaceBetween direction="vertical" size="m">
                <FormField
                  label="Import Notifications"
                  description="Receive notifications when import jobs complete"
                >
                  <Toggle checked={true}>
                    Email notifications enabled
                  </Toggle>
                </FormField>
                
                <FormField
                  label="Exception Alerts"
                  description="Receive alerts when new exceptions require attention"
                >
                  <Toggle checked={true}>
                    Exception alerts enabled
                  </Toggle>
                </FormField>
              </SpaceBetween>
            </Container>

            <Container header={<Header variant="h3">Privacy</Header>}>
              <SpaceBetween direction="vertical" size="s">
                <Box>
                  <Box variant="awsui-key-label">Data Retention</Box>
                  <Box variant="small">
                    Your activity logs are retained for 90 days by default (configurable by your administrator).
                  </Box>
                </Box>
                <Box>
                  <Box variant="awsui-key-label">Audit Trail</Box>
                  <Box variant="small">
                    All your actions are logged for compliance and security purposes.
                  </Box>
                </Box>
              </SpaceBetween>
            </Container>
          </SpaceBetween>
        </Form>
      </Modal>

      {/* Change Password Confirmation Modal */}
      <Modal
        onDismiss={() => {
          setShowChangePasswordConfirm(false);
          setCurrentPassword('');
          setNewPassword('');
          setConfirmPassword('');
          setPasswordError('');
        }}
        visible={showChangePasswordConfirm}
        closeAriaLabel="Close"
        size="medium"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => {
                setShowChangePasswordConfirm(false);
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                setPasswordError('');
              }}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleChangePassword} loading={changingPassword}>
                Change Password
              </Button>
            </SpaceBetween>
          </Box>
        }
        header="Change Password"
      >
        <Form errorText={passwordError}>
          <SpaceBetween size="m">
            <FormField label="Current Password">
              <Input
                type="password"
                value={currentPassword}
                onChange={({ detail }) => setCurrentPassword(detail.value)}
                placeholder="Enter current password"
              />
            </FormField>
            <FormField label="New Password">
              <Input
                type="password"
                value={newPassword}
                onChange={({ detail }) => setNewPassword(detail.value)}
                placeholder="Enter new password (min 12 characters)"
              />
            </FormField>
            <FormField label="Confirm New Password">
              <Input
                type="password"
                value={confirmPassword}
                onChange={({ detail }) => setConfirmPassword(detail.value)}
                placeholder="Confirm new password"
              />
            </FormField>
          </SpaceBetween>
        </Form>
      </Modal>
    </>
  );
};

const App: React.FC = () => {
  return (

      <ThemeProvider>
        <AuthProvider>
          <PrivilegesProvider>
              <ConfigProvider>
                <AppContent />
            </ConfigProvider>
          </PrivilegesProvider>
        </AuthProvider>
      </ThemeProvider>
  );
};

export default App;
