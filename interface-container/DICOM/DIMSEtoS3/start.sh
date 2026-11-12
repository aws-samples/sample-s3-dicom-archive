#!/bin/bash
cd "$(dirname "$0")"
source venv/bin/activate

export LOCATION_ID="18c1df47-b291-4ba8-8876-0c3885a8af0e"
export CONFIGURATION_API_ENDPOINT="https://88e7yawmc5.execute-api.us-east-1.amazonaws.com/v1"
export AWS_REGION="us-east-1"
export LOGLEVEL="INFO"

echo "Starting DICOM Service..."
echo "Location ID: $LOCATION_ID"
echo "Config Endpoint: $CONFIGURATION_API_ENDPOINT"
echo ""

python3 -u main.py
