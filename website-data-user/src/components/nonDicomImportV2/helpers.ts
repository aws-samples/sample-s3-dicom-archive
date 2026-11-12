/**
 * Pure helpers for Non-DICOM Import V2: file typing (by content), size caps,
 * SHA-256 for duplicate detection, analysis merging, disagreement detection and
 * DICOM value formatting. No React, no API calls. Identical in both data-user sites.
 */
import { Sha256 } from '@aws-crypto/sha256-js';
import type { AnalyzeResult, Candidate, ExtractedField, FieldKey, PatientRecord, V2Modality } from '../../services/nonDicomImportV2Service';

export const MAX_FILES = 50;
// Same limits and units as the API (sniff.py): 100 MiB for PDF/JPEG/PNG, 2 GiB
// for MP4/MPEG/MOV, so a file the server accepts is never refused here.
export const MAX_DOC_IMAGE_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

export const ACCEPT = '.pdf,.jpg,.jpeg,.png,.mp4,.mpeg,.mpg,.mov,application/pdf,image/jpeg,image/png,video/mp4,video/mpeg,video/quicktime';

export interface FileType { contentType: string; modality: V2Modality; label: string }

/** Type from the file's first bytes (the server re-checks the same magic bytes). */
export function sniffType(head: Uint8Array): FileType | null {
  const b = head;
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return { contentType: 'application/pdf', modality: 'DOC', label: 'PDF' };
  if (at(0, 0xff, 0xd8, 0xff)) return { contentType: 'image/jpeg', modality: 'SC', label: 'JPEG' };
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return { contentType: 'image/png', modality: 'SC', label: 'PNG' };
  if (at(4, 0x66, 0x74, 0x79, 0x70)) { // 'ftyp'
    const brand = String.fromCharCode(b[8] || 0, b[9] || 0, b[10] || 0, b[11] || 0);
    return brand === 'qt  '
      ? { contentType: 'video/quicktime', modality: 'XC', label: 'MOV' }
      : { contentType: 'video/mp4', modality: 'XC', label: 'MP4' };
  }
  if (at(0, 0x00, 0x00, 0x01, 0xba) || at(0, 0x00, 0x00, 0x01, 0xb3)) return { contentType: 'video/mpeg', modality: 'XC', label: 'MPEG' };
  return null;
}

export async function detectType(file: File): Promise<FileType | null> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return sniffType(head);
}

export function sizeCap(modality: V2Modality): number {
  return modality === 'XC' ? MAX_VIDEO_BYTES : MAX_DOC_IMAGE_BYTES;
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(0)} kB`;
  if (n < 1000 * 1000 * 1000) return `${(n / 1000 / 1000).toFixed(1)} MB`;
  return `${(n / 1000 / 1000 / 1000).toFixed(2)} GB`;
}

const SUBTLE_MAX = 256 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

function hex(buf: ArrayBuffer | Uint8Array): string {
  const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
  return s;
}

/** SHA-256 of a file. WebCrypto for files that fit in memory, chunked JS hash for large videos. */
export async function sha256OfFile(file: Blob): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
  if (subtle && file.size <= SUBTLE_MAX) {
    return hex(await subtle.digest('SHA-256', await file.arrayBuffer()));
  }
  const h = new Sha256();
  for (let off = 0; off < file.size; off += CHUNK) {
    h.update(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()));
  }
  return hex(await h.digest());
}

export const FIELD_LABELS: Record<FieldKey, string> = {
  patientName: 'Patient name',
  patientId: 'Patient ID',
  birthDate: 'Birth date',
  sex: 'Sex',
  documentDate: 'Document date',
  documentType: 'Document type',
  documentTitle: 'Document title',
  referringPhysician: 'Referring physician',
  institution: 'Institution',
  accessionNumber: 'Accession number',
};
export const FIELD_ORDER: FieldKey[] = ['patientName', 'patientId', 'birthDate', 'sex', 'documentType', 'documentTitle',
  'documentDate', 'referringPhysician', 'institution', 'accessionNumber'];

/** DICOM PN "DOE^JANE" -> "DOE, JANE". */
export function formatPN(pn?: string | null): string {
  if (!pn) return '';
  const parts = String(pn).split('^').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  return `${parts[0]}, ${parts.slice(1).join(' ')}`;
}

/** DICOM DA "19800101" -> "1980-01-01" (other values unchanged). */
export function formatDA(da?: string | null): string {
  if (!da) return '';
  const s = String(da);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

export function formatValue(key: FieldKey, value?: string | null): string {
  if (!value) return '';
  if (key === 'patientName' || key === 'referringPhysician') return formatPN(value);
  if (key === 'birthDate' || key === 'documentDate') return formatDA(value);
  return value;
}

/** Accepts "YYYYMMDD" or "YYYY-MM-DD"; returns DICOM DA or '' when empty. null when invalid. */
export function toDA(input: string): string | null {
  const s = input.trim();
  if (!s) return '';
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const mm = Number(mo); const dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}${mo}${d}`;
}

