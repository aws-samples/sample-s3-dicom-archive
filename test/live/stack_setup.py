#!/usr/bin/env python3
"""Prepare a freshly deployed test stack for the live suites, and write their env.

Usage: stack_setup.py <stack-prefix> <workdir> [--seed-from s3://bucket[/prefix]]

Idempotent. Every step looks up what already exists before creating anything:
  1. resolves API, CloudFront, Cognito pool/client, DIMSE NLB + its SG, plug-in I/O
     bucket and the Lambda names the suites invoke;
  2. sets the deployment `admin` password (written to <workdir>/admin_pw, mode 600);
  3. creates the `demo-studies` storage and, with --seed-from, copies test data into it;
  4. creates the DIMSE interface (AE <PREFIX>ARCHIVE on the in-cloud location) with a
     routing rule into demo-studies;
  5. creates an untagged probe bucket for the D-7 import check;
  6. writes 3 instances of one MR series to <workdir>/vf-series for the VF suite;
  7. creates the six test users (setup-test-users.js) and their tokens;
  8. writes <workdir>/stack.env.

Stays within the target stack: only resources whose names start with the prefix,
plus the probe bucket it creates itself.
"""
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))  # test/ helpers
from cognito_mfa import sign_in  # noqa: E402  (completes the TOTP MFA challenge)
import json, os, secrets, string, subprocess, sys, time, urllib.request, urllib.error

import boto3

PREFIX = sys.argv[1].lower()
WD = os.path.abspath(sys.argv[2])
SEED = sys.argv[sys.argv.index('--seed-from') + 1] if '--seed-from' in sys.argv else None
HERE = os.path.dirname(os.path.abspath(__file__))
TEST = os.path.dirname(HERE)
REPO = os.path.dirname(TEST)
os.makedirs(WD, exist_ok=True)
REGION = os.environ.get('AWS_REGION', 'us-east-1')
cfn, cog = boto3.client('cloudformation', REGION), boto3.client('cognito-idp', REGION)
s3, lam, elb = boto3.client('s3', REGION), boto3.client('lambda', REGION), boto3.client('elbv2', REGION)
ACCOUNT = boto3.client('sts').get_caller_identity()['Account']


def log(msg):
    print(f'[setup {PREFIX}] {msg}', flush=True)


# 1. resolve -------------------------------------------------------------------
# In-VPC runners (networkMode=vpc, no NAT) cannot reach the CloudFormation or ELB
# APIs (no interface endpoints for them). SETUP_RESOLVED=<json> supplies the
# step-1 values resolved from outside the VPC; everything else runs in-VPC.
_RESOLVED = os.environ.get('SETUP_RESOLVED')
if _RESOLVED:
    _r = json.load(open(_RESOLVED))
    API, CF, POOL, CLIENT = _r['API'], _r['CF'], _r['POOL'], _r['CLIENT']
    NLB_DNS, NLB_SG, PLUGIN_BUCKET = _r['NLB_DNS'], _r['NLB_SG'], _r['PLUGIN_BUCKET']
    SCHED_FN, RUNNER_FN = _r['SCHED_FN'], _r['RUNNER_FN']
    buckets = [b['Name'] for b in s3.list_buckets()['Buckets']]
    log(f'using pre-resolved values from {_RESOLVED}')
else:
    outs = {o['OutputKey']: o['OutputValue'] for o in cfn.describe_stacks(StackName=PREFIX)['Stacks'][0]['Outputs']}
    API = outs['ApiUrl'].rstrip('/')
    # VPC mode has no CloudFront; the UI/DICOMweb front door is the internal ALB,
    # exported as FrontDoorUrl. Public mode exports CloudFrontDistributionUrl.
    CF = (outs.get('CloudFrontDistributionUrl') or outs.get('FrontDoorUrl')).rstrip('/')
    POOL = next(p['Id'] for p in cog.list_user_pools(MaxResults=60)['UserPools'] if p['Name'] == f'{PREFIX}-user-pool')
    clients = cog.list_user_pool_clients(UserPoolId=POOL, MaxResults=60)['UserPoolClients']
    CLIENT = None
    for c in clients:
        d = cog.describe_user_pool_client(UserPoolId=POOL, ClientId=c['ClientId'])['UserPoolClient']
        if 'ALLOW_USER_PASSWORD_AUTH' in d.get('ExplicitAuthFlows', []) and not d.get('ClientSecret'):
            CLIENT = c['ClientId']
            break
    assert CLIENT, 'no public client with USER_PASSWORD_AUTH'
    nlb = next(lb for lb in elb.describe_load_balancers()['LoadBalancers']
               if lb['Type'] == 'network' and lb['LoadBalancerName'].lower().startswith(PREFIX[:6] + '-'))
    NLB_DNS, NLB_SG = nlb['DNSName'], nlb['SecurityGroups'][0]
    all_buckets = s3.list_buckets()['Buckets']
    buckets = [b['Name'] for b in all_buckets]
    # The plug-in I/O bucket is retained when a stack is deleted, so a re-created stack with the
    # same prefix leaves an older match behind. The newest one belongs to the live stack.
    PLUGIN_BUCKET = max((b for b in all_buckets if b['Name'].startswith(f'{PREFIX}-processingjobs')
                         and 'pluginiobucket' in b['Name']), key=lambda b: b['CreationDate'])['Name']
    fns = []
    for page in lam.get_paginator('list_functions').paginate():
        fns += [f['FunctionName'] for f in page['Functions'] if f['FunctionName'].startswith(PREFIX)]
    SCHED_FN = next(f for f in fns if 'ProcessingJobScheduler' in f)
    RUNNER_FN = f'{PREFIX}-plugin-runner'
    assert RUNNER_FN in fns, RUNNER_FN
    log(f'API={API} CF={CF} pool={POOL} client={CLIENT} nlb={NLB_DNS} sg={NLB_SG}')


