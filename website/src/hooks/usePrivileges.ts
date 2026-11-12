import { useState, useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { useAuth } from '../contexts/AuthContext';

export interface DatastorePrivilege {
  datastoreId: string;
  canRead: boolean;
  canStore: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  // Download a study as a .zip (enforced by the DICOMweb service). Missing = false.
  canDownload?: boolean;
}

export interface VirtualFolderPrivilege {
  virtualFolderId: string;
  canRead: boolean;
  canStore: boolean;
  canDownload?: boolean;
}

export interface ManagementPrivilege {
  canEdit: boolean;
  canDelete: boolean;
  canList: boolean;
  canQuery?: boolean;
  canCreate?: boolean;
  canRun?: boolean;
  canRead?: boolean;
}

export interface ManagementPrivileges {
  interfaces: ManagementPrivilege;
  dicomEntities: ManagementPrivilege;
  datastores: ManagementPrivilege;
  locations: ManagementPrivilege;
  privilegeGroups: ManagementPrivilege;
  users: ManagementPrivilege;
  auditTrail: ManagementPrivilege;
  systemMonitor: ManagementPrivilege;
  routingRules: ManagementPrivilege;
  virtualFolders: ManagementPrivilege;
  analytics: ManagementPrivilege;
  processingJobs: ManagementPrivilege;
  indexAttributes: ManagementPrivilege;
}

export interface Privileges {
  datastorePrivileges: DatastorePrivilege[];
  virtualFolderPrivileges: VirtualFolderPrivilege[];
  managementPrivileges: ManagementPrivileges;
}

export const usePrivileges = () => {
  const [privileges, setPrivileges] = useState<Privileges | null>(null);
  const [loading, setLoading] = useState(true);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      loadPrivileges();
    } else {
      setPrivileges(null);
      setLoading(false);
    }
  }, [isAuthenticated]);

  const loadPrivileges = async () => {
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      
      if (idToken) {
        const payload = idToken.payload;
        const privilegesStr = payload['custom:privileges'] as string;
        
        if (privilegesStr) {
          const parsed = JSON.parse(privilegesStr);
          setPrivileges(parsed);
        }
      }
    } catch (error) {
      console.error('Error loading privileges:', error.message);
    } finally {
      setLoading(false);
    }
  };

  const hasDatastoreAccess = (datastoreId: string, permission: 'canRead' | 'canStore' | 'canUpdate' | 'canDelete'): boolean => {
    if (!privileges) return false;
    
    // Check for wildcard access
    const wildcardPriv = privileges.datastorePrivileges.find(p => p.datastoreId === '*');
    if (wildcardPriv && wildcardPriv[permission]) return true;
    
    // Check for specific datastore access
    const datastorePriv = privileges.datastorePrivileges.find(p => p.datastoreId === datastoreId);
    return datastorePriv ? datastorePriv[permission] : false;
  };

  const hasVirtualFolderAccess = (folderId: string, permission: 'canRead' | 'canStore'): boolean => {
    if (!privileges?.virtualFolderPrivileges) return false;
    const wildcardPriv = privileges.virtualFolderPrivileges.find(p => p.virtualFolderId === '*');
    if (wildcardPriv && wildcardPriv[permission]) return true;
    const folderPriv = privileges.virtualFolderPrivileges.find(p => p.virtualFolderId === folderId);
    return folderPriv ? folderPriv[permission] : false;
  };

  const hasManagementAccess = (resource: keyof ManagementPrivileges, permission: 'canEdit' | 'canDelete' | 'canList' | 'canQuery' | 'canCreate' | 'canRun' | 'canRead'): boolean => {
    if (!privileges) return false;
    
    // Check direct privilege
    const hasDirectAccess = privileges.managementPrivileges[resource]?.[permission] || false;
    if (hasDirectAccess) return true;
    
    // Check implicit privileges (derived from other permissions)
    // If user can create/edit DICOM interfaces, they implicitly need to list locations
    if (resource === 'locations' && permission === 'canList') {
      return privileges.managementPrivileges.interfaces?.canEdit || 
             privileges.managementPrivileges.dicomEntities?.canEdit || false;
    }
    
    // If user can create/edit routing rules or DICOM entities, they implicitly need to list interfaces
    if (resource === 'interfaces' && permission === 'canList') {
      return privileges.managementPrivileges.routingRules?.canEdit || 
             privileges.managementPrivileges.dicomEntities?.canEdit || false;
    }
    
    return false;
  };

  const canAccessDataManagement = (): boolean => {
    if (!privileges) return false;
    // User can access if they have any actual datastore permissions
    return privileges.datastorePrivileges.some(ds => 
      ds.canRead || ds.canStore || ds.canUpdate || ds.canDelete
    );
  };

  const canAccessConfiguration = (): boolean => {
    if (!privileges) return false;
    // User can access if they have list access to any config resource
    return hasManagementAccess('interfaces', 'canList') ||
           hasManagementAccess('dicomEntities', 'canList') ||
           hasManagementAccess('datastores', 'canList');
  };

  const canAccessUserManagement = (): boolean => {
    if (!privileges) return false;
    return hasManagementAccess('users', 'canList') ||
           hasManagementAccess('privilegeGroups', 'canList');
  };

  return {
    privileges,
    loading,
    hasDatastoreAccess,
    hasVirtualFolderAccess,
    hasManagementAccess,
    canAccessDataManagement,
    canAccessConfiguration,
    canAccessUserManagement,
  };
};
