#!/usr/bin/env node

const https = require('https');
const fs = require('fs');
const path = require('path');

const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-profiles.json'), 'utf8'));
const endpointsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'api-endpoints.json'), 'utf8'));

const CONFIG = {
  apiBaseUrl: process.env.API_BASE_URL || '',
  testDelay: 100,
  outputDir: './test-results'
};

// Load feature flags from config.json
function loadFeatureFlags() {
  try {
    const configPath = path.join(__dirname, '../cdk-infrastructure/config.json');
    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    return {
      virtualFolder: config.virtualFolderFeature || false
    };
  } catch (error) {
    console.warn('Could not load feature flags from config.json, assuming all features disabled');
    return { virtualFolder: false };
  }
}

const FEATURES = loadFeatureFlags();
console.log(`Feature Flags: VirtualFolder=${FEATURES.virtualFolder}\n`);

function hasDatastorePrivilege(profile, privilege) {
  return profile.datastorePrivileges?.some(p => p[privilege]) || false;
}

function hasManagementPrivilege(profile, resource, privilege) {
  return profile.managementPrivileges?.[resource]?.[privilege] || false;
}

function hasImplicitPrivilege(profile, resource) {
  const mgmt = profile.managementPrivileges || {};
  if (resource === 'interfaces') {
    return mgmt.interfaces?.canList || mgmt.routingRules?.canEdit || mgmt.dicomEntities?.canEdit || false;
  }
  if (resource === 'locations') {
    return mgmt.locations?.canEdit || mgmt.locations?.canDelete || mgmt.interfaces?.canEdit || mgmt.dicomEntities?.canEdit || false;
  }
  return false;
}

function checkAccess(endpoint, profile) {
  if (endpoint.requiresAuth) return true;
  
  if (endpoint.requiresDatastoreRead && hasDatastorePrivilege(profile, 'canRead')) return true;
  if (endpoint.requiresDatastoreStore && hasDatastorePrivilege(profile, 'canStore')) return true;
  
  if (endpoint.requiresImplicit && hasImplicitPrivilege(profile, endpoint.requiresImplicit)) return true;
  
  if (endpoint.requiresManagement) {
    const parts = endpoint.requiresManagement.split('|');
    for (const part of parts) {
      const [resource, privilege] = part.split('.');
      if (hasManagementPrivilege(profile, resource, privilege)) return true;
    }
  }
  
  return false;
}

async function testEndpoint(method, path, token, shouldHaveAccess) {
  // API_BASE_URL may be the stage URL (…/v1) or the API root (…/v1/api, as
  // run-all-tests.sh and setup-test-users.js use it); never double the /api.
  const url = `${CONFIG.apiBaseUrl.replace(/\/api\/?$/, '')}/api${path}`;
  
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const hasAccess = res.statusCode !== 403;
        const passed = hasAccess === shouldHaveAccess;
        
        resolve({
          method,
          path,
          expectedAccess: shouldHaveAccess,
          actualAccess: hasAccess,
          statusCode: res.statusCode,
          passed
        });
      });
    });
    
    req.on('error', (error) => {
      resolve({
        method,
        path,
        expectedAccess: shouldHaveAccess,
        actualAccess: false,
        statusCode: 0,
        passed: false,
        error: error.message
      });
    });
    
    req.end();
  });
}

async function runTestsForProfile(profileKey, profile, token) {
  console.log(`\n${'='.repeat(120)}`);
  console.log(`Testing Profile: ${profile.name} (${profileKey})`);
  console.log('='.repeat(120));
  
  const results = [];
  
  for (const category of endpointsData) {
    // Skip categories based on feature flags
    if (category.category === 'Virtual Folders' && !FEATURES.virtualFolder) {
      console.log(`Skipping ${category.category} (feature disabled)`);
      continue;
    }
    
    for (const endpoint of category.endpoints) {
      const shouldHaveAccess = checkAccess(endpoint, profile);
      const result = await testEndpoint(endpoint.method, endpoint.path, token, shouldHaveAccess);
      results.push({ ...result, category: category.category, skipped: false });
      
      const status = result.passed ? '✓ PASS' : '✗ FAIL';
      const expected = result.expectedAccess ? 'ALLOW' : 'DENY';
      const actual = result.actualAccess ? 'ALLOW' : 'DENY';
      
      console.log(`${status} | ${result.method.padEnd(6)} ${result.path.padEnd(50)} | Expected: ${expected.padEnd(5)} | Actual: ${actual.padEnd(5)} | HTTP ${result.statusCode}`);
      
      await new Promise(resolve => setTimeout(resolve, CONFIG.testDelay));
    }
  }
  
  return results;
}

