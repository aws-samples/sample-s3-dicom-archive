# PHI notice: this module handles Protected Health Information (patient name, ID,
# birth date, sex, accession number and other DICOM identifiers). Deployers are
# responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
# responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
"""S3-native DICOMweb (QIDO/WADO-RS) service entrypoint.

Read-only DICOMweb over the S3 storage index (`patient`/`study`/`series`/
`instance`/`Instancelocation`/`Instancemetadata`). Pixels stay in the datastore's
archive bucket and are served with ranged GETs; nothing is copied into this
service.

Two invariants run through every handler:

  1. **Tenancy.** Every route is `/dicomweb/<datastore_id>/...`, and the only
     datastore id that may reach SQL is `g.identity.datastore_id` — the value the
     `before_request` hook resolved and authorized. No handler declares the path
     variable at all (see the route block), so using the unvalidated one is not
     possible rather than merely discouraged. Our unique keys are composite, so a
     bare UID is not unique across datastores: a query missing its datastore
     predicate returns another tenant's PHI.

  2. **Availability.** `(0008,0056)` is surfaced by QIDO at every level, and every
     endpoint that ranged-GETs a backing object refuses with 503 when that object
     has tiered out of reach. `/metadata` is the deliberate exception — it reads a
     database blob, not S3.
"""

import datetime
import gzip
import hashlib
import json
import logging
import os
import re
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from uuid import uuid4

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from botocore.exceptions import ConnectionError as BotoConnectionError, HTTPClientError
import pydicom
from pydicom import Dataset, DataElement, dcmread, uid
from pydicom.filebase import DicomFileLike
from highdicom.io import ImageFileReader
from cachetools import TTLCache
from flask import Flask, g, has_request_context, request, Response
from flask_cors import CORS
from waitress import serve

import extra_transfer_syntaxes  # noqa: F401  registers JPEG XL / Deflated Image Frame with pydicom
import audit_events
import availability
import mysqlConnectionFactory
import pixel_codecs
import sql_queries
import vf_deid
from auth_middleware import (AuthMiddleware, RequestIdentity, is_download_path)
from oidc_verifier import OIDCVerifier
from writable_destination import is_writable_access_level
from db_mappings import tables, table_unique_keys, studyTagsTofields, seriesTagsTofields, instanceTagsTofields
from qido_search_tags import (
    SearchForstudiesTags,
    SearchForSeriesTags,
    SearchForInstancesTags,
    _ParentSearchForInstancesTags,
    UnsupportedFilterError,
    filter_tag_for,
    filter_is_mappable,
    is_search_key,
    _FILTER_COLUMN_OVERRIDES,
    _FILTER_EXISTS_SUBQUERIES,
)

logger = logging.getLogger(__name__)

# ── Globals (initialized in bootstrap()) ─────────────────────────────────────
sql_pool = None
s3_client = None
lambda_client = None
auth_middleware = None

# STOW-RS: the ingest lambda this service invokes SYNCHRONOUSLY after writing a
# STOW'd object, so the object is fully indexed before the STOW response returns.
INGEST_FUNCTION_ARN = os.environ.get('INGEST_FUNCTION_ARN', '')
# STOW into a writable virtual folder: per-series de-id messages for the VF de-id
# consumer, the same queue the manual assign API feeds.
VF_DEID_QUEUE_URL = os.environ.get('VF_DEID_QUEUE_URL', '')

QIDO_CACHE_TTL_SEC = int(os.environ.get('QIDO_CACHE_TTL', '0'))
QIDO_CACHE_MAX = int(os.environ.get('QIDO_CACHE_MAX', '1024'))
# QIDO caching is OFF by default (TTL 0): a newly ingested/STOW'd instance must
# appear on the very next QIDO refresh, so we never serve a stale study/series
# result set. The index query is a cheap indexed lookup, so skipping the cache
# costs little. Set QIDO_CACHE_TTL > 0 to re-enable time-bounded caching.
QIDO_CACHE_ENABLED = QIDO_CACHE_TTL_SEC > 0
WSI_TABLES_CACHE_TTL_SEC = int(os.environ.get('WSI_TABLES_CACHE_TTL', '3600'))
WSI_TABLES_CACHE_MAX = int(os.environ.get('WSI_TABLES_CACHE_MAX', '256'))
# Per-instance frame-location/offset lookup cache (WADO_INSTANCE_LOC). A WSI
# viewer panning one slide fires hundreds of tile/frame requests for a SINGLE
# instance, each of which otherwise re-runs the identical immutable
# location/offset query against the DB. The row is immutable for the life of an
# instance, so a short TTL is safe — it only bounds staleness after a delete or
# re-ingest of that exact instance. Keyed by (scope, sopinstanceuid) where scope
# is the datastore id OR the virtual-folder id (see _wado_scope): a VF-scoped
# request must never read a datastore-scoped entry or vice-versa.
FRAME_LOC_CACHE_TTL_SEC = int(os.environ.get('FRAME_LOC_CACHE_TTL', '45'))
FRAME_LOC_CACHE_MAX = int(os.environ.get('FRAME_LOC_CACHE_MAX', '4096'))
FRAME_LOC_CACHE_ENABLED = FRAME_LOC_CACHE_TTL_SEC > 0

# Applied when the client sends no limit — a bare /studies must never return
# every row in the database. QIDO-RS allows the server to impose its own cap.
QIDO_DEFAULT_LIMIT = int(os.environ.get('QIDO_DEFAULT_LIMIT', '1000'))
QIDO_MAX_LIMIT = int(os.environ.get('QIDO_MAX_LIMIT', '1000'))
WORKER_THREADS = int(os.environ.get('WORKER_THREADS', '32'))
DB_POOL_SIZE = int(os.environ.get('DB_POOL_SIZE', '32'))
# Number of WSGI WORKER PROCESSES (gunicorn) this task runs. The single-process
# waitress model left 3 of 4 vCPU idle because the GIL serializes CPU work in one
# process, so a spike of concurrent I/O-bound requests queued on one process's
# threads. Running one worker per vCPU lets those requests parallelize across
# processes. Each worker builds its OWN DB pool, S3 client and in-process caches
# (QIDO, WSI-tables, frame-loc), so the TASK's total DB connections are
# WEB_CONCURRENCY * DB_POOL_SIZE — size DB_POOL_SIZE DOWN accordingly (the CDK
# sets 4 workers * 8 = 32 conns/task, matching the old single-process 32). Caches
# are per-worker (each warms independently); acceptable for immutable-row caches.
# WEB_CONCURRENCY <= 1 keeps the original single-process waitress path.
WEB_CONCURRENCY = int(os.environ.get('WEB_CONCURRENCY', '1'))

# Chunk size for relaying an S3 body into a multipart response. Bulk retrieve is
# the one path whose response can be tens of gigabytes, so it relays chunks
# instead of buffering each instance whole — peak memory stays flat in the size of
# a study rather than the size of its largest instance.
STREAM_CHUNK_SIZE = 64 * 1024

# Study download (.zip, GET .../studies/{uid}/download). The archive is streamed
# (STORED, no recompression: pixel data is usually already compressed and
# deflating gigabytes would pin a CPU), so server memory is flat whatever the
# study size. The caps protect the BROWSER, which holds the archive in memory
# before saving it: a study above DOWNLOAD_MAX_INSTANCES is refused up front
# (413), and a response that grows past DOWNLOAD_MAX_BYTES is aborted, which the
# client sees as a failed transfer (the zip has no central directory), never as
# a silently short study.
DOWNLOAD_MAX_INSTANCES = int(os.environ.get('DOWNLOAD_MAX_INSTANCES', '10000'))
DOWNLOAD_MAX_BYTES = int(os.environ.get('DOWNLOAD_MAX_BYTES', str(2 * 1024 ** 3)))

# How many hops in front of this task append to X-Forwarded-For. Two in the
# deployed topology (CloudFront, then the internal ALB); see _client_ip_provenance for why the
# count decides which element of the chain is worth auditing. Never below 1: the
# ALB always appends one.
TRUSTED_PROXY_HOPS = max(1, int(os.environ.get('TRUSTED_PROXY_HOPS', '2')))

AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')
OIDC_ENABLED = os.environ.get('OIDC_ENABLED', 'true').lower() == 'true'
SOLUTION_VERSION = os.environ.get('SOLUTION_VERSION', 'unknown')
STACK_NAME = os.environ.get('STACK_NAME', '')
# Every archive bucket in a deployment shares this prefix. The task role is
# already scoped to it, so this is a second line of defence: a corrupted or
# attacker-influenced Instancelocation row must not be able to make this service
# fetch an unrelated object it happens to be able to read. Empty disables it.
ARCHIVE_BUCKET_PREFIX = os.environ.get('ARCHIVE_BUCKET_PREFIX', '')

# Caches and thread pools are built at import, not in bootstrap(): they need no
# credentials or configuration beyond the env knobs above, and building them here
# means a unit test can exercise a handler through create_app() without standing
# up a database. ThreadPoolExecutor spawns no thread until first submit.
worker_pool: ThreadPoolExecutor = ThreadPoolExecutor(
    max_workers=WORKER_THREADS, thread_name_prefix='dicomweb')
qido_cache: TTLCache = TTLCache(maxsize=QIDO_CACHE_MAX, ttl=max(QIDO_CACHE_TTL_SEC, 1))
# Caches the shared JPEG-tables blob (TIFF tag 347) for virtualized WSI (SVS)
# instances, keyed by (bucket, s3key, tables_offset). The tables are shared by
# every tile of a whole-slide file, so this is ~one small ranged GET per file
# amortized across thousands of tile requests.
wsi_tables_cache: TTLCache = TTLCache(maxsize=WSI_TABLES_CACHE_MAX, ttl=WSI_TABLES_CACHE_TTL_SEC)
# Per-instance frame-location lookup cache. Keyed by (scope, sopinstanceuid) —
# scope is the datastore id OR the VF id, so a VF request can never read a
# datastore entry. cachetools.TTLCache expires on access, so concurrent waitress
# worker threads mutating it during expiry need a lock around get/set; the
# existing caches ride the GIL, but this one is on the hottest path (WSI tile
# panning) so it is guarded explicitly.
frame_loc_cache: TTLCache = TTLCache(maxsize=FRAME_LOC_CACHE_MAX,
                                     ttl=max(FRAME_LOC_CACHE_TTL_SEC, 1))
_frame_loc_cache_lock = threading.Lock()

# The health probe runs its SELECT 1 here so it can bound itself. Socket-level
# timeouts belong to the pool, and a probe that blocks on a wedged database until
# the ALB's own timeout burns a waitress thread per attempt. Two workers is ample
# for two 30 s probes, and result(timeout=...) returns on schedule even if both
# are stuck.
health_pool: ThreadPoolExecutor = ThreadPoolExecutor(
    max_workers=2, thread_name_prefix='dicomweb-health')
HEALTH_DB_TIMEOUT_SECONDS = 2.0
# One permit per health worker. Without it, a database wedged with no socket
# timeout parks both workers forever and every later probe merely lengthens the
# executor's unbounded queue: the probe would answer 503 for the rest of the
# task's life, long after the database recovered, because the queued work never
# runs. Refusing to enqueue while both workers are stuck keeps the queue empty, so
# the first worker to come back serves the very next probe.
_health_slots = threading.Semaphore(2)

# Private DICOM block for DICOMweb-S3-specific attributes. Odd group 0x7777 is
# a private group; the reserved (gggg,0010) element carries the Private Creator
# ID that scopes elements (gggg,10xx). Instance-level QIDO responses expose the
# backing S3 object key at (7777,1001) — but only to a caller with the
# storage-location privilege, since the key plus the bucket is enough to bypass
# this service's authorization entirely.
PRIVATE_GROUP = 0x7777
PRIVATE_CREATOR = 'DICOMWEBS3'
PRIVATE_CREATOR_TAG = f'{PRIVATE_GROUP:04X}0010'   # (7777,0010)
PRIVATE_S3KEY_TAG = f'{PRIVATE_GROUP:04X}1001'      # (7777,1001)
PRIVATE_S3BUCKET_TAG = f'{PRIVATE_GROUP:04X}1002'   # (7777,1002)
# Levels whose result set is one row per instance (S3 key is meaningful there).
_INSTANCE_LEVELS = {'INSTANCE', 'STUDY.INSTANCE', 'STUDY.SERIES.INSTANCE'}

# Audit resource_type per QIDO level.
_QIDO_RESOURCE_TYPES = {
    'STUDY': 'study',
    'SERIES': 'series',
    'STUDY.SERIES': 'series',
    'INSTANCE': 'instance',
    'STUDY.INSTANCE': 'instance',
    'STUDY.SERIES.INSTANCE': 'instance',
}

app = Flask(__name__)


# ── Authentication ───────────────────────────────────────────────────────────
@app.before_request
def _authenticate():
    """The service's single datastore-scope check. Handlers never re-check."""
    # A CORS preflight carries no credentials and must reach no handler: every
    # handler below dereferences g.identity, which authenticate_request()
    # deliberately leaves None for OPTIONS. Answering here also keeps a preflight
    # out of the audit trail and off the database. flask_cors' after_request adds
    # the Access-Control-* headers to this response when CORS is configured.
    if request.method == 'OPTIONS':
        return Response(status=204)

    # DEV/DEBUG ONLY AUTH BYPASS (env DICOMWEB_AUTH_BYPASS, default OFF). NOT A
    # PRODUCTION FEATURE. Driven by the CDK config flag `devOnlyAuthBypass`: the
    # container is deployed WITHOUT this env var unless that flag is true, so it
    # is inert in a normal deploy. When enabled it synthesizes a datastore-scoped
    # identity from the URL so a developer can exercise the service without a
    # token. It disables ALL access control on a PHI service, so it must only
    # ever be enabled in an isolated dev/test deployment, never one holding real
    # data. Health and OPTIONS are already handled above.
    if (os.environ.get('DICOMWEB_AUTH_BYPASS', '') or '').lower() in ('1', 'true', 'yes'):
        _ds = _datastore_id_from_path(request.path)
        if _ds:
            g.identity = RequestIdentity(username='auth-bypass', datastore_id=_ds,
                                         include_private_tags=True)
            logger.warning("AUTHBYPASS active (debug) for datastore %s path %s", _ds, request.path)
            return None

    # A missing middleware means the service booted without auth wiring. Refusing
    # with 503 is the only safe answer: AttributeError-ing into a 500 here reads
    # like a transient fault and invites a retry loop against an unguarded
    # service.
    if auth_middleware is None:
        if request.path in AuthMiddleware.EXEMPT_PATHS:
            return None
        return Response(json.dumps({"error": "Service unavailable"}),
                        status=503, mimetype="application/json")
    try:
        g.identity = auth_middleware.authenticate_request()
    except Exception as exc:      # noqa: BLE001 - the middleware maps type to status
        # Only a non-exempt, non-OPTIONS request can raise here, so every arrival
        # at this line is a real denial worth a trail entry.
        _emit_audit(
            _action_for_path(request.path), 'DICOMweb Access Denied',
            'datastore', _datastore_id_from_path(request.path),
            {
                'datastoreId': _datastore_id_from_path(request.path),
                'reason': type(exc).__name__,
                # request.path, never full_path: the query string carries QIDO
                # filter values, which are PHI.
                'path': request.path,
            },
            status='FAILURE', error_message=str(exc),
        )
        return auth_middleware.handle_auth_error(exc)
    return None


# ── Health ───────────────────────────────────────────────────────────────────
@app.route('/dicomweb/health', methods=['GET'])
def health():
    """ALB target-group probe. Auth-exempt, never audited, no datastore.

    Reports the database because that is the dependency whose loss makes every
    other route useless: a task that cannot reach Aurora should leave the target
    group rather than serve 500s.
    """
    if not _health_slots.acquire(blocking=False):
        # Both workers still stuck in an earlier probe. That is itself a degraded
        # database, and not enqueueing is what lets the probe recover later.
        logger.warning("health check skipped: no probe slot free")
        return _health_degraded()

    try:
        future = health_pool.submit(_probe_db)
    except Exception:             # noqa: BLE001 - executor refused the work
        _health_slots.release()
        raise

    try:
        future.result(timeout=HEALTH_DB_TIMEOUT_SECONDS)
    except Exception as exc:      # noqa: BLE001 - any failure is "degraded"
        logger.warning("health check failed: %s", exc)
        return _health_degraded()
    return Response(json.dumps({"status": "ok", "version": SOLUTION_VERSION}),
                    mimetype="application/json")


def _health_degraded() -> Response:
    return Response(
        json.dumps({"status": "degraded", "version": SOLUTION_VERSION, "error": "database"}),
        status=503, mimetype="application/json")


def _probe_db() -> None:
    """Run the ping and free the slot however long the ping takes.

    The worker releases the permit, not the request thread: the request thread
    gives up after HEALTH_DB_TIMEOUT_SECONDS while a blocked PyMySQL socket read
    can hold the worker for much longer, and releasing early would let probes pile
    up in the queue again.
    """
    try:
        _db_ping()
    finally:
        _health_slots.release()


def _db_ping() -> None:
    """SELECT 1 on a pooled connection. Touches no index table."""
    sql_conn = mysqlConnectionFactory.connection_with_rotation_retry()
    try:
        cursor = sql_conn.cursor()
        try:
            cursor.execute('SELECT 1')
            cursor.fetchone()
        finally:
            cursor.close()
    finally:
        sql_conn.close()


# ── Routes ───────────────────────────────────────────────────────────────────
# Every data-plane route carries <datastore_id>, and no handler below declares
# it: the path value is unvalidated, and only g.identity.datastore_id has been
# resolved and authorized by the hook above. Flask passes view args as keyword
# arguments, so absorbing it into **_ leaves the wrong value literally
# unreachable from the handler body.

# ── QIDO endpoints ───────────────────────────────────────────────────────────
@app.route("/dicomweb/<datastore_id>/studies", methods=["GET", "OPTIONS"])
def search_for_studies(**_):
    return _qido_response(level="STUDY")


# ── STOW-RS (store) ──────────────────────────────────────────────────────────
# Write path: parse the multipart/related DICOM body, write each instance to the
# SOURCE datastore's bucket at YYYY/MM/DD/<studyUID>/<seriesUID>/<sopUID>.dcm, then
# SYNCHRONOUSLY invoke the ingest lambda per object so the instance is fully
# queryable/retrievable before this response returns. Authorization (canStore) is
# enforced by the before_request middleware; a VF-index target is rejected there.
DICOM_JSON = "application/dicom+json"


def _source_bucket_for(datastore_id):
    """Resolve the source archive bucket for the authorized datastore id.
    None for a read-only storage too (defense in depth: the middleware already
    refuses writes into one, see writable_destination)."""
    row = _fetch_one(
        "SELECT s3_bucket_name, access_level FROM datastores WHERE id = %s "
        "AND deleted = FALSE AND status = 'ACTIVE'",
        (datastore_id,))
    if not row or not is_writable_access_level(row.get('access_level')):
        return None
    return row['s3_bucket_name']


def _parse_multipart_dicom(body, content_type):
    """Yield raw DICOM part bodies from a multipart/related; type=application/dicom
    request. Minimal boundary splitter — STOW bodies are application/dicom parts."""
    m = re.search(r'boundary="?([^";]+)"?', content_type or '')
    if not m:
        raise ValueError("missing multipart boundary")
    boundary = ('--' + m.group(1)).encode()
    parts = body.split(boundary)
    for part in parts:
        if not part or part in (b'--\r\n', b'--', b'\r\n'):
            continue
        # split headers from body on the first blank line
        idx = part.find(b'\r\n\r\n')
        if idx == -1:
            continue
        payload = part[idx + 4:]
        # strip the trailing CRLF that precedes the next boundary
        if payload.endswith(b'\r\n'):
            payload = payload[:-2]
        if payload:
            yield payload


STOW_INGEST_ATTEMPTS = max(1, int(os.environ.get('STOW_INGEST_ATTEMPTS', '3')))
# Lambda errors worth another try: the request may never have reached the
# function (throttled, service-side 5xx). Indexing one key is an idempotent
# upsert (the S3 notification indexes every STOW object a second time anyway),
# so a retry after a lost RESPONSE is also safe.
_RETRYABLE_LAMBDA_CODES = {'TooManyRequestsException', 'ServiceException', 'EC2ThrottledException',
                           'ResourceConflictException', 'ThrottlingException'}


def _invoke_sync_ingest(bucket, key, sop_uid):
    """Index one stored object through the ingest Lambda; retry transport errors.

    The client keeps botocore retries off (one place decides). A connection the
    NAT/LB closed while the call was idle shows up as ConnectionClosedError and
    is retried here with a short backoff. Returns (response, payload).
    """
    body = json.dumps({"direct": {"bucket": bucket, "key": key}}).encode()
    for attempt in range(1, STOW_INGEST_ATTEMPTS + 1):
        try:
            resp = lambda_client.invoke(FunctionName=INGEST_FUNCTION_ARN,
                                        InvocationType='RequestResponse', Payload=body)
            return resp, json.loads(resp['Payload'].read() or b'{}')
        # ConnectionClosedError / ReadTimeoutError are HTTPClientError, not ConnectionError.
        except (BotoConnectionError, HTTPClientError, ClientError) as e:
            code = e.response.get('Error', {}).get('Code') if isinstance(e, ClientError) else None
            if isinstance(e, ClientError) and code not in _RETRYABLE_LAMBDA_CODES:
                raise
            if attempt == STOW_INGEST_ATTEMPTS:
                raise
            logger.warning("STOW sync ingest attempt %d/%d for %s failed (%s), retrying",
                           attempt, STOW_INGEST_ATTEMPTS, sop_uid, code or type(e).__name__)
            time.sleep(0.5 * (2 ** (attempt - 1)))


