import React, { useState, useEffect } from 'react';
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
  Textarea,
  Checkbox,
  Alert,
  StatusIndicator,
  Icon,
  RadioGroup,
  ColumnLayout,
  Badge,
} from '@cloudscape-design/components';
import { datastoreService, privilegeGroupService, apiClient } from '../services';
import { usePrivileges } from '../contexts/PrivilegesContext';

interface Datastore {
  id: string;
  name: string;
  status: string;
}

interface DatastorePrivilege {
  datastoreId: string;
  canRead: boolean;
  canStore: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  // Download a study as a .zip. Missing = false (older groups never had it).
  canDownload?: boolean;
}

interface VirtualFolderPrivilege {
  virtualFolderId: string;
  virtualFolderName?: string;
  canRead: boolean;
  canStore: boolean;
  canDownload?: boolean;
}

// The built-in Administrators group stores no canDownload key (schema-init
// re-seeds it on every deploy and it is locked), yet the API authorizer and the
// DICOMweb service grant it download wherever it can read. Show that here so
// the details view matches what is enforced.
const BUILTIN_ADMIN_GROUP_ID = 'admin-group';
const effectiveDownload = (groupId: string | undefined, p: { canRead?: boolean; canDownload?: boolean }) =>
  p.canDownload === true || (groupId === BUILTIN_ADMIN_GROUP_ID && p.canRead === true);

interface DeploymentPrivilege {
  locationId: string;
  canDeploy: boolean;
}

interface ManagementPrivileges {
  interfaces: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  dicomEntities: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  datastores: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  locations: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  routingRules: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  privilegeGroups: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  users: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  auditTrail: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  statistics: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  virtualFolders: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  analytics: {
    canList: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canQuery: boolean;
  };
  indexAttributes: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
  processingJobs: {
    canRead: boolean;
    canCreate: boolean;
    canRun: boolean;
    canDelete: boolean;
  };
  systemMonitor: {
    canEdit: boolean;
    canDelete: boolean;
    canList: boolean;
  };
}

// Most resources use canList/canEdit/canDelete. Processing jobs name the same
// ideas canRead/canCreate/canDelete and add canRun, so the editor maps its
// columns per resource.
type MgmtColumn = 'list' | 'edit' | 'delete' | 'extra';
const MGMT_FIELD: Record<string, Partial<Record<MgmtColumn, string>>> = {
  processingJobs: { list: 'canRead', edit: 'canCreate', delete: 'canDelete', extra: 'canRun' },
  analytics: { list: 'canList', edit: 'canEdit', delete: 'canDelete', extra: 'canQuery' },
};
const LIST_ONLY = new Set(['auditTrail', 'statistics', 'systemMonitor']);
const mgmtField = (key: string, col: MgmtColumn): string | undefined =>
  MGMT_FIELD[key] ? MGMT_FIELD[key][col]
    : col === 'extra' ? undefined
    : LIST_ONLY.has(key) && col !== 'list' ? undefined
    : ({ list: 'canList', edit: 'canEdit', delete: 'canDelete' } as const)[col];

type MgmtResource = { resource: string; key: string };
const MGMT_RESOURCES: MgmtResource[] = [
  { resource: 'Interfaces', key: 'interfaces' },
  { resource: 'DICOM Entities', key: 'dicomEntities' },
  { resource: 'Datastores', key: 'datastores' },
  { resource: 'Virtual Folders', key: 'virtualFolders' },
  { resource: 'Locations', key: 'locations' },
  { resource: 'Routing Rules', key: 'routingRules' },
  { resource: 'Privilege Groups', key: 'privilegeGroups' },
  { resource: 'Users', key: 'users' },
  { resource: 'Audit Trail', key: 'auditTrail' },
  { resource: 'Statistics', key: 'statistics' },
  { resource: 'Analytics', key: 'analytics' },
  { resource: 'Searchable Attributes', key: 'indexAttributes' },
  { resource: 'Processing Jobs', key: 'processingJobs' },
  { resource: 'System Monitor', key: 'systemMonitor' },
];

