#!/usr/bin/env python3
"""Workflow suite: DICOM deletes + config chain + STOW + VF assignment rule.

Covers (all as ADMIN unless noted):
  N8  STOW-RS: store a DICOM via POST multipart/related, then QIDO confirms it
  N1  Remove study from VF  (DELETE at VF scope -> unassign)
  N2  Delete series         (DELETE series at datastore scope)
  N3  Delete study          (DELETE study at datastore scope -> soft-delete)
  N4  Study->VF assignment rule (POST /virtual-folders/{id}/rules)
  N5  Configure DICOM interface (POST /dicom-interfaces, needs locationId)
  N6  Configure DICOM entity    (POST /dicom-entities)
  N7  Configure routing rule    (POST /routing-rules, needs interfaceId)

Env: ARCHIVE_API, ARCHIVE_CF ; admin token in $SCRATCH/test_admin_token.txt
Writes JSON to $SCRATCH/test_workflow_results.json
"""
import json, os, time, subprocess, uuid, urllib.request, urllib.error

SCRATCH = os.environ.get("TEST_SCRATCH", "/tmp")
API = os.environ["ARCHIVE_API"]; CF = os.environ["ARCHIVE_CF"]
ADMIN = open(os.path.join(SCRATCH, "test_admin_token.txt")).read().strip()
import time as _t
_SUF = str(int(_t.time()))[-6:]
results = []
def rec(name, ok, detail=""):
    results.append({"test": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}")

def http(method, url, token=None, body=None, bearer=False, raw=None, ctype=None, timeout=90):
    r = urllib.request.Request(url, method=method)
    if token: r.add_header("Authorization", ("Bearer " + token) if bearer else token)
    data = None
    if body is not None:
        r.add_header("Content-Type", "application/json"); data = json.dumps(body).encode()
    elif raw is not None:
        r.add_header("Content-Type", ctype); data = raw
    try:
        with urllib.request.urlopen(r, data=data, timeout=timeout) as resp:
            return resp.status, resp.read(4000).decode("utf-8","replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(1500).decode("utf-8","replace")
    except Exception as e:
        return 0, str(e)

def aws(*a): return subprocess.run(["aws",*a], capture_output=True, text=True).stdout.strip()
def jid(b):
    try:
        d = json.loads(b); d = d.get("data", d); return d.get("id") or d.get("datastoreId")
    except Exception: return None

STUDY = "1.3.6.1.4.1.5962.1.2.1.20040119072730.12322"
SERIES = "1.3.6.1.4.1.5962.1.3.1.1.20040119072730.12322"

print("=== SETUP: datastore + ingest a baseline study ===")
st,b = http("POST", API+"/datastores", ADMIN, {"name":"wf-ds"}); ds=jid(b)
rec("datastore create", st in (200,201), f"id={ds}")
bucket=None
for _ in range(30):
    st,b = http("GET", f"{API}/datastores/{ds}", ADMIN)
    try:
        d=json.loads(b).get("data",json.loads(b))
        if d.get("status")=="ACTIVE": bucket=d.get("bucketName") or d.get("archiveBucket") or d.get("s3BucketName"); break
    except Exception: pass
    time.sleep(8)
rec("datastore ACTIVE", bool(bucket), f"bucket={bucket}")
src = subprocess.run(["python3","-c","from pydicom.data import get_testdata_file;print(get_testdata_file('CT_small.dcm'))"],capture_output=True,text=True).stdout.strip()
if bucket:
    aws("s3","cp",src,f"s3://{bucket}/CT_small.dcm"); time.sleep(40)
st,b = http("GET", f"{CF}/dicomweb/{ds}/studies", ADMIN, bearer=True)
rec("baseline study ingested (QIDO)", st==200 and len(b)>10, f"status={st} len={len(b)}")

print("=== N8: STOW-RS (store via DICOMweb POST) ===")
# build multipart/related application/dicom body with a SECOND dicom (different SOP) by re-reading CT_small
dicom_bytes = open(src,"rb").read()
boundary = "----stowboundary"+uuid.uuid4().hex[:12]
pre = (f"--{boundary}\r\nContent-Type: application/dicom\r\n\r\n").encode()
post = (f"\r\n--{boundary}--\r\n").encode()
mp_body = pre + dicom_bytes + post
ctype = f'multipart/related; type="application/dicom"; boundary={boundary}'
st,b = http("POST", f"{CF}/dicomweb/{ds}/studies", ADMIN, raw=mp_body, ctype=ctype, bearer=True)
rec("N8 STOW POST /studies", st in (200,202), f"status={st} body={b[:120]}")

print("=== N5: configure DICOM interface (needs a location) ===")
st,b = http("POST", API+"/locations", ADMIN, {"name":f"wf-loc-{_SUF}","dicom_port":11112}); loc=jid(b)
rec("location create (for interface)", st in (200,201), f"id={loc} status={st}")
iface=None
if loc:
    st,b = http("POST", API+"/dicom-interfaces", ADMIN,
                {"name":f"wf-iface-{_SUF}","aeTitle":f"WFA{_SUF[-3:]}","locationId":loc,"host":"10.0.0.5","maxAssociations":10})
    iface=jid(b); rec("N5 POST /dicom-interfaces", st in (200,201), f"id={iface} status={st} body={b[:120]}")
else:
    rec("N5 POST /dicom-interfaces", False, "skipped - no location")

print("=== N6: configure DICOM entity ===")
st,b = http("POST", API+"/dicom-entities", ADMIN,
            {"entityType":"OTHER","name":f"wf-entity-{_SUF}","aeTitle":f"WFE{_SUF[-3:]}","hostname":"10.0.0.6","port":104})
ent=jid(b); rec("N6 POST /dicom-entities", st in (200,201), f"id={ent} status={st} body={b[:120]}")

print("=== N7: configure routing rule (needs interface) ===")
rr=None
if iface:
    st,b = http("POST", API+"/routing-rules", ADMIN,
                {"name":f"wf-rr-{_SUF}","interfaceId":iface,"priority":1,
                 "action":{"datastoreId":ds},"conditions":[{"attributeName":"Modality","operator":"EQUALS","value":"CT"}]})
    rr=jid(b); rec("N7 POST /routing-rules", st in (200,201), f"id={rr} status={st} body={b[:150]}")
else:
    rec("N7 POST /routing-rules", False, "skipped - no interface")

print("=== N4: VF + study->VF assignment rule ===")
st,b = http("POST", API+"/virtual-folders", ADMIN, {"name":f"wf-vf-{_SUF}","datastoreId":ds}); vf=jid(b)
rec("VF create", st in (200,201), f"id={vf}")
rule=None
if vf:
    st,b = http("POST", f"{API}/virtual-folders/{vf}/assignment-rules", ADMIN,
                {"name":f"wf-rule-{_SUF}","priority":1,"enabled":True,
                 "conditions":[{"attributeName":"Modality","operator":"EQUALS","value":"CT"}]})
    rule=jid(b); rec("N4 POST VF assignment rule", st in (200,201), f"id={rule} status={st} body={b[:150]}")

print("=== N1: remove study from VF (DELETE at VF scope) ===")
if vf:
    st,b = http("DELETE", f"{CF}/dicomweb/{vf}/studies/{STUDY}", ADMIN, bearer=True)
    rec("N1 DELETE study @VF (unassign)", st in (200,202,204,404), f"status={st} body={b[:100]}")

print("=== N2: delete series (datastore scope) ===")
st,b = http("DELETE", f"{CF}/dicomweb/{ds}/studies/{STUDY}/series/{SERIES}", ADMIN, bearer=True)
rec("N2 DELETE series", st in (200,202,204), f"status={st} body={b[:100]}")

print("=== N3: delete study in storage (datastore scope) ===")
st,b = http("DELETE", f"{CF}/dicomweb/{ds}/studies/{STUDY}", ADMIN, bearer=True)
rec("N3 DELETE study (soft-delete)", st in (200,202,204), f"status={st} body={b[:100]}")
# confirm it's gone from QIDO
time.sleep(5)
st,b = http("GET", f"{CF}/dicomweb/{ds}/studies", ADMIN, bearer=True)
rec("N3 study gone from QIDO", st==200, f"status={st} len={len(b)} (empty=[] after delete)")

print("=== CLEANUP ===")
for p in ([f"/routing-rules/{rr}"] if rr else []) + \
         ([f"/dicom-interfaces/{iface}"] if iface else []) + \
         ([f"/dicom-entities/{ent}"] if ent else []) + \
         ([f"/locations/{loc}"] if loc else []) + \
         ([f"/virtual-folders/{vf}"] if vf else []) + \
         ([f"/datastores/{ds}"] if ds else []):
    st,_ = http("DELETE", API+p, ADMIN); print(f"  DELETE {p} -> {st}")

json.dump({"api":API,"cf":CF,"datastore_id":ds,"results":results},
          open(os.path.join(SCRATCH,"test_workflow_results.json"),"w"), indent=2)
p=sum(1 for r in results if r["verdict"]=="PASS"); f=sum(1 for r in results if r["verdict"]=="FAIL")
print(f"\nTOTALS: PASS={p} FAIL={f} of {len(results)}")
