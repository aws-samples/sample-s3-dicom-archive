/**
 * index-attributes-api: /defs list de-duplication and bounded-wait DDL.
 * The shared database layer is mocked at its boundary (/opt/nodejs/database).
 */
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockExecute = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery, transaction: mockTransaction, execute: mockExecute }), { virtual: true });
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSend })),
  SendMessageCommand: jest.fn((input) => ({ input })),
}), { virtual: true });
process.env.BACKFILL_QUEUE_URL = 'https://sqs.example/backfill';
jest.mock('/opt/nodejs/dicom-tags.json', () => ({
  dicom_attributes: [{ tag: '(0008,0070)', keyword: 'Manufacturer' }],
}), { virtual: true });

const { handler } = require('./index');

// Route a SQL string to a canned result. ensureSchema's checks report the table
// already in its current shape so only the code under test issues statements.
function routeQuery(overrides = {}) {
  mockQuery.mockImplementation(async (sql) => {
    for (const [needle, result] of Object.entries(overrides)) {
      if (sql.includes(needle)) return typeof result === 'function' ? result(sql) : result;
    }
    if (sql.includes("column_name = 'virtual_folder_id'")) return [{ 1: 1 }];
    if (sql.includes("index_name = 'uq_def'")) return [{ n: 1 }];
    return [];
  });
}

const post = (body) => handler({
  httpMethod: 'POST', path: '/api/index-attributes/defs', body: JSON.stringify(body),
});
const MFR = { targetType: 'STORAGE', dicomTag: '00080070', dicomLevel: 'SERIES', columnName: 'qa_mfr', dataType: 'STRING' };

beforeEach(() => {
  mockQuery.mockReset(); mockTransaction.mockReset(); mockExecute.mockReset(); mockSend.mockReset();
  mockExecute.mockResolvedValue({ affectedRows: 1 }); mockSend.mockResolvedValue({});
});

test('a custom def is not listed again as a built-in column', async () => {
  routeQuery({
    "target_type = 'STORAGE' AND virtual_folder_id IS NULL ORDER BY": [
      { id: 'd1', target_type: 'STORAGE', dicom_tag: '00080070', dicom_level: 'SERIES', column_name: 'qa_mfr', physical_column: 'manufacturer' },
    ],
    'information_schema.COLUMNS WHERE table_schema=DATABASE() AND table_name=?': (sql) => [
      { col: 'modality', dtype: 'varchar' }, { col: 'manufacturer', dtype: 'varchar' },
    ],
  });
  const res = await handler({ httpMethod: 'GET', path: '/api/index-attributes/defs', queryStringParameters: { targetType: 'STORAGE' } });
  const body = JSON.parse(res.body);
  expect(res.statusCode).toBe(200);
  expect(body.data.map(d => d.physicalColumn)).toEqual(['manufacturer']);
  const series = body.builtins.filter(b => b.dicomLevel === 'SERIES').map(b => b.columnName);
  expect(series).toContain('modality');
  expect(series).not.toContain('manufacturer');
  // Same column name at a level with no def stays a built-in.
  expect(body.builtins.filter(b => b.dicomLevel === 'STUDY').map(b => b.columnName)).toContain('manufacturer');
});

test('ADD COLUMN runs with a bounded metadata-lock wait on one connection', async () => {
  routeQuery({ 'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x', physical_column: 'manufacturer' }] });
  mockTransaction.mockResolvedValue([[], [], []]);
  const res = await post(MFR);
  expect(res.statusCode).toBe(201);
  expect(mockTransaction).toHaveBeenCalledTimes(1);
  const stmts = mockTransaction.mock.calls[0][0].map(s => s.sql);
  expect(stmts[0]).toMatch(/^SET SESSION lock_wait_timeout = \d+$/);
  expect(stmts[1]).toBe('ALTER TABLE `series` ADD COLUMN `manufacturer` VARCHAR(255) NULL');
  expect(stmts[2]).toBe('SET SESSION lock_wait_timeout = DEFAULT');
  // DDL never goes through the plain pooled query().
  expect(mockQuery.mock.calls.some(([sql]) => /ALTER TABLE `series`/.test(sql))).toBe(false);
});

