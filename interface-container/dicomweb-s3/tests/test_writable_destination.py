"""Writable-destination rule on the DICOMweb write paths.

A storage with datastores.access_level = 'read-only' (the default for an
imported bucket) is never written to: STOW-RS into it and DELETE from it are
refused with 403 "Storage is read-only", for every caller. A virtual folder
whose write storage is read-only refuses STOW the same way. Reads are
unaffected, and app-owned (NULL) and 'read-write' storages behave as before.
"""
import json

import pytest

import auth_middleware as A
import writable_destination as W
from conftest import DS_A, DS_B, STUDY_UID, base

VF_EXISTING_RO = "bbbbbbbb-0000-4000-8000-000000000001"
VF_DEDICATED_RW = "bbbbbbbb-0000-4000-8000-000000000002"
VF_STORE = [{"virtualFolderId": "*", "canRead": True, "canStore": True}]


def authenticate(service, path, headers, method):
    with service.app.test_request_context(path, headers=headers, method=method):
        return service.main.auth_middleware.authenticate_request()


@pytest.fixture
def ds_a_read_only(two_datastores):
    """Datastore A becomes an imported read-only storage; B gets 'read-write'."""
    conn = two_datastores.conn
    conn.find("datastores", id=DS_A)["access_level"] = "read-only"
    conn.find("datastores", id=DS_B)["access_level"] = "read-write"
    return conn


@pytest.fixture
def folders(ds_a_read_only, identities):
    conn = ds_a_read_only
    conn.insert("virtual_folders", id=VF_EXISTING_RO, name="on-ro", status="ACTIVE",
                write_mode="EXISTING", write_datastore_id=DS_A, deleted=False)
    conn.insert("virtual_folders", id=VF_DEDICATED_RW, name="on-rw", status="ACTIVE",
                write_mode="DEDICATED", write_datastore_id=DS_B, deleted=False)

    def grant(label, vf_privs):
        user = conn.find("users", cognito_username=label)
        membership = conn.find("user_privilege_groups", user_id=user["id"])
        group = conn.find("privilege_groups", id=membership["privilege_group_id"])
        group["virtual_folder_privileges"] = json.dumps(vf_privs)
    return grant


# ── the pure rule (mirrors the Node helper) ─────────────────────────────────
@pytest.mark.parametrize("level,writable", [(None, True), ("read-write", True),
                                            ("read-only", False), ("bogus", False)])
def test_access_level_rule(level, writable):
    assert W.is_writable_access_level(level) is writable


def test_storage_rule_reports_read_only_before_status():
    assert W.storage_write_problem({"status": "ACTIVE", "access_level": None}) is None
    assert W.storage_write_problem({"status": "SYNCING", "access_level": "read-only"}) == W.STORAGE_READ_ONLY
    assert "DELETING" in W.storage_write_problem({"status": "DELETING", "access_level": None})
    assert W.storage_write_problem(None) == "Storage not found"
    assert W.storage_write_problem({"status": "ACTIVE", "deleted": True}) == "Storage not found"


def test_folder_mode_rule():
    assert W.folder_mode_is_writable("EXISTING", "ds")
    assert W.folder_mode_is_writable("DEDICATED", "ds")
    assert not W.folder_mode_is_writable("NONE", None)
    assert not W.folder_mode_is_writable("EXISTING", None)


# ── datastore path ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE"])
def test_write_into_a_read_only_storage_is_refused(service, identities, ds_a_read_only, method):
    with pytest.raises(PermissionError, match="^Storage is read-only$"):
        authenticate(service, base(DS_A) + "/studies", identities["reader_a"].headers, method)


def test_admin_cannot_write_into_a_read_only_storage_either(service, identities, ds_a_read_only):
    with pytest.raises(PermissionError, match="read-only"):
        authenticate(service, base(DS_A) + "/studies", identities["admin"].headers, "POST")


def test_unauthorized_caller_gets_the_privilege_refusal_not_the_access_level(service, identities, ds_a_read_only):
    with pytest.raises(PermissionError, match="does not have store access"):
        authenticate(service, base(DS_A) + "/studies", identities["reader_b"].headers, "POST")


def test_reads_of_a_read_only_storage_are_unaffected(service, identities, ds_a_read_only):
    identity = authenticate(service, base(DS_A) + "/studies", identities["reader_a"].headers, "GET")
    assert identity.datastore_id == DS_A


def test_read_write_storage_still_accepts_writes(service, identities, ds_a_read_only):
    identity = authenticate(service, base(DS_B) + "/studies", identities["reader_b"].headers, "POST")
    assert identity.datastore_id == DS_B


def test_app_owned_storage_still_accepts_writes(service, identities, two_datastores):
    assert two_datastores.conn.find("datastores", id=DS_A)["access_level"] is None
    identity = authenticate(service, base(DS_A) + "/studies", identities["reader_a"].headers, "POST")
    assert identity.datastore_id == DS_A


