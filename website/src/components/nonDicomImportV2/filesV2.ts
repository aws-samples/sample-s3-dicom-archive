/**
 * Non-DICOM Import V2: file helpers (type detection, client-side limits,
 * SHA-256, thumbnails) and small value formatters.
 *
 * The pdf.js worker is bundled with the site: Vite's `?worker` import builds
 * pdfjs-dist's worker into a same-origin .js asset, so nothing is loaded from a
 * CDN at run time. (A `.js` asset, not the raw `.mjs`, so S3/CloudFront serve
 * it with a JavaScript content type, which module workers require.)
 */
import PdfJsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type { V2Modality } from './apiV2';

export const MAX_FILES = 50;
export const MAX_DOC_BYTES = 100 * 1024 * 1024; // PDF / JPEG / PNG
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024; // MP4 / MPEG / MOV
/** Files above this size are not hashed in the browser (whole-file read). */
export const MAX_HASH_BYTES = 256 * 1024 * 1024;

/** Whole-slide pathology (SVS/BIF) upload ceiling: single presigned S3 PUT = 5 GB. */
export const MAX_WSI_BYTES = 5 * 1024 * 1024 * 1024;

export const ACCEPT_ATTR = '.pdf,.jpg,.jpeg,.png,.mp4,.mpeg,.mpg,.mov,.svs,.bif,application/pdf,image/jpeg,image/png,video/mp4,video/mpeg,video/quicktime,image/tiff';

const TYPE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  mp4: 'video/mp4', mpeg: 'video/mpeg', mpg: 'video/mpeg', mov: 'video/quicktime',
  // Whole-slide pathology. Both SVS and BIF are TIFF containers; the backend
  // sniffs the TIFF magic and ingest classifies the vendor. image/tiff is the
  // content type the API accepts (modality SM).
  svs: 'image/tiff', bif: 'image/tiff',
};
export const MODALITY_FOR_TYPE: Record<string, V2Modality> = {
  'application/pdf': 'DOC', 'image/jpeg': 'SC', 'image/png': 'SC',
  'video/mp4': 'XC', 'video/mpeg': 'XC', 'video/quicktime': 'XC',
  'image/tiff': 'SM',
};
export const MODALITY_LABEL: Record<V2Modality, string> = {
  DOC: 'Documents (PDF)', SC: 'Images', XC: 'Videos', SM: 'Pathology slides (SVS/BIF)',
};

/** Content type from the browser's MIME type, falling back to the extension.
 * SVS/BIF rarely carry a usable MIME type, so the extension is authoritative
 * for them (a browser may report '' or a generic octet-stream). */
export function detectContentType(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (ext === 'svs' || ext === 'bif') return 'image/tiff';
  if (file.type && MODALITY_FOR_TYPE[file.type]) return file.type;
  return TYPE_BY_EXT[ext] || null;
}

export function sizeCapFor(modality: V2Modality): number {
  if (modality === 'SM') return MAX_WSI_BYTES;
  return modality === 'XC' ? MAX_VIDEO_BYTES : MAX_DOC_BYTES;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Hex SHA-256 via Web Crypto; null when the file is too large or crypto.subtle is missing (non-HTTPS). */
export async function sha256Hex(file: File): Promise<string | null> {
  if (file.size > MAX_HASH_BYTES || !window.crypto?.subtle) return null;
  const buf = await file.arrayBuffer();
  const digest = await window.crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- thumbnails

function imageThumbnail(file: File): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const s = Math.min(120 / img.width, 120 / img.height, 1);
      c.width = img.width * s; c.height = img.height * s;
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

function videoThumbnail(file: File): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'metadata';
    const done = (s: string) => { URL.revokeObjectURL(url); resolve(s); };
    v.onloadeddata = () => { v.currentTime = 0.1; };
    v.onseeked = () => {
      const c = document.createElement('canvas');
      const s = Math.min(120 / (v.videoWidth || 120), 120 / (v.videoHeight || 120), 1);
      c.width = v.videoWidth * s; c.height = v.videoHeight * s;
      try { c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height); done(c.toDataURL('image/jpeg', 0.7)); } catch { done(''); }
    };
    // Browsers cannot decode every container (e.g. MPEG-2); no preview then.
    v.onerror = () => done('');
    v.src = url;
  });
}

let pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist').then((lib) => {
      // One shared worker for every thumbnail; pdf.destroy() leaves a workerPort running.
      if (!lib.GlobalWorkerOptions.workerPort) lib.GlobalWorkerOptions.workerPort = new PdfJsWorker();
      return lib;
    }).catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

async function pdfThumbnail(file: File): Promise<string> {
  try {
    const pdfjsLib = await loadPdfjs();
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 0.3 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    pdf.destroy?.();
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return ''; // encrypted or damaged PDF: no preview; the server reports the real error
  }
}

export function makeThumbnail(file: File, modality: V2Modality): Promise<string> {
  if (modality === 'SC') return imageThumbnail(file);
  if (modality === 'XC') return videoThumbnail(file);
  // WSI slides (SM) are multi-GB TIFFs the browser cannot decode — no preview.
  if (modality === 'SM') return Promise.resolve('');
  return pdfThumbnail(file);
}

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

// ---------------------------------------------------------------- formatting

/** DICOM DA (YYYYMMDD) -> ISO (YYYY-MM-DD) for date pickers. Other input is returned as-is. */
export function daToIso(d?: string | null): string {
  if (!d) return '';
  const s = d.replace(/[^0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
}
/** ISO (YYYY-MM-DD) -> DICOM DA (YYYYMMDD). */
export function isoToDa(d?: string | null): string {
  return (d || '').replace(/-/g, '').slice(0, 8);
}
export function displayDate(d?: string | null): string {
  const iso = daToIso(d);
  return iso || (d || '');
}
/** DICOM PN "DOE^JANE" -> "DOE, JANE" for display. */
export function displayPN(pn?: string | null): string {
  if (!pn) return '';
  const parts = pn.split('^').filter(Boolean);
  return parts.length > 1 ? `${parts[0]}, ${parts.slice(1).join(' ')}` : (parts[0] || '');
}
/** Normalised name for comparing two extracted names (case, accents, component order). */
export function nameKey(pn?: string | null): string {
  if (!pn) return '';
  return pn
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(/[\^,\s]+/).map(p => p.replace(/[^A-Z]/g, '')).filter(Boolean)
    .sort().join(' ');
}
export function idKey(id?: string | null): string {
  return (id || '').trim().toUpperCase();
}

/** "Patient name and birth date" from ['patientName','birthDate']. */
export function joinFieldLabels(keys: string[], labels: Record<string, string>): string {
  const names = keys.map((k, i) => (i === 0 ? labels[k] || k : (labels[k] || k).toLowerCase()));
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
