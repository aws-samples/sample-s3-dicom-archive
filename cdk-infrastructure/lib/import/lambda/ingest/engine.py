# PHI notice: this module handles Protected Health Information (patient name, ID,
# birth date, sex, accession number and other DICOM identifiers). Deployers are
# responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
# responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
"""s3-ingest Lambda: index archive-bucket S3 events into the DICOM index tables.

Ported from reference/dicomweb-s3/lambda/ingest/handler.py with these
extensions:

  * Datastore resolution — buckets are per-datastore; the event's bucket maps to
    datastores.id/s3_prefix via a cached DB lookup. Objects landing in a bucket
    no datastore owns fail VISIBLY (Import Object Failed event + DLQ forward).
  * Tenancy — study/series/instance rows carry datastore_id (the INTERNAL
    datastores.id UUID) and every lookup is datastore-scoped;
    instanceid = 63-bit SHA-256 hash over 'datastore_id|SOPInstanceUID'
    (BIGINT UNSIGNED column).
  * Event sources — the ingest queue delivers BOTH classic S3 notification
    records and EventBridge-wrapped S3 events; both shapes normalize here.
    Handled: Object Created (index), Object Deleted (soft-delete / WSI
    OFFLINE), storage-class / intelligent-tiering transitions and restore
    lifecycle (availability model: below Glacier Instant Retrieval ⇒ OFFLINE,
    restore-in-progress ⇒ NEARLINE, restored/instant ⇒ ONLINE, surfaced via
    instance.instanceavailability + series rollup).
  * Compressed tar + ZIP — unpack-on-ingest (archive_ingest): members are PUT
    back under '{originalKey}.extracted/…', the original is retained, and the
    extracted copies index via their own events. Unsupported/corrupt/oversized
    archives fail visibly, never silently.
  * import_jobs — objects under a job's staged input prefix update
    processed_files/failed_files/instances_imported/total_size_bytes and flip
    status/completed_at when the counts reach total_files (import_jobs.py).
  * Synthetic EventBridge events on the shared bus (index_events.py), source
    'dicom.archive.index', plus audit events in the shared-layer wire shape.

Logging: bucket names, keys, UIDs and counts only — never parsed patient
demographics (no PHI in log lines).
"""

import json
import os
import gzip
import hashlib
import random
import time
import typing
import urllib.parse
import uuid

import boto3
import pymysql
import pydicom
from io import BytesIO

import archive_ingest
import import_jobs
import index_events
import tar_ingest
from ingest_errors import PermanentIngestError
# Shared DICOM-header primitives (also used by the index-attribute re-index lambda).
# Re-exported under their original names so call sites in this module are unchanged.
from dicom_header import (

    _get_tag,
    _find_pixel_offset,
    _ranged_read,
    _content_range_total,
    _is_main_pixel_data,
    _extend_header_to_pixel_data,
)


# Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
# (rds-global-bundle.pem, shipped beside this file) instead of the old
# check_hostname-only config that supplied NO CA and therefore skipped cert
# verification entirely. PyMySQL verifies the chain once 'ca' is set; hostname
# verification is ENFORCED (check_hostname=True, verify-full): the bundle also
# trusts public roots, so skipping it would accept ANY public cert for the DB.
# DB_SSL_CA_PATH overrides the bundle location.
_RDS_CA = os.environ.get(
    "DB_SSL_CA_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-global-bundle.pem"),
)


# MySQL deadlock retry policy. Errno 1213 ("Deadlock found when trying to get
# lock; try restarting transaction") happens whenever many concurrent Lambdas
# upsert the same parent rows (patient/study/series). The detector kills one
# transaction; the standard remedy is to retry. 5 attempts with jittered
# exponential backoff covers all realistic contention; after that we let the
# message fail so SQS can redeliver.
DEADLOCK_ERRNO = 1213
DEADLOCK_MAX_ATTEMPTS = 5
DEADLOCK_BASE_BACKOFF_S = 0.05  # first sleep ~50-100 ms, doubles each attempt


s3_client = boto3.client('s3')
sqs_client = boto3.client('sqs')

# ── ingestion-v2 coalescing pipeline ─────────────────────────────────────────
# When INGESTION_V2 is on, this lambda (stage-1) does NOT recompute the
# contended study/series aggregates inline. Instead, after the instance rows are
# durable it emits ONE message per distinct study+series onto a FIFO queue,
# using a hash of (StudyInstanceUID + SeriesInstanceUID) as the MessageGroupId.
# FIFO single-flight-per-group guarantees the stage-2 consumer serialises all
# recomputes for one series onto one invocation/transaction, so the many
# concurrent parent-row upserts that caused the 1213 deadlock storm collapse to
# one writer per series. The real UIDs travel in the body; a group-id hash
# collision (astronomically unlikely with SHA-256) is harmless — stage-2 groups
# by the body UIDs, so an accidental co-grouping just serialises two unrelated
# series together, never mixes their data.
_INGESTION_V2 = (os.environ.get('INGESTION_V2', '') or '').lower() in ('1', 'true', 'yes')
# Per-series VF assignment queue. When set, the batch finalize emits one message
# per touched series so the vf-assign-consumer evaluates the datastore's enabled
# VF rules against the recomputed series/study/patient rows (OFF the per-instance
# write path). Unset -> emit is a no-op (rule eval falls to the VF-indexer).
_VF_ASSIGN_QUEUE_URL = os.environ.get('VF_ASSIGN_QUEUE_URL', '')

# ── Pathology (WSI) sniff-and-fork ───────────────────────────────────────────
# When PATHOLOGY_QUEUE_URL is set, THIS lambda is the shared ingest entry point:
# a slide (TIFF-magic sniff, extension-independent) is NOT processed here —
# instead the object is forwarded verbatim to the pathology queue, so a
# multi-GB slide never occupies a DICOM worker for more than the millisecond
# it takes to sniff-and-forward. When the var is UNSET, this lambda IS the
# pathology worker: it processes the slide inline via path_ingest.process_svs.
# The classification is purely magic-byte based (DICM@128 first, then TIFF
# magic) — no reliance on the object's file extension for routing.
_PATHOLOGY_QUEUE_URL = os.environ.get('PATHOLOGY_QUEUE_URL', '')

# Stage-1 get-or-create parents (experimental, DEFAULT OFF). When '1', the lean
# V2 branch does a get-or-create for patient/study/series instead of SELECT-or-
# NULL: SELECT first (lock-free MVCC read, the common case once a series exists),
# and only on a miss create the parent rows (INSERT..ON DUPLICATE KEY, deadlock-
# retry-wrapped). The instance then always links INLINE (series_pkey never NULL),
# so stage-2's _backfill_instance_fks — the UPDATE whose lock contention wedged
# stage-2 under a batchSize-200 flood — never has work to do. The AGGREGATE
# recompute stays in stage-2 (tracker-driven, single-writer via FIFO), so only
# row-EXISTENCE moves to stage-1, not the count updates. Risk being A/B-tested:
# concurrent first-instances of many new series racing the same parent-row upsert
# (esp. the shared patient row) could re-introduce V1-style contention; the
# SELECT-first path keeps that to each parent's brief birth, not every instance.
_STAGE1_CREATE_PARENTS = (os.environ.get('STAGE1_CREATE_PARENTS', '') or '').lower() in ('1', 'true', 'yes')

def _emit_vf_assign_messages(conn, cache):
    """Emit ONE VF-assign message per distinct series touched this batch.

    Called at batch finalize AFTER the instance writes are durable and the
    aggregates are recomputed, so the consumer reads settled series/study rows.
    Source of truth for 'touched series' is cache.touched_study_series_v2 (the
    (datastore, study_uid, series_uid) map populated for EVERY touched instance
    on the lean V2/V3 path) — cache.touched_series (pkeys) is only populated when
    a series' parents are freshly created, so it would miss series that only
    received new instances into an already-existing series.

    Body: {datastore_id, series_pkey, study_uid, series_uid}. series_pkey is
    resolved with the existing lock-free MVCC read (_select_parent_pkey), never a
    write lock. send_message_batch in chunks of 10 (standard queue -> no
    MessageGroupId/dedup). No-op when the queue url is unset or nothing was
    touched. A send failure raises so the SQS batch retries (instance rows are
    durable + the assign INSERTs are idempotent, so a retry is safe)."""
    if not cache or not getattr(cache, 'touched_study_series_v2', None):
        return
    if not _VF_ASSIGN_QUEUE_URL:
        return
    triples = list(cache.touched_study_series_v2.keys())
    bodies = []
    for (datastore_id, study_uid, series_uid) in triples:
        series_pkey = _select_parent_pkey(
            conn, 'series_pkey', 'series', 'seriesinstanceuid',
            datastore_id, series_uid)
        if series_pkey is None:
            # Series row not resolvable (e.g. an object with no SeriesUID, or a
            # not-yet-created parent). Skip — the VF-indexer reconciles later.
            continue
        bodies.append(json.dumps({
            'datastore_id': datastore_id,
            'series_pkey': int(series_pkey),
            'study_uid': study_uid,
            'series_uid': series_uid,
        }, separators=(',', ':')))
    for i in range(0, len(bodies), 10):
        chunk = bodies[i:i + 10]
        entries = [{'Id': str(n), 'MessageBody': b} for n, b in enumerate(chunk)]
        resp = sqs_client.send_message_batch(QueueUrl=_VF_ASSIGN_QUEUE_URL, Entries=entries)
        failed = resp.get('Failed') or []
        if failed:
            raise RuntimeError(f"VF-assign send failed for {len(failed)}/{len(entries)}: {failed}")


# Any DICOM element whose value exceeds this size is stripped from the inline
# metadata blob and replaced with a BulkDataURI pointing at the bulk endpoint.
# Keeps Instancemetadata rows lean even for objects with huge private tags.
BULK_DATA_THRESHOLD_BYTES = 1024


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, '') or default)
    except ValueError:
        return default


# Header prefetch. The first ranged GET is HEADER_WINDOW_BYTES, which covers
# essentially every clinical object in one round trip. When PixelData isn't in
# that window the header is genuinely bigger, and we keep fetching windows until
# we find it (see _extend_header_to_pixel_data) — a truncated header means both
# a partial metadata blob and a bogus pixel offset, so guessing is not an option.
#
# HEADER_MAX_BYTES bounds the walk. Objects with no PixelData at all (RTSTRUCT,
# SR, presentation states) are read to EOF or to this cap, whichever comes first;
# the accumulated buffer plus the parsed dataset has to fit in the Lambda's
# 1024 MB, which 64 MB comfortably does.
#
# The initial window is deliberately small (256 KB): the header of almost every
# single-frame clinical object — and every ~50 KB object in the perf corpus —
# fits inside it, so the common case is ONE small ranged GET, not a 2 MB
# transfer. When PixelData is not in the first window (large multi-frame headers,
# fat private tags) _extend_header_to_pixel_data fetches further HEADER_WINDOW_
# BYTES windows on demand until it finds the main (7FE0,0010) tag, so bigger
# headers stay correct — they just cost the extra GET they actually need. Both
# are env-overridable so the window can be retuned without a code change.
HEADER_WINDOW_BYTES = _env_int('HEADER_WINDOW_BYTES', 256 * 1024)
# Exponential header prefetch (S3 read minimization): the FIRST ranged GET reads
# HEADER_INITIAL_BYTES (100 KB), which holds the full DICOM header for the
# overwhelming majority of instances. If PixelData still hasn't been located,
# _extend_header_to_pixel_data reads another HEADER_GROWTH_START (200 KB), then
# DOUBLES the chunk each subsequent extension (200K -> 400K -> 800K -> ...),
# bounded by HEADER_MAX_BYTES. Most objects cost one small 100 KB GET; the rare
# fat-header object converges in a few exponentially-growing reads.
HEADER_INITIAL_BYTES = _env_int('HEADER_INITIAL_BYTES', 100 * 1024)
HEADER_GROWTH_START = _env_int('HEADER_GROWTH_START', 200 * 1024)
HEADER_MAX_BYTES = _env_int('HEADER_MAX_BYTES', 64 * 1024 * 1024)


# Env contract (see the module docstring in each helper for semantics):
#   DB_SECRET_ARN  (required) Secrets Manager secret with host/port/username/
#                  password/dbname; DB_HOST / DB_NAME / DB_PORT override it.
#   EVENT_BUS_NAME (index_events) shared '{stackPrefix}-event-bus'.
#   INGEST_DLQ_URL (optional) queue URL permanent failures are forwarded to.
#   ARCHIVE_EXTRACT_MAX_BYTES / ARCHIVE_EXTRACT_MAX_MEMBERS caps for
#                  unpack-on-ingest (defaults 4 GiB / 20000).
#   ARCHIVE_UNPACK_ENABLED (default true) when false, compressed archives
#                  (zip + compressed tar) are skipped, not unpacked/ingested.
#   DATASTORE_CACHE_TTL_SECONDS bucket→datastore lookup cache (default 300).
INGEST_DLQ_URL = os.environ.get('INGEST_DLQ_URL', '')
ARCHIVE_EXTRACT_MAX_BYTES = _env_int('ARCHIVE_EXTRACT_MAX_BYTES',
                                     archive_ingest.DEFAULT_MAX_EXTRACT_BYTES)
ARCHIVE_EXTRACT_MAX_MEMBERS = _env_int('ARCHIVE_EXTRACT_MAX_MEMBERS',
                                       archive_ingest.DEFAULT_MAX_EXTRACT_MEMBERS)
DATASTORE_CACHE_TTL_SECONDS = _env_int('DATASTORE_CACHE_TTL_SECONDS', 300)

# ARCHIVE_UNPACK_ENABLED (default true) — the unpack-on-ingest path for
# COMPRESSED archives (ZIP and compressed tar: .tar.gz/.tgz/.tar.bz2/.tar.xz/
# .tar.zst/…). When set to a falsey value ('0'/'false'/'no'/'off'), a compressed
# archive is NOT extracted and NOT ingested: the object is left untouched and the
# message is acknowledged as SKIPPED (no DLQ, no Import Object Failed event). This
# only gates COMPRESSED archives — uncompressed .tar (indexed in place) and plain
# DICOM are unaffected, since neither goes through the unpack path.
ARCHIVE_UNPACK_ENABLED = (os.environ.get('ARCHIVE_UNPACK_ENABLED', 'true')
                          or 'true').strip().lower() not in ('0', 'false', 'no', 'off')


class Datastore(typing.NamedTuple):
    """The resolved owner of an archive bucket (internal UUID + key prefix)."""
    id: str
    bucket: str
    prefix: str  # normalized: no leading/trailing slashes, '' when none
    # datastores.access_level: NULL (app-owned) or 'read-write' is writable,
    # anything else ('read-only', the default for an imported bucket) is not.
    # Ingest only READS the bucket, except unpack-on-ingest, which PUTs extracted
    # members back and so must refuse a non-writable storage.
    access_level: str | None = None

    @property
    def writable(self) -> bool:
        """Same access_level rule as layers/shared/nodejs/writable-destination.js."""
        return self.access_level is None or self.access_level == 'read-write'


class ObjectEvent(typing.NamedTuple):
    """One normalized S3 object event (classic or EventBridge shape)."""
    action: str          # CREATED | REMOVED | TRANSITION |
                         # RESTORE_INITIATED | RESTORE_COMPLETED | RESTORE_EXPIRED
    bucket: str
    key: str
    availability: str | None = None  # for TRANSITION: mapped target availability


