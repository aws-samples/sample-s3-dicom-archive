"""Sidecar identity: resolution, sidecar-first pending study, late UID re-sync,
and the H1 binding rules.

H1 (CWE-639/345): a sidecar is `<slide key>.json` in the SAME bucket as the slide
its `filepath` names. It can never act on another bucket/datastore, on an object
it is not named after, or on anything but a virtualized WSI slide (TIFF object,
VL Whole Slide Microscopy instances). It never revives soft-deleted parents, and
every applied sidecar emits a SIDECAR_APPLIED audit event.
"""

import gzip
import json

import pytest

import engine as H
from conftest import DS_A, make_dicom
from ingest_errors import PermanentIngestError

TIFF_HEAD = b"II\x2a\x00" + b"\x00" * 60


def _dicom_json(**tag_values):
    """Build a DICOM-JSON dict from {tag: (vr, value)}."""
    out = {}
    for tag, (vr, val) in tag_values.items():
        if vr == "PN":
            out[tag] = {"vr": vr, "Value": [{"Alphabetic": val}]}
        else:
            out[tag] = {"vr": vr, "Value": [val]}
    return out


@pytest.fixture
def ds():
    return H.Datastore(id=DS_A, bucket="b", prefix="")


@pytest.fixture
def audits(monkeypatch):
    import index_events
    seen = []
    monkeypatch.setattr(index_events, "emit_audit_event", lambda **kw: seen.append(kw))
    return seen


def _seed_object(fake_conn, key, sop_class, levels=(0, 1), bucket="b",
                 study_deleted=None, series_deleted=None):
    """Seed an indexed object (one storage_index row, one instance per level)."""
    import path_ingest as S
    from engine import _stable_instanceid
    orig = S.Identity(None, key)
    fake_conn.tables["series"].append({"series_pkey": 1, "datastore_id": DS_A,
                                       "seriesinstanceuid": orig.series_uid,
                                       "study_pkey": 1, "availability": "ONLINE",
                                       "deleted_at": series_deleted})
    fake_conn.tables["study"].append({"study_pkey": 1, "datastore_id": DS_A,
                                      "studyinstanceuid": orig.study_uid,
                                      "deleted_at": study_deleted})
    fake_conn.tables["storage_index"].append({"content_pkey": 1, "datastore_id": DS_A,
                                              "s3_bucket_name": bucket, "s3_key": key,
                                              "s3_key_version": "",
                                              "content_kind": "DICOM",
                                              "deleted_at": None})
    for lvl in levels:
        sop = orig.sop_uid_for_level(lvl)
        fake_conn.tables["instance"].append({"instanceid": _stable_instanceid(DS_A, sop),
                                             "instance_pkey": lvl + 1,
                                             "datastore_id": DS_A,
                                             "series_pkey": 1, "content_pkey": 1,
                                             "sopclassuid": sop_class,
                                             "sopinstanceuid": sop,
                                             "instanceavailability": "ONLINE",
                                             "instancenumber": lvl + 1,
                                             "deleted_at": None})
        fake_conn.tables["Instancemetadata"].append({
            "instance_pkey": lvl + 1, "content_pkey": 1,
            "metadata": gzip.compress(json.dumps({
                "0020000D": {"vr": "UI", "Value": [orig.study_uid]},
                "00080018": {"vr": "UI", "Value": [sop]}}).encode()),
            "metadataendoffset": 0, "frame_offsets": b"[]",
            "jpeg_tables_offset": None, "jpeg_tables_length": None})
    return orig


def _snapshot(fake_conn):
    return json.dumps({t: fake_conn.tables[t] for t in
                       ("patient", "study", "series", "instance")},
                      default=repr, sort_keys=True)


