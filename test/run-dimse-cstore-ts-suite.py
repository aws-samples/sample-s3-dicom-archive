"""E2E: inbound C-STORE in every transfer syntax, run against a deployed stack.

For each instance the transfer-syntax conformance generator wrote
($TSC_WORKDIR/tsconf/, see ts-conformance/README.md), this suite:
  1 re-stamps it with fresh study/series/SOP UIDs (one new study for the run),
  2 sends it by C-STORE from an SCU that proposes ONLY that transfer syntax,
  3 reads it back by WADO-RS as stored and checks the transfer syntax and the
    pixel data bytes are unchanged (the service stores what it receives).

Every syntax the generator writes is expected to be ACCEPTED and to round-trip
byte-exact, JPEG XL (.110, .112) and Deflated Image Frame Compression (.8.1)
included: the DIMSE service registers those with its pydicom 3.0.x
(interface-container/DICOM/DIMSEtoS3/extra_transfer_syntaxes.py). JPEG XL JPEG
Recompression (.111) is not generated, so it is covered by the unit tests only.
Re-saving the .110/.112/.8.1 inputs here works because importing pynetdicom
3.0.4 adds those UIDs to pydicom's UID dictionary.

Needs pydicom 3.0.x + pynetdicom 3.0.x (the DIMSE image versions; pydicom 2.4
cannot write HTJ2K). Env: CTS_E2E_API, CTS_E2E_CLIENT_ID, CTS_E2E_HOST (NLB DNS), CTS_E2E_PORT (11112),
     CTS_E2E_INTERFACE, CTS_E2E_DICOMWEB (https://<cf>/dicomweb/<datastoreId>),
     TSC_WORKDIR. Results: CTS_E2E_RESULTS.
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import email.parser, io, json, os, sys, time, uuid, urllib.request, urllib.error

import boto3
import pydicom
import requests
from pydicom.uid import generate_uid
from pynetdicom import AE

API = os.environ['CTS_E2E_API']
CLIENT = os.environ['CTS_E2E_CLIENT_ID']
HOST = os.environ['CTS_E2E_HOST']
PORT = int(os.environ.get('CTS_E2E_PORT', '11112'))
IFACE = os.environ.get('CTS_E2E_INTERFACE', 'inf1')
DW = os.environ['CTS_E2E_DICOMWEB'].rstrip('/')
OUT = os.environ.get('CTS_E2E_RESULTS', 'dimse-cstore-ts-results.json')
SRC = os.path.join(os.environ['TSC_WORKDIR'], 'tsconf')
WORK = os.path.join(os.environ['TSC_WORKDIR'], 'cstore-ts')
TAG = uuid.uuid4().hex[:4].upper()
results = []


def rec(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


TOK = sign_in(boto3.client('cognito-idp'), CLIENT, 'test-admin', 'TestAdmin123!')['AccessToken']
H = {'Authorization': 'Bearer ' + TOK}


def api(method, path, body=None):
    r = urllib.request.Request(API + path, method=method, headers=H)
    data = None
    if body is not None:
        r.add_header('Content-Type', 'application/json'); data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, data=data, timeout=60) as resp:
            t = resp.read(); return resp.status, (json.loads(t) if t else {})
    except urllib.error.HTTPError as e:
        return e.code, {'raw': e.read()[:300].decode('utf-8', 'replace')}


def d(b):
    return b.get('data', b) if isinstance(b, dict) else b


def wado_instance(study, series, sop):
    url = f'{DW}/studies/{study}/series/{series}/instances/{sop}'
    r = requests.get(url, headers={**H, 'Accept': 'multipart/related; type="application/dicom"; transfer-syntax=*'},
                     timeout=120)
    if r.status_code != 200:
        return r.status_code, None
    ct = r.headers.get('Content-Type', '')
    msg = email.parser.BytesParser().parsebytes(b'Content-Type: ' + ct.encode() + b'\r\n\r\n' + r.content)
    body = [p.get_payload(decode=True) for p in msg.walk() if not p.is_multipart()][0]
    return 200, pydicom.dcmread(io.BytesIO(body), force=True)


def c_store_only(calling, path, ts):
    """Send `path` proposing only `ts`. Returns 'rejected', 'no-association' or a status int."""
    ae = AE(ae_title=calling)
    ds = pydicom.dcmread(path, stop_before_pixels=True, force=True)
    ae.add_requested_context(str(ds.SOPClassUID), ts)
    assoc = ae.associate(HOST, PORT, ae_title=IFACE)
    if not assoc.is_established:
        # pynetdicom aborts on its own side when the acceptor rejected every
        # context; the A-ASSOCIATE-AC still carries the rejection results.
        if any(cx.abstract_syntax == ds.SOPClassUID and cx.result != 0x00
               for cx in getattr(assoc, '_rejected_cx', [])):
            return 'rejected'
        return 'no-association'
    try:
        if not assoc.accepted_contexts:
            return 'rejected'
        st = assoc.send_c_store(path)   # sends the encoded file as-is
        return getattr(st, 'Status', None)
    finally:
        assoc.release()


man = json.load(open(os.path.join(SRC, 'manifest.json')))
os.makedirs(WORK, exist_ok=True)
study = generate_uid()
entity = None
try:
    lst = d(api('GET', '/dicom-interfaces')[1])
    lst = lst if isinstance(lst, list) else lst.get('items', [])
    iface = next(i for i in lst if i.get('aeTitle') == IFACE)
    calling = f'CTS{TAG}'
    st, b = api('POST', '/dicom-entities', {
        'entityType': 'CLIENT', 'name': calling, 'aeTitle': calling, 'hostname': '127.0.0.1', 'port': 104,
        'dicomPrivileges': [{'interfaceId': iface['id'], 'store': True, 'query': False, 'retrieve': False}]})
    entity = d(b).get('id')
    rec(f'setup: entity {calling} created', st in (200, 201) and entity, f'status={st}')

    # Re-stamp every instance into one new study.
    sent = []
    for m in man:
        ts = m['ts']
        src = os.path.join(SRC, f'{ts}.dcm')
        ds = pydicom.dcmread(src)
        ds.StudyInstanceUID = study
        ds.SeriesInstanceUID = generate_uid()
        ds.SOPInstanceUID = generate_uid()
        ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
        ds.PatientID = f'CSTORETS{TAG}'
        ds.PatientName = 'CSTORE^TS'
        ds.StudyDescription = 'C-STORE transfer syntaxes'
        p = os.path.join(WORK, f'{ts}.dcm')
        ds.save_as(p, enforce_file_format=True)
        sent.append((ts, m.get('name') or m.get('note') or ts, p, ds.SeriesInstanceUID, ds.SOPInstanceUID,
                     ds.get('PixelData')))

    # The container picks up the new entity on its config refresh. Probe with a
    # separate Explicit VR LE copy so the per-syntax instances are sent once.
    ele = '1.2.840.10008.1.2.1'
    probe = pydicom.dcmread(os.path.join(SRC, f'{ele}.dcm'))
    probe.StudyInstanceUID, probe.SeriesInstanceUID = study, generate_uid()
    probe.SOPInstanceUID = probe.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    probe.PatientID, probe.PatientName = f'CSTORETS{TAG}', 'CSTORE^TS'
    probe_path = os.path.join(WORK, 'probe.dcm')
    probe.save_as(probe_path, enforce_file_format=True)
    ready = False
    for _ in range(30):
        if c_store_only(calling, probe_path, ele) == 0x0000:
            ready = True
            break
        time.sleep(10)
    rec('setup: DIMSE service knows the new entity', ready)

    stored = []
    for ts, name, p, series, sop, _px in sent:
        st = c_store_only(calling, p, ts)
        shown = hex(st) if isinstance(st, int) else st
        rec(f'{ts} {name}: C-STORE accepted, peer offered only this syntax', st == 0x0000, shown)
        if st == 0x0000:
            stored.append((ts, name, series, sop, _px))

    # Read back as stored once ingest has indexed them.
    time.sleep(60)
    for ts, name, series, sop, px in stored:
        code, got = None, None
        for _ in range(12):
            code, got = wado_instance(study, series, sop)
            if code == 200:
                break
            time.sleep(10)
        if got is None:
            rec(f'{ts} {name}: stored as received', False, f'WADO status={code}')
            continue
        same_ts = str(got.file_meta.TransferSyntaxUID) == ts
        same_px = got.get('PixelData') == px
        rec(f'{ts} {name}: stored as received', same_ts and same_px,
            f'ts={got.file_meta.TransferSyntaxUID} pixel_bytes_equal={same_px}')
finally:
    if entity:
        api('DELETE', f'/dicom-entities/{entity}')
        print('  cleanup: deleted 1 entity')

passed = sum(1 for _, ok, _ in results if ok)
print(f'\nDIMSE C-STORE transfer-syntax suite: {passed}/{len(results)} passed (study {study})')
json.dump([{'name': n, 'ok': ok, 'detail': dt} for n, ok, dt in results], open(OUT, 'w'), indent=1)
sys.exit(0 if passed == len(results) else 1)