@app.route("/dicomweb/<datastore_id>/studies", methods=["POST"])
@app.route("/dicomweb/<datastore_id>/studies/<studyInstanceUID>", methods=["POST"])
def store_instances(studyInstanceUID: str = None, **_):
    datastore_id = g.identity.datastore_id
    bucket = _source_bucket_for(datastore_id)
    if not bucket:
        return Response(json.dumps({"error": "datastore has no writable S3 bucket"}),
                        status=409, mimetype="application/json")

    ctype = request.headers.get('Content-Type', '')
    if 'multipart/related' not in ctype:
        return Response(json.dumps({"error": "STOW requires multipart/related; type=\"application/dicom\""}),
                        status=400, mimetype="application/json")

    try:
        parts = list(_parse_multipart_dicom(request.get_data(), ctype))
    except ValueError as e:
        return Response(json.dumps({"error": str(e)}), status=400, mimetype="application/json")
    if not parts:
        return Response(json.dumps({"error": "no application/dicom parts in request"}),
                        status=400, mimetype="application/json")

    referenced = []   # successfully stored + indexed
    failed = []       # {sop, reason}
    for raw in parts:
        # Security: UIDs become the S3 key, so only real DICOM UIDs are
        # accepted (a "/" or ".." would write outside the study's prefix).
        try:
            ds = dcmread(BytesIO(raw), stop_before_pixels=False, force=True)
            study_uid = str(ds.StudyInstanceUID)
            series_uid = str(ds.SeriesInstanceUID)
            sop_uid = str(ds.SOPInstanceUID)
            sop_class = str(getattr(ds, 'SOPClassUID', '') or '')
        except Exception as e:
            failed.append({"sop": None, "reason": f"unparseable DICOM part: {e}"})
            continue
        bad_uid = next((u for u in (study_uid, series_uid, sop_uid) if not _is_dicom_uid(u)), None)
        if bad_uid is not None:
            failed.append({"sop": sop_uid if _is_dicom_uid(sop_uid) else None,
                           "reason": "invalid DICOM UID", "class": sop_class})
            continue

        # Reject a study-UID mismatch when the URL pins one (DICOM STOW rule).
        if studyInstanceUID and study_uid != studyInstanceUID:
            failed.append({"sop": sop_uid, "reason": "StudyInstanceUID mismatch with request URI",
                           "class": sop_class})
            continue

        # Partition by StudyDate when present (groups a study's objects, stable on
        # re-STOW), else by today's UTC date.
        study_date = str(getattr(ds, 'StudyDate', '') or '')
        if len(study_date) == 8 and study_date.isdigit():
            date_prefix = f"{study_date[0:4]}/{study_date[4:6]}/{study_date[6:8]}"
        else:
            now = datetime.datetime.now(datetime.timezone.utc)
            date_prefix = now.strftime("%Y/%m/%d")
        s3_key = f"{date_prefix}/{study_uid}/{series_uid}/{sop_uid}.dcm"

        try:
            # Security: never overwrite. A re-send of the SAME bytes is
            # idempotent (the object is re-indexed); different bytes under an
            # existing SOP Instance UID are refused as a duplicate.
            if not _put_if_absent_or_identical(bucket, s3_key, raw):
                failed.append({"sop": sop_uid, "reason": "an object with this SOP Instance UID already exists",
                               "class": sop_class, "code": 273})  # 0111 = duplicate SOP instance
                continue
        except Exception as e:
            # Do not log the SOP Instance UID (a PHI identifier); log the error only.
            logger.error("STOW S3 put failed for one instance: %s", e)
            failed.append({"sop": sop_uid, "reason": f"storage write failed: {e}",
                           "class": sop_class})
            continue

        # Synchronous full index via the ingest lambda (same routine as async).
        if not INGEST_FUNCTION_ARN or lambda_client is None:
            # Object is written and the S3 notification will index it async; but we
            # cannot GUARANTEE immediate retrieval, so report as accepted-not-indexed.
            failed.append({"sop": sop_uid, "reason": "sync ingest not configured; object stored, indexing deferred",
                           "class": sop_class})
            continue
        try:
            resp, payload = _invoke_sync_ingest(bucket, s3_key, sop_uid)
            if resp.get('FunctionError') or not payload.get('ok'):
                reason = payload.get('error') or resp.get('FunctionError') or 'ingest failed'
                failed.append({"sop": sop_uid, "reason": f"index failed: {reason}",
                               "class": sop_class})
                continue
        except Exception as e:
            logger.error("STOW sync ingest invoke failed: %s", type(e).__name__)  # no SOP UID: PHI
            failed.append({"sop": sop_uid, "reason": f"index invoke failed: {e}",
                           "class": sop_class})
            continue

        referenced.append({"sop": sop_uid, "class": sop_class, "study": study_uid, "series": series_uid})

    vf_id = getattr(g.identity, 'virtual_folder_id', None)
    if vf_id and referenced:
        referenced, not_assigned = _assign_stowed_to_vf(vf_id, datastore_id, referenced)
        failed.extend(not_assigned)

    # Build the DICOM STOW-RS response (application/dicom+json).
    resp_ds = {}
    if referenced:
        resp_ds["00081199"] = {"vr": "SQ", "Value": [
            {
                "00081150": {"vr": "UI", "Value": [r["class"]]} if r["class"] else {"vr": "UI"},
                "00081155": {"vr": "UI", "Value": [r["sop"]]},
            } for r in referenced
        ]}
    if failed:
        resp_ds["00081198"] = {"vr": "SQ", "Value": [
            {
                "00081150": {"vr": "UI", "Value": [f.get("class")]} if f.get("class") else {"vr": "UI"},
                "00081155": {"vr": "UI", "Value": [f["sop"]]} if f.get("sop") else {"vr": "UI"},
                "00081197": {"vr": "US", "Value": [f.get("code", 272)]},  # 0110 processing failure / 0111 duplicate
            } for f in failed
        ]}
    # 200 all-ok, 202 partial, 409 all-failed (DICOM PS3.18 STOW status codes).
    status = 200 if referenced and not failed else (202 if referenced else 409)
    # One audit row per STOW request: who stored what where. UIDs and counts only;
    # the failure reasons can quote parser text, so they stay out of the row.
    studies = sorted({r['study'] for r in referenced})
    _emit_audit(
        audit_events.ACTION_STORE, 'DICOMweb Instances Stored',
        'study' if len(studies) == 1 else 'datastore',
        studies[0] if len(studies) == 1 else datastore_id,
        {'datastoreId': datastore_id, 'virtualFolderId': vf_id,
         'stored': len(referenced), 'failed': len(failed), 'httpStatus': status,
         'studyInstanceUids': studies[:50],
         'seriesInstanceUids': sorted({r['series'] for r in referenced})[:50]},
        status='SUCCESS' if referenced else 'FAILURE',
        error_message=None if referenced else f'{len(failed)} instance(s) not stored')
    return Response(json.dumps(resp_ds), status=status, mimetype=DICOM_JSON,
                    content_type=DICOM_JSON)

_DICOM_UID_RE = re.compile(r'^[0-9]+(\.[0-9]+)*$')  # nosemgrep: python.lang.security.audit.regex_dos -- anchored DICOM UID regex on bounded internal input (audited)


def _is_dicom_uid(value) -> bool:
    return isinstance(value, str) and len(value) <= 64 and bool(_DICOM_UID_RE.match(value))


def _put_if_absent_or_identical(bucket, key, raw) -> bool:
    """Write `raw` only when `key` does not exist yet (S3 conditional write).
    True when written, or when the existing object holds exactly these bytes;
    False when a DIFFERENT object is already stored under the key."""
    try:
        s3_client.put_object(Bucket=bucket, Key=key, Body=raw,
                             ContentType="application/dicom", IfNoneMatch='*')
        return True
    except ClientError as e:
        code = (e.response.get('Error') or {}).get('Code', '')
        status = (e.response.get('ResponseMetadata') or {}).get('HTTPStatusCode')
        if code not in ('PreconditionFailed', 'ConditionalRequestConflict') and status not in (409, 412):
            raise
    head = s3_client.head_object(Bucket=bucket, Key=key)
    etag = str(head.get('ETag', '')).strip('"')
    return '-' not in etag and etag == hashlib.md5(raw).hexdigest()  # nosec - content comparison, not security # nosemgrep: python.lang.security.insecure-hash-algorithm-md5 -- MD5 compared to the S3 ETag for content integrity, not a security control (audited)


def _assign_stowed_to_vf(vf_id, datastore_id, referenced):
    """Assign instances a STOW into a writable virtual folder just stored and
    indexed in the folder's storage. Returns (assigned, not_assigned_failures).

    Mirrors virtual-folder-assignment-api assignSeries: membership rows keyed by
    the instance's content_pkey, then one de-id message per series so the
    folder's de-identified tree is built, then the folder's counts. An instance
    that is stored but could not be assigned is reported as a failure: it is in
    the storage but not visible through the folder."""
    sops = [r["sop"] for r in referenced]
    ph = ",".join(["%s"] * len(sops))
    try:
        _execute_write(
            "INSERT INTO virtual_folder_assignments "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
            "  (virtual_folder_id, datastore_id, content_pkey, study_instance_uid, series_instance_uid, sop_instance_uid) "
            "SELECT %s, i.datastore_id, i.content_pkey, st.studyinstanceuid, se.seriesinstanceuid, i.sopinstanceuid "
            "FROM instance i JOIN series se ON se.series_pkey = i.series_pkey "
            "JOIN study st ON st.study_pkey = se.study_pkey "
            f"WHERE i.datastore_id = %s AND i.sopinstanceuid IN ({ph}) "
            "  AND i.deleted_at IS NULL AND i.content_pkey IS NOT NULL "
            "ON DUPLICATE KEY UPDATE datastore_id = VALUES(datastore_id)",
            (vf_id, datastore_id, *sops))
        rows = _execute_query(
            "SELECT sop_instance_uid FROM virtual_folder_assignments "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
            f"WHERE virtual_folder_id = %s AND sop_instance_uid IN ({ph})", (vf_id, *sops))
        assigned_sops = {r["sop_instance_uid"] for r in rows}
    except Exception as e:  # noqa: BLE001
        logger.error("STOW VF assign failed for %s: %s", vf_id, e)
        assigned_sops = set()

    assigned = [r for r in referenced if r["sop"] in assigned_sops]
    missing = [{"sop": r["sop"], "class": r["class"],
                "reason": "stored in the folder's storage but not assigned to the folder"}
               for r in referenced if r["sop"] not in assigned_sops]

    series_units = sorted({(r["series"], r["study"]) for r in assigned})
    if series_units and VF_DEID_QUEUE_URL:
        sqs = boto3.client('sqs')
        for series_uid, study_uid in series_units:
            try:
                sqs.send_message(QueueUrl=VF_DEID_QUEUE_URL, MessageBody=json.dumps({
                    "op": "deid", "virtual_folder_id": vf_id, "datastore_id": datastore_id,
                    "series_instance_uid": series_uid, "study_instance_uid": study_uid}))
            except Exception as e:  # noqa: BLE001 - the indexer reconciles a missed message
                logger.error("VF de-id enqueue failed (vf=%s): %s", vf_id, type(e).__name__)  # no series UID: PHI
    elif series_units:
        logger.warning("VF_DEID_QUEUE_URL not set; de-id tree of %s not built after STOW", vf_id)
    if assigned:
        _recompute_vf_stats(vf_id)
    logger.info("STOW into VF %s: %d assigned, %d not assigned, %d series queued for de-id",
                vf_id, len(assigned), len(missing), len(series_units))
    return assigned, missing


# ── DELETE (non-standard hierarchical delete) ────────────────────────────────
# DICOMweb has no standard delete verb, but we expose HTTP DELETE on the study /
# series / instance resources as the deletion API (hierarchical only, no query
# filters). Two scopes, disambiguated by g.identity exactly like the read path:
#
#   STORAGE (g.identity.datastore_id set): a real deletion from the source
#     storage — soft-delete the instance/series/study tree (cascading up),
#     hard-unassign the content from EVERY virtual folder, HARD-delete the
#     backing S3 objects + soft-delete storage_index, and emit 'Instance
#     Deleted' so index-stats-consumer recomputes datastore_statistics.
#
#   VF (g.identity.virtual_folder_id set): remove content from THIS folder only
#     — delete just this VF's virtual_folder_assignments + virtual_instance rows
#     for the target content; NEVER touch S3, the storage tree, or another VF;
#     recompute virtual_folder_statistics.
#
# This is a faithful Python port of the delete worker
# (cdk-infrastructure/lib/DataManagement/lambda/queue-consumer.js) so the
# semantics are identical whether a delete arrives via the job queue or this
# synchronous verb. Reads filter deleted_at IS NULL, so a storage soft-delete
# disappears from QIDO/WADO immediately. Idempotent: nothing live -> 204 no-op.
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')
INDEX_EVENT_SOURCE = 'dicom.archive.index'


def _execute_write(query: str, params):
    """Run one write statement (autocommit pool) and return affected rowcount."""
    logger.debug("SQL(write): %s | %d params", query, len(params or ()))
    sql_conn = mysqlConnectionFactory.connection_with_rotation_retry()
    try:
        cursor = sql_conn.cursor()
        try:
            cursor.execute(query, params)
            return cursor.rowcount
        finally:
            cursor.close()
    finally:
        sql_conn.close()


def _resolve_storage_delete_rows(datastore_id, level, study_uid, series_uid, sop_uid):
    """Instance rows (+ physical objects + parent pkeys) to delete, by level.
    Returns [] when nothing live matches (idempotent)."""
    base = (
        "SELECT i.instance_pkey, i.content_pkey, s.series_pkey, st.study_pkey, "
        "       st.patient_pkey, si.s3_bucket_name, si.s3_key "
        "  FROM instance i "
        "  JOIN series s ON s.series_pkey = i.series_pkey "
        "  JOIN study st ON st.study_pkey = s.study_pkey "
        "  LEFT JOIN storage_index si ON si.content_pkey = i.content_pkey "
        " WHERE i.datastore_id = %s AND i.deleted_at IS NULL "
        "   AND s.deleted_at IS NULL AND st.deleted_at IS NULL")
    if level == 'INSTANCE':
        return _execute_query(
            base + " AND st.studyinstanceuid = %s AND s.seriesinstanceuid = %s AND i.sopinstanceuid = %s",
            (datastore_id, study_uid, series_uid, sop_uid))
    if level == 'SERIES':
        return _execute_query(
            base + " AND st.studyinstanceuid = %s AND s.seriesinstanceuid = %s",
            (datastore_id, study_uid, series_uid))
    return _execute_query(base + " AND st.studyinstanceuid = %s", (datastore_id, study_uid))


def _delete_from_storage(datastore_id, level, study_uid, series_uid, sop_uid):
    """Real deletion from source storage. Mirrors deleteFromStorage in the worker.
    Returns the count of instance rows deleted."""
    rows = _resolve_storage_delete_rows(datastore_id, level, study_uid, series_uid, sop_uid)
    if not rows:
        logger.info("DELETE(%s) STORAGE: nothing live to delete in %s", level, datastore_id)
        return 0

    content_pkeys = list({r['content_pkey'] for r in rows if r['content_pkey'] is not None})
    instance_pkeys = list({r['instance_pkey'] for r in rows})
    series_pkeys = list({r['series_pkey'] for r in rows})
    study_pkeys = list({r['study_pkey'] for r in rows})
    patient_pkeys = list({r['patient_pkey'] for r in rows})

    # 1. Unassign from EVERY virtual folder (hard; never touch S3 here).
    if content_pkeys:
        ph = ','.join(['%s'] * len(content_pkeys))
        # The retired shared `virtual_instance` table was DROPped (replaced by
        # per-folder vf_<id>_instance databases), so a DELETE against it 1146s and
        # aborts the whole storage-delete transaction. Removed. Fanning the purge
        # across every vf_<id>_instance database (this path has no single vf id in
        # hand) is a cross-VF cascade concern owned by the per-VF cleanup path,
        # tracked separately; virtual_folder_assignments (shared, live) is the
        # authoritative membership record and IS purged here.
        _execute_write(f"DELETE FROM virtual_folder_assignments WHERE content_pkey IN ({ph})", content_pkeys)  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)

    # 2. HARD-delete the backing S3 objects, then soft-delete storage_index.
    for r in rows:
        if r.get('s3_bucket_name') and r.get('s3_key'):
            try:
                s3_client.delete_object(Bucket=r['s3_bucket_name'], Key=r['s3_key'])
            except Exception as e:  # noqa: BLE001 - a missing object must not fail the delete
                # Do not log the full S3 key (it can encode study/series UIDs).
                logger.warning("S3 delete failed for an object in bucket %s: %s",
                               r['s3_bucket_name'], e)
    if content_pkeys:
        ph = ','.join(['%s'] * len(content_pkeys))
        _execute_write(f"UPDATE storage_index SET deleted_at = NOW() WHERE content_pkey IN ({ph})",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                       content_pkeys)

    # 3. Soft-delete the instance rows, then the now-empty parents, cascading up.
    iph = ','.join(['%s'] * len(instance_pkeys))
    _execute_write(
        f"UPDATE instance SET deleted_at = NOW() WHERE instance_pkey IN ({iph}) AND deleted_at IS NULL",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        instance_pkeys)
    for sp in series_pkeys:
        live = _fetch_one(
            "SELECT COUNT(*) AS n FROM instance WHERE series_pkey = %s AND deleted_at IS NULL", (sp,))
        if int(live['n']) == 0:
            _execute_write("UPDATE series SET deleted_at = NOW() WHERE series_pkey = %s", (sp,))
    for stp in study_pkeys:
        live = _fetch_one(
            "SELECT COUNT(*) AS n FROM series WHERE study_pkey = %s AND deleted_at IS NULL", (stp,))
        if int(live['n']) == 0:
            _execute_write("UPDATE study SET deleted_at = NOW() WHERE study_pkey = %s", (stp,))
    for pp in patient_pkeys:
        live = _fetch_one(
            "SELECT COUNT(*) AS n FROM study WHERE patient_pkey = %s AND deleted_at IS NULL", (pp,))
        if int(live['n']) == 0:
            _execute_write("UPDATE patient SET deleted_at = NOW() WHERE patient_pkey = %s", (pp,))

    logger.info("DELETE(%s) STORAGE: %d instances, %d objects from %s",
                level, len(instance_pkeys), len(content_pkeys), datastore_id)
    _emit_instance_deleted(datastore_id)
    return len(instance_pkeys)


def _delete_from_virtual_folder(vf_id, level, study_uid, series_uid, sop_uid):
    """Remove content from ONE virtual folder only. Mirrors deleteFromVirtualFolder.
    NEVER touches S3 / storage tree / other folders. Returns count of objects removed."""
    # Phase 3: this folder's de-id instance rows live in its own database
    # vf_<id> (table vf_<id>_instance, keyed on instance_pkey). The membership
    # list (virtual_folder_assignments) STAYS SHARED in dicomarchive and still keys
    # on virtual_folder_id, so the assignment lookup/delete below is unchanged.
    vf_db = sql_queries.vf_db_name(vf_id)
    where = "virtual_folder_id = %s"
    params = [vf_id]
    if level == 'STUDY':
        where += " AND study_instance_uid = %s"
        params.append(study_uid)
    elif level == 'SERIES':
        where += " AND study_instance_uid = %s AND series_instance_uid = %s"
        params.extend([study_uid, series_uid])
    else:  # INSTANCE
        where += " AND sop_instance_uid = %s"
        params.append(sop_uid)

    assigned = _execute_query(
        f"SELECT content_pkey FROM virtual_folder_assignments WHERE {where}", params)  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    if not assigned:
        logger.info("VF unassign(%s): nothing assigned in folder %s", level, vf_id)
        return 0
    content_pkeys = list({r['content_pkey'] for r in assigned if r['content_pkey'] is not None})
    if content_pkeys:
        ph = ','.join(['%s'] * len(content_pkeys))
        # vf_<id>_instance has no virtual_folder_id column (the database is the
        # scope); delete by content_pkey within this folder's own database.
        _execute_write(
            f"DELETE FROM `{vf_db}`.`{vf_db}_instance` WHERE content_pkey IN ({ph})",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
            content_pkeys)
    _execute_write(f"DELETE FROM virtual_folder_assignments WHERE {where}", params)  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    logger.info("VF unassign(%s): removed %d objects from folder %s (no S3 touched)",
                level, len(content_pkeys), vf_id)
    _recompute_vf_stats(vf_id)
    return len(content_pkeys)


def _recompute_vf_stats(vf_id):
    """Recompute virtual_folder_statistics for a folder after an unassign.

    Phase 3 scoping note: this touches ONLY shared, dicomarchive-resident tables —
    virtual_folder_statistics (a control-plane counts table keyed by
    virtual_folder_id, FK -> shared virtual_folders, NOT part of the per-VF
    vf_<id> tree template) and virtual_folder_assignments (the shared membership
    list). Neither is a de-id TREE table, so both stay shared and keep their
    virtual_folder_id key; this function is deliberately unchanged by the
    per-database move.

    The row id is minted by MySQL's UUID() (36 chars, as the assignment API
    does): virtual_folder_statistics.id is VARCHAR(36), and the old
    'vfstats-<vf uuid>' id (44 chars) failed every insert in strict mode, so
    the folder's counts were never refreshed. On an existing row the unique
    key on virtual_folder_id takes the ON DUPLICATE KEY UPDATE branch and the
    id is left as it is."""
    try:
        _execute_write(
            "INSERT INTO virtual_folder_statistics "
            "  (id, virtual_folder_id, patient_count, study_count, series_count, instance_count) "
            "SELECT UUID(), %s, "
            "  COUNT(DISTINCT study_instance_uid), COUNT(DISTINCT study_instance_uid), "
            "  COUNT(DISTINCT series_instance_uid), COUNT(DISTINCT sop_instance_uid) "
            "FROM virtual_folder_assignments WHERE virtual_folder_id = %s "
            "ON DUPLICATE KEY UPDATE "
            "  study_count = VALUES(study_count), series_count = VALUES(series_count), "
            "  instance_count = VALUES(instance_count), last_updated = NOW()",
            (vf_id, vf_id))
    except Exception as e:  # noqa: BLE001 - stats are best-effort, never fail the delete
        logger.warning("VF stats recompute skipped for %s: %s", vf_id, e)


def _emit_instance_deleted(datastore_id):
    """Emit 'Instance Deleted' so index-stats-consumer recomputes datastore_statistics."""
    if not EVENT_BUS_NAME:
        return
    try:
        boto3.client('events').put_events(Entries=[{
            'Source': INDEX_EVENT_SOURCE,
            'DetailType': 'Instance Deleted',
            'EventBusName': EVENT_BUS_NAME,
            'Detail': json.dumps({'datastoreId': datastore_id}),
        }])
    except Exception as e:  # noqa: BLE001
        logger.warning("stats event emit failed for %s: %s", datastore_id, e)


def _delete_dispatch(level, study_uid, series_uid=None, sop_uid=None):
    """Shared DELETE handler: branch on scope (VF vs storage), do the delete,
    audit, and return a DICOMweb-style response.

    204 No Content on success (including an idempotent no-op — the resource is
    absent either way, which is the delete postcondition); 500 on an unexpected
    failure. Authorization (canDelete / VF canStore) was already enforced by the
    before_request middleware."""
    vf_id = getattr(g.identity, 'virtual_folder_id', None)
    resource_type = 'instance' if sop_uid else ('series' if series_uid else 'study')
    resource_id = sop_uid or series_uid or study_uid
    new_values = {
        'level': level,
        'scope': 'VF' if vf_id else 'STORAGE',
        'studyInstanceUID': study_uid,
    }
    if vf_id:
        new_values['virtualFolderId'] = vf_id
    else:
        new_values['datastoreId'] = g.identity.datastore_id
    if series_uid:
        new_values['seriesInstanceUID'] = series_uid
    if sop_uid:
        new_values['sopInstanceUID'] = sop_uid

    try:
        if vf_id:
            removed = _delete_from_virtual_folder(vf_id, level, study_uid, series_uid, sop_uid)
        else:
            removed = _delete_from_storage(g.identity.datastore_id, level, study_uid, series_uid, sop_uid)
    except Exception as e:  # noqa: BLE001 - map to 500, audit the failure, keep detail off the wire
        logger.error("DELETE(%s) failed: %s", level, e)
        _emit_audit(audit_events.ACTION_DELETE, 'DICOMweb Delete', resource_type, resource_id,
                    new_values, status='FAILURE', error_message=str(e))
        return Response(json.dumps({"error": "delete failed"}), status=500,
                        mimetype="application/json")

    new_values['removed'] = removed
    _emit_audit(audit_events.ACTION_DELETE, 'DICOMweb Delete', resource_type, resource_id,
                new_values, status='SUCCESS')
    return Response(status=204)


