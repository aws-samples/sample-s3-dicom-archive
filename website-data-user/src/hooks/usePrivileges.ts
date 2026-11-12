import { useState, useEffect } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

export interface DatastorePrivilege {
  datastoreId: string;
  canRead: boolean;
  canStore: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  // Download a study as a .zip. Missing = false. The data-user UI asks the
  // DICOMweb service (dicomwebService.canDownload) rather than this token
  // claim, which can be stale and omits the built-in admin group's grant.
  canDownload?: boolean;
}

export interface Privileges {
  datastorePrivileges: DatastorePrivilege[];
}

export const usePrivileges = () => {
  const [privileges, setPrivileges] = useState<Privileges | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPrivileges();
  }, []);

  const loadPrivileges = async () => {
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      
      if (idToken) {
        const payload = idToken.payload;
        const privilegesStr = payload['custom:privileges'] as string;
        
        if (privilegesStr) {
          const parsed = JSON.parse(privilegesStr);
          setPrivileges({ datastorePrivileges: parsed.datastorePrivileges || [] });
        }
      }
    } catch (error) {
      console.error('Error loading privileges:', { errorType: error.name });
    } finally {
      setLoading(false);
    }
  };

  const hasDatastoreAccess = (datastoreId: string, permission: 'canRead' | 'canStore' | 'canUpdate' | 'canDelete'): boolean => {
    if (!privileges) return false;
    
    const wildcardPriv = privileges.datastorePrivileges.find(p => p.datastoreId === '*');
    if (wildcardPriv && wildcardPriv[permission]) return true;
    
    const datastorePriv = privileges.datastorePrivileges.find(p => p.datastoreId === datastoreId);
    return datastorePriv ? datastorePriv[permission] : false;
  };

  return { privileges, loading, hasDatastoreAccess };
};