def test_stow_over_http_into_a_read_only_storage_is_403(service, client, identities, ds_a_read_only, fake_s3):
    resp = client.post(base(DS_A) + "/studies", headers=identities["reader_a"].headers,
                       data=b"", content_type='multipart/related; type="application/dicom"; boundary=x')
    assert resp.status_code == 403
    assert json.loads(resp.get_data(as_text=True)) == {"error": "Storage is read-only"}


def test_delete_over_http_from_a_read_only_storage_is_403(service, client, identities, ds_a_read_only):
    resp = client.delete(base(DS_A) + f"/studies/{STUDY_UID}", headers=identities["reader_a"].headers)
    assert resp.status_code == 403
    assert "read-only" in resp.get_data(as_text=True)


def test_unauthenticated_mode_still_refuses_a_read_only_write(service, ds_a_read_only, monkeypatch):
    monkeypatch.setattr(A, "ALLOW_UNAUTHENTICATED_ACCESS", True)
    monkeypatch.setattr(service.main, "auth_middleware", A.AuthMiddleware(None, service.pool))
    with pytest.raises(PermissionError, match="requires authentication"):
        authenticate(service, base(DS_A) + "/studies", {}, "POST")


# ── Security: unauthenticated (DEV/DEBUG ONLY) mode is read-only ─────────
@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_unauthenticated_mode_refuses_writes_on_a_writable_datastore(service, ds_a_read_only, monkeypatch, method):
    monkeypatch.setattr(A, "ALLOW_UNAUTHENTICATED_ACCESS", True)
    monkeypatch.setattr(service.main, "auth_middleware", A.AuthMiddleware(None, service.pool))
    with pytest.raises(PermissionError, match="requires authentication"):
        authenticate(service, base(DS_B) + "/studies", {}, method)


def test_unauthenticated_mode_still_serves_reads(service, ds_a_read_only, monkeypatch):
    monkeypatch.setattr(A, "ALLOW_UNAUTHENTICATED_ACCESS", True)
    monkeypatch.setattr(service.main, "auth_middleware", A.AuthMiddleware(None, service.pool))
    ident = authenticate(service, base(DS_B) + "/studies", {}, "GET")
    assert ident.username is None and ident.include_private_tags is False


@pytest.mark.parametrize("method", ["POST", "DELETE"])
def test_unauthenticated_mode_refuses_folder_writes_and_unassigns(service, folders, monkeypatch, method):
    folders("admin", VF_STORE)
    monkeypatch.setattr(A, "ALLOW_UNAUTHENTICATED_ACCESS", True)
    monkeypatch.setattr(service.main, "auth_middleware", A.AuthMiddleware(None, service.pool))
    with pytest.raises(PermissionError, match="requires authentication"):
        authenticate(service, base(VF_EXISTING_RO) + "/studies", {}, method)


def test_stow_handler_has_no_bucket_for_a_read_only_storage(service, ds_a_read_only):
    # Defense in depth behind the middleware: the handler's own bucket lookup.
    assert service.main._source_bucket_for(DS_A) is None
    assert service.main._source_bucket_for(DS_B) == "archive-ds-b"


# ── virtual-folder path (auth_middleware._vf_write_datastore) ───────────────
def test_stow_into_a_folder_on_a_read_only_storage_is_refused(service, identities, folders):
    folders("admin", VF_STORE)
    with pytest.raises(PermissionError, match="storage is read-only"):
        authenticate(service, base(VF_EXISTING_RO) + "/studies", identities["admin"].headers, "POST")


def test_stow_over_http_into_a_folder_on_a_read_only_storage_is_403(service, client, identities, folders):
    folders("admin", VF_STORE)
    resp = client.post(base(VF_EXISTING_RO) + "/studies", headers=identities["admin"].headers,
                       data=b"", content_type='multipart/related; type="application/dicom"; boundary=x')
    assert resp.status_code == 403
    assert "read-only" in resp.get_data(as_text=True)


def test_stow_into_a_folder_on_a_read_write_storage_is_allowed(service, identities, folders):
    folders("reader_b", VF_STORE)
    identity = authenticate(service, base(VF_DEDICATED_RW) + "/studies", identities["reader_b"].headers, "POST")
    assert identity == A.RequestIdentity("reader_b", DS_B, False, virtual_folder_id=VF_DEDICATED_RW)


def test_reads_of_a_folder_on_a_read_only_storage_are_unaffected(service, identities, folders):
    folders("admin", VF_STORE)
    identity = authenticate(service, base(VF_EXISTING_RO) + "/studies", identities["admin"].headers, "GET")
    assert identity.virtual_folder_id == VF_EXISTING_RO
