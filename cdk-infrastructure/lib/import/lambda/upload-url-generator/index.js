// Upload-URL generator for DICOM import.
//
// New (S3-native) model: there is NO staging bucket, NO import-trigger copy and
// NO separate import job. The browser uploads each DICOM instance DIRECTLY into
// the target datastore's ARCHIVE bucket via a presigned PUT, at the standard
// partition key. The archive bucket's existing S3 ObjectCreated notification
// then drives the s3-ingest pipeline, which populates the DICOM index — exactly
// the same path STOW-RS uses. So a plain S3 copy is all import has to do.
//
// Partition key (server-authoritative, from client-supplied DICOM metadata):
//   YYYY/MM/DD/{studyUID}/{seriesUID}/{sopUID}.dcm   when StudyDate parses
//   {studyUID}/{seriesUID}/{sopUID}.dcm              when StudyDate is absent/unparseable
// prefixed by the datastore's configured s3_prefix (if any).
//
// The key is built HERE, never trusted from the client, so a caller cannot
// write outside its datastore's archive prefix.
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { query } = require('/opt/nodejs/database');
const { storageWriteRefusal } = require('/opt/nodejs/writable-destination');

const s3Client = new S3Client({});

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS'
};

const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

function err(statusCode, message) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify({ success: false, error: { message } }) };
}

// Does the authenticated caller hold write (canStore) on this datastore?
// Mirrors the import-jobs-api / non-dicom-import-api idiom: datastorePrivileges
// is a JSON array of { datastoreId, canStore, ... } threaded by the api-authorizer
// into event.requestContext.authorizer; '*' is the admin "All Datastores" grant.
function callerCanStore(event, datastoreId) {
  const raw = event.requestContext?.authorizer?.datastorePrivileges;
  let privileges = [];
  try {
    privileges = raw ? JSON.parse(raw) : [];
  } catch {
    privileges = [];
  }
  return privileges.some(p =>
    (p.datastoreId === datastoreId || p.datastoreId === '*') && p.canStore // nosec - intentional wildcard for admin "All Datastores" privilege
  );
}

// The authenticated principal's username, from the authorizer context. Never
// trust a client-supplied username for key construction.
function callerUsername(event) {
  return event.requestContext?.authorizer?.username || null;
}

// F16: a client-supplied relative path (s3Key / path / folderName) is appended
// under the caller's own {username}/{timestamp}/ prefix. Reject anything that
// could climb out of that prefix: no leading '/', no '..' segment, no empty.
// Returns a cleaned relative path, or null if it is unsafe.
function safeRelPath(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (s.startsWith('/')) return null;
  const segments = s.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.' || seg.trim() === '') return null;
  }
  return segments.join('/');
}

// One DICOM UID path segment. UIDs are dotted digits, but we defend against a
// malformed value: strip anything that is not a UID-legal char and reject empty.
function safeUidSegment(value) {
  const s = String(value || '').trim();
  const cleaned = s.replace(/[^0-9.]/g, '');
  return cleaned.length ? cleaned : null;
}

// Build the archive-bucket key for one instance from its DICOM identity.
// StudyDate (DA, 'YYYYMMDD') -> YYYY/MM/DD prefix; otherwise no date prefix and
// the study/series/sop hierarchy alone locates the object.
function buildArchiveKey(destPrefix, meta) {
  const study = safeUidSegment(meta.studyInstanceUID);
  const series = safeUidSegment(meta.seriesInstanceUID);
  const sop = safeUidSegment(meta.sopInstanceUID);
  if (!study || !series || !sop) return null;

  const sd = String(meta.studyDate || '').trim();
  let datePrefix = '';
  if (/^\d{8}$/.test(sd)) {
    const y = sd.slice(0, 4), m = sd.slice(4, 6), d = sd.slice(6, 8);
    // Guard against a syntactically-8-digit but invalid date (e.g. month 00/13).
    const mo = Number(m), da = Number(d);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      datePrefix = `${y}/${m}/${d}/`;
    }
  }
  return `${destPrefix}${datePrefix}${study}/${series}/${sop}.dcm`;
}

exports.handler = async (event) => {
  console.log('Upload URL Generator:', event.httpMethod, event.path);
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    // Decode the request body (API Gateway may base64-encode it) and parse.
    // (Removed the BODYDIAG/FILESDIAG diagnostics that logged the raw request
    // body head and shape — a request-content leak from an earlier investigation.)
    const rawBody = event.body;
    const decodedBody = event.isBase64Encoded && typeof rawBody === 'string'
      ? Buffer.from(rawBody, 'base64').toString('utf8')
      : rawBody;
    const body = JSON.parse(decodedBody || '{}');
    const { datastoreId, files } = body;

    if (!Array.isArray(files) || files.length === 0) return err(400, 'files array required');
    if (files.length > MAX_FILES) return err(400, `Too many files. Maximum ${MAX_FILES} allowed, got ${files.length}`);
    const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalSize > MAX_TOTAL_BYTES) {
      return err(400, `Total size exceeds 10GB limit. Got ${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB`);
    }

    // Two modes on the same route:
    //   DICOM import (datastoreId present) -> presign directly into the
    //     datastore ARCHIVE bucket at the DICOM-partition key; s3-ingest indexes
    //     from the archive S3 event. No staging, no import job.
    //   Non-DICOM (no datastoreId) -> LEGACY staging-bucket presign; the
    //     non-DICOM encapsulation flow turns those into DICOM later. Preserved so
    //     /non-dicom-import/upload-url keeps working unchanged.
    if (!datastoreId) {
      return handleStagingPresign(event, body, files);
    }
    // F14: authorize the caller's WRITE access to this specific datastore before
    // handing back a presigned PUT into its archive bucket. Without this, any
    // authenticated user could name another tenant's datastoreId and get a URL
    // to write .dcm objects into it (the server-built key only bounds WHERE in
    // the prefix, not WHICH datastore).
    if (!callerCanStore(event, datastoreId)) {
      return err(403, 'You do not have write permission for this datastore');
    }
    return handleArchivePresign(datastoreId, files);
  } catch (error) {
    console.error('Error generating upload URLs:', error.message);
    return err(500, error.message);
  }
};

