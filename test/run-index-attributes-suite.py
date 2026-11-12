#!/usr/bin/env python3
"""E2E: searchable (custom index) attributes, run against a deployed stack.

What it proves, all through the product API (no direct DB access):
  1. /index-attributes/defs validation (bad tag -> 400) and create at every level
     (PATIENT/STUDY/SERIES/INSTANCE, STRING/INT/DECIMAL/DATE), duplicate -> 409.
  2. The defs list shows each custom attribute once (not also as a "built-in").
  3. A study stored BEFORE the attributes existed is back-filled WITHOUT any storage
     Sync: adding a STORAGE attribute starts a back-fill job that fills the column
     from the DICOM headers already stored in the DB. The job's status (on GET
     /defs) reaches DONE, and the values are checked at every level. The explicit
     Back-fill action (POST /defs {action:'backfill', id}) re-runs a DONE job.
     Optionally probes two concurrent adds of one new attribute (only one may win).
  4. Newly ingested objects (a new study, and a new instance in an EXISTING series)
     are populated without a sync.
  5. Values are read back through analytics SQL (the product's search over custom
     columns). QIDO is probed: it must never silently widen on a custom-attribute
     filter (400 or exact match); whether QIDO honors it is reported as INFO.
  6. Deleting the defs removes them from the list, and an object ingested after the
     delete is no longer populated (the physical column is intentionally kept).
Cleans up at start AND end: deletes every def this suite owns (columnName qa_test_*,
duplicates included, re-listing until none is left) and its studies (delete-study API).

Env: IA_E2E_API, IA_E2E_CF, IA_E2E_CLIENT_ID, IA_E2E_ADMIN_PW, IA_E2E_DS (datastore id),
     IA_E2E_BUCKET (that datastore's bucket), IA_E2E_TEMPLATE (a .dcm to clone),
     optional IA_E2E_PROFILE / IA_E2E_REGION (AWS CLI profile/region for the S3 PUTs),
     IA_E2E_INDEXED=0 (create the SERIES attribute without a DB index),
     IA_E2E_BACKFILL_WAIT_S (max wait for a back-fill to finish, default 1800),
     IA_E2E_RACE=1 (probe two concurrent adds; a FAIL only with IA_E2E_EXPECT_UNIQUE_SCOPE=1,
     i.e. a DB built from scratch with the uq_def_scope key, else reported as INFO),
     IA_E2E_RESULTS (json results path).
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import copy, io, json, os, sys, threading, time, uuid, urllib.error, urllib.parse, urllib.request
import boto3, pydicom
from pydicom.uid import generate_uid

API = os.environ['IA_E2E_API'].rstrip('/')
CF = os.environ['IA_E2E_CF'].rstrip('/')
CLIENT = os.environ['IA_E2E_CLIENT_ID']
PW = os.environ['IA_E2E_ADMIN_PW']
DS = os.environ['IA_E2E_DS']
BUCKET = os.environ['IA_E2E_BUCKET']
TEMPLATE = os.environ['IA_E2E_TEMPLATE']
OUT = os.environ.get('IA_E2E_RESULTS', 'index-attributes-results.json')
SESSION = boto3.Session(profile_name=os.environ.get('IA_E2E_PROFILE') or None,
                        region_name=os.environ.get('IA_E2E_REGION') or None)
RUN = uuid.uuid4().hex[:6]
# IA_E2E_INDEXED=0 skips the CREATE INDEX on series (one fewer DDL on a shared table).
INDEXED = os.environ.get('IA_E2E_INDEXED', '1') != '0'
BACKFILL_WAIT_S = int(os.environ.get('IA_E2E_BACKFILL_WAIT_S', '1800'))
PREFIX = f'qa_test_ia_{RUN}'
results = []


def rec(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}", flush=True)


def info(name, detail):
    print(f"  [INFO] {name} :: {detail}", flush=True)


_tok = {'t': None, 'at': 0}


def tok():
    if not _tok['t'] or time.time() - _tok['at'] > 2400:
        _tok['t'] = sign_in(SESSION.client('cognito-idp'), CLIENT, 'admin', PW)['AccessToken']
        _tok['at'] = time.time()
    return _tok['t']


def http(method, url, body=None, headers=None, timeout=120):
    r = urllib.request.Request(url, method=method, headers={'Authorization': 'Bearer ' + tok(), **(headers or {})})
    data = None
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
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {'raw': repr(e)[:300]}


def api(method, path, body=None):
    return http(method, API + path, body)


def sql(q):
    """Run read-only SQL through analytics on this storage; returns rows or None."""
    st, b = api('POST', f'/analytics-projects/{DS}/query',
                {'type': 'sql', 'source': {'kind': 'storage', 'ids': [DS]}, 'sql': q})
    data = (b or {}).get('data') or {}
    if st != 200 or data.get('status') != 'SUCCEEDED':
        print(f"    analytics {st}: {json.dumps(b)[:300]}", flush=True)
        return None
    return data.get('rows') or []


# ── test attributes: one per level, all four data types ─────────────────────
# (columnName suffix, tag, level, type, physical column, value written, expected read-back)
ATTRS = [
    ('ethnic', '00102160', 'PATIENT', 'STRING', 'ethnicgroup'),
    ('inst', '00080080', 'STUDY', 'STRING', 'institutionname'),
    ('mfr', '00080070', 'SERIES', 'STRING', 'manufacturer'),
    ('thick', '00180050', 'INSTANCE', 'DECIMAL', 'slicethickness'),
    ('acqno', '00200012', 'INSTANCE', 'INT', 'acquisitionnumber'),
    ('cdate', '00080023', 'INSTANCE', 'DATE', 'contentdate'),
]
COL = {a[0]: a[4] for a in ATTRS}


def make_instance(study_uid, series_uid, patient_id, vals, inst_no):
    ds = pydicom.dcmread(TEMPLATE)
    ds.PatientID = patient_id
    ds.PatientName = f'QA^IA{RUN}'
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SOPInstanceUID = generate_uid()
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.StudyDescription = f'qa_test index attributes {RUN}'
    ds.InstanceNumber = inst_no
    ds.EthnicGroup = vals['ethnic']
    ds.InstitutionName = vals['inst']
    ds.Manufacturer = vals['mfr']
    ds.SliceThickness = vals['thick']
    ds.AcquisitionNumber = vals['acqno']
    ds.ContentDate = vals['cdate']
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return ds.SOPInstanceUID, buf.getvalue()


def put(key, data):
    SESSION.client('s3').put_object(Bucket=BUCKET, Key=key, Body=data, ContentType='application/dicom')


def row_for_sop(sop):
    rows = sql(
        "SELECT i.datastore_id, i.sopinstanceuid, i.slicethickness, i.acquisitionnumber, i.contentdate, "
        "s.manufacturer, st.institutionname, p.ethnicgroup "
        "FROM instance i JOIN series s ON i.series_pkey = s.series_pkey "
        "JOIN study st ON s.study_pkey = st.study_pkey JOIN patient p ON st.patient_pkey = p.patient_pkey "
        f"WHERE i.datastore_id = '{DS}' AND i.sopinstanceuid = '{sop}' AND i.deleted_at IS NULL")
    return rows[0] if rows else None


def indexed(sop):
    """Base-columns-only lookup (works before the custom columns exist)."""
    rows = sql(f"SELECT i.datastore_id, i.sopinstanceuid FROM instance i JOIN series s ON i.series_pkey = s.series_pkey "
               f"WHERE i.datastore_id = '{DS}' AND i.sopinstanceuid = '{sop}' AND i.deleted_at IS NULL")
    return rows[0] if rows else None


def wait_row(sop, pred, secs=420, lookup=None):
    last = None
    deadline = time.time() + secs
    while time.time() < deadline:
        last = (lookup or row_for_sop)(sop)
        if last and pred(last):
            return last, True
        time.sleep(15)
    return last, False


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def matches(row, vals):
    """Every level's column carries the expected value."""
    if not row:
        return False
    return (row.get('ethnicgroup') == vals['ethnic'] and row.get('institutionname') == vals['inst']
            and row.get('manufacturer') == vals['mfr'] and num(row.get('slicethickness')) == float(vals['thick'])
            and str(row.get('acquisitionnumber')) == str(vals['acqno'])
            and str(row.get('contentdate') or '')[:10] == f"{vals['cdate'][0:4]}-{vals['cdate'][4:6]}-{vals['cdate'][6:8]}")


