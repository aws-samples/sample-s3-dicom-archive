"""Behavior test for the ingest DEADLOCK-STORM fix, against a real MySQL 8.

The live problem (CloudWatch: ~2832 deadlocks vs 2313 indexes in 3 minutes,
errno 1213/1205): every DICOM instance of a study shares its patient/study/
series rows, and with dozens of concurrent ingest Lambdas each running
INSERT..ON DUPLICATE KEY UPDATE on those same unique keys, InnoDB next-key
locking forms cross-transaction deadlock cycles. The fix in engine.py:

  1. GROUP the SQS batch — resolve each DISTINCT patient/study/series ONCE per
     invocation (a per-invocation _ParentCache), so a 15-object same-study batch
     upserts 1 patient + 1 study + N series instead of 15 + 15 + 15.
  2. SELECT-FIRST on the parents — an existing parent is resolved with a shared
     read that takes NO write lock, so the contended re-ingest / same-parent hot
     path never enters the write path that deadlocks. INSERT..ON DUP fires only
     for a genuinely absent parent.
  3. This also removed the old `pkey = LAST_INSERT_ID(pkey)` forced write on the
     ON DUP SET list, which took a write lock on every parent upsert including
     pure no-op re-ingests.

These are properties the in-memory FakeConn cannot exercise (no real locking, no
real ON DUPLICATE KEY semantics), so this file runs only when a MySQL 8 is
reachable, and SKIPS otherwise (never adds to the offline failure count):

    S3INGEST_TEST_MYSQL=host=127.0.0.1;port=13399;user=root;password=root;db=t
    docker run -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=t -p 13399:3306 mysql:8.0
"""

import io
import json
import os
import threading

import pytest

import engine as H
from conftest import DS_A, FakeS3, make_dicom
from test_lastrowid_roundtrips import (
    _connect, _load_index_schema, SCHEMA_SQL,  # reuse the live-conn helpers
)


# ── connection that counts parent INSERT vs SELECT statements ────────────────
class _CountingCursor:
    def __init__(self, real, tally):
        self._c, self._t = real, tally

    def execute(self, sql, params=()):
        up = " ".join(sql.split()).upper()
        if up.startswith(("INSERT INTO PATIENT", "INSERT INTO STUDY",
                          "INSERT INTO SERIES")):
            self._t["parent_insert"] += 1
        elif up.startswith("SELECT") and (" FROM PATIENT " in up
                                          or " FROM STUDY " in up
                                          or " FROM SERIES " in up):
            self._t["parent_select"] += 1
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
        self._c = real
        self.tally = {"parent_insert": 0, "parent_select": 0}

    def reset(self):
        self.tally = {"parent_insert": 0, "parent_select": 0}

    def cursor(self, *a, **k):
        return _CountingCursor(self._c.cursor(*a, **k), self.tally)

    def commit(self): return self._c.commit()
    def rollback(self): return self._c.rollback()
    def ping(self, reconnect=True): return self._c.ping(reconnect=reconnect)
    def close(self): return self._c.close()


def _rows(conn, table):
    cur = conn.cursor(); cur.execute(f"SELECT * FROM {table}")
    out = cur.fetchall(); cur.close(); return out


def _seed_datastore_and_jobs(real):
    """The two aux tables _resolve_datastore / match_job read."""
    cur = real.cursor()
    cur.execute("DROP TABLE IF EXISTS datastores")
    cur.execute("CREATE TABLE datastores (id VARCHAR(36), s3_bucket_name "
                "VARCHAR(255), s3_prefix VARCHAR(255), deleted BOOLEAN, "
                "created_at INT)")
    cur.execute("INSERT INTO datastores VALUES (%s,%s,%s,%s,%s)",
                (DS_A, "bkt", "", False, 0))
    cur.execute("DROP TABLE IF EXISTS import_jobs")
    cur.execute("CREATE TABLE import_jobs (id VARCHAR(64), datastore_id "
                "VARCHAR(36), status VARCHAR(32), s3_input_uri VARCHAR(512), "
                "job_name VARCHAR(255), total_files INT, processed_files INT, "
                "failed_files INT, instances_imported INT, total_size_bytes "
                "BIGINT, progress_percentage FLOAT, error_message TEXT, "
                "error_details JSON, completed_at DATETIME, created_at INT)")
    cur.close(); real.commit()


