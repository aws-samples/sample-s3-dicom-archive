import React, { useState, useEffect } from 'react';
import { formatTimestamp } from '../utils/dateUtils';
import {
  Container,
  Header,
  Table,
  Box,
  SpaceBetween,
  Button,
  Modal,
  FormField,
  Input,
  Multiselect,
  StatusIndicator,
  Alert,
  Checkbox,
  Toggle,
  ButtonDropdown
} from '@cloudscape-design/components';
import { privilegeGroupService, userService } from '../services';
import { usePrivileges } from '../contexts/PrivilegesContext';

interface PrivilegeGroup {
  id: string;
  name: string;
  description: string;
  userMode?: string;
}

interface User {
  id: string;
  username?: string;
  email: string;
  firstName: string;
  lastName: string;
  description?: string;
  privilegeGroupId: string | null;
  privilegeGroupName?: string;
  privilegeGroupIds?: string[];
  privilegeGroups?: { id: string; name: string }[];
  status: string;
  createdAt: string;
  lastLogin?: string | null;
  mfaEnabled?: boolean;
}

// Human-friendly badge text for each user_mode shown beside a privilege group
// in the multiselect.
const USER_MODE_LABELS: Record<string, string> = {
  SYSTEM_USER: 'System User',
  DATA_USER: 'Data User',
  DEPLOYER_USER: 'Deployer User',
};

