// Unit tests for the processing-job plugin lambdas (pure logic only).
// Run: node --test tests/plugins/
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

// Stub the Lambda layer modules (/opt/nodejs/*) so the handlers load locally.
// `db.query` is swapped per test; the handlers bound the stub's wrapper at load.
const db = { query: async () => [] };
const stubs = {
  '/opt/nodejs/database': { query: (...a) => db.query(...a), queryReadOnly: async () => [], execute: async () => ({ affectedRows: 0 }) },
  '/opt/nodejs/audit-helper': { sendAuditEvent: async () => {}, AUDIT_ACTIONS: { CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE' } },
  '/opt/nodejs/versioning-helper': { softDelete: async () => {} },
  // The real guard (pure logic), not a stub.
  '/opt/nodejs/sql-ast-guard': require(path.join(__dirname, '..', '..', '..', 'cdk-infrastructure', 'lib', 'main', 'lambda', 'layers', 'shared', 'nodejs', 'sql-ast-guard.js')),
  '/opt/nodejs/run-visibility': require(path.join(__dirname, '..', '..', '..', 'cdk-infrastructure', 'lib', 'main', 'lambda', 'layers', 'shared', 'nodejs', 'run-visibility.js')),
  '/opt/nodejs/job-params': require(path.join(__dirname, '..', '..', '..', 'cdk-infrastructure', 'lib', 'main', 'lambda', 'layers', 'shared', 'nodejs', 'job-params.js')),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return stubs[req] ? req : origResolve.call(this, req, ...rest); };
for (const [k, v] of Object.entries(stubs)) require.cache[k] = { id: k, filename: k, loaded: true, exports: v };

process.env.STACK_PREFIX = 'test';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.AWS_REGION = 'us-east-1';
process.env.PLUGIN_EXTRA_ALLOWED_IMAGES = '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-east-1:abc';

const L = (n) => path.join(__dirname, '..', '..', '..', 'cdk-infrastructure', 'lib', 'processing-jobs', 'lambda', n, 'index.js');
const registry = require(L('plugin-registry'))._internal;
const runner = require(L('plugin-runner'))._internal;
const recorder = require(L('plugin-recorder'))._internal;
const api = require(L('processing-jobs-api'))._internal;

const IMG = '123456789012.dkr.ecr.us-east-1.amazonaws.com/test-plugin-thumb:1.0.0';
const base = () => ({ name: 'Thumb', image: IMG, parameters: [] });

test('valid minimal manifest normalizes defaults', () => {
  const v = registry.validateManifest(base());
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(v.normalized.resources, { vcpu: 1, memoryMiB: 2048, timeoutMinutes: 60, gpu: 0, ephemeralGiB: 21 });
  assert.equal(v.normalized.producesDicom, false);
  assert.equal(v.normalized.granularity, 'series');
  assert.equal(v.normalized.architecture, 'X86_64');
});

test('image must be an in-account <prefix>-plugin-* ECR repo with tag or digest', () => {
  for (const image of [
    'docker.io/library/python:3.12',
    '999999999999.dkr.ecr.us-east-1.amazonaws.com/test-plugin-thumb:1',
    '123456789012.dkr.ecr.eu-west-1.amazonaws.com/test-plugin-thumb:1',
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/other-repo:1',
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/test-plugin-thumb',
    '123456789012.dkr.ecr.us-east-1.amazonaws.com/qa2-plugin-thumb:1',
  ]) {
    assert.equal(registry.validateManifest({ ...base(), image }).ok, false, image);
  }
  assert.equal(registry.validateManifest({ ...base(), image: IMG.replace(':1.0.0', '@sha256:' + 'a'.repeat(64)) }).ok, true);
});

test('explicitly allowed extra image (bundled sample) is accepted', () => {
  assert.equal(registry.validateManifest({ ...base(), image: process.env.PLUGIN_EXTRA_ALLOWED_IMAGES }).ok, true);
});

test('fargate resource combinations are enforced', () => {
  assert.equal(registry.validateManifest({ ...base(), resources: { vcpu: 1, memoryMiB: 512 } }).ok, false);
  assert.equal(registry.validateManifest({ ...base(), resources: { vcpu: 3, memoryMiB: 8192 } }).ok, false);
  assert.equal(registry.validateManifest({ ...base(), resources: { vcpu: 4, memoryMiB: 16384, timeoutMinutes: 120 } }).ok, true);
  assert.equal(registry.validateManifest({ ...base(), resources: { timeoutMinutes: 721 } }).ok, false);
});

test('parameter declarations are validated', () => {
  const bad = (p) => registry.validateManifest({ ...base(), parameters: p }).ok;
  assert.equal(bad([{ name: '1x', type: 'string' }]), false);
  assert.equal(bad([{ name: 'target', type: 'string' }]), false);
  assert.equal(bad([{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }]), false);
  assert.equal(bad([{ name: 'a', type: 'float' }]), false);
  assert.equal(bad([{ name: 'a', type: 'enum', options: [] }]), false);
  assert.equal(bad([{ name: 'a', type: 'enum', options: ['x'], default: 'y' }]), false);
  assert.equal(bad([{ name: 'a', type: 'string', min: 1 }]), false);
  assert.equal(bad([{ name: 'a', type: 'integer', min: 1, max: 9, default: 3 }]), true);
});

test('descriptor maps typed params to the modal form', () => {
  const m = registry.validateManifest({ ...base(), parameters: [
    { name: 'size', type: 'integer', default: 256 },
    { name: 'w', type: 'enum', options: ['a', 'b'] },
    { name: 'flag', type: 'boolean', default: true },
  ] }).normalized;
  const d = registry.toDescriptor(m);
  assert.equal(d.acceptsTarget, true);
  assert.deepEqual(d.parameters.map(p => p.type), ['text', 'select', 'select']);
  assert.equal(d.parameters[0].default, '256');
  assert.deepEqual(d.parameters[2].options, ['yes', 'no']);
  assert.equal(d.parameters[2].default, 'yes');
});

test('runner guards sql targets (D-1): allowlist, scope predicate, no mutation', () => {
  assert.throws(() => runner.guardTargetSql('DELETE FROM series', ['ds1']), /refused/);
  assert.throws(() => runner.guardTargetSql('SELECT 1; SELECT 2', ['ds1']), /refused/);
  assert.throws(() => runner.guardTargetSql('SELECT * FROM users', ['ds1']), /not permitted: users/);
  assert.throws(() => runner.guardTargetSql('SELECT * FROM series', []), /No datastores/);
  // The EdgeSwarm exploit: PHI concatenated into the projected datastore_id. The
  // inner patient read is scoped to the caller's datastores, so it reads nothing
  // outside them.
  const exploit = "SELECT (SELECT GROUP_CONCAT(patientname) FROM patient WHERE datastore_id='victim') AS datastore_id, studyinstanceuid AS study_instance_uid, 'x' AS series_instance_uid FROM study LIMIT 1";
  const g = runner.guardTargetSql(exploit, ['ds1']);
  assert.match(g, /`patient`\.`datastore_id` IN \('ds1'\)/);
  assert.match(g, /`study`\.`datastore_id` IN \('ds1'\)/);
  const q = runner.buildPageQuery(runner.guardTargetSql('SELECT datastore_id, studyinstanceuid AS study_instance_uid, seriesinstanceuid AS series_instance_uid FROM series LIMIT 5', ['ds1']), 50, 10);
  assert.match(q, /SELECT DISTINCT datastore_id, study_instance_uid, series_instance_uid/);
  assert.match(q, /LIMIT 10 OFFSET 50$/);
  assert.doesNotMatch(q, /LIMIT 5/);
});

test('runner never stores DB error text on the run (D-1 exfil channel)', () => {
  const dbErr = Object.assign(new Error("Truncated incorrect DOUBLE value: 'DOE^JOHN'"), { errno: 1292, sqlState: '22007' });
  assert.equal(runner.publicMessage(dbErr), 'The selection query could not be run');
  assert.equal(runner.publicMessage(new runner.TargetError('Plugin is disabled')), 'Plugin is disabled');
  assert.equal(runner.publicMessage(new Error('AccessDenied arn:aws:...')), 'The run could not be started');
});

test('runner scope check fails closed without a scope', () => {
  assert.equal(runner.scopeChecker('alice', null)('ds1'), false);
  assert.equal(runner.scopeChecker('alice', { canReadDatastoreIds: ['ds1'] })('ds1'), true);
  assert.equal(runner.scopeChecker('alice', { canReadDatastoreIds: ['ds1'] })('ds2'), false);
  assert.equal(runner.scopeChecker('alice', { canReadDatastoreIds: ['*'] })('ds2'), true);
  // Security: a user NAMED scheduler gets no bypass; scheduled runs carry a scope.
  assert.equal(runner.scopeChecker('scheduler', null)('ds2'), false);
  assert.equal(runner.scopeChecker('scheduler', { canReadDatastoreIds: ['ds2'] })('ds2'), true);
});

test('recorder keeps only output/ keys without traversal', () => {
  const out = recorder.sanitizeOutputs([
    { key: 'output/a.png' }, { key: '/output/b.png' }, { key: 'input.json' },
    { key: 'output/../input.json' }, { key: 5 }, null,
  ]);
  assert.deepEqual(out.map(o => o.key), ['output/a.png', 'output/b.png']);
});

test('recorder finds the run id from env or job name', () => {
  assert.equal(recorder.runIdFrom({ container: { environment: [{ name: 'PLUGIN_RUN_ID', value: 'r1' }] } }), 'r1');
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  assert.equal(recorder.runIdFrom({ jobName: `plugin-${id}` }), id);
  assert.equal(recorder.runIdFrom({ jobName: 'nifti-x' }), null);
});

// ---- GPU ---------------------------------------------------------------------

test('GPU plugins: x86_64 only, EC2 sizing instead of Fargate pairs', () => {
  const gpu = (resources, extra = {}) => registry.validateManifest({ ...base(), ...extra, resources });
  assert.equal(gpu({ gpu: 1, vcpu: 4, memoryMiB: 15000 }).ok, true, gpu({ gpu: 1, vcpu: 4, memoryMiB: 15000 }).errors.join());
  assert.equal(gpu({ gpu: 1, vcpu: 4, memoryMiB: 15000 }, { architecture: 'ARM64' }).ok, false);
  assert.equal(gpu({ gpu: 5, vcpu: 4, memoryMiB: 15000 }).ok, false);
  assert.equal(gpu({ gpu: 1.5, vcpu: 4, memoryMiB: 15000 }).ok, false);
  assert.equal(gpu({ gpu: 1, vcpu: 0.5, memoryMiB: 2048 }).ok, false);
  // 3 vCPU / 15000 MiB is not a Fargate pair, so it must fail without a GPU.
  assert.equal(gpu({ vcpu: 3, memoryMiB: 15000 }).ok, false);
});

test('job definition: Fargate without GPU, EC2 with a GPU requirement', () => {
  const cpu = registry.validateManifest(base()).normalized;
  const g = registry.validateManifest({ ...base(), resources: { gpu: 1, vcpu: 4, memoryMiB: 15000 } }).normalized;
  const a = registry.jobDefinitionInput('n', 'id', cpu);
  const b = registry.jobDefinitionInput('n', 'id', g);
  assert.deepEqual(a.platformCapabilities, ['FARGATE']);
  assert.ok(a.containerProperties.networkConfiguration);
  assert.deepEqual(b.platformCapabilities, ['EC2']);
  assert.deepEqual(b.containerProperties.resourceRequirements.find(r => r.type === 'GPU'), { type: 'GPU', value: '1' });
  assert.equal(b.containerProperties.networkConfiguration, undefined);
  assert.equal(b.containerProperties.runtimePlatform, undefined);
});

// ---- Write-back ----------------------------------------------------------------

test('write-back: only producesDicom plugins, and the descriptor offers it', () => {
  const plain = registry.validateManifest(base()).normalized;
  const dicom = registry.validateManifest({ ...base(), producesDicom: true }).normalized;
  assert.equal(registry.toDescriptor(plain).parameters.some(p => p.name === 'writeBack'), false);
  const wb = registry.toDescriptor(dicom).parameters.find(p => p.name === 'writeBack');
  assert.deepEqual(wb.options, ['no', 'source', 'datastore']);
  assert.equal(wb.default, 'no');
  const dest = registry.toDescriptor(dicom).parameters.find(p => p.name === 'writeBackDatastoreId');
  assert.equal(dest.type, 'datastore-select');
  assert.deepEqual(dest.showWhen, { param: 'writeBack', equals: 'datastore' });
  assert.deepEqual(api.parseWriteBack(undefined, plain), { value: 'no' });
  assert.ok(api.parseWriteBack('source', plain).error);
  assert.deepEqual(api.parseWriteBack('source', dicom), { value: 'source' });
  assert.ok(api.parseWriteBack('elsewhere', dicom).error);
  const destId = '4315396f-494f-4ddb-b127-ebaa05927b7f';
  assert.deepEqual(api.parseWriteBack('datastore', dicom, destId), { value: 'datastore', datastoreId: destId });
  assert.match(api.parseWriteBack('datastore', dicom).error, /writeBackDatastoreId/);
  assert.ok(api.parseWriteBack('datastore', dicom, 'x; DROP').error);
  assert.ok(api.parseWriteBack('datastore', plain, destId).error);
  assert.equal(registry.validateManifest({ ...base(), parameters: [{ name: 'writeBack', type: 'string' }] }).ok, false);
  assert.equal(registry.validateManifest({ ...base(), parameters: [{ name: 'writeBackDatastoreId', type: 'string' }] }).ok, false);
});

function part10(sopUid, { magic = 'DICM' } = {}) {
  const el = (elem, vr, value) => {
    const v = Buffer.from(value.length % 2 ? value + '\0' : value, 'latin1');
    const h = Buffer.alloc(8);
    h.writeUInt16LE(0x0002, 0); h.writeUInt16LE(elem, 2); h.write(vr, 4, 'latin1'); h.writeUInt16LE(v.length, 6);
    return Buffer.concat([h, v]);
  };
  const ob = Buffer.alloc(14);
  ob.writeUInt16LE(0x0002, 0); ob.writeUInt16LE(0x0001, 2); ob.write('OB', 4, 'latin1'); ob.writeUInt32LE(2, 8); ob[12] = 0; ob[13] = 1;
  return Buffer.concat([Buffer.alloc(128), Buffer.from(magic, 'latin1'), ob,
    el(0x0002, 'UI', '1.2.840.10008.5.1.4.1.1.7'), el(0x0003, 'UI', sopUid), el(0x0010, 'UI', '1.2.840.10008.1.2.1'),
    Buffer.alloc(64)]);
}

test('Part 10 meta parser reads MediaStorageSOPInstanceUID and rejects non-DICOM', () => {
  assert.deepEqual(recorder.parsePart10Meta(part10('1.2.3.4.5')), { sopInstanceUid: '1.2.3.4.5' });
  assert.deepEqual(recorder.parsePart10Meta(part10('1.2.3.4')), { sopInstanceUid: '1.2.3.4' }); // odd length, padded
  assert.ok(recorder.parsePart10Meta(part10('1.2.3', { magic: 'NOPE' })).error);
  assert.ok(recorder.parsePart10Meta(Buffer.from('PNG')).error);
  assert.ok(recorder.parsePart10Meta(part10('1.2.x')).error);
  assert.equal(recorder.isDicomOutput({ key: 'output/a.dcm' }), true);
  assert.equal(recorder.isDicomOutput({ key: 'output/a', contentType: 'application/dicom' }), true);
  assert.equal(recorder.isDicomOutput({ key: 'output/a.png', contentType: 'image/png' }), false);
});

// ---- Chaining ------------------------------------------------------------------

const pluginRow = (id, manifest, enabled = true) => ({ id, name: `P-${id}`, config: JSON.stringify({ plugin: { manifest, enabled } }) });

test('chain stages: plugin must exist, be enabled, share granularity; params coerced', async () => {
  const series = { granularity: 'series', parameters: [{ name: 'n', type: 'integer', default: 2, max: 5 }] };
  const rows = { a: pluginRow('a', series), off: pluginRow('off', series, false), study: pluginRow('study', { granularity: 'study' }) };
  db.query = async (_sql, args) => (rows[args[0]] ? [rows[args[0]]] : []);
  const ok = await api.resolveChainStage({ pluginId: 'a', params: { n: '4' } }, 'series', 0);
  assert.deepEqual(ok.stage, { pluginId: 'a', name: 'P-a', params: { n: 4 }, writeBack: 'no' });
  assert.equal((await api.resolveChainStage({ pluginId: 'zzz' }, 'series', 0)).status, 404);
  assert.equal((await api.resolveChainStage({ pluginId: 'off' }, 'series', 0)).status, 409);
  assert.equal((await api.resolveChainStage({ pluginId: 'study' }, 'series', 1)).status, 400);
  assert.equal((await api.resolveChainStage({ pluginId: 'a', params: { n: 9 } }, 'series', 0)).status, 400);
  assert.equal((await api.resolveChainStage({ pluginId: 'a', writeBack: 'source' }, 'series', 0)).status, 400);
  assert.equal((await api.resolveChainStage({}, 'series', 0)).status, 400);
});

test('upstream target: completed steps become the selection, keyed per series', async () => {
  db.query = async (sql) => {
    if (/FROM processing_jobs/.test(sql)) return [{ id: 'up', name: 'NIfTI run' }];
    return [
      { step_number: 1, input: JSON.stringify({ datastoreId: 'ds', studyInstanceUid: 'st', seriesInstanceUids: ['s1'] }), output: JSON.stringify({ outputs: [{ key: 'output/a.nii.gz' }] }) },
      { step_number: 3, input: JSON.stringify({ datastoreId: 'ds', studyInstanceUid: 'st', seriesInstanceUids: ['s3'] }), output: '{}' },
    ];
  };
  const { target, upstreamByKey } = await runner.loadUpstream('up', 'series');
  assert.deepEqual(target, { mode: 'explicit', entries: [{ datastoreId: 'ds', seriesInstanceUID: 's1' }, { datastoreId: 'ds', seriesInstanceUID: 's3' }] });
  const ref = upstreamByKey.get(runner.groupKey('series', 'ds', 'st', 's1'));
  assert.equal(ref.step, 0);
  assert.deepEqual(ref.outputs, [{ key: 'output/a.nii.gz' }]);
  assert.equal(upstreamByKey.get(runner.groupKey('series', 'ds', 'st', 's3')).step, 2);
  const study = await runner.loadUpstream('up', 'study');
  assert.deepEqual(study.target.entries, [{ datastoreId: 'ds', studyInstanceUID: 'st' }, { datastoreId: 'ds', studyInstanceUID: 'st' }]);
  db.query = async () => [];
});

test('write-back scope uses store grants', () => {
  const scope = { canReadDatastoreIds: ['ds1', 'ds2'], canWriteDatastoreIds: ['ds1'] };
  assert.equal(runner.scopeChecker('alice', scope, 'canWriteDatastoreIds')('ds1'), true);
  assert.equal(runner.scopeChecker('alice', scope, 'canWriteDatastoreIds')('ds2'), false);
  assert.equal(runner.scopeChecker('alice', { canReadDatastoreIds: ['ds1'] }, 'canWriteDatastoreIds')('ds1'), false);
});