class CreatedResult(typing.NamedTuple):
    """What _handle_created did with one object."""
    kind: str            # dicom | wsi | wsi-forward | sidecar | tar | archive-extracted
    instances: list      # summary dicts for index_events
    size_bytes: int = 0
    extracted_count: int = 0
    members_found: int = 0
    members_failed: int = 0
    # Summaries of instances retired because this object superseded them
    # (overwrite with new UIDs) -> 'Instance Deleted' events.
    retired: list | None = None


def _bulk_uri_for(datastore_id: str, sop_uid: str, tag) -> str:
    """Build a BulkDataURI the DICOMweb service can resolve back to bytes.

    Routes are rebased from the reference's '/aetitle/...' to the datastore-
    scoped '/dicomweb/{datastoreId}/...' contract (assessment §2.1/§6).
    """
    tag_str = f"{tag.group:04X}{tag.element:04X}"
    return f"/dicomweb/{datastore_id}/bulk/element/{sop_uid}/{tag_str}"


def _stable_instanceid(datastore_id: str, sop_uid: str) -> int:
    """Deterministic 63-bit positive int from 'datastore_id|SOPInstanceUID'.

    Locked decision: instanceid is BIGINT UNSIGNED and datastore-scoped. The
    reference's 31-bit SHA1[:4] over the bare SOP UID reaches ~1% collision
    probability around 65k instances; 63 bits of SHA-256 puts a silent
    ON DUPLICATE KEY row-merge out of reach at enterprise scale.
    """
    seed = f"{datastore_id}|{sop_uid}".encode('utf-8')
    digest = hashlib.sha256(seed).digest()
    return int.from_bytes(digest[:8], 'big') & 0x7FFFFFFFFFFFFFFF


# ── Parent-row cache + deterministic lock ordering (deadlock avoidance) ──────
# THE ingest deadlock storm (proven live: ~2832 deadlocks vs 2313 indexes in a
# 3-minute window, errno 1213/1205) comes from the patient/study/series rows.
# Every DICOM instance of a study shares those THREE parent rows, so with ~40-100
# concurrent Lambdas each running an SQS batch, many transactions simultaneously
# INSERT..ON DUPLICATE KEY UPDATE the SAME unique keys. InnoDB's next-key locking
# on those unique indexes forms cross-transaction lock cycles → deadlock. The
# _with_deadlock_retry wrapper only MASKS it: each retry re-does the whole object
# plus a backoff sleep, collapsing throughput to ~11 inst/s.
#
# Two properties kill the storm, both implemented here:
#
#   1. Upsert each DISTINCT patient / study / series ONCE per invocation, not
#      once per instance. A 15-object same-study batch then touches 1 patient +
#      1 study + N-series rows instead of 15 + 15 + 15 — collapsing the number of
#      contended writes by ~15x. The cache below (keyed by natural key) memoizes
#      the resolved pkey so every later instance in the batch reuses it.
#
#   2. SELECT-FIRST on the parents. The overwhelming steady-state case is that
#      the parent row already exists (re-ingest, or a study whose first instance
#      already landed): a plain SELECT on the unique key takes a shared read, not
#      the next-key WRITE lock that INSERT..ON DUP takes even for a no-op row. A
#      read never forms the write-write cycle that deadlocks, so the contended
#      hot path stops taking write locks entirely. The INSERT..ON DUP path is hit
#      only when the row is genuinely absent (first instance of a brand-new
#      parent), and those inserts are ordered deterministically (see
#      _flush_parent_upserts) so concurrent invocations acquire the gap locks in
#      the SAME order — the classic anti-deadlock discipline.
#
# This also removes the prior `<pkey> = LAST_INSERT_ID(<pkey>)` forced write on
# the ON DUP SET list, which took a write lock on EVERY parent upsert, including
# pure no-op re-ingests — exactly the wrong thing under contention.


class _ParentCache:
    """Per-invocation memo of resolved patient/study/series pkeys.

    Keyed by natural key so the whole SQS batch — which may span several
    studies/series — resolves each distinct parent exactly once. Also collects
    the parents that still need inserting so handler() can flush them in a
    deterministic, sorted order before the per-instance writes.

    Scope is one Lambda invocation (one SQS batch). A fresh cache per handler()
    call means a warm-container reuse never serves a stale pkey across
    invocations, and the direct-call test paths (no cache) keep working.
    """

    def __init__(self):
        # natural key -> pkey (int) once resolved.
        self.patient: dict = {}
        self.study: dict = {}
        self.series: dict = {}
        # Distinct parent pkeys that had a descendant written this batch. Used to
        # propagate last_updated upward once per batch (not per instance), so the
        # scheduler's last_updated window is correct without re-introducing the
        # hot-parent-row write contention the deadlock fix removed.
        self.touched_patient: set = set()
        self.touched_study: set = set()
        self.touched_series: set = set()
        # ingestion-v2 only: distinct (datastore_id, study_uid, series_uid)
        # triples touched this batch -> the MAX storage_index.content_pkey seen
        # for that series this batch. stage-1 emits one FIFO coalescing message
        # per key and upserts the series_update_tracker watermark to that max, so
        # stage-2 can tell a fresh signal from a redundant one. Populated in the
        # V2 path only; unused (empty) on V1.
        self.touched_study_series_v2: dict = {}

    @staticmethod
    def _pk(datastore_id, uid):
        return (datastore_id, uid)


def _select_parent_pkey(conn, table_pkey_col, table, where_col, datastore_id, uid):
    """SELECT the parent pkey on its datastore-scoped unique key (shared read).

    Returns the pkey, or None when the row does not exist yet. Takes only a
    shared read lock on the existing row — never the next-key WRITE lock that
    INSERT..ON DUPLICATE KEY UPDATE takes — so it cannot form the write-write
    deadlock cycle that the concurrent parent upserts do.
    """
    row = _exec_one(
        conn,
        f"SELECT {table_pkey_col} FROM {table} "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        f"WHERE datastore_id = %s AND {where_col} = %s",
        (datastore_id, uid))
    return row[0] if row else None


def _revive_parent(conn, table, table_pkey_col, pkey):
    """Clear deleted_at on a parent row that the SELECT-first path REUSED.

    Bug this fixes: when a series/study/patient was soft-deleted (deleted_at set
    by an ObjectRemoved / delete-marker event) and a new instance is later
    ingested, get-or-create HITS the existing tombstoned row on its unique key
    and returns its pkey — but the SELECT-first hit path takes no write, so the
    parent stays deleted_at != NULL while its fresh storage_index/instance rows
    are live. The study then never shows in the Studies menu (which filters
    deleted_at IS NULL). Re-ingesting into a soft-deleted parent must REVIVE it.

    Minimal + idempotent: the UPDATE is guarded by `AND deleted_at IS NOT NULL`,
    so the ordinary live-parent hit (the overwhelming common case) matches zero
    rows and pays no write — only a genuinely tombstoned parent is touched. It
    is a single-row keyed UPDATE (low contention); the INSERT-on-miss branch
    already writes a live row (deleted_at NULL) so it needs no change.
    """
    _exec(conn,
          f"UPDATE {table} SET deleted_at = NULL "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
          f"WHERE {table_pkey_col} = %s AND deleted_at IS NOT NULL",
          (pkey,))


# ── Commit strategy (per-object vs per-SQS-batch) ────────────────────────────
# Every write path here historically ended with its own conn.commit(), so a
# single object = one durable Aurora commit (an fsync round-trip). Under the
# 300k-object perf run that is the dominant per-object cost: a batchSize-10
# invocation pays ~10 serial fsync round-trips on top of the row work.
#
# handler() (the SQS entry point) sets _DEFER_COMMIT so the per-object commits
# become no-ops and it issues ONE commit after the whole Records loop — the
# batching win. Deferral is safe because every write in this file is idempotent
# (ON DUPLICATE KEY upserts keyed on stable, content-derived keys; instanceid is
# a deterministic hash of datastore_id|SOPInstanceUID), so a batch that fails
# partway is rolled back and the messages redeliver without double-counting.
#
# The flag defaults to False, so any caller that invokes a write path directly
# (unit tests, backfill helpers) keeps the original one-commit-per-call
# behaviour unchanged.
_DEFER_COMMIT = False


def _commit(conn):
    """Commit now, or defer to the batch-level commit in handler().

    A no-op while _DEFER_COMMIT is set: handler() owns the single durable commit
    for the whole SQS batch. Otherwise commits immediately (legacy behaviour).
    """
    if _DEFER_COMMIT:
        return
    conn.commit()


def _propagate_last_updated(conn, cache):
    """Bump last_updated on every parent (patient/study/series) that had a
    descendant written this batch, so the processing-job scheduler's
    last_updated window reflects 'a modified instance implies a modified
    series/study/patient'.

    Done ONCE per batch with a single UPDATE ... WHERE pkey IN (...) per level —
    not per instance — to keep the hot-parent-row write contention low (the
    deadlock fix's central concern). Tolerates a missing last_updated column
    (older DB not yet migrated): a failure is logged and skipped, never fatal to
    ingest. Instances self-maintain their own last_updated via the column's
    DEFAULT/ON UPDATE, so only the SELECT-first parents need the explicit touch.
    """
    if cache is None:
        return
    for pkeys, table, col in (
        (cache.touched_series, 'series', 'series_pkey'),
        (cache.touched_study, 'study', 'study_pkey'),
        (cache.touched_patient, 'patient', 'patient_pkey'),
    ):
        if not pkeys:
            continue
        ids = list(pkeys)
        ph = ','.join(['%s'] * len(ids))
        try:
            cur = conn.cursor()
            try:
                # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
                cur.execute(
                    f"UPDATE `{table}` SET last_updated = NOW() WHERE `{col}` IN ({ph})",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    ids)
            finally:
                cur.close()
        except Exception as e:
            # Missing column (un-migrated DB) or transient error: never fail the
            # batch over the propagation bump.
            print(f"WARNING: last_updated propagation on {table} skipped: {e}")


def _recompute_aggregates(conn, cache):
    """Recompute the DERIVED study/series aggregates for the parents touched
    this batch. These are NOT reliably present in a single instance's header,
    so we compute them from the index rows themselves, once per batch:

      series.numberofseriesrelatedinstances = COUNT(live instances in series)
      study.numberofstudyrelatedseries      = COUNT(DISTINCT live series in study)
      study.numberofstudyrelatedinstances   = COUNT(live instances in study)
      study.modalitiesinstudy               = sorted DISTINCT series.modality set

    Done set-based (one UPDATE ... JOIN per aggregate over the touched pkeys),
    not per-row. Never fatal to ingest — a failure is logged and skipped.
    """
    if cache is None:
        return
    series_ids = list(cache.touched_series)
    study_ids = list(cache.touched_study)

    try:
        if series_ids:
            ph = ','.join(['%s'] * len(series_ids))
            cur = conn.cursor()
            try:
                # series instance count
                # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
                cur.execute(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    f"""UPDATE series se
                        LEFT JOIN (
                            SELECT series_pkey, COUNT(*) c FROM instance
                            WHERE deleted_at IS NULL AND series_pkey IN ({ph})
                            GROUP BY series_pkey
                        ) x ON x.series_pkey = se.series_pkey
                        SET se.numberofseriesrelatedinstances = COALESCE(x.c, 0)
                        WHERE se.series_pkey IN ({ph})""",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    series_ids + series_ids)
            finally:
                cur.close()

        if study_ids:
            ph = ','.join(['%s'] * len(study_ids))
            cur = conn.cursor()
            try:
                # study series count
                # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
                cur.execute(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    f"""UPDATE study st
                        LEFT JOIN (
                            SELECT study_pkey, COUNT(*) c FROM series
                            WHERE deleted_at IS NULL AND study_pkey IN ({ph})
                            GROUP BY study_pkey
                        ) x ON x.study_pkey = st.study_pkey
                        SET st.numberofstudyrelatedseries = COALESCE(x.c, 0)
                        WHERE st.study_pkey IN ({ph})""",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    study_ids + study_ids)
                # study instance count (instance -> series -> study)
                # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
                cur.execute(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    f"""UPDATE study st
                        LEFT JOIN (
                            SELECT se.study_pkey, COUNT(*) c
                            FROM instance i JOIN series se ON se.series_pkey = i.series_pkey
                            WHERE i.deleted_at IS NULL AND se.deleted_at IS NULL
                              AND se.study_pkey IN ({ph})
                            GROUP BY se.study_pkey
                        ) x ON x.study_pkey = st.study_pkey
                        SET st.numberofstudyrelatedinstances = COALESCE(x.c, 0)
                        WHERE st.study_pkey IN ({ph})""",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    study_ids + study_ids)
                # modalities in study = DISTINCT non-null series.modality, joined
                # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
                cur.execute(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    f"""UPDATE study st
                        LEFT JOIN (
                            SELECT study_pkey,
                                   GROUP_CONCAT(DISTINCT modality ORDER BY modality
                                                SEPARATOR '\\\\') m
                            FROM series
                            WHERE deleted_at IS NULL AND modality IS NOT NULL
                              AND modality <> '' AND study_pkey IN ({ph})
                            GROUP BY study_pkey
                        ) x ON x.study_pkey = st.study_pkey
                        SET st.modalitiesinstudy = x.m
                        WHERE st.study_pkey IN ({ph})""",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    study_ids + study_ids)
            finally:
                cur.close()
    except Exception as e:
        print(f"WARNING: aggregate recompute skipped: {e}")


# ── DB connection (reused across invocations) ────────────────────────────────
_conn = None


def _connect_db():
    sm = boto3.client('secretsmanager')
    sec = json.loads(sm.get_secret_value(SecretId=os.environ['DB_SECRET_ARN'])['SecretString'])
    # PyMySQL uses the text protocol — no server-side prepared statements,
    # so RDS Proxy doesn't pin the backend connection per Lambda invocation.
    # That's the whole reason we picked PyMySQL over mysql-connector-python.
    #
    # SSL is required for caching_sha2_password full-auth (Aurora MySQL 8's
    # default plugin). Without TLS the auth handshake fails with "Access
    # denied" whenever the server doesn't have a fast-auth cache hit — which
    # is most of the time when going through RDS Proxy.
    return pymysql.connect(
        host=os.environ.get('DB_HOST') or sec['host'],
        user=sec['username'], password=sec['password'],
        database=os.environ.get('DB_NAME') or sec.get('dbname'),
        port=_env_int('DB_PORT', int(sec.get('port', 3306))),
        charset='utf8mb4',
        autocommit=False,
        # READ COMMITTED (vs the MySQL default REPEATABLE READ) drops next-key /
        # gap locking, so concurrent INSERT..ON DUPLICATE KEY UPDATE on the shared
        # patient/study/series unique keys stops forming gap-lock deadlock cycles.
        # Set per-connection (ingest path only) so analytics/read paths keep the
        # default isolation. Runs on every (re)connect via init_command.
        init_command="SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
        ssl={"ca": _RDS_CA, "check_hostname": True},
    )


def _get_db_conn():
    """Warm-container connection reuse: ping-and-reconnect, else fresh connect."""
    global _conn
    if _conn is not None:
        try:
            _conn.ping(reconnect=True)
            return _conn
        except Exception:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
    _conn = _connect_db()
    return _conn


# ── Datastore resolution (bucket-per-datastore) ──────────────────────────────
# bucket name -> (expires_epoch, Datastore | None). None is cached too, so a
# bucket of junk drops doesn't hammer the DB — but only for the TTL, letting a
# datastore registered after its first object start resolving.
_datastore_cache: dict = {}


