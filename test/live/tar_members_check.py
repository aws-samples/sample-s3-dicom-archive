#!/usr/bin/env python3
"""Live check: every member of an uncompressed tar indexed in place reads back as itself.

Regression for 858ff0a (storage_index keyed per S3 object, so all members of one tar
collapsed onto the last member's byte range). Builds a 3-member tar of distinct CT
instances in one series, uploads it to demo-studies, waits for QIDO to list all three,
then WADO-retrieves each instance and compares its bytes with the source file.

Usage: tar_members_check.py <workdir>   (reads <workdir>/stack.env and admin_token)
"""
import io, os, re, sys, tarfile, time, uuid, urllib.request, urllib.error

import boto3, pydicom
from pydicom.data import get_testdata_file
from pydicom.uid import generate_uid

WD = sys.argv[1]
ENV = dict(re.findall(r"^(\w+)='(.*)'$", open(os.path.join(WD, 'stack.env')).read(), re.M))
TOK = open(os.path.join(WD, 'admin_token')).read().strip()
BASE = f"{ENV['CF']}/dicomweb/{ENV['DS_ID']}"
results = []


def rec(name, ok, detail=''):
    results.append(ok)
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


def get(path, accept):
    r = urllib.request.Request(BASE + path, headers={'Authorization': 'Bearer ' + TOK, 'Accept': accept})
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            return resp.status, resp.headers.get('Content-Type', ''), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, '', e.read()[:300]


def first_part(ctype, body):
    m = re.search(r'boundary="?([^";]+)"?', ctype)
    assert m, ctype
    part = body.split(b'--' + m.group(1).encode())[1]
    return part.split(b'\r\n\r\n', 1)[1].rsplit(b'\r\n', 1)[0]


tag = uuid.uuid4().hex[:6].upper()
study, series = generate_uid(), generate_uid()
members = {}
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as tf:
    for i in range(3):
        d = pydicom.dcmread(get_testdata_file('CT_small.dcm'))
        d.PatientName, d.PatientID = f'TAR^MEMBER{i + 1}', f'TARCHK{tag}'
        d.StudyInstanceUID, d.SeriesInstanceUID = study, series
        d.SOPInstanceUID = d.file_meta.MediaStorageSOPInstanceUID = generate_uid()
        d.InstanceNumber = i + 1
        b = io.BytesIO(); d.save_as(b, write_like_original=False); raw = b.getvalue()
        members[d.SOPInstanceUID] = raw
        ti = tarfile.TarInfo(f'member{i + 1}.dcm'); ti.size = len(raw)
        tf.addfile(ti, io.BytesIO(raw))
key = f'tar-check/{tag}.tar'
boto3.client('s3').put_object(Bucket=ENV['DS_BUCKET'], Key=key, Body=buf.getvalue())
rec('upload 3-member tar', True, f"s3://{ENV['DS_BUCKET']}/{key}")

found = []
for _ in range(40):
    st, _, body = get(f'/studies/{study}/series/{series}/instances', 'application/dicom+json')
    if st == 200 and body:
        import json
        found = [x['00080018']['Value'][0] for x in json.loads(body)]
        if len(found) == 3:
            break
    time.sleep(10)
rec('QIDO lists all 3 members', sorted(found) == sorted(members), f'found={len(found)}')

for sop, raw in members.items():
    st, ct, body = get(f'/studies/{study}/series/{series}/instances/{sop}',
                       'multipart/related; type="application/dicom"; transfer-syntax=*')
    got = first_part(ct, body) if st == 200 else b''
    same = got == raw
    got_sop = pydicom.dcmread(io.BytesIO(got), force=True).SOPInstanceUID if got else None
    rec(f'WADO {sop[-12:]} returns its own bytes', st == 200 and same,
        f'status={st} bytes={len(got)}/{len(raw)} sop_match={got_sop == sop}')

boto3.client('s3').delete_object(Bucket=ENV['DS_BUCKET'], Key=key)
print(f"RESULT {sum(results)}/{len(results)}")
sys.exit(0 if all(results) else 1)
