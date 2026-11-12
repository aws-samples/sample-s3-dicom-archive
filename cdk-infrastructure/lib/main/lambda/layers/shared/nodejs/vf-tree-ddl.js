'use strict';

/**
 * Per-VF de-id tree: names, DDL and the opaque source keys. Shared (layer) so
 * the folder API (creates the tree) and the indexer (rebuilds an outdated tree)
 * use ONE definition. The Python vf-deid-consumer mirrors sourcePatientKey().
 *
 * Security: the tree holds NO original identifier. The old original_* columns
 * (PatientID, PatientName, accession, dates, descriptions, referring physician)
 * were readable by every folder reader through folder analytics and getStudies.
 * Rows are now de-duplicated on:
 *   - patient: source_key = HMAC-SHA256(pepper, vfId \x1f PatientID \x1f Issuer),
 *     an opaque key that cannot be reversed or brute-forced without the
 *     per-deployment pepper secret, which no folder reader can read;
 *   - study/series/instance: the UIDs the tree already exposes (v1 keeps the
 *     real UIDs, see vf_deid.py), so no extra identifier is stored.
 *
 * TREE_SCHEMA_MARKER is a column only the current schema has; a tree without it
 * was built by an older release and is dropped and recreated (the tree is
 * derived data, rebuilt from virtual_folder_assignments by the indexer).
 */

const crypto = require('crypto');

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const TREE_SCHEMA_MARKER = { leaf: 'patient', column: 'source_key' };
const TREE_LEAVES_DROP_ORDER = ['series_tracker', 'instance', 'series', 'study', 'patient'];

function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}

function assertVfDb(vfDb) {
  if (!/^vf_[0-9a-f]{32}$/.test(vfDb)) {
    throw new Error(`Refusing to build SQL for unexpected vf-db name: ${vfDb}`);
  }
}

/**
 * Opaque per-folder patient key. MUST match vf-deid-consumer/handler.py
 * _source_patient_key byte for byte. Throws without a pepper: an unpeppered
 * hash of a low-entropy PatientID would be brute-forceable (fail closed).
 */
function sourcePatientKey(pepper, vfId, patientId, issuer) {
  if (!pepper) throw new Error('de-id pepper is required to key a folder patient');
  return crypto.createHmac('sha256', pepper)
    .update(`${vfId}\x1f${patientId || ''}\x1f${issuer || ''}`, 'utf8')
    .digest('hex');
}