@app.route("/dicomweb/<datastore_id>/studies/<studyInstanceUID>", methods=["DELETE"])
def delete_study(studyInstanceUID: str, **_):
    return _delete_dispatch('STUDY', studyInstanceUID)


@app.route("/dicomweb/<datastore_id>/studies/<studyInstanceUID>/series/<seriesInstanceUID>",
           methods=["DELETE"])
def delete_series(studyInstanceUID: str, seriesInstanceUID: str, **_):
    return _delete_dispatch('SERIES', studyInstanceUID, seriesInstanceUID)


@app.route("/dicomweb/<datastore_id>/studies/<studyInstanceUID>/series/<seriesInstanceUID>"
           "/instances/<sopInstanceUID>", methods=["DELETE"])
def delete_instance(studyInstanceUID: str, seriesInstanceUID: str, sopInstanceUID: str, **_):
    return _delete_dispatch('INSTANCE', studyInstanceUID, seriesInstanceUID, sopInstanceUID)



@app.route("/dicomweb/<datastore_id>/studies/<studyInstanceUID>/series", methods=["GET", "OPTIONS"])
def search_for_study_series(studyInstanceUID: str, **_):
    return _qido_response(level="STUDY.SERIES", path_params={"StudyInstanceUID": studyInstanceUID})


@app.route("/dicomweb/<datastore_id>/studies/<studyInstanceUID>/instances", methods=["GET", "OPTIONS"])
def search_for_study_instances(studyInstanceUID: str, **_):
    return _qido_response(level="STUDY.INSTANCE", path_params={"StudyInstanceUID": studyInstanceUID})


@app.route("/dicomweb/<datastore_id>/series", methods=["GET", "OPTIONS"])
def search_for_series(**_):
    return _qido_response(level="SERIES")


@app.route("/dicomweb/<datastore_id>/studies/<studyInstanceUID>/series/<seriesInstanceUID>/instances",
           methods=["GET", "OPTIONS"])
def search_for_study_series_instances(studyInstanceUID: str, seriesInstanceUID: str, **_):
    return _qido_response(level="STUDY.SERIES.INSTANCE", path_params={
        "StudyInstanceUID": studyInstanceUID,
        "SeriesInstanceUID": seriesInstanceUID,
    })


@app.route("/dicomweb/<datastore_id>/instances", methods=["GET", "OPTIONS"])
def search_for_instances(**_):
    return _qido_response(level="INSTANCE")


# ── WADO retrieve endpoints ──────────────────────────────────────────────────
# Every WADO handler resolves its query + scope value through _wado_scope():
# when g.identity.virtual_folder_id is set the request targets a virtual folder,
# which spans datastores, so the datastore-equality query would match nothing.
# _wado_scope() returns the VF-scoped variant of the query bound to the vf id
# instead of the datastore-scoped one bound to the (empty) datastore id.


def _wado_scope(datastore_query, vf_query):
    """Return (query, scope_value) for the active request.

    VF request (identity.virtual_folder_id set): the VF-scoped variant, bound to
    the vf id. Datastore request: the datastore-scoped query, bound to the
    datastore id. This is tenancy, so it is REPLACE not add: a VF request never
    keeps the empty datastore_id scope, and a request carrying neither a real
    datastore id nor a vf id yields a scope value of '' that matches no row —
    never all rows — because both query families lead with an equality/membership
    predicate on that single bound value.
    """
    vf_id = getattr(g.identity, 'virtual_folder_id', None)
    if vf_id:
        return vf_query, vf_id
    return datastore_query, g.identity.datastore_id


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>', methods=['GET', 'OPTIONS'])
def retrieve_study(StudyInstanceUID: str, **_):
    query, scope = _wado_scope(sql_queries.WADO_LOC_BY_STUDY,
                               sql_queries.WADO_LOC_BY_STUDY_VF)
    return _retrieve_dicom_bulk(query, scope, StudyInstanceUID)


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>',
           methods=['GET', 'OPTIONS'])
def retrieve_series(SeriesInstanceUID: str, **_):
    query, scope = _wado_scope(sql_queries.WADO_LOC_BY_SERIES,
                               sql_queries.WADO_LOC_BY_SERIES_VF)
    return _retrieve_dicom_bulk(query, scope, SeriesInstanceUID)


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/instances/<InstanceUID>',
           methods=['GET', 'OPTIONS'])
def retrieve_instance(InstanceUID: str, **_):
    query, scope = _wado_scope(sql_queries.WADO_LOC_BY_INSTANCE,
                               sql_queries.WADO_LOC_BY_INSTANCE_VF)
    return _retrieve_dicom_bulk(query, scope, InstanceUID)


# ── Study download (.zip) ────────────────────────────────────────────────────
# The download is the WADO study retrieve repackaged: the SAME location queries
# (so the same tenancy scope) and, for a virtual folder, the SAME per-object
# de-identification (_deid_part10_chunks) as GET /studies/{uid}. canRead AND
# canDownload are both enforced by the auth middleware before this runs.
_DOWNLOAD_DETAIL = 'DICOMweb Study Downloaded'
_SAFE_NAME_RE = re.compile(r'[^0-9A-Za-z._-]')


@app.route('/dicomweb/<datastore_id>/download-access', methods=['GET', 'OPTIONS'])
def download_access(**_):
    """Whether the caller may download from this storage/folder.

    The data-user site calls this to decide whether to offer Download. It is
    advice for the UI only: the download route enforces the privilege itself.
    Carries no PHI, so it is not audited (a denial at the read gate still is).
    """
    return Response(json.dumps({'canDownload': bool(g.identity.can_download)}),
                    status=200, mimetype='application/json',
                    headers={'Cache-Control': 'no-store'})


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/download', methods=['GET', 'OPTIONS'])
def download_study(StudyInstanceUID: str, **_):
    # The middleware already refused a caller without canDownload; this guards
    # the identities that never get a download decision (DIMSE service token,
    # unauthenticated / debug modes), which all carry can_download=False.
    if not getattr(g.identity, 'can_download', False):
        return _refuse(403, "Download not permitted", audit_events.ACTION_DOWNLOAD,
                       _DOWNLOAD_DETAIL)
    query, scope = _wado_scope(sql_queries.WADO_LOC_BY_STUDY,
                               sql_queries.WADO_LOC_BY_STUDY_VF)
    return _download_study_zip(query, scope, StudyInstanceUID)


class _ZipStreamSink:
    """Write-only, non-seekable file object that zipfile writes into; the
    response generator drains it after every write. zipfile detects the
    missing seek() and writes a data descriptor after each member instead of
    patching its local header, which is what makes a streamed zip possible."""

    def __init__(self):
        self._parts = []
        self._pos = 0

    def write(self, data):
        data = bytes(data)
        self._parts.append(data)
        self._pos += len(data)
        return len(data)

    def tell(self):
        return self._pos

    def flush(self):
        pass

    def drain(self):
        parts, self._parts = self._parts, []
        return parts


class DownloadTooLarge(Exception):
    """The archive grew past DOWNLOAD_MAX_BYTES mid-stream."""


def _download_study_zip(query: str, scope: str, study_uid: str) -> Response:
    action = audit_events.ACTION_DOWNLOAD
    rows = _execute_query(query, (scope, study_uid))
    if not rows:
        return _refuse(404, "Not Found", action, _DOWNLOAD_DETAIL)

    # Same exclusions and pre-checks as the bulk retrieve, for the same reasons:
    # a virtualized WSI level has no Part 10 object, and the status is committed
    # with the first byte, so an archived member must refuse the whole request.
    skipped = sum(1 for row in rows if _is_virtualized_object(row))
    if skipped:
        rows = [row for row in rows if not _is_virtualized_object(row)]
        if not rows:
            return _refuse(404, "Not Found", action, _DOWNLOAD_DETAIL,
                           {'virtualizedSkipped': skipped})
    if len(rows) > DOWNLOAD_MAX_INSTANCES:
        return _refuse(413, f"Study has {len(rows)} instances; the download limit is "
                            f"{DOWNLOAD_MAX_INSTANCES}", action, _DOWNLOAD_DETAIL,
                       {'instanceCount': len(rows)})
    worst = availability.worst_availability(row.get('availability') for row in rows)
    blocked = availability.unavailable_response(worst)
    if blocked is not None:
        return _refuse_unavailable(blocked, worst, action, _DOWNLOAD_DETAIL,
                                   {'instanceCount': len(rows)})
    try:
        deid_ctx = _vf_deid_context()
    except VfDeidUnavailable as exc:
        return _refuse(503, f"De-identification unavailable: {exc}", action, _DOWNLOAD_DETAIL)
    deid_on = _vf_deid_active(deid_ctx)

    vf_id = getattr(g.identity, 'virtual_folder_id', None)
    datastore_id = g.identity.datastore_id
    resource_type, resource_id, uids = _uid_scope()
    audit_ctx = _audit_context()
    folder = _SAFE_NAME_RE.sub('_', study_uid)[:64] or 'study'
    # Members are named by position, never by their stored UIDs: in a virtual
    # folder those may be the source (identified) UIDs.
    force_zip64 = DOWNLOAD_MAX_BYTES >= 0xFFFFFFFF

    def stream():
        sink = _ZipStreamSink()
        served = 0
        failure = None
        try:
            zf = zipfile.ZipFile(sink, 'w', compression=zipfile.ZIP_STORED, allowZip64=True)
            for n, row in enumerate(rows, 1):
                chunks = (_deid_part10_chunks(row, deid_ctx) if deid_on
                          else _s3_get(row['bucketname'], row['s3key'],
                                       byte_range=_member_range(row))['Body']
                          .iter_chunks(chunk_size=STREAM_CHUNK_SIZE))
                with zf.open(f"{folder}/IM{n:05d}.dcm", 'w', force_zip64=force_zip64) as member:
                    for chunk in chunks:
                        served += len(chunk)
                        if served > DOWNLOAD_MAX_BYTES:
                            raise DownloadTooLarge(
                                f"study exceeds the {DOWNLOAD_MAX_BYTES}-byte download limit")
                        member.write(chunk)
                        yield from sink.drain()
                yield from sink.drain()
            zf.close()
            yield from sink.drain()
        except Exception as exc:      # noqa: BLE001 - re-raised immediately
            # As in the bulk retrieve: the 200 is already out, so abort the
            # body (no central directory = the client cannot open a short zip)
            # and audit the failure.
            failure = exc
            logger.error("study download truncated after %d bytes: %s", served, exc)
            raise
        finally:
            values = {'datastoreId': datastore_id, **uids,
                      'instanceCount': len(rows), 'bytesServed': served,
                      'truncated': failure is not None,
                      'deidentified': bool(deid_on)}
            if vf_id:
                values['virtualFolderId'] = vf_id
            if skipped:
                values['virtualizedSkipped'] = skipped
            _emit_audit(action, _DOWNLOAD_DETAIL, resource_type, resource_id, values,
                        status='FAILURE' if failure is not None else 'SUCCESS',
                        error_message=str(failure) if failure is not None else None,
                        context=audit_ctx)

    return Response(
        status=200,
        response=stream(),
        content_type='application/zip',
        headers={'Content-Disposition': f'attachment; filename="{folder}.zip"',
                 'Cache-Control': 'no-store'},
    )

# ── WADO metadata endpoints ──────────────────────────────────────────────────
@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/metadata', methods=['GET', 'OPTIONS'])
def retrieve_study_metadata(StudyInstanceUID: str, **_):
    query, scope = _wado_scope(sql_queries.WADO_METADATA_STUDY,
                               sql_queries.WADO_METADATA_STUDY_VF)
    return _retrieve_metadata(query, scope, StudyInstanceUID)


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/metadata',
           methods=['GET', 'OPTIONS'])
def retrieve_series_metadata(SeriesInstanceUID: str, **_):
    query, scope = _wado_scope(sql_queries.WADO_METADATA_SERIES,
                               sql_queries.WADO_METADATA_SERIES_VF)
    return _retrieve_metadata(query, scope, SeriesInstanceUID)


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/instances/<InstanceUID>/metadata',
           methods=['GET', 'OPTIONS'])
def retrieve_instance_metadata(InstanceUID: str, **_):
    query, scope = _wado_scope(sql_queries.WADO_METADATA_INSTANCE,
                               sql_queries.WADO_METADATA_INSTANCE_VF)
    return _retrieve_metadata(query, scope, InstanceUID)


# ── WADO frame endpoint ──────────────────────────────────────────────────────
@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/instances/<InstanceUID>/frames/<Frames>',
           methods=['GET', 'OPTIONS'])
