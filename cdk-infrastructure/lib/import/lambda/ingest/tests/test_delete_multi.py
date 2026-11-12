"""_handle_removed handles multiple instances per S3 key and WSI-vs-DICOM.

Port deltas: the call takes (conn, datastore, bucket, key), matching is
datastore-scoped, and the return value ((deleted, offlined) summary lists)
feeds the synthetic 'Instance Deleted' / 'Instance Availability Changed'
events.
"""

import engine as H
from conftest import DS_A, DS_B

WSI = "1.2.840.10008.5.1.4.1.1.77.1.6"


def _seed(conn, key, sop_class, n=3, ds_id=DS_A, bucket="b"):
    """Seed n instances sharing one s3key under one series.

    Current schema: the physical object is ONE storage_index row (content_pkey);
    every instance links to it via instance.content_pkey, and _handle_removed
    matches through that FK (not a per-instance location row).
    """
    conn.tables["study"].append({"study_pkey": 1, "datastore_id": ds_id,
                                 "studyinstanceuid": "1.2.3", "deleted_at": None})
    conn.tables["series"].append({"series_pkey": 1, "datastore_id": ds_id,
                                  "seriesinstanceuid": "S", "study_pkey": 1,
                                  "availability": "ONLINE", "deleted_at": None})
    content_pkey = 1
    conn.tables["storage_index"].append({"content_pkey": content_pkey,
                                         "datastore_id": ds_id,
                                         "s3_bucket_name": bucket, "s3_key": key,
                                         "s3_key_version": "",
                                         "content_kind": "DICOM",
                                         "deleted_at": None})
    for i in range(n):
        iid = 1000 + i
        conn.tables["instance"].append({"instanceid": iid, "datastore_id": ds_id,
                                        "series_pkey": 1,
                                        "content_pkey": content_pkey,
                                        "sopclassuid": sop_class,
                                        "sopinstanceuid": f"uid.{i}",
                                        "instanceavailability": "ONLINE",
                                        "instancenumber": None, "deleted_at": None})


def _ds(ds_id=DS_A, bucket="b"):
    return H.Datastore(id=ds_id, bucket=bucket, prefix="")


def test_dicom_multi_instance_soft_delete(fake_conn):
    key = "a/multi.dcm"
    _seed(fake_conn, key, "1.2.840.10008.5.1.4.1.1.2", n=3)  # CT SOP class

    deleted, offlined = H._handle_removed(fake_conn, _ds(), "b", key)

    # All three soft-deleted (would have raised 1242 with the old scalar subquery).
    assert all(r["deleted_at"] == "now" for r in fake_conn.tables["instance"])
    assert fake_conn.commits == 1
    assert len(deleted) == 3 and offlined == []
    # The summaries carry what 'Instance Deleted' events need.
    assert {d["sopUID"] for d in deleted} == {"uid.0", "uid.1", "uid.2"}
    assert all(d["studyUID"] == "1.2.3" and d["seriesUID"] == "S" for d in deleted)


def test_wsi_removal_marks_offline_not_deleted(fake_conn):
    key = "slides/slide.svs"
    _seed(fake_conn, key, WSI, n=4)

    deleted, offlined = H._handle_removed(fake_conn, _ds(), "b", key)

    # WSI: instances go OFFLINE, rows retained (not soft-deleted).
    assert all(r["deleted_at"] is None for r in fake_conn.tables["instance"])
    assert all(r["instanceavailability"] == "OFFLINE" for r in fake_conn.tables["instance"])
    # And the series rollup followed (no live ONLINE instance remains).
    assert fake_conn.tables["series"][0]["availability"] == "OFFLINE"
    assert deleted == [] and len(offlined) == 4


def test_removal_of_unknown_key_is_noop(fake_conn):
    deleted, offlined = H._handle_removed(fake_conn, _ds(), "b", "never/ingested.dcm")
    assert fake_conn.commits == 1  # commits cleanly, nothing to change
    assert deleted == [] and offlined == []


def test_removal_is_datastore_scoped(fake_conn):
    """The same (bucket, key) indexed by another datastore must not be touched."""
    key = "shared/multi.dcm"
    _seed(fake_conn, key, "1.2.840.10008.5.1.4.1.1.2", n=1, ds_id=DS_B)

    deleted, offlined = H._handle_removed(fake_conn, _ds(DS_A), "b", key)

    assert deleted == [] and offlined == []
    assert fake_conn.tables["instance"][0]["deleted_at"] is None


def test_removal_skips_already_deleted_rows(fake_conn):
    key = "a/multi.dcm"
    _seed(fake_conn, key, "1.2.840.10008.5.1.4.1.1.2", n=2)
    fake_conn.tables["instance"][0]["deleted_at"] = "earlier"

    deleted, _ = H._handle_removed(fake_conn, _ds(), "b", key)

    assert len(deleted) == 1  # only the live one reported
    assert fake_conn.tables["instance"][0]["deleted_at"] == "earlier"
    assert fake_conn.tables["instance"][1]["deleted_at"] == "now"
