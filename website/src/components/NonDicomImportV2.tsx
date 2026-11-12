/**
 * Non-DICOM Import V2: guided three-step import of PDFs, images and videos.
 *
 * PHI notice: this component collects and displays patient identifiers (PHI).
 * Deployers are responsible for HIPAA (and, where applicable, GDPR) controls
 * under the AWS shared responsibility model; use only synthetic data for
 * testing. See PHI-HANDLING.md.
 *
 *   1. Destination + files: only writable destinations (GET /destinations). Files
 *      upload at once to the caller's user-uploads prefix; each PDF/image is
 *      analysed as soon as its upload finishes.
 *   2. Patient: extracted fields with evidence and confidence, ranked candidates,
 *      a new patient pre-filled from the analysis, or manual search.
 *   3. Review: one series per modality (DOC/SC/XC), per-file document fields,
 *      de-identified folder acknowledgement, submit and per-file status.
 *
 * Opened with `fixedDestination` + `fixedStudy` (the Studies page "Attach files"
 * action), the destination is locked and step 2 is skipped.
 *
 * Contract: plans/NON-DICOM-IMPORT-V2-CONTRACT.md. V1 (NonDicomImport.tsx) is
 * untouched; this component shares no state with it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Badge, Box, Button, Checkbox, ColumnLayout, Container, DatePicker, ExpandableSection,
  FormField, Header, Input, Modal, ProgressBar, RadioGroup, Select, SpaceBetween, StatusIndicator,
  Table, Tiles,
} from '@cloudscape-design/components';
import { ModalityBadge } from './ModalityBadge';
import { dicomwebService, ProcessedDicomSeries } from '../services/dicomwebService';
import {
  AnalyzeResponse, Candidate, CandidateStudy, CreateImportBody, DestinationKind, EXTRACTED_FIELD_KEYS,
  ExtractedFieldKey, FIELD_LABELS, ImportDetail, ImportSummary, PatientSearchResult, V2Destination,
  V2Modality, nonDicomV2Api, putFile,
} from './nonDicomImportV2/apiV2';
import {
  ACCEPT_ATTR, MAX_FILES, MODALITY_FOR_TYPE, MODALITY_LABEL, daToIso, detectContentType, displayDate,
  displayPN, formatBytes, idKey, isoToDa, joinFieldLabels, makeThumbnail, nameKey, readVideoMetadata, sha256Hex, sizeCapFor,
} from './nonDicomImportV2/filesV2';
import type { VideoMetadata } from './nonDicomImportV2/filesV2';
import { V2_THEME } from './nonDicomImportV2/themeV2';

// ------------------------------------------------------------------ types

type UploadState = 'preparing' | 'waiting' | 'uploading' | 'uploaded' | 'failed';
type AnalysisState = 'waiting' | 'analysing' | 'analysed' | 'not_analysed' | 'skipped';

interface FileItem {
  localId: string;
  file: File;
  name: string;
  size: number;
  contentType: string;
  modality: V2Modality;
  thumbnail: string;
  sha256: string | null;
  duplicateOf: string | null;
  upload: UploadState;
  progress: number;
  uploadError?: string;
  s3Key?: string;
  analysis: AnalysisState;
  analysisReason?: string;
  result?: AnalyzeResponse;
  documentTitle: string;
  contentDate: string; // ISO YYYY-MM-DD (date picker); sent as DA
  institutionName: string;
  metaTouched: boolean;
  seriesRef: string | null;
  /** Video only: dimensions read in the browser; null when it cannot decode the file. */
  video?: VideoMetadata | null;
}

interface SeriesGroup {
  ref: string;
  mode: 'new' | 'existing';
  seriesInstanceUID: string;
  modality: V2Modality;
  description: string;
}

interface ChosenPatient {
  patientId: string; patientName: string; birthDate?: string; sex?: string; studies: CandidateStudy[];
}

type PatientMode = 'candidate' | 'new' | 'search';
type StepId = 'files' | 'patient' | 'review';

export interface FixedStudy {
  studyInstanceUID: string;
  patientId: string;
  patientName: string;
  birthDate?: string;
  sex?: string;
  studyDescription?: string;
  studyDate?: string;
  accessionNumber?: string;
}

export interface NonDicomImportV2Props {
  /** Lock the destination (Attach files from a study). */
  fixedDestination?: { kind: DestinationKind; id: string; name?: string };
  /** Lock patient + study (Attach files); step 2 is skipped. */
  fixedStudy?: FixedStudy;
  /** Called by the "Close" action after an attach-mode import. */
  onClose?: () => void;
}

interface BestField { key: ExtractedFieldKey; value: string; confidence: number; evidence: string; fileName: string }

// ------------------------------------------------------------------ constants

const UPLOAD_CONCURRENCY = 3;
const POLL_MS = 3000;
const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'FAILED']);
const DEFAULT_SERIES_DESC: Record<V2Modality, string> = { DOC: 'Documents', SC: 'Images', XC: 'Videos', SM: 'Whole Slide Image' };
const SEX_OPTIONS = [{ label: 'M', value: 'M' }, { label: 'F', value: 'F' }, { label: 'O', value: 'O' }];
const DEID_STEP1_TEXT =
  'This folder de-identifies DICOM tags only. Text and images inside the files are stored as they are, ' +
  "so patient details printed on them stay visible to the folder's readers.";
const ACK_LABEL = 'I understand the file contents are not de-identified';

const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
};
const thumbStyle: React.CSSProperties = {
  width: 56, height: 56, objectFit: 'cover', borderRadius: 4, border: `1px solid ${V2_THEME.border}`, display: 'block',
};
const noThumbStyle: React.CSSProperties = {
  ...thumbStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
  background: V2_THEME.mutedBg, color: V2_THEME.mutedText, textAlign: 'center',
};

let localCounter = 0;
const nextLocalId = () => `f${Date.now().toString(36)}-${(localCounter++).toString(36)}`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const pct = (c: number) => `${Math.round((c || 0) * 100)}%`;
const confidenceColor = (c: number): 'green' | 'blue' | 'grey' => (c >= 0.8 ? 'green' : c >= 0.5 ? 'blue' : 'grey');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e || 'Unknown error'));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() : s);

// ------------------------------------------------------------------ status panel

const FILE_STATUS: Record<string, { type: 'pending' | 'in-progress' | 'success' | 'error' | 'loading'; text: string }> = {
  PENDING: { type: 'pending', text: 'Queued' },
  ENCAPSULATING: { type: 'in-progress', text: 'Converting to DICOM' },
  WRITTEN: { type: 'in-progress', text: 'Written, waiting for indexing' },
  INDEXED: { type: 'success', text: 'Indexed' },
  FAILED: { type: 'error', text: 'Failed' },
};
const IMPORT_STATUS: Record<string, { type: 'pending' | 'in-progress' | 'success' | 'error' | 'warning'; text: string }> = {
  SUBMITTED: { type: 'pending', text: 'Submitted' },
  PENDING: { type: 'pending', text: 'Submitted' },
  PROCESSING: { type: 'in-progress', text: 'Processing' },
  COMPLETED: { type: 'success', text: 'Completed' },
  PARTIAL: { type: 'warning', text: 'Partly completed' },
  FAILED: { type: 'error', text: 'Failed' },
};

const ImportStatusIndicator: React.FC<{ status: string }> = ({ status }) => {
  const s = IMPORT_STATUS[status] || { type: 'pending' as const, text: status || 'Unknown' };
  return <StatusIndicator type={s.type}>{s.text}</StatusIndicator>;
};

