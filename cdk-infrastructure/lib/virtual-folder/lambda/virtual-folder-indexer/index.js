const { query } = require('/opt/nodejs/database');
const { sanitizeError } = require('/opt/nodejs/log-utils');
const { createHash, createHmac } = require('crypto');

// Security: values are keyed with HMAC-SHA256(key = salt, msg = value), salt =
// "{pepper}:{vfId}". MUST match _keyed_hex() in dicomweb-s3/vf_deid.py.
function keyedHex(salt, text) {
  return createHmac('sha256', String(salt)).update(String(text), 'utf8').digest('hex');
}
const zlib = require('zlib');
const { DICOM_TAGS, getTag, getRequiredTagsByLevel } = require('/opt/nodejs/dicom-tags');
// Security: shared tree DDL (no original_* columns) + opaque patient key.
const { ensureTreeSchema, sourcePatientKey } = require('/opt/nodejs/vf-tree-ddl');

// ── Per-VF database name derivation (Phase 2, VF Per-Database Redesign) ───────
// Each VF's de-id tree now lives in its OWN database `vf_<sanitized-uuid>` with
// tables vf_<id>_patient/study/series/instance (+ vf_<id>_series_tracker). The
// shared virtual_* tree is gone. This MUST derive the name byte-identically to
// the Phase 1 helper cdk-infrastructure/lib/virtual-folder/lambda/
// virtual-folder-api/vf-database.js (vfDbName): 'vf_' + uuid.toLowerCase()
// .replace(/-/g,''). That module lives in a DIFFERENT lambda dir and CDK Docker
// bundling mounts only THIS lambda's dir, so it cannot be imported here — the
// function is replicated exactly (and defensively re-asserted below).
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Derive the per-VF database name from a validated VF UUID (never interpolate
// unvalidated input into SQL — Data API cannot parameterize DDL identifiers).
function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}

// Fully-qualified backtick-quoted VF tree table name: `vf_x`.`vf_x_patient`.
// The shared query() helper pins the connection's default database to DB_NAME,
// so every VF-tree statement MUST be database-qualified to reach vf_<id>.
function vfTable(vfDb, leaf) {
  if (!/^vf_[0-9a-f]{32}$/.test(vfDb)) {
    throw new Error(`Refusing to build SQL for unexpected vf-db name: ${vfDb}`);
  }
  return `\`${vfDb}\`.\`${vfDb}_${leaf}\``;
}

// The shared physical index tree stays in dicomarchive (app-only, never granted to a
// VF SQL user). Its DB name is fixed for the deployment; qualify cross-database
// reads explicitly since the connection default is the VF-agnostic DB_NAME.
const SHARED_DB = process.env.DB_NAME || 'dicomarchive';
function sharedTbl(name) {
  return `\`${SHARED_DB}\`.\`${name}\``;
}

// S7: de-identification hash salt. The salt was historically the VF id alone,
// which is NOT secret (it appears in URLs/API responses), so low-entropy
// identifiers (PatientID, dates) were brute-forceable -> reversible pseudonyms.
// A per-deployment SECRET pepper (fetched once at cold start from Secrets
// Manager, name in DEID_HASH_PEPPER_SECRET_NAME) is prepended so the effective
// salt is "{pepper}:{vfId}". The Python retrieve engine
// (interface-container/dicomweb-s3/vf_deid.py) computes the SAME effective salt
// from the SAME secret, preserving the index-time/query-time consistency
// contract. When the secret is UNSET both sides fall back to the bare VF id, so
// existing deployments/data are unchanged until the pepper is configured AND
// the VF is re-indexed.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const _smClient = new SecretsManagerClient({});
let _deidPepper = null;          // resolved secret string ('' when none)
let _deidPepperResolved = false; // one-shot guard

async function resolveDeidPepper() {
  if (_deidPepperResolved) return _deidPepper;
  const name = process.env.DEID_HASH_PEPPER_SECRET_NAME || '';
  if (!name) {
    _deidPepper = '';
    _deidPepperResolved = true;
    return _deidPepper;
  }
  try {
    const resp = await _smClient.send(new GetSecretValueCommand({ SecretId: name }));
    _deidPepper = resp.SecretString || '';
  } catch (e) {
    // Fail CLOSED on the de-id contract: if the pepper is configured but
    // unreadable, do NOT silently fall back to the weaker bare-VF-id salt
    // (that would write reversible pseudonyms). Surface the error.
    console.error(`VF indexer: failed to resolve de-id pepper secret: ${e && (e.message || e.code)}`);
    throw e;
  }
  _deidPepperResolved = true;
  return _deidPepper;
}

function effectiveSalt(vfId) {
  // Security: never fall back to the public folder id as the only salt.
  if (!_deidPepper) throw new Error('de-id pepper is not configured; refusing to hash folder values');
  return `${_deidPepper}:${vfId}`;
}

