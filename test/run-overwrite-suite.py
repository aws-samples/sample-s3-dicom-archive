#!/usr/bin/env python3
"""Live check: re-uploading an S3 key with NEW UIDs replaces the old instance.

Regression for the duplicate-instance-on-overwrite bug: storage_index is keyed on
the S3 object, instance on the SOP, so a re-upload of the same key with new
Study/Series/SOP UIDs used to leave the earlier instance live on the same
content_pkey (a phantom study served with the new object's bytes).

Steps (against the demo-studies datastore of the stack in <workdir>/stack.env):
  1. generate a small DICOM with pydicom (fresh UIDs, not a seed file) and PUT it
     to s3://$DS_BUCKET/overwrite-test/<random>/obj.dcm
  2. wait until QIDO lists its study with exactly one instance
  3. PUT a second generated DICOM (all-new UIDs) to the SAME key
  4. assert the old study, series and SOP are gone from QIDO and the new study is
     present with exactly one instance (the new SOP)
  5. delete the test object, assert the prefix is empty in S3 and the new study
     leaves QIDO
  6. removal: PUT a third generated DICOM to a NEW key, wait for QIDO, assert its
     storage_index row is live (analytics POST /query, type=sql), delete it from
     S3, then assert the storage_index row is no longer live (soft-deleted on the
     ObjectRemoved event; the analytics guard excludes deleted_at rows) and the
     instance is gone from QIDO

Usage:
  run-overwrite-suite.py [<workdir>] [--profile P] [--region R] [--timeout S]
  run-overwrite-suite.py --dry-run      (local generation only: no AWS, no HTTP)

<workdir> defaults to $TEST_SCRATCH/burner; it must hold stack.env (API, CF,
DS_ID, DS_BUCKET, CLIENT, ADMIN_PW_FILE) and admin_token. The token is refreshed
through Cognito once if QIDO answers 401.
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import argparse
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, MRImageStorage, generate_uid

results = []


def rec(name, ok, detail=''):
    results.append(bool(ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


def make_dicom(tag, version):
    """A tiny native MR instance with all-new Study/Series/SOP UIDs."""
    ds = Dataset()
    ds.PatientName = f'OVERWRITE^V{version}'
    ds.PatientID = f'OVW{tag}'
    ds.StudyDescription = f'overwrite-test {tag} v{version}'
    ds.Modality = 'MR'
    ds.SOPClassUID = MRImageStorage
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.SOPInstanceUID = generate_uid()
    ds.StudyDate, ds.StudyTime = time.strftime('%Y%m%d'), time.strftime('%H%M%S')
    ds.SeriesNumber = ds.InstanceNumber = 1
    ds.Rows = ds.Columns = 8
    ds.BitsAllocated, ds.BitsStored, ds.HighBit = 16, 16, 15
    ds.SamplesPerPixel, ds.PixelRepresentation = 1, 0
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.PixelData = bytes([version % 256, 0]) * 64
    fm = FileMetaDataset()
    fm.TransferSyntaxUID = ExplicitVRLittleEndian
    fm.MediaStorageSOPClassUID = ds.SOPClassUID
    fm.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.file_meta = fm
    buf = io.BytesIO()
    try:
        ds.save_as(buf, enforce_file_format=True)       # pydicom 3
    except TypeError:
        ds.save_as(buf, write_like_original=False)      # pydicom 2
    return {'study': ds.StudyInstanceUID, 'series': ds.SeriesInstanceUID,
            'sop': ds.SOPInstanceUID, 'bytes': buf.getvalue()}


class Qido:
    def __init__(self, wd, env, session):
        self.wd, self.env, self.session = wd, env, session
        self.base = f"{env['CF'].rstrip('/')}/dicomweb/{env['DS_ID']}"
        self.token = open(os.path.join(wd, 'admin_token')).read().strip()
        self.refreshed = False

    def _refresh(self):
        pw = open(self.env['ADMIN_PW_FILE']).read().strip()
        auth = sign_in(self.session.client('cognito-idp'), self.env['CLIENT'], 'admin', pw)
        self.token = auth['AccessToken']
        with open(os.path.join(self.wd, 'admin_token'), 'w') as f:
            f.write(self.token)
        self.refreshed = True

    def get(self, path):
        """GET a QIDO path -> (status, list). 204 / empty body -> []."""
        req = urllib.request.Request(self.base + path, headers={
            'Authorization': 'Bearer ' + self.token, 'Accept': 'application/dicom+json'})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
                return resp.status, (json.loads(body) if body.strip() else [])
        except urllib.error.HTTPError as e:
            if e.code == 401 and not self.refreshed:
                self._refresh()
                return self.get(path)
            return e.code, []

    def studies(self, study_uid):
        return self.get(f'/studies?StudyInstanceUID={study_uid}')

    def instances(self, study_uid):
        return self.get(f'/studies/{study_uid}/instances')

    def sop(self, sop_uid):
        return self.get(f'/instances?SOPInstanceUID={sop_uid}')


class Analytics:
    """Typed-SQL reads through the analytics API (storage scope = DS_ID). The
    server-side guard adds datastore_id scoping and deleted_at IS NULL to every
    storage table, so a row count here is a count of LIVE rows."""

    def __init__(self, env, qido):
        self.env, self.qido = env, qido
        self.url = f"{env['API'].rstrip('/')}/analytics-projects/{env['DS_ID']}/query"

    def rows(self, sql):
        body = {'type': 'sql', 'sql': sql, 'pageSize': 100, 'pageOffset': 0,
                'source': {'kind': 'storage', 'ids': [self.env['DS_ID']]}}
        for attempt in (0, 1):
            req = urllib.request.Request(self.url, method='POST', data=json.dumps(body).encode(),
                                         headers={'Authorization': 'Bearer ' + self.qido.token,
                                                  'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    return resp.status, (json.loads(resp.read() or b'{}').get('data') or {}).get('rows', [])
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0 and not self.qido.refreshed:
                    self.qido._refresh()
                    continue
                return e.code, []

    def live_storage_rows(self, key):
        # key is generated here (hex tag), never user input; no quote can occur.
        assert "'" not in key
        return self.rows(f"SELECT si.content_pkey FROM storage_index si WHERE si.s3_key = '{key}'")


def removal_check(args, s3, qido, analytics, bucket, prefix, tag):
    """Upload, delete from S3, expect storage_index soft-deleted + QIDO gone."""
    key = prefix + 'removed.dcm'
    v3 = make_dicom(tag, 3)
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=v3['bytes'], ContentType='application/dicom')
        rec('removal: upload object', True, f's3://{bucket}/{key} sop={v3["sop"]}')

        def indexed():
            st, rows = qido.sop(v3['sop'])
            return st == 200 and len(rows) == 1, f'status={st} rows={len(rows)}'
        ok, d = wait_for('removal indexed', indexed, args.timeout)
        rec('removal: QIDO lists the instance', ok, d)
        if not ok:
            return
        st, rows = analytics.live_storage_rows(key)
        rec('removal: storage_index row is live before delete', st == 200 and len(rows) == 1,
            f'status={st} live_rows={len(rows)}')

        s3.delete_object(Bucket=bucket, Key=key)
        rec('removal: delete object from S3', True, key)

        def storage_retired():
            st, rows = analytics.live_storage_rows(key)
            return st == 200 and rows == [], f'status={st} live_rows={len(rows)}'
        ok, d = wait_for('storage soft-deleted', storage_retired, args.timeout)
        rec('removal: storage_index row soft-deleted', ok, d)

        def gone():
            st, rows = qido.sop(v3['sop'])
            return st in (200, 204) and rows == [], f'status={st} rows={len(rows)}'
        ok, d = wait_for('removal gone', gone, args.timeout)
        rec('removal: instance gone from QIDO', ok, d)
        # The study row is retired by the recompute that follows the instance, so it can
        # trail the instance by a few seconds: wait for it like the other checks.
        def study_gone():
            st, rows = qido.studies(v3['study'])
            return st in (200, 204) and rows == [], f'status={st} rows={len(rows)}'
        ok, d = wait_for('removal study gone', study_gone, args.timeout)
        rec('removal: study gone from QIDO', ok, d)
    finally:
        s3.delete_object(Bucket=bucket, Key=key)


def sops(rows):
    return sorted(r.get('00080018', {}).get('Value', [None])[0] for r in rows)


def wait_for(desc, check, timeout, every=10):
    """Poll check() -> (done, detail) until done or timeout."""
    deadline = time.time() + timeout
    while True:
        done, detail = check()
        if done or time.time() >= deadline:
            return done, detail
        time.sleep(every)


def dry_run():
    tag = uuid.uuid4().hex[:8]
    key = f'overwrite-test/{tag}/obj.dcm'
    v1, v2 = make_dicom(tag, 1), make_dicom(tag, 2)
    for v in (v1, v2):
        d = pydicom.dcmread(io.BytesIO(v['bytes']))
        rec(f"generated {v['sop'][-10:]} parses", d.SOPInstanceUID == v['sop']
            and d.StudyInstanceUID == v['study'], f"{len(v['bytes'])} bytes")
    rec('v2 has all-new UIDs', all(v1[k] != v2[k] for k in ('study', 'series', 'sop')))
    rec('key under overwrite-test/<random>/', re.fullmatch(r'overwrite-test/[0-9a-f]{8}/obj\.dcm', key), key)
    print('dry run: would PUT v1, wait for QIDO, PUT v2 to the same key, assert, delete;')
    print('         then PUT v3 to a new key, delete it, assert storage_index soft-deleted + QIDO gone')


def live(args):
    import boto3
    env = dict(re.findall(r"^(\w+)='(.*)'$", open(os.path.join(args.workdir, 'stack.env')).read(), re.M))
    session = boto3.Session(profile_name=args.profile or None,
                            region_name=args.region or os.environ.get('AWS_REGION') or 'us-east-2')
    s3 = session.client('s3')
    qido = Qido(args.workdir, env, session)
    bucket = env['DS_BUCKET']
    tag = uuid.uuid4().hex[:8]
    prefix = f'overwrite-test/{tag}/'
    key = prefix + 'obj.dcm'
    v1, v2 = make_dicom(tag, 1), make_dicom(tag, 2)
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=v1['bytes'], ContentType='application/dicom')
        rec('upload v1', True, f's3://{bucket}/{key} study={v1["study"]}')

        def v1_indexed():
            st, rows = qido.instances(v1['study'])
            return st == 200 and sops(rows) == [v1['sop']], f'status={st} sops={sops(rows)}'
        ok, d = wait_for('v1', v1_indexed, args.timeout)
        rec('QIDO lists v1 study with one instance', ok, d)
        if not ok:
            return

        s3.put_object(Bucket=bucket, Key=key, Body=v2['bytes'], ContentType='application/dicom')
        rec('re-upload same key with new UIDs (v2)', True, f'study={v2["study"]}')

        def v2_indexed():
            st, rows = qido.instances(v2['study'])
            return st == 200 and len(rows) >= 1, f'status={st} sops={sops(rows)}'
        ok, d = wait_for('v2', v2_indexed, args.timeout)
        rec('QIDO lists v2 study', ok, d)

        def v1_gone():
            st, rows = qido.studies(v1['study'])
            return st in (200, 204) and rows == [], f'status={st} rows={len(rows)}'
        ok, d = wait_for('v1 gone', v1_gone, args.timeout)
        rec('old study gone from QIDO', ok, d)
        st, rows = qido.sop(v1['sop'])
        rec('old SOP gone from QIDO', st in (200, 204) and rows == [], f'status={st} rows={len(rows)}')
        st, rows = qido.instances(v2['study'])
        rec('new study has exactly one instance (the new SOP)',
            st == 200 and sops(rows) == [v2['sop']], f'status={st} sops={sops(rows)}')
        st, rows = qido.studies(v2['study'])
        n = (rows[0].get('00201208', {}).get('Value', [None])[0] if rows else None)
        rec('new study NumberOfStudyRelatedInstances == 1', st == 200 and len(rows) == 1 and n == 1,
            f'status={st} studies={len(rows)} count={n}')
    finally:
        s3.delete_object(Bucket=bucket, Key=key)
        left = s3.list_objects_v2(Bucket=bucket, Prefix=prefix).get('KeyCount', 0)
        rec('test objects deleted from S3', left == 0, f'prefix={prefix} remaining={left}')

    def v2_gone():
        st, rows = qido.studies(v2['study'])
        return st in (200, 204) and rows == [], f'status={st} rows={len(rows)}'
    ok, d = wait_for('v2 gone', v2_gone, args.timeout)
    rec('new study leaves QIDO after delete', ok, d)

    removal_check(args, s3, qido, Analytics(env, qido), bucket, prefix, tag)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('workdir', nargs='?',
                    default=os.path.join(os.environ.get('TEST_SCRATCH', '.'), 'burner'))
    ap.add_argument('--dry-run', action='store_true', help='local generation only')
    ap.add_argument('--profile', default=os.environ.get('OVW_AWS_PROFILE'))
    ap.add_argument('--region')
    ap.add_argument('--timeout', type=int, default=300, help='seconds per wait (default 300)')
    args = ap.parse_args()
    if args.dry_run:
        dry_run()
    else:
        live(args)
    print(f"RESULT {sum(results)}/{len(results)}")
    sys.exit(0 if results and all(results) else 1)


if __name__ == '__main__':
    main()
