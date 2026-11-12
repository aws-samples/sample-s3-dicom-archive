"""Shared pytest fixtures + import shims for the ingest Lambda tests (lambda/ingest/).

Ported from reference/dicomweb-s3/tests/conftest.py and adapted to the Phase-1
port in cdk-infrastructure/lib/import/lambda/ingest/:

  * modules import from the ingest directory (the parent of this one); the
    indexing engine is `engine` (engine.py), the Lambda entry point is `handler`;
  * FakeConn understands the datastore-scoped SQL the port issues — every
    study/series/instance row carries datastore_id, unique keys include it,
    and the datastores/import_jobs tables exist;
  * FakeS3 grew upload_fileobj (unpack-on-ingest PUTs extracted members back)
    and a streaming Body (tarfile 'r|*' reads it in chunks);
  * fakes for EventBridge (index_events) and SQS (DLQ forward) capture what
    the handler emits so event shapes can be asserted.

The ingest code imports `pymysql` and `boto3` at module load. Neither a real
MySQL nor a real AWS client is wanted in a unit-test run, so the minimum
surface is stubbed here BEFORE any ingest module is imported.

Real-data tests (CMU-1.svs / Ventana-1.bif / the ClearCanvas DICOM corpus) do
NOT ship with this tree. They are found via $S3INGEST_FIXTURES_DIR (a directory
holding CMU-1.svs, Ventana-1.bif and/or a ClearCanvas/ corpus of per-study
.dcm subdirectories), falling back to the reference checkout's
reference/dicomweb-s3/tests/fixtures and reference/dicomweb-s3/dagcom-test-data
paths when present. Tests skip when the fixture is absent.

Run:  cd cdk-infrastructure/lib/import/lambda/ingest && python3.12 -m pytest tests/
"""

import io
import os
import re
import sys
import tarfile
import types

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
MODULE_DIR = os.path.dirname(TESTS_DIR)          # .../lambda/ingest
# S3INGEST_MODULE_DIR runs this same suite against another copy of the ingest
# modules (path relative to the lambda/ directory's tests parent).
if os.environ.get("S3INGEST_MODULE_DIR"):
    MODULE_DIR = os.path.abspath(os.path.join(
        os.path.dirname(TESTS_DIR), os.environ["S3INGEST_MODULE_DIR"]))
REPO_ROOT = os.path.abspath(os.path.join(TESTS_DIR, *[".."] * 6))

if MODULE_DIR not in sys.path:
    sys.path.insert(0, MODULE_DIR)


# ── Dependency stubs (must precede any ingest-module import) ─────────────────
def _install_pymysql_stub():
    if "pymysql" in sys.modules:
        return
    # Live-MySQL behavior tests (test_lastrowid_roundtrips,
    # test_ingest_deadlock_avoidance) need the REAL driver. When the run opts in
    # via S3INGEST_LIVE_MYSQL=1 and real pymysql is importable, do NOT stub it —
    # the rest of the suite still runs fine against the real driver (it only ever
    # connects when a test explicitly does). Any other run keeps the stub so the
    # offline unit suite needs no MySQL and no network.
    if os.environ.get("S3INGEST_LIVE_MYSQL") == "1":
        try:
            import pymysql  # noqa: F401  (real driver into sys.modules)
            return
        except Exception:
            pass
    pymysql = types.ModuleType("pymysql")

    class MySQLError(Exception):
        pass

    pymysql.MySQLError = MySQLError
    pymysql.connect = lambda **k: None
    cursors = types.ModuleType("pymysql.cursors")
    cursors.DictCursor = object
    pymysql.cursors = cursors
    sys.modules["pymysql"] = pymysql
    sys.modules["pymysql.cursors"] = cursors


def _install_boto3_stub():
    if "boto3" in sys.modules:
        return
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda *a, **k: None
    boto3.resource = lambda *a, **k: None
    boto3.session = types.SimpleNamespace(Session=lambda *a, **k: None)
    sys.modules["boto3"] = boto3


_install_pymysql_stub()
_install_boto3_stub()


def has_tifffile():
    try:
        import tifffile  # noqa: F401
        return True
    except Exception:
        return False


requires_tifffile = pytest.mark.skipif(
    not has_tifffile(), reason="tifffile not installed (runs in Lambda layer / CI)")


# ── Fixture-file discovery ($S3INGEST_FIXTURES_DIR, reference fallback) ──────
def _fixture_dirs():
    dirs = []
    env = os.environ.get("S3INGEST_FIXTURES_DIR")
    if env:
        dirs.append(env)
    dirs.append(os.path.join(REPO_ROOT, "reference", "dicomweb-s3",
                             "tests", "fixtures"))
    return dirs


def find_fixture(name):
    """Absolute path of a named large fixture (CMU-1.svs, …), or None."""
    for d in _fixture_dirs():
        path = os.path.join(d, name)
        if os.path.exists(path):
            return path
    return None


_CORPUS_STUDIES = ("RFStudy", "CRStudy", "DXStudy", "CTStudy")


def find_dicom_corpus():
    """A directory of per-study .dcm subdirectories (ClearCanvas), or None."""
    candidates = []
    env = os.environ.get("S3INGEST_FIXTURES_DIR")
    if env:
        candidates += [os.path.join(env, "ClearCanvas"), env]
    candidates.append(os.path.join(REPO_ROOT, "reference", "dicomweb-s3",
                                   "dagcom-test-data", "dicom", "ClearCanvas"))
    for d in candidates:
        if d and all(os.path.isdir(os.path.join(d, s)) for s in _CORPUS_STUDIES):
            return d
    return None


