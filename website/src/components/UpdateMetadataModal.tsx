import React, { useState, useEffect } from 'react';
import {
  Modal,
  FormField,
  Input,
  Select,
  ColumnLayout,
  SpaceBetween,
  Button,
  Box,
  Alert,
  Header
} from '@cloudscape-design/components';
import { apiClient } from '../services/apiClient';

export interface UpdateMetadataModalProps {
  visible: boolean;
  onDismiss: () => void;
  mode: 'PATIENT_STUDY' | 'SERIES';
  datastoreId: string;
  studyInstanceUID: string;
  seriesInstanceUID?: string;
  currentValues: Record<string, string>;
  onSubmitSuccess: () => void;
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const UpdateMetadataModal: React.FC<UpdateMetadataModalProps> = ({
  visible, onDismiss, mode, datastoreId, studyInstanceUID, seriesInstanceUID, currentValues, onSubmitSuccess
}) => {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (visible) {
      setValues({ ...currentValues });
      setError('');
    }
  }, [visible, currentValues]);

  const set = (key: string, val: string) => setValues(prev => ({ ...prev, [key]: val }));

  const getModifiedFields = (): Record<string, string> => {
    const modified: Record<string, string> = {};
    for (const [key, val] of Object.entries(values)) {
      if (val !== (currentValues[key] || '')) modified[key] = val;
    }
    return modified;
  };

  const handleSubmit = async () => {
    const modifications = getModifiedFields();
    if (!Object.keys(modifications).length) {
      setError('No fields have been modified.');
      return;
    }

    // Validate SeriesNumber is numeric
    if (mode === 'SERIES' && modifications.SeriesNumber && !/^\d+$/.test(modifications.SeriesNumber)) {
      setError('Series Number must be a numeric value.');
      return;
    }

    // Validate date formats
    const dateFields = ['PatientBirthDate', 'StudyDate', 'SeriesDate'];
    for (const field of dateFields) {
      if (modifications[field] && !DATE_REGEX.test(modifications[field])) {
        setError(`${field} must be in YYYY-MM-DD format.`);
        return;
      }
    }

    setSubmitting(true);
    setError('');
    try {
      const response = await apiClient.makeRequest(`/storage/${datastoreId}/studies/${studyInstanceUID}/update-metadata`, {
        method: 'POST',
        body: JSON.stringify({ mode, seriesInstanceUID, modifications })
      });
      if (response.success) {
        onSubmitSuccess();
        onDismiss();
      } else {
        setError((response as any).error || 'Update request failed.');
      }
    } catch (e: any) {
      setError(e.message || 'Unexpected error.');
    } finally {
      setSubmitting(false);
    }
  };

  const hasChanges = Object.keys(getModifiedFields()).length > 0;

  return (
    <Modal
      visible={visible}
      onDismiss={onDismiss}
      size="large"
      header={<Header variant="h2">{mode === 'PATIENT_STUDY' ? 'Edit Patient / Study Metadata' : 'Edit Series Metadata'}</Header>}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onDismiss}>Cancel</Button>
            <Button variant="primary" onClick={handleSubmit} loading={submitting} disabled={!hasChanges}>
              Submit Update
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="l">
        {error && <Alert type="error">{error}</Alert>}

        {mode === 'PATIENT_STUDY' && (
          <Alert type="info">
            Patient and Study-level changes will be applied to <strong>all instances</strong> in this study atomically.
          </Alert>
        )}

        {mode === 'PATIENT_STUDY' && (
          <>
            <Header variant="h3">Patient</Header>
            <ColumnLayout columns={2}>
              <FormField label="Patient Name">
                <Input value={values.PatientName || ''} onChange={({ detail }) => set('PatientName', detail.value)} placeholder="Last^First" />
              </FormField>
              <FormField label="Patient ID">
                <Input value={values.PatientID || ''} onChange={({ detail }) => set('PatientID', detail.value)} />
              </FormField>
              <FormField label="Patient Birth Date" description="Format: YYYY-MM-DD">
                <Input value={values.PatientBirthDate || ''} onChange={({ detail }) => set('PatientBirthDate', detail.value)} placeholder="YYYY-MM-DD" />
              </FormField>
              <FormField label="Patient Sex">
                <Select
                  selectedOption={values.PatientSex ? { label: { M: 'Male', F: 'Female', O: 'Other' }[values.PatientSex] || values.PatientSex, value: values.PatientSex } : null}
                  onChange={({ detail }) => set('PatientSex', detail.selectedOption.value || '')}
                  options={[{ label: 'Male', value: 'M' }, { label: 'Female', value: 'F' }, { label: 'Other', value: 'O' }]}
                  placeholder="Select"
                />
              </FormField>
              <FormField label="Issuer of Patient ID">
                <Input value={values.IssuerOfPatientID || ''} onChange={({ detail }) => set('IssuerOfPatientID', detail.value)} />
              </FormField>
            </ColumnLayout>

            <Header variant="h3">Study</Header>
            <ColumnLayout columns={2}>
              <FormField label="Study Date" description="Format: YYYY-MM-DD">
                <Input value={values.StudyDate || ''} onChange={({ detail }) => set('StudyDate', detail.value)} placeholder="YYYY-MM-DD" />
              </FormField>
              <FormField label="Study Description">
                <Input value={values.StudyDescription || ''} onChange={({ detail }) => set('StudyDescription', detail.value)} />
              </FormField>
              <FormField label="Accession Number">
                <Input value={values.AccessionNumber || ''} onChange={({ detail }) => set('AccessionNumber', detail.value)} />
              </FormField>
              <FormField label="Referring Physician Name">
                <Input value={values.ReferringPhysicianName || ''} onChange={({ detail }) => set('ReferringPhysicianName', detail.value)} />
              </FormField>
              <FormField label="Study ID">
                <Input value={values.StudyID || ''} onChange={({ detail }) => set('StudyID', detail.value)} />
              </FormField>
            </ColumnLayout>
          </>
        )}

        {mode === 'SERIES' && (
          <>
            <ColumnLayout columns={2}>
              <FormField label="Series Number">
                <Input value={values.SeriesNumber || ''} onChange={({ detail }) => set('SeriesNumber', detail.value)} inputMode="numeric" />
              </FormField>
              <FormField label="Series Description">
                <Input value={values.SeriesDescription || ''} onChange={({ detail }) => set('SeriesDescription', detail.value)} />
              </FormField>
              <FormField label="Series Date" description="Format: YYYY-MM-DD">
                <Input value={values.SeriesDate || ''} onChange={({ detail }) => set('SeriesDate', detail.value)} placeholder="YYYY-MM-DD" />
              </FormField>
            </ColumnLayout>
          </>
        )}
      </SpaceBetween>
    </Modal>
  );
};

export default UpdateMetadataModal;
