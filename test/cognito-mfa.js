'use strict';
// Cognito sign-in for the test scripts, with TOTP MFA. JS twin of cognito_mfa.py:
// same flow (MFA_SETUP enrolment, SOFTWARE_TOKEN_MFA answers), same secret store
// ($TEST_MFA_DIR, default <tmpdir>/dicom-archive-test-mfa, files mode 0600) and the
// same one-sign-in-per-30s-step rule, so either language can sign in a user the other
// enrolled. TEST-ONLY credentials for disposable test users.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  InitiateAuthCommand, AssociateSoftwareTokenCommand, VerifySoftwareTokenCommand,
  RespondToAuthChallengeCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const STEP = 30;

function mfaDir() {
  const d = process.env.TEST_MFA_DIR || path.join(os.tmpdir(), 'dicom-archive-test-mfa');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

function filePath(clientId, username, kind) {
  const safe = `${clientId}__${username}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(mfaDir(), `${safe}.${kind}`);
}

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error('bad base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, stepIndex) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(stepIndex ?? Math.floor(Date.now() / 1000 / STEP)));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(off) & 0x7fffffff) % 1000000;
  return String(code).padStart(6, '0');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One sign-in per user per 30 s step (Cognito refuses a reused TOTP code).
// The step file is shared with cognito_mfa.py; suites run one at a time.
async function freshStep(clientId, username) {
  const p = filePath(clientId, username, 'step');
  const last = fs.existsSync(p) ? parseInt(fs.readFileSync(p, 'utf8').trim() || '-1', 10) : -1;
  let now = Math.floor(Date.now() / 1000 / STEP);
  if (now <= last) {
    await sleep(((last + 1) * STEP - Date.now() / 1000 + 0.5) * 1000);
    now = Math.floor(Date.now() / 1000 / STEP);
  }
  fs.writeFileSync(p, String(now));
  return now;
}

async function signIn(cognito, clientId, username, password) {
  const secretPath = filePath(clientId, username, 'totp');
  let r = await cognito.send(new InitiateAuthCommand({
    ClientId: clientId, AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: username, PASSWORD: password },
  }));
  for (let i = 0; i < 3; i++) {
    if (r.AuthenticationResult) return r.AuthenticationResult;
    if (r.ChallengeName === 'MFA_SETUP') {
      const a = await cognito.send(new AssociateSoftwareTokenCommand({ Session: r.Session }));
      const step = await freshStep(clientId, username);
      const v = await cognito.send(new VerifySoftwareTokenCommand({
        Session: a.Session, UserCode: totp(a.SecretCode, step), FriendlyDeviceName: 'e2e-tests',
      }));
      if (v.Status !== 'SUCCESS') throw new Error(`TOTP verify failed for ${username}`);
      fs.writeFileSync(secretPath, a.SecretCode, { mode: 0o600 });
      r = await cognito.send(new RespondToAuthChallengeCommand({
        ClientId: clientId, ChallengeName: 'MFA_SETUP', Session: v.Session,
        ChallengeResponses: { USERNAME: username },
      }));
    } else if (r.ChallengeName === 'SOFTWARE_TOKEN_MFA') {
      if (!fs.existsSync(secretPath)) {
        throw new Error(`${username} is enrolled in TOTP but no secret is stored in ${mfaDir()}`);
      }
      const step = await freshStep(clientId, username);
      r = await cognito.send(new RespondToAuthChallengeCommand({
        ClientId: clientId, ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: r.Session,
        ChallengeResponses: {
          USERNAME: username,
          SOFTWARE_TOKEN_MFA_CODE: totp(fs.readFileSync(secretPath, 'utf8').trim(), step),
        },
      }));
    } else {
      throw new Error(`unexpected Cognito challenge for ${username}: ${r.ChallengeName}`);
    }
  }
  throw new Error(`sign-in for ${username} did not complete`);
}

module.exports = { signIn, totp };