def _resolve_datastore(conn, bucket: str) -> Datastore | None:
    now = time.time()
    cached = _datastore_cache.get(bucket)
    if cached is not None and cached[0] > now:
        return cached[1]

    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT id, s3_prefix, access_level FROM datastores "
            "WHERE s3_bucket_name = %s "
            "  AND deleted = FALSE "
            "ORDER BY created_at DESC LIMIT 1",
            (bucket,),
        )
        row = cur.fetchone()
    finally:
        cur.close()

    datastore = None
    if row is not None:
        prefix = (row[1] or '').strip('/')
        datastore = Datastore(id=row[0], bucket=bucket, prefix=prefix,
                              access_level=row[2] if len(row) > 2 else None)
    _datastore_cache[bucket] = (now + DATASTORE_CACHE_TTL_SECONDS, datastore)
    return datastore


def path_ingest_looks_like_tiff(prefix: bytes) -> bool:
    """True if a byte prefix starts with a TIFF/BigTIFF magic number.

    Thin re-export of path_ingest.looks_like_tiff so the created-object branch can
    sniff without importing the (layer-only tifffile-dependent) module until we
    actually need it. The magic check itself has no heavy dependency.
    """
    import path_ingest
    return path_ingest.looks_like_tiff(prefix)


def _maybe_parse_sidecar(chunk: bytes):
    """Parse a possible SVS sidecar from an object prefix.

    Returns the parsed dict if `chunk` is JSON carrying both `filepath` and
    `DICOM` (our sidecar contract), else None. Never raises — a `.json` object
    that isn't a sidecar falls through to the normal DICOM path.
    """
    try:
        obj = json.loads(chunk)
    except Exception:
        return None
    if isinstance(obj, dict) and 'filepath' in obj and 'DICOM' in obj:
        return obj
    return None


def _exec(conn, sql, params=()):
    """Execute one statement, return lastrowid."""
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return cur.lastrowid
    finally:
        cur.close()


def _upsert_returning_pkey(conn, insert_sql, insert_params,
                           lookup_sql, lookup_params):
    """Run an INSERT..ON DUPLICATE KEY UPDATE that carries a
    `<pkey> = LAST_INSERT_ID(<pkey>)` assignment, and return that pkey in ONE
    round trip instead of the historical INSERT + SELECT-back pair.

    Round-trip win: the SELECT-back is gone on both the fresh-insert and the
    ordinary duplicate-with-change paths — cursor.lastrowid already holds the
    pkey after execute(), on the SAME connection/cursor, so no `SELECT
    LAST_INSERT_ID()` hop is needed either.

    Edge case (verified on real MySQL 8, mirrors the VF indexer's fallback):
    on a PURE-DUPLICATE, ZERO-CHANGE upsert MySQL reports rowcount 0. Because
    the `<pkey> = LAST_INSERT_ID(<pkey>)` assignment is *explicitly in the SET
    list*, the server still evaluates it and refreshes the session last-insert-
    id, so lastrowid stays correct even then. But the MySQL manual leaves the
    all-columns-unchanged path implementation-defined, so we keep the VF
    indexer's belt-and-suspenders guard: if lastrowid comes back 0/None (which
    would mean the assignment did NOT fire on this server/version), fall back to
    the scoped SELECT on the unique key. The common case pays no extra round
    trip; only a genuinely unreliable no-op pays the one SELECT it used to pay
    every time.
    """
    pkey = _exec(conn, insert_sql, insert_params)
    if pkey:  # non-zero, non-None: LAST_INSERT_ID(pkey) fired — trust it.
        return pkey
    row = _exec_one(conn, lookup_sql, lookup_params)
    return row[0] if row else None


def _exec_one(conn, sql, params=()):
    """Execute a SELECT and return the first row (or None)."""
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        row = cur.fetchone()
        return row
    finally:
        cur.close()


def _exec_all(conn, sql, params=()):
    """Execute a SELECT and return all rows."""
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    finally:
        cur.close()


def _upsert_patient(conn, datastore_id: str, ds, cache: '_ParentCache | None' = None) -> int:
    patient_id = _get_tag(ds, '00100020')
    # IssuerOfPatientID (0010,0021) qualifies PatientID: two sources can assign
    # the same PatientID to different people, so patient identity is
    # (datastore_id, patientid, issuerofpatientid). Absent tag -> '' (NOT NULL),
    # so no-issuer patients still dedup — NULL would compare distinct in the
    # unique key and re-insert every ingest (same trick as storage_index
    # .s3_key_version).
    issuer = _get_tag(ds, '00100021') or ''
    key = (datastore_id, patient_id, issuer)
    if cache is not None and key in cache.patient:
        return cache.patient[key]

    # SELECT-FIRST: the steady-state hot path. If the row already exists we take
    # only a shared read lock and take NO write lock at all — so a re-ingest, or
    # a second instance of an already-seen patient, never contends on the write
    # path that deadlocks. A plain SELECT that finds the row is the common case
    # under load; the INSERT below fires only for a genuinely new patient.
    row = _exec_one(
        conn,
        "SELECT patient_pkey FROM patient "
        "WHERE datastore_id = %s AND patientid = %s AND issuerofpatientid = %s",
        (datastore_id, patient_id, issuer))
    pkey = row[0] if row else None
    if pkey is None:
        # Absent: insert. deleted_at = NULL on the UPDATE branch resurrects a
        # soft-deleted parent if a new instance lands before the GC sweep. The
        # ON DUP branch here is now only reached on a race (a concurrent
        # invocation inserted the same new patient between our SELECT and INSERT)
        # — it stays correct and idempotent, but no longer fires the
        # LAST_INSERT_ID forced-write on the ordinary no-op path.
        # uq_patient_ds_id is (datastore_id, patientid, issuerofpatientid).
        pkey = _upsert_returning_pkey(
            conn,
            """
            INSERT INTO patient (datastore_id, patientid, issuerofpatientid, patientname, patientbirthdate, patientsex)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                patient_pkey = LAST_INSERT_ID(patient_pkey),
                patientname = VALUES(patientname), deleted_at = NULL
            """,
            (datastore_id, patient_id, issuer, _get_tag(ds, '00100010'),
             _get_tag(ds, '00100030') or None, _get_tag(ds, '00100040')),
            "SELECT patient_pkey FROM patient WHERE datastore_id = %s AND patientid = %s AND issuerofpatientid = %s",
            (datastore_id, patient_id, issuer))
        # Redesign item 3a: populate enabled PATIENT-level index attrs at row
        # birth (this MISS path only), on the just-created row no other instance
        # contends on. No-op unless a PATIENT-level STORAGE attr is enabled.
        _apply_parent_index_attributes_on_create(conn, datastore_id, ds, 'PATIENT', pkey)
    else:
        # HIT: reusing an existing row. If it was soft-deleted, revive it so a
        # re-ingest un-tombstones the parent (else the study stays hidden).
        _revive_parent(conn, 'patient', 'patient_pkey', pkey)
    if cache is not None:
        cache.patient[key] = pkey
        cache.touched_patient.add(pkey)
    return pkey


def _upsert_study(conn, datastore_id: str, patient_pkey: int, ds,
                  cache: '_ParentCache | None' = None) -> int:
    study_uid = _get_tag(ds, '0020000D')
    key = (datastore_id, study_uid)
    if cache is not None and key in cache.study:
        return cache.study[key]

    # SELECT-FIRST (see _upsert_patient): existing study => shared read, no write
    # lock, no deadlock. uq_study_uid is (datastore_id, studyinstanceuid).
    pkey = _select_parent_pkey(conn, 'study_pkey', 'study', 'studyinstanceuid',
                               datastore_id, study_uid)
    if pkey is None:
        pkey = _upsert_returning_pkey(
            conn,
            """
            INSERT INTO study (datastore_id, patient_pkey, studyinstanceuid, studydate,
                studytime, accessionnumber, modalitiesinstudy, referringphysicianname,
                studydescription, studyid)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
                study_pkey = LAST_INSERT_ID(study_pkey),
                studydate = VALUES(studydate), deleted_at = NULL
            """,
            (datastore_id, patient_pkey, study_uid, _get_tag(ds, '00080020') or None,
             _get_tag(ds, '00080030') or None, _get_tag(ds, '00080050'),
             _get_tag(ds, '00080061'), _get_tag(ds, '00080090'),
             _get_tag(ds, '00081030'), _get_tag(ds, '00200010')),
            "SELECT study_pkey FROM study WHERE datastore_id = %s AND studyinstanceuid = %s",
            (datastore_id, study_uid))
        # Redesign item 3a: enabled STUDY-level index attrs at row birth.
        _apply_parent_index_attributes_on_create(conn, datastore_id, ds, 'STUDY', pkey)
    else:
        # HIT: revive a soft-deleted study on re-ingest (see _revive_parent).
        _revive_parent(conn, 'study', 'study_pkey', pkey)
    if cache is not None:
        cache.study[key] = pkey
        cache.touched_study.add(pkey)
    return pkey


def _upsert_series(conn, datastore_id: str, study_pkey: int, ds,
                   cache: '_ParentCache | None' = None) -> int:
    series_uid = _get_tag(ds, '0020000E')
    key = (datastore_id, series_uid)
    if cache is not None and key in cache.series:
        return cache.series[key]

    # SELECT-FIRST (see _upsert_patient): existing series => shared read, no
    # write lock, no deadlock. uq_series_uid is (datastore_id, seriesinstanceuid).
    pkey = _select_parent_pkey(conn, 'series_pkey', 'series', 'seriesinstanceuid',
                               datastore_id, series_uid)
    if pkey is None:
        pkey = _upsert_returning_pkey(
            conn,
            """
            INSERT INTO series (datastore_id, study_pkey, seriesinstanceuid, modality,
                seriesdate, seriesdescription, seriesnumber, numberofseriesrelatedinstances)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
                series_pkey = LAST_INSERT_ID(series_pkey),
                modality = VALUES(modality), deleted_at = NULL
            """,
            (datastore_id, study_pkey, series_uid, _get_tag(ds, '00080060'),
             _get_tag(ds, '00080021') or None, _get_tag(ds, '0008103E'),
             _get_tag(ds, '00200011') or None, _get_tag(ds, '00201209') or None),
            "SELECT series_pkey FROM series WHERE datastore_id = %s AND seriesinstanceuid = %s",
            (datastore_id, series_uid))
        # Redesign item 3a: enabled SERIES-level index attrs at row birth. This
        # is where series.bodypartexamined is now first written for a NEW series
        # — on the row's own INSERT, off the hot-row pre-commit path that lost
        # instances. Existing-series arrivals get it in the post-commit settle
        # pass (item 3b, handler.py _aggregate_series).
        _apply_parent_index_attributes_on_create(conn, datastore_id, ds, 'SERIES', pkey)
    else:
        # HIT: revive a soft-deleted series on re-ingest (see _revive_parent).
        _revive_parent(conn, 'series', 'series_pkey', pkey)
    if cache is not None:
        cache.series[key] = pkey
        cache.touched_series.add(pkey)
        # ingestion-v2: remember the study+series UIDs touched this batch so the
        # handler can emit one coalescing FIFO message per distinct study+series.
        # (Dead under the lean V2 path, which does not call _upsert_series; kept
        # dict-compatible so the type stays consistent.)
        if _INGESTION_V2:
            study_uid = _get_tag(ds, '0020000D')
            cache.touched_study_series_v2.setdefault((datastore_id, study_uid, series_uid), 0)
    return pkey


def _upsert_instance(conn, datastore_id: str, series_pkey: int, ds, instanceid: int):
    # TransferSyntaxUID lives on file_meta, not iterall(); read it directly.
    try:
        ts_uid = str(ds.file_meta.TransferSyntaxUID) if ds.file_meta else None
    except Exception:
        ts_uid = None
    # instanceavailability = NULL on the UPDATE branch: fresh bytes just landed, so an
    # instance previously marked OFFLINE by a lifecycle transition or object
    # removal is readable again (NULL is treated as ONLINE by the read path).
    _exec(conn, """
        INSERT INTO instance (instanceid, datastore_id, series_pkey, seriesid,
            transfersyntaxuid, sopclassuid, sopinstanceuid, instancenumber,
            samplesperpixel, numberofframes, `rows`, `columns`, bitsallocated)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
            series_pkey = VALUES(series_pkey),
            transfersyntaxuid = VALUES(transfersyntaxuid),
            samplesperpixel   = VALUES(samplesperpixel),
            instanceavailability = NULL,
            deleted_at  = NULL
    """, (instanceid, datastore_id, series_pkey, series_pkey,
          ts_uid,
          _get_tag(ds, '00080016'), _get_tag(ds, '00080018'),
          _get_tag(ds, '00200013') or None,
          _get_tag(ds, '00280002') or None,
          _get_tag(ds, '00280008') or None,
          _get_tag(ds, '00280010') or None,
          _get_tag(ds, '00280011') or None,
          _get_tag(ds, '00280100') or None))


# Native (uncompressed) transfer syntaxes — they have a fixed-size pixel layout
# and no encapsulation, so per-frame offsets are computable on the read side
# from rows/cols/bits and don't need an explicit cache.
_NATIVE_TS = {
    '1.2.840.10008.1.2',          # Implicit VR LE
    '1.2.840.10008.1.2.1',        # Explicit VR LE
    '1.2.840.10008.1.2.2',        # Explicit VR BE
}