def all_null(row):
    return bool(row) and all(row.get(c) is None for c in COL.values())


def list_defs():
    st, b = api('GET', '/index-attributes/defs?targetType=STORAGE')
    return st, (b.get('data') or []), (b.get('builtins') or [])


def wait_backfills(ids, secs=None):
    """Poll GET /defs until every def's back-fill is DONE or FAILED (or the wait
    runs out). Returns {def_id: backfill-dict-or-None}."""
    deadline = time.time() + (secs or BACKFILL_WAIT_S)
    last = {}
    while time.time() < deadline:
        st, defs, _ = list_defs()
        if st == 200:
            last = {d['id']: d.get('backfill') for d in defs if d.get('id') in ids}
            states = [(b or {}).get('status') for b in last.values()]
            if len(last) == len(ids) and all(x in ('DONE', 'FAILED') for x in states):
                return last
            print(f"    back-fill: {[(i[-6:], (b or {}).get('status'), (b or {}).get('percent')) for i, b in last.items()]}", flush=True)
        time.sleep(20)
    return last


created_defs = []
studies = []


def leftover_studies():
    """Studies left by an aborted earlier run of this suite (patient id QAIA-*)."""
    rows = sql(f"SELECT st.datastore_id, st.studyinstanceuid FROM study st JOIN patient p ON st.patient_pkey = p.patient_pkey "
               f"WHERE st.datastore_id = '{DS}' AND p.patientid LIKE 'QAIA-%' AND st.deleted_at IS NULL")
    return [r['studyinstanceuid'] for r in rows or []]


