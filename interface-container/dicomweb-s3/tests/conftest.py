"""Shared pytest fixtures + import shims for the S3-native DICOMweb service.

Mirrors the Phase-1 harness in
cdk-infrastructure/lib/import/lambda/ingest/tests/conftest.py so a reader
moving between the two suites is not surprised: same stub installers, same
FakeConn/FakeCursor/FakeS3/FakeEvents names, same DictCursor-shaped rows, same
"record every (sql, params) pair" contract.

The differences are all consequences of testing a *reader* instead of a writer:

  * FakeConn grew a small SQL interpreter instead of a statement-shape lookup.
    The read side builds its SQL by f-string composition at request time, so the
    exact text is not knowable from a table of prefixes. The interpreter parses
    the SELECT list, the FROM/JOIN chain (including each ON condition), the
    WHERE conjuncts and ORDER BY/LIMIT, then evaluates them against the row
    store. That buys three things a prefix lookup cannot:
      - a query that reaches Instancelocation/Instancemetadata without the
        instance join returns rows the test can see are wrong, rather than
        silently matching a hand-written expectation;
      - an unqualified `datastore_id = %s` over a multi-table join raises the
        way MySQL 1052 does, and a SELECT-list alias used in WHERE raises the
        way MySQL 1054 does (the two traps in spec 5.1 and 5.7);
      - swapping datastore_id and a UID in the params tuple yields zero rows
        instead of an error, which is exactly the silent failure spec 5.3
        wants pinned.
  * fakes for EventBridge (audit_events) and the OIDC verifier replace the
    ingest suite's SQS/index_events fakes.

The service imports pymysql and boto3 at module load, and a unit run must touch
neither MySQL nor AWS, so the minimum surface for both is stubbed here BEFORE
any service module is imported. The remaining infrastructure-only imports
(dbutils, waitress, requests, jwt, highdicom, botocore) are stubbed only when
the real package is absent, so a CI run with requirements.txt installed
exercises the shipped code paths.

Flask, flask-cors and cachetools are deliberately *not* in that stub list: the
suite drives the real app through Flask's test_client and asserts real TTLCache
eviction, so a stub would only test the stub. They are ordinary requirements.txt
entries, which is why the run recipe installs both requirement files.

No network, no real fixture files: the pixel/geometry fixtures live in the
Phase-1 ingest suite, and everything here is synthesized by make_dicom().

Run (from interface-container/dicomweb-s3):

    python3 -m venv .venv                       # no --system-site-packages
    .venv/bin/pip install -r requirements.txt -r requirements-test.txt
    .venv/bin/python -m pytest tests/ -q

The venv must not inherit system site-packages. A leaked newer pydicom shadows
the pinned pydicom 2.4.x and the suite then passes against an API the container
does not ship; that is exactly how the 3-only `enforce_file_format=` keyword
below went unnoticed.
"""

import gzip
import hashlib
import io
import json
import os
import re
import sys
import types

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
MODULE_DIR = os.path.dirname(TESTS_DIR)          # .../interface-container/dicomweb-s3
REPO_ROOT = os.path.abspath(os.path.join(TESTS_DIR, *[".."] * 3))

if MODULE_DIR not in sys.path:
    sys.path.insert(0, MODULE_DIR)


# ── Dependency stubs (must precede any service-module import) ────────────────
def _install_pymysql_stub():
    if "pymysql" in sys.modules:
        return
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


class _NoAws:
    """Stands in for a boto3 client. Any call is a bug in the test, not a pass.

    Returning None (as the Phase-1 stub does) is fine for a Lambda that only
    ever holds the client in a module global; here bootstrap() builds real
    clients, so a loud failure is what tells a test it forgot to patch one.
    """

    def __init__(self, name="<unknown>"):
        self._name = name

    def __getattr__(self, attr):
        def _refuse(*a, **k):
            raise AssertionError(
                f"unit tests must not call AWS: boto3 {self._name}.{attr}() "
                f"- patch the client onto the module under test instead")
        return _refuse


def _install_boto3_stub():
    if "boto3" in sys.modules:
        return
    boto3 = types.ModuleType("boto3")
    boto3.client = lambda name, *a, **k: _NoAws(name)
    boto3.resource = lambda name, *a, **k: _NoAws(name)
    boto3.session = types.SimpleNamespace(Session=lambda *a, **k: None)
    sys.modules["boto3"] = boto3


def _stub_if_missing(name, build):
    """Install `build()`'s modules only when `name` cannot be imported.

    pymysql and boto3 are stubbed unconditionally above because a unit run must
    not reach MySQL or AWS even where the real clients are importable. These
    others are pure plumbing the service imports at module load; when the real
    package is installed the real one wins, so CI tests the shipped behavior.
    """
    try:
        __import__(name)
        return
    except Exception:
        pass
    for mod_name, module in build().items():
        sys.modules[mod_name] = module


def _build_botocore():
    botocore = types.ModuleType("botocore")
    config = types.ModuleType("botocore.config")

    class Config:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    config.Config = Config
    exceptions = types.ModuleType("botocore.exceptions")
    exceptions.ClientError = ClientError
    botocore.config = config
    botocore.exceptions = exceptions
    return {"botocore": botocore, "botocore.config": config,
            "botocore.exceptions": exceptions}


def _build_dbutils():
    dbutils = types.ModuleType("dbutils")
    pooled = types.ModuleType("dbutils.pooled_db")

    class PooledDB:
        def __init__(self, *a, **k):
            raise AssertionError("unit tests must not open a real MySQL pool")

    pooled.PooledDB = PooledDB
    dbutils.pooled_db = pooled
    return {"dbutils": dbutils, "dbutils.pooled_db": pooled}


def _build_waitress():
    waitress = types.ModuleType("waitress")
    waitress.serve = lambda *a, **k: None
    return {"waitress": waitress}


def _build_requests():
    requests = types.ModuleType("requests")

    def _refuse(*a, **k):
        raise AssertionError("unit tests must not make HTTP calls")

    requests.get = _refuse
    requests.post = _refuse
    exceptions = types.ModuleType("requests.exceptions")
    exceptions.RequestException = type("RequestException", (Exception,), {})
    requests.exceptions = exceptions
    return {"requests": requests, "requests.exceptions": exceptions}


def _build_jwt():
    jwt = types.ModuleType("jwt")
    exceptions = types.ModuleType("jwt.exceptions")

    class InvalidTokenError(Exception):
        pass

    class ExpiredSignatureError(InvalidTokenError):
        pass

    exceptions.InvalidTokenError = InvalidTokenError
    exceptions.ExpiredSignatureError = ExpiredSignatureError
    jwt.exceptions = exceptions
    jwt.InvalidTokenError = InvalidTokenError
    jwt.ExpiredSignatureError = ExpiredSignatureError
    jwt.get_unverified_header = lambda token: {"kid": "stub"}
    jwt.decode = lambda *a, **k: {}
    algorithms = types.ModuleType("jwt.algorithms")
    algorithms.RSAAlgorithm = types.SimpleNamespace(from_jwk=lambda k: object())
    jwt.algorithms = algorithms
    return {"jwt": jwt, "jwt.exceptions": exceptions, "jwt.algorithms": algorithms}


def _build_highdicom():
    highdicom = types.ModuleType("highdicom")
    hd_io = types.ModuleType("highdicom.io")

    class ImageFileReader:
        def __init__(self, *a, **k):
            raise AssertionError(
                "highdicom is not installed; the Tier-3 full-object frame read "
                "is covered by @requires_highdicom tests only")

    hd_io.ImageFileReader = ImageFileReader
    highdicom.io = hd_io
    return {"highdicom": highdicom, "highdicom.io": hd_io}


class ClientError(Exception):
    """botocore.exceptions.ClientError's shape, minus botocore.

    FakeS3 raises this for a missing key so handler code that inspects
    `err.response['Error']['Code']` behaves the same as it does against S3.
    """

    def __init__(self, error_response, operation_name):
        self.response = error_response
        self.operation_name = operation_name
        super().__init__(
            f"An error occurred ({error_response['Error']['Code']}) when "
            f"calling the {operation_name} operation")


_install_pymysql_stub()
_install_boto3_stub()
_stub_if_missing("botocore", _build_botocore)
_stub_if_missing("dbutils", _build_dbutils)
_stub_if_missing("waitress", _build_waitress)
_stub_if_missing("requests", _build_requests)
_stub_if_missing("jwt", _build_jwt)
_stub_if_missing("highdicom", _build_highdicom)