# ── In-memory fake DB ─────────────────────────────────────────────────────────
class FakeCursor:
    """Minimal cursor over a FakeConn's tables. Understands only the statement
    shapes the ingest code issues; enough to exercise control flow and row
    mutations without a real MySQL."""

    def __init__(self, conn):
        self.conn = conn
        self._rows = []
        self.lastrowid = 0
        self.rowcount = 0

    def execute(self, sql, params=()):
        # pymysql %-formats the statement whenever params is not None (even an
        # empty tuple), so a literal '%' must be written '%%'. Do the same here
        # so a stray '%' (e.g. LIKE 'vf\\_%') fails the unit tests instead of
        # every live ingest.
        if params is not None:
            args = params if isinstance(params, dict) else tuple("x" for _ in params)
            sql % args
        self.conn.log.append((" ".join(sql.split()), tuple(params)))
        self.rowcount = 0
        self._rows = self.conn.dispatch(sql, params, self)
        return self.rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def close(self):
        pass


_INSERT_RE = re.compile(r"INSERT INTO (\w+)\s*\(([^)]*)\)", re.I)
# First VALUES(...) tuple of an INSERT (the ingest INSERTs each write one row).
_INSERT_VALUES_RE = re.compile(r"VALUES\s*\(([^)]*)\)", re.I)


def _split_values_tuple(body):
    """Split a VALUES(...) body on top-level commas, respecting '...' literals."""
    tokens, buf, in_str = [], [], False
    for ch in body:
        if ch == "'":
            in_str = not in_str
            buf.append(ch)
        elif ch == "," and not in_str:
            tokens.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        tokens.append("".join(buf))
    return tokens

# Canonical table-name spellings (SQL arrives in mixed case).
#
# The handler's physical-object source of truth is `storage_index` (keyed on
# (datastore_id, s3_key, s3_key_version), carrying content_pkey): it replaced the
# former per-instance `Instancelocation` table. Each instance links to its
# storage_index row via instance.content_pkey, and Instancemetadata is now keyed
# on instance_pkey (one metadata row per queryable instance) with content_pkey
# riding along as the physical-object linkage.
_TABLE_CANON = {
    "patient": "patient", "study": "study", "series": "series",
    "instance": "instance", "storage_index": "storage_index",
    "instancemetadata": "Instancemetadata", "datastores": "datastores",
    "import_jobs": "import_jobs",
    "virtual_folder_assignments": "virtual_folder_assignments",
}

# Unique keys used to emulate ON DUPLICATE KEY UPDATE, matching the real schema:
#   patient  uq_patient_ds_id = (datastore_id, patientid, issuerofpatientid)
#   study    uq_study_uid     = (datastore_id, studyinstanceuid)
#   series   uq_series_uid    = (datastore_id, seriesinstanceuid)
#   instance                  = (instanceid)   (datastore-scoped 63-bit hash)
#   storage_index            = (datastore_id, s3_key, s3_key_version)
#   Instancemetadata         = (instance_pkey)
_UNIQUE_KEYS = {
    "patient": ("datastore_id", "patientid", "issuerofpatientid"),
    "study": ("datastore_id", "studyinstanceuid"),
    "series": ("datastore_id", "seriesinstanceuid"),
    "instance": ("instanceid",),
    # member_slot = COALESCE(member_offset, -1) in MySQL; member_offset (None ==
    # None) is the same key here: one row per tar member, one per whole object.
    "storage_index": ("datastore_id", "s3_key", "s3_key_version", "member_offset"),
    "Instancemetadata": ("instance_pkey",),
}

_SOFT_DELETE_TABLES = ("patient", "study", "series", "instance", "storage_index")


