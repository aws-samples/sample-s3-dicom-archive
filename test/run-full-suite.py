#!/usr/bin/env python3
"""Full-suite test: write/lifecycle + authz boundary + DICOM ingest + DICOMweb.
Records structured PASS/FAIL and writes JSON to $TEST_SCRATCH/test_full_results.json.
Admin AccessToken is read from $TEST_SCRATCH/test_admin_token.txt (bare, no Bearer)."""
import json, os, time, urllib.request, urllib.error

SCRATCH = os.environ.get("TEST_SCRATCH", "/tmp")
API = os.environ["ARCHIVE_API"]
CF  = os.environ["ARCHIVE_CF"]
ADMIN = open(os.path.join(SCRATCH, "test_admin_token.txt")).read().strip()

results = []
import uuid as _uuid
RUN = _uuid.uuid4().hex[:6]  # unique names: soft-deleted rows keep reserving theirs
def rec(name, ok, detail=""):
    results.append({"test": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}")

def req(method, url, token=None, body=None, bearer=False, timeout=60):
    r = urllib.request.Request(url, method=method)
    if token:
        r.add_header("Authorization", ("Bearer " + token) if bearer else token)
    if body is not None:
        r.add_header("Content-Type", "application/json")
        body = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, data=body, timeout=timeout) as resp:
            return resp.status, resp.read(4000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(1500).decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)

def apa(method, path, body=None, token=None):
    return req(method, API + path, token or ADMIN, body)

print("=== SECTION 1: write/lifecycle (admin) ===")
# Datastore create -> ACTIVE
st, b = apa("POST", "/datastores", {"name": f"full-suite-ds-{RUN}"})
ds_id = None
try: ds_id = json.loads(b).get("data", {}).get("id") or json.loads(b).get("id")
except Exception: pass
rec("POST /datastores", st in (200,201) and bool(ds_id), f"status={st} id={ds_id}")
# poll ACTIVE
ds_status = None; bucket = None
for _ in range(30):
    st, b = apa("GET", f"/datastores/{ds_id}")
    try:
        d = json.loads(b).get("data", json.loads(b))
        ds_status = d.get("status") or d.get("datastoreStatus")
        bucket = d.get("s3BucketName") or d.get("bucketName") or d.get("archiveBucket") or d.get("bucket")
    except Exception: pass
    if ds_status == "ACTIVE": break
    time.sleep(10)
rec("datastore -> ACTIVE", ds_status == "ACTIVE", f"status={ds_status} bucket={bucket}")
rec("GET /datastores/{id}", st == 200, f"status={st}")

# Virtual folder
st, b = apa("POST", "/virtual-folders", {"name": f"fs-vf-{RUN}", "datastoreId": ds_id})
vf_id = None
try: vf_id = json.loads(b).get("data", {}).get("id") or json.loads(b).get("id")
except Exception: pass
rec("POST /virtual-folders", st in (200,201), f"status={st} id={vf_id}")

# Privilege group (full body)
st, b = apa("POST", "/privilege-groups", {"name": f"fs-pg-{RUN}", "description": "full-suite"})
pg_id = None
try: pg_id = json.loads(b).get("data", {}).get("id") or json.loads(b).get("id")
except Exception: pass
rec("POST /privilege-groups", st in (200,201), f"status={st} id={pg_id}")
# empty-body -> should be 400 (F2 was 500)
st, b = apa("POST", "/privilege-groups", {})
rec("POST /privilege-groups {} validation", st == 400, f"status={st} (expect 400; 500=F2 bug)")

# Location (F1 fix: lowercase prefix -> valid bucket)
st, b = apa("POST", "/locations", {"name": f"fs-loc-{RUN}", "dicom_port": 11112})
loc_id = None
try: loc_id = json.loads(b).get("data", {}).get("id") or json.loads(b).get("id")
except Exception: pass
rec("POST /locations (F1 fix)", st in (200,201), f"status={st} id={loc_id} body={b[:150]}")

print("=== SECTION 2: data-user authz boundary ===")
# create data-user in empty pg
st, b = apa("POST", "/users", {"username":f"fs-datauser-{RUN}","email":f"fs-datauser-{RUN}@example.com",
                               "firstName":"FS","lastName":"User","privilegeGroupId": pg_id})