/** Polls GET /{importId} until the import is terminal and shows per-file status. */
export const ImportStatusPanel: React.FC<{ importId: string }> = ({ importId }) => {
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const d = await nonDicomV2Api.getImport(importId);
        if (stopped) return;
        setDetail(d); setError(null);
        if (TERMINAL.has(String(d?.import?.status || '').toUpperCase())) return;
      } catch (e) {
        if (stopped) return;
        setError(errMsg(e));
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [importId]);

  const files = detail?.files || [];
  const done = files.filter(f => f.status === 'INDEXED' || f.status === 'FAILED').length;
  const status = String(detail?.import?.status || 'SUBMITTED').toUpperCase();
  const terminal = TERMINAL.has(status);

  return (
    <SpaceBetween size="m">
      {error && <Alert type="warning" header="Could not refresh the import status">{error} Retrying every few seconds.</Alert>}
      <ColumnLayout columns={3} variant="text-grid">
        <div><Box variant="awsui-key-label">Import ID</Box><Box>{importId}</Box></div>
        <div><Box variant="awsui-key-label">Status</Box><ImportStatusIndicator status={status} /></div>
        <div><Box variant="awsui-key-label">Study</Box><Box>{detail?.import?.studyInstanceUID || '-'}</Box></div>
      </ColumnLayout>
      {!terminal && files.length > 0 && (
        <ProgressBar value={(done / files.length) * 100} label="Files processed" description={`${done} of ${files.length} files finished`} />
      )}
      <div aria-live="polite" style={srOnly}>{terminal ? `Import ${IMPORT_STATUS[status]?.text || status}.` : `${done} of ${files.length} files finished.`}</div>
      <Table
        variant="embedded"
        items={files}
        trackBy="id"
        loading={!detail && !error}
        loadingText="Loading import status"
        empty={<Box textAlign="center" padding="s">No files</Box>}
        columnDefinitions={[
          { id: 'name', header: 'File', cell: f => f.fileName, isRowHeader: true },
          {
            id: 'status', header: 'Status', cell: f => {
              const s = FILE_STATUS[f.status] || { type: 'pending' as const, text: f.status };
              return <StatusIndicator type={s.type}>{s.text}</StatusIndicator>;
            },
          },
          { id: 'error', header: 'Details', cell: f => f.errorMessage ? <Box color="text-status-error">{f.errorMessage}</Box> : (f.sopInstanceUID ? <Box variant="small">SOP {f.sopInstanceUID}</Box> : '-') },
        ]}
      />
    </SpaceBetween>
  );
};

// ------------------------------------------------------------------ main component