def _sqs_record(key):
    return {"body": json.dumps({"Records": [
        {"eventName": "ObjectCreated:Put",
         "s3": {"bucket": {"name": "bkt"}, "object": {"key": key}}}]})}


@pytest.fixture
def live(monkeypatch):
    real = _connect()
    if real is None:
        pytest.skip("no live MySQL 8 (set S3INGEST_TEST_MYSQL / run the "
                    "throwaway container) — deadlock-avoidance test skipped")
    _load_index_schema(real)
    _seed_datastore_and_jobs(real)
    # index_events must not try to reach EventBridge in the test.
    import index_events
    monkeypatch.setattr(index_events, "begin_batch", lambda *a, **k: None)
    monkeypatch.setattr(index_events, "flush_batch", lambda *a, **k: None)
    monkeypatch.setattr(index_events, "emit_instances_indexed",
                        lambda *a, **k: None)
    s3 = FakeS3()
    monkeypatch.setattr(H, "s3_client", s3)
    monkeypatch.setattr(H, "_DEFER_COMMIT", True)
    conn = _CountingConn(real)
    yield conn, s3, real
    real.close()


def test_same_study_batch_upserts_parents_once(live):
    """A 15-object same-study batch => 1 patient + 1 study + 1 series INSERT.

    Before the fix that batch issued 15 patient + 15 study + 15 series upserts,
    each taking a write lock on the SAME contended unique keys. After: 3 total.
    """
    conn, s3, real = live
    recs = []
    for i in range(15):
        from pydicom.uid import generate_uid
        data = make_dicom(sop_uid=generate_uid())  # shared study/series/patient
        s3.put("bkt", f"o{i}.dcm", data)
        recs.append(_sqs_record(f"o{i}.dcm"))

    cache = H._ParentCache()
    job_cache = {}
    conn.reset()
    for r in recs:
        H._process_message(conn, r, job_cache, cache=cache)
    real.commit()

    # THE deadlock-storm fix: contended parent WRITES collapse 45 -> 3.
    assert conn.tally["parent_insert"] == 3, (
        f"expected 3 parent INSERTs (1 each), got "
        f"{conn.tally['parent_insert']} — batch grouping is not deduping")
    # Correct row shape: parents deduped, every instance landed.
    assert len(_rows(conn, "patient")) == 1
    assert len(_rows(conn, "study")) == 1
    assert len(_rows(conn, "series")) == 1
    assert len(_rows(conn, "instance")) == 15
    assert len(_rows(conn, "storage_index")) == 15
    # every instance linked to a distinct storage_index row
    cur = conn.cursor()
    cur.execute("SELECT content_pkey FROM instance")
    cps = [r[0] for r in cur.fetchall()]; cur.close()
    assert None not in cps and len(set(cps)) == 15


def test_multi_study_batch_groups_each_study_independently(live):
    """A batch spanning 3 studies (5 objects each) => 3 patient/3 study/3 series
    INSERTs, not 15 — grouping must not assume one study per batch."""
    conn, s3, real = live
    from pydicom.uid import generate_uid
    recs = []
    n = 0
    for st in range(3):
        study = f"1.2.900.{st}"
        series = f"1.2.900.{st}.1"
        pid = f"PT{st}"
        for j in range(5):
            data = make_dicom(sop_uid=generate_uid(), study_uid=study,
                              series_uid=series, patient_id=pid)
            s3.put("bkt", f"m{n}.dcm", data)
            recs.append(_sqs_record(f"m{n}.dcm"))
            n += 1

    cache = H._ParentCache()
    conn.reset()
    for r in recs:
        H._process_message(conn, r, {}, cache=cache)
    real.commit()

    assert conn.tally["parent_insert"] == 9, (  # 3 patient + 3 study + 3 series
        f"expected 9 parent INSERTs across 3 studies, got "
        f"{conn.tally['parent_insert']}")
    assert len(_rows(conn, "patient")) == 3
    assert len(_rows(conn, "study")) == 3
    assert len(_rows(conn, "series")) == 3
    assert len(_rows(conn, "instance")) == 15


