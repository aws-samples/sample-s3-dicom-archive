'use strict';

/**
 * Per-VF database lifecycle helper (VF Per-Database Redesign, Phase 1).
 *
 * Each virtual folder gets its OWN MySQL database `vf_<sanitized-uuid>` holding
 * its de-identified tree (vf_<id>_patient/study/series/instance). This isolates
 * a VF for a raw-SQL customer via `GRANT SELECT ON vf_<id>.*` — the shared
 * `virtual_*` tree could only be row-scoped by a virtual_folder_id column, which
 * a SQL client bypasses.
 *
 * Design source of truth: plans/VF-PER-DATABASE-REDESIGN.md.
 *
 * Differences from the shared virtual_* defs (schema-virtual-folder.sql):
 *   (a) No virtual_folder_id column / key / FK — the DATABASE is the scope.
 *   (b) vf_<id>_instance carries BOTH content_pkey AND instance_pkey and is
 *       UNIQUE on instance_pkey (not content_pkey), so WSI pyramid levels stay
 *       distinct (the shared virtual_instance keyed on content_pkey and
 *       collapsed levels).
 *   (c) NO cross-database FKs. Intra-tree parent links (instance->series->
 *       study->patient) are FKs INSIDE vf_<id>. Links to the shared
 *       storage_index/instance (content_pkey, instance_pkey) are plain indexed
 *       columns — the app / a privileged extractor resolves them.
 *   (d) Reserved words `rows`/`columns` are backticked.
 *
 * This runs over the RDS Data API `query(sql, params, secretArn)` helper the VF
 * API lambda already uses. All DDL is either database-scoped (CREATE DATABASE /
 * USER / GRANT) or fully database-qualified (CREATE TABLE `vf_x`.`vf_x_patient`
 * ...), so it does not depend on the connection's default schema (which the
 * shared helper pins to DB_NAME). Data API cannot parameterize DDL identifiers,
 * so the vf-db name is built ONLY from a validated UUID (see vfDbName).
 */

const crypto = require('crypto');

// Strict UUID v-any matcher. We validate BEFORE deriving any identifier so no
// unvalidated input is ever interpolated into DDL.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Derive the per-VF database name from a VF UUID.
 * Scheme: 'vf_' + uuid.toLowerCase().replace(/-/g,'') -> 'vf_' + 32 hex chars.
 * Throws if the input is not a valid UUID (never interpolate unvalidated input).
 * @param {string} vfId
 * @returns {string} e.g. 'vf_dfab76ff7aa049019a62359518ce4b1f'
 */
function vfDbName(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vf_' + vfId.toLowerCase().replace(/-/g, '');
}

/**
 * Derive the per-VF read-only MySQL username. Deterministic from the VF id so
 * deprovision can DROP it without extra state. <= 32 chars (MySQL limit):
 * 'vfro_' (5) + 27 hex = 32.
 * @param {string} vfId
 * @returns {string}
 */
function vfRoUser(vfId) {
  if (typeof vfId !== 'string' || !UUID_RE.test(vfId)) {
    throw new Error(`Invalid virtual folder id (must be a UUID): ${vfId}`);
  }
  return 'vfro_' + vfId.toLowerCase().replace(/-/g, '').slice(0, 27);
}

// The tree DDL lives in the shared layer so the indexer rebuilds an outdated
// tree with exactly the same definition (no original_* columns).
const { renderTreeDDL } = require('/opt/nodejs/vf-tree-ddl');

/**
 * Generate an alphanumeric password (no punctuation) safe to embed in DDL —
 * matches the constraint the analytics RO provisioner enforces (Data API cannot
 * parameterize a CREATE USER password).
 * @returns {string}
 */
function generateAlnumPassword(len = 32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Provision a VF's database and tree tables. Idempotent (IF NOT EXISTS).
 *
 * Runs as the app DB user, which holds CREATE/DROP/DML on the `vf\\_%` database
 * pattern (granted by schema-init), so no grant or user is created here:
 *   - the app user already reaches every vf_<id> through that pattern;
 *   - folder analytics read it as analytics_vf_ro through its own wildcard
 *     SELECT grant; the storage analytics user has none (EdgeSwarm D-2).
 * The per-folder 'vfro_<id>' users this used to create were never used (their
 * password was not stored) and needed the master user; schema-init removes the
 * leftovers.
 *
 * @param {string} vfId  the VF UUID (validated).
 * @param {(sql: string, params?: any[]) => Promise<any>} query
 * @returns {Promise<{vfDb:string}>}
 */
async function provisionVfDatabase(vfId, query) {
  const vfDb = vfDbName(vfId);
  await query(`CREATE DATABASE IF NOT EXISTS \`${vfDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  // Tree tables (fully qualified, no dependence on the session default schema).
  for (const ddl of renderTreeDDL(vfDb)) {
    await query(ddl);
  }
  return { vfDb };
}

/**
 * Drop a VF's database. Idempotent (IF EXISTS).
 *
 * @param {string} vfId
 * @param {(sql: string, params?: any[]) => Promise<any>} query
 * @returns {Promise<{vfDb:string}>}
 */
async function deprovisionVfDatabase(vfId, query) {
  const vfDb = vfDbName(vfId);
  await query(`DROP DATABASE IF EXISTS \`${vfDb}\``);
  return { vfDb };
}

module.exports = {
  vfDbName,
  vfRoUser,
  renderTreeDDL,
  provisionVfDatabase,
  deprovisionVfDatabase,
};
