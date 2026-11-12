/**
 * index-attributes-backfill: value parity with ingest, batch/cursor/chain
 * behaviour, deadlock handling. The DB layer and SQS are mocked at their
 * boundaries; a small in-memory job + table model answers the worker's SQL.
 */
const zlib = require('zlib');

const mockQuery = jest.fn();
const mockTransaction = jest.fn();
jest.mock('/opt/nodejs/database', () => ({ query: mockQuery, transaction: mockTransaction }), { virtual: true });
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn(() => ({ send: mockSend })),
  SendMessageCommand: jest.fn((input) => ({ input })),
}), { virtual: true });

process.env.BACKFILL_QUEUE_URL = 'https://sqs.example/q';
process.env.BACKFILL_INSTANCE_BATCH = '2';
process.env.BACKFILL_PARENT_BATCH = '2';
process.env.BACKFILL_DEADLOCK_RETRIES = '2';

const { coerceAttrValue, dicomJsonValue, valueFromBlob } = require('./values');
const { handler, _test } = require('./index');

const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
const hdr = (vals) => gz(Object.fromEntries(Object.entries(vals).map(([t, v]) => [t, { vr: 'LO', Value: [v] }])));

// ── values: parity with ingest/engine.py _coerce_attr_value / ingest/aggregate.py _dcm ──
// Expected values were produced by running the Python _coerce_attr_value.
describe('coerceAttrValue matches ingest', () => {
  const cases = [
    [null, 'STRING', null], ['', 'INT', null], [' 42 ', 'INT', 42], ['+7', 'INT', 7], ['1_000', 'INT', 1000],
    ['4.0', 'INT', null], ['abc', 'INT', null], [5, 'INT', 5],
    ['1.25', 'DECIMAL', 1.25], ['1.5\\2.5', 'DECIMAL', 1.5], ['.5', 'DECIMAL', 0.5], ['1e3', 'DECIMAL', 1000],
    ['x', 'DECIMAL', null], [2.5, 'DECIMAL', 2.5],
    ['20240102', 'DATE', '2024-01-02'], ['2024-01-02', 'DATE', null], ['20240102120000', 'DATE', '2024-01-02'],
    ['2024', 'DATE', null], ['ACME', 'STRING', 'ACME'], [7, 'STRING', '7'],
  ];
  test.each(cases)('%p as %s -> %p', (raw, type, expected) => {
    expect(coerceAttrValue(raw, type)).toEqual({ write: true, value: expected });
  });
  test('STRING keeps the first 255 code points', () => {
    expect(coerceAttrValue('x'.repeat(300), 'STRING').value).toBe('x'.repeat(255));
    expect(coerceAttrValue('é'.repeat(300), 'STRING').value).toBe('é'.repeat(255));
  });
  test('values MySQL strict mode rejects are skipped, as ingest skips the failed UPDATE', () => {
    expect(coerceAttrValue('99999999999', 'INT')).toEqual({ write: false });
    expect(coerceAttrValue('1e13', 'DECIMAL')).toEqual({ write: false });
    expect(coerceAttrValue('inf', 'DECIMAL')).toEqual({ write: false });
    expect(coerceAttrValue('20231399', 'DATE')).toEqual({ write: false });
    expect(coerceAttrValue('20230229', 'DATE')).toEqual({ write: false });
    expect(coerceAttrValue('20240229', 'DATE')).toEqual({ write: true, value: '2024-02-29' });
  });
});

describe('dicomJsonValue matches ingest _dcm', () => {
  test('first value, PN alphabetic, empty -> null', () => {
    const md = {
      '00080070': { vr: 'LO', Value: ['ACME', 'B'] },
      '00100010': { vr: 'PN', Value: [{ Alphabetic: 'Doe^John' }] },
      '00180050': { vr: 'DS', Value: [1.25] },
      '00081030': { vr: 'LO' },
      '00080080': { vr: 'LO', Value: [] },
      '00081115': { vr: 'SQ', Value: [{ '00080016': {} }] },
    };
    expect(dicomJsonValue(md, '00080070')).toBe('ACME');
    expect(dicomJsonValue(md, '00100010')).toBe('Doe^John');
    expect(dicomJsonValue(md, '00180050')).toBe(1.25);
    expect(dicomJsonValue(md, '00081030')).toBeNull();
    expect(dicomJsonValue(md, '00080080')).toBeNull();
    expect(dicomJsonValue(md, '00081115')).toBeNull();
    expect(dicomJsonValue(md, '00200012')).toBeNull();
  });
  test('tag key case-insensitive hex; gzipped blob round trip', () => {
    expect(dicomJsonValue({ '0008103E': { Value: ['d'] } }, '0008103e')).toBe('d');
    expect(valueFromBlob(hdr({ '00180050': '2.5' }), '00180050', 'DECIMAL')).toEqual({ write: true, value: 2.5 });
    expect(valueFromBlob(null, '00180050', 'DECIMAL')).toEqual({ write: false });
    expect(valueFromBlob(Buffer.from('not gzip'), '00180050', 'DECIMAL')).toEqual({ write: false });
  });
});

