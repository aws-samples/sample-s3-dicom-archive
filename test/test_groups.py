"""Resolve the six test privilege groups to their ids on the target stack.

setup-test-users.js creates the groups through the API as "Test <profile name>",
so their ids are generated (pg-...). Older stacks were seeded with fixed ids
("test-admin-group", ...). Suites refer to the groups by those fixed names; this
maps each name to the id that actually exists, preferring the fixed id if present.
"""
import json
import os
import urllib.request

_PROFILES = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'test-profiles.json')))


def group_ids(api, token):
    req = urllib.request.Request(api + '/privilege-groups', headers={'Authorization': 'Bearer ' + token})
    body = json.loads(urllib.request.urlopen(req, timeout=60).read())
    data = body.get('data', body)
    groups = data.get('items', data) if isinstance(data, dict) else data
    by_id = {g['id']: g for g in groups}
    by_name = {g.get('name'): g for g in groups}
    out = {}
    for key, prof in _PROFILES.items():
        fixed = f'test-{key.lower()}-group'
        if fixed in by_id:
            out[fixed] = fixed
        elif f"Test {prof['name']}" in by_name:
            out[fixed] = by_name[f"Test {prof['name']}"]['id']
        else:
            raise KeyError(f'no test group for {key}: run test/setup-test-users.js first')
    return out