# 2. admin password --------------------------------------------------------------
pw_file = os.path.join(WD, 'admin_pw')
if os.path.exists(pw_file):
    PW = open(pw_file).read().strip()
else:
    alphabet = string.ascii_letters + string.digits
    PW = ''.join(secrets.choice(alphabet) for _ in range(18)) + 'a7!Z'
    cog.admin_set_user_password(UserPoolId=POOL, Username='admin', Password=PW, Permanent=True)
    with open(os.open(pw_file, os.O_WRONLY | os.O_CREAT, 0o600), 'w') as f:
        f.write(PW)
    log('admin password set')


def token(user='admin', pw=None):
    return sign_in(cog, CLIENT, user, pw or PW)['AccessToken']


TOK = token()
with open(os.open(os.path.join(WD, 'admin_token'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
    f.write(TOK)


def api(method, path, body=None):
    r = urllib.request.Request(API + path, method=method, headers={'Authorization': 'Bearer ' + TOK})
    data = None
    if body is not None:
        r.add_header('Content-Type', 'application/json'); data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, data=data, timeout=90) as resp:
            t = resp.read(); return resp.status, (json.loads(t) if t else {})
    except urllib.error.HTTPError as e:
        return e.code, {'raw': e.read()[:400].decode('utf-8', 'replace')}


def items(b):
    d = b.get('data', b) if isinstance(b, dict) else b
    return d if isinstance(d, list) else d.get('items', d.get('datastores', []))


# 3. demo-studies storage ---------------------------------------------------------
def find_ds(name):
    return next((x for x in items(api('GET', '/datastores')[1]) if x.get('name') == name), None)


ds = find_ds('demo-studies')
if not ds:
    st, b = api('POST', '/datastores', {'name': 'demo-studies'})
    assert st in (200, 201), (st, b)
    log('demo-studies created')
for _ in range(60):
    ds = find_ds('demo-studies')
    if ds and (ds.get('status') or ds.get('datastoreStatus')) == 'ACTIVE':
        break
    time.sleep(10)
DS_ID = ds['id']
DS_BUCKET = ds.get('s3BucketName') or ds.get('bucketName')
assert DS_BUCKET, ds
log(f'demo-studies {DS_ID} bucket {DS_BUCKET}')
if SEED and not s3.list_objects_v2(Bucket=DS_BUCKET, MaxKeys=1).get('KeyCount'):
    log(f'seeding from {SEED}')
    subprocess.run(['aws', 's3', 'cp', SEED, f's3://{DS_BUCKET}/', '--recursive', '--only-show-errors'], check=True)
elif not SEED and not s3.list_objects_v2(Bucket=DS_BUCKET, Prefix='seed/', MaxKeys=1).get('KeyCount'):
    # No seed data given: write one generated MR series (4 instances, pydicom's MR_small
    # test file) so suites that need an existing MR series (pluginfiles) have one.
    import io
    import pydicom
    from pydicom.data import get_testdata_file
    from pydicom.uid import generate_uid
    study, series = generate_uid(), generate_uid()
    for i in range(4):
        d = pydicom.dcmread(get_testdata_file('MR_small.dcm'))
        d.StudyInstanceUID, d.SeriesInstanceUID = study, series
        d.SOPInstanceUID = d.file_meta.MediaStorageSOPInstanceUID = generate_uid()
        d.InstanceNumber, d.SeriesDescription = i + 1, 'E2E seed MR'
        buf = io.BytesIO(); d.save_as(buf)
        s3.put_object(Bucket=DS_BUCKET, Key=f'seed/mr{i + 1}.dcm', Body=buf.getvalue())
    log('seeded demo-studies with a generated 4-instance MR series')

# 4. DIMSE interface + routing rule -------------------------------------------------
AE = f'{PREFIX.upper()}ARCHIVE'[:16]  # DICOM AE titles are at most 16 chars; the API truncates
locs = items(api('GET', '/locations')[1])
loc = next(x for x in locs if x.get('name') == f'{PREFIX}-dicom-ecs')
ifaces = items(api('GET', '/dicom-interfaces')[1])
iface = next((x for x in ifaces if x.get('aeTitle') == AE), None)
if not iface:
    st, b = api('POST', '/dicom-interfaces', {'name': 'inf1', 'aeTitle': AE, 'locationId': loc['id'],
                                              'accessibleDatastores': [DS_ID]})
    assert st in (200, 201), (st, b)
    iface = next(x for x in items(api('GET', '/dicom-interfaces')[1]) if x.get('aeTitle') == AE)
    log(f'interface {AE} created')
rules = items(api('GET', f"/routing-rules?interfaceId={iface['id']}")[1])
if not rules:
    st, b = api('POST', '/routing-rules', {'interfaceId': iface['id'], 'name': 'to-demo-studies',
                                           'action': {'datastoreId': DS_ID}, 'conditions': {}})
    assert st in (200, 201), (st, b)
    log('routing rule created')

# 5. untagged probe bucket -----------------------------------------------------------
PROBE = f'dicom-archive-e2e-untagged-{ACCOUNT}'
if PROBE not in buckets:
    # Outside us-east-1, S3 requires an explicit location constraint.
    s3.create_bucket(Bucket=PROBE, **({} if REGION == 'us-east-1' else
                                      {'CreateBucketConfiguration': {'LocationConstraint': REGION}}))
    s3.put_public_access_block(Bucket=PROBE, PublicAccessBlockConfiguration={
        'BlockPublicAcls': True, 'IgnorePublicAcls': True, 'BlockPublicPolicy': True, 'RestrictPublicBuckets': True})
    log(f'probe bucket {PROBE} created')

# 6. one MR series, 3 instances -------------------------------------------------------
import pydicom
from pydicom.data import get_testdata_file
from pydicom.uid import generate_uid
vf_dir = os.path.join(WD, 'vf-series')
if not os.path.isdir(vf_dir) or len(os.listdir(vf_dir)) < 3:
    os.makedirs(vf_dir, exist_ok=True)
    study, series = generate_uid(), generate_uid()
    for i in range(3):
        d = pydicom.dcmread(get_testdata_file('MR_small.dcm'))
        d.StudyInstanceUID, d.SeriesInstanceUID = study, series
        d.SOPInstanceUID = d.file_meta.MediaStorageSOPInstanceUID = generate_uid()
        d.InstanceNumber = i + 1
        d.save_as(os.path.join(vf_dir, f'mr{i + 1}.dcm'))

# 7. test users + tokens ---------------------------------------------------------------
env = dict(os.environ, API_BASE_URL=API, USER_POOL_ID=POOL, CLIENT_ID=CLIENT, AWS_REGION=REGION,
           ADMIN_USERNAME='admin', ADMIN_PASSWORD=PW)
subprocess.run(['node', 'test/setup-test-users.js'], cwd=REPO, env=env, check=True)
subprocess.run(['node', 'test/authenticate-test-users.js'], cwd=REPO, env=env, check=True)

# 8. env file ----------------------------------------------------------------------------
E = {
    'STACK_PREFIX': PREFIX, 'API': API, 'CF': CF, 'POOL': POOL, 'CLIENT': CLIENT, 'ADMIN_PW_FILE': pw_file,
    'NLB_DNS': NLB_DNS, 'NLB_SG': NLB_SG, 'AE': AE, 'DS_ID': DS_ID, 'DS_BUCKET': DS_BUCKET,
    'PLUGIN_BUCKET': PLUGIN_BUCKET, 'SCHED_FN': SCHED_FN, 'RUNNER_FN': RUNNER_FN, 'PROBE_BUCKET': PROBE,
    'VF_DIR': vf_dir, 'WD': WD,
}
with open(os.path.join(WD, 'stack.env'), 'w') as f:
    for k, v in E.items():
        f.write(f"{k}='{v}'\n")
log(f'wrote {WD}/stack.env')
