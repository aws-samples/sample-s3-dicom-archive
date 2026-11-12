"""Overwrite of an S3 key with NEW UIDs must not leave the old instance live.

storage_index is keyed on the physical object (key + member slot), instance on
the SOP. Re-uploading a key with new Study/Series/SOP UIDs reuses the
content_pkey but writes a new instance row; the earlier instance must be
soft-deleted and its series/study registered for the aggregate recompute.
WSI pyramid levels legitimately share one content_pkey and must be kept.

Runs against s3-ingest by default; against the live v3 source with
S3INGEST_MODULE_DIR=../ingest S3INGEST_MODULE_ALIAS=engine.
"""

import json

import pytest

import engine as H
from conftest import DS_A, make_dicom, make_tar

WSI = "1.2.840.10008.5.1.4.1.1.77.1.6"


def _live(conn):
    return [i for i in conn.rows("instance") if i["deleted_at"] is None]


def _dicom(n, sop=None):
    """A DICOM in its own study/series, all UIDs derived from n."""
    return make_dicom(sop_uid=sop or f"1.2.777.{n}.3",
                      study_uid=f"1.2.777.{n}", series_uid=f"1.2.777.{n}.2")


@pytest.fixture
def ingest(fake_conn, fake_s3, datastore, monkeypatch):
    monkeypatch.setattr(H, "s3_client", fake_s3)

    def _run(key, data):
        fake_s3.put("bkt", key, data)
        cache = H._ParentCache()
        result = H._handle_created(fake_conn, datastore, "bkt", key, cache=cache)
        return result, cache
    return _run


def test_overwrite_with_new_uids_retires_the_old_instance(fake_conn, ingest):
    ingest("ts/a.dcm", _dicom(1))
    old = fake_conn.rows("instance")[0]

    result, cache = ingest("ts/a.dcm", _dicom(2))

    (live,) = _live(fake_conn)
    assert live["sopinstanceuid"] == "1.2.777.2.3"
    assert old["deleted_at"] == "now"
    # Same physical object, one live storage row carrying the new UIDs.
    (si,) = fake_conn.rows("storage_index")
    assert live["content_pkey"] == old["content_pkey"] == si["content_pkey"]
    assert si["deleted_at"] is None and si["sop_instance_uid"] == "1.2.777.2.3"
    # The retired instance is reported and its parents queued for recompute.
    assert result.retired == [{"sopUID": "1.2.777.1.3", "studyUID": "1.2.777.1",
                               "seriesUID": "1.2.777.1.2"}]
    assert old["series_pkey"] in cache.touched_series
    old_series = fake_conn._find("series", series_pkey=old["series_pkey"])
    assert old_series["study_pkey"] in cache.touched_study
    tss = getattr(cache, "touched_study_series_v2", None)
    if tss is not None:  # v3: the settle pass recomputes / cascades it
        assert (DS_A, "1.2.777.1", "1.2.777.1.2") in tss


def test_repeated_overwrites_leave_exactly_one_live_instance(fake_conn, ingest):
    for n in range(1, 5):
        ingest("ts/a.dcm", _dicom(n))
    (live,) = _live(fake_conn)
    assert live["sopinstanceuid"] == "1.2.777.4.3"
    assert len(fake_conn.rows("instance")) == 4


def test_identical_reupload_retires_nothing(fake_conn, ingest):
    ingest("ts/a.dcm", _dicom(1))
    result, _ = ingest("ts/a.dcm", _dicom(1))
    assert result.retired == []
    assert len(_live(fake_conn)) == 1


def test_new_sop_in_same_series_retires_old_sop(fake_conn, ingest):
    ingest("ts/a.dcm", make_dicom(sop_uid="1.2.778.1"))
    result, _ = ingest("ts/a.dcm", make_dicom(sop_uid="1.2.778.2"))
    assert [i["sopinstanceuid"] for i in _live(fake_conn)] == ["1.2.778.2"]
    assert [r["sopUID"] for r in result.retired] == ["1.2.778.1"]


def test_other_keys_are_untouched(fake_conn, ingest):
    ingest("ts/a.dcm", _dicom(1))
    ingest("ts/b.dcm", _dicom(2))
    ingest("ts/a.dcm", _dicom(3))
    assert sorted(i["sopinstanceuid"] for i in _live(fake_conn)) == \
        ["1.2.777.2.3", "1.2.777.3.3"]


