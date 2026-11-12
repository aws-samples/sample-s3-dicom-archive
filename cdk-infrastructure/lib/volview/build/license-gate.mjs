#!/usr/bin/env node
// License gate + THIRD-PARTY-NOTICES for the VolView build (no dependencies).
//
//   node license-gate.mjs <license-checker.json> <distDir> <noticesOut>
//
// <license-checker.json> is `license-checker-rseidelsohn --json` over the WHOLE
// installed tree. `--production` is useless for VolView: every package it ships
// is declared under devDependencies, so a production scan sees only the root.
//
// Gate (exit 1):
//  - ANY installed package (shipped or build tooling) whose license expression
//    is GPL / AGPL / SSPL in every alternative. A dual licence that offers a
//    permissive choice ("MIT OR GPL-3.0-or-later") passes; LGPL is not matched.
//    license-checker's own --failOn is an exact string match, so "GPL-3.0" would
//    not catch "GPL-3.0-or-later"; this gate matches the whole family.
//  - any SHIPPED package with no recognisable licence (missing/UNKNOWN/UNLICENSED).
//
// "Shipped" = every node_modules package that appears in the build's source maps
// plus the packages copied in as static assets (itk-wasm pipelines, fonts). The
// notices file lists exactly that set with each package's licence text.
import fs from 'node:fs';
import path from 'node:path';

const [jsonPath, distDir, noticesOut] = process.argv.slice(2);
if (!jsonPath || !distDir || !noticesOut) {
  console.error('usage: license-gate.mjs <license-checker.json> <distDir> <noticesOut>');
  process.exit(2);
}

// Copied by vite-plugin-static-copy / referenced from CSS, so absent from JS maps.
const STATIC_ASSET_PACKAGES = [
  'itk-wasm',
  '@itk-wasm/image-io',
  '@itk-wasm/dicom',
  '@itk-wasm/morphological-contour-interpolation',
  '@fontsource/roboto',
  '@mdi/font',
];

const FORBIDDEN = /^(A?GPL|SSPL)/i; // GPL-*, GPLv3, AGPL-*, SSPL-*; LGPL does not match
const NO_LICENSE = /^(UNKNOWN|UNLICENSED|NONE|CUSTOM)/i;

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const entries = Object.entries(data).map(([id, info]) => ({
  id,
  info,
  real: fs.realpathSync(info.path),
}));
const byPath = new Map(entries.map((e) => [e.real, e]));

const alternatives = (licenses) => {
  const list = Array.isArray(licenses) ? licenses : [String(licenses ?? '')];
  return list.flatMap((expr) =>
    expr
      .replace(/[()*]/g, ' ')
      .split(/\s+OR\s+/i)
      .map((alt) => alt.split(/\s+AND\s+/i).map((t) => t.trim()).filter(Boolean)),
  );
};
const isForbidden = (licenses) => {
  const alts = alternatives(licenses);
  return alts.length > 0 && alts.every((tokens) => tokens.some((t) => FORBIDDEN.test(t)));
};
const hasNoLicense = (licenses) => {
  const alts = alternatives(licenses);
  return alts.length === 0 || alts.every((tokens) => tokens.length === 0 || tokens.every((t) => NO_LICENSE.test(t)));
};

// ---- shipped set
const pkgRootOf = (file) => {
  const i = file.lastIndexOf(`node_modules${path.sep}`);
  if (i < 0) return null;
  const rest = file.slice(i + 13).split(path.sep);
  const name = rest[0].startsWith('@') ? `${rest[0]}${path.sep}${rest[1]}` : rest[0];
  return file.slice(0, i + 13) + name;
};
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)],
  );

const shipped = new Map();
const problems = [];
for (const mapFile of walk(distDir).filter((f) => f.endsWith('.map'))) {
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const base = path.resolve(path.dirname(mapFile), map.sourceRoot || '');
  for (const src of map.sources || []) {
    const root = pkgRootOf(path.resolve(base, src));
    if (!root) continue;
    let real;
    try { real = fs.realpathSync(root); } catch { continue; } // virtual module
    const entry = byPath.get(real);
    if (entry) shipped.set(entry.id, entry);
    else problems.push(`shipped package not in license report: ${root}`);
  }
}
for (const name of STATIC_ASSET_PACKAGES) {
  const real = fs.realpathSync(path.resolve('node_modules', name));
  const entry = byPath.get(real);
  if (entry) shipped.set(entry.id, entry);
  else problems.push(`static-asset package not in license report: ${name}`);
}

// ---- gate
for (const e of entries) {
  if (isForbidden(e.info.licenses)) problems.push(`forbidden licence ${JSON.stringify(e.info.licenses)}: ${e.id}`);
}
for (const e of shipped.values()) {
  if (hasNoLicense(e.info.licenses)) problems.push(`shipped package has no licence: ${e.id}`);
}

// ---- summary
const tally = (list) => {
  const t = {};
  for (const e of list) {
    const k = Array.isArray(e.info.licenses) ? e.info.licenses.join(' OR ') : String(e.info.licenses);
    t[k] = (t[k] || 0) + 1;
  }
  return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k}: ${n}`).join('\n');
};
console.log(`Installed tree: ${entries.length} packages\n${tally(entries)}`);
console.log(`Shipped in dist/: ${shipped.size} packages\n${tally([...shipped.values()])}`);

if (problems.length) {
  for (const p of [...new Set(problems)]) console.error(`LICENSE GATE FAILED: ${p}`);
  process.exit(1);
}

// ---- notices
const sorted = [...shipped.values()].sort((a, b) => a.id.localeCompare(b.id));
const parts = [
  'THIRD-PARTY SOFTWARE NOTICES',
  '',
  'This build of Kitware VolView (https://github.com/Kitware/VolView, Apache-2.0)',
  'includes the following third-party packages.',
  '',
];
for (const e of sorted) {
  let text = '';
  if (e.info.licenseFile) {
    try { text = fs.readFileSync(e.info.licenseFile, 'utf8').trim(); } catch { /* none */ }
  }
  parts.push(
    '-'.repeat(78),
    `${e.id}`,
    `License: ${Array.isArray(e.info.licenses) ? e.info.licenses.join(' OR ') : e.info.licenses}`,
    ...(e.info.repository ? [`Repository: ${e.info.repository}`] : []),
    ...(e.info.publisher ? [`Publisher: ${e.info.publisher}`] : []),
    '',
    text || '(no licence file in the package; licence per its package.json)',
    '',
  );
}
fs.writeFileSync(noticesOut, `${parts.join('\n')}\n`);
console.log(`Wrote ${noticesOut} (${sorted.length} packages)`);