def _scan_encapsulated_frame_offsets(bucket: str, key: str,
                                     pixel_data_tag_offset: int,
                                     transfer_syntax: str,
                                     number_of_frames: int) -> list | None:
    """Walk the encapsulated PixelData stream and return per-frame byte offsets.

    Returns a list of [start, end] absolute byte offsets in the S3 object,
    one pair per frame. The byte range covers the JPEG/JPEG2000/etc payload
    *only* — Item tag headers are excluded; the read side wraps the bytes in
    proper encapsulation framing if it needs to.

    Returns None when:
    - The transfer syntax is native (caller should skip).
    - The Basic Offset Table is empty AND the encoder used multi-fragment
      frames (we can't reconstruct boundaries without decoding).
    - Anything else goes wrong — caller falls back to the slow full-fetch path.

    Strategy: read the encapsulated stream in chunks (256 KB each), parsing
    Item tags as we go. Most JPEG/JPEG2000 encoders emit one Item per frame
    and the BOT either tells us the offsets or we count Items.
    """
    if transfer_syntax in _NATIVE_TS:
        return None
    if not number_of_frames or number_of_frames < 1:
        return None

    CHUNK_SIZE = 256 * 1024
    ITEM_TAG = b'\xfe\xff\x00\xe0'    # (FFFE,E000) in little-endian on the wire
    SEQ_DELIM = b'\xfe\xff\xdd\xe0'   # (FFFE,E0DD)

    # The pixel_data_tag_offset points at the (7FE0,0010) tag itself. After it
    # comes the tag header (8 or 12 bytes, same logic as the native path) then
    # the first Item tag.
    if transfer_syntax == '1.2.840.10008.1.2':
        cursor = pixel_data_tag_offset + 8   # Implicit VR: tag(4) + length(4)
    else:
        cursor = pixel_data_tag_offset + 12  # Explicit VR: tag(4) + VR(2) + reserved(2) + length(4)

    # Read the first Item header to detect the BOT.
    bot_header = _ranged_read(bucket, key, cursor, cursor + 7)
    if bot_header[:4] != ITEM_TAG:
        return None  # not encapsulated as we expected
    bot_length = int.from_bytes(bot_header[4:8], 'little')
    cursor += 8  # past the BOT Item header

    bot = b''
    if bot_length > 0:
        bot = _ranged_read(bucket, key, cursor, cursor + bot_length - 1)
        cursor += bot_length

    # If BOT is present and well-formed, just project its values onto the
    # frames-data start. Each BOT entry is a 4-byte little-endian offset
    # *relative to the first Item header AFTER the BOT*. The end of each frame
    # is implied by the next entry (or by walking Items for the last frame).
    if bot and len(bot) >= 4 * number_of_frames:
        frames_origin = cursor  # absolute offset of first frame's Item header
        starts_relative = [
            int.from_bytes(bot[i*4:(i+1)*4], 'little')
            for i in range(number_of_frames)
        ]
        # For each frame, start = frames_origin + bot_offset + 8 (skip its
        # Item header). End is start + Item length - 1. We need the length,
        # which means a tiny per-frame read. Cheap (8 bytes each).
        offsets = []
        for i, rel_start in enumerate(starts_relative):
            item_header_off = frames_origin + rel_start
            hdr = _ranged_read(bucket, key, item_header_off, item_header_off + 7)
            if hdr[:4] != ITEM_TAG:
                return None  # BOT lied, fall back
            length = int.from_bytes(hdr[4:8], 'little')
            payload_start = item_header_off + 8
            offsets.append([payload_start, payload_start + length - 1])
            # A frame is one contiguous range only if its single Item ends where
            # the next frame begins (or, for the last frame, at the Sequence
            # Delimiter). Otherwise the frame has several fragments and one range
            # would hold only the first: leave the cache empty (full-read path).
            next_off = (frames_origin + starts_relative[i + 1]) if i + 1 < number_of_frames else None
            if next_off is not None:
                if payload_start + length != next_off:
                    return None
            else:
                tail = _ranged_read(bucket, key, payload_start + length, payload_start + length + 7)
                if tail[:4] != SEQ_DELIM:
                    return None
        return offsets

    # No BOT (or unusable). Walk Items until we see the Sequence Delimitation
    # tag or have collected number_of_frames Items. Reject if we hit
    # delimitation before we have enough frames (means multi-fragment, which
    # we can't reconstruct without a BOT).
    offsets = []
    walk_cursor = cursor
    chunk = b''
    chunk_origin = walk_cursor

    def _ensure(byte_count: int):
        """Make sure `chunk` has at least byte_count bytes from walk_cursor."""
        nonlocal chunk, chunk_origin
        offset_in_chunk = walk_cursor - chunk_origin
        if offset_in_chunk < 0 or offset_in_chunk + byte_count > len(chunk):
            chunk_origin = walk_cursor
            chunk = _ranged_read(bucket, key, walk_cursor,
                                 walk_cursor + CHUNK_SIZE - 1)
        return walk_cursor - chunk_origin

    while len(offsets) < number_of_frames:
        off = _ensure(8)
        header = chunk[off:off+8]
        if len(header) < 8:
            return None  # ran off the end unexpectedly
        if header[:4] == SEQ_DELIM:
            break  # stream ended before we expected
        if header[:4] != ITEM_TAG:
            return None
        length = int.from_bytes(header[4:8], 'little')
        payload_start = walk_cursor + 8
        offsets.append([payload_start, payload_start + length - 1])
        walk_cursor = payload_start + length

    if len(offsets) != number_of_frames:
        return None  # ran out of Items — likely multi-fragment, give up
    # One Item per frame only if the stream ends right here. More Items mean
    # fragmented frames (a single-frame image owns ALL fragments, PS3.5 A.4), and
    # the first N Items would be wrong ranges, so leave the cache empty.
    off = _ensure(8)
    if chunk[off:off + 4] != SEQ_DELIM:
        return None
    return offsets




def _refuse_unpack_into_read_only(datastore: 'Datastore | None', bucket: str,
                                  key: str) -> None:
    """Unpack-on-ingest PUTs '{key}.extracted/…' back into the bucket. A
    read-only storage (an imported bucket defaults to read-only) must never be
    written to, so the archive is failed visibly instead: nothing is extracted
    and nothing is indexed for it. The original object is left untouched."""
    if datastore is not None and not datastore.writable:
        print(f"refusing to unpack compressed archive into read-only storage "
              f"{datastore.id}: s3://{bucket}/{key}")
        raise PermanentIngestError(
            "compressed archive not unpacked: the storage is read-only "
            "(unpacking would write extracted members into it)")


def _handle_created(conn, datastore: Datastore, bucket: str, key: str,
                    cache: '_ParentCache | None' = None) -> CreatedResult:
    s3prefix = key.rsplit('/', 1)[0] if '/' in key else ''

    # Pull the first header window. Objects whose header is bigger than this get
    # extended below, on the DICOM path only.
    # NoSuchKey races happen when an object is created+deleted faster than the
    # SQS event lands (or when cross-region replication produces ObjectCreated
    # events for keys that were already overwritten/deleted at the source).
    # Skip the message rather than fail it — there's nothing to ingest.
    try:
        resp = s3_client.get_object(
            Bucket=bucket, Key=key,
            Range=f"bytes=0-{HEADER_INITIAL_BYTES - 1}",
        )
    except s3_client.exceptions.NoSuchKey:
        print(f"WARNING: skipping ingest, key not found: s3://{bucket}/{key}")
        return CreatedResult(kind='skipped', instances=[])
    chunk = resp['Body'].read()
    total_size = _content_range_total(resp) or len(chunk)
    # S3 ETag of the backing object (quotes stripped). Threaded into the DICOM
    # storage_index write so delta sync can skip this key next time when it is
    # unchanged. The ranged GET response already carries it — no extra request.
    object_etag = (resp.get('ETag') or '').strip('"') or None

    # ── Whole-slide imaging branches ────────────────────────────────────────
    # A sidecar (`<slide key>.json` whose body has filepath+DICOM) carries patient/study
    # identity and is tiny — processed inline here regardless of routing. A WSI
    # TIFF (Aperio SVS or Ventana BIF) is virtualized into DICOM WSI instances;
    # it is classified by TIFF MAGIC BYTES, not by file extension. When this
    # lambda is the shared ingest ENTRY point (PATHOLOGY_QUEUE_URL set), a slide
    # is forwarded verbatim to the pathology queue instead of being processed
    # here, so a multi-GB slide never blocks the DICOM workers. When the var is
    # unset, this IS the pathology worker and it processes the slide inline via
    # process_svs (which detects the exact vendor format and refuses NDPI / plain
    # TIFF rather than mis-ingesting them). Everything else falls through to the
    # DICOM path (unchanged).
    # H1: sidecars are recognized by KEY first (only `<slide key>.json`), never by
    # content alone, so e.g. a JSON body uploaded to a presigned `.dcm` key goes
    # down the DICOM path and fails there visibly. process_sidecar then binds the
    # sidecar to that slide in the same bucket.
    sidecar_json = None
    if key.endswith('.json') and chunk.lstrip()[:1] == b'{':
        sidecar_json = _maybe_parse_sidecar(chunk)
        if sidecar_json is not None:
            import path_ingest
            path_ingest.process_sidecar(conn, s3_client, bucket, key, datastore)
            return CreatedResult(kind='sidecar', instances=[],
                                 size_bytes=total_size)
    # DICOM-first: a DICOM Part 10 file has the 'DICM' magic at byte offset 128
    # (after a 128-byte preamble). Some valid DICOM files carry pixel/overlay data
    # whose bytes trip the TIFF-magic sniff below (path_ingest_looks_like_tiff),
    # which would misroute them to process_svs and reject them as "not a
    # recognized WSI". So if the object is unambiguously DICOM, take the DICOM
    # path directly and skip the WSI/archive sniffs entirely. A real .svs/.bif
    # WSI never has 'DICM' at 128, so WSI ingest is unaffected.
    retired, written = [], []
    if len(chunk) >= 132 and chunk[128:132] == b'DICM':
        summary = _index_dicom(conn, datastore, bucket, key, s3prefix, chunk,
                               total_size, object_etag=object_etag, cache=cache,
                               retired=retired, written_content_pkeys=written)
        retired.extend(_retire_superseded_slots(conn, datastore.id, key, written,
                                                cache=cache))
        return CreatedResult(kind='dicom', instances=[summary],
                             size_bytes=total_size, retired=retired)
    if path_ingest_looks_like_tiff(chunk):
        # Classified as a slide by TIFF magic bytes (no extension reliance).
        if _PATHOLOGY_QUEUE_URL:
            # Entry lambda: hand the slide off to the pathology worker and do NOT
            # process it here. A GB slide must never occupy a DICOM worker.
            _forward_to_pathology(bucket, key)
            return CreatedResult(kind='wsi-forward', instances=[],
                                 size_bytes=total_size)
        # Pathology worker (PATHOLOGY_QUEUE_URL unset): process the slide inline.
        # process_svs detects the exact vendor format and refuses NDPI / plain
        # TIFF rather than mis-ingesting them.
        import path_ingest
        instances = path_ingest.process_svs(conn, s3_client, bucket, key, datastore,
                                            cache=cache, retired=retired)
        # Register the slide's series as touched so the caller's aggregate step
        # recomputes its study/series rollups (NumberOfSeriesRelatedInstances,
        # ModalitiesInStudy, ...). process_svs writes the instances but does not
        # recompute aggregates; the DICOM path records touched series via the
        # parent cache, and the WSI path must do the same or the rollups stay
        # stale. A slide is one object in one invocation (no contention), so a
        # sentinel watermark of 0 is fine — the aggregate recompute is a full,
        # idempotent COUNT keyed only on (study_uid, series_uid).
        if cache is not None:
            for s in instances:
                st, se = s.get('studyUID'), s.get('seriesUID')
                if st and se:
                    tri = (datastore.id, st, se)
                    cache.touched_study_series_v2.setdefault(tri, 0)
        return CreatedResult(kind='wsi', instances=instances,
                             size_bytes=total_size, retired=retired)

    # ── ZIP + compressed tar: unpack-on-ingest ──────────────────────────────
    # Members of a compressed archive aren't range-addressable, so they are
    # extracted back to the bucket under '{key}.extracted/…' (original object
    # retained) and indexed via their own ObjectCreated events. This has to run
    # before the uncompressed-tar branch (a mislabeled `.tar` that is really a
    # zip or a gzip must not be walked as tar headers) and before the DICOM
    # header walk (an archive has no (7FE0,0010) of its own).
    #
    # ARCHIVE_UNPACK_ENABLED=false disables this entirely: a compressed archive
    # is left untouched and the message is acknowledged as SKIPPED (no extraction,
    # no DLQ, no failure event). The check is here (not inside the branches) so a
    # disabled compressed archive can never fall through to the uncompressed-tar
    # walk or the DICOM header walk below.
    #
    # A read-only storage (datastores.access_level 'read-only') is never
    # unpacked into: the archive fails visibly as a PermanentIngestError (job
    # failure + Import Object Failed + DLQ) and nothing is written or indexed.
    _is_zip = archive_ingest.looks_like_zip(key, chunk)
    _compression = None if _is_zip else archive_ingest.is_compressed_tar(key, chunk)
    if _is_zip or _compression:
        if not ARCHIVE_UNPACK_ENABLED:
            print(f"skipping compressed archive (ARCHIVE_UNPACK_ENABLED=false): "
                  f"s3://{bucket}/{key}")
            return CreatedResult(kind='skipped', instances=[],
                                 size_bytes=total_size)
        _refuse_unpack_into_read_only(datastore, bucket, key)
    if _is_zip:
        extracted = archive_ingest.unpack_zip(
            s3_client, bucket, key,
            max_bytes=ARCHIVE_EXTRACT_MAX_BYTES,
            max_members=ARCHIVE_EXTRACT_MAX_MEMBERS)
        return CreatedResult(kind='archive-extracted', instances=[],
                             size_bytes=total_size, extracted_count=extracted)
    compression = _compression
    if compression:
        extracted = archive_ingest.unpack_compressed_tar(
            s3_client, bucket, key, compression,
            max_bytes=ARCHIVE_EXTRACT_MAX_BYTES,
            max_members=ARCHIVE_EXTRACT_MAX_MEMBERS)
        return CreatedResult(kind='archive-extracted', instances=[],
                             size_bytes=total_size, extracted_count=extracted)

    # ── Uncompressed tar ────────────────────────────────────────────────────
    # Index each member where it lies instead of extracting. This has to come
    # before the header extension below: a tar has no (7FE0,0010) of its own, so
    # extending would walk to HEADER_MAX_BYTES looking for one that isn't there.
    if tar_ingest.looks_like_archive(key, chunk):
        summaries, found, failed = tar_ingest.process_tar(
            conn, s3_client, bucket, key,
            lambda member: _index_dicom(
                conn, datastore, bucket, key, s3prefix, member.prefix, None,
                member=member, cache=cache,
                retired=retired, written_content_pkeys=written),
            head=chunk, total_size=total_size,
        )
        # Only a fully indexed tar defines the object's complete member set; a
        # failed member leaves its old slot alone rather than dropping it.
        if failed == 0:
            retired.extend(_retire_superseded_slots(conn, datastore.id, key,
                                                    written, cache=cache))
        return CreatedResult(kind='tar', instances=summaries,
                             size_bytes=total_size, members_found=found,
                             members_failed=failed, retired=retired)

    try:
        summary = _index_dicom(conn, datastore, bucket, key, s3prefix, chunk,
                               total_size, object_etag=object_etag, cache=cache,
                               retired=retired, written_content_pkeys=written)
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        # Not parseable as DICOM (or missing its SOPInstanceUID). Before failing,
        # record it as a NON_DICOM physical object (pathology sidecars, native
        # slide files, reports) so it is discoverable in raw storage-content
        # listings and can be associated into an index manually. Only objects
        # with a recognized non-DICOM extension are indexed this way; anything
        # else is still a hard failure (bad bytes, no number of retries fixes).
        non_dicom_type = _non_dicom_type_for(key)
        if non_dicom_type is not None:
            _index_non_dicom(conn, datastore, bucket, key, non_dicom_type, total_size)
            return CreatedResult(kind='non-dicom', instances=[],
                                 size_bytes=total_size)
        raise PermanentIngestError(
            f"object s3://{bucket}/{key} is not ingestible DICOM: {exc}") from exc
    retired.extend(_retire_superseded_slots(conn, datastore.id, key, written,
                                            cache=cache))
    return CreatedResult(kind='dicom', instances=[summary],
                         size_bytes=total_size, retired=retired)


# Recognized non-DICOM object extensions -> free MIME/type label. Pathology
# native slide formats and common sidecar/report types. A pyramidal .svs is
# handled as WSI upstream; anything reaching here is a plain non-DICOM file.
_NON_DICOM_EXT_TYPES = {
    '.tiff': 'image/tiff', '.tif': 'image/tiff',
    '.ndpi': 'application/vnd.hamamatsu-ndpi',
    '.scn': 'application/vnd.leica-scn',
    '.mrxs': 'application/vnd.mirax',
    '.vsi': 'application/vnd.olympus-vsi',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml',
}


def _non_dicom_type_for(key: str):
    """Return a MIME/type label for a recognized non-DICOM object, else None."""
    lower = key.lower()
    for ext, mime in _NON_DICOM_EXT_TYPES.items():
        if lower.endswith(ext):
            return mime
    return None