# ── identity resolution ───────────────────────────────────────────────────────
def test_identity_synthetic_without_sidecar():
    import path_ingest as S
    ident = S.Identity(None, "slides/CMU-1.svs")
    assert ident.study_uid.startswith("2.25.")
    assert ident.patient_id.startswith("SVS-")
    assert ident.patient_name == "CMU-1.svs"
    # deterministic
    assert ident.study_uid == S.Identity(None, "slides/CMU-1.svs").study_uid
    assert ident.sop_uid_for_level(0) != ident.sop_uid_for_level(1)


def test_identity_sidecar_overrides():
    import path_ingest as S
    block = _dicom_json(**{
        "00100020": ("LO", "PID-42"),
        "00100010": ("PN", "Doe^Jane"),
        "0020000D": ("UI", "1.2.3.4.5"),
        "00080050": ("SH", "ACC9"),
    })
    ident = S.Identity(S._sidecar_ds_from_json({"DICOM": block}), "slides/x.svs")
    assert ident.study_uid == "1.2.3.4.5"
    assert ident.patient_id == "PID-42"
    assert ident.patient_name == "Doe^Jane"
    assert ident.accession == "ACC9"
    # series not supplied -> synthetic
    assert ident.series_uid.startswith("2.25.")


# ── legitimate flows (bound sidecar next to its slide) ────────────────────────
def test_sidecar_first_creates_pending_offline_series(fake_conn, fake_s3, ds, audits):
    import path_ingest as S
    # SVS is NOT in the bucket yet; sidecar arrives first, named after it.
    sidecar = {"filepath": "s3://b/slides/x.svs",
               "DICOM": _dicom_json(**{"00100020": ("LO", "P1"),
                                       "0020000D": ("UI", "9.9.9")})}
    fake_s3.put("b", "slides/x.svs.json", json.dumps(sidecar).encode())
    S.process_sidecar(fake_conn, fake_s3, "b", "slides/x.svs.json", ds)

    # study/series created, zero instances, series OFFLINE, datastore-scoped
    assert len(fake_conn.tables["study"]) == 1
    assert len(fake_conn.tables["series"]) == 1
    assert len(fake_conn.tables["instance"]) == 0
    assert fake_conn.tables["series"][0]["availability"] == "OFFLINE"
    assert fake_conn.tables["study"][0]["datastore_id"] == DS_A
    assert fake_conn.tables["study"][0]["studyinstanceuid"] == "9.9.9"
    assert fake_conn.tables["series"][0]["datastore_id"] == DS_A
    (a,) = audits
    assert a["action"] == "SIDECAR_APPLIED" and a["resource_id"] == DS_A
    assert a["new_values"]["sourceBucket"] == "b"
    assert a["new_values"]["sourceKey"] == "slides/x.svs.json"
    assert a["new_values"]["targetDatastoreId"] == DS_A
    assert a["new_values"]["mode"] == "pending"
    assert a["new_values"]["studyUID"] == "9.9.9"


def test_sidecar_first_defers_when_svs_present_uningested(fake_conn, fake_s3, ds, audits):
    import path_ingest as S
    # SVS present in bucket but not yet ingested (no rows): sidecar should defer.
    fake_s3.put("b", "slides/x.svs", TIFF_HEAD)
    sidecar = {"filepath": "s3://b/slides/x.svs", "DICOM": {}}
    fake_s3.put("b", "slides/x.svs.json", json.dumps(sidecar).encode())
    S.process_sidecar(fake_conn, fake_s3, "b", "slides/x.svs.json", ds)
    # Nothing created — defers to retry after the SVS ingests. Nothing to audit.
    assert len(fake_conn.tables["study"]) == 0
    assert len(fake_conn.tables["series"]) == 0
    assert audits == []


def test_sidecar_without_filepath_fails_visibly(fake_conn, fake_s3, ds):
    import path_ingest as S
    fake_s3.put("b", "bad.json", json.dumps({"filepath": "", "DICOM": {}}).encode())
    with pytest.raises(PermanentIngestError, match="filepath"):
        S.process_sidecar(fake_conn, fake_s3, "b", "bad.json", ds)