const NonDicomImportV2: React.FC<NonDicomImportV2Props> = ({ fixedDestination, fixedStudy, onClose }) => {
  const attachMode = !!fixedStudy;
  const steps: StepId[] = attachMode ? ['files', 'review'] : ['files', 'patient', 'review'];
  const STEP_TITLES: Record<StepId, string> = { files: 'Destination and files', patient: 'Choose the patient', review: 'Review and submit' };

  // Destinations
  const [destinations, setDestinations] = useState<V2Destination[]>([]);
  const [destLoading, setDestLoading] = useState(true);
  const [destError, setDestError] = useState<string | null>(null);
  const [destination, setDestination] = useState<V2Destination | null>(null);

  // Files
  const [files, setFiles] = useState<FileItem[]>([]);
  const filesRef = useRef<FileItem[]>([]);
  filesRef.current = files;
  const removedIds = useRef<Set<string>>(new Set());
  const [rejections, setRejections] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Steps
  const [step, setStep] = useState<StepId>('files');

  // Patient (step 2)
  const [patientMode, setPatientMode] = useState<PatientMode | null>(null);
  const [chosenPatient, setChosenPatient] = useState<ChosenPatient | null>(null);
  const [studyChoice, setStudyChoice] = useState<string>(''); // studyInstanceUID | 'new'
  const [newPatient, setNewPatient] = useState({ patientId: '', patientName: '', birthDate: '', sex: '' });
  const [newStudy, setNewStudy] = useState({ studyDescription: '', studyDate: '', accessionNumber: '', referringPhysician: '' });
  const prefilledRef = useRef(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<PatientSearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Series (step 3)
  const [series, setSeries] = useState<SeriesGroup[]>([]);
  const [existingSeries, setExistingSeries] = useState<ProcessedDicomSeries[]>([]);
  const [existingSeriesLoading, setExistingSeriesLoading] = useState(false);
  const [addSeriesModality, setAddSeriesModality] = useState<V2Modality | ''>('');
  const [addExistingUid, setAddExistingUid] = useState('');
  const [ack, setAck] = useState(false);

  // Submit / tracking
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [importId, setImportId] = useState<string | null>(null);

  // History
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ImportSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyViewId, setHistoryViewId] = useState<string | null>(null);

  // ---------------------------------------------------------------- destinations

  const loadDestinations = useCallback(async () => {
    setDestLoading(true); setDestError(null);
    try {
      const list = await nonDicomV2Api.getDestinations();
      setDestinations(list || []);
      if (fixedDestination) {
        setDestination((list || []).find(d => d.kind === fixedDestination.kind && d.id === fixedDestination.id) || null);
      }
    } catch (e) {
      setDestError(errMsg(e));
    } finally {
      setDestLoading(false);
    }
  }, [fixedDestination]);
  useEffect(() => { loadDestinations(); }, [loadDestinations]);

  const destNameById = useMemo(() => {
    const m = new Map<string, string>();
    destinations.forEach(d => m.set(`${d.kind}:${d.id}`, d.name));
    return m;
  }, [destinations]);

  // ---------------------------------------------------------------- file state helpers

  const patchFile = useCallback((localId: string, patch: Partial<FileItem> | ((f: FileItem) => Partial<FileItem>)) => {
    setFiles(prev => prev.map(f => (f.localId === localId ? { ...f, ...(typeof patch === 'function' ? patch(f) : patch) } : f)));
  }, []);

  const busyUploading = files.some(f => f.upload === 'preparing' || f.upload === 'waiting' || f.upload === 'uploading');

  // Warn before leaving while files upload or the import is being submitted.
  useEffect(() => {
    if (!busyUploading && !submitting) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [busyUploading, submitting]);

  const runAnalysis = useCallback(async (item: FileItem, s3Key: string, dest: V2Destination) => {
    if (item.modality === 'XC') {
      patchFile(item.localId, { analysis: 'skipped', analysisReason: 'Videos are not analysed.' });
      return;
    }
    if (item.modality === 'SM') {
      // Whole-slide pathology is not AI-analysed (multi-GB TIFF, no readable
      // text to extract). Patient/study are entered manually and written into
      // the slide's ingest sidecar.
      patchFile(item.localId, { analysis: 'skipped', analysisReason: 'Pathology slides are not analysed — enter patient and study details below.' });
      return;
    }
    if (!dest.canAnalyze) {
      patchFile(item.localId, { analysis: 'not_analysed', analysisReason: 'Analysis needs read permission on this destination.' });
      return;
    }
    patchFile(item.localId, { analysis: 'analysing' });
    try {
      const res = await nonDicomV2Api.analyze(dest.kind, dest.id, s3Key);
      if (removedIds.current.has(item.localId)) return;
      if (res?.status === 'ANALYSED') {
        patchFile(item.localId, f => {
          const fields = res.fields || {};
          const title = fields.documentTitle?.value || fields.documentType?.value || '';
          return {
            analysis: 'analysed', result: res,
            ...(f.metaTouched ? {} : {
              documentTitle: title || f.documentTitle,
              contentDate: daToIso(fields.documentDate?.value) || f.contentDate,
              institutionName: fields.institution?.value || f.institutionName,
            }),
          };
        });
      } else {
        patchFile(item.localId, { analysis: 'not_analysed', analysisReason: res?.reason || 'The document could not be analysed.', result: res });
      }
    } catch (e) {
      patchFile(item.localId, { analysis: 'not_analysed', analysisReason: errMsg(e) });
    }
  }, [patchFile]);

  /** Request presigned URLs for these items, PUT them (bounded concurrency), then analyse each. */
  const uploadItems = useCallback(async (items: FileItem[], dest: V2Destination) => {
    if (!items.length) return;
    items.forEach(i => patchFile(i.localId, { upload: 'waiting', uploadError: undefined, progress: 0 }));
    let urls: { s3Key: string; uploadUrl: string }[];
    try {
      const resp = await nonDicomV2Api.getUploadUrls(dest.kind, dest.id, items.map(i => ({ name: i.name, contentType: i.contentType, size: i.size })));
      urls = resp.files || [];
      if (urls.length !== items.length) throw new Error('The server returned an unexpected number of upload links.');
    } catch (e) {
      const m = errMsg(e);
      items.forEach(i => patchFile(i.localId, { upload: 'failed', uploadError: m, analysis: 'waiting' }));
      return;
    }
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const idx = next++;
        const item = items[idx];
        if (removedIds.current.has(item.localId)) continue;
        const { s3Key, uploadUrl } = urls[idx];
        patchFile(item.localId, { upload: 'uploading', progress: 0 });
        try {
          await putFile(uploadUrl, item.file, item.contentType, p => patchFile(item.localId, { progress: p }));
          if (removedIds.current.has(item.localId)) continue;
          patchFile(item.localId, { upload: 'uploaded', progress: 1, s3Key });
          // Analysis starts as soon as this file's upload finishes; not awaited so the
          // next upload is not held up by the model.
          void runAnalysis(item, s3Key, dest);
        } catch (e) {
          patchFile(item.localId, { upload: 'failed', uploadError: errMsg(e) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, items.length) }, worker));
  }, [patchFile, runAnalysis]);

  const addFiles = useCallback(async (picked: File[]) => {
    if (!destination || !picked.length) return;
    const dest = destination;
    const rejected: string[] = [];
    const accepted: FileItem[] = [];
    let room = MAX_FILES - filesRef.current.length;
    for (const file of picked) {
      const contentType = detectContentType(file);
      if (!contentType) { rejected.push(`${file.name}: not a supported type (PDF, JPEG, PNG, MP4, MPEG, MOV, SVS, BIF).`); continue; }
      const modality = MODALITY_FOR_TYPE[contentType];
      const cap = sizeCapFor(modality);
      const kindLabel = modality === 'XC' ? 'videos' : modality === 'SM' ? 'pathology slides' : 'documents and images';
      if (file.size > cap) { rejected.push(`${file.name}: ${formatBytes(file.size)} is larger than the ${formatBytes(cap)} limit for ${kindLabel}.`); continue; }
      if (file.size === 0) { rejected.push(`${file.name}: the file is empty.`); continue; }
      if (room <= 0) { rejected.push(`${file.name}: an import holds at most ${MAX_FILES} files.`); continue; }
      room--;
      accepted.push({
        localId: nextLocalId(), file, name: file.name, size: file.size, contentType, modality,
        thumbnail: '', sha256: null, duplicateOf: null, upload: 'preparing', progress: 0,
        analysis: (modality === 'XC' || modality === 'SM') ? 'skipped' : 'waiting',
        analysisReason: modality === 'XC' ? 'Videos are not analysed.'
          : modality === 'SM' ? 'Pathology slides are not analysed — enter patient and study details below.'
          : undefined,
        documentTitle: '', contentDate: '', institutionName: '', metaTouched: false, seriesRef: null,
      });
    }
    setRejections(rejected);
    if (!accepted.length) return;
    setFiles(prev => [...prev, ...accepted]);

    // Hash + thumbnail, then the duplicate check (SHA-256 within this import).
    const prepared = await Promise.all(accepted.map(async (it) => {
      const [sha, thumb, video] = await Promise.all([
        sha256Hex(it.file).catch(() => null),
        makeThumbnail(it.file, it.modality).catch(() => ''),
        it.modality === 'XC' ? readVideoMetadata(it.file).catch(() => null) : Promise.resolve(null),
      ]);
      return { ...it, sha256: sha, thumbnail: thumb, video };
    }));
    const seen = new Map<string, string>();
    filesRef.current.filter(f => !accepted.some(a => a.localId === f.localId)).forEach(f => {
      seen.set(f.sha256 || `${f.name}|${f.size}|${f.file.lastModified}`, f.name);
    });
    for (const p of prepared) {
      const k = p.sha256 || `${p.name}|${p.size}|${p.file.lastModified}`;
      const dupe = seen.get(k) || null;
      if (!dupe) seen.set(k, p.name);
      patchFile(p.localId, { sha256: p.sha256, thumbnail: p.thumbnail, duplicateOf: dupe, video: p.video });
    }
    await uploadItems(prepared.filter(p => !removedIds.current.has(p.localId)), dest);
  }, [destination, patchFile, uploadItems]);

  const retryUpload = (item: FileItem) => { if (destination) void uploadItems([item], destination); };
  const removeFile = (localId: string) => {
    removedIds.current.add(localId);
    setFiles(prev => prev.filter(f => f.localId !== localId));
  };
  const resetAll = () => {
    files.forEach(f => removedIds.current.add(f.localId));
    setFiles([]); setRejections([]); setStep('files');
    setPatientMode(null); setChosenPatient(null); setStudyChoice('');
    setNewPatient({ patientId: '', patientName: '', birthDate: '', sex: '' });
    setNewStudy({ studyDescription: '', studyDate: '', accessionNumber: '', referringPhysician: '' });
    prefilledRef.current = false;
    setSearchQ(''); setSearchResults(null); setSearchError(null);
    setSeries([]); setExistingSeries([]); setAck(false);
    setSubmitError(null); setImportId(null);
    if (!fixedDestination) setDestination(null);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    if (destination && e.dataTransfer.files.length) void addFiles(Array.from(e.dataTransfer.files));
  };

  // ---------------------------------------------------------------- analysis aggregate

  const analysedFiles = useMemo(() => files.filter(f => f.analysis === 'analysed' && f.result), [files]);
  const analysingCount = files.filter(f => f.analysis === 'analysing' || (f.analysis === 'waiting' && f.upload !== 'failed')).length;
  const videoOnly = files.length > 0 && files.every(f => f.modality === 'XC');

  const bestFields = useMemo<BestField[]>(() => {
    const out: BestField[] = [];
    for (const key of EXTRACTED_FIELD_KEYS) {
      let best: BestField | null = null;
      for (const f of analysedFiles) {
        const v = f.result?.fields?.[key];
        if (!v || v.value == null || String(v.value).trim() === '') continue;
        if (!best || (v.confidence || 0) > best.confidence) {
          best = { key, value: String(v.value), confidence: v.confidence || 0, evidence: v.evidence || '', fileName: f.name };
        }
      }
      if (best) out.push(best);
    }
    return out;
  }, [analysedFiles]);
  const bestValue = (key: ExtractedFieldKey) => bestFields.find(b => b.key === key)?.value || '';

  /** Files that disagree on patient ID or name (confident values only). One patient per import: warn, do not split. */
  const disagreement = useMemo(() => {
    const ids = new Map<string, string[]>();
    const names = new Map<string, { shown: string; files: string[] }>();
    for (const f of analysedFiles) {
      const id = f.result?.fields?.patientId;
      if (id?.value && (id.confidence || 0) >= 0.5) {
        const k = idKey(id.value);
        ids.set(k, [...(ids.get(k) || []), f.name]);
      }
      const nm = f.result?.fields?.patientName;
      if (nm?.value && (nm.confidence || 0) >= 0.5) {
        const k = nameKey(nm.value);
        const cur = names.get(k) || { shown: nm.value, files: [] };
        cur.files.push(f.name);
        names.set(k, cur);
      }
    }
    const lines: string[] = [];
    if (ids.size > 1) lines.push(`Patient IDs differ: ${Array.from(ids.entries()).map(([k, fs]) => `${k} (${fs.join(', ')})`).join('; ')}.`);
    if (names.size > 1) lines.push(`Patient names differ: ${Array.from(names.values()).map(v => `${displayPN(v.shown)} (${v.files.join(', ')})`).join('; ')}.`);
    return lines;
  }, [analysedFiles]);

  const candidates = useMemo<Candidate[]>(() => {
    const byId = new Map<string, Candidate & { fileCount: number }>();
    for (const f of analysedFiles) {
      for (const c of f.result?.candidates || []) {
        const k = idKey(c.patientId);
        const cur = byId.get(k);
        if (!cur) {
          byId.set(k, { ...c, reasons: [...(c.reasons || [])], studies: [...(c.studies || [])], fileCount: 1 });
        } else {
          cur.score = Math.max(cur.score, c.score || 0);
          cur.fileCount++;
          (c.reasons || []).forEach(r => { if (!cur.reasons.includes(r)) cur.reasons.push(r); });
          (c.studies || []).forEach(s => { if (!cur.studies.some(x => x.studyInstanceUID === s.studyInstanceUID)) cur.studies.push(s); });
        }
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.score - a.score);
  }, [analysedFiles]);

  const printedNotes = useMemo(() => files
    .filter(f => (f.result?.printedIdentifiers || []).length > 0)
    .map(f => {
      const keys = f.result!.printedIdentifiers!;
      return `${joinFieldLabels(keys, FIELD_LABELS)} ${keys.length > 1 ? 'were' : 'was'} found printed in ${f.name}.`;
    }), [files]);

  const fillNewFromAnalysis = useCallback(() => {
    setNewPatient({
      patientId: bestValue('patientId'),
      patientName: bestValue('patientName'),
      birthDate: daToIso(bestValue('birthDate')),
      sex: ['M', 'F', 'O'].includes(bestValue('sex').toUpperCase()) ? bestValue('sex').toUpperCase() : '',
    });
    setNewStudy({
      studyDescription: clip(bestValue('documentType') || bestValue('documentTitle'), 64),
      studyDate: daToIso(bestValue('documentDate')) || todayIso(),
      accessionNumber: bestValue('accessionNumber'),
      referringPhysician: bestValue('referringPhysician'),
    });
  }, [bestFields]); // eslint-disable-line react-hooks/exhaustive-deps

  // Default choice and one-time pre-fill on entering step 2.
  useEffect(() => {
    if (step !== 'patient') return;
    // Pre-fill once, after the analyses settle, and only while the user has typed nothing.
    const untouched = !newPatient.patientId && !newPatient.patientName && !newPatient.birthDate && !newPatient.sex
      && !newStudy.studyDescription && !newStudy.accessionNumber && !newStudy.referringPhysician;
    if (!prefilledRef.current && analysingCount === 0) {
      if (untouched) fillNewFromAnalysis();
      prefilledRef.current = true;
    }
    if (patientMode === null) {
      if (!destination?.canAnalyze) setPatientMode('new');
      else if (videoOnly) setPatientMode('search');
      else if (candidates.length > 0) setPatientMode('candidate');
      else if (analysedFiles.length > 0) setPatientMode('new');
      else if (analysingCount === 0) setPatientMode('search');
    }
  }, [step, analysingCount, candidates.length, analysedFiles.length, videoOnly, patientMode, destination, fillNewFromAnalysis]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = async () => {
    if (!destination || searchQ.trim().length < 2) return;
    setSearchLoading(true); setSearchError(null);
    try {
      setSearchResults(await nonDicomV2Api.searchPatients(destination.kind, destination.id, searchQ.trim()));
    } catch (e) {
      setSearchError(errMsg(e)); setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  const selectPatient = (p: ChosenPatient | null) => { setChosenPatient(p); setStudyChoice(''); };

  // ---------------------------------------------------------------- resolved patient / study

  const resolved = useMemo(() => {
    if (fixedStudy) {
      return {
        patient: { mode: 'existing' as const, patientId: fixedStudy.patientId, patientName: fixedStudy.patientName, birthDate: fixedStudy.birthDate || '', sex: fixedStudy.sex || '' },
        study: {
          mode: 'existing' as const, studyInstanceUID: fixedStudy.studyInstanceUID, studyDescription: fixedStudy.studyDescription || '',
          studyDate: fixedStudy.studyDate || '', accessionNumber: fixedStudy.accessionNumber || '', referringPhysician: '',
        },
      };
    }
    const studyNew = {
      mode: 'new' as const, studyInstanceUID: '', studyDescription: newStudy.studyDescription.trim(), studyDate: isoToDa(newStudy.studyDate),
      accessionNumber: newStudy.accessionNumber.trim(), referringPhysician: newStudy.referringPhysician.trim(),
    };
    if (patientMode === 'new') {
      return {
        patient: { mode: 'new' as const, patientId: newPatient.patientId.trim(), patientName: newPatient.patientName.trim(), birthDate: isoToDa(newPatient.birthDate), sex: newPatient.sex },
        study: studyNew,
      };
    }
    if ((patientMode === 'candidate' || patientMode === 'search') && chosenPatient && studyChoice) {
      const ex = chosenPatient.studies.find(s => s.studyInstanceUID === studyChoice);
      return {
        patient: { mode: 'existing' as const, patientId: chosenPatient.patientId, patientName: chosenPatient.patientName, birthDate: chosenPatient.birthDate || '', sex: chosenPatient.sex || '' },
        study: studyChoice === 'new' || !ex ? studyNew : {
          mode: 'existing' as const, studyInstanceUID: ex.studyInstanceUID, studyDescription: ex.description || '', studyDate: ex.studyDate || '',
          accessionNumber: ex.accessionNumber || '', referringPhysician: '',
        },
      };
    }
    return null;
  }, [fixedStudy, patientMode, newPatient, newStudy, chosenPatient, studyChoice]);

  const existingStudyUid = resolved?.study.mode === 'existing' ? resolved.study.studyInstanceUID : '';

  // Existing series of the target study, for "move into a compatible existing series".
  useEffect(() => {
    if (!destination || !existingStudyUid) { setExistingSeries([]); return; }
    let stop = false;
    setExistingSeriesLoading(true);
    dicomwebService.searchSeries(destination.id, existingStudyUid, {}, destination.id, 'S3')
      .then(r => { if (!stop) setExistingSeries(r.success && r.data ? r.data : []); })
      .catch(() => { if (!stop) setExistingSeries([]); })
      .finally(() => { if (!stop) setExistingSeriesLoading(false); });
    return () => { stop = true; };
  }, [destination, existingStudyUid]);

  // ---------------------------------------------------------------- series grouping

  const modalitiesPresent = useMemo(() => Array.from(new Set(files.map(f => f.modality))) as V2Modality[], [files]);

  const seriesStateRef = useRef<SeriesGroup[]>(series);
  seriesStateRef.current = series;

  /** Auto-group: one new series per modality, description from document type/title. Keeps the user's choices. */
  const ensureSeries = useCallback(() => {
    const fs = filesRef.current;
    // Drop auto-created groups that no longer hold files; keep user-added and existing ones.
    let next = seriesStateRef.current.filter(s => !s.ref.startsWith('auto-') || fs.some(f => f.seriesRef === s.ref));
    const assignments: Record<string, string> = {};
    for (const f of fs) {
      const cur = next.find(s => s.ref === f.seriesRef);
      if (cur && cur.modality === f.modality) continue;
      let target = next.find(s => s.mode === 'new' && s.modality === f.modality);
      if (!target) {
        const sample = fs.find(x => x.modality === f.modality && x.analysis === 'analysed');
        const flds = sample?.result?.fields;
        target = {
          ref: `auto-${f.modality}`, mode: 'new', seriesInstanceUID: '', modality: f.modality,
          description: clip(flds?.documentType?.value || flds?.documentTitle?.value || DEFAULT_SERIES_DESC[f.modality], 64),
        };
        next = [...next, target];
      }
      assignments[f.localId] = target.ref;
    }
    setSeries(next);
    if (Object.keys(assignments).length) {
      setFiles(prev => prev.map(f => (assignments[f.localId] ? { ...f, seriesRef: assignments[f.localId] } : f)));
    }
  }, []);

  useEffect(() => { if (step === 'review') ensureSeries(); }, [step, files.length, ensureSeries]);

  const filesInSeries = (ref: string) => files.filter(f => f.seriesRef === ref);

  const addNewSeries = (modality: V2Modality) => {
    const ref = `s-${Date.now().toString(36)}`;
    setSeries(prev => [...prev, { ref, mode: 'new', seriesInstanceUID: '', modality, description: DEFAULT_SERIES_DESC[modality] }]);
  };
  const addExistingSeries = (uid: string) => {
    const s = existingSeries.find(x => x.seriesInstanceUID === uid);
    if (!s || series.some(x => x.seriesInstanceUID === uid)) return;
    // The API accepts refs of letters, digits, _ and - (at most 64): a UID's dots do not qualify.
    setSeries(prev => [...prev, {
      ref: `ex-${Date.now().toString(36)}-${(localCounter++).toString(36)}`, mode: 'existing', seriesInstanceUID: uid,
      modality: s.modality as V2Modality,
      description: clip(s.seriesDescription || `Series ${s.seriesNumber ?? ''}`.trim(), 64),
    }]);
  };
  const removeSeries = (ref: string) => {
    if (filesInSeries(ref).length > 0) return;
    setSeries(prev => prev.filter(s => s.ref !== ref));
  };
  const compatibleExisting = existingSeries.filter(s =>
    (['DOC', 'SC', 'XC', 'SM'] as string[]).includes(s.modality) && modalitiesPresent.includes(s.modality as V2Modality)
    && !series.some(x => x.seriesInstanceUID === s.seriesInstanceUID));

  // ---------------------------------------------------------------- blockers

  const step1Blockers: string[] = [];
  if (!destination) step1Blockers.push('Choose a destination.');
  if (files.length === 0) step1Blockers.push('Add at least one file.');
  if (files.length > MAX_FILES) step1Blockers.push(`Remove files: an import holds at most ${MAX_FILES}.`);
  if (files.length > 0 && files.every(f => f.upload === 'failed')) step1Blockers.push('Every upload failed: retry or remove the files.');

  const step2Blockers: string[] = [];
  if (!attachMode) {
    if (!patientMode) step2Blockers.push('Choose how to set the patient.');
    if (patientMode === 'new') {
      if (!newPatient.patientName.trim()) step2Blockers.push('Enter the patient name.');
      if (!newPatient.patientId.trim()) step2Blockers.push('Enter the patient ID.');
    }
    if (patientMode === 'candidate' || patientMode === 'search') {
      if (!chosenPatient) step2Blockers.push(patientMode === 'candidate' ? 'Select a candidate patient.' : 'Search for and select a patient.');
      else if (!studyChoice) step2Blockers.push('Choose one of the patient\'s studies or a new study.');
    }
  }

  const usedSeries = series.filter(s => filesInSeries(s.ref).length > 0);
  const submitBlockers: string[] = [];
  if (submitting) submitBlockers.push('The import is being submitted.');
  if (!destination) submitBlockers.push('Choose a destination.');
  if (files.length === 0) submitBlockers.push('Add at least one file.');
  const stillUploading = files.filter(f => f.upload !== 'uploaded' && f.upload !== 'failed').length;
  const failedUploads = files.filter(f => f.upload === 'failed').length;
  if (stillUploading) submitBlockers.push(`${stillUploading} file${stillUploading > 1 ? 's are' : ' is'} still uploading.`);
  if (failedUploads) submitBlockers.push(`${failedUploads} upload${failedUploads > 1 ? 's' : ''} failed: retry or remove ${failedUploads > 1 ? 'them' : 'it'} in step 1.`);
  if (!resolved) submitBlockers.push('Choose the patient and study in step 2.');
  else step2Blockers.forEach(b => submitBlockers.push(b));
  const unassigned = files.filter(f => !f.seriesRef || !series.some(s => s.ref === f.seriesRef)).length;
  if (unassigned) submitBlockers.push(`${unassigned} file${unassigned > 1 ? 's have' : ' has'} no series.`);
  const mismatched = files.filter(f => { const s = series.find(x => x.ref === f.seriesRef); return s && s.modality !== f.modality; }).length;
  if (mismatched) submitBlockers.push(`${mismatched} file${mismatched > 1 ? 's are' : ' is'} in a series of another modality.`);
  if (destination?.deidentified && !ack) submitBlockers.push(`Tick "${ACK_LABEL}".`);

  // ---------------------------------------------------------------- submit

  const submit = async () => {
    if (submitBlockers.length || !destination || !resolved) return;
    setSubmitting(true); setSubmitError(null);
    const body: CreateImportBody = {
      destinationKind: destination.kind,
      destinationId: destination.id,
      acknowledgedContentNotDeidentified: destination.deidentified ? ack : false,
      patient: resolved.patient,
      // Descriptive text is clipped to the API's limits (LO 64, title 255); identifiers are not.
      study: { ...resolved.study, studyDescription: clip(resolved.study.studyDescription.trim(), 64) },
      series: usedSeries.map(s => ({
        ref: s.ref, mode: s.mode, seriesInstanceUID: s.mode === 'existing' ? s.seriesInstanceUID : '', modality: s.modality,
        description: clip(s.description.trim(), 64),
      })),
      files: files.map(f => ({
        s3Key: f.s3Key!, fileName: f.name, seriesRef: f.seriesRef!, documentTitle: clip(f.documentTitle.trim(), 255),
        contentDate: isoToDa(f.contentDate), institutionName: clip(f.institutionName.trim(), 64),
        ...(f.modality === 'XC' && f.video ? f.video : {}),
      })),
    };
    try {
      const r = await nonDicomV2Api.createImport(body);
      setImportId(r.importId);
    } catch (e) {
      setSubmitError(errMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------- history

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true); setHistoryError(null);
    try { setHistory(await nonDicomV2Api.listImports()); } catch (e) { setHistoryError(errMsg(e)); } finally { setHistoryLoading(false); }
  }, []);
  useEffect(() => { if (historyOpen) loadHistory(); }, [historyOpen, loadHistory]);

  // ---------------------------------------------------------------- render pieces

  const stepIndex = steps.indexOf(step);
  const goNext = () => { const n = steps[stepIndex + 1]; if (n) setStep(n); };
  const goBack = () => { const p = steps[stepIndex - 1]; if (p) setStep(p); };

  const BlockerList: React.FC<{ items: string[]; id: string; what: string }> = ({ items, id, what }) => (
    items.length ? (
      <div id={id}>
        <Box variant="small" color="text-body-secondary">
          {what} is disabled: {items.join(' ')}
        </Box>
      </div>
    ) : null
  );

  const stepList = (
    <nav aria-label="Import steps">
      <ol style={{ display: 'flex', gap: 24, listStyle: 'none', margin: 0, padding: 0, flexWrap: 'wrap' }}>
        {steps.map((s, i) => {
          const current = s === step;
          const done = i < stepIndex;
          return (
            <li key={s} aria-current={current ? 'step' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-hidden="true" style={{
                width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600,
                border: `2px solid ${current || done ? V2_THEME.primary : V2_THEME.border}`,
                background: done ? V2_THEME.primary : 'transparent', color: done ? V2_THEME.card : current ? V2_THEME.primary : V2_THEME.mutedText,
              }}>{done ? '✓' : i + 1}</span>
              <span style={{ fontWeight: current ? 600 : 400, color: current ? V2_THEME.text : V2_THEME.mutedText, fontSize: 14 }}>
                <span style={srOnly}>Step {i + 1} of {steps.length}{done ? ', completed' : current ? ', current' : ''}: </span>
                {STEP_TITLES[s]}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );

  const uploadStatus = (f: FileItem) => {
    switch (f.upload) {
      case 'preparing': return <StatusIndicator type="loading">Preparing</StatusIndicator>;
      case 'waiting': return <StatusIndicator type="pending">Waiting to upload</StatusIndicator>;
      case 'uploading': return <StatusIndicator type="in-progress">Uploading {pct(f.progress)}</StatusIndicator>;
      case 'uploaded': return <StatusIndicator type="success">Uploaded</StatusIndicator>;
      default: return <StatusIndicator type="error">{f.uploadError || 'Upload failed'}</StatusIndicator>;
    }
  };
  const analysisStatus = (f: FileItem) => {
    switch (f.analysis) {
      case 'waiting': return <StatusIndicator type="pending">{f.upload === 'failed' ? 'Not analysed' : 'Starts after upload'}</StatusIndicator>;
      case 'analysing': return <StatusIndicator type="loading">Analysing</StatusIndicator>;
      case 'analysed': return <StatusIndicator type="success">Analysed</StatusIndicator>;
      case 'skipped': return <StatusIndicator type="stopped">Not analysed (video)</StatusIndicator>;
      default: return <StatusIndicator type="warning">Not analysed{f.analysisReason ? `: ${f.analysisReason}` : ''}</StatusIndicator>;
    }
  };
  const thumb = (f: FileItem) => (f.thumbnail
    ? <img src={f.thumbnail} alt={`Preview of ${f.name}`} style={thumbStyle} />
    : <div style={noThumbStyle} role="img" aria-label={`No preview for ${f.name}`}>No preview</div>);

  const deidAlertStep1 = destination?.deidentified ? (
    <Alert type="warning" header="De-identified folder">{DEID_STEP1_TEXT}</Alert>
  ) : null;

  // ---------------------------------------------------------------- step 1

  const uploadedCount = files.filter(f => f.upload === 'uploaded').length;
  const analysedCount = files.filter(f => f.analysis === 'analysed').length;

  const step1 = (
    <SpaceBetween size="l">
      {destError && (
        <Alert type="error" header="Could not load destinations" action={<Button onClick={loadDestinations}>Retry</Button>}>{destError}</Alert>
      )}
      {fixedDestination && !destLoading && !destError && !destination && (
        <Alert type="error" header="This destination does not accept imports">
          {fixedDestination.name || 'The selected storage or folder'} is read-only, inactive, or you do not have store permission on it.
        </Alert>
      )}
      {fixedStudy && (
        <Container header={<Header variant="h3">Target study</Header>}>
          <ColumnLayout columns={3} variant="text-grid">
            <div><Box variant="awsui-key-label">Patient</Box><Box>{displayPN(fixedStudy.patientName) || '-'} ({fixedStudy.patientId || 'no ID'})</Box></div>
            <div><Box variant="awsui-key-label">Study</Box><Box>{fixedStudy.studyDescription || 'No description'}</Box></div>
            <div><Box variant="awsui-key-label">Study date</Box><Box>{displayDate(fixedStudy.studyDate) || '-'}</Box></div>
          </ColumnLayout>
        </Container>
      )}
      <FormField
        label="Destination"
        description="Only storages and virtual folders you can write into are listed."
        constraintText={files.length > 0 && !fixedDestination ? 'Remove all files (Start over) to change the destination.' : undefined}
      >
        <Select
          ariaLabel="Destination"
          selectedOption={destination ? { label: destination.name, value: `${destination.kind}:${destination.id}` } : null}
          onChange={({ detail }) => {
            const d = destinations.find(x => `${x.kind}:${x.id}` === detail.selectedOption?.value);
            setDestination(d || null);
            setPatientMode(null); selectPatient(null); setSearchResults(null);
          }}
          options={destinations.map(d => ({
            label: d.name,
            value: `${d.kind}:${d.id}`,
            description: d.kind === 'virtualFolder' ? `Virtual folder${d.deidentified ? ', de-identified' : ''}` : 'Storage',
            tags: [...(d.deidentified ? ['de-identified'] : []), ...(d.canAnalyze ? [] : ['no analysis'])],
          }))}
          placeholder={destLoading ? 'Loading destinations' : 'Choose a storage or virtual folder'}
          empty="No writable destinations: you need store permission on an active, writable storage or folder."
          disabled={destLoading || files.length > 0 || !!fixedDestination}
          statusType={destLoading ? 'loading' : 'finished'}
          loadingText="Loading destinations"
          filteringType="auto"
        />
      </FormField>

      {deidAlertStep1}
      {destination && !destination.canAnalyze && (
        <Alert type="info" header="No analysis for this destination">
          You can store into this destination but not read it, so files are not analysed and patients cannot be searched. You will enter the patient yourself.
        </Alert>
      )}

      {destination && (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label="Add files: drop files here or press Enter to browse"
            aria-describedby="ndv2-file-limits"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragOver ? V2_THEME.primary : V2_THEME.border}`, borderRadius: 8, padding: 20, textAlign: 'center', cursor: 'pointer',
              background: dragOver ? V2_THEME.mutedBg : 'transparent',
            }}
          >
            <Box>Drop files here or click to browse</Box>
            <div id="ndv2-file-limits">
              <Box variant="small" color="text-body-secondary">
                PDF, JPEG, PNG up to 100 MB each; MP4, MPEG, MOV up to 2 GB each; at most {MAX_FILES} files.
              </Box>
            </div>
            <input
              ref={fileInputRef} type="file" multiple accept={ACCEPT_ATTR} aria-label="Choose files to import" style={{ display: 'none' }}
              onChange={e => { if (e.target.files) void addFiles(Array.from(e.target.files)); e.target.value = ''; }}
            />
          </div>
          {rejections.length > 0 && (
            <Alert type="error" header="Some files were not added" dismissible onDismiss={() => setRejections([])}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>{rejections.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </Alert>
          )}
          {files.some(f => f.duplicateOf) && (
            <Alert type="warning" header="Duplicate files">
              {files.filter(f => f.duplicateOf).map(f => `${f.name} has the same content as ${f.duplicateOf}.`).join(' ')} Remove the copies unless you want them imported twice.
            </Alert>
          )}
          <div aria-live="polite" style={srOnly}>
            {files.length > 0 ? `${uploadedCount} of ${files.length} files uploaded. ${analysedCount} analysed.` : ''}
          </div>
          <Table
            variant="embedded"
            items={files}
            trackBy="localId"
            header={<Header variant="h3" counter={files.length ? `(${files.length})` : undefined}>Files</Header>}
            empty={<Box textAlign="center" padding="s" color="text-body-secondary">No files yet</Box>}
            columnDefinitions={[
              { id: 'preview', header: 'Preview', cell: f => thumb(f), width: 80 },
              {
                id: 'name', header: 'File', isRowHeader: true, cell: f => (
                  <div>
                    <Box>{f.name}</Box>
                    <Box variant="small" color="text-body-secondary">{formatBytes(f.size)}</Box>
                    {f.duplicateOf && <Box variant="small" color="text-status-warning">Same content as {f.duplicateOf}</Box>}
                  </div>
                ),
              },
              { id: 'type', header: 'Type', cell: f => <ModalityBadge modality={f.modality} /> },
              { id: 'upload', header: 'Upload', cell: f => uploadStatus(f) },
              { id: 'analysis', header: 'Analysis', cell: f => analysisStatus(f) },
              {
                id: 'actions', header: 'Actions', cell: f => (
                  <SpaceBetween direction="horizontal" size="xs">
                    {f.upload === 'failed' && <Button variant="inline-link" ariaLabel={`Retry upload of ${f.name}`} onClick={() => retryUpload(f)}>Retry</Button>}
                    <Button variant="inline-link" ariaLabel={`Remove ${f.name}`} onClick={() => removeFile(f.localId)}>Remove</Button>
                  </SpaceBetween>
                ),
              },
            ]}
          />
        </>
      )}
    </SpaceBetween>
  );

  // ---------------------------------------------------------------- step 2

  const newStudyForm = (
    <ColumnLayout columns={2}>
      <FormField label="Study description">
        <Input ariaLabel="Study description" value={newStudy.studyDescription} onChange={({ detail }) => setNewStudy(s => ({ ...s, studyDescription: detail.value }))} />
      </FormField>
      <FormField label="Study date">
        <DatePicker ariaLabel="Study date" value={newStudy.studyDate} onChange={({ detail }) => setNewStudy(s => ({ ...s, studyDate: detail.value }))} placeholder="YYYY/MM/DD" />
      </FormField>
      <FormField label="Accession number">
        <Input ariaLabel="Accession number" value={newStudy.accessionNumber} onChange={({ detail }) => setNewStudy(s => ({ ...s, accessionNumber: detail.value }))} />
      </FormField>
      <FormField label="Referring physician" description="DICOM name format: Last^First">
        <Input ariaLabel="Referring physician" value={newStudy.referringPhysician} onChange={({ detail }) => setNewStudy(s => ({ ...s, referringPhysician: detail.value }))} />
      </FormField>
    </ColumnLayout>
  );

  const studyPicker = chosenPatient ? (
    <Container header={<Header variant="h3" description={`${displayPN(chosenPatient.patientName)} (${chosenPatient.patientId})`}>Study</Header>}>
      <SpaceBetween size="m">
        <Table
          variant="embedded"
          items={chosenPatient.studies}
          trackBy="studyInstanceUID"
          selectionType="single"
          selectedItems={chosenPatient.studies.filter(s => s.studyInstanceUID === studyChoice)}
          onSelectionChange={({ detail }) => { const s = detail.selectedItems[0]; if (s) setStudyChoice(s.studyInstanceUID); }}
          ariaLabels={{
            selectionGroupLabel: 'Studies',
            itemSelectionLabel: (_s, st) => `Select study ${st.description || st.studyInstanceUID}`,
          }}
          columnDefinitions={[
            { id: 'desc', header: 'Study description', isRowHeader: true, cell: s => s.description || 'No description' },
            { id: 'date', header: 'Study date', cell: s => displayDate(s.studyDate) || '-' },
            { id: 'modality', header: 'Modality', cell: s => (s.modalities && s.modalities.length ? s.modalities.join(', ') : '-') },
            { id: 'accession', header: 'Accession number', cell: s => s.accessionNumber || '-' },
          ]}
          empty={<Box textAlign="center" padding="s">This patient has no studies yet.</Box>}
        />
        <RadioGroup
          ariaLabel="Create a new study"
          name="ndv2-study-new"
          value={studyChoice === 'new' ? 'new' : null}
          onChange={({ detail }) => setStudyChoice(detail.value)}
          items={[{ value: 'new', label: 'New study for this patient' }]}
        />
        {studyChoice === 'new' && newStudyForm}
      </SpaceBetween>
    </Container>
  ) : null;

  const step2 = (
    <SpaceBetween size="l">
      {analysingCount > 0 && (
        <Alert type="info" header="Analysis is still running">
          {analysingCount} file{analysingCount > 1 ? 's are' : ' is'} still being uploaded or analysed. Candidates and fields update as results arrive.
        </Alert>
      )}
      {videoOnly && <Alert type="info">Videos are not analysed. Search for the patient in this destination or enter a new patient.</Alert>}
      {disagreement.length > 0 && (
        <Alert type="warning" header="The files may belong to different patients">
          {disagreement.join(' ')} All files of one import go to one patient. Remove files that belong to someone else and import them separately.
        </Alert>
      )}

      {bestFields.length > 0 && (
        <ExpandableSection headerText={`Extracted fields (${bestFields.length})`} defaultExpanded>
          <Table
            variant="embedded"
            items={bestFields}
            trackBy="key"
            columnDefinitions={[
              { id: 'field', header: 'Field', isRowHeader: true, cell: b => FIELD_LABELS[b.key] || b.key },
              { id: 'value', header: 'Value', cell: b => (b.key === 'patientName' || b.key === 'referringPhysician') ? displayPN(b.value) : (b.key === 'birthDate' || b.key === 'documentDate') ? displayDate(b.value) : b.value },
              { id: 'conf', header: 'Confidence', cell: b => <Badge color={confidenceColor(b.confidence)}>{pct(b.confidence)}</Badge> },
              { id: 'evidence', header: 'Evidence (text it was read from)', cell: b => b.evidence ? <Box variant="small">&ldquo;{b.evidence}&rdquo;</Box> : '-' },
              { id: 'file', header: 'File', cell: b => b.fileName },
            ]}
          />
        </ExpandableSection>
      )}

      <FormField label="Patient" description="The analysis never selects a patient for you. Confirm the patient for these files.">
        <Tiles
          ariaLabel="How to set the patient"
          value={patientMode}
          onChange={({ detail }) => { setPatientMode(detail.value as PatientMode); selectPatient(null); }}
          columns={3}
          items={[
            {
              value: 'candidate', label: 'Matched patient',
              description: candidates.length ? `${candidates.length} candidate${candidates.length > 1 ? 's' : ''} found in this destination` : 'No candidates found',
              disabled: candidates.length === 0,
            },
            { value: 'new', label: 'New patient', description: analysedFiles.length ? 'Pre-filled from the analysis; all fields editable' : 'Enter the patient details' },
            {
              value: 'search', label: 'Search patients', description: destination?.canAnalyze ? 'Find a patient in this destination by name or ID' : 'Needs read permission on this destination',
              disabled: !destination?.canAnalyze,
            },
          ]}
        />
      </FormField>

      {patientMode === 'candidate' && (
        <Table
          items={candidates}
          trackBy="patientId"
          selectionType="single"
          selectedItems={chosenPatient ? candidates.filter(c => c.patientId === chosenPatient.patientId) : []}
          onSelectionChange={({ detail }) => { const c = detail.selectedItems[0]; selectPatient(c ? { ...c } : null); }}
          ariaLabels={{
            selectionGroupLabel: 'Candidate patients',
            itemSelectionLabel: (_s, c) => `Select ${displayPN(c.patientName)} (${c.patientId})`,
            allItemsSelectionLabel: () => 'Select all',
          }}
          header={<Header variant="h3" counter={`(${candidates.length})`} description="Ranked by how well each patient matches the extracted fields.">Candidate patients</Header>}
          columnDefinitions={[
            { id: 'name', header: 'Patient name', isRowHeader: true, cell: c => displayPN(c.patientName) },
            { id: 'id', header: 'Patient ID', cell: c => c.patientId },
            { id: 'dob', header: 'Birth date', cell: c => displayDate(c.birthDate) || '-' },
            { id: 'sex', header: 'Sex', cell: c => c.sex || '-' },
            { id: 'score', header: 'Match', cell: c => <Badge color={confidenceColor(c.score)}>{pct(c.score)}</Badge> },
            { id: 'reasons', header: 'Why', cell: c => c.reasons?.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{c.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul> : '-' },
          ]}
          empty={<Box textAlign="center" padding="s">No candidates</Box>}
        />
      )}

      {patientMode === 'search' && (
        <SpaceBetween size="m">
          <FormField label="Search" constraintText="Patient name or ID, at least 2 characters." errorText={searchError || undefined}>
            <SpaceBetween direction="horizontal" size="xs">
              <Input
                ariaLabel="Patient name or ID"
                type="search"
                value={searchQ}
                onChange={({ detail }) => setSearchQ(detail.value)}
                onKeyDown={({ detail }) => { if (detail.key === 'Enter') void runSearch(); }}
                placeholder="e.g. DOE or MRN123"
              />
              <Button onClick={() => void runSearch()} disabled={searchQ.trim().length < 2 || searchLoading} loading={searchLoading}>Search</Button>
            </SpaceBetween>
          </FormField>
          {searchResults && (
            <Table
              items={searchResults}
              trackBy="patientId"
              selectionType="single"
              selectedItems={chosenPatient ? searchResults.filter(p => p.patientId === chosenPatient.patientId) : []}
              onSelectionChange={({ detail }) => { const p = detail.selectedItems[0]; selectPatient(p ? { ...p } : null); }}
              ariaLabels={{
                selectionGroupLabel: 'Search results',
                itemSelectionLabel: (_s, p) => `Select ${displayPN(p.patientName)} (${p.patientId})`,
                allItemsSelectionLabel: () => 'Select all',
              }}
              header={<Header variant="h3" counter={`(${searchResults.length})`}>Patients</Header>}
              columnDefinitions={[
                { id: 'name', header: 'Patient name', isRowHeader: true, cell: p => displayPN(p.patientName) },
                { id: 'id', header: 'Patient ID', cell: p => p.patientId },
                { id: 'dob', header: 'Birth date', cell: p => displayDate(p.birthDate) || '-' },
                { id: 'sex', header: 'Sex', cell: p => p.sex || '-' },
                { id: 'studies', header: 'Studies', cell: p => p.studies?.length ?? 0 },
              ]}
              empty={<Box textAlign="center" padding="s">No patients match &ldquo;{searchQ}&rdquo;</Box>}
            />
          )}
        </SpaceBetween>
      )}

      {(patientMode === 'candidate' || patientMode === 'search') && studyPicker}

      {patientMode === 'new' && (
        <Container header={<Header variant="h3" actions={analysedFiles.length ? <Button onClick={fillNewFromAnalysis}>Fill from analysis</Button> : undefined}>New patient and study</Header>}>
          <SpaceBetween size="m">
            <ColumnLayout columns={2}>
              <FormField label="Patient name" description="DICOM name format: Last^First">
                <Input ariaLabel="Patient name" value={newPatient.patientName} invalid={!newPatient.patientName.trim()} onChange={({ detail }) => setNewPatient(p => ({ ...p, patientName: detail.value }))} placeholder="DOE^JANE" />
              </FormField>
              <FormField label="Patient ID">
                <Input ariaLabel="Patient ID" value={newPatient.patientId} invalid={!newPatient.patientId.trim()} onChange={({ detail }) => setNewPatient(p => ({ ...p, patientId: detail.value }))} />
              </FormField>
              <FormField label="Birth date">
                <DatePicker ariaLabel="Birth date" value={newPatient.birthDate} onChange={({ detail }) => setNewPatient(p => ({ ...p, birthDate: detail.value }))} placeholder="YYYY/MM/DD" />
              </FormField>
              <FormField label="Sex">
                <Select
                  ariaLabel="Sex"
                  selectedOption={newPatient.sex ? { label: newPatient.sex, value: newPatient.sex } : null}
                  options={SEX_OPTIONS}
                  onChange={({ detail }) => setNewPatient(p => ({ ...p, sex: detail.selectedOption?.value || '' }))}
                  placeholder="Choose"
                />
              </FormField>
            </ColumnLayout>
            {newStudyForm}
          </SpaceBetween>
        </Container>
      )}
    </SpaceBetween>
  );

  // ---------------------------------------------------------------- step 3

  const seriesLabel = (s: SeriesGroup) => `${s.description || DEFAULT_SERIES_DESC[s.modality]} (${s.modality}, ${s.mode === 'existing' ? 'existing' : 'new'})`;

  const patientSummary = resolved ? (
    <ColumnLayout columns={3} variant="text-grid">
      <div>
        <Box variant="awsui-key-label">Patient</Box>
        <Box>{displayPN(resolved.patient.patientName) || '-'} ({resolved.patient.patientId || 'no ID'}){resolved.patient.mode === 'new' ? ', new' : ''}</Box>
      </div>
      <div>
        <Box variant="awsui-key-label">Study</Box>
        <Box>{resolved.study.studyDescription || 'No description'}{resolved.study.mode === 'new' ? ', new' : ''}</Box>
      </div>
      <div><Box variant="awsui-key-label">Destination</Box><Box>{destination?.name}</Box></div>
    </ColumnLayout>
  ) : null;

  const step3 = (
    <SpaceBetween size="l">
      <Container header={<Header variant="h3">Summary</Header>}>{patientSummary || <Box color="text-status-error">Choose the patient and study in step 2.</Box>}</Container>

      <Table
        variant="embedded"
        items={series}
        trackBy="ref"
        header={
          <Header
            variant="h3"
            description="Files are grouped into one new series per type. Rename a series, add another, or move files into an existing compatible series of the study."
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Select
                  ariaLabel="Type of the new series"
                  selectedOption={addSeriesModality ? { label: MODALITY_LABEL[addSeriesModality], value: addSeriesModality } : null}
                  options={modalitiesPresent.map(m => ({ label: MODALITY_LABEL[m], value: m }))}
                  onChange={({ detail }) => setAddSeriesModality((detail.selectedOption?.value || '') as V2Modality | '')}
                  placeholder="Series type"
                />
                <Button disabled={!addSeriesModality} onClick={() => { if (addSeriesModality) addNewSeries(addSeriesModality); }}>Add new series</Button>
                {existingStudyUid && (
                  <>
                    <Select
                      ariaLabel="Existing series of the study"
                      selectedOption={addExistingUid ? { label: compatibleExisting.find(s => s.seriesInstanceUID === addExistingUid)?.seriesDescription || addExistingUid, value: addExistingUid } : null}
                      options={compatibleExisting.map(s => ({ label: s.seriesDescription || `Series ${s.seriesNumber}`, value: s.seriesInstanceUID, description: `${s.modality}, ${s.numberOfSeriesRelatedInstances ?? 0} instances` }))}
                      onChange={({ detail }) => setAddExistingUid(detail.selectedOption?.value || '')}
                      placeholder={existingSeriesLoading ? 'Loading series' : 'Existing series'}
                      empty="No compatible existing series (DOC, SC or XC)"
                      statusType={existingSeriesLoading ? 'loading' : 'finished'}
                    />
                    <Button disabled={!addExistingUid} onClick={() => { addExistingSeries(addExistingUid); setAddExistingUid(''); }}>Use existing series</Button>
                  </>
                )}
              </SpaceBetween>
            }
          >
            Series
          </Header>
        }
        columnDefinitions={[
          {
            id: 'desc', header: 'Description', isRowHeader: true, cell: s => s.mode === 'new'
              ? <Input ariaLabel={`Description of ${s.modality} series`} value={s.description} onChange={({ detail }) => setSeries(prev => prev.map(x => x.ref === s.ref ? { ...x, description: detail.value } : x))} />
              : <Box>{s.description}</Box>,
          },
          { id: 'mod', header: 'Type', cell: s => <ModalityBadge modality={s.modality} /> },
          { id: 'kind', header: 'Series', cell: s => s.mode === 'existing' ? 'Existing' : 'New' },
          { id: 'files', header: 'Files', cell: s => filesInSeries(s.ref).length },
          {
            id: 'act', header: 'Actions', cell: s => (
              <Button variant="inline-link" ariaLabel={`Remove series ${s.description}`} disabled={filesInSeries(s.ref).length > 0} onClick={() => removeSeries(s.ref)}>Remove</Button>
            ),
          },
        ]}
        empty={<Box textAlign="center" padding="s">No series</Box>}
      />

      <Table
        variant="embedded"
        items={files}
        trackBy="localId"
        header={<Header variant="h3" description="Document fields are pre-filled from the analysis and written into each DICOM file.">Files</Header>}
        columnDefinitions={[
          { id: 'preview', header: 'Preview', cell: f => thumb(f), width: 80 },
          { id: 'name', header: 'File', isRowHeader: true, cell: f => <div><Box>{f.name}</Box><ModalityBadge modality={f.modality} /></div> },
          {
            id: 'series', header: 'Series', minWidth: 200, cell: f => {
              const opts = series.filter(s => s.modality === f.modality).map(s => ({ label: seriesLabel(s), value: s.ref }));
              const cur = series.find(s => s.ref === f.seriesRef);
              return (
                <Select
                  ariaLabel={`Series for ${f.name}`}
                  selectedOption={cur ? { label: seriesLabel(cur), value: cur.ref } : null}
                  options={opts}
                  onChange={({ detail }) => patchFile(f.localId, { seriesRef: detail.selectedOption?.value || null })}
                  placeholder="Choose a series"
                  invalid={!cur}
                />
              );
            },
          },
          {
            id: 'title', header: 'Document title', minWidth: 160, cell: f => (
              <Input ariaLabel={`Document title for ${f.name}`} value={f.documentTitle} onChange={({ detail }) => patchFile(f.localId, { documentTitle: detail.value, metaTouched: true })} />
            ),
          },
          {
            id: 'date', header: 'Content date', minWidth: 160, cell: f => (
              <DatePicker ariaLabel={`Content date for ${f.name}`} value={f.contentDate} onChange={({ detail }) => patchFile(f.localId, { contentDate: detail.value, metaTouched: true })} placeholder="YYYY/MM/DD" />
            ),
          },
          {
            id: 'inst', header: 'Institution', minWidth: 160, cell: f => (
              <Input ariaLabel={`Institution for ${f.name}`} value={f.institutionName} onChange={({ detail }) => patchFile(f.localId, { institutionName: detail.value, metaTouched: true })} />
            ),
          },
        ]}
      />

      {destination?.deidentified && (
        <Alert type={printedNotes.length ? 'error' : 'warning'} header={printedNotes.length ? 'Patient details found printed in the files' : 'De-identified folder'}>
          <SpaceBetween size="s">
            <Box>{DEID_STEP1_TEXT}</Box>
            {printedNotes.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{printedNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
            <Checkbox checked={ack} onChange={({ detail }) => setAck(detail.checked)}>{ACK_LABEL}</Checkbox>
          </SpaceBetween>
        </Alert>
      )}

      {submitError && <Alert type="error" header="The import was not created">{submitError}</Alert>}
    </SpaceBetween>
  );

  // ---------------------------------------------------------------- tracking view

  if (importId) {
    return (
      <SpaceBetween size="l">
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              {onClose && <Button onClick={onClose}>Close</Button>}
              <Button variant="primary" onClick={resetAll}>Start another import</Button>
            </SpaceBetween>
          }
        >
          Import submitted
        </Header>
        <ImportStatusPanel importId={importId} />
      </SpaceBetween>
    );
  }

  const nextBlockers = step === 'files' ? step1Blockers : step === 'patient' ? step2Blockers : [];
  const isLast = stepIndex === steps.length - 1;

  return (
    <SpaceBetween size="l">
      <Header
        variant="h2"
        description="Import PDFs, images and videos as DICOM. Documents and images are analysed to suggest the patient; you always confirm it."
        actions={files.length > 0 ? <Button onClick={resetAll} disabled={submitting}>Start over</Button> : undefined}
      >
        {attachMode ? 'Attach files to study' : 'Non-DICOM Import (V2)'}
      </Header>

      {stepList}

      <Container header={<Header variant="h2" headingTagOverride="h3">{`Step ${stepIndex + 1}: ${STEP_TITLES[step]}`}</Header>}>
        {step === 'files' ? step1 : step === 'patient' ? step2 : step3}
      </Container>

      <SpaceBetween size="xs">
        <SpaceBetween direction="horizontal" size="xs">
          {stepIndex > 0 && <Button onClick={goBack} disabled={submitting}>Back</Button>}
          {!isLast && (
            <Button variant="primary" onClick={goNext} disabled={nextBlockers.length > 0} ariaDescribedby={nextBlockers.length ? 'ndv2-next-blockers' : undefined}>
              Next
            </Button>
          )}
          {isLast && (
            <Button variant="primary" onClick={() => void submit()} loading={submitting} disabled={submitBlockers.length > 0} ariaDescribedby={submitBlockers.length ? 'ndv2-submit-blockers' : undefined}>
              Submit import
            </Button>
          )}
        </SpaceBetween>
        {!isLast && <BlockerList items={nextBlockers} id="ndv2-next-blockers" what="Next" />}
        {isLast && <BlockerList items={submitBlockers.filter(b => b !== 'The import is being submitted.')} id="ndv2-submit-blockers" what="Submit" />}
      </SpaceBetween>

      {!attachMode && (
        <ExpandableSection headerText="My recent V2 imports" expanded={historyOpen} onChange={({ detail }) => setHistoryOpen(detail.expanded)}>
          <SpaceBetween size="s">
            {historyError && <Alert type="error" header="Could not load imports">{historyError}</Alert>}
            <Table
              variant="embedded"
              items={history}
              trackBy="id"
              loading={historyLoading}
              loadingText="Loading imports"
              header={<Header variant="h3" actions={<Button iconName="refresh" ariaLabel="Refresh imports" onClick={loadHistory} />}>Imports</Header>}
              columnDefinitions={[
                { id: 'created', header: 'Created', cell: i => i.createdAt ? new Date(i.createdAt).toLocaleString() : '-' },
                { id: 'status', header: 'Status', cell: i => <ImportStatusIndicator status={String(i.status || '').toUpperCase()} /> },
                { id: 'dest', header: 'Destination', cell: i => (i.destinationKind && i.destinationId ? destNameById.get(`${i.destinationKind}:${i.destinationId}`) || i.destinationId : '-') },
                { id: 'files', header: 'Files', cell: i => (typeof i.fileCount === 'number' ? i.fileCount : '-') },
                { id: 'by', header: 'Created by', cell: i => i.createdBy || '-' },
                { id: 'view', header: 'Details', cell: i => <Button variant="inline-link" ariaLabel={`View import ${i.id}`} onClick={() => setHistoryViewId(i.id)}>View</Button> },
              ]}
              empty={<Box textAlign="center" padding="s">No V2 imports yet</Box>}
            />
          </SpaceBetween>
        </ExpandableSection>
      )}

      <Modal visible={!!historyViewId} onDismiss={() => setHistoryViewId(null)} header="Import status" size="large" closeAriaLabel="Close import status">
        {historyViewId && <ImportStatusPanel importId={historyViewId} />}
      </Modal>
    </SpaceBetween>
  );
};

export default NonDicomImportV2;
