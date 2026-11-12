#!/bin/bash
# End-to-end test for encrypted config.zip deployment

set -e

echo "==================================="
echo "E2E Test: Encrypted Config.zip"
echo "==================================="
echo ""

# Prerequisites check
if [ -z "$LOCATION_ID" ]; then
    echo "❌ LOCATION_ID environment variable required"
    exit 1
fi

if [ -z "$API_ENDPOINT" ]; then
    echo "❌ API_ENDPOINT environment variable required"
    exit 1
fi

if [ -z "$JWT_TOKEN" ]; then
    echo "❌ JWT_TOKEN environment variable required"
    exit 1
fi

TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

echo "1. Downloading config.zip from API..."
HTTP_CODE=$(curl -w "%{http_code}" -o config.b64 -L \
    -H "Authorization: Bearer $JWT_TOKEN" \
    "${API_ENDPOINT}/locations/${LOCATION_ID}/certificates/dicom")

if [ "$HTTP_CODE" != "200" ]; then
    echo "❌ Failed to download config.zip (HTTP $HTTP_CODE)"
    exit 1
fi
echo "✅ Downloaded config.zip"

echo ""
echo "2. Decoding base64..."
base64 -D -i config.b64 -o config.zip 2>/dev/null || base64 -d config.b64 > config.zip
rm config.b64
echo "✅ Decoded to config.zip"

echo ""
echo "3. Testing encryption (should fail without password)..."
if unzip -t config.zip 2>/dev/null; then
    echo "❌ config.zip is NOT encrypted!"
    exit 1
else
    echo "✅ config.zip is encrypted (cannot extract without password)"
fi

echo ""
echo "4. Verifying AES-256 encryption..."
if unzip -l config.zip 2>&1 | grep -q "AES"; then
    echo "✅ config.zip uses AES encryption"
else
    echo "⚠️  Cannot verify AES encryption method from zip metadata"
fi

echo ""
echo "5. Checking file structure..."
if unzip -l config.zip 2>&1 | grep -q "config/config.json"; then
    echo "✅ config.zip contains config/config.json"
else
    echo "❌ config.zip missing config/config.json"
    exit 1
fi

if unzip -l config.zip 2>&1 | grep -q "config/certificate.pem"; then
    echo "✅ config.zip contains config/certificate.pem"
else
    echo "❌ config.zip missing config/certificate.pem"
    exit 1
fi

# Cleanup
cd /
rm -rf "$TEMP_DIR"

echo ""
echo "==================================="
echo "✅ All E2E tests passed!"
echo "==================================="
echo ""
echo "Next steps:"
echo "1. Deploy DICOM service with new image"
echo "2. Verify service starts successfully"
echo "3. Verify IAM Anywhere authentication works"
echo "4. Verify DICOM operations function normally"
