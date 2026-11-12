/**
 * index-attributes-api — configure user-defined DICOM tags as columns on the
 * index tables.
 *
 * MODEL (Phase 6, VF Per-Database redesign):
 *   - STORAGE defs are ONE GLOBAL structure (virtual_folder_id IS NULL): custom
 *     columns on the shared patient/study/series/instance tree in `dicomarchive`,
 *     shared by all datastores.
 *   - VF defs are PER-VIRTUAL-FOLDER (virtual_folder_id = the VF id): each VF has
 *     its own set of custom columns on its own `vf_<id>` database tree
 *     (vf_<id>_patient/study/series/instance). A VF starts from renderTreeDDL's
 *     base columns; a def ALTERs a custom column onto that ONE VF's database.
 *   - Population is UNCONDITIONAL: every defined column is populated by ingest.
 *     There is NO per-scope opt-in ("Population" tab removed).
 *   - BACK-FILL: adding a STORAGE def starts an async back-fill job that fills
 *     the column for rows indexed BEFORE the def existed, from the gzipped
 *     DICOM-JSON headers already stored in Instancemetadata (no S3 reads). The
 *     worker is the index-attributes-backfill lambda, driven by an SQS
 *     self-requeue chain; its state is the index_attribute_backfill_jobs row,
 *     returned on each def as `backfill` by GET /defs.
 *
 * ROUTES (only /defs remains):
 *     GET    /index-attributes/defs?targetType=STORAGE                    list global STORAGE defs (+ back-fill status) + built-ins
 *     GET    /index-attributes/defs?targetType=VF&virtualFolderId=<uuid>  list that VF's defs + its vf_<id> built-ins
 *     POST   /index-attributes/defs                                       add def (ALTER ADD COLUMN [+ CREATE INDEX]) + start back-fill
 *     POST   /index-attributes/defs  {action:'backfill', id[, restart]}   (re)start / resume the back-fill of an existing STORAGE def
 *     DELETE /index-attributes/defs/{id}                                  drop def (column left in place; its back-fill job row cascades)
 * The back-fill action rides the POST /defs route on purpose: it needs exactly
 * the privilege of adding an attribute (indexAttributes.canEdit in the API
 * authorizer), so it gets that privilege without a new API route.
 */
const { query, execute, transaction } = require('/opt/nodejs/database');
const { randomUUID } = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

// Back-fill queue (index-attributes-backfill worker). Unset = back-fill disabled
// (the def is still created; the response says the back-fill did not start).
const BACKFILL_QUEUE_URL = process.env.BACKFILL_QUEUE_URL || '';
// First message is delayed past the ingest workers' 60 s attribute-list cache,
// so every row the back-fill does NOT cover (pkey above the snapshot it takes
// when it starts) was written by an ingest that already knew the new def.
const BACKFILL_START_DELAY_S = Math.max(0, Math.min(900, parseInt(process.env.BACKFILL_START_DELAY_S || '90', 10) || 0));
// A RUNNING/PENDING job with no progress for this long is reported as stalled;
// the Back-fill action then resumes it from its cursor.
const BACKFILL_STALL_S = Math.max(60, parseInt(process.env.BACKFILL_STALL_S || '900', 10) || 900);
let _sqs = null;
function sqs() { return _sqs || (_sqs = new SQSClient({})); }

// Upper bound (seconds) on how long an ALTER TABLE / CREATE INDEX waits for the
// table's metadata lock. MySQL's default lock_wait_timeout is a year: a DDL that
// cannot get the lock (any open transaction that has read the table holds it)
// sits in the lock queue and blocks EVERY later read and write of that table —
// ingest, QIDO, delete — until the holder goes away, and it keeps waiting on the
// server after this Lambda has timed out. Bounding the wait turns that table-
// wide stall into a fast, retryable 503 for the admin. Two DDLs per add must fit
// in the 30 s Lambda timeout.
const DDL_LOCK_WAIT_S = Math.max(1, Math.min(12, parseInt(process.env.INDEX_ATTR_DDL_LOCK_WAIT_S || '8', 10) || 8));

class TableBusyError extends Error {}

