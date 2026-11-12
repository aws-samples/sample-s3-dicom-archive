import React, { useState, useEffect, Fragment, useCallback, useRef } from 'react';
import './dicom-studies-table.css';
import { getModalityOptions } from '../constants/dicomModalities';
import { ModalityBadge, ModalityBadges } from './ModalityBadge';
import {
  Container,
  Header,
  Table,
  Button,
  SpaceBetween,
  Box,
  FormField,
  Input,
  Select,
  ColumnLayout,
  Badge,
  Flashbar,
  DatePicker,
  ExpandableSection,
  Icon,
  Modal,
  Checkbox,
  Pagination,
  Tabs,
  Spinner
} from '@cloudscape-design/components';
import { fetchAuthSession } from 'aws-amplify/auth';

import { Datastore } from '../types';
import { apiClient } from '../services/apiClient';
import { useTheme } from '../contexts/ThemeContext';
import { usePrivileges } from '../contexts/PrivilegesContext';
import UpdateMetadataModal from './UpdateMetadataModal';
import { Mode } from '@cloudscape-design/global-styles';
import dicomwebService, {
  ProcessedDicomStudy,
  ProcessedDicomSeries,
  ProcessedDicomInstance,
  StudySearchParams,
  getDatastoreTarget
} from '../services/dicomwebService';
import DicomThumbnail from './DicomThumbnail';
import ProcessingJobModal, { ProcessingJobTarget } from './ProcessingJobModal';
import NonDicomImportV2, { FixedStudy } from './NonDicomImportV2';
import { isNonDicomImportV2Enabled } from './nonDicomImportV2/apiV2';
import { importJobService } from '../services';


// Configuration - Prioritize runtime config over static aws-exports
// const config = (window as any).REACT_APP_CONFIG || {};

interface DicomStudiesManagementProps {
  /**
   * Navigate to the unified Import center's DICOM tab, optionally preselecting a
   * storage datastore. Provided by App so the Studies page can offer a shortcut
   * instead of hosting its own upload / import-bucket controls.
   */
  onNavigateToImport?: (datastoreId?: string) => void;
}

interface VirtualFolder {
  id: string;
  name: string;
  status: string;
  description?: string;
}