def _importable(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False


requires_highdicom = pytest.mark.skipif(
    not _importable("highdicom.io") or "highdicom" not in sys.modules
    or getattr(sys.modules["highdicom"], "__file__", None) is None,
    reason="highdicom not installed (ships in the container image)")

requires_pyjwt = pytest.mark.skipif(
    getattr(sys.modules.get("jwt"), "__file__", None) is None,
    reason="PyJWT not installed (ships in the container image)")


# ── Identifiers shared by every test module ──────────────────────────────────
# Two datastores holding the SAME study/series/SOP UIDs. Our unique keys are
# composite (datastore_id, uid), so this is a legal state and it is the state
# every tenancy assertion keys off.
DS_A = "11111111-1111-4111-8111-111111111111"
DS_B = "22222222-2222-4222-8222-222222222222"
# A datastore id from a former storage type. The S3-only schema has no storage_type, so
# such a row cannot exist any more; the id is not seeded and must 404 like any
# other unknown id.
DS_FORMER = "33333333-3333-4333-8333-333333333333"
DS_SOFT_DELETED = "44444444-4444-4444-8444-444444444444"  # deleted = TRUE
DS_DELETING = "55555555-5555-4555-8555-555555555555"  # status='DELETING'
DS_UNKNOWN = "66666666-6666-4666-8666-666666666666"   # no row at all

STUDY_UID = "1.2.826.0.1.3680043.10.9999.1"
SERIES_UID = "1.2.826.0.1.3680043.10.9999.1.1"
SERIES_UID_2 = "1.2.826.0.1.3680043.10.9999.1.2"
SERIES_PENDING_UID = "1.2.826.0.1.3680043.10.9999.1.9"
SOP_UID = "1.2.826.0.1.3680043.10.9999.1.1.1"
SOP_UID_2 = "1.2.826.0.1.3680043.10.9999.1.1.2"
SOP_UID_3 = "1.2.826.0.1.3680043.10.9999.1.2.1"
SOP_UID_DELETED = "1.2.826.0.1.3680043.10.9999.1.1.8"
SOP_UID_WSI = "1.2.826.0.1.3680043.10.9999.1.1.7"
SOP_UID_WSI_NATIVE = "1.2.826.0.1.3680043.10.9999.1.1.77"
SOP_UID_ENCAPSULATED = "1.2.826.0.1.3680043.10.9999.1.1.6"

BUCKET_A = "archive-ds-a"
BUCKET_B = "archive-ds-b"

PATIENT_ID = "PT-1"
PATIENT_NAME = "Doe^Jane"
PATIENT_BIRTHDATE = "19700101"
PATIENT_SEX = "F"

# Datastore B's patient carries the SAME PatientID as A's — PatientID is
# assigned by the sending institution, so a shared archive with per-institution
# datastores collides on local ID schemes almost immediately — but belongs to a
# different human. Every demographic differs, so a patient row resolved across
# the tenancy boundary shows up as the wrong name, MRN or birth date rather than
# as an indistinguishable duplicate.
PATIENT_NAME_B = "Leaked^Bob"
PATIENT_BIRTHDATE_B = "19551105"
PATIENT_SEX_B = "M"
ACCESSION = "ACC-000123"
STUDY_DESCRIPTION = "CHEST CT WITH CONTRAST"

# Private DICOM block for the S3 location tags (spec 5.9).
PRIVATE_CREATOR_TAG = "77770010"
PRIVATE_S3KEY_TAG = "77771001"
PRIVATE_S3BUCKET_TAG = "77771002"

WSI_SOP_CLASS_UID = "1.2.840.10008.5.1.4.1.1.77.1.6"
CT_SOP_CLASS_UID = "1.2.840.10008.5.1.4.1.1.2"

IMPLICIT_VR_LE = "1.2.840.10008.1.2"
EXPLICIT_VR_LE = "1.2.840.10008.1.2.1"
JPEG_BASELINE = "1.2.840.10008.1.2.4.50"

ROWS = COLS = 16
PIXEL_A = b"\xA5\x5A"
PIXEL_B = b"\xB6\x6B"


def instance_key(datastore_id, sop_uid):
    """instance.instanceid: a 63-bit hash over 'datastore_id|SOPInstanceUID'.

    Reproduced here (not just a counter) because the same SOP UID in two
    datastores must produce two different keys, and a test that asserts
    Instancelocation is reached only through the instance join needs the keys to
    be genuinely distinct.
    """
    digest = hashlib.sha1(f"{datastore_id}|{sop_uid}".encode()).digest()
    return int.from_bytes(digest[:8], "big") >> 1


# ── Canonical schema (schema-s3-index.sql + schema.sql) ──────────────────────
# patient/study/series/instance mirror schema-s3-index.sql column for column
# (friendly names, not the old d######## tag columns), so a query naming a
# column the real table lacks fails here the way it fails on Aurora.
# The column sets are what make MySQL's ambiguous-column (1052) and
# unknown-column (1054) errors reproducible: resolving a bare column name means
# counting how many joined tables declare it.
_TABLE_COLUMNS = {
    "patient": (
        "patient_pkey", "datastore_id", "patientid", "issuerofpatientid", "patientname",
        "patientbirthdate", "patientsex", "last_updated", "deleted_at",
    ),
    "study": (
        "study_pkey", "patient_pkey", "datastore_id", "specificcharacterset", "studydate",
        "studytime", "accessionnumber", "modalitiesinstudy", "referringphysicianname",
        "studydescription", "studyinstanceuid", "studyid", "numberofstudyrelatedseries",
        "numberofstudyrelatedinstances", "last_updated", "deleted_at",
    ),
    "series": (
        "series_pkey", "study_pkey", "datastore_id", "modality", "seriesdate",
        "seriesdescription", "seriesinstanceuid", "seriesnumber", "imagecount",
        "numberofseriesrelatedinstances", "performedprocedurestepstartdate",
        "performedprocedurestepstarttime", "requestattributessequence",
        "scheduledprocedurestepid", "requestedprocedureid", "patientposition",
        "bodypartexamined", "availability", "last_updated", "deleted_at",
    ),
    "instance": (
        "instance_pkey", "instanceid", "content_pkey", "datastore_id", "seriesid",
        "series_pkey", "transfersyntaxuid", "sopclassuid", "sopinstanceuid",
        "instanceavailability", "timezoneoffsetfromutc", "retrieveurl", "instancenumber",
        "samplesperpixel", "numberofframes", "rows", "columns", "bitsallocated",
        "totalpixelmatrixcolumns", "totalpixelmatrixrows", "dimensionorganizationtype",
        "imagelaterality", "last_updated", "deleted_at",
    ),
    # S3-only physical-object table; replaced Instancelocation. Joined via
    # instance.content_pkey = storage_index.content_pkey.
    "storage_index": (
        "content_pkey", "datastore_id", "s3_bucket_name", "s3_key",
        "s3_key_version", "content_kind", "non_dicom_type",
        "study_instance_uid", "series_instance_uid", "sop_instance_uid",
        "transfer_syntax", "member_offset", "member_length", "size_bytes",
        "deleted_at",
    ),
    "Instancemetadata": (
        "id", "instance_pkey", "content_pkey", "instanceid", "metadata", "metadataendoffset", "frame_offsets",
        "jpeg_tables_offset", "jpeg_tables_length", "icc_profile_offset",
        "icc_profile_length",
    ),
    "datastores": (
        # No storage_type: the S3-only port dropped it (every datastore is S3).
        "id", "name", "description", "status", "datastore_id",
        "s3_bucket_name", "s3_prefix", "deleted",
        # schema.sql: NULL (app-owned) | 'read-only' | 'read-write'. The write
        # paths refuse 'read-only' (writable_destination).
        "access_level",
    ),
    "users": (
        # deleted: privilege_checker filters u.deleted = false (soft-deleted users
        # hold no rights), schema.sql users.deleted BOOLEAN DEFAULT FALSE.
        # Group membership is now the many-to-many user_privilege_groups table.
        "id", "cognito_username", "email", "status", "deleted",
    ),
    "user_privilege_groups": (
        "user_id", "privilege_group_id",
    ),
    "privilege_groups": (
        "id", "name", "datastore_privileges", "virtual_folder_privileges",
        "management_privileges", "deleted",
    ),
    # schema-virtual-folder.sql: the columns the service reads. A path id that is
    # not a datastore is resolved here (datastore_resolver.resolve_virtual_folder),
    # and STOW into a folder reads its write mode (auth_middleware._vf_write_datastore).
    "virtual_folders": (
        "id", "name", "status", "write_mode", "write_datastore_id", "deleted",
    ),
}

# SQL arrives in mixed case; these two tables are the only CamelCase ones.
_TABLE_CANON = {name.lower(): name for name in _TABLE_COLUMNS}

_SOFT_DELETE_TABLES = ("patient", "study", "series", "instance")


def _blank_row(table, **values):
    row = {col: None for col in _TABLE_COLUMNS[table]}
    unknown = set(values) - set(row)
    assert not unknown, f"{table}: no such column(s) {sorted(unknown)}"
    row.update(values)
    return row


# ── SQL text utilities ───────────────────────────────────────────────────────
def normalize_sql(sql):
    """Collapse whitespace so assertions can match on text, as Phase 1 does."""
    return " ".join(sql.split())


def _depth_zero_spans(text, keywords):
    """Offsets of each keyword occurrence that sits outside every paren.

    Derived QIDO columns are parenthesized subqueries carrying their own
    SELECT/FROM/WHERE, so every clause split has to ignore nested depth.
    """
    hits = []
    depth = 0
    i = 0
    upper = text.upper()
    while i < len(text):
        ch = text[i]
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif depth == 0:
            for kw in keywords:
                if upper.startswith(kw, i) and _is_word_boundary(upper, i, len(kw)):
                    hits.append((i, kw))
                    i += len(kw) - 1
                    break
        i += 1
    return hits


def _is_word_boundary(text, start, length):
    before = text[start - 1] if start else " "
    after = text[start + length] if start + length < len(text) else " "
    return not (before.isalnum() or before == "_") and \
        not (after.isalnum() or after == "_")


def split_clauses(sql):
    """{'select','from','where','order','limit'} for one flat SELECT."""
    text = normalize_sql(sql)
    marks = _depth_zero_spans(text, ("SELECT", "FROM", "WHERE", "ORDER BY", "LIMIT"))
    # Only the first depth-zero SELECT matters; a UNION would need more, and the
    # read side emits none.
    bounds = {}
    for idx, (pos, kw) in enumerate(marks):
        end = marks[idx + 1][0] if idx + 1 < len(marks) else len(text)
        key = {"SELECT": "select", "FROM": "from", "WHERE": "where",
               "ORDER BY": "order", "LIMIT": "limit"}[kw]
        bounds.setdefault(key, text[pos + len(kw):end].strip())
    return bounds


def split_top_level(text, sep=","):
    """Split on `sep` at paren depth zero."""
    out, depth, current = [], 0, []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == sep and depth == 0:
            out.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        out.append("".join(current).strip())
    return [item for item in out if item]


_FROM_RE = re.compile(
    r"\b(?P<kind>FROM|(?:LEFT\s+|RIGHT\s+|INNER\s+)?JOIN)\s+"
    r"(?P<table>\w+)"
    r"(?:\s+(?!ON\b|LEFT\b|RIGHT\b|INNER\b|JOIN\b)(?P<alias>\w+))?"
    r"(?:\s+ON\s+(?P<left>[\w.]+)\s*=\s*(?P<right>[\w.]+))?",
    re.I)

# Every WHERE conjunct shape the read side emits, in one alternation so
# finditer yields them in textual order — which is the order the positional
# params are consumed in.
_COND_RE = re.compile(
    r"(?P<col>[\w.]+)\s+(?:"
    r"(?P<between>BETWEEN\s+%s\s+AND\s+%s)"
    r"|(?P<inlist>IN\s*\(\s*%s(?:\s*,\s*%s)*\s*\))"
    r"|(?P<like>LIKE\s+%s)"
    r"|(?P<isnotnull>IS\s+NOT\s+NULL)"
    r"|(?P<isnull>IS\s+NULL)"
    r"|(?P<eqparam>=\s*%s)"
    r"|(?P<eqstr>=\s*'(?P<strlit>[^']*)')"
    r"|(?P<eqbool>=\s*(?P<boollit>TRUE|FALSE))"
    r"|(?P<eqnum>=\s*(?P<numlit>\d+))"
    # Column-to-column equality, which is how an EXISTS subquery correlates to
    # the outer row (`mis.study_pkey = study.study_pkey`). Without this branch
    # the conjunct matches nothing, gets dropped, and the subquery degrades to
    # "does ANY row in the child table match" - so a correlation bug would make
    # the tests pass rather than fail. Both sides must be qualified, which is
    # what the read side emits and keeps this from swallowing a literal.
    r"|(?P<eqcol>=\s*(?P<colref>[A-Za-z_]\w*\.[A-Za-z_]\w*))"
    r")", re.I)


def _exists_spans(text):
    """(start, end, body) for each depth-zero `EXISTS (...)` in a WHERE clause.

    Returned so the conjunct parser can walk an EXISTS and the flat conditions
    around it in one textual pass: positional params are consumed in textual
    order, so an EXISTS that carries its own `%s` has to claim its slots at the
    point where it appears, not before or after the conditions beside it.
    """
    spans = []
    for pos, _kw in _depth_zero_spans(text, ("EXISTS",)):
        open_at = text.find("(", pos)
        if open_at == -1:
            raise SqlError(f"FakeConn: EXISTS without a subquery in {text[:200]}")
        depth = 0
        for idx in range(open_at, len(text)):
            if text[idx] == "(":
                depth += 1
            elif text[idx] == ")":
                depth -= 1
                if depth == 0:
                    spans.append((pos, idx + 1, text[open_at + 1:idx]))
                    break
        else:
            raise SqlError(f"FakeConn: unbalanced EXISTS parens in {text[:200]}")
    return spans


# ── In-memory fake DB ────────────────────────────────────────────────────────
class FakeCursor:
    """Minimal DictCursor over a FakeConn's tables.

    Every (sql, params) pair lands in `conn.log` before evaluation, so a test
    can assert on the emitted text and on positional order even for a query
    that legitimately returns nothing.
    """

    def __init__(self, conn):
        self.conn = conn
        self._rows = []
        self.lastrowid = 0
        self.rowcount = 0

    def execute(self, sql, params=()):
        if params is None:
            params = ()
        if not isinstance(params, (tuple, list)):
            params = (params,)
        self.conn.log.append((normalize_sql(sql), tuple(params)))
        self._rows = self.conn.dispatch(sql, tuple(params))
        self.rowcount = len(self._rows)
        return self.rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


class SqlError(AssertionError):
    """A MySQL rejection the read side must never provoke.

    Raised as an AssertionError subclass so it surfaces as a test failure with
    the offending SQL rather than being swallowed by production `except
    Exception` handlers that only mean to catch driver faults.
    """


class FakeConn:
    """A tiny stand-in for a pooled PyMySQL connection.

    `dispatch` interprets one flat SELECT at a time: it resolves the FROM/JOIN
    chain using each ON condition, evaluates the WHERE conjuncts against the
    joined rows consuming the positional params in textual order, projects the
    SELECT list, then orders and pages. It is not a SQL engine - no aggregates
    outside the recognized derived subqueries, no OR, no expressions - but it is
    faithful on exactly the axes the tenancy and soft-delete rules live on.
    """

    def __init__(self):
        self.log = []
        self.closed = 0
        self.fail_next = None       # set to an Exception to make execute() raise
        self.tables = {name: [] for name in _TABLE_COLUMNS}
        self._pk = {"patient": 0, "study": 0, "series": 0, "instance": 0}
        self._row_id = {"Instancemetadata": 0}
        self._content_pkey = 0

    # -- connection protocol --
    def cursor(self, *a, **k):
        return FakeCursor(self)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        self.closed += 1

    def ping(self, reconnect=True):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    # -- helpers for tests --
    def rows(self, table):
        return self.tables[_TABLE_CANON[table.lower()]]

    def sql_log(self):
        return [sql for sql, _ in self.log]

    def last_sql(self):
        return self.log[-1][0] if self.log else None

    def find(self, table, **filters):
        for row in self.rows(table):
            if all(row.get(k) == v for k, v in filters.items()):
                return row
        return None

    def insert(self, table, **values):
        table = _TABLE_CANON[table.lower()]
        row = _blank_row(table, **values)
        if table in self._pk:
            self._pk[table] += 1
            row.setdefault(f"{table}_pkey", None)
            if row.get(f"{table}_pkey") is None:
                row[f"{table}_pkey"] = self._pk[table]
        if table in self._row_id:
            self._row_id[table] += 1
            row["id"] = self._row_id[table]
        self.tables[table].append(row)
        return row

    def add_location(self, instance_row, bucket, key, *, member_offset=None,
                     member_length=None, size_bytes=None):
        """The physical object of an instance: one storage_index row, linked by
        instance.content_pkey (the S3-only replacement for Instancelocation)."""
        self._content_pkey += 1
        loc = self.insert("storage_index", content_pkey=self._content_pkey,
                          datastore_id=instance_row["datastore_id"], s3_bucket_name=bucket,
                          s3_key=key, content_kind="DICOM",
                          sop_instance_uid=instance_row["sopinstanceuid"],
                          member_offset=member_offset, member_length=member_length,
                          size_bytes=size_bytes)
        instance_row["content_pkey"] = loc["content_pkey"]
        return loc

    def _settle_aggregates(self):
        """Keep the stored study/series aggregates current, as ingest does.

        The service reads study.numberofstudyrelatedseries /
        numberofstudyrelatedinstances / modalitiesinstudy and
        series.numberofseriesrelatedinstances instead of counting (0f7c288);
        ingest-v3 recomputes them after every commit over live rows only, with
        modalities as a sorted, backslash-joined DISTINCT list. Recomputing here
        before each read gives the same picture for any rows a test seeds or
        soft-deletes."""
        for series in self.tables["series"]:
            series["numberofseriesrelatedinstances"] = len(self._live_instances(series))
        for study in self.tables["study"]:
            live = self._live_series(study)
            study["numberofstudyrelatedseries"] = len(live)
            study["numberofstudyrelatedinstances"] = sum(len(self._live_instances(x)) for x in live)
            modalities = sorted({x["modality"] for x in live if x["modality"]})
            study["modalitiesinstudy"] = "\\".join(modalities) or None

    # ── dispatch ────────────────────────────────────────────────────────────
    def dispatch(self, sql, params):
        if self.fail_next is not None:
            err, self.fail_next = self.fail_next, None
            raise err
        self._settle_aggregates()

        text = normalize_sql(sql)
        upper = text.upper()
        if not upper.startswith("SELECT"):
            raise SqlError(f"FakeConn: the read side issues SELECTs only: {text[:120]}")

        # /dicomweb/health probes liveness and must not name an index table.
        if re.match(r"SELECT\s+1\b", upper):
            for table in _TABLE_COLUMNS:
                assert table.upper() not in upper, \
                    f"health probe must not reference {table}: {text}"
            return [{"1": 1}]

        clauses = split_clauses(text)
        joined, aliases = self._resolve_from(clauses.get("from", ""), text)
        rows = self._apply_where(joined, aliases, clauses.get("where", ""), params, text)
        rows = self._order(rows, aliases, clauses.get("order"), text)
        rows = self._page(rows, clauses.get("limit"))
        return [self._project(row, aliases, clauses["select"], text) for row in rows]

    # ── FROM / JOIN ─────────────────────────────────────────────────────────
    def _resolve_from(self, from_clause, text):
        specs = []
        # split_clauses drops the keyword it split on, but _FROM_RE keys off it to
        # tell the base table apart from a joined one, so it goes back on here.
        if from_clause:
            from_clause = "FROM " + from_clause
        for m in _FROM_RE.finditer(from_clause):
            table = _TABLE_CANON.get(m.group("table").lower())
            if table is None:
                raise SqlError(f"FakeConn: unknown table {m.group('table')!r} in {text[:160]}")
            specs.append({
                "table": table,
                "alias": m.group("alias") or table,
                "left": bool(re.match(r"LEFT", m.group("kind"), re.I)),
                "on": (m.group("left"), m.group("right")),
            })
        if not specs:
            raise SqlError(f"FakeConn: no FROM clause in {text[:160]}")

        aliases = {}
        for spec in specs:
            if spec["alias"] in aliases:
                raise SqlError(f"FakeConn: duplicate alias {spec['alias']!r} in {text[:160]}")
            aliases[spec["alias"]] = spec["table"]

        base = specs[0]
        joined = [{base["alias"]: row} for row in self.tables[base["table"]]]
        for spec in specs[1:]:
            left, right = spec["on"]
            if not left or not right:
                raise SqlError(
                    f"FakeConn: JOIN {spec['table']} needs an ON condition: {text[:160]}")
            joined = self._join(joined, spec, left, right, aliases, text)
        return joined, aliases

    def _join(self, joined, spec, left, right, aliases, text):
        new_alias = spec["alias"]
        pairs = []
        for side in (left, right):
            alias, _, col = side.partition(".")
            if not col:
                raise SqlError(
                    f"FakeConn: ON conditions must be table-qualified, got {side!r}: {text[:160]}")
            pairs.append((alias, col))
        (a_alias, a_col), (b_alias, b_col) = pairs
        if a_alias == new_alias:
            new_col, existing_alias, existing_col = a_col, b_alias, b_col
        elif b_alias == new_alias:
            new_col, existing_alias, existing_col = b_col, a_alias, a_col
        else:
            raise SqlError(
                f"FakeConn: ON condition does not mention {new_alias!r}: {text[:160]}")
        for alias, col, table in ((new_alias, new_col, spec["table"]),
                                  (existing_alias, existing_col, aliases.get(existing_alias))):
            if table is None or col not in _TABLE_COLUMNS[table]:
                raise SqlError(
                    f"FakeConn: unknown join column {alias}.{col}: {text[:160]}")

        out = []
        for partial in joined:
            if existing_alias not in partial:
                raise SqlError(
                    f"FakeConn: JOIN references {existing_alias!r} before it is joined: {text[:160]}")
            anchor = partial[existing_alias]
            key = anchor.get(existing_col) if anchor else None
            matches = [row for row in self.tables[spec["table"]]
                       if key is not None and row.get(new_col) == key]
            if matches:
                for row in matches:
                    merged = dict(partial)
                    merged[new_alias] = row
                    out.append(merged)
            elif spec["left"]:
                merged = dict(partial)
                merged[new_alias] = None
                out.append(merged)
        return out

    # ── WHERE ───────────────────────────────────────────────────────────────
    def _apply_where(self, joined, aliases, where, params, text):
        if not where:
            assert not params, f"FakeConn: {len(params)} params but no WHERE: {text[:160]}"
            return joined

        conds, consumed = self._parse_conds(where, text)

        # A desync here means the WHERE contains a shape this fake does not
        # model, and every later param would be compared against the wrong
        # column - the exact silent failure the suite exists to catch.
        placeholders = where.count("%s")
        if placeholders != consumed:
            raise SqlError(
                f"FakeConn: {placeholders} placeholders but {consumed} parsed "
                f"conditions in WHERE: {where[:200]}")
        assert len(params) == consumed, (
            f"FakeConn: query wants {consumed} params, got {len(params)}: {text[:200]}")

        out = []
        for partial in joined:
            if all(self._matches(partial, aliases, kind, col, arg, n, params, text)
                   for kind, col, arg, n in conds):
                out.append(partial)
        return out

    def _parse_conds(self, where, text):
        """Parse one WHERE into (conds, params_consumed).

        Param offsets are relative to the first `%s` in `where`, so the caller
        owns the slice: the outer clause passes the whole param tuple, and an
        EXISTS body gets only its own window.

        EXISTS spans and the flat conjuncts beside them are merged in TEXTUAL
        order, because that is the order MySQL binds positional params - an
        EXISTS carrying `%s` must claim its slots where it sits in the string.
        """
        exists = _exists_spans(where)
        items = [(start, ("exists", body, end)) for start, end, body in exists]
        for m in _COND_RE.finditer(where):
            # Conjuncts inside an EXISTS belong to that subquery's own parse.
            if any(start <= m.start() < end for start, end, _ in exists):
                continue
            items.append((m.start(), ("cond", m, None)))
        items.sort(key=lambda item: item[0])

        conds, consumed = [], 0
        for _pos, (kind, payload, _end) in items:
            if kind == "exists":
                count = payload.count("%s")
                conds.append(("exists", payload, consumed, count))
                consumed += count
                continue
            m = payload
            col = m.group("col")
            if m.group("between"):
                conds.append(("between", col, consumed, 2))
                consumed += 2
            elif m.group("inlist"):
                count = m.group("inlist").count("%s")
                conds.append(("in", col, consumed, count))
                consumed += count
            elif m.group("like"):
                conds.append(("like", col, consumed, 1))
                consumed += 1
            elif m.group("isnull"):
                conds.append(("isnull", col, None, 0))
            elif m.group("isnotnull"):
                conds.append(("isnotnull", col, None, 0))
            elif m.group("eqparam"):
                conds.append(("eq", col, consumed, 1))
                consumed += 1
            elif m.group("eqstr"):
                conds.append(("lit", col, m.group("strlit"), 0))
            elif m.group("eqbool"):
                conds.append(("lit", col, m.group("boollit").upper() == "TRUE", 0))
            elif m.group("eqnum"):
                conds.append(("lit", col, int(m.group("numlit")), 0))
            elif m.group("eqcol"):
                conds.append(("eqcol", col, m.group("colref"), 0))

        return conds, consumed

    def _exists(self, partial, aliases, body, params, text):
        """Evaluate one correlated `EXISTS (SELECT 1 FROM t alias WHERE ...)`.

        The outer row stays visible: inner aliases are layered ON TOP of the
        outer ones and the candidate child row is merged into the outer partial,
        so a correlation predicate resolves against the outer row exactly as
        MySQL would. `params` is already sliced to this subquery's window.
        """
        clauses = split_clauses(body)
        from_clause = clauses.get("from", "")
        if not from_clause:
            raise SqlError(f"FakeConn: EXISTS subquery has no FROM: {body[:160]}")
        m = _FROM_RE.search("FROM " + from_clause)
        table = _TABLE_CANON.get(m.group("table").lower()) if m else None
        if table is None:
            raise SqlError(f"FakeConn: unknown table in EXISTS subquery: {body[:160]}")
        alias = m.group("alias") or table
        inner_aliases = {**aliases, alias: table}

        conds, consumed = self._parse_conds(clauses.get("where", ""), body)
        placeholders = body.count("%s")
        if placeholders != consumed:
            raise SqlError(
                f"FakeConn: {placeholders} placeholders but {consumed} parsed "
                f"conditions in EXISTS: {body[:200]}")

        for row in self.tables[table]:
            merged = dict(partial)
            merged[alias] = row
            if all(self._matches(merged, inner_aliases, kind, col, arg, n, params, body)
                   for kind, col, arg, n in conds):
                return True
        return False

    def _matches(self, partial, aliases, kind, col, arg, n, params, text):
        # Before _column: an EXISTS carries a subquery body, not a column
        # reference, so resolving it as one would raise a bogus 1054.
        if kind == "exists":
            return self._exists(partial, aliases, col, params[arg:arg + n], text)
        value = self._column(partial, aliases, col, text)
        if kind == "eqcol":
            return _sql_eq(value, self._column(partial, aliases, arg, text))
        if kind == "isnull":
            return value is None
        if kind == "isnotnull":
            return value is not None
        if kind == "lit":
            return value == arg
        if kind == "eq":
            return _sql_eq(value, params[arg])
        if kind == "in":
            return any(_sql_eq(value, p) for p in params[arg:arg + n])
        if kind == "like":
            pattern = str(params[arg]).replace("%", "*")
            return value is not None and _sql_like(str(value), pattern)
        if kind == "between":
            lo, hi = params[arg], params[arg + 1]
            return value is not None and str(lo) <= str(value) <= str(hi)
        raise SqlError(f"FakeConn: unhandled condition {kind}")

    # ── column resolution ───────────────────────────────────────────────────
    def _column(self, partial, aliases, reference, text):
        # MySQL identifier quoting: the service backticks reserved words such as
        # `rows` (i.`rows`), which names the same column as the bare word.
        reference = reference.replace("`", "")
        alias, _, col = reference.partition(".")
        if col:
            if alias not in aliases:
                raise SqlError(
                    f"FakeConn: MySQL 1054 unknown table alias {alias!r} in {text[:200]}")
            if col not in _TABLE_COLUMNS[aliases[alias]]:
                raise SqlError(
                    f"FakeConn: MySQL 1054 unknown column {alias}.{col} in {text[:200]}")
            row = partial.get(alias)
            return row.get(col) if row else None

        owners = [a for a, table in aliases.items() if reference in _TABLE_COLUMNS[table]]
        if not owners:
            # A SELECT-list alias used in WHERE lands here: spec 5.7's 1054 trap.
            raise SqlError(
                f"FakeConn: MySQL 1054 unknown column {reference!r} in {text[:200]}")
        if len(owners) > 1:
            raise SqlError(
                f"FakeConn: MySQL 1052 column {reference!r} in where clause is "
                f"ambiguous (declared by {sorted(owners)}) in {text[:200]}")
        row = partial.get(owners[0])
        return row.get(reference) if row else None

    # ── ORDER BY / LIMIT ────────────────────────────────────────────────────
    def _order(self, rows, aliases, order, text):
        if not order:
            return rows
        column = order.split()[0]
        assert "." in column, \
            f"ORDER BY must be table-qualified for deterministic paging: {text[:160]}"
        return sorted(rows, key=lambda r: _sort_key(self._column(r, aliases, column, text)))

    @staticmethod
    def _page(rows, limit):
        if not limit:
            return rows
        parts = [p.strip() for p in limit.split(",")]
        if len(parts) == 2:
            offset, count = int(parts[0]), int(parts[1])
        else:
            offset, count = 0, int(parts[0])
        return rows[offset:offset + count]

    # ── SELECT list ─────────────────────────────────────────────────────────
    def _project(self, partial, aliases, select, text):
        out = {}
        for item in split_top_level(select):
            if item.endswith(".*"):
                alias = item[:-2].strip()
                if alias not in aliases:
                    raise SqlError(f"FakeConn: unknown alias in {item!r}: {text[:160]}")
                row = partial.get(alias) or {}
                for col in _TABLE_COLUMNS[aliases[alias]]:
                    out[col] = row.get(col)
                continue

            expr, alias = _split_alias(item)
            key = alias or expr.rpartition(".")[2]
            out[key] = self._evaluate(partial, aliases, expr, alias, item, text)
        return out

    def _evaluate(self, partial, aliases, expr, alias, item, text):
        if expr.startswith("("):
            return self._derived(partial, aliases, alias, item, text)

        coalesce = re.match(r"COALESCE\s*\(\s*([\w.]+)\s*,\s*'([^']*)'\s*\)$", expr, re.I)
        if coalesce:
            value = self._column(partial, aliases, coalesce.group(1), text)
            return coalesce.group(2) if value is None else value

        return self._column(partial, aliases, expr, text)

    def _derived(self, partial, aliases, alias, item, text):
        """The five computed QIDO columns, dispatched on their SELECT alias.

        Dispatching on the alias rather than the subquery text keeps the fake
        from pinning one exact f-string, but the soft-delete filter is still
        asserted: a derived count that stops filtering deleted_at would inflate
        _numstudyseries and friends with rows no reader may see.
        """
        assert alias, f"FakeConn: derived column needs an AS alias: {item[:160]}"
        assert re.search(r"DELETED_AT\s+IS\s+NULL", item, re.I), \
            f"derived column {alias} must filter deleted_at IS NULL: {item[:200]}"

        study = partial.get(_alias_of(aliases, "study"))
        series = partial.get(_alias_of(aliases, "series"))

        if alias == "_numstudyseries":
            return len(self._live_series(study))
        if alias == "_numstudyinstances":
            return sum(len(self._live_instances(s)) for s in self._live_series(study))
        if alias == "_modalitiesinstudy":
            modalities = sorted({s["modality"] for s in self._live_series(study)
                                 if s["modality"]})
            # GROUP_CONCAT comes back from PyMySQL as bytes; _serialize_value
            # decodes it, and that path only gets exercised if the fake agrees.
            return "\\".join(modalities).encode() if modalities else None
        if alias == "_seriesinstances":
            return len(self._live_instances(series))
        if alias == "_availability":
            return self._study_availability(study)
        raise SqlError(f"FakeConn: unrecognized derived column {alias!r}: {item[:160]}")

    def _live_series(self, study):
        if not study:
            return []
        return [s for s in self.tables["series"]
                if s["study_pkey"] == study["study_pkey"] and s["deleted_at"] is None]

    def _live_instances(self, series):
        if not series:
            return []
        return [i for i in self.tables["instance"]
                if i["series_pkey"] == series["series_pkey"] and i["deleted_at"] is None]

    def _study_availability(self, study):
        """Best-state-wins rollup over the study's live series (spec 6.2)."""
        states = [s["availability"] for s in self._live_series(study)]
        if any(state in (None, "ONLINE") for state in states):
            return "ONLINE"
        if any(state == "NEARLINE" for state in states):
            return "NEARLINE"
        return "OFFLINE"


def _alias_of(aliases, table):
    for alias, name in aliases.items():
        if name == table:
            return alias
    return None


def _split_alias(item):
    m = re.search(r"\s+AS\s+(?P<alias>\w+)\s*$", item, re.I)
    if not m:
        return item.strip(), None
    return item[:m.start()].strip(), m.group("alias")


def _sql_eq(value, param):
    if value is None:
        return False
    if isinstance(value, int) and not isinstance(value, bool):
        try:
            return value == int(param)
        except (TypeError, ValueError):
            return False
    return str(value) == str(param)


def _sql_like(value, pattern):
    return re.fullmatch(re.escape(pattern).replace(r"\*", ".*"), value) is not None


def _sort_key(value):
    return (value is None, value if value is not None else 0)


class FakePool:
    """A DBUtils PooledDB stand-in: connection() always hands back the same
    FakeConn, so a test can inspect one SQL log across a whole request."""

    def __init__(self, conn):
        self.conn = conn
        self.handouts = 0

    def connection(self):
        self.handouts += 1
        return self.conn


@pytest.fixture
def fake_conn():
    return FakeConn()


# ── In-memory fake S3 ────────────────────────────────────────────────────────
class _Body:
    """Streaming body: read(size) honors size, like botocore's StreamingBody."""

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

    def iter_chunks(self, chunk_size=1024):
        """botocore's StreamingBody.iter_chunks - what the bulk streamer uses."""
        while True:
            chunk = self.read(chunk_size)
            if not chunk:
                return
            yield chunk

    def close(self):
        pass


class FakeS3:
    """Serves objects from an in-memory dict, honoring byte ranges.

    `get_calls` is what the availability tests assert on: a non-ONLINE instance
    must produce no S3 read at all, not a read whose result is discarded.
    """

    class exceptions:
        NoSuchKey = type("NoSuchKey", (Exception,), {})

    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.get_calls = []       # (Bucket, Key, Range)

    def put(self, bucket, key, data):
        self.objects[(bucket, key)] = data

    def get_object(self, Bucket, Key, Range=None):
        self.get_calls.append((Bucket, Key, Range))
        data = self.objects.get((Bucket, Key))
        if data is None:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey",
                           "Message": "The specified key does not exist."}},
                "GetObject")
        if Range:
            lo, hi = Range.replace("bytes=", "").split("-")
            lo, hi = int(lo), int(hi)
            body = data[lo:hi + 1]
            return {"Body": _Body(body),
                    "ContentLength": len(body),
                    "ContentRange": f"bytes {lo}-{lo + max(len(body) - 1, 0)}/{len(data)}"}
        return {"Body": _Body(data), "ContentLength": len(data)}

    def head_object(self, Bucket, Key):
        data = self.objects.get((Bucket, Key))
        if data is None:
            raise ClientError(
                {"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return {"ContentLength": len(data)}

    def ranges_for(self, bucket, key):
        return [rng for b, k, rng in self.get_calls if (b, k) == (bucket, key)]


@pytest.fixture
def fake_s3():
    return FakeS3()


# ── Fake EventBridge ─────────────────────────────────────────────────────────
class FakeEvents:
    def __init__(self):
        self.calls = []     # each PutEvents batch, as passed
        self.entries = []   # flattened
        self.fail = False   # make put_events raise, to prove audit never 500s

    def put_events(self, Entries):
        if self.fail:
            raise RuntimeError("EventBridge unavailable")
        self.calls.append(list(Entries))
        self.entries.extend(Entries)
        return {"FailedEntryCount": 0}

    def details(self):
        return [json.loads(e["Detail"]) for e in self.entries]

    def of_type(self, detail_type):
        return [json.loads(e["Detail"]) for e in self.entries
                if e["DetailType"] == detail_type]


class _InlineExecutor:
    """Runs submitted work on the calling thread.

    Audit emission is fire-and-forget on a real ThreadPoolExecutor, so a test
    that asserts on emitted entries immediately after a response would race the
    worker. Swallowing the exception matches the production contract that an
    audit failure never changes the response.
    """

    def __init__(self):
        self.submitted = 0
        self.errors = []

    def submit(self, fn, *args, **kwargs):
        self.submitted += 1
        try:
            fn(*args, **kwargs)
        except Exception as exc:      # noqa: BLE001 - mirrors the real executor
            self.errors.append(exc)
        return None

    def shutdown(self, *a, **k):
        pass


_EVENT_CLIENT_ATTRS = ("_events_client", "events_client", "_event_client",
                       "_eventbridge_client", "_eventbridge", "_client")
_EXECUTOR_ATTRS = ("_executor", "_audit_executor", "executor", "_worker_pool")


def _patch_module_attr(monkeypatch, module, candidates, value, what):
    for name in candidates:
        if hasattr(module, name):
            monkeypatch.setattr(module, name, value)
            return name
    raise AssertionError(
        f"{module.__name__} exposes no {what}; expected one of {candidates}. "
        f"Rename to match, or extend the candidate list in conftest.")


@pytest.fixture
def fake_events(monkeypatch):
    """Capture audit emission synchronously (and give it a bus so it isn't skipped)."""
    import audit_events

    fe = FakeEvents()
    _patch_module_attr(monkeypatch, audit_events, _EVENT_CLIENT_ATTRS, fe,
                       "EventBridge client attribute")
    _patch_module_attr(monkeypatch, audit_events, _EXECUTOR_ATTRS,
                       _InlineExecutor(), "audit executor attribute")
    monkeypatch.setattr(audit_events, "EVENT_BUS_NAME", "test-bus", raising=False)
    return fe


# ── Fake OIDC verifier ───────────────────────────────────────────────────────
class FakeOIDCVerifier:
    """Maps an opaque bearer string to (sub, cognito_username).

    A real PyJWT round trip would need an RSA keypair and a JWKS endpoint per
    test; the middleware contract only says verify_token returns a
    (user_id, username) pair or raises ValueError, and that is the whole surface
    the 401/403/404 matrix depends on. The two genuinely OIDCVerifier-specific
    behaviors (JWKS timeout, empty app_client_id) are tested directly.
    """

    def __init__(self, tokens=None):
        self.tokens = dict(tokens or {})
        self.calls = []

    def add(self, username):
        token = f"tok-{username}"
        self.tokens[token] = (f"sub-{username}", username)
        return token

    def verify_token(self, token):
        self.calls.append(token)
        if token not in self.tokens:
            raise ValueError(f"Token verification failed: unknown token")
        return self.tokens[token]


@pytest.fixture
def fake_oidc():
    verifier = FakeOIDCVerifier()
    for username in _PRINCIPALS:
        verifier.add(username)
    verifier.add("ghost")            # a valid token for a user with no users row
    return verifier


# ── Principals (users + privilege_groups) ────────────────────────────────────
def _privs(datastore_id, **flags):
    entry = {"datastoreId": datastore_id, "canRead": True, "canStore": True,
             "canDelete": True, "canQuery": True}
    entry.update(flags)
    return [entry]


def _mgmt(can_edit):
    return {"datastores": {"canEdit": can_edit, "canView": True}}


# label -> (group_id, datastore_privileges, management_privileges, user status)
_PRINCIPALS = {
    "reader_a": ("grp-reader-a", _privs(DS_A), _mgmt(False), "ACTIVE"),
    "reader_b": ("grp-reader-b", _privs(DS_B), _mgmt(False), "ACTIVE"),
    "reader_star": ("grp-reader-star", _privs("*"), _mgmt(False), "ACTIVE"),
    "admin": ("grp-admin", _privs("*"), _mgmt(True), "ACTIVE"),
    "unprivileged": ("grp-none", [], _mgmt(False), "ACTIVE"),
    "read_only_false": ("grp-noread", _privs(DS_A, canRead=False), _mgmt(False), "ACTIVE"),
    "inactive": ("grp-admin", _privs("*"), _mgmt(True), "INACTIVE"),
    "mgmt_missing": ("grp-mgmt-missing", _privs(DS_A), None, "ACTIVE"),
    "mgmt_malformed": ("grp-mgmt-bad", _privs(DS_A), "{not json", "ACTIVE"),
    "nogroup": (None, None, None, "ACTIVE"),
}


def _seed_principals(conn):
    """Users and privilege groups, JSON-encoded exactly as MySQL hands them back.

    PyMySQL returns JSON columns as str, which is why privilege_checker calls
    json.loads; storing dicts here would let a missing json.loads pass.
    """
    if conn.rows("users"):
        return
    for label, (group_id, ds_privs, mgmt, status) in _PRINCIPALS.items():
        if group_id and not conn.find("privilege_groups", id=group_id):
            conn.insert(
                "privilege_groups", id=group_id, name=group_id, deleted=False,
                datastore_privileges=(json.dumps(ds_privs) if ds_privs is not None
                                      else None),
                virtual_folder_privileges=json.dumps([]),
                management_privileges=(mgmt if isinstance(mgmt, str)
                                       else json.dumps(mgmt) if mgmt is not None
                                       else None))
        user_db_id = f"user-{label}"
        conn.insert("users", id=user_db_id, cognito_username=label,
                    email=f"{label}@example.test",
                    status=status, deleted=False)
        if group_id:
            conn.insert("user_privilege_groups", user_id=user_db_id,
                        privilege_group_id=group_id)


def _seed_datastores(conn):
    if conn.rows("datastores"):
        return
    conn.insert("datastores", id=DS_A, name="ds-a", status="ACTIVE",
                s3_bucket_name=BUCKET_A, s3_prefix="/a/",
                deleted=False)
    conn.insert("datastores", id=DS_B, name="ds-b", status="ACTIVE",
                s3_bucket_name=BUCKET_B, s3_prefix="b",
                deleted=False)
    conn.insert("datastores", id=DS_SOFT_DELETED, name="ds-gone", status="ACTIVE",
                s3_bucket_name="archive-ds-gone", s3_prefix="",
                deleted=True)
    conn.insert("datastores", id=DS_DELETING, name="ds-deleting", status="DELETING",
                s3_bucket_name="archive-ds-deleting",
                s3_prefix="", deleted=False)
    # The name-is-not-an-identifier test: this row's NAME is datastore A's ID.
    conn.insert("datastores", id="77777777-7777-4777-8777-777777777777",
                name=DS_A, status="ACTIVE",
                s3_bucket_name="archive-ds-imposter", s3_prefix="", deleted=False)


# ── DICOM builders ───────────────────────────────────────────────────────────
def make_dicom(sop_uid=SOP_UID, study_uid=STUDY_UID, series_uid=SERIES_UID,
               pixel=PIXEL_A, transfer_syntax=EXPLICIT_VR_LE, frames=1,
               patient_id=PATIENT_ID, patient_name=PATIENT_NAME,
               modality="CT", instance_number=1, series_number=1):
    """A small native instance with a recognizable per-datastore pixel pattern."""
    from pydicom.dataset import Dataset, FileMetaDataset

    ds = Dataset()
    ds.PatientName = patient_name
    ds.PatientID = patient_id
    ds.PatientBirthDate = PATIENT_BIRTHDATE
    ds.PatientSex = "F"
    ds.AccessionNumber = ACCESSION
    ds.StudyDescription = STUDY_DESCRIPTION
    ds.StudyDate = "20240115"
    ds.StudyTime = "101500.000000"
    ds.Modality = modality
    ds.SOPClassUID = CT_SOP_CLASS_UID
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SeriesNumber = series_number
    ds.InstanceNumber = instance_number
    ds.Rows, ds.Columns = ROWS, COLS
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
    ds.SamplesPerPixel, ds.PixelRepresentation = 1, 0
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.WindowCenter, ds.WindowWidth = 2048, 4096
    if frames > 1:
        ds.NumberOfFrames = frames
    ds.PixelData = pixel * (ROWS * COLS * frames)

    fm = FileMetaDataset()
    fm.TransferSyntaxUID = transfer_syntax
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm

    buf = io.BytesIO()
    # `write_like_original=False` is the pydicom 2.x spelling of "emit a
    # conformant Part 10 file". pydicom 3 renamed it to enforce_file_format= but
    # still honours this one (deprecated, removed in 4.0), so the harness runs
    # against the container's pinned pydicom 2.4.x *and* against a 3.x that leaks
    # in from system site-packages. The 3-only keyword silently made this whole
    # suite unrunnable against requirements.txt.
    ds.save_as(buf, write_like_original=False)
    return ds, buf.getvalue()


def pixel_data_tag_offset(dicom_bytes):
    """Absolute offset of the (7FE0,0010) tag - what ingest stores in
    Instancemetadata.metadataendoffset. The frame reader adds 8 (implicit VR LE)
    or 12 (explicit) to reach the first pixel byte."""
    offset = dicom_bytes.rfind(b"\xe0\x7f\x10\x00")
    assert offset > 0, "no PixelData tag in the synthesized instance"
    return offset


def make_metadata_blob(ds):
    """The gzipped DICOM-JSON header the read side serves from the database.

    PixelData is dropped the way ingest drops it: /metadata is a header view and
    the pixels are reached through /frames or /bulk.
    """
    header = ds.copy()
    if "PixelData" in header:
        del header.PixelData
    return gzip.compress(json.dumps(header.to_json_dict()).encode("utf-8"))


# Synthetic abbreviated-JPEG parts for the WSI tables-splice path. Real tiles
# are Aperio/Ventana output; the splice only cares about SOI/EOI placement.
JPEG_TABLES_BLOB = b"\xff\xd8\xff\xdb\x00\x04TBL\xff\xd9"
JPEG_TILE_BODY = b"\xff\xd8\xff\xda\x00\x04TILE-PIXELS\xff\xd9"


# ── Datastore/tree fixture ───────────────────────────────────────────────────
class TwoDatastores:
    """Handles on the seeded two-tenant world, plus the mutators tests need.

    Both datastores hold the same StudyInstanceUID, SeriesInstanceUID and
    SOPInstanceUIDs; only the bucket, the key and the pixel bytes differ. Any
    response that carries B's bytes under an A-scoped request is a tenancy
    failure, and vice versa.
    """

    def __init__(self, conn, s3):
        self.conn = conn
        self.s3 = s3
        self.bucket = {DS_A: BUCKET_A, DS_B: BUCKET_B}
        self.pixel = {DS_A: PIXEL_A, DS_B: PIXEL_B}
        self.objects = {}      # (datastore_id, sop_uid) -> (bucket, key, bytes)
        self.datasets = {}     # (datastore_id, sop_uid) -> pydicom Dataset

    def key(self, datastore_id, sop_uid):
        return self.objects[(datastore_id, sop_uid)][1]

    def object_bytes(self, datastore_id, sop_uid):
        return self.objects[(datastore_id, sop_uid)][2]

    def instance_row(self, datastore_id, sop_uid):
        return self.conn.find("instance", datastore_id=datastore_id,
                              sopinstanceuid=sop_uid)

    def location_row(self, datastore_id, sop_uid):
        inst = self.instance_row(datastore_id, sop_uid)
        return self.conn.find("storage_index", content_pkey=inst["content_pkey"])

    def metadata_row(self, datastore_id, sop_uid):
        return self.conn.find("Instancemetadata",
                              instanceid=instance_key(datastore_id, sop_uid))

    def set_availability(self, datastore_id, sop_uid, value):
        self.instance_row(datastore_id, sop_uid)["instanceavailability"] = value

    def set_series_availability(self, datastore_id, series_uid, value):
        self.conn.find("series", datastore_id=datastore_id,
                       seriesinstanceuid=series_uid)["availability"] = value

    def soft_delete_instance(self, datastore_id, sop_uid):
        """Mark the instance deleted, leaving location/metadata rows behind.

        That is exactly the state after an ingest delete and before the GC
        sweep: those two tables have no deleted_at of their own, so a query that
        reaches them without the instance join serves deleted PHI.
        """
        self.instance_row(datastore_id, sop_uid)["deleted_at"] = "2024-01-15 10:00:00"

    def soft_delete_series(self, datastore_id, series_uid):
        self.conn.find("series", datastore_id=datastore_id,
                       seriesinstanceuid=series_uid)["deleted_at"] = "2024-01-15 10:00:00"

    def soft_delete_study(self, datastore_id, study_uid):
        self.conn.find("study", datastore_id=datastore_id,
                       studyinstanceuid=study_uid)["deleted_at"] = "2024-01-15 10:00:00"


def _seed_instance(world, datastore_id, series_row, sop_uid, *,
                   instance_number, transfer_syntax=EXPLICIT_VR_LE,
                   frames=1, deleted=False, availability=None,
                   sop_class_uid=CT_SOP_CLASS_UID, member=False,
                   dimension_organization_type=None,
                   metadata_end_offset="auto", frame_offsets=None,
                   jpeg_tables=None, icc=None, wsi_geometry=None,
                   object_bytes=None, key=None):
    conn, s3 = world.conn, world.s3
    bucket = world.bucket[datastore_id]
    pixel = world.pixel[datastore_id]
    iid = instance_key(datastore_id, sop_uid)

    ds, dicom_bytes = make_dicom(
        sop_uid=sop_uid, study_uid=STUDY_UID, series_uid=series_row["seriesinstanceuid"],
        pixel=pixel, transfer_syntax=transfer_syntax, frames=frames,
        instance_number=instance_number)
    world.datasets[(datastore_id, sop_uid)] = ds

    key = key or f"{datastore_id[:8]}/{sop_uid}.dcm"
    if object_bytes is None:
        object_bytes = dicom_bytes
        member_offset = member_length = None
    if member:
        # An uncompressed tar member: the instance is a slice of a larger object
        # and must be served with a Range, never as the whole object.
        prefix = b"USTAR-HEADER-PADDING" * 26          # 520 bytes
        payload = object_bytes
        object_bytes = prefix + payload + b"\x00" * 512
        member_offset, member_length = len(prefix), len(payload)
        key = f"{datastore_id[:8]}/bundle.tar"
    else:
        member_offset = member_length = None

    s3.put(bucket, key, object_bytes)
    world.objects[(datastore_id, sop_uid)] = (bucket, key, object_bytes)

    if metadata_end_offset == "auto":
        metadata_end_offset = (member_offset or 0) + pixel_data_tag_offset(dicom_bytes)

    geometry = wsi_geometry or {}
    inst_row = conn.insert("instance", instanceid=iid, datastore_id=datastore_id,
                series_pkey=series_row["series_pkey"],
                seriesid=series_row["series_pkey"],
                transfersyntaxuid=transfer_syntax, sopclassuid=sop_class_uid,
                sopinstanceuid=sop_uid, instanceavailability=availability,
                instancenumber=instance_number, samplesperpixel=1,
                numberofframes=frames if frames > 1 else None,
                rows=geometry.get("rows", ROWS),
                columns=geometry.get("columns", COLS),
                bitsallocated=16,
                totalpixelmatrixcolumns=geometry.get("total_columns"),
                totalpixelmatrixrows=geometry.get("total_rows"),
                dimensionorganizationtype=dimension_organization_type,
                deleted_at="2024-01-15 10:00:00" if deleted else None)
    conn.add_location(inst_row, bucket, key, member_offset=member_offset,
                      member_length=member_length, size_bytes=len(object_bytes))
    # Instancemetadata is keyed on instance_pkey (WSI levels are distinct
    # instances sharing one object), so wire the blob to THIS instance's pkey.
    conn.insert("Instancemetadata", instance_pkey=inst_row["instance_pkey"],
                instanceid=iid,
                metadata=make_metadata_blob(ds),
                metadataendoffset=metadata_end_offset,
                frame_offsets=(json.dumps(frame_offsets).encode()
                               if frame_offsets is not None else None),
                jpeg_tables_offset=(jpeg_tables or {}).get("offset"),
                jpeg_tables_length=(jpeg_tables or {}).get("length"),
                icc_profile_offset=(icc or {}).get("offset"),
                icc_profile_length=(icc or {}).get("length"))
    return iid


@pytest.fixture
def two_datastores(fake_conn, fake_s3):
    """Two datastores with colliding UIDs - the key fixture (spec 9.1)."""
    _seed_datastores(fake_conn)
    _seed_principals(fake_conn)

    world = TwoDatastores(fake_conn, fake_s3)

    # One patient row per datastore, sharing PatientID and nothing else: patient
    # is datastore-scoped (uq_patient_ds_id), so the collision is two rows, and
    # any reader that crosses the boundary renders B's demographics.
    demographics = {
        DS_A: (PATIENT_NAME, PATIENT_BIRTHDATE, PATIENT_SEX),
        DS_B: (PATIENT_NAME_B, PATIENT_BIRTHDATE_B, PATIENT_SEX_B),
    }

    for datastore_id in (DS_A, DS_B):
        name, birthdate, sex = demographics[datastore_id]
        patient = fake_conn.insert(
            "patient", datastore_id=datastore_id, patientid=PATIENT_ID,
            patientname=name, patientbirthdate=birthdate, patientsex=sex)
        study = fake_conn.insert(
            "study", patient_pkey=patient["patient_pkey"],
            datastore_id=datastore_id, studyinstanceuid=STUDY_UID,
            studydate="20240115", studytime="10:15:00",
            accessionnumber=ACCESSION, studydescription=STUDY_DESCRIPTION,
            referringphysicianname="Smith^Bob", studyid="ST1")
        series_1 = fake_conn.insert(
            "series", study_pkey=study["study_pkey"], datastore_id=datastore_id,
            seriesinstanceuid=SERIES_UID, modality="CT", seriesdescription="AXIAL",
            seriesnumber=1)
        series_2 = fake_conn.insert(
            "series", study_pkey=study["study_pkey"], datastore_id=datastore_id,
            seriesinstanceuid=SERIES_UID_2, modality="SR", seriesdescription="REPORT",
            seriesnumber=2)

        _seed_instance(world, datastore_id, series_1, SOP_UID, instance_number=1)
        _seed_instance(world, datastore_id, series_1, SOP_UID_2, instance_number=2)
        _seed_instance(world, datastore_id, series_2, SOP_UID_3, instance_number=1)
        # Soft-deleted, with its location/metadata rows deliberately intact.
        _seed_instance(world, datastore_id, series_1, SOP_UID_DELETED,
                       instance_number=8, deleted=True)

    # A sidecar-first pending series: zero instances, availability OFFLINE, and
    # still discoverable (spec 5.10). Datastore A only.
    study_a = fake_conn.find("study", datastore_id=DS_A, studyinstanceuid=STUDY_UID)
    fake_conn.insert("series", study_pkey=study_a["study_pkey"], datastore_id=DS_A,
                     seriesinstanceuid=SERIES_PENDING_UID, modality="SM",
                     seriesdescription="PENDING SLIDE", seriesnumber=9,
                     availability="OFFLINE")
    return world


@pytest.fixture
def encapsulated(two_datastores):
    """An encapsulated (JPEG baseline) instance with per-frame byte ranges.

    The payloads are opaque bytes on purpose: the as-stored frame path range-GETs
    each [start, end] pair and returns the payload verbatim, so a real JPEG
    encoder is not needed to pin the read arithmetic. The Item framing around
    them is real, because the read side checks the 8 bytes after each frame
    (next Item header, or the Sequence Delimiter after the last frame) to detect
    a frame split over several fragments.
    """
    world = two_datastores
    conn, s3 = world.conn, world.s3
    series = conn.find("series", datastore_id=DS_A, seriesinstanceuid=SERIES_UID)
    iid = instance_key(DS_A, SOP_UID_ENCAPSULATED)

    item = b"\xfe\xff\x00\xe0"
    header = b"H" * 300 + item + b"\x00\x00\x00\x00"     # ... + empty Basic Offset Table
    frame_1 = b"\xff\xd8FRAME-ONE\xff\xd9"
    frame_2 = b"\xff\xd8FRAME-TWO-LONGER\xff\xd9"
    item_1 = item + len(frame_1).to_bytes(4, 'little')
    item_2 = item + len(frame_2).to_bytes(4, 'little')
    body = header + item_1 + frame_1 + item_2 + frame_2 + b"\xfe\xff\xdd\xe0\x00\x00\x00\x00"
    key = "a/encapsulated.dcm"
    s3.put(BUCKET_A, key, body)

    start_1 = len(header) + 8
    start_2 = start_1 + len(frame_1) + 8
    offsets = [[start_1, start_1 + len(frame_1) - 1],
               [start_2, start_2 + len(frame_2) - 1]]

    inst_row = conn.insert("instance", instanceid=iid, datastore_id=DS_A,
                series_pkey=series["series_pkey"], seriesid=series["series_pkey"],
                transfersyntaxuid=JPEG_BASELINE, sopclassuid=CT_SOP_CLASS_UID,
                sopinstanceuid=SOP_UID_ENCAPSULATED, instancenumber=6, samplesperpixel=1,
                numberofframes=2, rows=ROWS, columns=COLS, bitsallocated=8)
    conn.add_location(inst_row, BUCKET_A, key, size_bytes=len(body))
    conn.insert("Instancemetadata", instance_pkey=inst_row["instance_pkey"], instanceid=iid, metadata=None,
                metadataendoffset=len(header) - 12,
                frame_offsets=json.dumps(offsets).encode())
    world.objects[(DS_A, SOP_UID_ENCAPSULATED)] = (BUCKET_A, key, body)
    return types.SimpleNamespace(
        sop_uid=SOP_UID_ENCAPSULATED, bucket=BUCKET_A, key=key,
        frames=[frame_1, frame_2], offsets=offsets,
        transfer_syntax=JPEG_BASELINE)


@pytest.fixture
def wsi_instance(two_datastores):
    """A virtualized WSI level: TILED_FULL, metadataendoffset 0, shared JPEG
    tables and an ICC profile. Both bulk routes and the WSI guard key off it."""
    world = two_datastores
    conn, s3 = world.conn, world.s3
    series = conn.find("series", datastore_id=DS_A, seriesinstanceuid=SERIES_UID_2)
    iid = instance_key(DS_A, SOP_UID_WSI)

    tables_offset = 64
    icc_offset = 512
    icc_bytes = b"ICC-PROFILE-PAYLOAD" * 4
    tile_at = 4096
    body = bytearray(b"\x00" * 8192)
    body[tables_offset:tables_offset + len(JPEG_TABLES_BLOB)] = JPEG_TABLES_BLOB
    body[icc_offset:icc_offset + len(icc_bytes)] = icc_bytes
    body[tile_at:tile_at + len(JPEG_TILE_BODY)] = JPEG_TILE_BODY
    key = "a/slide.svs"
    s3.put(BUCKET_A, key, bytes(body))

    # 2x2 grid of 16x16 tiles over a 32x32 level.
    inst_row = conn.insert("instance", instanceid=iid, datastore_id=DS_A,
                series_pkey=series["series_pkey"], seriesid=series["series_pkey"],
                transfersyntaxuid=JPEG_BASELINE, sopclassuid=WSI_SOP_CLASS_UID,
                sopinstanceuid=SOP_UID_WSI, instancenumber=7, samplesperpixel=3,
                numberofframes=4, rows=ROWS, columns=COLS, bitsallocated=8,
                totalpixelmatrixcolumns=32, totalpixelmatrixrows=32, dimensionorganizationtype="TILED_FULL")
    conn.add_location(inst_row, BUCKET_A, key, size_bytes=len(body))
    frame_offsets = [[tile_at, tile_at + len(JPEG_TILE_BODY) - 1]] * 4
    conn.insert("Instancemetadata", instance_pkey=inst_row["instance_pkey"], instanceid=iid, metadata=None,
                metadataendoffset=0,
                frame_offsets=json.dumps(frame_offsets).encode(),
                jpeg_tables_offset=tables_offset,
                jpeg_tables_length=len(JPEG_TABLES_BLOB),
                icc_profile_offset=icc_offset,
                icc_profile_length=len(icc_bytes))
    world.objects[(DS_A, SOP_UID_WSI)] = (BUCKET_A, key, bytes(body))
    return types.SimpleNamespace(
        sop_uid=SOP_UID_WSI, bucket=BUCKET_A, key=key,
        tables_offset=tables_offset, tables_length=len(JPEG_TABLES_BLOB),
        icc_offset=icc_offset, icc_bytes=icc_bytes,
        tile_bytes=JPEG_TILE_BODY, n_cols=2, n_rows=2)


@pytest.fixture
def native_wsi_icc(two_datastores):
    """A NATIVE DICOM WSI (not an SVS conversion): a real Part-10 object whose
    ICC profile is a genuine (0028,2000) OB element nested in OpticalPathSequence.

    Unlike wsi_instance (a virtualized SVS level with metadataendoffset = 0), this
    carries a real DICOM header, so metadataendoffset > 0 and /bulk/element can
    range-read the header and pull the nested element out. This is the shape the
    Leica GT450 slides ingest as, and the one the read-path fix must serve.
    """
    from pydicom.dataset import Dataset, FileMetaDataset

    world = two_datastores
    conn, s3 = world.conn, world.s3
    series = conn.find("series", datastore_id=DS_A, seriesinstanceuid=SERIES_UID_2)
    iid = instance_key(DS_A, SOP_UID_WSI_NATIVE)
    icc_bytes = b"acsp" + b"NATIVE-WSI-ICC-PROFILE" * 8

    ds = Dataset()
    ds.SOPClassUID = WSI_SOP_CLASS_UID
    ds.SOPInstanceUID = SOP_UID_WSI_NATIVE
    ds.StudyInstanceUID = STUDY_UID
    ds.SeriesInstanceUID = SERIES_UID_2
    ds.PatientName = PATIENT_NAME
    ds.PatientID = PATIENT_ID
    ds.Modality = "SM"
    ds.InstanceNumber = 77
    ds.Rows, ds.Columns = 16, 16
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 8, 8, 7
    ds.SamplesPerPixel, ds.PixelRepresentation = 3, 0
    ds.PhotometricInterpretation = "RGB"
    # The ICC profile lives inside OpticalPathSequence[0] — a top-level lookup
    # for (0028,2000) misses it, which is exactly what _find_element must handle.
    op = Dataset()
    op.OpticalPathIdentifier = "1"
    op.ICCProfile = icc_bytes
    ds.OpticalPathSequence = [op]
    ds.PixelData = b"\x00" * (16 * 16 * 3)

    fm = FileMetaDataset()
    fm.TransferSyntaxUID = EXPLICIT_VR_LE
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm

    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    object_bytes = buf.getvalue()
    end_offset = pixel_data_tag_offset(object_bytes)

    key = f"{DS_A[:8]}/native-wsi.dcm"
    s3.put(BUCKET_A, key, object_bytes)
    world.objects[(DS_A, SOP_UID_WSI_NATIVE)] = (BUCKET_A, key, object_bytes)

    inst_row = conn.insert("instance", instanceid=iid, datastore_id=DS_A,
                series_pkey=series["series_pkey"], seriesid=series["series_pkey"],
                transfersyntaxuid=EXPLICIT_VR_LE, sopclassuid=WSI_SOP_CLASS_UID,
                sopinstanceuid=SOP_UID_WSI_NATIVE, instancenumber=77, samplesperpixel=3,
                rows=16, columns=16, bitsallocated=8,
                dimensionorganizationtype="TILED_SPARSE")
    conn.add_location(inst_row, BUCKET_A, key, size_bytes=len(object_bytes))
    conn.insert("Instancemetadata", instance_pkey=inst_row["instance_pkey"], instanceid=iid,
                metadata=make_metadata_blob(ds), metadataendoffset=end_offset,
                frame_offsets=None, jpeg_tables_offset=None,
                jpeg_tables_length=None,
                icc_profile_offset=None, icc_profile_length=None)
    return types.SimpleNamespace(
        sop_uid=SOP_UID_WSI_NATIVE, bucket=BUCKET_A, key=key,
        icc_bytes=icc_bytes)


# ── Identities ───────────────────────────────────────────────────────────────
class Principal:
    """One caller: the bearer string, the headers, and the RequestIdentity the
    middleware should produce for it (None when it must be refused)."""

    def __init__(self, label, username, datastore_id, include_private_tags,
                 expect_status):
        self.label = label
        self.username = username
        self.token = f"tok-{username}" if username else None
        self.datastore_id = datastore_id
        self.include_private_tags = include_private_tags
        self.expect_status = expect_status

    @property
    def headers(self):
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    @property
    def identity(self):
        if self.expect_status != 200:
            return None
        from auth_middleware import RequestIdentity
        return RequestIdentity(self.username, self.datastore_id,
                               self.include_private_tags)


@pytest.fixture
def identities(fake_conn):
    """The RequestIdentity variants spec 9.1 enumerates, keyed by label."""
    _seed_principals(fake_conn)
    return {
        "reader_a": Principal("reader_a", "reader_a", DS_A, False, 200),
        "reader_b": Principal("reader_b", "reader_b", DS_B, False, 200),
        "reader_star": Principal("reader_star", "reader_star", DS_A, False, 200),
        "admin": Principal("admin", "admin", DS_A, True, 200),
        "unprivileged": Principal("unprivileged", "unprivileged", DS_A, False, 403),
        "read_only_false": Principal("read_only_false", "read_only_false", DS_A, False, 403),
        "inactive": Principal("inactive", "inactive", DS_A, False, 403),
        "mgmt_missing": Principal("mgmt_missing", "mgmt_missing", DS_A, False, 200),
        "mgmt_malformed": Principal("mgmt_malformed", "mgmt_malformed", DS_A, False, 200),
        "nogroup": Principal("nogroup", "nogroup", DS_A, False, 403),
        "unknown": Principal("unknown", "ghost", DS_A, False, 403),
        "anonymous": Principal("anonymous", None, DS_A, False, 401),
    }


# ── Flask app / test client ──────────────────────────────────────────────────
_REQUIRED_ENV = {
    "SOLUTION_VERSION": "test-2.0.0",
    "EVENT_BUS_NAME": "test-bus",
    "STACK_NAME": "test-stack",
    "USER_POOL_ID": "us-east-1_TEST",
    "USER_POOL_CLIENT_ID": "test-client-id",
    "DB_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:000000000000:secret:test",
    "DB_NAME": "dicomarchive",
    "AWS_REGION": "us-east-1",
    "ARCHIVE_BUCKET_PREFIX": "archive-ds-",
    "CORS_ALLOWED_ORIGINS": "",
}


def _import_main():
    for name, value in _REQUIRED_ENV.items():
        os.environ.setdefault(name, value)
    import main
    return main


@pytest.fixture
def service(fake_conn, fake_s3, fake_events, fake_oidc, monkeypatch):
    """The service module with every outbound dependency replaced by a fake.

    Both the connection factory's pool and main's own reference are patched:
    the factory is what datastore_resolver/privilege_checker reach through, and
    main holds its own module global for the QIDO/WADO path.
    """
    import mysqlConnectionFactory

    main = _import_main()
    from auth_middleware import AuthMiddleware

    pool = FakePool(fake_conn)
    monkeypatch.setattr(mysqlConnectionFactory, "sql_pool", pool)
    monkeypatch.setattr(mysqlConnectionFactory, "init_connection_pool",
                        lambda: pool)
    # Through the pool, so a test that patches pool.connection reaches every
    # caller (main routes all reads via connection_with_rotation_retry).
    monkeypatch.setattr(mysqlConnectionFactory, "get_connection", lambda: pool.connection())

    app = main.create_app() if hasattr(main, "create_app") else main.app
    app.config.update(TESTING=True)

    monkeypatch.setattr(main, "sql_pool", pool, raising=False)
    monkeypatch.setattr(main, "s3_client", fake_s3, raising=False)
    monkeypatch.setattr(main, "auth_middleware",
                        AuthMiddleware(fake_oidc, pool), raising=False)
    _ensure_caches(main, monkeypatch)

    return types.SimpleNamespace(main=main, app=app, conn=fake_conn, s3=fake_s3,
                                 events=fake_events, oidc=fake_oidc, pool=pool)


def _ensure_caches(main, monkeypatch):
    """bootstrap() normally builds these; a test client never calls it."""
    from cachetools import TTLCache
    from concurrent.futures import ThreadPoolExecutor

    if getattr(main, "qido_cache", None) is None:
        monkeypatch.setattr(main, "qido_cache", TTLCache(maxsize=1024, ttl=30),
                            raising=False)
    if getattr(main, "wsi_tables_cache", None) is None:
        monkeypatch.setattr(main, "wsi_tables_cache",
                            TTLCache(maxsize=256, ttl=3600), raising=False)
    if getattr(main, "frame_loc_cache", None) is None:
        monkeypatch.setattr(main, "frame_loc_cache",
                            TTLCache(maxsize=4096, ttl=45), raising=False)
    if getattr(main, "worker_pool", None) is None:
        monkeypatch.setattr(main, "worker_pool", ThreadPoolExecutor(max_workers=2),
                            raising=False)


@pytest.fixture
def client(service):
    return service.app.test_client()


@pytest.fixture
def get(client, identities):
    """`get(path, principal='reader_a')` - a bearer-carrying GET.

    Almost every test is "this caller, this route", and threading the header
    dict through by hand is the kind of boilerplate that ends up copied without
    the header on one line and silently testing the unauthenticated path.
    """
    def _get(path, principal="reader_a", headers=None, **kwargs):
        merged = dict(identities[principal].headers) if principal else {}
        merged.update(headers or {})
        return client.get(path, headers=merged, **kwargs)
    return _get


def base(datastore_id=DS_A):
    return f"/dicomweb/{datastore_id}"


# ── State reset ──────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _reset_state():
    """Clear every process-global cache around each test.

    A leaked QIDO entry makes a tenancy test pass for the wrong reason, and a
    leaked resolver entry makes a 404 test pass without any SQL running. The
    imports are guarded because the auth modules are testable before main.py
    exists on disk.
    """
    def _clear():
        try:
            import datastore_resolver
            datastore_resolver.invalidate()
        except Exception:
            pass
        main = sys.modules.get("main")
        if main is not None:
            for name in ("qido_cache", "wsi_tables_cache", "frame_loc_cache"):
                cache = getattr(main, name, None)
                if cache is not None:
                    cache.clear()

    _clear()
    yield
    _clear()
