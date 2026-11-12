"""Study download (.zip) behind the canDownload privilege.

Pinned here:
  * canDownload is a separate grant from canRead: a reader without it gets 403
    (audited as DOWNLOAD_STUDY FAILURE), and canDownload without canRead is
    still refused at the read gate;
  * the built-in admin-group downloads wherever it reads, with no stored
    canDownload key (schema-init re-seeds it without one);
  * the zip holds exactly the study's live instances, byte-identical for a
    storage and de-identified (same _deid_part10_chunks) for a folder;
  * the instance cap refuses up front and the byte cap aborts the body, so a
    short study can never arrive as a valid zip.
"""
import json
import zipfile
from io import BytesIO
from types import SimpleNamespace

import pydicom
import pytest
from pydicom.data import get_testdata_file

import auth_middleware
import privilege_checker
import vf_deid
from conftest import DS_A, DS_B, SOP_UID, SOP_UID_2, SOP_UID_3, STUDY_UID, base


def _add_user(conn, oidc, username, group_id, ds_privs, vf_privs=None):
    if not conn.find("privilege_groups", id=group_id):
        conn.insert("privilege_groups", id=group_id, name=group_id, deleted=False,
                    datastore_privileges=json.dumps(ds_privs),
                    virtual_folder_privileges=json.dumps(vf_privs or []),
                    management_privileges=json.dumps({"datastores": {"canEdit": False}}))
    user_db_id = f"user-{username}"
    conn.insert("users", id=user_db_id, cognito_username=username,
                email=f"{username}@example.test",
                status="ACTIVE", deleted=False)
    conn.insert("user_privilege_groups", user_id=user_db_id, privilege_group_id=group_id)
    return {"Authorization": f"Bearer {oidc.add(username)}"}


@pytest.fixture
def downloader(two_datastores, service, identities):
    return _add_user(service.conn, service.oidc, "downloader", "grp-dl",
                     [{"datastoreId": DS_A, "canRead": True, "canDownload": True}])


def _download(client, headers, ds=DS_A, study=STUDY_UID):
    return client.get(f"{base(ds)}/studies/{study}/download", headers=headers)


def _zip_members(response):
    zf = zipfile.ZipFile(BytesIO(response.get_data()))
    assert zf.testzip() is None
    return [zf.read(n) for n in sorted(zf.namelist())], sorted(zf.namelist())


def _download_audits(events):
    return [d for d in events.details() if d.get("action") == "DOWNLOAD_STUDY"]


# ── path parsing ─────────────────────────────────────────────────────────────
def test_download_path_shapes():
    assert auth_middleware.is_download_path(f"/dicomweb/{DS_A}/studies/1.2.3/download")
    assert not auth_middleware.is_download_path(f"/dicomweb/{DS_A}/studies/1.2.3")
    assert not auth_middleware.is_download_path(f"/dicomweb/{DS_A}/studies/1.2.3/series/download")
    assert auth_middleware.is_download_access_path(f"/dicomweb/{DS_A}/download-access")
    assert not auth_middleware.is_download_access_path(f"/dicomweb/{DS_A}/studies")


# ── privilege checker ────────────────────────────────────────────────────────
class _Conn:
    def __init__(self, row):
        # Accept a single group row or a list of group rows (the checker now
        # aggregates across all of a user's groups via fetchall()).
        self.rows = row if isinstance(row, list) else [row]

    def cursor(self):
        rows = self.rows
        return SimpleNamespace(execute=lambda *a: None,
                               fetchall=lambda: rows,
                               fetchone=lambda: (rows[0] if rows else None),
                               close=lambda: None)


def _row(group_id, ds=None, vf=None):
    return {"privilege_group_id": group_id, "datastore_privileges": json.dumps(ds or []),
            "virtual_folder_privileges": json.dumps(vf or []), "management_privileges": "{}"}


def test_missing_or_non_boolean_candownload_is_no_download():
    for entry in ({"datastoreId": "*", "canRead": True},
                  {"datastoreId": "*", "canRead": True, "canDownload": "true"},
                  {"datastoreId": "*", "canRead": True, "canDownload": 1}):
        assert not privilege_checker.check_datastore_download_access(
            "u", DS_A, _Conn(_row("grp-x", ds=[entry])))


def test_builtin_admin_group_downloads_wherever_it_reads():
    ds = [{"datastoreId": "*", "canRead": True}]
    vf = [{"virtualFolderId": "*", "canRead": True}]
    conn = _Conn(_row("admin-group", ds=ds, vf=vf))
    assert privilege_checker.check_datastore_download_access("admin", DS_A, conn)
    assert privilege_checker.check_virtual_folder_download_access("admin", "vf-1", conn)
    # Only the built-in group: a custom group with the same entries does not.
    other = _Conn(_row("grp-copy", ds=ds, vf=vf))
    assert not privilege_checker.check_datastore_download_access("u", DS_A, other)
    assert not privilege_checker.check_virtual_folder_download_access("u", "vf-1", other)
    # And never where the admin group cannot read.
    no_read = _Conn(_row("admin-group", ds=[{"datastoreId": "*", "canRead": False}]))
    assert not privilege_checker.check_datastore_download_access("admin", DS_A, no_read)


def test_vf_candownload_is_per_folder():
    conn = _Conn(_row("grp-vf", vf=[{"virtualFolderId": "vf-1", "canRead": True, "canDownload": True}]))
    assert privilege_checker.check_virtual_folder_download_access("u", "vf-1", conn)
    assert not privilege_checker.check_virtual_folder_download_access("u", "vf-2", conn)


# ── route: authorization ─────────────────────────────────────────────────────
def test_reader_without_candownload_gets_403_and_an_audit_row(two_datastores, service, client, identities):
    r = _download(client, identities["reader_a"].headers)
    assert r.status_code == 403
    rows = _download_audits(service.events)
    assert len(rows) == 1 and rows[0]["status"] == "FAILURE"


