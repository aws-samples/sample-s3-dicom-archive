#!/bin/bash
# Test Dockerfile build locally

set -e

echo "Testing DICOM service Dockerfile build..."
cd "$(dirname "$0")/../../interface-container/DICOM/DIMSEtoS3"

# Build the image
echo "Building Docker image..."
docker build -t test-dicom-service:latest .

echo "✅ Docker build successful"

# Test that binary exists and is executable
echo "Testing binary in container..."
docker run --rm test-dicom-service:latest ls -lh /app/dicom-service

echo "✅ Binary exists and is executable"

# Cleanup
docker rmi test-dicom-service:latest

echo "✅ All Dockerfile tests passed!"