def _index_non_dicom(conn, datastore: Datastore, bucket: str, key: str,
                     non_dicom_type: str, size_bytes: int | None) -> None:
    """Upsert a NON_DICOM storage_index row: physical object only, no query tree.

    NULL UIDs, no patient/study/series/instance rows — these objects are not
    DICOMweb-queryable, only listable and manually associable into an index.
    """
    _exec(conn, """
        INSERT INTO storage_index
            (datastore_id, s3_bucket_name, s3_key, s3_key_version, content_kind,
             non_dicom_type, size_bytes, deleted_at)
        VALUES (%s,%s,%s,'','NON_DICOM',%s,%s,NULL)
        ON DUPLICATE KEY UPDATE
            content_kind   = 'NON_DICOM',
            non_dicom_type = VALUES(non_dicom_type),
            size_bytes     = VALUES(size_bytes),
            deleted_at     = NULL
    """, (datastore.id, bucket, key, non_dicom_type, size_bytes or 0))
    _commit(conn)


_INDEX_ATTR_CACHE_TABLE = {'PATIENT': 'patient', 'STUDY': 'study',
                          'SERIES': 'series', 'INSTANCE': 'instance'}
_INDEX_ATTR_PKEY = {'PATIENT': 'patient_pkey', 'STUDY': 'study_pkey',
                    'SERIES': 'series_pkey', 'INSTANCE': 'instance_pkey'}
# Per-warm-container cache of configured index attributes, keyed by datastore_id.
# Short TTL so a config change is picked up without a cold start.
_index_attr_cache: dict = {}
_INDEX_ATTR_TTL_S = 60


def _load_index_attributes(conn, datastore_id: str):
    """All global STORAGE index attributes (cached, short TTL).

    Phase 6B: population is unconditional. Every STORAGE def (global, i.e.
    virtual_folder_id IS NULL) is populated on every datastore ingest — there is
    no per-scope opt-in / enabled gate anymore. physical_column comes from the
    def, so ingest writes the same column the /defs ALTER created.
    """
    import time as _t
    cached = _index_attr_cache.get(datastore_id)
    if cached and (_t.time() - cached[0]) < _INDEX_ATTR_TTL_S:
        return cached[1]
    rows = _exec_all(
        conn,
        "SELECT physical_column, dicom_tag, dicom_level, data_type "
        "FROM index_attribute_defs "
        "WHERE target_type='STORAGE' AND virtual_folder_id IS NULL",
        (),
    )
    attrs = [{'physical_column': r[0], 'dicom_tag': r[1], 'dicom_level': r[2],
              'data_type': r[3]} for r in rows]
    _index_attr_cache[datastore_id] = (_t.time(), attrs)
    return attrs


def _coerce_attr_value(raw, data_type):
    """Coerce a raw header string to the column's SQL type; None on empty/bad."""
    if raw is None or raw == '':
        return None
    if data_type == 'INT':
        try:
            return int(str(raw).strip())
        except (ValueError, TypeError):
            return None
    if data_type == 'DECIMAL':
        try:
            # DICOM DS may be multi-valued ("1.5\\2.5"); take the first value.
            return float(str(raw).split('\\')[0].strip())
        except (ValueError, TypeError):
            return None
    if data_type == 'DATE':
        s = str(raw).strip()[:8]  # DICOM DA is YYYYMMDD
        if len(s) == 8 and s.isdigit():
            return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
        return None
    # STRING columns are VARCHAR(255); a longer value would fail the UPDATE
    # (strict mode) and leave the column NULL, so keep the first 255 chars.
    return str(raw)[:255]


def _attr_raw(ds, tag):
    """Raw header value for an index attribute: the FIRST value of a
    multi-valued element (matching the settle pass, which reads Value[0] from the
    DICOM-JSON). str() of a pydicom MultiValue is "['A', 'B']", which is not a
    value and does not coerce to a number."""
    try:
        val = ds[tag].value
    except Exception:
        return None
    if isinstance(val, (list, tuple)) or type(val).__name__ == 'MultiValue':
        val = val[0] if len(val) else None
    return None if val is None else str(val)


def _keyword_column_for_tag(dicom_tag: str) -> str:
    """Resolve a DICOM tag (GGGGEEEE hex) to its lowercase keyword column name,
    matching how index-attributes-api creates the physical column (item 4:
    custom attributes are keyword-named columns, not d<tag>). Falls back to the
    raw d<tag> form when the tag is not in the dictionary (private/unknown), so
    ingest never fails to locate the column the config API created."""
    try:
        from pydicom.datadict import keyword_for_tag
        t = str(dicom_tag).strip()
        kw = keyword_for_tag(int(t, 16))
        if kw:
            return kw.lower()
    except Exception:
        pass
    return f"d{str(dicom_tag).lower()}"


def _apply_index_attributes(conn, datastore_id: str, ds, patient_pkey, study_pkey,
                            series_pkey, instanceid, only_levels=None):
    """Populate ENABLED index-attribute columns from the header, by level.

    A no-op (single cached SELECT) when the datastore has no ENABLED attributes.
    The physical column comes from the def (index_attribute_defs.physical_column)
    so ingest and the backfill always write the same column.

    ``only_levels`` (a set like {'INSTANCE'} or {'SERIES','STUDY','PATIENT'})
    restricts which levels are written this call. This is how the redesign keeps
    the shared-parent-row UPDATE off the pre-commit instance transaction: the
    INSTANCE level is applied inline on the instance's own row, while the
    SERIES/STUDY/PATIENT levels are applied elsewhere (at parent row birth and in
    the post-commit per-series settle pass). None = all levels (legacy callers /
    the non-lean else branch, which is not the live engine).
    """
    attrs = _load_index_attributes(conn, datastore_id)
    if not attrs:
        return
    pkey_val = {'PATIENT': patient_pkey, 'STUDY': study_pkey, 'SERIES': series_pkey}
    for a in attrs:
        level = a['dicom_level']
        if only_levels is not None and level not in only_levels:
            continue
        table = _INDEX_ATTR_CACHE_TABLE.get(level)
        if not table:
            continue
        # A non-INSTANCE level with no resolved pkey (not on hand this call) is
        # skipped — it will be written where its pkey IS on hand.
        if level != 'INSTANCE' and pkey_val.get(level) is None:
            continue
        value = _coerce_attr_value(_attr_raw(ds, a['dicom_tag']), a['data_type'])
        col = a.get('physical_column') or _keyword_column_for_tag(a['dicom_tag'])
        cur = conn.cursor()
        try:
            if level == 'INSTANCE':
                # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
                cur.execute(
                    f"UPDATE instance SET `{col}`=%s WHERE datastore_id=%s AND instanceid=%s",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    (value, datastore_id, instanceid))
            else:
                # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
                cur.execute(
                    f"UPDATE `{table}` SET `{col}`=%s WHERE {_INDEX_ATTR_PKEY[level]}=%s",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                    (value, pkey_val[level]))
        except Exception as e:
            # A deadlock / lock-wait timeout has already aborted the WHOLE
            # transaction (instance INSERT included): swallowing it would let
            # the batch commit without the instance. Re-raise so it replays.
            if getattr(e, 'args', None) and e.args[0] in _DEADLOCK_ERRNOS:
                raise
            # A missing column (config/ingest race) must not fail the whole
            # ingest — the re-index backfill will fill it once the ALTER lands.
            # Error name/code only: DB driver messages can echo SQL values (PHI).
            print(f"WARNING: index-attribute {col} update skipped: {type(e).__name__} {getattr(e, 'args', [None])[0] if getattr(e, 'args', None) else ''}")
        finally:
            cur.close()


def _apply_instance_index_attributes(conn, datastore_id, ds, instanceid):
    """Apply ENABLED INSTANCE-level index attributes to the instance's OWN row.

    Redesign item 2: this runs inline on the lean/live path, but only ever
    UPDATEs the instance row this transaction just INSERTed — never a shared
    parent (patient/study/series) row. So it cannot form the write-write cycle on
    a hot existing-series row that the old pre-commit series.bodypartexamined
    UPDATE did (the 1213-swallow instance-loss bug). A no-op single cached SELECT
    when no INSTANCE-level STORAGE attr is enabled (the common case)."""
    _apply_index_attributes(conn, datastore_id, ds, None, None, None,
                            instanceid, only_levels={'INSTANCE'})


def _apply_parent_index_attributes_on_create(conn, datastore_id, ds, level, pkey):
    """Apply ENABLED index attributes for a single parent LEVEL to a
    freshly-created parent row (redesign item 3a).

    Called ONLY on the get-or-create MISS path (row birth), so the UPDATE lands
    on a row no other instance is contending on — contention-free by
    construction. A no-op single cached SELECT when no attr is enabled at this
    level. ``level`` is one of 'PATIENT' | 'STUDY' | 'SERIES'; ``pkey`` is that
    row's just-created primary key."""
    pk = {'PATIENT': None, 'STUDY': None, 'SERIES': None}
    pk[level] = pkey
    _apply_index_attributes(conn, datastore_id, ds, pk['PATIENT'], pk['STUDY'],
                            pk['SERIES'], None, only_levels={level})


