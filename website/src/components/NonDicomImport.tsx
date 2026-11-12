import React, { useState, useEffect, useCallback, useRef } from 'react';
import { formatTimestamp } from '../utils/dateUtils';
import {
  Container, Header, Table, Box, SpaceBetween, Button,
  FormField, Input, Select, StatusIndicator, Alert,
  ColumnLayout, DatePicker, Badge, ExpandableSection, Grid, Flashbar, Pagination, CollectionPreferences
} from '@cloudscape-design/components';
import { ModalityBadge, ModalityBadges } from './ModalityBadge';
import { datastoreService } from '../services';
import { Datastore } from '../types';
import { dicomwebService, ProcessedDicomStudy, getDatastoreTarget } from '../services/dicomwebService';
import { amplifyAuthService } from '../services/amplifyAuthService';

const config = (window as any).REACT_APP_CONFIG || {};
const API_BASE_URL = config.API_BASE_URL || '';

interface NonDicomJob { id: string; datastore_id: string; datastore_name?: string; status: string; status_description?: string; created_at: string; created_by?: string; }
interface FileEntry { file: File; thumbnail?: string; contentType: string; videoWidth?: number; videoHeight?: number; videoDuration?: number; }
interface SeriesRow { id: string; description: string; modality?: string; isNew: boolean; seriesInstanceUID?: string; assignedFiles: number[]; sopClassUID?: string; _type: 'series'; seriesNumber: number; }
interface StudyRow { _type: 'study'; id: string; patientName: string; patientID: string; studyDate: string; studyDescription: string; accessionNumber: string; series: SeriesRow[]; expanded: boolean; }
type TargetMode = 'none' | 'copyPatient' | 'existingStudy' | 'newAll';

const MODALITY_FOR_TYPE: Record<string, string> = { 'application/pdf': 'DOC', 'image/jpeg': 'SC', 'image/png': 'SC', 'video/mp4': 'XC', 'video/mpeg': 'XC', 'video/quicktime': 'XC' };
const SOP_CLASS_FOR_TYPE: Record<string, string> = { 'application/pdf': '1.2.840.10008.5.1.4.1.1.104.1', 'image/jpeg': '1.2.840.10008.5.1.4.1.1.7', 'image/png': '1.2.840.10008.5.1.4.1.1.7', 'video/mp4': '1.2.840.10008.5.1.4.1.1.77.1.4.1', 'video/mpeg': '1.2.840.10008.5.1.4.1.1.77.1.4.1', 'video/quicktime': '1.2.840.10008.5.1.4.1.1.77.1.4.1' };
const ASSIGNABLE_MODALITIES = new Set(['SC', 'DOC']);
const ACCEPTED_TYPES = Object.keys(MODALITY_FOR_TYPE);
const SERIES_COLORS = ['#0972d3', '#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6550d', '#a6761d'];
const MODALITY_ACCEPTS: Record<string, string[]> = { SC: ['image/jpeg', 'image/png'], DOC: ['application/pdf'], XC: ['video/mp4', 'video/mpeg', 'video/quicktime'] };

async function apiRequest(endpoint: string, options: RequestInit = {}) {
  const token = await amplifyAuthService.getToken();
  const res = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
  return res.json();
}

function generateImageThumbnail(file: File): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file); const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); const s = Math.min(120/img.width,120/img.height,1); c.width=img.width*s; c.height=img.height*s; c.getContext('2d')!.drawImage(img,0,0,c.width,c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg',0.7)); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); }; img.src = url;
  });
}
function generateVideoThumbnailAndMeta(file: File): Promise<{ thumbnail: string; videoWidth: number; videoHeight: number; videoDuration: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file); const v = document.createElement('video'); v.muted=true; v.preload='auto';
    v.onloadeddata = () => { v.currentTime=0.1; };
    v.onseeked = () => { const c = document.createElement('canvas'); const s = Math.min(120/v.videoWidth,120/v.videoHeight,1); c.width=v.videoWidth*s; c.height=v.videoHeight*s; c.getContext('2d')!.drawImage(v,0,0,c.width,c.height); URL.revokeObjectURL(url); resolve({ thumbnail: c.toDataURL('image/jpeg',0.7), videoWidth: v.videoWidth, videoHeight: v.videoHeight, videoDuration: v.duration }); };
    v.onerror = () => { URL.revokeObjectURL(url); resolve({ thumbnail: '', videoWidth: 0, videoHeight: 0, videoDuration: 0 }); }; v.src = url;
  });
}
async function generatePdfThumbnail(file: File): Promise<string> {
  try { const pdfjsLib = await import('pdfjs-dist'); pdfjsLib.GlobalWorkerOptions.workerSrc=`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`; const d=await file.arrayBuffer(); const pdf=await pdfjsLib.getDocument({data:d}).promise; const pg=await pdf.getPage(1); const vp=pg.getViewport({scale:0.3}); const c=document.createElement('canvas'); c.width=vp.width; c.height=vp.height; await pg.render({canvasContext:c.getContext('2d')!,viewport:vp}).promise; return c.toDataURL('image/jpeg',0.7); } catch { return ''; }
}
async function generateThumbnail(file: File): Promise<string | { thumbnail: string; videoWidth: number; videoHeight: number; videoDuration: number }> {
  if (file.type.startsWith('image/')) return generateImageThumbnail(file);
  if (file.type.startsWith('video/')) return generateVideoThumbnailAndMeta(file);
  if (file.type === 'application/pdf') return generatePdfThumbnail(file);
  return '';
}