// Cache table models
let tableModels = {};

function getCoreAttributesByLevel(level) {
  if (level === 'PATIENT') {
    return ['00100010', '00100020', '00100030', '00100040'];
  }
  return getRequiredTagsByLevel(level)
    .filter(tag => !tag.computed)
    .map(tag => tag.tag);
}

function hashUid(uid, salt) {
  return '2.25.' + BigInt('0x' + keyedHex(salt, uid).substring(0, 30)).toString();
}

function hashValue(value, salt, vr, maxLength) {
  const hash = keyedHex(salt, value);
  
  // For UIDs, use special format
  if (vr === 'UI') {
    return '2.25.' + BigInt('0x' + hash.substring(0, 30)).toString();
  }
  
  // For other VRs, truncate to max length
  const truncated = hash.substring(0, maxLength || 64);
  return truncated;
}

function applyDeidAction(originalValue, tagId, tagActions, hashSalt, vr, patientId) {
  if (!tagActions || !originalValue) return originalValue;
  
  const actionRule = tagActions.find(rule => rule.tag === tagId);
  if (!actionRule) return originalValue;
  
  switch (actionRule.action) {
    case 'REMOVE':
    case 'EMPTY':
      return null;
    case 'HASH':
      return vr === 'UI' ? hashUid(originalValue, hashSalt) : hashValue(originalValue, hashSalt, vr, 64);
    case 'HASH_8':
      return hashValue(originalValue, hashSalt, vr, 8);
    case 'HASH_16':
      return hashValue(originalValue, hashSalt, vr, 16);
    case 'HASH_32':
      return hashValue(originalValue, hashSalt, vr, 32);
    case 'KEEP':
      return originalValue;
    case 'REPLACE':
      // The profile-api and de-id UI persist the fixed value under `replacement`
      // (validateDeidProfile requires it); older records used `value`. Honor both.
      return (actionRule.replacement ?? actionRule.value) || null;
    case 'SHIFT_DATE':
      return shiftDate(originalValue, actionRule, hashSalt, patientId);
    default:
      return originalValue;
  }
}