class FakeConn:
    """A tiny stand-in for a PyMySQL connection.

    Backed by dict-of-rows tables; `dispatch` interprets the specific SQL the
    ingest/svs/import_jobs code runs. Not a general SQL engine — just enough
    for tests. INSERTs are parsed generically (column list → row dict), so a
    schema drift in the code shows up as a changed row shape, not a silently
    ignored column.
    """

    def __init__(self):
        self.log = []
        self.commits = 0
        self.rollbacks = 0
        self.tables = {
            "patient": [], "study": [], "series": [],
            "instance": [], "storage_index": [], "Instancemetadata": [],
            "datastores": [], "import_jobs": [],
            "virtual_folder_assignments": [],
        }
        # AUTO_INCREMENT pkey counters. storage_index.content_pkey and
        # instance.instance_pkey are real surrogate keys the handler reads back
        # via LAST_INSERT_ID / SELECT instance_pkey, so they must auto-number.
        self._pk = {"patient": 0, "study": 0, "series": 0,
                    "instance": 0, "storage_index": 0}
        # Per-VF databases reported by information_schema, and the content_pkey
        # purges issued against their vf_<id>_instance tables.
        self.vf_databases = []
        self.vf_instance_deletes = []

    def cursor(self, *a, **k):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        pass

    def ping(self, reconnect=True):
        pass

    # -- helpers for tests --
    def rows(self, table):
        return self.tables[table]

    def add_datastore(self, ds_id, bucket, prefix="", access_level=None):
        self.tables["datastores"].append({
            "id": ds_id, "s3_bucket_name": bucket, "s3_prefix": prefix,
            "storage_type": "S3", "deleted": False, "created_at": 0,
            "access_level": access_level,
        })

    def add_import_job(self, job_id, datastore_id, s3_input_uri,
                       total_files=0, status="IN_PROGRESS", job_name="job"):
        self.tables["import_jobs"].append({
            "id": job_id, "datastore_id": datastore_id, "status": status,
            "s3_input_uri": s3_input_uri, "job_name": job_name,
            "total_files": total_files, "processed_files": 0,
            "failed_files": 0, "instances_imported": 0, "total_size_bytes": 0,
            "progress_percentage": 0.0, "error_message": None,
            "error_details": [], "completed_at": None, "created_at": 0,
        })

    def _find(self, table, **filters):
        for row in self.tables[table]:
            if all(row.get(k) == v for k, v in filters.items()):
                return row
        return None

    def _instance(self, instanceid):
        return self._find("instance", instanceid=instanceid)

    def _content_pkeys_for_key(self, bucket, key):
        """content_pkeys of the storage_index rows backing one (bucket, key)."""
        return {s["content_pkey"] for s in self.tables["storage_index"]
                if s["s3_bucket_name"] == bucket and s["s3_key"] == key}

    def _instances_for_key(self, bucket, key):
        """Instance rows whose content_pkey points at this (bucket, key).

        Mirrors the handler's `instance JOIN storage_index ON content_pkey`
        matching: an object backs its instances through the physical-object row,
        not a per-instance location row anymore.
        """
        cpkeys = self._content_pkeys_for_key(bucket, key)
        return [i for i in self.tables["instance"]
                if i.get("content_pkey") in cpkeys]

    # ── dispatch ─────────────────────────────────────────────────────────────
    def dispatch(self, sql, params, cursor):
        s = " ".join(sql.split())
        up = s.upper()

        m = _INSERT_RE.match(s)
        if m:
            table = _TABLE_CANON[m.group(1).lower()]
            cols = [c.strip() for c in m.group(2).split(",")]
            values = self._bind_insert_values(table, cols, s, params)
            return self._insert(table, cols, values, cursor)
        if up.startswith("SELECT"):
            return self._select(up, params, cursor)
        if up.startswith("UPDATE"):
            return self._update(up, params, cursor)
        if up.startswith("DELETE"):
            return self._delete(up, params, cursor)
        return []

    def _delete(self, up, params, cursor):
        if up.startswith("DELETE FROM VIRTUAL_FOLDER_ASSIGNMENTS WHERE CONTENT_PKEY IN"):
            cpks = set(params)
            before = len(self.tables["virtual_folder_assignments"])
            self.tables["virtual_folder_assignments"] = [
                r for r in self.tables["virtual_folder_assignments"]
                if r.get("content_pkey") not in cpks]
            cursor.rowcount = before - len(self.tables["virtual_folder_assignments"])
            return []
        m = re.match(r"DELETE FROM `(VF_[0-9A-F]{32})`\.`(VF_[0-9A-F]{32})_INSTANCE`", up)
        if m:
            self.vf_instance_deletes.append((m.group(1).lower(), tuple(params)))
            return []
        return []

    @staticmethod
    def _bind_insert_values(table, cols, sql, params):
        """Pair INSERT columns with their VALUES tokens.

        The handler's INSERTs mix placeholders with SQL literals, e.g.
        storage_index's `... content_kind, ...) VALUES (%s,%s,%s,%s,'DICOM',...,NULL)`
        — so a plain zip(cols, params) over-counts. Parse the first VALUES(...)
        tuple: a `%s` token consumes the next positional param, a quoted string
        or NULL/number is taken as the literal it is.
        """
        vm = _INSERT_VALUES_RE.search(sql)
        if not vm:
            # No VALUES tuple parsed (shape we don't expect): fall back to the
            # strict 1:1 assumption so drift still surfaces loudly.
            assert len(cols) == len(params), \
                f"INSERT INTO {table}: {len(cols)} columns but {len(params)} params"
            return dict(zip(cols, params))
        tokens = _split_values_tuple(vm.group(1))
        assert len(tokens) == len(cols), (
            f"INSERT INTO {table}: {len(cols)} columns but "
            f"{len(tokens)} VALUES tokens")
        values = {}
        pi = 0
        for col, tok in zip(cols, tokens):
            t = tok.strip()
            if t == "%s":
                values[col] = params[pi]
                pi += 1
            elif t.upper() == "NULL":
                values[col] = None
            elif len(t) >= 2 and t[0] == "'" and t[-1] == "'":
                values[col] = t[1:-1]
            else:
                # bare number/keyword literal
                try:
                    values[col] = int(t)
                except ValueError:
                    values[col] = t
        assert pi == len(params), (
            f"INSERT INTO {table}: {pi} placeholders bound but "
            f"{len(params)} params supplied")
        return values

    def _insert(self, table, cols, values, cursor):
        key_cols = _UNIQUE_KEYS.get(table)
        existing = None
        if key_cols and all(c in values for c in key_cols):
            existing = self._find(table, **{c: values[c] for c in key_cols})

        # Surrogate AUTO_INCREMENT key column per table (what the handler reads
        # back through cursor.lastrowid / SELECT ..._pkey).
        pk_col = {"patient": "patient_pkey", "study": "study_pkey",
                  "series": "series_pkey", "instance": "instance_pkey",
                  "storage_index": "content_pkey"}.get(table)

        if existing is not None:
            # ON DUPLICATE KEY UPDATE emulation: apply the provided values and
            # resurrect (every upsert's SET list carries `deleted_at = NULL`).
            existing.update(values)
            if table in _SOFT_DELETE_TABLES:
                existing["deleted_at"] = None
            # The DICOM instance upsert's SET list sets instanceavailability=NULL
            # explicitly (fresh bytes landed); its INSERT column list has no
            # instanceavailability, while the WSI upsert's does and carries it.
            if table == "instance" and "instanceavailability" not in cols:
                existing["instanceavailability"] = None
            # `<pkey> = LAST_INSERT_ID(<pkey>)` in the SET list hands the
            # existing surrogate pkey back through lastrowid on the dup path.
            cursor.lastrowid = existing.get(pk_col, 0) if pk_col else 0
            cursor.rowcount = 2  # MySQL reports 2 for a dup-key update
            return []

        row = dict(values)
        if pk_col:
            self._pk[table] += 1
            row[pk_col] = self._pk[table]
            cursor.lastrowid = self._pk[table]
        if table in _SOFT_DELETE_TABLES:
            row.setdefault("deleted_at", None)
        if table == "instance":
            row.setdefault("instanceavailability", None)
            row.setdefault("instancenumber", None)
            row.setdefault("content_pkey", None)
        if table == "storage_index":
            row.setdefault("member_offset", None)
            row.setdefault("member_length", None)
            row.setdefault("size_bytes", 0)
            row.setdefault("s3_etag", None)
            row.setdefault("content_kind", None)
            for c in ("study_instance_uid", "series_instance_uid",
                      "sop_instance_uid", "transfer_syntax", "non_dicom_type"):
                row.setdefault(c, None)
        if table == "Instancemetadata":
            row.setdefault("content_pkey", None)
            for c in ("metadataendoffset", "frame_offsets",
                      "jpeg_tables_offset", "jpeg_tables_length",
                      "icc_profile_offset", "icc_profile_length"):
                row.setdefault(c, None)
        self.tables[table].append(row)
        cursor.rowcount = 1
        return []

    def _select(self, up, params, cursor):
        if up.startswith("SELECT PHYSICAL_COLUMN, DICOM_TAG"):
            # index_attribute_defs (STORAGE defs for _load_index_attributes, and
            # the physical_column/dicom_tag map for _load_vf_rules): the unit
            # corpus defines none, so ingest writes only the fixed columns.
            return []
        if up.startswith("SELECT PATIENT_PKEY FROM PATIENT"):
            # uq_patient_ds_id = (datastore_id, patientid, issuerofpatientid)
            row = self._find("patient", datastore_id=params[0],
                             patientid=params[1], issuerofpatientid=params[2])
            return [(row["patient_pkey"],)] if row else []

        if up.startswith("SELECT STUDY_PKEY FROM STUDY"):
            row = self._find("study", datastore_id=params[0],
                             studyinstanceuid=params[1])
            return [(row["study_pkey"],)] if row else []

        if up.startswith("SELECT SERIES_PKEY FROM SERIES"):
            row = self._find("series", datastore_id=params[0],
                             seriesinstanceuid=params[1])
            return [(row["series_pkey"],)] if row else []

        if up.startswith("SELECT STUDY_PKEY FROM SERIES"):
            row = self._find("series", series_pkey=params[0])
            return [(row["study_pkey"],)] if row else []

        if up.startswith("SELECT INSTANCE_PKEY FROM INSTANCE"):
            row = self._find("instance", instanceid=params[0])
            return [(row["instance_pkey"],)] if row else []

        if up.startswith("SELECT ID, S3_PREFIX, ACCESS_LEVEL FROM DATASTORES"):
            for row in self.tables["datastores"]:
                if (row["s3_bucket_name"] == params[0]
                        and row["storage_type"] == "S3" and not row["deleted"]):
                    return [(row["id"], row["s3_prefix"], row.get("access_level"))]
            return []

        if up.startswith("SELECT ID, S3_PREFIX FROM DATASTORES"):
            for row in self.tables["datastores"]:
                if (row["s3_bucket_name"] == params[0]
                        and row["storage_type"] == "S3" and not row["deleted"]):
                    return [(row["id"], row["s3_prefix"])]
            return []

        if up.startswith("SELECT CONTENT_PKEY FROM STORAGE_INDEX"):
            # Fallback lookup on the physical-object unique key
            # (datastore_id, s3_key, s3_key_version). handler passes
            # (datastore.id, key, '') and path_ingest uses a literal '' for the
            # version, so match datastore + key and the empty version.
            ds_id, s3_key = params[0], params[1]
            version = params[2] if len(params) > 2 else ''
            if len(params) > 3:   # ... AND member_offset <=> %s
                row = self._find("storage_index", datastore_id=ds_id, s3_key=s3_key,
                                 s3_key_version=version, member_offset=params[3])
            else:
                row = self._find("storage_index", datastore_id=ds_id, s3_key=s3_key,
                                 s3_key_version=version)
            return [(row["content_pkey"],)] if row else []

        if up.startswith("SELECT DISTINCT I.INSTANCEID"):
            # _apply_sidecar resync: (instanceid, series_pkey, sopinstanceuid,
            # instancenumber, sopclassuid) for the live instances backing this
            # (bucket, key).
            bucket, key, ds_id = params
            out = []
            for inst in sorted(self._instances_for_key(bucket, key),
                               key=lambda i: i["instanceid"]):
                if inst["datastore_id"] == ds_id and inst["deleted_at"] is None:
                    out.append((inst["instanceid"], inst["series_pkey"],
                                inst["sopinstanceuid"],
                                inst.get("instancenumber"),
                                inst.get("sopclassuid")))
            return out

        if up.startswith("SELECT I.INSTANCEID, I.SOPINSTANCEUID, I.SERIES_PKEY"):
            # _retire_superseded_instances: live instances on these content_pkeys
            # with their series/study/patient linkage.
            ds_id, cpks = params[0], set(params[1:])
            out = []
            for inst in sorted(self.tables["instance"], key=lambda i: i["instanceid"]):
                if (inst["datastore_id"] != ds_id or inst["deleted_at"] is not None
                        or inst.get("content_pkey") not in cpks):
                    continue
                series = self._find("series", series_pkey=inst["series_pkey"])
                study = (self._find("study", study_pkey=series["study_pkey"])
                         if series else None)
                out.append((inst["instanceid"], inst["sopinstanceuid"],
                            inst["series_pkey"],
                            series["seriesinstanceuid"] if series else None,
                            series["study_pkey"] if series else None,
                            study["studyinstanceuid"] if study else None,
                            study.get("patient_pkey") if study else None))
            return out

        if up.startswith("SELECT SI.CONTENT_PKEY FROM STORAGE_INDEX SI"):
            # _retire_superseded_slots: live slots of one key (ds, key, key).
            ds_id, key = params[0], params[1]
            return [(r["content_pkey"],) for r in self.tables["storage_index"]
                    if r["datastore_id"] == ds_id and r["s3_key"] == key
                    and r.get("s3_key_version", "") == ""
                    and r.get("deleted_at") is None]

        if up.startswith("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA"):
            return [(n,) for n in self.vf_databases]

        if up.startswith("SELECT I.INSTANCEID"):
            # _instances_for_key: 7 columns incl. joined series/study UIDs,
            # matched through storage_index.content_pkey.
            bucket, key, ds_id = params
            out = []
            for inst in sorted(self._instances_for_key(bucket, key),
                               key=lambda i: i["instanceid"]):
                if inst["datastore_id"] != ds_id or inst["deleted_at"] is not None:
                    continue
                series = self._find("series", series_pkey=inst["series_pkey"])
                study = (self._find("study", study_pkey=series["study_pkey"])
                         if series else None)
                out.append((inst["instanceid"], inst["sopinstanceuid"],
                            inst["sopclassuid"], inst["instanceavailability"],
                            inst["series_pkey"],
                            series["seriesinstanceuid"] if series else None,
                            study["studyinstanceuid"] if study else None))
            return out

        if up.startswith("SELECT SE.DATASTORE_ID, SE.SERIESINSTANCEUID"):
            # _emit_vf_assign_messages: resolve a touched series' UIDs. Only
            # fires when VF_ASSIGN_QUEUE_URL is set (not in the unit run).
            series = self._find("series", series_pkey=params[0])
            if not series:
                return []
            study = self._find("study", study_pkey=series["study_pkey"])
            return [(series["datastore_id"], series["seriesinstanceuid"],
                     study["studyinstanceuid"] if study else None)]

        if up.startswith("SELECT METADATA FROM INSTANCEMETADATA"):
            # keyed on instance_pkey now
            row = self._find("Instancemetadata", instance_pkey=params[0])
            return [(row["metadata"],)] if row else []

        if up.startswith("SELECT ID, S3_INPUT_URI FROM IMPORT_JOBS"):
            ds_id, statuses = params
            return [(r["id"], r["s3_input_uri"]) for r in self.tables["import_jobs"]
                    if r["datastore_id"] == ds_id and r["status"] in statuses
                    and r["s3_input_uri"] is not None]

        if up.startswith("SELECT STATUS, JOB_NAME"):
            row = self._find("import_jobs", id=params[0])
            if not row:
                return []
            return [(row["status"], row["job_name"], row["datastore_id"],
                     row["total_files"], row["processed_files"],
                     row["failed_files"], row["instances_imported"])]

        raise AssertionError(f"FakeConn: unhandled SELECT: {up[:120]}")

    def _update(self, up, params, cursor):
        # ── series ──────────────────────────────────────────────────────────
        if up.startswith("UPDATE SERIES SE SET SE.AVAILABILITY"):
            # Rollup: best state among live instances wins; no live -> OFFLINE.
            # The real SQL passes a single tuple param: WHERE se.series_pkey IN %s.
            pkeys = params[0]
            for row in self.tables["series"]:
                if row["series_pkey"] not in pkeys:
                    continue
                live = [i for i in self.tables["instance"]
                        if i["series_pkey"] == row["series_pkey"]
                        and i["deleted_at"] is None]
                if any(i["instanceavailability"] in (None, "ONLINE") for i in live):
                    row["availability"] = "ONLINE"
                elif any(i["instanceavailability"] == "NEARLINE" for i in live):
                    row["availability"] = "NEARLINE"
                else:
                    row["availability"] = "OFFLINE"
                cursor.rowcount += 1
            return []

        if up.startswith("UPDATE SERIES SET AVAILABILITY = %S"):
            # _set_series_availability (path_ingest): (availability, series_pkey)
            row = self._find("series", series_pkey=params[1])
            if row:
                row["availability"] = params[0]
                cursor.rowcount = 1
            return []

        if up.startswith("UPDATE SERIES SET SERIESINSTANCEUID"):
            # sidecar re-sync: (seriesinstanceuid, seriesdescription, series_pkey)
            row = self._find("series", series_pkey=params[-1])
            if row:
                row["seriesinstanceuid"] = params[0]
                row["seriesdescription"] = params[1]
                if "DELETED_AT=NULL" in up.replace(" ", ""):
                    row["deleted_at"] = None   # only if the SQL itself revives
                cursor.rowcount = 1
            return []

        if up.startswith("UPDATE SERIES SET LAST_UPDATED") or \
                up.startswith("UPDATE `SERIES` SET LAST_UPDATED"):
            cursor.rowcount = 0  # _propagate_last_updated: best-effort, modelled as no-op
            return []

        if up.startswith("UPDATE SERIES SE"):
            cursor.rowcount = 0  # _recompute_aggregates: best-effort, modelled as no-op
            return []

        # ── study ───────────────────────────────────────────────────────────
        if up.startswith("UPDATE STUDY SET PATIENT_PKEY"):
            # sidecar re-sync: (patient_pkey, studyinstanceuid, studydate,
            # accessionnumber, referringphysicianname, studydescription,
            # studyid, study_pkey)
            row = self._find("study", study_pkey=params[-1])
            if row:
                row["patient_pkey"] = params[0]
                row["studyinstanceuid"] = params[1]
                if "DELETED_AT=NULL" in up.replace(" ", ""):
                    row["deleted_at"] = None   # only if the SQL itself revives
                cursor.rowcount = 1
            return []

        if up.startswith("UPDATE STUDY ST"):
            cursor.rowcount = 0  # _recompute_aggregates: best-effort, modelled as no-op
            return []

        if up.startswith("UPDATE STUDY SET LAST_UPDATED") or \
                up.startswith("UPDATE `STUDY` SET LAST_UPDATED"):
            cursor.rowcount = 0  # _propagate_last_updated: best-effort, modelled as no-op
            return []

        # ── revive-parent (get-or-create HIT path) ──────────────────────────
        # _revive_parent: UPDATE <table> SET deleted_at = NULL
        #                 WHERE <pkey> = %s AND deleted_at IS NOT NULL
        for _tbl, _pk in (("PATIENT", "patient_pkey"), ("STUDY", "study_pkey"),
                          ("SERIES", "series_pkey")):
            if up.startswith(f"UPDATE {_tbl} SET DELETED_AT = NULL WHERE {_pk.upper()}"):
                row = self._find(_tbl.lower(), **{_pk: params[0]})
                if row and row.get("deleted_at") is not None:
                    row["deleted_at"] = None
                    cursor.rowcount = 1
                return []

        if up.startswith("UPDATE PATIENT SET LAST_UPDATED") or \
                up.startswith("UPDATE `PATIENT` SET LAST_UPDATED"):
            cursor.rowcount = 0  # _propagate_last_updated: best-effort, modelled as no-op
            return []

        # ── instance ────────────────────────────────────────────────────────
        if up.startswith("UPDATE INSTANCE SET CONTENT_PKEY"):
            # link the instance to its physical object: (content_pkey, instanceid)
            row = self._find("instance", instanceid=params[1])
            if row:
                row["content_pkey"] = params[0]
                cursor.rowcount = 1
            return []

        if up.startswith("UPDATE INSTANCE SET INSTANCEAVAILABILITY = 'OFFLINE'"):
            # WSI removal: content_pkey IN (SELECT ... FROM storage_index ...)
            bucket, key, ds_id = params
            cpkeys = self._content_pkeys_for_key(bucket, key)
            for row in self.tables["instance"]:
                if (row.get("content_pkey") in cpkeys
                        and row["datastore_id"] == ds_id
                        and row["deleted_at"] is None):
                    row["instanceavailability"] = "OFFLINE"
                    cursor.rowcount += 1
            return []

        if up.startswith("UPDATE INSTANCE SET INSTANCEAVAILABILITY = %S"):
            availability, bucket, key, ds_id = params
            cpkeys = self._content_pkeys_for_key(bucket, key)
            for row in self.tables["instance"]:
                if (row.get("content_pkey") in cpkeys
                        and row["datastore_id"] == ds_id
                        and row["deleted_at"] is None):
                    row["instanceavailability"] = availability
                    cursor.rowcount += 1
            return []

        if up.startswith("UPDATE INSTANCE SET DELETED_AT = NOW() WHERE INSTANCEID IN"):
            ids = set(params)
            for row in self.tables["instance"]:
                if row["instanceid"] in ids and row["deleted_at"] is None:
                    row["deleted_at"] = "now"
                    cursor.rowcount += 1
            return []

        if up.startswith("UPDATE STORAGE_INDEX SET DELETED_AT = NOW() WHERE DATASTORE_ID"):
            # _soft_delete_storage_for_key: (datastore_id, key, key, bucket).
            ds_id, key, _key, bucket = params
            for row in self.tables["storage_index"]:
                if (row["datastore_id"] == ds_id and row["s3_key"] == key
                        and row["s3_bucket_name"] == bucket
                        and row.get("deleted_at") is None):
                    row["deleted_at"] = "now"
                    cursor.rowcount += 1
            return []

        if up.startswith("UPDATE STORAGE_INDEX SET DELETED_AT = NOW() WHERE CONTENT_PKEY IN"):
            cpks = set(params)
            for row in self.tables["storage_index"]:
                if row["content_pkey"] in cpks and row.get("deleted_at") is None:
                    row["deleted_at"] = "now"
                    cursor.rowcount += 1
            return []

        if up.startswith("UPDATE INSTANCE SET DELETED_AT = NOW()"):
            bucket, key, ds_id = params
            cpkeys = self._content_pkeys_for_key(bucket, key)
            for row in self.tables["instance"]:
                if (row.get("content_pkey") in cpkeys
                        and row["datastore_id"] == ds_id
                        and row["deleted_at"] is None):
                    row["deleted_at"] = "now"
                    cursor.rowcount += 1
            return []

        if up.startswith("UPDATE INSTANCE SET INSTANCEID"):
            # sidecar UID re-sync: (instanceid, sopinstanceuid, old_instanceid).
            # ON UPDATE CASCADE carries Instancemetadata's FK along — but
            # Instancemetadata is keyed on instance_pkey, which does NOT change,
            # so no cascade is needed for it; the instance row's new instanceid
            # is enough.
            new_id, new_uid, old_id = params
            for row in self.tables["instance"]:
                if row["instanceid"] == old_id:
                    row["instanceid"] = new_id
                    row["sopinstanceuid"] = new_uid
                    cursor.rowcount += 1
            return []

        if up.startswith("UPDATE INSTANCE SET SOPINSTANCEUID"):
            new_uid, old_id = params
            for row in self.tables["instance"]:
                if row["instanceid"] == old_id:
                    row["sopinstanceuid"] = new_uid
                    cursor.rowcount += 1
            return []

        # ── Instancemetadata ────────────────────────────────────────────────
        if up.startswith("UPDATE INSTANCEMETADATA SET METADATA"):
            # keyed on instance_pkey now: (metadata, instance_pkey)
            row = self._find("Instancemetadata", instance_pkey=params[1])
            if row:
                row["metadata"] = params[0]
                cursor.rowcount = 1
            return []

        # ── import_jobs ─────────────────────────────────────────────────────
        if up.startswith("UPDATE IMPORT_JOBS SET PROCESSED_FILES"):
            count_file, instances, size_bytes, job_id = params
            row = self._find("import_jobs", id=job_id)
            if row:
                row["processed_files"] += count_file
                row["instances_imported"] += instances
                row["total_size_bytes"] += size_bytes
                self._recompute_progress(row)
                cursor.rowcount = 1
            return []

        if up.startswith("UPDATE IMPORT_JOBS SET FAILED_FILES"):
            # failed_files always increments by a literal 1 in the SQL
            # (visibility over arithmetic purity — see import_jobs docstring).
            message, max_details, key, _message2, job_id = params
            row = self._find("import_jobs", id=job_id)
            if row:
                row["failed_files"] += 1
                row["error_message"] = message
                if len(row["error_details"]) < max_details:
                    row["error_details"].append({"key": key, "error": message})
                self._recompute_progress(row)
                cursor.rowcount = 1
            return []

        if up.startswith("UPDATE IMPORT_JOBS SET STATUS"):
            job_id, statuses = params
            row = self._find("import_jobs", id=job_id)
            if (row and row["status"] in statuses and row["total_files"] > 0
                    and row["processed_files"] + row["failed_files"] >= row["total_files"]):
                row["status"] = ("COMPLETED_WITH_FAILURES"
                                 if row["failed_files"] > 0 else "COMPLETED")
                row["completed_at"] = "now"
                row["progress_percentage"] = 100.0
                cursor.rowcount = 1
            return []

        if up.startswith("UPDATE DATASTORES D JOIN IMPORT_JOBS J"):
            # backfill job completion clears SYNCING; no datastore rows modelled here
            cursor.rowcount = 0
            return []

        if up.startswith("UPDATE NON_DICOM_IMPORTS SET STATUS"):
            description, job_id = params
            new_status = "COMPLETED" if "STATUS = 'COMPLETED'" in up else "FAILED"
            n = 0
            for row in self.tables.setdefault("non_dicom_imports", []):
                if row.get("import_job_id") == job_id and row.get("status") == "IMPORTING":
                    row["status"] = new_status
                    row["status_description"] = description
                    n += 1
            cursor.rowcount = n
            return []

        raise AssertionError(f"FakeConn: unhandled UPDATE: {up[:120]}")

    @staticmethod
    def _recompute_progress(row):
        done = row["processed_files"] + row["failed_files"]
        row["progress_percentage"] = min(
            100.0, round(100.0 * done / max(row["total_files"], 1), 2))