def test_late_sidecar_resyncs_uids_and_rewrites_blob(fake_conn, fake_s3, ds, audits):
    import path_ingest as S
    from engine import _stable_instanceid

    key = "slides/x.svs"
    fake_s3.put("b", key, TIFF_HEAD)
    orig = _seed_object(fake_conn, key, S.WSI_SOP_CLASS_UID)

    # Late sidecar supplies real study + patient identity.
    sidecar = {"filepath": f"s3://b/{key}",
               "DICOM": _dicom_json(**{"00100020": ("LO", "REALPID"),
                                       "0020000D": ("UI", "1.2.999")})}
    fake_s3.put("b", f"{key}.json", json.dumps(sidecar).encode())
    S.process_sidecar(fake_conn, fake_s3, "b", f"{key}.json", ds)

    new_ident = S.Identity(S._sidecar_ds_from_json(sidecar), key)
    # Each instance's SOP UID + instanceid recomputed to the new identity —
    # still hashed with the datastore id.
    expected_ids = {_stable_instanceid(DS_A, new_ident.sop_uid_for_level(l))
                    for l in (0, 1)}
    got_ids = {r["instanceid"] for r in fake_conn.tables["instance"]}
    assert got_ids == expected_ids, (got_ids, expected_ids)

    # The physical-object linkage is unchanged: both instances still point at the
    # one storage_index row; the two metadata rows are rewritten in place.
    assert {r["content_pkey"] for r in fake_conn.tables["instance"]} == {1}
    assert len(fake_conn.tables["Instancemetadata"]) == 2

    # Metadata blobs rewritten with the new study UID + patient.
    for r in fake_conn.tables["Instancemetadata"]:
        js = json.loads(gzip.decompress(r["metadata"]))
        assert js["0020000D"]["Value"] == ["1.2.999"]
        assert js["00100020"]["Value"] == ["REALPID"]

    # Study row re-pointed at the sidecar's UID.
    assert fake_conn.tables["study"][0]["studyinstanceuid"] == "1.2.999"

    (a,) = audits
    assert a["new_values"]["mode"] == "resync"
    assert a["new_values"]["instances"] == 2
    assert set(a["new_values"]["previousSopInstanceUIDs"]) == {
        orig.sop_uid_for_level(0), orig.sop_uid_for_level(1)}


# ── H1 regressions ────────────────────────────────────────────────────────────
def test_h1_cross_bucket_sidecar_is_refused_and_changes_nothing(fake_conn, fake_s3, ds, audits):
    """filepath in another bucket (another datastore) is refused outright: no
    datastore lookup, no pending study, no rewrite there."""
    import path_ingest as S
    sidecar = {"filepath": "s3://other/slides/y.svs",
               "DICOM": _dicom_json(**{"0020000D": ("UI", "7.7.7")})}
    fake_s3.put("b", "slides/y.svs.json", json.dumps(sidecar).encode())
    before = _snapshot(fake_conn)
    with pytest.raises(PermanentIngestError, match="cross-bucket target"):
        S.process_sidecar(fake_conn, fake_s3, "b", "slides/y.svs.json", ds)
    assert _snapshot(fake_conn) == before
    assert audits == []


def test_h1_cross_bucket_refused_even_when_target_is_indexed(fake_conn, fake_s3, ds):
    """The identity-rewrite variant: the target object IS indexed in the other
    bucket; it must stay untouched."""
    import path_ingest as S
    fake_s3.put("other", "slides/y.svs", TIFF_HEAD)
    orig = _seed_object(fake_conn, "slides/y.svs", S.WSI_SOP_CLASS_UID, bucket="other")
    sidecar = {"filepath": "s3://other/slides/y.svs",
               "DICOM": _dicom_json(**{"00100020": ("LO", "ATTACKER"),
                                       "0020000D": ("UI", "6.6.6")})}
    fake_s3.put("b", "slides/y.svs.json", json.dumps(sidecar).encode())
    with pytest.raises(PermanentIngestError, match="cross-bucket target"):
        S.process_sidecar(fake_conn, fake_s3, "b", "slides/y.svs.json", ds)
    assert fake_conn.tables["study"][0]["studyinstanceuid"] == orig.study_uid


