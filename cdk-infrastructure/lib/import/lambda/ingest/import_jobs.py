"""import_jobs progress tracking for objects indexed by the s3-ingest Lambda.

How an archive object maps back to a job: import-trigger's S3 branch copies
every staged object under the job's `s3_input_uri` (s3://staging-bucket/prefix/)
into the datastore archive bucket at `{datastore.s3_prefix}/{stagedKey}`,
preserving the full staged key, and sets `total_files` to the copy count. So an
archive object belongs to a job when its key — with the datastore prefix
stripped — starts with the job's staged input prefix.

Columns written (schema.sql import_jobs, same ones job-status-updater writes on
the legacy path): processed_files, failed_files, instances_imported,
total_size_bytes, progress_percentage, error_message, error_details, status,
completed_at, updated_at.

Extraction products ('{key}.extracted/…' from unpack-on-ingest) match the job
prefix but were never in `total_files`, so they contribute
`instances_imported` only (`count_file=False`) — a success must not inflate
`processed_files` past `total_files`. Their FAILURES do count into
`failed_files`, deliberately: visibility over arithmetic purity.

Completion is a separate conditional UPDATE (not part of the increment) so the
caller can tell from rowcount whether *this* invocation flipped the job and
emit the audit event exactly once.
"""

from archive_ingest import EXTRACTED_MARKER

# Cap on error_details entries per job, so a job with thousands of bad files
# doesn't grow a multi-MB JSON column. error_message always carries the latest.
_MAX_ERROR_DETAILS = 100

_ACTIVE_STATUSES = ("PENDING", "IN_PROGRESS")


def _parse_s3_uri_prefix(uri: str) -> str | None:
    """Key prefix of an s3://bucket/prefix URI (trailing slash ensured)."""
    if not uri or not uri.startswith('s3://'):
        return None
    rest = uri[len('s3://'):]
    if '/' not in rest:
        return ''
    prefix = rest.split('/', 1)[1]
    if prefix and not prefix.endswith('/'):
        prefix += '/'
    return prefix


def _strip_datastore_prefix(datastore, key: str) -> str:
    if datastore.prefix and key.startswith(datastore.prefix + '/'):
        return key[len(datastore.prefix) + 1:]
    return key


def _candidate_jobs(conn, datastore_id: str):
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, s3_input_uri FROM import_jobs "
            "WHERE datastore_id = %s AND status IN %s "
            "  AND s3_input_uri IS NOT NULL "
            "ORDER BY created_at DESC",
            (datastore_id, _ACTIVE_STATUSES),
        )
        return cur.fetchall()
    finally:
        cur.close()


def match_job(conn, datastore, key: str, cache: dict):
    """(job_id, count_file) for the job owning this object, or None.

    `cache` memoizes the active-job list per datastore for the duration of one
    Lambda invocation (an SQS batch), so a 10-object batch costs one SELECT.
    """
    if datastore is None:
        return None
    jobs = cache.get(datastore.id)
    if jobs is None:
        jobs = _candidate_jobs(conn, datastore.id)
        cache[datastore.id] = jobs

    stripped = _strip_datastore_prefix(datastore, key)
    is_extracted = EXTRACTED_MARKER in stripped
    for job_id, s3_input_uri in jobs:
        job_prefix = _parse_s3_uri_prefix(s3_input_uri)
        if job_prefix is None:
            continue
        if stripped.startswith(job_prefix):
            return job_id, not is_extracted
    return None


def record_object_success(conn, job_id: str, instance_count: int,
                          size_bytes: int, count_file: bool = True):
    """Credit one indexed object to its job. Caller commits."""
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE import_jobs SET "
            "  processed_files = processed_files + %s, "
            "  instances_imported = instances_imported + %s, "
            "  total_size_bytes = total_size_bytes + %s, "
            "  progress_percentage = LEAST(100, ROUND(100 * (processed_files + failed_files) / GREATEST(total_files, 1), 2)), "
            "  updated_at = NOW() "
            "WHERE id = %s",
            (1 if count_file else 0, int(instance_count), int(size_bytes or 0), job_id),
        )
    finally:
        cur.close()


