"""dedupe_sweep: retire duplicate live instance rows sharing one content_pkey.

Reuses the unit-suite FakeConn from conftest.py (it already understands the SQL of
engine._retire_superseded_instances / _purge_vf_membership) and adds
the sweep's own discovery/load statements.

Run: cd cdk-infrastructure/lib/import/lambda/ingest && python3.12 -m pytest tests/
"""
import pytest

import conftest as C  # shared fixtures + the pymysql/boto3 stubs (pytest loads it first)

import handler as h  # noqa: E402
import dedupe_sweep as D  # noqa: E402

DS_A, DS_B = C.DS_A, C.DS_B
CT = "1.2.840.10008.5.1.4.1.1.2"
WSI = "1.2.840.10008.5.1.4.1.1.77.1.6"


class SweepConn(C.FakeConn):
    def __init__(self):
        super().__init__()
        self.session_sets = []
        self.lock_wait = 50

    def dispatch(self, sql, params, cursor):
        s = " ".join(sql.split())
        up = s.upper()
        if up.startswith("SELECT @@SESSION.INNODB_LOCK_WAIT_TIMEOUT"):
            return [(self.lock_wait,)]
        if up.startswith("SET SESSION INNODB_LOCK_WAIT_TIMEOUT"):
            self.lock_wait = params[0]
            self.session_sets.append(params[0])
            return []
        if up.startswith("SELECT COALESCE(MAX(CONTENT_PKEY), 0) FROM STORAGE_INDEX"):
            return [(max([r["content_pkey"] for r in self.tables["storage_index"]] or [0]),)]
        if up.startswith("SELECT I.DATASTORE_ID, I.CONTENT_PKEY, COUNT(*)"):
            lo, hi = params[0], params[1]
            ds_f = params[2] if len(params) > 2 else None
            groups = {}
            for i in self.tables["instance"]:
                cpk = i.get("content_pkey")
                if (i["deleted_at"] is None and cpk is not None and lo < cpk <= hi
                        and (ds_f is None or i["datastore_id"] == ds_f)):
                    groups[(i["datastore_id"], cpk)] = groups.get((i["datastore_id"], cpk), 0) + 1
            return sorted([(d, c, n) for (d, c), n in groups.items() if n > 1],
                          key=lambda t: t[1])
        if up.startswith("SELECT I.INSTANCE_PKEY, I.INSTANCEID"):
            ds_id, cpk = params
            si = self._find("storage_index", content_pkey=cpk)
            out = []
            for i in sorted(self.tables["instance"], key=lambda r: r["instance_pkey"]):
                if (i["datastore_id"] != ds_id or i["content_pkey"] != cpk
                        or i["deleted_at"] is not None):
                    continue
                se = self._find("series", series_pkey=i["series_pkey"])
                st = self._find("study", study_pkey=se["study_pkey"]) if se else None
                out.append((i["instance_pkey"], i["instanceid"], i["sopinstanceuid"],
                            i["sopclassuid"], i.get("last_updated"),
                            se["seriesinstanceuid"] if se else None,
                            st["studyinstanceuid"] if st else None,
                            si["s3_bucket_name"], si["s3_key"], si.get("member_offset"),
                            si.get("member_length"), si.get("sop_instance_uid"),
                            si.get("deleted_at")))
            return out
        return super().dispatch(sql, params, cursor)


@pytest.fixture
def conn(monkeypatch):
    c = SweepConn()
    monkeypatch.setattr(D.engine, "_get_db_conn", lambda: c)
    return c


@pytest.fixture
def s3(monkeypatch):
    fake = C.FakeS3()
    monkeypatch.setattr(D.engine, "s3_client", fake)
    return fake


@pytest.fixture
def settled(monkeypatch):
    calls = []
    monkeypatch.setattr(h, "_settle_touched",
                        lambda conn, touched: calls.append(dict(touched)))
    return calls


@pytest.fixture
def events(monkeypatch):
    sent = []
    monkeypatch.setattr(D.engine.index_events, "emit_instances_deleted",
                        lambda ds, b, k, inst: sent.append((ds, k, list(inst))))
    return sent


_pk = {"n": 0}


def _seed_object(conn, cpk, key, sops, ds=DS_A, si_sop=None, sop_class=CT,
                 last_updated=None):
    """One storage_index row + one live instance per SOP, each in its own
    study/series (as an overwrite with new UIDs leaves them)."""
    conn.tables["storage_index"].append({
        "content_pkey": cpk, "datastore_id": ds, "s3_bucket_name": "bkt",
        "s3_key": key, "s3_key_version": "", "content_kind": "DICOM",
        "member_offset": None, "member_length": None,
        "sop_instance_uid": si_sop, "deleted_at": None})
    for n, sop in enumerate(sops):
        _pk["n"] += 1
        p = _pk["n"]
        conn.tables["study"].append({"study_pkey": p, "datastore_id": ds,
                                     "studyinstanceuid": f"st.{sop}",
                                     "patient_pkey": 1, "deleted_at": None})
        conn.tables["series"].append({"series_pkey": p, "datastore_id": ds,
                                      "seriesinstanceuid": f"se.{sop}",
                                      "study_pkey": p, "deleted_at": None})
        conn.tables["instance"].append({
            "instance_pkey": p, "instanceid": 1000 + p, "datastore_id": ds,
            "series_pkey": p, "content_pkey": cpk, "sopclassuid": sop_class,
            "sopinstanceuid": sop, "instanceavailability": "ONLINE",
            "last_updated": (last_updated or [None] * len(sops))[n],
            "deleted_at": None})