function generateReport(allResults) {
  const timestamp = new Date().toISOString();
  
  const summary = {
    timestamp,
    features: FEATURES,
    totalTests: 0,
    passed: 0,
    failed: 0,
    byProfile: {}
  };
  
  for (const [profileKey, results] of Object.entries(allResults)) {
    const profilePassed = results.filter(r => r.passed).length;
    const profileFailed = results.filter(r => !r.passed).length;
    
    summary.totalTests += results.length;
    summary.passed += profilePassed;
    summary.failed += profileFailed;
    summary.byProfile[profileKey] = {
      total: results.length,
      passed: profilePassed,
      failed: profileFailed,
      passRate: ((profilePassed / results.length) * 100).toFixed(2) + '%'
    };
  }
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <title>API Privilege Test Report - ${timestamp}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1400px; margin: 0 auto; background: white; padding: 20px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
    h1 { color: #333; border-bottom: 3px solid #007bff; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    .summary { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 20px 0; }
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
    .summary-card { background: white; padding: 15px; border-radius: 5px; border-left: 4px solid #007bff; }
    .summary-card h3 { margin: 0 0 10px 0; font-size: 14px; color: #666; }
    .summary-card .value { font-size: 24px; font-weight: bold; color: #333; }
    .pass { color: #28a745; }
    .fail { color: #dc3545; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #007bff; color: white; font-weight: bold; }
    tr:hover { background: #f8f9fa; }
    .badge { padding: 4px 8px; border-radius: 3px; font-size: 12px; font-weight: bold; }
    .badge-pass { background: #28a745; color: white; }
    .badge-fail { background: #dc3545; color: white; }
    .badge-allow { background: #17a2b8; color: white; }
    .badge-deny { background: #6c757d; color: white; }
  </style>
</head>
<body>
  <div class="container">
    <h1>API Privilege Test Report</h1>
    <p><strong>Generated:</strong> ${timestamp}</p>
    
    <div class="feature-flags" style="background: #fff3cd; padding: 10px; border-radius: 5px; margin: 10px 0; border-left: 4px solid #ffc107;">
      <strong style="color: #856404;">Feature Flags:</strong> 
      Virtual Folders: ${FEATURES.virtualFolder ? '✅ Enabled' : '❌ Disabled'}
    </div>
    
    <div class="summary">
      <h2>Overall Summary</h2>
      <div class="summary-grid">
        <div class="summary-card">
          <h3>Total Tests</h3>
          <div class="value">${summary.totalTests}</div>
        </div>
        <div class="summary-card">
          <h3>Passed</h3>
          <div class="value pass">${summary.passed}</div>
        </div>
        <div class="summary-card">
          <h3>Failed</h3>
          <div class="value fail">${summary.failed}</div>
        </div>
        <div class="summary-card">
          <h3>Pass Rate</h3>
          <div class="value">${((summary.passed / summary.totalTests) * 100).toFixed(2)}%</div>
        </div>
      </div>
    </div>
    
    ${Object.entries(allResults).map(([profileKey, results]) => `
      <h2>${profiles[profileKey].name} (${profileKey})</h2>
      <p>
        <strong>Pass Rate:</strong> ${summary.byProfile[profileKey].passRate} 
        (${summary.byProfile[profileKey].passed}/${summary.byProfile[profileKey].total})
      </p>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Category</th>
            <th>Method</th>
            <th>Endpoint</th>
            <th>Expected</th>
            <th>Actual</th>
            <th>HTTP Status</th>
          </tr>
        </thead>
        <tbody>
          ${results.map(r => `
            <tr>
              <td><span class="badge ${r.passed ? 'badge-pass' : 'badge-fail'}">${r.passed ? 'PASS' : 'FAIL'}</span></td>
              <td>${r.category}</td>
              <td><strong>${r.method}</strong></td>
              <td><code>${r.path}</code></td>
              <td><span class="badge ${r.expectedAccess ? 'badge-allow' : 'badge-deny'}">${r.expectedAccess ? 'ALLOW' : 'DENY'}</span></td>
              <td><span class="badge ${r.actualAccess ? 'badge-allow' : 'badge-deny'}">${r.actualAccess ? 'ALLOW' : 'DENY'}</span></td>
              <td>${r.statusCode}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `).join('')}
  </div>
</body>
</html>`;
  
  return { summary, html };
}

async function main() {
  console.log('API Privilege Test Suite');
  console.log('========================\n');
  
  if (!CONFIG.apiBaseUrl) {
    console.error('ERROR: API_BASE_URL environment variable is required');
    process.exit(1);
  }
  
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node api-privilege-test-suite.js <admin-token> [data-access-token] [read-only-token] ...');
    console.error('\nProvide bearer tokens for each test profile in order:');
    console.error('  1. ADMIN');
    console.error('  2. DATA_ACCESS');
    console.error('  3. READ_ONLY');
    console.error('  4. DATASTORE_MANAGER');
    console.error('  5. SYSTEM_MANAGER');
    console.error('  6. NO_ACCESS');
    process.exit(1);
  }
  
  const tokens = {
    ADMIN: args[0],
    DATA_ACCESS: args[1],
    READ_ONLY: args[2],
    DATASTORE_MANAGER: args[3],
    SYSTEM_MANAGER: args[4],
    NO_ACCESS: args[5]
  };
  
  const allResults = {};
  
  for (const [profileKey, token] of Object.entries(tokens)) {
    if (token) {
      const profile = profiles[profileKey];
      allResults[profileKey] = await runTestsForProfile(profileKey, profile, token);
    }
  }
  
  console.log('\n\nGenerating report...');
  const { summary, html } = generateReport(allResults);
  
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  const reportPath = path.join(CONFIG.outputDir, `api-privilege-test-${Date.now()}.html`);
  fs.writeFileSync(reportPath, html);
  console.log(`\nHTML report saved to: ${reportPath}`);
  
  const jsonPath = path.join(CONFIG.outputDir, `api-privilege-test-${Date.now()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, results: allResults }, null, 2));
  console.log(`JSON report saved to: ${jsonPath}`);
  
  console.log('\n' + '='.repeat(120));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(120));
  console.log(`Total Tests: ${summary.totalTests}`);
  console.log(`Passed: ${summary.passed} (${((summary.passed / summary.totalTests) * 100).toFixed(2)}%)`);
  console.log(`Failed: ${summary.failed} (${((summary.failed / summary.totalTests) * 100).toFixed(2)}%)`);
  console.log('\nBy Profile:');
  for (const [profile, stats] of Object.entries(summary.byProfile)) {
    console.log(`  ${profile}: ${stats.passed}/${stats.total} (${stats.passRate})`);
  }
  
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch(console.error);