@pytest.fixture
def fake_conn():
    return FakeConn()


# ── In-memory fake S3 ─────────────────────────────────────────────────────────
class _Body:
    """Streaming body: read(size) honors size, like botocore's StreamingBody.

    tarfile stream mode ('r|*') reads the body in bounded chunks, so returning
    everything on read(n) would break it.
    """

    def __init__(self, data):
        self._data = data
        self._pos = 0

    def read(self, size=-1):
        if size is None or size < 0:
            out = self._data[self._pos:]
            self._pos = len(self._data)
        else:
            out = self._data[self._pos:self._pos + size]
            self._pos += len(out)
        return out

    def close(self):
        pass


class FakeS3:
    """Serves objects from an in-memory dict; supports Range, head_object and
    upload_fileobj (the unpack-on-ingest path PUTs extracted members back)."""

    class exceptions:
        NoSuchKey = type("NoSuchKey", (Exception,), {})

    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.get_calls = []
        self.uploads = []  # (bucket, key) in upload order

    def put(self, bucket, key, data):
        self.objects[(bucket, key)] = data

    def get_object(self, Bucket, Key, Range=None):
        data = self.objects.get((Bucket, Key))
        if data is None:
            raise self.exceptions.NoSuchKey(f"{Bucket}/{Key}")
        self.get_calls.append((Bucket, Key, Range))
        if Range:
            lo, hi = Range.replace("bytes=", "").split("-")
            lo, hi = int(lo), int(hi)
            body = data[lo:hi + 1]
            # Real S3 answers a ranged GET with ContentRange; the ingest header
            # reader uses the total to know where the object ends.
            return {
                "Body": _Body(body),
                "ContentRange": f"bytes {lo}-{lo + max(len(body) - 1, 0)}/{len(data)}",
            }
        return {"Body": _Body(data)}

    def head_object(self, Bucket, Key):
        data = self.objects.get((Bucket, Key))
        if data is None:
            raise self.exceptions.NoSuchKey(f"{Bucket}/{Key}")
        return {"ContentLength": len(data)}

    def upload_fileobj(self, fileobj, bucket, key):
        self.objects[(bucket, key)] = fileobj.read()
        self.uploads.append((bucket, key))


