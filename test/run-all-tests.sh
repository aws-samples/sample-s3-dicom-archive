#!/bin/bash

# API Privilege Test Suite - Quick Start
# This script sets up test users, authenticates them, and runs the test suite

set -e

echo "================================"
echo "API Privilege Test Suite"
echo "================================"
echo ""

# Check required environment variables
if [ -z "$API_BASE_URL" ]; then
  echo "ERROR: API_BASE_URL environment variable is required"
  exit 1
fi

if [ -z "$USER_POOL_ID" ]; then
  echo "ERROR: USER_POOL_ID environment variable is required"
  exit 1
fi

if [ -z "$CLIENT_ID" ]; then
  echo "ERROR: CLIENT_ID environment variable is required"
  exit 1
fi

# setup-test-users.js creates the test groups/users through the admin API
# (the RDS Data API is disabled), signed in as an existing administrator.
if [ -z "$ADMIN_USERNAME" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "ERROR: ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required"
  exit 1
fi

echo "Configuration:"
echo "  API URL: $API_BASE_URL"
echo "  User Pool: $USER_POOL_ID"
echo "  Region: ${AWS_REGION:-us-east-1}"
echo ""

# Step 1: Setup test users
echo "Step 1: Setting up test users..."
node test/setup-test-users.js
if [ $? -ne 0 ]; then
  echo "ERROR: Failed to setup test users"
  exit 1
fi
echo ""

# Step 2: Authenticate test users
echo "Step 2: Authenticating test users..."
node test/authenticate-test-users.js
if [ $? -ne 0 ]; then
  echo "ERROR: Failed to authenticate test users"
  exit 1
fi
echo ""

# Step 3: Run test suite
echo "Step 3: Running test suite..."
if [ -f "test/test-tokens.json" ]; then
  # Read tokens from file and pass to test suite
  ADMIN_TOKEN=$(node -p "require('./test/test-tokens.json').ADMIN || ''")
  DATA_ACCESS_TOKEN=$(node -p "require('./test/test-tokens.json').DATA_ACCESS || ''")
  READ_ONLY_TOKEN=$(node -p "require('./test/test-tokens.json').READ_ONLY || ''")
  DATASTORE_MANAGER_TOKEN=$(node -p "require('./test/test-tokens.json').DATASTORE_MANAGER || ''")
  SYSTEM_MANAGER_TOKEN=$(node -p "require('./test/test-tokens.json').SYSTEM_MANAGER || ''")
  NO_ACCESS_TOKEN=$(node -p "require('./test/test-tokens.json').NO_ACCESS || ''")
  
  node test/api-privilege-test-suite.js \
    "$ADMIN_TOKEN" \
    "$DATA_ACCESS_TOKEN" \
    "$READ_ONLY_TOKEN" \
    "$DATASTORE_MANAGER_TOKEN" \
    "$SYSTEM_MANAGER_TOKEN" \
    "$NO_ACCESS_TOKEN"
else
  echo "ERROR: test-tokens.json not found"
  exit 1
fi

echo ""
echo "================================"
echo "Test suite complete!"
echo "Check test-results/ for reports"
echo "================================"