test('a busy table returns 503 and records no def', async () => {
  routeQuery();
  const err = Object.assign(new Error('Lock wait timeout exceeded; try restarting transaction'), { errno: 1205 });
  mockTransaction.mockRejectedValue(err);
  const res = await post(MFR);
  expect(res.statusCode).toBe(503);
  expect(JSON.parse(res.body).error).toMatch(/in use by another database session/);
  expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO index_attribute_defs/.test(sql))).toBe(false);
});

test('an existing column is reused without any DDL', async () => {
  routeQuery({
    'information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?': [{ 1: 1 }],
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x' }],
  });
  const res = await post(MFR);
  expect(res.statusCode).toBe(201);
  expect(mockTransaction).not.toHaveBeenCalled();
});

test('a busy table on CREATE INDEX keeps the column and warns', async () => {
  routeQuery({
    'SELECT COUNT(DISTINCT index_name)': [{ n: 3 }],
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x' }],
  });
  mockTransaction
    .mockResolvedValueOnce([[], [], []])
    .mockRejectedValueOnce(Object.assign(new Error('Lock wait timeout exceeded'), { errno: 1205 }));
  const res = await post({ ...MFR, isIndexed: true });
  const body = JSON.parse(res.body);
  expect(res.statusCode).toBe(201);
  expect(body.warning).toMatch(/without an index/);
  const insert = mockQuery.mock.calls.find(([sql]) => /INSERT INTO index_attribute_defs/.test(sql));
  expect(insert[1][8]).toBe(0); // is_indexed recorded false
});

test('a duplicate STORAGE def (NULL virtual folder) returns 409 and runs no DDL', async () => {
  routeQuery({ 'SELECT id FROM index_attribute_defs WHERE target_type = ? AND virtual_folder_id <=> ?': [{ id: 'existing' }] });
  const res = await post(MFR);
  expect(res.statusCode).toBe(409);
  expect(JSON.parse(res.body).error).toMatch(/already exists at the SERIES level for STORAGE tables/);
  const dupCall = mockQuery.mock.calls.find(([sql]) => sql.includes('virtual_folder_id <=> ?'));
  expect(dupCall[1]).toEqual(['STORAGE', null, 'SERIES', 'manufacturer']);
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(mockQuery.mock.calls.some(([sql]) => /INSERT INTO index_attribute_defs/.test(sql))).toBe(false);
});

test('a duplicate VF def is checked against that virtual folder only', async () => {
  const vf = '11111111-2222-3333-4444-555555555555';
  routeQuery({ 'SELECT id FROM index_attribute_defs WHERE target_type = ? AND virtual_folder_id <=> ?': [{ id: 'existing' }] });
  const res = await post({ ...MFR, targetType: 'VF', virtualFolderId: vf });
  expect(res.statusCode).toBe(409);
  expect(JSON.parse(res.body).error).toMatch(/for this virtual folder/);
  const dupCall = mockQuery.mock.calls.find(([sql]) => sql.includes('virtual_folder_id <=> ?'));
  expect(dupCall[1]).toEqual(['VF', vf, 'SERIES', 'manufacturer']);
});

// ── TASK A: concurrent duplicate adds ───────────────────────────────────────

test('a duplicate-key error from the INSERT (concurrent add) is a 409, by errno', async () => {
  routeQuery({
    'information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?': [{ 1: 1 }],
    'INSERT INTO index_attribute_defs': () => { throw Object.assign(new Error("dup on 'uq_def_scope'"), { errno: 1062, code: 'ER_DUP_ENTRY' }); },
  });
  const res = await post(MFR);
  expect(res.statusCode).toBe(409);
  expect(JSON.parse(res.body).error).toMatch(/already exists at the SERIES level/);
  expect(mockSend).not.toHaveBeenCalled(); // no back-fill for a def that was not created
});