@pytest.fixture
def fake_s3():
    return FakeS3()


class DiskS3:
    """Serves byte ranges out of files on disk instead of holding them in memory.

    Lets tests run over multi-hundred-megabyte archives/slides and still count
    exactly how many round trips and bytes a walk cost. `head_ok=False` makes
    head_object raise, pinning that the tar walk never needs a HEAD (the ranged
    GET's ContentRange already told it the size).
    """

    class exceptions:
        NoSuchKey = type("NoSuchKey", (Exception,), {})

    def __init__(self, head_ok=False):
        self.objects = {}
        self.gets = 0
        self.bytes = 0
        self.head_ok = head_ok

    def put(self, bucket, key, path):
        self.objects[(bucket, key)] = path

    def get_object(self, Bucket, Key, Range=None):
        path = self.objects.get((Bucket, Key))
        if path is None:
            raise self.exceptions.NoSuchKey(f"{Bucket}/{Key}")
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if Range:
                lo, hi = Range.replace("bytes=", "").split("-")
                lo, hi = int(lo), min(int(hi), size - 1)
                f.seek(lo)
                data = f.read(hi - lo + 1)
                self.gets += 1
                self.bytes += len(data)
                return {"Body": _Body(data),
                        "ContentRange":
                            f"bytes {lo}-{lo + max(len(data) - 1, 0)}/{size}"}
            data = f.read()
        self.gets += 1
        self.bytes += len(data)
        return {"Body": _Body(data)}

    def head_object(self, Bucket, Key):
        if not self.head_ok:
            raise AssertionError("ingest should not need head_object on a tar")
        path = self.objects.get((Bucket, Key))
        if path is None:
            raise self.exceptions.NoSuchKey(f"{Bucket}/{Key}")
        return {"ContentLength": os.path.getsize(path)}


