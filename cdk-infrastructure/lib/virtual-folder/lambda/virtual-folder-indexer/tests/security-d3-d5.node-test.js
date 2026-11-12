'use strict';
// De-identification security tests for the VF indexer: no original identifier reaches the
// folder tree, REMOVE stores NULL, an outdated tree is rebuilt first, and the
// patient key matches the Python consumer.
// Run: node --test tests/security-d3-d5.node-test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const LAYER = path.resolve(__dirname, '../../../../main/lambda/layers/shared/nodejs');
const calls = [];
let schemaCurrent = false;
const fakeDb = {
  query: async (sql, params) => {
    calls.push({ sql, params });
    if (/information_schema\.COLUMNS/.test(sql)) return [{ n: schemaCurrent ? 1 : 0 }];
    if (/FROM .*virtual_folder_assignments/.test(sql)) return [SRC];
    if (/^SELECT .* AS pk/.test(sql.trim())) return [{ pk: 1 }];
    return [];
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '/opt/nodejs/database') return path.join(__dirname, 'fake-db-stub.js');
  if (req.startsWith('/opt/nodejs/')) req = path.join(LAYER, req.slice('/opt/nodejs/'.length));
  return origResolve.call(this, req, ...rest);
};
Object.assign(require('./fake-db-stub'), fakeDb);

const SRC = {
  content_pkey: 7, instance_pkey: 70, datastore_id: 'ds-1',
  patientid: 'MRN-1234567', patientname: 'DOE^JANE', patientbirthdate: '1961-03-04', patientsex: 'F',
  issuerofpatientid: 'HOSP', studyinstanceuid: '1.2.3', studydate: '2020-05-06', studytime: null,
  accessionnumber: 'ACC-998877', studyid: 'S1', studydescription: 'CT CHEST JANE DOE',
  referringphysicianname: 'SMITH^JOHN', modalitiesinstudy: 'CT', seriesinstanceuid: '1.2.3.4',
  modality: 'CT', seriesdescription: 'AXIAL', seriesnumber: '1', sopinstanceuid: '1.2.3.4.5',
  sopclassuid: '1.2.840.10008.5.1.4.1.1.2', instancenumber: 1,
};
const IDS = ['MRN-1234567', 'DOE^JANE', '1961-03-04', '19610304', 'ACC-998877', 'CT CHEST JANE DOE', 'SMITH^JOHN', '2020-05-06'];
const VF = '11111111-1111-1111-1111-111111111111';
const idx = require('../index.js')._test;
const REMOVE_ALL = ['00100010', '00100020', '00100030', '00080050', '00080020', '00081030', '00080090']
  .map((tag) => ({ tag, action: 'REMOVE' }));

const writes = () => calls.filter((c) => /INSERT INTO/.test(c.sql));
const insertFor = (leaf) => writes().find((c) => c.sql.includes(`_${leaf}\``)).params;

test('outdated tree is dropped and recreated before hydration', async () => {
  calls.length = 0; schemaCurrent = false; idx.setPepper('pep');
  await idx.hydrateVfTree(VF, REMOVE_ALL, 'salt');
  assert.ok(calls.some((c) => /DROP TABLE IF EXISTS .*_patient/.test(c.sql)));
  assert.ok(calls.some((c) => /CREATE TABLE IF NOT EXISTS .*_patient[\s\S]*source_key/.test(c.sql)));
});

test('REMOVE stores NULL and no original identifier is written', async () => {
  for (const actions of [REMOVE_ALL, [
    { tag: '00100020', action: 'HASH_16' }, { tag: '00100010', action: 'EMPTY' },
    { tag: '00100030', action: 'SHIFT_DATE', shiftDaysMin: 5, shiftDaysMax: 9 },
    { tag: '00080050', action: 'HASH' }, { tag: '00080020', action: 'REMOVE' },
    { tag: '00081030', action: 'REPLACE', replacement: 'X' }, { tag: '00080090', action: 'REMOVE' }]]) {
    calls.length = 0; schemaCurrent = true; idx.setPepper('pep');
    await idx.hydrateVfTree(VF, actions, 'salt');
    const dumped = JSON.stringify(writes());
    for (const id of IDS) assert.ok(!dumped.includes(id), `${id} leaked with ${JSON.stringify(actions)}`);
    assert.ok(!dumped.includes('original_'));
  }
  calls.length = 0; await idx.hydrateVfTree(VF, REMOVE_ALL, 'salt');
  const pat = insertFor('patient'); // source_key, issuer, ds, patientid, patientname, birthdate, sex
  assert.deepStrictEqual([pat[3], pat[4], pat[5]], [null, null, null]);
  const st = insertFor('study');    // patient_pkey, ds, uid, accession, studyid, studydate, desc, referring, mods
  assert.deepStrictEqual([st[3], st[5], st[6], st[7]], [null, null, null, null]);
});

test('no rule keeps the value, dates included', async () => {
  calls.length = 0; schemaCurrent = true; idx.setPepper('pep');
  await idx.hydrateVfTree(VF, [], 'salt');
  const pat = insertFor('patient');
  assert.strictEqual(pat[3], 'MRN-1234567');
  assert.strictEqual(pat[5], '1961-03-04');
});

test('patient key matches the Python consumer and needs the pepper', async () => {
  const { sourcePatientKey } = require('/opt/nodejs/vf-tree-ddl');
  assert.strictEqual(sourcePatientKey('pep', VF, 'PID1', 'ISS'),
    'c7060a133c71a03d7e1a4bb67be99a7f2521b2d8fc98c92d7db069d4cd201523');
  assert.throws(() => sourcePatientKey('', VF, 'PID1', 'ISS'));
});

test('D-6: keyed hash vectors match dicomweb-s3/vf_deid.py', () => {
  assert.strictEqual(idx.hashValue('MRN1', 'pep:vf', 'LO', 16), 'e8ef55f86b082c8f');
  assert.strictEqual(idx.hashUid('1.2.3', 'pep:vf'), '2.25.695757587007268595812842039316285979');
  assert.strictEqual(idx.shiftDate('20200101', { shiftDaysMin: 1, shiftDaysMax: 30 }, 'pep:vf', 'MRN1'), '20200126');
});
