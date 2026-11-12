# API Privilege Testing Suite

Comprehensive test suite to verify API access control based on user privileges.

## Overview

This test suite validates that API endpoints are properly protected and only accessible to users with the appropriate privileges. It tests all API endpoints with different user profiles to ensure the authorization system works correctly.

## Prerequisites

- Node.js 18+
- AWS CLI configured
- Access to the deployed application
- Environment variables set:
  - `API_BASE_URL` - Your API Gateway URL
  - `USER_POOL_ID` - Cognito User Pool ID
  - `CLIENT_ID` - Cognito App Client ID
  - `ADMIN_USERNAME` / `ADMIN_PASSWORD` - an existing administrator; `setup-test-users.js`
    creates the test groups and users through the admin API (the RDS Data API is disabled)
  - `DB_NAME` - Database name (default: archive)
  - `AWS_REGION` - AWS region (default: us-east-1)

## Test Profiles

The suite tests with 6 different user profiles:

1. **ADMIN** - Full access to all resources and management operations
2. **DATA_ACCESS** - Full data access, limited management privileges
3. **READ_ONLY** - Can only read data, no modifications
4. **DATASTORE_MANAGER** - Can manage datastores but not access data
5. **SYSTEM_MANAGER** - Can manage users and privilege groups
6. **NO_ACCESS** - No privileges (should be denied everything except public endpoints)

## Setup

### 1. Install Dependencies

```bash
npm install @aws-sdk/client-cognito-identity-provider@3.929.0 @aws-sdk/client-rds-data@3.929.0 uuid@9.0.1
```

### 2. Set Environment Variables

```bash
export API_BASE_URL="https://your-api-id.execute-api.us-east-1.amazonaws.com/v1"
export USER_POOL_ID="us-east-1_XXXXXXXXX"
export CLIENT_ID="your-client-id"
export ADMIN_USERNAME="admin"
export ADMIN_PASSWORD="<the administrator's password>"
export DB_NAME="archive"
export AWS_REGION="us-east-1"
```

### 3. Create Test Users

```bash
node test/setup-test-users.js
```

This will:
- Create test users in Cognito
- Create privilege groups in the database
- Link users to their respective privilege groups

Test user credentials will be displayed after setup.

## Running Tests

### 1. Authenticate Test Users

You need to obtain bearer tokens for each test user. You can use the AWS CLI or your application's login endpoint:

```bash
# Example using AWS CLI
aws cognito-idp admin-initiate-auth \
  --user-pool-id $USER_POOL_ID \
  --client-id $CLIENT_ID \
  --auth-flow ADMIN_NO_SRP_AUTH \
  --auth-parameters USERNAME=test-admin@example.com,PASSWORD=TestAdmin123!
```

Or use your application's login page to authenticate and extract the token from the browser.

### 2. Run Test Suite

```bash
node test/api-privilege-test-suite.js \
  "<admin-token>" \
  "<data-access-token>" \
  "<read-only-token>" \
  "<datastore-manager-token>" \
  "<system-manager-token>" \
  "<no-access-token>"
```

You can test with fewer profiles by omitting tokens:

```bash
# Test only admin and read-only
node test/api-privilege-test-suite.js "<admin-token>" "" "<read-only-token>"
```

### 3. Review Results

The test suite generates two reports in the `test-results/` directory:

- **HTML Report** - Visual report with color-coded results
- **JSON Report** - Machine-readable results for CI/CD integration

## Test Results

The test suite validates:

- ✓ **Expected ALLOW** - User should have access and does
- ✓ **Expected DENY** - User should not have access and doesn't
- ✗ **Unexpected ALLOW** - User has access but shouldn't (security issue)
- ✗ **Unexpected DENY** - User doesn't have access but should (functionality issue)

## Understanding Results

### Pass Rate
- **100%** - All access controls working correctly
- **<100%** - Some endpoints have incorrect access control

### Common Issues

1. **Unexpected ALLOW** - Security vulnerability, user has more access than intended
2. **Unexpected DENY** - Functionality issue, user can't access features they should
3. **HTTP 404** - Endpoint doesn't exist or path is incorrect
4. **HTTP 500** - Server error, check Lambda logs

## API Endpoints Tested

The suite tests all endpoints across these categories:

- Datastores (6 endpoints)
- Import Jobs (3 endpoints)
- DICOM Interfaces (5 endpoints)
- DICOM Entities (5 endpoints)
- DICOM Privileges (3 endpoints)
- Locations (5 endpoints)
- Routing Rules (4 endpoints)
- Interface Servers (1 endpoint)
- Privilege Groups (5 endpoints)
- Users (5 endpoints)
- Audit (1 endpoint)
- Dashboard & Statistics (3 endpoints)
- System Monitor (1 endpoint)
- Virtual Folders (5 endpoints)
- Public endpoints (1 endpoint)

**Total: 53 endpoints**

## Cleanup

To remove test users:

