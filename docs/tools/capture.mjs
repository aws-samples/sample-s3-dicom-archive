#!/usr/bin/env node
// Documentation screenshot capture.
//
// Usage:
//   DOCS_BASE_URL=https://<cloudfront-domain> DOCS_USER=admin DOCS_PASSWORD_FILE=<file> \
//     [DOCS_TOKEN=<access token, only for shots whose path contains <access-token>>] \
//     node docs/tools/capture.mjs <shots.json> [--only name1,name2] [--headed]
//
// shots.json is an array of shot objects:
//   {
//     "name": "storage-list",                 // output: docs/images/<name>.png
//     "path": "/admin/datastores",            // path under DOCS_BASE_URL (or "url" for absolute)
//     "app": "admin" | "data-user" | "none",  // which login flow to run first (default admin)
//     "steps": [                              // optional, run in order before the screenshot
//       {"click": "text=Create storage"},
//       {"fill": "input[name=name]", "value": "demo-studies"},
//       {"press": "Escape"},
//       {"wait": "text=Active"},              // wait for selector
//       {"sleep": 1500},
//       {"scroll": "css=.footer"}
//     ],
//     "callouts": [                           // numbered red boxes drawn on the page
//       {"selector": "text=Create storage", "label": "1"},
//       {"selector": "table >> nth=0", "label": "2"}
//     ],
//     "redact": [["secret-\\w+", "••••"]],    // optional extra regex -> replacement (defaults always apply)
//     "mask": ["css=.token-value"],           // optional: paint over these elements
//     "clip": "css=main",                     // optional: screenshot only this element
//     "viewport": {"width": 1440, "height": 900},
//     "fullPage": false
//   }
//
// Selectors are Playwright selectors (css=, text=, role=, xpath=). A callout whose selector
// matches nothing is reported and skipped, never fatal, so one stale selector does not lose a run.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'images');
const args = process.argv.slice(2);
const specFile = args.find((a) => !a.startsWith('--'));
if (!specFile) { console.error('usage: capture.mjs <shots.json> [--only a,b] [--headed]'); process.exit(2); }
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;
const headed = args.includes('--headed');

const BASE = (process.env.DOCS_BASE_URL || '').replace(/\/$/, '');
const USER = process.env.DOCS_USER || 'admin';
const PW = process.env.DOCS_PASSWORD
  || (process.env.DOCS_PASSWORD_FILE ? fs.readFileSync(process.env.DOCS_PASSWORD_FILE, 'utf8').trim() : '');
if (!BASE || !PW) { console.error('DOCS_BASE_URL and DOCS_PASSWORD(_FILE) are required'); process.exit(2); }

const shots = JSON.parse(fs.readFileSync(specFile, 'utf8')).filter((s) => !only || only.has(s.name));
fs.mkdirSync(outDir, { recursive: true });