test('db-init and the API ensure-create key STORAGE defs on a non-NULL generated scope column', async () => {
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(path.join(__dirname, '../../../database/lambda/database-schema-init/schema.sql'), 'utf8');
  const block = schema.slice(schema.indexOf('CREATE TABLE index_attribute_defs'), schema.indexOf('ENGINE', schema.indexOf('CREATE TABLE index_attribute_defs')));
  expect(block).toMatch(/scope_key\s+VARCHAR\(36\) GENERATED ALWAYS AS \(IFNULL\(virtual_folder_id, ''\)\) STORED NOT NULL/);
  expect(block).toMatch(/UNIQUE KEY uq_def_scope \(target_type, scope_key, dicom_level, physical_column\)/);
  expect(schema).toMatch(/CREATE TABLE index_attribute_backfill_jobs/);
  routeQuery();
  let fresh;
  jest.isolateModules(() => { fresh = require('./index').handler; }); // ensureSchema runs once per module
  await fresh({ httpMethod: 'GET', path: '/api/index-attributes/defs', queryStringParameters: { targetType: 'STORAGE' } });
  const create = mockQuery.mock.calls.map(([q]) => q).find(q => q.includes('CREATE TABLE IF NOT EXISTS index_attribute_defs'));
  expect(create).toMatch(/UNIQUE KEY uq_def_scope \(target_type, scope_key, dicom_level, physical_column\)/);
});

// ── TASK B: back-fill ───────────────────────────────────────────────────────

const job = (o = {}) => ({ def_id: 'x', status: 'RUNNING', cursor_pkey: 50, max_pkey: 200, rows_scanned: 50, rows_written: 40,
  batches: 1, error: null, idle_s: 5, ...o });

test('adding a STORAGE def arms a back-fill and sends its first message after the ingest cache delay', async () => {
  routeQuery({
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x', physical_column: 'manufacturer', scope_key: '' }],
    'FROM index_attribute_backfill_jobs WHERE def_id = ?': [job({ status: 'PENDING', cursor_pkey: 0, max_pkey: null })],
  });
  mockTransaction.mockResolvedValue([[], [], []]);
  const res = await post(MFR);
  const body = JSON.parse(res.body);
  expect(res.statusCode).toBe(201);
  expect(body.warning).toBeUndefined();
  expect(body.data.scopeKey).toBeUndefined();
  expect(body.data.backfill).toMatchObject({ status: 'PENDING', percent: 0 });
  const arm = mockQuery.mock.calls.find(([q]) => q.includes('INSERT INTO index_attribute_backfill_jobs'));
  const defInsert = mockQuery.mock.calls.find(([q]) => q.includes('INSERT INTO index_attribute_defs'));
  expect(arm[1][0]).toBe(defInsert[1][0]); // the job is keyed on the new def's id
  expect(mockSend).toHaveBeenCalledTimes(1);
  const input = mockSend.mock.calls[0][0].input;
  expect(input.QueueUrl).toBe('https://sqs.example/backfill');
  expect(input.DelaySeconds).toBe(90);
  expect(JSON.parse(input.MessageBody)).toEqual({ defId: arm[1][0], token: arm[1][1] });
});

test('a VF def does not start a storage back-fill', async () => {
  routeQuery({
    'information_schema.COLUMNS WHERE table_schema = ? AND table_name = ? AND column_name = ?': [{ 1: 1 }],
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x' }],
  });
  const res = await post({ ...MFR, targetType: 'VF', virtualFolderId: '11111111-2222-3333-4444-555555555555' });
  expect(res.statusCode).toBe(201);
  expect(mockSend).not.toHaveBeenCalled();
});

test('if the first message cannot be sent the def is kept, the job is FAILED and the add warns', async () => {
  routeQuery({
    'information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?': [{ 1: 1 }],
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x' }],
  });
  mockSend.mockRejectedValue(new Error('AccessDenied'));
  const res = await post(MFR);
  expect(res.statusCode).toBe(201);
  expect(JSON.parse(res.body).warning).toMatch(/back-fill of existing studies did not start \(AccessDenied\)/);
  expect(mockExecute.mock.calls[0][0]).toMatch(/SET status = 'FAILED'/);
});