function shiftDate(dateValue, actionRule, hashSalt, patientId) {
  if (!dateValue || !/^\d{8}/.test(dateValue)) return dateValue;
  
  const min = actionRule.shiftDaysMin || 0;
  const max = actionRule.shiftDaysMax || 365;
  const hash = createHmac('sha256', String(hashSalt)).update(String(patientId), 'utf8').digest();
  const offset = min + (hash.readUInt32BE(0) % (max - min + 1));
  
  const year = parseInt(dateValue.substring(0, 4));
  const month = parseInt(dateValue.substring(4, 6)) - 1;
  const day = parseInt(dateValue.substring(6, 8));
  const date = new Date(year, month, day);
  date.setDate(date.getDate() + offset);
  
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function extractTagValues(dicomMetadata, tagIds, tagActions, hashSalt, patientId) {
  const result = {};
  for (const tagId of tagIds) {
    const tagDef = getTag(tagId);
    if (!tagDef) continue;
    
    const fieldName = tagDef.name;
    const value = dicomMetadata[fieldName];
    if (value === undefined || value === null) continue;
    
    const lowerFieldName = fieldName.toLowerCase();
    result[lowerFieldName] = applyDeidAction(value, tagId, tagActions, hashSalt, tagDef.vr, patientId);
  }
  return result;
}

function buildAttributeList(level, profileAttributes) {
  const coreAttrs = getCoreAttributesByLevel(level);
  const profileAttrs = profileAttributes ? JSON.parse(profileAttributes) : [];
  return [...new Set([...coreAttrs, ...profileAttrs])];
}

// ── Per-VF tree self-heal + hydration (de-id) ───────────────────────────────
// Phase 2 (VF Per-Database Redesign): each VF's de-id tree lives in its OWN
// database vf_<id> (tables vf_<id>_patient/study/series/instance), created by
// Phase 1 provisioning (virtual-folder-api/vf-database.js provisionVfDatabase /
// renderTreeDDL) at VF-create time. The shared virtual_* tree is gone. So the
// legacy shared-tree migration this function used to perform no longer applies:
// the vf_<id> tables are born with the correct end-state schema, and any lazy
// per-VF index-attribute columns are added on demand by ensureVfAttrColumn into
// vf_<id>. This is now a no-op kept for handler-call-site compatibility.
let _vfTreeEnsured = false;
async function ensureVfTreeSchema() {
  if (_vfTreeEnsured) return;
  // Intentionally empty: Phase 1 renderTreeDDL owns the vf_<id> tree DDL; lazy
  // attribute columns are ADDed per-VF by ensureVfAttrColumn.
  _vfTreeEnsured = true;
}

// Read a scalar tag value from a shared-tree row, given its physical column, and
// apply the VF's de-id action for that tag. Returns the (possibly swapped) value.
// Security: the result is written AS IS. A REMOVE/EMPTY rule yields null and
// the column is stored NULL; it must never fall back to the source value. With
// no rule, applyDeidAction returns the source value (KEEP). DATE columns come
// back from the DB as 'YYYY-MM-DD'; they are normalised to DICOM DA (YYYYMMDD)
// first so SHIFT_DATE applies and _dateOrNull can store them.
function deidField(sourceRow, physicalCol, dicomTag, tagActions, hashSalt, vr, patientId) {
  let raw = sourceRow[physicalCol];
  if (raw === undefined || raw === null || raw === '') return null;
  raw = String(raw);
  if (vr === 'DA') raw = _toDicomDate(raw);
  return applyDeidAction(raw, dicomTag, tagActions, hashSalt, vr, patientId);
}

// 'YYYY-MM-DD[ ...]' or 'YYYYMMDD' -> 'YYYYMMDD'; anything else unchanged.
function _toDicomDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}${m[2]}${m[3]}` : v;
}

// ── Per-VF index-attribute population (Phase 6B) ─────────────────────────────
// Load ALL of the VF's index-attribute defs (target_type='VF' rows carrying
// this folder's id). Population is unconditional now — there is no per-scope
// enabled gate. The value is copied from the shared tree and DE-IDENTIFIED with
// the VF profile before being written into the vf_<id> column, so the indexed
// value matches the on-the-fly retrieve path byte-for-byte.
const VF_LEVEL_TABLE = { PATIENT: 'patient', STUDY: 'study', SERIES: 'series', INSTANCE: 'instance' };
const SRC_LEVEL_ALIAS = { PATIENT: 'pt', STUDY: 'st', SERIES: 'se', INSTANCE: 'i' };
const VF_LEVEL_PKEY = { PATIENT: 'patient_pkey', STUDY: 'study_pkey', SERIES: 'series_pkey', INSTANCE: 'instance_pkey' };
const ATTR_SQL_TYPE = { STRING: 'VARCHAR(255)', INT: 'INT', DATE: 'DATE', DECIMAL: 'DECIMAL(18,6)' };

async function loadEnabledVfAttributes(virtualFolderId) {
  try {
    const rows = await query(
      `SELECT physical_column, dicom_tag, dicom_level, data_type
         FROM index_attribute_defs
        WHERE target_type='VF' AND virtual_folder_id=?`,
      [virtualFolderId]);
    return rows.filter(r => r.physical_column && VF_LEVEL_TABLE[r.dicom_level]);
  } catch (e) {
    console.warn('loadEnabledVfAttributes skipped:', e.message);
    return [];
  }
}

// Ensure an enabled VF attribute's physical column exists on its vf_<id> tree
// table (idempotent). The column is created NULLable so unpopulated rows stay
// NULL. Phase 2: the table is fully qualified into the VF's own database.
async function ensureVfAttrColumn(vfDb, leaf, col, dataType) {
  const validLeaves = new Set(['patient', 'study', 'series', 'instance']);
  if (!validLeaves.has(leaf)) throw new Error(`Invalid VF table leaf: ${leaf}`);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(col)) throw new Error(`Invalid column name: ${col}`);
  const fq = vfTable(vfDb, leaf); // validates vfDb shape
  const exists = await query(
    'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [vfDb, `${vfDb}_${leaf}`, col]);
  if (!exists.length) {
    await query(`ALTER TABLE ${fq} ADD COLUMN \`${col}\` ${ATTR_SQL_TYPE[dataType] || 'VARCHAR(255)'} NULL`);
  }
}

// DICOM VR by attribute, used to drive the de-id action's hashing form. The
// engine only needs UI vs non-UI, so map DATE->'DA', keep others generic.
function attrVr(dataType) {
  return dataType === 'DATE' ? 'DA' : 'LO';
}

// Coerce a raw header/source string to the VF attribute column's SQL type.
function coerceAttrValue(raw, dataType) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (dataType === 'INT') { const n = parseInt(String(raw).trim(), 10); return isNaN(n) ? null : n; }
  if (dataType === 'DECIMAL') { const n = parseFloat(String(raw).split('\\')[0].trim()); return isNaN(n) ? null : n; }
  if (dataType === 'DATE') return _dateOrNull(raw);
  return String(raw);
}

