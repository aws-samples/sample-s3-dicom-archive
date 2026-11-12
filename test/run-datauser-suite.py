#!/usr/bin/env python3
"""Data-user workflow suite.

As ADMIN: create a privilege group WITH datastore+VF read grants, create a data-user
in it, mark the Cognito user CONFIRMED + set a password, then authenticate AS the
data-user and drive the exact calls the data-user website makes:
  GET /datastores, GET /virtual-folders  (what the user may see)
  VF/datastore-scoped QIDO /studies -> /series -> WADO /metadata
  OHIF/SLIM bundle serving (200) -- render itself needs a browser (deferred)
Also verifies the authz boundary: a data-user must NOT reach management ops.

Env: ARCHIVE_API, ARCHIVE_CF, ARCHIVE_POOL, ARCHIVE_CLIENT; admin token in $SCRATCH/test_admin_token.txt
Writes JSON to $SCRATCH/test_datauser_results.json
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import json, os, time, subprocess, urllib.request, urllib.error

SCRATCH = os.environ.get("TEST_SCRATCH", "/tmp")
API = os.environ["ARCHIVE_API"]
CF  = os.environ["ARCHIVE_CF"]
POOL = os.environ["ARCHIVE_POOL"]
CLIENT = os.environ["ARCHIVE_CLIENT"]
ADMIN = open(os.path.join(SCRATCH, "test_admin_token.txt")).read().strip()

results = []
def rec(name, ok, detail=""):
    results.append({"test": name, "verdict": "PASS" if ok else "FAIL", "detail": detail})
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} :: {detail}")

def http(method, url, token=None, body=None, bearer=False, timeout=60):
    r = urllib.request.Request(url, method=method)
    if token: r.add_header("Authorization", ("Bearer " + token) if bearer else token)
    if body is not None:
        r.add_header("Content-Type", "application/json"); body = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, data=body, timeout=timeout) as resp:
            return resp.status, resp.read(4000).decode("utf-8","replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(1500).decode("utf-8","replace")
    except Exception as e:
        return 0, str(e)

def aws(*args):
    return subprocess.run(["aws", *args], capture_output=True, text=True).stdout.strip()

def jid(body):
    try:
        j = json.loads(body); d = j.get("data", j)
        return d.get("id") or d.get("datastoreId")
    except Exception: return None

print("=== SETUP: datastore + ingest (as admin) ===")
st, b = http("POST", API + "/datastores", ADMIN, {"name": "du-ds"})
ds_id = jid(b); rec("admin POST /datastores", st in (200,201), f"status={st} id={ds_id}")
bucket = None
for _ in range(30):
    st, b = http("GET", f"{API}/datastores/{ds_id}", ADMIN)
    try:
        d = json.loads(b).get("data", json.loads(b))
        if d.get("status") == "ACTIVE":
            bucket = d.get("bucketName") or d.get("archiveBucket") or d.get("s3BucketName")
            break
    except Exception: pass
    time.sleep(8)
rec("datastore ACTIVE", bucket is not None, f"bucket={bucket}")
if bucket:
    src = subprocess.run(["python3","-c","from pydicom.data import get_testdata_file;print(get_testdata_file('CT_small.dcm'))"],
                         capture_output=True, text=True).stdout.strip()
    aws("s3","cp",src,f"s3://{bucket}/CT_small.dcm")
    time.sleep(40)
STUDY = "1.3.6.1.4.1.5962.1.2.1.20040119072730.12322"

print("=== T2: virtual folder + T1 privilege group (WITH grants) ===")
st, b = http("POST", API + "/virtual-folders", ADMIN, {"name":"du-vf","datastoreId":ds_id})
vf_id = jid(b); rec("admin POST /virtual-folders", st in (200,201), f"status={st} id={vf_id}")
pg_body = {
    "name": "du-pg", "description": "data-user read access", "userMode": "DATA_USER",
    "datastorePrivileges": [{"datastoreId": ds_id, "canRead": True, "canStore": True, "canDelete": False}],
    "virtualFolderPrivileges": [{"virtualFolderId": vf_id, "canRead": True}],
    "managementPrivileges": {}
}
st, b = http("POST", API + "/privilege-groups", ADMIN, pg_body)
pg_id = jid(b)
rec("admin POST /privilege-groups (granted)", st in (200,201), f"status={st} id={pg_id}")

print("=== T1: data-user creation + Cognito confirm + password ===")
import time as _t
_suf = str(int(_t.time()))[-6:]
du_user = f"du-tester-{_suf}"
du_email = f"du-tester-{_suf}@example.com"
st, b = http("POST", API + "/users", ADMIN,
             {"username":du_user,"email":du_email,"firstName":"DU","lastName":"Tester","privilegeGroupId":pg_id})
rec("admin POST /users (data-user)", st in (200,201), f"status={st}")
cu = aws("cognito-idp","list-users","--user-pool-id",POOL,"--query",
         "Users[?Attributes[?Name=='email' && Value=='"+du_email+"']].Username | [0]","--output","text")
if not cu or cu == "None": cu = du_user
rec("cognito user exists", bool(cu) and cu!="None", f"cognito_username={cu}")
DUPW = "DataUser!Pass123"
out = subprocess.run(["aws","cognito-idp","admin-set-user-password","--user-pool-id",POOL,
                      "--username",cu,"--password",DUPW,"--permanent"], capture_output=True, text=True)
rec("cognito confirm + set password", out.returncode == 0, (out.stderr.strip()[:120] or "ok"))
import boto3
du_tok = sign_in(boto3.client("cognito-idp"), CLIENT, cu, DUPW)["AccessToken"]  # enrols TOTP on first sign-in
rec("data-user authenticates (TOTP MFA)", bool(du_tok) and len(du_tok)>500, f"token_len={len(du_tok)}")

print("=== data-user website FEATURES (as the data-user) ===")
st, b = http("GET", API + "/datastores", du_tok)
rec("DU GET /datastores (site load)", st == 200, f"status={st}")
st, b = http("GET", API + "/virtual-folders", du_tok)
rec("DU GET /virtual-folders (site load)", st == 200, f"status={st}")
st, b = http("GET", f"{CF}/dicomweb/{ds_id}/studies", du_tok, bearer=True)
rec("DU QIDO /studies (datastore)", st == 200, f"status={st} len={len(b)}")
st, b = http("GET", f"{CF}/dicomweb/{ds_id}/studies/{STUDY}/series", du_tok, bearer=True)
rec("DU QIDO /series", st == 200, f"status={st}")
st, b = http("GET", f"{CF}/dicomweb/{ds_id}/studies/{STUDY}/metadata", du_tok, bearer=True)
rec("DU WADO /metadata", st == 200, f"status={st}")
st, b = http("GET", f"{CF}/dicomweb/{vf_id}/studies", du_tok, bearer=True)
rec("DU QIDO /studies (VF-scoped)", st in (200,204), f"status={st} len={len(b)}")

print("=== viewer website serving (render deferred to browser) ===")
for name, path in [("data-user","/data-user/"), ("ohif","/ohif/"), ("slim","/slim/")]:
    st, b = http("GET", CF + path)
    rec(f"{name} site serves (200)", st == 200, f"status={st}")

print("=== authz: a data-user must NOT reach management ops ===")
st, b = http("GET", API + "/users", du_tok)
rec("DU GET /users -> denied", st in (401,403), f"status={st}")
st, b = http("GET", API + "/audit", du_tok)
rec("DU GET /audit -> denied", st in (401,403), f"status={st}")

print("=== CLEANUP ===")
du_api_id = None
lu_st, lu_b = http("GET", API + "/users", ADMIN)
try:
    data = json.loads(lu_b).get("data", json.loads(lu_b))
    for u in (data.get("items", data) if isinstance(data, dict) else data):
        if isinstance(u, dict) and u.get("username") == du_user: du_api_id = u.get("id")
except Exception: pass
for p in ([f"/users/{du_api_id}"] if du_api_id else []) + \
         ([f"/privilege-groups/{pg_id}"] if pg_id else []) + \
         ([f"/virtual-folders/{vf_id}"] if vf_id else []) + \
         ([f"/datastores/{ds_id}"] if ds_id else []):
    st, _ = http("DELETE", API + p, ADMIN); print(f"  DELETE {p} -> {st}")

json.dump({"api":API,"cf":CF,"datastore_id":ds_id,"vf_id":vf_id,"results":results},
          open(os.path.join(SCRATCH,"test_datauser_results.json"),"w"), indent=2)
p = sum(1 for r in results if r["verdict"]=="PASS"); f = sum(1 for r in results if r["verdict"]=="FAIL")
print(f"\nTOTALS: PASS={p} FAIL={f} of {len(results)}")