// ── in-memory model ──────────────────────────────────────────────────────────
let db;
function model({ level = 'INSTANCE', tag = '00180050', type = 'DECIMAL', col = 'slicethickness', job = {}, rows = {} } = {}) {
  db = {
    def: { id: 'd1', target_type: 'STORAGE', virtual_folder_id: null, dicom_tag: tag, dicom_level: level, physical_column: col, data_type: type },
    job: { def_id: 'd1', status: 'PENDING', chain_token: 't0', cursor_pkey: 0, max_pkey: null, hops: 0, ...job },
    instances: rows.instances || [], // {pk, series, deleted, meta}
    series: rows.series || [], // {pk, study, deleted}
    study: rows.study || [],
    patient: rows.patient || [],
    writes: [],
    failNextTx: [],
  };
  mockQuery.mockImplementation(async (sql, p = []) => {
    const j = db.job;
    if (sql.includes('FROM index_attribute_backfill_jobs j')) return j ? [{ ...j, ...db.def }] : [];
    if (sql.includes('SELECT chain_token, status, cursor_pkey')) return j ? [{ ...j }] : [];
    if (sql.includes('COALESCE(MAX(')) {
      const t = { instance: db.instances, series: db.series, study: db.study, patient: db.patient }[sql.match(/FROM `(\w+)`/)[1]];
      return [{ m: t.reduce((a, r) => Math.max(a, r.pk), 0) }];
    }
    if (sql.includes("SET status = 'RUNNING', max_pkey")) {
      if (j.chain_token === p[2] && j.max_pkey == null) Object.assign(j, { status: 'RUNNING', max_pkey: p[0] });
      return [];
    }
    if (sql.includes("SET status = 'RUNNING' WHERE")) { if (j.chain_token === p[1]) j.status = 'RUNNING'; return []; }
    if (sql.includes('SET status = ?, error = ?')) {
      if (j.chain_token === p[4]) Object.assign(j, { status: p[0], error: p[1] });
      return [];
    }
    if (sql.includes('SET chain_token = ? WHERE def_id = ? AND chain_token = ?')) {
      if (j.chain_token === p[2]) j.chain_token = p[0];
      return [];
    }
    if (sql.includes('FROM instance i LEFT JOIN Instancemetadata')) {
      const [cur, max, lim] = p;
      return db.instances.filter(r => r.pk > cur && r.pk <= max && !r.deleted).slice(0, lim).map(r => ({ pk: r.pk, metadata: r.meta || null }));
    }
    const lvl = sql.match(/^\s*SELECT (\w+)_pkey AS pk FROM `(\w+)`/);
    if (lvl) {
      const [cur, max, lim] = p;
      return db[lvl[2]].filter(r => r.pk > cur && r.pk <= max && !r.deleted).slice(0, lim).map(r => ({ pk: r.pk }));
    }
    if (sql.includes('FROM series se WHERE se.series_pkey IN')) {
      return p.map(pk => {
        const live = db.instances.filter(i => i.series === pk && !i.deleted).map(i => i.pk);
        return { pk, rep: live.length ? Math.max(...live) : null };
      });
    }
    if (sql.includes('FROM study p WHERE p.study_pkey IN')) {
      return p.map(pk => { const c = db.series.filter(s => s.study === pk && !s.deleted).map(s => s.pk); return { pk, rep: c.length ? Math.max(...c) : null }; });
    }
    if (sql.includes('FROM patient p WHERE p.patient_pkey IN')) {
      return p.map(pk => { const c = db.study.filter(s => s.patient === pk && !s.deleted).map(s => s.pk); return { pk, rep: c.length ? Math.max(...c) : null }; });
    }
    if (sql.includes('FROM Instancemetadata WHERE instance_pkey IN')) {
      return db.instances.filter(i => p.includes(i.pk) && i.meta).map(i => ({ ipk: i.pk, metadata: i.meta }));
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`);
  });
  mockTransaction.mockImplementation(async (stmts) => {
    if (db.failNextTx.length) throw db.failNextTx.shift();
    const out = [];
    for (const s of stmts) {
      const p = s.parameters || [];
      const j = db.job;
      if (s.sql.includes('SET cursor_pkey = ?')) {
        if (j && j.chain_token === p[4] && j.cursor_pkey === p[5] && j.status === 'RUNNING') {
          j.cursor_pkey = p[0]; j.rows_scanned = (j.rows_scanned || 0) + p[1]; j.rows_written = (j.rows_written || 0) + p[2];
        }
        out.push([]);
      } else if (s.sql.includes(' = CASE ')) {
        const n = (p.length) / 3;
        for (let i = 0; i < n; i++) db.writes.push({ sql: s.sql, pk: p[2 * i], value: p[2 * i + 1] });
        out.push([]);
      } else if (s.sql.includes('SET chain_token = ?, hops = hops + 1')) {
        if (j.chain_token === p[2] && j.status === 'RUNNING') { j.chain_token = p[0]; j.hops += 1; }
        out.push([]);
      } else if (s.sql.includes('SELECT chain_token FROM')) {
        out.push([{ chain_token: j.chain_token }]);
      } else out.push([]);
    }
    return out;
  });
}

beforeEach(() => { mockQuery.mockReset(); mockTransaction.mockReset(); mockSend.mockReset(); mockSend.mockResolvedValue({}); });

const rec = (body, receive = 1) => ({ Records: [{ body: JSON.stringify(body), attributes: { ApproximateReceiveCount: String(receive) } }] });
const ctx = (ms = 300000) => ({ getRemainingTimeInMillis: () => ms });

describe('runStep', () => {
  test('INSTANCE level: snapshots the range, writes each live instance from its own header, finishes DONE', async () => {
    model({
      rows: {
        instances: [
          { pk: 1, meta: hdr({ '00180050': '1.25' }) },
          { pk: 2, meta: hdr({ '00080070': 'no thickness' }) },
          { pk: 3, deleted: true, meta: hdr({ '00180050': '9' }) },
          { pk: 4, meta: null },
          { pk: 5, meta: hdr({ '00180050': '2.5' }) },
        ],
      },
    });
    const out = await _test.runStep({ defId: 'd1', token: 't0' }, 300000);
    expect(out).toBe('done');
    expect(db.job).toMatchObject({ status: 'DONE', max_pkey: 5, cursor_pkey: 5 });
    expect(db.writes.map(w => [w.pk, w.value])).toEqual([[1, 1.25], [2, null], [5, 2.5]]);
    expect(db.writes[0].sql).toMatch(/UPDATE `instance` SET `slicethickness` = CASE instance_pkey/);
    expect(mockSend).not.toHaveBeenCalled();
    // Every batch transaction bounds its lock wait and resets it.
    for (const [stmts] of mockTransaction.mock.calls) {
      expect(stmts[0].sql).toMatch(/innodb_lock_wait_timeout = 5/);
      expect(stmts[stmts.length - 1].sql).toMatch(/innodb_lock_wait_timeout = DEFAULT/);
    }
  });

  test('rows above the snapshot are left to ingest (bounded walk)', async () => {
    model({ job: { status: 'RUNNING', max_pkey: 1 }, rows: { instances: [{ pk: 1, meta: hdr({ '00180050': '1' }) }, { pk: 2, meta: hdr({ '00180050': '2' }) }] } });
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 300000)).toBe('done');
    expect(db.writes.map(w => w.pk)).toEqual([1]);
  });

  test('SERIES level: one write per live series from its latest live instance', async () => {
    model({
      level: 'SERIES', tag: '00080070', type: 'STRING', col: 'manufacturer',
      rows: {
        series: [{ pk: 10, study: 1 }, { pk: 11, study: 1 }, { pk: 12, study: 1, deleted: true }],
        instances: [
          { pk: 1, series: 10, meta: hdr({ '00080070': 'OLD' }) },
          { pk: 2, series: 10, meta: hdr({ '00080070': 'NEW' }) },
          { pk: 3, series: 10, deleted: true, meta: hdr({ '00080070': 'GONE' }) },
          { pk: 4, series: 11, deleted: true, meta: hdr({ '00080070': 'X' }) },
        ],
      },
    });
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 300000)).toBe('done');
    expect(db.writes.map(w => [w.pk, w.value])).toEqual([[10, 'NEW']]); // 11 has no live instance
  });

  test('PATIENT level resolves study -> series -> instance', async () => {
    model({
      level: 'PATIENT', tag: '00102160', type: 'STRING', col: 'ethnicgroup',
      rows: {
        patient: [{ pk: 100 }],
        study: [{ pk: 50, patient: 100 }],
        series: [{ pk: 10, study: 50 }],
        instances: [{ pk: 7, series: 10, meta: hdr({ '00102160': 'E1' }) }],
      },
    });
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 300000)).toBe('done');
    expect(db.writes.map(w => [w.pk, w.value])).toEqual([[100, 'E1']]);
    expect(db.writes[0].sql).toMatch(/UPDATE `patient` SET `ethnicgroup`/);
  });

  test('a stale token does nothing', async () => {
    model({ job: { chain_token: 'newer' }, rows: { instances: [{ pk: 1, meta: hdr({ '00180050': '1' }) }] } });
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 300000)).toBe('superseded');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  test('out of time: rotates the token once and sends exactly one next message', async () => {
    model({ rows: { instances: [1, 2, 3, 4, 5].map(pk => ({ pk, meta: hdr({ '00180050': String(pk) }) })) } });
    // 0 ms left: the step still runs one batch, then hands off.
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 0)).toBe('handed-off');
    expect(db.job.cursor_pkey).toBe(2);
    expect(db.job.hops).toBe(1);
    expect(db.job.chain_token).not.toBe('t0');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockSend.mock.calls[0][0].input.MessageBody)).toEqual({ defId: 'd1', token: db.job.chain_token });
    // A duplicate of the consumed message is now stale.
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 0)).toBe('superseded');
    // The chain resumes from the cursor.
    expect(await _test.runStep({ defId: 'd1', token: db.job.chain_token }, 300000)).toBe('done');
    expect(db.writes.map(w => w.pk)).toEqual([1, 2, 3, 4, 5]);
  });

  test('a failed next-message send gives the token back and throws', async () => {
    model({ rows: { instances: [1, 2, 3].map(pk => ({ pk, meta: hdr({ '00180050': '1' }) })) } });
    mockSend.mockRejectedValueOnce(new Error('sqs down'));
    await expect(_test.runStep({ defId: 'd1', token: 't0' }, 0)).rejects.toThrow('sqs down');
    expect(db.job.chain_token).toBe('t0');
  });

  test('hard stop on the hop cap', async () => {
    model({ job: { hops: 100000, status: 'RUNNING', max_pkey: 9 } });
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 300000)).toBe('failed');
    expect(db.job.status).toBe('FAILED');
    expect(db.job.error).toMatch(/hard stop/);
  });

  test('a VF def is never back-filled', async () => {
    model();
    db.def.target_type = 'VF'; db.def.virtual_folder_id = 'e2f2e9ae-09a1-487f-803a-79bf13619460';
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 300000)).toBe('failed');
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});

describe('deadlocks', () => {
  const deadlock = () => Object.assign(new Error('Deadlock found'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });
  test('a deadlocked batch is rolled back and retried; the cursor advances once', async () => {
    model({ rows: { instances: [{ pk: 1, meta: hdr({ '00180050': '1' }) }] } });
    db.failNextTx.push(deadlock());
    expect(await _test.runStep({ defId: 'd1', token: 't0' }, 300000)).toBe('done');
    expect(db.job.cursor_pkey).toBe(1);
    expect(db.writes).toHaveLength(1);
  });
  test('a persistent deadlock is re-thrown, never swallowed', async () => {
    model({ rows: { instances: [{ pk: 1, meta: hdr({ '00180050': '1' }) }] } });
    db.failNextTx.push(deadlock(), deadlock(), deadlock());
    await expect(_test.runStep({ defId: 'd1', token: 't0' }, 300000)).rejects.toMatchObject({ errno: 1213 });
    expect(db.job.cursor_pkey).toBe(0);
  });
  test('withDeadlockRetry does not retry other errors', async () => {
    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('bad column'), { errno: 1054 }));
    await expect(_test.withDeadlockRetry(fn, 3, 1)).rejects.toThrow('bad column');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('handler', () => {
  test('an early failed attempt throws so SQS redelivers', async () => {
    model({ rows: { instances: [{ pk: 1, meta: hdr({ '00180050': '1' }) }] } });
    db.failNextTx.push(new Error('boom'));
    await expect(handler(rec({ defId: 'd1', token: 't0' }, 1), ctx())).rejects.toThrow('boom');
  });
  test('the last attempt marks the job FAILED and drops the message', async () => {
    model({ rows: { instances: [{ pk: 1, meta: hdr({ '00180050': '1' }) }] } });
    db.failNextTx.push(new Error('boom'));
    await expect(handler(rec({ defId: 'd1', token: 't0' }, 3), ctx())).resolves.toBeUndefined();
    expect(db.job.status).toBe('FAILED');
    expect(db.job.error).toMatch(/boom.*resumes/);
  });
  test('a message for a deleted def is acknowledged', async () => {
    model(); db.job = null;
    await expect(handler(rec({ defId: 'd1', token: 't0' }), ctx())).resolves.toBeUndefined();
  });
});