// Run one DDL statement with a bounded metadata-lock wait, on ONE pooled
// connection (the SET SESSION must reach the same session as the DDL). The DDL
// commits implicitly inside transaction(); the trailing COMMIT is then a no-op.
// If the DDL fails, the reset is skipped and that pooled connection keeps the
// short wait: harmless here, this function only runs short admin statements.
async function runDdl(sql) {
  try {
    await transaction([
      { sql: `SET SESSION lock_wait_timeout = ${DDL_LOCK_WAIT_S}` },
      { sql },
      { sql: 'SET SESSION lock_wait_timeout = DEFAULT' },
    ]);
  } catch (e) {
    if (e && (e.errno === 1205 || e.code === 'ER_LOCK_WAIT_TIMEOUT')) throw new TableBusyError(e.message);
    throw e;
  }
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
};

// STORAGE target -> shared tree tables in the connection's default DB (dicomarchive).
const STORAGE_LEVEL_TABLE = { PATIENT: 'patient', STUDY: 'study', SERIES: 'series', INSTANCE: 'instance' };
// VF per-level table BASENAME suffix. The real table is `<vfDb>`.`<vfDb>_<suffix>`
// (see vf-database.js renderTreeDDL: vf_<id>_patient/study/series/instance).
const VF_LEVEL_SUFFIX = { PATIENT: 'patient', STUDY: 'study', SERIES: 'series', INSTANCE: 'instance' };

// DICOM VR -> SQL type (see original notes: DS defaults STRING, opt-in DECIMAL).
const SQL_TYPE = { STRING: 'VARCHAR(255)', INT: 'INT', DATE: 'DATE', DECIMAL: 'DECIMAL(18,6)' };
const COLUMN_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TAG_RE = /^[0-9A-Fa-f]{8}$/;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Inlined from virtual-folder-api/vf-database.js vfDbName() — CDK Docker
// bundling mounts only this lambda's own dir, so a cross-lambda require is not
// possible at runtime. Scheme MUST stay byte-identical to vf-database.js:
//   'vf_' + uuid.toLowerCase().replace(/-/g,'') -> 'vf_' + 32 hex.
// Built ONLY from a validated UUID so no unvalidated input reaches DDL.
function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}

// Resolve the fully-qualified, backtick-quoted target table for a def.
//   STORAGE -> `patient` (default DB) ; VF -> `vf_<id>`.`vf_<id>_patient`.
function vfLevelTable(vfDb, level) {
  const suffix = VF_LEVEL_SUFFIX[level];
  return { schema: vfDb, table: `${vfDb}_${suffix}` };
}

