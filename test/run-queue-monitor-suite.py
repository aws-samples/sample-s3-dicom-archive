#!/usr/bin/env python3
"""Live check of the Queues Monitor API (GET /api/system-monitor).

Compares the API's queue list with SQS itself, then creates short-lived test
queues to prove that new queues, dead-letter links and failed messages show up,
and that a queue of another deployment with the same name prefix does not.
Also checks that the response carries no queue URLs/ARNs, and (read-only) that
no event source mapping to this deployment's HeartbeatUpdater is left pointing
at a deleted DICOM service heartbeat queue (the clean-up removes them).

Env:
  QM_API         API base, e.g. https://xxxx.execute-api.us-east-2.amazonaws.com/v1/api
  QM_TOKEN_FILE  file holding an admin access token
  QM_PREFIX      stack prefix (queue names start with "<prefix>-")
  QM_RESULTS     optional JSON results path

Creates only queues named <prefix>-qmtest-<random>-*, and deletes them at the end.
"""
import json, os, secrets, sys, time, urllib.error, urllib.request

import boto3

API = os.environ['QM_API'].rstrip('/')
TOKEN = open(os.environ['QM_TOKEN_FILE']).read().strip()
PREFIX = os.environ['QM_PREFIX']
RESULTS = os.environ.get('QM_RESULTS')
sqs = boto3.client('sqs')
lam = boto3.client('lambda')

results = []


def check(cid, ok, detail=''):
    results.append({'id': cid, 'ok': bool(ok), 'detail': detail})
    print(f"[{'PASS' if ok else 'FAIL'}] {cid} {detail}", flush=True)


def get(token=TOKEN):
    req = urllib.request.Request(f'{API}/system-monitor', headers={'Authorization': f'Bearer {token}'} if token else {})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None


def arn_from_url(u):
    # https://sqs.<region>.amazonaws.com/<account>/<name>
    host, account, name = u.split('/')[2], u.split('/')[3], u.split('/')[4]
    return f'arn:aws:sqs:{host.split(".")[1]}:{account}:{name}'


def sqs_deployment_queues():
    names, kwargs = {}, {'QueueNamePrefix': f'{PREFIX}-', 'MaxResults': 1000}
    while True:
        res = sqs.list_queues(**kwargs)
        for u in res.get('QueueUrls', []):
            try:
                tags = sqs.list_queue_tags(QueueUrl=u).get('Tags', {})
            except sqs.exceptions.QueueDoesNotExist:
                continue
            if tags.get('Deployment') == PREFIX:
                names[u.rsplit('/', 1)[1]] = u
        if not res.get('NextToken'):
            return names
        kwargs['NextToken'] = res['NextToken']


# ---------------------------------------------------------------- read checks
status, body = get()
check('Q1 GET returns 200', status == 200, f'status={status}')
if status != 200:
    sys.exit(1)
data = body['data']
check('Q1 every source was readable', data.get('unavailable') == [], f"unavailable={data.get('unavailable')}")
api = {q['name']: q for q in data['queues']}

expected = sqs_deployment_queues()
missing = sorted(set(expected) - set(api))
extra = sorted(set(api) - set(expected))
check('Q2 lists exactly the deployment\'s queues', not missing and not extra,
      f'{len(api)} listed; missing={missing} extra={extra}')

bad_links = []
for q in api.values():
    if q['deadLetterQueue']:
        dlq = api.get(q['deadLetterQueue'])
        if not dlq or dlq['category'] != 'dlq' or q['name'] not in dlq['sourceQueues']:
            bad_links.append(q['name'])
check('Q3 dead-letter links are consistent', not bad_links, f'bad={bad_links}')

dimse = [q for q in api.values() if q['category'] == 'dimse']
by_client = {}
for q in dimse:
    by_client.setdefault(q['dimse']['clientId'], set()).add(q['dimse']['role'])
check('Q4 DICOM service queues are listed as inbound/outbound/heartbeat sets', dimse and all(
    roles == {'inbound', 'outbound', 'heartbeat'} for roles in by_client.values()),
    f'{len(dimse)} queues, clients={ {k: sorted(v) for k, v in by_client.items()} }')
check('Q4 DICOM service queues show their location and server status', dimse and all(
    q['dimse']['locationName'] and not q['dimse'].get('detailsHidden') and q['dimse']['serverStatus'] == 'ACTIVE' for q in dimse),
    '; '.join(sorted({f"{q['dimse']['locationName']}={q['dimse']['serverStatus']}" for q in dimse})))

esm_state = {}
for page in lam.get_paginator('list_event_source_mappings').paginate():
    for m in page['EventSourceMappings']:
        esm_state.setdefault(m['EventSourceArn'], set()).add(m['State'])
arn_of = {n: arn_from_url(u) for n, u in expected.items()}
wrong = [q['name'] for q in api.values() if arn_of.get(q['name']) in esm_state and
         {c['state'] for c in q['consumers']} != esm_state[arn_of[q['name']]]]
check('Q5 consumers match the event source mappings', not wrong, f'wrong={wrong}')

leaky = sorted(q['name'] for q in data['queues'] if 'url' in q or 'arn' in q)
account = next(iter(expected.values())).split('/')[3] if expected else None
check('Q9 no queue URL or ARN in the response', not leaky and (not account or account not in json.dumps(body)),
      f'with url/arn={leaky[:5]}')

