"""STOW-RS into a virtual folder: the write-mode gate in auth_middleware.

A folder is a de-identified projection over source storages. Its write mode
decides whether its STOW endpoint takes data at all:

  * NONE (read-only)      -> 403, whoever asks.
  * EXISTING / DEDICATED  -> the request is authorized as a write into the
                             folder's write storage (virtual_folders.
                             write_datastore_id), and the handler assigns what it
                             stored to the folder. Requires VF canStore.
  * a write storage that is gone or not ACTIVE yet -> 404, never a write into
    whatever row happens to be there.

Reads of the same folder are unaffected by the write mode.
"""
import json

import pytest

import auth_middleware as A
from conftest import DS_A, DS_DELETING, base

VF_RO = "aaaaaaaa-0000-4000-8000-000000000001"
VF_EXISTING = "aaaaaaaa-0000-4000-8000-000000000002"
VF_PENDING = "aaaaaaaa-0000-4000-8000-000000000003"
VF_STORE = [{"virtualFolderId": "*", "canRead": True, "canStore": True}]
VF_READ = [{"virtualFolderId": "*", "canRead": True, "canStore": False}]


def authenticate(service, path, headers, method):
    with service.app.test_request_context(path, headers=headers, method=method):
        return service.main.auth_middleware.authenticate_request()


@pytest.fixture
def folders(two_datastores, identities):
    conn = two_datastores.conn
    conn.insert("virtual_folders", id=VF_RO, name="ro", status="ACTIVE",
                write_mode="NONE", write_datastore_id=None, deleted=False)
    conn.insert("virtual_folders", id=VF_EXISTING, name="ex", status="ACTIVE",
                write_mode="EXISTING", write_datastore_id=DS_A, deleted=False)
    # Points at a storage that is still being created / deleted.
    conn.insert("virtual_folders", id=VF_PENDING, name="pending", status="ACTIVE",
                write_mode="DEDICATED", write_datastore_id=DS_DELETING, deleted=False)

    def grant(label, vf_privs):
        user = conn.find("users", cognito_username=label)
        membership = conn.find("user_privilege_groups", user_id=user["id"])
        group = conn.find("privilege_groups", id=membership["privilege_group_id"])
        group["virtual_folder_privileges"] = json.dumps(vf_privs)
    return grant


def test_stow_into_a_read_only_folder_is_refused(service, identities, folders):
    folders("reader_a", VF_STORE)
    with pytest.raises(PermissionError, match="read-only"):
        authenticate(service, base(VF_RO) + "/studies", identities["reader_a"].headers, "POST")


def test_stow_into_a_writable_folder_is_a_write_into_its_storage(service, identities, folders):
    folders("reader_a", VF_STORE)
    identity = authenticate(service, base(VF_EXISTING) + "/studies",
                            identities["reader_a"].headers, "POST")
    assert identity == A.RequestIdentity("reader_a", DS_A, False, virtual_folder_id=VF_EXISTING)


def test_stow_into_a_writable_folder_needs_folder_store(service, identities, folders):
    folders("reader_a", VF_READ)
    with pytest.raises(PermissionError, match="store access to virtual folder"):
        authenticate(service, base(VF_EXISTING) + "/studies", identities["reader_a"].headers, "POST")


def test_stow_into_a_folder_whose_storage_is_not_active_is_a_404(service, identities, folders):
    folders("reader_a", VF_STORE)
    with pytest.raises(A.DatastoreNotFound):
        authenticate(service, base(VF_PENDING) + "/studies", identities["reader_a"].headers, "POST")


def test_stow_into_a_folder_without_a_token_is_refused(service, folders):
    with pytest.raises(ValueError):
        authenticate(service, base(VF_EXISTING) + "/studies", {}, "POST")


def test_stow_into_a_folder_is_never_served_unauthenticated(service, folders, monkeypatch):
    monkeypatch.setattr(A, "ALLOW_UNAUTHENTICATED_ACCESS", True)
    monkeypatch.setattr(service.main, "auth_middleware", A.AuthMiddleware(None, service.pool))
    with pytest.raises(PermissionError, match="requires authentication"):
        authenticate(service, base(VF_EXISTING) + "/studies", {}, "POST")


def test_a_read_of_a_writable_folder_is_still_a_folder_read(service, identities, folders):
    folders("reader_a", VF_STORE)
    identity = authenticate(service, base(VF_EXISTING) + "/studies",
                            identities["reader_a"].headers, "GET")
    # datastore_id stays empty: reads of a folder never become reads of its storage.
    assert identity == A.RequestIdentity("reader_a", "", False, virtual_folder_id=VF_EXISTING)


def test_stow_over_http_maps_a_read_only_folder_to_403(service, client, identities, folders):
    folders("reader_a", VF_STORE)
    resp = client.post(base(VF_RO) + "/studies", headers=identities["reader_a"].headers,
                       data=b"", content_type='multipart/related; type="application/dicom"; boundary=x')
    assert resp.status_code == 403
    assert "read-only" in resp.get_data(as_text=True)
