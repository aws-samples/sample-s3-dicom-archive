"""Behavior test for the parent upsert path in _index_dicom, against real MySQL.

Unlike the rest of the suite (which runs against the in-memory FakeConn), this
exercises the REAL upsert path against a REAL MySQL 8 using the actual
schema-s3-index.sql, and counts the statements _index_dicom issues per object.
It proves things the fake DB cannot about the deadlock-storm fix:

  * the parent path is now SELECT-FIRST — an existing patient/study/series is
    resolved with a shared-read SELECT and takes NO write lock, so the
    contended re-ingest / same-parent hot path never touches the write path that
    deadlocks. A fresh object costs 10 statement round-trips in _index_dicom
    (3 parents x [SELECT-miss + INSERT] + instance + storage_index + UPDATE
    instance + Instancemetadata); a second object under the SAME parents, and a
    pure no-op re-ingest, both cost 7 (the 3 parent SELECTs hit, so no parent
    INSERT fires at all);
  * the pkeys returned are correct on the fresh, the duplicate-parent, and the
    pure no-op re-ingest paths, so the instance always links to the right
    storage_index.content_pkey;
  * re-ingest stays idempotent (no duplicate rows).

SKIPPED unless a MySQL 8 is reachable. Point it at one with, e.g.:

    S3INGEST_TEST_MYSQL=host=127.0.0.1;port=13399;user=root;password=root;db=t

(a throwaway `docker run -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=t
-p 13399:3306 mysql:8.0` is enough). Without that env var, or if the real
pymysql / a live server is not available, the test skips rather than fails, so
it never adds to the offline unit-suite failure count.
"""

import io
import os

import pytest

import engine as H
from conftest import DS_A, FakeS3, make_dicom


# ── opt-in live-MySQL connection ─────────────────────────────────────────────
def _mysql_params():
    raw = os.environ.get("S3INGEST_TEST_MYSQL")
    if not raw:
        # Default to the throwaway container this test was authored against.
        raw = "host=127.0.0.1;port=13399;user=root;password=root;db=t"
    kv = dict(p.split("=", 1) for p in raw.split(";") if "=" in p)
    return kv


def _connect():
    """Return a live pymysql connection, or None if unavailable (=> skip)."""
    kv = _mysql_params()
    try:
        import pymysql  # the REAL driver, not the conftest stub
        if getattr(pymysql, "connect", None) is None:
            return None
        # conftest installs a pymysql stub whose connect() returns None; detect
        # that and treat it as "no real driver".
        conn = pymysql.connect(
            host=kv.get("host", "127.0.0.1"),
            port=int(kv.get("port", 3306)),
            user=kv.get("user", "root"),
            password=kv.get("password", ""),
            database=kv.get("db", "t"),
            autocommit=False, charset="utf8mb4",
            connect_timeout=3,
        )
        return conn
    except Exception:
        return None


SCHEMA_SQL = os.path.abspath(os.path.join(
    os.path.dirname(__file__), *([".."] * 4),
    "database", "lambda", "database-schema-init", "schema-s3-index.sql"))


def _load_index_schema(conn):
    sql = open(SCHEMA_SQL).read()
    cur = conn.cursor()
    for t in ("Instancemetadata", "instance", "storage_index",
              "series", "study", "patient"):
        cur.execute(f"DROP TABLE IF EXISTS {t}")
    # Split on ';' at end-of-line, skipping comment/blank lines, and run only the
    # six index-table CREATEs (the file also references VF/other tables in prose).
    stmts, buf = [], []
    for line in sql.splitlines():
        s = line.strip()
        if s.startswith("--") or not s:
            continue
        buf.append(line)
        if s.endswith(";"):
            stmts.append("\n".join(buf)); buf = []
    wanted = ("PATIENT", "STUDY", "SERIES", "INSTANCE", "STORAGE_INDEX",
              "INSTANCEMETADATA")
    for stmt in stmts:
        up = " ".join(stmt.upper().split())
        if up.startswith("CREATE TABLE") and any(w in up.split("(")[0]
                                                  for w in wanted):
            cur.execute(stmt)
    cur.close(); conn.commit()


class _CountingCursor:
    def __init__(self, real, counter):
        self._c, self._n = real, counter
    def execute(self, sql, params=()):
        self._n[0] += 1
        return self._c.execute(sql, params)
    @property
    def lastrowid(self): return self._c.lastrowid
    @property
    def rowcount(self): return self._c.rowcount
    def fetchone(self): return self._c.fetchone()
    def fetchall(self): return self._c.fetchall()
    def close(self): return self._c.close()


class _CountingConn:
    def __init__(self, real):
        self._conn, self.count = real, [0]
    def cursor(self, *a, **k):
        return _CountingCursor(self._conn.cursor(*a, **k), self.count)
    def commit(self): return self._conn.commit()
    def rollback(self): return self._conn.rollback()
    def ping(self, reconnect=True): return self._conn.ping(reconnect=reconnect)
    def close(self): return self._conn.close()