# ---------------------------------------------------------------- live signal
tag = secrets.token_hex(3)
names = {
    'dlq': f'{PREFIX}-qmtest-{tag}-dlq',
    'src': f'{PREFIX}-qmtest-{tag}-queue',
    'foreign': f'{PREFIX}-qmtest-{tag}-foreign',
}
created = []
try:
    dlq_url = sqs.create_queue(QueueName=names['dlq'], tags={'Deployment': PREFIX})['QueueUrl']
    created.append(dlq_url)
    dlq_arn = sqs.get_queue_attributes(QueueUrl=dlq_url, AttributeNames=['QueueArn'])['Attributes']['QueueArn']
    src_url = sqs.create_queue(QueueName=names['src'], tags={'Deployment': PREFIX}, Attributes={
        'RedrivePolicy': json.dumps({'deadLetterTargetArn': dlq_arn, 'maxReceiveCount': 4})})['QueueUrl']
    created.append(src_url)
    created.append(sqs.create_queue(QueueName=names['foreign'], tags={'Deployment': f'{PREFIX}-qmtest-other'})['QueueUrl'])
    for i in range(2):
        sqs.send_message(QueueUrl=dlq_url, MessageBody=f'queue-monitor test {i}')
    for i in range(3):
        sqs.send_message(QueueUrl=src_url, MessageBody=f'queue-monitor test {i}')

    # New queues and approximate counts can take a little while to show.
    seen = {}
    for _ in range(12):
        status, body = get()
        seen = {q['name']: q for q in body['data']['queues']} if status == 200 else {}
        d, s = seen.get(names['dlq']), seen.get(names['src'])
        if d and s and d['messagesVisible'] == 2 and s['messagesVisible'] == 3:
            break
        time.sleep(5)
    d, s = seen.get(names['dlq']), seen.get(names['src'])
    check('Q6 a newly created queue appears', bool(d and s), f"dlq={bool(d)} src={bool(s)}")
    check('Q6 a DLQ with messages is an error', bool(d) and d['status'] == 'error' and d['statusReason'] == '2 failed messages',
          f"{d and (d['status'], d['statusReason'])}")
    check('Q6 the DLQ names its source and the source its DLQ', bool(d and s) and names['src'] in d['sourceQueues']
          and s['deadLetterQueue'] == names['dlq'] and s['maxReceiveCount'] == 4,
          f"{d and d['sourceQueues']} / {s and (s['deadLetterQueue'], s['maxReceiveCount'])}")
    check('Q6 waiting messages are counted', bool(s) and s['messagesVisible'] == 3, f"{s and s['messagesVisible']}")
    check('Q6 a queue sorted by severity comes first', status == 200 and body['data']['queues'][0]['status'] == 'error',
          f"first={body['data']['queues'][0]['name'] if status == 200 else None}")
    check('Q7 another deployment\'s queue with the same prefix is excluded', names['foreign'] not in seen)
finally:
    for u in created:
        try:
            sqs.delete_queue(QueueUrl=u)
        except Exception as e:  # noqa: BLE001
            print(f'cleanup failed for {u}: {e}', flush=True)
    print(f'deleted {len(created)} test queues', flush=True)

# ---------------------------------------------------------------- mapping leak
# get-config maps each <prefix>-<client>-heartbeat queue to the HeartbeatUpdater;
# the clean-up (every minute) deletes the mapping with the queue and sweeps any
# left behind, at most 50 per run. Read-only: allow a few runs before failing.
def orphan_heartbeat_mappings():
    shared = arn_from_url(expected[f'{PREFIX}-heartbeat-queue'])
    updaters = {m['FunctionArn'] for m in lam.list_event_source_mappings(EventSourceArn=shared)['EventSourceMappings']}
    orphans, total = [], 0
    for fn in updaters:
        for page in lam.get_paginator('list_event_source_mappings').paginate(FunctionName=fn):
            for m in page['EventSourceMappings']:
                name = m['EventSourceArn'].split(':')[-1]
                if name == f'{PREFIX}-heartbeat-queue' or not (name.startswith(f'{PREFIX}-') and name.endswith('-heartbeat')):
                    continue
                total += 1
                try:
                    sqs.get_queue_url(QueueName=name, QueueOwnerAWSAccountId=m['EventSourceArn'].split(':')[4])
                except sqs.exceptions.QueueDoesNotExist:
                    orphans.append(name)
    return updaters, orphans, total


if f'{PREFIX}-heartbeat-queue' not in expected:
    check('Q10 no event source mappings left on deleted heartbeat queues', False, 'shared heartbeat queue not found')
else:
    for attempt in range(4):
        updaters, orphans, total = orphan_heartbeat_mappings()
        if not orphans:
            break
        time.sleep(65)
    check('Q10 no event source mappings left on deleted heartbeat queues', updaters and not orphans,
          f'updaters={len(updaters)} client heartbeat mappings={total} orphans={len(orphans)} {orphans[:5]}')

# ---------------------------------------------------------------- access
status, _ = get(token=None)
check('Q8 no token is refused', status in (401, 403), f'status={status}')

passed = sum(r['ok'] for r in results)
print(f'\n{passed}/{len(results)} checks passed', flush=True)
if RESULTS:
    with open(RESULTS, 'w') as f:
        json.dump(results, f, indent=2)
sys.exit(0 if passed == len(results) else 1)