def test_overwrite_purges_vf_membership_of_the_object(fake_conn, ingest):
    ingest("ts/a.dcm", _dicom(1))
    cpk = fake_conn.rows("storage_index")[0]["content_pkey"]
    fake_conn.tables["virtual_folder_assignments"] += [
        {"virtual_folder_id": "vf1", "content_pkey": cpk},
        {"virtual_folder_id": "vf1", "content_pkey": cpk + 100},
    ]
    vf_db = "vf_" + "a" * 32
    fake_conn.vf_databases = [vf_db, "vf_not_a_vf_db"]

    ingest("ts/a.dcm", _dicom(2))

    assert [r["content_pkey"] for r in fake_conn.rows("virtual_folder_assignments")] \
        == [cpk + 100]
    assert fake_conn.vf_instance_deletes == [(vf_db, (cpk,))]


def test_no_vf_purge_without_an_overwrite(fake_conn, ingest):
    ingest("ts/a.dcm", _dicom(1))
    cpk = fake_conn.rows("storage_index")[0]["content_pkey"]
    fake_conn.tables["virtual_folder_assignments"].append(
        {"virtual_folder_id": "vf1", "content_pkey": cpk})
    ingest("ts/a.dcm", _dicom(1))
    assert len(fake_conn.rows("virtual_folder_assignments")) == 1


# ── tar members (one content_pkey per member slot) ──────────────────────────
def _tar_of(ns):
    return make_tar([(f"m{n}.dcm", _dicom(n)) for n in ns])


def test_tar_reupload_with_new_uids_keeps_only_new_members(fake_conn, ingest):
    ingest("t/s.tar", _tar_of([1, 2, 3]))
    assert len(_live(fake_conn)) == 3

    # Same member sizes -> same slots: each slot's old SOP is retired in place.
    result, _ = ingest("t/s.tar", _tar_of([11, 12, 13]))

    assert sorted(i["sopinstanceuid"] for i in _live(fake_conn)) == \
        ["1.2.777.11.3", "1.2.777.12.3", "1.2.777.13.3"]
    assert len(result.retired) == 3
    assert len(fake_conn.rows("storage_index")) == 3


def test_tar_with_fewer_members_retires_vanished_slots(fake_conn, ingest):
    ingest("t/s.tar", _tar_of([1, 2, 3]))
    result, _ = ingest("t/s.tar", _tar_of([21]))

    assert [i["sopinstanceuid"] for i in _live(fake_conn)] == ["1.2.777.21.3"]
    live_slots = [s for s in fake_conn.rows("storage_index") if s["deleted_at"] is None]
    assert len(live_slots) == 1
    assert {r["sopUID"] for r in result.retired} == \
        {"1.2.777.1.3", "1.2.777.2.3", "1.2.777.3.3"}


def test_tar_with_a_failed_member_does_not_sweep_slots(fake_conn, ingest):
    ingest("t/s.tar", _tar_of([1, 2, 3]))
    good = _dicom(31)
    result, _ = ingest("t/s.tar", make_tar([("m.dcm", good), ("bad.dcm", b"\0" * 400)]))
    assert result.members_failed == 1
    # No sweep: slots not rewritten this time keep their (old) instances.
    assert len([s for s in fake_conn.rows("storage_index") if s["deleted_at"] is None]) == 3


def test_plain_object_replaced_by_tar_retires_whole_object_slot(fake_conn, ingest):
    ingest("x/obj", _dicom(1))
    ingest("x/obj", _tar_of([41, 42]))
    assert sorted(i["sopinstanceuid"] for i in _live(fake_conn)) == \
        ["1.2.777.41.3", "1.2.777.42.3"]
    whole = [s for s in fake_conn.rows("storage_index") if s["member_offset"] is None]
    assert whole[0]["deleted_at"] == "now"


# ── WSI: N level instances share one content_pkey ───────────────────────────
def _seed_wsi(conn, n_levels):
    conn.tables["study"].append({"study_pkey": 1, "datastore_id": DS_A,
                                 "studyinstanceuid": "W", "patient_pkey": 1,
                                 "deleted_at": None})
    conn.tables["series"].append({"series_pkey": 1, "datastore_id": DS_A,
                                  "seriesinstanceuid": "WS", "study_pkey": 1,
                                  "deleted_at": None})
    conn.tables["storage_index"].append({"content_pkey": 9, "datastore_id": DS_A,
                                         "s3_bucket_name": "bkt", "s3_key": "s.svs",
                                         "s3_key_version": "", "member_offset": None,
                                         "deleted_at": None})
    for lvl in range(n_levels):
        conn.tables["instance"].append({"instanceid": 500 + lvl, "datastore_id": DS_A,
                                        "series_pkey": 1, "content_pkey": 9,
                                        "sopclassuid": WSI,
                                        "sopinstanceuid": f"W.{lvl}",
                                        "deleted_at": None})


