#!/usr/bin/env node
/*
 * Count CloudFormation resources per synthesized template in cdk.out and flag
 * any stack approaching the hard 500-resource-per-stack limit.
 *
 * Usage:
 *   node scripts/count-stack-resources.js            # report all stacks
 *   node scripts/count-stack-resources.js Api        # filter by substring
 *   node scripts/count-stack-resources.js --types Api  # also break down by type
 *
 * Run `npx cdk synth` (or `npx cdk synth --all`) first to (re)generate cdk.out.
 * Exit code is non-zero if any reported stack is at/over the limit.
 */
const fs = require('fs');
const path = require('path');

const LIMIT = 500;
const WARN_AT = 450;
const CDK_OUT = path.join(__dirname, '..', 'cdk.out');

const args = process.argv.slice(2);
const showTypes = args.includes('--types');
const filter = args.find((a) => !a.startsWith('--'));

if (!fs.existsSync(CDK_OUT)) {
  console.error(`cdk.out not found at ${CDK_OUT}. Run "npx cdk synth --all" first.`);
  process.exit(2);
}

const templates = fs
  .readdirSync(CDK_OUT)
  .filter((f) => f.endsWith('.template.json'))
  .filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()));

if (templates.length === 0) {
  console.error('No matching template.json files found in cdk.out.');
  process.exit(2);
}

const rows = [];
for (const file of templates) {
  let tpl;
  try {
    tpl = JSON.parse(fs.readFileSync(path.join(CDK_OUT, file), 'utf8'));
  } catch (e) {
    console.error(`Skipping unparseable ${file}: ${e.message}`);
    continue;
  }
  const resources = tpl.Resources || {};
  const total = Object.keys(resources).length;
  const byType = {};
  for (const r of Object.values(resources)) {
    byType[r.Type] = (byType[r.Type] || 0) + 1;
  }
  rows.push({ file, total, byType });
}

rows.sort((a, b) => b.total - a.total);

let over = false;
const stackCol = Math.max(...rows.map((r) => r.file.length), 10);
console.log(`${'STACK'.padEnd(stackCol)}  COUNT  STATUS`);
for (const row of rows) {
  let status = 'ok';
  if (row.total >= LIMIT) {
    status = `OVER LIMIT (${LIMIT})`;
    over = true;
  } else if (row.total >= WARN_AT) {
    status = `WARN (>=${WARN_AT})`;
  }
  console.log(`${row.file.padEnd(stackCol)}  ${String(row.total).padStart(5)}  ${status}`);
  if (showTypes && (filter || row.total >= WARN_AT)) {
    const types = Object.entries(row.byType).sort((a, b) => b[1] - a[1]);
    for (const [type, n] of types) {
      console.log(`    ${type}: ${n}`);
    }
  }
}

process.exit(over ? 1 : 0);