const Users: React.FC = () => {
  const { hasManagementAccess } = usePrivileges();
  const [users, setUsers] = useState<User[]>([]);
  const [privilegeGroups, setPrivilegeGroups] = useState<PrivilegeGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedItems, setSelectedItems] = useState<User[]>([]);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showResetPasswordModal, setShowResetPasswordModal] = useState(false);
  const [showResetSuccessModal, setShowResetSuccessModal] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [userToReset, setUserToReset] = useState<User | null>(null);
  const [showResetMfaModal, setShowResetMfaModal] = useState(false);
  const [resettingMfa, setResettingMfa] = useState(false);
  const [userToResetMfa, setUserToResetMfa] = useState<User | null>(null);
  
  // Form state
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPrivilegeGroups, setSelectedPrivilegeGroups] = useState<{ label: string; value: string }[]>([]);
  const [password, setPassword] = useState('');
  const [autoGeneratePassword, setAutoGeneratePassword] = useState(false);
  const [mfaEnabled, setMfaEnabled] = useState(false);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const data = await userService.getAll();
      setUsers((data.items || []) as any);
    } catch (error) {
      // Error fetching users
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchPrivilegeGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear selections on manual refresh (keep only items still in list)
  useEffect(() => {
    setSelectedItems(prev => 
      prev.filter(selected => 
        users.some(item => item.id === selected.id)
      )
    );
  }, [users]);

  const fetchPrivilegeGroups = async () => {
    try {
      const data = await privilegeGroupService.getAll();
      setPrivilegeGroups((data || []) as PrivilegeGroup[]);
    } catch (error) {
      // Error fetching privilege groups
    }
  };

  const handleCreate = () => {
    setUsername('');
    setEmail('');
    setFirstName('');
    setLastName('');
    setDescription('');
    setPassword('');
    setAutoGeneratePassword(false);
    setMfaEnabled(false);
    setSelectedPrivilegeGroups([]);
    setSelectedItems([]);
    setErrorMessage('');
    setShowModal(true);
  };

  const handleEdit = () => {
    if (selectedItems.length !== 1) return;
    const user = selectedItems[0];
    setEmail(user.email);
    setFirstName(user.firstName);
    setLastName(user.lastName);
    setDescription(user.description || '');
    setPassword('');
    setMfaEnabled(user.mfaEnabled || false);
    setSelectedPrivilegeGroups(
      (user.privilegeGroups && user.privilegeGroups.length)
        ? user.privilegeGroups.map(g => ({ label: g.name, value: g.id }))
        : (user.privilegeGroupIds || []).map(id => {
            const pg = privilegeGroups.find(p => p.id === id);
            return { label: pg?.name || id, value: id };
          })
    );
    setShowModal(true);
  };

  const handleSave = async () => {
    try {
      // Validate required fields
      if (!email.trim() || !firstName.trim() || !lastName.trim()) {
        return;
      }

      if (selectedItems.length === 0 && !username.trim()) {
        return;
      }

      if (selectedItems.length === 0 && !/^[a-zA-Z0-9._\-@]+$/.test(username.trim())) {
        setErrorMessage('Username must contain only letters, numbers, periods, hyphens, underscores, or @ symbols');
        return;
      }

      if (selectedItems.length === 0 && !autoGeneratePassword && !password.trim()) {
        return;
      }

      setSaving(true);
      setErrorMessage('');

      const selectedGroupIds = selectedPrivilegeGroups.map(g => g.value);

      // Client-side mirror of the backend rule (design decision b): every group
      // a user belongs to must share one user_mode. Catch it before the request.
      const modes = Array.from(new Set(
        selectedGroupIds
          .map(id => privilegeGroups.find(p => p.id === id)?.userMode)
          .filter(Boolean)
      ));
      if (modes.length > 1) {
        setErrorMessage('All selected privilege groups must share the same user mode (e.g. all System User, or all Data User).');
        setSaving(false);
        return;
      }

      const data = {
        email: email.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        description: description.trim(),
        privilegeGroupIds: selectedGroupIds,
        mfaEnabled,
        ...(selectedItems.length === 1 ? {} : {
          username: username.trim(),
          password: password,
          autoGeneratePassword
        })
      };

      if (selectedItems.length === 1) {
        await userService.update(selectedItems[0].id, data as any);
      } else {
        const result: any = await userService.create(data as any);
        if (result.temporaryPassword) {
          setTemporaryPassword(result.temporaryPassword);
          setShowPasswordModal(true);
        }
      }

      setShowModal(false);
      setSelectedItems([]);
      fetchUsers();
    } catch (error: any) {
      setErrorMessage(error.message || 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (selectedItems.length !== 1) return;
    setUserToDelete(selectedItems[0]);
    setDeleteConfirmation('');
    setShowDeleteModal(true);
  };

  const confirmResetPassword = () => {
    if (selectedItems.length !== 1) return;
    setUserToReset(selectedItems[0]);
    setShowResetPasswordModal(true);
  };

  const handleResetPassword = async () => {
    if (!userToReset) return;
    
    try {
      setResettingPassword(true);
      const { apiClient } = await import('../utils/apiClient');
      const response = await apiClient.post(`/users/${userToReset.id}/reset-password`) as any;
      
      if (response.success) {
        setShowResetPasswordModal(false);
        setShowResetSuccessModal(true);
        setSelectedItems([]);
      }
    } catch (error) {
      console.error('Error resetting password:', error.message);
    } finally {
      setResettingPassword(false);
    }
  };

  const confirmResetMfa = () => {
    if (selectedItems.length !== 1) return;
    setUserToResetMfa(selectedItems[0]);
    setShowResetMfaModal(true);
  };

  const handleResetMfa = async () => {
    if (!userToResetMfa) return;
    
    try {
      setResettingMfa(true);
      const { apiClient } = await import('../utils/apiClient');
      await apiClient.post(`/users/${userToResetMfa.id}/reset-mfa`);
      setShowResetMfaModal(false);
      setUserToResetMfa(null);
      setSelectedItems([]);
    } catch (error) {
      console.error('Error resetting MFA:', error.message);
    } finally {
      setResettingMfa(false);
    }
  };

  const handleDelete = async () => {
    if (!userToDelete) return;
    
    try {
      setDeleting(true);
      await userService.delete(userToDelete.id);
      setShowDeleteModal(false);
      setUserToDelete(null);
      setSelectedItems([]);
      fetchUsers();
    } catch (error: any) {
      // Error handled by UI
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <SpaceBetween direction="vertical" size="l">
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="normal" iconName="refresh" onClick={() => { setIsManualRefresh(true); fetchUsers().finally(() => setIsManualRefresh(false)); }} loading={isManualRefresh && loading}>
                Refresh
              </Button>
              {hasManagementAccess('users', 'canEdit') && (
                <Button variant="primary" onClick={handleCreate}>
                  Create User
                </Button>
              )}
          </SpaceBetween>
        }
      >
        Users
      </Header>
      <Table
        loading={loading}
        items={users}
        selectionType="single"
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
        header={
          <Header
            counter={`(${users.length})`}
            actions={
              hasManagementAccess('users', 'canEdit') && (
                <ButtonDropdown
                  items={[
                    { text: 'Edit', id: 'edit', disabled: selectedItems.length !== 1 },
                    { text: 'Reset Password', id: 'reset', disabled: selectedItems.length !== 1 },
                    ...((window as any).REACT_APP_CONFIG?.MFA_ENABLED === 'true' ? [{ text: 'Reset MFA', id: 'reset-mfa', disabled: selectedItems.length !== 1 }] : []),
                    ...(hasManagementAccess('users', 'canDelete') ? [{ text: 'Delete', id: 'delete', disabled: selectedItems.length !== 1 }] : [])
                  ]}
                  onItemClick={({ detail }) => {
                    if (detail.id === 'edit') handleEdit();
                    else if (detail.id === 'reset') confirmResetPassword();
                    else if (detail.id === 'reset-mfa') confirmResetMfa();
                    else if (detail.id === 'delete') confirmDelete();
                  }}
                  disabled={selectedItems.length !== 1}
                >
                  Actions
                </ButtonDropdown>
              )
            }
          />
        }
        columnDefinitions={[
          {
            id: 'username',
            header: 'Username',
            cell: (item) => item.username || '-'
          },
          {
            id: 'email',
            header: 'Email',
            cell: (item) => item.email
          },
          {
            id: 'name',
            header: 'Name',
            cell: (item) => `${item.firstName} ${item.lastName}`
          },
          {
            id: 'privilegeGroup',
            header: 'Privilege Groups',
            cell: (item) => {
              const names = (item.privilegeGroups && item.privilegeGroups.length)
                ? item.privilegeGroups.map(g => g.name)
                : (item.privilegeGroupName ? [item.privilegeGroupName] : []);
              return names.length ? names.join(', ') : '-';
            }
          },
          {
            id: 'status',
            header: 'Status',
            cell: (item) => (
              <StatusIndicator type={item.status === 'ACTIVE' ? 'success' : 'stopped'}>
                {item.status}
              </StatusIndicator>
            )
          },
          {
            id: 'lastLogin',
            header: 'Last Login',
            cell: (item) => item.lastLogin ? formatTimestamp(item.lastLogin) : 'Never'
          }
        ]}
        empty={
          <Box textAlign="center" color="inherit">
            <b>No users</b>
            <Box padding={{ bottom: 's' }} variant="p" color="inherit">
              No users to display.
            </Box>
          </Box>
        }
      />

      <Modal
        visible={showModal}
        onDismiss={() => !saving && setShowModal(false)}
        header={selectedItems.length === 1 ? 'Edit User' : 'Create User'}
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowModal(false)} disabled={saving}>
                Cancel
              </Button>
              <Button 
                variant="primary" 
                onClick={handleSave} 
                disabled={saving || !email.trim() || !firstName.trim() || !lastName.trim() || (selectedItems.length === 0 && (!username.trim() || (!autoGeneratePassword && !password.trim())))}
                loading={saving}
              >
                {selectedItems.length === 1 ? 'Save' : 'Create'}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          {errorMessage && (
            <Alert type="error" dismissible onDismiss={() => setErrorMessage('')}>
              {errorMessage}
            </Alert>
          )}
          <FormField label="Email" constraintText="Required">
            <Input
              value={email}
              onChange={({ detail }) => setEmail(detail.value)}
              placeholder="user@example.com"
              type="email"
              disabled={selectedItems.length === 1 || saving}
            />
          </FormField>

          {selectedItems.length === 0 && (
            <FormField label="Username" constraintText="Required. Used for login.">
              <Input
                value={username}
                onChange={({ detail }) => setUsername(detail.value)}
                placeholder="Enter username"
                disabled={saving}
              />
            </FormField>
          )}

          <FormField label="First Name" constraintText="Required">
            <Input
              value={firstName}
              onChange={({ detail }) => setFirstName(detail.value)}
              placeholder="Enter first name"
              disabled={saving}
            />
          </FormField>

          <FormField label="Last Name" constraintText="Required">
            <Input
              value={lastName}
              onChange={({ detail }) => setLastName(detail.value)}
              placeholder="Enter last name"
              disabled={saving}
            />
          </FormField>

          <FormField label="Description">
            <Input
              value={description}
              onChange={({ detail }) => setDescription(detail.value)}
              placeholder="Enter description (optional)"
              disabled={saving}
            />
          </FormField>

          {selectedItems.length === 0 && (
            <>
              <FormField 
                label="Password" 
                constraintText={autoGeneratePassword ? "Password will be auto-generated and sent to user's email" : "Required for new users. Minimum 12 characters."}
              >
                <Input
                  value={password}
                  onChange={({ detail }) => setPassword(detail.value)}
                  placeholder="Enter password"
                  type="password"
                  disabled={autoGeneratePassword || saving}
                />
              </FormField>

              <Checkbox
                checked={autoGeneratePassword}
                onChange={({ detail }) => {
                  setAutoGeneratePassword(detail.checked);
                  if (detail.checked) {
                    setPassword('');
                  }
                }}
                disabled={saving}
              >
                Auto-generate password and send via email
              </Checkbox>
            </>
          )}

          <FormField 
            label="Privilege Groups" 
            constraintText="Optional. A user's effective privileges are the union of all selected groups. All groups must share the same user mode."
          >
            <Multiselect
              selectedOptions={selectedPrivilegeGroups}
              onChange={({ detail }) => setSelectedPrivilegeGroups(detail.selectedOptions as any)}
              options={(() => {
                // The user_mode already committed by the current selection; once
                // one group is picked, groups of a different mode are disabled so
                // the "all groups share one user mode" rule is visible in the UI.
                const selectedModes = new Set(
                  selectedPrivilegeGroups
                    .map(sel => privilegeGroups.find(p => p.id === sel.value)?.userMode)
                    .filter(Boolean)
                );
                const lockedMode = selectedModes.size === 1 ? [...selectedModes][0] : null;
                return privilegeGroups.map(pg => {
                  const mode = pg.userMode || 'SYSTEM_USER';
                  const conflicts = !!lockedMode && mode !== lockedMode;
                  return {
                    label: pg.name,
                    value: pg.id,
                    description: pg.description,
                    tags: [USER_MODE_LABELS[mode] || mode],
                    disabled: conflicts,
                    disabledReason: conflicts
                      ? `This group is ${USER_MODE_LABELS[mode] || mode}; the selection is ${USER_MODE_LABELS[lockedMode] || lockedMode}. A user's groups must share one mode.`
                      : undefined,
                  };
                });
              })()}
              placeholder="Select privilege groups"
              empty="No privilege groups available"
              disabled={saving}
            />
          </FormField>

          {/* Temporarily disabled MFA checkbox for documentation purposes
          <Checkbox
            checked={mfaEnabled}
            onChange={({ detail }) => setMfaEnabled(detail.checked)}
            disabled={saving}
          >
            Enable Multi-Factor Authentication (MFA)
          </Checkbox>
          */}

          {selectedItems.length === 1 && (
            <Alert type="info">
              To change the password, the user must use the "Forgot Password" feature.
            </Alert>
          )}
        </SpaceBetween>
      </Modal>

      <Modal
        visible={showPasswordModal}
        onDismiss={() => setShowPasswordModal(false)}
        header="User Created Successfully"
        footer={
          <Box float="right">
            <Button variant="primary" onClick={() => setShowPasswordModal(false)}>
              Close
            </Button>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="success">
            The user has been created successfully and will receive an email with login instructions.
          </Alert>
          <Box>
            <Box variant="h4">Temporary Password</Box>
            <Box variant="p">
              Please save this password. The user must change it on first login.
            </Box>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Button
                iconName="copy"
                variant="inline-icon"
                onClick={() => {
                  navigator.clipboard.writeText(temporaryPassword);
                }}
              />
              <Box 
                padding="s" 
                variant="code"
                fontSize="body-m"
              >
                {temporaryPassword}
              </Box>
            </div>
          </Box>
        </SpaceBetween>
      </Modal>

      <Modal
        visible={showDeleteModal}
        onDismiss={() => setShowDeleteModal(false)}
        header="Delete User"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowDeleteModal(false)}>
                Cancel
              </Button>
              <Button 
                variant="primary" 
                onClick={handleDelete}
                disabled={!userToDelete || deleteConfirmation !== userToDelete.email || deleting}
                loading={deleting}
              >
                Delete
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Alert type="warning">
            Are you sure you want to delete this user? This action cannot be undone.
          </Alert>
          {userToDelete && (
            <>
              <Box>
                <Box variant="p">
                  <strong>Email:</strong> {userToDelete.email}
                </Box>
                <Box variant="p">
                  <strong>Name:</strong> {userToDelete.firstName} {userToDelete.lastName}
                </Box>
              </Box>
              <FormField 
                label="Confirm deletion" 
                constraintText={`Type "${userToDelete.email}" to confirm`}
              >
                <Input
                  value={deleteConfirmation}
                  onChange={({ detail }) => setDeleteConfirmation(detail.value)}
                  placeholder="Enter user email"
                />
            </FormField>
          </>
        )}
      </SpaceBetween>
    </Modal>

    {/* Reset Password Confirmation Modal */}
    <Modal
      onDismiss={() => setShowResetPasswordModal(false)}
      visible={showResetPasswordModal}
      closeAriaLabel="Close"
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowResetPasswordModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleResetPassword} loading={resettingPassword}>
              Yes, Reset Password
            </Button>
          </SpaceBetween>
        </Box>
      }
      header="Reset User Password"
    >
      <SpaceBetween size="m">
        <Alert type="warning">
          This will generate a new temporary password for the user.
        </Alert>
        {userToReset && (
          <Box>
            <Box variant="p">
              <strong>User:</strong> {userToReset.firstName} {userToReset.lastName}
            </Box>
            <Box variant="p">
              <strong>Email:</strong> {userToReset.email}
            </Box>
          </Box>
        )}
      </SpaceBetween>
    </Modal>

    {/* Reset Password Success Modal */}
    <Modal
      onDismiss={() => {
        setShowResetSuccessModal(false);
        setTemporaryPassword('');
        setUserToReset(null);
      }}
      visible={showResetSuccessModal}
      closeAriaLabel="Close"
      size="medium"
      footer={
        <Box float="right">
          <Button variant="primary" onClick={() => {
            setShowResetSuccessModal(false);
            setUserToReset(null);
          }}>
            Close
          </Button>
        </Box>
      }
      header="Password Reset Email Sent"
    >
      <SpaceBetween size="m">
        <Alert type="success">
          A password reset email has been sent to the user.
        </Alert>
        {userToReset && (
          <Box>
            <Box variant="p">
              <strong>User:</strong> {userToReset.email}
            </Box>
            <Box variant="p" margin={{ top: 'm' }} color="text-status-info">
              The user will receive an email with a link to reset their password.
            </Box>
          </Box>
        )}
      </SpaceBetween>
    </Modal>

    {/* Reset MFA Confirmation Modal */}
    <Modal
      onDismiss={() => setShowResetMfaModal(false)}
      visible={showResetMfaModal}
      closeAriaLabel="Close"
      size="medium"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => setShowResetMfaModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleResetMfa} loading={resettingMfa}>
              Yes, Reset MFA
            </Button>
          </SpaceBetween>
        </Box>
      }
      header="Reset Multi-Factor Authentication"
    >
      <SpaceBetween size="m">
        <Alert type="warning">
          This will remove the user's current MFA configuration. They will be prompted to set up a new authenticator device on their next login.
        </Alert>
        {userToResetMfa && (
          <Box>
            <Box variant="p">
              <strong>User:</strong> {userToResetMfa.firstName} {userToResetMfa.lastName}
            </Box>
            <Box variant="p">
              <strong>Email:</strong> {userToResetMfa.email}
            </Box>
          </Box>
        )}
      </SpaceBetween>
    </Modal>
    </SpaceBetween>
    </>
  );
};

export default Users;
