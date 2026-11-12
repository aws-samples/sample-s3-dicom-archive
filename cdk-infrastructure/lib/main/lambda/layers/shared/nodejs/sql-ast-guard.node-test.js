// Run: node --test sql-ast-guard.node-test.js (from this directory; needs node_modules).
const test = require('node:test');
const assert = require('node:assert/strict');
const { guardSql } = require('./sql-ast-guard');

const STORAGE = new Set(['storage_index', 'patient', 'study', 'series', 'instance']);
const VFDB = 'vf_0123456789abcdef0123456789abcdef';
const VF = new Set([`${VFDB}_patient`, `${VFDB}_study`, `${VFDB}_series`, `${VFDB}_instance`]);

const storage = (sql, ids = ['DS1']) => guardSql(sql, { allowTables: STORAGE, scope: { kind: 'storage', ids } });
const vf = (sql) => guardSql(sql, { allowTables: VF, scope: { kind: 'vf', ids: ['0123'] }, vfDb: VFDB });

function rejects(r, re) {
  assert.equal(r.ok, false, `expected rejection, got: ${r.sql}`);
  if (re) assert.match(r.message, re);
}

// Every base-table alias in the output must carry the predicate. Count reads vs predicates.
function scopedCount(sql) { return (sql.match(/`datastore_id` IN \('DS1'\)/g) || []).length; }

test('plain select gets the predicate on its base table', () => {
  const r = storage('SELECT * FROM patient');
  assert.ok(r.ok);
  assert.equal(scopedCount(r.sql), 1);
});

test('D-2 comma join: both tables scoped', () => {
  const r = storage('SELECT a.* FROM study a, patient b');
  assert.ok(r.ok);
  assert.equal(scopedCount(r.sql), 2);
});

test('D-2 STRAIGHT_JOIN is rejected', () => {
  rejects(storage('SELECT * FROM study a STRAIGHT_JOIN patient b ON a.patient_pkey = b.patient_pkey'));
});

test('D-2 shared table inside a VF query is rejected (comma join)', () => {
  rejects(vf(`SELECT a.* FROM ${VFDB}.${VFDB}_patient a, patient b`), /not permitted/);
  rejects(vf(`SELECT * FROM ${VFDB}_patient a JOIN Instancemetadata m ON 1=1`), /not permitted/);
  rejects(vf('SELECT * FROM vf_ffffffffffffffffffffffffffffffff.vf_ffffffffffffffffffffffffffffffff_patient'), /not permitted/);
});

test('VF query on its own tree is accepted without a row predicate', () => {
  const r = vf(`SELECT p.patientname FROM ${VFDB}.${VFDB}_patient p JOIN ${VFDB}_study s ON s.patient_pkey = p.patient_pkey`);
  assert.ok(r.ok, r.message);
  assert.doesNotMatch(r.sql, /datastore_id/);
});

test('D-4 projected alias cannot escape: predicate is inside, on the physical row', () => {
  const r = storage("SELECT i.content_pkey, 'DS1' AS datastore_id FROM instance i WHERE i.datastore_id = 'DS2'");
  assert.ok(r.ok);
  assert.match(r.sql, /`i`\.`datastore_id` IN \('DS1'\)/);
});

test('derived tables, CTEs, subqueries in every clause and UNION arms are all scoped', () => {
  const cases = [
    ['SELECT * FROM (SELECT * FROM patient) x', 1],
    ['WITH c AS (SELECT * FROM patient) SELECT * FROM c', 1],
    ['SELECT * FROM study WHERE patient_pkey IN (SELECT patient_pkey FROM patient)', 2],
    ['SELECT (SELECT GROUP_CONCAT(patientname) FROM patient) AS x FROM study LIMIT 1', 2],
    ['SELECT * FROM study UNION SELECT * FROM study', 2],
    ['SELECT * FROM study s JOIN (SELECT * FROM series) z ON z.study_pkey = s.study_pkey', 2],
    ['SELECT * FROM study WHERE EXISTS (SELECT 1 FROM patient p WHERE p.x = 1)', 2],
    ['SELECT * FROM study s ORDER BY (SELECT COUNT(*) FROM series)', 2],
    ['SELECT modality, COUNT(*) FROM series GROUP BY modality HAVING COUNT(*) > (SELECT COUNT(*) FROM study)', 2],
    ['SELECT * FROM study s JOIN series se ON se.study_pkey = s.study_pkey AND se.x IN (SELECT y FROM instance)', 3],
    ['WITH a AS (SELECT * FROM patient), b AS (SELECT * FROM a JOIN study st ON 1=1) SELECT * FROM b', 2],
  ];
  for (const [sql, n] of cases) {
    const r = storage(sql);
    assert.ok(r.ok, `${sql}: ${r.message}`);
    assert.equal(scopedCount(r.sql), n, `${sql}\n=> ${r.sql}`);
  }
});

test('a CTE cannot shadow a real table inside its own body', () => {
  rejects(storage('WITH users AS (SELECT * FROM users) SELECT * FROM users'), /not permitted: users/);
  const r = storage('WITH patient AS (SELECT * FROM patient) SELECT * FROM patient');
  assert.ok(r.ok);
  assert.equal(scopedCount(r.sql), 1); // the inner, real patient read is scoped
});

