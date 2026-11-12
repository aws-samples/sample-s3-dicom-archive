#!/usr/bin/env node
// Creates the test privilege groups and users from test-profiles.json through
// the ADMIN REST API (the RDS Data API is disabled on the cluster, EdgeSwarm
// F-7, so nothing writes to the database from outside the VPC any more).
//
// Signs in as an existing administrator (ADMIN_USERNAME / ADMIN_PASSWORD, with
// the app client CLIENT_ID allowing USER_PASSWORD_AUTH), then for each profile:
//   - creates or updates the group "Test <profile name>" (POST/PUT /privilege-groups),
//   - creates the user test-<key> in that group (POST /users), skipping one that exists,
//   - sets the profile's password as permanent in Cognito (AdminSetUserPassword).
// Groups are found again by NAME, since the API assigns their ids.
//
// Env: API_BASE_URL, USER_POOL_ID, CLIENT_ID, ADMIN_USERNAME, ADMIN_PASSWORD, AWS_REGION.
const {
  CognitoIdentityProviderClient, AdminSetUserPasswordCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { signIn } = require('./cognito-mfa');
const fs = require('fs');
const path = require('path');

const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-profiles.json'), 'utf8'));
const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'us-east-1' });
const { API_BASE_URL, USER_POOL_ID, CLIENT_ID, ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;

async function api(token, method, p, body) {
  const res = await fetch(API_BASE_URL.replace(/\/$/, '') + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}
const data = (b) => (b && b.data !== undefined ? b.data : b);

async function main() {
  const missing = ['API_BASE_URL', 'USER_POOL_ID', 'CLIENT_ID', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`ERROR: missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  const token = (await signIn(cognito, CLIENT_ID, ADMIN_USERNAME, ADMIN_PASSWORD)).AccessToken;

  // The list endpoint may return a bare array, {data:[...]}, or {data:{items:[...]}}
  // depending on API version — normalize to an array.
  const groupsRaw = data((await api(token, 'GET', '/privilege-groups')).body);
  const groups = Array.isArray(groupsRaw) ? groupsRaw : (groupsRaw?.items || []);
  let failures = 0;
  for (const [key, profile] of Object.entries(profiles)) {
    console.log(`\nSetting up ${profile.name} (${key})...`);
    try {
      const groupName = `Test ${profile.name}`;
      const groupBody = {
        name: groupName,
        description: `Test privilege group for ${profile.name}`,
        userMode: 'SYSTEM_USER',
        datastorePrivileges: profile.datastorePrivileges || [],
        virtualFolderPrivileges: profile.virtualFolderPrivileges || [],
        managementPrivileges: profile.managementPrivileges || {},
      };
      let group = groups.find(g => g.name === groupName);
      if (group) {
        const r = await api(token, 'PUT', `/privilege-groups/${group.id}`, groupBody);
        if (r.status !== 200) throw new Error(`update group: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        console.log(`  ✓ Updated privilege group ${groupName} (${group.id})`);
      } else {
        const r = await api(token, 'POST', '/privilege-groups', groupBody);
        if (r.status !== 200 && r.status !== 201) throw new Error(`create group: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        group = data(r.body);
        console.log(`  ✓ Created privilege group ${groupName} (${group.id})`);
      }

      const [firstName, ...rest] = profile.name.split(' ');
      const username = profile.username || `test-${key.toLowerCase()}`;
      const u = await api(token, 'POST', '/users', {
        username, email: profile.email, firstName, lastName: rest.join(' ') || 'User',
        description: `Test user (${key})`, privilegeGroupId: group.id, password: profile.password,
      });
      if (u.status === 200 || u.status === 201) console.log(`  ✓ Created user ${username}`);
      else if (u.status === 409) console.log(`  ⚠ User ${username} already exists (group not changed)`);
      else throw new Error(`create user: ${u.status} ${JSON.stringify(u.body).slice(0, 200)}`);

      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID, Username: username, Password: profile.password, Permanent: true,
      }));
      console.log(`  ✓ Password set for ${username}`);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${profile.name}: ${e.message}`);
    }
  }
  console.log(failures ? `\n${failures} profile(s) failed` : '\nSetup complete');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