def _live(conn, cpk=None):
    return sorted(i["sopinstanceuid"] for i in conn.rows("instance")
                  if i["deleted_at"] is None and (cpk is None or i["content_pkey"] == cpk))


# ── dry run ─────────────────────────────────────────────────────────────────
def test_dry_run_reports_and_changes_nothing(conn, s3, settled, events):
    _seed_object(conn, 578, "a.dcm", ["1.9.1", "1.9.2", "1.9.3"])
    s3.put("bkt", "a.dcm", C.make_dicom(sop_uid="1.9.2"))
    _seed_object(conn, 600, "solo.dcm", ["1.9.9"])  # not a duplicate

    out = D.run({"mode": "dedupe-sweep"}, None)

    assert out["apply"] is False and out["done"] is True
    st = out["perDatastore"][DS_A]
    assert st["duplicateGroups"] == 1 and st["staleInstances"] == 2
    assert st["retiredInstances"] == 0 and st["rules"] == {"s3": 1}
    (row,) = out["rows"]
    assert row["contentPkey"] == 578 and row["survivor"]["sopUID"] == "1.9.2"
    assert sorted(r["sopUID"] for r in row["retire"]) == ["1.9.1", "1.9.3"]
    assert _live(conn) == ["1.9.1", "1.9.2", "1.9.3", "1.9.9"]
    assert settled == [] and events == []


def test_s3_uid_beats_newest(conn, s3, settled):
    """The S3 object holds the OLDEST row's SOP (overwritten back): keep it."""
    _seed_object(conn, 1, "a.dcm", ["old", "new"], last_updated=["2026-01-01", "2026-02-01"])
    s3.put("bkt", "a.dcm", C.make_dicom(sop_uid="old"))
    (row,) = D.run({"mode": "dedupe-sweep"}, None)["rows"]
    assert row["rule"] == "s3" and row["survivor"]["sopUID"] == "old"


def test_unreadable_object_falls_back_to_storage_index_uid(conn, s3, settled):
    _seed_object(conn, 1, "a.dcm", ["x1", "x2"], si_sop="x1")
    s3.put("bkt", "a.dcm", b"not dicom at all")
    (row,) = D.run({"mode": "dedupe-sweep"}, None)["rows"]
    assert row["rule"] == "storage_index_uid" and row["survivor"]["sopUID"] == "x1"
    assert "s3" in row


def test_falls_back_to_newest(conn, s3, settled):
    _seed_object(conn, 1, "a.dcm", ["y1", "y2", "y3"],
                 last_updated=["2026-01-03", "2026-01-01", "2026-01-02"])
    (row,) = D.run({"mode": "dedupe-sweep", "s3Check": False}, None)["rows"]
    assert row["rule"] == "newest" and row["survivor"]["sopUID"] == "y1"


def test_newest_tie_breaks_on_instance_pkey(conn, s3, settled):
    _seed_object(conn, 1, "a.dcm", ["z1", "z2"])
    (row,) = D.run({"mode": "dedupe-sweep", "s3Check": False}, None)["rows"]
    assert row["survivor"]["sopUID"] == "z2"


@pytest.mark.parametrize("setup,reason", [
    ("missing", "object_missing"),
    ("unindexed", "s3_uid_not_indexed"),
    ("wsi", "wsi"),
    ("storage_deleted", "storage_deleted"),
])
def test_skipped_groups_are_never_guessed(conn, s3, settled, setup, reason):
    _seed_object(conn, 1, "a.dcm", ["w1", "w2"],
                 sop_class=WSI if setup == "wsi" else CT)
    if setup == "unindexed":
        s3.put("bkt", "a.dcm", C.make_dicom(sop_uid="w9"))
    elif setup in ("wsi", "storage_deleted"):
        s3.put("bkt", "a.dcm", C.make_dicom(sop_uid="w1"))
    if setup == "storage_deleted":
        conn.rows("storage_index")[0]["deleted_at"] = "earlier"
    out = D.run({"mode": "dedupe-sweep", "apply": True}, None)
    assert out["perDatastore"][DS_A]["skipped"] == {reason: 1}
    assert out["rows"][0]["skipped"] == reason
    assert _live(conn) == ["w1", "w2"]


def test_apply_must_be_boolean_true(conn, s3, settled):
    _seed_object(conn, 1, "a.dcm", ["q1", "q2"])
    out = D.run({"mode": "dedupe-sweep", "apply": "true", "s3Check": False}, None)
    assert out["apply"] is False and _live(conn) == ["q1", "q2"]


