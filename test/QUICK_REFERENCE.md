# API Privilege Testing - Quick Reference

## Setup (One Time)

```bash
# 1. Set environment variables
export API_BASE_URL="https://your-api-id.execute-api.us-east-1.amazonaws.com/v1"
export USER_POOL_ID="us-east-1_XXXXXXXXX"
export CLIENT_ID="your-client-id"
export DB_CLUSTER_ARN="arn:aws:rds:us-east-1:123456789012:cluster:your-cluster"
export DB_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:your-secret"
export DB_NAME="archive"
export AWS_REGION="us-east-1"

# 2. Install dependencies
cd test
npm install
```

## Run Tests (Quick)

```bash
# Run everything in one command
npm run test:all
```

## Run Tests (Step by Step)

```bash
# 1. Create test users (run once)
npm run setup

# 2. Authenticate users (run before each test session)
npm run auth

# 3. Run tests
npm run test $(node -p "Object.values(require('./test-tokens.json')).map(t => '\"' + t + '\"').join(' ')")
```

## Test Users

| Profile | Email | Password |
|---------|-------|----------|
| Administrator | test-admin@example.com | TestAdmin123! |
| Data Access | test-data-access@example.com | TestData123! |
| Read Only | test-readonly@example.com | TestReadOnly123! |
| Datastore Manager | test-datastore-mgr@example.com | TestDatastoreMgr123! |
| System Manager | test-system-mgr@example.com | TestSystemMgr123! |
| No Access | test-no-access@example.com | TestNoAccess123! |

## Results

- **HTML Report**: `test-results/api-privilege-test-*.html`
- **JSON Report**: `test-results/api-privilege-test-*.json`

## Cleanup

```bash
# Delete test users from Cognito
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-admin@example.com
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-data-access@example.com
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-readonly@example.com
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-datastore-mgr@example.com
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-system-mgr@example.com
aws cognito-idp admin-delete-user --user-pool-id $USER_POOL_ID --username test-no-access@example.com

# Delete from database (run SQL)
DELETE FROM users WHERE email LIKE 'test-%@example.com';
DELETE FROM privilege_groups WHERE id LIKE 'test-%';
```

## Files

- `test-profiles.json` - User profile definitions
- `api-endpoints.json` - API endpoint catalog
- `setup-test-users.js` - Create users
- `authenticate-test-users.js` - Get tokens
- `api-privilege-test-suite.js` - Run tests
- `run-all-tests.sh` - Quick start
- `README.md` - Full documentation
- `IMPLEMENTATION_SUMMARY.md` - Implementation details

## Troubleshooting

| Issue | Solution |
|-------|----------|
| All tests fail | Check tokens are valid, verify authorizer Lambda |
| Setup fails | Verify AWS credentials and database connectivity |
| Auth fails | Check CLIENT_ID supports USER_PASSWORD_AUTH |
| 404 errors | Verify API_BASE_URL is correct |

## Expected Pass Rates

- **Administrator**: 100%
- **Data Access**: ~40%
- **Read Only**: ~20%
- **Datastore Manager**: ~15%
- **System Manager**: ~15%
- **No Access**: ~2%

## Support

See `test/README.md` for detailed documentation.