def owned(dfn):
    """A def created by this suite (any run): column name qa_test_*."""
    return str(dfn.get('columnName', '')).lower().startswith('qa_test_')


def delete_owned_defs():
    """Delete every qa_test_* def, duplicates included; re-list until none is
    left (or 3 passes). Returns how many are still there."""
    left = []
    for _ in range(3):
        st, defs, _ = list_defs()
        if st != 200:
            print(f'    defs list -> {st}', flush=True)
            continue
        left = [d for d in defs if owned(d)]
        if not left:
            return 0
        for dfn in left:
            st, _ = api('DELETE', f"/index-attributes/defs/{dfn['id']}")
            print(f"    delete def {dfn['columnName']} ({dfn['id']}) -> {st}", flush=True)
    return len(left)


def cleanup():
    print('--- cleanup', flush=True)
    left = delete_owned_defs()
    if left:
        print(f'    WARNING: {left} qa_test_ def(s) could not be deleted', flush=True)
    for s in studies:
        st, _ = api('POST', f'/storage/{DS}/studies/{s}/delete-study', {})
        print(f"    delete-study {s} -> {st}", flush=True)


def main():
    print(f'=== index-attributes suite run={RUN} datastore={DS}', flush=True)
    # Leftovers from an aborted earlier run would 409 the creates below.
    left = delete_owned_defs()
    rec('no qa_test_ attribute defs left over before the run', left == 0, f'left={left}')
    if left:
        return
    for s_uid in leftover_studies():
        st, _ = api('POST', f'/storage/{DS}/studies/{s_uid}/delete-study', {})
        print(f'    removed leftover study {s_uid} -> {st}', flush=True)

    # ── 1. a study that exists BEFORE the attributes are defined ────────────
    pre_vals = {'ethnic': f'PRE{RUN}', 'inst': f'QA_INST_PRE_{RUN}', 'mfr': f'QA_MFR_PRE_{RUN}',
                'thick': '1.25', 'acqno': 7, 'cdate': '20240102'}
    s1, ser_a, pat1 = generate_uid(), generate_uid(), f'QAIA-{RUN}-1'
    studies.append(s1)
    pre_sops = []
    for n in (1, 2):
        sop, data = make_instance(s1, ser_a, pat1, pre_vals, n)
        put(f'{PREFIX}/pre/a{n}.dcm', data)
        pre_sops.append(sop)
    row, ok = wait_row(pre_sops[1], lambda r: True, lookup=indexed)
    rec('pre-existing study indexed', ok, f'sop={pre_sops[1]}')
    if not ok:
        return

    # ── 2. defs API: validation + create at every level ─────────────────────
    st, b = api('POST', '/index-attributes/defs', {'targetType': 'STORAGE', 'dicomTag': 'ZZZZ0070',
                                                   'dicomLevel': 'SERIES', 'columnName': f'qa_test_{RUN}_bad'})
    rec('bad DICOM tag rejected', st == 400, f'status={st}')
    st, b = api('POST', '/index-attributes/defs', {'targetType': 'STORAGE', 'dicomTag': '00080070',
                                                   'dicomLevel': 'SERIES', 'columnName': 'Bad Name'})
    rec('bad column name rejected', st == 400, f'status={st}')
    all_created = True
    bf_on_create = {}
    for suffix, tag, level, dtype, phys in ATTRS:
        st, b = api('POST', '/index-attributes/defs', {
            'targetType': 'STORAGE', 'dicomTag': tag, 'dicomLevel': level, 'dataType': dtype,
            'columnName': f'qa_test_{RUN}_{suffix}', 'isIndexed': suffix == 'mfr' and INDEXED,
            'description': 'qa_test index-attributes suite'})
        dd = (b or {}).get('data') or {}
        ok = st == 201 and dd.get('physicalColumn') == phys
        all_created &= ok
        if dd.get('id'):
            created_defs.append(dd['id'])
            bf_on_create[dd['id']] = (dd.get('backfill') or {}).get('status')
        rec(f'create {level} {dtype} attribute {tag}', ok,
            f"status={st} physical={dd.get('physicalColumn')} indexed={dd.get('isIndexed')} warn={b.get('warning')}")
        if st in (502, 503, 504):
            # 504 = the ALTER outlived the API (stuck on the table's metadata lock
            # and still queued in the DB); 503 = the API gave up safely. Either
            # way stop adding DDL, and report whether the table is still usable.
            t0 = time.time()
            hs, _ = http('GET', f'{CF}/dicomweb/{DS}/studies?limit=1', headers={'Accept': 'application/dicom+json'}, timeout=25)
            rec('archive still answers QIDO after a failed attribute add', hs == 200,
                f'status={hs} in {time.time() - t0:.1f}s (a hang means a queued ALTER is blocking the table)')
            break
    if not all_created:
        return
    st, b = api('POST', '/index-attributes/defs', {'targetType': 'STORAGE', 'dicomTag': '00080070',
                                                   'dicomLevel': 'SERIES', 'columnName': f'qa_test_{RUN}_dup'})
    rec('duplicate tag at same level -> 409', st == 409, f'status={st}')
    dup_id = ((b or {}).get('data') or {}).get('id')
    if dup_id:  # an undeployed guard let it through: own it so it is deleted below
        created_defs.append(dup_id)

    st, defs, builtins = list_defs()
    mine = [x for x in defs if str(x.get('columnName', '')).startswith(f'qa_test_{RUN}_')]
    rec('defs list shows all created attributes', st == 200 and len(mine) == len(ATTRS), f'n={len(mine)}')
    dup = [(x.get('dicomLevel'), x.get('columnName')) for x in builtins
           if (x.get('dicomLevel'), x.get('columnName')) in {(a[2], a[4]) for a in ATTRS}]
    rec('custom attributes not also listed as built-in', not dup, f'duplicated={dup}')

    # ── 3. pre-existing study: back-filled from stored headers, NO sync ─────
    rec('each create started a back-fill', all(v in ('PENDING', 'RUNNING', 'DONE') for v in bf_on_create.values())
        and len(bf_on_create) == len(ATTRS), json.dumps(bf_on_create))
    bfs = wait_backfills(created_defs)
    rec('back-fill status reaches DONE for every attribute (no Sync run)',
        len(bfs) == len(created_defs) and all((b or {}).get('status') == 'DONE' for b in bfs.values()),
        json.dumps({k[-6:]: (v or {}).get('status') for k, v in bfs.items()}))
    failed = {k: (v or {}).get('error') for k, v in bfs.items() if (v or {}).get('status') == 'FAILED'}
    if failed:
        print(f'    back-fill errors: {json.dumps(failed)}', flush=True)
    row = row_for_sop(pre_sops[1])
    exp = {'ethnicgroup': pre_vals['ethnic'], 'institutionname': pre_vals['inst'], 'manufacturer': pre_vals['mfr']}
    for suffix, _tag, level, _dtype, phys in ATTRS:
        got = (row or {}).get(phys)
        if phys in exp:
            ok = got == exp[phys]
        elif phys == 'slicethickness':
            ok = num(got) == float(pre_vals['thick'])
        elif phys == 'acquisitionnumber':
            ok = str(got) == str(pre_vals['acqno'])
        else:
            ok = str(got or '')[:10] == '2024-01-02'
        rec(f'back-fill wrote the {level} attribute {phys} on the pre-existing study', ok, f'got={got!r}')
    for sop in pre_sops:
        row = row_for_sop(sop)
        rec(f'all levels back-filled for pre-existing instance {sop[-8:]}', matches(row, pre_vals), json.dumps(row))

    # ── 4. explicit Back-fill action on an existing attribute ───────────────
    st, b = api('POST', '/index-attributes/defs', {'action': 'backfill', 'id': f'qa-missing-{RUN}'})
    rec('back-fill of an unknown attribute -> 404', st == 404, f'status={st}')
    series_def = created_defs[[a[2] for a in ATTRS].index('SERIES')]
    st, b = api('POST', '/index-attributes/defs', {'action': 'backfill', 'id': series_def})
    bf = ((b or {}).get('data') or {}).get('backfill') or {}
    rec('Back-fill action on a DONE attribute is accepted (re-run)', st == 202 and bf.get('status') in ('PENDING', 'RUNNING'),
        f"status={st} backfill={json.dumps(bf)}")
    bfs = wait_backfills([series_def])
    rec('re-run back-fill reaches DONE', (bfs.get(series_def) or {}).get('status') == 'DONE', json.dumps(bfs.get(series_def)))
    row = row_for_sop(pre_sops[0])
    rec('re-run keeps the SERIES value', (row or {}).get('manufacturer') == pre_vals['mfr'], json.dumps(row))

    if os.environ.get('IA_E2E_RACE') == '1':
        # Two concurrent adds of one NEW attribute: only one may be created.
        body = {'targetType': 'STORAGE', 'dicomTag': '00081090', 'dicomLevel': 'SERIES', 'dataType': 'STRING',
                'columnName': f'qa_test_{RUN}_race', 'description': 'qa_test index-attributes suite (race)'}
        got = []
        ths = [threading.Thread(target=lambda: got.append(api('POST', '/index-attributes/defs', body))) for _ in range(2)]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        codes = sorted(c for c, _ in got)
        for c, bb in got:
            rid = ((bb or {}).get('data') or {}).get('id')
            if rid:
                created_defs.append(rid)
        ok = codes == [201, 409]
        if os.environ.get('IA_E2E_EXPECT_UNIQUE_SCOPE') == '1':
            rec('two concurrent adds of the same attribute: one 201, one 409', ok, f'codes={codes}')
        else:
            info('two concurrent adds of the same attribute', f'codes={codes} (DB-level guarantee only on a from-scratch DB)')

    # ── 5. new ingest: new study + new instance in an EXISTING series ───────
    new_vals = {'ethnic': f'NEW{RUN}', 'inst': f'QA_INST_NEW_{RUN}', 'mfr': f'QA_MFR_NEW_{RUN}',
                'thick': '2.5', 'acqno': 9, 'cdate': '20250304'}
    s2, ser_b, pat2 = generate_uid(), generate_uid(), f'QAIA-{RUN}-2'
    studies.append(s2)
    sop_new, data = make_instance(s2, ser_b, pat2, new_vals, 1)
    put(f'{PREFIX}/post/b1.dcm', data)
    row, ok = wait_row(sop_new, lambda r: matches(r, new_vals))
    rec('new study ingested after defs: all levels populated', ok, json.dumps(row))

    a3_vals = dict(pre_vals, thick='3.75', acqno=11, cdate='20240105')
    sop_a3, data = make_instance(s1, ser_a, pat1, a3_vals, 3)
    put(f'{PREFIX}/post/a3.dcm', data)
    row, ok = wait_row(sop_a3, lambda r: matches(r, a3_vals))
    rec('new instance in existing series: instance + parent levels populated', ok, json.dumps(row))

    # ── 6. search: analytics SQL filter on custom columns; QIDO probe ───────
    rows = sql(f"SELECT s.datastore_id, s.seriesinstanceuid FROM series s WHERE s.datastore_id = '{DS}' "
               f"AND s.manufacturer = 'QA_MFR_PRE_{RUN}' AND s.deleted_at IS NULL")
    rec('analytics filter on SERIES custom attribute finds the back-filled series',
        rows is not None and [r['seriesinstanceuid'] for r in rows] == [ser_a], json.dumps(rows))
    rows = sql(f"SELECT i.datastore_id, i.sopinstanceuid FROM instance i WHERE i.datastore_id = '{DS}' "
               f"AND i.slicethickness > 1 AND i.contentdate = '2024-01-02' AND i.sopinstanceuid IN "
               f"('{pre_sops[0]}','{pre_sops[1]}','{sop_a3}','{sop_new}') AND i.deleted_at IS NULL")
    rec('analytics filter on INSTANCE DECIMAL+DATE attributes', rows is not None and
        sorted(r['sopinstanceuid'] for r in rows) == sorted(pre_sops), json.dumps(rows))
    rows = sql(f"SELECT st.datastore_id, st.studyinstanceuid FROM study st JOIN patient p ON st.patient_pkey = p.patient_pkey "
               f"WHERE st.datastore_id = '{DS}' AND p.ethnicgroup = 'NEW{RUN}' AND st.institutionname = 'QA_INST_NEW_{RUN}'")
    rec('analytics filter on PATIENT + STUDY attributes', rows is not None and
        [r['studyinstanceuid'] for r in rows] == [s2], json.dumps(rows))

    st, b = http('GET', f'{CF}/dicomweb/{DS}/studies/{s1}/series?Manufacturer=QA_MFR_NEW_{RUN}',
                 headers={'Accept': 'application/dicom+json'})
    got = b if isinstance(b, list) else []
    rec('QIDO never silently widens on a custom-attribute filter', st in (400, 204) or (st == 200 and not got),
        f'status={st} n={len(got)}')
    st2, b2 = http('GET', f'{CF}/dicomweb/{DS}/studies/{s1}/series?Manufacturer=QA_MFR_PRE_{RUN}',
                   headers={'Accept': 'application/dicom+json'})
    info('QIDO filter on custom attribute (Manufacturer)',
         f'status={st2} n={len(b2) if isinstance(b2, list) else 0} (400 = not QIDO-searchable; analytics only)')

    # ── 7. delete the defs: gone from the list, no longer populated ─────────
    ok_all = True
    for dfn_id in created_defs:
        st, _ = api('DELETE', f'/index-attributes/defs/{dfn_id}')
        ok_all &= st == 200
    rec('delete all test attributes', ok_all, f'n={len(created_defs)}')
    st, b = api('DELETE', f'/index-attributes/defs/{created_defs[0]}')
    rec('delete again -> 404', st == 404, f'status={st}')
    _, defs, _ = list_defs()
    left = [x for x in defs if str(x.get('columnName', '')).startswith(f'qa_test_{RUN}_')]
    rec('deleted attributes gone from the defs list', not left, f'left={len(left)}')
    time.sleep(75)  # outlive the ingest's 60 s def cache
    s3u, ser_c, pat3 = generate_uid(), generate_uid(), f'QAIA-{RUN}-3'
    studies.append(s3u)
    sop_c, data = make_instance(s3u, ser_c, pat3, new_vals, 1)
    put(f'{PREFIX}/post/c1.dcm', data)
    row, ok = wait_row(sop_c, lambda r: True)
    rec('object ingested after delete is not populated', ok and all_null(row), json.dumps(row))
    row = row_for_sop(pre_sops[0])
    info('values already written stay in the kept column after delete', json.dumps(row))


try:
    main()
except Exception as e:  # report, then clean up
    import traceback; traceback.print_exc()
    rec('suite ran to completion', False, repr(e))
finally:
    try:
        cleanup()
    except Exception as e:
        print(f'    cleanup failed: {e!r}', flush=True)
    passed = sum(1 for r in results if r[1])
    print(f'{passed}/{len(results)} checks passed', flush=True)
    with open(OUT, 'w') as f:
        json.dump([{'name': n, 'ok': o, 'detail': d} for n, o, d in results], f, indent=1)
    sys.exit(0 if results and passed == len(results) else 1)
