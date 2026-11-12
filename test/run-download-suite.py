#!/usr/bin/env python3
"""Live check: the canDownload privilege and the study .zip download.

Against the demo-studies datastore of the stack in <workdir>/stack.env:
  1. admin's GET .../download-access reports canDownload=true (the built-in
     Administrators group downloads wherever it reads)
  2. pick a small non-WSI study via QIDO, count its instances
     (GET /studies/{uid}/instances)
  3. admin GET .../studies/{uid}/download -> 200 application/zip; the archive
     opens, passes testzip(), and its DICOM Part 10 member count equals the QIDO
     instance count
  4. READ_ONLY (canRead, no canDownload) can QIDO the storage (precondition) but
     gets 403 on the download and canDownload=false from the probe
  5. no token -> 401 on the download
  6. the audit trail holds a DOWNLOAD_STUDY SUCCESS row for the admin's download
     of that study (instanceCount matches), and a FAILURE row for READ_ONLY's

Read-only apart from the download itself (no data is written; the download and
the denied attempt each add one audit row).

Usage:
  run-download-suite.py [<workdir>] [--tokens test/test-tokens.json] [--max-instances N]

<workdir> defaults to $TEST_SCRATCH/burner; it must hold stack.env (API, CF,
DS_ID, CLIENT, ADMIN_PW_FILE) and admin_token. The admin token is refreshed
through Cognito once on a 401. READ_ONLY's token comes from test-tokens.json
(written by test/authenticate-test-users.js).
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import argparse
import base64
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
results = []


def rec(name, ok, detail=''):
    results.append(bool(ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


def jwt_username(token):
    """The username claim of a Cognito access token (no verification: display/match only)."""
    try:
        payload = token.split('.')[1]
        payload += '=' * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims.get('username') or claims.get('cognito:username') or ''
    except Exception:
        return ''


class Client:
    def __init__(self, wd, env):
        self.wd, self.env = wd, env
        self.cf = env['CF'].rstrip('/')
        self.api = env['API'].rstrip('/')
        self.base = f"{self.cf}/dicomweb/{env['DS_ID']}"
        self.admin = open(os.path.join(wd, 'admin_token')).read().strip()
        self.refreshed = False

    def refresh_admin(self):
        import boto3
        session = boto3.Session(profile_name=os.environ.get('AWS_PROFILE') or None,
                                region_name=os.environ.get('AWS_REGION') or 'us-east-2')
        pw = open(self.env['ADMIN_PW_FILE']).read().strip()
        auth = sign_in(session.client('cognito-idp'), self.env['CLIENT'], 'admin', pw)
        self.admin = auth['AccessToken']
        with open(os.path.join(self.wd, 'admin_token'), 'w') as f:
            f.write(self.admin)
        self.refreshed = True

    def request(self, url, token, accept, bearer=True, timeout=300):
        """-> (status, headers, body bytes)."""
        headers = {'Accept': accept}
        if token:
            headers['Authorization'] = ('Bearer ' + token) if bearer else token
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()
        except Exception as e:      # connection failure / truncated body
            return 0, {}, str(e).encode()

    def admin_get(self, url, accept, bearer=True):
        st, h, body = self.request(url, self.admin, accept, bearer)
        if st == 401 and not self.refreshed:
            self.refresh_admin()
            st, h, body = self.request(url, self.admin, accept, bearer)
        return st, h, body


def first(row, tag):
    v = (row.get(tag) or {}).get('Value') or [None]
    return v[0]


def pick_study(c, max_instances):
    """Smallest multi-instance, non-WSI study on the first QIDO page (keeps the download small)."""
    st, _, body = c.admin_get(f"{c.base}/studies?limit=100&includefield=00201208,00080061",
                              'application/dicom+json')
    rows = json.loads(body) if st == 200 and body.strip() else []
    cands = []
    for r in rows:
        uid = first(r, '0020000D')
        n = first(r, '00201208')
        mods = (r.get('00080061') or {}).get('Value') or []
        if uid and isinstance(n, int) and 0 < n <= max_instances and 'SM' not in mods:
            cands.append((n, uid))
    # Prefer a multi-instance study so the count check means something.
    cands.sort(key=lambda c: (c[0] < 2, c[0]))
    return st, len(rows), (cands[0][1] if cands else None)


def dicom_members(data):
    """(member count, Part 10 member count, testzip result)."""
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = [n for n in zf.namelist() if not n.endswith('/')]
    part10 = 0
    for n in names:
        head = zf.open(n).read(132)
        part10 += head[128:132] == b'DICM'
    return len(names), part10, zf.testzip()


def audit_rows(c, action, page_size=100):
    st, _, body = c.admin_get(f"{c.api}/audit?action={action}&pageSize={page_size}",
                              'application/json', bearer=False)
    try:
        return st, (json.loads(body).get('data') or {}).get('items') or []
    except ValueError:
        return st, []


def new_values(row):
    nv = row.get('newValues') or {}
    if isinstance(nv, str):
        try:
            nv = json.loads(nv)
        except ValueError:
            nv = {}
    return nv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('workdir', nargs='?',
                    default=os.path.join(os.environ.get('TEST_SCRATCH', '.'), 'burner'))
    ap.add_argument('--tokens', default=os.path.join(HERE, 'test-tokens.json'))
    ap.add_argument('--max-instances', type=int, default=200)
    ap.add_argument('--audit-wait', type=int, default=90)
    args = ap.parse_args()

    env = dict(re.findall(r"^(\w+)='(.*)'$", open(os.path.join(args.workdir, 'stack.env')).read(), re.M))
    c = Client(args.workdir, env)
    read_only = json.load(open(args.tokens)).get('READ_ONLY', '')

    print('=== download privilege suite ===')
    # 1. probe
    st, _, body = c.admin_get(f"{c.base}/download-access", 'application/json')
    verdict = json.loads(body).get('canDownload') if st == 200 else None
    rec('admin download-access probe -> canDownload=true', st == 200 and verdict is True,
        f"HTTP {st} {body[:80]!r}")
    admin_user = jwt_username(c.admin)

    # 2. pick a study
    st, n_rows, study = pick_study(c, args.max_instances)
    rec('QIDO finds a small non-WSI study', st == 200 and bool(study),
        f"HTTP {st} rows={n_rows} study={study}")
    if not study:
        print(f"\nTOTALS: PASS={sum(results)} FAIL={len(results) - sum(results)} of {len(results)}")
        return 1
    st, _, body = c.admin_get(f"{c.base}/studies/{study}/instances?limit=1000",
                              'application/dicom+json')
    qido_count = len(json.loads(body)) if st == 200 and body.strip() else 0
    rec('QIDO instance count for the study', st == 200 and qido_count > 0,
        f"HTTP {st} instances={qido_count}")

    # Audit rows that already exist, so only this run's rows count below.
    _, before = audit_rows(c, 'DOWNLOAD_STUDY', 500)
    seen = {r.get('id') for r in before}

    # 3. admin download
    t0 = time.time()
    st, h, data = c.admin_get(f"{c.base}/studies/{study}/download", 'application/zip')
    ctype = (h.get('Content-Type') or h.get('content-type') or '')
    disp = (h.get('Content-Disposition') or h.get('content-disposition') or '')
    rec('admin download -> 200 application/zip attachment',
        st == 200 and ctype.startswith('application/zip') and 'attachment' in disp,
        f"HTTP {st} type={ctype} bytes={len(data)} {time.time() - t0:.1f}s")
    members = part10 = -1
    bad = 'not opened'
    if st == 200:
        try:
            members, part10, bad = dicom_members(data)
        except zipfile.BadZipFile as e:
            bad = f"BadZipFile: {e}"
    rec('zip opens and every member passes CRC (testzip)', bad is None, f"testzip={bad}")
    rec('zip DICOM count == QIDO instance count',
        part10 == qido_count and members == qido_count,
        f"members={members} part10={part10} qido={qido_count}")

    # 4. READ_ONLY: reads, but no download
    st, _, _ = c.request(f"{c.base}/studies?limit=1", read_only, 'application/dicom+json')
    rec('precondition: READ_ONLY can QIDO this storage (canRead)', st == 200, f"HTTP {st}")
    st, _, body = c.request(f"{c.base}/download-access", read_only, 'application/json')
    verdict = json.loads(body).get('canDownload') if st == 200 else None
    rec('READ_ONLY download-access probe -> canDownload=false', st == 200 and verdict is False,
        f"HTTP {st} {body[:80]!r}")
    st, _, body = c.request(f"{c.base}/studies/{study}/download", read_only, 'application/zip')
    rec('READ_ONLY download -> 403', st == 403, f"HTTP {st} {body[:120]!r}")
    ro_user = jwt_username(read_only)

    # 5. no token
    st, _, _ = c.request(f"{c.base}/studies/{study}/download", None, 'application/zip')
    rec('no token download -> 401', st == 401, f"HTTP {st}")

    # 6. audit rows (EventBridge -> SQS -> audit_logs is asynchronous)
    ok_row = deny_row = None
    deadline = time.time() + args.audit_wait
    while True:
        st, rows = audit_rows(c, 'DOWNLOAD_STUDY')
        for r in rows:
            if r.get('id') in seen or study not in json.dumps(r):
                continue
            status = str(r.get('status') or '').upper()
            if status == 'SUCCESS' and r.get('user') == admin_user and ok_row is None:
                ok_row = r
            # A middleware denial is recorded before an identity exists, so the
            # row's user is empty; the refusal message names the caller.
            err = str(r.get('errorMessage') or '')
            if (status == 'FAILURE' and 'download access' in err
                    and (not ro_user or ro_user in err) and deny_row is None):
                deny_row = r
        if (ok_row and deny_row) or time.time() >= deadline:
            break
        time.sleep(10)
    nv = new_values(ok_row) if ok_row else {}
    rec('audit: DOWNLOAD_STUDY SUCCESS row for the admin download',
        ok_row is not None and nv.get('instanceCount') == qido_count and nv.get('truncated') is False,
        f"HTTP {st} user={admin_user} row={'yes' if ok_row else 'no'} "
        f"instanceCount={nv.get('instanceCount')} bytesServed={nv.get('bytesServed')}")
    rec('audit: DOWNLOAD_STUDY FAILURE row for the READ_ONLY attempt', deny_row is not None,
        f"user={ro_user} row={'yes' if deny_row else 'no'}")

    passed = sum(results)
    print(f"\nTOTALS: PASS={passed} FAIL={len(results) - passed} of {len(results)}")
    return 0 if passed == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