def _index_dicom(conn, datastore: Datastore, bucket: str, key: str,
                 s3prefix: str, chunk: bytes, total_size: int | None,
                 member=None, object_etag: str | None = None,
                 cache: '_ParentCache | None' = None,
                 retired: list | None = None,
                 written_content_pkeys: list | None = None) -> dict:
    """Index one DICOM stream: parse its header, write the index rows, commit.

    `retired` (optional out-list) receives summaries of instances retired
    because this stream superseded them; `written_content_pkeys` (optional
    out-list) receives the content_pkey written.

    The stream is either a whole object (`member is None`, so it spans bytes 0 to
    `total_size`) or one member of an uncompressed tar, which occupies
    `member.offset .. member.offset + member.size` of it. `chunk` is however much
    of the stream the caller already read, and every offset persisted here is
    absolute within the object, so the read path can range-GET it without caring
    which of the two it was.

    Returns a summary dict for the synthetic-event emitter.
    """
    if member is None:
        data_start, data_end = 0, total_size
        member_offset = member_length = None
        size_bytes = total_size or 0
    else:
        data_start, data_end = member.offset, member.offset + member.size
        member_offset, member_length = member.offset, member.size
        size_bytes = member.size

    # Make sure we hold the *whole* header before parsing. Below this point
    # `chunk` may be larger than the first window, and metadata_offset is None
    # when the object has no pixel data (or its header blew past HEADER_MAX_BYTES).
    chunk, metadata_offset = _extend_header_to_pixel_data(
        bucket, key, chunk, data_end, data_start,
    )

    ds = pydicom.dcmread(BytesIO(chunk), stop_before_pixels=True, force=True)

    sop_uid = _get_tag(ds, '00080018')
    if not sop_uid:
        raise ValueError(f"Object {key} missing SOPInstanceUID")
    instanceid = _stable_instanceid(datastore.id, sop_uid)

    # Strip text VR values longer than the threshold before serializing — pydicom's
    # to_json_dict only applies bulk_data_threshold to binary VRs.
    for elem in list(ds.iterall()):
        if elem.VR in ('LT', 'UT', 'ST', 'LO', 'SH', 'PN', 'AE', 'CS', 'IS', 'DS'):
            try:
                if elem.value is None:
                    continue
                value_str = str(elem.value)
                if len(value_str) > BULK_DATA_THRESHOLD_BYTES:
                    elem.value = ''  # placeholder; the JSON BulkDataURI rewriter below replaces it
                    elem._is_bulkdata_text = True  # marker for post-pass
            except Exception:
                pass

    # pydicom calls this for any binary element whose value exceeds bulk_data_threshold.
    def _bulk_handler(elem):
        return _bulk_uri_for(datastore.id, sop_uid, elem.tag)

    json_dict = ds.to_json_dict(
        bulk_data_threshold=BULK_DATA_THRESHOLD_BYTES,
        bulk_data_element_handler=_bulk_handler,
    )

    # Second pass: replace the placeholder for stripped text elements.
    for elem in ds.iterall():
        if getattr(elem, '_is_bulkdata_text', False):
            tag_str = f"{elem.tag.group:04X}{elem.tag.element:04X}"
            if tag_str in json_dict:
                json_dict[tag_str] = {
                    "vr": elem.VR,
                    "BulkDataURI": _bulk_uri_for(datastore.id, sop_uid, elem.tag),
                }

    metadata_gz = gzip.compress(json.dumps(json_dict).encode())

    # Encapsulated frame-offset cache: scan the encapsulated PixelData stream
    # so the read path can do a single ranged GET per frame instead of fetching
    # the whole instance. NULL when we can't (or shouldn't) compute the offsets,
    # in which case the read path falls back to its existing full-fetch logic.
    frame_offsets_blob = None
    try:
        ts_uid_for_scan = str(ds.file_meta.TransferSyntaxUID) if ds.file_meta else None
        n_frames = int(_get_tag(ds, '00280008') or 1)
        if (ts_uid_for_scan and ts_uid_for_scan not in _NATIVE_TS and n_frames >= 1
                and metadata_offset is not None):
            offsets = _scan_encapsulated_frame_offsets(
                bucket, key, metadata_offset, ts_uid_for_scan, n_frames,
            )
            if offsets is not None:
                frame_offsets_blob = json.dumps(offsets, separators=(',', ':')).encode()
    except Exception as e:
        # Never fail ingest because of an offset-cache error; just skip it.
        print(f"WARNING: frame-offset scan failed for {key}: {e}")

    if _INGESTION_V2:
        # LEAN STAGE-1: never WRITE the contended patient/study/series rows. But
        # we CAN cheaply READ the series_pkey: a plain SELECT on the series'
        # datastore-scoped unique key is an MVCC snapshot read (no lock), so it
        # cannot form the write-write cycle the old parent upserts did. When the
        # series already exists (the common case after its first instance), the
        # instance is linked INLINE here and needs no stage-2 backfill. When it
        # doesn't exist yet (first instance(s) of a new series), we insert with
        # series_pkey NULL and stage-2 creates the parents + backfills. Either
        # way stage-1 does ZERO parent-row writes.
        study_uid_v2 = _get_tag(ds, '0020000D')
        series_uid_v2 = _get_tag(ds, '0020000E')
        linked_series_pkey = _select_parent_pkey(
            conn, 'series_pkey', 'series', 'seriesinstanceuid',
            datastore.id, series_uid_v2)
        if linked_series_pkey is None and _STAGE1_CREATE_PARENTS:
            # Series doesn't exist yet. Instead of leaving series_pkey NULL for
            # stage-2 to backfill (the UPDATE that wedged under load), create the
            # parents now so the instance links inline. SELECT-first inside each
            # _upsert_* keeps this contention-free once a parent exists; the
            # retry wrapper absorbs the brief write-write race among the first
            # concurrent instances of a genuinely new parent. The aggregate
            # recompute is NOT done here — it stays in stage-2 (tracker-driven).
            def _make_parents_stage1():
                pp = _upsert_patient(conn, datastore.id, ds, cache=cache)
                stp = _upsert_study(conn, datastore.id, pp, ds, cache=cache)
                return _upsert_series(conn, datastore.id, stp, ds, cache=cache)
            linked_series_pkey = _with_deadlock_retry(_make_parents_stage1)
        _upsert_instance(conn, datastore.id, linked_series_pkey, ds, instanceid)
        # User-defined index attributes on the LEAN/LIVE path (redesign):
        #   • INSTANCE-level attrs are written HERE, inline, on the instance's
        #     OWN row (contention-free — never a shared parent row).
        #   • SERIES/STUDY/PATIENT-level attrs are NOT written pre-commit here.
        #     They are populated (a) at parent row birth in the get-or-create
        #     (_upsert_* on MISS) and (b) in the post-commit per-series settle
        #     pass (handler.py _aggregate_series), off this instance txn.
        # This removes the old pre-commit series.bodypartexamined UPDATE that
        # UPDATEd the hot shared series row inside the instance INSERT txn and,
        # on a swallowed 1213, let storage_index commit while the instance row
        # was rolled back (storage_index==260 / instance==258 loss). No shared
        # parent row is UPDATEd pre-commit in the instance txn anymore.
        _apply_instance_index_attributes(conn, datastore.id, ds, instanceid)
        # Record the touched triple; its content_pkey watermark is filled in
        # after the storage_index upsert below returns content_pkey.
        if cache is not None:
            cache.touched_study_series_v2.setdefault(
                (datastore.id, study_uid_v2, series_uid_v2), 0)
    else:
        patient_pkey = _upsert_patient(conn, datastore.id, ds, cache=cache)
        study_pkey = _upsert_study(conn, datastore.id, patient_pkey, ds, cache=cache)
        series_pkey = _upsert_series(conn, datastore.id, study_pkey, ds, cache=cache)
        _upsert_instance(conn, datastore.id, series_pkey, ds, instanceid)

        # NON-LEAN branch (NOT the live engine; live is INGESTION_V2). Kept
        # consistent with the redesign: INSTANCE-level attrs on the instance's
        # own row, SERIES/STUDY/PATIENT-level attrs at parent row birth handled
        # inside the _upsert_* get-or-create MISS path (contention-free). No
        # shared-parent-row index-attr UPDATE is issued pre-commit here either.
        _apply_instance_index_attributes(conn, datastore.id, ds, instanceid)

    # storage_index: the physical-object row (source of truth). Keyed on
    # (datastore_id, s3_key, s3_key_version, member_slot) -- member_slot being the
    # tar member's offset, -1 for a whole object -- so UID collisions across/within
    # storages coexist as distinct rows. Replaces the former Instancelocation.
    # member_offset/length NULL for a plain object; set for a tar member.
    #
    # `content_pkey = LAST_INSERT_ID(content_pkey)` in the SET list hands the
    # existing row's pkey back through cursor.lastrowid on the duplicate path,
    # so the follow-up `SELECT content_pkey` is gone — one fewer round trip. On
    # a fresh insert lastrowid is the new AUTO_INCREMENT pkey. The no-op-row
    # fallback SELECT (rare) is handled by _upsert_returning_pkey.
    content_pkey = _upsert_returning_pkey(
        conn,
        """
        INSERT INTO storage_index
            (datastore_id, s3_bucket_name, s3_key, s3_key_version, content_kind,
             study_instance_uid, series_instance_uid, sop_instance_uid, transfer_syntax,
             member_offset, member_length, size_bytes, s3_etag, deleted_at)
        VALUES (%s,%s,%s,%s,'DICOM',%s,%s,%s,%s,%s,%s,%s,%s,NULL)
        ON DUPLICATE KEY UPDATE
            content_pkey        = LAST_INSERT_ID(content_pkey),
            content_kind        = 'DICOM',
            study_instance_uid  = VALUES(study_instance_uid),
            series_instance_uid = VALUES(series_instance_uid),
            sop_instance_uid    = VALUES(sop_instance_uid),
            transfer_syntax     = VALUES(transfer_syntax),
            member_offset       = VALUES(member_offset),
            member_length       = VALUES(member_length),
            size_bytes          = VALUES(size_bytes),
            s3_etag             = VALUES(s3_etag),
            deleted_at          = NULL
        """,
        (datastore.id, bucket, key, '',
         _get_tag(ds, '0020000D'), _get_tag(ds, '0020000E'), sop_uid,
         (str(ds.file_meta.TransferSyntaxUID) if getattr(ds, 'file_meta', None) else None),
         member_offset, member_length, size_bytes or 0,
         (object_etag if member is None else None)),
        # Fallback lookup on the physical-object unique key, only hit when a
        # pure no-op upsert leaves lastrowid at 0 on this server/version.
        # TODO(s3-parity): thread the real S3 object VersionId from the ingest
        # event into s3_key_version (currently '' — correct for unversioned
        # reads, but does not yet distinguish object versions).
        """
        SELECT content_pkey FROM storage_index
        WHERE datastore_id = %s AND s3_key = %s AND s3_key_version = %s
          AND member_offset <=> %s
        """,
        (datastore.id, key, '', member_offset))

    # Link the instance to its physical object (the read path resolves
    # instance -> storage_index bytes via this FK).
    _exec(conn, "UPDATE instance SET content_pkey = %s WHERE instanceid = %s",
          (content_pkey, instanceid))

    # Overwrite: this stream is exactly one SOP, so any OTHER live instance on
    # the same content_pkey came from an earlier version of the object (same
    # key / tar slot, different UIDs). Retire it in this same transaction.
    _retired = _retire_superseded_instances(
        conn, datastore.id, [content_pkey], [instanceid], cache=cache)
    if retired is not None:
        retired.extend(_retired)
    if written_content_pkeys is not None and content_pkey:
        written_content_pkeys.append(content_pkey)

    # ingestion-v2: raise this series' watermark for the batch to the highest
    # content_pkey we've written for it. stage-1 upserts series_update_tracker to
    # this value; stage-2 uses it to skip redundant recomputes. Keyed by the same
    # triple recorded in the lean branch above.
    if _INGESTION_V2 and cache is not None and content_pkey:
        k = (datastore.id, _get_tag(ds, '0020000D'), _get_tag(ds, '0020000E'))
        prev = cache.touched_study_series_v2.get(k, 0)
        if content_pkey > prev:
            cache.touched_study_series_v2[k] = content_pkey

    # Virtual-folder assignment rules are NO LONGER evaluated here on the
    # per-instance write path. They moved OFF this hot path onto a dedicated
    # per-series consumer (vf-assign-consumer): after the batch's aggregates are
    # recomputed, the handler emits ONE message per touched series to the
    # VF_ASSIGN_QUEUE, and the consumer evaluates the datastore's enabled rules
    # against the recomputed series/study/patient ROWS and assigns all of the
    # series' instances. See _emit_vf_assign_messages below. (The _apply_vf_*
    # helpers are retained for the s3-ingest legacy path and any direct callers.)

    # metadataendoffset is NULL when we never located the main PixelData tag —
    # the read path treats that as "geometry unknown" and full-fetches, which is
    # slower but correct. It must never be a guess. Keyed on instance_pkey (the
    # queryable instance), with content_pkey carried as the physical-object
    # linkage; for ordinary DICOM instance:object is 1:1 so this is unchanged
    # behaviour, and it is what lets WSI levels (N instances, one object) each
    # keep their own header + frame_offsets. instance_pkey resolved from the
    # instance row just written (uq_instanceid point lookup).
    _im_row = _exec_one(conn, "SELECT instance_pkey FROM instance WHERE instanceid = %s", (instanceid,))
    _im_instance_pkey = _im_row[0] if _im_row else None
    _exec(conn, """
        INSERT INTO Instancemetadata (instance_pkey, content_pkey, metadata, metadataendoffset, frame_offsets)
        VALUES (%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
            content_pkey      = VALUES(content_pkey),
            metadata          = VALUES(metadata),
            metadataendoffset = VALUES(metadataendoffset),
            frame_offsets     = VALUES(frame_offsets)
    """, (_im_instance_pkey, content_pkey, metadata_gz, metadata_offset, frame_offsets_blob))

    _commit(conn)

    return {
        'sopUID': sop_uid,
        'studyUID': _get_tag(ds, '0020000D'),
        'seriesUID': _get_tag(ds, '0020000E'),
        'modality': _get_tag(ds, '00080060'),
        'sopClassUID': _get_tag(ds, '00080016'),
        'sizeBytes': size_bytes or 0,
        'kind': 'dicom' if member is None else 'tar-member',
    }


# ── Overwrite handling: retire instances superseded by a new object version ──
# storage_index is keyed on the physical object (datastore, s3_key, version,
# member_slot) while instance is keyed on the SOP (instanceid = hash(datastore,
# SOPInstanceUID)). Re-uploading the SAME key with NEW UIDs therefore reuses the
# content_pkey but writes a NEW instance row, and the instance written by the
# earlier version used to stay live on that content_pkey: a phantom study whose
# bytes are now another instance's. Whoever writes an object's instances knows
# the complete set it just wrote, so it retires every OTHER live instance on that
# object's content_pkey(s):
#   * plain DICOM / tar member: one stream = one SOP = one content_pkey, so the
#     keep-set is the single instanceid just written;
#   * WSI (.svs/.bif, path_ingest.process_svs): N pyramid-level instances
#     legitimately share ONE content_pkey, so the keep-set is every level
#     instanceid written in that same run -- siblings are never retired, only
#     levels left over from an earlier version of the slide.
# A tar re-uploaded with a different member layout leaves storage_index rows at
# member slots that no longer exist; _retire_superseded_slots soft-deletes those
# (and their instances) once a whole object ingested cleanly.
_DEADLOCK_ERRNOS = (1213, 1205)


def _list_vf_databases(conn):
    """Existing per-VF databases (vf_ + 32 hex), validated before interpolation.
    Same enumeration as handler.py's settle pass; only called on the rare
    overwrite path."""
    import re as _re
    rows = _exec_all(
        conn,
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA "
        "WHERE SCHEMA_NAME LIKE 'vf\\_%%'")  # %% : pymysql %-formats even with empty params
    return [r[0] for r in rows
            if r and r[0] and _re.match(r'^vf_[0-9a-f]{32}$', r[0])]


def _purge_vf_membership(conn, content_pkeys):
    """Hard-delete VF membership for physical objects whose content changed.

    virtual_folder_assignments and each vf_<id>.vf_<id>_instance key on
    content_pkey and carry the UIDs of the instance that was assigned; after an
    overwrite those UIDs describe content that no longer exists, and the
    assignment upsert only refreshes datastore_id, so the rows would never be
    corrected. Removing them lets the per-series VF-assign pass re-evaluate the
    rules against the new content. Hard delete (no deleted_at on these tables),
    same as the settle pass's VF-unassign. A per-VF-DB failure is logged and
    skipped, except a deadlock / lock-wait, which must reach the retry wrapper."""
    cpks = sorted({int(c) for c in content_pkeys if c})
    if not cpks:
        return
    ph = ','.join(['%s'] * len(cpks))
    _exec(conn, f"DELETE FROM virtual_folder_assignments WHERE content_pkey IN ({ph})",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
          cpks)
    for vf_db in _list_vf_databases(conn):
        try:
            _exec(conn,
                  f"DELETE FROM `{vf_db}`.`{vf_db}_instance` WHERE content_pkey IN ({ph})",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                  cpks)
        except Exception as e:
            if (e.args[0] if getattr(e, 'args', None) else None) in _DEADLOCK_ERRNOS:
                raise
            print(f"WARNING: VF purge skipped for {vf_db}: {e}")