# ── Fake EventBridge / SQS clients ────────────────────────────────────────────
class FakeEvents:
    def __init__(self):
        self.calls = []    # each PutEvents batch, as passed
        self.entries = []  # flattened

    def put_events(self, Entries):
        self.calls.append(list(Entries))
        self.entries.extend(Entries)
        return {"FailedEntryCount": 0}

    def of_type(self, detail_type):
        import json
        return [json.loads(e["Detail"]) for e in self.entries
                if e["DetailType"] == detail_type]


@pytest.fixture
def fake_events(monkeypatch):
    """Capture index_events emission (sets a bus name so it isn't skipped)."""
    import index_events
    fe = FakeEvents()
    monkeypatch.setattr(index_events, "_events_client", fe)
    monkeypatch.setattr(index_events, "EVENT_BUS_NAME", "test-bus")
    return fe


class FakeSQS:
    def __init__(self):
        self.messages = []  # (QueueUrl, parsed body)

    def send_message(self, QueueUrl, MessageBody):
        import json
        self.messages.append((QueueUrl, json.loads(MessageBody)))
        return {"MessageId": "fake"}


@pytest.fixture
def fake_dlq(monkeypatch):
    """Capture the handler's permanent-failure DLQ forwards."""
    import engine as H
    fq = FakeSQS()
    monkeypatch.setattr(H, "sqs_client", fq)
    monkeypatch.setattr(H, "INGEST_DLQ_URL", "https://sqs.test/ingest-dlq")
    return fq


