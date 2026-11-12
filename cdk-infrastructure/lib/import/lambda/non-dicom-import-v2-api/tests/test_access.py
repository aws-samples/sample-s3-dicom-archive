import json

import pytest

import access as a
from access import ApiError, Caller

DS = '11111111-1111-1111-1111-111111111111'
DS2 = '22222222-2222-2222-2222-222222222222'
VF = '33333333-3333-3333-3333-333333333333'


def ds_row(**kw):
    row = {'id': DS, 'name': 'Main', 'status': 'ACTIVE', 'access_level': None, 'deleted': 0,
           's3_bucket_name': 'stack-ds-main', 's3_prefix': None}
    row.update(kw)
    return row


def vf_row(**kw):
    row = {'id': VF, 'name': 'Folder', 'status': 'ACTIVE', 'write_mode': 'DEDICATED',
           'write_datastore_id': DS, 'deid_profile_id': None, 'deidentification_config': None, 'deleted': 0}
    row.update(kw)
    return row


def caller(ds=(), vf=()):
    return Caller('alice', 'SYSTEM_USER', list(ds), list(vf))


def grant(ds_id=DS, **kw):
    return {'datastoreId': ds_id, **kw}


def vgrant(vf_id=VF, **kw):
    return {'virtualFolderId': vf_id, **kw}


# --- writable rules ----------------------------------------------------------

@pytest.mark.parametrize('row,expected', [
    (ds_row(), True),
    (ds_row(access_level='read-write'), True),
    (ds_row(access_level='read-only'), False),
    (ds_row(status='CREATING'), False),
    (ds_row(status='SYNCING'), False),
    (ds_row(deleted=1), False),
    (None, False),
])
def test_storage_writable(row, expected):
    assert a.storage_writable(row) is expected


@pytest.mark.parametrize('vf,ds,expected', [
    (vf_row(), ds_row(), True),
    (vf_row(write_mode='EXISTING'), ds_row(), True),
    (vf_row(write_mode='NONE'), ds_row(), False),
    (vf_row(write_datastore_id=None), ds_row(), False),
    (vf_row(status='DISABLED'), ds_row(), False),
    (vf_row(deleted=True), ds_row(), False),
    (vf_row(), ds_row(access_level='read-only'), False),   # read-only storage behind the folder
    (vf_row(), ds_row(status='CREATING'), False),           # dedicated storage still being created
    (vf_row(), None, False),
    (vf_row(write_datastore_id=DS2), ds_row(), False),      # row is not the folder's storage
])
def test_folder_writable(vf, ds, expected):
    assert a.folder_writable(vf, ds) is expected


@pytest.mark.parametrize('vf,expected', [
    (vf_row(), False),
    (vf_row(deid_profile_id='p1'), True),
    (vf_row(deidentification_config='{"tagActions": []}'), False),
    (vf_row(deidentification_config='{}'), False),
    (vf_row(deidentification_config='null'), False),
    (vf_row(deidentification_config={'a': 1}), False),
    # V1 folder create stores this default on every folder: not de-identifying
    (vf_row(deidentification_config='{"enabled": false, "hashSalt": "x", "attributes": []}'), False),
    (vf_row(deidentification_config='{"enabled": true, "hashSalt": "x"}'), True),
    (vf_row(deidentification_config={'enabled': True}), True),
    (vf_row(deidentification_config={'enabled': 'true'}), False),
    (vf_row(deidentification_config='not json'), True),
    (vf_row(deid_profile_id='p1', deidentification_config='{"enabled": false}'), True),
])
def test_folder_deidentified(vf, expected):
    assert a.folder_deidentified(vf) is expected


# --- privileges --------------------------------------------------------------

def test_strict_boolean_grants():
    c = caller(ds=[grant(canStore='true', canRead=1)])
    assert not c.ds(DS, 'canStore')
    assert not c.ds(DS, 'canRead')


def test_wildcard_grant():
    c = caller(ds=[grant('*', canStore=True, canRead=True)], vf=[vgrant('*', canStore=True)])
    assert c.ds(DS2, 'canStore') and c.vf(VF, 'canStore') and c.is_admin()