def _retire_superseded_instances(conn, datastore_id, content_pkeys, keep_instanceids,
                                 cache: '_ParentCache | None' = None,
                                 purge_vf: bool = True) -> list:
    """Soft-delete live instances on these physical objects that this ingest did
    not write (left behind by an earlier version of the object).

    Runs inside the caller's object transaction (deadlock-retried as a whole).
    The retired instances' series/studies are registered as touched so the
    aggregate pass recomputes their counts/modalities -- and, on the live v3
    path, the settle pass's empty-parent cascade soft-deletes a series/study/
    patient that is left with no live instance. Returns summary dicts
    (sopUID/studyUID/seriesUID) for 'Instance Deleted' events.
    """
    cpks = sorted({int(c) for c in content_pkeys if c})
    if not cpks:
        return []
    keep = {int(i) for i in keep_instanceids if i is not None}
    ph = ','.join(['%s'] * len(cpks))
    rows = _exec_all(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        SELECT i.instanceid, i.sopinstanceuid, i.series_pkey, se.seriesinstanceuid,
               se.study_pkey, st.studyinstanceuid, st.patient_pkey
        FROM instance i
        LEFT JOIN series se ON se.series_pkey = i.series_pkey
        LEFT JOIN study st ON st.study_pkey = se.study_pkey
        WHERE i.datastore_id = %s AND i.content_pkey IN ({ph})
          AND i.deleted_at IS NULL
    """, [datastore_id] + cpks)  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    stale = [r for r in rows if int(r[0]) not in keep]
    if not stale:
        return []
    ids = sorted({int(r[0]) for r in stale})
    iph = ','.join(['%s'] * len(ids))
    _exec(conn,
          f"UPDATE instance SET deleted_at = NOW() "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
          f"WHERE instanceid IN ({iph}) AND deleted_at IS NULL",
          ids)
    if purge_vf:
        _purge_vf_membership(conn, cpks)
    retired = []
    for (iid, sop, series_pkey, series_uid, study_pkey, study_uid, patient_pkey) in stale:
        if cache is not None:
            tss = getattr(cache, 'touched_study_series_v2', None)  # v3 only
            if series_uid and tss is not None:
                tss.setdefault((datastore_id, study_uid or '', series_uid), 0)
            if series_pkey is not None:
                cache.touched_series.add(series_pkey)
            if study_pkey is not None:
                cache.touched_study.add(study_pkey)
            if patient_pkey is not None:
                cache.touched_patient.add(patient_pkey)
        retired.append({'sopUID': sop or '', 'studyUID': study_uid or '',
                        'seriesUID': series_uid or ''})
    print(f"overwrite: retired {len(retired)} superseded instance(s) on "
          f"content_pkey(s) {cpks}: {[r['sopUID'] for r in retired]}")
    return retired


def _retire_superseded_slots(conn, datastore_id, key, keep_content_pkeys,
                             cache: '_ParentCache | None' = None) -> list:
    """Soft-delete storage_index rows of this key whose member slot was not
    written by the ingest that just completed (a tar re-uploaded with a
    different layout, or a key that switched between tar and plain object),
    retiring their live instances too. Only call after a COMPLETE ingest of the
    object (no failed members), else a transiently unparseable member would be
    dropped."""
    keep = {int(c) for c in keep_content_pkeys if c}
    rows = _exec_all(conn, """
        SELECT si.content_pkey FROM storage_index si
        WHERE si.datastore_id = %s AND si.s3_key_hash = SHA2(%s, 256)
          AND si.s3_key = %s AND si.s3_key_version = '' AND si.deleted_at IS NULL
    """, (datastore_id, key, key))
    stale = sorted({int(r[0]) for r in rows} - keep)
    if not stale:
        return []
    retired = _retire_superseded_instances(conn, datastore_id, stale, (), cache=cache)
    ph = ','.join(['%s'] * len(stale))
    _exec(conn,
          f"UPDATE storage_index SET deleted_at = NOW() "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
          f"WHERE content_pkey IN ({ph}) AND deleted_at IS NULL",
          stale)
    print(f"overwrite: soft-deleted {len(stale)} superseded storage slot(s) of "
          f"{key}: content_pkeys {stale}")
    _commit(conn)
    return retired


WSI_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.77.1.6'  # VL Whole Slide Microscopy


def _instances_for_key(conn, datastore: Datastore, bucket: str, key: str) -> list:
    """Live instances backed by this object, with the UIDs events need.

    All matching is by (bucketname, s3key) + datastore scope: an object may back
    one instance (a `.dcm`), many via member ranges (a tar) or many via
    virtualization (an `.svs` pyramid).
    """
    rows = _exec_all(conn, """
        SELECT i.instanceid, i.sopinstanceuid, i.sopclassuid, i.instanceavailability,
               i.series_pkey, se.seriesinstanceuid, st.studyinstanceuid
        FROM instance i
        JOIN storage_index il ON il.content_pkey = i.content_pkey
        LEFT JOIN series se ON se.series_pkey = i.series_pkey
        LEFT JOIN study st ON st.study_pkey = se.study_pkey
        WHERE il.s3_bucket_name = %s AND il.s3_key = %s
          AND i.datastore_id = %s AND i.deleted_at IS NULL
    """, (bucket, key, datastore.id))
    return [{
        'instanceid': r[0],
        'sopUID': r[1],
        'sopClassUID': r[2],
        'previousAvailability': r[3],
        'seriesPkey': r[4],
        'seriesUID': r[5] or '',
        'studyUID': r[6] or '',
    } for r in rows]


def _rollup_series_availability(conn, series_pkeys):
    """Recompute series.availability from live instances (best state wins).

    ONLINE (or NULL, which reads as ONLINE) beats NEARLINE beats OFFLINE — a
    series is reachable if any of its instances is. Runs only for the series an
    event actually touched.
    """
    pkeys = sorted({p for p in series_pkeys if p is not None})
    if not pkeys:
        return
    _exec(conn, """
        UPDATE series se
        SET se.availability = (
            SELECT CASE
                WHEN COALESCE(SUM(i.instanceavailability IS NULL OR i.instanceavailability = 'ONLINE'), 0) > 0 THEN 'ONLINE'
                WHEN COALESCE(SUM(i.instanceavailability = 'NEARLINE'), 0) > 0 THEN 'NEARLINE'
                ELSE 'OFFLINE'
            END
            FROM instance i
            WHERE i.series_pkey = se.series_pkey AND i.deleted_at IS NULL
        )
        WHERE se.series_pkey IN %s
    """, (pkeys,))


def _handle_removed(conn, datastore: Datastore, bucket: str, key: str):
    """Handle removal of a backing S3 object.

    - **DICOM**: soft-delete via `deleted_at = NOW()`. The GC sweep cascades the
      soft-delete upward and hard-deletes past the grace window; a new
      ObjectCreated for the same series before the sweep resurrects it.
    - **WSI (`.svs`)**: do NOT delete. Mark the instances and their series
      `OFFLINE` and leave the rows in place, so the slide stays a discoverable,
      known-but-unavailable catalog entry. A re-upload flips it back ONLINE.
      OFFLINE rows keep `deleted_at IS NULL`, so the sweep leaves them (its
      series step also skips availability='OFFLINE').

    Zero matches is fine: the object may never have been ingested (e.g. a
    rejected non-DICOM ObjectCreated) or was already handled by an earlier event.

    The object's storage_index rows (every member slot, DICOM or NON_DICOM) are
    soft-deleted in the same transaction, except for WSI: QIDO joins
    storage_index on deleted_at IS NULL, so a soft-deleted slot would hide the
    OFFLINE catalog entry the WSI contract keeps discoverable. A re-upload
    clears deleted_at through the ingest upsert. The caller's late-REMOVED guard
    (_object_exists_now) runs first, so a key re-created after the delete is
    never reached here.

    Returns (deleted_instances, offlined_instances) summary lists for events.
    """
    instances = _instances_for_key(conn, datastore, bucket, key)
    if not instances:
        _soft_delete_storage_for_key(conn, datastore.id, bucket, key)
        _commit(conn)
        return [], []

    wsi = any(i['sopClassUID'] == WSI_SOP_CLASS_UID for i in instances)
    cur = conn.cursor()
    try:
        if wsi:
            # WSI: mark OFFLINE, retain rows.
            cur.execute(
                "UPDATE instance SET instanceavailability = 'OFFLINE' "
                "WHERE content_pkey IN (SELECT content_pkey FROM storage_index "
                "                     WHERE s3_bucket_name = %s AND s3_key = %s) "
                "  AND datastore_id = %s AND deleted_at IS NULL",
                (bucket, key, datastore.id),
            )
        else:
            cur.execute(
                "UPDATE instance SET deleted_at = NOW() "
                "WHERE content_pkey IN (SELECT content_pkey FROM storage_index "
                "                     WHERE s3_bucket_name = %s AND s3_key = %s) "
                "  AND datastore_id = %s AND deleted_at IS NULL",
                (bucket, key, datastore.id),
            )
    finally:
        cur.close()
    if wsi:
        _rollup_series_availability(conn, [i['seriesPkey'] for i in instances])
    else:
        _soft_delete_storage_for_key(conn, datastore.id, bucket, key)
    _commit(conn)
    return ([], instances) if wsi else (instances, [])


def _soft_delete_storage_for_key(conn, datastore_id: str, bucket: str, key: str) -> int:
    """Soft-delete every live storage_index row of one removed object (all
    member slots, DICOM and NON_DICOM). Rides the uq_storage_object prefix
    (datastore_id, s3_key_hash). Runs inside the caller's transaction."""
    cur = conn.cursor()
    try:
        n = cur.execute(
            "UPDATE storage_index SET deleted_at = NOW() "
            "WHERE datastore_id = %s AND s3_key_hash = SHA2(%s, 256) "
            "  AND s3_key = %s AND s3_bucket_name = %s AND deleted_at IS NULL",
            (datastore_id, key, key, bucket),
        )
    finally:
        cur.close()
    if n:
        print(f"removed s3://{bucket}/{key}: soft-deleted {n} storage_index row(s)")
    return n or 0


def _handle_availability(conn, datastore: Datastore, bucket: str, key: str,
                         availability: str) -> list:
    """Set instance availability for every live instance backing this object.

    Tar members inherit the containing object's availability: they all share
    one s3key, so one lifecycle transition flips every member row. The series
    rollup follows the best-state-wins rule in _rollup_series_availability.

    Returns the affected instance summaries (with previousAvailability) for the
    'Instance Availability Changed' events.
    """
    instances = _instances_for_key(conn, datastore, bucket, key)
    if not instances:
        _commit(conn)
        return []

    _exec(conn, """
        UPDATE instance SET instanceavailability = %s
        WHERE content_pkey IN (SELECT content_pkey FROM storage_index
                             WHERE s3_bucket_name = %s AND s3_key = %s)
          AND datastore_id = %s AND deleted_at IS NULL
    """, (availability, bucket, key, datastore.id))
    _rollup_series_availability(conn, [i['seriesPkey'] for i in instances])
    _commit(conn)

    changed = [i for i in instances
               if (i['previousAvailability'] or 'ONLINE') != availability]
    print(f"availability s3://{bucket}/{key}: {len(instances)} instance(s) -> "
          f"{availability} ({len(changed)} changed)")
    return changed


def _with_deadlock_retry(fn, *args, **kwargs):
    """Run fn(*args, **kwargs); retry on MySQL deadlock with backoff.

    On errno 1213 we roll back the txn (the deadlock victim's work is already
    discarded by InnoDB, but rollback() releases any client-side cursor state)
    and sleep `base * 2**attempt` seconds plus 0-50% jitter before retrying.
    After DEADLOCK_MAX_ATTEMPTS the original exception propagates so SQS
    redelivery (and eventually DLQ) can pick up the message.

    The connection is the first positional arg in both call sites today, so we
    can pull it for the rollback. Kept defensive in case that changes.

    `_dl_cache` (popped, never forwarded to fn) is the per-invocation
    _ParentCache. A rollback discards every uncommitted row — including any
    parent this cache resolved via an INSERT in the rolled-back transaction — so
    the cache is CLEARED on each rollback. The retry then re-resolves parents
    against the committed state (SELECT-first finds the ones that survived,
    re-inserts the ones that did not), keeping the cached pkeys and the DB in
    agreement. Existing parents that predate this transaction keep their pkeys,
    so clearing only costs a cheap re-SELECT.
    """
    cache = kwargs.pop('_dl_cache', None)
    conn = args[0] if args else kwargs.get('conn')
    last_exc = None
    for attempt in range(DEADLOCK_MAX_ATTEMPTS):
        try:
            return fn(*args, **kwargs)
        except pymysql.MySQLError as e:
            # PyMySQL surfaces errno via e.args[0] (mysql-connector used e.errno).
            errno = e.args[0] if e.args else None
            if errno != DEADLOCK_ERRNO:
                raise
            last_exc = e
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
            if cache is not None:
                # Uncommitted parent inserts vanished with the rollback; drop the
                # memo so the retry re-resolves against the real committed state.
                cache.patient.clear()
                cache.study.clear()
                cache.series.clear()
            if attempt + 1 == DEADLOCK_MAX_ATTEMPTS:
                break
            backoff = DEADLOCK_BASE_BACKOFF_S * (2 ** attempt)
            backoff *= 1 + random.random() * 0.5
            print(f"WARNING: deadlock on attempt {attempt + 1}, retrying in {backoff:.3f}s")
            time.sleep(backoff)
    print(f"ERROR: gave up after {DEADLOCK_MAX_ATTEMPTS} deadlock retries")
    raise last_exc


# ── Event normalization ───────────────────────────────────────────────────────
# Storage-class → availability mapping (assessment §11.3, locked):
# anything ranged-GET-addressable is ONLINE; Glacier Flexible / Deep Archive
# (and the Intelligent-Tiering archive tiers) are OFFLINE; restore-in-progress
# is NEARLINE and a restored copy is ONLINE until it expires.
_OFFLINE_STORAGE_CLASSES = {'GLACIER', 'DEEP_ARCHIVE'}
_OFFLINE_ACCESS_TIERS = {'ARCHIVE_ACCESS', 'DEEP_ARCHIVE_ACCESS'}


def _availability_for_transition(storage_class: str | None,
                                 access_tier: str | None) -> str:
    if access_tier:
        return 'OFFLINE' if access_tier.upper() in _OFFLINE_ACCESS_TIERS else 'ONLINE'
    if storage_class and storage_class.upper() in _OFFLINE_STORAGE_CLASSES:
        return 'OFFLINE'
    return 'ONLINE'


def _normalize_classic_record(record) -> ObjectEvent | None:
    """One classic S3 notification record → ObjectEvent (or None to ignore)."""
    evt_name = record.get('eventName', '')
    bucket = record['s3']['bucket']['name']
    # Classic notifications URL-encode the key; EventBridge does not.
    key = urllib.parse.unquote_plus(record['s3']['object']['key'])

    if evt_name.startswith('ObjectCreated'):
        return ObjectEvent('CREATED', bucket, key)
    if evt_name.startswith('ObjectRemoved') or evt_name.startswith('LifecycleExpiration'):
        return ObjectEvent('REMOVED', bucket, key)
    if evt_name.startswith('ObjectRestore:Post'):
        return ObjectEvent('RESTORE_INITIATED', bucket, key)
    if evt_name.startswith('ObjectRestore:Completed'):
        return ObjectEvent('RESTORE_COMPLETED', bucket, key)
    if evt_name.startswith('ObjectRestore:Delete'):
        return ObjectEvent('RESTORE_EXPIRED', bucket, key)
    if evt_name.startswith('LifecycleTransition'):
        dest = (record.get('lifecycleEventData', {})
                      .get('transitionEventData', {})
                      .get('destinationStorageClass'))
        return ObjectEvent('TRANSITION', bucket, key,
                           availability=_availability_for_transition(dest, None))
    if evt_name.startswith('IntelligentTiering'):
        tier = (record.get('intelligentTieringEventData', {})
                      .get('destinationAccessTier'))
        return ObjectEvent('TRANSITION', bucket, key,
                           availability=_availability_for_transition(None, tier))
    print(f"WARNING: ignoring unhandled S3 event {evt_name} for "
          f"s3://{bucket}/{key}")
    return None


_EVENTBRIDGE_ACTIONS = {
    'Object Created': 'CREATED',
    'Object Deleted': 'REMOVED',
    'Object Restore Initiated': 'RESTORE_INITIATED',
    'Object Restore Completed': 'RESTORE_COMPLETED',
    'Object Restore Expired': 'RESTORE_EXPIRED',
}


def _normalize_eventbridge(body) -> ObjectEvent | None:
    """One EventBridge-wrapped aws.s3 event → ObjectEvent (or None to ignore)."""
    detail_type = body.get('detail-type', '')
    detail = body.get('detail', {}) or {}
    bucket = detail.get('bucket', {}).get('name')
    key = detail.get('object', {}).get('key')  # EventBridge keys are not URL-encoded
    if not bucket or not key:
        return None

    action = _EVENTBRIDGE_ACTIONS.get(detail_type)
    if action:
        return ObjectEvent(action, bucket, key)
    if detail_type == 'Object Storage Class Changed':
        dest = detail.get('destination-storage-class')
        return ObjectEvent('TRANSITION', bucket, key,
                           availability=_availability_for_transition(dest, None))
    if detail_type == 'Object Access Tier Changed':
        tier = detail.get('destination-access-tier')
        return ObjectEvent('TRANSITION', bucket, key,
                           availability=_availability_for_transition(None, tier))
    print(f"WARNING: ignoring unhandled EventBridge detail-type "
          f"{detail_type!r} for s3://{bucket}/{key}")
    return None


def _forward_to_pathology(bucket: str, key: str) -> None:
    """Forward one slide object to the pathology queue as a synthetic classic S3
    ObjectCreated notification. The pathology worker re-normalizes it through the
    exact same _normalize_message path and, with PATHOLOGY_QUEUE_URL unset there,
    processes it inline via process_svs. Only the {bucket, key} identity is
    needed — the worker re-reads the object itself. The key is URL-encoded to
    match the classic-notification contract (_normalize_classic_record unquotes
    it)."""
    payload = {
        'Records': [{
            'eventSource': 'aws:s3',
            'eventName': 'ObjectCreated:Put',
            's3': {
                'bucket': {'name': bucket},
                'object': {'key': urllib.parse.quote_plus(key)},
            },
        }]
    }
    sqs_client.send_message(
        QueueUrl=_PATHOLOGY_QUEUE_URL,
        MessageBody=json.dumps(payload))
    print(f"forwarded slide to pathology queue: s3://{bucket}/{key}")


def _normalize_message(body) -> list:
    """SQS message body (either wire shape) → list of ObjectEvents."""
    if not isinstance(body, dict):
        return []
    if body.get('Event') == 's3:TestEvent':
        return []  # bucket-notification handshake, nothing to do
    events = []
    if 'Records' in body:  # classic S3 notification batch
        for record in body.get('Records') or []:
            try:
                evt = _normalize_classic_record(record)
            except (KeyError, TypeError):
                print(f"WARNING: malformed classic S3 record skipped: "
                      f"{str(record)[:200]}")
                continue
            if evt:
                events.append(evt)
    elif body.get('source') == 'aws.s3' and 'detail' in body:
        evt = _normalize_eventbridge(body)
        if evt:
            events.append(evt)
    else:
        print(f"WARNING: unrecognized message shape skipped: {str(body)[:200]}")
    return events


# ── Visible failure path ─────────────────────────────────────────────────────
def _forward_to_dlq(evt: ObjectEvent, datastore_id: str | None, error: str):
    """Best-effort copy of a permanent failure onto the ingest DLQ.

    Permanent failures succeed their SQS message (redelivery can't fix the
    bytes and would double-count import_jobs), so visibility comes from writing
    the failure to the DLQ ourselves — the same DLQ the Queues Monitor shows.
    """
    if not INGEST_DLQ_URL:
        return
    try:
        sqs_client.send_message(
            QueueUrl=INGEST_DLQ_URL,
            MessageBody=json.dumps({
                'source': 's3-ingest',
                'reason': 'permanent-ingest-failure',
                'action': evt.action,
                'bucket': evt.bucket,
                'key': evt.key,
                'datastoreId': datastore_id,
                'error': (error or '')[:2048],
            }),
        )
    except Exception as exc:
        print(f"ERROR: failed to forward permanent failure to DLQ: {exc}")


def _apply_job_success(conn, job_id: str, instance_count: int,
                       size_bytes: int, count_file: bool):
    """Credit one object to its job + completion check, in one committed txn."""
    import_jobs.record_object_success(conn, job_id, instance_count, size_bytes,
                                      count_file=count_file)
    completion = import_jobs.maybe_complete_job(conn, job_id)
    _commit(conn)
    return completion


def _apply_job_failure(conn, job_id: str, key: str, error: str,
                       count_file: bool):
    """Charge one failed object to its job + completion check, committed."""
    import_jobs.record_object_failure(conn, job_id, key, error,
                                      count_file=count_file)
    completion = import_jobs.maybe_complete_job(conn, job_id)
    _commit(conn)
    return completion


def _record_permanent_failure(conn, evt: ObjectEvent,
                              datastore: Datastore | None, error: str,
                              job_match, job_cache: dict):
    """import_jobs failure + 'Import Object Failed' event + DLQ forward."""
    print(f"ERROR: permanent ingest failure for s3://{evt.bucket}/{evt.key}: {error}")
    datastore_id = datastore.id if datastore else None
    job_id = None
    if job_match is not None:
        job_id, count_file = job_match
        try:
            completion = _with_deadlock_retry(
                _apply_job_failure, conn, job_id, evt.key, error, count_file)
            if completion:
                _emit_job_completed_audit(job_id, completion)
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            print(f"ERROR: failed to record job failure for {job_id}: {exc}")
    index_events.emit_import_object_failed(datastore_id, evt.bucket, evt.key,
                                           error, import_job_id=job_id)
    _forward_to_dlq(evt, datastore_id, error)


def _emit_job_completed_audit(job_id: str, completion: dict):
    """Audit parity with job-status-updater's legacy manifest path."""
    failed = completion.get('failedFiles') or 0
    index_events.emit_audit_event(
        action='COMPLETE_IMPORT_JOB',
        detail_type='ImportJobCompleted',
        resource_type='import_job',
        resource_id=job_id,
        new_values={
            'jobName': completion.get('jobName'),
            'datastoreId': completion.get('datastoreId'),
            'status': completion.get('status'),
            'totalFiles': completion.get('totalFiles'),
            'processedFiles': completion.get('processedFiles'),
            'failedFiles': failed,
            'instancesImported': completion.get('instancesImported'),
        },
        status='SUCCESS' if not failed else 'FAILURE',
    )
    print(f"import job {job_id} completed: {completion.get('status')} "
          f"({completion.get('processedFiles')}/{completion.get('totalFiles')} "
          f"files, {failed} failed)")


def _object_exists_now(bucket: str, key: str) -> bool:
    """True only when a HEAD proves the key currently exists. A 404 / delete
    marker -- or any error -- returns False, so the removal proceeds exactly as
    before whenever existence cannot be shown."""
    try:
        s3_client.head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False


def _process_event(conn, evt: ObjectEvent, job_cache: dict,
                   cache: '_ParentCache | None' = None):
    """Dispatch one normalized object event. Raises only on transient errors.

    `cache` is the per-invocation _ParentCache: patient/study/series pkeys are
    resolved once per SQS batch and reused, so a same-study batch upserts each
    parent once instead of once per instance (the core deadlock-storm fix).
    """
    if evt.key.endswith('/'):
        return  # folder marker

    print(f"{evt.action} s3://{evt.bucket}/{evt.key}")
    datastore = _resolve_datastore(conn, evt.bucket)
    if datastore is None:
        if evt.action == 'CREATED':
            # Visible failure per the locked decision: an object in a bucket no
            # S3 datastore owns can never be indexed.
            _record_permanent_failure(
                conn, evt, None,
                f"bucket {evt.bucket} is not registered to any S3 datastore",
                job_match=None, job_cache=job_cache)
        else:
            print(f"WARNING: ignoring {evt.action} for unregistered bucket "
                  f"{evt.bucket}")
        return

    if evt.action == 'CREATED':
        job_match = import_jobs.match_job(conn, datastore, evt.key, job_cache)
        try:
            result = _with_deadlock_retry(_handle_created, conn, datastore,
                                          evt.bucket, evt.key, cache=cache,
                                          _dl_cache=cache)
        except PermanentIngestError as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            _record_permanent_failure(conn, evt, datastore, str(exc),
                                      job_match, job_cache)
            return

        if result.kind == 'skipped':
            return
        if result.kind == 'wsi-forward':
            # The slide was handed to the pathology queue; the pathology worker
            # does the real ingest AND owns job-completion counting for this
            # object. Emitting an index event or advancing the job here would
            # double-count. Nothing more to do in the entry lambda.
            return
        if result.instances:
            index_events.emit_instances_indexed(
                datastore.id, evt.bucket, evt.key, result.instances,
                import_job_id=job_match[0] if job_match else None)
        if result.retired:
            index_events.emit_instances_deleted(datastore.id, evt.bucket,
                                                evt.key, result.retired)
        if job_match is not None:
            job_id, count_file = job_match
            completion = _with_deadlock_retry(
                _apply_job_success, conn, job_id, len(result.instances),
                result.size_bytes, count_file)
            if completion:
                _emit_job_completed_audit(job_id, completion)

    elif evt.action == 'REMOVED':
        if _object_exists_now(evt.bucket, evt.key):
            # Delete + re-upload of the same key: the removal event can be
            # processed AFTER the re-created object was indexed (separate
            # messages, no ordering). The key holds live bytes, so soft-deleting
            # now would hide the new instance; its CREATED event owns the index
            # (and retires the previous version's instances on its own).
            print(f"skipping REMOVED for s3://{evt.bucket}/{evt.key}: the key "
                  f"exists again (re-created after the delete)")
            return
        deleted, offlined = _with_deadlock_retry(
            _handle_removed, conn, datastore, evt.bucket, evt.key)
        if deleted:
            index_events.emit_instances_deleted(datastore.id, evt.bucket,
                                                evt.key, deleted)
            # Record the touched series so the handler.py post-commit settle pass
            # runs for a DELETE-only batch too (the CREATE path is the only other
            # writer of this set). Without this a batch that ONLY removes objects
            # would never re-aggregate the emptied series/study nor unassign the
            # dangling VF pointers — the whole point of the delete cascade. The
            # settle recompute is a full idempotent COUNT and the tracker guard
            # still coalesces, so a content_pkey of 0 here is fine (it only needs
            # to mark the series as touched, not advance a watermark).
            if cache is not None:
                for inst in deleted:
                    suid = inst.get('seriesUID') or ''
                    stuid = inst.get('studyUID') or ''
                    if suid:
                        cache.touched_study_series_v2.setdefault(
                            (datastore.id, stuid, suid), 0)
        if offlined:
            index_events.emit_availability_changed(datastore.id, evt.bucket,
                                                   evt.key, 'OFFLINE', offlined)

    elif evt.action in ('TRANSITION', 'RESTORE_INITIATED',
                        'RESTORE_COMPLETED', 'RESTORE_EXPIRED'):
        availability = {
            'TRANSITION': evt.availability or 'ONLINE',
            'RESTORE_INITIATED': 'NEARLINE',
            'RESTORE_COMPLETED': 'ONLINE',
            'RESTORE_EXPIRED': 'OFFLINE',
        }[evt.action]
        changed = _with_deadlock_retry(
            _handle_availability, conn, datastore, evt.bucket, evt.key,
            availability)
        if changed:
            index_events.emit_availability_changed(
                datastore.id, evt.bucket, evt.key, availability, changed)


def _process_message(conn, sqs_record, job_cache, cache: '_ParentCache | None' = None):
    """Normalize + dispatch every event in one SQS message. Raises on error."""
    body = json.loads(sqs_record['body'])
    for evt in _normalize_message(body):
        _process_event(conn, evt, job_cache, cache=cache)


def handler(event, context):
    global _DEFER_COMMIT
    conn = _get_db_conn()

    # ── Direct (synchronous) invoke path — STOW-RS ────────────────────────────
    # dicomweb-s3 writes a STOW'd object to the source bucket, then invokes this
    # function with RequestResponse so the object is FULLY indexed (storage_index
    # + patient/study/series/instance keyword columns + the NumberOf*Related*
    # aggregates + Instancemetadata blob + frame offsets) BEFORE the STOW call
    # returns — so an immediate QIDO/WADO/metadata/frame fetch finds it. Reuses
    # the exact same _handle_created routine as the async SQS path, so row
    # identities (instanceid hash, storage_index key, content_pkey) are identical;
    # the S3 ObjectCreated notification then re-runs this idempotently. Shape:
    #   {"direct": {"bucket": "...", "key": "..."}}
    direct = event.get('direct') if isinstance(event, dict) else None
    if direct:
        bucket = direct.get('bucket')
        key = direct.get('key')
        if not bucket or not key:
            return {'ok': False, 'error': 'direct invoke requires bucket and key'}
        try:
            datastore = _resolve_datastore(conn, bucket)
            if datastore is None:
                return {'ok': False, 'error': f'bucket {bucket} not registered to any S3 datastore'}
            cache = _ParentCache()
            result = _with_deadlock_retry(_handle_created, conn, datastore,
                                          bucket, key, cache=cache, _dl_cache=cache)
            conn.commit()  # instance durable first (see batch-path rationale)
            try:
                if not _INGESTION_V2:
                    # V1 only. Under V2, stage-1 does ZERO contended parent
                    # writes; the coalescing stage-2 consumer owns last_updated +
                    # aggregate recompute. (This direct path is the STOW-RS
                    # synchronous invoke, which is wired to the V1 function today,
                    # but gate it too so a V2 direct-invoke can never re-introduce
                    # the hot-parent-row contention.)
                    _propagate_last_updated(conn, cache)
                    _recompute_aggregates(conn, cache)
                    conn.commit()
            except Exception as agg_e:
                print(f"WARNING: post-commit derived-state maintenance skipped (direct): {agg_e}")
                try:
                    conn.rollback()
                except Exception:
                    pass
            if result.kind == 'skipped':
                return {'ok': False, 'error': f'object not found: s3://{bucket}/{key}'}
            # Emit the same index events the async path emits, so downstream
            # (stats/analytics) sees the STOW'd object identically.
            try:
                if result.instances:
                    index_events.emit_instances_indexed(
                        datastore.id, bucket, key, result.instances)
            except Exception as _e:
                print(f"WARNING: index event emit skipped (direct): {_e}")
            return {'ok': True, 'instanceCount': len(result.instances),
                    'datastoreId': datastore.id}
        except PermanentIngestError as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            return {'ok': False, 'error': str(exc)}
        except Exception as exc:
            try:
                conn.rollback()
            except Exception:
                pass
            print(f"ERROR: direct ingest failed for s3://{bucket}/{key}: {exc}")
            return {'ok': False, 'error': str(exc)}

    records = event['Records']
    job_cache = {}  # datastore_id -> active import_jobs rows, per invocation

    # Fast path: defer every per-object commit and issue ONE durable commit for
    # the whole batch. Each write here is idempotent (ON DUPLICATE KEY upserts on
    # content-derived keys; deterministic instanceid), so if ANY message in the
    # batch raises we roll the whole batch back and fall through to the slow path
    # below, which replays the batch committing per message — that isolates the
    # one poison message as an SQS batch-item failure while everything else still
    # lands. The happy path (the overwhelmingly common case) pays a single fsync
    # per invocation instead of one per object.
    _DEFER_COMMIT = True
    index_events.begin_batch()
    # One parent cache for the whole batch: patient/study/series pkeys resolved
    # once and reused across every object in every message. This is what turns a
    # 15-object same-study batch's 15+15+15 parent upserts into 1+1+N, collapsing
    # the contended writes that caused the deadlock storm. Safe under the single
    # batch transaction: on a rollback the retry wrapper clears the cache, and if
    # the whole fast path aborts the slow path below rebuilds a fresh cache.
    parent_cache = _ParentCache()
    try:
        for sqs_record in records:
            _process_message(conn, sqs_record, job_cache, cache=parent_cache)
        # Commit the INSTANCE INSERTS first and make them durable. The parent
        # last_updated bump + derived-aggregate recompute are deliberately done
        # AFTER this commit, in their own transaction (below): they touch the hot
        # shared parent rows and can deadlock (1213), and a 1213 aborts the WHOLE
        # transaction — so if they ran before this commit, a deadlock there would
        # silently roll back the instance inserts and the batch would "lose"
        # instances while only logging a benign skip. Post-commit, a deadlock in
        # those derived steps leaves the instances durable; the aggregate just
        # lags until the next write recomputes it.
        conn.commit()
        # Best-effort derived-state maintenance, separately committed. A failure
        # here (incl. a deadlock) never affects the already-durable instances.
        try:
            if not _INGESTION_V2:
                # V1: bump parent last_updated + recompute the contended
                # aggregates inline (post-commit). In V2 BOTH are deferred to the
                # coalescing stage-2 consumer so stage-1 does ZERO contended
                # parent writes (the last_updated bump was the residual 1213
                # source observed in the first V2 load test).
                _propagate_last_updated(conn, parent_cache)
                _recompute_aggregates(conn, parent_cache)
                conn.commit()
        except Exception as agg_e:
            print(f"WARNING: post-commit derived-state maintenance skipped ({agg_e})")
            try:
                conn.rollback()
            except Exception:
                pass
        # DB is durable — now (and only now) emit the buffered index events,
        # coalesced into ceil(N/10) PutEvents calls for the whole batch.
        index_events.flush_batch()
        return {'batchItemFailures': []}
    except Exception as e:
        print(f"WARNING: batch commit path failed ({e}); "
              f"replaying {len(records)} message(s) individually")
        try:
            conn.rollback()
        except Exception:
            pass
        # Drop the buffered events: their DB effect was rolled back, and the
        # slow-path replay re-buffers and re-emits per message.
        index_events.begin_batch()
        index_events.flush_batch()
    finally:
        _DEFER_COMMIT = False

    # Slow path: one message at a time, one commit per message. Reached only when
    # the batched path hit an error; preserves the exact partial-batch-failure
    # contract (a poison message fails its own item; its neighbours still commit).
    failures = []
    job_cache = {}
    for sqs_record in records:
        message_id = sqs_record['messageId']
        index_events.begin_batch()
        # Fresh cache per message here: each message commits independently, so a
        # cache must never carry a pkey resolved under a sibling message that
        # later rolled back. Within one message a same-study batch still dedups.
        msg_cache = _ParentCache()
        try:
            _process_message(conn, sqs_record, job_cache, cache=msg_cache)
            conn.commit()  # instance durable first (see batch-path rationale)
            try:
                if not _INGESTION_V2:
                    _propagate_last_updated(conn, msg_cache)
                    _recompute_aggregates(conn, msg_cache)
                    conn.commit()
            except Exception as agg_e:
                print(f"WARNING: post-commit derived-state maintenance skipped (slow path): {agg_e}")
                try:
                    conn.rollback()
                except Exception:
                    pass
            index_events.flush_batch()
        except Exception as e:
            print(f"ERROR processing message {message_id}: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            index_events.begin_batch()   # discard this message's buffered events
            index_events.flush_batch()
            failures.append({'itemIdentifier': message_id})
    return {'batchItemFailures': failures}