const cardStyle: React.CSSProperties = { width: 120, display: 'inline-block', verticalAlign: 'top', margin: 4, position: 'relative', cursor: 'pointer' };
const thumbStyle: React.CSSProperties = { width: 120, height: 120, objectFit: 'cover', borderRadius: 4, border: '1px solid #d5dbdb', display: 'block' };
const noThumbStyle: React.CSSProperties = { ...thumbStyle, objectFit: undefined, background: '#f2f3f3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#687078' };
const checkStyle: React.CSSProperties = { position: 'absolute', top: 4, left: 4, zIndex: 1 };
const removeStyle: React.CSSProperties = { position: 'absolute', top: 2, right: 2, zIndex: 1, background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', borderRadius: '50%', width: 20, height: 20, cursor: 'pointer', fontSize: 12, lineHeight: '18px', textAlign: 'center', padding: 0 };
const nameStyle: React.CSSProperties = { fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: 120, marginTop: 2 };
const dotStyle = (color: string): React.CSSProperties => ({ width: 12, height: 12, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 });

const NonDicomImport: React.FC = () => {
  // Jobs
  const [jobs, setJobs] = useState<NonDicomJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsExpanded, setJobsExpanded] = useState(false);
  const [jobsPageSize, setJobsPageSize] = useState(10);
  const [jobsPageIndex, setJobsPageIndex] = useState(1);
  const [jobsTotalCount, setJobsTotalCount] = useState(0);
  const refreshTimer = useRef<NodeJS.Timeout | null>(null);

  // Datastores
  const [datastores, setDatastores] = useState<Datastore[]>([]);
  const [selectedDatastore, setSelectedDatastore] = useState<Datastore | null>(null);

  // Search filter inputs
  const [searchPatientIDInput, setSearchPatientIDInput] = useState('');
  const [searchPatientNameInput, setSearchPatientNameInput] = useState('');
  const [searchAccessionInput, setSearchAccessionInput] = useState('');

  // Search results + pagination
  const [searchResults, setSearchResults] = useState<ProcessedDicomStudy[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [studyPageIndex, setStudyPageIndex] = useState(1);
  const STUDY_PAGE_SIZE = 10;

  // Selected study + target mode
  const [selectedSearchStudy, setSelectedSearchStudy] = useState<ProcessedDicomStudy | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>('none');

  // New patient/study fields
  const [newPatientID, setNewPatientID] = useState('');
  const [newPatientName, setNewPatientName] = useState('');
  const [newPatientBirthDate, setNewPatientBirthDate] = useState('');
  const [newPatientSex, setNewPatientSex] = useState('');
  const [newStudyDescription, setNewStudyDescription] = useState('');
  const [newStudyDate, setNewStudyDate] = useState('');
  const [newStudyTime, setNewStudyTime] = useState('');
  const [newAccessionNumber, setNewAccessionNumber] = useState('');

  // Series + files
  const [seriesRows, setSeriesRows] = useState<SeriesRow[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string | null>(null);
  const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  // Warn user if navigating away during upload
  useEffect(() => {
    if (!submitting) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [submitting]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const nowDate = () => new Date().toISOString().slice(0, 10);
  const dicomDateToISO = (d: string) => d && d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : d;
  const nowTime = () => { const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };

  const addNotification = (type: string, header: string, content?: string) => {
    const id = `${Date.now()}`;
    setNotifications(prev => [...prev, { type, header, content, id, dismissible: true, onDismiss: () => setNotifications(p => p.filter(n => n.id !== id)) }]);
  };

  // ========== Jobs ==========
  const loadJobs = useCallback(async () => {
    try { const r = await apiRequest(`/non-dicom-import?pageSize=${jobsPageSize}&offset=${(jobsPageIndex - 1) * jobsPageSize}`); if (r.success) { setJobs(r.data?.items || []); setJobsTotalCount(r.data?.totalCount || 0); } } catch (e) { console.error(e); } finally { setJobsLoading(false); }
  }, [jobsPageSize, jobsPageIndex]);
  useEffect(() => { loadJobs(); refreshTimer.current = setInterval(loadJobs, 10000); return () => { if (refreshTimer.current) clearInterval(refreshTimer.current); }; }, [loadJobs]);

  // ========== Datastores ==========
  const loadDatastores = useCallback(async () => {
    try { const d = await datastoreService.getAll({ pageSize: 100 }); setDatastores(d.items || []); } catch (e) { console.error('Failed to load datastores:', e); }
  }, []);
  useEffect(() => { loadDatastores(); }, [loadDatastores]);

  // ========== Search ==========
  const doSearch = useCallback(async () => {
    if (!selectedDatastore) return;
    setSearchLoading(true);
    try {
      const params: any = { limit: 10 };
      if (searchPatientIDInput.trim()) params.PatientID = `*${searchPatientIDInput.trim()}*`;
      if (searchPatientNameInput.trim()) params.PatientName = `*${searchPatientNameInput.trim()}*`;
      if (searchAccessionInput.trim()) params.AccessionNumber = searchAccessionInput.trim();
      const { pathId, storageType } = getDatastoreTarget(selectedDatastore);
      const r = await dicomwebService.searchStudies(pathId, params, selectedDatastore.id, storageType || 'S3');
      if (r.success && r.data) setSearchResults(r.data);
      else setSearchResults([]);
      setStudyPageIndex(1);
    } catch (e) { console.error(e); } finally { setSearchLoading(false); }
  }, [selectedDatastore, searchPatientIDInput, searchPatientNameInput, searchAccessionInput]);

  // Auto-load first 10 studies when datastore changes
  useEffect(() => {
    if (selectedDatastore) {
      setSearchResults([]);
      setSelectedSearchStudy(null);
      setTargetMode('none');
      setSeriesRows([]);
      doSearch();
    }
  }, [selectedDatastore]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => { doSearch(); };
  const handleClearFilters = () => {
    setSearchPatientIDInput(''); setSearchPatientNameInput(''); setSearchAccessionInput('');
  };

  // ========== Target mode actions ==========
  const handleCopyPatient = () => {
    if (!selectedSearchStudy) return;
    setTargetMode('copyPatient');
    setNewPatientID(selectedSearchStudy.patientID);
    setNewPatientName(selectedSearchStudy.patientName);
    setNewPatientBirthDate(dicomDateToISO(selectedSearchStudy.patientBirthDate || ''));
    setNewPatientSex(selectedSearchStudy.patientSex || '');
    setNewStudyDescription(''); setNewStudyDate(nowDate()); setNewStudyTime(nowTime()); setNewAccessionNumber('');
    setSeriesRows([]);
  };

  const handleAddToStudy = async () => {
    if (!selectedSearchStudy || !selectedDatastore) return;
    setTargetMode('existingStudy');
    const { pathId, storageType } = getDatastoreTarget(selectedDatastore);
    const r = await dicomwebService.searchSeries(pathId, selectedSearchStudy.studyInstanceUID, {}, selectedDatastore.id, storageType || 'S3');
    const existing = r.success && r.data ? r.data : [];
    setSeriesRows(existing.map(s => ({ _type: 'series' as const, id: s.seriesInstanceUID, description: s.seriesDescription || `Series ${s.seriesNumber}`, modality: s.modality, isNew: false, seriesInstanceUID: s.seriesInstanceUID, assignedFiles: [], sopClassUID: undefined, seriesNumber: s.seriesNumber || 0 })));
  };

  const handleNewAll = () => {
    setTargetMode('newAll');
    setSelectedSearchStudy(null);
    setNewPatientID(''); setNewPatientName(''); setNewPatientBirthDate(''); setNewPatientSex('');
    setNewStudyDescription(''); setNewStudyDate(nowDate()); setNewStudyTime(nowTime()); setNewAccessionNumber('');
    setSeriesRows([]);
  };

  // ========== Series ==========
  const addNewSeries = () => {
    const id = `new-${Date.now()}`;
    const maxNum = seriesRows.reduce((max, s) => Math.max(max, s.seriesNumber || 0), 0);
    setSeriesRows(prev => [...prev, { _type: 'series', id, description: '', modality: undefined, isNew: true, assignedFiles: [], sopClassUID: undefined, seriesNumber: maxNum + 1 }]);
    setSelectedSeriesId(id);
  };

  const assignFilesToSeries = () => {
    if (!selectedSeriesId || selectedFiles.size === 0) return;
    const target = seriesRows.find(s => s.id === selectedSeriesId);
    if (!target) return;

    // Block assignment to non-SC/DOC modality series
    if (target.modality && !ASSIGNABLE_MODALITIES.has(target.modality)) {
      addNotification('error', 'Cannot assign files', `Series with modality ${target.modality} does not accept non-DICOM files`);
      return;
    }

    // Determine SOP Class UID of files being assigned
    const fileSopClass = SOP_CLASS_FOR_TYPE[fileEntries[Array.from(selectedFiles)[0]]?.contentType];

    // Check SOP Class UID compatibility with existing series
    if (target.sopClassUID && fileSopClass && target.sopClassUID !== fileSopClass) {
      addNotification('error', 'SOP Class mismatch', 'Files must produce the same SOP Class UID as existing instances in this series');
      return;
    }

    // Check all selected files have same SOP Class
    const allSame = Array.from(selectedFiles).every(fi => SOP_CLASS_FOR_TYPE[fileEntries[fi]?.contentType] === fileSopClass);
    if (!allSame) {
      addNotification('error', 'Mixed file types', 'All selected files must produce the same SOP Class UID');
      return;
    }

    const mod = target.modality || MODALITY_FOR_TYPE[fileEntries[Array.from(selectedFiles)[0]]?.contentType];
    const effectiveMod = mod;

    if (effectiveMod) {
      const allowed = MODALITY_ACCEPTS[effectiveMod];
      if (allowed) {
        const bad = Array.from(selectedFiles).filter(fi => !allowed.includes(fileEntries[fi]?.contentType));
        if (bad.length > 0) {
          addNotification('error', 'Modality mismatch', `${effectiveMod} series only accepts ${allowed.map(t => t.split('/')[1]).join(', ')} files`);
          return;
        }
      }
    }

    setSeriesRows(prev => {
      const cleaned = prev.map(s => ({ ...s, assignedFiles: s.assignedFiles.filter(f => !selectedFiles.has(f)) }));
      return cleaned.map(s => {
        if (s.id !== selectedSeriesId) return s;
        const updated = { ...s, assignedFiles: [...s.assignedFiles, ...Array.from(selectedFiles)] };
        if (s.isNew && !s.modality && effectiveMod) updated.modality = effectiveMod;
        if (!s.sopClassUID && fileSopClass) updated.sopClassUID = fileSopClass;
        return updated;
      });
    });
    setSelectedFiles(new Set());
  };

  const removeSeriesRow = (id: string) => {
    setSeriesRows(prev => prev.filter(s => s.id !== id));
    if (selectedSeriesId === id) setSelectedSeriesId(null);
  };

  // ========== Color helpers ==========
  const fileColorMap = new Map<number, string>();
  const seriesColorMap = new Map<string, string>();
  let colorIdx = 0;
  seriesRows.forEach((s) => {
    const assignable = !s.modality || ASSIGNABLE_MODALITIES.has(s.modality);
    if (assignable) {
      const color = SERIES_COLORS[colorIdx % SERIES_COLORS.length];
      seriesColorMap.set(s.id, color);
      s.assignedFiles.forEach(fi => fileColorMap.set(fi, color));
      colorIdx++;
    }
  });

  // ========== Files ==========
  const handleFilesSelected = async (files: File[]) => {
    const valid = files.filter(f => ACCEPTED_TYPES.includes(f.type));
    const entries: FileEntry[] = [];
    for (const file of valid) {
      const result = await generateThumbnail(file);
      if (typeof result === 'object') {
        entries.push({ file, thumbnail: result.thumbnail, contentType: file.type, videoWidth: result.videoWidth, videoHeight: result.videoHeight, videoDuration: result.videoDuration });
      } else {
        entries.push({ file, thumbnail: result, contentType: file.type });
      }
    }
    setFileEntries(prev => [...prev, ...entries]);
  };

  const removeFile = (idx: number) => {
    setFileEntries(prev => prev.filter((_, i) => i !== idx));
    setSeriesRows(prev => prev.map(s => ({ ...s, assignedFiles: s.assignedFiles.filter(f => f !== idx).map(f => f > idx ? f - 1 : f) })));
    setSelectedFiles(prev => { const n = new Set<number>(); prev.forEach(f => { if (f < idx) n.add(f); else if (f > idx) n.add(f - 1); }); return n; });
  };

  const toggleFileSelection = (idx: number) => {
    setSelectedFiles(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; });
  };

  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); if (e.dataTransfer.files.length) handleFilesSelected(Array.from(e.dataTransfer.files)); };

  // ========== Submit ==========
  const canSubmit = () => {
    if (!selectedDatastore || fileEntries.length === 0 || submitting) return false;
    if (targetMode === 'none') return false;
    const hasAssigned = seriesRows.some(s => s.assignedFiles.length > 0);
    if (!hasAssigned) return false;
    if (targetMode === 'newAll' && (!newPatientID || !newPatientName)) return false;
    return true;
  };

  const handleSubmit = async () => {
    if (!canSubmit() || !selectedDatastore) return;
    setSubmitting(true);
    try {
      const assignedIndices = new Set<number>();
      seriesRows.forEach(s => s.assignedFiles.forEach(f => assignedIndices.add(f)));
      const assignedFiles = Array.from(assignedIndices).sort((a, b) => a - b);
      if (assignedFiles.length === 0) throw new Error('No files assigned to any series');

      const timestamp = Date.now();
      const urlResp = await apiRequest('/non-dicom-import/upload-url', {
        method: 'POST',
        body: JSON.stringify({ files: assignedFiles.map((fi, i) => ({ path: `${i}-${fileEntries[fi].file.name}`, name: fileEntries[fi].file.name, size: fileEntries[fi].file.size, type: fileEntries[fi].contentType })), folderName: `non-dicom-${timestamp}`, timestamp }),
      });
      if (!urlResp.success) throw new Error(urlResp.error?.message || 'Failed to get upload URLs');
      const uploadUrls = urlResp.data.uploadUrls;
      await Promise.all(uploadUrls.map((u: any, i: number) => fetch(u.url, { method: 'PUT', body: fileEntries[assignedFiles[i]].file, headers: { 'Content-Type': fileEntries[assignedFiles[i]].contentType } })));

      const patientAttrs = targetMode === 'existingStudy' && selectedSearchStudy
        ? { PatientID: selectedSearchStudy.patientID, PatientName: selectedSearchStudy.patientName, PatientBirthDate: selectedSearchStudy.patientBirthDate, PatientSex: selectedSearchStudy.patientSex }
        : { PatientID: newPatientID, PatientName: newPatientName, PatientBirthDate: newPatientBirthDate.replace(/-/g, ''), PatientSex: newPatientSex };

      const studyAttrs = targetMode === 'existingStudy' && selectedSearchStudy
        ? { StudyInstanceUID: selectedSearchStudy.studyInstanceUID, StudyID: selectedSearchStudy.studyID, StudyDescription: selectedSearchStudy.studyDescription, StudyDate: selectedSearchStudy.studyDate, StudyTime: selectedSearchStudy.studyTime, AccessionNumber: selectedSearchStudy.accessionNumber }
        : { StudyDescription: newStudyDescription, StudyDate: newStudyDate.replace(/-/g, ''), StudyTime: newStudyTime.replace(/:/g, '') + '00', AccessionNumber: newAccessionNumber };

      const seriesAssignments = assignedFiles.map((fi, ui) => {
        const series = seriesRows.find(s => s.assignedFiles.includes(fi));
        return { s3Key: uploadUrls[ui].key, contentType: fileEntries[fi].contentType, seriesInstanceUID: series && !series.isNew ? series.seriesInstanceUID : undefined, seriesDescription: series?.description || fileEntries[fi].file.name, ...(fileEntries[fi].videoWidth ? { videoWidth: fileEntries[fi].videoWidth, videoHeight: fileEntries[fi].videoHeight, videoDuration: fileEntries[fi].videoDuration } : {}) };
      });

      const jobResp = await apiRequest('/non-dicom-import', {
        method: 'POST',
        body: JSON.stringify({ datastoreId: selectedDatastore.id, s3InputKeys: uploadUrls.map((u: any) => u.key), patientAttrs, studyAttrs, seriesAssignments }),
      });
      if (!jobResp.success) throw new Error(jobResp.error?.message || 'Failed to create job');

      setTargetMode('none'); setSelectedSearchStudy(null); setSearchResults([]);
      setSearchPatientIDInput(''); setSearchPatientNameInput(''); setSearchAccessionInput('');
      setNewPatientID(''); setNewPatientName(''); setNewPatientBirthDate(''); setNewPatientSex('');
      setNewStudyDescription(''); setNewStudyDate(''); setNewStudyTime(''); setNewAccessionNumber('');
      setSeriesRows([]); setFileEntries([]); setSelectedFiles(new Set());
      setJobsExpanded(true); loadJobs();
      addNotification('success', 'Import job created', 'Your non-DICOM import job has been submitted.');
      doSearch();
    } catch (e: any) { addNotification('error', 'Import failed', e.message || 'Upload failed'); } finally { setSubmitting(false); }
  };

  const statusIndicator = (status: string) => {
    const map: Record<string, 'pending' | 'in-progress' | 'success' | 'error'> = { SUBMITTED: 'pending', PROCESSING: 'in-progress', IMPORTING: 'in-progress', COMPLETED: 'success', FAILED: 'error' };
    return <StatusIndicator type={map[status] || 'pending'}>{status}</StatusIndicator>;
  };

  // ========== Computed ==========
  const assignedToSeries = new Set<number>();
  seriesRows.forEach(s => s.assignedFiles.forEach(f => assignedToSeries.add(f)));
  const pagedStudies = searchResults.slice((studyPageIndex - 1) * STUDY_PAGE_SIZE, studyPageIndex * STUDY_PAGE_SIZE);
  const hasAssignedFiles = seriesRows.some(s => s.assignedFiles.length > 0);

  // ========== RENDER ==========
  return (
    <div style={{ width: '100%', maxWidth: '100vw', boxSizing: 'border-box' }}>
      <Flashbar items={notifications} />
      <SpaceBetween direction="vertical" size="l">
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={handleNewAll} disabled={!selectedDatastore}>Create New Patient &amp; Study</Button>
            </SpaceBetween>
          }
        >
          Non-DICOM Import {selectedDatastore ? `- ${selectedDatastore.name}` : ''}
        </Header>

        {/* Datastore Selection */}
        <FormField label="Select Storage" description="Choose a storage location to import non-DICOM files">
          <Select
            selectedOption={selectedDatastore ? { label: `${selectedDatastore.name} (${selectedDatastore.id})`, value: selectedDatastore.id } : null}
            options={datastores.map(d => ({
              label: `${d.name} (${d.id})`,
              value: d.id,
              description: 'Storage: S3'
            }))}
            onChange={({ detail }) => { const ds = datastores.find(d => d.id === detail.selectedOption.value); setSelectedDatastore(ds || null); }}
            placeholder="Select a datastore"
          />
        </FormField>

        {selectedDatastore && (
          <>
            {/* Search Filters */}
            <ExpandableSection headerText="Study Search Filters" defaultExpanded={true}>
              <SpaceBetween size="s">
                <ColumnLayout columns={4}>
                  <FormField label="Patient ID">
                    <Input value={searchPatientIDInput} onChange={({ detail }) => setSearchPatientIDInput(detail.value)} placeholder="Patient ID" onKeyDown={({ detail }) => { if (detail.key === 'Enter') handleSearch(); }} />
                  </FormField>
                  <FormField label="Patient Name">
                    <Input value={searchPatientNameInput} onChange={({ detail }) => setSearchPatientNameInput(detail.value)} placeholder="Patient Name" onKeyDown={({ detail }) => { if (detail.key === 'Enter') handleSearch(); }} />
                  </FormField>
                  <FormField label="Accession Number">
                    <Input value={searchAccessionInput} onChange={({ detail }) => setSearchAccessionInput(detail.value)} placeholder="Accession Number" onKeyDown={({ detail }) => { if (detail.key === 'Enter') handleSearch(); }} />
                  </FormField>
                  <Box padding={{ top: 'xl' }}>
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button onClick={handleSearch} disabled={searchLoading}>Search</Button>
                      {(searchPatientIDInput || searchPatientNameInput || searchAccessionInput) && (
                        <Button onClick={() => { handleClearFilters(); doSearch(); }}>Clear</Button>
                      )}
                    </SpaceBetween>
                  </Box>
                </ColumnLayout>
              </SpaceBetween>
            </ExpandableSection>

            {/* Study Results Table */}
            <Table
              items={pagedStudies}
              loading={searchLoading}
              loadingText="Searching studies..."
              selectionType="single"
              selectedItems={selectedSearchStudy ? [selectedSearchStudy] : []}
              onSelectionChange={({ detail }) => setSelectedSearchStudy(detail.selectedItems[0] || null)}
              columnDefinitions={[
                { id: 'patientID', header: 'Patient ID', cell: i => i.patientID },
                { id: 'patientName', header: 'Patient Name', cell: i => i.patientName },
                { id: 'studyDate', header: 'Study Date', cell: i => i.studyDate },
                { id: 'description', header: 'Description', cell: i => i.studyDescription },
                { id: 'modality', header: 'Modality', cell: i => i.modalitiesInStudy?.length > 0
                  ? <ModalityBadges modalities={i.modalitiesInStudy} />
                  : i.modality ? <ModalityBadge modality={i.modality} /> : '-' },
                { id: 'accession', header: 'Accession #', cell: i => i.accessionNumber },
                { id: 'series', header: 'Series', cell: i => i.numberOfStudyRelatedSeries },
              ]}
              empty={<Box textAlign="center" padding="l">No studies found</Box>}
              header={<Header counter={`(${searchResults.length})`} actions={
                selectedSearchStudy ? (
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={handleCopyPatient}>Copy Patient &amp; New Study</Button>
                    <Button onClick={handleAddToStudy}>Add Files to This Study</Button>
                  </SpaceBetween>
                ) : undefined
              }>Studies</Header>}
              pagination={
                searchResults.length > STUDY_PAGE_SIZE ? (
                  <Pagination
                    currentPageIndex={studyPageIndex}
                    pagesCount={Math.ceil(searchResults.length / STUDY_PAGE_SIZE)}
                    onChange={({ detail }) => setStudyPageIndex(detail.currentPageIndex)}
                  />
                ) : undefined
              }
            />
          </>
        )}

        {/* Main workspace: left panel + right panel */}
        {targetMode !== 'none' && selectedDatastore && (
          <Grid gridDefinition={[{ colspan: 7 }, { colspan: 5 }]}>
            {/* ===== LEFT PANEL ===== */}
            <SpaceBetween size="l">
              {/* New patient/study form (copyPatient or newAll) */}
              {(targetMode === 'copyPatient' || targetMode === 'newAll') && (
                <Container header={<Header variant="h3" actions={targetMode === 'newAll' ? <Button disabled={!selectedSearchStudy} onClick={() => { if (!selectedSearchStudy) return; setNewPatientID(selectedSearchStudy.patientID); setNewPatientName(selectedSearchStudy.patientName); setNewPatientBirthDate(dicomDateToISO(selectedSearchStudy.patientBirthDate || '')); setNewPatientSex(selectedSearchStudy.patientSex || ''); }}>Copy patient from this study</Button> : undefined}>{targetMode === 'copyPatient' ? 'New Study (patient copied)' : 'New Patient & Study'}</Header>}>
                  <SpaceBetween size="m">
                    <ColumnLayout columns={2}>
                      <FormField label="Patient ID"><Input value={newPatientID} onChange={({ detail }) => setNewPatientID(detail.value)} disabled={targetMode === 'copyPatient'} /></FormField>
                      <FormField label="Patient Name"><Input value={newPatientName} onChange={({ detail }) => setNewPatientName(detail.value)} disabled={targetMode === 'copyPatient'} placeholder="Lastname^Firstname" /></FormField>
                      <FormField label="Birth Date"><DatePicker value={newPatientBirthDate} onChange={({ detail }) => setNewPatientBirthDate(detail.value)} placeholder="YYYY/MM/DD" /></FormField>
                      <FormField label="Sex"><Select selectedOption={newPatientSex ? { label: newPatientSex, value: newPatientSex } : null} options={[{ label: 'M', value: 'M' }, { label: 'F', value: 'F' }, { label: 'O', value: 'O' }]} onChange={({ detail }) => setNewPatientSex(detail.selectedOption.value || '')} placeholder="Select" /></FormField>
                    </ColumnLayout>
                    <ColumnLayout columns={2}>
                      <FormField label="Study Description"><Input value={newStudyDescription} onChange={({ detail }) => setNewStudyDescription(detail.value)} /></FormField>
                      <FormField label="Study Date"><DatePicker value={newStudyDate} onChange={({ detail }) => setNewStudyDate(detail.value)} placeholder="YYYY/MM/DD" /></FormField>
                      <FormField label="Study Time"><Input value={newStudyTime} onChange={({ detail }) => setNewStudyTime(detail.value)} placeholder="HH:mm" /></FormField>
                      <FormField label="Accession Number"><Input value={newAccessionNumber} onChange={({ detail }) => setNewAccessionNumber(detail.value)} /></FormField>
                    </ColumnLayout>
                  </SpaceBetween>
                </Container>
              )}

              {/* Existing study info */}
              {targetMode === 'existingStudy' && selectedSearchStudy && (
                <Container header={<Header variant="h3">Target Study</Header>}>
                  <ColumnLayout columns={3}>
                    <div><Box variant="awsui-key-label">Patient</Box>{selectedSearchStudy.patientName} ({selectedSearchStudy.patientID})</div>
                    <div><Box variant="awsui-key-label">Study</Box>{selectedSearchStudy.studyDescription || 'No description'}</div>
                    <div><Box variant="awsui-key-label">Date</Box>{selectedSearchStudy.studyDate}</div>
                  </ColumnLayout>
                </Container>
              )}

              {/* Series Management Table */}
              <Table
                header={<Header variant="h3" actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    <Button onClick={assignFilesToSeries} disabled={!selectedSeriesId || selectedFiles.size === 0}>
                      Assign {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} to series
                    </Button>
                    <Button onClick={addNewSeries}>Add new series</Button>
                    <Button variant="primary" loading={submitting} disabled={!canSubmit()} onClick={handleSubmit}>Submit Import</Button>
                  </SpaceBetween>
                }>Series</Header>}
                items={seriesRows}
                columnDefinitions={[
                  {
                    id: 'color',
                    header: '',
                    width: 40,
                    cell: (s) => {
                      const color = seriesColorMap.get(s.id);
                      return color ? <span style={{ width: 16, height: 16, background: color, display: 'inline-block', borderRadius: 2 }} /> : '';
                    },
                  },
                  {
                    id: 'seriesNumber',
                    header: '#',
                    width: 90,
                    cell: (s) => {
                      return s.isNew
                        ? <Input value={String(s.seriesNumber)} onChange={({ detail }) => setSeriesRows(prev => prev.map(sr => sr.id === s.id ? { ...sr, seriesNumber: parseInt(detail.value) || 0 } : sr))} />
                        : s.seriesNumber;
                    },
                  },
                  {
                    id: 'description',
                    header: 'Description',
                    cell: (s) => s.isNew
                      ? <Input value={s.description} onChange={({ detail }) => setSeriesRows(prev => prev.map(sr => sr.id === s.id ? { ...sr, description: detail.value } : sr))} placeholder="Series description" />
                      : (s.description || 'Untitled'),
                  },
                  {
                    id: 'modality',
                    header: 'Modality',
                    width: 100,
                    cell: (s) => s.modality ? <ModalityBadge modality={s.modality} /> : '—',
                  },
                  {
                    id: 'files',
                    header: 'Assigned Files',
                    width: 120,
                    cell: (s) => s.assignedFiles.length > 0 ? `${s.assignedFiles.length} file(s)` : '—',
                  },
                  {
                    id: 'status',
                    header: 'Status',
                    width: 160,
                    cell: (s) => {
                      if (s.modality && !ASSIGNABLE_MODALITIES.has(s.modality)) return <StatusIndicator type="stopped">Not assignable</StatusIndicator>;
                      if (s.assignedFiles.length > 0) return <StatusIndicator type="success">{s.assignedFiles.length} assigned</StatusIndicator>;
                      if (s.isNew) return <StatusIndicator type="pending">Awaiting files</StatusIndicator>;
                      return '';
                    },
                  },
                  {
                    id: 'actions',
                    header: '',
                    width: 50,
                    cell: (s) => s.isNew ? <Button variant="icon" iconName="remove" onClick={() => removeSeriesRow(s.id)} /> : '',
                  },
                ]}
                selectionType="single"
                selectedItems={selectedSeriesId ? seriesRows.filter(s => s.id === selectedSeriesId) : []}
                onSelectionChange={({ detail }) => {
                  const item = detail.selectedItems[0];
                  if (item) setSelectedSeriesId(item.id);
                  else setSelectedSeriesId(null);
                }}
                isItemDisabled={(s) => !!(s.modality && !ASSIGNABLE_MODALITIES.has(s.modality))}
                trackBy="id"
                variant="embedded"
                empty={<Box textAlign="center" padding="s">No series. Click "Add new series" to get started.</Box>}
              />
            </SpaceBetween>

            {/* ===== RIGHT PANEL: File Browser ===== */}
            <Container header={<Header variant="h3" actions={
              fileEntries.length > 0 ? (
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="link" onClick={() => setSelectedFiles(new Set(fileEntries.map((_, i) => i)))}>Select all</Button>
                  <Button variant="link" onClick={() => setSelectedFiles(new Set())}>Deselect all</Button>
                </SpaceBetween>
              ) : undefined
            } counter={fileEntries.length > 0 ? `(${fileEntries.length})` : undefined}>Files</Header>}>
              <SpaceBetween size="s">
                <div
                  onDragOver={e => e.preventDefault()} onDrop={handleDrop}
                  style={{ border: '2px dashed #aab7b8', borderRadius: 8, padding: 16, textAlign: 'center', cursor: 'pointer' }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Box color="text-body-secondary">Drop files here or click to browse</Box>
                  <Box variant="small" color="text-body-secondary">PDF, JPEG, PNG, MP4</Box>
                  <input ref={fileInputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.mp4,.mpeg,.mov" style={{ display: 'none' }}
                    onChange={e => { if (e.target.files) handleFilesSelected(Array.from(e.target.files)); e.target.value = ''; }} />
                </div>
                {fileEntries.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {fileEntries.map((entry, idx) => {
                      const isSelected = selectedFiles.has(idx);
                      const seriesColor = fileColorMap.get(idx);
                      const borderColor = seriesColor || (isSelected ? '#0972d3' : '#d5dbdb');
                      const borderWidth = seriesColor || isSelected ? '2px' : '1px';
                      return (
                        <div key={idx} style={{ ...cardStyle }} onClick={() => toggleFileSelection(idx)}>
                          <input type="checkbox" checked={isSelected} onChange={() => {}} style={checkStyle} />
                          <button style={removeStyle} onClick={e => { e.stopPropagation(); removeFile(idx); }}>&times;</button>
                          {entry.thumbnail ? (
                            <img src={entry.thumbnail} alt={entry.file.name} style={{ ...thumbStyle, border: `${borderWidth} solid ${borderColor}` }} />
                          ) : (
                            <div style={{ ...noThumbStyle, border: `${borderWidth} solid ${borderColor}` }}>No preview</div>
                          )}
                          <div style={nameStyle} title={entry.file.name}>{entry.file.name}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <ModalityBadge modality={MODALITY_FOR_TYPE[entry.contentType] || '?'} />
                            {seriesColor && <span style={dotStyle(seriesColor)} />}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </SpaceBetween>
            </Container>
          </Grid>
        )}

        {/* Job History */}
        <ExpandableSection headerText={`Import History (${jobsTotalCount})`} expanded={jobsExpanded} onChange={({ detail }) => setJobsExpanded(detail.expanded)}>
          <Table
            items={jobs}
            loading={jobsLoading} loadingText="Loading jobs..."
            empty={<Box textAlign="center" padding="l">No import jobs</Box>}
            columnDefinitions={[
              { id: 'id', header: 'Job ID', cell: i => i.id },
              { id: 'status', header: 'Status', cell: i => statusIndicator(i.status) },
              { id: 'description', header: 'Description', cell: i => i.status_description || '-' },
              { id: 'datastore', header: 'Datastore', cell: i => i.datastore_name || i.datastore_id?.substring(0, 8) },
              { id: 'created_by', header: 'Created By', cell: i => i.created_by || '-' },
              { id: 'created_at', header: 'Created', cell: i => formatTimestamp(i.created_at) },
            ]}
            pagination={jobsTotalCount > jobsPageSize ? <Pagination currentPageIndex={jobsPageIndex} pagesCount={Math.ceil(jobsTotalCount / jobsPageSize)} onChange={({ detail }) => setJobsPageIndex(detail.currentPageIndex)} /> : undefined}
            preferences={<CollectionPreferences pageSizePreference={{ title: 'Page size', options: [{ value: 10, label: '10 jobs' }, { value: 25, label: '25 jobs' }, { value: 50, label: '50 jobs' }] }} preferences={{ pageSize: jobsPageSize }} onConfirm={({ detail }) => { setJobsPageSize(detail.pageSize ?? 10); setJobsPageIndex(1); }} />}
          />
        </ExpandableSection>
      </SpaceBetween>
    </div>
  );
};

export default NonDicomImport;
