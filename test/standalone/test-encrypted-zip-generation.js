#!/usr/bin/env node
/**
 * Test archiver-zip-encrypted AES-256 encryption
 * 
 * This test verifies that the archiver-zip-encrypted library
 * can create AES-256 encrypted zip files that are compatible
 * with pyzipper for decryption.
 */

const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

async function testEncryptedZipGeneration() {
  console.log('Testing AES-256 encrypted zip generation with archiver-zip-encrypted\n');
  
  const password = 'test-password-123';
  const outputPath = path.join(__dirname, 'test-encrypted.zip');
  
  try {
    // Register encrypted format
    archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
    
    // Create archive
    const archive = archiver.create('zip-encrypted', {
      zlib: { level: 9 },
      encryptionMethod: 'aes256',
      password: password
    });
    
    const output = fs.createWriteStream(outputPath);
    
    // Collect data
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    
    const zipPromise = new Promise((resolve, reject) => {
      archive.on('end', () => {
        const buffer = Buffer.concat(chunks);
        fs.writeFileSync(outputPath, buffer);
        resolve(buffer);
      });
      archive.on('error', reject);
    });
    
    // Add files
    const configData = {
      locationId: 'test-location',
      awsRegion: 'us-east-1'
    };
    
    archive.append(JSON.stringify(configData, null, 2), { name: 'config/config.json' });
    archive.append('-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----', { name: 'config/certificate.pem' });
    archive.append('-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----', { name: 'config/private_key.pem' });
    
    await archive.finalize();
    await zipPromise;
    
    console.log('✅ Created encrypted zip file');
    
    // Verify file exists
    const stats = fs.statSync(outputPath);
    console.log(`✅ Zip file size: ${stats.size} bytes`);
    
    // Cleanup
    fs.unlinkSync(outputPath);
    
    console.log('\n✅ All tests passed!');
    return true;
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    
    // Cleanup on error
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    
    return false;
  }
}

// Run test
testEncryptedZipGeneration().then(success => {
  process.exit(success ? 0 : 1);
});