const stripAccents = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function normName(pn?: string | null): string {
  if (!pn) return '';
  return stripAccents(String(pn)).toUpperCase().split(/[\^\s,]+/).filter(Boolean).sort().join(' ');
}
export function normId(id?: string | null): string {
  return (id || '').toUpperCase().replace(/[\s-]/g, '');
}

export interface FileAnalysis { fileName: string; result: AnalyzeResult }

export interface MergedField extends ExtractedField { fileName: string }

/** Highest-confidence value per field across all analysed files. */
export function mergeFields(analyses: FileAnalysis[]): Partial<Record<FieldKey, MergedField>> {
  const out: Partial<Record<FieldKey, MergedField>> = {};
  for (const a of analyses) {
    if (a.result.status !== 'ANALYSED') continue;
    for (const key of FIELD_ORDER) {
      const f = a.result.fields?.[key];
      if (!f || !f.value) continue;
      const cur = out[key];
      if (!cur || (f.confidence ?? 0) > (cur.confidence ?? 0)) out[key] = { ...f, fileName: a.fileName };
    }
  }
  return out;
}

export interface MergedCandidate extends Candidate { fileNames: string[] }

/** Candidates from every file, merged by patient ID, best score first. */
export function mergeCandidates(analyses: FileAnalysis[]): MergedCandidate[] {
  const byId = new Map<string, MergedCandidate>();
  for (const a of analyses) {
    for (const c of a.result.candidates || []) {
      if (!c?.patientId) continue;
      const cur = byId.get(c.patientId);
      if (!cur) {
        byId.set(c.patientId, { ...c, reasons: [...(c.reasons || [])], fileNames: [a.fileName] });
      } else {
        if ((c.score ?? 0) > (cur.score ?? 0)) { cur.score = c.score; }
        for (const r of c.reasons || []) if (!cur.reasons!.includes(r)) cur.reasons!.push(r);
        if (!cur.fileNames.includes(a.fileName)) cur.fileNames.push(a.fileName);
        if ((c.studies?.length || 0) > (cur.studies?.length || 0)) cur.studies = c.studies;
      }
    }
  }
  return [...byId.values()].sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
}

const CONFIDENT = 0.5;

/**
 * One patient per import: describe files whose extracted patient ID, name or
 * birth date disagree with each other. Empty when they agree.
 */
export function findDisagreements(analyses: FileAnalysis[]): string[] {
  const out: string[] = [];
  const check = (key: FieldKey, norm: (v: string) => string) => {
    const seen = new Map<string, string[]>();
    for (const a of analyses) {
      const f = a.result.status === 'ANALYSED' ? a.result.fields?.[key] : null;
      if (!f?.value || (f.confidence ?? 0) < CONFIDENT) continue;
      const n = norm(f.value);
      if (!n) continue;
      seen.set(n, [...(seen.get(n) || []), `${a.fileName} (${formatValue(key, f.value)})`]);
    }
    if (seen.size > 1) {
      out.push(`${FIELD_LABELS[key]} differs: ${[...seen.values()].map(v => v.join(', ')).join(' vs ')}.`);
    }
  };
  check('patientId', normId);
  check('patientName', normName);
  check('birthDate', v => v.replace(/-/g, ''));
  return out;
}

