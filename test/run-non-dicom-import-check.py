#!/usr/bin/env python3
"""End-to-end non-DICOM import check (the flow the "Non-DICOM Import" screen runs).

Uploads a small PNG through /non-dicom-import/upload-url exactly like the UI,
creates the import job for a NEW patient and study, then waits until:
  - the non-DICOM job reaches COMPLETED (not stuck in IMPORTING, not FAILED);
  - QIDO finds the new study, with one SC instance, in the chosen storage.

Regression for: import-trigger refusing the encapsulated staging source (F16)
and non_dicom_imports never leaving IMPORTING.

Env: ND_E2E_API (…/v1/api), ND_E2E_CF (https://<cloudfront>), ND_E2E_CLIENT_ID,
     ND_E2E_ADMIN_PW (deployment admin), optional ND_E2E_DATASTORE (id or name).
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import base64, json, os, sys, time, uuid, urllib.request, urllib.error
import boto3

API, CF, CLIENT = os.environ['ND_E2E_API'], os.environ['ND_E2E_CF'], os.environ['ND_E2E_CLIENT_ID']
WANT_DS = os.environ.get('ND_E2E_DATASTORE', '')
TIMEOUT_S = int(os.environ.get('ND_E2E_TIMEOUT', '420'))

# 1x1 PNG
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

results = []
def rec(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)

cog = boto3.client('cognito-idp')
TOK = sign_in(cog, CLIENT, 'admin', os.environ['ND_E2E_ADMIN_PW'])['AccessToken']

def req(method, url, body=None, headers=None, raw=None):
    h = {'Authorization': 'Bearer ' + TOK, **(headers or {})}
    data = raw
    if body is not None:
        h['Content-Type'] = 'application/json'; data = json.dumps(body).encode()
    r = urllib.request.Request(url, method=method, headers=h, data=data)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp: b, st = resp.read(), resp.status
    except urllib.error.HTTPError as e: b, st = e.read(), e.code
    try: return st, json.loads(b) if b else {}
    except ValueError: return st, {}

def api(method, path, body=None): return req(method, API + path, body)

# Storage
st, b = api('GET', '/datastores?pageSize=100')
dss = (b.get('data') or {}).get('items', []) if isinstance(b.get('data'), dict) else b.get('data', [])
ds = next((x for x in dss if WANT_DS in (x.get('id'), x.get('name'))), None) if WANT_DS else (dss[0] if dss else None)
rec('a storage is available', ds is not None, ds and f"{ds['name']} ({ds['id']})")
if not ds: sys.exit(1)

# Upload exactly like the UI
ts = int(time.time() * 1000)
st, b = api('POST', '/non-dicom-import/upload-url', {
    'files': [{'path': '0-nd-check.png', 'name': 'nd-check.png', 'size': len(PNG), 'type': 'image/png'}],
    'folderName': f'non-dicom-{ts}', 'timestamp': ts})
urls = (b.get('data') or {}).get('uploadUrls') or []
rec('upload URL issued', st == 200 and len(urls) == 1, f'HTTP {st}')
if not urls: sys.exit(1)
put = urllib.request.Request(urls[0]['url'], method='PUT', data=PNG, headers={'Content-Type': 'image/png'})
with urllib.request.urlopen(put, timeout=60) as r: rec('file uploaded to staging', r.status == 200, f'HTTP {r.status}')

pid = f'ND-CHECK-{uuid.uuid4().hex[:8].upper()}'
st, b = api('POST', '/non-dicom-import', {
    'datastoreId': ds['id'], 's3InputKeys': [urls[0]['key']],
    'patientAttrs': {'PatientID': pid, 'PatientName': 'NDCHECK^PNG', 'PatientBirthDate': '', 'PatientSex': 'O'},
    'studyAttrs': {'StudyDescription': 'non-DICOM import check', 'StudyDate': time.strftime('%Y%m%d'),
                   'StudyTime': time.strftime('%H%M%S'), 'AccessionNumber': ''},
    'seriesAssignments': [{'s3Key': urls[0]['key'], 'contentType': 'image/png', 'seriesDescription': 'nd check'}]})
job = (b.get('data') or {})
job_id = job.get('id') or job.get('jobId')
rec('import job created', st in (200, 201) and job_id, f'HTTP {st} job={job_id}')
if not job_id: sys.exit(1)

# Wait for a terminal status
deadline, status, desc = time.time() + TIMEOUT_S, None, None
while time.time() < deadline:
    st, b = api('GET', f'/non-dicom-import/{job_id}')
    j = b.get('data') or {}
    status, desc = j.get('status'), j.get('status_description')
    if status in ('COMPLETED', 'FAILED'): break
    time.sleep(10)
rec('non-DICOM job reaches COMPLETED', status == 'COMPLETED', f'status={status} ({desc})')

# Study is queryable in the storage
found = None
for _ in range(18):
    st, b = req('GET', f"{CF}/dicomweb/{ds['id']}/studies?PatientID={pid}&includefield=00201208", headers={'Accept': 'application/dicom+json'})
    if st == 200 and isinstance(b, list) and b: found = b[0]; break
    time.sleep(10)
n = found and (found.get('00201208') or {}).get('Value', [None])[0]
rec('QIDO finds the new study', found is not None, f'PatientID={pid} instances={n}')
rec('study holds the one imported instance', n == 1, f'instances={n}')

passed = sum(ok for _, ok, _ in results)
print(f'\nnon-DICOM import check: {passed}/{len(results)}')
sys.exit(0 if passed == len(results) else 1)