/** CREATE TABLE statements for a VF tree (fully database-qualified). */
function renderTreeDDL(vfDb) {
  assertVfDb(vfDb);
  const q = (t) => `\`${vfDb}\`.\`${vfDb}_${t}\``;

  const patient = `CREATE TABLE IF NOT EXISTS ${q('patient')} (
    patient_pkey BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    source_key CHAR(64) NOT NULL,
    issuerofpatientid VARCHAR(64) NOT NULL DEFAULT '',
    source_datastoreid VARCHAR(64) NOT NULL,
    patientid VARCHAR(64) NULL,
    patientname VARCHAR(64) NULL,
    patientbirthdate DATE NULL,
    patientsex VARCHAR(64) NULL,   -- 64: a HASH rule writes a 64-char value (review 3, F9)
    patientcomments TEXT NULL,
    PRIMARY KEY (patient_pkey),
    UNIQUE KEY uk_patient (source_key),
    INDEX idx_patientid (patientid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  const study = `CREATE TABLE IF NOT EXISTS ${q('study')} (
    study_pkey BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    patient_pkey BIGINT UNSIGNED NOT NULL,
    source_datastoreid VARCHAR(64) NOT NULL,
    studyinstanceuid VARCHAR(64) NOT NULL,
    accessionnumber VARCHAR(64) NULL,
    studyid VARCHAR(64) NULL,
    studydate DATE NULL,
    studytime TIME NULL,
    studydescription VARCHAR(64) NULL,
    referringphysicianname VARCHAR(64) NULL,
    modalitiesinstudy VARCHAR(255) NULL,
    numberofstudyrelatedseries INT NULL,
    numberofstudyrelatedinstances INT NULL,
    PRIMARY KEY (study_pkey),
    UNIQUE KEY uk_study (studyinstanceuid),
    INDEX idx_patient_pkey (patient_pkey),
    FOREIGN KEY (patient_pkey) REFERENCES ${q('patient')}(patient_pkey) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  const series = `CREATE TABLE IF NOT EXISTS ${q('series')} (
    series_pkey BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    study_pkey BIGINT UNSIGNED NOT NULL,
    source_datastoreid VARCHAR(64) NOT NULL,
    seriesinstanceuid VARCHAR(64) NOT NULL,
    modality VARCHAR(16) NULL,
    seriesnumber VARCHAR(12) NULL,
    seriesdescription VARCHAR(64) NULL,
    institutionname VARCHAR(64) NULL,
    bodypartexamined VARCHAR(16) NULL,
    stationname VARCHAR(16) NULL,
    manufacturer VARCHAR(64) NULL,
    protocolname VARCHAR(64) NULL,
    laterality VARCHAR(16) NULL,
    numberofseriesrelatedinstances INT NULL,
    PRIMARY KEY (series_pkey),
    UNIQUE KEY uk_series (seriesinstanceuid, source_datastoreid),
    INDEX idx_study_pkey (study_pkey),
    FOREIGN KEY (study_pkey) REFERENCES ${q('study')}(study_pkey) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  // instance: keyed on instance_pkey (WSI pyramid levels stay distinct).
  // content_pkey + instance_pkey are plain indexed cross-DB links (no FK).
  const instance = `CREATE TABLE IF NOT EXISTS ${q('instance')} (
    instance_pkey BIGINT UNSIGNED NOT NULL,
    content_pkey BIGINT UNSIGNED NULL,
    series_pkey BIGINT UNSIGNED NOT NULL,
    source_datastoreid VARCHAR(64) NOT NULL,
    sopinstanceuid VARCHAR(64) NOT NULL,
    sopclassuid VARCHAR(64) NOT NULL,
    imagetype VARCHAR(64) NULL,
    instancenumber INT NULL,
    acquisitiondate DATE NULL,
    acquisitiontime TIME NULL,
    contentdate DATE NULL,
    contenttime TIME NULL,
    photometricinterpretation VARCHAR(16) NULL,
    numberofframes INT NULL,
    \`rows\` INT NULL,
    \`columns\` INT NULL,
    bitsallocated INT NULL,
    bitsstored INT NULL,
    highbit INT NULL,
    rescaleslope VARCHAR(16) NULL,
    rescaleintercept VARCHAR(16) NULL,
    pixelrepresentation INT NULL,
    windowcenter VARCHAR(16) NULL,
    windowwidth VARCHAR(16) NULL,
    imagelaterality VARCHAR(16) NULL,
    PRIMARY KEY (instance_pkey),
    INDEX idx_content_pkey (content_pkey),
    INDEX idx_sopinstanceuid (sopinstanceuid),
    INDEX idx_series_pkey (series_pkey),
    FOREIGN KEY (series_pkey) REFERENCES ${q('series')}(series_pkey) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  // Per-VF monotonic watermark used by the vf-deid-consumer.
  const seriesTracker = `CREATE TABLE IF NOT EXISTS ${q('series_tracker')} (
    series_instance_uid VARCHAR(64) NOT NULL,
    study_instance_uid VARCHAR(64) NULL,
    datastore_id VARCHAR(64) NULL,
    last_content_pkey BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (series_instance_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

  return [patient, study, series, instance, seriesTracker];
}

/**
 * True when the vf_<id> tree exists with the current schema: the D-3 marker
 * column is there, and patientsex is wide enough for a HASH value (F9; a tree
 * with the old VARCHAR(16) is rebuilt like any other outdated tree).
 */
async function isTreeSchemaCurrent(query, vfDb) {
  assertVfDb(vfDb);
  const rows = await query(
    `SELECT (SUM(COLUMN_NAME = ?) > 0
             AND SUM(COLUMN_NAME = 'patientsex' AND CHARACTER_MAXIMUM_LENGTH >= 64) > 0) AS n
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [TREE_SCHEMA_MARKER.column, vfDb, `${vfDb}_${TREE_SCHEMA_MARKER.leaf}`]);
  return Number(rows && rows[0] && rows[0].n) > 0;
}

/**
 * Bring a VF tree to the current schema. A tree from an older release is
 * dropped and recreated EMPTY (it is derived data); the caller re-hydrates it.
 * Returns true when the tree was rebuilt.
 */
async function ensureTreeSchema(query, vfDb) {
  assertVfDb(vfDb);
  if (await isTreeSchemaCurrent(query, vfDb)) return false;
  await query(`CREATE DATABASE IF NOT EXISTS \`${vfDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const leaf of TREE_LEAVES_DROP_ORDER) {
    await query(`DROP TABLE IF EXISTS \`${vfDb}\`.\`${vfDb}_${leaf}\``);
  }
  for (const ddl of renderTreeDDL(vfDb)) await query(ddl);
  return true;
}

module.exports = {
  UUID_RE,
  TREE_SCHEMA_MARKER,
  vfDbName,
  sourcePatientKey,
  renderTreeDDL,
  isTreeSchemaCurrent,
  ensureTreeSchema,
};