# ── Datastores ────────────────────────────────────────────────────────────────
DS_A = "11111111-1111-4111-8111-111111111111"
DS_B = "22222222-2222-4222-8222-222222222222"


@pytest.fixture
def datastore():
    """A resolved Datastore for direct _handle_* calls (bucket 'bkt')."""
    import engine as H
    return H.Datastore(id=DS_A, bucket="bkt", prefix="")


@pytest.fixture(autouse=True)
def _reset_handler_state():
    """The bucket→datastore cache is module-global; never leak between tests.

    Also bridge dicom_header's own module-global s3_client to whatever the test
    installs on handler.s3_client. The header-prefetch and encapsulated
    frame-offset helpers live in dicom_header and issue their ranged GETs
    through dicom_header.s3_client — a DIFFERENT module global from
    handler.s3_client. In production both are the same boto3 S3 client; in the
    unit run a test monkeypatches handler.s3_client to a FakeS3, so without this
    bridge those ranged reads would hit the None boto3 stub ('NoneType has no
    attribute get_object'). A lazy proxy forwards every attribute access to the
    CURRENT handler.s3_client at call time, so it tracks per-test monkeypatches
    (including FlakyS3 subclasses installed mid-test).
    """
    import engine as H
    import dicom_header as DH

    class _S3Proxy:
        def __getattr__(self, name):
            return getattr(H.s3_client, name)

    H._datastore_cache.clear()
    _saved = DH.s3_client
    DH.s3_client = _S3Proxy()
    yield
    DH.s3_client = _saved
    H._datastore_cache.clear()


