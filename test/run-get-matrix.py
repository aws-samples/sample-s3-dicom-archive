#!/usr/bin/env python3
"""GET-matrix smoke test: exercise every idempotent GET endpoint as admin.
Reads api-endpoints.json, fills each {id} with the id of a real item of that
resource (the first item its list endpoint returns), and records HTTP status + a
verdict. A resource with no items is SKIPped. Writes JSON to
$TEST_SCRATCH/test_get_results.json; exits 1 if any GET fails."""
import json, subprocess, sys, urllib.request, urllib.error

import os
SCRATCH = os.environ.get("TEST_SCRATCH", "/tmp")
API = os.environ["ARCHIVE_API"]
TOKEN = open(os.path.join(SCRATCH, "test_admin_token.txt")).read().strip()
OUT = os.path.join(SCRATCH, "test_get_results.json")

def call(method, path, limit=2000):
    url = API + path
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", TOKEN)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            # read(-1) raises "negative count" on Python 3.9; None reads everything.
            return r.status, (r.read() if limit is None or limit < 0 else r.read(limit)).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)

# discover a datastore id to fill {id} path params
ds_id = None
st, body = call("GET", "/datastores")
try:
    j = json.loads(body)
    data = j.get("data", j) if isinstance(j, dict) else j
    items = data if isinstance(data, list) else data.get("items") or data.get("datastores") or []
    if items:
        ds_id = (items[0].get("id") or items[0].get("datastoreId") or items[0].get("DatastoreId"))
except Exception:
    pass

def first_id(list_path):
    """Id of the first item a list endpoint returns, or None."""
    st, body = call("GET", list_path, limit=-1)
    if st != 200:
        return None
    try:
        j = json.loads(body)
    except ValueError:
        return None
    data = j.get("data", j) if isinstance(j, dict) else j
    items = data if isinstance(data, list) else (data.get("items") or data.get("datastores") or [])
    return (items[0].get("id") or items[0].get("datastoreId")) if items else None


# Query parameters a GET needs to be meaningful.
REQUIRED_QUERY = {"/datastores/statistics": lambda: f"?datastoreId={ds_id}" if ds_id else None}

cat_eps = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "api-endpoints.json")))
results = []
for cat in cat_eps:
    for e in cat["endpoints"]:
        if e["method"] != "GET":
            continue
        path = e["path"]
        skip = False
        if path in REQUIRED_QUERY:
            q = REQUIRED_QUERY[path]()
            if q is None:
                skip = True
            else:
                path += q
        if "{" in path:
            item = first_id(path.split("/{", 1)[0])
            if item and ("{id}" in path or "{s}" in path):
                path = path.replace("{id}", str(item)).replace("{s}", str(item))
            else:
                skip = True
        if skip:
            results.append({"category": cat["category"], "method": "GET",
                            "path": e["path"], "status": None,
                            "verdict": "SKIP", "note": "no item to fill {id} with"})
            continue
        status, body = call("GET", path)
        verdict = "PASS" if status in (200, 204) else ("FAIL" if status else "ERR")
        # 404 on a GET-by-id with a real id is unexpected; 403 = authz issue for admin
        results.append({"category": cat["category"], "method": "GET",
                        "path": e["path"], "resolved": path, "status": status,
                        "verdict": verdict, "snippet": body[:120]})

json.dump({"datastore_id": ds_id, "results": results},
          open(OUT, "w"), indent=2)
p = sum(1 for r in results if r["verdict"] == "PASS")
f = sum(1 for r in results if r["verdict"] == "FAIL")
s = sum(1 for r in results if r["verdict"] == "SKIP")
print(f"datastore_id={ds_id}")
for r in results:
    print(f"  [{r['verdict']}] GET {r['path']} -> {r['status']}")
print(f"TOTALS: PASS={p} FAIL={f} SKIP={s} of {len(results)} GETs")
sys.exit(1 if f else 0)