// C01-GEN-01: Aurora/MySQL default to lower_case_table_names=0, so a CTE named
// `Patient` does NOT satisfy a later `FROM patient` — MySQL reads the real,
// unscoped `patient` table. The guard rejects such case-insensitive collisions
// outright (fix #1), so the "already scoped" shortcut can never be mis-applied.
test('C01-GEN-01: case-mismatched CTE colliding with a base table is rejected', () => {
  for (const sql of [
    'WITH Patient AS (SELECT * FROM patient) SELECT * FROM patient',
    'WITH STUDY AS (SELECT * FROM study) SELECT * FROM study',
    'WITH PATIENT AS (SELECT 1 AS n) SELECT * FROM patient',
    'WITH Patient AS (SELECT * FROM study) SELECT * FROM Patient',
    'WITH STUDY AS (SELECT * FROM study) SELECT * FROM STUDY',
  ]) {
    rejects(storage(sql), /collides with a base table/);
  }
});

test('C01-GEN-01: byte-identical lowercase CTE still resolves as the CTE', () => {
  // `WITH patient AS (...) ... FROM patient` is safe: MySQL resolves the FROM to
  // the CTE (same byte string). The real read inside the CTE body is scoped once.
  const r = storage('WITH patient AS (SELECT * FROM patient) SELECT patientname FROM patient');
  assert.ok(r.ok, r.message);
  assert.equal(scopedCount(r.sql), 1);
});

test('C01-GEN-01: a distinctly-named CTE wrapping a base table is still fine', () => {
  // No name collision: CTE `pats` wraps the scoped read; the outer FROM pats is
  // the CTE. One scoped base-table read inside the body.
  const r = storage('WITH pats AS (SELECT * FROM patient) SELECT * FROM pats');
  assert.ok(r.ok, r.message);
  assert.equal(scopedCount(r.sql), 1);
});

test('LEFT JOIN predicate goes into ON, keeping outer rows', () => {
  const r = storage('SELECT * FROM study s LEFT JOIN series se ON se.study_pkey = s.study_pkey');
  assert.ok(r.ok);
  assert.match(r.sql, /LEFT JOIN `series` AS `se` ON \(`se`\.`study_pkey` = `s`\.`study_pkey`\) AND \(`se`\.`datastore_id` IN \('DS1'\)\)/);
  assert.match(r.sql, /WHERE `s`\.`datastore_id` IN \('DS1'\)/);
});

test('RIGHT and FULL joins are rejected', () => {
  rejects(storage('SELECT * FROM study s RIGHT JOIN series se ON 1=1'), /not supported/);
  rejects(storage('SELECT * FROM study s FULL JOIN series se ON 1=1'), /not supported/);
});

test('tables outside the allowlist or another database are rejected', () => {
  for (const sql of [
    'SELECT * FROM users',
    'SELECT * FROM privilege_groups',
    'SELECT * FROM Instancemetadata',
    'SELECT * FROM virtual_folder_assignments',
    'SELECT * FROM dicomarchive.patient',
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM mysql.user',
    'SELECT * FROM study WHERE x IN (SELECT id FROM users)',
    'SELECT * FROM DUAL',
    'SELECT 1',
  ]) rejects(storage(sql));
});

test('writes, INTO, locking, variables and dangerous functions are rejected', () => {
  for (const sql of [
    "UPDATE patient SET patientname = 'x'",
    'DELETE FROM patient',
    'SELECT 1 FROM patient; DROP TABLE patient',
    "SELECT * FROM patient INTO OUTFILE '/tmp/x'",
    'SELECT * FROM patient FOR UPDATE',
    'SELECT * FROM patient LOCK IN SHARE MODE',
    'SELECT @x := 1 FROM patient',
    'SELECT @@version FROM patient',
    'SELECT SLEEP(5) FROM patient',
    'SELECT BENCHMARK(1000000, MD5(1)) FROM patient',
    "SELECT LOAD_FILE('/etc/passwd') FROM patient",
    "SELECT GET_LOCK('x', 10) FROM patient",
    'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r',
  ]) rejects(storage(sql));
});

test('executable comments never reach the database', () => {
  const r = storage('SELECT * FROM patient /*! UNION SELECT * FROM users */');
  assert.ok(r.ok);
  assert.doesNotMatch(r.sql, /users|\/\*/);
});

test('string literals that contain SQL stay literals', () => {
  const r = storage("SELECT * FROM patient WHERE patientname = 'x\\' UNION SELECT * FROM users -- '");
  assert.ok(r.ok);
  assert.equal(scopedCount(r.sql), 1);
});

test("'*' scope keeps the allowlist but adds no predicate", () => {
  const r = storage('SELECT * FROM patient', ['*']);
  assert.ok(r.ok);
  assert.doesNotMatch(r.sql, /datastore_id/);
  rejects(storage('SELECT * FROM users', ['*']));
});

test('empty scope and malformed ids are rejected', () => {
  rejects(storage('SELECT * FROM patient', []));
  rejects(storage('SELECT * FROM patient', ["x') OR 1=1 -- "]));
});