// DICOM: presign directly into the datastore's archive bucket at the partition key.
async function handleArchivePresign(datastoreId, files) {
  const rows = await query(
    "SELECT s3_bucket_name, s3_prefix, status, access_level, deleted FROM datastores WHERE id = ? AND deleted = FALSE AND status = 'ACTIVE'",
    [datastoreId]
  );
  const datastore = rows && rows[0];
  if (!datastore || !datastore.s3_bucket_name) {
    return err(404, 'Datastore not found or has no writable S3 bucket');
  }
  // Writable-destination rule (shared layer): a read-only storage (the default
  // for an imported bucket) never gets a presigned PUT, whoever asks.
  const refused = storageWriteRefusal(datastore);
  if (refused) {
    return err(refused.statusCode, refused.message);
  }
  const destBucket = datastore.s3_bucket_name;
  const destPrefix = datastore.s3_prefix ? datastore.s3_prefix.replace(/^\/+|\/+$/g, '') + '/' : '';

  const uploadUrls = [];
  const failed = [];
  await Promise.all(files.map(async (f) => {
    const clientId = f.clientId || f.name;
    const key = buildArchiveKey(destPrefix, f);
    if (!key) {
      failed.push({ file: clientId, reason: 'missing StudyInstanceUID/SeriesInstanceUID/SOPInstanceUID' });
      return;
    }
    const command = new PutObjectCommand({ Bucket: destBucket, Key: key, ContentType: 'application/dicom' });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    uploadUrls.push({ file: clientId, url, key, bucket: destBucket, method: 'PUT' });
  }));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: { uploadUrls, bucketName: destBucket, failed, expiresIn: 3600 } })
  };
}

// Non-DICOM (legacy): presign into the shared staging bucket keyed by
// {username}/{timestamp}/{folder}/{path}. Kept verbatim for the non-DICOM
// encapsulation flow, which reads these staged objects by s3Key.
async function handleStagingPresign(event, body, files) {
  const uploadBucket = process.env.UPLOAD_BUCKET_NAME;
  const { folderName, timestamp } = body;
  const useTimestamp = timestamp || Date.now();
  // F14: the key prefix is the UPLOADER'S identity, so it must come from the
  // authenticated principal — never a client-supplied body.username, which a
  // caller could set to another user's name to land objects under their prefix.
  const username = callerUsername(event);
  if (!username) {
    return err(403, 'Authenticated user context required');
  }

  // F16: the folderName is a client value too — sanitize it once up front.
  const safeFolder = folderName != null ? safeRelPath(folderName) : '';
  if (folderName != null && safeFolder === null) {
    return err(400, 'Invalid folderName');
  }

  const failed = [];
  const uploadUrls = (await Promise.all(files.map(async (file) => {
    // The client controls s3Key / path; keep them strictly UNDER the caller's
    // own {username}/{timestamp}/ prefix — a traversal attempt is rejected,
    // never silently clamped, so a bad client fails loudly.
    const rel = file.s3Key != null
      ? safeRelPath(file.s3Key)
      : safeRelPath(`${safeFolder ? safeFolder + '/' : ''}${file.path}`);
    if (rel === null) {
      failed.push({ file: file.s3Key || file.path || '(unnamed)', reason: 'invalid or unsafe path' });
      return null;
    }
    const key = `${username}/${useTimestamp}/${rel}`;
    const command = new PutObjectCommand({
      Bucket: uploadBucket,
      Key: key,
      ContentType: file.type || 'application/octet-stream',
      Metadata: { originalName: file.name || '', uploadedBy: username, uploadTimestamp: useTimestamp.toString() }
    });
    const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
    return { file: file.s3Key || file.path, url, key, method: 'PUT' };
  }))).filter(Boolean);

  if (uploadUrls.length === 0) {
    return err(400, 'No valid files to upload');
  }

  const firstKey = uploadUrls[0].key;
  const pathParts = firstKey.split('/');
  const s3Path = safeFolder
    ? `s3://${uploadBucket}/${username}/${useTimestamp}/${safeFolder}/`
    : `s3://${uploadBucket}/${pathParts.slice(0, -1).join('/')}/`;

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ success: true, data: { uploadUrls, bucketName: uploadBucket, s3Path, failed, expiresIn: 3600 } })
  };
}