def record_object_failure(conn, job_id: str, key: str, error: str,
                          count_file: bool = True):
    """Charge one failed object to its job. Caller commits.

    `count_file` is accepted for signature symmetry with the success path but
    failed_files ALWAYS increments — extraction products were never in
    total_files, yet their failures must be visible (locked posture:
    visibility over arithmetic purity; see module docstring).
    """
    del count_file
    message = (error or 'ingest failed')[:1024]
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE import_jobs SET "
            "  failed_files = failed_files + 1, "
            "  error_message = %s, "
            "  error_details = IF("
            "      JSON_LENGTH(COALESCE(error_details, JSON_ARRAY())) < %s, "
            "      JSON_ARRAY_APPEND(COALESCE(error_details, JSON_ARRAY()), '$', "
            "                        JSON_OBJECT('key', %s, 'error', %s)), "
            "      error_details), "
            "  progress_percentage = LEAST(100, ROUND(100 * (processed_files + failed_files) / GREATEST(total_files, 1), 2)), "
            "  updated_at = NOW() "
            "WHERE id = %s",
            (message, _MAX_ERROR_DETAILS, key, message, job_id),
        )
    finally:
        cur.close()


def maybe_complete_job(conn, job_id: str):
    """Flip the job to its terminal status when every counted file landed.

    Returns the terminal status string when THIS call performed the flip
    (rowcount 1), else None. total_files > 0 guards the race where objects
    index before import-trigger has finished counting the copy.
    """
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE import_jobs SET "
            "  status = IF(failed_files > 0, 'COMPLETED_WITH_FAILURES', 'COMPLETED'), "
            "  completed_at = NOW(), "
            "  progress_percentage = 100.00, "
            "  updated_at = NOW() "
            "WHERE id = %s AND status IN %s AND total_files > 0 "
            "  AND processed_files + failed_files >= total_files",
            (job_id, _ACTIVE_STATUSES),
        )
        if cur.rowcount != 1:
            return None
    finally:
        cur.close()

    # If this job was a bucket sync/backfill, clear the datastore's SYNCING
    # status back to ACTIVE now that the crawl's objects have all been indexed.
    # Scoped to created_by='backfill' jobs so an ordinary import doesn't touch
    # datastore status here. Only flips a datastore that is actually SYNCING.
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE datastores d "
            "JOIN import_jobs j ON j.datastore_id = d.id "
            "SET d.status = 'ACTIVE', d.updated_at = NOW() "
            "WHERE j.id = %s AND j.created_by = 'backfill' AND d.status = 'SYNCING'",
            (job_id,),
        )
    finally:
        cur.close()

    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT status, job_name, datastore_id, total_files, "
            "       processed_files, failed_files, instances_imported "
            "FROM import_jobs WHERE id = %s",
            (job_id,),
        )
        row = cur.fetchone()
    finally:
        cur.close()
    if row is None:
        return None

    # A non-DICOM import (non_dicom_imports.import_job_id) waits in
    # IMPORTING on this job; carry the terminal status over so it doesn't sit
    # there forever. Best effort: a failure here must not undo the job flip.
    try:
        cur = conn.cursor()
        try:
            if row[0] == 'COMPLETED':
                cur.execute(
                    "UPDATE non_dicom_imports SET status = 'COMPLETED', "
                    "  status_description = %s, updated_at = NOW() "
                    "WHERE import_job_id = %s AND status = 'IMPORTING'",
                    (f"Imported {row[6]} instance(s)", job_id),
                )
            else:
                cur.execute(
                    "UPDATE non_dicom_imports SET status = 'FAILED', "
                    "  status_description = %s, updated_at = NOW() "
                    "WHERE import_job_id = %s AND status = 'IMPORTING'",
                    (f"{row[5]} of {row[3]} file(s) failed to import", job_id),
                )
        finally:
            cur.close()
    except Exception as exc:  # noqa: BLE001
        print(f"WARNING: could not update linked non-DICOM import for job {job_id}: {exc}")

    return {
        'status': row[0],
        'jobName': row[1],
        'datastoreId': row[2],
        'totalFiles': row[3],
        'processedFiles': row[4],
        'failedFiles': row[5],
        'instancesImported': row[6],
    }