test('typical analytics queries still pass', () => {
  for (const sql of [
    'SELECT st.studyinstanceuid, st.studydate, p.patientname FROM study st JOIN patient p ON p.patient_pkey = st.patient_pkey WHERE LOWER(st.studydescription) LIKE \'%brain%\' ORDER BY st.studydate DESC LIMIT 20',
    'SELECT se.modality, COUNT(*) AS n FROM series se GROUP BY se.modality ORDER BY n DESC',
    'SELECT SUM(si.size_bytes) AS total FROM storage_index si',
    'SELECT i.content_pkey, i.datastore_id, s.seriesinstanceuid AS series_instance_uid FROM instance i JOIN series s ON s.series_pkey = i.series_pkey WHERE s.modality = \'MR\'',
    'SELECT DISTINCT s.datastore_id, st.studyinstanceuid AS study_instance_uid, s.seriesinstanceuid AS series_instance_uid FROM series s JOIN study st ON st.study_pkey = s.study_pkey',
  ]) {
    const r = storage(sql);
    assert.ok(r.ok, `${sql}: ${r.message}`);
  }
});

// H2-XSS-01: a quoted identifier holding a backtick parsed as one alias but was
// re-serialized unescaped, so the executed SQL carried an unscoped UNION and a
// comment that swallowed the scope predicate.
const BACKTICK_BYPASSES = [
  'SELECT p.patientname AS "x` FROM patient UNION SELECT patientname FROM patient -- " FROM patient p',
  "SELECT p.patientname AS 'x` FROM patient UNION SELECT patientname FROM patient -- ' FROM patient p",
  'SELECT x.patientname FROM patient AS "x` UNION SELECT patientname FROM patient -- "',
  'WITH c AS (SELECT p.patientname FROM patient p) SELECT * FROM c AS "q` UNION SELECT patientname FROM patient -- "',
  'SELECT p.patientname AS "a\\" FROM patient UNION SELECT 1 -- " FROM patient p',
];

test('H2-XSS-01: quote or backslash inside an identifier is rejected (storage scope)', () => {
  for (const sql of BACKTICK_BYPASSES) rejects(storage(sql), /Identifiers may not contain/);
});

test('H2-XSS-01: same bypass rejected in virtual-folder scope', () => {
  rejects(vf(`SELECT p.patientname AS "x\` FROM ${VFDB}_patient UNION SELECT patientname FROM ${VFDB}_patient -- " FROM ${VFDB}_patient p`), /Identifiers may not contain/);
});

test('H2-XSS-01: no accepted query executes text that re-parses differently', () => {
  const { Parser } = require('node-sql-parser');
  const p = new Parser();
  for (const sql of [
    "SELECT p.patientname FROM patient p WHERE p.patientname = 'O''Brien'",
    "SELECT p.patientname FROM patient p WHERE p.patientname = 'a\\' OR 1=1 -- '",
    'SELECT p.patientname FROM patient p WHERE p.patientname = "x` UNION SELECT 1 -- "',
    'SELECT se.modality, COUNT(*) AS n FROM series se GROUP BY se.modality',
  ]) {
    const r = storage(sql);
    assert.ok(r.ok, `${sql}: ${r.message}`);
    assert.equal(p.sqlify(p.astify(r.sql, { database: 'MySQL' }), { database: 'MySQL' }), r.sql);
    assert.equal(scopedCount(r.sql), 1, r.sql);
  }
});

test('H2-XSS-01: string literals may still contain quotes and backticks', () => {
  const r = storage('SELECT st.studydescription FROM study st WHERE st.studydescription LIKE \'%`x"%\'');
  assert.ok(r.ok, r.message);
  assert.equal(scopedCount(r.sql), 1);
});

test('liveTables: every read of a listed table excludes soft-deleted rows', () => {
  const live = (sql) => guardSql(sql, { allowTables: STORAGE, scope: { kind: 'storage', ids: ['DS1'] }, liveTables: ['series', 'instance'] });
  const r = live('SELECT se.modality, COUNT(i.instance_pkey) n FROM series se LEFT JOIN instance i ON i.series_pkey = se.series_pkey '
    + 'WHERE se.series_pkey IN (SELECT x.series_pkey FROM series x) GROUP BY se.modality');
  assert.ok(r.ok, r.message);
  assert.equal(scopedCount(r.sql), 3);
  assert.equal((r.sql.match(/`deleted_at` IS NULL/g) || []).length, 3);
  // The LEFT JOIN's filter goes in ON, so series with no live instances are kept.
  assert.match(r.sql, /LEFT JOIN `instance` AS `i` ON \(.*\) AND \(`i`.`datastore_id` IN \('DS1'\) AND `i`.`deleted_at` IS NULL\)/);
  // A table not listed gets no soft-delete filter.
  const s = live('SELECT p.patientid FROM patient p');
  assert.ok(s.ok);
  assert.doesNotMatch(s.sql, /deleted_at/);
  // Default (no liveTables): unchanged behaviour.
  assert.doesNotMatch(storage('SELECT se.modality FROM series se').sql, /deleted_at/);
});
