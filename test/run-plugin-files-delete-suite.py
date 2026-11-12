"""E2E: plugin run files are kept until a user deletes them (run against a deployed stack).

- The plugin I/O bucket has no expiry rule on runs/.
- DELETE /processing-jobs/runs/{id}/outputs: refused while the run is in progress (409),
  refused without processingJobs.canDelete (403), then deletes every file of the run;
  the run stays listed and its outputs response reports outputsDeleted.
- DELETE /processing-jobs/{id} on a finished plugin run also deletes its files.

Starts two "DICOM to NIfTI (plugin)" runs on one series of an existing storage.
Env: PF_E2E_API, PF_E2E_CF (CloudFront base for /dicomweb), PF_E2E_CLIENT_ID,
PF_E2E_BUCKET (plugin I/O bucket), PF_E2E_DATASTORE (storage name or id with an MR series).
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import json, os, sys, time, urllib.parse, urllib.request, urllib.error
import boto3

API = os.environ['PF_E2E_API']
CLIENT = os.environ['PF_E2E_CLIENT_ID']
BUCKET = os.environ['PF_E2E_BUCKET']
DS = os.environ['PF_E2E_DATASTORE']
s3 = boto3.client('s3')
results = []


def rec(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


def token(user, pw):
    return sign_in(boto3.client('cognito-idp'), CLIENT, user, pw)['AccessToken']


ADMIN = token('test-admin', 'TestAdmin123!')
RO = token('test-read_only', 'TestReadOnly123!')


def api(method, path, tok=ADMIN, body=None):
    r = urllib.request.Request(API + path, method=method, headers={'Authorization': 'Bearer ' + tok})
    data = None
    if body is not None:
        r.add_header('Content-Type', 'application/json'); data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, data=data, timeout=60) as resp:
            t = resp.read(); return resp.status, (json.loads(t) if t else {})
    except urllib.error.HTTPError as e:
        t = e.read().decode('utf-8', 'replace')
        try: return e.code, json.loads(t)
        except ValueError: return e.code, {'raw': t[:300]}


def keys(run_id):
    out, tok = [], None
    while True:
        kw = {'Bucket': BUCKET, 'Prefix': f'runs/{run_id}/'}
        if tok: kw['ContinuationToken'] = tok
        p = s3.list_objects_v2(**kw)
        out += [c['Key'] for c in p.get('Contents', [])]
        if not p.get('IsTruncated'): return out
        tok = p['NextContinuationToken']


def run_status(run_id):
    s, b = api('GET', f'/processing-jobs/{run_id}')
    return (b.get('data') or {}).get('status')


def wait_done(run_id, secs=900):
    end = time.time() + secs
    while time.time() < end:
        st = run_status(run_id)
        if st in ('COMPLETED', 'PARTIAL', 'FAILED'): return st
        time.sleep(15)
    return run_status(run_id)


# ---- lifecycle --------------------------------------------------------------
lc = s3.get_bucket_lifecycle_configuration(Bucket=BUCKET).get('Rules', [])
rec('I/O bucket has no expiration rule', not any('Expiration' in r for r in lc), json.dumps([r.get('ID') for r in lc]))
tags = {t['Key']: t['Value'] for t in s3.get_bucket_tagging(Bucket=BUCKET).get('TagSet', [])}
rec('I/O bucket is not set to be emptied on stack deletion', 'aws-cdk:auto-delete-objects' not in tags, '')

# ---- pick a series and the NIfTI plugin --------------------------------------
_, b = api('GET', '/datastores')
items = b.get('data') if isinstance(b.get('data'), list) else (b.get('data') or {}).get('items', [])
ds = next(d for d in items if DS in (d.get('id'), d.get('name')))
_, b = api('GET', '/processing-jobs/plugins')
nifti = next(p for p in b['data'] if 'NIfTI' in p['name'])
nifti_id = nifti['id']
# First MR series of the storage, found with QIDO-RS. Skips the one-instance-
# per-syntax test data (ts and cstorets suites, series named 'TS <uid>'), which
# the NIfTI plugin cannot convert.
CF = os.environ['PF_E2E_CF']
q = urllib.request.Request(f"{CF}/dicomweb/{ds['id']}/series?Modality=MR&limit=500",
                           headers={'Authorization': 'Bearer ' + ADMIN, 'Accept': 'application/dicom+json'})
with urllib.request.urlopen(q, timeout=60) as resp:
    ser = next(s for s in json.loads(resp.read())
               if not str((s.get('0008103E', {}).get('Value') or [''])[0]).startswith('TS '))
study_uid = ser['0020000D']['Value'][0]
series_uid = ser['0020000E']['Value'][0]
target = {'mode': 'explicit', 'entries': [{'datastoreId': ds['id'], 'studyInstanceUID': study_uid, 'seriesInstanceUID': series_uid}]}


def start():
    s, b = api('POST', f'/processing-jobs/{nifti_id}/execute', body={'params': {}, 'target': target})
    assert s == 201, (s, b)
    return b['data']['id']


run_a = start()
run_b = start()
print(f'runs: {run_a} {run_b}', flush=True)

# ---- in-progress refusal ----------------------------------------------------
s, b = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs')
rec('Delete files while the run is in progress is refused (409)', s == 409, f'{s} {json.dumps(b)[:120]}')
s, b = api('DELETE', f'/processing-jobs/{run_b}')
rec('Delete run while in progress is refused (409)', s == 409, f'{s}')

st_a, st_b = wait_done(run_a), wait_done(run_b)
rec('Both runs finished', st_a == 'COMPLETED' and st_b == 'COMPLETED', f'{st_a} {st_b}')
ka, kb = keys(run_a), keys(run_b)
rec('Both runs left files in the I/O bucket', len(ka) > 0 and len(kb) > 0, f'{len(ka)} / {len(kb)} objects')

# ---- permission ---------------------------------------------------------------
s, _ = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs', tok=RO)
rec('Delete files without processingJobs.canDelete is refused (403)', s == 403, f'{s}')
rec('...and nothing was deleted', len(keys(run_a)) == len(ka), f'{len(keys(run_a))} objects')

# ---- delete one file ---------------------------------------------------------------
_, b = api('GET', f'/processing-jobs/runs/{run_a}/outputs')
listed = [f['key'] for st in b['data']['steps'] for f in st['files']]
one = listed[0]
q = '?key=' + urllib.parse.quote(one, safe='')
s, _ = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs{q}', tok=RO)
rec('Delete one file without processingJobs.canDelete is refused (403)', s == 403, f'{s}')
s, _ = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs?key=' + urllib.parse.quote(f'runs/{run_a}/steps/0/input.json', safe=''))
rec('A key that is not a listed output is refused (404)', s == 404, f'{s}')
s, b = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs?key=' + urllib.parse.quote(f'runs/{run_b}/' + one.split('/', 2)[2], safe=''))
rec("Another run's file cannot be deleted through this run (404)", s == 404, f'{s}')
s, b = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs{q}')
rec('Delete one file returns 200', s == 200 and b['data']['key'] == one, f"{s} {one.split('/')[-1]}")
left = keys(run_a)
rec('Only that file is gone from S3', one not in left and len(left) == len(ka) - 1, f'{len(left)} of {len(ka)} objects left')
_, b = api('GET', f'/processing-jobs/runs/{run_a}/outputs')
now = [f['key'] for st in b['data']['steps'] for f in st['files']]
rec('Outputs list drops the file and keeps the others', one not in now and len(now) == len(listed) - 1 and not b['data']['outputsDeleted'],
    f'{len(now)} of {len(listed)} listed')
ka = left

# ---- delete files, keep the run -------------------------------------------------
s, b = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs')
rec('Delete files returns 200 with the count', s == 200 and b['data']['filesDeleted'] == len(ka), f"{s} {b.get('data')}")
rec('Run prefix is empty in S3', keys(run_a) == [], f'{len(keys(run_a))} objects')
s, b = api('GET', f'/processing-jobs/runs/{run_a}/outputs')
d = b.get('data') or {}
rec('Run still listed; outputs report outputsDeleted and no files',
    s == 200 and d.get('outputsDeleted', {}).get('by') == 'test-admin' and all(not st['files'] for st in d['steps']),
    json.dumps(d.get('outputsDeleted')))
s, b = api('DELETE', f'/processing-jobs/runs/{run_a}/outputs')
rec('Deleting the files again is harmless (0 files)', s == 200 and b['data']['filesDeleted'] == 0, f"{s} {b.get('data')}")

# ---- delete the run, files go too -----------------------------------------------
s, _ = api('DELETE', f'/processing-jobs/{run_b}')
rec('Delete run returns 200', s == 200, f'{s}')
rec('Deleted run left no files in S3', keys(run_b) == [], f'{len(keys(run_b))} objects')

# ---- audit trail ---------------------------------------------------------------
def audit_rows(res_type, run_id):
    _, b = api('GET', f'/audit?pageSize=20&resourceType={res_type}')
    return [i for i in ((b.get('data') or {}).get('items') or []) if i.get('resourceId') == run_id]


time.sleep(20)  # EventBridge -> SQS -> audit writer
rec('Delete files is in the audit trail', len(audit_rows('PROCESSING_JOB_RUN_OUTPUTS', run_a)) >= 1, run_a[:8])
rec('Delete run is in the audit trail', any(i['action'] == 'DELETE' for i in audit_rows('PROCESSING_JOB', run_b)), run_b[:8])

# ---- cleanup -------------------------------------------------------------------
api('DELETE', f'/processing-jobs/{run_a}')
passed = sum(ok for _, ok, _ in results)
print(f'\n{passed}/{len(results)} passed')
sys.exit(0 if passed == len(results) else 1)