def test_reingest_takes_no_parent_write_lock(live):
    """Pure re-ingest of an already-indexed batch => 0 parent INSERTs.

    The contended hot path (re-ingest, or a study whose instances already
    landed) resolves parents with a shared-read SELECT and never takes the
    write lock that forms the deadlock cycle. Idempotent: no duplicate rows.
    """
    conn, s3, real = live
    from pydicom.uid import generate_uid
    recs = []
    for i in range(10):
        data = make_dicom(sop_uid=generate_uid())
        s3.put("bkt", f"r{i}.dcm", data)
        recs.append(_sqs_record(f"r{i}.dcm"))

    # first ingest: creates the 3 parents
    for r in recs:
        H._process_message(conn, r, {}, cache=H._ParentCache())
    real.commit()
    assert len(_rows(conn, "instance")) == 10

    # re-ingest the identical batch: SELECT-first, ZERO parent writes
    conn.reset()
    for r in recs:
        H._process_message(conn, r, {}, cache=H._ParentCache())
    real.commit()
    assert conn.tally["parent_insert"] == 0, (
        f"re-ingest took {conn.tally['parent_insert']} parent write(s); "
        f"SELECT-first must take none")
    assert conn.tally["parent_select"] >= 3  # it resolved via reads
    # idempotent: still exactly one of each parent, ten instances
    assert len(_rows(conn, "patient")) == 1
    assert len(_rows(conn, "study")) == 1
    assert len(_rows(conn, "series")) == 1
    assert len(_rows(conn, "instance")) == 10
    assert len(_rows(conn, "storage_index")) == 10


def test_concurrent_new_study_does_not_deadlock(live):
    """Two connections ingesting the SAME brand-new study concurrently commit
    without a 1213 deadlock, and converge to one parent set.

    This is the exact shape that stormed live (many writers, shared new parents).
    With SELECT-first + deterministic-order inserts and ON DUP as the race
    backstop, both transactions complete and the parents are deduped.
    """
    conn, s3, real = live
    from pydicom.uid import generate_uid
    study, series, pid = "1.2.777.9", "1.2.777.9.1", "SHARED"
    # two disjoint sets of instances, SAME parents
    a = [make_dicom(sop_uid=generate_uid(), study_uid=study,
                    series_uid=series, patient_id=pid) for _ in range(8)]
    b = [make_dicom(sop_uid=generate_uid(), study_uid=study,
                    series_uid=series, patient_id=pid) for _ in range(8)]
    for i, d in enumerate(a): s3.put("bkt", f"a{i}.dcm", d)
    for i, d in enumerate(b): s3.put("bkt", f"b{i}.dcm", d)

    kv = _mysql_kv()
    errors = []
    barrier = threading.Barrier(2)

    def worker(prefix):
        import pymysql
        c = pymysql.connect(host=kv["host"], port=int(kv["port"]),
                            user=kv["user"], password=kv["password"],
                            database=kv["db"], autocommit=False,
                            charset="utf8mb4", connect_timeout=5)
        try:
            cache = H._ParentCache()
            barrier.wait()
            for i in range(8):
                H._process_event(
                    c, H.ObjectEvent("CREATED", "bkt", f"{prefix}{i}.dcm"),
                    {}, cache=cache)
            c.commit()
        except Exception as exc:  # pragma: no cover - failure path
            errors.append(exc)
            try: c.rollback()
            except Exception: pass
        finally:
            c.close()

    t1 = threading.Thread(target=worker, args=("a",))
    t2 = threading.Thread(target=worker, args=("b",))
    t1.start(); t2.start(); t1.join(30); t2.join(30)

    # _with_deadlock_retry is a backstop, but with SELECT-first the write-write
    # cycle is avoided; either way both workers must finish without surfacing a
    # deadlock error to the caller.
    assert not errors, f"concurrent ingest surfaced errors: {errors}"
    # converged to ONE parent set and all 16 instances landed
    assert len(_rows(conn, "patient")) == 1
    assert len(_rows(conn, "study")) == 1
    assert len(_rows(conn, "series")) == 1
    assert len(_rows(conn, "instance")) == 16


def _mysql_kv():
    raw = os.environ.get(
        "S3INGEST_TEST_MYSQL",
        "host=127.0.0.1;port=13399;user=root;password=root;db=t")
    return dict(p.split("=", 1) for p in raw.split(";") if "=" in p)
