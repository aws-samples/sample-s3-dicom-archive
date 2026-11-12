#!/usr/bin/env python3
"""
Test config.zip decryption with pyzipper AES-256
"""

import os
import sys
import pyzipper
import json
from io import BytesIO

def test_create_encrypted_zip():
    """Create a test encrypted zip with AES-256"""
    password = "test-password-123"
    
    config_data = {
        "locationId": "test-location",
        "awsRegion": "us-east-1"
    }
    
    cert_data = b"-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----"
    key_data = b"-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----"
    
    # Create encrypted zip
    with pyzipper.AESZipFile('test-config.zip', 'w', compression=pyzipper.ZIP_DEFLATED, encryption=pyzipper.WZ_AES) as zf:
        zf.setpassword(password.encode('utf-8'))
        zf.writestr('config/config.json', json.dumps(config_data, indent=2))
        zf.writestr('config/certificate.pem', cert_data)
        zf.writestr('config/private_key.pem', key_data)
    
    print("✅ Created encrypted test-config.zip")
    return password

def test_decrypt_zip(password):
    """Test decrypting the zip file"""
    try:
        with pyzipper.AESZipFile('test-config.zip', 'r') as zf:
            zf.setpassword(password.encode('utf-8'))
            
            # Read config
            config_json = zf.read('config/config.json').decode('utf-8')
            config = json.loads(config_json)
            print(f"✅ Decrypted config: {config}")
            
            # Read certificates
            cert = zf.read('config/certificate.pem')
            key = zf.read('config/private_key.pem')
            print(f"✅ Loaded certificate ({len(cert)} bytes) and key ({len(key)} bytes)")
            
        return True
    except Exception as e:
        print(f"❌ Decryption failed: {e}")
        return False

def test_wrong_password():
    """Test that wrong password fails"""
    try:
        with pyzipper.AESZipFile('test-config.zip', 'r') as zf:
            zf.setpassword(b'wrong-password')
            zf.read('config/config.json')
        print("❌ Should have failed with wrong password")
        return False
    except Exception as e:
        print(f"✅ Correctly rejected wrong password: {type(e).__name__}")
        return True

if __name__ == '__main__':
    print("Testing AES-256 encrypted zip with pyzipper\n")
    
    password = test_create_encrypted_zip()
    
    if not test_decrypt_zip(password):
        sys.exit(1)
    
    if not test_wrong_password():
        sys.exit(1)
    
    # Cleanup
    os.remove('test-config.zip')
    
    print("\n✅ All tests passed!")