def test_datastore_filter(conn, s3, settled):
    _seed_object(conn, 1, "a.dcm", ["d1", "d2"], ds=DS_A)
    _seed_object(conn, 2, "b.dcm", ["e1", "e2"], ds=DS_B)
    out = D.run({"mode": "dedupe-sweep", "datastoreId": DS_B, "s3Check": False}, None)
    assert list(out["perDatastore"]) == [DS_B]


# ── apply ───────────────────────────────────────────────────────────────────
def test_apply_retires_stale_rows_purges_vf_and_settles(conn, s3, settled, events):
    _seed_object(conn, 578, "a.dcm", ["1.9.1", "1.9.2", "1.9.3"])
    s3.put("bkt", "a.dcm", C.make_dicom(sop_uid="1.9.2"))
    conn.tables["virtual_folder_assignments"] += [
        {"virtual_folder_id": "vf1", "content_pkey": 578},
        {"virtual_folder_id": "vf1", "content_pkey": 999}]
    vf_db = "vf_" + "b" * 32
    conn.vf_databases = [vf_db]

    out = D.run({"mode": "dedupe-sweep", "apply": True}, None)

    assert _live(conn) == ["1.9.2"]
    assert out["perDatastore"][DS_A]["retiredInstances"] == 2
    assert out["rows"][0]["retired"] == 2
    # Stale VF membership of the object is purged (rules re-add the survivor).
    assert [r["content_pkey"] for r in conn.rows("virtual_folder_assignments")] == [999]
    assert conn.vf_instance_deletes == [(vf_db, (578,))]
    # One settle pass covering the retired rows' series AND the survivor's.
    (touched,) = settled
    assert set(touched) == {(DS_A, "st.1.9.1", "se.1.9.1"),
                            (DS_A, "st.1.9.2", "se.1.9.2"),
                            (DS_A, "st.1.9.3", "se.1.9.3")}
    assert all(v[0] == 578 for v in touched.values())
    (ev,) = events
    assert sorted(i["sopUID"] for i in ev[2]) == ["1.9.1", "1.9.3"]
    assert out["settledSeries"] == 3


def test_apply_is_idempotent(conn, s3, settled, events):
    _seed_object(conn, 1, "a.dcm", ["i1", "i2"], si_sop="i2")
    D.run({"mode": "dedupe-sweep", "apply": True, "s3Check": False}, None)
    again = D.run({"mode": "dedupe-sweep", "apply": True, "s3Check": False}, None)
    assert again["groupsExamined"] == 0 and _live(conn) == ["i2"]
    assert len(settled) == 1


def test_batched_with_resumable_cursor(conn, s3, settled):
    _seed_object(conn, 10, "a.dcm", ["c1", "c2"])
    _seed_object(conn, 20, "b.dcm", ["c3", "c4"])
    first = D.run({"mode": "dedupe-sweep", "apply": True, "s3Check": False,
                   "maxGroups": 1, "windowSize": 100}, None)
    assert first["done"] is False and first["stoppedBy"] == "maxGroups"
    assert first["nextAfterContentPkey"] == 19
    assert _live(conn, 20) == ["c3", "c4"]
    second = D.run({"mode": "dedupe-sweep", "apply": True, "s3Check": False,
                    "afterContentPkey": first["nextAfterContentPkey"]}, None)
    assert second["done"] is True and second["groupsExamined"] == 1
    assert _live(conn, 20) == ["c4"]


def test_lock_wait_is_bounded_and_restored(conn, s3, settled):
    _seed_object(conn, 1, "a.dcm", ["l1", "l2"])
    D.run({"mode": "dedupe-sweep", "apply": True, "s3Check": False,
           "lockWaitSeconds": 3}, None)
    assert conn.session_sets == [3, 50]
    # The apply re-read takes row locks under that bound.
    assert any(s.endswith("FOR UPDATE") for s, _ in conn.log)


def test_lock_timeout_skips_group_and_continues(conn, s3, settled, monkeypatch):
    _seed_object(conn, 1, "a.dcm", ["t1", "t2"])
    _seed_object(conn, 2, "b.dcm", ["t3", "t4"])
    real = D._retire_group

    def flaky(c, ds, cpk, s3r, cache):
        if cpk == 1:
            raise D.engine.pymysql.MySQLError(1205, "Lock wait timeout exceeded")
        return real(c, ds, cpk, s3r, cache)
    monkeypatch.setattr(D, "_retire_group", flaky)
    out = D.run({"mode": "dedupe-sweep", "apply": True, "s3Check": False}, None)
    assert [e["contentPkey"] for e in out["errors"]] == [1]
    assert _live(conn, 1) == ["t1", "t2"] and _live(conn, 2) == ["t4"]


def test_handler_routes_sweep_event(conn, s3, settled):
    out = h.handler({"mode": "dedupe-sweep"}, None)
    assert out["mode"] == "dedupe-sweep" and out["groupsExamined"] == 0