def test_existing_folder_needs_storage_store():
    vf = vf_row(write_mode='EXISTING')
    assert not a.can_store_folder(caller(vf=[vgrant(canStore=True)]), vf)
    assert a.can_store_folder(caller(ds=[grant(canStore=True)], vf=[vgrant(canStore=True)]), vf)
    # DEDICATED: folder canStore is enough
    assert a.can_store_folder(caller(vf=[vgrant(canStore=True)]), vf_row())


def test_from_event_parses_context():
    ev = {'requestContext': {'authorizer': {
        'username': 'bob', 'userMode': 'DATA_USER', 'userId': 'sub-1',
        'datastorePrivileges': json.dumps([grant(canStore=True)]),
        'virtualFolderPrivileges': 'not json',
    }}}
    c = Caller.from_event(ev)
    assert c.username == 'bob' and c.user_mode == 'DATA_USER' and c.user_id == 'sub-1'
    assert c.ds(DS, 'canStore') and c.vf_privs == []


@pytest.mark.parametrize('name', ['', None, '../x', 'a/b', 'x' * 200, '..'])
def test_bad_usernames_refused(name):
    with pytest.raises(ApiError) as e:
        Caller(name, 'SYSTEM_USER', [], []).require_username()
    assert e.value.status == 403


# --- check_destination -------------------------------------------------------

def status_of(fn):
    with pytest.raises(ApiError) as e:
        fn()
    return e.value.status


def test_check_destination_statuses():
    store = caller(ds=[grant(canStore=True)])
    read = caller(ds=[grant(canRead=True)])
    nobody = caller()
    assert status_of(lambda: a.check_destination(store, 'bucket', DS, ds_row(), None)) == 400
    assert status_of(lambda: a.check_destination(store, 'datastore', 'not-a-uuid', ds_row(), None)) == 400
    assert status_of(lambda: a.check_destination(store, 'datastore', DS, None, None)) == 404
    assert status_of(lambda: a.check_destination(store, 'datastore', DS, ds_row(deleted=1), None)) == 404
    assert status_of(lambda: a.check_destination(nobody, 'datastore', DS, ds_row(), None)) == 404
    assert status_of(lambda: a.check_destination(read, 'datastore', DS, ds_row(), None)) == 403
    assert status_of(lambda: a.check_destination(
        store, 'datastore', DS, ds_row(access_level='read-only'), None)) == 403
    d = a.check_destination(store, 'datastore', DS, ds_row(), None)
    assert d['writeDatastoreId'] == DS and d['canAnalyze'] is False and d['deidentified'] is False
    # analyze needs canRead too
    assert status_of(lambda: a.check_destination(store, 'datastore', DS, ds_row(), None, need_read=True)) == 403


def test_check_destination_folder():
    c = caller(vf=[vgrant(canStore=True, canRead=True)])
    d = a.check_destination(c, 'virtualFolder', VF, vf_row(deid_profile_id='p'), ds_row())
    assert d['kind'] == 'virtualFolder' and d['writeDatastoreId'] == DS and d['deidentified'] is True
    assert d['canAnalyze'] is True
    assert status_of(lambda: a.check_destination(c, 'virtualFolder', VF, vf_row(write_mode='NONE'), ds_row())) == 403
    # EXISTING folder without canStore on its storage
    assert status_of(lambda: a.check_destination(
        c, 'virtualFolder', VF, vf_row(write_mode='EXISTING'), ds_row())) == 403
    # patients search: read-only folder is fine when writability is not required
    d = a.check_destination(c, 'virtualFolder', VF, vf_row(write_mode='NONE'), None,
                            need_store=False, need_read=True, need_writable=False)
    assert d['id'] == VF


def test_list_writable():
    c = caller(ds=[grant(canStore=True, canRead=True), grant(DS2, canStore=True)],
               vf=[vgrant(canStore=True)])
    datastores = [ds_row(), ds_row(id=DS2, name='Imported', access_level='read-only')]
    folders = [vf_row(), vf_row(id='44444444-4444-4444-4444-444444444444', write_mode='NONE')]
    out = a.list_writable(c, datastores, folders, {d['id']: d for d in datastores})
    assert [(d['kind'], d['id']) for d in out] == [('datastore', DS), ('virtualFolder', VF)]
    assert out[0]['canAnalyze'] is True and out[1]['canAnalyze'] is False
    assert 'bucket' not in out[0]