def _rows(conn, table):
    cur = conn.cursor(); cur.execute(f"SELECT * FROM {table}")
    out = cur.fetchall(); cur.close(); return out


def _ingest(conn, s3, key, data):
    """Call _index_dicom exactly as _handle_created's DICOM branch does."""
    return H._index_dicom(conn, H.Datastore(id=DS_A, bucket="bkt", prefix=""),
                          "bkt", key, "", data[:H.HEADER_WINDOW_BYTES],
                          len(data), object_etag="deadbeef")


@pytest.fixture
def live_conn():
    real = _connect()
    if real is None:
        pytest.skip("no live MySQL 8 (set S3INGEST_TEST_MYSQL / run the "
                    "throwaway container) — round-trip behavior test skipped")
    _load_index_schema(real)
    conn = _CountingConn(real)
    yield conn
    real.close()


def test_lastrowid_collapse_cuts_roundtrips_and_stays_correct(live_conn,
                                                              monkeypatch):
    conn = live_conn
    s3 = FakeS3()
    monkeypatch.setattr(H, "s3_client", s3)

    from pydicom.uid import generate_uid
    uid1 = generate_uid()
    data1 = make_dicom(sop_uid=uid1)
    s3.put("bkt", "a.dcm", data1)

    # ── fresh object: parents created SELECT-first, 10 round-trips ──────────
    # 3 parents x (SELECT-miss + INSERT) = 6, + instance + storage_index +
    # UPDATE instance content_pkey + Instancemetadata = 4  => 10.
    conn.count[0] = 0
    _ingest(conn, s3, "a.dcm", data1)
    conn.commit()
    assert conn.count[0] == 10, f"fresh object issued {conn.count[0]} statements, expected 10"
    assert len(_rows(conn, "patient")) == 1
    assert len(_rows(conn, "study")) == 1
    assert len(_rows(conn, "series")) == 1
    assert len(_rows(conn, "instance")) == 1
    assert len(_rows(conn, "storage_index")) == 1
    assert len(_rows(conn, "Instancemetadata")) == 1

    # instance is FK-linked to the storage_index row (content_pkey resolved)
    cur = conn.cursor()
    cur.execute("SELECT i.content_pkey, si.content_pkey FROM instance i "
                "JOIN storage_index si ON si.content_pkey = i.content_pkey")
    link = cur.fetchone(); cur.close()
    assert link is not None and link[0] is not None and link[0] == link[1]

    # ── second object, SAME parents: 3 parent SELECTs HIT, no parent INSERT ──
    # SELECT-first means the contended parents take only shared reads here — the
    # write path that deadlocks is never entered. 3 parent SELECTs (hit) + 4
    # instance-level statements => 7, and NO parent rows are added.
    uid2 = generate_uid()
    data2 = make_dicom(sop_uid=uid2)  # same study/series/patient UIDs
    s3.put("bkt", "b.dcm", data2)
    conn.count[0] = 0
    _ingest(conn, s3, "b.dcm", data2)
    conn.commit()
    assert conn.count[0] == 7, f"same-parent object issued {conn.count[0]} statements, expected 7"
    assert len(_rows(conn, "patient")) == 1   # not duplicated
    assert len(_rows(conn, "study")) == 1
    assert len(_rows(conn, "series")) == 1
    assert len(_rows(conn, "instance")) == 2
    assert len(_rows(conn, "storage_index")) == 2
    cur = conn.cursor()
    cur.execute("SELECT content_pkey FROM instance ORDER BY content_pkey")
    cps = [r[0] for r in cur.fetchall()]; cur.close()
    assert None not in cps and len(set(cps)) == 2

    # ── re-ingest object 1: PURE no-op — parents resolved by SELECT, 0 writes
    conn.count[0] = 0
    _ingest(conn, s3, "a.dcm", data1)
    conn.commit()
    # Still 7: the 3 parent SELECTs hit, so no parent INSERT and no write lock on
    # the hot re-ingest path — the whole point of the deadlock-storm fix.
    assert conn.count[0] == 7
    assert len(_rows(conn, "patient")) == 1   # idempotent
    assert len(_rows(conn, "study")) == 1
    assert len(_rows(conn, "series")) == 1
    assert len(_rows(conn, "instance")) == 2
    assert len(_rows(conn, "storage_index")) == 2

    # the re-ingested instance still links to the SAME storage_index pkey
    iid1 = H._stable_instanceid(DS_A, str(uid1))
    cur = conn.cursor()
    cur.execute("SELECT content_pkey FROM instance WHERE instanceid = %s", (iid1,))
    cp_inst = cur.fetchone()[0]
    cur.execute("SELECT content_pkey FROM storage_index WHERE s3_key = %s", ("a.dcm",))
    cp_si = cur.fetchone()[0]; cur.close()
    assert cp_inst is not None and cp_inst == cp_si