async function login(page, base) {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const user = page.locator('input[type="text"], input[type="email"], input[name="username"]').first();
  try { await user.waitFor({ timeout: 15000 }); } catch { return; } // already signed in
  await user.fill(USER);
  await page.locator('input[type="password"]').first().fill(PW);
  await page.locator('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), button[type="submit"]').first().click();
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

async function drawCallouts(page, callouts) {
  const missing = [];
  for (const c of callouts || []) {
    const loc = page.locator(c.selector).first();
    let box = null;
    try { await loc.waitFor({ state: 'visible', timeout: 5000 }); box = await loc.boundingBox(); } catch {}
    if (!box) { missing.push(c.selector); continue; }
    await page.evaluate(({ box, label, color }) => {
      const pad = 4;
      const sx = window.scrollX, sy = window.scrollY;
      const r = document.createElement('div');
      r.className = '__doc_callout';
      Object.assign(r.style, {
        position: 'absolute', left: `${box.x + sx - pad}px`, top: `${box.y + sy - pad}px`,
        width: `${box.width + pad * 2}px`, height: `${box.height + pad * 2}px`,
        border: `3px solid ${color}`, borderRadius: '6px', zIndex: 2147483646, pointerEvents: 'none',
        boxShadow: '0 0 0 2px rgba(255,255,255,0.85)',
      });
      const b = document.createElement('div');
      b.className = '__doc_callout';
      b.textContent = label;
      Object.assign(b.style, {
        position: 'absolute', left: `${Math.max(0, box.x + sx - pad - 14)}px`, top: `${Math.max(0, box.y + sy - pad - 14)}px`,
        minWidth: '26px', height: '26px', padding: '0 6px', borderRadius: '13px', background: color, color: '#fff',
        font: 'bold 15px/26px system-ui, sans-serif', textAlign: 'center', zIndex: 2147483647, pointerEvents: 'none',
        boxShadow: '0 1px 4px rgba(0,0,0,0.4)', boxSizing: 'border-box',
      });
      document.body.appendChild(r); document.body.appendChild(b);
    }, { box, label: String(c.label), color: c.color || '#e5242b' });
  }
  return missing;
}

// Deployment-specific values must never ship in a doc image. Every shot rewrites visible
// text and input values matching these patterns (plus the shot's own "redact" regexes)
// before the screenshot. "mask" selectors are additionally painted over by Playwright.
const DEFAULT_REDACT = [
  ['\\b\\d{12}\\b', '123456789012'],                                   // AWS account IDs
  ['[a-z0-9]{10,16}\\.cloudfront\\.net', 'dxxxxxxxxxxxxx.cloudfront.net'],
  ['[a-z0-9]{10}\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com', 'xxxxxxxxxx.execute-api.region.amazonaws.com'],
  ['[A-Za-z0-9-]+\\.elb\\.[a-z0-9-]+\\.amazonaws\\.com', 'prefix-dicom-nlb-0123456789abcdef.elb.region.amazonaws.com'],
  ['\\bip-\\d+-\\d+-\\d+-\\d+(\\.[a-z0-9-]+)?\\.compute\\.internal\\b', 'ip-10-0-0-10.region.compute.internal'],
  ['\\b[a-z]{2}-[a-z]+-\\d_[A-Za-z0-9]{9}\\b', 'region_XXXXXXXXX'],     // Cognito pool IDs
  ['\\b[a-z0-9]{26}\\b', 'xxxxxxxxxxxxxxxxxxxxxxxxxx'],                // Cognito app-client IDs
  ['eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', '<JWT redacted>'],
  ['\\bAKIA[0-9A-Z]{16}\\b', 'AKIAXXXXXXXXXXXXXXXX'],
  // Real e-mail addresses -> example.com (example.com addresses are already fictitious).
  ['\\b[A-Za-z0-9._%+-]+@(?!example\\.com\\b)[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b', 'admin@example.com'],
  // IPv4 -> documentation range. Lookarounds keep DICOM UIDs (long dotted digit runs) intact,
  // and addresses already in the RFC 5737 documentation ranges are left alone.
  ['(?<![\\d.])(?!192\\.0\\.2\\.|198\\.51\\.100\\.|203\\.0\\.113\\.)(?:\\d{1,3}\\.){3}\\d{1,3}(?![\\d.]*\\d)', '203.0.113.10'],
];
async function redact(page, extra) {
  const rules = DEFAULT_REDACT.concat(extra.map((r) => (Array.isArray(r) ? r : [r, '••••'])));
  await page.evaluate((rules) => {
    const res = rules.map(([p, r]) => [new RegExp(p, 'g'), r]);
    const fix = (t) => res.reduce((acc, [re, r]) => acc.replace(re, r), t);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) { const v = fix(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
    document.querySelectorAll('input, textarea').forEach((el) => { const v = fix(el.value || ''); if (v !== el.value) el.value = v; });
  }, rules);
}

async function runStep(page, s) {
  if (s.click) await page.locator(s.click).first().click({ timeout: 15000 });
  else if (s.fill) await page.locator(s.fill).first().fill(String(s.value ?? ''), { timeout: 15000 });
  else if (s.select) await page.locator(s.select).first().selectOption(String(s.value), { timeout: 15000 });
  else if (s.press) await page.keyboard.press(s.press);
  else if (s.hover) await page.locator(s.hover).first().hover({ timeout: 15000 });
  else if (s.wait) await page.locator(s.wait).first().waitFor({ timeout: s.timeout || 30000 });
  else if (s.sleep) await page.waitForTimeout(s.sleep);
  else if (s.scroll) await page.locator(s.scroll).first().scrollIntoViewIfNeeded();
  else if (s.goto) await page.goto(s.goto.startsWith('http') ? s.goto : BASE + s.goto, { waitUntil: 'domcontentloaded' });
}

const browser = await chromium.launch({ headless: !headed });
const contexts = {};
async function pageFor(app, viewport) {
  const key = `${app}:${viewport.width}x${viewport.height}`;
  if (!contexts[key]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'light' });
    const page = await ctx.newPage();
    // The admin UI is served under /admin/ and the data-user UI under /data-user/.
    if (app === 'admin') await login(page, BASE + '/admin');
    if (app === 'data-user') await login(page, BASE + '/data-user');
    contexts[key] = page;
  }
  return contexts[key];
}

let failures = 0;
for (const shot of shots) {
  const viewport = shot.viewport || { width: 1440, height: 900 };
  const app = shot.app || 'admin';
  try {
    const page = await pageFor(app, viewport);
    // "<access-token>" in a path/url is replaced by DOCS_TOKEN (e.g. for the OHIF viewer link),
    // so shot files never hold a real token.
    const target = (shot.url || BASE + (shot.path || '/')).replace('<access-token>', encodeURIComponent(process.env.DOCS_TOKEN || ''));
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(shot.settle ?? 1200);
    for (const s of shot.steps || []) await runStep(page, s);
    await redact(page, shot.redact || []);
    const missing = await drawCallouts(page, shot.callouts);
    const file = path.join(outDir, `${shot.name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mask = (shot.mask || []).map((sel) => page.locator(sel));
    if (shot.clip) await page.locator(shot.clip).first().screenshot({ path: file, mask });
    else await page.screenshot({ path: file, fullPage: !!shot.fullPage, mask });
    await page.evaluate(() => document.querySelectorAll('.__doc_callout').forEach((n) => n.remove()));
    // Leave any modal the steps opened so the next shot starts clean.
    await page.keyboard.press('Escape').catch(() => {});
    console.log(`OK   ${shot.name}${missing.length ? `  (callouts not found: ${missing.join(' | ')})` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${shot.name}: ${String(e.message || e).split('\n')[0]}`);
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
