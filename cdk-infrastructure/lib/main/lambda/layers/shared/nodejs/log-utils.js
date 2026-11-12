// Shared logging helpers.
//
// This system processes Protected Health Information (PHI). Error objects and
// request payloads can contain PHI/PII (patient identifiers, DICOM metadata,
// user emails). Logging them verbatim risks leaking that data into CloudWatch.
// `sanitizeError` returns only the non-sensitive fields safe for logs.

function sanitizeError(err) {
  if (err === null || err === undefined) {
    return { message: String(err) };
  }
  if (typeof err === 'string') {
    return { message: err };
  }
  const safe = { message: err.message || String(err) };
  if (err.name) safe.name = err.name;
  if (err.code) safe.code = err.code;
  if (err.statusCode) safe.statusCode = err.statusCode;
  return safe;
}

module.exports = { sanitizeError };
