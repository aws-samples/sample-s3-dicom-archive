"""ObjectRemoved soft-deletes the object's storage_index rows.

Before this fix only instance rows were soft-deleted; the storage_index row of
a removed object stayed live, so the settle pass's VF-unassign (keyed on
storage_index.deleted_at IS NOT NULL) never fired and NON_DICOM objects were
never retired at all.

Runs against s3-ingest by default; against the live v3 source with
S3INGEST_MODULE_DIR=../ingest S3INGEST_MODULE_ALIAS=engine.
"""

import json

import pytest

import engine as H
from conftest import DS_A, DS_B, make_dicom, make_tar

WSI = "1.2.840.10008.5.1.4.1.1.77.1.6"


def _sqs(*bodies):
    return {"Records": [{"messageId": f"m{n}", "body": json.dumps(b)}
                        for n, b in enumerate(bodies)]}


def _evt(name, key, bucket="bkt"):
    return {"Records": [{"eventName": name,
                         "s3": {"bucket": {"name": bucket},
                                "object": {"key": key}}}]}


@pytest.fixture
def world(fake_conn, fake_s3, monkeypatch):
    fake_conn.add_datastore(DS_A, "bkt", prefix="")
    monkeypatch.setattr(H, "s3_client", fake_s3)
    monkeypatch.setattr(H, "_get_db_conn", lambda: fake_conn)
    return fake_conn, fake_s3


def _put_and_ingest(fake_s3, key, data):
    fake_s3.put("bkt", key, data)
    H.handler(_sqs(_evt("ObjectCreated:Put", key)), None)


def _delete_and_remove(fake_s3, key):
    del fake_s3.objects[("bkt", key)]
    H.handler(_sqs(_evt("ObjectRemoved:Delete", key)), None)


def test_dicom_removal_soft_deletes_storage_row(world):
    fake_conn, fake_s3 = world
    _put_and_ingest(fake_s3, "a.dcm", make_dicom(sop_uid="1.2.55.1"))
    (si,) = fake_conn.rows("storage_index")
    assert si["deleted_at"] is None

    _delete_and_remove(fake_s3, "a.dcm")

    assert si["deleted_at"] == "now"
    assert all(i["deleted_at"] == "now" for i in fake_conn.rows("instance"))


def test_tar_removal_soft_deletes_every_member_slot(world):
    fake_conn, fake_s3 = world
    _put_and_ingest(fake_s3, "t.tar", make_tar(
        [(f"m{n}.dcm", make_dicom(sop_uid=f"1.2.56.{n}")) for n in range(3)]))
    assert len(fake_conn.rows("storage_index")) == 3

    _delete_and_remove(fake_s3, "t.tar")

    assert all(s["deleted_at"] == "now" for s in fake_conn.rows("storage_index"))


def test_non_dicom_removal_soft_deletes_storage_row(world):
    fake_conn, fake_s3 = world
    _put_and_ingest(fake_s3, "notes.txt", b"hello")
    (si,) = fake_conn.rows("storage_index")
    assert si["content_kind"] == "NON_DICOM" and si["deleted_at"] is None

    _delete_and_remove(fake_s3, "notes.txt")

    assert si["deleted_at"] == "now"


def test_late_remove_after_recreate_keeps_storage_row_live(world):
    """REMOVED processed after the key was re-uploaded: the guard skips it, so
    the storage row (and instance) of the new content stay live."""
    fake_conn, fake_s3 = world
    _put_and_ingest(fake_s3, "a.dcm", make_dicom(sop_uid="1.2.57.1"))
    _put_and_ingest(fake_s3, "a.dcm", make_dicom(sop_uid="1.2.57.2"))
    H.handler(_sqs(_evt("ObjectRemoved:Delete", "a.dcm")), None)

    (si,) = fake_conn.rows("storage_index")
    assert si["deleted_at"] is None
    assert [i["sopinstanceuid"] for i in fake_conn.rows("instance")
            if i["deleted_at"] is None] == ["1.2.57.2"]


def test_late_remove_of_non_dicom_after_recreate_keeps_row(world):
    fake_conn, fake_s3 = world
    _put_and_ingest(fake_s3, "notes.txt", b"v1")
    H.handler(_sqs(_evt("ObjectRemoved:Delete", "notes.txt")), None)  # key still there
    assert fake_conn.rows("storage_index")[0]["deleted_at"] is None


def test_reupload_after_removal_revives_storage_row(world):
    fake_conn, fake_s3 = world
    _put_and_ingest(fake_s3, "a.dcm", make_dicom(sop_uid="1.2.58.1"))
    _delete_and_remove(fake_s3, "a.dcm")
    _put_and_ingest(fake_s3, "a.dcm", make_dicom(sop_uid="1.2.58.1"))
    (si,) = fake_conn.rows("storage_index")
    assert si["deleted_at"] is None


def _seed(conn, key, sop_class, ds_id=DS_A, bucket="b"):
    conn.tables["series"].append({"series_pkey": 1, "datastore_id": ds_id,
                                  "seriesinstanceuid": "S", "study_pkey": 1,
                                  "availability": "ONLINE", "deleted_at": None})
    conn.tables["storage_index"].append({"content_pkey": 1, "datastore_id": ds_id,
                                         "s3_bucket_name": bucket, "s3_key": key,
                                         "s3_key_version": "",
                                         "content_kind": "DICOM",
                                         "deleted_at": None})
    conn.tables["instance"].append({"instanceid": 1, "datastore_id": ds_id,
                                    "series_pkey": 1, "content_pkey": 1,
                                    "sopclassuid": sop_class,
                                    "sopinstanceuid": "u1",
                                    "instanceavailability": "ONLINE",
                                    "instancenumber": None, "deleted_at": None})


def test_wsi_removal_keeps_storage_row_live(fake_conn):
    """WSI stays a discoverable OFFLINE catalog entry; QIDO joins storage_index
    on deleted_at IS NULL, so its storage row must stay live."""
    _seed(fake_conn, "s.svs", WSI)
    H._handle_removed(fake_conn, H.Datastore(id=DS_A, bucket="b", prefix=""), "b", "s.svs")
    assert fake_conn.rows("storage_index")[0]["deleted_at"] is None
    assert fake_conn.rows("instance")[0]["instanceavailability"] == "OFFLINE"


def test_storage_soft_delete_is_datastore_scoped(fake_conn):
    _seed(fake_conn, "x.dcm", "1.2.840.10008.5.1.4.1.1.2", ds_id=DS_B)
    H._handle_removed(fake_conn, H.Datastore(id=DS_A, bucket="b", prefix=""), "b", "x.dcm")
    assert fake_conn.rows("storage_index")[0]["deleted_at"] is None


def test_storage_soft_delete_shares_the_removal_transaction(fake_conn):
    _seed(fake_conn, "x.dcm", "1.2.840.10008.5.1.4.1.1.2")
    H._handle_removed(fake_conn, H.Datastore(id=DS_A, bucket="b", prefix=""), "b", "x.dcm")
    assert fake_conn.commits == 1
    assert fake_conn.rows("storage_index")[0]["deleted_at"] == "now"
    stmts = [s for s, _ in fake_conn.log]
    assert any(s.startswith("UPDATE storage_index SET deleted_at = NOW() "
                            "WHERE datastore_id = %s AND s3_key_hash") for s in stmts)