```bash
# Delete from Cognito
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-admin@example.com
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-data-access@example.com
# ... repeat for other test users

# Delete from database (run SQL)
DELETE FROM users WHERE email LIKE 'test-%@example.com';
DELETE FROM privilege_groups WHERE id LIKE 'test-%';
```

## CI/CD Integration

Example GitHub Actions workflow:

```yaml
- name: Run API Privilege Tests
  env:
    API_BASE_URL: ${{ secrets.API_BASE_URL }}
    USER_POOL_ID: ${{ secrets.USER_POOL_ID }}
    CLIENT_ID: ${{ secrets.CLIENT_ID }}
  run: |
    node test/setup-test-users.js
    # Authenticate and get tokens
    ADMIN_TOKEN=$(./scripts/get-token.sh test-admin@example.com TestAdmin123!)
    # Run tests
    node test/api-privilege-test-suite.js "$ADMIN_TOKEN"
```

## Troubleshooting

### "Unauthorized" errors
- Check that tokens are valid and not expired
- Verify user exists in both Cognito and database
- Ensure privilege groups are correctly configured

### "Connection refused"
- Verify API_BASE_URL is correct
- Check API Gateway is deployed
- Ensure network connectivity

### All tests fail
- Verify authorizer Lambda is working
- Check CloudWatch logs for errors
- Ensure database connection is working

## Live end-to-end suites

Run the full set of functional suites against a deployed **test** stack. Use a
disposable account: the suites create storages, users, queues and objects.

```bash
export AWS_PROFILE=<test-account-profile> AWS_REGION=<region>
export NODE_PATH=<dir with @aws-sdk/client-cognito-identity-provider installed>
# Python with boto3, requests, pydicom and pynetdicom:
export PYTHON=<python>  TS_PYTHON=<python3.12 or later, for the transfer-syntax venvs>

python test/live/stack_setup.py <stackPrefix> <workdir>   # once per stack; idempotent
test/live/run_live_suites.sh <workdir> [suite ...]       # default: all suites
```

- `stack_setup.py` sets the `admin` password, creates the `demo-studies` storage
  (seeded with a generated MR series unless `--seed-from s3://...` is given), a DIMSE
  interface, the six test users and `<workdir>/stack.env`.
- Results go to `<workdir>/results/<suite>.log`, with a one-line-per-suite
  `summary.txt`.
- **MFA.** The deployment requires TOTP MFA by default. `cognito_mfa.py` and
  `cognito-mfa.js` complete the Cognito challenge for every scripted sign-in: they
  enrol a user in TOTP on first sign-in and keep its secret, mode 0600, in
  `$TEST_MFA_DIR` (default `<workdir>/mfa` under the runner). Keep that directory
  for the life of the stack: an enrolled user cannot sign in without its secret.
- **DIMSE suites** (`cstorets`) open a temporary `/32` ingress for this host's public
  IP on the DICOM NLB security group and revoke it when the suite exits.
- Keep `<workdir>` outside the repository: it holds the admin password, tokens and
  TOTP secrets.

## Standalone tests (no deployment needed)

`test/standalone/` holds checks that run locally, without a deployed stack. The
suites above all need a deployment.

| File | What it checks | Run |
|---|---|---|
| `test-config-zip-decryption.py` | AES-256 encrypted location `config.zip` (pyzipper): decrypt, wrong password rejected | `python3 test/standalone/test-config-zip-decryption.py` (needs `pyzipper`) |
| `test-iam-anywhere-memory-certs.py` | IAM Roles Anywhere session accepts in-memory certificate bytes | from `interface-container/DICOM/DIMSEtoS3`: `python3 ../../../test/standalone/test-iam-anywhere-memory-certs.py` |
| `test-encrypted-zip-generation.js` | Generating the encrypted `config.zip` | `node test/standalone/test-encrypted-zip-generation.js` |
| `test-dockerfile-build.sh` | DIMSE service Docker image builds | `bash test/standalone/test-dockerfile-build.sh` (needs Docker/Podman) |
| `test-installer-script.sh`, `test-e2e-encrypted-config.sh` | Installer and end-to-end encrypted-config flow | `bash test/standalone/<script>` |
| `plugins/plugins.test.js` | Processing-job plugins and the scheduler/runner, against the real shared-layer modules | `node --test test/standalone/plugins/*.test.js` (needs the AWS SDK v3 clients the Lambda runtime provides: put them on `NODE_PATH`) |

Unit tests that belong to one component stay next to its code
(`interface-container/*/tests/`, `cdk-infrastructure/lib/**/*.test.js`).

## Files

- `test-profiles.json` - Test user profile definitions
- `api-endpoints.json` - API endpoint definitions with privilege requirements
- `setup-test-users.js` - Creates test users and privilege groups
- `api-privilege-test-suite.js` - Main test runner
- `test-results/` - Generated test reports

## Support

For issues or questions, check:
- CloudWatch Logs for Lambda errors
- API Gateway execution logs
- Database query logs