// Second pass: populate each enabled VF attribute column in the vf_<id> tree,
// de-identified. Reads the source value from the SHARED (dicomarchive) tree (by
// instance_pkey / content_pkey and parent pkeys), applies the VF profile action
// for that tag, and UPDATEs the vf_<id> row. Instances key on instance_pkey;
// parent levels use one representative instance per parent (value is constant at
// that level). Phase 2: the database is the VF scope (no virtual_folder_id
// filter); shared reads are qualified dicomarchive.*.
async function populateVfAttributes(vfDb, virtualFolderId, attrs, tagActions, hashSalt) {
  if (!attrs.length) return;
  for (const a of attrs) {
    const level = a.dicom_level;
    const leaf = VF_LEVEL_TABLE[level];
    const srcAlias = SRC_LEVEL_ALIAS[level];
    const col = a.physical_column;
    const vtable = vfTable(vfDb, leaf);
    const vInstance = vfTable(vfDb, 'instance');
    const vSeries = vfTable(vfDb, 'series');
    const vStudy = vfTable(vfDb, 'study');
    try {
      await ensureVfAttrColumn(vfDb, leaf, col, a.data_type);
    } catch (e) { console.warn(`VF attr column ${vtable}.${col} skipped:`, e.message); continue; }

    // Pull (vf_row_pkey, source_value, patientid) for this VF's rows. The source
    // value comes from the shared (dicomarchive) tree's physical column at this
    // level; patientid is needed for SHIFT_DATE's per-patient offset seed. The
    // vf_<id>_instance row carries instance_pkey (WSI per-level correctness), so
    // the INSTANCE join is by instance_pkey; parents join through it.
    let rows;
    try {
      if (level === 'INSTANCE') {
        rows = await query(
          `SELECT vi.instance_pkey AS pk, i.\`${col}\` AS srcval, pt.patientid AS pid
             FROM ${vInstance} vi
             JOIN ${sharedTbl('instance')} i ON i.instance_pkey = vi.instance_pkey AND i.deleted_at IS NULL
             JOIN ${sharedTbl('series')} se ON se.series_pkey = i.series_pkey
             JOIN ${sharedTbl('study')} st ON st.study_pkey = se.study_pkey
             JOIN ${sharedTbl('patient')} pt ON pt.patient_pkey = st.patient_pkey`);
      } else {
        // Representative shared-tree row per VF parent, joined via one instance.
        const vfaJoin =
          `FROM ${vtable} v
           JOIN ${vInstance} vi ON vi.${level === 'SERIES' ? 'series_pkey = v.series_pkey'
             : level === 'STUDY' ? `series_pkey IN (SELECT series_pkey FROM ${vSeries} WHERE study_pkey = v.study_pkey)`
             : `series_pkey IN (SELECT vs.series_pkey FROM ${vSeries} vs JOIN ${vStudy} vst2 ON vst2.study_pkey = vs.study_pkey WHERE vst2.patient_pkey = v.patient_pkey)`}
           JOIN ${sharedTbl('instance')} i ON i.instance_pkey = vi.instance_pkey AND i.deleted_at IS NULL
           JOIN ${sharedTbl('series')} se ON se.series_pkey = i.series_pkey
           JOIN ${sharedTbl('study')} st ON st.study_pkey = se.study_pkey
           JOIN ${sharedTbl('patient')} pt ON pt.patient_pkey = st.patient_pkey`;
        rows = await query(
          `SELECT v.${VF_LEVEL_PKEY[level]} AS pk, MIN(${srcAlias}.\`${col}\`) AS srcval, MIN(pt.patientid) AS pid
           ${vfaJoin}
           GROUP BY v.${VF_LEVEL_PKEY[level]}`);
      }
    } catch (e) { console.warn(`VF attr source read ${vtable}.${col} skipped:`, e.message); continue; }

    for (const row of rows) {
      const deid = applyDeidAction(row.srcval == null ? null : String(row.srcval),
        a.dicom_tag, tagActions, hashSalt, attrVr(a.data_type), row.pid || '');
      const value = coerceAttrValue(deid, a.data_type);
      try {
        await query(`UPDATE ${vtable} SET \`${col}\` = ? WHERE ${VF_LEVEL_PKEY[level]} = ?`, [value, row.pk]);
      } catch (e) { console.warn(`VF attr update ${vtable}.${col} pk=${row.pk} skipped:`, e.message); }
    }
  }
  console.log(`VF ${virtualFolderId}: populated ${attrs.length} enabled index attribute(s)`);
}

