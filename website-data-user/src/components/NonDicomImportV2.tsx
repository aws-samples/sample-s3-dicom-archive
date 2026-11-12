/**
 * Non-DICOM Import V2, data-user site (plans/NON-DICOM-IMPORT-REDESIGN.md,
 * binding API plans/NON-DICOM-IMPORT-V2-CONTRACT.md).
 *
 * Step 1: destination + files (upload to presigned URLs, per-file analysis when
 *         the destination allows it, duplicate warning, de-id folder warning).
 * Step 2: patient + study (extracted fields with evidence, ranked candidates,
 *         manual search, pre-filled new patient). Skipped when attaching to a study.
 * Step 3: series per modality, per-file document fields, de-id acknowledgement,
 *         submit, then per-file status until the files are indexed.
 *
 * Written against the Cloudscape component API, which vite.config.ts aliases to
 * the src/ui kit. No colours are set here: theme tokens come from the kit.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Badge, Box, Button, Checkbox, ColumnLayout, Container, ExpandableSection, FormField, Header, Input,
  KeyValuePairs, RadioGroup, Select, SpaceBetween, Spinner, StatusIndicator, Table, Tiles,
} from '@cloudscape-design/components';
import {
  AnalyzeResult, apiErrorMessage, CreateImportBody, Destination, DestinationKind, ImportDetail, nonDicomImportV2Service,
  PatientRecord, StudyRef, putToPresignedUrl, V2Modality,
} from '../services/nonDicomImportV2Service';
import { dicomwebService, DICOMSeries } from '../services/dicomwebService';
import { configService } from '../services/configService';
import {
  ACCEPT, clip64, DEFAULT_SERIES_DESCRIPTION, detectType, FIELD_LABELS, FIELD_ORDER, FileAnalysis, findDisagreements,
  findMismatchWithPatient, formatBytes, formatDA, formatPN, formatValue, MAX_FILES, mergeCandidates, mergeFields,
  MODALITY_LABEL, printedIdentifierNotes, readVideoMetadata, sha256OfFile, sizeCap, toDA,
} from './nonDicomImportV2/helpers';
import type { VideoMetadata } from './nonDicomImportV2/helpers';

type SIType = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'in-progress' | 'loading' | 'stopped';

export interface FixedStudy {
  studyInstanceUID: string;
  patientId: string;
  patientName?: string;
  birthDate?: string;
  sex?: string;
  studyDescription?: string;
  studyDate?: string;
  accessionNumber?: string;
}

export interface NonDicomImportV2Props {
  /** Cancel / Close. Asked for confirmation first when files would be discarded. */
  onClose?: () => void;
  /** Attach-to-study entry: destination and study are fixed, step 2 is skipped. */
  fixedDestination?: { kind: DestinationKind; id: string };
  fixedStudy?: FixedStudy;
  /** Rendered inside a modal: no page header. */
  embedded?: boolean;
  /** True while there is uploaded, unsubmitted work that closing would discard. */
  onDirtyChange?: (dirty: boolean) => void;
}

type UploadStatus = 'requesting' | 'queued' | 'uploading' | 'uploaded' | 'failed';
type AnalysisStatus = 'none' | 'skipped' | 'queued' | 'running' | 'done' | 'not_analysed' | 'failed';

interface LocalFile {
  localId: string;
  file: File;
  name: string;
  size: number;
  contentType: string;
  typeLabel: string;
  modality: V2Modality;
  previewUrl?: string;
  sha256?: string;
  uploadStatus: UploadStatus;
  uploadProgress: number;
  uploadError?: string;
  s3Key?: string;
  analysisStatus: AnalysisStatus;
  analysis?: AnalyzeResult;
  analysisMessage?: string;
  documentTitle: string;
  contentDate: string;
  institutionName: string;
  seriesRef?: string;
  /** Video only: dimensions read in the browser; null when it cannot decode the file. */
  video?: VideoMetadata | null;
}

interface SeriesDraft {
  ref: string;
  mode: 'new' | 'existing';
  seriesInstanceUID: string;
  modality: V2Modality;
  description: string;
  seriesNumber?: string;
}

const UPLOAD_CONCURRENCY = 3;
const ANALYSIS_CONCURRENCY = 2;
const POLL_FAST_MS = 3000;
const POLL_SLOW_MS = 10000;
const POLL_FAST_FOR_MS = 2 * 60 * 1000;
const POLL_GIVE_UP_MS = 30 * 60 * 1000;
const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'FAILED']);
const destKey = (d: { kind: string; id: string }) => `${d.kind}:${d.id}`;
let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const SEX_OPTIONS = [
  { label: 'Not specified', value: '' },
  { label: 'Female (F)', value: 'F' },
  { label: 'Male (M)', value: 'M' },
  { label: 'Other (O)', value: 'O' },
];

const FILE_STATUS: Record<string, { type: SIType; text: string }> = {
  PENDING: { type: 'pending', text: 'Waiting' },
  ENCAPSULATING: { type: 'in-progress', text: 'Converting to DICOM' },
  WRITTEN: { type: 'in-progress', text: 'Stored, waiting for indexing' },
  INDEXED: { type: 'success', text: 'Imported' },
  FAILED: { type: 'error', text: 'Failed' },
};