def retrieve_frames(InstanceUID: str, Frames: str, **_):
    datastore_id = g.identity.datastore_id
    loc_query, loc_scope = _wado_scope(sql_queries.WADO_INSTANCE_LOC,
                                       sql_queries.WADO_INSTANCE_LOC_VF)
    try:
        frame_list = [int(f) for f in Frames.split(",") if f]
    except ValueError:
        return _refuse(400, "Invalid frame numbers",
                       audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved')
    if not frame_list:
        return _refuse(400, "No frames requested",
                       audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved')
    frame_list = list(dict.fromkeys(frame_list))          # Security: dedupe, keep order
    if len(frame_list) > FRAMES_MAX_PER_REQUEST:
        return _refuse(400, f"At most {FRAMES_MAX_PER_REQUEST} frames per request",
                       audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved')

    row = _fetch_instance_loc_cached(loc_query, loc_scope, InstanceUID)
    if row is None:
        return _refuse(404, "Not Found",
                       audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved')

    blocked = availability.unavailable_response(row.get('availability'))
    if blocked is not None:
        return _refuse_unavailable(blocked, row.get('availability'),
                                   audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved',
                                   {'frames': frame_list})

    # Bound the frame numbers here, before any S3 read. Left to the fetch tiers,
    # an out-of-range frame falls through both ranged-GET paths into
    # _read_full_frame, which downloads the entire object — up to a multi-GB
    # virtualized slide — into task memory and only then fails, after the 200 and
    # the Content-Type are already committed. /rendered guards the same way.
    n_frames = int(row.get('number_of_frames') or 1)
    if any(f < 1 or f > n_frames for f in frame_list):
        return _refuse(404, "Frame out of range",
                       audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved',
                       {'frames': frame_list})

    accepted_ts = _parse_accept_transfer_syntaxes(request.headers.get('Accept', ''))
    body = _build_frames_multipart(row, frame_list, accepted_ts)
    boundary = body['boundary']

    audit_values = {'datastoreId': datastore_id, 'sopUID': InstanceUID,
                    'frames': frame_list, 'transferSyntax': body['return_ts']}
    _emit_audit(audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved',
                'instance', InstanceUID, audit_values)

    audit_ctx = _audit_context()

    def guarded():
        """Turn a mid-stream failure into a visibly broken transfer.

        The 200 above cannot be recalled, so re-raising is the only way to deny the
        client a well-formed-looking multipart body: it aborts the chunked
        response with no closing boundary. The audit row emitted above already
        claims a read, so a second FAILURE row records that it was truncated.
        """
        try:
            yield from body['stream']()
        except Exception as exc:      # noqa: BLE001 - re-raised immediately
            logger.error("frames retrieve truncated for instance: %s", exc)
            _emit_audit(audit_events.ACTION_FRAMES, 'DICOMweb Frames Retrieved',
                        'instance', InstanceUID, {**audit_values, 'truncated': True},
                        status='FAILURE', error_message=str(exc), context=audit_ctx)
            raise

    return Response(
        status=200,
        response=guarded(),
        content_type=f'multipart/related; type="application/octet-stream"; boundary="{boundary}"',
    )


# ── WADO-RS Rendered (PS3.18 §10.4) ──────────────────────────────────────────
# Study/series-level rendering (one image per instance across a whole study or
# series) is intentionally not implemented — it is unbounded on large studies
# and rarely useful. Instance and frames rendering are supported.
@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/rendered', methods=['GET', 'OPTIONS'])
@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/rendered',
           methods=['GET', 'OPTIONS'])
def rendered_study_series_not_implemented(**_):
    return _refuse(501,
                   "Study/series-level rendering not implemented; "
                   "render a specific instance or frame",
                   audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved')


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/instances/<InstanceUID>/rendered',
           methods=['GET', 'OPTIONS'])
def retrieve_instance_rendered(InstanceUID: str, **_):
    """Rendered Instance: render the instance's representative frame (frame 1).

    Frame 1 for every instance, WSI included — the spec's route table says "frame 1
    implied" and makes no exception, and for a WSI pyramid level frame 1 is the
    first tile of the TILED_FULL grid. Compositing a whole gigapixel level instead
    would fetch and decode thousands of tiles for one unparameterized GET, which is
    the same unboundedness that makes study/series rendering a 501 above. A client
    that wants a region of a level asks for it with `viewport`, which does
    composite (see _render_wsi_region).
    """
    return _render_response(g.identity.datastore_id, InstanceUID, frame_id=None)


@app.route('/dicomweb/<datastore_id>/studies/<StudyInstanceUID>/series/<SeriesInstanceUID>/instances/<InstanceUID>/frames/<Frames>/rendered',
           methods=['GET', 'OPTIONS'])
def retrieve_frames_rendered(InstanceUID: str, Frames: str, **_):
    """Rendered Frames: render one specific frame to an image."""
    try:
        frame_list = [int(f) for f in Frames.split(",") if f]
    except ValueError:
        return _refuse(400, "Invalid frame numbers",
                       audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved')
    if len(frame_list) != 1:
        # Rendering multiple frames into one image is not supported; a client
        # wanting several rendered frames should request them individually.
        return _refuse(400, "Rendered frames supports exactly one frame per request",
                       audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved')
    return _render_response(g.identity.datastore_id, InstanceUID, frame_id=frame_list[0])


# ── Bulk data ────────────────────────────────────────────────────────────────
def _find_element(ds, group, element):
    """Locate (group,element) at the top level OR nested in any sequence.

    /bulk/element addresses a tag by number only, but the tag can live inside a
    sequence — notably the WSI ICC profile (0028,2000) nested in
    OpticalPathSequence (0048,0105)[n]. A top-level ds[(g,e)] misses it, so fall
    back to a depth-first walk of every sequence item. Returns the first match's
    DataElement, or None.
    """
    try:
        return ds[(group, element)]
    except KeyError:
        pass
    for elem in ds.iterall():
        if elem.tag.group == group and elem.tag.element == element:
            return elem
    return None


# There is deliberately no /bulk/<bucket>/<path:key> route. The reference had
# one, and it read any bucket and any key with the task role, unscoped by
# datastore. Nothing in this pipeline emits it: the ingest Lambdas write only the
# two datastore-scoped shapes below into stored metadata.
@app.route('/dicomweb/<datastore_id>/bulk/element/<sop_uid>/<tag_hex>', methods=['GET', 'OPTIONS'])
def retrieve_bulk_element(sop_uid: str, tag_hex: str, **_):
    """Resolve a stripped DICOM element back to its raw value bytes.

    Ingest replaces large element values with a BulkDataURI of this shape so the
    inline metadata blob stays small. We re-fetch the header from S3 on demand
    and return the requested element's value as application/octet-stream.
    """
    datastore_id = g.identity.datastore_id
    loc_query, loc_scope = _wado_scope(sql_queries.WADO_INSTANCE_LOC,
                                       sql_queries.WADO_INSTANCE_LOC_VF)
    audit_values = {'datastoreId': datastore_id, 'sopUID': sop_uid,
                    'tag': tag_hex, 'kind': 'element'}

    if len(tag_hex) != 8:
        return _refuse(400, "Invalid tag", audit_events.ACTION_BULKDATA,
                       'DICOMweb BulkData Retrieved', audit_values)
    try:
        group = int(tag_hex[:4], 16)
        element = int(tag_hex[4:], 16)
    except ValueError:
        return _refuse(400, "Invalid tag", audit_events.ACTION_BULKDATA,
                       'DICOMweb BulkData Retrieved', audit_values)

    try:
        deid_ctx = _vf_deid_context()
    except VfDeidUnavailable as exc:
        return _refuse(503, f"De-identification unavailable: {exc}",
                       audit_events.ACTION_BULKDATA, 'DICOMweb BulkData Retrieved', audit_values)

    row = _fetch_instance_loc_cached(loc_query, loc_scope, sop_uid)
    if row is None:
        return _refuse(404, "Not Found", audit_events.ACTION_BULKDATA,
                       'DICOMweb BulkData Retrieved', audit_values)

    blocked = availability.unavailable_response(row.get('availability'))
    if blocked is not None:
        return _refuse_unavailable(blocked, row.get('availability'),
                                   audit_events.ACTION_BULKDATA,
                                   'DICOMweb BulkData Retrieved', audit_values)

    # The real hazard here is an UNBOUNDED full-fetch of a multi-GB slide. A
    # SVS-VIRTUALIZED WSI level writes metadataendoffset = 0 (there is no real
    # DICOM header — the object is a TIFF pyramid), so the falsy branch below
    # would _read_instance_object() the whole multi-GB file to answer an element
    # lookup. Its one bulk element (the ICC profile) is served by /bulk/icc from
    # a stored TIFF byte range instead, so refuse the /bulk/element route for it
    # rather than OOM the task.
    #
    # A NATIVE DICOM WSI, by contrast, has a real header and a populated
    # metadataendoffset: its ICC profile (0028,2000) and other large elements are
    # genuine DICOM elements bulk-stripped to a /bulk/element BulkDataURI, so the
    # bounded header range-read below serves them safely. Gate the refusal on a
    # FALSY offset (the unbounded path) — not on WSI SOP class — so native WSI is
    # no longer blanket-404'd.
    end_offset = row.get('metadataendoffset')
    if not end_offset and _is_wsi(None, row):
        return _refuse(404, "Element not found", audit_events.ACTION_BULKDATA,
                       'DICOMweb BulkData Retrieved', audit_values)

    # A NULL offset means ingest never located the PixelData tag, so there is no
    # header length to trust. Read the whole instance rather than guessing a
    # window: a short guess silently truncates the very elements this endpoint
    # exists to serve (they're bulk-referenced precisely because they're large).
    #
    # metadataendoffset is absolute within the object, so the header runs from the
    # instance's start — byte 0 normally, the member's start inside a tar.
    if end_offset:
        start = int(row.get('member_offset') or 0)
        s3_obj = _s3_get(row['bucketname'], row['s3key'],
                         byte_range=f"bytes={start}-{int(end_offset) - 1}")
        header_bytes = s3_obj['Body'].read()
    else:
        header_bytes = _read_instance_object(row)
    ds = pydicom.dcmread(BytesIO(header_bytes), stop_before_pixels=True, force=True)

    # Security: for a folder request the element is read from the
    # de-identified header (same engine as /metadata, every sequence depth), so
    # e.g. 00100010 returns the de-identified name or nothing at all.
    if _vf_deid_active(deid_ctx):
        action_index, drop_private, salt = deid_ctx
        vf_deid.apply_profile_to_dataset(ds, action_index, salt, drop_private)

    elem = _find_element(ds, group, element)
    if elem is None or (deid_ctx is not None and elem.value in (None, '', b'', [])):
        return _refuse(404, "Element not found", audit_events.ACTION_BULKDATA,
                       'DICOMweb BulkData Retrieved', audit_values)

    raw = elem.value
    if isinstance(raw, str):
        raw = raw.encode('utf-8')
    elif not isinstance(raw, (bytes, bytearray)):
        raw = str(raw).encode('utf-8')

    _emit_audit(audit_events.ACTION_BULKDATA, 'DICOMweb BulkData Retrieved',
                'instance', sop_uid, {**audit_values, 'bytesServed': len(raw)}, always=True)
    return Response(status=200, response=raw, content_type="application/octet-stream")


@app.route('/dicomweb/<datastore_id>/bulk/icc/<sop_uid>', methods=['GET', 'OPTIONS'])
def retrieve_icc_profile(sop_uid: str, **_):
    """Serve a virtualized WSI instance's ICC color profile.

    SVS ingest stores the ICC profile's byte range (TIFF tag 34675) and emits a
    BulkDataURI of this shape on OpticalPathSequence[0].ICCProfile. The microscopy
    viewer fetches it here for color-managed rendering; we range-read it straight
    from the S3 object. 404 when the instance has no stored profile.
    """
    datastore_id = g.identity.datastore_id
    loc_query, loc_scope = _wado_scope(sql_queries.WADO_INSTANCE_LOC,
                                       sql_queries.WADO_INSTANCE_LOC_VF)
    audit_values = {'datastoreId': datastore_id, 'sopUID': sop_uid, 'kind': 'icc'}

    row = _fetch_instance_loc_cached(loc_query, loc_scope, sop_uid)
    if row is None:
        return _refuse(404, "Not Found", audit_events.ACTION_BULKDATA,
                       'DICOMweb BulkData Retrieved', audit_values)

    blocked = availability.unavailable_response(row.get('availability'))
    if blocked is not None:
        return _refuse_unavailable(blocked, row.get('availability'),
                                   audit_events.ACTION_BULKDATA,
                                   'DICOMweb BulkData Retrieved', audit_values)

    off = row.get('icc_profile_offset')
    length = row.get('icc_profile_length')
    if not length or off is None:
        return _refuse(404, "No ICC profile", audit_events.ACTION_BULKDATA,
                       'DICOMweb BulkData Retrieved', audit_values)
    data = _s3_get(
        row['bucketname'], row['s3key'],
        byte_range=f"bytes={int(off)}-{int(off) + int(length) - 1}",
    )['Body'].read()

    _emit_audit(audit_events.ACTION_BULKDATA, 'DICOMweb BulkData Retrieved',
                'instance', sop_uid, {**audit_values, 'bytesServed': len(data)})
    return Response(status=200, response=data, content_type="application/octet-stream")


# ── Audit plumbing ───────────────────────────────────────────────────────────
def _client_ip_provenance():
    """(caller IP, how it was chosen, the ALB-appended peer) for the audit trail.

    request.remote_addr is the load balancer's own private address, which would
    make every audit row identical and the trail useless.

    Counted from the right, not the left. Every element of X-Forwarded-For left of
    what our own infrastructure appended is client-supplied, so trusting the
    left-most one lets a caller stamp any address it likes on the audit record of
    its own PHI read. TRUSTED_PROXY_HOPS is how many hops append here (2 = the
    CloudFront distribution and the ALB behind it): the ALB appended the last
    element, CloudFront the one before it, and CloudFront's element is the viewer
    address it actually observed. A chain shorter than the hop count means the
    request did not come the expected way, so fall back to the nearest hop we can
    still vouch for.

    Length alone cannot prove the chain came through CloudFront: a caller that
    reaches the internal ALB directly and sends one bogus element produces a
    two-element chain of exactly the expected shape. What it cannot forge is the
    *last* element, which the ALB appends from the TCP peer. So the selection is
    recorded alongside the address — which element, out of how many, and the peer
    the ALB saw — and a bypass shows up afterwards as an audit row whose peer is
    not a CloudFront VPC-origin address.
    """
    forwarded = request.headers.get('X-Forwarded-For', '')
    hops = [h.strip() for h in forwarded.split(',') if h.strip()] if forwarded else []
    if not hops:
        return request.remote_addr, 'peer', request.remote_addr
    if len(hops) >= TRUSTED_PROXY_HOPS:
        return hops[-TRUSTED_PROXY_HOPS], f'xff[-{TRUSTED_PROXY_HOPS}]/{len(hops)}', hops[-1]
    return hops[0], f'xff[0]/{len(hops)}', hops[-1]


def _request_id():
    """Correlation id, so an audit row can be tied back to an access log line.

    Guarded: this is called from except branches whose whole contract is to
    swallow and return None. Reached outside a request context (a background
    call, a unit test, the interpreter), an unguarded `request` raises
    RuntimeError from werkzeug's proxy and destroys the exception being logged.
    """
    if not has_request_context():
        return None
    return request.headers.get('X-Amzn-Trace-Id') or request.headers.get('X-Request-Id')


def _datastore_id_from_path(path: str) -> str:
    """Datastore segment of a /dicomweb/{id}/... path, or ''.

    Only for the denial trail, where the hook raised before producing a validated
    identity. Never for a query.
    """
    parts = path.split('/')
    return parts[2] if len(parts) > 2 and parts[1] == 'dicomweb' else ''


def _action_for_path(path: str) -> str:
    """Audit action for a request that never reached its handler."""
    if request.method == 'DELETE':
        return audit_events.ACTION_DELETE
    if request.method == 'POST':      # STOW-RS is the only POST route
        return audit_events.ACTION_STORE
    if is_download_path(path):
        return audit_events.ACTION_DOWNLOAD
    if path.endswith('/rendered'):
        return audit_events.ACTION_RENDERED
    if path.endswith('/metadata'):
        return audit_events.ACTION_METADATA
    if '/bulk/' in path:
        return audit_events.ACTION_BULKDATA
    if '/frames/' in path:
        return audit_events.ACTION_FRAMES
    if path.endswith(('/studies', '/series', '/instances')):
        return audit_events.ACTION_QUERY
    if '/studies/' in path:
        return audit_events.ACTION_INSTANCE
    return audit_events.ACTION_QUERY


def _audit_context() -> dict:
    """Snapshot the request-scoped audit fields.

    Streaming handlers finish their body after the request context is gone, so
    the fields have to be captured while `request` and `g` are still bound.
    """
    identity = getattr(g, 'identity', None)
    ip_address, selection, peer = _client_ip_provenance()
    return {
        'user': identity.username if identity is not None else None,
        'datastore_id': (identity.datastore_id if identity is not None
                         else _datastore_id_from_path(request.path)),
        'api_endpoint': request.path,
        'http_method': request.method,
        'ip_address': ip_address,
        'request_id': _request_id(),
        # Not a kwarg of emit_data_plane_audit: _emit_audit moves these into
        # new_values, where they qualify the ip_address they explain.
        'client_address_provenance': {'selection': selection, 'peer': peer},
    }


def _emit_audit(action: str, detail_type: str, resource_type: str, resource_id: str,
                new_values: dict, status: str = 'SUCCESS',
                error_message: str = None, context: dict = None,
                refusal: bool = False, always: bool = False) -> None:
    ctx = dict(context if context is not None else _audit_context())
    provenance = ctx.pop('client_address_provenance', None)
    if provenance:
        # 'clientIp…', not 'clientAddress…': _scrub_new_values drops any key
        # containing 'address' as a suspected PHI carrier.
        new_values = {**(new_values or {}),
                      'clientIpSelection': provenance['selection'],
                      'clientIpPeer': provenance['peer']}
    audit_events.emit_data_plane_audit(
        action, detail_type, resource_type, resource_id,
        new_values=new_values, status=status, error_message=error_message,
        refusal=refusal, always=always, **ctx)


def _uid_scope():
    """(resource_type, resource_id, UID newValues) for the matched retrieve route.

    Read off request.view_args rather than passed down, so the shared
    retrieve/metadata helpers keep the signatures the spec pins.
    """
    args = request.view_args or {}
    uids = {}
    resource_type = 'datastore'
    resource_id = g.identity.datastore_id
    for key, level, field in (
        ('StudyInstanceUID', 'study', 'studyUID'),
        ('SeriesInstanceUID', 'series', 'seriesUID'),
        ('InstanceUID', 'instance', 'sopUID'),
        ('sop_uid', 'instance', 'sopUID'),
    ):
        value = args.get(key)
        if value:
            uids[field] = value
            resource_type, resource_id = level, value
    return resource_type, resource_id, uids


def _refuse(status: int, body: str, action: str, detail_type: str,
            new_values: dict = None) -> Response:
    """A text/plain error for a data-plane route, audited as a FAILURE.

    Every data-plane request emits exactly one audit event, including the ones
    that serve no bytes: "the client asked for an instance that is not there" is
    exactly what an access review needs to see.
    """
    resource_type, resource_id, uids = _uid_scope()
    values = {'datastoreId': g.identity.datastore_id, **uids}
    if new_values:
        values.update(new_values)
    _emit_audit(action, detail_type, resource_type, resource_id, values,
                status='FAILURE', error_message=body)
    return Response(status=status, response=body, content_type="text/plain")


def _refuse_unavailable(blocked: Response, availability_value, action: str,
                        detail_type: str, new_values: dict = None) -> Response:
    """Audit an availability refusal as a SUCCESS and return the prepared 503.

    The access decision succeeded — the object is simply not ranged-GET reachable
    right now — so recording a FAILURE here would pollute the denial trail that
    actually matters.
    """
    resource_type, resource_id, uids = _uid_scope()
    values = {'datastoreId': g.identity.datastore_id, **uids,
              'availability': availability_value}
    if new_values:
        values.update(new_values)
    _emit_audit(action, detail_type, resource_type, resource_id, values, refusal=True)
    return blocked


# ── QIDO core ────────────────────────────────────────────────────────────────
def _qido_response(level: str, path_params: dict = None) -> Response:
    datastore_id = g.identity.datastore_id
    virtual_folder_id = getattr(g.identity, 'virtual_folder_id', None)
    include_private = bool(g.identity.include_private_tags)

    try:
        parameters = _process_parameters(level=level)
    except UnsupportedFilterError as exc:
        # Reached only for a DICOM attribute this level cannot filter on; a
        # non-attribute parameter is ignored instead (see is_search_key).
        # Only the key is echoed, never the value: a filter value is PHI and the
        # response body is not a PHI-safe channel for it either.
        return _refuse(400, f"Unsupported search key: {exc.key}",
                       audit_events.ACTION_QUERY, 'DICOMweb Query',
                       {'level': level, 'rejectedParameter': exc.key})
    if path_params:
        parameters.update(path_params)

    cache_key = _qido_cache_key(datastore_id, virtual_folder_id, include_private,
                               level, parameters, request.query_string)
    payload = qido_cache.get(cache_key) if QIDO_CACHE_ENABLED else None
    if payload is None:
        query, qparams = _construct_query(parameters, datastore_id, include_private,
                                          virtual_folder_id=virtual_folder_id)
        db_results = _execute_query(query, qparams)
        payload = _convert_to_json(db_results, parameters, include_private)
        # NOTE: no post-hoc VF de-id overlay here. _construct_query's VF branch
        # reads the folder's OWN de-id tree `vf_<id>` directly, so the payload is
        # ALREADY de-identified and self-consistent (the filter bound against the
        # same de-id'd columns it returns).
        if QIDO_CACHE_ENABLED:
            qido_cache[cache_key] = payload

    _emit_audit(
        audit_events.ACTION_QUERY, 'DICOMweb Query',
        _QIDO_RESOURCE_TYPES[level], virtual_folder_id or datastore_id,
        {
            'datastoreId': datastore_id,
            'virtualFolderId': virtual_folder_id,
            'level': level,
            'resultCount': len(payload),
            'limit': parameters['limit'],
            'offset': parameters['offset'],
            # Filter KEYS only. A filter value is PHI — patient name, accession
            # number, birth date — and this event lands in a non-PHI log store.
            'filterKeys': sorted(parameters['wherefields'].keys()),
            'ignoredParameters': sorted(parameters['ignoredParams']),
        },
    )
    return _json_response(payload, ignored_params=parameters['ignoredParams'])


def _qido_cache_key(datastore_id: str, virtual_folder_id, include_private: bool,
                    level: str, parameters: dict, query_string: bytes) -> str:
    # datastore_id / virtual_folder_id lead because they are the tenancy
    # boundary — a VF request and a datastore request must never share a cache
    # entry even if their query strings match. include_private is a separate
    # namespace because the privileged payload carries the (7777,…) S3 location
    # block and must never be served to an unprivileged caller.
    return (f"{datastore_id}|{virtual_folder_id or ''}|{int(include_private)}|{level}|"
            f"{parameters.get('StudyInstanceUID', '')}|"
            f"{parameters.get('SeriesInstanceUID', '')}|"
            f"{query_string.decode('utf-8', 'replace')}")


def _json_response(payload, ignored_params=None) -> Response:
    response = Response(
        status=200,
        response=json.dumps(payload),
        mimetype="application/dicom+json",
        content_type="application/dicom+json",
    )
    if ignored_params:
        # PS3.18 §8.3.4.4: an origin server that ignores part of the query says so
        # here, so a client can tell "you filtered on that" from "you did not".
        response.headers['Warning'] = (
            '299 dicomweb-s3: query parameters ignored: '
            + ', '.join(_header_token(p) for p in sorted(ignored_params)[:16])
        )
    return response


# Parameter names are client-supplied, and this one goes into a response *header*,
# where a CR or LF would end the header and let the caller inject its own.
_HEADER_TOKEN_SAFE = frozenset(
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-')


def _header_token(value: str) -> str:
    return ''.join(c if c in _HEADER_TOKEN_SAFE else '?' for c in value[:64])


def _execute_query(query: str, query_parameters):
    # The SQL text is logged but the parameters are not: they include QIDO filter
    # values (patient name, accession number, birth date), and CloudWatch Logs is
    # not a PHI store. The placeholder count is enough to debug a shape mismatch.
    logger.debug("SQL: %s | %d params", query, len(query_parameters or ()))
    sql_conn = mysqlConnectionFactory.connection_with_rotation_retry()
    try:
        # The pool sets cursorclass=DictCursor, so every row reads by column name.
        cursor = sql_conn.cursor()
        try:
            cursor.execute(query, query_parameters)
            return cursor.fetchall()
        finally:
            cursor.close()
    finally:
        sql_conn.close()  # returns the connection to the pool


def _fetch_one(query: str, params):
    sql_conn = mysqlConnectionFactory.connection_with_rotation_retry()
    try:
        cursor = sql_conn.cursor()
        try:
            cursor.execute(query, params)
            return cursor.fetchone()
        finally:
            cursor.close()
    finally:
        sql_conn.close()


def _fetch_instance_loc_cached(query: str, scope: str, sop_uid: str):
    """Per-instance frame-location lookup with a short-TTL in-process cache.

    The frame endpoint runs WADO_INSTANCE_LOC on EVERY frame request; a WSI
    viewer panning one slide fires hundreds of tile requests for ONE instance,
    each re-querying identical immutable location/offset metadata. The row is
    immutable for the life of the instance, so a short TTL (FRAME_LOC_CACHE_TTL,
    default 45s) safely amortizes the DB round-trip while bounding staleness
    after a delete/re-ingest.

    The cache key is (scope, sop_uid). `scope` is the value _wado_scope bound —
    the datastore id for a datastore request, the VF id for a VF request — so a
    VF-scoped request can never read a datastore-scoped entry or vice-versa
    (same tenancy discipline the QIDO cache key follows). `query` need not be in
    the key: _wado_scope pairs each scope kind with its own query, so a given
    scope value always arrives with the same query.

    Returns the same row `_fetch_one` returns (a dict, or None on miss). A None
    (404) is NOT cached — a not-yet-ingested instance must appear immediately.
    """
    if not FRAME_LOC_CACHE_ENABLED:
        return _fetch_one(query, (scope, sop_uid))
    cache_key = (scope, sop_uid)
    with _frame_loc_cache_lock:
        cached = frame_loc_cache.get(cache_key)
    if cached is not None:
        return cached
    row = _fetch_one(query, (scope, sop_uid))
    if row is not None:
        with _frame_loc_cache_lock:
            frame_loc_cache[cache_key] = row
    return row



def _convert_to_json(db_results, params: dict, include_s3_location: bool):
    tag_dict = _result_tag_dict(params["queryLevel"])
    json_array = []
    for result in db_results:
        ds = Dataset()
        for tag, col_name in tag_dict.items():
            col = col_name.lower()
            if col not in result:
                continue
            value = result[col]
            if value is None or value == '':
                continue
            try:
                ds.add(DataElement(tag, pydicom.datadict.dictionary_VR(tag), _serialize_value(value)))
            except Exception as e:
                logger.debug("skip tag %s: %s", tag, e)

        for tag in params["includefield"]:
            if tag not in tag_dict:
                continue
            col = tag_dict[tag].lower()
            if col not in result:
                continue
            value = result[col]
            if value is None or value == '':
                continue
            try:
                ds.add(DataElement(tag, pydicom.datadict.dictionary_VR(tag), _serialize_value(value)))
            except Exception as e:
                logger.debug("skip includefield %s: %s", tag, e)

        entry = _normalize_qido_entry(ds.to_json_dict())
        _add_private_s3_location(entry, params["queryLevel"], result, include_s3_location)
        if not include_s3_location:
            filter_private_tags(entry)
        json_array.append(entry)
    return json_array


def _add_private_s3_location(entry: dict, level: str, result: dict,
                             include_s3_location: bool) -> None:
    """Attach the backing S3 key/bucket as private DICOM elements.

    Only meaningful at instance level (one S3 object per row), and only for a
    caller holding the storage-location privilege — the key plus the bucket is
    enough to read the object directly and bypass this service's authorization.
    Emitted in a proper private block: (7777,0010) = Private Creator "DICOMWEBS3",
    then (7777,1001) = S3 key (LO) and (7777,1002) = bucket (LO). Injected
    straight into the JSON because pydicom's dictionary_VR lookup raises on
    private tags.

    `include_s3_location` has no default on purpose: True would reintroduce the
    leak at any call site that forgot it, False would silently break the admin
    view, and neither failure is loud.
    """
    if not include_s3_location:
        return
    if level not in _INSTANCE_LEVELS:
        return
    s3key = result.get('_s3key')
    if not s3key:
        return
    entry[PRIVATE_CREATOR_TAG] = {'vr': 'LO', 'Value': [PRIVATE_CREATOR]}
    entry[PRIVATE_S3KEY_TAG] = {'vr': 'LO', 'Value': [_serialize_value(s3key)]}
    s3bucket = result.get('_s3bucket')
    if s3bucket:
        entry[PRIVATE_S3BUCKET_TAG] = {'vr': 'LO', 'Value': [_serialize_value(s3bucket)]}


def _normalize_qido_entry(entry: dict) -> dict:
    """Ensure every element has a `Value` key (DICOMweb clients commonly assume this).

    pydicom emits {"vr": "..."} for empty elements; OHIF and others access .Value.length
    blindly. We force Value to be a list (empty if no data) for client compatibility.
    """
    for tag, payload in entry.items():
        if not isinstance(payload, dict):
            continue
        if 'Value' in payload or 'BulkDataURI' in payload or 'InlineBinary' in payload:
            continue
        payload['Value'] = []
    return entry


def filter_private_tags(entry: dict) -> dict:
    """Strip every 0x7777 element from an assembled QIDO entry.

    Last line of defence behind the SQL gate and the injector gate: a derived
    column that ever lands in the private group must not reach an unprivileged
    caller just because a new code path forgot the flag.
    """
    for tag in [t for t in entry if _is_private_s3_tag(t)]:
        del entry[tag]
    return entry


def _is_private_s3_tag(tag) -> bool:
    try:
        return int(str(tag)[:4], 16) == PRIVATE_GROUP
    except (ValueError, TypeError):
        return False


def _result_tag_dict(level: str) -> dict:
    return {
        "STUDY": studyTagsTofields,
        "SERIES": seriesTagsTofields,
        "INSTANCE": instanceTagsTofields,
        "STUDY.SERIES": seriesTagsTofields,
        "STUDY.INSTANCE": instanceTagsTofields,
        "STUDY.SERIES.INSTANCE": instanceTagsTofields,
    }[level]


def _filter_tag_dict(level: str) -> dict:
    return {
        "STUDY": SearchForstudiesTags,
        "SERIES": {**SearchForstudiesTags, **SearchForSeriesTags},
        "INSTANCE": _ParentSearchForInstancesTags,
        "STUDY.SERIES": SearchForSeriesTags,
        "STUDY.INSTANCE": _ParentSearchForInstancesTags,
        "STUDY.SERIES.INSTANCE": _ParentSearchForInstancesTags,
    }[level]


def _serialize_value(obj):
    if isinstance(obj, datetime.date):
        return obj.strftime('%Y%m%d')
    if isinstance(obj, datetime.timedelta):
        # MySQL TIME values come back as timedelta — render as HHMMSS.ffffff
        total = obj.total_seconds()
        h, rem = divmod(int(total), 3600)
        m, s = divmod(rem, 60)
        return f"{h:02d}{m:02d}{s:02d}.{obj.microseconds:06d}"
    if isinstance(obj, (bytes, bytearray)):
        # MySQL GROUP_CONCAT and similar can come back as bytes
        try:
            return obj.decode('utf-8', 'replace')
        except Exception:
            return str(obj)
    return obj


def _process_parameters(level: str) -> dict:
    """Parse the QIDO query string. Raises UnsupportedFilterError on a bad filter."""
    bypass_other_includefields = False
    returnfields = []
    wherefields = {}
    ignored = []
    query_offset = 0
    query_limit = 0

    filter_tags = _filter_tag_dict(level)

    for arg in request.args:
        # getlist, not get: PS3.18 §8.3.4 lets includefield repeat, and clients do
        # send `includefield=A&includefield=B`. request.args.get() returns only the
        # first, which silently dropped every field after it.
        arg_values = request.args.getlist(arg)
        arg_value = arg_values[0]
        # The four PS3.18 §8.3.4 parameters that are not search keys, matched
        # case-insensitively: the standard spells them lower case, but `?Limit=5`
        # is unambiguously this parameter and refusing it buys nothing. DICOM
        # keywords stay case-sensitive — that lookup uses `arg`, not `control`.
        control = arg.lower()
        if control == "includefield":
            for value in arg_values:
                if value == "all":
                    bypass_other_includefields = True
                    returnfields = ["*"]
                    break
                if not bypass_other_includefields:
                    returnfields.extend(v for v in value.split(",") if v)
        elif control == "fuzzymatching":
            pass
        elif control == "limit":
            try:
                query_limit = max(0, min(int(arg_value), QIDO_MAX_LIMIT))
            except (TypeError, ValueError):
                query_limit = 0
        elif control == "offset":
            try:
                query_offset = max(0, int(arg_value))
            except (TypeError, ValueError):
                query_offset = 0
        elif is_search_key(arg):
            # Raises for a DICOM attribute outside the level's allowlist. A dropped
            # filter widens the query, so the caller turns this into a 400 rather
            # than answering a one-patient question with the whole datastore.
            tag = filter_tag_for(filter_tags, arg)
            # Second gate, same reasoning as the first: being allowlisted is not
            # the same as being expressible in SQL at this level. Checked here,
            # inside the caller's try, because _construct_query runs outside it —
            # raising there would be a 500 instead of a 400.
            if not filter_is_mappable(level, tag, _result_tag_dict(level)):
                raise UnsupportedFilterError(arg)
            wherefields[tag] = arg_value
        else:
            # Not an attribute, so it cannot widen anything: ignored per PS3.18
            # §8.3.4 and reported back in a Warning header rather than refused.
            # Cache-busters and viewer/vendor extensions all land here.
            ignored.append(arg)

    if query_limit == 0:
        query_limit = QIDO_DEFAULT_LIMIT

    return {
        "queryLevel": level,
        "limit": query_limit,
        "offset": query_offset,
        "includefield": returnfields,
        "wherefields": wherefields,
        "ignoredParams": ignored,
    }


def _construct_query(params: dict, datastore_id: str, include_s3_location: bool,
                     virtual_folder_id: str = None):
    """Build a parameterized SELECT for the given QIDO level.

    SQL identifiers (table/column names) come exclusively from hard-coded
    `tables` / `*TagsTofields` dicts. User-supplied values flow only through
    the parameterized %s placeholders.

    Tenancy is the first predicate of every WHERE. For a datastore request that
    is `datastore_id = %s` on every level, with `datastore_id` the first bound
    param. For a virtual-folder request (`virtual_folder_id` set) the datastore
    predicate is REPLACED — never supplemented — by a VF-membership predicate on
    `instance.content_pkey`, and `virtual_folder_id` becomes the first bound
    param instead. A VF spans datastores, so no datastore equality survives in
    that path.

    TENANCY IS SECURITY. The VF predicate stands in for the datastore scope; it
    is never additive/optional. A request with neither a real datastore_id nor a
    virtual_folder_id is refused here rather than allowed to run an unscoped
    query that would return every tenant's rows.
    """
    level = params["queryLevel"]
    qparams = []
    where_extra = ""

    is_vf = bool(virtual_folder_id)
    # Neither scope means an unscoped query, which at datastore level is
    # `datastore_id = '' ` (matches nothing legitimate but is a latent all-rows
    # risk if an empty-string datastore ever existed) and at VF level would be a
    # membership test with no id. Refuse outright: a read with no tenancy is a
    # bug, and the safe direction is to serve nothing.
    if not is_vf and not datastore_id:
        raise ValueError("query has neither a datastore_id nor a virtual_folder_id scope")

    # Table identifiers. For a DATASTORE request these are the shared dicomarchive
    # tree (study/patient/series/instance). For a VF request they are the
    # folder's OWN de-id tree `vf_<id>`.`vf_<id>_study` etc. — the tables that
    # ALREADY store the de-identified, self-consistent values. Reading them
    # directly is what fixes the round-trip: a QIDO filter on patientid=<hash>
    # binds against the vf tree's hashed column (a match) instead of the shared
    # tree's original value (0 rows -> empty series list). The db + table names
    # are IDENTIFIERS (never bind params); they are built ONLY from the validated
    # derived name (vf_db_name -> _assert_vf_db, matched ^vf_[0-9a-f]{32}$) and
    # interpolated, so no client input reaches the SQL text.
    if is_vf:
        vf_db = sql_queries._assert_vf_db(sql_queries.vf_db_name(virtual_folder_id))
        study_table = f"`{vf_db}`.`{vf_db}_study`"
        patient_table = f"`{vf_db}`.`{vf_db}_patient`"
        series_table = f"`{vf_db}`.`{vf_db}_series`"
        instance_table = f"`{vf_db}`.`{vf_db}_instance`"
    else:
        study_table = tables["study_table"]
        patient_table = tables["patient_table"]
        series_table = tables["series_table"]
        instance_table = tables["instance_table"]

    # Pkey column names are IDENTICAL across the shared tree and the vf_<id>
    # tree (study_pkey/patient_pkey/series_pkey/instance_pkey), so these are the
    # same for both branches.
    study_pkey = table_unique_keys["study_table"]
    patient_pkey = table_unique_keys["patient_table"]
    series_pkey = table_unique_keys["series_table"]
    instance_pkey = table_unique_keys["instance_table"]

    # UID columns. The vf_<id> tree carries `studyinstanceuid`/`seriesinstanceuid`
    # (the de-id'd values; identical to the originals in v1) just like the shared
    # tree, so the same tag->column mapping resolves on both.
    study_uid_col = studyTagsTofields["0020000D"]
    series_uid_col = seriesTagsTofields["0020000E"]

    # NOTE: earlier revisions enumerated VF content from the SHARED dicomarchive tree
    # and gated it with a `content_pkey IN (SELECT ... virtual_folder_assignments
    # WHERE virtual_folder_id = %s)` membership predicate (plus a study/series
    # EXISTS walk). That is gone: the VF branch now reads the folder's OWN
    # de-id tree `vf_<id>` directly, and that tree already contains exactly the
    # assigned, de-identified rows — the database IS the membership scope. This
    # is what fixes the round-trip: a QIDO filter (e.g. patientid=<hash>) binds
    # against the vf tree's de-id'd column and MATCHES, instead of running against
    # the shared tree's original value and returning 0 rows (the empty series
    # list). WADO keeps the shared-tree + virtual_folder_assignments membership
    # path (sql_queries.WADO_*_VF) — it resolves content_pkey against the shared
    # storage_index and is intentionally unchanged.

    # Derived (computed) columns — referenced from the *TagsTofields dicts via
    # underscore-prefixed names. Defined here once so every level that returns
    # study/series rows can include them with a consistent schema.
    #
    # DATASTORE branch: computed on the fly from the shared tree with COUNT
    # subqueries, filtering `deleted_at IS NULL` so soft-deleted rows don't
    # inflate the counts. VF branch: the vf_<id> tree has NO deleted_at and
    # ALREADY stores these aggregates (numberofstudyrelatedseries /
    # numberofstudyrelatedinstances / modalitiesinstudy on _study;
    # numberofseriesrelatedinstances on _series — the vf-deid-consumer settle
    # step maintains them), so we read the STORED columns and skip the
    # subqueries. Same read-time aliases either way.
    if is_vf:
        derived_study = (
            f"{study_table}.numberofstudyrelatedseries AS _numstudyseries, "
            f"{study_table}.numberofstudyrelatedinstances AS _numstudyinstances, "
            f"{study_table}.modalitiesinstudy AS _modalitiesinstudy"
        )
        derived_series = (
            f"{series_table}.numberofseriesrelatedinstances AS _seriesinstances"
        )
        # The vf_<id> tree stores no availability. VF content is de-id'd and
        # served through WADO; QIDO reports it ONLINE (nothing is tiered here).
        derived_study_availability = "'ONLINE' AS _availability"
    else:
        # Read the STORED study/series aggregates instead of recomputing them
        # with correlated subqueries. The ingest aggregate recompute maintains
        # study.numberofstudyrelatedseries / numberofstudyrelatedinstances /
        # modalitiesinstudy and series.numberofseriesrelatedinstances (same
        # columns the VF branch reads). The former per-study COUNT(*) subqueries
        # — especially the instances count that JOINed the ~100M-row instance
        # table once PER RETURNED STUDY — made a bare /studies (up to
        # QIDO_DEFAULT_LIMIT rows) run ~limit×3 correlated subqueries against the
        # hot instance table and hang under load. Reading the stored columns is a
        # plain scan of the (indexed, ≤limit) study rows. Availability has no
        # stored study column, so its best-state-wins rollup stays a subquery
        # (it touches only `series`, not `instance`, so it is cheap).
        derived_study = (
            f"{study_table}.numberofstudyrelatedseries AS _numstudyseries, "
            f"{study_table}.numberofstudyrelatedinstances AS _numstudyinstances, "
            f"{study_table}.modalitiesinstudy AS _modalitiesinstudy"
        )
        derived_series = (
            f"{series_table}.numberofseriesrelatedinstances AS _seriesinstances"
        )
        # Study-level availability rollup. There is no study.availability column
        # and Phase 2 adds no DDL, so the writer's best-state-wins series rule —
        # ONLINE beats NEARLINE beats OFFLINE, a study is reachable if any of it
        # is — is recomputed here. A study with no live series rolls up to
        # OFFLINE, which is what keeps a sidecar-first pending study discoverable.
        # Touches only `series` (indexed by study_pkey), never `instance`.
        derived_study_availability = (
            f"(SELECT CASE "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
            f"    WHEN COALESCE(SUM(sa.availability IS NULL OR sa.availability = 'ONLINE'), 0) > 0 THEN 'ONLINE' "
            f"    WHEN COALESCE(SUM(sa.availability = 'NEARLINE'), 0) > 0 THEN 'NEARLINE' "
            f"    ELSE 'OFFLINE' "
            f"  END "
            f" FROM {series_table} sa "
            f" WHERE sa.{study_pkey} = {study_table}.{study_pkey} "
            f"   AND sa.deleted_at IS NULL) AS _availability"
        )

    # The private S3 location columns are selected only for a caller holding the
    # storage-location privilege. Defense in depth: a column that never leaves
    # the database cannot be leaked by a bug in the injector.
    if include_s3_location:
        private_select = ", il.s3_bucket_name AS _s3bucket, il.s3_key AS _s3key"
        # The join rides instance.content_pkey -> storage_index.content_pkey (the
        # S3-only physical-object link that replaced Instancelocation).
        # storage_index STAYS in the shared database and is left UNqualified so
        # it resolves against the connection's default (shared) schema — true for
        # both a datastore request (instance already in the shared db) and a VF
        # request (vf_<id>_instance.content_pkey points across to the shared
        # storage_index).
        private_join = f"LEFT JOIN storage_index il ON il.content_pkey = {instance_table}.content_pkey AND il.deleted_at IS NULL "
    else:
        private_select = ""
        private_join = ""

    # Shared instance-level fragments. All three instance protos join series and
    # study for the parent UIDs and for liveness, and scope all three tables:
    # the redundant predicates let the optimizer use the composite unique keys
    # instead of scanning on a bare UID. For a VF request there is no
    # instanceavailability column on the vf_<id> tree — VF content is de-id'd and
    # served through WADO, so QIDO reports it ONLINE.
    if is_vf:
        avail_expr = "'ONLINE' AS _availability"
    else:
        avail_expr = f"COALESCE({instance_table}.instanceavailability, 'ONLINE') AS _availability"
    instance_select = (
        f"SELECT {instance_table}.*, "
        f"{avail_expr}, "
        f"{study_table}.{study_uid_col} AS _studyinstanceuid, "
        f"{series_table}.{series_uid_col} AS _seriesinstanceuid"
        f"{private_select} "
    )
    instance_from = (
        f"FROM {instance_table} "
        f"JOIN {series_table} ON {series_table}.{series_pkey} = {instance_table}.{series_pkey} "
        f"JOIN {study_table}  ON {study_table}.{study_pkey}   = {series_table}.{study_pkey} "
        f"{private_join}"
    )
    # Tenancy scope for the instance protos. For a VF request the vf_<id> tree IS
    # the membership, so no datastore equality. For a datastore request:
    #   - bare INSTANCE (no study/series UID filter) MUST scope on
    #     instance.datastore_id — it is the only selective predicate.
    #   - STUDY.INSTANCE / STUDY.SERIES.INSTANCE ALSO carry a study/series UID
    #     equality (appended after this scope). Scoping instance.datastore_id
    #     there let the planner drive from `instance` on datastore_id and scan
    #     every instance in the datastore (tens of millions) before applying the
    #     UID filter — the /instances hang. For those levels we scope datastore
    #     on study/series ONLY: (datastore_id, studyinstanceuid) hits uq_study_uid
    #     and (datastore_id, seriesinstanceuid) hits uq_series_uid, resolving the
    #     single parent first, then instances via idx_instance_series. So the
    #     number of datastore-scoped tables (and bound params) is level-dependent
    #     — `_instance_scope_ds_tables` tracks it so the qparams stay in sync.
    _uid_bearing = level in ("STUDY.INSTANCE", "STUDY.SERIES.INSTANCE")
    if is_vf:
        instance_scope = "WHERE 1=1 "
        _instance_scope_ds_tables = 0
    elif _uid_bearing:
        # No instance.datastore_id — force parent-first resolution via the UID.
        instance_scope = (
            f"WHERE {series_table}.datastore_id   = %s "
            f"  AND {study_table}.datastore_id    = %s "
        )
        _instance_scope_ds_tables = 2
    else:
        instance_scope = (
            f"WHERE {instance_table}.datastore_id = %s "
            f"  AND {series_table}.datastore_id   = %s "
            f"  AND {study_table}.datastore_id    = %s "
        )
        _instance_scope_ds_tables = 3
    # Soft-delete liveness. The vf_<id> tree has NO deleted_at column (a series is
    # removed by DELETE, not soft-delete — see vf-database.js renderTreeDDL), so
    # the VF branch emits no liveness predicate at all.
    if is_vf:
        instance_live = ""
    else:
        instance_live = (
            f"  AND {instance_table}.deleted_at IS NULL "
            f"  AND {series_table}.deleted_at   IS NULL "
            f"  AND {study_table}.deleted_at    IS NULL "
        )

    # Soft-delete: every joined level must filter `deleted_at IS NULL` so
    # rows the ingest Lambda has soft-deleted are invisible until the GC
    # sweep hard-deletes them. Built once per level so the WHERE clause
    # always covers exactly the tables this proto references.
    if level == "STUDY":
        # The patient join is scoped explicitly, exactly like the series/study
        # joins below. The FK alone is not the boundary: a patient row reached
        # through it is only this tenant's because `uq_patient_ds_id` is
        # (datastore_id, patientid), and this predicate is what keeps a
        # regression in the writer's dedup from turning a study-level QIDO
        # response into another tenant's PatientName, MRN and birth date.
        #
        # For a VF request there is no datastore to scope patient on; membership
        # is enforced by the study-level EXISTS walking down to an assigned
        # instance, and the patient row is pulled by the 1:1 FK from the study
        # that EXISTS already admitted — so no tenant's patient row can appear
        # for a study not in the VF.
        # For a VF request the vf_<id> tree IS the membership — only assigned,
        # de-id'd studies live in it — so there is NO membership EXISTS and NO
        # deleted_at (the vf tree has no such column). The patient row rides the
        # 1:1 FK inside the same vf_<id> database.
        if is_vf:
            proto = (
                f"SELECT {study_table}.*, {patient_table}.*, {derived_study}, {derived_study_availability} "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                f"FROM {study_table} "
                f"JOIN {patient_table} ON {study_table}.{patient_pkey} = {patient_table}.{patient_pkey} "
                f"WHERE 1=1 "
            )
        else:
            proto = (
                f"SELECT {study_table}.*, {patient_table}.*, {derived_study}, {derived_study_availability} "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                f"FROM {study_table} "
                f"JOIN {patient_table} ON {study_table}.{patient_pkey} = {patient_table}.{patient_pkey} "
                f"WHERE {study_table}.datastore_id   = %s "
                f"  AND {patient_table}.datastore_id = %s "
                f"  AND {study_table}.deleted_at IS NULL AND {patient_table}.deleted_at IS NULL "
            )
            qparams.extend([datastore_id, datastore_id])
        tag_dict = studyTagsTofields
    elif level == "STUDY.SERIES":
        if is_vf:
            proto = (
                f"SELECT {series_table}.*, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                f"'ONLINE' AS _availability, "
                f"{study_table}.{study_uid_col} AS _studyinstanceuid, {derived_series} "
                f"FROM {series_table} "
                f"JOIN {study_table} ON {study_table}.{study_pkey} = {series_table}.{study_pkey} "
                f"WHERE {study_table}.{study_uid_col} = %s "
            )
            qparams.append(params["StudyInstanceUID"])
        else:
            proto = (
                f"SELECT {series_table}.*, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                f"COALESCE({series_table}.availability, 'ONLINE') AS _availability, "
                f"{study_table}.{study_uid_col} AS _studyinstanceuid, {derived_series} "
                f"FROM {series_table} "
                f"JOIN {study_table} ON {study_table}.{study_pkey} = {series_table}.{study_pkey} "
                f"WHERE {series_table}.datastore_id = %s "
                f"  AND {study_table}.datastore_id  = %s "
                f"  AND {study_table}.{study_uid_col} = %s "
                f"  AND {series_table}.deleted_at IS NULL AND {study_table}.deleted_at IS NULL "
            )
            qparams.extend([datastore_id, datastore_id, params["StudyInstanceUID"]])
        tag_dict = seriesTagsTofields
    elif level == "SERIES":
        # `patient` is joined for one reason: SearchForSeries accepts PatientID and
        # PatientName, and without the join those filters have no column to bind to
        # and were silently dropped. The join is 1:1 on patient_pkey so it cannot
        # duplicate a series row, and its datastore_id predicate is not redundant —
        # it is the same tenancy guard the STUDY level carries, for the same reason.
        # No patient column reaches the response: the SELECT list is explicit.
        #
        # For a VF request the tenancy guard is the series-level EXISTS on VF
        # membership; the patient join stays for its filter columns and rides the
        # 1:1 FK, adding no rows.
        if is_vf:
            proto = (
                f"SELECT {series_table}.*, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                f"'ONLINE' AS _availability, "
                f"{study_table}.{study_uid_col} AS _studyinstanceuid, {derived_series} "
                f"FROM {series_table} "
                f"JOIN {study_table} ON {study_table}.{study_pkey} = {series_table}.{study_pkey} "
                f"JOIN {patient_table} ON {study_table}.{patient_pkey} = {patient_table}.{patient_pkey} "
                f"WHERE 1=1 "
            )
        else:
            proto = (
                f"SELECT {series_table}.*, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                f"COALESCE({series_table}.availability, 'ONLINE') AS _availability, "
                f"{study_table}.{study_uid_col} AS _studyinstanceuid, {derived_series} "
                f"FROM {series_table} "
                f"JOIN {study_table} ON {study_table}.{study_pkey} = {series_table}.{study_pkey} "
                f"JOIN {patient_table} ON {study_table}.{patient_pkey} = {patient_table}.{patient_pkey} "
                f"WHERE {series_table}.datastore_id = %s "
                f"  AND {study_table}.datastore_id  = %s "
                f"  AND {patient_table}.datastore_id = %s "
                f"  AND {series_table}.deleted_at IS NULL AND {study_table}.deleted_at IS NULL "
                f"  AND {patient_table}.deleted_at IS NULL "
            )
            qparams.extend([datastore_id, datastore_id, datastore_id])
        tag_dict = seriesTagsTofields
    elif level == "STUDY.SERIES.INSTANCE":
        proto = (
            instance_select + instance_from + instance_scope
            + f"  AND {study_table}.{study_uid_col} = %s "
            + f"  AND {series_table}.{series_uid_col} = %s "
            + instance_live
        )
        if not is_vf:
            qparams.extend([datastore_id] * _instance_scope_ds_tables)
        qparams.extend([params["StudyInstanceUID"], params["SeriesInstanceUID"]])
        tag_dict = instanceTagsTofields
    elif level == "STUDY.INSTANCE":
        proto = (
            instance_select + instance_from + instance_scope
            + f"  AND {study_table}.{study_uid_col} = %s "
            + instance_live
        )
        if not is_vf:
            qparams.extend([datastore_id] * _instance_scope_ds_tables)
        qparams.extend([params["StudyInstanceUID"]])
        tag_dict = instanceTagsTofields
    elif level == "INSTANCE":
        proto = instance_select + instance_from + instance_scope + instance_live
        if not is_vf:
            qparams.extend([datastore_id] * _instance_scope_ds_tables)
        tag_dict = instanceTagsTofields
    else:
        raise ValueError(f"Unsupported QIDO level: {level}")

    # Deterministic paging: ORDER BY the result table's auto-increment pkey
    # (unique + clustered index) so LIMIT/OFFSET pages have a stable order.
    # EXCEPTION: the UID-bearing instance levels (STUDY.INSTANCE /
    # STUDY.SERIES.INSTANCE) return ONE study/series' instances — at most a
    # single page in practice — so paging is moot AND `ORDER BY instance_pkey`
    # there misled the optimizer into walking the instance PRIMARY KEY (scanning
    # the shared, ~100M-row instance table dominated by other datastores) instead
    # of using idx_instance_series — the /instances hang. Drop the ORDER BY for
    # those two levels so the series index is the natural plan; DICOM clients sort
    # instances by InstanceNumber themselves. Bare INSTANCE keeps ordered paging.
    order_clause = {
        "STUDY":                 f" ORDER BY {study_table}.{study_pkey}",
        "SERIES":                f" ORDER BY {series_table}.{series_pkey}",
        "STUDY.SERIES":          f" ORDER BY {series_table}.{series_pkey}",
        "INSTANCE":              f" ORDER BY {instance_table}.{instance_pkey}",
        "STUDY.INSTANCE":        "",
        "STUDY.SERIES.INSTANCE": "",
    }[level]

    # Allowlisted column-based WHERE clause builder
    table_names = dict(study_table=study_table, series_table=series_table,
                       instance_table=instance_table, patient_table=patient_table)
    for tag, raw_value in params["wherefields"].items():
        # A tag whose value lives in a one-to-many child gets an EXISTS wrapper;
        # a tag whose mapping is a read-time alias gets its real qualified column.
        # MySQL rejects a select-list alias in WHERE either way.
        exists_tpl = _FILTER_EXISTS_SUBQUERIES.get((level, tag))
        override = _FILTER_COLUMN_OVERRIDES.get((level, tag))
        if exists_tpl is not None:
            column = exists_tpl["column"]
        elif override is not None:
            column = override.format(**table_names)
        elif tag in tag_dict and not tag_dict[tag].startswith("_"):
            column = tag_dict[tag]
        else:
            # Unreachable: filter_is_mappable() already refused this at parse time
            # with a 400. Kept as a hard stop because the alternative — emitting no
            # predicate — widens the query, and a raise is the safe direction.
            raise ValueError(f"unmappable filter {tag!r} at level {level}")

        # Build the comparison first, wrap second, so EXISTS inherits every
        # operator (=, IN, LIKE, BETWEEN) instead of only equality.
        if tag == "00080020" and "-" in raw_value:
            predicate = f"{column} BETWEEN %s AND %s"
            values = list(raw_value.split("-", 1))
        elif "*" in raw_value:
            predicate = f"{column} LIKE %s"
            values = [raw_value.replace("*", "%")]
        elif "," in raw_value:
            items = raw_value.split(",")
            placeholders = ",".join(["%s"] * len(items))
            predicate = f"{column} IN ({placeholders})"
            values = items
        else:
            predicate = f"{column} = %s"
            values = [raw_value]

        if exists_tpl is not None:
            # The vf_<id> tree has no deleted_at, so the EXISTS liveness filter is
            # emitted only for the datastore (shared-tree) branch.
            live_pred = "" if is_vf else "AND mis.deleted_at IS NULL "
            predicate = exists_tpl["wrap"].format(
                predicate=predicate, study_pkey=study_pkey, live=live_pred,
                **table_names)
        where_extra += f" AND {predicate} "
        qparams.extend(values)

    limit_clause = ""
    if params['limit'] > 0:
        limit_clause = f" LIMIT {int(params['offset'])}, {int(params['limit'])}"

    full_query = proto + where_extra + order_clause + limit_clause
    return full_query, qparams


# ── S3 access ────────────────────────────────────────────────────────────────
def _check_bucket(bucket: str) -> None:
    """Refuse any bucket outside the deployment's archive namespace.

    The task role is already scoped to '{stack}-ds-*', so this only turns a late
    AccessDenied into an early, explicit refusal — but it also means a corrupted
    or attacker-influenced Instancelocation row cannot make this service fetch an
    unrelated object it does happen to be able to read.
    """
    if ARCHIVE_BUCKET_PREFIX and not bucket.startswith(ARCHIVE_BUCKET_PREFIX):
        raise PermissionError(f"bucket '{bucket}' is outside the archive namespace")


def _s3_get(bucket: str, key: str, byte_range: str = None):
    """Every S3 read in this service goes through here, so the guard is total."""
    _check_bucket(bucket)
    kwargs = {'Bucket': bucket, 'Key': key}
    if byte_range:
        kwargs['Range'] = byte_range
    return s3_client.get_object(**kwargs)


# ── WADO bulk DICOM (multipart/related; type="application/dicom") ────────────
def _retrieve_dicom_bulk(query: str, datastore_id: str, uid_value: str) -> Response:
    rows = _execute_query(query, (datastore_id, uid_value))
    if not rows:
        return _refuse(404, "Not Found", audit_events.ACTION_INSTANCE,
                       'DICOMweb Instance Retrieved')

    # A virtualized pyramid level has no Part 10 representation to serve: its
    # backing object is the raw .svs TIFF, so streaming it as application/dicom
    # would hand the client the whole multi-gigabyte slide, mislabelled, once per
    # level. Those levels stay reachable through /frames, /metadata and /rendered.
    # Filtering happens before the availability pre-check so an archived level
    # cannot block a study whose real instances are all ONLINE.
    skipped = sum(1 for row in rows if _is_virtualized_object(row))
    if skipped:
        rows = [row for row in rows if not _is_virtualized_object(row)]
        if not rows:
            # Nothing Part 10 under this UID. 404 rather than an empty multipart
            # body: "no DICOM instance here" is what the client has to act on.
            return _refuse(404, "Not Found", audit_events.ACTION_INSTANCE,
                           'DICOMweb Instance Retrieved',
                           {'virtualizedSkipped': skipped})

    # Pre-check, because the status code is committed before the first byte of a
    # multipart body: streaming the ONLINE members and omitting the rest would
    # produce a 200 that looks like a complete study, and a silently short study
    # is a patient-safety defect. Refusing the whole request is unambiguous, and
    # QIDO already reports (0008,0056) per instance so the client knows which
    # members it can still fetch individually.
    worst = availability.worst_availability(row.get('availability') for row in rows)
    blocked = availability.unavailable_response(worst)
    if blocked is not None:
        return _refuse_unavailable(blocked, worst, audit_events.ACTION_INSTANCE,
                                   'DICOMweb Instance Retrieved',
                                   {'instanceCount': len(rows)})

    # Security: a folder request gets de-identified objects. Resolved before
    # the 200 is committed so an unreadable profile refuses the whole request.
    try:
        deid_ctx = _vf_deid_context()
    except VfDeidUnavailable as exc:
        return _refuse(503, f"De-identification unavailable: {exc}",
                       audit_events.ACTION_INSTANCE, 'DICOMweb Instance Retrieved')
    deid_on = _vf_deid_active(deid_ctx)

    boundary = uuid4().hex
    resource_type, resource_id, uids = _uid_scope()
    audit_ctx = _audit_context()

    def stream():
        served = 0
        failure = None
        try:
            for row in rows:
                chunks = (_deid_part10_chunks(row, deid_ctx) if deid_on
                          else _s3_get(row['bucketname'], row['s3key'],
                                       byte_range=_member_range(row))['Body']
                          .iter_chunks(chunk_size=STREAM_CHUNK_SIZE))
                yield (
                    f"--{boundary}\r\n"
                    f"Content-Type: application/dicom\r\n\r\n"
                ).encode()
                for chunk in chunks:
                    served += len(chunk)
                    yield chunk
                yield b"\r\n"
            yield f"--{boundary}--\r\n".encode()
        except Exception as exc:      # noqa: BLE001 - re-raised immediately
            # The 200 went out with the first chunk and cannot be recalled, so the
            # failure has to be loud in the two places that can still act on it:
            # re-raising aborts the chunked body without a closing boundary (the
            # client sees a broken transfer rather than a short study), and the
            # audit record below says FAILURE instead of claiming a clean read.
            failure = exc
            logger.error("bulk retrieve truncated after %d bytes: %s", served, exc)
            raise
        finally:
            # Emitted from `finally` so a client that disconnects mid-study is
            # still audited: it read PHI, and a generator closed early never
            # reaches the line after the last yield. A disconnect raises
            # GeneratorExit, which is not an Exception, so it stays a SUCCESS —
            # the bytes it did receive were served correctly.
            values = {'datastoreId': datastore_id, **uids,
                      'instanceCount': len(rows), 'bytesServed': served,
                      'truncated': failure is not None}
            if skipped:
                values['virtualizedSkipped'] = skipped
            _emit_audit(audit_events.ACTION_INSTANCE, 'DICOMweb Instance Retrieved',
                        resource_type, resource_id, values,
                        status='FAILURE' if failure is not None else 'SUCCESS',
                        error_message=str(failure) if failure is not None else None,
                        context=audit_ctx)

    return Response(
        status=200,
        response=stream(),
        content_type=f'multipart/related; type="application/dicom"; boundary="{boundary}"',
    )


# Objects whose PixelData offset is unknown are de-identified by parsing the
# whole object; this caps that full read (the header-splice path has no cap).
VF_DEID_FULL_READ_MAX_BYTES = int(os.environ.get('VF_DEID_FULL_READ_MAX_BYTES', str(512 * 1024 * 1024)))
_DEFLATED_TS = '1.2.840.10008.1.2.1.99'


def _encode_part10(ds) -> bytes:
    buf = BytesIO()
    pydicom.dcmwrite(buf, ds, write_like_original=True)
    return buf.getvalue()


def _deid_part10_chunks(row: dict, deid_ctx):
    """Yield one de-identified Part 10 object for a folder retrieve.

    Header and pixel data are handled separately: the header (everything before
    the main PixelData element, located at ingest as metadataendoffset) is
    parsed, run through the folder profile at every sequence depth, and
    re-encoded in its original transfer syntax; the PixelData element and
    anything after it are streamed unchanged. So a multi-GB object costs one
    small header parse, not a full read. When the offset is unknown, or the
    object is deflated (the header cannot be spliced), the whole object is
    parsed instead, up to VF_DEID_FULL_READ_MAX_BYTES. Any failure raises,
    which aborts the response; source bytes are never served in its place.
    """
    action_index, drop_private, salt = deid_ctx
    start = int(row.get('member_offset') or 0)
    length = row.get('member_length')
    end_offset = row.get('metadataendoffset')
    if end_offset and int(end_offset) > start:
        end_offset = int(end_offset)
        header = _s3_get(row['bucketname'], row['s3key'],
                         byte_range=f"bytes={start}-{end_offset - 1}")['Body'].read()
        ds = pydicom.dcmread(BytesIO(header), force=True, stop_before_pixels=True)
        ts = str(getattr(getattr(ds, 'file_meta', None), 'TransferSyntaxUID', '') or '')
        if ts != _DEFLATED_TS:
            vf_deid.apply_profile_to_dataset(ds, action_index, salt, drop_private)
            yield _encode_part10(ds)
            tail_end = f"{start + int(length) - 1}" if length else ''
            body = _s3_get(row['bucketname'], row['s3key'],
                           byte_range=f"bytes={end_offset}-{tail_end}")['Body']
            yield from body.iter_chunks(chunk_size=STREAM_CHUNK_SIZE)
            return
    resp = _s3_get(row['bucketname'], row['s3key'], byte_range=_member_range(row))
    if int(resp.get('ContentLength') or 0) > VF_DEID_FULL_READ_MAX_BYTES:
        raise ValueError("object too large to de-identify without a known PixelData offset")
    ds = pydicom.dcmread(BytesIO(resp['Body'].read()), force=True)
    vf_deid.apply_profile_to_dataset(ds, action_index, salt, drop_private)
    yield _encode_part10(ds)


def _member_range(row: dict) -> str | None:
    """HTTP Range covering just this instance's slice of its backing object.

    An instance normally *is* its object, and both member columns are NULL — no
    Range needed. For an instance inside an uncompressed tar they bound its member,
    which ingest indexed in place rather than extracting.
    """
    offset = row.get('member_offset')
    length = row.get('member_length')
    if offset is None or not length:
        return None
    return f"bytes={int(offset)}-{int(offset) + int(length) - 1}"


def _is_virtualized_object(row: dict) -> bool:
    """True when the row's backing object is not a Part 10 DICOM stream.

    SVS ingest indexes each pyramid level of a slide as an instance over the raw
    `.svs` TIFF and marks it by writing metadataendoffset = 0 — there is no DICOM
    header in that object for the offset to end. jpeg_tables_offset (TIFF tag 347)
    is only ever populated for those levels, so either mark is conclusive.

    A NULL metadataendoffset is deliberately *not* a mark: it means ingest never
    located PixelData in an otherwise real Part 10 object, which is still servable.
    Nor is the SOP class — a genuine Part 10 WSI `.dcm` carries the same one.
    """
    end_offset = row.get('metadataendoffset')
    if end_offset is not None and int(end_offset) == 0:
        return True
    return row.get('jpeg_tables_offset') is not None


def _read_instance_object(row: dict) -> bytes:
    """Read the complete DICOM stream backing one instance row.

    For a plain object that's the whole object, as before. For a tar member it's
    that member's bytes — which is not merely an optimization: handing pydicom the
    whole archive would present it with a 512-byte tar header where the preamble
    should be.
    """
    return _s3_get(row['bucketname'], row['s3key'],
                   byte_range=_member_range(row))['Body'].read()


# ── WADO metadata (gzipped JSON precomputed at ingest time) ──────────────────

def _vf_drop_private(vf_id: str) -> bool:
    """Whether this VF's de-id profile drops all private tags."""
    if not vf_id:
        return False
    try:
        rows = _execute_query(sql_queries.VF_DEID_DROP_PRIVATE, (vf_id,))
        return bool(rows and rows[0].get('drop_private_tags'))
    except Exception as exc:
        print(f"VF drop_private_tags load failed for {vf_id}: {exc}")
        return False


class VfDeidUnavailable(Exception):
    """The folder's de-id profile could not be loaded or applied.
    Folder responses refuse rather than fall back to the source values."""


def _vf_deid_context():
    """De-id context for the active request.

    None for a storage (datastore) request. For a folder request returns
    (action_index, drop_private, salt). A folder WITHOUT a de-id profile gets an
    empty context (no rules, no private-tag drop): the folder owner chose no
    de-identification, and the folder tree holds the same values.

    Fails CLOSED (raises VfDeidUnavailable) when the profile row cannot be
    read, the folder points at a profile that no longer exists, or the stored
    tag_actions cannot be parsed. The old loader returned "no rules" in all
    three cases, so a transient DB error served identified headers.
    """
    vf_id = getattr(g.identity, 'virtual_folder_id', None)
    if not vf_id:
        return None
    try:
        rows = _execute_query(sql_queries.VF_DEID_PROFILE, (vf_id,))
    except Exception as exc:
        raise VfDeidUnavailable('de-id profile could not be loaded') from exc
    if not rows:
        raise VfDeidUnavailable('virtual folder not found')
    row = rows[0]
    if row.get('deid_profile_id') and not row.get('profile_id'):
        raise VfDeidUnavailable('virtual folder references a missing de-id profile')
    raw = row.get('tag_actions')
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode('utf-8', 'replace')
    tag_actions = raw
    if isinstance(raw, str):
        try:
            tag_actions = json.loads(raw) if raw.strip() else []
        except Exception as exc:
            raise VfDeidUnavailable('de-id profile is unreadable') from exc
    if tag_actions is not None and not isinstance(tag_actions, list):
        raise VfDeidUnavailable('de-id profile is unreadable')
    action_index = vf_deid.build_action_index(tag_actions or [])
    try:
        salt = vf_deid.effective_salt(vf_id)
    except Exception as exc:   # pepper unset or unreadable
        raise VfDeidUnavailable('de-identification key unavailable') from exc
    return action_index, bool(row.get('drop_private_tags')), salt


def _vf_deid_active(ctx) -> bool:
    return bool(ctx and (ctx[0] or ctx[1]))


def _vf_deid_json(obj: dict, ctx) -> None:
    """Apply a folder de-id context to one DICOM-JSON object in place."""
    action_index, drop_private, salt = ctx
    if action_index:
        vf_deid.apply_profile_to_json(obj, action_index, salt)
    if drop_private:
        vf_deid.strip_private_json(obj)


def _strip_private_tags(obj: dict) -> None:
    """Remove private DICOM tags from a DICOM-JSON object in place. A tag is
    private when its group (first 4 hex digits) is ODD (PS3.5 §7.8.1)."""
    for tag in list(obj.keys()):
        try:
            group = int(tag[:4], 16)
        except (ValueError, TypeError):
            continue
        if group % 2 == 1:
            del obj[tag]


# Per-instance identity tags overlaid onto each /metadata entry from the
# `instance` row's own columns. (json_tag, VR, row-key, is_numeric). A
# virtualized WSI study shares ONE Instancemetadata blob across all its pyramid
# levels (they share content_pkey), so the blob alone would make every level's
# entry identical; these five tags are what actually differ per level and must
# come from the per-instance row, not the shared blob. UL is emitted as an int
# (DICOM-JSON number), IS/UI as strings (string VRs).
_WSI_OVERLAY_TAGS = (
    ('00080018', 'UI', 'inst_sopinstanceuid', False),           # SOP Instance UID
    ('00200013', 'IS', 'inst_instancenumber', False),           # Instance Number
    ('00280008', 'IS', 'inst_numberofframes', False),           # Number of Frames
    ('00480006', 'UL', 'inst_totalpixelmatrixcolumns', True),   # Total Pixel Matrix Columns
    ('00480007', 'UL', 'inst_totalpixelmatrixrows', True),      # Total Pixel Matrix Rows
)


def _overlay_instance_identity(obj: dict, row: dict) -> None:
    """Write each instance's OWN identity/geometry tags onto its metadata entry.

    SAFETY NET (no longer the primary mechanism). Instancemetadata is now keyed
    on instance_pkey, so a correctly-ingested WSI study serves a DISTINCT blob
    per pyramid level — each already carries its own SOPInstanceUID / dims /
    frame_offsets, and this overlay writes the same values back (a true no-op).
    It is retained because (a) it costs one dict overlay per row and (b) it keeps
    a graceful degradation for any legacy row ingested under the old
    content_pkey keying (collapsed blob, identical entries) that has not yet been
    re-ingested: the overlay still hands SLIM distinct per-level identity from
    the instance row's own columns, avoiding the "identical dimensions" reject
    (though non-base frame_offsets still require re-ingest to tile). A NULL
    column leaves the blob's own value untouched."""
    for json_tag, vr, key, is_numeric in _WSI_OVERLAY_TAGS:
        if key not in row:
            continue
        val = row[key]
        if val is None:
            continue
        el = obj.get(json_tag) or obj.get(json_tag.lower())
        if is_numeric:
            try:
                out_val = [int(val)]
            except (TypeError, ValueError):
                out_val = [str(val)]
        else:
            out_val = [str(val)]
        if el is not None:
            el['Value'] = out_val
            el.setdefault('vr', vr)
        else:
            obj[json_tag] = {'vr': vr, 'Value': out_val}


def _retrieve_metadata(query: str, datastore_id: str, uid_value: str) -> Response:
    rows = _execute_query(query, (datastore_id, uid_value))
    if not rows:
        return _refuse(404, "Not Found", audit_events.ACTION_METADATA,
                       'DICOMweb Metadata Retrieved')

    # No availability guard here, deliberately. The blob is a database row, not an
    # S3 read: serving it touches no archived object and is exactly what a client
    # needs to render an "archived, request restore" affordance with real
    # study/series/instance context.
    # Security: resolve the folder de-id context BEFORE committing a 200.
    try:
        deid_ctx = _vf_deid_context()
    except VfDeidUnavailable as exc:
        return _refuse(503, f"De-identification unavailable: {exc}",
                       audit_events.ACTION_METADATA, 'DICOMweb Metadata Retrieved')

    resource_type, resource_id, uids = _uid_scope()
    _emit_audit(audit_events.ACTION_METADATA, 'DICOMweb Metadata Retrieved',
                resource_type, resource_id,
                {'datastoreId': datastore_id, **uids, 'instanceCount': len(rows)})

    # Per-VF de-identification: when this request targets a VF, the metadata the
    # client sees must reflect the VF's de-id profile — applied to EVERY covered
    # header element on the fly, INCLUDING tags that are not indexed columns,
    # because the served blob is the raw source header (redesign §F). This uses
    # the SAME action engine, salt (the VF id) and rules as
    # virtual-folder-indexer, so a hashed/shifted tag reads identically whether
    # it came from the indexed column (search) or here (retrieve). The physical
    # bytes / pixel offsets are untouched (they key on content_pkey, not
    # identity). Datastore requests keep the fast verbatim pass-through.
    deid_on = _vf_deid_active(deid_ctx)

    def stream():
        yield b"["
        first = True
        for row in rows:
            blob = row['metadata']
            if blob is None:
                continue
            decoded = gzip.decompress(blob)
            # Overlay this instance's OWN identity onto its copy of the blob.
            # A virtualized WSI study is N level-instances over ONE physical .svs
            # object, so all N rows share a single content_pkey and the LEFT JOIN
            # maps every level to the SAME blob (one level's serialized header).
            # Left untouched, the series /metadata returns N identical entries and
            # SLIM 0.46+ rejects the series. Per-instance identity lives on the
            # `instance` row's columns (carried out as inst_* aliases), never in
            # the shared blob, so overlay them per row. Non-WSI rows overlay the
            # blob's own values back onto it (a no-op), so this is unconditional.
            try:
                obj = json.loads(decoded)
                _overlay_instance_identity(obj, row)
                decoded = json.dumps(obj).encode()
            except Exception as exc:
                # A malformed blob must not break the stream; serve as-is.
                # No SOP Instance UID here: it is patient-linkable (PHI).
                print(f"metadata identity overlay skipped: {type(exc).__name__}")
                decoded = gzip.decompress(blob)
            # Folder requests: apply the profile (every sequence depth) and the
            # private-tag drop. Security: a blob that cannot be de-identified
            # is never served as-is; raising aborts the chunked body, so the
            # client sees a broken transfer instead of identified headers.
            if deid_on:
                obj = json.loads(decoded)
                _vf_deid_json(obj, deid_ctx)
                decoded = json.dumps(obj).encode()
            if first:
                yield decoded
                first = False
            else:
                yield b","
                yield decoded
        yield b"]"

    return Response(status=200, response=stream(),
                    content_type="application/dicom+json")


# ── WADO frames (transcoding dispatch) ───────────────────────────────────────
NATIVE_TRANSFER_SYNTAXES = {
    '1.2.840.10008.1.2',          # Implicit VR Little Endian
    '1.2.840.10008.1.2.1',        # Explicit VR Little Endian
    '1.2.840.10008.1.2.2',        # Explicit VR Big Endian
}

# Lossy compressed syntaxes — refuse to re-encode them (any transcode adds loss).
LOSSY_TRANSFER_SYNTAXES = {
    '1.2.840.10008.1.2.4.50',     # JPEG Baseline (Process 1)
    '1.2.840.10008.1.2.4.51',     # JPEG Extended (Process 2 & 4)
    '1.2.840.10008.1.2.4.91',     # JPEG 2000 Image Compression (Lossy variants)
    '1.2.840.10008.1.2.4.93',     # JPEG 2000 Part 2 Multi-component (Lossy)
    '1.2.840.10008.1.2.4.100',    # MPEG2 Main Profile @ Main Level
    '1.2.840.10008.1.2.4.101',    # MPEG2 Main Profile @ High Level
    '1.2.840.10008.1.2.4.102',    # MPEG-4 AVC/H.264 High Profile / Level 4.1
    '1.2.840.10008.1.2.4.103',    # MPEG-4 AVC/H.264 BD-compatible
    '1.2.840.10008.1.2.4.104',    # MPEG-4 AVC/H.264 High Profile / Level 4.2 For 2D
    '1.2.840.10008.1.2.4.105',    # MPEG-4 AVC/H.264 High Profile / Level 4.2 For 3D
    '1.2.840.10008.1.2.4.106',    # MPEG-4 AVC/H.264 Stereo High Profile / Level 4.2
    '1.2.840.10008.1.2.4.107',    # HEVC/H.265 Main Profile / Level 5.1
    '1.2.840.10008.1.2.4.108',    # HEVC/H.265 Main 10 Profile / Level 5.1
    '1.2.840.10008.1.2.4.111',    # JPEG XL JPEG Recompression
    '1.2.840.10008.1.2.4.112',    # JPEG XL
    '1.2.840.10008.1.2.4.203',    # High-Throughput JPEG 2000 (lossy permitted)
}


def _parse_accept_transfer_syntaxes(accept_header: str) -> list:
    """Pull every transfer-syntax= UID out of an Accept header, in order.

    Permissive on purpose: returns an empty list for missing/`*/*`/wildcard
    or anything we can't make sense of. Empty list means "no preference; serve
    as-stored". Never raises.
    """
    if not accept_header:
        return []
    found = []
    for media_range in accept_header.split(','):
        # Walk each `;`-separated parameter; we only care about transfer-syntax.
        for param in media_range.split(';'):
            if 'transfer-syntax' not in param.lower():
                continue
            if '=' not in param:
                continue
            try:
                value = param.split('=', 1)[1].strip().strip('"').strip("'")
                if not value:
                    continue
                if value == '*':
                    return []  # wildcard = "give me whatever you have"
                found.append(value)
            except Exception:
                continue
    return found


def _select_decoder(stored_ts: str, requested: list):
    """Return (return_ts, decoder_fn).

    Policy (permissive, prefers as-stored):
      - empty requested list (no Accept / wildcard) → as-stored
      - stored TS already in requested list         → as-stored
      - stored TS is lossy                          → as-stored (no re-encode)
      - no installed decoder for the stored TS      → as-stored (labelled honestly,
                                                       never a 500 mid-stream)
      - requested includes Explicit VR LE           → decode to ELE
      - otherwise                                   → as-stored fallback
    """
    if not requested or stored_ts in requested:
        return stored_ts, _read_frame_as_stored
    if stored_ts in LOSSY_TRANSFER_SYNTAXES:
        return stored_ts, _read_frame_as_stored
    if stored_ts not in pixel_codecs.DECODABLE_TO_ELE:
        return stored_ts, _read_frame_as_stored
    if '1.2.840.10008.1.2.1' in requested:
        return '1.2.840.10008.1.2.1', _read_frame_decoded_to_ele
    return stored_ts, _read_frame_as_stored


def _build_frames_multipart(row: dict, frame_list: list, requested_ts: list) -> dict:
    boundary = uuid4().hex
    stored_ts = row.get('transfer_syntax') or ''
    return_ts, decoder = _select_decoder(stored_ts, requested_ts)

    def stream():
        # Submit reads concurrently; preserve frame order on output.
        futures = [worker_pool.submit(decoder, row, f, return_ts) for f in frame_list]
        for fut in futures:
            frame_bytes, ts = fut.result()
            yield (
                f"--{boundary}\r\n"
                f"Content-Type: {get_content_type(ts)};"
                f' transfer-syntax="{ts}"\r\n\r\n'
            ).encode()
            yield frame_bytes
            yield b"\r\n"
        yield f"--{boundary}--\r\n".encode()

    return {"boundary": boundary, "stream": stream, "return_ts": return_ts}


class FrameOutOfRangeError(Exception):
    """The requested frame cannot exist within this instance's own bytes.

    Kept distinct from the transient errors the fetch tiers fall back on, because
    falling back here is what makes it dangerous: for an instance indexed in place
    inside a tar, bytes past the member window belong to the *next instance*, and
    serving them as this instance's pixel data is a cross-instance PHI leak. Never
    caught by a tier fallback — the read aborts instead.
    """


def _read_frame_as_stored(row: dict, frame_id: int, return_ts: str):
    """As-stored path. Three tiers in priority order:
      1. Native uncompressed: compute offset, single ranged GET.
      2. Encapsulated with cached frame offsets: single ranged GET, wrap in
         encapsulation framing.
      3. Fall back: GET the whole instance and let pydicom/highdicom carve.
    """
    ts = row.get('transfer_syntax')
    rows_ = row.get('rows_')
    cols_ = row.get('columns_')
    bits = row.get('bits_allocated')
    samples = row.get('samples_per_pixel') or 1
    end_offset = row.get('metadataendoffset')

    if (ts in NATIVE_TRANSFER_SYNTAXES and rows_ and cols_ and bits and end_offset):
        try:
            return _read_native_frame_range(
                row['bucketname'], row['s3key'],
                end_offset, int(rows_), int(cols_), int(bits), int(samples),
                frame_id, ts,
                n_frames=int(row.get('number_of_frames') or 1),
                member_offset=row.get('member_offset'),
                member_length=row.get('member_length'),
            )
        except FrameOutOfRangeError:
            # Deliberately not a fallback case: see FrameOutOfRangeError.
            raise
        except Exception as e:
            logger.warning("range fetch failed for frame %d, falling back: %s",
                           frame_id, e)

    frame_offsets_blob = row.get('frame_offsets')
    if frame_offsets_blob and ts not in pixel_codecs.VIDEO:
        try:
            return _read_encapsulated_frame_range(
                row['bucketname'], row['s3key'], frame_offsets_blob,
                frame_id, ts,
                jpeg_tables_offset=row.get('jpeg_tables_offset'),
                jpeg_tables_length=row.get('jpeg_tables_length'),
                validate_fragments=bool(row.get('metadataendoffset')),
            )
        except FrameOutOfRangeError:
            raise
        except Exception as e:
            logger.warning("encapsulated range fetch failed for frame %d, falling back: %s",
                           frame_id, e)

    return _read_full_frame(row, frame_id)


def _get_wsi_jpeg_tables(bucket: str, key: str, offset: int, length: int) -> bytes:
    """Fetch (and cache) the shared JPEG-tables blob for a virtualized WSI file.

    The blob is identical for every tile of a whole-slide file, so we cache it
    by (bucket, key, offset) and pay ~one small ranged GET per file rather than
    per tile.
    """
    cache_key = (bucket, key, offset)
    if wsi_tables_cache is not None:
        cached = wsi_tables_cache.get(cache_key)
        if cached is not None:
            return cached
    jpeg_tables = _s3_get(bucket, key,
                          byte_range=f"bytes={offset}-{offset + length - 1}")['Body'].read()
    if wsi_tables_cache is not None:
        wsi_tables_cache[cache_key] = jpeg_tables
    return jpeg_tables


# Adobe APP14 marker with color transform = 0, meaning "the three components are
# R, G, B — do NOT apply a YCbCr→RGB transform". Aperio SVS JPEG tiles store RGB
# pixels but omit this marker and use non-standard component IDs (0,1,2), so a
# decoder defaults to assuming YCbCr and mangles the color (white → magenta).
# Injecting this marker makes any decoder treat the tile as RGB, matching the
# instance's PhotometricInterpretation=RGB.
_ADOBE_APP14_RGB = (
    b'\xff\xee\x00\x0e' + b'Adobe' + b'\x00\x64\x00\x00\x00\x00' + b'\x00'
)


def _jpeg_has_color_marker(data: bytes) -> bool:
    """True if the JPEG stream carries a JFIF (APP0) or Adobe (APP14) marker.

    Their presence tells a decoder the color space unambiguously. We only scan
    the APPn marker run at the start of the stream (right after SOI); a decoder's
    color decision is made from those, so that's all we need to inspect.
    """
    i = 0
    if data[:2] == b'\xff\xd8':
        i = 2
    while i + 4 <= len(data) and data[i] == 0xFF:
        marker = data[i + 1]
        if marker in (0xE0, 0xEE):  # APP0 (JFIF) / APP14 (Adobe)
            return True
        if 0xE1 <= marker <= 0xEF:  # other APPn — skip past it
            seg_len = (data[i + 2] << 8) | data[i + 3]
            i += 2 + seg_len
            continue
        break  # first non-APP marker (DQT/DHT/SOF/…) — no color marker found
    return False


def _jpeg_chroma_subsampled(data: bytes) -> bool:
    """True if the JPEG frame header (SOF) gives any component a sampling factor
    other than 1x1, i.e. the chroma is subsampled (4:2:2, 4:2:0, ...).

    Chroma subsampling only makes sense for YCbCr, so a subsampled tile is
    YCbCr-coded: Ventana BIF tiles are (TIFF Photometric=YCbCr, 2x1 sampling).
    Aperio RGB tiles are never subsampled (all components 1x1). Returns False
    when no SOF is found in the scanned prefix.
    """
    i = 2 if data[:2] == b'\xff\xd8' else 0
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return False
        marker = data[i + 1]
        if marker == 0xFF:          # fill byte
            i += 1
            continue
        seg_len = (data[i + 2] << 8) | data[i + 3]
        # SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if i + 10 > len(data):
                return False
            n = data[i + 9]
            for k in range(n):
                j = i + 10 + 3 * k
                if j + 1 >= len(data):
                    return False
                if data[j + 1] != 0x11:
                    return True
            return False
        if marker == 0xDA:          # start of scan: no SOF before it
            return False
        i += 2 + seg_len
    return False


def _merge_jpeg_tables(tile_bytes: bytes, tables_bytes: bytes) -> bytes:
    """Splice shared JPEG tables into an abbreviated tile to form a full JPEG.

    Aperio SVS tiles are abbreviated JPEG streams (SOI … SOS/data … EOI) with no
    quantization/Huffman tables — those live once in TIFF tag 347 as their own
    abbreviated stream (SOI … DQT/DHT … EOI). A decodable standalone JPEG is:
        SOI + [Adobe APP14] + <table segments> + <tile body after its SOI>
    We drop the tables' trailing EOI and the tile's leading SOI so there's
    exactly one SOI and one EOI.

    Color fix: Aperio's tiles store RGB pixels but omit any JFIF/Adobe marker and
    use component IDs 0,1,2, so a decoder defaults to assuming YCbCr and mangles
    the color (white → magenta). When the reconstructed stream has no color
    marker, we inject an Adobe APP14 (transform=0) so decoders treat it as RGB —
    matching PhotometricInterpretation=RGB. A stream that already carries a
    JFIF/Adobe marker is left untouched (the decoder can trust it).

    Not every marker-less WSI tile is RGB: Ventana BIF tiles are YCbCr with 2x1
    chroma subsampling and also carry no marker. Marking those RGB makes the
    decoder show raw Y/Cb/Cr as R/G/B (a pink slide), so a subsampled tile is
    left without a marker and decoded with the default YCbCr conversion.
    """
    SOI = b'\xff\xd8'
    EOI = b'\xff\xd9'
    jpeg_tables = tables_bytes
    if jpeg_tables.endswith(EOI):
        jpeg_tables = jpeg_tables[:-2]
    if not jpeg_tables.startswith(SOI):
        # Tables blob without a leading SOI: prepend one so the result is well-formed.
        jpeg_tables = SOI + jpeg_tables
    body = tile_bytes
    if body.startswith(SOI):
        body = body[2:]
    merged = jpeg_tables + body
    if not _jpeg_has_color_marker(merged) and not _jpeg_chroma_subsampled(merged):
        # SOI + APP14 + (rest of the stream after its SOI)
        return SOI + _ADOBE_APP14_RGB + merged[2:]
    return merged


def _read_encapsulated_frame_range(bucket: str, key: str, frame_offsets_blob,
                                    frame_id: int, transfer_syntax: str,
                                    jpeg_tables_offset=None, jpeg_tables_length=None,
                                    validate_fragments=False):
    """Single ranged S3 GET for one encapsulated frame's payload.

    frame_offsets_blob is the JSON list cached at ingest time:
       [[start_a, end_a], [start_b, end_b], ...]
    Both ends are inclusive byte offsets in the S3 object, pointing at the
    JPEG/JPEG2000/etc payload (Item tag headers excluded).

    For virtualized whole-slide (SVS) tiles, `jpeg_tables_offset`/`_length` point
    at the file's shared JPEG-tables blob (TIFF tag 347). The tile payload is an
    abbreviated JPEG, so we splice the shared tables in to produce a decodable
    standalone JPEG. `frame_offsets` still addresses only the tile payload, so
    the length check below is against the raw tile bytes, before merging.

    Returns the (possibly merged) payload bytes — the multipart streamer wraps
    them in the boundary headers; we don't add Item-tag framing ourselves.
    """
    import time
    t0 = time.monotonic()

    offsets = json.loads(frame_offsets_blob)

    if frame_id < 1 or frame_id > len(offsets):
        # Not a ValueError: falling back to the full-object path for a frame that
        # cannot exist means downloading the whole (possibly multi-GB) object to
        # discover the same thing, after the response status is already committed.
        raise FrameOutOfRangeError(
            f"frame {frame_id} out of range (have {len(offsets)})")

    start, end_inclusive = offsets[frame_id - 1]
    # For a DICOM Part 10 object, also read the 8 bytes after the frame: they must
    # be the next frame's Item header, or the Sequence Delimiter after the last
    # frame. Anything else means the frame spans several fragments and the cached
    # range holds only the first (offsets indexed before the multi-fragment fix),
    # so fall back to the full read. Raw WSI files (metadataendoffset 0) have no
    # Item framing and are not checked.
    check_tail = bool(validate_fragments) and not jpeg_tables_length
    read_end = end_inclusive + (8 if check_tail else 0)
    payload = _s3_get(bucket, key, byte_range=f"bytes={start}-{read_end}")['Body'].read()
    t_done = time.monotonic()

    expected = end_inclusive - start + 1
    if check_tail:
        tail = payload[expected:expected + 8]
        payload = payload[:expected]
        if frame_id == len(offsets):
            whole = tail[:4] == pixel_codecs.SEQ_DELIM
        else:
            whole = tail[:4] == pixel_codecs.ITEM_TAG and offsets[frame_id][0] == read_end + 1
        if not whole:
            raise ValueError(f"frame {frame_id} spans more than one fragment")
    if len(payload) != expected:
        raise ValueError(f"got {len(payload)} bytes, expected {expected}")

    if jpeg_tables_offset is not None and jpeg_tables_length:
        jpeg_tables = _get_wsi_jpeg_tables(
            bucket, key, int(jpeg_tables_offset), int(jpeg_tables_length))
        payload = _merge_jpeg_tables(payload, jpeg_tables)
        logger.info(
            "frame %d [wsi-tile+tables]: range=%.0fms tile=%d merged=%d",
            frame_id, (t_done - t0) * 1000, expected, len(payload),
        )
        return payload, transfer_syntax

    logger.info(
        "frame %d [encapsulated]: range=%.0fms size=%d",
        frame_id, (t_done - t0) * 1000, len(payload),
    )
    return payload, transfer_syntax


def _decode_frame_full(row: dict, frame_id: int):
    """GET the whole object and decode one frame to a numpy array.

    Returns (array, t_get, t_parse) monotonic timestamps for the caller's log line.
    """
    import time
    body = _read_instance_object(row)
    t_get = time.monotonic()
    ds = dcmread(BytesIO(body), force=True)
    t_parse = time.monotonic()

    # Security: a pydicom decode can decode EVERY frame; refuse objects whose
    # decoded size would exceed the budget (dimensions come from the stored object).
    decoded = (int(getattr(ds, 'Rows', 0) or 0) * int(getattr(ds, 'Columns', 0) or 0)
               * int(getattr(ds, 'SamplesPerPixel', 1) or 1)
               * max(1, (int(getattr(ds, 'BitsAllocated', 8) or 8) + 7) // 8)
               * int(getattr(ds, 'NumberOfFrames', 1) or 1))
    if decoded > DECODE_MAX_BYTES:
        raise FrameDecodeError(f"frame {frame_id}: object too large to transcode ({decoded} bytes decoded)")
    return pixel_codecs.decode_frame(ds, frame_id - 1), t_get, t_parse


def _decode_frame_full_or_415(row: dict, frame_id: int, ts: str):
    """Render-path wrapper: a frame no installed decoder can read is a 415.

    The decode budget (FrameDecodeError) is not swallowed: it is its own answer.
    """
    try:
        return _decode_frame_full(row, frame_id)[0]
    except FrameDecodeError:
        raise
    except Exception as exc:      # noqa: BLE001 - decoders raise many types
        raise UnsupportedRenderSyntaxError(ts or 'unknown') from exc


def _read_frame_decoded_to_ele(row: dict, frame_id: int, return_ts: str):
    """Decode an encapsulated frame and return raw little-endian pixel bytes.

    Decoding is pixel_codecs.decode_frame: pydicom handlers (python-gdcm,
    pylibjpeg-rle) for JPEG / JPEG-LS / RLE / native, OpenJPEG for JPEG 2000
    Part 1/2 and HTJ2K, zlib for Deflated Image Frame Compression.
    """
    import sys
    import time
    t0 = time.monotonic()

    frame_arr, t_get, t_parse = _decode_frame_full(row, frame_id)

    # Force little-endian, contiguous bytes for ELE output.
    if frame_arr.dtype.byteorder == '>' or (
        frame_arr.dtype.byteorder == '=' and sys.byteorder == 'big'
    ):
        frame_arr = frame_arr.byteswap().view(frame_arr.dtype.newbyteorder('<'))
    pixel_bytes = frame_arr.tobytes(order='C')
    t_done = time.monotonic()

    # The S3 key is absent from this line at every level, DEBUG included. It embeds
    # the datastore id and the study/series/SOP UIDs, and ingest derives it from the
    # source object so it can also carry patient names, MRNs and accession numbers;
    # CloudWatch is not a PHI store, and this is the same key path deliberately
    # withheld from a caller without private-tag privilege. Nothing stops an
    # operator setting LOG_LEVEL=DEBUG in production, so DEBUG is not a hiding
    # place. Frame id, timings and sizes identify the work without identifying the
    # patient; the audit trail is where the UIDs belong.
    logger.info(
        "frame %d [decoded %s→ELE]: get=%.0fms parse=%.0fms decode=%.0fms total=%.0fms size=%d",
        frame_id, row.get('transfer_syntax'),
        (t_get - t0) * 1000, (t_parse - t_get) * 1000,
        (t_done - t_parse) * 1000, (t_done - t0) * 1000, len(pixel_bytes),
    )
    return pixel_bytes, return_ts


def _read_native_frame_range(bucket: str, key: str, metadata_end_offset: int,
                              rows_: int, cols_: int, bits: int, samples: int,
                              frame_id: int, transfer_syntax: str,
                              n_frames: int = 1,
                              member_offset=None, member_length=None):
    """Single ranged S3 GET for an uncompressed-pixel-data frame.

    Layout from `metadata_end_offset` (the byte position of the PixelData tag header):
      - 4 bytes:  group + element (7FE0,0010)
      - For Explicit VR LE/BE: 2 bytes VR + 2 bytes reserved + 4 bytes length = 8 bytes
        For Implicit VR LE:    4 bytes length only                            = 4 bytes
      - then `frame_size` bytes per frame, frames are contiguous.

    We trust the offset stored at ingest time (the rfind-based scan finds the
    main image's PixelData tag, skipping any IconImageSequence). If the data
    turns out to be stale or wrong, the size check at the end raises and the
    caller falls back to the full-fetch path.

    The computed range is bounded twice before it reaches S3: against
    NumberOfFrames, and against the instance's member window when it lives inside
    a tar. Without the second bound an over-large frame index produces a perfectly
    valid Range into the *next* member, and S3 returns a neighbouring instance's
    bytes with a 206 that nothing downstream can distinguish from this instance's
    pixel data.
    """
    import time
    t0 = time.monotonic()

    if frame_id < 1 or frame_id > max(int(n_frames or 1), 1):
        raise FrameOutOfRangeError(
            f"frame {frame_id} out of range (have {n_frames})")

    # Implicit VR LE: 4-byte length only after tag. Explicit: 2 VR + 2 reserved + 4 length.
    if transfer_syntax == '1.2.840.10008.1.2':
        pixel_data_start = metadata_end_offset + 8
    else:
        pixel_data_start = metadata_end_offset + 12

    bytes_per_pixel = (bits + 7) // 8
    frame_size = rows_ * cols_ * samples * bytes_per_pixel

    frame_start = pixel_data_start + (frame_id - 1) * frame_size
    frame_end = frame_start + frame_size - 1

    if member_length:
        # metadataendoffset is absolute in the object, so the window is too.
        window_start = int(member_offset or 0)
        window_end = window_start + int(member_length) - 1
        if frame_start < window_start or frame_end > window_end:
            raise FrameOutOfRangeError(
                f"frame {frame_id} range escapes this instance's member window")

    frame = _s3_get(bucket, key, byte_range=f"bytes={frame_start}-{frame_end}")['Body'].read()
    t_done = time.monotonic()

    if len(frame) != frame_size:
        raise ValueError(f"got {len(frame)} bytes, expected {frame_size}")

    logger.info(
        "frame %d [native]: range=%.0fms size=%d",
        frame_id, (t_done - t0) * 1000, frame_size,
    )
    return frame, transfer_syntax


def _read_full_frame(row: dict, frame_id: int):
    """Fallback path: GET the whole instance, parse, hand to highdicom.

    Used for encapsulated transfer syntaxes (JPEG/JPEG-LS/JPEG2000/RLE/video)
    and for any object whose geometry we couldn't read from the index.
    """
    import time
    t0 = time.monotonic()
    # Frame id and the fallback reason only — never the key (see _read_frame_decoded_to_ele).
    logger.debug("frame %d taking the full-object read path (ts=%s)",
                 frame_id, row.get('transfer_syntax'))
    body = _read_instance_object(row)
    t_get = time.monotonic()

    stored_ts = row.get('transfer_syntax') or ''
    if stored_ts not in NATIVE_TRANSFER_SYNTAXES:   # encapsulated, deflated or video
        # pydicom inflates a deflated dataset on read and joins fragments itself;
        # highdicom's reader needs one Basic Offset Table entry per frame, which a
        # video (one bitstream) or a fragmented single frame does not have.
        ds = dcmread(BytesIO(body), force=True)
        ts = str(ds.file_meta.TransferSyntaxUID)
        if ts == pixel_codecs.DEFLATED_LE:
            # Deflate applies to the whole dataset, not the frame: the frame itself
            # is native little-endian pixel data.
            frame = pixel_codecs.native_frame_bytes(ds, frame_id - 1)
            ts = '1.2.840.10008.1.2.1'
        elif ts in pixel_codecs.VIDEO:
            # PS3.18: a video is one bitstream; any frame of it is answered with
            # the whole stream.
            frame = pixel_codecs.video_stream(ds)
        else:
            frame = pixel_codecs.encapsulated_frame(ds, frame_id - 1)
        t_frame = time.monotonic()
        logger.info(
            "frame %d [full/pydicom]: get=%.0fms frame=%.0fms size=%d",
            frame_id, (t_get - t0) * 1000, (t_frame - t_get) * 1000, len(body))
        return frame, ts

    buf = BytesIO(body)
    dcmfile = DicomFileLike(buf)
    ds = dcmread(dcmfile, force=True, stop_before_pixels=True)
    ts = ds.file_meta.TransferSyntaxUID
    dcmfile.is_implicit_VR = ts.is_implicit_VR
    dcmfile.is_little_endian = ts.is_little_endian
    dcmfile.seek(0)
    t_parse = time.monotonic()

    imr = ImageFileReader(dcmfile)
    frame = imr.read_frame_raw(frame_id - 1)
    t_frame = time.monotonic()

    logger.info(
        "frame %d [full]: get=%.0fms parse=%.0fms frame=%.0fms total=%.0fms size=%d",
        frame_id,
        (t_get - t0) * 1000, (t_parse - t_get) * 1000,
        (t_frame - t_parse) * 1000, (t_frame - t0) * 1000,
        len(body),
    )
    return frame, ts


# ── Rendered pipeline glue ────────────────────────────────────────────────────
WSI_SOP_CLASS_UID = '1.2.840.10008.5.1.4.1.1.77.1.6'
RENDER_MAX_DIM = int(os.environ.get('RENDER_MAX_DIM', '4096'))
# Render budgets: a WSI region render composites at most this many
# tiles / pixels; a frames request lists at most this many frames; a decode of
# the whole object (lossless -> Explicit VR LE) is refused above this size.
RENDER_MAX_TILES = int(os.environ.get('RENDER_MAX_TILES', '256'))
RENDER_MAX_REGION_PIXELS = int(os.environ.get('RENDER_MAX_REGION_PIXELS', str(64 * 1024 * 1024)))
FRAMES_MAX_PER_REQUEST = int(os.environ.get('FRAMES_MAX_PER_REQUEST', '256'))
DECODE_MAX_BYTES = int(os.environ.get('DECODE_MAX_BYTES', str(1024 * 1024 * 1024)))


def _dataset_from_metadata_blob(datastore_id: str, instance_uid: str,
                                query=None, scope=None, deid_ctx=None):
    """Reconstruct a pydicom Dataset from the stored (gzipped) metadata blob.

    Gives the rendered pipeline the instance's presentation attributes
    (rescale slope/intercept, window, photometric, WSI geometry) without
    re-fetching or re-parsing the S3 object. Returns None if not found.

    `query`/`scope` let a VF request pass the VF-scoped metadata query bound to
    its vf id; when omitted this falls back to the datastore-scoped query bound
    to `datastore_id`, preserving the original behaviour for non-VF callers.
    """
    if query is None:
        query, scope = sql_queries.WADO_METADATA_INSTANCE, datastore_id
    row = _fetch_one(query, (scope, instance_uid))
    if row is None or row.get('metadata') is None:
        return None
    try:
        js = json.loads(gzip.decompress(row['metadata']))
        if _vf_deid_active(deid_ctx):
            _vf_deid_json(js, deid_ctx)   # folder request: de-identified values only
        return Dataset.from_json(json.dumps(js))
    except Exception as e:
        # request_id, not the SOPInstanceUID: a UID is patient-linkable and belongs
        # in the audit event (which carries it and this same id), not in CloudWatch.
        logger.warning("failed to rebuild dataset (request %s): %s", _request_id(), e)
        return None


# Encoded syntaxes Pillow can actually open. Everything else this service will
# happily *serve* through /frames (as-stored is always a valid answer there) but
# cannot render: RLE Lossless, JPEG-LS, lossless JPEG and the MPEG family are all
# either unknown to Pillow or not still images at all. Handing them to
# Image.open() produced a 500 HTML page from a route that advertises images.
PIL_DECODABLE_TRANSFER_SYNTAXES = {
    '1.2.840.10008.1.2.4.50',     # JPEG Baseline (Process 1)
    '1.2.840.10008.1.2.4.51',     # JPEG Extended (Process 2 & 4)
    '1.2.840.10008.1.2.4.90',     # JPEG 2000 Lossless
    '1.2.840.10008.1.2.4.91',     # JPEG 2000
}


class UnsupportedRenderSyntaxError(Exception):
    """This frame's transfer syntax has no rendering decoder here → 415."""


class FrameDecodeError(Exception):
    """A decoder was selected but THIS frame's bytes did not decode.

    Distinct from UnsupportedRenderSyntaxError on purpose: unsupported is a
    property of the codec and applies to every frame of the instance (415),
    whereas this is one corrupt or truncated frame. Keeping them apart is what
    lets a single bad WSI tile be blanked instead of refusing the whole region.
    """


def _decode_frame_array(row: dict, frame_id: int):
    """Fetch + decode one frame to a numpy pixel array.

    Reuses the frame-fetch tiers for the bytes (native range / encapsulated tile
    with JPEG-table merge / full-object fallback), then decodes:
      - native little-endian → reshape from geometry
      - JPEG/JPEG2000 → Pillow decode
    Anything else raises UnsupportedRenderSyntaxError for the caller to turn into
    a 415; it is not a server fault that the frame is stored in a codec no
    installed decoder handles.
    """
    import numpy as np
    stored_ts = row.get('transfer_syntax') or ''
    if stored_ts and stored_ts not in pixel_codecs.DECODABLE \
            and stored_ts not in PIL_DECODABLE_TRANSFER_SYNTAXES:
        # Video, JPEG XL, unknown: say so before fetching any bytes.
        raise UnsupportedRenderSyntaxError(stored_ts)
    if (stored_ts and stored_ts not in PIL_DECODABLE_TRANSFER_SYNTAXES
            and stored_ts not in NATIVE_TRANSFER_SYNTAXES
            and stored_ts != pixel_codecs.DEFLATED_LE):
        # JPEG lossless, JPEG-LS, RLE, JPEG 2000 Part 2, HTJ2K, deflated/
        # uncompressed frames: whole-object decode under the B-10 budget.
        return _decode_frame_full_or_415(row, frame_id, stored_ts)

    frame_bytes, ts = _read_frame_as_stored(row, frame_id, None)

    if ts in NATIVE_TRANSFER_SYNTAXES:
        rows_ = int(row['rows_']); cols_ = int(row['columns_'])
        samples = int(row.get('samples_per_pixel') or 1)
        bits = int(row.get('bits_allocated') or 8)
        order = '>' if ts == '1.2.840.10008.1.2.2' else '<'
        dtype = np.dtype(np.uint8) if bits <= 8 else np.dtype(order + 'u2')
        arr = np.frombuffer(frame_bytes, dtype=dtype)
        if samples >= 3:
            return arr.reshape(rows_, cols_, samples)
        return arr.reshape(rows_, cols_)

    if ts not in PIL_DECODABLE_TRANSFER_SYNTAXES:
        raise UnsupportedRenderSyntaxError(ts or 'unknown')

    # Encoded (JPEG/J2K): let Pillow decode the codestream.
    #
    # The two failure modes are split deliberately, because they are not the same
    # answer and the WSI tile loop depends on telling them apart:
    #
    #   open() failing  -> Pillow could not identify the codestream or has no
    #                      plugin for it (a build without openjpeg). That is a
    #                      property of the image, holds for every tile of the
    #                      level, and is a 415.
    #   load() failing  -> the format WAS identified and a decoder WAS selected,
    #                      and decoding THESE bytes failed. That is one corrupt
    #                      or truncated frame, not an unsupported codec, so it
    #                      must stay per-frame: _render_wsi_region blanks the
    #                      single tile instead of 415ing the whole region.
    #
    # Collapsing both into UnsupportedRenderSyntaxError made the per-tile
    # degradation path unreachable for every encoded slide.
    from PIL import Image
    try:
        img = Image.open(BytesIO(frame_bytes))
    except Exception as exc:      # noqa: BLE001 - Pillow raises many types
        # Pillow has no decoder for this codestream (12-bit JPEG extended, a
        # build without openjpeg). Non-WSI frames decode through pydicom/GDCM
        # instead; a WSI tile keeps the 415, since its stored object is the
        # whole slide and a full decode is never the answer for one tile.
        if not _is_wsi(None, row) and ts in pixel_codecs.DECODABLE:
            return _decode_frame_full_or_415(row, frame_id, ts)
        raise UnsupportedRenderSyntaxError(ts or 'unknown') from exc
    try:
        img.load()
    except Exception as exc:      # noqa: BLE001 - Pillow raises many types
        raise FrameDecodeError(
            f"frame {frame_id} did not decode as {ts or 'unknown'}: {exc}"
        ) from exc
    return np.asarray(img)


def _is_wsi(ds, row) -> bool:
    """True for a whole-slide microscopy instance.

    Falls back to the index row: WADO_INSTANCE_LOC carries sop_class_uid and
    dimension_organization_type precisely so a missing or unparseable metadata
    blob cannot silently demote a gigapixel level onto the single-frame path.
    """
    if ds is not None and str(getattr(ds, 'SOPClassUID', '') or '') == WSI_SOP_CLASS_UID:
        return True
    if row is None:
        return False
    return (row.get('sop_class_uid') == WSI_SOP_CLASS_UID
            or row.get('dimension_organization_type') == 'TILED_FULL')


def _wsi_total_matrix(ds, row):
    """(TotalPixelMatrixColumns, TotalPixelMatrixRows) for a WSI level, or None."""
    try:
        return int(ds.TotalPixelMatrixColumns), int(ds.TotalPixelMatrixRows)
    except Exception:
        pass
    if row is None:
        return None
    cols = row.get('total_pixel_matrix_columns')
    rows_ = row.get('total_pixel_matrix_rows')
    if cols and rows_:
        return int(cols), int(rows_)
    return None


def _render_wsi_region(row, ds, vp):
    """Composite the WSI level tiles intersecting a viewport source region.

    Only the tiles overlapping [sx,sy,sx+sw,sy+sh] are range-fetched and decoded,
    so cost scales with the requested region, not the whole gigapixel level.
    Returns a PIL RGB image of the cropped region (unscaled); the caller scales.
    """
    from PIL import Image

    tile_w = int(row['columns_'])
    tile_h = int(row['rows_'])
    matrix = _wsi_total_matrix(ds, row)
    if matrix is None:
        raise ValueError("missing TotalPixelMatrix for WSI region render")
    total_cols, total_rows = matrix
    n_cols = (total_cols + tile_w - 1) // tile_w

    sx = vp.sx or 0
    sy = vp.sy or 0
    sw = vp.sw if vp.sw is not None else (total_cols - sx)
    sh = vp.sh if vp.sh is not None else (total_rows - sy)
    flip_h = sw < 0
    flip_v = sh < 0
    sw = abs(sw); sh = abs(sh)
    # Clamp to matrix bounds.
    sx = max(0, min(sx, total_cols)); sy = max(0, min(sy, total_rows))
    sw = min(sw, total_cols - sx); sh = min(sh, total_rows - sy)
    if sw <= 0 or sh <= 0:
        raise ValueError("empty WSI source region")

    col0 = sx // tile_w
    col1 = (sx + sw - 1) // tile_w
    row0 = sy // tile_h
    row1 = (sy + sh - 1) // tile_h

    n_tiles = (col1 - col0 + 1) * (row1 - row0 + 1)
    if n_tiles > RENDER_MAX_TILES or n_tiles * tile_w * tile_h > RENDER_MAX_REGION_PIXELS:
        raise ValueError("WSI source region too large; request a lower-resolution level or a smaller region")
    canvas = Image.new('RGB', ((col1 - col0 + 1) * tile_w, (row1 - row0 + 1) * tile_h))
    for tr in range(row0, row1 + 1):
        for tc in range(col0, col1 + 1):
            frame_id = tr * n_cols + tc + 1   # TILED_FULL row-major, 1-based
            try:
                arr = _decode_frame_array(row, frame_id)
                tile = Image.fromarray(arr).convert('RGB')
            except UnsupportedRenderSyntaxError:
                # Undecodable applies to every tile of the level, so blanking them
                # one by one would return an all-black slide with a 200. Let the
                # caller answer 415 once.
                raise
            except Exception as e:
                logger.warning("wsi tile %d decode failed: %s", frame_id, e)
                tile = Image.new('RGB', (tile_w, tile_h))
            canvas.paste(tile, ((tc - col0) * tile_w, (tr - row0) * tile_h))

    # Crop the canvas to the exact requested region (offset within the tile grid).
    off_x = sx - col0 * tile_w
    off_y = sy - row0 * tile_h
    region = canvas.crop((off_x, off_y, off_x + sw, off_y + sh))
    if flip_h:
        region = region.transpose(Image.FLIP_LEFT_RIGHT)
    if flip_v:
        region = region.transpose(Image.FLIP_TOP_BOTTOM)
    return region


def _render_response(datastore_id: str, instance_uid: str, frame_id):
    """Shared handler for Rendered Instance and Rendered Frames.

    Parses rendering query params, decodes the requested frame (or WSI region),
    runs the presentation pipeline, and returns an encoded image.
    """
    import render as R

    loc_query, loc_scope = _wado_scope(sql_queries.WADO_INSTANCE_LOC,
                                       sql_queries.WADO_INSTANCE_LOC_VF)
    meta_query, meta_scope = _wado_scope(sql_queries.WADO_METADATA_INSTANCE,
                                         sql_queries.WADO_METADATA_INSTANCE_VF)

    media_type = R.negotiate_media_type(request.headers.get('Accept', ''))
    if media_type is None:
        return _refuse(406, "Not Acceptable", audit_events.ACTION_RENDERED,
                       'DICOMweb Rendered Retrieved')

    # Parse query params (400 on malformed).
    try:
        vp = R.parse_viewport(request.args['viewport']) if 'viewport' in request.args else None
        window = R.parse_window(request.args['window']) if 'window' in request.args else None
        quality = R.parse_quality(request.args['quality']) if 'quality' in request.args else 90
        icc_mode = R.parse_iccprofile(request.args['iccprofile']) if 'iccprofile' in request.args else 'no'
        annotations = R.parse_annotation(request.args['annotation']) if 'annotation' in request.args else []
    except (ValueError, KeyError) as e:
        return _refuse(400, f"Invalid rendering parameter: {e}",
                       audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved')

    audit_values = {
        'datastoreId': datastore_id,
        'sopUID': instance_uid,
        'frame': frame_id,
        'mediaType': media_type,
        # Geometry and window are client-supplied render parameters, not PHI.
        'viewport': request.args.get('viewport'),
        'window': request.args.get('window'),
    }

    try:
        deid_ctx = _vf_deid_context()
    except VfDeidUnavailable as exc:
        return _refuse(503, f"De-identification unavailable: {exc}",
                       audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved', audit_values)

    row = _fetch_one(loc_query, (loc_scope, instance_uid))
    if row is None:
        return _refuse(404, "Not Found", audit_events.ACTION_RENDERED,
                       'DICOMweb Rendered Retrieved', audit_values)

    # Before any S3 read: every branch below range-GETs the backing object.
    blocked = availability.unavailable_response(row.get('availability'))
    if blocked is not None:
        return _refuse_unavailable(blocked, row.get('availability'),
                                   audit_events.ACTION_RENDERED,
                                   'DICOMweb Rendered Retrieved', audit_values)

    ds = _dataset_from_metadata_blob(datastore_id, instance_uid,
                                     query=meta_query, scope=meta_scope,
                                     deid_ctx=deid_ctx)
    # Security: a folder request whose metadata could not be de-identified
    # must not burn identifiers into the image; render without annotations.
    if deid_ctx is not None and ds is None:
        annotations = []

    is_wsi = _is_wsi(ds, row)
    n_frames = int(row.get('number_of_frames') or 1)

    # WSI instance-level with a source-region viewport → composite tiles.
    try:
        if is_wsi and frame_id is None and vp is not None and vp.has_source_region:
            img = _render_wsi_region(row, ds, vp)
            img = img.resize((vp.vw, vp.vh), _pil_bilinear())
        else:
            # Pick the frame: explicit, else 1.
            fid = frame_id if frame_id is not None else 1
            if fid < 1 or fid > max(n_frames, 1):
                return _refuse(404, "Frame out of range", audit_events.ACTION_RENDERED,
                               'DICOMweb Rendered Retrieved', audit_values)
            arr = _decode_frame_array(row, fid)
            img = R.to_display_image(ds if ds is not None else _minimal_ds(row), arr, window)
            # Big-image guard + viewport.
            if vp is not None:
                img = R.apply_viewport(img, vp)
            else:
                img = _cap_dimensions(img, RENDER_MAX_DIM)
    except ValueError as exc:
        # Security: an over-budget (or empty) WSI region is a bad request.
        return _refuse(400, str(exc), audit_events.ACTION_RENDERED,
                       'DICOMweb Rendered Retrieved', audit_values)
    except UnsupportedRenderSyntaxError as exc:
        # 415, not 500: the request was well formed and the instance is there, we
        # simply have no decoder for how its pixels are stored. /frames still
        # serves the frame as-stored for a client that can decode it itself.
        return _refuse(415, f"Cannot render transfer syntax {exc}",
                       audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved',
                       audit_values)
    except FrameDecodeError as exc:
        # 500, not 415: we DO have a decoder for this codec, so the fault is the
        # stored bytes, not the request. Refused explicitly rather than left to
        # Flask's default handler so the attempt still lands in the audit trail.
        # The message names the frame and syntax only - never the object key.
        logger.warning("rendered: %s", exc)
        return _refuse(500, "Stored pixel data for this frame could not be decoded",
                       audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved',
                       audit_values)

    # ICC color management (WSI/color only).
    if icc_mode != 'no' and img.mode in ('RGB', 'RGBA'):
        icc_bytes = _fetch_icc_bytes(row)
        if icc_bytes:
            img = R.apply_icc(img, icc_bytes, icc_mode)

    if annotations and ds is not None:
        img = R.burn_annotations(img, R.annotation_lines(ds, annotations))

    body = R.encode(img, media_type, quality=quality)
    if annotations:
        audit_values = {**audit_values, 'annotation': ','.join(annotations)}
    _emit_audit(audit_events.ACTION_RENDERED, 'DICOMweb Rendered Retrieved',
                'instance', instance_uid, audit_values, always='patient' in annotations)
    return Response(status=200, response=body, content_type=media_type)


def _pil_bilinear():
    from PIL import Image
    return Image.BILINEAR


def _minimal_ds(row):
    """Fallback Dataset from the WADO_INSTANCE_LOC row when no metadata blob."""
    ds = Dataset()
    ds.SamplesPerPixel = int(row.get('samples_per_pixel') or 1)
    ds.BitsStored = int(row.get('bits_allocated') or 8)
    return ds


def _cap_dimensions(img, max_dim: int):
    """Downscale so neither dimension exceeds max_dim (preserves aspect)."""
    W, H = img.size
    if max(W, H) <= max_dim:
        return img
    scale = max_dim / float(max(W, H))
    return img.resize((max(1, int(W * scale)), max(1, int(H * scale))), _pil_bilinear())


def _fetch_icc_bytes(row):
    """Range-read the instance's ICC profile from S3, if present."""
    off = row.get('icc_profile_offset')
    length = row.get('icc_profile_length')
    if not length or off is None:
        return None
    try:
        return _s3_get(
            row['bucketname'], row['s3key'],
            byte_range=f"bytes={int(off)}-{int(off) + int(length) - 1}",
        )['Body'].read()
    except Exception:
        return None


def get_content_type(transfer_syntax):
    """Map a transfer-syntax UID to its MIME type.

    Built lazily with getattr() so we don't crash on a pydicom version that
    renamed or dropped any specific constant (e.g. JPEGLosslessP14 → JPEGLossless).
    """
    mapping = {
        'ImplicitVRLittleEndian':         "application/octet-stream",
        'ExplicitVRLittleEndian':         "application/octet-stream",
        'DeflatedExplicitVRLittleEndian': "application/octet-stream",
        'ExplicitVRBigEndian':            "application/octet-stream",
        'JPEGBaseline8Bit':               "image/jpeg",
        'JPEGExtended12Bit':              "image/jpeg",
        'JPEGLossless':                   "image/jpeg",
        'JPEGLosslessP14':                "image/jpeg",
        'JPEGLosslessSV1':                "image/jpeg",
        'RLELossless':                    "image/dicom-rle",
        'JPEGLSLossless':                 "image/jls",
        'JPEGLSNearLossless':             "image/jls",
        'JPEG2000Lossless':               "image/jp2",
        'JPEG2000':                       "image/jp2",
        'JPEG2000MCLossless':             "image/jpx",
        'JPEG2000MC':                     "image/jpx",
        'MPEG2MPML':                      "video/mpeg2",
        'MPEG2MPHL':                      "video/mpeg2",
        'MPEG4HP41':                      "video/mp4",
        'MPEG4HP41BD':                    "video/mp4",
        'MPEG4HP422D':                    "video/mp4",
        'MPEG4HP423D':                    "video/mp4",
        'MPEG4HP42STEREO':                "video/mp4",
    }
    for name, mime in mapping.items():
        if getattr(uid, name, None) == transfer_syntax:
            return mime
    # Syntaxes newer than pydicom 2.4's uid constants (PS3.18 Table 8.7.3-2/-5).
    return {
        '1.2.840.10008.1.2.4.107': "video/H265",
        '1.2.840.10008.1.2.4.108': "video/H265",
        '1.2.840.10008.1.2.4.201': "image/jphc",
        '1.2.840.10008.1.2.4.202': "image/jphc",
        '1.2.840.10008.1.2.4.203': "image/jphc",
        '1.2.840.10008.1.2.4.110': "image/jxl",
        '1.2.840.10008.1.2.4.111': "image/jxl",
        '1.2.840.10008.1.2.4.112': "image/jxl",
    }.get(transfer_syntax, "application/octet-stream")


# ── Entrypoint ───────────────────────────────────────────────────────────────
def create_app() -> Flask:
    """Configure and return the Flask app.

    The app object itself is built at import time so the route decorators have
    something to attach to; create_app() applies the configuration a test client
    needs without also opening the connections bootstrap() owns.
    """
    # One HTTPS origin (CloudFront) fronts both the SPA and this service, so the
    # browser never makes a cross-origin request in the supported topology. CORS
    # stays OFF unless an operator names explicit origins; '*' on a PHI data
    # plane is never acceptable.
    _cors_origins = [o.strip() for o in os.environ.get('CORS_ALLOWED_ORIGINS', '').split(',') if o.strip()]
    if _cors_origins:
        CORS(app, origins=_cors_origins, supports_credentials=True)
    return app


def bootstrap() -> Flask:
    global sql_pool, s3_client, lambda_client, auth_middleware

    logging.basicConfig(level=os.environ.get('LOG_LEVEL', 'INFO'))

    # First, so a bad auth configuration is the first thing that fails. The
    # verifier raises when USER_POOL_CLIENT_ID is empty — an unaudienced token
    # check is worse than no service, so failing closed at boot is correct.
    oidc_verifier = None
    if OIDC_ENABLED:
        oidc_verifier = OIDCVerifier(
            os.environ['USER_POOL_ID'], AWS_REGION,
            app_client_id=os.environ.get('USER_POOL_CLIENT_ID'))
    else:
        logger.warning("OIDC_ENABLED=false: token verification is disabled")

    try:
        sql_pool = mysqlConnectionFactory.init_connection_pool()
    except Exception as exc:      # noqa: BLE001 - deliberately not fatal
        # Boot without a pool rather than crash-loop: /dicomweb/health then
        # answers 503, the ALB pulls the target, and the deployment circuit
        # breaker rolls back with a readable log line instead of a task that
        # dies before it can write one. Every data-plane route refuses with 503
        # in the meantime, because auth_middleware stays None.
        logger.error("database pool initialization failed: %s", exc)
        sql_pool = None

    if sql_pool is not None:
        # Optional DIMSE session-token verifier: enabled when the shared HMAC
        # secret ARN is configured. Lets this solution's DICOM DIMSE service
        # query/retrieve with a config-service-minted token instead of Cognito.
        from dicom_service_token import DicomServiceTokenVerifier
        dicom_token_verifier = DicomServiceTokenVerifier.from_secrets_manager(
            os.environ.get('DICOM_SERVICE_AUTH_SECRET_ARN', ''), AWS_REGION)
        auth_middleware = AuthMiddleware(oidc_verifier, sql_pool, dicom_token_verifier)

    boto_cfg = BotoConfig(max_pool_connections=max(WORKER_THREADS, DB_POOL_SIZE))
    s3_client = boto3.client('s3', config=boto_cfg)
    # Lambda client for synchronous STOW-RS ingest. Read timeout comfortably above
    # a cold-start + single-object index. botocore retries off: _invoke_sync_ingest
    # retries transport errors itself, with logging (indexing is an idempotent upsert).
    lambda_client = boto3.client(
        'lambda',
        config=BotoConfig(read_timeout=120, connect_timeout=10,
                          retries={'max_attempts': 0}))

    logger.info("QIDO/WADO-RS service bootstrapped (stack=%s, version=%s, workers=%d, "
                "db_pool=%d, cache_ttl=%ds, oidc=%s)",
                STACK_NAME or '-', SOLUTION_VERSION, WORKER_THREADS, DB_POOL_SIZE,
                QIDO_CACHE_TTL_SEC, OIDC_ENABLED)
    return create_app()


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8080'))
    if WEB_CONCURRENCY > 1:
        # Multi-process: hand off to gunicorn (gthread workers) so all vCPUs are
        # used. gunicorn imports wsgi:application in each forked worker, and that
        # module calls bootstrap() per worker — so each worker owns its own DB
        # pool, S3 client and caches. We do NOT bootstrap() here in the master:
        # the master never serves a request and opening a pool it then forks
        # across workers would share sockets unsafely.
        import sys
        argv = [
            'gunicorn',
            '--workers', str(WEB_CONCURRENCY),
            '--worker-class', 'gthread',
            '--threads', str(WORKER_THREADS),
            '--bind', f'0.0.0.0:{port}',
            # A whole-study multipart body can stream for a while; keep gunicorn's
            # request timeout well above the ALB idle timeout (120s) so gunicorn
            # never kills a worker mid-transfer. 0 would disable it entirely, but
            # a finite ceiling still reaps a genuinely wedged worker.
            '--timeout', os.environ.get('GUNICORN_TIMEOUT', '300'),
            '--graceful-timeout', '30',
            '--keep-alive', '75',
            # Bounded body size mirrors the old waitress max_request_body_size.
            '--limit-request-line', '8190',
            '--access-logfile', '-',
            '--error-logfile', '-',
            '--log-level', os.environ.get('LOG_LEVEL', 'info').lower(),
            'wsgi:application',
        ]
        os.execvp('gunicorn', argv)
    else:
        # Single-process fallback (local dev / tests): original waitress path.
        bootstrap()
        serve(app, host="0.0.0.0", port=port, url_scheme='http',  # nosec B104
              max_request_body_size=4 * 1024 * 1024 * 1024,
              threads=DB_POOL_SIZE, asyncore_use_poll=True)