// Rebuild the per-VF metadata tree (virtual_patient/study/series/instance) for a
// VF from its assignments, copying the shared-tree values and applying the VF's
// de-id tag_actions to the identity/date/description fields. v1 keeps the real
// UIDs (so the dicomweb read path resolves the same physical content); only
// demographic/date/description VALUES are swapped. content_pkey links each VF
// instance to the shared physical row for retrieval.
async function hydrateVfTree(virtualFolderId, tagActions, hashSalt) {
  const vfDb = vfDbName(virtualFolderId);
  const vPatient = vfTable(vfDb, 'patient');
  const vStudy = vfTable(vfDb, 'study');
  const vSeries = vfTable(vfDb, 'series');
  const vInstance = vfTable(vfDb, 'instance');

  // Security: a tree built by an older release still has the original_*
  // columns; drop and recreate it with the current DDL before re-hydrating.
  if (await ensureTreeSchema(query, vfDb)) {
    console.log(`VF ${virtualFolderId}: tree schema was outdated; recreated ${vfDb}`);
  }

  // Clear the VF's existing tree (reverse-FK order). Phase 2: the DATABASE is
  // the scope, so no virtual_folder_id filter — clear the whole vf_<id> tree.
  await query(`DELETE FROM ${vInstance}`);
  await query(`DELETE FROM ${vSeries}`);
  await query(`DELETE FROM ${vStudy}`);
  await query(`DELETE FROM ${vPatient}`);

  // One row per assigned physical object, joined up the SHARED (dicomarchive) tree.
  // virtual_folder_assignments STAYS shared in dicomarchive (qualified). Select
  // i.instance_pkey too — the vf_<id>_instance row keys on instance_pkey so WSI
  // pyramid levels (which share a content_pkey) stay distinct.
  const rows = await query(
    `SELECT vfa.content_pkey, i.instance_pkey, vfa.datastore_id,
            pt.patientid, pt.patientname, pt.patientbirthdate, pt.patientsex, pt.issuerofpatientid,
            st.studyinstanceuid, st.studydate, st.studytime, st.accessionnumber,
            st.studyid, st.studydescription, st.referringphysicianname, st.modalitiesinstudy,
            se.seriesinstanceuid AS seriesinstanceuid, se.modality AS modality, se.seriesdescription AS seriesdescription,
            se.seriesnumber AS seriesnumber,
            i.sopinstanceuid AS sopinstanceuid, i.sopclassuid AS sopclassuid, i.instancenumber AS instancenumber
     FROM ${sharedTbl('virtual_folder_assignments')} vfa
     JOIN ${sharedTbl('instance')} i ON i.content_pkey = vfa.content_pkey AND i.datastore_id = vfa.datastore_id AND i.deleted_at IS NULL
     JOIN ${sharedTbl('series')}   se ON se.series_pkey = i.series_pkey
     JOIN ${sharedTbl('study')}    st ON st.study_pkey  = se.study_pkey
     JOIN ${sharedTbl('patient')}  pt ON pt.patient_pkey = st.patient_pkey
     WHERE vfa.virtual_folder_id = ?`,
    [virtualFolderId]);

  // Memo the pkeys we create so shared parents collapse to one VF row each.
  const patientPk = {}, studyPk = {}, seriesPk = {};
  let counts = { patient: 0, study: 0, series: 0, instance: 0 };

  // The shared query() helper (RDS Data API) returns no insertId, and
  // LAST_INSERT_ID() is not reliable across separate ExecuteStatement calls, so
  // resolve each parent pkey with a SELECT on its unique key after the upsert.
  // Phase 2: no virtual_folder_id column — the vf_<id> db is the scope.
  const selPk = async (col, table, whereSql, whereParams) => {
    const [row] = await query(`SELECT ${col} AS pk FROM ${table} WHERE ${whereSql} LIMIT 1`, whereParams);
    return row ? row.pk : null;
  };

  for (const r of rows) {
    const pid = r.patientid || '';
    const ds = r.datastore_id;
    // IssuerOfPatientID carried from the core patient row (real 0010,0021),
    // '' when absent — mirrors the core patient identity model.
    const issuer = r.issuerofpatientid || '';
    // Patient (de-id demographics). Identity = (original PatientID, issuer)
    // within the VF's own database.
    const patKey = `${ds}|${pid}|${issuer}`;
    if (!(patKey in patientPk)) {
      const deidName = deidField(r, 'patientname', '00100010', tagActions, hashSalt, 'PN', pid);
      const deidId = deidField(r, 'patientid', '00100020', tagActions, hashSalt, 'LO', pid);
      const deidBd = deidField(r, 'patientbirthdate', '00100030', tagActions, hashSalt, 'DA', pid);
      // Security: sex and StudyID follow the profile like every other column.
      const deidSex = deidField(r, 'patientsex', '00100040', tagActions, hashSalt, 'CS', pid);
      // Identity = opaque HMAC of (PatientID, issuer); no original is stored.
      const srcKey = sourcePatientKey(_deidPepper, virtualFolderId, pid, issuer);
      await query(
        `INSERT INTO ${vPatient}
          (source_key, issuerofpatientid, source_datastoreid,
           patientid, patientname, patientbirthdate, patientsex)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE patientname = VALUES(patientname), patientid = VALUES(patientid),
                                 patientbirthdate = VALUES(patientbirthdate), patientsex = VALUES(patientsex)`,
        [srcKey, issuer, ds, deidId, deidName,
         (deidBd ? _dateOrNull(deidBd) : null), deidSex]);
      patientPk[patKey] = await selPk('patient_pkey', vPatient, 'source_key = ?', [srcKey]);
      counts.patient++;
    }
    // Study (de-id dates/description/accession; real UID in v1).
    const stKey = `${ds}|${r.studyinstanceuid}`;
    if (!(stKey in studyPk)) {
      const deidAcc = deidField(r, 'accessionnumber', '00080050', tagActions, hashSalt, 'SH', pid);
      const deidStDate = deidField(r, 'studydate', '00080020', tagActions, hashSalt, 'DA', pid);
      const deidStDesc = deidField(r, 'studydescription', '00081030', tagActions, hashSalt, 'LO', pid);
      const deidRef = deidField(r, 'referringphysicianname', '00080090', tagActions, hashSalt, 'PN', pid);
      const deidStudyId = deidField(r, 'studyid', '00200010', tagActions, hashSalt, 'SH', pid);
      await query(
        `INSERT INTO ${vStudy}
          (patient_pkey, source_datastoreid, studyinstanceuid,
           accessionnumber, studyid, studydate, studydescription,
           referringphysicianname, modalitiesinstudy)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE accessionnumber = VALUES(accessionnumber), studydate = VALUES(studydate),
                                 studydescription = VALUES(studydescription), studyid = VALUES(studyid),
                                 referringphysicianname = VALUES(referringphysicianname)`,
        [patientPk[patKey], ds, r.studyinstanceuid,
         deidAcc, deidStudyId, (deidStDate ? _dateOrNull(deidStDate) : null), deidStDesc,
         deidRef, r.modalitiesinstudy || null]);
      studyPk[stKey] = await selPk('study_pkey', vStudy, 'studyinstanceuid = ?', [r.studyinstanceuid]);
      counts.study++;
    }
    // Series (real UID in v1; description may be de-id'd).
    const seKey = `${ds}|${r.seriesinstanceuid}`;
    if (!(seKey in seriesPk)) {
      const deidSeDesc = deidField(r, 'seriesdescription', '0008103E', tagActions, hashSalt, 'LO', pid);
      await query(
        `INSERT INTO ${vSeries}
          (study_pkey, source_datastoreid, seriesinstanceuid, modality, seriesnumber, seriesdescription)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE seriesdescription = VALUES(seriesdescription)`,
        [studyPk[stKey], ds, r.seriesinstanceuid, r.modality || null, r.seriesnumber || null, deidSeDesc]);
      seriesPk[seKey] = await selPk('series_pkey', vSeries,
        'seriesinstanceuid = ? AND source_datastoreid = ?',
        [r.seriesinstanceuid, ds]);
      counts.series++;
    }
    // Instance (real UID in v1). Phase 2: carries BOTH instance_pkey (PK / dedup
    // key — WSI pyramid levels stay distinct) AND content_pkey (shared S3
    // pointer). Both are plain cross-DB columns (no FK to dicomarchive).
    await query(
      `INSERT INTO ${vInstance}
        (instance_pkey, content_pkey, series_pkey, source_datastoreid,
         sopinstanceuid, sopclassuid, instancenumber)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE content_pkey = VALUES(content_pkey), series_pkey = VALUES(series_pkey)`,
      [r.instance_pkey, r.content_pkey, seriesPk[seKey], ds,
       r.sopinstanceuid, r.sopclassuid || '', r.instancenumber || null]);
    counts.instance++;
  }
  console.log(`VF ${virtualFolderId}: hydrated tree ` +
    `${counts.patient}p/${counts.study}st/${counts.series}se/${counts.instance}i (de-id ${tagActions ? 'on' : 'off'})`);

  // Phase 6B: populate ALL of the VF's index-attribute columns, de-id'd with
  // the same profile/salt/actions used above (byte-for-byte match to the
  // on-the-fly retrieve path). Additive — a no-op when the VF defined none.
  try {
    const enabledAttrs = await loadEnabledVfAttributes(virtualFolderId);
    await populateVfAttributes(vfDb, virtualFolderId, enabledAttrs, tagActions, hashSalt);
  } catch (e) {
    console.warn(`VF ${virtualFolderId}: index-attribute population skipped:`, e.message);
  }
  return counts;
}

