export interface DicomTag {
  tag: string;
  name: string;
  keyword: string;
  vr: string;
}

export const VR_TYPES = {
  DATE: ['DA', 'DT', 'TM'],
  NUMERIC: ['IS', 'DS', 'US', 'UL', 'SS', 'SL', 'FL', 'FD'],
  TEXT: ['LO', 'SH', 'PN', 'CS', 'ST', 'LT', 'UT', 'AE', 'AS', 'UI', 'SQ']
};

export function getVrType(vr: string): 'DATE' | 'NUMERIC' | 'TEXT' {
  if (VR_TYPES.DATE.includes(vr)) return 'DATE';
  if (VR_TYPES.NUMERIC.includes(vr)) return 'NUMERIC';
  return 'TEXT';
}

export function getOperatorsForVr(vr: string) {
  const vrType = getVrType(vr);
  
  if (vrType === 'DATE') {
    return [
      { label: 'Before', value: 'BEFORE' },
      { label: 'After', value: 'AFTER' },
      { label: 'On', value: 'ON' },
      { label: 'Between', value: 'BETWEEN' }
    ];
  }
  
  if (vrType === 'NUMERIC') {
    return [
      { label: 'Equals', value: 'EQUALS' },
      { label: 'Greater Than', value: 'GREATER_THAN' },
      { label: 'Less Than', value: 'LESS_THAN' },
      { label: 'Greater or Equal', value: 'GREATER_EQUAL' },
      { label: 'Less or Equal', value: 'LESS_EQUAL' },
      { label: 'Between', value: 'BETWEEN' }
    ];
  }
  
  return [
    { label: 'Equals', value: 'EQUALS' },
    { label: 'Contains', value: 'CONTAINS' },
    { label: 'Starts With', value: 'STARTS_WITH' },
    { label: 'Ends With', value: 'ENDS_WITH' },
    { label: 'Regex', value: 'REGEX' },
    { label: 'In List', value: 'IN_LIST' }
  ];
}
