/**
 * get-config: a routing rule whose target storage is not writable is handed to
 * the DIMSE service bucketless (destinationWritable=false), never with the
 * storage's bucket, and never silently removed (removal would let its studies
 * fall through to another rule or the fallback and be written elsewhere).
 * Run: npx jest lib/config/lambda/config-infrastructure/get-config
 */
jest.mock('/opt/nodejs/database', () => ({ query: jest.fn() }), { virtual: true });
jest.mock('/opt/nodejs/resource-tracker', () => ({ trackResource: jest.fn() }), { virtual: true });
jest.mock('/opt/nodejs/writable-destination',
  () => jest.requireActual('../../../../main/lambda/layers/shared/nodejs/writable-destination'), { virtual: true });
const client = () => ({ send: jest.fn() });
jest.mock('@aws-sdk/client-sqs', () => ({ SQSClient: jest.fn(client) }), { virtual: true });
jest.mock('@aws-sdk/client-sns', () => ({ SNSClient: jest.fn(client) }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({ LambdaClient: jest.fn(client) }), { virtual: true });
jest.mock('@aws-sdk/client-secrets-manager', () => ({ SecretsManagerClient: jest.fn(client) }), { virtual: true });

const fs = require('fs');
const path = require('path');

// index.js declares parseUseS3Direct twice (legal in a sloppy CommonJS script,
// rejected by jest's babel parser), so it is evaluated here the way Node loads
// it: as a plain function body, with jest's require so the mocks above apply.
const SRC_PATH = path.join(__dirname, 'index.js');
function loadGetConfig() {
  const mod = { exports: {} };
  const req = (id) => (id.startsWith('.') ? require(path.join(__dirname, id)) : require(id));
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', '__dirname', '__filename', fs.readFileSync(SRC_PATH, 'utf8'))(
    req, mod, mod.exports, __dirname, SRC_PATH);
  return mod.exports;
}
const { _internal: { routingRuleForConfig, isDimseTaskRoleCaller } } = loadGetConfig();

const ROW = { name: 'Main', s3BucketName: 'b-app', status: 'ACTIVE', access_level: null, deleted: 0 };
const DATASTORES = {
  'ds-app': ROW,
  'ds-rw': { ...ROW, name: 'RW', s3BucketName: 'b-rw', access_level: 'read-write' },
  'ds-ro': { ...ROW, name: 'Imported', s3BucketName: 'b-ro', access_level: 'read-only' },
  'ds-del': { ...ROW, name: 'Going', s3BucketName: 'b-del', status: 'DELETING' },
  'ds-gone': { ...ROW, name: 'Gone', s3BucketName: 'b-gone', deleted: 1 },
};
const rule = (action) => ({ id: 'r1', name: 'rule', priority: 10, enabled: true, conditions: {}, action });

beforeAll(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));

test.each([['ds-app', 'b-app'], ['ds-rw', 'b-rw']])('writable storage %s keeps its bucket', (id, bucket) => {
  const r = routingRuleForConfig(rule({ datastoreId: id }), DATASTORES);
  expect(r.action.s3BucketName).toBe(bucket);
  expect(r.action.destinationWritable).toBe(true);
  expect(r.action.datastoreName).toBe(DATASTORES[id].name);
});

test.each([
  ['ds-ro', 'Storage is read-only'],
  ['ds-del', 'Storage is not active (DELETING)'],
  ['ds-gone', 'Storage not found'],
  ['ds-unknown', 'Storage not found'],
])('non-writable storage %s is kept as a bucketless refusing rule', (id, reason) => {
  const r = routingRuleForConfig(rule({ datastoreId: id }), DATASTORES);
  expect(r.id).toBe('r1');
  expect(r.enabled).toBe(true);                 // still matches, so it can refuse
  expect(r.action.datastoreId).toBe(id);
  expect(r.action.destinationWritable).toBe(false);
  expect(r.action.destinationRefusal).toBe(reason);
  expect(r.action).not.toHaveProperty('s3BucketName');
});

test('a bucket stored inside the action JSON is never passed through', () => {
  const ro = routingRuleForConfig(rule({ datastoreId: 'ds-ro', s3BucketName: 'b-ro' }), DATASTORES);
  expect(ro.action).not.toHaveProperty('s3BucketName');
  const ok = routingRuleForConfig(rule({ datastoreId: 'ds-app', s3BucketName: 'attacker-bucket' }), DATASTORES);
  expect(ok.action.s3BucketName).toBe('b-app');
  const none = routingRuleForConfig(rule({ s3BucketName: 'attacker-bucket' }), DATASTORES);
  expect(none.action).not.toHaveProperty('s3BucketName');
});

test('the handler reads the writability columns and builds rules through routingRuleForConfig', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  expect(src).toMatch(/SELECT id, name, s3_bucket_name, status, access_level, deleted FROM datastores WHERE id IN/);
  expect(src).toMatch(/routingRules: \(rulesByInterface\[iface\.id\] \|\| \[\]\)\.map\(rule => routingRuleForConfig\(rule, datastoresMap\)\)/);
});

// ───────────────────── SECURITY: cross-account DIMSE caller ─────────────────────
// The in-VPC PRIVATE API's resource policy admits any principal that routes through
// the VPC endpoint (no account condition). get-config must therefore pin the trusted
// DIMSE task-role caller to THIS deployment's account, not the role name alone — else
// an identically-named assumed-role in another AWS account could impersonate the DIMSE
// service and pull its TLS private key + DICOMweb session tokens.
describe('isDimseTaskRoleCaller account pinning', () => {
  const ROLE = 'myarchive-dimse-task-role';
  const ACCT = '111122223333';
  const evt = (arn) => ({ requestContext: { identity: { userArn: arn } } });
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, DIMSE_TASK_ROLE_NAME: ROLE, DIMSE_TASK_ROLE_ACCOUNT: ACCT }; });
  afterAll(() => { process.env = OLD; });

  test('accepts the DIMSE task role in THIS account', () => {
    expect(isDimseTaskRoleCaller(evt(`arn:aws:sts::${ACCT}:assumed-role/${ROLE}/ecs-task-123`))).toBe(true);
  });

  test('REJECTS the same role name in a DIFFERENT account (the attack)', () => {
    expect(isDimseTaskRoleCaller(evt(`arn:aws:sts::999999999999:assumed-role/${ROLE}/sess`))).toBe(false);
  });

  test('rejects a different role in this account', () => {
    expect(isDimseTaskRoleCaller(evt(`arn:aws:sts::${ACCT}:assumed-role/some-other-role/sess`))).toBe(false);
  });

  test('fails closed when the expected account env is unset', () => {
    delete process.env.DIMSE_TASK_ROLE_ACCOUNT;
    expect(isDimseTaskRoleCaller(evt(`arn:aws:sts::${ACCT}:assumed-role/${ROLE}/sess`))).toBe(false);
  });

  test('rejects a non-assumed-role / garbage ARN', () => {
    expect(isDimseTaskRoleCaller(evt('arn:aws:iam::' + ACCT + ':user/someone'))).toBe(false);
    expect(isDimseTaskRoleCaller(evt('not-an-arn'))).toBe(false);
    expect(isDimseTaskRoleCaller({})).toBe(false);
  });
});