// DICOM DA (YYYYMMDD) -> SQL DATE (YYYY-MM-DD); null if not 8 digits.
function _dateOrNull(v) {
  const s = String(v).trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}` : null;
}

exports.handler = async (event) => {
  console.log('Virtual Folder Indexer: processing', event.Records?.length, 'records');
  // S7: resolve the de-id hash pepper once (cold start) before any hashing, so
  // effectiveSalt() uses the secret-peppered salt that matches the retrieve path.
  await resolveDeidPepper();
  await ensureVfTreeSchema();
  
  for (const record of event.Records) {
    try {
      const msg = JSON.parse(record.body);
      const { virtualFolderId } = msg;
      // hydrateOnly: skip the destructive rule-based rebuild (which DELETEs all
      // assignments and re-inserts only rule matches) and ONLY rebuild the de-id
      // tree from the assignments that already exist. Used after a MANUAL /
      // analytics assign, whose rows are not rule-derived and would otherwise be
      // wiped by the rebuild. reason='analytics-assign'/'manual-assign' implies it.
      const hydrateOnly = msg.hydrateOnly === true ||
        msg.reason === 'analytics-assign' || msg.reason === 'manual-assign';
      console.log(`Processing VF reindex: VF=${virtualFolderId} hydrateOnly=${hydrateOnly} reason=${msg.reason || ''}`);

      const [vf] = await query(`SELECT vf.*, dp.tag_actions as tag_actions
        FROM virtual_folders vf
        LEFT JOIN virtual_folder_deid_profiles dp ON vf.deid_profile_id = dp.id
        WHERE vf.id = ? AND vf.deleted = FALSE AND vf.status = 'ACTIVE'`, [virtualFolderId]);
      if (!vf) { console.error(`VF ${virtualFolderId} not found / not ACTIVE`); continue; }

      // hydrateOnly short-circuit: (re)build the de-id tree from the CURRENT
      // assignments without touching virtual_folder_assignments membership.
      if (hydrateOnly) {
        let tagActionsH = vf.tag_actions;
        if (typeof tagActionsH === 'string') { try { tagActionsH = JSON.parse(tagActionsH); } catch { tagActionsH = null; } }
        if (!Array.isArray(tagActionsH)) tagActionsH = null;
        try {
          await hydrateVfTree(virtualFolderId, tagActionsH, effectiveSalt(vf.id));
          console.log(`VF ${virtualFolderId}: hydrate-only tree rebuild from existing assignments complete`);
        } catch (e) {
          console.error(`VF ${virtualFolderId}: hydrate-only tree hydration failed: ${e && (e.message || e.code || JSON.stringify(e))}`);
          throw e;
        }
        continue;
      }

      // ── Rule-based multi-storage hydration ────────────────────────────────
      // A VF index is a set of physical-file rows drawn from N datastores. We
      // rebuild its membership (virtual_folder_assignments) by evaluating each
      // enabled assignment rule against storage_index. A rule scopes to a set of
      // datastores (virtual_folder_assignment_rule_datastores) and carries typed
      // conditions (virtual_folder_assignment_rule_conditions) over content
      // attributes. Full rebuild: clear then re-insert, so a rule edit or a
      // removed source object is reflected without stale membership.
      const rules = await query(
        `SELECT id, priority FROM virtual_folder_assignment_rules
         WHERE virtual_folder_id = ? AND enabled = TRUE ORDER BY priority DESC`,
        [virtualFolderId]);

      await query('DELETE FROM virtual_folder_assignments WHERE virtual_folder_id = ?', [virtualFolderId]);

      let assigned = 0;
      for (const rule of rules) {
        const dsRows = await query(
          'SELECT datastore_id FROM virtual_folder_assignment_rule_datastores WHERE rule_id = ?',
          [rule.id]);
        const datastoreIds = dsRows.map(r => r.datastore_id);
        if (datastoreIds.length === 0) continue; // a rule with no source datastores selects nothing

        const conds = await query(
          `SELECT attribute_name, operator, value, value_end, logic_operator, is_exclusion
           FROM virtual_folder_assignment_rule_conditions WHERE rule_id = ?`,
          [rule.id]);

        // Translate typed conditions to a parameterized WHERE over storage_index
        // (aliased si), joining the index tables so rules can match not just the
        // UID/ContentKind columns on storage_index but also study/series/instance
        // DICOM attributes and user-defined x_<col> index-attribute columns.
        // Unknown attributes/operators are ignored (fail-safe: narrows nothing).
        //   base (storage_index si): the 4 UID/kind columns
        //   i (instance)  se (series)  st (study)  pt (patient)
        const ATTR_COL = {
          StudyInstanceUID: 'si.`study_instance_uid`',
          SeriesInstanceUID: 'si.`series_instance_uid`',
          SOPInstanceUID: 'si.`sop_instance_uid`',
          ContentKind: 'si.`content_kind`',
          Modality: 'se.`modality`',
          SeriesDescription: 'se.`seriesdescription`',
          StudyDescription: 'st.`studydescription`',
          StudyDate: 'st.`studydate`',
          AccessionNumber: 'st.`accessionnumber`',
          PatientID: 'pt.`patientid`',
          PatientName: 'pt.`patientname`',
          SOPClassUID: 'i.`sopclassuid`',
        };
        // Load configured index attributes so a rule may reference an attribute
        // column. Redesign: structure lives in index_attribute_defs; both STORAGE
        // (shared-tree) and VF defs may be referenced by a rule condition.
        const xAttrs = await query(
          "SELECT physical_column, dicom_level FROM index_attribute_defs",
          []).catch(() => []);
        const X_TABLE_ALIAS = { PATIENT: 'pt', STUDY: 'st', SERIES: 'se', INSTANCE: 'i' };
        const xCol = {};
        for (const xa of xAttrs) {
          const a = X_TABLE_ALIAS[xa.dicom_level];
          if (a && xa.physical_column) xCol[xa.physical_column] = `${a}.\`${xa.physical_column}\``;
        }
        const clauses = [];
        const params = [];
        let needJoin = false;
        for (const c of conds) {
          const col = ATTR_COL[c.attribute_name] || xCol[c.attribute_name];
          if (!col) continue;
          if (!col.startsWith('si.')) needJoin = true;
          const neg = c.is_exclusion ? 'NOT ' : '';
          switch ((c.operator || '').toUpperCase()) {
            case 'EQUALS': case '=':
              clauses.push(`${neg}(${col} = ?)`); params.push(c.value); break;
            case 'LIKE': case 'CONTAINS':
              clauses.push(`${neg}(${col} LIKE ?)`); params.push(`%${c.value}%`); break;
            case 'IN': {
              const vals = String(c.value).split(',').map(s => s.trim()).filter(Boolean);
              if (vals.length) {
                clauses.push(`${neg}(${col} IN (${vals.map(() => '?').join(',')}))`);
                params.push(...vals);
              }
              break;
            }
            default: break; // unknown operator: ignore
          }
        }
        // Combine with the rule's logic operator (default AND). A rule with no
        // usable conditions selects every DICOM row in its datastores.
        const logic = (conds[0]?.logic_operator === 'OR') ? ' OR ' : ' AND ';
        const condSql = clauses.length ? ` AND (${clauses.join(logic)})` : '';
        // Only join the index tables when a non-storage_index attribute is used.
        const joinSql = needJoin
          ? ` LEFT JOIN instance i ON i.content_pkey = si.content_pkey
              LEFT JOIN series se ON se.series_pkey = i.series_pkey
              LEFT JOIN study st ON st.study_pkey = se.study_pkey
              LEFT JOIN patient pt ON pt.patient_pkey = st.patient_pkey`
          : '';

        const dsPlaceholders = datastoreIds.map(() => '?').join(',');
        const rows = await query(
          `SELECT si.content_pkey, si.datastore_id, si.study_instance_uid,
                  si.series_instance_uid, si.sop_instance_uid
           FROM storage_index si${joinSql}
           WHERE si.datastore_id IN (${dsPlaceholders})
             AND si.deleted_at IS NULL
             AND si.content_kind = 'DICOM'${condSql}`,
          [...datastoreIds, ...params]);

        for (const r of rows) {
          await query(
            `INSERT INTO virtual_folder_assignments
               (virtual_folder_id, datastore_id, content_pkey,
                study_instance_uid, series_instance_uid, sop_instance_uid)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE datastore_id = VALUES(datastore_id)`,
            [virtualFolderId, r.datastore_id, r.content_pkey,
             r.study_instance_uid, r.series_instance_uid, r.sop_instance_uid]);
          assigned++;
        }
      }

      // De-identified per-VF tree hydration. When the VF has a de-id profile,
      // tag_actions drives the value swaps; otherwise the tree is a faithful
      // (non-de-id'd) per-VF copy. tag_actions is a JSON column — parse it if it
      // arrives as a string (Data API), tolerate an already-parsed array/object.
      let tagActions = vf.tag_actions;
      if (typeof tagActions === 'string') { try { tagActions = JSON.parse(tagActions); } catch { tagActions = null; } }
      if (!Array.isArray(tagActions)) tagActions = null;
      const hashSalt = effectiveSalt(vf.id); // S7: pepper + VF id (or bare VF id if unset)
      try {
        await hydrateVfTree(virtualFolderId, tagActions, hashSalt);
      } catch (e) {
        // Tree hydration failure must not lose the membership rebuild above.
        console.error(`VF ${virtualFolderId}: tree hydration failed: ${e && (e.message || e.code || JSON.stringify(e))}`);
      }
      console.log(`VF ${virtualFolderId}: hydrated ${assigned} assignment(s) from storage_index across rules`);
    } catch (err) {
      console.error('Error:', sanitizeError(err));
      throw err;
    }
  }
  return { statusCode: 200 };
};


// Test hook (de-identification unit tests); not used at runtime.
exports._test = {
  hydrateVfTree, hashValue, hashUid, shiftDate,
  setPepper(p) { _deidPepper = p; _deidPepperResolved = true; },
};