function resp(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function toCamel(obj) {
  const o = {};
  for (const k in obj) {
    if (k === 'scope_key') continue; // generated uniqueness key, not API data
    o[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = obj[k];
  }
  return o;
}

// A duplicate-key error from MySQL (uq_def / uq_def_scope).
function isDuplicateKey(e) {
  return !!e && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY' || /Duplicate entry/i.test(e.message || ''));
}

// Self-heal migration: schema.sql creates index_attribute_defs on fresh installs,
// but a persistent DB reached through migrations may lack the virtual_folder_id
// column or the re-keyed UNIQUE. Reconcile idempotently on first use so the API
// never 500s on a partial DB. MySQL 8/Aurora rejects ADD COLUMN IF NOT EXISTS,
// so gate on an information_schema check.
let _schemaEnsured = false;
async function ensureSchema() {
  if (_schemaEnsured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS index_attribute_defs (
      id VARCHAR(36) PRIMARY KEY,
      target_type ENUM('STORAGE','VF') NOT NULL,
      virtual_folder_id VARCHAR(36) NULL,
      dicom_tag VARCHAR(8) NOT NULL,
      dicom_level ENUM('PATIENT','STUDY','SERIES','INSTANCE') NOT NULL,
      column_name VARCHAR(64) NOT NULL,
      physical_column VARCHAR(64) NOT NULL,
      data_type ENUM('STRING','INT','DATE','DECIMAL') NOT NULL DEFAULT 'STRING',
      is_indexed BOOLEAN NOT NULL DEFAULT FALSE,
      description TEXT,
      created_by VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      scope_key VARCHAR(36) GENERATED ALWAYS AS (IFNULL(virtual_folder_id, '')) STORED NOT NULL,
      UNIQUE KEY uq_def (target_type, virtual_folder_id, dicom_level, physical_column),
      UNIQUE KEY uq_def_scope (target_type, scope_key, dicom_level, physical_column),
      KEY idx_type (target_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Same definition as schema.sql (db-init); a no-op where it already exists.
  await query(`
    CREATE TABLE IF NOT EXISTS index_attribute_backfill_jobs (
      def_id VARCHAR(36) PRIMARY KEY,
      status ENUM('PENDING','RUNNING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
      chain_token VARCHAR(36) NOT NULL,
      cursor_pkey BIGINT UNSIGNED NOT NULL DEFAULT 0,
      max_pkey BIGINT UNSIGNED NULL,
      rows_scanned BIGINT UNSIGNED NOT NULL DEFAULT 0,
      rows_written BIGINT UNSIGNED NOT NULL DEFAULT 0,
      batches INT UNSIGNED NOT NULL DEFAULT 0,
      hops INT UNSIGNED NOT NULL DEFAULT 0,
      error TEXT NULL,
      requested_by VARCHAR(64) NULL,
      requested_at TIMESTAMP NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_iabf_status (status),
      CONSTRAINT fk_iabf_def FOREIGN KEY (def_id) REFERENCES index_attribute_defs (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Add virtual_folder_id to a pre-existing table if missing.
  const hasCol = await query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = 'index_attribute_defs' AND column_name = 'virtual_folder_id'");
  if (!hasCol.length) {
    await query('ALTER TABLE index_attribute_defs ADD COLUMN virtual_folder_id VARCHAR(36) NULL AFTER target_type');
  }

  // Re-key the UNIQUE to include virtual_folder_id if it still has the old shape.
  const uq = await query(
    "SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE table_schema = DATABASE() AND table_name = 'index_attribute_defs' AND index_name = 'uq_def' AND column_name = 'virtual_folder_id'");
  if (Number(uq[0]?.n || 0) === 0) {
    // Old uq_def exists without virtual_folder_id: drop and recreate. Wrapped so
    // a partial state (index already gone) does not abort the API.
    try { await query('ALTER TABLE index_attribute_defs DROP INDEX uq_def'); }
    catch (e) { console.warn('drop old uq_def skipped:', e.message); }
    try {
      await query('ALTER TABLE index_attribute_defs ADD UNIQUE KEY uq_def (target_type, virtual_folder_id, dicom_level, physical_column)');
    } catch (e) { console.warn('recreate uq_def skipped:', e.message); }
  }
  _schemaEnsured = true;
}

// Full DICOM dictionary -> `d<gggeeee>` column-name -> lower-case keyword lookup.
let _tagKeywordByCol = null;
function tagKeywordMap() {
  if (_tagKeywordByCol) return _tagKeywordByCol;
  const m = {};
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const dict = require('/opt/nodejs/dicom-tags.json');
    const attrs = (dict && dict.dicom_attributes) || [];
    for (const a of attrs) {
      if (!a || !a.tag || !a.keyword) continue;
      const col = 'd' + String(a.tag).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      if (col.length === 9) m[col] = String(a.keyword).toLowerCase();
    }
  } catch (e) {
    console.warn('dicom-tags dictionary unavailable:', e.message);
  }
  _tagKeywordByCol = m;
  return m;
}

// Resolve a physical column name to its lower-case DICOM attribute name.
function attributeNameFor(colName) {
  const name = String(colName || '');
  if (/^d[0-9a-f]{8}$/i.test(name)) {
    const lc = name.toLowerCase();
    return tagKeywordMap()[lc] || lc;
  }
  return name.toLowerCase();
}

// The physical column a tag maps to: its keyword form (matching the base schema
// standard-tag columns) if the dictionary knows it, else the raw d<tag> form so
// the create never fails on a private/unknown tag.
function physicalColumnForTag(dicomTag) {
  return attributeNameFor(`d${String(dicomTag).toLowerCase()}`);
}

const BUILTIN_TAG = {
  patientid: '00100020', patientname: '00100010', patientbirthdate: '00100030', patientsex: '00100040',
  issuerofpatientid: '00100021',
  studyinstanceuid: '0020000D', studydate: '00080020', studytime: '00080030', accessionnumber: '00080050',
  modalitiesinstudy: '00080061', referringphysicianname: '00080090', studydescription: '00081030', studyid: '00200010',
  numberofstudyrelatedseries: '00201206', numberofstudyrelatedinstances: '00201208',
  modality: '00080060', seriesdate: '00080021', seriesdescription: '0008103E',
  seriesinstanceuid: '0020000E', seriesnumber: '00200011',
  numberofseriesrelatedinstances: '00201209', patientposition: '00185100',
  transfersyntaxuid: '00020010', sopclassuid: '00080016', sopinstanceuid: '00080018',
  instanceavailability: '00080056', instancenumber: '00200013', imagelaterality: '00200062',
};

const BUILTIN_LABELS = {
  patientid: 'patientid', patientname: 'patientname',
  patientbirthdate: 'patientbirthdate', patientsex: 'patientsex',
  studyinstanceuid: 'studyinstanceuid', studydate: 'studydate',
  studytime: 'studytime', accessionnumber: 'accessionnumber',
  modalitiesinstudy: 'modalitiesinstudy', referringphysicianname: 'referringphysicianname',
  studydescription: 'studydescription', studyid: 'studyid',
  numberofstudyrelatedseries: 'numberofstudyrelatedseries', numberofstudyrelatedinstances: 'numberofstudyrelatedinstances',
};
const BUILTIN_HIDE = new Set([
  'patient_pkey', 'study_pkey', 'series_pkey', 'instance_pkey', 'content_pkey',
  'datastore_id', 'deleted_at', 'last_updated', 'instanceid', 'seriesid',
  'samplesperpixel', 'numberofframes', 'rows', 'columns', 'bitsallocated',
  'totalpixelmatrixcolumns', 'totalpixelmatrixrows', 'dimensionorganizationtype',
  'timezoneoffsetfromutc', 'retrieveurl',
  'performedprocedurestepstartdate', 'performedprocedurestepstarttime',
  'requestattributessequence', 'scheduledprocedurestepid', 'requestedprocedureid',
  'specificcharacterset',
  'imagecount', 'availability',
  // VF-tree plumbing (per-VF db built-ins).
  'virtual_folder_id', 'source_datastoreid', 'imageset_pkey',
]);
// A VF-tree column may be stored as a paired original_<f>/<f>; hide the
// original_ shadow from the built-in list (the de-id'd column is the attribute).
function isVfShadow(name) { return /^original_/.test(name); }

// Built-in (schema-defined) columns for the STORAGE tree, introspected from
// information_schema in the connection's default DB (dicomarchive).
async function storageBuiltinColumns() {
  const out = [];
  for (const [level, table] of Object.entries(STORAGE_LEVEL_TABLE)) {
    let cols, idx;
    try {
      cols = await query(
        "SELECT column_name AS col, data_type AS dtype FROM information_schema.COLUMNS WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position",
        [table]);
      idx = await query(
        "SELECT DISTINCT column_name AS col FROM information_schema.STATISTICS WHERE table_schema=DATABASE() AND table_name=? AND index_name <> 'PRIMARY'",
        [table]);
    } catch (e) { console.warn(`storageBuiltinColumns ${table} skipped:`, e.message); continue; }
    pushBuiltins(out, level, cols, idx);
  }
  return out;
}

// Built-in columns for a VF, introspected from that VF's OWN vf_<id> database
// (the shared virtual_* tables no longer exist post-Phase-5).
async function vfBuiltinColumns(vfDb) {
  const out = [];
  for (const [level, suffix] of Object.entries(VF_LEVEL_SUFFIX)) {
    const table = `${vfDb}_${suffix}`;
    let cols, idx;
    try {
      cols = await query(
        "SELECT column_name AS col, data_type AS dtype FROM information_schema.COLUMNS WHERE table_schema=? AND table_name=? ORDER BY ordinal_position",
        [vfDb, table]);
      idx = await query(
        "SELECT DISTINCT column_name AS col FROM information_schema.STATISTICS WHERE table_schema=? AND table_name=? AND index_name <> 'PRIMARY'",
        [vfDb, table]);
    } catch (e) { console.warn(`vfBuiltinColumns ${table} skipped:`, e.message); continue; }
    pushBuiltins(out, level, cols, idx);
  }
  return out;
}

function pushBuiltins(out, level, cols, idx) {
  const indexed = new Set(idx.map(r => r.col));
  for (const c of cols) {
    const name = c.col;
    if (!name || BUILTIN_HIDE.has(name) || isVfShadow(name)) continue;
    const label = BUILTIN_LABELS[name] || attributeNameFor(name);
    out.push({
      builtin: true,
      columnName: name,
      label: String(label).toLowerCase(),
      dicomTag: /^d[0-9a-f]{8}$/i.test(name) ? name.slice(1).toUpperCase() : (BUILTIN_TAG[name] || null),
      dicomLevel: level,
      dataType: c.dtype,
      isIndexed: indexed.has(name),
    });
  }
}

// ── /defs ────────────────────────────────────────────────────────────────────

async function listDefs(event) {
  const q = event.queryStringParameters || {};
  const targetType = (q.targetType || 'STORAGE').toUpperCase();
  if (!['STORAGE', 'VF'].includes(targetType))
    return resp(400, { success: false, error: 'targetType must be STORAGE or VF' });

  let rows, builtins = [];
  if (targetType === 'VF') {
    const vfId = q.virtualFolderId;
    if (!vfId || !UUID_RE.test(vfId))
      return resp(400, { success: false, error: 'virtualFolderId (a UUID) is required for targetType=VF' });
    rows = await query(
      "SELECT * FROM index_attribute_defs WHERE target_type = 'VF' AND virtual_folder_id = ? ORDER BY created_at",
      [vfId]);
    try { builtins = await vfBuiltinColumns(vfDbName(vfId)); }
    catch (e) { console.warn('vfBuiltinColumns skipped:', e.message); }
  } else {
    rows = await query(
      "SELECT * FROM index_attribute_defs WHERE target_type = 'STORAGE' AND virtual_folder_id IS NULL ORDER BY created_at");
    try { builtins = await storageBuiltinColumns(); }
    catch (e) { console.warn('storageBuiltinColumns skipped:', e.message); }
  }
  const jobs = targetType === 'STORAGE' ? await loadBackfillJobs() : {};
  const data = rows.map(toCamel).map(r => ({
    ...r,
    label: attributeNameFor(r.physicalColumn || r.columnName),
    ...(targetType === 'STORAGE' ? { backfill: formatJob(jobs[r.id]) } : {}),
  }));
  // A custom def's physical column is a real column on the table, so the
  // information_schema introspection returns it too. List it once, as the
  // (deletable) custom def, not again as a read-only built-in.
  const defCols = new Set(data.map(r => `${r.dicomLevel}:${r.physicalColumn}`));
  builtins = builtins.filter(c => !defCols.has(`${c.dicomLevel}:${c.columnName}`));
  return resp(200, { success: true, data, builtins });
}

async function addDef(event) {
  const b = JSON.parse(event.body || '{}');
  const targetType = (b.targetType || 'STORAGE').toUpperCase();
  const { dicomTag, dicomLevel, columnName } = b;
  const dataType = b.dataType || 'STRING';
  const isIndexed = b.isIndexed === true;

  if (!dicomTag || !dicomLevel || !columnName)
    return resp(400, { success: false, error: 'dicomTag, dicomLevel, columnName are required' });
  if (!['STORAGE', 'VF'].includes(targetType))
    return resp(400, { success: false, error: 'targetType must be STORAGE or VF' });
  if (!STORAGE_LEVEL_TABLE[dicomLevel])
    return resp(400, { success: false, error: 'dicomLevel must be PATIENT/STUDY/SERIES/INSTANCE' });
  if (!COLUMN_RE.test(columnName))
    return resp(400, { success: false, error: 'columnName must match ^[a-z][a-z0-9_]{0,63}$' });
  if (!TAG_RE.test(dicomTag))
    return resp(400, { success: false, error: 'dicomTag must be 8 hex chars, e.g. 00080070' });
  if (!SQL_TYPE[dataType])
    return resp(400, { success: false, error: 'dataType must be STRING/INT/DATE/DECIMAL' });

  const physicalCol = physicalColumnForTag(dicomTag);
  const sqlType = SQL_TYPE[dataType];

  // Resolve the target table + schema and the virtual_folder_id to persist.
  let vfId = null;
  let schema; // schema for information_schema checks + a DDL prefix
  let table;
  let qualifiedTable; // backtick-quoted, DDL-ready
  let schemaPredicateParams;
  let schemaClause;
  if (targetType === 'VF') {
    vfId = b.virtualFolderId;
    if (!vfId || !UUID_RE.test(vfId))
      return resp(400, { success: false, error: 'virtualFolderId (a UUID) is required for targetType=VF' });
    let vfDb;
    try { vfDb = vfDbName(vfId); }
    catch (e) { return resp(400, { success: false, error: e.message }); }
    const t = vfLevelTable(vfDb, dicomLevel);
    schema = t.schema;
    table = t.table;
    qualifiedTable = `\`${schema}\`.\`${table}\``;
    schemaClause = 'table_schema = ?';
    schemaPredicateParams = [schema];
  } else {
    schema = null; // default DB (dicomarchive)
    table = STORAGE_LEVEL_TABLE[dicomLevel];
    qualifiedTable = `\`${table}\``;
    schemaClause = 'table_schema = DATABASE()';
    schemaPredicateParams = [];
  }

  // Duplicate guard. uq_def cannot enforce this for STORAGE defs: their
  // virtual_folder_id is NULL and a MySQL UNIQUE index treats NULLs as distinct,
  // so the same tag could be defined twice at one level. Compare null-safely.
  const dup = await query(
    'SELECT id FROM index_attribute_defs WHERE target_type = ? AND virtual_folder_id <=> ? AND dicom_level = ? AND physical_column = ? LIMIT 1',
    [targetType, vfId, dicomLevel, physicalCol]);
  if (dup.length)
    return resp(409, { success: false, error: `A definition for that tag already exists at the ${dicomLevel} level${targetType === 'VF' ? ' for this virtual folder' : ' for STORAGE tables'}` });

  // Idempotent ADD COLUMN on the target table. May already exist (a base column,
  // or another def at the same level+tag) — fine.
  const existing = await query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE ${schemaClause} AND table_name = ? AND column_name = ?`,  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
    [...schemaPredicateParams, table, physicalCol]);
  if (!existing.length) {
    try {
      await runDdl(`ALTER TABLE ${qualifiedTable} ADD COLUMN \`${physicalCol}\` ${sqlType} NULL`);  // nosemgrep: javascript.express.security.injection.tainted-sql-string -- DDL identifiers are backtick-quoted, UUID/hex-tag validated and SQL type is allowlisted (audited)
    } catch (e) {
      if (e instanceof TableBusyError) {
        console.warn(`ADD COLUMN ${physicalCol} on ${table} gave up after ${DDL_LOCK_WAIT_S}s: ${e.message}`);
        return resp(503, {
          success: false,
          error: `The '${table}' table is in use by another database session, so the column could not be added ` +
            `without blocking the archive. Nothing was changed. Try again in a few minutes.`,
        });
      }
      throw e;
    }
  }

  // Optional secondary index — the ONLY place an index decision is made. 64-cap
  // handling preserved: on the cap we create the column but skip the index and
  // return a warning.
  const INDEX_CAP = 64;
  let indexWarning = null;
  let indexed = isIndexed;
  if (isIndexed) {
    const idxName = `idx_${physicalCol}`.slice(0, 64);
    const idxExists = await query(
      `SELECT 1 FROM information_schema.STATISTICS WHERE ${schemaClause} AND table_name = ? AND index_name = ?`,  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
      [...schemaPredicateParams, table, idxName]);
    if (!idxExists.length) {
      const idxRows = await query(
        `SELECT COUNT(DISTINCT index_name) AS n FROM information_schema.STATISTICS WHERE ${schemaClause} AND table_name = ? AND index_name <> 'PRIMARY'`,  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
        [...schemaPredicateParams, table]);
      const existingIndexes = Number(idxRows[0]?.n || 0);
      if (existingIndexes >= INDEX_CAP) {
        indexed = false;
        indexWarning =
          `The '${table}' table has reached the MySQL limit of ${INDEX_CAP} indexes per table. ` +
          `The attribute column was created but WITHOUT a database index — filtering or sorting on ` +
          `it will still work but may be slower. Remove an unused indexed attribute to free a slot.`;
        console.warn(`index cap reached on ${table} (${existingIndexes}/${INDEX_CAP}); created ${physicalCol} non-indexed`);
      } else {
        const idxTarget = dataType === 'STRING' ? `\`${physicalCol}\`(191)` : `\`${physicalCol}\``;
        try {
          await runDdl(`CREATE INDEX \`${idxName}\` ON ${qualifiedTable} (${idxTarget})`);
        } catch (e) {
          indexed = false;
          indexWarning = `The database index could not be created (${e.message}); the attribute column was created without an index.`;
          console.warn(`index ${idxName} not created: ${e.message}`);
        }
      }
    } else {
      indexed = true;
    }
  }

  const id = randomUUID();
  const username = event.requestContext?.authorizer?.claims?.['cognito:username'] || 'system';
  try {
    await query(
      `INSERT INTO index_attribute_defs
         (id, target_type, virtual_folder_id, dicom_tag, dicom_level, column_name, physical_column, data_type, is_indexed, description, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, targetType, vfId, dicomTag.toUpperCase(), dicomLevel, columnName, physicalCol, dataType, indexed ? 1 : 0, b.description || null, username]);
  } catch (e) {
    // The application check above can race a concurrent add of the same def;
    // the database's unique keys (uq_def_scope covers the NULL-VF STORAGE case)
    // then reject the second INSERT. Same answer as the application check.
    if (isDuplicateKey(e))
      return resp(409, { success: false, error: `A definition for that tag already exists at the ${dicomLevel} level${targetType === 'VF' ? ' for this virtual folder' : ' for STORAGE tables'}` });
    throw e;
  }
  const [row] = await query('SELECT * FROM index_attribute_defs WHERE id = ?', [id]);
  const data = toCamel(row || { id });
  const warnings = indexWarning ? [indexWarning] : [];
  // STORAGE defs are populated by ingest, so rows indexed before this def need
  // the back-fill. VF defs are populated by the folder's own re-index (hydrate).
  if (targetType === 'STORAGE') {
    let bf;
    try { bf = await startBackfill(id, username, { restart: true, delayS: BACKFILL_START_DELAY_S }); }
    catch (e) { console.error(`back-fill arm for ${id} failed:`, e.message); bf = { started: false, error: e.message }; }
    if (!bf.started) warnings.push(`The attribute was added, but the back-fill of existing studies did not start (${bf.error}). Use Back-fill to retry.`);
    data.backfill = formatJob(await loadBackfillJob(id));
  }
  return resp(201, { success: true, data, warning: warnings.length ? warnings.join(' ') : undefined });
}

// ── back-fill jobs ───────────────────────────────────────────────────────────

const JOB_COLS = `def_id, status, cursor_pkey, max_pkey, rows_scanned, rows_written, batches,
  error, requested_by, requested_at, started_at, finished_at, updated_at,
  TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS idle_s`;

async function loadBackfillJobs() {
  try {
    const rows = await query(`SELECT ${JOB_COLS} FROM index_attribute_backfill_jobs`);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
    const out = {};
    for (const r of rows) out[r.def_id] = r;
    return out;
  } catch (e) { console.warn('back-fill job list skipped:', e.message); return {}; }
}

async function loadBackfillJob(defId) {
  try {
    const [r] = await query(`SELECT ${JOB_COLS} FROM index_attribute_backfill_jobs WHERE def_id = ?`, [defId]);  // nosemgrep: javascript.aws-lambda.security.tainted-sql-string -- trusted identifier/const + bound ? params; no user value interpolated (audited)
    return r || null;
  } catch (e) { console.warn('back-fill job read skipped:', e.message); return null; }
}

const isActive = (j) => !!j && (j.status === 'PENDING' || j.status === 'RUNNING');
const isStalled = (j) => isActive(j) && Number(j.idle_s) > BACKFILL_STALL_S;

// API shape of a job row (null = never back-filled).
function formatJob(j) {
  if (!j) return null;
  const cursor = Number(j.cursor_pkey || 0);
  const maxPkey = j.max_pkey == null ? null : Number(j.max_pkey);
  let percent = 0;
  if (j.status === 'DONE') percent = 100;
  else if (maxPkey) percent = Math.max(0, Math.min(99, Math.floor((cursor * 100) / maxPkey)));
  return {
    status: j.status,
    stalled: isStalled(j),
    percent,
    cursor,
    maxPkey,
    rowsScanned: Number(j.rows_scanned || 0),
    rowsWritten: Number(j.rows_written || 0),
    batches: Number(j.batches || 0),
    error: j.error || null,
    requestedBy: j.requested_by || null,
    requestedAt: j.requested_at || null,
    startedAt: j.started_at || null,
    finishedAt: j.finished_at || null,
    updatedAt: j.updated_at || null,
  };
}

// Arm a back-fill run and send the first message of its chain. restart=true
// starts over from the first row; restart=false resumes from the stored cursor.
// A fresh chain_token supersedes any older chain of the same job: its messages
// then match nothing and stop. Returns { started, error? }.
async function startBackfill(defId, username, { restart, delayS }) {
  if (!BACKFILL_QUEUE_URL) return { started: false, error: 'back-fill is not configured on this deployment' };
  const token = randomUUID();
  if (restart) {
    await query(
      `INSERT INTO index_attribute_backfill_jobs
         (def_id, status, chain_token, cursor_pkey, max_pkey, rows_scanned, rows_written, batches, hops,
          error, requested_by, requested_at, started_at, finished_at)
       VALUES (?, 'PENDING', ?, 0, NULL, 0, 0, 0, 0, NULL, ?, NOW(), NULL, NULL)
       ON DUPLICATE KEY UPDATE status = 'PENDING', chain_token = VALUES(chain_token), cursor_pkey = 0,
         max_pkey = NULL, rows_scanned = 0, rows_written = 0, batches = 0, hops = 0, error = NULL,
         requested_by = VALUES(requested_by), requested_at = NOW(), started_at = NULL, finished_at = NULL`,
      [defId, token, username]);
  } else {
    await query(
      `UPDATE index_attribute_backfill_jobs
          SET status = IF(max_pkey IS NULL, 'PENDING', 'RUNNING'), chain_token = ?, hops = 0, error = NULL,
              requested_by = ?, requested_at = NOW(), finished_at = NULL
        WHERE def_id = ?`,
      [token, username, defId]);
  }
  try {
    await sqs().send(new SendMessageCommand({
      QueueUrl: BACKFILL_QUEUE_URL,
      MessageBody: JSON.stringify({ defId, token }),
      DelaySeconds: delayS || 0,
    }));
  } catch (e) {
    console.error(`back-fill start for ${defId} failed:`, e.message);
    await execute(
      "UPDATE index_attribute_backfill_jobs SET status = 'FAILED', error = ? WHERE def_id = ? AND chain_token = ?",
      [`Could not start: ${String(e.message || e).slice(0, 500)}`, defId, token]).catch(() => {});
    return { started: false, error: e.message || 'queue send failed' };
  }
  return { started: true };
}

// POST /defs {action:'backfill', id, restart?}: run the back-fill of an
// existing STORAGE def. A FAILED or stalled run resumes from its cursor; a DONE
// run (or restart=true) starts over. A healthy running one is left alone (409).
async function backfillDef(event, b) {
  const id = b.id;
  if (!id || typeof id !== 'string') return resp(400, { success: false, error: 'id (the attribute definition id) is required' });
  const [def] = await query('SELECT * FROM index_attribute_defs WHERE id = ?', [id]);
  if (!def) return resp(404, { success: false, error: 'Definition not found' });
  if (def.target_type !== 'STORAGE' || def.virtual_folder_id) {
    return resp(400, {
      success: false,
      error: 'Back-fill applies to storage attributes. A virtual-folder attribute is filled when that folder is re-indexed.',
    });
  }
  const job = await loadBackfillJob(id);
  const restart = b.restart === true || !job || job.status === 'DONE';
  if (isActive(job) && !isStalled(job) && b.restart !== true) {
    return resp(409, { success: false, error: 'A back-fill is already running for this attribute.', data: { backfill: formatJob(job) } });
  }
  const username = event.requestContext?.authorizer?.claims?.['cognito:username'] || 'system';
  // A run that never got to snapshot its range still needs the cache delay.
  const delayS = restart || !job || job.max_pkey == null ? BACKFILL_START_DELAY_S : 0;
  const bf = await startBackfill(id, username, { restart, delayS });
  const after = formatJob(await loadBackfillJob(id));
  if (!bf.started) return resp(503, { success: false, error: `The back-fill could not be started: ${bf.error}`, data: { backfill: after } });
  return resp(202, { success: true, data: { id, backfill: after, resumed: !restart } });
}

async function deleteDef(id) {
  const [row] = await query('SELECT * FROM index_attribute_defs WHERE id = ?', [id]);
  if (!row) return resp(404, { success: false, error: 'Definition not found' });
  // Leave the physical column/index in place (non-destructive). No scope-cascade
  // needed — index_attribute_scope was retired.
  await query('DELETE FROM index_attribute_defs WHERE id = ?', [id]);
  return resp(200, { success: true });
}

exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method;
  const path = event.path || '';
  const id = event.pathParameters?.id;
  console.log('IndexAttributesAPI:', method, path);

  if (method === 'OPTIONS') return resp(200, {});
  try {
    await ensureSchema();

    if (path.includes('/defs')) {
      if (method === 'GET') return await listDefs(event);
      if (method === 'POST') {
        let b;
        try { b = JSON.parse(event.body || '{}') || {}; }
        catch { return resp(400, { success: false, error: 'Request body must be JSON' }); }
        if (b.action === 'backfill') return await backfillDef(event, b);
        if (b.action !== undefined) return resp(400, { success: false, error: `Unknown action '${b.action}'` });
        return await addDef(event);
      }
      if (method === 'DELETE' && id) return await deleteDef(id);
      return resp(405, { success: false, error: `Method ${method} not allowed on /defs` });
    }

    // Every other route (the retired /scope population switches and the legacy
    // flat routes) is gone as of Phase 6.
    return resp(410, {
      success: false,
      error: 'This route was retired. Index attributes are configured only via /index-attributes/defs; population is unconditional (no per-scope opt-in).',
    });
  } catch (e) {
    console.error('IndexAttributesAPI error:', e.message);
    return resp(500, { success: false, error: e.message });
  }
};
