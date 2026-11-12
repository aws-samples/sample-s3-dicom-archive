#!/bin/bash

# Test script for Data Management API operations
API_URL="https://8zzzsrd427.execute-api.us-east-1.amazonaws.com/v1/api"
STORAGE_ID="c26a8916-ab85-44ce-9d42-419784c905de"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Data Management API Test ===${NC}\n"

# Test 1: Update Study - Change Patient Name
echo -e "${YELLOW}Test 1: Update Patient Name in Study${NC}"
STUDY_UID="1.3.6.1.4.1.25403.52237031786.3872.20100510032220.1"

PAYLOAD='{
  "00100010": {
    "vr": "PN",
    "Value": [{"Alphabetic": "TestPatient^Updated"}]
  }
}'

echo "Request: PATCH ${API_URL}/storage/${STORAGE_ID}/studies/${STUDY_UID}"
echo "Payload: ${PAYLOAD}"

RESPONSE=$(curl -s -X PATCH \
  "${API_URL}/storage/${STORAGE_ID}/studies/${STUDY_UID}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

echo -e "Response: ${RESPONSE}\n"

# Extract job ID if successful
JOB_ID=$(echo $RESPONSE | jq -r '.jobId // empty')

if [ ! -z "$JOB_ID" ]; then
  echo -e "${GREEN}✓ Job created: ${JOB_ID}${NC}\n"
  
  # Test 2: Check Job Status
  echo -e "${YELLOW}Test 2: Check Job Status${NC}"
  echo "Request: GET ${API_URL}/studies/modify/jobs/${JOB_ID}"
  
  STATUS_RESPONSE=$(curl -s -X GET \
    "${API_URL}/studies/modify/jobs/${JOB_ID}")
  
  echo -e "Response: ${STATUS_RESPONSE}\n"
  
  STATUS=$(echo $STATUS_RESPONSE | jq -r '.status // empty')
  echo -e "Job Status: ${STATUS}\n"
else
  echo -e "${RED}✗ Failed to create job${NC}\n"
fi

# Test 3: Update Series - Change Series Description
echo -e "${YELLOW}Test 3: Update Series Description${NC}"
SERIES_UID="1.3.6.1.4.1.25403.52237031786.3872.20100510032220.2"

PAYLOAD='{
  "0008103E": {
    "vr": "LO",
    "Value": ["Updated Series Description"]
  }
}'

echo "Request: PATCH ${API_URL}/storage/${STORAGE_ID}/studies/${STUDY_UID}/series/${SERIES_UID}"
echo "Payload: ${PAYLOAD}"

RESPONSE=$(curl -s -X PATCH \
  "${API_URL}/storage/${STORAGE_ID}/studies/${STUDY_UID}/series/${SERIES_UID}" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")

echo -e "Response: ${RESPONSE}\n"

echo -e "${YELLOW}=== Test Complete ===${NC}"
