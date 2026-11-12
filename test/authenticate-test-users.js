#!/usr/bin/env node

const { CognitoIdentityProviderClient } = require('@aws-sdk/client-cognito-identity-provider');
const { signIn } = require('./cognito-mfa');
const fs = require('fs');
const path = require('path');

const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-profiles.json'), 'utf8'));

const CONFIG = {
  userPoolId: process.env.USER_POOL_ID,
  clientId: process.env.CLIENT_ID,
  region: process.env.AWS_REGION || 'us-east-1'
};

const cognitoClient = new CognitoIdentityProviderClient({ region: CONFIG.region });

async function authenticate(username, password) {
  try {
    // Return ACCESS token instead of ID token. signIn completes the TOTP MFA challenge.
    return (await signIn(cognitoClient, CONFIG.clientId, username, password)).AccessToken || null;
  } catch (error) {
    console.error(`Failed to authenticate ${username}:`, error.message);
    return null;
  }
}

async function main() {
  console.log('Authenticating Test Users');
  console.log('=========================\n');
  
  if (!CONFIG.userPoolId || !CONFIG.clientId) {
    console.error('ERROR: Missing required environment variables:');
    console.error('  - USER_POOL_ID');
    console.error('  - CLIENT_ID');
    process.exit(1);
  }
  
  const tokens = {};
  
  for (const [profileKey, profile] of Object.entries(profiles)) {
    console.log(`Authenticating ${profile.name}...`);
    const token = await authenticate(profile.username, profile.password);
    if (token) {
      tokens[profileKey] = token;
      console.log(`  ✓ Success`);
    } else {
      console.log(`  ✗ Failed`);
    }
  }
  
  console.log('\n=========================');
  console.log('Authentication Complete\n');
  
  // Save tokens to file
  const tokensPath = path.join(__dirname, 'test-tokens.json');
  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  console.log(`Tokens saved to: ${tokensPath}\n`);
  
  // Print command to run tests
  const tokenArgs = Object.values(tokens).map(t => `"${t}"`).join(' ');
  console.log('Run tests with:');
  console.log(`node test/api-privilege-test-suite.js ${tokenArgs}`);
  
  // Also print individual tokens for manual use
  console.log('\nIndividual tokens:');
  for (const [profileKey, token] of Object.entries(tokens)) {
    console.log(`\n${profileKey}:`);
    console.log(token);
  }
}

main().catch(console.error);