function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <nav aria-label="Import steps">
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 24 }}>
        {steps.map((s, i) => (
          <li key={s} aria-current={i === current ? 'step' : undefined}>
            <Box color={i === current ? 'inherit' : 'text-body-secondary'} fontWeight={i === current ? 'bold' : 'normal'}>
              {`Step ${i + 1}: ${s}`}
            </Box>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const NonDicomImportV2: React.FC<NonDicomImportV2Props> = ({ onClose, fixedDestination, fixedStudy, embedded, onDirtyChange }) => {
  const attachMode = !!(fixedDestination && fixedStudy);

  // ----- destinations -----
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [destLoading, setDestLoading] = useState(true);
  const [destError, setDestError] = useState('');
  const [destSel, setDestSel] = useState<string>(fixedDestination ? destKey(fixedDestination) : '');
  const dest = destinations.find(d => destKey(d) === destSel);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDestLoading(true);
      const list = await nonDicomImportV2Service.getDestinations();
      if (cancelled) return;
      setDestinations(list);
      if (fixedDestination && !list.some(d => destKey(d) === destKey(fixedDestination))) {
        setDestError('You cannot import files into this storage or folder (it is read-only or you do not have the store privilege).');
      } else if (!fixedDestination && list.length === 1) {
        setDestSel(destKey(list[0]));
      } else if (list.length === 0) {
        setDestError('No writable storage or folder is available to you.');
      }
      setDestLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- files -----
  const [files, setFiles] = useState<LocalFile[]>([]);
  const filesRef = useRef<LocalFile[]>([]);
  filesRef.current = files;
  const [addErrors, setAddErrors] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const aborters = useRef(new Map<string, AbortController>());
  // Presigned target per file, kept in a ref so the upload worker never waits for a render.
  const targets = useRef(new Map<string, { s3Key: string; uploadUrl: string }>());
  const mounted = useRef(true);

  const patchFile = useCallback((id: string, patch: Partial<LocalFile> | ((f: LocalFile) => Partial<LocalFile>)) => {
    if (!mounted.current) return;
    setFiles(prev => prev.map(f => (f.localId === id ? { ...f, ...(typeof patch === 'function' ? patch(f) : patch) } : f)));
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      aborters.current.forEach(a => a.abort());
      filesRef.current.forEach(f => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    };
  }, []);

  // ----- upload + analysis queues -----
  const uploadQueue = useRef<string[]>([]);
  const uploadsActive = useRef(0);
  const analysisQueue = useRef<string[]>([]);
  const analysesActive = useRef(0);
  const destRef = useRef<Destination | undefined>(undefined);
  destRef.current = dest;

  const runAnalysis = useCallback(async (id: string) => {
    const t = targets.current.get(id);
    const d = destRef.current;
    if (!t || !d || !filesRef.current.some(x => x.localId === id)) return;
    patchFile(id, { analysisStatus: 'running' });
    try {
      const result = await nonDicomImportV2Service.analyze(d.kind, d.id, t.s3Key);
      const fields = result.fields || {};
      patchFile(id, cur => ({
        analysis: result,
        analysisStatus: result.status === 'ANALYSED' ? 'done' : 'not_analysed',
        analysisMessage: result.status === 'ANALYSED' ? undefined : (result.reason || 'The file could not be analysed.'),
        documentTitle: cur.documentTitle || clip64(fields.documentTitle?.value || fields.documentType?.value || ''),
        contentDate: cur.contentDate || (toDA(fields.documentDate?.value || '') || ''),
        institutionName: cur.institutionName || clip64(fields.institution?.value || ''),
      }));
    } catch (error: any) {
      patchFile(id, { analysisStatus: 'failed', analysisMessage: apiErrorMessage(error, 'Analysis failed.') });
    }
  }, [patchFile]);

  const pumpAnalysis = useCallback(() => {
    while (analysesActive.current < ANALYSIS_CONCURRENCY && analysisQueue.current.length) {
      const id = analysisQueue.current.shift()!;
      analysesActive.current++;
      runAnalysis(id).finally(() => { analysesActive.current--; pumpAnalysis(); });
    }
  }, [runAnalysis]);

  const startAnalysisFor = useCallback((f: LocalFile) => {
    const d = destRef.current;
    if (!d?.canAnalyze || f.modality === 'XC') {
      patchFile(f.localId, { analysisStatus: 'skipped' });
      return;
    }
    patchFile(f.localId, { analysisStatus: 'queued' });
    analysisQueue.current.push(f.localId);
    pumpAnalysis();
  }, [patchFile, pumpAnalysis]);

  const runUpload = useCallback(async (id: string) => {
    const f = filesRef.current.find(x => x.localId === id);
    const t = targets.current.get(id);
    if (!f || !t) return;
    const ctl = new AbortController();
    aborters.current.set(id, ctl);
    patchFile(id, { uploadStatus: 'uploading', uploadProgress: 0, uploadError: undefined });
    let lastPct = -1;
    try {
      await putToPresignedUrl(t.uploadUrl, f.file, f.contentType, (fr) => {
        const pct = Math.round(fr * 100);
        if (pct !== lastPct) { lastPct = pct; patchFile(id, { uploadProgress: pct }); }
      }, ctl.signal);
      patchFile(id, { uploadStatus: 'uploaded', uploadProgress: 100 });
      startAnalysisFor(f);
    } catch (error: any) {
      patchFile(id, { uploadStatus: 'failed', uploadError: error?.message || 'Upload failed.' });
    } finally {
      aborters.current.delete(id);
    }
  }, [patchFile, startAnalysisFor]);

  const pumpUploads = useCallback(() => {
    while (uploadsActive.current < UPLOAD_CONCURRENCY && uploadQueue.current.length) {
      const id = uploadQueue.current.shift()!;
      uploadsActive.current++;
      runUpload(id).finally(() => { uploadsActive.current--; pumpUploads(); });
    }
  }, [runUpload]);

  /** Ask the API for presigned URLs for these files, then queue their uploads. */
  const requestUrlsAndUpload = useCallback(async (batch: LocalFile[]) => {
    const d = destRef.current;
    if (!d || batch.length === 0) return;
    try {
      const res = await nonDicomImportV2Service.getUploadUrls(d.kind, d.id,
        batch.map(f => ({ name: f.name, contentType: f.contentType, size: f.size })));
      const got = res?.files || [];
      batch.forEach((f, i) => {
        const u = got[i];
        if (!u?.uploadUrl || !u?.s3Key) {
          patchFile(f.localId, { uploadStatus: 'failed', uploadError: 'No upload link was returned for this file.' });
          return;
        }
        targets.current.set(f.localId, { s3Key: u.s3Key, uploadUrl: u.uploadUrl });
        patchFile(f.localId, { uploadStatus: 'queued', s3Key: u.s3Key });
        uploadQueue.current.push(f.localId);
      });
      pumpUploads();
    } catch (error: any) {
      const msg = apiErrorMessage(error, 'Could not prepare the upload.');
      batch.forEach(f => patchFile(f.localId, { uploadStatus: 'failed', uploadError: msg }));
    }
  }, [patchFile, pumpUploads]);

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    const errors: string[] = [];
    if (!destRef.current) {
      setAddErrors(['Choose a destination before adding files.']);
      return;
    }
    const room = MAX_FILES - filesRef.current.length;
    if (incoming.length > room) {
      errors.push(`An import holds at most ${MAX_FILES} files; ${incoming.length - Math.max(0, room)} file(s) were not added.`);
    }
    const accepted: LocalFile[] = [];
    for (const file of incoming.slice(0, Math.max(0, room))) {
      if (file.size === 0) { errors.push(`${file.name} is empty.`); continue; }
      let t;
      try { t = await detectType(file); } catch { t = null; }
      if (!t) { errors.push(`${file.name} is not a PDF, JPEG, PNG, MP4, MPEG or MOV file.`); continue; }
      const cap = sizeCap(t.modality);
      if (file.size > cap) { errors.push(`${file.name} is larger than ${formatBytes(cap)} (${t.label} limit).`); continue; }
      accepted.push({
        localId: newId('f'), file, name: file.name, size: file.size, contentType: t.contentType, typeLabel: t.label,
        modality: t.modality, previewUrl: t.modality === 'SC' ? URL.createObjectURL(file) : undefined,
        uploadStatus: 'requesting', uploadProgress: 0, analysisStatus: 'none',
        documentTitle: '', contentDate: '', institutionName: '',
      });
    }
    setAddErrors(errors);
    if (!accepted.length) return;
    setFiles(prev => [...prev, ...accepted]);
    filesRef.current = [...filesRef.current, ...accepted];
    // Video dimensions for the DICOM header, read while the upload runs.
    accepted.filter(f => f.modality === 'XC').forEach(f => {
      readVideoMetadata(f.file).catch(() => null).then(video => {
        if (filesRef.current.some(x => x.localId === f.localId)) patchFile(f.localId, { video });
      });
    });
    await requestUrlsAndUpload(accepted);
  }, [requestUrlsAndUpload, patchFile]);

  const retryUpload = (f: LocalFile) => {
    patchFile(f.localId, { uploadStatus: 'requesting', uploadError: undefined, uploadProgress: 0 });
    requestUrlsAndUpload([f]);
  };

  const removeFile = (f: LocalFile) => {
    aborters.current.get(f.localId)?.abort();
    uploadQueue.current = uploadQueue.current.filter(x => x !== f.localId);
    analysisQueue.current = analysisQueue.current.filter(x => x !== f.localId);
    targets.current.delete(f.localId);
    if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    filesRef.current = filesRef.current.filter(x => x.localId !== f.localId);
    setFiles(prev => prev.filter(x => x.localId !== f.localId));
  };

  const removeAll = () => {
    [...filesRef.current].forEach(f => removeFile(f));
    setAddErrors([]);
  };

  // ----- duplicate detection (only files that share a size can be identical) -----
  const hashing = useRef(new Set<string>());
  useEffect(() => {
    const bySize = new Map<number, LocalFile[]>();
    files.forEach(f => bySize.set(f.size, [...(bySize.get(f.size) || []), f]));
    bySize.forEach(group => {
      if (group.length < 2) return;
      group.forEach(f => {
        if (f.sha256 || hashing.current.has(f.localId)) return;
        hashing.current.add(f.localId);
        sha256OfFile(f.file)
          .then(h => patchFile(f.localId, { sha256: h }))
          .catch(() => { /* duplicate check is advisory */ })
          .finally(() => hashing.current.delete(f.localId));
      });
    });
  }, [files, patchFile]);

  const duplicateOf = useMemo(() => {
    const m = new Map<string, string>();
    const seen = new Map<string, string>();
    files.forEach(f => {
      if (!f.sha256) return;
      const first = seen.get(f.sha256);
      if (first) m.set(f.localId, first); else seen.set(f.sha256, f.name);
    });
    return m;
  }, [files]);

  // ----- derived analysis -----
  const analyses: FileAnalysis[] = useMemo(() => files
    .filter(f => f.analysis && (f.analysisStatus === 'done' || f.analysisStatus === 'not_analysed'))
    .map(f => ({ fileName: f.name, result: f.analysis! })), [files]);
  const merged = useMemo(() => mergeFields(analyses), [analyses]);
  const candidates = useMemo(() => mergeCandidates(analyses), [analyses]);
  const disagreements = useMemo(() => findDisagreements(analyses), [analyses]);
  const printedNotes = useMemo(() => printedIdentifierNotes(analyses), [analyses]);
  const analysisPending = files.filter(f => f.analysisStatus === 'queued' || f.analysisStatus === 'running').length;
  const videoOnly = files.length > 0 && files.every(f => f.modality === 'XC');

  // ----- steps -----
  const steps = attachMode ? ['Files', 'Review and submit'] : ['Files and destination', 'Patient and study', 'Review and submit'];
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1); // 4 = submitted
  const stepIndex = step === 1 ? 0 : step === 2 ? 1 : attachMode ? 1 : 2;

  // ----- step 2: patient + study -----
  const canSearch = !!dest?.canAnalyze;
  const [patientMode, setPatientMode] = useState<'existing' | 'new'>('existing');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedPatient, setSelectedPatient] = useState<PatientRecord | null>(null);
  const [studyChoice, setStudyChoice] = useState<string | null>(null);
  const [newPatient, setNewPatient] = useState({ patientId: '', patientName: '', birthDate: '', sex: '' });
  const [newStudy, setNewStudy] = useState({ studyDescription: '', studyDate: '', accessionNumber: '', referringPhysician: '' });
  const touched = useRef(new Set<string>());
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PatientRecord[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [step2Error, setStep2Error] = useState('');

  useEffect(() => { setPatientMode(canSearch ? 'existing' : 'new'); }, [canSearch]);

  // Pre-fill the new-patient and new-study forms from the extraction, without
  // overwriting anything the user typed.
  useEffect(() => {
    const val = (k: keyof typeof merged) => merged[k]?.value || '';
    setNewPatient(p => ({
      patientName: touched.current.has('patientName') || p.patientName ? p.patientName : clip64(val('patientName')),
      patientId: touched.current.has('patientId') || p.patientId ? p.patientId : clip64(val('patientId')),
      birthDate: touched.current.has('birthDate') || p.birthDate ? p.birthDate : (toDA(val('birthDate')) || ''),
      sex: touched.current.has('sex') || p.sex ? p.sex : (['F', 'M', 'O'].includes(val('sex').toUpperCase()) ? val('sex').toUpperCase() : ''),
    }));
    setNewStudy(s => ({
      studyDescription: touched.current.has('studyDescription') || s.studyDescription ? s.studyDescription : clip64(val('documentType') || val('documentTitle')),
      studyDate: touched.current.has('studyDate') || s.studyDate ? s.studyDate : (toDA(val('documentDate')) || ''),
      accessionNumber: touched.current.has('accessionNumber') || s.accessionNumber ? s.accessionNumber : clip64(val('accessionNumber')),
      referringPhysician: touched.current.has('referringPhysician') || s.referringPhysician ? s.referringPhysician : clip64(val('referringPhysician')),
    }));
  }, [merged]);

  const editPatient = (k: keyof typeof newPatient, v: string) => { touched.current.add(k); setNewPatient(p => ({ ...p, [k]: v })); };
  const editStudy = (k: keyof typeof newStudy, v: string) => { touched.current.add(k); setNewStudy(s => ({ ...s, [k]: v })); };

  const runSearch = async () => {
    const q = query.trim();
    if (!dest || q.length < 2) { setSearchError('Type at least 2 characters of a name or patient ID.'); return; }
    setSearching(true); setSearchError('');
    try {
      setSearchResults(await nonDicomImportV2Service.searchPatients(dest.kind, dest.id, q));
    } catch (error: any) {
      setSearchError(apiErrorMessage(error, 'Search failed.'));
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  };

  const pickPatient = (key: string, p: PatientRecord) => {
    setSelectedKey(key); setSelectedPatient(p); setStudyChoice(null); setStep2Error('');
  };

  const patientLabel = (p: PatientRecord) => `${formatPN(p.patientName) || '(no name)'} · ID ${p.patientId}`;
  const patientDetails = (p: PatientRecord) => [p.birthDate ? `born ${formatDA(p.birthDate)}` : '', p.sex ? `sex ${p.sex}` : '',
    `${p.studies?.length || 0} stud${(p.studies?.length || 0) === 1 ? 'y' : 'ies'}`].filter(Boolean).join(' · ');

  const effectivePatient: PatientRecord | null = attachMode
    ? { patientId: fixedStudy!.patientId, patientName: fixedStudy!.patientName, birthDate: fixedStudy!.birthDate, sex: fixedStudy!.sex }
    : patientMode === 'existing' ? selectedPatient : null;
  const patientMismatch = useMemo(() => (effectivePatient ? findMismatchWithPatient(analyses, effectivePatient) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analyses, effectivePatient?.patientId, effectivePatient?.patientName]);

  const studyIsExisting = attachMode || (patientMode === 'existing' && !!studyChoice && studyChoice !== 'new');
  const existingStudyUID = attachMode ? fixedStudy!.studyInstanceUID : studyIsExisting ? studyChoice! : '';

  const validateStep2 = (): string => {
    if (patientMode === 'existing') {
      if (!selectedPatient) return 'Choose a patient, or switch to New patient.';
      if (!studyChoice) return 'Choose one of the patient\'s studies or New study.';
    } else {
      if (!newPatient.patientName.trim()) return 'Enter the patient name.';
      if (toDA(newPatient.birthDate) === null) return 'Birth date must be YYYYMMDD or YYYY-MM-DD.';
    }
    if (!studyIsExisting && toDA(newStudy.studyDate) === null) return 'Study date must be YYYYMMDD or YYYY-MM-DD.';
    return '';
  };

  // ----- step 3: series -----
  const [series, setSeries] = useState<SeriesDraft[]>([]);
  const seriesStudyRef = useRef('');
  const [existingSeries, setExistingSeries] = useState<DICOMSeries[]>([]);
  const [existingSeriesLoading, setExistingSeriesLoading] = useState(false);
  const [ack, setAck] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (step !== 3 || !dest || !studyIsExisting || !existingStudyUID) { setExistingSeries([]); return; }
    let cancelled = false;
    setExistingSeriesLoading(true);
    (async () => {
      try {
        const list = dest.kind === 'datastore'
          ? await dicomwebService.searchSeries(dest.id, existingStudyUID)
          : await dicomwebService.searchVirtualFolderSeries(dest.id, configService.getConfig().virtualFolderDicomWebUrl, existingStudyUID);
        if (!cancelled) setExistingSeries((list || []).filter(s => ['DOC', 'SC', 'XC'].includes((s.modality || '').toUpperCase())));
      } catch {
        if (!cancelled) setExistingSeries([]);
      } finally {
        if (!cancelled) setExistingSeriesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [step, dest, studyIsExisting, existingStudyUID]);

  /** One new series per modality for files without a compatible series; keeps user choices. */
  const ensureSeries = () => {
    // Existing-series choices belong to one study; drop them if the study changed.
    const sameStudy = seriesStudyRef.current === existingStudyUID;
    seriesStudyRef.current = existingStudyUID;
    const out = sameStudy ? [...series] : series.filter(s => s.mode === 'new');
    const assign = new Map<string, string>();
    for (const f of filesRef.current) {
      const cur = out.find(s => s.ref === f.seriesRef);
      if (cur && cur.modality === f.modality) continue;
      let auto = out.find(s => s.mode === 'new' && s.modality === f.modality);
      if (!auto) {
        const firstOfKind = filesRef.current.find(x => x.modality === f.modality && x.analysis?.status === 'ANALYSED');
        const desc = f.modality === 'DOC'
          ? (firstOfKind?.analysis?.fields?.documentType?.value || firstOfKind?.analysis?.fields?.documentTitle?.value || '')
          : '';
        auto = { ref: newId('s'), mode: 'new', seriesInstanceUID: '', modality: f.modality, description: clip64(desc || DEFAULT_SERIES_DESCRIPTION[f.modality]) };
        out.push(auto);
      }
      assign.set(f.localId, auto.ref);
    }
    setSeries(out);
    if (assign.size) setFiles(prev => prev.map(f => (assign.has(f.localId) ? { ...f, seriesRef: assign.get(f.localId) } : f)));
  };

  const moveFile = (f: LocalFile, value: string) => {
    if (value === '__new__') {
      const s: SeriesDraft = { ref: newId('s'), mode: 'new', seriesInstanceUID: '', modality: f.modality, description: DEFAULT_SERIES_DESCRIPTION[f.modality] };
      setSeries(prev => [...prev, s]);
      patchFile(f.localId, { seriesRef: s.ref });
      return;
    }
    if (value.startsWith('existing:')) {
      const uid = value.slice('existing:'.length);
      const already = series.find(s => s.mode === 'existing' && s.seriesInstanceUID === uid);
      if (already) { patchFile(f.localId, { seriesRef: already.ref }); return; }
      const ex = existingSeries.find(s => s.seriesInstanceUID === uid);
      const s: SeriesDraft = { ref: newId('s'), mode: 'existing', seriesInstanceUID: uid, modality: f.modality,
        description: ex?.seriesDescription || '', seriesNumber: ex?.seriesNumber };
      setSeries(prev => [...prev, s]);
      patchFile(f.localId, { seriesRef: s.ref });
      return;
    }
    patchFile(f.localId, { seriesRef: value });
  };

  const usedSeries = series.filter(s => files.some(f => f.seriesRef === s.ref));
  const seriesLabel = (s: SeriesDraft) => s.mode === 'existing'
    ? `Existing series${s.seriesNumber ? ` #${s.seriesNumber}` : ''}: ${s.description || '(no description)'}`
    : `New series: ${s.description || DEFAULT_SERIES_DESCRIPTION[s.modality]}`;
  const seriesOptions = (f: LocalFile) => {
    const opts = series.filter(s => s.modality === f.modality).map(s => ({ label: seriesLabel(s), value: s.ref }));
    existingSeries
      .filter(es => (es.modality || '').toUpperCase() === f.modality && !series.some(s => s.mode === 'existing' && s.seriesInstanceUID === es.seriesInstanceUID))
      .forEach(es => opts.push({ label: `Existing series${es.seriesNumber ? ` #${es.seriesNumber}` : ''}: ${es.seriesDescription || '(no description)'}`, value: `existing:${es.seriesInstanceUID}` }));
    opts.push({ label: 'Add a new series…', value: '__new__' });
    return opts;
  };

  const validateStep3 = (): string => {
    for (const f of files) {
      if (!f.seriesRef || !series.some(s => s.ref === f.seriesRef)) return `Choose a series for ${f.name}.`;
      if (toDA(f.contentDate) === null) return `Content date of ${f.name} must be YYYYMMDD or YYYY-MM-DD.`;
    }
    if (usedSeries.some(s => s.mode === 'new' && !s.description.trim())) return 'Every new series needs a description.';
    if (dest?.deidentified && !ack) return 'Confirm that you understand the file contents are not de-identified.';
    return '';
  };

  // ----- submit + poll -----
  const [importId, setImportId] = useState('');
  const [detail, setDetail] = useState<ImportDetail | null>(null);
  const [pollState, setPollState] = useState<'idle' | 'polling' | 'stopped'>('idle');
  const [pollError, setPollError] = useState('');
  const [pollNonce, setPollNonce] = useState(0);

  const submit = async () => {
    const err = validateStep3();
    if (err) { setSubmitError(err); return; }
    if (!dest) return;
    const patient: CreateImportBody['patient'] = attachMode
      ? { mode: 'existing', patientId: fixedStudy!.patientId || '', patientName: fixedStudy!.patientName || '', birthDate: fixedStudy!.birthDate || '', sex: fixedStudy!.sex || '' }
      : patientMode === 'existing' && selectedPatient
        ? { mode: 'existing', patientId: selectedPatient.patientId, patientName: selectedPatient.patientName || '', birthDate: selectedPatient.birthDate || '', sex: selectedPatient.sex || '' }
        : { mode: 'new', patientId: newPatient.patientId.trim(), patientName: newPatient.patientName.trim(), birthDate: toDA(newPatient.birthDate) || '', sex: newPatient.sex };
    const study: CreateImportBody['study'] = studyIsExisting
      ? { mode: 'existing', studyInstanceUID: existingStudyUID, studyDescription: '', studyDate: '', accessionNumber: '', referringPhysician: '' }
      : { mode: 'new', studyInstanceUID: '', studyDescription: newStudy.studyDescription.trim(), studyDate: toDA(newStudy.studyDate) || '',
          accessionNumber: newStudy.accessionNumber.trim(), referringPhysician: newStudy.referringPhysician.trim() };
    const body: CreateImportBody = {
      destinationKind: dest.kind,
      destinationId: dest.id,
      acknowledgedContentNotDeidentified: dest.deidentified ? ack : false,
      patient,
      study,
      series: usedSeries.map(s => ({ ref: s.ref, mode: s.mode, seriesInstanceUID: s.mode === 'existing' ? s.seriesInstanceUID : '',
        modality: s.modality, description: s.description.trim() })),
      files: files.map(f => ({ s3Key: f.s3Key!, fileName: f.name, seriesRef: f.seriesRef!, documentTitle: f.modality === 'DOC' ? f.documentTitle.trim() : '',
        contentDate: toDA(f.contentDate) || '', institutionName: f.institutionName.trim(),
        ...(f.modality === 'XC' && f.video ? f.video : {}) })),
    };
    setSubmitting(true); setSubmitError('');
    try {
      const res = await nonDicomImportV2Service.createImport(body);
      if (!res?.importId) throw new Error('The server did not return an import id.');
      setImportId(res.importId);
      setStep(4);
    } catch (error: any) {
      setSubmitError(apiErrorMessage(error, 'The import could not be started.'));
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!importId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const started = Date.now();
    setPollState('polling');
    const tick = async () => {
      try {
        const d = await nonDicomImportV2Service.getImport(importId);
        if (cancelled) return;
        setDetail(d); setPollError(''); failures = 0;
        if (TERMINAL.has(String(d?.import?.status || '').toUpperCase())) { setPollState('stopped'); return; }
      } catch (error: any) {
        if (cancelled) return;
        failures++;
        setPollError(apiErrorMessage(error, 'Could not read the import status.'));
        if (failures >= 5) { setPollState('stopped'); return; }
      }
      const elapsed = Date.now() - started;
      if (elapsed > POLL_GIVE_UP_MS) { setPollState('stopped'); return; }
      timer = setTimeout(tick, elapsed < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [importId, pollNonce]);

  // ----- dirty / close -----
  const dirty = files.length > 0 && step !== 4;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const close = () => {
    if (dirty && !window.confirm('Close the import? The files you added are not imported.')) return;
    onClose?.();
  };

  const resetAll = () => {
    aborters.current.forEach(a => a.abort());
    uploadQueue.current = []; analysisQueue.current = []; targets.current.clear();
    files.forEach(f => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    filesRef.current = [];
    setFiles([]); setAddErrors([]); setSeries([]); setAck(false); setSubmitError('');
    setSelectedKey(null); setSelectedPatient(null); setStudyChoice(null); setSearchResults(null); setQuery('');
    setNewPatient({ patientId: '', patientName: '', birthDate: '', sex: '' });
    setNewStudy({ studyDescription: '', studyDate: '', accessionNumber: '', referringPhysician: '' });
    touched.current.clear();
    setImportId(''); setDetail(null); setPollState('idle'); setPollError('');
    setStep(1);
  };

  // ----- render helpers -----
  const deidWarning = (withNotes: boolean) => dest?.deidentified ? (
    <Alert type="warning" header="This folder de-identifies DICOM tags only">
      <SpaceBetween size="xs">
        <span>Text and images inside the files are stored as they are, so patient details printed on them stay visible to the folder's readers.</span>
        {withNotes && printedNotes.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {printedNotes.map(n => <li key={n}><strong>{n}</strong></li>)}
          </ul>
        )}
      </SpaceBetween>
    </Alert>
  ) : null;

  const uploadCell = (f: LocalFile) => {
    switch (f.uploadStatus) {
      case 'requesting': return <StatusIndicator type="pending">Preparing</StatusIndicator>;
      case 'queued': return <StatusIndicator type="pending">Waiting to upload</StatusIndicator>;
      case 'uploading': return <StatusIndicator type="in-progress">{`Uploading ${f.uploadProgress}%`}</StatusIndicator>;
      case 'uploaded': return <StatusIndicator type="success">Uploaded</StatusIndicator>;
      default: return <StatusIndicator type="error" wrapText>{f.uploadError || 'Upload failed'}</StatusIndicator>;
    }
  };
  const analysisCell = (f: LocalFile) => {
    switch (f.analysisStatus) {
      case 'none': return <Box color="text-body-secondary">-</Box>;
      case 'skipped': return <StatusIndicator type="stopped">{f.modality === 'XC' ? 'Not analysed (video)' : 'Not analysed'}</StatusIndicator>;
      case 'queued': return <StatusIndicator type="pending">Waiting to analyse</StatusIndicator>;
      case 'running': return <StatusIndicator type="in-progress">Analysing</StatusIndicator>;
      case 'done': return <StatusIndicator type="success">Analysed</StatusIndicator>;
      case 'not_analysed': return <StatusIndicator type="warning" wrapText>{`Not analysed: ${f.analysisMessage}`}</StatusIndicator>;
      default: return <StatusIndicator type="warning" wrapText>{f.analysisMessage || 'Analysis failed'}</StatusIndicator>;
    }
  };

  const uploadsBusy = files.some(f => f.uploadStatus === 'requesting' || f.uploadStatus === 'queued' || f.uploadStatus === 'uploading');
  const uploadsFailed = files.filter(f => f.uploadStatus === 'failed').length;
  const step1Ready = !!dest && files.length > 0 && !uploadsBusy && uploadsFailed === 0;

  const goToStep3 = () => { ensureSeries(); setSubmitError(''); setStep(3); };

  // ======================= STEP 1 =======================
  const renderStep1 = () => (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">Destination</Header>}>
        {destLoading ? <Spinner /> : fixedDestination ? (
          <Box>{dest ? `${dest.name} (${dest.kind === 'virtualFolder' ? 'virtual folder' : 'storage'})` : '-'}</Box>
        ) : (
          <FormField label="Storage or virtual folder" description="Only destinations you can store files into are listed."
            constraintText={files.length > 0 ? 'Remove all files to change the destination.' : undefined}>
            <Select
              ariaLabel="Storage or virtual folder"
              placeholder="Choose a destination"
              disabled={files.length > 0}
              selectedOption={dest ? { label: dest.name, value: destKey(dest) } : null}
              onChange={({ detail }) => { setDestSel(detail.selectedOption.value || ''); setAddErrors([]); }}
              options={destinations.map(d => ({
                label: d.name,
                value: destKey(d),
                description: [d.kind === 'virtualFolder' ? 'Virtual folder' : 'Storage', d.deidentified ? 'de-identified' : '',
                  d.canAnalyze ? '' : 'no document analysis (read access needed)'].filter(Boolean).join(' · '),
              }))}
            />
          </FormField>
        )}
      </Container>

      {!!destError && <Alert type="error">{destError}</Alert>}
      {deidWarning(true)}
      {dest && !dest.canAnalyze && (
        <Alert type="info">Documents are not analysed for this destination because you do not have read access to it. You will enter the patient details yourself.</Alert>
      )}

      <Container header={<Header variant="h2" counter={files.length ? `(${files.length}/${MAX_FILES})` : undefined}
        actions={files.length > 0 ? <Button onClick={removeAll}>Remove all</Button> : undefined}>Files</Header>}>
        <SpaceBetween size="m">
          <Box color={dragOver ? 'text-status-info' : 'text-body-secondary'}>
            <div
              role="group"
              aria-label="File drop area"
              onDragOver={(e) => { e.preventDefault(); if (dest) setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); }}
              style={{ border: '2px dashed currentColor', borderRadius: 8, padding: 24, textAlign: 'center' }}
            >
              <SpaceBetween size="xs" alignItems="center">
                <span>{dest ? 'Drop files here, or' : 'Choose a destination first.'}</span>
                <Button iconName="upload" disabled={!dest || files.length >= MAX_FILES} onClick={() => inputRef.current?.click()}>Choose files</Button>
                <Box fontSize="body-s" color="inherit">
                  {`PDF, JPEG or PNG up to 100 MB; MP4, MPEG or MOV up to 2 GB; at most ${MAX_FILES} files.`}
                </Box>
              </SpaceBetween>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                aria-label="Choose files to import"
                style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>
          </Box>

          {addErrors.length > 0 && (
            <Alert type="error" header="Some files were not added" dismissible onDismiss={() => setAddErrors([])}>
              <ul style={{ margin: 0, paddingLeft: 20 }}>{addErrors.map(e => <li key={e}>{e}</li>)}</ul>
            </Alert>
          )}

          {files.length > 0 && (
            <Table
              variant="embedded"
              trackBy="localId"
              items={files}
              columnDefinitions={[
                {
                  id: 'preview', header: 'Preview', width: 72,
                  cell: (f: LocalFile) => f.previewUrl
                    ? <img src={f.previewUrl} alt={`Preview of ${f.name}`} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4 }} />
                    : <Badge>{f.typeLabel}</Badge>,
                },
                {
                  id: 'name', header: 'File', isRowHeader: true,
                  cell: (f: LocalFile) => (
                    <SpaceBetween size="xxxs">
                      <Box fontWeight="bold">{f.name}</Box>
                      <Box fontSize="body-s" color="text-body-secondary">{`${f.typeLabel} · ${formatBytes(f.size)} · ${MODALITY_LABEL[f.modality]}`}</Box>
                      {duplicateOf.has(f.localId) && (
                        <StatusIndicator type="warning" wrapText>{`Same content as ${duplicateOf.get(f.localId)}`}</StatusIndicator>
                      )}
                    </SpaceBetween>
                  ),
                },
                { id: 'upload', header: 'Upload', cell: uploadCell },
                { id: 'analysis', header: 'Analysis', cell: analysisCell },
                {
                  id: 'actions', header: 'Actions',
                  cell: (f: LocalFile) => (
                    <SpaceBetween direction="horizontal" size="xs">
                      {f.uploadStatus === 'failed' && <Button variant="link" onClick={() => retryUpload(f)} ariaLabel={`Retry upload of ${f.name}`}>Retry</Button>}
                      <Button variant="icon" iconName="close" ariaLabel={`Remove ${f.name}`} onClick={() => removeFile(f)} />
                    </SpaceBetween>
                  ),
                },
              ]}
            />
          )}
          {uploadsFailed > 0 && <Alert type="error">{`${uploadsFailed} file(s) failed to upload. Retry or remove them to continue.`}</Alert>}
        </SpaceBetween>
      </Container>

      <Box float="right">
        <SpaceBetween direction="horizontal" size="xs">
          {onClose && <Button onClick={close}>Cancel</Button>}
          <Button variant="primary" disabled={!step1Ready || !!destError}
            onClick={() => (attachMode ? goToStep3() : setStep(2))}>
            {uploadsBusy ? 'Uploading…' : 'Next'}
          </Button>
        </SpaceBetween>
      </Box>
    </SpaceBetween>
  );

  // ======================= STEP 2 =======================
  const fieldRows = FIELD_ORDER.filter(k => merged[k]).map(k => ({ key: k, ...merged[k]! }));
  const newStudyForm = (
    <ColumnLayout columns={2}>
      <FormField label="Study description">
        <Input ariaLabel="Study description" value={newStudy.studyDescription} onChange={({ detail }) => editStudy('studyDescription', clip64(detail.value))} />
      </FormField>
      <FormField label="Study date" constraintText="YYYYMMDD or YYYY-MM-DD"
        errorText={toDA(newStudy.studyDate) === null ? 'Invalid date' : undefined}>
        <Input ariaLabel="Study date" value={newStudy.studyDate} onChange={({ detail }) => editStudy('studyDate', detail.value)} />
      </FormField>
      <FormField label="Accession number">
        <Input ariaLabel="Accession number" value={newStudy.accessionNumber} onChange={({ detail }) => editStudy('accessionNumber', detail.value.slice(0, 16))} />
      </FormField>
      <FormField label="Referring physician" constraintText="DICOM format, e.g. SMITH^JOHN">
        <Input ariaLabel="Referring physician" value={newStudy.referringPhysician} onChange={({ detail }) => editStudy('referringPhysician', clip64(detail.value))} />
      </FormField>
    </ColumnLayout>
  );

  const renderStep2 = () => (
    <SpaceBetween size="l">
      {analysisPending > 0 && (
        <Alert type="info">{`Analysing ${analysisPending} file(s). Suggestions appear here as each one finishes.`}</Alert>
      )}
      {videoOnly && <Alert type="info">Videos are not analysed. Search for the patient or create a new one.</Alert>}
      {disagreements.length > 0 && (
        <Alert type="warning" header="These files may belong to different patients">
          <SpaceBetween size="xs">
            <span>One import goes to one patient. Remove the files that do not belong, then import them separately.</span>
            <ul style={{ margin: 0, paddingLeft: 20 }}>{disagreements.map(d => <li key={d}>{d}</li>)}</ul>
          </SpaceBetween>
        </Alert>
      )}

      {fieldRows.length > 0 && (
        <Container header={<Header variant="h2" description="Read from the files by the analysis. Check them before you use them.">Extracted details</Header>}>
          <Table
            variant="embedded"
            trackBy="key"
            items={fieldRows}
            columnDefinitions={[
              { id: 'field', header: 'Field', isRowHeader: true, cell: (r: any) => FIELD_LABELS[r.key as keyof typeof FIELD_LABELS] },
              { id: 'value', header: 'Value', cell: (r: any) => formatValue(r.key, r.value) },
              { id: 'confidence', header: 'Confidence', cell: (r: any) => `${Math.round((r.confidence ?? 0) * 100)}%` },
              { id: 'evidence', header: 'Evidence', cell: (r: any) => (
                <span>{r.evidence ? <q>{r.evidence}</q> : '-'}<Box fontSize="body-s" color="text-body-secondary">{r.fileName}</Box></span>
              ) },
            ]}
          />
        </Container>
      )}

      <Container header={<Header variant="h2">Patient</Header>}>
        <SpaceBetween size="l">
          <Tiles
            ariaLabel="Patient"
            value={patientMode}
            onChange={({ detail }) => { setPatientMode(detail.value as 'existing' | 'new'); setStep2Error(''); }}
            items={[
              { value: 'existing', label: 'Existing patient', disabled: !canSearch,
                description: canSearch ? 'A suggested patient or one you search for in this destination.' : 'Needs read access to this destination.' },
              { value: 'new', label: 'New patient', description: 'Create a patient from the details below.' },
            ]}
          />

          {patientMode === 'existing' && (
            <SpaceBetween size="l">
              {candidates.length > 0 && (
                <FormField label="Suggested patients" description="Ranked by how well they match the extracted details. Nothing is selected for you.">
                  <RadioGroup
                    ariaLabel="Suggested patients"
                    value={selectedKey?.startsWith('c:') ? selectedKey : null}
                    onChange={({ detail }) => {
                      const c = candidates.find(x => `c:${x.patientId}` === detail.value);
                      if (c) pickPatient(detail.value, c);
                    }}
                    items={candidates.slice(0, 10).map(c => ({
                      value: `c:${c.patientId}`,
                      label: `${patientLabel(c)} · ${Math.round((c.score ?? 0) * 100)}% match`,
                      description: [patientDetails(c), (c.reasons || []).join(', '), `from ${c.fileNames.join(', ')}`].filter(Boolean).join(' · '),
                    }))}
                  />
                </FormField>
              )}
              {candidates.length === 0 && analysisPending === 0 && !videoOnly && analyses.length > 0 && (
                <Box color="text-body-secondary">No matching patient was found in this destination. Search below, or create a new patient.</Box>
              )}

              <FormField label="Search patients" description="Name or patient ID, at least 2 characters." errorText={searchError || undefined}>
                <SpaceBetween direction="horizontal" size="xs">
                  <Input
                    ariaLabel="Search patients by name or ID"
                    type="search"
                    value={query}
                    onChange={({ detail }) => setQuery(detail.value)}
                    onKeyDown={({ detail }) => { if (detail.key === 'Enter') runSearch(); }}
                  />
                  <Button iconName="search" loading={searching} onClick={runSearch}>Search</Button>
                </SpaceBetween>
              </FormField>
              {searchResults && (searchResults.length === 0 ? (
                <Box color="text-body-secondary">No patient matches this search.</Box>
              ) : (
                <FormField label={`Search results (${searchResults.length})`}>
                  <Table
                    variant="embedded"
                    items={searchResults}
                    trackBy="patientId"
                    selectionType="single"
                    selectedItems={selectedKey?.startsWith('s:') && selectedPatient ? searchResults.filter(p => p.patientId === selectedPatient.patientId) : []}
                    onSelectionChange={({ detail }) => { const p = detail.selectedItems[0]; if (p) pickPatient(`s:${p.patientId}`, p); }}
                    ariaLabels={{
                      selectionGroupLabel: 'Search results',
                      itemSelectionLabel: (_s: any, p: PatientRecord) => `Select ${formatPN(p.patientName) || '(no name)'} (${p.patientId})`,
                    }}
                    columnDefinitions={[
                      { id: 'name', header: 'Patient name', isRowHeader: true, cell: (p: PatientRecord) => formatPN(p.patientName) || '(no name)' },
                      { id: 'id', header: 'Patient ID', cell: (p: PatientRecord) => p.patientId },
                      { id: 'dob', header: 'Birth date', cell: (p: PatientRecord) => formatDA(p.birthDate) || '-' },
                      { id: 'sex', header: 'Sex', cell: (p: PatientRecord) => p.sex || '-' },
                      { id: 'studies', header: 'Studies', cell: (p: PatientRecord) => p.studies?.length ?? 0 },
                    ]}
                  />
                </FormField>
              ))}

              {selectedPatient && (
                <SpaceBetween size="m">
                  {patientMismatch.length > 0 && (
                    <Alert type="warning" header="The files may not belong to this patient">
                      <ul style={{ margin: 0, paddingLeft: 20 }}>{patientMismatch.map(m => <li key={m}>{m}</li>)}</ul>
                    </Alert>
                  )}
                  <FormField label={`Study for ${formatPN(selectedPatient.patientName) || selectedPatient.patientId}`}>
                    <SpaceBetween size="s">
                      <Table
                        variant="embedded"
                        items={selectedPatient.studies || []}
                        trackBy="studyInstanceUID"
                        selectionType="single"
                        selectedItems={(selectedPatient.studies || []).filter(s => s.studyInstanceUID === studyChoice)}
                        onSelectionChange={({ detail }) => { const s = detail.selectedItems[0]; if (s) { setStudyChoice(s.studyInstanceUID); setStep2Error(''); } }}
                        ariaLabels={{
                          selectionGroupLabel: 'Studies',
                          itemSelectionLabel: (_s: any, st: StudyRef) => `Select study ${st.description || st.studyInstanceUID}`,
                        }}
                        columnDefinitions={[
                          { id: 'desc', header: 'Study description', isRowHeader: true, cell: (s: StudyRef) => s.description || '(no description)' },
                          { id: 'date', header: 'Study date', cell: (s: StudyRef) => formatDA(s.studyDate) || '-' },
                          { id: 'modality', header: 'Modality', cell: (s: StudyRef) => (s.modalities && s.modalities.length ? s.modalities.join(', ') : '-') },
                          { id: 'accession', header: 'Accession number', cell: (s: StudyRef) => s.accessionNumber || '-' },
                        ]}
                        empty={<Box color="text-body-secondary">This patient has no studies yet.</Box>}
                      />
                      <RadioGroup
                        ariaLabel="Create a new study"
                        value={studyChoice === 'new' ? 'new' : null}
                        onChange={({ detail }) => { setStudyChoice(detail.value); setStep2Error(''); }}
                        items={[{ value: 'new', label: 'New study', description: 'Create a new study for this patient instead of using one above.' }]}
                      />
                    </SpaceBetween>
                  </FormField>
                  {studyChoice === 'new' && newStudyForm}
                </SpaceBetween>
              )}
            </SpaceBetween>
          )}

          {patientMode === 'new' && (
            <SpaceBetween size="l">
              <ColumnLayout columns={2}>
                <FormField label="Patient name" constraintText="DICOM format, e.g. DOE^JANE (family^given)">
                  <Input ariaLabel="Patient name" value={newPatient.patientName} invalid={!!step2Error && !newPatient.patientName.trim()}
                    onChange={({ detail }) => editPatient('patientName', clip64(detail.value))} />
                </FormField>
                <FormField label="Patient ID" constraintText="As printed on the document (MRN), if known.">
                  <Input ariaLabel="Patient ID" value={newPatient.patientId} onChange={({ detail }) => editPatient('patientId', clip64(detail.value))} />
                </FormField>
                <FormField label="Birth date" constraintText="YYYYMMDD or YYYY-MM-DD"
                  errorText={toDA(newPatient.birthDate) === null ? 'Invalid date' : undefined}>
                  <Input ariaLabel="Birth date" value={newPatient.birthDate} onChange={({ detail }) => editPatient('birthDate', detail.value)} />
                </FormField>
                <FormField label="Sex">
                  <Select
                    ariaLabel="Sex"
                    selectedOption={SEX_OPTIONS.find(o => o.value === newPatient.sex) || SEX_OPTIONS[0]}
                    onChange={({ detail }) => editPatient('sex', detail.selectedOption.value || '')}
                    options={SEX_OPTIONS}
                  />
                </FormField>
              </ColumnLayout>
              <Box variant="h3">New study</Box>
              {newStudyForm}
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Container>

      {!!step2Error && <Alert type="error">{step2Error}</Alert>}
      <Box float="right">
        <SpaceBetween direction="horizontal" size="xs">
          {onClose && <Button onClick={close}>Cancel</Button>}
          <Button onClick={() => setStep(1)}>Back</Button>
          <Button variant="primary" onClick={() => {
            const err = validateStep2();
            if (err) { setStep2Error(err); return; }
            setStep2Error('');
            goToStep3();
          }}>Next</Button>
        </SpaceBetween>
      </Box>
    </SpaceBetween>
  );

  // ======================= STEP 3 =======================
  const patientSummary = attachMode
    ? `${formatPN(fixedStudy!.patientName) || '(no name)'} · ID ${fixedStudy!.patientId || '-'}`
    : patientMode === 'existing' && selectedPatient ? `${patientLabel(selectedPatient)} (existing)`
      : `${formatPN(newPatient.patientName)}${newPatient.patientId ? ` · ID ${newPatient.patientId}` : ''} (new)`;
  const studySummary = attachMode
    ? `${formatDA(fixedStudy!.studyDate) || 'No date'} · ${fixedStudy!.studyDescription || '(no description)'} (existing)`
    : studyIsExisting
      ? (() => { const s = selectedPatient?.studies?.find(x => x.studyInstanceUID === studyChoice); return `${formatDA(s?.studyDate) || 'No date'} · ${s?.description || '(no description)'} (existing)`; })()
      : `${formatDA(toDA(newStudy.studyDate) || '') || 'No date'} · ${newStudy.studyDescription || '(no description)'} (new)`;

  const renderStep3 = () => (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">Summary</Header>}>
        <KeyValuePairs columns={3} items={[
          { label: 'Destination', value: dest ? `${dest.name} (${dest.kind === 'virtualFolder' ? 'virtual folder' : 'storage'})` : '-' },
          { label: 'Patient', value: patientSummary },
          { label: 'Study', value: studySummary },
        ]} />
      </Container>

      {patientMismatch.length > 0 && (
        <Alert type="warning" header="The files may not belong to this patient">
          <ul style={{ margin: 0, paddingLeft: 20 }}>{patientMismatch.map(m => <li key={m}>{m}</li>)}</ul>
        </Alert>
      )}
      {disagreements.length > 0 && (
        <Alert type="warning" header="These files may belong to different patients">
          <ul style={{ margin: 0, paddingLeft: 20 }}>{disagreements.map(d => <li key={d}>{d}</li>)}</ul>
        </Alert>
      )}

      <Container header={<Header variant="h2" description="Files are grouped into one new series per kind (document, image, video). Rename a series, or move a file into another compatible series.">Series</Header>}>
        <SpaceBetween size="l">
          {existingSeriesLoading && <Box color="text-body-secondary"><Spinner /> Loading the study's series…</Box>}
          {usedSeries.map(s => {
            const members = files.filter(f => f.seriesRef === s.ref);
            return (
              <SpaceBetween key={s.ref} size="s">
                <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                  <Badge color={s.mode === 'existing' ? 'grey' : 'blue'}>{s.mode === 'existing' ? 'Existing' : 'New'}</Badge>
                  <Badge>{s.modality}</Badge>
                  <Box fontSize="body-s" color="text-body-secondary">{MODALITY_LABEL[s.modality]}</Box>
                </SpaceBetween>
                {s.mode === 'new' ? (
                  <FormField label="Series description" errorText={!s.description.trim() ? 'Required' : undefined}>
                    <Input ariaLabel={`Description of the new ${MODALITY_LABEL[s.modality].toLowerCase()} series`} value={s.description}
                      onChange={({ detail }) => setSeries(prev => prev.map(x => (x.ref === s.ref ? { ...x, description: clip64(detail.value) } : x)))} />
                  </FormField>
                ) : (
                  <Box>{seriesLabel(s)}</Box>
                )}
                <Table
                  variant="embedded"
                  trackBy="localId"
                  items={members}
                  columnDefinitions={[
                    { id: 'name', header: 'File', isRowHeader: true, cell: (f: LocalFile) => f.name },
                    {
                      id: 'series', header: 'Series',
                      cell: (f: LocalFile) => {
                        const opts = seriesOptions(f);
                        return (
                          <Select ariaLabel={`Series for ${f.name}`} options={opts}
                            selectedOption={opts.find(o => o.value === f.seriesRef) || null}
                            onChange={({ detail }) => moveFile(f, detail.selectedOption.value || '')} />
                        );
                      },
                    },
                    {
                      id: 'title', header: 'Document title',
                      cell: (f: LocalFile) => f.modality === 'DOC'
                        ? <Input ariaLabel={`Document title of ${f.name}`} value={f.documentTitle}
                            onChange={({ detail }) => patchFile(f.localId, { documentTitle: clip64(detail.value) })} />
                        : <Box color="text-body-secondary">-</Box>,
                    },
                    {
                      id: 'date', header: 'Content date',
                      cell: (f: LocalFile) => (
                        <Input ariaLabel={`Content date of ${f.name} (YYYYMMDD)`} value={f.contentDate} invalid={toDA(f.contentDate) === null}
                          placeholder="YYYYMMDD" onChange={({ detail }) => patchFile(f.localId, { contentDate: detail.value })} />
                      ),
                    },
                    {
                      id: 'institution', header: 'Institution',
                      cell: (f: LocalFile) => (
                        <Input ariaLabel={`Institution of ${f.name}`} value={f.institutionName}
                          onChange={({ detail }) => patchFile(f.localId, { institutionName: clip64(detail.value) })} />
                      ),
                    },
                  ]}
                />
              </SpaceBetween>
            );
          })}
        </SpaceBetween>
      </Container>

      {dest?.deidentified && (
        <SpaceBetween size="s">
          {deidWarning(true)}
          <Checkbox checked={ack} onChange={({ detail }) => { setAck(detail.checked); setSubmitError(''); }}>
            I understand the file contents are not de-identified
          </Checkbox>
        </SpaceBetween>
      )}

      {!!submitError && <Alert type="error" header="The import was not started">{submitError}</Alert>}
      <Box float="right">
        <SpaceBetween direction="horizontal" size="xs">
          {onClose && <Button onClick={close}>Cancel</Button>}
          <Button onClick={() => setStep(attachMode ? 1 : 2)} disabled={submitting}>Back</Button>
          <Button variant="primary" loading={submitting} disabled={!!dest?.deidentified && !ack} onClick={submit}>
            {`Import ${files.length} file${files.length === 1 ? '' : 's'}`}
          </Button>
        </SpaceBetween>
      </Box>
    </SpaceBetween>
  );

  // ======================= SUBMITTED =======================
  const renderSubmitted = () => {
    const st = String(detail?.import?.status || 'PENDING').toUpperCase();
    const list = detail?.files || [];
    const done = list.filter(f => ['INDEXED', 'FAILED'].includes(String(f.status).toUpperCase())).length;
    const summary: { type: 'success' | 'warning' | 'error' | 'info'; text: string } =
      st === 'COMPLETED' ? { type: 'success', text: 'All files were imported and indexed.' }
        : st === 'PARTIAL' ? { type: 'warning', text: 'Some files failed. The others were imported.' }
          : st === 'FAILED' ? { type: 'error', text: 'No file was imported.' }
            : { type: 'info', text: list.length ? `Processing: ${done} of ${list.length} file(s) finished.` : 'The import has started.' };
    return (
      <SpaceBetween size="l">
        <Alert type={summary.type} header={TERMINAL.has(st) ? 'Import finished' : 'Import in progress'}>
          <SpaceBetween size="xs">
            <span>{summary.text}</span>
            <Box fontSize="body-s" color="text-body-secondary">{`Import ID ${importId}`}</Box>
          </SpaceBetween>
        </Alert>
        {!!pollError && <Alert type="warning">{pollError}</Alert>}
        {pollState === 'stopped' && !TERMINAL.has(st) && (
          <Alert type="info">Status checks stopped. Files keep processing on the server; refresh to see where they are.</Alert>
        )}
        <Container header={<Header variant="h2" actions={pollState === 'polling'
          ? <StatusIndicator type="loading">Checking</StatusIndicator>
          : <Button iconName="refresh" onClick={() => { setPollError(''); setPollNonce(n => n + 1); }}>Refresh</Button>}>Files</Header>}>
          {!detail ? <Spinner /> : (
            <Table
              variant="embedded"
              trackBy="id"
              items={list}
              columnDefinitions={[
                { id: 'name', header: 'File', isRowHeader: true, cell: (f: ImportDetail['files'][number]) => f.fileName },
                {
                  id: 'status', header: 'Status',
                  cell: (f: ImportDetail['files'][number]) => {
                    const s = FILE_STATUS[String(f.status).toUpperCase()] || { type: 'info' as SIType, text: String(f.status) };
                    return <StatusIndicator type={s.type}>{s.text}</StatusIndicator>;
                  },
                },
                { id: 'message', header: 'Message', cell: (f: ImportDetail['files'][number]) => f.errorMessage || '-' },
              ]}
            />
          )}
        </Container>
        {!!detail?.import?.studyInstanceUID && (
          <ExpandableSection headerText="DICOM identifiers">
            <KeyValuePairs columns={1} items={[{ label: 'Study Instance UID', value: detail.import.studyInstanceUID }]} />
          </ExpandableSection>
        )}
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={resetAll}>Import more files</Button>
            {onClose && <Button variant="primary" onClick={() => onClose()}>Close</Button>}
          </SpaceBetween>
        </Box>
      </SpaceBetween>
    );
  };

  const body = step === 1 ? renderStep1() : step === 2 ? renderStep2() : step === 3 ? renderStep3() : renderSubmitted();
  return (
    <SpaceBetween size="l">
      {!embedded && (
        <Header variant="h1" description={attachMode ? 'Add PDF, image or video files to this study.' : 'Import PDF documents, images and videos as DICOM.'}>
          {attachMode ? 'Attach files' : 'Import files'}
        </Header>
      )}
      {attachMode && embedded && fixedStudy && (
        <Box color="text-body-secondary">
          {`Study: ${formatDA(fixedStudy.studyDate) || 'No date'} · ${fixedStudy.studyDescription || '(no description)'} · ${formatPN(fixedStudy.patientName) || fixedStudy.patientId}`}
        </Box>
      )}
      {step !== 4 && <StepIndicator steps={steps} current={stepIndex} />}
      {body}
    </SpaceBetween>
  );
};

export default NonDicomImportV2;
