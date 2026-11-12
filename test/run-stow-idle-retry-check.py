"""STOW, idle past the NAT idle timeout, STOW again: exercises the sync-ingest retry.

Env: STOW_E2E_API, STOW_E2E_CF, STOW_E2E_CLIENT_ID. Args: [idle seconds] [rounds].
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import io, json, os, sys, time, uuid, urllib.request, urllib.error
import boto3, pydicom
from pydicom.data import get_testdata_file
from pydicom.uid import generate_uid

API = os.environ['STOW_E2E_API']
CF = os.environ['STOW_E2E_CF']
CLIENT = os.environ['STOW_E2E_CLIENT_ID']
IDLE = int(sys.argv[1]) if len(sys.argv) > 1 else 420
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 3


def tok():
    return sign_in(boto3.client('cognito-idp'), CLIENT, 'test-admin', 'TestAdmin123!')['AccessToken']


t = tok()
r = urllib.request.Request(API + '/datastores', headers={'Authorization': 'Bearer ' + t})
b = json.loads(urllib.request.urlopen(r, timeout=60).read())
demo = next(x['id'] for x in (lambda d: d if isinstance(d, list) else d.get('items', []))(b.get('data', b)) if x.get('name') == 'demo-studies')
results = []
for i in range(ROUNDS):
    if i:
        print(f'idle {IDLE}s', flush=True); time.sleep(IDLE); t = tok()
    ds = pydicom.dcmread(get_testdata_file('CT_small.dcm'))
    ds.StudyInstanceUID, ds.SeriesInstanceUID, ds.SOPInstanceUID = generate_uid(), generate_uid(), generate_uid()
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    buf = io.BytesIO(); ds.save_as(buf, write_like_original=False)
    bnd = 'b' + uuid.uuid4().hex
    body = f'--{bnd}\r\nContent-Type: application/dicom\r\n\r\n'.encode() + buf.getvalue() + f'\r\n--{bnd}--\r\n'.encode()
    req = urllib.request.Request(f'{CF}/dicomweb/{demo}/studies', data=body, method='POST', headers={
        'Authorization': 'Bearer ' + t, 'Accept': 'application/dicom+json',
        'Content-Type': f'multipart/related; type="application/dicom"; boundary={bnd}'})
    try:
        st = urllib.request.urlopen(req, timeout=180).status
    except urllib.error.HTTPError as e:
        st = e.code
    print(f'round {i + 1}: STOW status {st}', flush=True)
    results.append(st)
print('all 200' if all(s == 200 for s in results) else f'FAILURES {results}')
