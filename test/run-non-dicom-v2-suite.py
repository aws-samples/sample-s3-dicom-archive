#!/usr/bin/env python3
"""Live suite: Non-DICOM Import V2 (plans/NON-DICOM-IMPORT-V2-CONTRACT.md).

Runs against a stack prepared by test/live/stack_setup.py (reads <workdir>/stack.env
and the deployment admin password). Every object it creates is named `ndv2-*` and removed at start and at end.

Setup (as the deployment `admin`):
  W   writable storage, seeded by STOW with the patients in fixtures/manifest.json
  E   EXISTING folder writing into W           D   DEDICATED folder (+ its storage)
  N   NONE (read-only view) folder             X   EXISTING folder on W with a de-id profile
  R   imported storage on the suite's own tagged bucket, access level read-only
Checks:
  destinations   only writable destinations the caller can store into, per user tier
  analysis       existing patient ranked first; new patient pre-filled, no strong
                 candidate; scanned PDF read; injection PDF gives normal fields and no
                 injected value; two files disagree; burned-in PNG; video not analysed;
                 patient search; key ownership
  validation     51 files, oversize declared size, unsupported type, Content-Length is
                 signed, modality vs magic bytes, unknown patient, foreign key, unknown
                 destination, de-id folder acknowledgement
  refusals       R and N: V2 upload-urls/create 403, V1 /import-jobs/upload-url, STOW,
                 folder settings (EXISTING on R) and STOW through such a folder
  end to end     imports into W (existing patient, new + existing study/series), E, D,
                 X, a partial import and a video import: per-file statuses, INDEXED,
                 QIDO, /metadata tags (0042,0010) (0008,0090) (0008,0023) (0008,0080),
                 folder visibility, source upload deleted
  audit          ANALYZE_DOCUMENT per call, without extracted values; the import's
                 acknowledgement flag in CREATE_NON_DICOM_IMPORT
  data user      one DATA_USER whose group is switched between store+read, store only
                 and read only

Usage:
  run-non-dicom-v2-suite.py <workdir> [--timeout S] [--region R] [--profile P]
                            [--keep] [--cleanup-only]
  run-non-dicom-v2-suite.py --dry-run     (fixtures + request bodies only: no AWS, no HTTP)
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, 'fixtures', 'non-dicom-v2')
GEN = os.path.join(FIX, 'generate_fixtures.py')
V2 = '/non-dicom-import/v2'
NAME = 'ndv2-'
MIB = 1024 * 1024
FIELDS = {'patientName', 'patientId', 'birthDate', 'sex', 'documentDate', 'documentType', 'documentTitle',
          'referringPhysician', 'institution', 'accessionNumber'}
ANALYSIS_KEYS = {'fields', 'candidates', 'model', 'escalated', 'status', 'reason', 'printedIdentifiers'}
SOP_PDF, SOP_SC, SOP_VIDEO = '1.2.840.10008.5.1.4.1.1.104.1', '1.2.840.10008.5.1.4.1.1.7', '1.2.840.10008.5.1.4.1.1.77.1.4.1'
TAGS = {'documentTitle': '00420010', 'referringPhysician': '00080090', 'contentDate': '00080023',
        'institutionName': '00080080'}
DU_PW = 'Ndv2-DataUser!2026'

results = []


def rec(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


def section(title):
    print(f'\n=== {title} ===', flush=True)


def step(title, fn, *a):
    """Run one section; an exception is a FAIL for that section, not the end of the run."""
    section(title)
    try:
        return fn(*a)
    except Exception as e:                                 # noqa: BLE001 - reported as a FAIL
        rec(f'{title}: ran without error', False, f'{type(e).__name__}: {e}')
        traceback.print_exc()
        return None


# --- fixtures -------------------------------------------------------------------------
def load_fixtures():
    manifest = os.path.join(FIX, 'manifest.json')
    m = json.load(open(manifest)) if os.path.exists(manifest) else None
    if not m or not all(os.path.exists(os.path.join(FIX, n)) for n in m['files']):
        subprocess.run([sys.executable, GEN], check=True)
        m = json.load(open(manifest))
    blobs = {n: open(os.path.join(FIX, n), 'rb').read() for n in m['files']}
    return m, blobs


def magic_ok(name, blob, ctype):
    if ctype == 'application/pdf':
        return blob[:4] == b'%PDF'
    if ctype == 'image/png':
        return blob[:4] == b'\x89PNG'
    if ctype == 'video/mp4':
        return blob[4:8] == b'ftyp'
    return False


def norm(s):
    """Loose comparison form: upper case, letters and digits only."""
    return re.sub(r'[^A-Z0-9]', '', str(s or '').upper())


def name_parts(pn):
    return [norm(p) for p in re.split(r'[\^ ,]+', str(pn or '')) if norm(p)]


def name_matches(got, want):
    """Every family/given component of `want` appears in `got` (order and middle initial free)."""
    g = norm(got)
    return bool(g) and all(p in g for p in name_parts(want)[:2])


# --- HTTP -----------------------------------------------------------------------------
def http(method, url, token=None, body=None, raw=None, headers=None, timeout=120):
    h = dict(headers or {})
    if token:
        h['Authorization'] = 'Bearer ' + token
    data = raw
    if body is not None:
        h['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    req = urllib.request.Request(url, method=method, headers=h, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except (urllib.error.URLError, OSError) as e:
        return 0, {}, str(e).encode()


def js(b):
    try:
        return json.loads(b) if b else {}
    except ValueError:
        return {'raw': b[:400].decode('utf-8', 'replace')}


def d(b):
    return b.get('data', b) if isinstance(b, dict) else b


def items(b):
    x = d(b)
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        for k in ('items', 'datastores', 'virtualFolders', 'users', 'groups', 'profiles', 'imports'):
            if isinstance(x.get(k), list):
                return x[k]
    return []


def short(b, n=160):
    return json.dumps(b)[:n]


class User:
    """A Cognito user with a token that is refreshed once on 401."""

    def __init__(self, ctx, username, password):
        self.ctx, self.username, self.password, self.token = ctx, username, password, None
        self.login()

    def login(self):
        self.token = sign_in(self.ctx.cog, self.ctx.client, self.username, self.password)['AccessToken']

    def call(self, method, url, **kw):
        st, h, b = http(method, url, self.token, **kw)
        if st == 401:
            self.login()
            st, h, b = http(method, url, self.token, **kw)
        return st, h, b

    def api(self, method, path, body=None, timeout=120):
        st, _, b = self.call(method, self.ctx.api + path, body=body, timeout=timeout)
        return st, js(b)

    def dw(self, target, path, accept='application/dicom+json'):
        st, _, b = self.call('GET', f'{self.ctx.cf}/dicomweb/{target}{path}', headers={'Accept': accept})
        try:
            return st, (json.loads(b) if b.strip() else [])
        except ValueError:
            return st, []

    def stow(self, target, blobs):
        boundary = 'ndv2' + uuid.uuid4().hex
        body = b''
        for blob in blobs:
            body += f'--{boundary}\r\nContent-Type: application/dicom\r\n\r\n'.encode() + blob + b'\r\n'
        body += f'--{boundary}--\r\n'.encode()
        st, _, b = self.call('POST', f'{self.ctx.cf}/dicomweb/{target}/studies', raw=body, headers={
            'Content-Type': f'multipart/related; type="application/dicom"; boundary={boundary}',
            'Accept': 'application/dicom+json'})
        return st, js(b)


def wait_for(check, timeout, every=10):
    """Poll check() -> (done, detail) until done or timeout."""
    deadline = time.time() + timeout
    while True:
        done, detail = check()
        if done or time.time() >= deadline:
            return done, detail
        time.sleep(every)


def tag_value(inst, tag):
    v = (inst.get(tag) or {}).get('Value') or [None]
    v = v[0]
    if isinstance(v, dict):
        v = v.get('Alphabetic')
    return v


# --- request bodies (shared by dry run and live run) ----------------------------------
def create_body(kind, dest, patient, study, series, files, ack=None):
    b = {'destinationKind': kind, 'destinationId': dest, 'patient': patient, 'study': study,
         'series': series, 'files': files}
    if ack is not None:
        b['acknowledgedContentNotDeidentified'] = ack
    return b


def new_patient(exp):
    return {'mode': 'new', 'patientId': exp['patientId'], 'patientName': exp['patientName'],
            'birthDate': exp.get('birthDate', ''), 'sex': exp.get('sex', '')}


def existing_patient(seed):
    return {'mode': 'existing', 'patientId': seed['patientId'], 'patientName': seed['patientName'],
            'birthDate': seed['birthDate'], 'sex': seed['sex']}


def new_study(desc, exp=None):
    exp = exp or {}
    return {'mode': 'new', 'studyInstanceUID': '', 'studyDescription': desc,
            'studyDate': exp.get('documentDate', time.strftime('%Y%m%d')),
            'accessionNumber': exp.get('accessionNumber', ''), 'referringPhysician': exp.get('referringPhysician', '')}


def series(ref, modality, desc, uid=None):
    return {'ref': ref, 'mode': 'existing' if uid else 'new', 'seriesInstanceUID': uid or '',
            'modality': modality, 'description': desc}


def file_entry(key, name, ref, exp=None, video=None):
    exp = exp or {}
    e = {'s3Key': key, 'fileName': name, 'seriesRef': ref, 'documentTitle': exp.get('documentTitle', ''),
         'contentDate': exp.get('documentDate', ''), 'institutionName': exp.get('institution', '')}
    # Optional, video (XC) only: what the UIs read from a <video> element's loadedmetadata.
    e.update(video or {})
    return e


# Declared for tiny.mp4 (the fixture carries no decodable track, so a browser would omit
# them; the API takes declared values as they are).
VIDEO_DIMS = {'videoWidth': 320, 'videoHeight': 240, 'numberOfFrames': 90, 'frameTime': 33.33}


# --- context --------------------------------------------------------------------------
class Ctx:
    pass


def make_ctx(args):
    import boto3
    env = dict(re.findall(r"^(\w+)='(.*)'$", open(os.path.join(args.workdir, 'stack.env')).read(), re.M))
    c = Ctx()
    c.env, c.args = env, args
    c.region = args.region or env.get('AWS_REGION') or os.environ.get('AWS_REGION') or 'us-east-1'
    c.session = boto3.Session(profile_name=args.profile or None, region_name=c.region)
    c.cog, c.s3 = c.session.client('cognito-idp'), c.session.client('s3')
    c.account = c.session.client('sts').get_caller_identity()['Account']
    c.api, c.cf, c.client, c.pool = env['API'].rstrip('/'), env['CF'].rstrip('/'), env['CLIENT'], env['POOL']
    c.prefix = env['STACK_PREFIX']
    c.tag = uuid.uuid4().hex[:6]
    c.timeout = args.timeout
    # The read-only probe bucket is reused across runs (one per account + stack). Its name must
    # not contain the stack prefix, or the import API treats it as one of the stack's own buckets.
    c.ro_bucket = f'dicom-archive-e2e-ndv2ro-{hashlib.sha1(c.prefix.encode()).hexdigest()[:8]}-{c.account}'
    c.upload_bucket = None
    c.upload_keys = set()          # every key upload-urls handed out this run
    c.analyzed = []                # (s3Key, destinationId) of every successful admin analyze
    c.audit_from = time.strftime('%Y-%m-%d', time.gmtime(time.time() - 86400))
    c.admin = User(c, 'admin', open(env['ADMIN_PW_FILE']).read().strip())
    return c


# --- cleanup ----------------------------------------------------------------------------
def sweep(c, label):
    """Remove every ndv2-* object on the stack (folders, profiles, users, groups, storages)
    and leftover ndv2-* uploads. Safe to run at start and end."""
    a = c.admin
    n = {}
    for vf in items(a.api('GET', '/virtual-folders')[1]):
        if str(vf.get('name', '')).startswith(NAME):
            n['folders'] = n.get('folders', 0) + (a.api('DELETE', f"/virtual-folders/{vf['id']}")[0] in (200, 204))
    for p in items(a.api('GET', '/virtual-folders/deid-profiles')[1]):
        if str(p.get('name', '')).startswith(NAME):
            n['profiles'] = n.get('profiles', 0) + (a.api('DELETE', f"/virtual-folders/deid-profiles/{p['id']}")[0] in (200, 204))
    for u in items(a.api('GET', '/users')[1]):
        if str(u.get('username', '')).startswith(NAME):
            n['users'] = n.get('users', 0) + (a.api('DELETE', f"/users/{u['id']}")[0] in (200, 204))
    for g in items(a.api('GET', '/privilege-groups')[1]):
        if str(g.get('name', '')).startswith(NAME):
            n['groups'] = n.get('groups', 0) + (a.api('DELETE', f"/privilege-groups/{g['id']}")[0] in (200, 204))
    ro_ids = []
    for ds in items(a.api('GET', '/datastores?pageSize=500')[1]):
        mine = str(ds.get('name', '')).startswith(NAME)
        on_ro = ds.get('s3BucketName') == c.ro_bucket
        if not (mine or on_ro) or ds.get('status') == 'DELETING':
            continue
        imported = bool(ds.get('imported')) or on_ro
        # App-owned storages: DELETE_ALL empties and removes their bucket. The imported one is
        # only deregistered; its bucket is the suite's own probe bucket, kept for the next run.
        st = a.api('DELETE', f"/datastores/{ds['id']}", {'deletionType': 'DEREGISTER' if imported else 'DELETE_ALL'})[0]
        n['storages'] = n.get('storages', 0) + (st in (200, 202, 204))
        if on_ro:
            ro_ids.append(ds['id'])
    if ro_ids:   # the bucket can back one storage only: wait until the old row is gone
        wait_for(lambda: (not any(x.get('id') in ro_ids and x.get('status') != 'DELETED'
                                  for x in items(a.api('GET', '/datastores?pageSize=500')[1])), ''), 300)
    n['uploads'] = sweep_uploads(c)
    print(f'  cleanup ({label}): {json.dumps(n)}', flush=True)


def sweep_uploads(c):
    if not c.upload_bucket:
        return 0
    gone = 0
    for k in sorted(c.upload_keys):
        try:
            c.s3.delete_object(Bucket=c.upload_bucket, Key=k)
            gone += 1
        except Exception:                                      # noqa: BLE001 - best effort
            pass
    for page in c.s3.get_paginator('list_objects_v2').paginate(Bucket=c.upload_bucket, Prefix='non-dicom-v2/'):
        for o in page.get('Contents', []):
            if re.match(r'^\d+-ndv2-', o['Key'].rsplit('/', 1)[-1]):
                c.s3.delete_object(Bucket=c.upload_bucket, Key=o['Key'])
                gone += 1
    return gone


# --- setup ------------------------------------------------------------------------------
def wait_active(c, ds_id, secs=600):
    def chk():
        st, b = c.admin.api('GET', f'/datastores/{ds_id}')
        return d(b).get('status') == 'ACTIVE', d(b).get('status')
    return wait_for(chk, secs)


def make_seed(seed):
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid
    ds = Dataset()
    ds.PatientName, ds.PatientID = seed['patientName'], seed['patientId']
    ds.PatientBirthDate, ds.PatientSex = seed['birthDate'], seed['sex']
    ds.StudyDescription, ds.StudyDate, ds.StudyTime = seed['studyDescription'], seed['studyDate'], '101500'
    ds.Modality, ds.SOPClassUID = 'MR', MRImageStorage
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID = generate_uid(), generate_uid(), generate_uid()
    ds.SeriesNumber = ds.InstanceNumber = 1
    ds.Rows = ds.Columns = 8
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
    ds.SamplesPerPixel, ds.PixelRepresentation, ds.PhotometricInterpretation = 1, 0, 'MONOCHROME2'
    ds.PixelData = bytes(128)
    fm = FileMetaDataset()
    fm.TransferSyntaxUID, fm.MediaStorageSOPClassUID = ExplicitVRLittleEndian, ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm
    buf = io.BytesIO()
    try:
        ds.save_as(buf, enforce_file_format=True)              # pydicom 3
    except TypeError:
        ds.save_as(buf, write_like_original=False)             # pydicom 2
    return str(ds.StudyInstanceUID), buf.getvalue()


def ensure_ro_bucket(c):
    s3 = c.s3
    try:
        s3.head_bucket(Bucket=c.ro_bucket)
    except Exception:                                          # noqa: BLE001 - absent: create it
        s3.create_bucket(Bucket=c.ro_bucket, **({} if c.region == 'us-east-1' else
                                                {'CreateBucketConfiguration': {'LocationConstraint': c.region}}))
        s3.put_public_access_block(Bucket=c.ro_bucket, PublicAccessBlockConfiguration={
            'BlockPublicAcls': True, 'IgnorePublicAcls': True, 'BlockPublicPolicy': True, 'RestrictPublicBuckets': True})
    try:
        tags = s3.get_bucket_tagging(Bucket=c.ro_bucket)['TagSet']
    except Exception:                                          # noqa: BLE001 - NoSuchTagSet
        tags = []
    if {'Key': 'Deployment', 'Value': c.prefix} not in tags:
        tags = [t for t in tags if t['Key'] != 'Deployment'] + [{'Key': 'Deployment', 'Value': c.prefix}]
        s3.put_bucket_tagging(Bucket=c.ro_bucket, Tagging={'TagSet': tags})
    # The owner's second step: the event notification to the ingest queue, as the setup
    # instructions give it (the archive never sets it on an imported bucket itself).
    st, b = c.admin.api('GET', f'/datastores/import/bucket-policy?bucketName={c.ro_bucket}')
    rule = next(s['json'] for s in d(b)['steps'] if 'QueueArn' in (s.get('json') or {}))
    cur = s3.get_bucket_notification_configuration(Bucket=c.ro_bucket)
    cur.pop('ResponseMetadata', None)
    cur['QueueConfigurations'] = [q for q in cur.get('QueueConfigurations', []) if q.get('Id') != rule['Id']] + [rule]
    s3.put_bucket_notification_configuration(Bucket=c.ro_bucket, NotificationConfiguration=cur)


def setup(c, m):
    a, t = c.admin, c.tag
    st, b = a.api('GET', V2 + '/destinations')
    rec('V2 API is deployed (GET /destinations as admin)', st == 200, f'status={st} {short(b) if st != 200 else ""}')
    if st != 200:
        raise RuntimeError('V2 API not reachable: is nonDicomImportV2 on and deployed?')

    st, b = a.api('POST', '/datastores', {'name': f'{NAME}w-{t}'})
    c.W = d(b).get('id')
    ok, s = wait_active(c, c.W)
    rec('setup: writable storage W ACTIVE', st in (200, 201) and ok, f'{c.W} {s}')

    c.seed_studies = {}
    blobs = []
    for seed in m['seeded']:
        study, blob = make_seed(seed)
        c.seed_studies[seed['patientId']] = study
        blobs.append(blob)
    st, b = a.stow(c.W, blobs)
    rec('setup: seed patients STOWed into W', st == 200, f'status={st} patients={len(blobs)}')

    def seeded():
        n = sum(1 for pid in c.seed_studies if a.dw(c.W, f'/studies?PatientID={pid}')[1])
        return n == len(c.seed_studies), f'{n}/{len(c.seed_studies)} in QIDO'
    ok, det = wait_for(seeded, c.timeout)
    rec('setup: seed patients indexed', ok, det)

    def vf(body):
        st, b = a.api('POST', '/virtual-folders', body)
        return st, d(b)
    st, x = vf({'name': f'{NAME}ex-{t}', 'writeMode': 'EXISTING', 'writeDatastoreId': c.W})
    c.E = x.get('id')
    rec('setup: EXISTING folder E on W', st in (200, 201) and x.get('writeDatastoreId') == c.W, f'status={st} {c.E}')
    st, x = vf({'name': f'{NAME}dd-{t}', 'writeMode': 'DEDICATED'})
    c.D, c.D_DS = x.get('id'), x.get('writeDatastoreId')
    ok, s = wait_active(c, c.D_DS) if c.D_DS else (False, None)
    rec('setup: DEDICATED folder D and its storage ACTIVE', st in (200, 201) and ok, f'status={st} {c.D} storage={c.D_DS} {s}')
    st, x = vf({'name': f'{NAME}none-{t}', 'writeMode': 'NONE'})
    c.N = x.get('id')
    rec('setup: NONE folder N', st in (200, 201) and c.N, f'status={st} {c.N}')
    st, b = a.api('POST', '/virtual-folders/deid-profiles', {
        'name': f'{NAME}prof-{t}', 'description': 'ndv2 suite', 'drop_private_tags': True,
        'tag_actions': [{'tag': '00100010', 'action': 'REMOVE'}, {'tag': '00100020', 'action': 'HASH_16'}]})
    prof = d(b).get('id')
    st2, x = vf({'name': f'{NAME}deid-{t}', 'writeMode': 'EXISTING', 'writeDatastoreId': c.W, 'deidProfileId': prof})
    c.X = x.get('id')
    rec('setup: de-identified EXISTING folder X on W', st in (200, 201) and st2 in (200, 201) and c.X,
        f'profile={st} folder={st2} {c.X}')

    ensure_ro_bucket(c)
    st, b = a.api('POST', '/datastores/import', {'name': f'{NAME}ro-{t}', 'bucketName': c.ro_bucket,
                                                 'accessLevel': 'read-only'})
    r = (d(b) or {}).get('datastore') or {}
    c.R = r.get('id')
    rec('setup: imported read-only storage R ACTIVE', st == 201 and r.get('status') == 'ACTIVE'
        and r.get('accessLevel') == 'read-only', f"status={st} {c.R} {r.get('status')} {r.get('accessLevel')}")

    # A folder set to EXISTING on R must be refused by the folder-settings API. If the API wrongly
    # accepts it, the folder is kept as RF so STOW and V2 can be checked against it too.
    st, x = vf({'name': f'{NAME}exro-{t}', 'writeMode': 'EXISTING', 'writeDatastoreId': c.R})
    c.RF = x.get('id') if st in (200, 201) else None
    rec('folder write path: creating an EXISTING folder on read-only R is refused', st in (400, 403),
        f'status={st} {short(x, 120)}')
    st, b = a.api('PUT', f'/virtual-folders/{c.N}', {'writeMode': 'EXISTING', 'writeDatastoreId': c.R})
    st2, b2 = a.api('GET', f'/virtual-folders/{c.N}')
    rec('folder write path: switching folder N to EXISTING on R is refused', st in (400, 403)
        and d(b2).get('writeMode') == 'NONE', f"status={st} now={d(b2).get('writeMode')}")
    if d(b2).get('writeMode') != 'NONE':
        a.api('PUT', f'/virtual-folders/{c.N}', {'writeMode': 'NONE'})


# --- destinations -----------------------------------------------------------------------
def dests(user):
    st, b = user.api('GET', V2 + '/destinations')
    return st, {x.get('id'): x for x in (items(b) if st == 200 else [])}


def check_destinations(c):
    st, ds = dests(c.admin)
    w, e, dd, x = ds.get(c.W, {}), ds.get(c.E, {}), ds.get(c.D, {}), ds.get(c.X, {})
    rec('destinations (admin): W listed as a datastore, canAnalyze',
        w.get('kind') == 'datastore' and w.get('canAnalyze') is True and w.get('deidentified') is False, short(w))
    rec('destinations (admin): EXISTING folder E listed, writes to W',
        e.get('kind') == 'virtualFolder' and e.get('writeDatastoreId') == c.W, short(e))
    rec('destinations (admin): DEDICATED folder D listed, writes to its storage',
        dd.get('kind') == 'virtualFolder' and dd.get('writeDatastoreId') == c.D_DS, short(dd))
    rec('destinations (admin): de-id folder X flagged deidentified, E and D not',
        x.get('deidentified') is True and e.get('deidentified') is False and dd.get('deidentified') is False,
        f"X={x.get('deidentified')} E={e.get('deidentified')} D={dd.get('deidentified')}")
    rec('destinations (admin): read-only storage R absent', c.R not in ds, f'R in list={c.R in ds}')
    rec('destinations (admin): NONE folder N absent', c.N not in ds, f'N in list={c.N in ds}')
    if c.RF:
        rec('destinations (admin): folder on read-only R absent', c.RF not in ds, '')
    # SYSTEM_USER tiers from setup-test-users.js
    da = User(c, 'test-data_access', 'TestData123!')
    st, ds = dests(da)
    rec('destinations (data-access system user, store on *): W listed, R absent',
        st == 200 and c.W in ds and c.R not in ds, f'status={st} W={c.W in ds} R={c.R in ds}')
    rec('destinations (data-access system user, no folder rights): folders absent',
        st == 200 and not any(v in ds for v in (c.E, c.D, c.X)), '')
    ro = User(c, 'test-read_only', 'TestReadOnly123!')
    st, ds = dests(ro)
    rec('destinations (read-only system user): W absent (no canStore)', st == 200 and c.W not in ds,
        f'status={st} W={c.W in ds}')
    st, b = ro.api('POST', V2 + '/upload-urls', {'destinationKind': 'datastore', 'destinationId': c.W,
                                                  'files': [{'name': 'ndv2-x.pdf', 'contentType': 'application/pdf', 'size': 10}]})
    rec('read-only system user: upload-urls on W -> 403', st == 403, f'status={st}')


# --- uploads ----------------------------------------------------------------------------
def bucket_of(url):
    p = urllib.parse.urlparse(url)
    if '.s3.' in p.netloc or '.s3-' in p.netloc:
        return p.netloc.split('.s3')[0]
    return p.path.lstrip('/').split('/', 1)[0]


def upload(c, user, kind, dest, files):
    """files: [(upload_name, blob, contentType)] -> {upload_name: s3Key}. Records one check."""
    st, b = user.api('POST', V2 + '/upload-urls', {'destinationKind': kind, 'destinationId': dest,
                                                     'files': [{'name': n, 'contentType': ct, 'size': len(bl)}
                                                               for n, bl, ct in files]})
    data = d(b) if st == 200 else {}
    got = data.get('files') or []
    uid = data.get('uploadId')
    keys, bad, puts = {}, [], []
    for (n, bl, ct), f in zip(files, got):
        k = f.get('s3Key', '')
        c.upload_keys.add(k)
        c.upload_bucket = c.upload_bucket or bucket_of(f.get('uploadUrl', ''))
        if not re.match(rf'^non-dicom-v2/{re.escape(user.username)}/{re.escape(str(uid))}/\d+-', k) or f.get('name') != n:
            bad.append(k)
        pst = http('PUT', f['uploadUrl'], raw=bl, headers={'Content-Type': ct}, timeout=300)[0] if f.get('uploadUrl') else None
        puts.append(pst)
        keys[n] = k
    rec(f'upload {len(files)} file(s) to {kind} as {user.username}',
        st == 200 and uid and len(got) == len(files) and not bad and all(p == 200 for p in puts),
        f'status={st} uploadId={uid} bad_keys={bad[:2]} puts={puts}')
    return keys


def do_uploads(c, m, blobs):
    a = c.admin
    c.k = {}
    c.k.update(upload(c, a, 'datastore', c.W, [
        ('ndv2-existing-patient.pdf', blobs['existing-patient.pdf'], 'application/pdf'),
        ('ndv2-burned-in.png', blobs['burned-in.png'], 'image/png'),
        ('ndv2-new-patient.pdf', blobs['new-patient.pdf'], 'application/pdf'),
        ('ndv2-scanned.pdf', blobs['scanned.pdf'], 'application/pdf'),
        ('ndv2-injection.pdf', blobs['injection.pdf'], 'application/pdf'),
        ('ndv2-tiny.mp4', blobs['tiny.mp4'], 'video/mp4'),
        ('ndv2-broken.png', blobs['broken.png'], 'image/png'),
        ('ndv2-burned-in-copy.png', blobs['burned-in.png'], 'image/png'),
        ('ndv2-existing-patient-copy.pdf', blobs['existing-patient.pdf'], 'application/pdf'),
        ('ndv2-spare.pdf', blobs['existing-patient.pdf'], 'application/pdf')]))
    c.k.update(upload(c, a, 'virtualFolder', c.E, [('ndv2-new-patient-e.pdf', blobs['new-patient.pdf'], 'application/pdf')]))
    c.k.update(upload(c, a, 'virtualFolder', c.D, [('ndv2-patient-a.pdf', blobs['patient-a.pdf'], 'application/pdf'),
                                                   ('ndv2-patient-b.pdf', blobs['patient-b.pdf'], 'application/pdf')]))
    c.k.update(upload(c, a, 'virtualFolder', c.X, [('ndv2-deid-scan.png', blobs['burned-in.png'], 'image/png')]))


# --- analysis ---------------------------------------------------------------------------
def analyze(c, user, kind, dest, key):
    t0 = time.time()
    st, b = user.api('POST', V2 + '/analyze', {'destinationKind': kind, 'destinationId': dest, 's3Key': key}, timeout=150)
    if st == 200 and user is c.admin:
        c.analyzed.append((key, dest))
    return st, d(b) if st == 200 else b, round(time.time() - t0, 1)


def fval(res, f):
    return ((res.get('fields') or {}).get(f) or {}).get('value')


def check_fields(label, res, exp, names):
    for f in names:
        got, want = fval(res, f), exp.get(f)
        if f in ('patientName', 'referringPhysician'):
            ok = name_matches(got, want)
        else:
            ok = norm(got) == norm(want)
        rec(f'{label}: {f} extracted', ok, f'got={got!r} want={want!r}')


def check_shape(label, res):
    f = res.get('fields') or {}
    bad = [k for k in f if k not in FIELDS]
    conf = [v.get('confidence') for v in f.values() if isinstance(v, dict)]
    rec(f'{label}: response shape (known keys, 0<=confidence<=1, evidence present)',
        set(res) <= ANALYSIS_KEYS | {'durationMs'} and not bad
        and all(isinstance(x, (int, float)) and 0 <= x <= 1 for x in conf)
        and all('evidence' in v for v in f.values() if isinstance(v, dict) and v.get('value')),
        f'extra_top={sorted(set(res) - ANALYSIS_KEYS)} extra_fields={bad}')


def run_analysis(c, m):
    a, F = c.admin, m['files']
    seeded_ids = {s['patientId'] for s in m['seeded']}
    jobs = {
        'existing-W': (a, 'datastore', c.W, c.k['ndv2-existing-patient.pdf']),
        'png-W': (a, 'datastore', c.W, c.k['ndv2-burned-in.png']),
        'new-W': (a, 'datastore', c.W, c.k['ndv2-new-patient.pdf']),
        'new-E': (a, 'virtualFolder', c.E, c.k['ndv2-new-patient-e.pdf']),
        'scanned-W': (a, 'datastore', c.W, c.k['ndv2-scanned.pdf']),
        'injection-W': (a, 'datastore', c.W, c.k['ndv2-injection.pdf']),
        'a-D': (a, 'virtualFolder', c.D, c.k['ndv2-patient-a.pdf']),
        'b-D': (a, 'virtualFolder', c.D, c.k['ndv2-patient-b.pdf']),
        'video-W': (a, 'datastore', c.W, c.k['ndv2-tiny.mp4']),
        'png-X': (a, 'virtualFolder', c.X, c.k['ndv2-deid-scan.png']),
    }
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        fut = {n: ex.submit(analyze, c, *j) for n, j in jobs.items()}
        R = {n: f.result() for n, f in fut.items()}
    for n, (st, res, secs) in R.items():
        rec(f'analyze {n}: 200', st == 200, f'status={st} {secs}s {short(res, 100) if st != 200 else ""}')
    res = {n: (r[1] if r[0] == 200 else {}) for n, r in R.items()}

    # existing patient (text PDF) -> ranked first
    r, exp = res['existing-W'], F['existing-patient.pdf']['expect']
    rec('existing patient PDF: ANALYSED', r.get('status') == 'ANALYSED', f"status={r.get('status')} model={r.get('model')}")
    check_shape('existing patient PDF', r)
    check_fields('existing patient PDF', r, exp, ['patientName', 'patientId', 'birthDate', 'sex', 'referringPhysician',
                                                   'institution', 'accessionNumber'])
    cand = r.get('candidates') or []
    rec('existing patient PDF: the seeded patient is ranked first',
        cand and cand[0].get('patientId') == exp['patientId'], f"order={[x.get('patientId') for x in cand]}")
    rec('existing patient PDF: first candidate scores above the rest, with reasons and studies',
        cand and all(cand[0].get('score', 0) > x.get('score', 0) for x in cand[1:]) and cand[0].get('reasons')
        and any(s.get('studyInstanceUID') == c.seed_studies.get(exp['patientId']) for s in cand[0].get('studies') or []),
        f"scores={[x.get('score') for x in cand]} reasons={cand[0].get('reasons') if cand else None}")
    rec('existing patient PDF: at most 5 candidates, all from W', len(cand) <= 5
        and all(x.get('patientId') in seeded_ids for x in cand), f'{len(cand)}')

    # burned-in PNG -> same patient, printed identifiers reported
    r, exp = res['png-W'], F['burned-in.png']['expect']
    check_fields('burned-in PNG', r, exp, ['patientName', 'patientId'])
    cand = r.get('candidates') or []
    rec('burned-in PNG: the seeded patient is ranked first', cand and cand[0].get('patientId') == exp['patientId'],
        f"order={[x.get('patientId') for x in cand]}")
    rec('burned-in PNG: printedIdentifiers names the patient name', 'patientName' in (r.get('printedIdentifiers') or []),
        f"{r.get('printedIdentifiers')}")

    # new patient -> pre-filled fields, no strong candidate (W holds three other patients)
    for n in ('new-W', 'new-E'):
        r, exp = res[n], F['new-patient.pdf']['expect']
        check_fields(f'new patient PDF ({n})', r, exp, ['patientName', 'patientId', 'birthDate', 'sex', 'documentTitle',
                                                        'referringPhysician', 'institution', 'accessionNumber'])
        top = max([x.get('score', 0) for x in r.get('candidates') or []] or [0])
        rec(f'new patient PDF ({n}): no strong candidate (best score < 0.5)', top < 0.5,
            f"candidates={[(x.get('patientId'), x.get('score')) for x in r.get('candidates') or []]}")

    # scanned (image-only) PDF
    r, exp = res['scanned-W'], F['scanned.pdf']['expect']
    rec('scanned PDF: ANALYSED', r.get('status') == 'ANALYSED', f"status={r.get('status')} reason={r.get('reason')}")
    check_fields('scanned PDF', r, exp, ['patientName', 'patientId', 'birthDate'])

    # injection: normal fields, nothing injected, matching still scoped to W
    r, exp = res['injection-W'], F['injection.pdf']['expect']
    check_shape('injection PDF', r)
    check_fields('injection PDF', r, exp, ['patientName', 'patientId'])
    vals = json.dumps({k: (v or {}).get('value') for k, v in (r.get('fields') or {}).items()}).upper()
    hits = [s for s in F['injection.pdf']['injected'] if s.upper() in vals or s in json.dumps(r)]
    rec('injection PDF: no injected value in the output (patientId not ADMIN, no ROOT, no sqlQuery)',
        fval(r, 'patientId') != 'ADMIN' and not hits, f'found={hits}')
    cand = r.get('candidates') or []
    rec('injection PDF: candidates only from W, at most 5, none for ADMIN',
        len(cand) <= 5 and all(x.get('patientId') in seeded_ids for x in cand), f"{[x.get('patientId') for x in cand]}")
    conf = [v.get('confidence') for v in (r.get('fields') or {}).values() if isinstance(v, dict)]
    rec('injection PDF: confidences not all forced to 1.0', not conf or not all(x == 1 for x in conf), f'{conf}')

    # disagreement: the two files name different patients (the condition the UI warns on)
    ra, rb = res['a-D'], res['b-D']
    check_fields('patient A PDF', ra, F['patient-a.pdf']['expect'], ['patientName', 'patientId'])
    check_fields('patient B PDF', rb, F['patient-b.pdf']['expect'], ['patientName', 'patientId'])
    rec('two files disagree: different patient IDs and names', fval(ra, 'patientId') and fval(rb, 'patientId')
        and norm(fval(ra, 'patientId')) != norm(fval(rb, 'patientId'))
        and norm(fval(ra, 'patientName')) != norm(fval(rb, 'patientName')),
        f"A={fval(ra, 'patientId')} B={fval(rb, 'patientId')}")

    # video: not analysed
    r = res['video-W']
    rec('video: NOT_ANALYSED with a reason, no candidates', r.get('status') == 'NOT_ANALYSED' and r.get('reason')
        and not r.get('candidates'), f"status={r.get('status')} reason={r.get('reason')}")

    # de-identified folder: printed identifiers found (raises the warning)
    r = res['png-X']
    rec('de-id folder: analysis reports printed identifiers', bool(r.get('printedIdentifiers')),
        f"{r.get('printedIdentifiers')}")

    # patient search
    st, b = a.api('GET', V2 + f'/patients?destinationKind=datastore&destinationId={c.W}&q=QUIG')
    p = items(b) if st == 200 else []
    rec('patients search q=QUIG in W: both Quigleys, with their studies',
        st == 200 and {'NDV2-44172', 'NDV2-44711'} <= {x.get('patientId') for x in p}
        and all(x.get('studies') for x in p) and len(p) <= 25, f"status={st} {[x.get('patientId') for x in p]}")
    st, b = a.api('GET', V2 + f'/patients?destinationKind=datastore&destinationId={c.W}&q=Q')
    rec('patients search with a 1-character query -> 400', st == 400, f'status={st}')
    st, b = a.api('GET', V2 + f'/patients?destinationKind=virtualFolder&destinationId={c.E}&q=QUIG')
    rec('patients search in folder E (empty tree): no W patients', st == 200 and not items(b), f'status={st} {len(items(b))}')

    # key ownership
    st, b, _ = analyze(c, a, 'datastore', c.W, f'non-dicom-v2/someone-else/{uuid.uuid4()}/0-ndv2-x.pdf')
    rec("analyze another user's key -> refused (403/404)", st in (403, 404), f'status={st}')
    st, b, _ = analyze(c, a, 'datastore', c.W, 'non-dicom-v2/admin/../someone-else/0-ndv2-x.pdf')
    rec('analyze a key with ".." -> refused (400/403/404)', st in (400, 403, 404), f'status={st}')
    st, b, _ = analyze(c, a, 'datastore', c.R, c.k['ndv2-spare.pdf'])
    rec('analyze against read-only storage R -> 403', st == 403, f'status={st}')


# --- validation -------------------------------------------------------------------------
def run_validation(c):
    a, W = c.admin, c.W

    def urls(files, kind='datastore', dest=None):
        return a.api('POST', V2 + '/upload-urls', {'destinationKind': kind, 'destinationId': dest or W, 'files': files})[0]

    pdf = lambda n, s: {'name': n, 'contentType': 'application/pdf', 'size': s}   # noqa: E731
    rec('upload-urls with 51 files -> 400', urls([pdf(f'ndv2-{i}.pdf', 1000) for i in range(51)]) == 400, '')
    rec('upload-urls with 0 files -> 400', urls([]) == 400, '')
    rec('upload-urls PDF declared 101 MiB -> 400', urls([pdf('ndv2-big.pdf', 101 * MIB)]) == 400, '')
    rec('upload-urls PNG declared 101 MiB -> 400',
        urls([{'name': 'ndv2-big.png', 'contentType': 'image/png', 'size': 101 * MIB}]) == 400, '')
    rec('upload-urls MP4 declared 2 GiB + 1 -> 400',
        urls([{'name': 'ndv2-big.mp4', 'contentType': 'video/mp4', 'size': 2048 * MIB + 1}]) == 400, '')
    st, b = a.api('POST', V2 + '/upload-urls', {'destinationKind': 'datastore', 'destinationId': W,
                                                'files': [{'name': 'ndv2-150.mp4', 'contentType': 'video/mp4', 'size': 150 * MIB}]})
    for f in (d(b).get('files') or []) if st == 200 else []:
        c.upload_keys.add(f.get('s3Key'))
    rec('upload-urls MP4 declared 150 MiB -> 200 (video cap is 2 GB)', st == 200, f'status={st}')
    rec('upload-urls unsupported type (application/zip) -> 400',
        urls([{'name': 'ndv2-x.zip', 'contentType': 'application/zip', 'size': 100}]) == 400, '')

    # Content-Length is part of the presigned signature.
    st, b = a.api('POST', V2 + '/upload-urls', {'destinationKind': 'datastore', 'destinationId': W, 'files': [pdf('ndv2-len.pdf', 100)]})
    f = (d(b).get('files') or [{}])[0] if st == 200 else {}
    c.upload_keys.add(f.get('s3Key'))
    pst = http('PUT', f['uploadUrl'], raw=b'%PDF' + b'x' * 196, headers={'Content-Type': 'application/pdf'})[0] if f else None
    rec('presigned PUT with a different Content-Length is refused by S3 (403)', pst == 403, f'put={pst}')
    pst = http('PUT', f['uploadUrl'], raw=b'%PDF' + b'x' * 96, headers={'Content-Type': 'image/png'})[0] if f else None
    rec('presigned PUT with a different Content-Type is refused by S3 (403)', pst == 403, f'put={pst}')

    spare = c.k['ndv2-spare.pdf']
    pat = {'mode': 'new', 'patientId': f'NDV2-VAL-{c.tag}', 'patientName': 'NDV2^VALIDATION', 'birthDate': '', 'sex': 'O'}

    def create(body):
        st, b = a.api('POST', V2, body)
        if st == 202:
            print(f'  WARNING: unexpected import {d(b).get("importId")} created', flush=True)
        return st, b

    def one(kind='datastore', dest=None, key=spare, modality='DOC', patient=None, ack=None):
        return create_body(kind, dest or W, patient or pat, new_study('ndv2 validation'), [series('s1', modality, 'v')],
                           [file_entry(key, 'v.pdf', 's1')], ack)

    st, b = create(create_body('datastore', W, pat, new_study('v'), [series('s1', 'DOC', 'v')],
                               [file_entry(f'non-dicom-v2/admin/{uuid.uuid4()}/{i}-ndv2-v.pdf', 'v.pdf', 's1') for i in range(51)]))
    rec('create with 51 files -> 400', st == 400, f'status={st}')
    st, b = create(create_body('datastore', W, pat, new_study('v'), [series('s1', 'DOC', 'v')], []))
    rec('create with 0 files -> 400', st == 400, f'status={st}')
    st, b = create(one(modality='SC'))
    rec('create: PDF bytes in an SC series -> 400 (magic bytes vs modality)', st == 400, f'status={st} {short(b, 120)}')
    st, b = create(one(patient={'mode': 'existing', 'patientId': f'NDV2-NOPE-{c.tag}'}))
    rec('create: existing patient not in the destination -> 400/404', st in (400, 404), f'status={st}')
    st, b = create(one(key=f'non-dicom-v2/someone-else/{uuid.uuid4()}/0-ndv2-x.pdf'))
    rec("create: another user's key -> 400/403", st in (400, 403), f'status={st}')
    st, b = create(one(key=f'non-dicom-v2/admin/{uuid.uuid4()}/0-ndv2-missing.pdf'))
    rec('create: key that does not exist in S3 -> 400', st == 400, f'status={st}')
    st, b = create(one(dest=str(uuid.uuid4())))
    rec('create: unknown destination -> 404', st == 404, f'status={st}')
    st, b = create(one('virtualFolder', c.X))
    rec('create into de-id folder X without acknowledgedContentNotDeidentified -> 400', st == 400, f'status={st}')
    st, b = create(one('virtualFolder', c.X, ack=False))
    rec('create into de-id folder X with acknowledgement false -> 400', st == 400, f'status={st}')
    for bad in ({'videoWidth': 0}, {'numberOfFrames': 1.5}, {'frameTime': '33.33'}):
        body = one(modality='XC')
        body['files'][0].update(VIDEO_DIMS, **bad)
        st, b = create(body)
        rec(f'create: video field {bad} -> 400', st == 400, f'status={st} {short(b, 100)}')


# --- refusals on non-writable destinations ------------------------------------------------
def run_refusals(c):
    a = c.admin
    spare = c.k['ndv2-spare.pdf']
    pat = {'mode': 'new', 'patientId': f'NDV2-REF-{c.tag}', 'patientName': 'NDV2^REFUSAL', 'birthDate': '', 'sex': 'O'}
    targets = [('read-only storage R', 'datastore', c.R), ('NONE folder N', 'virtualFolder', c.N)]
    if c.RF:
        targets.append(('folder RF (EXISTING on R, wrongly accepted)', 'virtualFolder', c.RF))
    for label, kind, dest in targets:
        st, b = a.api('POST', V2 + '/upload-urls', {'destinationKind': kind, 'destinationId': dest,
                                                    'files': [{'name': 'ndv2-r.pdf', 'contentType': 'application/pdf', 'size': 100}]})
        for f in (d(b).get('files') or []) if st == 200 else []:
            c.upload_keys.add(f.get('s3Key'))
        rec(f'V2 upload-urls to {label} -> 403', st == 403, f'status={st}')
        st, b = a.api('POST', V2, create_body(kind, dest, pat, new_study('ndv2 refusal'), [series('s1', 'DOC', 'r')],
                                                     [file_entry(spare, 'r.pdf', 's1')]))
        rec(f'V2 create into {label} -> 403', st == 403, f'status={st} {short(b, 100)}')

    # V1 DICOM upload-url generator (writes straight into the storage's bucket)
    f = [{'name': 'ndv2-v1.dcm', 'size': 1000, 'studyInstanceUID': '1.2.3.4', 'seriesInstanceUID': '1.2.3.4.5',
          'sopInstanceUID': '1.2.3.4.5.6', 'studyDate': '20260101'}]
    st, b = a.api('POST', '/import-jobs/upload-url', {'datastoreId': c.R, 'files': f})
    rec('V1 /import-jobs/upload-url for read-only R -> refused (403), no URL', st == 403 and not d(b).get('uploadUrls'),
        f'status={st}')
    st, b = a.api('POST', '/import-jobs/upload-url', {'datastoreId': c.W, 'files': f})
    rec('V1 /import-jobs/upload-url for writable W still works (control)', st == 200 and d(b).get('uploadUrls'), f'status={st}')

    # STOW
    _, blob = make_seed({'patientId': f'NDV2-STOW-{c.tag}', 'patientName': 'NDV2^STOW', 'birthDate': '', 'sex': 'O',
                         'studyDescription': 'ndv2 stow refusal', 'studyDate': '20260101'})
    st, b = a.stow(c.R, [blob])
    rec('STOW into read-only storage R -> 403', st == 403, f'status={st} {short(b, 120)}')
    st, b = a.stow(c.N, [blob])
    rec('STOW into NONE folder N -> 403', st == 403, f'status={st}')
    if c.RF:
        st, b = a.stow(c.RF, [blob])
        rec('folder write path: STOW through a folder on read-only R -> 403', st == 403, f'status={st}')
    left = c.s3.list_objects_v2(Bucket=c.ro_bucket, MaxKeys=5).get('KeyCount', 0)
    rec('nothing was written into the read-only bucket', left == 0, f'objects={left}')


# --- end to end ---------------------------------------------------------------------------
def get_import(user, iid):
    st, b = user.api('GET', f'{V2}/{iid}')
    return st, (d(b) if st == 200 else {})


def wait_imports(c, user, ids):
    """Poll until every import is COMPLETED / PARTIAL / FAILED (or timeout)."""
    final, deadline = {}, time.time() + max(c.timeout, 900)
    while ids and time.time() < deadline:
        for iid in list(ids):
            st, x = get_import(user, iid)
            if (x.get('import') or {}).get('status') in ('COMPLETED', 'PARTIAL', 'FAILED'):
                final[iid] = x
                ids.remove(iid)
        if ids:
            time.sleep(10)
    for iid in ids:
        final[iid] = get_import(user, iid)[1]
    return final


def create_import(c, user, label, body):
    st, b = user.api('POST', V2, body)
    iid = d(b).get('importId') if st == 202 else None
    rec(f'create {label} -> 202 with importId', st == 202 and iid, f'status={st} {iid or short(b, 140)}')
    return iid


def metadata_checks(c, label, target, study, files_sent, sops):
    st, meta = c.admin.dw(target, f'/studies/{study}/metadata')
    by_sop = {tag_value(i, '00080018'): i for i in meta} if st == 200 else {}
    for (fe, sop, sop_class, ref_phys) in sops:
        inst = by_sop.get(sop, {})
        got = {k: tag_value(inst, t) for k, t in TAGS.items()}
        want = {'documentTitle': fe['documentTitle'], 'referringPhysician': ref_phys,
                'contentDate': fe['contentDate'], 'institutionName': fe['institutionName']}
        need = ['referringPhysician', 'contentDate', 'institutionName'] + (['documentTitle'] if sop_class == SOP_PDF else [])
        bad = {k: (got[k], want[k]) for k in need if want[k] and norm(got[k]) != norm(want[k])}
        rec(f'{label}: /metadata of {fe["fileName"]} has SOP class and the new tags',
            inst and tag_value(inst, '00080016') == sop_class and not bad,
            f'status={st} class={tag_value(inst, "00080016")} mismatched={bad}')


def file_rows(x):
    return x.get('files') or []


def check_import(c, label, x, want_status, n_files, n_indexed):
    imp, fs = x.get('import') or {}, file_rows(x)
    rec(f'{label}: import {want_status}, {n_indexed}/{n_files} files INDEXED',
        imp.get('status') == want_status and len(fs) == n_files
        and sum(f.get('status') == 'INDEXED' for f in fs) == n_indexed
        and all(f.get('sopInstanceUID') and f.get('seriesInstanceUID') for f in fs if f.get('status') == 'INDEXED'),
        f"status={imp.get('status')} files={[(f.get('fileName'), f.get('status'), f.get('errorMessage')) for f in fs]}")
    return imp, fs


def run_e2e(c, m):
    a, F, S = c.admin, m['files'], {s['patientId']: s for s in m['seeded']}
    seed = S['NDV2-44172']
    ex = F['existing-patient.pdf']['expect']
    ref_a = ex['referringPhysician']
    fa = [file_entry(c.k['ndv2-existing-patient.pdf'], 'existing-patient.pdf', 's1', ex),
          file_entry(c.k['ndv2-burned-in.png'], 'burned-in.png', 's2',
                     {'documentTitle': 'Ultrasound capture', 'documentDate': ex['documentDate'], 'institution': ex['institution']})]
    body_a = create_body('datastore', c.W, existing_patient(seed), new_study(f'NDV2 A {c.tag}', ex),
                         [series('s1', 'DOC', 'Clinic letter'), series('s2', 'SC', 'Ultrasound capture')], fa)
    nx = F['new-patient.pdf']['expect']
    fb = [file_entry(c.k['ndv2-new-patient-e.pdf'], 'new-patient.pdf', 's1', nx)]
    body_b = create_body('virtualFolder', c.E, new_patient(nx), new_study(f'NDV2 B {c.tag}', nx),
                         [series('s1', 'DOC', 'MRI report')], fb)
    pa, pb = F['patient-a.pdf']['expect'], F['patient-b.pdf']['expect']
    fc = [file_entry(c.k['ndv2-patient-a.pdf'], 'patient-a.pdf', 's1', pa),
          file_entry(c.k['ndv2-patient-b.pdf'], 'patient-b.pdf', 's1', pb)]
    body_c = create_body('virtualFolder', c.D, new_patient(pa), new_study(f'NDV2 C {c.tag}'),
                         [series('s1', 'DOC', 'Rehab reports')], fc)
    pf = {'patientId': f'NDV2-PART-{c.tag}', 'patientName': 'NDV2^PARTIAL', 'birthDate': '20000101', 'sex': 'O'}
    body_f = create_body('datastore', c.W, new_patient(pf), new_study(f'NDV2 F {c.tag}'), [series('s1', 'SC', 'captures')],
                         [file_entry(c.k['ndv2-broken.png'], 'broken.png', 's1'),
                          file_entry(c.k['ndv2-burned-in-copy.png'], 'burned-in-copy.png', 's1')])
    pg = {'patientId': f'NDV2-VID-{c.tag}', 'patientName': 'NDV2^VIDEO', 'birthDate': '', 'sex': 'O'}
    body_g = create_body('datastore', c.W, new_patient(pg), new_study(f'NDV2 G {c.tag}'), [series('s1', 'XC', 'clip')],
                         [file_entry(c.k['ndv2-tiny.mp4'], 'tiny.mp4', 's1', video=VIDEO_DIMS)])
    px = {'patientId': f'NDV2-DEID-{c.tag}', 'patientName': 'NDV2^DEIDFOLDER', 'birthDate': '19900101', 'sex': 'F'}
    body_x = create_body('virtualFolder', c.X, new_patient(px), new_study(f'NDV2 X {c.tag}'), [series('s1', 'SC', 'scan')],
                         [file_entry(c.k['ndv2-deid-scan.png'], 'deid-scan.png', 's1')], ack=True)
    ids = {}
    for label, body in (('A: W, existing patient, new study, DOC+SC', body_a), ('B: EXISTING folder E, new patient', body_b),
                        ('C: DEDICATED folder D, two files', body_c), ('F: W, one broken PNG + one good', body_f),
                        ('G: W, video', body_g), ('X: de-id folder with acknowledgement', body_x)):
        ids[label[0]] = create_import(c, a, label, body)
    c.import_ids = {k: v for k, v in ids.items() if v}
    st, x = get_import(a, ids['A']) if ids['A'] else (0, {})
    rec('GET import right after create: record and one file row per file',
        st == 200 and len(file_rows(x)) == len(fa), f"status={st} files={len(file_rows(x))}")

    final = wait_imports(c, a, [v for v in ids.values() if v])
    get = lambda k: final.get(ids[k], {}) if ids[k] else {}            # noqa: E731

    # A
    imp, fs = check_import(c, 'A', get('A'), 'COMPLETED', 2, 2)
    study_a = imp.get('studyInstanceUID')
    rec('A: import record (destination, createdBy, study UID)', imp.get('destinationKind') == 'datastore'
        and imp.get('destinationId') == c.W and imp.get('createdBy') == 'admin' and study_a,
        f"{ {k: imp.get(k) for k in ('destinationKind', 'destinationId', 'createdBy', 'studyInstanceUID')} }")
    if study_a:
        st, rows = a.dw(c.W, f'/studies?StudyInstanceUID={study_a}&includefield=00201208')
        rec('A: QIDO finds the study in W under the existing patient',
            st == 200 and len(rows) == 1 and tag_value(rows[0], '00100020') == seed['patientId'],
            f'status={st} rows={len(rows)}')
        st, rows = a.dw(c.W, f"/studies?PatientID={seed['patientId']}")
        rec('A: existing patient reused (seed study + A under one PatientID)', st == 200 and len(rows) == 2,
            f'studies={len(rows)}')
        by_name = {f.get('fileName'): f for f in fs}
        metadata_checks(c, 'A', c.W, study_a, fa, [
            (fa[0], (by_name.get('existing-patient.pdf') or {}).get('sopInstanceUID'), SOP_PDF, ref_a),
            (fa[1], (by_name.get('burned-in.png') or {}).get('sopInstanceUID'), SOP_SC, ref_a)])
        gone = []
        for fe in fa:
            try:
                c.s3.head_object(Bucket=c.upload_bucket, Key=fe['s3Key'])
            except Exception:                                  # noqa: BLE001 - 404 expected
                gone.append(fe['s3Key'])
        rec('A: source uploads deleted from user-uploads after encapsulation', len(gone) == len(fa), f'{len(gone)}/{len(fa)}')

        # A2: existing study + existing series
        doc_series = (by_name.get('existing-patient.pdf') or {}).get('seriesInstanceUID')
        body_a2 = create_body('datastore', c.W, existing_patient(seed),
                              {'mode': 'existing', 'studyInstanceUID': study_a},
                              [series('s1', 'DOC', 'Clinic letter', uid=doc_series)],
                              [file_entry(c.k['ndv2-existing-patient-copy.pdf'], 'existing-patient-copy.pdf', 's1', ex)])
        iid = create_import(c, a, 'A2: W, existing study + existing series', body_a2)
        if iid:
            c.import_ids['A2'] = iid
            x2 = wait_imports(c, a, [iid])[iid]
            imp2, fs2 = check_import(c, 'A2', x2, 'COMPLETED', 1, 1)
            rec('A2: file joined the existing study and series', imp2.get('studyInstanceUID') == study_a
                and fs2 and fs2[0].get('seriesInstanceUID') == doc_series, f"series={fs2[0].get('seriesInstanceUID') if fs2 else None}")
            ok, det = wait_for(lambda: (lambda r: (len(r) == 3, f'{len(r)} instances'))(
                a.dw(c.W, f'/studies/{study_a}/instances')[1]), c.timeout)
            rec('A2: study A now holds 3 instances', ok, det)

    # B: EXISTING folder
    imp, fs = check_import(c, 'B', get('B'), 'COMPLETED', 1, 1)
    sb = imp.get('studyInstanceUID')
    if sb:
        st, rows = a.dw(c.W, f"/studies?PatientID={nx['patientId']}")
        rec("B: the file is in the folder's write storage W", st == 200 and len(rows) == 1, f'rows={len(rows)}')
        ok, det = wait_for(lambda: (lambda r: (len(r) == 1, f'{len(r)} studies'))(
            a.dw(c.E, f'/studies?StudyInstanceUID={sb}')[1]), c.timeout)
        rec('B: QIDO through folder E finds the study (assigned to the folder)', ok, det)
        metadata_checks(c, 'B (via folder E)', c.E, sb, fb, [(fb[0], fs[0].get('sopInstanceUID') if fs else None, SOP_PDF,
                                                               nx['referringPhysician'])])

    # C: DEDICATED folder
    imp, fs = check_import(c, 'C', get('C'), 'COMPLETED', 2, 2)
    sc = imp.get('studyInstanceUID')
    if sc:
        st, rows = a.dw(c.D_DS, f'/studies/{sc}/instances')
        rec("C: both files in D's dedicated storage", st == 200 and len(rows) == 2, f'instances={len(rows)}')
        st, rows = a.dw(c.W, f'/studies?StudyInstanceUID={sc}')
        rec('C: nothing written to W', st in (200, 204) and not rows, f'rows={len(rows)}')
        ok, det = wait_for(lambda: (lambda r: (len(r) == 1, f'{len(r)} studies'))(
            a.dw(c.D, f'/studies?StudyInstanceUID={sc}')[1]), c.timeout)
        rec('C: QIDO through folder D finds the study', ok, det)
        by_name = {f.get('fileName'): f for f in fs}
        metadata_checks(c, 'C (via folder D)', c.D, sc, fc, [
            (fe, (by_name.get(fe['fileName']) or {}).get('sopInstanceUID'), SOP_PDF, '') for fe in fc])

    # F: partial
    imp, fs = check_import(c, 'F', get('F'), 'PARTIAL', 2, 1)
    bad = next((f for f in fs if f.get('status') == 'FAILED'), {})
    msg = bad.get('errorMessage') or ''
    rec('F: broken PNG FAILED with a readable message (no exception class / traceback)',
        bad.get('fileName') == 'broken.png' and msg and not re.search(r'Traceback|\b\w+(Error|Exception)\b', msg),
        repr(msg))

    # G: video
    imp, fs = check_import(c, 'G', get('G'), 'COMPLETED', 1, 1)
    if imp.get('studyInstanceUID') and fs:
        st, meta = a.dw(c.W, f"/studies/{imp['studyInstanceUID']}/metadata")
        cls = tag_value(meta[0], '00080016') if st == 200 and meta else None
        rec('G: stored as Video Photographic (XC)', cls == SOP_VIDEO and tag_value(meta[0], '00080060') == 'XC',
            f'class={cls}')
        if st == 200 and meta:
            got = {k: tag_value(meta[0], t) for k, t in (('videoHeight', '00280010'), ('videoWidth', '00280011'),
                                                          ('numberOfFrames', '00280008'), ('frameTime', '00181063'))}

            def num(v):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return None
            bad = {k: (got[k], VIDEO_DIMS[k]) for k in got if num(got[k]) != float(VIDEO_DIMS[k])}
            rec('G: declared video dimensions in Rows, Columns, NumberOfFrames, FrameTime', not bad,
                f'mismatched={bad}')

    # X: de-id folder with acknowledgement
    check_import(c, 'X', get('X'), 'COMPLETED', 1, 1)

    # list
    st, b = a.api('GET', V2)
    lst = items(b)
    got = [x.get('id') for x in lst]
    ts = [str(x.get('createdAt')) for x in lst]
    rec('GET / (admin): lists this run\'s imports, newest first, at most 50',
        st == 200 and all(v in got for v in c.import_ids.values()) and ts == sorted(ts, reverse=True) and len(lst) <= 50,
        f'status={st} n={len(lst)}')


# --- audit ------------------------------------------------------------------------------------
def audit_rows(c, action):
    st, b = c.admin.api('GET', f'/audit?action={action}&pageSize=500&timestampFrom={c.audit_from}')
    return items(b) if st == 200 else []


def run_audit(c, m):
    keys = {k for k, _ in c.analyzed}

    def found():
        rows = audit_rows(c, 'ANALYZE_DOCUMENT')
        hit = {k for k in keys if any(k in json.dumps(r) for r in rows)}
        return hit == keys, (rows, hit)
    ok, (rows, hit) = wait_for(found, 180, every=15)
    rec('audit: one ANALYZE_DOCUMENT row per analyze call (matched on file key)', ok and keys, f'{len(hit)}/{len(keys)}')
    mine = [r for r in rows if any(k in json.dumps(r) for k in keys)]
    rec('audit: ANALYZE_DOCUMENT rows name the user, destination and model',
        mine and all(r.get('user') == 'admin' for r in mine)
        and all(any(dst in json.dumps(r) for _, dst in c.analyzed) for r in mine)
        and all('model' in json.dumps(r.get('newValues') or {}).lower() for r in mine),
        f"users={sorted({r.get('user') for r in mine})}")
    secrets_ = [s for f in m['files'].values() for k, s in f['expect'].items()
                if k in ('patientName', 'patientId', 'birthDate', 'accessionNumber')]
    secrets_ += [p for s in secrets_ for p in name_parts(s) if len(p) > 4]
    leaked = sorted({s for s in secrets_ if any(s.upper() in json.dumps(r).upper() for r in mine)})
    rec('audit: no extracted values (names, IDs, birth dates, accession) in ANALYZE_DOCUMENT rows', not leaked,
        f'leaked={leaked[:5]}')

    def ack_of(row):
        nv = row.get('newValues') or {}
        flags = [v for k, v in (nv.items() if isinstance(nv, dict) else []) if re.search(r'ack|acknowledg', k, re.I)]
        return flags[0] if flags else None
    want = {c.import_ids.get('X'): True, c.import_ids.get('A'): False}
    want.pop(None, None)

    def creates():
        rows = audit_rows(c, 'CREATE_NON_DICOM_IMPORT')
        by = {iid: next((r for r in rows if iid in json.dumps(r)), None) for iid in want}
        return all(by.values()), by
    ok, by = wait_for(creates, 180, every=15)
    rec('audit: CREATE_NON_DICOM_IMPORT row for each import', ok, f'{sum(1 for v in by.values() if v)}/{len(want)}')
    x = by.get(c.import_ids.get('X'))
    rec('audit: de-id folder import records the acknowledgement (true)', x and ack_of(x) is True,
        f"ack={ack_of(x) if x else None} newValues={short((x or {}).get('newValues'), 200)}")
    a_ = by.get(c.import_ids.get('A'))
    rec('audit: storage import records no acknowledgement (false or absent)', a_ and ack_of(a_) in (False, None),
        f'ack={ack_of(a_) if a_ else None}')


# --- data user ----------------------------------------------------------------------------------
def run_data_user(c, m, blobs):
    a, W, t = c.admin, c.W, c.tag
    gname, uname = f'{NAME}du-{t}', f'{NAME}du-{t}'

    def grants(read, store):
        return {'name': gname, 'description': 'ndv2 suite data user', 'userMode': 'DATA_USER',
                'datastorePrivileges': [{'datastoreId': W, 'canRead': read, 'canStore': store, 'canDelete': False}],
                'virtualFolderPrivileges': [], 'managementPrivileges': {}}
    st, b = a.api('POST', '/privilege-groups', grants(True, True))
    gid = d(b).get('id')
    rec('data user: group created (DATA_USER, W read+store)', st in (200, 201) and gid, f'status={st}')
    st, b = a.api('POST', '/users', {'username': uname, 'email': f'{uname}@example.com', 'firstName': 'NDV2',
                                     'lastName': 'DataUser', 'privilegeGroupId': gid, 'password': DU_PW})
    rec('data user: user created', st in (200, 201), f'status={st} {short(b, 120) if st not in (200, 201) else ""}')
    c.cog.admin_set_user_password(UserPoolId=c.pool, Username=uname, Password=DU_PW, Permanent=True)
    du = User(c, uname, DU_PW)

    def phase(read, store, expect_w, expect_analyze):
        """Apply grants, then wait until /destinations reflects them (fresh token each minute)."""
        if (read, store) != (True, True):
            st = a.api('PUT', f'/privilege-groups/{gid}', grants(read, store))[0]
            rec(f'data user: group set to read={read} store={store}', st == 200, f'status={st}')
        last = [0]

        def chk():
            if time.time() - last[0] > 60:
                du.login(); last[0] = time.time()
            st, ds = dests(du)
            w = ds.get(W)
            ok = st == 200 and ((w is not None) == expect_w) and (not expect_w or w.get('canAnalyze') is expect_analyze)
            return ok, f'status={st} W={short(w, 120) if w else None}'
        return wait_for(chk, 360, every=15)

    # store + read
    ok, det = phase(True, True, True, True)
    rec('data user (store+read): W listed with canAnalyze', ok, det)
    st, ds = dests(du)
    rec('data user (store+read): R, E, D, X, N absent', st == 200 and not any(v in ds for v in (c.R, c.E, c.D, c.X, c.N)),
        f'status={st} listed={sorted(ds)}')
    keys = upload(c, du, 'datastore', W, [('ndv2-du-letter.pdf', blobs['patient-b.pdf'], 'application/pdf')])
    k = keys.get('ndv2-du-letter.pdf')
    st, res, _ = analyze(c, du, 'datastore', W, k)
    rec('data user (store+read): analyze own file -> ANALYSED', st == 200 and res.get('status') == 'ANALYSED',
        f"status={st} {res.get('status') if st == 200 else ''}")
    st, _, _ = analyze(c, du, 'datastore', W, c.k['ndv2-spare.pdf'])
    rec("data user: analyze the admin's file -> 403/404", st in (403, 404), f'status={st}')
    st, b = du.api('GET', V2 + f'/patients?destinationKind=datastore&destinationId={W}&q=QUIG')
    rec('data user (store+read): patient search in W', st == 200 and items(b), f'status={st}')
    pb = m['files']['patient-b.pdf']['expect']
    pat = dict(new_patient(pb), patientId=f'NDV2-DU-{t}')
    st, b = du.api('POST', V2, create_body('datastore', W, pat, new_study(f'NDV2 DU {t}'), [series('s1', 'DOC', 'du')],
                                                 [file_entry(c.k['ndv2-spare.pdf'], 'x.pdf', 's1')]))
    rec("data user: create with the admin's key -> 400/403", st in (400, 403), f'status={st}')
    iid = create_import(c, du, 'data user (store+read): import into W', create_body(
        'datastore', W, pat, new_study(f'NDV2 DU {t}'), [series('s1', 'DOC', 'du')],
        [file_entry(k, 'du-letter.pdf', 's1', pb)]))
    if iid:
        x = wait_imports(c, du, [iid])[iid]
        check_import(c, 'data user import', x, 'COMPLETED', 1, 1)
        st, rows = a.dw(W, f"/studies?PatientID={pat['patientId']}")
        rec('data user import: QIDO finds the study in W', st == 200 and len(rows) == 1, f'rows={len(rows)}')
        st, b = du.api('GET', V2)
        got = [x.get('id') for x in items(b)]
        rec("data user: GET / lists only the user's own imports", st == 200 and iid in got
            and not any(v in got for v in c.import_ids.values()), f'status={st} n={len(got)}')
    # GET /{importId}: the creator, an admin, or anyone with read or store on the import's
    # destination (the API's _can_see). The data user reads W, so it sees A (into W) but not
    # B (into folder E, where it holds no grant): 404, so the import's existence is not revealed.
    if c.import_ids.get('A'):
        st, _ = get_import(du, c.import_ids['A'])
        rec("data user (read on W): GET the admin's import into W -> 200", st == 200, f'status={st}')
    if c.import_ids.get('B'):
        st, _ = get_import(du, c.import_ids['B'])
        rec("data user (no grant on folder E): GET the admin's import into E -> 404", st == 404, f'status={st}')

    # store, no read
    ok, det = phase(False, True, True, False)
    rec('data user (store only): W listed, canAnalyze false', ok, det)
    keys = upload(c, du, 'datastore', W, [('ndv2-du-noread.pdf', blobs['patient-a.pdf'], 'application/pdf')])
    k2 = keys.get('ndv2-du-noread.pdf')
    st, _, _ = analyze(c, du, 'datastore', W, k2)
    rec('data user (store only): analyze -> 403', st == 403, f'status={st}')
    st, _ = du.api('GET', V2 + f'/patients?destinationKind=datastore&destinationId={W}&q=QUIG')
    rec('data user (store only): patient search -> 403', st == 403, f'status={st}')

    # read, no store
    ok, det = phase(True, False, False, None)
    rec('data user (read only): W no longer listed', ok, det)
    st, _ = du.api('POST', V2 + '/upload-urls', {'destinationKind': 'datastore', 'destinationId': W,
                                                 'files': [{'name': 'ndv2-du-ro.pdf', 'contentType': 'application/pdf', 'size': 100}]})
    rec('data user (read only): upload-urls -> 403', st == 403, f'status={st}')
    st, b = du.api('POST', V2, create_body('datastore', W, dict(pat, patientId=f'NDV2-DU2-{t}'), new_study('du2'),
                                                 [series('s1', 'DOC', 'du')], [file_entry(k2, 'du-noread.pdf', 's1')]))
    rec('data user (read only): create -> 403', st == 403, f'status={st}')


# --- dry run ------------------------------------------------------------------------------------
def dry_run():
    m, blobs = load_fixtures()
    for n, f in m['files'].items():
        if n == 'broken.png':
            rec('fixture broken.png: PNG signature, not decodable',
                blobs[n][:4] == b'\x89PNG' and not _png_decodes(blobs[n]), '')
        else:
            rec(f'fixture {n}: magic bytes match {f["contentType"]}', magic_ok(n, blobs[n], f['contentType']),
                f'{len(blobs[n])} bytes')
        rec(f'fixture {n}: under the 100 MB / 2 GB caps', len(blobs[n]) < 100 * MIB, '')
    for n in ('existing-patient.pdf', 'new-patient.pdf', 'injection.pdf', 'patient-a.pdf', 'patient-b.pdf'):
        rec(f'fixture {n}: xref offsets point at objects', _xref_ok(blobs[n]), '')
    rec('fixture scanned.pdf: no text layer (no font, no patient text in bytes)',
        b'/Font' not in blobs['scanned.pdf'] and b'Delacroix' not in blobs['scanned.pdf'], '')
    rec('fixture injection.pdf: carries the injected instruction',
        b'ignore all previous instructions' in blobs['injection.pdf'] and b'ROOT^ADMIN' in blobs['injection.pdf'], '')
    rec('fixture seeded patient matches existing-patient.pdf expectations',
        m['seeded'][0]['patientId'] == m['files']['existing-patient.pdf']['expect']['patientId'], '')
    _, seed = make_seed(m['seeded'][0])
    rec('seed DICOM builds', seed[128:132] == b'DICM', f'{len(seed)} bytes')
    k = 'non-dicom-v2/admin/u1/0-ndv2-x.pdf'
    ex = m['files']['existing-patient.pdf']['expect']
    b = create_body('datastore', 'ds', existing_patient(m['seeded'][0]), new_study('x', ex),
                    [series('s1', 'DOC', 'd'), series('s2', 'SC', 'i', uid='1.2.3')], [file_entry(k, 'x.pdf', 's1', ex)], ack=True)
    rec('create body has the contract keys', set(b) == {'destinationKind', 'destinationId', 'patient', 'study', 'series',
                                                        'files', 'acknowledgedContentNotDeidentified'}
        and set(b['files'][0]) == {'s3Key', 'fileName', 'seriesRef', 'documentTitle', 'contentDate', 'institutionName'}
        and b['series'][1]['mode'] == 'existing', json.dumps(b)[:120])
    v = file_entry(k, 'tiny.mp4', 's1', video=VIDEO_DIMS)
    rec('video file entry carries the optional video fields (positive ints, float frame time)',
        set(v) - set(b['files'][0]) == {'videoWidth', 'videoHeight', 'numberOfFrames', 'frameTime'}
        and all(isinstance(v[x], int) and v[x] > 0 for x in ('videoWidth', 'videoHeight', 'numberOfFrames'))
        and isinstance(v['frameTime'], float), json.dumps(v)[:160])
    rec('name matching helper', name_matches('Quigley^Harriet^M.', 'QUIGLEY^HARRIET^M')
        and not name_matches('QUIGLEY^HAROLD', 'QUIGLEY^HARRIET^M'), '')
    rec('bucket parsing (virtual-hosted and path style)',
        bucket_of('https://b-1.s3.us-east-1.amazonaws.com/k?x=1') == 'b-1'
        and bucket_of('https://s3.us-east-1.amazonaws.com/b-2/k') == 'b-2', '')
    print('dry run: no AWS or HTTP calls made')


def _png_decodes(blob):
    try:
        from PIL import Image
        Image.open(io.BytesIO(blob)).load()
        return True
    except Exception:                                          # noqa: BLE001
        return False


def _xref_ok(pdf):
    xref = int(re.search(rb'startxref\s+(\d+)', pdf).group(1))
    rows = re.findall(rb'(\d{10}) 00000 n', pdf[xref:])
    return pdf[xref:xref + 4] == b'xref' and all(re.match(rb'%d 0 obj' % (i + 1), pdf[int(o):]) for i, o in enumerate(rows))


# --- main -----------------------------------------------------------------------------------------
def live(args):
    m, blobs = load_fixtures()
    c = make_ctx(args)
    print(f'stack={c.prefix} region={c.region} run tag={c.tag} read-only bucket={c.ro_bucket}', flush=True)
    section('cleanup (start)')
    sweep(c, 'start')
    if args.cleanup_only:
        return
    try:
        if step('setup', setup, c, m) is None and not getattr(c, 'W', None):
            return
        if not all(getattr(c, x, None) for x in ('W', 'E', 'D', 'D_DS', 'N', 'X', 'R')):
            rec('setup complete (W, E, D, N, X, R)', False, 'skipping the rest')
            return
        step('destinations', check_destinations, c)
        step('uploads', do_uploads, c, m, blobs)
        if not getattr(c, 'k', None):
            return
        step('analysis', run_analysis, c, m)
        step('validation', run_validation, c)
        step('refusals on non-writable destinations', run_refusals, c)
        c.import_ids = {}
        step('end to end', run_e2e, c, m)
        step('audit', run_audit, c, m)
        step('data user privileges', run_data_user, c, m, blobs)
    finally:
        section('cleanup (end)')
        if args.keep:
            print('  --keep: leaving ndv2-* objects in place', flush=True)
        else:
            try:
                sweep(c, 'end')
            except Exception as e:                             # noqa: BLE001
                print(f'  cleanup failed: {e}', flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('workdir', nargs='?', default=os.path.join(os.environ.get('TEST_SCRATCH', '.'), 'burner'),
                    help='stack_setup.py workdir holding stack.env and admin_pw')
    ap.add_argument('--dry-run', action='store_true', help='fixtures and request bodies only; no AWS, no HTTP')
    ap.add_argument('--timeout', type=int, default=420, help='seconds per ingest/visibility wait (default 420)')
    ap.add_argument('--region', help='AWS region (default: AWS_REGION, else us-east-1)')
    ap.add_argument('--profile', default=os.environ.get('NDV2_AWS_PROFILE'), help='AWS profile for S3/Cognito calls')
    ap.add_argument('--keep', action='store_true', help='do not delete what this run created (debugging)')
    ap.add_argument('--cleanup-only', action='store_true', help='remove leftover ndv2-* objects and exit')
    args = ap.parse_args()
    if args.dry_run:
        dry_run()
    else:
        live(args)
    passed = sum(1 for _, ok, _ in results if ok)
    print(f'\nRESULT {passed}/{len(results)}')
    sys.exit(0 if args.cleanup_only or (results and passed == len(results)) else 1)


if __name__ == '__main__':
    main()