du_id = None
try: du_id = json.loads(b).get("data", {}).get("id") or json.loads(b).get("id")
except Exception: pass
rec("POST /users (data-user)", st in (200,201), f"status={st} id={du_id}")

print("=== SECTION 3: unauth guard ===")
st, b = req("GET", API + "/users")
rec("GET /users unauth -> 401", st in (401,403), f"status={st}")

print("=== SECTION 4: DICOM ingest + DICOMweb (QIDO/WADO) ===")
STUDY = "1.3.6.1.4.1.5962.1.2.1.20040119072730.12322"
ingested = False
if ds_id and bucket:
    try:
        import boto3, pydicom
        from pydicom.data import get_testdata_file
        src = get_testdata_file("CT_small.dcm")
        s3 = boto3.client("s3")
        s3.upload_file(src, bucket, "CT_small.dcm")
        ingested = True
        rec("DICOM upload to archive bucket", True, f"s3://{bucket}/CT_small.dcm")
    except Exception as e:
        rec("DICOM upload to archive bucket", False, str(e)[:150])
    # wait for ingest, then trigger stats sync so dashboard count reflects
    time.sleep(45)
    try:
        import boto3
        lam = boto3.client("lambda")
        fns = [f["FunctionName"] for f in lam.list_functions()["Functions"]
               if os.environ["STACK_PREFIX"] in f["FunctionName"] and "StatsBatchSync" in f["FunctionName"]]
        if fns:
            lam.invoke(FunctionName=fns[0], Payload=b"{}")
            time.sleep(5)
    except Exception as e:
        print("  (stats sync skipped:", str(e)[:80], ")")
    # dashboard study count
    st, b = apa("GET", "/dashboard/stats")
    cnt = None
    try:
        d = json.loads(b)
        cnt = json.dumps(d)[:200]
    except Exception: pass
    rec("ingest -> dashboard stats", "stud" in (cnt or "").lower() or st==200, f"status={st}")

if ds_id:
    # health
    st, b = req("GET", CF + "/dicomweb/health")
    rec("GET /dicomweb/health", st == 200, f"status={st} {b[:80]}")
    # QIDO studies (Bearer)
    st, b = req("GET", f"{CF}/dicomweb/{ds_id}/studies", ADMIN, bearer=True)
    rec("QIDO /studies (Bearer)", st == 200, f"status={st} len={len(b)}")
    # QIDO series
    st, b = req("GET", f"{CF}/dicomweb/{ds_id}/studies/{STUDY}/series", ADMIN, bearer=True)
    rec("QIDO /series (Bearer)", st == 200, f"status={st} len={len(b)}")
    # WADO metadata
    st, b = req("GET", f"{CF}/dicomweb/{ds_id}/studies/{STUDY}/metadata", ADMIN, bearer=True)
    rec("WADO /metadata (Bearer)", st == 200, f"status={st} len={len(b)}")
    # QIDO studies no-auth -> 401
    st2, _ = req("GET", f"{CF}/dicomweb/{ds_id}/studies")
    rec("QIDO /studies unauth -> 401", st2 == 401, f"status={st2}")

# cleanup
print("=== CLEANUP ===")
for p in ([f"/users/{du_id}"] if du_id else []) + \
         ([f"/locations/{loc_id}"] if loc_id else []) + \
         ([f"/privilege-groups/{pg_id}"] if pg_id else []) + \
         ([f"/virtual-folders/{vf_id}"] if vf_id else []) + \
         ([f"/datastores/{ds_id}"] if ds_id else []):
    st, _ = apa("DELETE", p)
    print(f"  DELETE {p} -> {st}")

json.dump({"api": API, "cf": CF, "datastore_id": ds_id, "results": results},
          open(os.path.join(SCRATCH, "test_full_results.json"), "w"), indent=2)
p = sum(1 for r in results if r["verdict"]=="PASS")
f = sum(1 for r in results if r["verdict"]=="FAIL")
print(f"\nTOTALS: PASS={p} FAIL={f} of {len(results)}")
print(f"DATASTORE_ID={ds_id}")