test('GET /defs returns each STORAGE def with its back-fill progress', async () => {
  routeQuery({
    "target_type = 'STORAGE' AND virtual_folder_id IS NULL ORDER BY": [
      { id: 'a', dicom_level: 'SERIES', physical_column: 'manufacturer' },
      { id: 'b', dicom_level: 'STUDY', physical_column: 'institutionname' },
      { id: 'c', dicom_level: 'PATIENT', physical_column: 'ethnicgroup' },
    ],
    'FROM index_attribute_backfill_jobs': [
      job({ def_id: 'a' }), job({ def_id: 'b', status: 'DONE', cursor_pkey: 200 }),
      job({ def_id: 'c', idle_s: 5000 }),
    ],
  });
  const res = await handler({ httpMethod: 'GET', path: '/api/index-attributes/defs', queryStringParameters: { targetType: 'STORAGE' } });
  const byId = Object.fromEntries(JSON.parse(res.body).data.map(d => [d.id, d.backfill]));
  expect(byId.a).toMatchObject({ status: 'RUNNING', percent: 25, rowsScanned: 50, rowsWritten: 40, stalled: false });
  expect(byId.b).toMatchObject({ status: 'DONE', percent: 100 });
  expect(byId.c.stalled).toBe(true);
});

const backfill = (body) => post({ action: 'backfill', ...body });

test('back-fill action: unknown def 404, VF def 400, missing id 400, unknown action 400', async () => {
  routeQuery();
  expect((await backfill({ id: 'nope' })).statusCode).toBe(404);
  expect((await backfill({})).statusCode).toBe(400);
  expect((await post({ action: 'drop' })).statusCode).toBe(400);
  routeQuery({ 'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'v', target_type: 'VF', virtual_folder_id: 'vf' }] });
  const res = await backfill({ id: 'v' });
  expect(res.statusCode).toBe(400);
  expect(mockSend).not.toHaveBeenCalled();
});

test('back-fill action: a healthy running job is left alone (409)', async () => {
  routeQuery({
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x', target_type: 'STORAGE', virtual_folder_id: null }],
    'FROM index_attribute_backfill_jobs WHERE def_id = ?': [job()],
  });
  const res = await backfill({ id: 'x' });
  expect(res.statusCode).toBe(409);
  expect(mockSend).not.toHaveBeenCalled();
});

test('back-fill action: a FAILED job resumes from its cursor with no delay', async () => {
  routeQuery({
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x', target_type: 'STORAGE', virtual_folder_id: null }],
    'FROM index_attribute_backfill_jobs WHERE def_id = ?': [job({ status: 'FAILED', error: 'boom' })],
  });
  const res = await backfill({ id: 'x' });
  expect(res.statusCode).toBe(202);
  expect(JSON.parse(res.body).data.resumed).toBe(true);
  const resume = mockQuery.mock.calls.find(([q]) => q.includes('UPDATE index_attribute_backfill_jobs'));
  expect(resume[0]).not.toMatch(/cursor_pkey = 0/);
  expect(mockQuery.mock.calls.some(([q]) => q.includes('INSERT INTO index_attribute_backfill_jobs'))).toBe(false);
  expect(mockSend.mock.calls[0][0].input.DelaySeconds).toBe(0);
  expect(JSON.parse(mockSend.mock.calls[0][0].input.MessageBody).token).toBe(resume[1][0]);
});

test('back-fill action: a stalled job resumes; a DONE job (or restart=true) starts over', async () => {
  routeQuery({
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x', target_type: 'STORAGE', virtual_folder_id: null }],
    'FROM index_attribute_backfill_jobs WHERE def_id = ?': [job({ idle_s: 99999 })],
  });
  expect((await backfill({ id: 'x' })).statusCode).toBe(202);
  expect(mockQuery.mock.calls.some(([q]) => q.includes('INSERT INTO index_attribute_backfill_jobs'))).toBe(false);

  mockQuery.mockReset(); mockSend.mockClear();
  routeQuery({
    'SELECT * FROM index_attribute_defs WHERE id': [{ id: 'x', target_type: 'STORAGE', virtual_folder_id: null }],
    'FROM index_attribute_backfill_jobs WHERE def_id = ?': [job({ status: 'DONE' })],
  });
  const res = await backfill({ id: 'x' });
  expect(res.statusCode).toBe(202);
  expect(JSON.parse(res.body).data.resumed).toBe(false);
  const arm = mockQuery.mock.calls.find(([q]) => q.includes('INSERT INTO index_attribute_backfill_jobs'));
  expect(arm[0]).toMatch(/cursor_pkey = 0/);
  expect(mockSend.mock.calls[0][0].input.DelaySeconds).toBe(90);
});