# ── DICOM/tar builders (shared by several test modules) ──────────────────────
ROWS = COLS = 16
PIXEL_PATTERN = b"\xA5\x5A"


def make_dicom(sop_uid=None, study_uid="1.2.900.1", series_uid="1.2.900.1.1",
               patient_id="TARPT", bloat=0):
    """A small native Explicit VR LE instance with a recognizable pixel pattern."""
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

    ds = Dataset()
    ds.PatientName = "Tar^Member"
    ds.PatientID = patient_id
    ds.Modality = "CT"
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = sop_uid or generate_uid()
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    if bloat:
        # (0029,1010) sorts after the geometry group, so the header stays parseable
        # while PixelData is pushed past any prefetch window.
        ds.add_new(0x00291010, "OB", b"\x00" * bloat)
    ds.Rows, ds.Columns = ROWS, COLS
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
    ds.SamplesPerPixel, ds.PixelRepresentation = 1, 0
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelData = PIXEL_PATTERN * (ROWS * COLS)

    fm = FileMetaDataset()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm

    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def make_tar(members, fmt=tarfile.GNU_FORMAT, dirs=()):
    """Build an uncompressed tar. `members` is [(name, bytes), ...]."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=fmt) as tf:
        for name in dirs:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            tf.addfile(info)
        for name, data in members:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def tar_expected(tar_bytes):
    """What tarfile itself says the regular members are: name -> (offset, size)."""
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tf:
        return {m.name: (m.offset_data, m.size) for m in tf if m.isfile()}