/** Disagreement between the analysed files and a patient already chosen (attach-to-study). */
export function findMismatchWithPatient(analyses: FileAnalysis[], patient: PatientRecord): string[] {
  const out: string[] = [];
  for (const a of analyses) {
    if (a.result.status !== 'ANALYSED') continue;
    const id = a.result.fields?.patientId;
    const name = a.result.fields?.patientName;
    if (id?.value && (id.confidence ?? 0) >= CONFIDENT && patient.patientId && normId(id.value) !== normId(patient.patientId)) {
      out.push(`${a.fileName} shows patient ID ${id.value}; the chosen patient's ID is ${patient.patientId}.`);
    } else if (name?.value && (name.confidence ?? 0) >= CONFIDENT && patient.patientName && normName(name.value) !== normName(patient.patientName)) {
      out.push(`${a.fileName} shows patient name ${formatPN(name.value)}; the chosen patient is ${formatPN(patient.patientName)}.`);
    }
  }
  return out;
}

const listJoin = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/** "Patient name and birth date were found printed in report.pdf." per file. */
export function printedIdentifierNotes(analyses: FileAnalysis[]): string[] {
  const out: string[] = [];
  for (const a of analyses) {
    const ids = (a.result.printedIdentifiers || []).map(k => (FIELD_LABELS as Record<string, string>)[k] || k);
    if (!ids.length) continue;
    const text = listJoin(ids.map((s, i) => (i === 0 ? s : s.toLowerCase())));
    out.push(`${text} ${ids.length === 1 ? 'was' : 'were'} found printed in ${a.fileName}.`);
  }
  return out;
}

export const MODALITY_LABEL: Record<V2Modality, string> = { DOC: 'Document (PDF)', SC: 'Image', XC: 'Video' };
export const DEFAULT_SERIES_DESCRIPTION: Record<V2Modality, string> = { DOC: 'Documents', SC: 'Images', XC: 'Video' };

/** DICOM LO/PN values are capped at 64 characters. */
export const clip64 = (s: string) => s.slice(0, 64);

// ---------------------------------------------------------------- video metadata

/** Optional per-file video fields of POST /non-dicom-import/v2 (create). */
export interface VideoMetadata {
  videoWidth: number;
  videoHeight: number;
  numberOfFrames?: number;
  frameTime: number;
}

/** Browsers do not expose a video's frame rate: assume 30 fps (frame time 33.33 ms), as V1 did. */
export const ASSUMED_FPS = 30;
export const ASSUMED_FRAME_TIME_MS = 33.33;

/**
 * Width, height and an estimated frame count of a video, read from a <video>
 * element's loadedmetadata. Frame count = round(duration * 30), omitted when the
 * duration is unknown. Resolves null when the browser cannot decode the file
 * (e.g. MPEG-2 in most browsers), so the fields are left out of the request and
 * the encapsulator uses its defaults.
 */
export function readVideoMetadata(file: Blob, timeoutMs = 15000): Promise<VideoMetadata | null> {
  return new Promise((resolve) => {
    let url = '';
    try { url = URL.createObjectURL(file); } catch { resolve(null); return; }
    const v = document.createElement('video');
    let finished = false;
    const finish = (m: VideoMetadata | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      v.onloadedmetadata = null; v.onerror = null;
      v.removeAttribute('src');
      try { v.load(); } catch { /* ignore */ }
      URL.revokeObjectURL(url);
      resolve(m);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    v.muted = true; v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const w = v.videoWidth, h = v.videoHeight, d = v.duration;
      // 0 x 0: the container opened but the video track cannot be decoded.
      if (!w || !h || w > 65535 || h > 65535) { finish(null); return; }
      const m: VideoMetadata = { videoWidth: w, videoHeight: h, frameTime: ASSUMED_FRAME_TIME_MS };
      if (Number.isFinite(d) && d > 0) m.numberOfFrames = Math.max(1, Math.round(d * ASSUMED_FPS));
      finish(m);
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}