const DicomStudiesManagement: React.FC<DicomStudiesManagementProps> = ({ onNavigateToImport }) => {
  // Use the theme context
  const { theme: themeMode } = useTheme();
  const theme = themeMode === Mode.Dark ? 'dark' : 'light';
  const { hasDatastoreAccess, hasManagementAccess, hasVirtualFolderAccess } = usePrivileges();
  
  // Get runtime configuration
  const config = (window as any).REACT_APP_CONFIG || {};
  const VIRTUAL_FOLDER_ENABLED = config.VIRTUAL_FOLDER === 'true';
  const NON_DICOM_V2_ENABLED = isNonDicomImportV2Enabled();
  // Non-DICOM Import V2 "Attach files": destination + study fixed, patient step skipped.
  const [attachTarget, setAttachTarget] = useState<{ kind: 'datastore' | 'virtualFolder'; id: string; name: string; study: FixedStudy } | null>(null);
  
  console.log('🎨 Using theme from context:', { themeMode, theme });

  // Tab state
  const [activeTab, setActiveTab] = useState('datastores');
  
  // Virtual folder studies state
  const [virtualFolderStudies, setVirtualFolderStudies] = useState<any[]>([]);
  const [virtualFolderLoading, setVirtualFolderLoading] = useState(false);
  const [selectedVirtualFolderStudies, setSelectedVirtualFolderStudies] = useState<Set<string>>(new Set());
  const [vfPage, setVfPage] = useState(1);
  const [vfPageSize] = useState(20);
  const [vfTotalPages, setVfTotalPages] = useState(1);
  const [vfTotalCount, setVfTotalCount] = useState(0);
  const [vfSearchParams, setVfSearchParams] = useState({
    PatientID: '',
    PatientName: '',
    StudyDate: '',
    StudyDescription: '',
    AccessionNumber: '',
    ModalitiesInStudy: ''
  });

  // State management
  const [studies, setStudies] = useState<ProcessedDicomStudy[]>([]);
  const [loading, setLoading] = useState(false);
  
  // Virtual datastore assignment state
  const [virtualFolders, setVirtualFolders] = useState<VirtualFolder[]>([]);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedVirtualFolder, setSelectedVirtualFolder] = useState<VirtualFolder | null>(null);
  const [assigning, setAssigning] = useState(false);
  
  // Upload / import now live in the unified Import center (see onNavigateToImport).
  
  // Delete state
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);
  const [pendingOpsCount, setPendingOpsCount] = useState(0);
  
  // Update metadata modal state
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateMode, setUpdateMode] = useState<'PATIENT_STUDY' | 'SERIES'>('PATIENT_STUDY');
  const [updateCurrentValues, setUpdateCurrentValues] = useState<Record<string, string>>({});
  const [updateStudyInstanceUID, setUpdateStudyInstanceUID] = useState('');
  const [updateSeriesInstanceUID, setUpdateSeriesInstanceUID] = useState<string | undefined>();

  // Import-existing-bucket state removed — the flow now lives in ImportCenter
  // (Existing S3 bucket tab) via the shared ImportDatastoreModal component.

  // Expandable rows state
  const [expandedStudies, setExpandedStudies] = useState<Set<string>>(new Set());
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());
  const [studySeriesMap, setStudySeriesMap] = useState<Map<string, ProcessedDicomSeries[]>>(new Map());
  const [seriesInstancesMap, setSeriesInstancesMap] = useState<Map<string, ProcessedDicomInstance[]>>(new Map());
  
  // Datastore management
  const [datastores, setDatastores] = useState<Datastore[]>([]);
  // Merged, kind-tagged index list backing the Studies selector: storage indexes
  // (one per datastore) + VF indexes (one per active virtual folder).
  const [indexes, setIndexes] = useState<Array<Datastore & { indexKind?: 'storage-index' | 'vf-index' }>>([]);
  // Raw storage-content listing (storage_index rows) for the selected storage index.
  const [storageContent, setStorageContent] = useState<any[]>([]);
  const [storageContentLoading, setStorageContentLoading] = useState(false);
  const [selectedDatastore, setSelectedDatastore] = useState<Datastore | null>(null);
  const [datastoresLoading, setDatastoresLoading] = useState(true);
  
  // Filter states (applied filters that trigger search)
  const [patientIdFilter, setPatientIdFilter] = useState('');
  const [studyDateFilter, setStudyDateFilter] = useState('');
  const [modalityFilter, setModalityFilter] = useState('');
  const [patientNameFilter, setPatientNameFilter] = useState('');
  const [studyDescriptionFilter, setStudyDescriptionFilter] = useState('');
  const [accessionNumberFilter, setAccessionNumberFilter] = useState('');
  const [patientBirthDateFilter, setPatientBirthDateFilter] = useState('');
  const [patientSexFilter, setPatientSexFilter] = useState('');
  
  // Filter input states (user input, not yet applied)
  const [patientIdInput, setPatientIdInput] = useState('');
  const [studyDateInput, setStudyDateInput] = useState('');
  const [modalityInput, setModalityInput] = useState('');
  const [patientNameInput, setPatientNameInput] = useState('');
  const [studyDescriptionInput, setStudyDescriptionInput] = useState('');
  const [accessionNumberInput, setAccessionNumberInput] = useState('');
  const [patientBirthDateInput, setPatientBirthDateInput] = useState('');
  const [patientSexInput, setPatientSexInput] = useState('');
  
  // Date validation states - track if field has been blurred
  const [studyDateTouched, setStudyDateTouched] = useState(false);
  const [birthDateTouched, setBirthDateTouched] = useState(false);
  
  // Table preferences state
  const [preferences] = useState({
    pageSize: 20,
    visibleColumns: ['select-expand', 'thumbnail', 'patientName', 'patientID', 'studyDate', 'modality', 'seriesCount', 'instanceCount', 'accessionNumber'],
    wrapLines: false,
    stripedRows: false
  });

  // All available columns for the table
  // const allColumns = [
  //   { id: 'select-expand', label: 'Select/Expand' },
  //   { id: 'thumbnail', label: 'View' },
  //   { id: 'patientName', label: 'Patient Name' },
  //   { id: 'patientID', label: 'Patient ID' },
  //   { id: 'studyDate', label: 'Study Date' },
  //   { id: 'studyTime', label: 'Study Time' },
  //   { id: 'studyDescription', label: 'Description' },
  //   { id: 'modality', label: 'Modality' },
  //   { id: 'seriesCount', label: 'Series' },
  //   { id: 'instanceCount', label: 'Instances' },
  //   { id: 'accessionNumber', label: 'Accession Number' },
  //   { id: 'referringPhysician', label: 'Referring Physician' }
  // ];

  // Table and pagination states
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pageSize, setPageSize] = useState(preferences.pageSize);
  const [totalCount, setTotalCount] = useState(0);
  
  // Notification state
  const [notifications, setNotifications] = useState<any[]>([]);
  
  // Selection state management
  const [selectedStudies, setSelectedStudies] = useState<Set<string>>(new Set());
  const [selectedSeries, setSelectedSeries] = useState<Set<string>>(new Set());
  const [selectedInstances, setSelectedInstances] = useState<Set<string>>(new Set());

  // Processing job state
  const canRunJobs = hasManagementAccess('processingJobs', 'canRun');
  const [showJobModal, setShowJobModal] = useState(false);
  const [jobTarget, setJobTarget] = useState<ProcessingJobTarget | null>(null);

  // Selection handlers
  const handleStudySelection = (studyId: string, checked: boolean) => {
    const newSelectedStudies = new Set(selectedStudies);
    if (checked) {
      newSelectedStudies.add(studyId);
    } else {
      newSelectedStudies.delete(studyId);
    }
    setSelectedStudies(newSelectedStudies);
  };

  const handleSeriesSelection = (seriesId: string, checked: boolean) => {
    const newSelectedSeries = new Set(selectedSeries);
    if (checked) {
      newSelectedSeries.add(seriesId);
    } else {
      newSelectedSeries.delete(seriesId);
    }
    setSelectedSeries(newSelectedSeries);
  };

  const handleInstanceSelection = (instanceId: string, checked: boolean) => {
    const newSelectedInstances = new Set(selectedInstances);
    if (checked) {
      newSelectedInstances.add(instanceId);
    } else {
      newSelectedInstances.delete(instanceId);
    }
    setSelectedInstances(newSelectedInstances);
  };

  // Function declarations (must be before useEffect calls)
  const loadDatastores = useCallback(async () => {
    setDatastoresLoading(true);
    try {
      console.log('🔄 Loading datastores...');
      const response = await apiClient.getDatastores({ pageSize: 100 });
      console.log('📦 Datastores response:', response);
      
      if (response.success && response.data) {
        console.log('✅ Raw datastores:', response.data.items);
        const activeDatastores = response.data.items.filter(ds => ds.status?.toUpperCase() === 'ACTIVE');
        console.log('✅ Active datastores after filter:', activeDatastores);
        
        // Filter datastores based on user privileges
        const accessibleDatastores = activeDatastores.filter(ds => 
          hasDatastoreAccess(ds.id, 'canRead') || hasDatastoreAccess('*', 'canRead')
        );
        console.log('✅ Accessible datastores after privilege filter:', accessibleDatastores);
        
        setDatastores(accessibleDatastores);
        
        // ── Merge VF indexes into the selector ────────────────────────────
        // The Studies selector now lists INDEXES, not storages: each datastore
        // is a 'storage-index', and each active virtual folder is a 'vf-index'.
        // Both are addressed on /dicomweb/{id}, so a VF index is shaped like a
        // datastore entry (id + name + status) with a kind tag and storageType
        // 'S3' so getDatastoreTarget resolves its path the same way.
        let vfIndexes: Datastore[] = [];
        try {
          const vfResp = await apiClient.getVirtualFolders({ pageSize: 100 });
          if (vfResp.success && vfResp.data) {
            vfIndexes = vfResp.data.items
              .filter((vf: any) => (vf.status?.toUpperCase?.() ?? 'ACTIVE') === 'ACTIVE')
              .filter((vf: any) => hasVirtualFolderAccess(vf.id, 'canRead') || hasVirtualFolderAccess('*', 'canRead'))
              .map((vf: any) => ({
                ...vf,
                id: vf.id,
                name: vf.name,
                status: 'ACTIVE',
                storageType: 'S3',
                indexKind: 'vf-index' as const,
              }));
          }
        } catch (e) {
          console.warn('VF indexes unavailable for selector:', e);
        }
        // Tag storage indexes and expose the merged, tagged list.
        const storageIndexes = accessibleDatastores.map(ds => ({ ...ds, indexKind: 'storage-index' as const }));
        setIndexes([...storageIndexes, ...vfIndexes]);
        
        // Auto-select first datastore if available
        if (accessibleDatastores.length > 0) {
          console.log('🎯 Auto-selecting first datastore:', accessibleDatastores[0]);
          setSelectedDatastore(accessibleDatastores[0]);
        }
      } else {
        console.error('❌ Failed to load datastores:', response.message);
        addNotification('error', 'Failed to load datastores', response.message);
      }
    } catch (error) {
      console.error('❌ Error loading datastores:', error.message);
      addNotification('error', 'Failed to load datastores', error);
    } finally {
      setDatastoresLoading(false);
    }
  }, [hasDatastoreAccess, hasVirtualFolderAccess]);

  // Load raw storage-content (storage_index rows) for the selected storage index.
  const loadStorageContent = useCallback(async () => {
    if (!selectedDatastore) return;
    setStorageContentLoading(true);
    try {
      const resp = await apiClient.getStorageContent(selectedDatastore.id, { pageSize: 200 });
      if (resp.success && resp.data) {
        setStorageContent(resp.data.items || []);
      } else {
        setStorageContent([]);
      }
    } catch (e) {
      console.warn('storage content load failed', e);
      setStorageContent([]);
    } finally {
      setStorageContentLoading(false);
    }
  }, [selectedDatastore]);

  useEffect(() => {
    if (activeTab === 'storage-content' && selectedDatastore) {
      loadStorageContent();
    }
  }, [activeTab, selectedDatastore, loadStorageContent]);

  // Handle search button click - apply all filter inputs
  const handleSearch = () => {
    setPatientIdFilter(patientIdInput);
    setStudyDateFilter(studyDateInput);
    setModalityFilter(modalityInput);
    setPatientNameFilter(patientNameInput);
    setStudyDescriptionFilter(studyDescriptionInput);
    setAccessionNumberFilter(accessionNumberInput);
    setPatientBirthDateFilter(patientBirthDateInput);
    setPatientSexFilter(patientSexInput);
    setCurrentPageIndex(1);
  };

  // Handle clear filters
  const handleClearFilters = () => {
    setPatientIdFilter('');
    setStudyDateFilter('');
    setModalityFilter('');
    setPatientNameFilter('');
    setStudyDescriptionFilter('');
    setAccessionNumberFilter('');
    setPatientBirthDateFilter('');
    setPatientSexFilter('');
    setCurrentPageIndex(1);
  };

  // Handle reset all filters (both input and applied)
  const handleResetAllFilters = () => {
    setPatientIdInput('');
    setStudyDateInput('');
    setModalityInput('');
    setPatientNameInput('');
    setStudyDescriptionInput('');
    setAccessionNumberInput('');
    setPatientBirthDateInput('');
    setPatientSexInput('');
    setPatientIdFilter('');
    setStudyDateFilter('');
    setModalityFilter('');
    setPatientNameFilter('');
    setStudyDescriptionFilter('');
    setAccessionNumberFilter('');
    setPatientBirthDateFilter('');
    setPatientSexFilter('');
    setCurrentPageIndex(1);
  };

  const loadStudies = useCallback(async () => {
    if (!selectedDatastore) return;
    
    setLoading(true);
    try {
      // Resolve the DICOMweb backend to talk to and the id it is keyed on.
      // S3-only: every datastore is S3-backed; storageType is treated as 'S3'.
      const { pathId: datastoreId, storageType } = getDatastoreTarget(selectedDatastore);

      if (!datastoreId) {
        console.error('❌ No datastore id found in selectedDatastore:', selectedDatastore);
        addNotification('error', 'Missing Datastore ID',
          'The selected datastore has no identifier, so its DICOMweb endpoint cannot be addressed.');
        return;
      }

      // Build search parameters for DICOMWeb QIDO-RS
      const searchParams: StudySearchParams = {};

      // The S3 DICOMweb container rejects study-level PatientSex with a 400 rather than
      // silently dropping the filter, so that one is applied client-side instead.
      const filterPatientSexClientSide = !!patientSexFilter.trim();

      // Check if we're using client-side demographic filters
      const usingDemographicFilters = patientBirthDateFilter.trim() || filterPatientSexClientSide;

      if (usingDemographicFilters) {
        // When using demographic filters, fetch more results for client-side filtering
        // We'll fetch a larger batch and filter client-side
        searchParams.limit = 100; // Fetch more results for filtering
        searchParams.offset = 0;   // Start from beginning
      } else {
        // Normal server-side pagination
        searchParams.limit = pageSize;
        searchParams.offset = (currentPageIndex - 1) * pageSize;
      }

      // Add filters if specified
      if (patientIdFilter.trim()) {
        searchParams.PatientID = patientIdFilter.trim();
      }
      if (patientNameFilter.trim()) {
        searchParams.PatientName = `*${patientNameFilter.trim()}*`; // Wildcard search
      }
      if (studyDescriptionFilter.trim()) {
        searchParams.StudyDescription = `*${studyDescriptionFilter.trim()}*`; // Wildcard search
      }
      if (studyDateFilter.trim()) {
        // Convert YYYY-MM-DD to YYYYMMDD format for DICOM
        const dateFormatted = studyDateFilter.replace(/-/g, '');
        searchParams.StudyDate = dateFormatted;
      }
      if (accessionNumberFilter.trim()) {
        searchParams.AccessionNumber = accessionNumberFilter.trim();
      }
      if (modalityFilter.trim()) {
        searchParams.ModalitiesInStudy = modalityFilter.trim();
      }
      if (patientSexFilter.trim() && !filterPatientSexClientSide) {
        searchParams.PatientSex = patientSexFilter.trim();
      }
      // Note: Patient birth date is not typically used as a search parameter in QIDO-RS
      // It will be filtered on the client side after retrieval

      console.log('🔍 Searching studies with DICOMweb API');
      console.log('🏥 Target datastore:', datastoreId, `(${storageType})`);
      console.log('📊 Using demographic filters:', usingDemographicFilters);

      // Use the DICOMweb service to search studies directly
      const response = await dicomwebService.searchStudies(datastoreId, searchParams, selectedDatastore.id, storageType);

      if (response.success && response.data) {
        let filteredStudies = response.data;

        // Apply client-side filters for patient demographics
        if (patientBirthDateFilter.trim()) {
          const filterDate = patientBirthDateFilter.replace(/-/g, ''); // Convert to YYYYMMDD
          filteredStudies = filteredStudies.filter(study =>
            study.patientBirthDate && study.patientBirthDate.includes(filterDate)
          );
        }

        if (filterPatientSexClientSide) {
          const filterSex = patientSexFilter.trim().toUpperCase();
          filteredStudies = filteredStudies.filter(study =>
            (study.patientSex || '').toUpperCase() === filterSex
          );
        }

        if (usingDemographicFilters) {
          // For demographic filtering, we need to implement client-side pagination
          const startIndex = (currentPageIndex - 1) * pageSize;
          const endIndex = startIndex + pageSize;
          const paginatedStudies = filteredStudies.slice(startIndex, endIndex);
          
          setStudies(paginatedStudies);
          setTotalCount(filteredStudies.length);
          
          // Show info about client-side filtering
          if (filteredStudies.length < response.data.length) {
            addNotification('info', 'Client-side Filtering Active', 
              `Showing ${filteredStudies.length} studies after applying demographic filters. ` +
              `Note: Pagination is limited when using patient birth date or gender filters.`);
          }
        } else {
          // Normal server-side pagination
          setStudies(filteredStudies);
          // For server-side pagination, we need to estimate total count
          // This is a limitation of QIDO-RS - we don't get total count
          setTotalCount(filteredStudies.length === pageSize ? (currentPageIndex * pageSize) + 1 : (currentPageIndex - 1) * pageSize + filteredStudies.length);
        }
        
        // Success notification removed - only show warnings and errors
      } else {
        addNotification('error', 'Failed to load DICOM studies', response.error || response.message || 'Unknown error occurred');
        setStudies([]);
        setTotalCount(0);
      }
    } catch (error) {
      console.error('❌ Error in loadStudies:', { errorType: error.name });
      
      if (error instanceof Error) {
        addNotification('error', 'Failed to load DICOM studies', error.message);
      } else {
        addNotification('error', 'Failed to load DICOM studies', 'An unexpected error occurred');
      }
      
      setStudies([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [selectedDatastore, currentPageIndex, pageSize, patientIdFilter, studyDateFilter, modalityFilter, patientNameFilter, studyDescriptionFilter, accessionNumberFilter, patientBirthDateFilter, patientSexFilter]);

  // Load datastores on component mount
  useEffect(() => {
    loadDatastores();
  }, [loadDatastores]);

  // Load virtual datastores if feature is enabled
  useEffect(() => {
    if (VIRTUAL_FOLDER_ENABLED) {
      apiClient.getVirtualFolders({ pageSize: 100 }).then(response => {
        if (response.success && response.data) {
          setVirtualFolders(response.data.items.filter((vds: VirtualFolder) => vds.status === 'ACTIVE'));
        }
      });
    }
  }, [VIRTUAL_FOLDER_ENABLED]);

  // Auto-select first virtual folder when list loads
  useEffect(() => {
    if (!selectedVirtualFolder && virtualFolders.length > 0) {
      setSelectedVirtualFolder(virtualFolders[0]);
    }
  }, [virtualFolders, selectedVirtualFolder]);

  // Load virtual folder studies
  const loadVirtualFolderStudies = useCallback(async () => {
    if (!selectedVirtualFolder) {
      setVirtualFolderStudies([]);
      return;
    }

    setVirtualFolderLoading(true);
    try {
      // Build query string
      const params = new URLSearchParams();
      params.append('page', vfPage.toString());
      params.append('pageSize', vfPageSize.toString());
      if (vfSearchParams.PatientID) params.append('PatientID', vfSearchParams.PatientID);
      if (vfSearchParams.PatientName) params.append('PatientName', vfSearchParams.PatientName);
      if (vfSearchParams.StudyDate) params.append('StudyDate', vfSearchParams.StudyDate);
      if (vfSearchParams.StudyDescription) params.append('StudyDescription', vfSearchParams.StudyDescription);
      if (vfSearchParams.AccessionNumber) params.append('AccessionNumber', vfSearchParams.AccessionNumber);
      if (vfSearchParams.ModalitiesInStudy) params.append('ModalitiesInStudy', vfSearchParams.ModalitiesInStudy);
      
      const queryString = params.toString();
      const url = `/virtual-folders/${selectedVirtualFolder.id}/studies${queryString ? '?' + queryString : ''}`;
      
      const response = await apiClient.makeRequest(url);
      if (response.success && response.data) {
        const data = response.data as any;
        setVirtualFolderStudies(data.items || []);
        setVfTotalCount(data.totalCount || 0);
        setVfTotalPages(data.totalPages || 1);
      } else {
        addNotification('error', 'Failed to load virtual folder studies', 'Unknown error');
        setVirtualFolderStudies([]);
      }
    } catch (error) {
      console.error('Error loading virtual folder studies:', error.message);
      addNotification('error', 'Failed to load virtual folder studies', error instanceof Error ? error.message : 'Unknown error');
      setVirtualFolderStudies([]);
    } finally {
      setVirtualFolderLoading(false);
    }
  }, [selectedVirtualFolder, vfPage, vfPageSize, vfSearchParams]);

  // Remove studies from virtual folder via the DICOMweb DELETE verb
  // (DELETE /dicomweb/{vfId}/studies/{uid}). This unassigns the study from THIS
  // folder only — it never touches S3 or the source storage tree. Replaces the
  // old /vf-assignments path, which failed with "Datastore not found".
  const handleRemoveFromVirtualFolder = async () => {
    if (!selectedVirtualFolder || selectedVirtualFolderStudies.size === 0) return;

    setVirtualFolderLoading(true);
    const studyUids = Array.from(selectedVirtualFolderStudies);
    try {
      const results = await Promise.allSettled(
        studyUids.map(uid => dicomwebService.deleteDicomweb(selectedVirtualFolder.id, uid))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed === 0) {
        addNotification('success', 'Studies Removed', `Successfully removed ${studyUids.length} study(ies) from ${selectedVirtualFolder.name}`);
      } else {
        addNotification('error', 'Removal Failed', `${failed} of ${studyUids.length} removal(s) failed`);
      }
      setSelectedVirtualFolderStudies(new Set());
      loadVirtualFolderStudies();
    } catch (error) {
      addNotification('error', 'Removal Failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setVirtualFolderLoading(false);
    }
  };

  // Fetch pending operations count for selected datastore
  const fetchPendingOps = useCallback(async () => {
    if (!selectedDatastore) { setPendingOpsCount(0); return; }
    try {
      const response = await apiClient.makeRequest<{ pendingCount: number }>(`/storage/${selectedDatastore.id}/pending-operations`);
      if (response.success && response.data) setPendingOpsCount(response.data.pendingCount);
    } catch { /* ignore */ }
  }, [selectedDatastore]);

  // Poll pending operations every 30s
  useEffect(() => {
    fetchPendingOps();
    if (!selectedDatastore) return;
    const interval = setInterval(fetchPendingOps, 30000);
    return () => clearInterval(interval);
  }, [selectedDatastore, fetchPendingOps]);

  // Build the explicit target for a processing job from the current selection.
  // A selected study means the whole study; individually selected series are
  // added only when their study is not already selected. Series keys are decoded
  // by scanning studySeriesMap rather than splitting on '-', because study UIDs
  // may themselves contain hyphens.
  const openJobModal = () => {
    if (!selectedDatastore) return;
    const entries: ProcessingJobTarget['entries'] = [];
    for (const studyInstanceUID of Array.from(selectedStudies)) {
      entries.push({ datastoreId: selectedDatastore.id, studyInstanceUID });
    }
    for (const seriesKey of Array.from(selectedSeries)) {
      for (const [studyUID, seriesList] of Array.from(studySeriesMap.entries())) {
        if (selectedStudies.has(studyUID)) continue;
        const series = seriesList.find((s: ProcessedDicomSeries) => `${studyUID}-${s.seriesInstanceUID}` === seriesKey);
        if (series) {
          entries.push({
            datastoreId: selectedDatastore.id,
            studyInstanceUID: studyUID,
            seriesInstanceUID: series.seriesInstanceUID,
          });
          break;
        }
      }
    }
    if (!entries.length) {
      addNotification('error', 'Nothing selected', 'Select at least one study or series to run a processing job.');
      return;
    }
    setJobTarget({ mode: 'explicit', entries });
    setShowJobModal(true);
  };

  // Handle delete selected studies/series
  const handleDeleteSelected = async () => {
    if (!selectedDatastore) return;
    setDeleteInProgress(true);
    setShowDeleteConfirmModal(false);
    const isVfIndex = (selectedDatastore as any).indexKind === 'vf-index';
    try {
      if (isVfIndex) {
        // VF index: "delete" means UNASSIGN from THIS folder only — via the
        // DICOMweb DELETE verb (DELETE /dicomweb/{vfId}/studies/{uid}[/series/{uid}]).
        // It never touches S3 or the source storage tree. The old /storage/{id}
        // path 404'd here ('Datastore not found') because {id} is a VF id.
        for (const studyUID of Array.from(selectedStudies)) {
          await dicomwebService.deleteDicomweb(selectedDatastore.id, studyUID);
        }
        // Individually selected series (not part of a selected study)
        for (const seriesKey of Array.from(selectedSeries)) {
          for (const [studyUID, seriesList] of Array.from(studySeriesMap.entries())) {
            if (selectedStudies.has(studyUID)) continue;
            const series = seriesList.find((s: ProcessedDicomSeries) => `${studyUID}-${s.seriesInstanceUID}` === seriesKey);
            if (series) {
              await dicomwebService.deleteDicomweb(selectedDatastore.id, studyUID, series.seriesInstanceUID);
              break;
            }
          }
        }
        addNotification('success', 'Removed from Virtual Folder', 'The selection was unassigned from this virtual folder.');
        setSelectedStudies(new Set());
        setSelectedSeries(new Set());
        loadStudies();
        return;
      }

      // Storage index: a real deletion. A fully-selected study -> delete-study
      // (worker cascades series->study->patient, unassigns from every VF, deletes
      // the S3 objects, updates stats).
      const studyArray = Array.from(selectedStudies);
      for (const studyUID of studyArray) {
        const study = studies.find(s => s.studyInstanceUID === studyUID);
        if (!study) continue;
        await apiClient.makeRequest(`/storage/${selectedDatastore.id}/studies/${studyUID}/delete-study`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
      }
      // For individually selected series (not part of a selected study)
      const seriesByStudy: Record<string, string[]> = {};
      const seriesArray = Array.from(selectedSeries);
      for (const seriesKey of seriesArray) {
        const entries = Array.from(studySeriesMap.entries());
        for (const [studyUID, seriesList] of entries) {
          if (selectedStudies.has(studyUID)) continue;
          const series = seriesList.find((s: ProcessedDicomSeries) => `${studyUID}-${s.seriesInstanceUID}` === seriesKey);
          if (series) {
            if (!seriesByStudy[studyUID]) seriesByStudy[studyUID] = [];
            seriesByStudy[studyUID].push(series.seriesInstanceUID);
            break;
          }
        }
      }
      for (const studyUID of Object.keys(seriesByStudy)) {
        await apiClient.makeRequest(`/storage/${selectedDatastore.id}/studies/${studyUID}/delete-series`, {
          method: 'POST',
          body: JSON.stringify({ seriesInstanceUIDs: seriesByStudy[studyUID] }),
        });
      }
      addNotification('success', 'Delete Requested', 'Delete operations have been queued for processing.');
      setSelectedStudies(new Set());
      setSelectedSeries(new Set());
      fetchPendingOps();
    } catch (error) {
      addNotification('error', 'Delete Failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setDeleteInProgress(false);
    }
  };

  // Load virtual folder studies when virtual folder changes
  useEffect(() => {
    if (activeTab === 'virtual-folders' && selectedVirtualFolder) {
      loadVirtualFolderStudies();
    }
  }, [activeTab, selectedVirtualFolder, loadVirtualFolderStudies]);

  // Reset page when search params or folder changes
  useEffect(() => { setVfPage(1); }, [selectedVirtualFolder, vfSearchParams]);

  // Handle assignment to virtual datastore
  const handleAssignToVirtualFolder = async () => {
    if (!selectedVirtualFolder || !selectedDatastore || selectedStudies.size === 0) return;
    
    setAssigning(true);
    try {
      let successCount = 0;
      const studyUids = Array.from(selectedStudies);
      for (const studyUid of studyUids) {
        const response = await apiClient.assignStudyToVirtualFolder({
          virtualFolderId: selectedVirtualFolder.id,
          studyInstanceUid: studyUid,
          datastoreId: selectedDatastore.id
        });
        if (response.success) successCount++;
      }
      addNotification('success', 'Studies Assigned', `Successfully assigned ${successCount} study(ies) to ${selectedVirtualFolder.name}`);
      setShowAssignModal(false);
      setSelectedStudies(new Set());
    } catch (error) {
      addNotification('error', 'Assignment Failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setAssigning(false);
    }
  };

  // Load studies when datastore or filters change
  useEffect(() => {
    console.log('🎨 Current theme in useEffect:', theme);
    if (selectedDatastore) {
      loadStudies();
    } else {
      setStudies([]);
      setTotalCount(0);
    }
  }, [selectedDatastore, currentPageIndex, pageSize, patientIdFilter, studyDateFilter, modalityFilter, patientNameFilter, studyDescriptionFilter, accessionNumberFilter, patientBirthDateFilter, patientSexFilter, loadStudies, theme]);

  // Helper to validate date format (YYYY-MM-DD)
  const isValidDateFormat = (dateStr: string) => {
    if (!dateStr || dateStr.trim() === '') return true; // Empty is valid
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateStr)) return false;
    const date = new Date(dateStr);
    return date instanceof Date && !isNaN(date.getTime());
  };

  const addNotification = (type: 'success' | 'error' | 'warning' | 'info', header: string, content?: any) => {
    const notification = {
      id: Date.now().toString(),
      type,
      header,
      content: content?.message || content,
      dismissible: true,
      onDismiss: () => setNotifications(prev => prev.filter(n => n.id !== notification.id))
    };
    setNotifications(prev => [...prev, notification]);
    
    // Auto-dismiss success notifications after 2 seconds
    if (type === 'success') {
      setTimeout(() => {
        setNotifications(prev => prev.filter(n => n.id !== notification.id));
      }, 2000);
    }
  };

  // Register an existing S3 bucket as an imported datastore now lives in the
  // unified Import center (ImportCenter → Existing S3 bucket tab).

  // Handle study row expansion
  const handleStudyExpand = async (study: ProcessedDicomStudy) => {
    const studyId = study.studyInstanceUID;
    const newExpandedStudies = new Set(expandedStudies);
    
    if (expandedStudies.has(studyId)) {
      // Collapse the study
      newExpandedStudies.delete(studyId);
      setExpandedStudies(newExpandedStudies);
    } else {
      // Expand the study and load series
      newExpandedStudies.add(studyId);
      setExpandedStudies(newExpandedStudies);
      
      if (!studySeriesMap.has(studyId)) {
        await loadSeriesForStudy(study);
      }
    }
  };

  // Handle series row expansion
  const handleSeriesExpand = async (study: ProcessedDicomStudy, series: ProcessedDicomSeries) => {
    const seriesId = `${study.studyInstanceUID}-${series.seriesInstanceUID}`;
    const newExpandedSeries = new Set(expandedSeries);
    
    if (expandedSeries.has(seriesId)) {
      // Collapse the series
      newExpandedSeries.delete(seriesId);
      setExpandedSeries(newExpandedSeries);
    } else {
      // Expand the series and load instances
      newExpandedSeries.add(seriesId);
      setExpandedSeries(newExpandedSeries);
      
      if (!seriesInstancesMap.has(seriesId)) {
        await loadInstancesForSeries(study, series);
      }
    }
  };

  // Load series for a study
  const loadSeriesForStudy = async (study: ProcessedDicomStudy) => {
    if (!selectedDatastore) return;
    const { pathId, storageType } = getDatastoreTarget(selectedDatastore);
    if (!pathId) return;

    try {
      const response = await dicomwebService.searchSeries(
        pathId,
        study.studyInstanceUID,
        {},
        selectedDatastore.id,
        storageType
      );

      if (response.success && response.data) {
        const newStudySeriesMap = new Map(studySeriesMap);
        newStudySeriesMap.set(study.studyInstanceUID, response.data);
        setStudySeriesMap(newStudySeriesMap);
        
        // Load first instance for each series for thumbnail purposes
        // Collect all instance loading promises to avoid race conditions
        const instanceLoadingPromises = response.data.map(async (series) => {
          const seriesId = `${study.studyInstanceUID}-${series.seriesInstanceUID}`;
          if (!seriesInstancesMap.has(seriesId)) {
            try {
              const instancesResponse = await dicomwebService.searchInstances(
                pathId,
                study.studyInstanceUID,
                series.seriesInstanceUID,
                {},
                selectedDatastore.id,
                storageType
              );

              if (instancesResponse.success && instancesResponse.data && instancesResponse.data.length > 0) {
                return { seriesId, instances: instancesResponse.data };
              }
            } catch (error) {
              console.warn(`Failed to load instances for series ${series.seriesInstanceUID} (for thumbnail):`, error);
            }
          }
          return null;
        });

        // Wait for all instance loading to complete
        const instanceResults = await Promise.all(instanceLoadingPromises);
        
        // Update the instances map with all results at once
        const newSeriesInstancesMap = new Map(seriesInstancesMap);
        instanceResults.forEach(result => {
          if (result) {
            newSeriesInstancesMap.set(result.seriesId, result.instances);
          }
        });
        
        // Only update state if we have new instances
        if (instanceResults.some(result => result !== null)) {
          setSeriesInstancesMap(newSeriesInstancesMap);
          console.log('✅ Loaded instances for', instanceResults.filter(r => r).length, 'series');
        }
      } else {
        addNotification('error', 'Failed to load series', response.error || response.message);
      }
    } catch (error) {
      console.error('Error loading series:', error.message);
      addNotification('error', 'Failed to load series', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  // Load instances for a series
  const loadInstancesForSeries = async (study: ProcessedDicomStudy, series: ProcessedDicomSeries) => {
    if (!selectedDatastore) return;
    const { pathId, storageType } = getDatastoreTarget(selectedDatastore);
    if (!pathId) return;

    try {
      const response = await dicomwebService.searchInstances(
        pathId,
        study.studyInstanceUID,
        series.seriesInstanceUID,
        {},
        selectedDatastore.id,
        storageType
      );

      if (response.success && response.data) {
        const seriesId = `${study.studyInstanceUID}-${series.seriesInstanceUID}`;
        const newSeriesInstancesMap = new Map(seriesInstancesMap);
        newSeriesInstancesMap.set(seriesId, response.data);
        setSeriesInstancesMap(newSeriesInstancesMap);
      } else {
        addNotification('error', 'Failed to load instances', response.error || response.message);
      }
    } catch (error) {
      console.error('Error loading instances:', error.message);
      addNotification('error', 'Failed to load instances', error instanceof Error ? error.message : 'Unknown error');
    }
  };

  const handleDatastoreChange = (selectedOption: any) => {
    // Resolve from the merged index list (storage + VF), falling back to datastores.
    const datastore = (indexes.length ? indexes : datastores).find(ds => ds.id === selectedOption.value);
    
    if (datastore && selectedDatastore && datastore.id === selectedDatastore.id) {
      // Same datastore re-selected — refresh studies
      loadStudies();
      return;
    }
    
    setSelectedDatastore(datastore || null);
    setCurrentPageIndex(1);
    setStudies([]);
    setTotalCount(0);
  };

  // Handle page size change
  const handlePageSizeChange = (newPageSize: number) => {
    setPageSize(newPageSize);
    setCurrentPageIndex(1); // Reset to first page when changing page size
  };

  // const formatFileSize = (bytes: number): string => {
  //   if (bytes === 0) return '0 Bytes';
  //   const k = 1024;
  //   const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  //   const i = Math.floor(Math.log(bytes) / Math.log(k));
  //   return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  // };

  const formatDate = (dateString: string): string => {
    if (!dateString) return 'Unknown';
    
    // Handle DICOM date format (YYYYMMDD)
    if (dateString.length === 8 && /^\d{8}$/.test(dateString)) {
      const year = dateString.substring(0, 4);
      const month = dateString.substring(4, 6);
      const day = dateString.substring(6, 8);
      return `${month}/${day}/${year}`;
    }
    
    // Handle ISO date format
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  };

  const formatPatientSex = (sex: string): string => {
    if (!sex) return 'Unknown';
    
    // DICOM standard values for Patient Sex (0010,0040)
    switch (sex.toUpperCase()) {
      case 'M':
        return 'Male';
      case 'F':
        return 'Female';
      case 'O':
        return 'Other';
      default:
        return sex; // Return as-is if not a standard value
    }
  };

  // Table configuration
  // Create expanded table data that includes only studies (series will be rendered as cards)
  // const createExpandedTableData = () => {
  //   const expandedData: any[] = [];
  //   
  //   studies.forEach(study => {
  //     // Add the study row
  //     expandedData.push({
  //       type: 'study',
  //       data: study,
  //       level: 0
  //     });
  //     
  //     // Add series cards row if study is expanded
  //     if (expandedStudies.has(study.studyInstanceUID)) {
  //       expandedData.push({
  //         type: 'series-cards',
  //         data: study,
  //         level: 1
  //       });
  //     }
  //   });
  //   
  //   return expandedData;
  // };

  // Render series cards for expanded studies
  // Get all unique modalities for a study from the study-level modalitiesInStudy array
  const getStudyModalities = (study: ProcessedDicomStudy): string[] => {
    // Use the modalitiesInStudy array from the study data (DICOM tag 00080061)
    return study.modalitiesInStudy || (study.modality ? [study.modality] : []);
  };

  // Render series as CloudScape Table for consistency
  const renderSeriesTable = (study: ProcessedDicomStudy) => {
    const series = studySeriesMap.get(study.studyInstanceUID) || [];
    
    if (series.length === 0) {
      return (
        <Box textAlign="center" color="inherit">
          <b>No series found</b>
          <Box padding={{ bottom: "s" }} variant="p" color="inherit">
            No series found for this study.
          </Box>
        </Box>
      );
    }

    // Create expanded data including instances when series are expanded
    const expandedSeriesData: any[] = [];
    
    series.forEach(seriesItem => {
      const seriesId = `${study.studyInstanceUID}-${seriesItem.seriesInstanceUID}`;
      const instances = seriesInstancesMap.get(seriesId) || [];
      const firstInstance = instances[0];
      const isExpanded = expandedSeries.has(seriesId);
      
      // Add the series row
      expandedSeriesData.push({
        type: 'series',
        data: seriesItem,
        seriesId,
        instances,
        firstInstance,
        studyInstanceUID: study.studyInstanceUID
      });
      
      // Add instance rows if expanded
      if (isExpanded && instances.length > 0) {
        instances.forEach(instance => {
          expandedSeriesData.push({
            type: 'instance',
            data: instance,
            seriesId,
            studyInstanceUID: study.studyInstanceUID,
            parentSeriesUID: seriesItem.seriesInstanceUID  // Add parent series UID
          });
        });
      }
    });

    return (
      <Table
        items={expandedSeriesData}
        columnDefinitions={[
          {
            id: 'select-expand',
            header: '',
            cell: (item: any) => {
              if (item.type === 'series') {
                const isSelected = selectedSeries.has(item.seriesId);
                const isExpanded = expandedSeries.has(item.seriesId);
                
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Checkbox
                      checked={isSelected}
                      onChange={({ detail }) => handleSeriesSelection(item.seriesId, detail.checked)}
                    />
                    {item.instances.length > 0 && (
                      <Button
                        variant="icon"
                        iconName={isExpanded ? "angle-down" : "angle-right"}
                        onClick={() => handleSeriesExpand(study, item.data)}
                        ariaLabel={isExpanded ? "Collapse instances" : "Expand instances"}
                      />
                    )}
                  </div>
                );
              } else if (item.type === 'instance') {
                return (
                  <div style={{ marginLeft: '24px' }}>
                    <Checkbox
                      checked={selectedInstances.has(item.data.sopInstanceUID)}
                      onChange={({ detail }) => handleInstanceSelection(item.data.sopInstanceUID, detail.checked)}
                    />
                  </div>
                );
              }
              return null;
            },
            width: 80
          },
          {
            id: 'thumbnail',
            header: 'View',
            cell: (item: any) => {
              const { pathId, storageType } = getDatastoreTarget(selectedDatastore);
              if (item.type === 'series' && item.firstInstance && pathId) {
                return (
                  <DicomThumbnail
                    datastoreId={pathId}
                    internalDatastoreId={selectedDatastore!.id}
                    storageType={storageType}
                    studyInstanceUID={item.studyInstanceUID}
                    seriesInstanceUID={item.data.seriesInstanceUID}
                    sopInstanceUID={item.firstInstance.sopInstanceUID}
                    theme={theme}
                  />
                );
              }
              return null;
            },
            width: 80
          },
          {
            id: 'description',
            header: 'Description',
            cell: (item: any) => {
              if (item.type === 'series') {
                return (
                  <span title={item.data.seriesDescription || 'No Description'}>
                    {item.data.seriesDescription || 'No Description'}
                  </span>
                );
              } else if (item.type === 'instance') {
                return (
                  <div style={{ marginLeft: '20px', fontSize: '13px', color: 'var(--color-muted-foreground)' }}>
                    Instance #{item.data.instanceNumber || 'N/A'}
                  </div>
                );
              }
              return null;
            },
            minWidth: 200
          },
          {
            id: 'modality',
            header: 'Modality',
            cell: (item: any) => {
              if (item.type === 'series') {
                return item.data.modality ? (
                  <ModalityBadge modality={item.data.modality} />
                ) : 'Unknown';
              }
              return null;
            },
            width: 100
          },
          {
            id: 'seriesNumber',
            header: 'Series #',
            cell: (item: any) => {
              if (item.type === 'series') {
                return item.data.seriesNumber || 'N/A';
              }
              return null;
            },
            width: 80
          },
          {
            id: 'instances',
            header: 'Instances',
            cell: (item: any) => {
              if (item.type === 'series') {
                return item.instances.length.toString();
              }
              return null;
            },
            width: 80
          },
          {
            id: 'date',
            header: 'Date',
            cell: (item: any) => {
              if (item.type === 'series') {
                return formatDate(item.data.seriesDate);
              }
              return null;
            },
            width: 100
          },
          {
            id: 'uid',
            header: 'UID',
            cell: (item: any) => {
              if (item.type === 'series') {
                return (
                  <span title={item.data.seriesInstanceUID}>
                    {item.data.seriesInstanceUID}
                  </span>
                );
              } else if (item.type === 'instance') {
                const { pathId } = getDatastoreTarget(selectedDatastore);
                // S3-only: served by this app's own /dicomweb origin.
                const dicomwebBase = `${window.location.origin}/dicomweb/${pathId}`;
                const dicomwebUrl = `${dicomwebBase}/studies/${item.studyInstanceUID}/series/${item.parentSeriesUID}/instances/${item.data.sopInstanceUID}`;

                return (
                  <SpaceBetween direction="horizontal" size="xs">
                    <span title={item.data.sopInstanceUID} style={{ fontSize: '12px', color: 'var(--color-muted-foreground)' }}>
                      {item.data.sopInstanceUID}
                    </span>
                    <Button
                      iconName="copy"
                      variant="inline-icon"
                      onClick={() => navigator.clipboard.writeText(dicomwebUrl)}
                      ariaLabel="Copy DICOMweb URL to clipboard"
                    />
                  </SpaceBetween>
                );
              }
              return null;
            },
            minWidth: 350
          }
        ]}
        variant="embedded"
        empty={
          <Box textAlign="center" color="inherit">
            <b>No series found</b>
            <Box padding={{ bottom: "s" }} variant="p" color="inherit">
              No series found for this study.
            </Box>
          </Box>
        }
      />
    );
  };

  return (
    <div style={{ 
      width: '100%', 
      maxWidth: '100vw',
      overflow: 'hidden',
      boxSizing: 'border-box'
    }}>
      <Flashbar items={notifications} />
      
      <>
      <SpaceBetween direction="vertical" size="l">
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {VIRTUAL_FOLDER_ENABLED && (selectedDatastore as any)?.indexKind !== 'vf-index' && (
                <Button 
                  onClick={() => setShowAssignModal(true)} 
                  disabled={selectedStudies.size === 0 || virtualFolders.length === 0}
                >
                  Assign to Virtual Folder ({selectedStudies.size})
                </Button>
              )}
              <Button
                onClick={() => {
                  if (selectedStudies.size === 1) {
                    const studyUID = Array.from(selectedStudies)[0];
                    const study = studies.find(s => s.studyInstanceUID === studyUID);
                    setUpdateMode('PATIENT_STUDY');
                    setUpdateStudyInstanceUID(studyUID);
                    setUpdateSeriesInstanceUID(undefined);
                    setUpdateCurrentValues({
                      PatientName: study?.patientName || '',
                      PatientID: study?.patientID || '',
                      PatientBirthDate: study?.patientBirthDate ? study.patientBirthDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '',
                      PatientSex: study?.patientSex || '',
                      IssuerOfPatientID: '',
                      StudyDate: study?.studyDate ? study.studyDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '',
                      StudyDescription: study?.studyDescription || '',
                      AccessionNumber: study?.accessionNumber || '',
                      ReferringPhysicianName: study?.referringPhysicianName || '',
                      StudyID: study?.studyID || '',
                    });
                    setShowUpdateModal(true);
                  } else if (selectedSeries.size > 0) {
                    const seriesKey = Array.from(selectedSeries)[0];
                    const parts = seriesKey.split('-');
                    const studyUID = parts.slice(0, -1).join('-');
                    const entries = Array.from(studySeriesMap.entries());
                    let foundSeries: any = null;
                    let foundStudyUID = '';
                    for (const [sUID, seriesList] of entries) {
                      const s = seriesList.find(sr => `${sUID}-${sr.seriesInstanceUID}` === seriesKey);
                      if (s) { foundSeries = s; foundStudyUID = sUID; break; }
                    }
                    if (foundSeries) {
                      setUpdateMode('SERIES');
                      setUpdateStudyInstanceUID(foundStudyUID);
                      setUpdateSeriesInstanceUID(foundSeries.seriesInstanceUID);
                      setUpdateCurrentValues({
                        SeriesNumber: foundSeries.seriesNumber?.toString() || '',
                        SeriesDescription: foundSeries.seriesDescription || '',
                        SeriesDate: foundSeries.seriesDate ? foundSeries.seriesDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : '',
                      });
                      setShowUpdateModal(true);
                    }
                  }
                }}
                disabled={
                  !selectedDatastore ||
                  !hasDatastoreAccess(selectedDatastore?.id || '', 'canUpdate') ||
                  (selectedStudies.size === 0 && selectedSeries.size === 0) ||
                  (selectedStudies.size > 0 && selectedSeries.size > 0) ||
                  selectedStudies.size > 1
                }
              >
                Edit Metadata
              </Button>
              <Button
                onClick={() => setShowDeleteConfirmModal(true)}
                disabled={deleteInProgress || (selectedStudies.size === 0 && selectedSeries.size === 0)}
                loading={deleteInProgress}
              >
                Delete ({selectedStudies.size + selectedSeries.size})
              </Button>
              {canRunJobs && (
                <Button
                  onClick={openJobModal}
                  disabled={!selectedDatastore || (selectedStudies.size === 0 && selectedSeries.size === 0)}
                >
                  Run Processing Job ({selectedStudies.size + selectedSeries.size})
                </Button>
              )}
              {NON_DICOM_V2_ENABLED && (
                <Button
                  disabled={!selectedDatastore || selectedStudies.size !== 1 || selectedSeries.size > 0}
                  onClick={() => {
                    if (!selectedDatastore || selectedStudies.size !== 1) return;
                    const studyUID = Array.from(selectedStudies)[0];
                    const st = studies.find(s => s.studyInstanceUID === studyUID);
                    if (!st) return;
                    const isVf = (selectedDatastore as any).indexKind === 'vf-index';
                    setAttachTarget({
                      kind: isVf ? 'virtualFolder' : 'datastore',
                      id: selectedDatastore.id,
                      name: selectedDatastore.name,
                      study: {
                        studyInstanceUID: st.studyInstanceUID,
                        patientId: st.patientID || '',
                        patientName: st.patientName || '',
                        birthDate: st.patientBirthDate || '',
                        sex: st.patientSex || '',
                        studyDescription: st.studyDescription || '',
                        studyDate: st.studyDate || '',
                        accessionNumber: st.accessionNumber || '',
                      },
                    });
                  }}
                >
                  Attach files
                </Button>
              )}
              <Button
                variant="primary"
                iconName="upload"
                onClick={() => {
                  // Deep-link to the unified Import center. Preselect the current
                  // index ONLY when it is a storage datastore — a VF index has no
                  // bucket to upload into, so it must never be an upload target.
                  const ds = selectedDatastore as (Datastore & { indexKind?: string }) | null;
                  const preselectId = ds && (ds as any).indexKind !== 'vf-index' ? ds.id : undefined;
                  onNavigateToImport?.(preselectId);
                }}
              >
                Import data
              </Button>
              </SpaceBetween>
          }
        >
          DICOM Studies {selectedDatastore ? `- ${selectedDatastore.name}` : ''} ({totalCount})
        </Header>
        <SpaceBetween size="l">
          {/* Datastore Selection - moved above filters for consistency */}
          <FormField
            label="Select Storage"
            description="Choose a storage location to browse DICOM studies using its DICOMweb API"
          >
            <SpaceBetween direction="horizontal" size="xs">
            <Select
                selectedOption={
                  selectedDatastore 
                    ? { label: `${selectedDatastore.name} (${selectedDatastore.id})`, value: selectedDatastore.id }
                    : null
                }
                onChange={({ detail }) => handleDatastoreChange(detail.selectedOption)}
                options={(indexes.length ? indexes : datastores.map(ds => ({ ...ds, indexKind: 'storage-index' as const }))).map(ix => ({
                  label: `${ix.name} (${ix.id})`,
                  value: ix.id,
                  description: ix.indexKind === 'vf-index'
                    ? 'VF index · rule-based multi-storage'
                    : 'Storage index · single datastore',
                  tags: [
                    ix.indexKind === 'vf-index' ? 'vf-index' : 'storage-index',
                    ...(((ix as any).imported === true || (ix as any).imported === 1) ? ['imported'] : []),
                  ],
                }))}
                placeholder="Select an index (storage or virtual) to view studies"
                empty="No active indexes available"
                disabled={datastoresLoading}
                statusType={datastoresLoading ? 'loading' : 'finished'}
                loadingText="Loading storage and virtual folder indexes..."
              />
              {datastoresLoading && (
                <Box padding={{ top: 'xxs' }}>
                  <SpaceBetween direction="horizontal" size="xs">
                    <Spinner size="normal" />
                    <Box variant="span" color="text-status-info">Loading indexes…</Box>
                  </SpaceBetween>
                </Box>
              )}
              {pendingOpsCount > 0 && (
                <Badge color="blue">{pendingOpsCount} pending operation{pendingOpsCount !== 1 ? 's' : ''}</Badge>
              )}
            </SpaceBetween>
            </FormField>

            {/* Filters */}
            {selectedDatastore && (
              <ExpandableSection headerText="DICOMweb Search Filters" defaultExpanded={true}>
                <SpaceBetween size="s">
                  <ColumnLayout columns={4}>
                    <FormField label="Patient ID" description="Exact match search">
                      <Input
                        value={patientIdInput}
                        onChange={({ detail }) => setPatientIdInput(detail.value)}
                        placeholder="Enter Patient ID"
                      />
                    </FormField>
                    <FormField label="Patient Name" description="Wildcard search supported">
                      <Input
                        value={patientNameInput}
                        onChange={({ detail }) => setPatientNameInput(detail.value)}
                        placeholder="Enter Patient Name"
                      />
                    </FormField>
                    <FormField label="Patient Gender" description="Filter by patient gender">
                      <Select
                        selectedOption={{ 
                          label: patientSexInput ? formatPatientSex(patientSexInput) : 'All Genders', 
                          value: patientSexInput 
                        }}
                        onChange={({ detail }) => setPatientSexInput(detail.selectedOption.value || '')}
                        options={[
                          { label: 'All Genders', value: '' },
                          { label: 'Male', value: 'M' },
                          { label: 'Female', value: 'F' },
                          { label: 'Other', value: 'O' }
                        ]}
                      />
                    </FormField>
                    <FormField label="Patient Birth Date" description="Filter by birth date">
                      <DatePicker
                        value={patientBirthDateInput}
                        onChange={({ detail }) => {
                          setPatientBirthDateInput(detail.value);
                          // Clear touched state when user starts typing again
                          if (birthDateTouched) setBirthDateTouched(false);
                        }}
                        onBlur={() => {
                          setBirthDateTouched(true);
                          if (patientBirthDateInput && !isValidDateFormat(patientBirthDateInput)) {
                            addNotification('error', 'Invalid Birth Date', 'Please enter a valid date in YYYY-MM-DD format');
                          }
                        }}
                        placeholder="YYYY-MM-DD"
                      />
                    </FormField>
                  </ColumnLayout>
                  <ColumnLayout columns={4}>
                    <FormField label="Accession Number" description="Exact match search">
                      <Input
                        value={accessionNumberInput}
                        onChange={({ detail }) => setAccessionNumberInput(detail.value)}
                        placeholder="Enter Accession Number"
                      />
                    </FormField>
                    <FormField label="Study Description" description="Wildcard search supported">
                      <Input
                        value={studyDescriptionInput}
                        onChange={({ detail }) => setStudyDescriptionInput(detail.value)}
                        placeholder="Enter Study Description"
                      />
                    </FormField>
                    <FormField label="Modality" description="Filter by imaging modality">
                      <Select
                        selectedOption={{ label: modalityInput || 'All Modalities', value: modalityInput }}
                        onChange={({ detail }) => setModalityInput(detail.selectedOption.value || '')}
                        options={getModalityOptions()}
                      />
                    </FormField>
                    <FormField label="Study Date" description="DICOM format: YYYYMMDD">
                      <DatePicker
                        value={studyDateInput}
                        onChange={({ detail }) => {
                          setStudyDateInput(detail.value);
                          // Clear touched state when user starts typing again
                          if (studyDateTouched) setStudyDateTouched(false);
                        }}
                        onBlur={() => {
                          setStudyDateTouched(true);
                          if (studyDateInput && !isValidDateFormat(studyDateInput)) {
                            addNotification('error', 'Invalid Study Date', 'Please enter a valid date in YYYY-MM-DD format');
                          }
                        }}
                        placeholder="YYYY-MM-DD"
                      />
                    </FormField>
                  </ColumnLayout>
                  <Box margin={{ top: 'l' }}>
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button variant="primary" onClick={handleSearch} disabled={loading}>
                        Search
                      </Button>
                      {(patientIdFilter || patientNameFilter || studyDescriptionFilter || accessionNumberFilter || studyDateFilter || 
                        patientBirthDateFilter || patientSexFilter || modalityFilter) && (
                        <Button onClick={handleClearFilters} disabled={loading}>
                          Clear
                        </Button>
                      )}
                      <Button onClick={handleResetAllFilters} disabled={loading}>
                        Reset All Filters
                      </Button>
                      <Button
                        onClick={loadStudies}
                        iconName="refresh"
                        disabled={!selectedDatastore || loading}
                      >
                        Refresh
                      </Button>
                    </SpaceBetween>
                  </Box>
                </SpaceBetween>
              </ExpandableSection>
            )}

            {/* Custom HTML Table with colspan support */}
            {selectedDatastore ? (
              <Container>
                {/* Pagination Controls - Moved to top right */}
                {studies.length > 0 && (
                  <Box margin={{ bottom: "s" }}>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '16px' }}>
                      <FormField label="Page size">
                        <Select
                          selectedOption={{ label: pageSize.toString(), value: pageSize.toString() }}
                          onChange={({ detail }) => handlePageSizeChange(parseInt(detail.selectedOption?.value || '20'))}
                          options={[
                            { label: '10', value: '10' },
                            { label: '20', value: '20' },
                            { label: '50', value: '50' },
                            { label: '100', value: '100' }
                          ]}
                        />
                      </FormField>
                      <Pagination
                        currentPageIndex={currentPageIndex}
                        pagesCount={Math.ceil(totalCount / pageSize)}
                        onChange={({ detail }) => setCurrentPageIndex(detail.currentPageIndex)}
                        ariaLabels={{
                          nextPageLabel: "Next page",
                          previousPageLabel: "Previous page",
                          pageLabel: (pageNumber) => `Page ${pageNumber} of all pages`
                        }}
                      />
                    </div>
                  </Box>
                )}
                
                <div
                  data-theme={theme}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    overflowX: 'auto',
                    overflowY: 'hidden',
                    border: '1px solid var(--color-border)',
                    borderRadius: 10,
                  }}
                >
                  <table className="cloudscape-table" style={{
                    width: '100%',
                    minWidth: 1000,
                    tableLayout: 'fixed'
                  }}>
                  {/* Table Header */}
                  <thead className="cloudscape-table-header">
                    <tr>
                      <th style={{ width: 72 }}>
                        {/* No header text */}
                      </th>
                      <th>
                        Patient Name
                      </th>
                      <th style={{ width: 120 }}>
                        Patient ID
                      </th>
                      <th style={{ width: 100 }}>
                        Birth Date
                      </th>
                      <th style={{ width: 80 }}>
                        Gender
                      </th>
                      <th style={{ width: 104 }}>
                        Accession #
                      </th>
                      <th>
                        Description
                      </th>
                      <th style={{ width: 100 }}>
                        Study Date
                      </th>
                      <th style={{ width: 104 }}>
                        Modality
                      </th>
                      <th style={{ width: 68 }}>
                        Series
                      </th>
                      <th style={{ width: 88 }}>
                        Instances
                      </th>
                    </tr>
                    {/* Refresh after an action keeps the rows; a thin bar shows progress. */}
                    {loading && studies.length > 0 && (
                      <tr aria-hidden="true"><th colSpan={11} style={{ padding: 0 }}><div className="ui-refresh-bar" /></th></tr>
                    )}
                  </thead>

                  {/* Table Body */}
                  <tbody>
                    {loading && studies.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="cloudscape-table-loading">
                          Loading DICOM studies from the DICOMweb API...
                        </td>
                      </tr>
                    ) : studies.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="cloudscape-table-empty">
                          <strong>No DICOM studies</strong>
                          <br />
                          No studies found. Try adjusting your search filters or select a different storage location.
                        </td>
                      </tr>
                    ) : (
                      studies.map((study, index) => (
                        <React.Fragment key={study.studyInstanceUID}>
                          {/* Study Row */}
                          <tr className="cloudscape-table-row">
                            <td className="cloudscape-table-cell cloudscape-table-cell-nowrap">
                              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <Checkbox
                                  checked={selectedStudies.has(study.studyInstanceUID)}
                                  onChange={({ detail }) => handleStudySelection(study.studyInstanceUID, detail.checked)}
                                />
                                <Button
                                  variant="icon"
                                  iconName="multiscreen"
                                  onClick={async () => {
                                    try {
                                      const session = await fetchAuthSession();
                                      const token = session.tokens?.accessToken?.toString() || '';
                                      const config = (window as any).REACT_APP_CONFIG || {};
                                      const ohifBaseUrl = config.OHIF_VIEWER_URL || '';
                                      // The path segment is the OHIF data source name, which the
                                      // config generator keys the same way this app does: the
                                      // internal id for S3.
                                      const { pathId } = getDatastoreTarget(selectedDatastore);
                                      // Security: only a real DICOM UID may reach the viewer URL.
                                      if (!/^[0-9]+(\.[0-9]+)*$/.test(study.studyInstanceUID || '') || study.studyInstanceUID.length > 64) {
                                        addNotification('error', 'Failed to open viewer', 'Invalid Study Instance UID');
                                        return;
                                      }
                                      // Token in the URL fragment, not the query: a fragment is never sent in a
                                      // request, so it stays out of access logs and Referer headers.
                                      const ohifUrl = `${ohifBaseUrl}/viewer/${encodeURIComponent(pathId)}?StudyInstanceUIDs=${encodeURIComponent(study.studyInstanceUID)}#token=${encodeURIComponent(token)}`;
                                      window.open(ohifUrl, '_blank');
                                    } catch (error) {
                                      console.error('Failed to get access token:', error.message);
                                      addNotification('error', 'Failed to open viewer', 'Could not retrieve authentication token');
                                    }
                                  }}
                                  ariaLabel="View in OHIF"
                                />
                                <Button
                                  variant="icon"
                                  iconName={expandedStudies.has(study.studyInstanceUID) ? 'angle-down' : 'angle-right'}
                                  onClick={() => handleStudyExpand(study)}
                                  ariaLabel={expandedStudies.has(study.studyInstanceUID) ? 'Collapse study' : 'Expand study'}
                                />
                              </div>
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-ellipsis">
                              <span title={study.patientName || 'Unknown Patient'}>
                                {study.patientName || 'Unknown Patient'}
                              </span>
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-ellipsis">
                              <span title={study.patientID || 'N/A'}>{study.patientID || 'N/A'}</span>
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-nowrap">
                              {formatDate(study.patientBirthDate)}
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-nowrap">
                              {formatPatientSex(study.patientSex)}
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-ellipsis">
                              <span title={study.accessionNumber || 'N/A'}>
                                {study.accessionNumber || 'N/A'}
                              </span>
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-ellipsis">
                              <span title={study.studyDescription || 'No description'}>
                                {study.studyDescription || 'No description'}
                              </span>
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-nowrap">
                              {formatDate(study.studyDate)}
                            </td>
                            <td className="cloudscape-table-cell">
                              {(() => {
                                const modalities = getStudyModalities(study);
                                return <ModalityBadges modalities={modalities} />;
                              })()}
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-nowrap cloudscape-table-cell-center">
                              {study.numberOfStudyRelatedSeries?.toString() || '0'}
                            </td>
                            <td className="cloudscape-table-cell cloudscape-table-cell-nowrap cloudscape-table-cell-center">
                              {study.numberOfStudyRelatedInstances?.toString() || '0'}
                            </td>
                          </tr>
                          
                          {/* Series Row - SPANS ALL COLUMNS */}
                          {expandedStudies.has(study.studyInstanceUID) && (
                            <tr>
                              <td colSpan={11} className="cloudscape-table-cell" style={{ 
                                padding: '12px',
                                backgroundColor: 'transparent'
                              }}>
                                {/* Constrained container for series */}
                                <div style={{ 
                                  width: '100%',
                                  maxWidth: '100%',
                                  overflow: 'hidden'
                                }}>
                                  {renderSeriesTable(study)}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Container>
            ) : (
              <Box textAlign="center" color="inherit">
                <b>Select a storage location</b>
                <Box padding={{ bottom: "s" }} variant="p" color="inherit">
                Please select a storage location from the dropdown above to view DICOM studies.
              </Box>
            </Box>
          )}
        </SpaceBetween>
      </SpaceBetween>
      </>

      {/* Virtual Folder Assignment Modal */}
      <Modal
        visible={showAssignModal}
        onDismiss={() => setShowAssignModal(false)}
        header="Assign Studies to Virtual Folder"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setShowAssignModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleAssignToVirtualFolder} loading={assigning} disabled={!selectedVirtualFolder}>
                Assign {selectedStudies.size} Study(ies)
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box>
            You are about to assign <strong>{selectedStudies.size}</strong> study(ies) to a virtual datastore.
            {selectedStudies.size > 0 && (
              <Box margin={{ top: 's' }} color="text-status-inactive">
                Selected studies: {Array.from(selectedStudies).slice(0, 3).join(', ')}{selectedStudies.size > 3 ? ` and ${selectedStudies.size - 3} more...` : ''}
              </Box>
            )}
          </Box>
          <FormField label="Select Virtual Folder">
            <Select
              selectedOption={selectedVirtualFolder ? { label: selectedVirtualFolder.name, value: selectedVirtualFolder.id } : null}
              onChange={({ detail }) => {
                const vds = virtualFolders.find(v => v.id === detail.selectedOption?.value);
                setSelectedVirtualFolder(vds || null);
              }}
              options={virtualFolders.map(vds => ({ label: vds.name, value: vds.id }))}
              placeholder="Select a virtual datastore"
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteConfirmModal}
        onDismiss={() => setShowDeleteConfirmModal(false)}
        header="Confirm Deletion"
        footer={
          <Box float="right">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="link" onClick={() => setShowDeleteConfirmModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleDeleteSelected} loading={deleteInProgress}>Delete</Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="s">
          <Box variant="p">
            <strong>Warning:</strong> This action is permanent and cannot be undone. The selected DICOM data will be permanently deleted from S3 storage.
          </Box>
          {selectedStudies.size > 0 && (
            <Box variant="p">{selectedStudies.size} study(ies) selected — all series within each study will be deleted.</Box>
          )}
          {selectedSeries.size > 0 && (
            <Box variant="p">{selectedSeries.size} individual series selected for deletion.</Box>
          )}
        </SpaceBetween>
      </Modal>

      {/* Update Metadata Modal */}
      <UpdateMetadataModal
        visible={showUpdateModal}
        onDismiss={() => setShowUpdateModal(false)}
        mode={updateMode}
        datastoreId={selectedDatastore?.id || ''}
        studyInstanceUID={updateStudyInstanceUID}
        seriesInstanceUID={updateSeriesInstanceUID}
        currentValues={updateCurrentValues}
        onSubmitSuccess={() => {
          addNotification('success', 'Update Queued', 'Metadata update has been submitted for processing.');
          setSelectedStudies(new Set());
          setSelectedSeries(new Set());
          fetchPendingOps();
        }}
      />

      {/* Processing Job Modal */}
      <ProcessingJobModal
        visible={showJobModal}
        onDismiss={() => setShowJobModal(false)}
        target={jobTarget}
        targetSummary={`${selectedStudies.size} study(ies) and ${selectedSeries.size} series selected`}
        onStarted={message => addNotification('success', 'Processing Job Started', message)}
      />

      {/* Non-DICOM Import V2: Attach files to the selected study */}
      <Modal
        visible={!!attachTarget}
        onDismiss={() => setAttachTarget(null)}
        size="max"
        header={attachTarget ? `Attach files - ${attachTarget.name}` : 'Attach files'}
        closeAriaLabel="Close attach files"
      >
        {attachTarget && (
          <NonDicomImportV2
            key={`${attachTarget.kind}:${attachTarget.id}:${attachTarget.study.studyInstanceUID}`}
            fixedDestination={{ kind: attachTarget.kind, id: attachTarget.id, name: attachTarget.name }}
            fixedStudy={attachTarget.study}
            onClose={() => setAttachTarget(null)}
          />
        )}
      </Modal>
    </div>
  );
};

export default DicomStudiesManagement;