def test_wsi_sibling_levels_are_kept(fake_conn):
    _seed_wsi(fake_conn, 3)
    retired = H._retire_superseded_instances(
        fake_conn, DS_A, [9], [500, 501, 502], purge_vf=False)
    assert retired == []
    assert len(_live(fake_conn)) == 3


def test_wsi_leftover_level_from_older_slide_is_retired(fake_conn):
    _seed_wsi(fake_conn, 4)  # the old slide had 4 levels, the new one 3
    fake_conn.tables["virtual_folder_assignments"].append(
        {"virtual_folder_id": "vf1", "content_pkey": 9})
    cache = H._ParentCache()
    retired = H._retire_superseded_instances(
        fake_conn, DS_A, [9], [500, 501, 502], cache=cache, purge_vf=False)
    assert [r["sopUID"] for r in retired] == ["W.3"]
    assert sorted(i["instanceid"] for i in _live(fake_conn)) == [500, 501, 502]
    assert 1 in cache.touched_series
    # Same series: per-object VF membership is kept.
    assert len(fake_conn.rows("virtual_folder_assignments")) == 1


# ── ObjectRemoved + re-create ordering (through the SQS handler) ────────────
def _sqs(*bodies):
    return {"Records": [{"messageId": f"m{i}", "body": json.dumps(b)}
                        for i, b in enumerate(bodies)]}


def _evt(name, key):
    return {"Records": [{"eventName": name,
                         "s3": {"bucket": {"name": "bkt"}, "object": {"key": key}}}]}


@pytest.fixture
def world(fake_conn, fake_s3, monkeypatch):
    fake_conn.add_datastore(DS_A, "bkt", prefix="")
    monkeypatch.setattr(H, "s3_client", fake_s3)
    monkeypatch.setattr(H, "_get_db_conn", lambda: fake_conn)
    return fake_conn, fake_s3


def test_overwrite_emits_instance_deleted_for_the_old_sop(world, fake_events):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "k.dcm", _dicom(1))
    H.handler(_sqs(_evt("ObjectCreated:Put", "k.dcm")), None)
    fake_s3.put("bkt", "k.dcm", _dicom(2))
    H.handler(_sqs(_evt("ObjectCreated:Put", "k.dcm")), None)

    (deleted,) = fake_events.of_type("Instance Deleted")
    assert deleted["sopUID"] == "1.2.777.1.3"
    assert [i["sopinstanceuid"] for i in _live(fake_conn)] == ["1.2.777.2.3"]


def test_late_remove_after_recreate_keeps_the_new_instance(world, fake_events):
    """delete + re-upload; the REMOVED message is processed after the new
    CREATED: the key exists again, so the removal must not hide it."""
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "k.dcm", _dicom(1))
    H.handler(_sqs(_evt("ObjectCreated:Put", "k.dcm")), None)
    fake_s3.put("bkt", "k.dcm", _dicom(2))  # deleted, then re-uploaded
    H.handler(_sqs(_evt("ObjectCreated:Put", "k.dcm")), None)
    H.handler(_sqs(_evt("ObjectRemoved:Delete", "k.dcm")), None)

    assert [i["sopinstanceuid"] for i in _live(fake_conn)] == ["1.2.777.2.3"]


def test_remove_then_recreate_in_order(world):
    fake_conn, fake_s3 = world
    fake_s3.put("bkt", "k.dcm", _dicom(1))
    H.handler(_sqs(_evt("ObjectCreated:Put", "k.dcm")), None)
    del fake_s3.objects[("bkt", "k.dcm")]
    H.handler(_sqs(_evt("ObjectRemoved:Delete", "k.dcm")), None)
    assert _live(fake_conn) == []
    fake_s3.put("bkt", "k.dcm", _dicom(2))
    H.handler(_sqs(_evt("ObjectCreated:Put", "k.dcm")), None)
    assert [i["sopinstanceuid"] for i in _live(fake_conn)] == ["1.2.777.2.3"]
