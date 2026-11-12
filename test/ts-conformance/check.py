"""Live transfer-syntax conformance check against a deployed DICOMweb service.

For every instance in tsconf/manifest.json:
  1 QIDO      instance found under its study/series
  2 metadata  instance metadata returns 200 with the SOP Instance UID
  3 instance  WADO instance (as stored) parses, same SOP UID and transfer syntax
  4 frame     frame 1 as stored: 200, bytes equal the stored frame (encapsulated) or decode equal (native)
  5 ELE       frame 1 with transfer-syntax=1.2.840.10008.1.2.1 requested:
                lossless/near-lossless  -> returned as ELE and pixels equal the independent reference decode
                lossy (service policy)  -> returned as stored, unchanged
  6 rendered  frame 1 rendered as image/jpeg: 200 for native and Pillow-decodable syntaxes, else 415
Env: TSC_BASE (https://<cf>/dicomweb/<datastoreId>), TSC_TOKEN_FILE. Writes tsconf/results.json.
"""
import email.parser, hashlib, io, json, os, re, sys, time
import numpy as np, pydicom, requests

S = os.environ.get('TSC_WORKDIR', os.path.join(os.getcwd(), 'tsconf-work')); D = os.path.join(S, 'tsconf')
BASE = os.environ['TSC_BASE'].rstrip('/'); TOK = open(os.environ['TSC_TOKEN_FILE']).read().strip()
H = {'Authorization': f'Bearer {TOK}'}
man = json.load(open(os.path.join(D, 'manifest.json'))); refs = json.load(open(os.path.join(D, 'refs.json')))
NATIVE = {'1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2'}  # deflated is a whole-dataset encoding
# Expected policy (independent restatement, not imported from the service):
TO_ELE = {'1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2', '1.2.840.10008.1.2.1.99', '1.2.840.10008.1.2.4.57',
          '1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.4.80', '1.2.840.10008.1.2.4.81', '1.2.840.10008.1.2.4.90',
          '1.2.840.10008.1.2.4.92', '1.2.840.10008.1.2.4.201', '1.2.840.10008.1.2.4.202', '1.2.840.10008.1.2.5',
          '1.2.840.10008.1.2.8.1', '1.2.840.10008.1.2.1.98'}
VIDEO = {f'1.2.840.10008.1.2.4.{n}' for n in range(100, 109)}
NOT_RENDERABLE = VIDEO | {'1.2.840.10008.1.2.4.110', '1.2.840.10008.1.2.4.112'}

def parts(resp):
    ct = resp.headers.get('Content-Type', '')
    msg = email.parser.BytesParser().parsebytes(b'Content-Type: ' + ct.encode() + b'\r\n\r\n' + resp.content)
    return [(p.get('Content-Type', ''), p.get_payload(decode=True)) for p in msg.walk() if not p.is_multipart()]

def ts_of(ct):
    m = re.search(r'transfer-syntax="?([0-9.]+)', ct or ''); return m.group(1) if m else None

results = []
for m in man:
    ts, sop = m['ts'], m['sop']; ref = refs[sop]
    base = f"{BASE}/studies/{m['study']}/series/{m['series']}/instances"
    r = {'ts': ts, 'name': m['name'] or m['note'], 'lossy': m['lossy'], 'checks': {}}
    c = r['checks']
    def rec(k, ok, detail=''):
        c[k] = {'ok': bool(ok), 'detail': str(detail)[:300]}
    try:
        q = requests.get(base, headers={**H, 'Accept': 'application/dicom+json'}, timeout=60)
        found = q.status_code == 200 and any(sop in json.dumps(x) for x in q.json())
        rec('qido', found, q.status_code)
        mt = requests.get(f'{base}/{sop}/metadata', headers={**H, 'Accept': 'application/dicom+json'}, timeout=60)
        rec('metadata', mt.status_code == 200 and sop in mt.text, mt.status_code)
        wi = requests.get(f'{base}/{sop}', headers={**H, 'Accept': 'multipart/related; type="application/dicom"; transfer-syntax=*'}, timeout=120)
        ok = False; det = wi.status_code
        if wi.status_code == 200:
            body = parts(wi)[0][1]; ds = pydicom.dcmread(io.BytesIO(body), force=True)
            ok = ds.SOPInstanceUID == sop and str(ds.file_meta.TransferSyntaxUID) == ts
            det = f'{wi.status_code} ts={ds.file_meta.TransferSyntaxUID} bytes={len(body)}'
        rec('instance', ok, det)
        fr = requests.get(f'{base}/{sop}/frames/1', headers={**H, 'Accept': 'multipart/related; type="application/octet-stream"; transfer-syntax=*'}, timeout=120)
        ok = False; det = fr.status_code
        if fr.status_code == 200:
            pct, payload = parts(fr)[0]
            if 'frame1' in ref:
                ok = hashlib.sha256(payload).hexdigest() == ref['frame1']
            elif ts == '1.2.840.10008.1.2.2':   # big endian as stored: swap, then compare
                ok = hashlib.sha256(np.frombuffer(payload, '>i2').astype('<i2').tobytes()).hexdigest() == ref['hash']
            else:  # native / deflated dataset: little-endian frame bytes
                ok = hashlib.sha256(payload).hexdigest() == ref['hash']
            det = f'200 ts={ts_of(pct)} bytes={len(payload)}'
        else:
            det = f'{fr.status_code} {fr.text[:160]}'
        rec('frame_as_stored', ok, det)
        fe = requests.get(f'{base}/{sop}/frames/1', headers={**H, 'Accept': 'multipart/related; type="application/octet-stream"; transfer-syntax=1.2.840.10008.1.2.1'}, timeout=180)
        ok = False; det = fe.status_code
        if fe.status_code == 200:
            pct, payload = parts(fe)[0]; got_ts = ts_of(pct)
            if ts not in TO_ELE:
                ok = got_ts == ts and hashlib.sha256(payload).hexdigest() == ref.get('frame1')
                det = f'returned as stored ({got_ts})'
            else:
                h = hashlib.sha256(payload).hexdigest()
                ok = got_ts == '1.2.840.10008.1.2.1' and h == ref.get('hash')
                det = f'ts={got_ts} bytes={len(payload)} ' + ('pixels match reference' if ok else f'hash {h[:12]} vs ref {str(ref.get("hash"))[:12]}')
                if not ok and got_ts == '1.2.840.10008.1.2.1' and ref.get('arr'):
                    a = np.load(ref['arr']); b = np.frombuffer(payload, dtype=a.dtype)
                    if b.size == a.size:
                        det += f' maxdiff={int(np.abs(a.astype(np.int64).ravel() - b.astype(np.int64)).max())}'
        else:
            det = f'{fe.status_code} {fe.text[:200]}'
        rec('frame_to_ELE', ok, det)
        rd = requests.get(f'{base}/{sop}/frames/1/rendered', headers={**H, 'Accept': 'image/jpeg'}, timeout=120)
        exp = 415 if ts in NOT_RENDERABLE else 200
        rec('rendered', rd.status_code == exp, f'{rd.status_code} (expected {exp})')
    except Exception as e:
        rec('error', False, f'{type(e).__name__}: {e}')
    r['pass'] = all(v['ok'] for v in c.values())
    results.append(r)
    print(('PASS ' if r['pass'] else 'FAIL ') + ts.ljust(24), (r['name'] or '')[:38].ljust(38),
          ' '.join(f"{k}={'ok' if v['ok'] else 'X'}" for k, v in c.items()))
json.dump(results, open(os.path.join(D, 'results.json'), 'w'), indent=1)
print(sum(r['pass'] for r in results), '/', len(results), 'passed')
