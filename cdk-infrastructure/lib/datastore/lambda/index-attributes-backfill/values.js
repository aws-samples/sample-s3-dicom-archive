/**
 * Value extraction + normalization for the index-attribute back-fill.
 *
 * Ports of the ingest routines (single source of truth stays in Python, this
 * lambda cannot import it: CDK bundling mounts only this lambda's own dir):
 *   dicomJsonValue  <- ingest/aggregate.py `_dcm` (also used by the
 *                      ingest-v3 settle pass for SERIES/STUDY/PATIENT attrs)
 *   coerceAttrValue <- ingest/engine.py `_coerce_attr_value`
 * Keep them in step with those functions.
 *
 * coerceAttrValue returns { write: false } where ingest's UPDATE would fail in
 * MySQL strict mode (out-of-range INT/DECIMAL, impossible DATE, inf/nan):
 * ingest logs and skips that UPDATE, leaving the column untouched, so the
 * back-fill skips the row too instead of failing its whole batch.
 */
const zlib = require('zlib');

// Python str() of a JSON scalar (strings unchanged; booleans as True/False).
function pyStr(x) {
  if (typeof x === 'boolean') return x ? 'True' : 'False';
  return String(x);
}

/** First Value of a DICOM-JSON element; PN -> its Alphabetic group. null when absent/empty. */
function dicomJsonValue(md, tag) {
  if (!md || typeof md !== 'object') return null;
  const t = String(tag || '');
  const el = md[t] || md[t.toUpperCase()] || md[t.toLowerCase()];
  if (!el || typeof el !== 'object') return null;
  const v = el.Value;
  if (!Array.isArray(v) || v.length === 0) return null;
  const x = v[0];
  if (x !== null && typeof x === 'object') return x.Alphabetic || null; // PN (or SQ item: no value)
  return x === undefined ? null : x;
}

const INT_RE = /^[+-]?\d+(?:_\d+)*$/;
// Python float() literal forms (underscores between digits allowed).
const FLOAT_RE = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const PY_SPECIAL_FLOAT_RE = /^[+-]?(?:inf|infinity|nan)$/i;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const DECIMAL_18_6_MAX = 1e12; // DECIMAL(18,6): 12 integer digits

function daysInMonth(y, m) {
  return [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/**
 * Coerce a raw header value to the column's SQL type, as ingest does.
 * Returns { write: true, value } (value may be null: ingest writes NULL for an
 * absent/empty/unparseable tag) or { write: false } (ingest's UPDATE would be
 * rejected by MySQL and skipped).
 */
function coerceAttrValue(raw, dataType) {
  if (raw === null || raw === undefined || raw === '') return { write: true, value: null };
  const s = pyStr(raw);
  if (dataType === 'INT') {
    const t = s.trim();
    if (!INT_RE.test(t)) return { write: true, value: null };
    const n = Number(t.replace(/_/g, ''));
    if (!Number.isSafeInteger(n) || n < INT_MIN || n > INT_MAX) return { write: false };
    return { write: true, value: n };
  }
  if (dataType === 'DECIMAL') {
    const t = s.split('\\')[0].trim();
    if (PY_SPECIAL_FLOAT_RE.test(t)) return { write: false };
    if (!FLOAT_RE.test(t)) return { write: true, value: null };
    const n = Number(t.replace(/_/g, ''));
    if (!Number.isFinite(n) || Math.abs(n) >= DECIMAL_18_6_MAX) return { write: false };
    return { write: true, value: n };
  }
  if (dataType === 'DATE') {
    const d = Array.from(s.trim()).slice(0, 8).join('');
    if (!/^\d{8}$/.test(d)) return { write: true, value: null };
    const y = Number(d.slice(0, 4)); const m = Number(d.slice(4, 6)); const day = Number(d.slice(6, 8));
    if (y < 1 || m < 1 || m > 12 || day < 1 || day > daysInMonth(y, m)) return { write: false };
    return { write: true, value: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` };
  }
  // STRING: VARCHAR(255); Python slices code points.
  return { write: true, value: Array.from(s).slice(0, 255).join('') };
}

/** Gunzip + parse one Instancemetadata.metadata blob; null if unreadable. */
function parseMetadataBlob(blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
    return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch (e) {
    return null;
  }
}

/** The value to write for one row: { write, value }. A missing header -> no write. */
function valueFromBlob(blob, dicomTag, dataType) {
  const md = parseMetadataBlob(blob);
  if (!md) return { write: false };
  return coerceAttrValue(dicomJsonValue(md, dicomTag), dataType);
}

module.exports = { dicomJsonValue, coerceAttrValue, parseMetadataBlob, valueFromBlob, pyStr };