def test_h1_sidecar_not_named_after_its_target_is_refused(fake_conn, fake_s3, ds, audits):
    """Same bucket but aimed at a DIFFERENT object than the one it is named for."""
    import path_ingest as S
    fake_s3.put("b", "slides/x.svs", TIFF_HEAD)
    _seed_object(fake_conn, "slides/x.svs", S.WSI_SOP_CLASS_UID)
    for name in ("late.json", "slides/other.svs.json", "meta/x.svs.json", "slides/x.json"):
        sidecar = {"filepath": "s3://b/slides/x.svs",
                   "DICOM": _dicom_json(**{"0020000D": ("UI", "5.5.5")})}
        fake_s3.put("b", name, json.dumps(sidecar).encode())
        before = _snapshot(fake_conn)
        with pytest.raises(PermanentIngestError, match="must be named 'slides/x.svs.json'"):
            S.process_sidecar(fake_conn, fake_s3, "b", name, ds)
        assert _snapshot(fake_conn) == before, name
    assert audits == []


def test_h1_json_body_at_a_dcm_key_is_not_a_sidecar(fake_conn, fake_s3, ds, monkeypatch, audits):
    """The presigned-upload vector: a JSON sidecar body PUT to a `.dcm` key goes
    down the DICOM path and is rejected there; it is never applied."""
    import path_ingest as S
    fake_s3.put("b", "slides/x.svs", TIFF_HEAD)
    orig = _seed_object(fake_conn, "slides/x.svs", S.WSI_SOP_CLASS_UID)
    body = json.dumps({"filepath": "s3://b/slides/x.svs",
                       "DICOM": _dicom_json(**{"0020000D": ("UI", "4.4.4")})}).encode()
    key = "2026/10/27/1.2/1.3/1.4.dcm"
    fake_s3.put("b", key, body)
    monkeypatch.setattr(H, "s3_client", fake_s3)
    called = []
    monkeypatch.setattr(S, "process_sidecar", lambda *a, **k: called.append(a))
    with pytest.raises(PermanentIngestError, match="not ingestible DICOM"):
        H._handle_created(fake_conn, ds, "b", key)
    assert called == []
    assert fake_conn.tables["study"][0]["studyinstanceuid"] == orig.study_uid
    assert audits == []


def test_h1_sidecar_json_key_still_routes_to_process_sidecar(fake_conn, fake_s3, ds, monkeypatch):
    """The legitimate `<slide>.json` sidecar still takes the sidecar branch."""
    import path_ingest as S
    body = json.dumps({"filepath": "s3://b/slides/x.svs", "DICOM": {}}).encode()
    fake_s3.put("b", "slides/x.svs.json", body)
    monkeypatch.setattr(H, "s3_client", fake_s3)
    called = []
    monkeypatch.setattr(S, "process_sidecar", lambda *a, **k: called.append(a[2:4]))
    res = H._handle_created(fake_conn, ds, "b", "slides/x.svs.json")
    assert res.kind == "sidecar" and called == [("b", "slides/x.svs.json")]


def test_h1_sidecar_cannot_rewrite_a_non_wsi_instance(fake_conn, fake_s3, ds, audits):
    """A sidecar named after a regular DICOM object (CT) is refused: identity and
    SOP UIDs of non-WSI instances are never touched."""
    import path_ingest as S
    key = "2026/10/27/1.2/1.3/1.4.dcm"
    fake_s3.put("b", key, make_dicom())
    orig = _seed_object(fake_conn, key, "1.2.840.10008.5.1.4.1.1.2", levels=(0,))
    sidecar = {"filepath": f"s3://b/{key}",
               "DICOM": _dicom_json(**{"00100020": ("LO", "ATTACKER"),
                                       "0020000D": ("UI", "3.3.3")})}
    fake_s3.put("b", f"{key}.json", json.dumps(sidecar).encode())
    before = _snapshot(fake_conn)
    with pytest.raises(PermanentIngestError, match="not a virtualized WSI slide"):
        S.process_sidecar(fake_conn, fake_s3, "b", f"{key}.json", ds)
    assert _snapshot(fake_conn) == before
    assert fake_conn.tables["instance"][0]["sopinstanceuid"] == orig.sop_uid_for_level(0)
    assert audits == []


