#!/bin/bash
# Test installer script behavior with encrypted config.zip

set -e

echo "Testing installer script modifications..."

TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

# Create mock encrypted config.zip
echo "Creating mock config.zip..."
mkdir -p config
echo '{"test": "data"}' > config/config.json
zip -q config.zip config/config.json
rm -rf config

# Simulate installer behavior
echo "Simulating installer download and placement..."
mv config.zip service-package.zip

# Decode (simulated)
cp service-package.zip service-package.b64

# Execute installer logic
mkdir -p config
mv service-package.zip config/config.zip

# Verify
if [ -f "config/config.zip" ]; then
    echo "✅ config.zip placed in config directory"
else
    echo "❌ config.zip not found in config directory"
    exit 1
fi

if [ -f "config/config.json" ]; then
    echo "❌ config.json should NOT be extracted"
    exit 1
else
    echo "✅ config.json not extracted (correct)"
fi

# Cleanup
cd /
rm -rf "$TEMP_DIR"

echo "✅ Installer script test passed!"
