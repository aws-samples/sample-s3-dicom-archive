import React from 'react';
import { Box } from '@cloudscape-design/components';
import { DicomInterfacePrivilege } from '../types/dicom';

interface DicomInterface {
  id: string;
  name: string;
  aeTitle: string;
  description?: string;
}

interface PrivilegeDisplayProps {
  privileges: DicomInterfacePrivilege[];
  interfaces: DicomInterface[];
}

interface PrivilegeSquareProps {
  letter: string;
  isActive: boolean;
  color: string;
}

const PrivilegeSquare: React.FC<PrivilegeSquareProps> = ({ letter, isActive, color }) => {
  const squareStyle: React.CSSProperties = {
    width: '18px',
    height: '18px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '10px',
    fontWeight: 'bold',
    borderRadius: '3px',
    backgroundColor: isActive ? color : 'transparent',
    color: isActive ? 'white' : '#5f6b7a', // Dark gray instead of black
    transition: 'all 0.2s ease'
  };

  return (
    <div style={squareStyle}>
      {letter}
    </div>
  );
};

interface InterfacePrivilegeRowProps {
  interfaceName: string;
  canStore: boolean;
  canQuery: boolean;
  canRetrieve: boolean;
}

const InterfacePrivilegeRow: React.FC<InterfacePrivilegeRowProps> = ({
  interfaceName,
  canStore,
  canQuery,
  canRetrieve
}) => {
  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '2px 0',
    minWidth: '120px'
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: '500',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: '1',
    marginRight: '8px'
    // Removed hardcoded color to use theme-aware text color
  };

  const squaresContainerStyle: React.CSSProperties = {
    display: 'flex',
    gap: '3px',
    flexShrink: 0
  };

  return (
    <div style={rowStyle}>
      <div style={labelStyle} title={interfaceName}>
        {interfaceName}
      </div>
      <div style={squaresContainerStyle}>
        <PrivilegeSquare 
          letter="S" 
          isActive={canStore} 
          color="#0073bb" // Blue for Store
        />
        <PrivilegeSquare 
          letter="Q" 
          isActive={canQuery} 
          color="#037f0c" // Green for Query
        />
        <PrivilegeSquare 
          letter="R" 
          isActive={canRetrieve} 
          color="#7d2d94" // Purple for Retrieve
        />
      </div>
    </div>
  );
};

const PrivilegeDisplay: React.FC<PrivilegeDisplayProps> = ({ privileges, interfaces }) => {
  if (!privileges || privileges.length === 0) {
    return (
      <Box color="text-status-inactive" fontSize="body-s">
        No privileges
      </Box>
    );
  }

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxWidth: '280px'
  };

  return (
    <div style={containerStyle}>
      {privileges.map((privilege) => {
        const interfaceInfo = interfaces.find(iface => iface.id === privilege.interfaceId);
        const interfaceName = interfaceInfo?.name || privilege.interfaceId;
        
        return (
          <InterfacePrivilegeRow
            key={privilege.interfaceId}
            interfaceName={interfaceName}
            canStore={privilege.canStore}
            canQuery={privilege.canQuery}
            canRetrieve={privilege.canRetrieve}
          />
        );
      })}
    </div>
  );
};

export default PrivilegeDisplay;
