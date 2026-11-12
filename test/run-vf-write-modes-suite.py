#!/usr/bin/env python3
"""E2E: the three virtual-folder write modes (run against a deployed stack).

NONE (read-only), EXISTING (write to a chosen storage), DEDICATED (a storage
created for the folder, with the folder's name), including STOW-RS through the
folder's DICOMweb endpoint and the permission rules:
  - EXISTING needs store permission on the chosen storage;
  - DEDICATED needs the storage-create permission (management datastores.canEdit);
  - STOW into a folder needs VF canStore.
Prerequisites on the target stack (the seeded test groups do not have them):
  - test-admin's group: virtual_folder_privileges [{"virtualFolderId":"*","canRead":true,"canStore":true}]
  - test-data_access and test-read_only groups: management virtualFolders canCreate/canEdit
    (so they reach the create route and the write-mode checks are what refuses them)

The suite applies these itself (as the deployment admin, VF_E2E_ADMIN_PW) and restores
the three groups afterwards.

Env: VF_E2E_API, VF_E2E_CF (CloudFront base for /dicomweb), VF_E2E_CLIENT_ID
(Cognito app client), VF_E2E_ADMIN_PW (deployment `admin` password), VF_E2E_DICOM_DIR
(a directory with at least 3 instances of one series). Cleans up every folder and
storage it creates.
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import glob, json, os, sys, time, uuid, urllib.request, urllib.error
import boto3, pydicom

API = os.environ['VF_E2E_API']
CF = os.environ['VF_E2E_CF']
CLIENT = os.environ['VF_E2E_CLIENT_ID']
SRC = sorted(p for p in glob.glob(os.environ['VF_E2E_DICOM_DIR'] + '/**/*', recursive=True) if os.path.isfile(p))[:3]
OUT = os.environ.get('VF_E2E_RESULTS', 'vf-write-modes-results.json')
TAG = uuid.uuid4().hex[:4]
results = []


def rec(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


def token(user, pw):
    return sign_in(boto3.client('cognito-idp'), CLIENT, user, pw)['AccessToken']


DEPLOY_ADMIN = token('admin', os.environ['VF_E2E_ADMIN_PW'])
ADMIN = token('test-admin', 'TestAdmin123!')
DATA = token('test-data_access', 'TestData123!')      # store on all storages, cannot create storages
RO = token('test-read_only', 'TestReadOnly123!')      # read-only on storages, no folder store


def http(method, url, tok, body=None, headers=None, raw=None, timeout=120):
    r = urllib.request.Request(url, method=method, headers={'Authorization': 'Bearer ' + tok, **(headers or {})})
    data = raw
    if body is not None:
        r.add_header('Content-Type', 'application/json'); data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, data=data, timeout=timeout) as resp:
            txt = resp.read()
            return resp.status, (json.loads(txt) if txt else {})
    except urllib.error.HTTPError as e:
        txt = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(txt)
        except ValueError:
            return e.code, {'raw': txt[:300]}


def api(method, path, tok=ADMIN, body=None):
    return http(method, API + path, tok, body)


def d(b):
    return b.get('data', b) if isinstance(b, dict) else b


def wait_active(ds_id, secs=400):
    for _ in range(secs // 10):
        st, b = api('GET', f'/datastores/{ds_id}')
        if d(b).get('status') == 'ACTIVE':
            return d(b)
        time.sleep(10)
    return d(b)


def stow(target, tok=ADMIN):
    boundary = 'vfe2e' + uuid.uuid4().hex
    body = b''
    for p in SRC:
        body += f'--{boundary}\r\nContent-Type: application/dicom\r\n\r\n'.encode() + open(p, 'rb').read() + b'\r\n'
    body += f'--{boundary}--\r\n'.encode()
    return http('POST', f'{CF}/dicomweb/{target}/studies', tok, raw=body,
                headers={'Content-Type': f'multipart/related; type="application/dicom"; boundary={boundary}',
                         'Accept': 'application/dicom+json'})


def qido(target, path, tok=ADMIN):
    st, b = http('GET', f'{CF}/dicomweb/{target}{path}', tok, headers={'Accept': 'application/dicom+json'})
    return st, (b if isinstance(b, list) else [])


study = str(pydicom.dcmread(SRC[0], stop_before_pixels=True).StudyInstanceUID)
created_vfs, created_ds = [], []


def group_of(username):
    st, b = http('GET', API + '/users', DEPLOY_ADMIN)
    users = d(b).get('items', d(b)) if isinstance(d(b), dict) else d(b)
    gid = next(u.get('privilegeGroupId') for u in users if (u.get('username') or u.get('cognitoUsername')) == username)
    return gid, d(http('GET', f'{API}/privilege-groups/{gid}', DEPLOY_ADMIN)[1])


def put_group(gid, g, **over):
    body = {k: g.get(k) for k in ('name', 'description', 'userMode', 'datastorePrivileges',
                                  'virtualFolderPrivileges', 'managementPrivileges', 'deploymentPrivileges')}
    body = {k: v for k, v in body.items() if v is not None}
    body.update(over)
    return http('PUT', f'{API}/privilege-groups/{gid}', DEPLOY_ADMIN, body)[0]


# Prerequisites (see the docstring), restored in `finally`.
saved = {}
for user in ('test-admin', 'test-data_access', 'test-read_only'):
    gid, g = group_of(user)
    saved[gid] = g
    if user == 'test-admin':
        st = put_group(gid, g, virtualFolderPrivileges=[{'virtualFolderId': '*', 'canRead': True, 'canStore': True}])
    else:
        mp = dict(g.get('managementPrivileges') or {})
        mp['virtualFolders'] = {**(mp.get('virtualFolders') or {}), 'canCreate': True, 'canEdit': True, 'canList': True}
        st = put_group(gid, g, managementPrivileges=mp)
    rec(f'prerequisite: {user} group updated', st == 200, f'status={st}')
time.sleep(310)   # the API authorizer caches privileges for up to 5 minutes
ADMIN = token('test-admin', 'TestAdmin123!')
DATA = token('test-data_access', 'TestData123!')
RO = token('test-read_only', 'TestReadOnly123!')

try:
    # ---------- storage for EXISTING ----------
    st, b = api('POST', '/datastores', body={'name': f'vfe2e-target-{TAG}'})
    target = d(b).get('id'); created_ds.append(target)
    rec('target storage ACTIVE', wait_active(target).get('status') == 'ACTIVE', target)

    # ---------- NONE ----------
    st, b = api('POST', '/virtual-folders', body={'name': f'vfe2e-ro-{TAG}', 'writeMode': 'NONE'})
    vf_ro = d(b).get('id'); created_vfs.append(vf_ro)
    rec('NONE: create', st in (200, 201) and d(b).get('writeMode') == 'NONE' and not d(b).get('writeDatastoreId'), f'status={st}')
    st, b = stow(vf_ro)
    rec('NONE: STOW to the folder refused (403, read-only)', st == 403 and 'read-only' in json.dumps(b), f'status={st} {json.dumps(b)[:120]}')

    # ---------- EXISTING ----------
    st, b = api('POST', '/virtual-folders', body={'name': f'vfe2e-ex-{TAG}', 'writeMode': 'EXISTING'})
    rec('EXISTING without a storage -> 400', st == 400, f'status={st}')
    st, b = api('POST', '/virtual-folders', body={'name': f'vfe2e-ex-{TAG}', 'writeMode': 'EXISTING', 'writeDatastoreId': str(uuid.uuid4())})
    rec('EXISTING with an unknown storage -> 400', st == 400, f'status={st}')
    st, b = api('POST', '/virtual-folders', RO, {'name': f'vfe2e-exro-{TAG}', 'writeMode': 'EXISTING', 'writeDatastoreId': target})
    if st in (200, 201):
        created_vfs.append(d(b).get('id'))
    rec('EXISTING by a user without store on that storage -> 403', st == 403, f'status={st} {json.dumps(b)[:140]}')
    st, b = api('POST', '/virtual-folders', body={'name': f'vfe2e-ex-{TAG}', 'writeMode': 'EXISTING', 'writeDatastoreId': target})
    vf_ex = d(b).get('id'); created_vfs.append(vf_ex)
    rec('EXISTING: create (store permission held)', st in (200, 201) and d(b).get('writeDatastoreId') == target, f'status={st}')

    st, b = stow(vf_ex, RO)
    rec('EXISTING: STOW by a user without folder store -> 403', st == 403, f'status={st}')
    st, b = stow(vf_ex)
    ok_refs = len((b.get('00081199') or {}).get('Value', [])) if isinstance(b, dict) else 0
    rec('EXISTING: STOW to the folder', st == 200 and ok_refs == len(SRC), f'status={st} stored={ok_refs}/{len(SRC)} {json.dumps(b)[:160] if st != 200 else ""}')
    st, rows = qido(target, f'/studies/{study}/instances')
    rec('EXISTING: instances are in the chosen storage', st == 200 and len(rows) == len(SRC), f'{len(rows)} instances')
    n = 0
    for _ in range(24):
        st, rows = qido(vf_ex, '/studies')
        n = len(rows)
        if n:
            break
        time.sleep(10)
    rec('EXISTING: the study shows in the folder (de-identified view)', n == 1, f'{n} studies via the folder')
    st, b = api('GET', f'/virtual-folders/{vf_ex}')
    stats = d(b)
    print('vf_ex:', json.dumps({k: stats.get(k) for k in ('writeMode', 'writeDatastoreId', 'writeDatastoreName', 'instanceCount', 'studyCount')}))

    st, b = api('PUT', f'/virtual-folders/{vf_ex}', body={'writeMode': 'NONE'})
    st2, b2 = api('GET', f'/virtual-folders/{vf_ex}')
    rec('switching to NONE clears the storage link', st == 200 and d(b2).get('writeMode') == 'NONE' and not d(b2).get('writeDatastoreId'),
        f'writeDatastoreId={d(b2).get("writeDatastoreId")}')
    st, b = stow(vf_ex)
    rec('after switching to NONE, STOW is refused', st == 403, f'status={st}')

    # ---------- DEDICATED ----------
    st, b = api('POST', '/virtual-folders', DATA, {'name': f'vfe2e dd {TAG}', 'writeMode': 'DEDICATED'})
    if st in (200, 201):
        created_vfs.append(d(b).get('id')); created_ds.append(d(b).get('writeDatastoreId'))
    rec('DEDICATED by a user who cannot create storages -> 403', st == 403, f'status={st} {json.dumps(b)[:140]}')

    vf_name = f'vfe2e ded {TAG}'
    st, b = api('POST', '/virtual-folders', body={'name': vf_name, 'writeMode': 'DEDICATED'})
    vf_dd = d(b).get('id'); created_vfs.append(vf_dd)
    dd = d(b).get('writeDatastoreId'); created_ds.append(dd)
    rec('DEDICATED: create', st in (200, 201) and bool(dd), f'status={st} storage={dd}')
    st, b = stow(vf_dd)
    rec('DEDICATED: STOW before the storage is ACTIVE -> 404 (not available yet)', st in (404, 200),
        f'status={st} (200 only if creation already finished)')
    ds = wait_active(dd)
    rec('DEDICATED: storage ACTIVE', ds.get('status') == 'ACTIVE', ds.get('status'))
    rec('DEDICATED: storage has the folder\'s name (space -> hyphen)', ds.get('name') == vf_name.replace(' ', '-'), repr(ds.get('name')))
    rec('DEDICATED: description says it belongs to the folder', vf_name in (ds.get('description') or '') and vf_dd in (ds.get('description') or ''),
        repr(ds.get('description')))
    st, b = api('POST', '/virtual-folders', body={'name': vf_name.replace(' ', '-'), 'writeMode': 'DEDICATED'})
    if st in (200, 201):
        created_vfs.append(d(b).get('id')); created_ds.append(d(b).get('writeDatastoreId'))
    rec('DEDICATED: a storage name clash is refused', st == 400 and 'already exists' in json.dumps(b), f'status={st}')

    st, b = stow(vf_dd)
    ok_refs = len((b.get('00081199') or {}).get('Value', [])) if isinstance(b, dict) else 0
    rec('DEDICATED: STOW to the folder', st == 200 and ok_refs == len(SRC), f'status={st} stored={ok_refs}/{len(SRC)}')
    st, rows = qido(dd, f'/studies/{study}/instances')
    rec('DEDICATED: instances are in the dedicated storage', st == 200 and len(rows) == len(SRC), f'{len(rows)} instances')
    st, rows = qido(target, f'/studies/{study}/instances')
    rec('DEDICATED: nothing went to the other storage', len(rows) == len(SRC), f'{len(rows)} (unchanged from the EXISTING test)')
    n = 0
    for _ in range(24):
        st, rows = qido(vf_dd, '/studies')
        n = len(rows)
        if n:
            break
        time.sleep(10)
    rec('DEDICATED: the study shows in the folder', n == 1, f'{n} studies via the folder')
    st, b = api('PUT', f'/virtual-folders/{vf_dd}', body={'description': 'edited', 'writeMode': 'DEDICATED'})
    st2, b2 = api('GET', f'/virtual-folders/{vf_dd}')
    rec('DEDICATED: re-saving keeps the same storage', d(b2).get('writeDatastoreId') == dd, f'{d(b2).get("writeDatastoreId")}')
finally:
    for v in created_vfs:
        if v:
            api('DELETE', f'/virtual-folders/{v}')
    for s in created_ds:
        if s:
            api('DELETE', f'/datastores/{s}')
    print(f'cleanup: {len([v for v in created_vfs if v])} folders, {len([s for s in created_ds if s])} storages deleted')
    for gid, g in saved.items():
        put_group(gid, g)
    print(f'restored {len(saved)} privilege groups')

json.dump(results, open(OUT, 'w'), indent=1)
sys.exit(0 if all(ok for _, ok, _ in results) else 1)
print(f"\n{sum(ok for _, ok, _ in results)}/{len(results)} passed")
