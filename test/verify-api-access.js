#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node verify-api-access.js <bearer-token> <privileges-json>');
  console.error('Example: node verify-api-access.js "eyJhbG..." \'{"datastorePrivileges":[...],"managementPrivileges":{...}}\'');
  process.exit(1);
}

const bearerToken = args[0];
const privileges = JSON.parse(args[1]);

// Read API URL from config
const configPath = path.join(__dirname, '../website/public/config.js');
const configContent = fs.readFileSync(configPath, 'utf8');
const apiUrlMatch = configContent.match(/API_BASE_URL:\s*"([^"]+)"/);
if (!apiUrlMatch) {
  console.error('Failed to extract API_BASE_URL from config.js');
  process.exit(1);
}
const API_BASE_URL = apiUrlMatch[1];

console.log(`Testing API access with URL: ${API_BASE_URL}\n`);

// Define all API endpoints with their required privileges
const endpoints = [
  // Datastore endpoints - canRead
  { method: 'GET', path: '/datastores', requires: (p) => p.datastorePrivileges.some(d => d.canRead) },
  { method: 'GET', path: '/datastores/statistics', requires: (p) => p.datastorePrivileges.some(d => d.canRead) },
  
  // Datastore endpoints - canStore
  { method: 'POST', path: '/datastores', requires: (p) => p.datastorePrivileges.some(d => d.canStore) },
  
  // Datastore endpoints - canUpdate
  { method: 'PUT', path: '/datastores/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canUpdate) },
  
  // Datastore endpoints - canDelete
  { method: 'DELETE', path: '/datastores/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canDelete) },
  
  // Import jobs
  { method: 'GET', path: '/import-jobs', requires: (p) => p.datastorePrivileges.some(d => d.canRead) },
  { method: 'POST', path: '/import-jobs', requires: (p) => p.datastorePrivileges.some(d => d.canStore) },
  { method: 'PUT', path: '/import-jobs/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canUpdate) },
  { method: 'DELETE', path: '/import-jobs/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canDelete) },
  
  // DICOM interfaces
  { method: 'GET', path: '/dicom-interfaces', requires: (p) => p.datastorePrivileges.some(d => d.canRead) },
  { method: 'POST', path: '/dicom-interfaces', requires: (p) => p.datastorePrivileges.some(d => d.canStore) },
  { method: 'PUT', path: '/dicom-interfaces/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canUpdate) },
  { method: 'DELETE', path: '/dicom-interfaces/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canDelete) },
  
  // DICOM entities
  { method: 'GET', path: '/dicom-entities', requires: (p) => p.datastorePrivileges.some(d => d.canRead) },
  { method: 'POST', path: '/dicom-entities', requires: (p) => p.datastorePrivileges.some(d => d.canStore) },
  { method: 'PUT', path: '/dicom-entities/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canUpdate) },
  { method: 'DELETE', path: '/dicom-entities/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canDelete) },
  
  // DICOM privileges
  { method: 'GET', path: '/dicom-privileges', requires: (p) => p.datastorePrivileges.some(d => d.canRead) },
  { method: 'POST', path: '/dicom-privileges', requires: (p) => p.datastorePrivileges.some(d => d.canStore) },
  { method: 'DELETE', path: '/dicom-privileges/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canDelete) },
  
  // Non-primary imagesets
  { method: 'GET', path: '/non-primary-imagesets', requires: (p) => p.datastorePrivileges.some(d => d.canRead) },
  
  // Interface servers
  { method: 'GET', path: '/interface-servers', requires: (p) => p.datastorePrivileges.some(d => d.canRead || d.canStore || d.canUpdate || d.canDelete) },
  { method: 'POST', path: '/interface-servers', requires: (p) => p.datastorePrivileges.some(d => d.canStore) },
  { method: 'PUT', path: '/interface-servers/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canUpdate) },
  { method: 'DELETE', path: '/interface-servers/test-id', requires: (p) => p.datastorePrivileges.some(d => d.canDelete) },
  
  // AWS resources
  { method: 'GET', path: '/aws-resources', requires: (p) => p.datastorePrivileges.some(d => d.canRead || d.canStore || d.canUpdate || d.canDelete) },
  
  // Privilege groups - canList
  { method: 'GET', path: '/privilege-groups', requires: (p) => p.managementPrivileges?.privilegeGroups?.canList || p.managementPrivileges?.privilegeGroups?.canEdit },
  
  // Privilege groups - canEdit (POST/PUT)
  { method: 'POST', path: '/privilege-groups', requires: (p) => p.managementPrivileges?.privilegeGroups?.canEdit },
  { method: 'PUT', path: '/privilege-groups/test-id', requires: (p) => p.managementPrivileges?.privilegeGroups?.canEdit },
  
  // Privilege groups - canDelete
  { method: 'DELETE', path: '/privilege-groups/test-id', requires: (p) => p.managementPrivileges?.privilegeGroups?.canDelete },
  
  // Users - canList
  { method: 'GET', path: '/users', requires: (p) => p.managementPrivileges?.users?.canList || p.managementPrivileges?.users?.canEdit },
  
  // Users - canEdit (POST/PUT/PATCH)
  { method: 'POST', path: '/users', requires: (p) => p.managementPrivileges?.users?.canEdit },
  { method: 'PUT', path: '/users/test-id', requires: (p) => p.managementPrivileges?.users?.canEdit },
  { method: 'PATCH', path: '/users/test-id/last-login', requires: (p) => p.managementPrivileges?.users?.canEdit },
  
  // Users - canDelete
  { method: 'DELETE', path: '/users/test-id', requires: (p) => p.managementPrivileges?.users?.canDelete },
  
  // Audit - canList only
  { method: 'GET', path: '/audit', requires: (p) => p.managementPrivileges?.auditTrail?.canList }
];

async function testEndpoint(method, path, shouldHaveAccess) {
  const url = `${API_BASE_URL}${path}`;
  
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const hasAccess = response.status !== 403;
    const expected = shouldHaveAccess ? 'ALLOWED' : 'DENIED';
    const actual = hasAccess ? 'ALLOWED' : 'DENIED';
    const result = expected === actual ? '✓ PASS' : '✗ FAIL';
    
    console.log(`${result} | ${method.padEnd(6)} ${path.padEnd(45)} | Expected: ${expected.padEnd(7)} | Actual: ${actual.padEnd(7)} | HTTP ${response.status}`);
    
    return expected === actual;
  } catch (error) {
    console.log(`✗ ERROR | ${method.padEnd(6)} ${path.padEnd(45)} | ${error.message}`);
    return false;
  }
}

async function runTests() {
  console.log('Starting API access verification...\n');
  console.log('=' .repeat(130));
  
  let passed = 0;
  let failed = 0;
  
  for (const endpoint of endpoints) {
    const shouldHaveAccess = endpoint.requires(privileges);
    const result = await testEndpoint(endpoint.method, endpoint.path, shouldHaveAccess);
    
    if (result) {
      passed++;
    } else {
      failed++;
    }
    
    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log('=' .repeat(130));
  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${endpoints.length} tests`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
