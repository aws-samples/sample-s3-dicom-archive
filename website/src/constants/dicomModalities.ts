// DICOM Modality Codes
// Based on DICOM Standard PS3.16 - Context Groups

export const DICOM_MODALITIES = [
  { code: 'BDUS', description: 'Bone Densitometry (Ultrasound)' },
  { code: 'BI', description: 'Biomagnetic Imaging' },
  { code: 'BMD', description: 'Bone Densitometry (X-Ray)' },
  { code: 'CR', description: 'Computed Radiography' },
  { code: 'CT', description: 'Computed Tomography' },
  { code: 'DOC', description: 'Document' },
  { code: 'DX', description: 'Digital Radiography' },
  { code: 'ECG', description: 'Electrocardiography' },
  { code: 'EPS', description: 'Cardiac Electrophysiology' },
  { code: 'ES', description: 'Endoscopy' },
  { code: 'GM', description: 'General Microscopy' },
  { code: 'HD', description: 'Hemodynamic Waveform' },
  { code: 'IO', description: 'Intra-Oral Radiography' },
  { code: 'IVOCT', description: 'Intravascular Optical Coherence Tomography' },
  { code: 'IVUS', description: 'Intravascular Ultrasound' },
  { code: 'KO', description: 'Key Object Selection' },
  { code: 'MG', description: 'Mammography' },
  { code: 'MR', description: 'Magnetic Resonance' },
  { code: 'NM', description: 'Nuclear Medicine' },
  { code: 'OCT', description: 'Optical Coherence Tomography' },
  { code: 'OP', description: 'Ophthalmic Photography' },
  { code: 'OPM', description: 'Ophthalmic Mapping' },
  { code: 'OPT', description: 'Ophthalmic Tomography' },
  { code: 'OPV', description: 'Ophthalmic Visual Field' },
  { code: 'OT', description: 'Other' },
  { code: 'PR', description: 'Presentation State' },
  { code: 'PT', description: 'Positron Emission Tomography' },
  { code: 'PX', description: 'Panoramic X-Ray' },
  { code: 'REG', description: 'Registration' },
  { code: 'RF', description: 'Radiofluoroscopy' },
  { code: 'RG', description: 'Radiographic Imaging' },
  { code: 'RTDOSE', description: 'Radiotherapy Dose' },
  { code: 'RTIMAGE', description: 'Radiotherapy Image' },
  { code: 'RTPLAN', description: 'Radiotherapy Plan' },
  { code: 'RTRECORD', description: 'RT Treatment Record' },
  { code: 'RTSTRUCT', description: 'Radiotherapy Structure Set' },
  { code: 'SC', description: 'Secondary Capture' },
  { code: 'SEG', description: 'Segmentation' },
  { code: 'SM', description: 'Slide Microscopy' },
  { code: 'SMR', description: 'Stereometric Relationship' },
  { code: 'SR', description: 'Structured Report' },
  { code: 'US', description: 'Ultrasound' },
  { code: 'XA', description: 'X-Ray Angiography' },
  { code: 'XC', description: 'External-camera Photography' },
];

// Helper function to get modality options for Select components
export const getModalityOptions = (includeAll = true) => {
  const options = DICOM_MODALITIES.map(m => ({
    label: `${m.code} - ${m.description}`,
    value: m.code
  }));
  
  if (includeAll) {
    return [{ label: 'All Modalities', value: '' }, ...options];
  }
  
  return options;
};

// Helper function to get modality description
export const getModalityDescription = (code: string): string => {
  const modality = DICOM_MODALITIES.find(m => m.code === code);
  return modality ? modality.description : code;
};