interface PrivilegeGroup {
  id: string;
  name: string;
  description: string;
  userMode?: 'SYSTEM_USER' | 'DATA_USER' | 'DEPLOYER_USER';
  datastorePrivileges: DatastorePrivilege[];
  virtualFolderPrivileges: VirtualFolderPrivilege[];
  managementPrivileges: ManagementPrivileges;
  deploymentPrivileges: DeploymentPrivilege[];
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  users?: Array<{
    email: string;
    firstName: string;
    lastName: string;
    status: string;
  }>;
}

const PrivilegeGroups: React.FC = () => {
  const { hasManagementAccess } = usePrivileges();
  const [groups, setGroups] = useState<PrivilegeGroup[]>([]);
  const [selectedItems, setSelectedItems] = useState<PrivilegeGroup[]>([]);
  const [datastores, setDatastores] = useState<Datastore[]>([]);
  const [virtualFolders, setVirtualFolders] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManualRefresh, setIsManualRefresh] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<PrivilegeGroup | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  
  // Form state
  const [groupName, setGroupName] = useState('');
  const [groupDescription, setGroupDescription] = useState('');
  const [userMode, setUserMode] = useState<'SYSTEM_USER' | 'DATA_USER' | 'DEPLOYER_USER'>('SYSTEM_USER');
  const [datastorePrivileges, setDatastorePrivileges] = useState<DatastorePrivilege[]>([]);
  const [virtualFolderPrivileges, setVirtualFolderPrivileges] = useState<VirtualFolderPrivilege[]>([]);
  const [deploymentPrivileges, setDeploymentPrivileges] = useState<DeploymentPrivilege[]>([]);
  const [managementPrivileges, setManagementPrivileges] = useState<ManagementPrivileges>({
    interfaces: { canEdit: false, canDelete: false, canList: false },
    dicomEntities: { canEdit: false, canDelete: false, canList: false },
    datastores: { canEdit: false, canDelete: false, canList: false },
    locations: { canEdit: false, canDelete: false, canList: false },
    routingRules: { canEdit: false, canDelete: false, canList: false },
    privilegeGroups: { canEdit: false, canDelete: false, canList: false },
    users: { canEdit: false, canDelete: false, canList: false },
    auditTrail: { canEdit: false, canDelete: false, canList: false },
    statistics: { canEdit: false, canDelete: false, canList: false },
    virtualFolders: { canCreate: false, canEdit: false, canDelete: false, canList: false },
    analytics: { canList: false, canEdit: false, canDelete: false, canQuery: false },
    indexAttributes: { canEdit: false, canDelete: false, canList: false },
    processingJobs: { canRead: false, canCreate: false, canRun: false, canDelete: false },
    systemMonitor: { canEdit: false, canDelete: false, canList: false }
  });

  const fetchGroups = async () => {
    try {
      const data = await privilegeGroupService.getAll();
      setGroups((data || []) as PrivilegeGroup[]);
    } catch (error) {
      // Error fetching groups
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
    fetchDatastores();
    fetchVirtualFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear selections on manual refresh (keep only items still in list)
  useEffect(() => {
    setSelectedItems(prev => 
      prev.filter(selected => 
        groups.some(item => item.id === selected.id)
      )
    );
  }, [groups]);

  const fetchDatastores = async () => {
    try {
      const response = await datastoreService.getAll();
      if (response.items) {
        setDatastores(response.items);
      }
    } catch (error) {
      // Error fetching datastores
    }
  };

  const fetchVirtualFolders = async () => {
    try {
      const response = await apiClient.getVirtualFolders({ pageSize: 100 });
      if (response.data?.items) {
        setVirtualFolders(response.data.items);
      }
    } catch (error) {
      // Error fetching virtual folders
    }
  };

  const fetchLocations = async () => {
    try {
      const response = await apiClient.getLocations();
      if (response.data) {
        setLocations(response.data);
      }
    } catch (error) {
      // Error fetching locations
    }
  };

  useEffect(() => {
    fetchGroups();
    fetchDatastores();
    fetchLocations();
    fetchVirtualFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreate = () => {
    setSelectedGroup(null);
    setGroupName('');
    setGroupDescription('');
    setUserMode('SYSTEM_USER');
    setDatastorePrivileges([
      { datastoreId: '*', canRead: false, canStore: false, canUpdate: false, canDelete: false, canDownload: false },
      ...datastores.map(ds => ({
        datastoreId: ds.id,
        canRead: false,
        canStore: false,
        canUpdate: false,
        canDelete: false,
        canDownload: false
      }))
    ]);
    setVirtualFolderPrivileges([
      { virtualFolderId: '*', canRead: false, canStore: false, canDownload: false },
      ...virtualFolders.map(vf => ({
        virtualFolderId: vf.id,
        canRead: false,
        canStore: false,
        canDownload: false
      }))
    ]);
    const deployPrivs = [
      { locationId: '*', canDeploy: false },
      ...locations.map(loc => ({
        locationId: loc.id,
        canDeploy: false
      }))
    ];
    setDeploymentPrivileges(deployPrivs);
    setDeploymentPrivileges(deployPrivs);
    setManagementPrivileges({
      interfaces: { canEdit: false, canDelete: false, canList: false },
      dicomEntities: { canEdit: false, canDelete: false, canList: false },
      datastores: { canEdit: false, canDelete: false, canList: false },
      locations: { canEdit: false, canDelete: false, canList: false },
      routingRules: { canEdit: false, canDelete: false, canList: false },
      privilegeGroups: { canEdit: false, canDelete: false, canList: false },
      users: { canEdit: false, canDelete: false, canList: false },
      auditTrail: { canEdit: false, canDelete: false, canList: false },
      statistics: { canEdit: false, canDelete: false, canList: false },
      virtualFolders: { canCreate: false, canEdit: false, canDelete: false, canList: false },
      analytics: { canList: false, canEdit: false, canDelete: false, canQuery: false },
      indexAttributes: { canEdit: false, canDelete: false, canList: false },
      processingJobs: { canRead: false, canCreate: false, canRun: false, canDelete: false },
      systemMonitor: { canEdit: false, canDelete: false, canList: false }
    });
    setShowModal(true);
  };

  const handleEdit = (group: PrivilegeGroup) => {
    setSelectedGroup(group);
    setGroupName(group.name);
    setGroupDescription(group.description);
    setUserMode(group.userMode || 'SYSTEM_USER');
    setDatastorePrivileges(group.datastorePrivileges);
    setVirtualFolderPrivileges(group.virtualFolderPrivileges || []);
    
    // Initialize deployment privileges with all locations
    const existingDeploymentPrivs = group.deploymentPrivileges || [];
    const deployPrivs = [
      { 
        locationId: '*', 
        canDeploy: existingDeploymentPrivs.find(p => p.locationId === '*')?.canDeploy || false 
      },
      ...locations.map(loc => ({
        locationId: loc.id,
        canDeploy: existingDeploymentPrivs.find(p => p.locationId === loc.id)?.canDeploy || false
      }))
    ];
    setDeploymentPrivileges(deployPrivs);
    
    setManagementPrivileges({
      interfaces: group.managementPrivileges.interfaces || { canEdit: false, canDelete: false, canList: false },
      dicomEntities: group.managementPrivileges.dicomEntities || { canEdit: false, canDelete: false, canList: false },
      datastores: group.managementPrivileges.datastores || { canEdit: false, canDelete: false, canList: false },
      locations: group.managementPrivileges.locations || { canEdit: false, canDelete: false, canList: false },
      routingRules: group.managementPrivileges.routingRules || { canEdit: false, canDelete: false, canList: false },
      privilegeGroups: group.managementPrivileges.privilegeGroups || { canEdit: false, canDelete: false, canList: false },
      users: group.managementPrivileges.users || { canEdit: false, canDelete: false, canList: false },
      auditTrail: group.managementPrivileges.auditTrail || { canEdit: false, canDelete: false, canList: false },
      statistics: group.managementPrivileges.statistics || { canEdit: false, canDelete: false, canList: false },
      virtualFolders: group.managementPrivileges.virtualFolders || { canCreate: false, canEdit: false, canDelete: false, canList: false },
      analytics: group.managementPrivileges.analytics || { canList: false, canEdit: false, canDelete: false, canQuery: false },
      indexAttributes: group.managementPrivileges.indexAttributes || { canEdit: false, canDelete: false, canList: false },
      processingJobs: (group.managementPrivileges as any).processingJobs || { canRead: false, canCreate: false, canRun: false, canDelete: false },
      systemMonitor: (group.managementPrivileges as any).systemMonitor || { canEdit: false, canDelete: false, canList: false }
    });
    setShowModal(true);
  };

  const handleViewDetails = async (group: PrivilegeGroup) => {
    setSelectedGroup(group);
    setShowDetailsModal(true);
    try {
      const resp = await apiClient.makeRequest<any>(`/privilege-groups/${group.id}`);
      if (resp.data) setSelectedGroup(resp.data);
    } catch {}
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = {
        name: groupName,
        description: groupDescription,
        userMode,
        datastorePrivileges: userMode === 'DEPLOYER_USER' ? [] : datastorePrivileges,
        virtualFolderPrivileges: userMode === 'DEPLOYER_USER' ? [] : virtualFolderPrivileges,
        deploymentPrivileges: userMode === 'DEPLOYER_USER' ? deploymentPrivileges : [],
        managementPrivileges: userMode === 'SYSTEM_USER' ? managementPrivileges : {
          interfaces: { canEdit: false, canDelete: false, canList: false },
          dicomEntities: { canEdit: false, canDelete: false, canList: false },
          datastores: { canEdit: false, canDelete: false, canList: false },
          locations: { canEdit: false, canDelete: false, canList: true },
          routingRules: { canEdit: false, canDelete: false, canList: false },
          privilegeGroups: { canEdit: false, canDelete: false, canList: false },
          users: { canEdit: false, canDelete: false, canList: false },
          auditTrail: { canEdit: false, canDelete: false, canList: false },
          statistics: { canEdit: false, canDelete: false, canList: false },
          virtualFolders: { canCreate: false, canEdit: false, canDelete: false, canList: false },
          analytics: { canList: false, canEdit: false, canDelete: false, canQuery: false },
          indexAttributes: { canEdit: false, canDelete: false, canList: false },
          processingJobs: { canRead: false, canCreate: false, canRun: false, canDelete: false },
          systemMonitor: { canEdit: false, canDelete: false, canList: false }
        }
      };

      if (selectedGroup) {
        await privilegeGroupService.update(selectedGroup.id, data);
      } else {
        await privilegeGroupService.create(data);
      }

      setShowModal(false);
      if (selectedGroup) setSelectedItems([]);
      fetchGroups();
    } catch (error) {
      console.error('Error saving privilege group:', error.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      setDeleting(true);
      setDeleteError(null);
      for (const group of selectedItems) {
        await privilegeGroupService.delete(group.id);
      }
      setShowDeleteModal(false);
      setSelectedItems([]);
      setDeleteConfirmation('');
      fetchGroups();
    } catch (error: any) {
      if (error.response?.data?.associatedUsers) {
        const users = error.response.data.associatedUsers.join(', ');
        setDeleteError(`Cannot delete privilege group. It is still associated with the following users: ${users}`);
      } else {
        setDeleteError(error.response?.data?.message || 'Failed to delete privilege group');
      }
    } finally {
      setDeleting(false);
    }
  };

  const updateDatastorePrivilege = (datastoreId: string, field: 'canRead' | 'canStore' | 'canUpdate' | 'canDelete' | 'canDownload', value: boolean) => {
    setDatastorePrivileges(prev => 
      prev.map(dp => 
        dp.datastoreId === datastoreId 
          ? { ...dp, [field]: value }
          : dp
      )
    );
  };

  const updateVirtualFolderPrivilege = (virtualFolderId: string, field: 'canRead' | 'canStore' | 'canDownload', value: boolean) => {
    setVirtualFolderPrivileges(prev => 
      prev.map(vfp => 
        vfp.virtualFolderId === virtualFolderId 
          ? { ...vfp, [field]: value }
          : vfp
      )
    );
  };

  const updateDeploymentPrivilege = (locationId: string, value: boolean) => {
    setDeploymentPrivileges(prev => 
      prev.map(dp => 
        dp.locationId === locationId 
          ? { ...dp, canDeploy: value }
          : dp
      )
    );
  };

  return (
    <>
      <SpaceBetween direction="vertical" size="l">
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="normal" iconName="refresh" onClick={() => { setIsManualRefresh(true); fetchGroups().finally(() => setIsManualRefresh(false)); }} loading={isManualRefresh && loading}>Refresh</Button>
              {hasManagementAccess('privilegeGroups', 'canEdit') && (
                <Button variant="primary" onClick={handleCreate}>
                  Create Privilege Group
                </Button>
              )}
          </SpaceBetween>
        }
      >
        Privilege Groups
      </Header>
      <Table
        loading={loading}
        items={groups}
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
        selectionType="single"
        header={
          <Header
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {hasManagementAccess('privilegeGroups', 'canList') && (
                  <Button 
                    onClick={() => handleViewDetails(selectedItems[0])} 
                    disabled={selectedItems.length !== 1}
                  >
                    View Details
                  </Button>
                )}
                {hasManagementAccess('privilegeGroups', 'canEdit') && (
                  <Button 
                      onClick={() => handleEdit(selectedItems[0])} 
                      disabled={selectedItems.length !== 1 || selectedItems[0]?.locked}
                  >
                    Edit
                  </Button>
                )}
                {hasManagementAccess('privilegeGroups', 'canDelete') && (
                  <Button 
                    onClick={() => setShowDeleteModal(true)} 
                    disabled={selectedItems.length === 0 || selectedItems.some(item => item.locked)}
                  >
                    Delete
                  </Button>
                )}
              </SpaceBetween>
            }
          >
            Privilege Groups
          </Header>
        }
        columnDefinitions={[
          {
            id: 'name',
            header: 'Group Name',
            cell: (item) => item.name
          },
          {
            id: 'description',
            header: 'Description',
            cell: (item) => item.description
          },
          {
            id: 'userMode',
            header: 'User Mode',
            cell: (item) => {
              if (item.userMode === 'DATA_USER') {
                return <Badge color="blue">Data User</Badge>;
              } else if (item.userMode === 'DEPLOYER_USER') {
                return <Badge color="green">Deployer User</Badge>;
              } else {
                return <Badge color="grey">System User</Badge>;
              }
            },
            width: 150
          },
          {
            id: 'locked',
            header: 'Locked',
            cell: (item) => item.locked ? <Icon name="lock-private" /> : '',
            width: 100
          }
        ]}
        empty={
          <Box textAlign="center" color="inherit">
            <b>No privilege groups</b>
            <Box padding={{ bottom: 's' }} variant="p" color="inherit">
              No privilege groups to display.
            </Box>
          </Box>
        }
      />

      <Modal
        visible={showModal}
        onDismiss={() => setShowModal(false)}
        header={selectedGroup ? 'Edit Privilege Group' : 'Create Privilege Group'}
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={!groupName.trim()} loading={saving}>
                Save
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="l">
          <FormField label="Group Name" constraintText="Required">
            <Input
              value={groupName}
              onChange={({ detail }) => setGroupName(detail.value)}
              placeholder="Enter group name"
            />
          </FormField>

          <FormField label="Group Description">
            <Textarea
              value={groupDescription}
              onChange={({ detail }) => setGroupDescription(detail.value)}
              placeholder="Enter group description"
              rows={3}
            />
          </FormField>

          <FormField 
            label="User Mode" 
            description="Select the type of user access for this privilege group."
          >
            <RadioGroup
              value={userMode}
              onChange={({ detail }) => setUserMode(detail.value as 'SYSTEM_USER' | 'DATA_USER' | 'DEPLOYER_USER')}
              items={[
                { value: 'SYSTEM_USER', label: 'System User', description: 'Full access based on assigned privileges' },
                { value: 'DATA_USER', label: 'Data User', description: 'Read-only access to studies and data' },
                { value: 'DEPLOYER_USER', label: 'Deployer User', description: 'Access to deploy remote services to specific locations' }
              ]}
            />
          </FormField>

          {userMode === 'DEPLOYER_USER' ? (
            <Box>
              <Header variant="h3">Deployment Locations</Header>
              <Table
                items={deploymentPrivileges}
                columnDefinitions={[
                  {
                    id: 'location',
                    header: 'Location',
                    cell: (item) => {
                      if (item.locationId === '*') {
                        return 'All Locations';
                      }
                      const loc = locations.find(l => l.id === item.locationId);
                      return loc?.name || item.locationId;
                    }
                  },
                  {
                    id: 'deploy',
                    header: 'Can Deploy',
                    cell: (item) => (
                      <Checkbox
                        checked={item.canDeploy}
                        onChange={({ detail }) => 
                          updateDeploymentPrivilege(item.locationId, detail.checked)
                        }
                      />
                    )
                  }
                ]}
              />
            </Box>
          ) : (
            <>
              <Box>
                <Header variant="h3">Datastore Data</Header>
            <Table
              items={datastorePrivileges}
                columnDefinitions={[
                  {
                    id: 'datastore',
                    header: 'Datastore',
                    cell: (item) => {
                      if (item.datastoreId === '*') {
                        return 'All Datastores';
                      }
                      const ds = datastores.find(d => d.id === item.datastoreId);
                      return ds?.name || item.datastoreId;
                    }
                  },
                  {
                    id: 'read',
                    header: 'Read',
                    cell: (item) => (
                      <Checkbox
                        checked={item.canRead}
                        onChange={({ detail }) => 
                          updateDatastorePrivilege(item.datastoreId, 'canRead', detail.checked)
                        }
                      />
                    )
                  },
                  {
                    id: 'store',
                    header: 'Store',
                    cell: (item) => (
                      <Checkbox
                        checked={item.canStore}
                        onChange={({ detail }) => 
                          updateDatastorePrivilege(item.datastoreId, 'canStore', detail.checked)
                        }
                      />
                    )
                  },
                  {
                    id: 'update',
                    header: 'Update',
                    cell: (item) => (
                      <Checkbox
                        checked={item.canUpdate}
                        onChange={({ detail }) => 
                          updateDatastorePrivilege(item.datastoreId, 'canUpdate', detail.checked)
                        }
                      />
                    )
                  },
                  {
                    id: 'delete',
                    header: 'Delete',
                    cell: (item) => (
                      <Checkbox
                        checked={item.canDelete}
                        onChange={({ detail }) => 
                          updateDatastorePrivilege(item.datastoreId, 'canDelete', detail.checked)
                        }
                      />
                    )
                  },
                  {
                    id: 'download',
                    header: 'Download',
                    cell: (item) => (
                      <Checkbox
                        checked={!!item.canDownload}
                        onChange={({ detail }) => 
                          updateDatastorePrivilege(item.datastoreId, 'canDownload', detail.checked)
                        }
                      />
                    )
                  }
                ]}
              />
          </Box>

          <Box>
            <Header variant="h3">Virtual Folder Data</Header>
            <Table
              items={virtualFolderPrivileges}
              columnDefinitions={[
                {
                  id: 'virtualFolder',
                  header: 'Virtual Folder',
                  cell: (item) => {
                    if (item.virtualFolderId === '*') {
                      return 'All Virtual Folders';
                    }
                    const vf = virtualFolders.find(v => v.id === item.virtualFolderId);
                    return vf?.name || item.virtualFolderId;
                  }
                },
                {
                  id: 'read',
                  header: 'Read',
                  cell: (item) => (
                    <Checkbox
                      checked={item.canRead}
                      onChange={({ detail }) => 
                        updateVirtualFolderPrivilege(item.virtualFolderId, 'canRead', detail.checked)
                      }
                    />
                  )
                },
                {
                  id: 'store',
                  header: 'Store',
                  cell: (item) => (
                    <Checkbox
                      checked={item.canStore}
                      onChange={({ detail }) => 
                        updateVirtualFolderPrivilege(item.virtualFolderId, 'canStore', detail.checked)
                      }
                    />
                  )
                },
                {
                  id: 'download',
                  header: 'Download',
                  cell: (item) => (
                    <Checkbox
                      checked={!!item.canDownload}
                      onChange={({ detail }) => 
                        updateVirtualFolderPrivilege(item.virtualFolderId, 'canDownload', detail.checked)
                      }
                    />
                  )
                }
              ]}
            />
          </Box>

          {userMode === 'SYSTEM_USER' && (
            <Box>
              <Header variant="h3">Management</Header>
              <Table
              items={MGMT_RESOURCES}
              columnDefinitions={([
                { id: 'edit', header: 'Edit', col: 'edit' },
                { id: 'delete', header: 'Delete', col: 'delete' },
                { id: 'list', header: 'List', col: 'list' },
                { id: 'extra', header: 'Query / Run', col: 'extra' },
              ] as { id: string; header: string; col: MgmtColumn }[]).reduce((cols, c) => [...cols, {
                id: c.id,
                header: c.header,
                cell: (item: MgmtResource) => {
                  const field = mgmtField(item.key, c.col);
                  if (!field) return null;
                  const current: any = (managementPrivileges as any)[item.key] || {};
                  const listField = mgmtField(item.key, 'list')!;
                  return (
                    <Checkbox
                      ariaLabel={`${MGMT_RESOURCES.find(r => r.key === item.key)?.resource} ${c.header}`}
                      checked={!!current[field]}
                      onChange={({ detail }) =>
                        setManagementPrivileges(prev => {
                          const cur: any = { ...((prev as any)[item.key] || {}) };
                          cur[field] = detail.checked;
                          // Any write/run permission implies being able to see the list.
                          if (c.col !== 'list') {
                            cur[listField] = detail.checked || ['edit', 'delete', 'extra'].some(k => {
                              const f = mgmtField(item.key, k as MgmtColumn);
                              return f && f !== field && cur[f];
                            }) || (!detail.checked && cur[listField]);
                          }
                          return { ...prev, [item.key]: cur };
                        })
                      }
                    />
                  );
                },
              }], [{ id: 'resource', header: 'Resource', cell: (item: MgmtResource) => item.resource }] as any[])}
            />
          </Box>
          )}
          </>
          )}
        </SpaceBetween>
      </Modal>

      <Modal
        visible={showDetailsModal}
        onDismiss={() => setShowDetailsModal(false)}
        header={<Header variant="h2">{selectedGroup?.name} - Details</Header>}
        size="large"
        footer={
          <Box float="right">
            <Button variant="link" onClick={() => setShowDetailsModal(false)}>
              Close
            </Button>
          </Box>
        }
      >
        {selectedGroup && (
          <SpaceBetween direction="vertical" size="l">
            <Box>
              <Box variant="h3">Description</Box>
              <Box>{selectedGroup.description || 'No description'}</Box>
            </Box>

            <Box>
              <Box variant="h3">User Mode</Box>
              {selectedGroup.userMode === 'DATA_USER' ? (
                <Badge color="blue">Data User</Badge>
              ) : selectedGroup.userMode === 'DEPLOYER_USER' ? (
                <Badge color="green">Deployer User</Badge>
              ) : (
                <Badge color="grey">System User</Badge>
              )}
            </Box>

            {selectedGroup.locked && (
              <Alert type="info">This is a system group and cannot be modified.</Alert>
            )}

            {selectedGroup.userMode !== 'DEPLOYER_USER' && (
            <>
            <Box>
              <Header variant="h3">Datastore Privileges</Header>
              <Table
                items={selectedGroup.datastorePrivileges}
                columnDefinitions={[
                  {
                    id: 'datastore',
                    header: 'Datastore',
                    cell: (item) => item.datastoreId === '*' ? 'All Datastores' : datastores.find(d => d.id === item.datastoreId)?.name || item.datastoreId
                  },
                  {
                    id: 'canRead',
                    header: 'Read',
                    cell: (item) => item.canRead ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  },
                  {
                    id: 'canStore',
                    header: 'Store',
                    cell: (item) => item.canStore ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  },
                  {
                    id: 'canUpdate',
                    header: 'Update',
                    cell: (item) => item.canUpdate ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  },
                  {
                    id: 'canDelete',
                    header: 'Delete',
                    cell: (item) => item.canDelete ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  },
                  {
                    id: 'canDownload',
                    header: 'Download',
                    cell: (item) => effectiveDownload(selectedGroup.id, item) ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  }
                ]}
                empty={<Box textAlign="center">No datastore privileges</Box>}
              />
            </Box>

            <Box>
              <Header variant="h3">Virtual Folder Privileges</Header>
              <Table
                items={selectedGroup.virtualFolderPrivileges || []}
                columnDefinitions={[
                  {
                    id: 'virtualFolder',
                    header: 'Virtual Folder',
                    cell: (item) => item.virtualFolderId === '*' ? 'All Virtual Folders' : (virtualFolders.find(v => v.id === item.virtualFolderId)?.name || item.virtualFolderId)
                  },
                  {
                    id: 'canRead',
                    header: 'Read',
                    cell: (item) => item.canRead ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  },
                  {
                    id: 'canStore',
                    header: 'Store',
                    cell: (item) => item.canStore ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  },
                  {
                    id: 'canDownload',
                    header: 'Download',
                    cell: (item) => effectiveDownload(selectedGroup.id, item) ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                  }
                ]}
                empty={<Box textAlign="center">No virtual folder privileges</Box>}
              />
            </Box>
            </>
            )}

            {selectedGroup.userMode === 'DEPLOYER_USER' && (
              <Box>
                <Header variant="h3">Deployment Privileges</Header>
                <Table
                  items={selectedGroup.deploymentPrivileges || []}
                  columnDefinitions={[
                    {
                      id: 'location',
                      header: 'Location',
                      cell: (item) => item.locationId === '*' ? 'All Locations' : locations.find(l => l.id === item.locationId)?.name || item.locationId
                    },
                    {
                      id: 'canDeploy',
                      header: 'Can Deploy',
                      cell: (item) => item.canDeploy ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No'
                    }
                  ]}
                  empty={<Box textAlign="center">No deployment privileges</Box>}
                />
              </Box>
            )}

            {selectedGroup.userMode === 'SYSTEM_USER' && (
            <Box>
              <Header variant="h3">Management Privileges</Header>
              <Table
                items={MGMT_RESOURCES}
                columnDefinitions={[
                  { id: 'resource', header: 'Resource', cell: (item: MgmtResource) => item.resource },
                  ...(([['canList', 'List', 'list'], ['canEdit', 'Edit', 'edit'], ['canDelete', 'Delete', 'delete'], ['extra', 'Query / Run', 'extra']] as [string, string, MgmtColumn][])
                    .map(([id, header, col]) => ({
                      id, header,
                      cell: (item: MgmtResource) => {
                        const field = mgmtField(item.key, col);
                        if (!field) return '';
                        return (selectedGroup.managementPrivileges as any)[item.key]?.[field]
                          ? <StatusIndicator type="success">Yes</StatusIndicator> : 'No';
                      },
                    }))),
                ]}
              />
            </Box>
            )}

            <Box>
              <Header variant="h3">Associated Users</Header>
              <Table
                items={selectedGroup.users || []}
                columnDefinitions={[
                  {
                    id: 'email',
                    header: 'Email',
                    cell: (item) => item.email
                  },
                  {
                    id: 'firstName',
                    header: 'First Name',
                    cell: (item) => item.firstName
                  },
                  {
                    id: 'lastName',
                    header: 'Last Name',
                    cell: (item) => item.lastName
                  },
                  {
                    id: 'status',
                    header: 'Status',
                    cell: (item) => <Badge color={item.status === 'ACTIVE' ? 'green' : 'grey'}>{item.status}</Badge>
                  }
                ]}
                empty={<Box textAlign="center">No users assigned to this group</Box>}
              />
            </Box>
          </SpaceBetween>
        )}
      </Modal>

      <Modal
        visible={showDeleteModal}
        onDismiss={() => {
          setShowDeleteModal(false);
          setDeleteConfirmation('');
          setDeleteError(null);
        }}
        header="Delete Privilege Groups"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => {
                setShowDeleteModal(false);
                setDeleteConfirmation('');
                setDeleteError(null);
              }}>
                Cancel
              </Button>
              <Button 
                variant="primary" 
                onClick={handleDelete}
                disabled={selectedItems.length !== 1 || deleteConfirmation !== selectedItems[0]?.name || deleting}
                loading={deleting}
              >
                Delete
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          {deleteError && (
            <Alert type="error" header="Deletion Failed">
              {deleteError}
            </Alert>
          )}
          <Box>
            Are you sure you want to delete {selectedItems.length} privilege group{selectedItems.length > 1 ? 's' : ''}?
          </Box>
          {selectedItems.length > 0 && (
            <Box>
              <strong>Groups to be deleted:</strong>
              {selectedItems.map(item => (
                <Box key={item.id}>• {item.name}</Box>
              ))}
            </Box>
          )}
          {selectedItems.length === 1 && (
            <FormField
              label={`Type "${selectedItems[0].name}" to confirm deletion`}
              description="This action cannot be undone."
            >
              <Input
                value={deleteConfirmation}
                onChange={({ detail }) => setDeleteConfirmation(detail.value)}
                placeholder={selectedItems[0].name}
              />
            </FormField>
          )}
      </SpaceBetween>
    </Modal>
    </SpaceBetween>
    </>
  );
};

export default PrivilegeGroups;
