import React, { createContext, useContext } from 'react';
import { usePrivileges as usePrivilegesHook } from '../hooks/usePrivileges';
import type { Privileges, ManagementPrivileges } from '../hooks/usePrivileges';

interface PrivilegesContextType {
  privileges: Privileges | null;
  loading: boolean;
  hasDatastoreAccess: (datastoreId: string, permission: 'canRead' | 'canStore' | 'canUpdate' | 'canDelete') => boolean;
  hasManagementAccess: (resource: keyof ManagementPrivileges, permission: 'canEdit' | 'canDelete' | 'canList' | 'canQuery' | 'canCreate' | 'canRun' | 'canRead') => boolean;
  canAccessDataManagement: () => boolean;
  canAccessConfiguration: () => boolean;
  canAccessUserManagement: () => boolean;
}

const PrivilegesContext = createContext<PrivilegesContextType | undefined>(undefined);

export const PrivilegesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const privilegesData = usePrivilegesHook();

  return (
    <PrivilegesContext.Provider value={privilegesData}>
      {children}
    </PrivilegesContext.Provider>
  );
};

export const usePrivileges = () => {
  const context = useContext(PrivilegesContext);
  if (context === undefined) {
    throw new Error('usePrivileges must be used within a PrivilegesProvider');
  }
  return context;
};