def test_h1_sidecar_cannot_rewrite_a_native_dicom_wsi_file(fake_conn, fake_s3, ds):
    """WSI SOP class but backed by a DICOM Part 10 object (not a TIFF slide):
    refused, because a sidecar only describes a virtualized SVS/BIF."""
    import path_ingest as S
    key = "wsi/native.dcm"
    fake_s3.put("b", key, make_dicom())
    _seed_object(fake_conn, key, S.WSI_SOP_CLASS_UID, levels=(0,))
    sidecar = {"filepath": f"s3://b/{key}", "DICOM": {}}
    fake_s3.put("b", f"{key}.json", json.dumps(sidecar).encode())
    before = _snapshot(fake_conn)
    with pytest.raises(PermanentIngestError, match="not a virtualized WSI slide"):
        S.process_sidecar(fake_conn, fake_s3, "b", f"{key}.json", ds)
    assert _snapshot(fake_conn) == before


def test_h1_sidecar_never_revives_soft_deleted_parents(fake_conn, fake_s3, ds):
    import path_ingest as S
    key = "slides/x.svs"
    fake_s3.put("b", key, TIFF_HEAD)
    _seed_object(fake_conn, key, S.WSI_SOP_CLASS_UID,
                 study_deleted="2026-10-01 00:00:00", series_deleted="2026-10-01 00:00:00")
    sidecar = {"filepath": f"s3://b/{key}",
               "DICOM": _dicom_json(**{"0020000D": ("UI", "2.2.2")})}
    fake_s3.put("b", f"{key}.json", json.dumps(sidecar).encode())
    S.process_sidecar(fake_conn, fake_s3, "b", f"{key}.json", ds)
    assert fake_conn.tables["study"][0]["deleted_at"] == "2026-10-01 00:00:00"
    assert fake_conn.tables["series"][0]["deleted_at"] == "2026-10-01 00:00:00"


def test_h1_audit_failure_does_not_fail_the_sidecar(fake_conn, fake_s3, ds, monkeypatch):
    import index_events
    import path_ingest as S
    monkeypatch.setattr(index_events, "emit_audit_event",
                        lambda **kw: (_ for _ in ()).throw(RuntimeError("bus down")))
    sidecar = {"filepath": "s3://b/slides/z.svs", "DICOM": {}}
    fake_s3.put("b", "slides/z.svs.json", json.dumps(sidecar).encode())
    S.process_sidecar(fake_conn, fake_s3, "b", "slides/z.svs.json", ds)
    assert len(fake_conn.tables["study"]) == 1


def test_h1_tiff_object_with_non_wsi_instances_is_refused(fake_conn, fake_s3, ds):
    """Defence in depth: even if the object starts with TIFF magic, a sidecar may
    only re-identify VL Whole Slide Microscopy instances (modality SM)."""
    import path_ingest as S
    key = "scans/page.tif"
    fake_s3.put("b", key, TIFF_HEAD)
    _seed_object(fake_conn, key, "1.2.840.10008.5.1.4.1.1.7", levels=(0,))  # Secondary Capture
    sidecar = {"filepath": f"s3://b/{key}", "DICOM": {}}
    fake_s3.put("b", f"{key}.json", json.dumps(sidecar).encode())
    before = _snapshot(fake_conn)
    with pytest.raises(PermanentIngestError, match="not a virtualized WSI slide"):
        S.process_sidecar(fake_conn, fake_s3, "b", f"{key}.json", ds)
    assert _snapshot(fake_conn) == before