def test_download_access_probe_reports_the_verdict(two_datastores, service, client, identities, downloader):
    no = client.get(f"{base(DS_A)}/download-access", headers=identities["reader_a"].headers)
    yes = client.get(f"{base(DS_A)}/download-access", headers=downloader)
    assert no.status_code == 200 and no.get_json() == {"canDownload": False}
    assert yes.status_code == 200 and yes.get_json() == {"canDownload": True}
    # The probe still needs read access to the storage.
    other = client.get(f"{base(DS_B)}/download-access", headers=downloader)
    assert other.status_code == 403


def test_candownload_without_canread_is_refused(two_datastores, service, client, identities):
    h = _add_user(service.conn, service.oidc, "dl_noread", "grp-dl-noread",
                  [{"datastoreId": DS_A, "canRead": False, "canDownload": True}])
    assert _download(client, h).status_code == 403


def test_candownload_is_scoped_to_its_storage(two_datastores, service, client, downloader):
    assert _download(client, downloader, ds=DS_B).status_code == 403


# ── route: content ───────────────────────────────────────────────────────────
def test_zip_holds_every_live_instance_byte_identical(two_datastores, service, client, downloader):
    r = _download(client, downloader)
    assert r.status_code == 200
    assert r.headers["Content-Type"] == "application/zip"
    assert r.headers["Content-Disposition"] == f'attachment; filename="{STUDY_UID}.zip"'
    bodies, names = _zip_members(r)
    assert len(names) == 3 and all(n.startswith(f"{STUDY_UID}/IM") for n in names)
    assert set(bodies) == {two_datastores.object_bytes(DS_A, uid)
                           for uid in (SOP_UID, SOP_UID_2, SOP_UID_3)}
    audits = _download_audits(service.events)
    assert len(audits) == 1 and audits[0]["status"] == "SUCCESS"
    assert audits[0]["resourceType"] == "study" and audits[0]["resourceId"] == STUDY_UID


def test_builtin_admin_group_downloads_end_to_end(two_datastores, service, client):
    h = _add_user(service.conn, service.oidc, "builtin_admin", "admin-group",
                  [{"datastoreId": "*", "canRead": True, "canStore": True,
                    "canUpdate": True, "canDelete": True}])
    r = _download(client, h)
    assert r.status_code == 200
    assert len(_zip_members(r)[1]) == 3


def test_unknown_study_is_404(two_datastores, service, client, downloader):
    assert _download(client, downloader, study="1.2.3.4.5.6").status_code == 404


def test_instance_cap_refuses_up_front(two_datastores, service, client, downloader, monkeypatch):
    monkeypatch.setattr(service.main, "DOWNLOAD_MAX_INSTANCES", 2)
    r = _download(client, downloader)
    assert r.status_code == 413
    assert _download_audits(service.events)[0]["status"] == "FAILURE"


def test_byte_cap_aborts_the_body(two_datastores, service, client, downloader, monkeypatch):
    monkeypatch.setattr(service.main, "DOWNLOAD_MAX_BYTES", 10)
    with pytest.raises(Exception):
        _download(client, downloader).get_data()
    audits = _download_audits(service.events)
    assert audits and audits[-1]["status"] == "FAILURE"


# ── virtual folder: de-identified exactly like the WADO retrieve ─────────────
VF = "aaaaaaaa-0000-4000-8000-0000000000d1"
SALT = "pepper:" + VF
INDEX = vf_deid.build_action_index([{"tag": "00100010", "action": "REMOVE"},
                                    {"tag": "00100020", "action": "HASH_16"}])


def test_folder_download_serves_deidentified_objects(service, monkeypatch):
    main = service.main
    src = pydicom.dcmread(get_testdata_file("CT_small.dcm"))
    raw = open(get_testdata_file("CT_small.dcm"), "rb").read()

    def s3_get(bucket, key, byte_range=None):
        data = raw
        if byte_range:
            a, _, b = byte_range[len("bytes="):].partition("-")
            data = raw[int(a): (int(b) + 1) if b else None]
        return {"Body": SimpleNamespace(read=lambda: data,
                                        iter_chunks=lambda chunk_size: iter([data])),
                "ContentLength": len(data)}

    row = {"bucketname": "b", "s3key": "k", "member_offset": None, "member_length": None,
           "metadataendoffset": raw.rfind(b"\xe0\x7f\x10\x00"), "jpeg_tables_offset": None,
           "availability": "ONLINE"}
    monkeypatch.setattr(main, "_s3_get", s3_get)
    monkeypatch.setattr(main, "_execute_query", lambda q, p: [row, dict(row)])
    monkeypatch.setattr(main, "_vf_deid_context", lambda: (INDEX, True, SALT))
    path = f"/dicomweb/{VF}/studies/{STUDY_UID}/download"
    with service.app.test_request_context(path):
        main.g.identity = auth_middleware.RequestIdentity(
            "u", "", False, virtual_folder_id=VF, can_download=True)
        resp = main.download_study(StudyInstanceUID=STUDY_UID)
        data = b"".join(resp.response)
    zf = zipfile.ZipFile(BytesIO(data))
    assert len(zf.namelist()) == 2
    for name in zf.namelist():
        out = zf.read(name)
        ds = pydicom.dcmread(BytesIO(out))
        assert str(ds.PatientName) == ""
        assert ds.PatientID == vf_deid.hash_value(src.PatientID, SALT, "LO", 16)
        assert ds.PixelData == src.PixelData
        assert str(src.PatientName).encode() not in out
    audits = _download_audits(service.events)
    assert audits[-1]["status"] == "SUCCESS"
