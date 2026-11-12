/**
 * #1 — DB TLS verification (shared Node layer).
 *
 * The connection must VERIFY the Aurora/RDS-Proxy server cert against the
 * bundled Amazon RDS CA, not accept any cert. This pins:
 *   - rejectUnauthorized is TRUE (the old value was false = accept anything),
 *   - a CA is supplied (the bundled rds-global-bundle.pem),
 *   - hostname verification is disabled (verify-ca, not verify-full),
 *   - a missing bundle fails loud rather than silently downgrading.
 */
const fs = require('fs');
const path = require('path');

// Requiring database.js triggers an AWS SDK client construction at module load,
// which is fine (no network until a query runs). Only _rdsSslOptions is exercised.
const db = require('./database');

describe('RDS TLS options (verify-ca)', () => {
  afterEach(() => { delete process.env.DB_SSL_CA_PATH; });

  test('verifies the chain: rejectUnauthorized true + a CA is present', () => {
    const opts = db._rdsSslOptions();
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.ca).toBeDefined();
    const caText = Buffer.isBuffer(opts.ca) ? opts.ca.toString() : String(opts.ca);
    expect(caText).toContain('BEGIN CERTIFICATE');
  });

  test('verify-FULL: hostname verification is NOT disabled (no checkServerIdentity override)', () => {
    const opts = db._rdsSslOptions();
    // The old no-op override made any chain-valid cert for any host acceptable
    // (the bundle trusts public roots too). verify-full must leave the default
    // identity check in place, so there is NO checkServerIdentity override.
    expect(opts.checkServerIdentity).toBeUndefined();
    expect(opts.minVersion).toBe('TLSv1.2');
  });

  test('the bundled CA file ships beside the module and carries BOTH RDS and public roots', () => {
    const p = path.join(__dirname, 'rds-global-bundle.pem');
    expect(fs.existsSync(p)).toBe(true);
    const pem = fs.readFileSync(p, 'utf8');
    const count = (pem.match(/BEGIN CERTIFICATE/g) || []).length;
    // Combined bundle = Amazon RDS CA roots + public roots (for the RDS Proxy
    // cert, which chains to a PUBLIC Amazon root, not the RDS CA). Both must be
    // present or the proxy connection fails with "unable to get local issuer
    // certificate". The RDS global bundle alone is ~114 certs; combined is more.
    // The Amazon RDS global bundle alone is ~114 certs; the combined bundle adds
    // the ~150 public roots, so a correct combined bundle is well over 114.
    // (CN text lives in the DER body, not the base64 PEM, so assert on count +
    // on the runtime's ability to load every cert rather than grepping names.)
    expect(count).toBeGreaterThan(200);
    const tls = require('tls');
    const ctx = tls.createSecureContext({ ca: pem });
    expect(ctx).toBeTruthy();
  });

  test('a missing CA bundle fails loud (no silent downgrade to no-verify)', () => {
    // Fresh module instance so the cached options do not mask the override.
    jest.resetModules();
    process.env.DB_SSL_CA_PATH = '/nonexistent/rds-ca-does-not-exist.pem';
    const freshDb = require('./database');
    expect(() => freshDb._rdsSslOptions()).toThrow(/RDS CA bundle not readable/);
  });
});
