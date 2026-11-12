const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand } = require('@aws-sdk/client-secrets-manager');

const sm = new SecretsManagerClient({});

exports.handler = async (event) => {
  console.log('TLS Cert Generator:', event.RequestType);
  const { RequestType, ResourceProperties, PhysicalResourceId } = event;
  const { SecretName, StackPrefix } = ResourceProperties;

  try {
    if (RequestType === 'Create' || RequestType === 'Update') {
      // Check if secret already exists
      try {
        await sm.send(new GetSecretValueCommand({ SecretId: SecretName }));
        console.log('Secret already exists, skipping generation');
        return { Status: 'SUCCESS', PhysicalResourceId: SecretName, Data: { SecretName } };
      } catch (e) {
        if (e.name !== 'ResourceNotFoundException') throw e;
      }

      const certs = generateCertificates(StackPrefix || 'DICOM');
      await sm.send(new CreateSecretCommand({
        Name: SecretName,
        SecretString: JSON.stringify(certs),
        Description: 'DICOM TLS server certificates (auto-generated)'
      }));

      console.log('Created TLS certificate secret:', SecretName);
      return { Status: 'SUCCESS', PhysicalResourceId: SecretName, Data: { SecretName } };
    }

    return { Status: 'SUCCESS', PhysicalResourceId: PhysicalResourceId || SecretName, Data: { SecretName } };
  } catch (error) {
    console.error('Error:', error.message);
    return { Status: 'FAILED', Reason: error.message, PhysicalResourceId: PhysicalResourceId || 'NONE' };
  }
};

function generateCertificates(stackPrefix) {
  // Generate CA key pair
  const caKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Self-signed CA cert
  const caCert = selfSignCert(caKeys, `${stackPrefix} DICOM TLS CA`, true, null, null, 3650);

  // Generate server key pair
  const serverKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Server cert signed by CA
  const serverCert = selfSignCert(serverKeys, `${stackPrefix} DICOM TLS Server`, false, caKeys.privateKey, `${stackPrefix} DICOM TLS CA`, 3650);

  return {
    caCert,
    caKey: caKeys.privateKey,
    serverCert,
    serverKey: serverKeys.privateKey
  };
}

function selfSignCert(keys, cn, isCA, signerKey, issuerCN, days) {
  // Use X509Certificate API available in Node 18+
  const serialNumber = crypto.randomBytes(16).toString('hex');
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + days * 86400000);

  // Build a minimal self-signed or CA-signed X.509 cert using createCertificate (Node 22+)
  // Fallback: use crypto.X509Certificate is read-only, so we use the legacy approach
  // Node 24 Lambda runtime supports crypto.createSign

  const cert = new crypto.X509Certificate(
    buildX509DER(keys.publicKey, signerKey || keys.privateKey, cn, issuerCN || cn, serialNumber, notBefore, notAfter, isCA)
  );
  return cert.toString();
}

function buildX509DER(publicKeyPem, signerKeyPem, subjectCN, issuerCN, serial, notBefore, notAfter, isCA) {
  // Encode a minimal X.509v3 certificate in DER format
  const pubKeyDer = pemToDer(publicKeyPem, 'PUBLIC KEY');

  const tbs = asn1Sequence([
    // version v3
    asn1Explicit(0, asn1Integer(2)),
    // serial
    asn1Integer(BigInt('0x' + serial)),
    // signature algorithm: sha256WithRSAEncryption
    sha256WithRSA(),
    // issuer
    asn1Sequence([asn1Set([asn1Sequence([asn1OID('2.5.4.3'), asn1UTF8(issuerCN)])])]),
    // validity
    asn1Sequence([asn1UTCTime(notBefore), asn1UTCTime(notAfter)]),
    // subject
    asn1Sequence([asn1Set([asn1Sequence([asn1OID('2.5.4.3'), asn1UTF8(subjectCN)])])]),
    // subjectPublicKeyInfo (raw from PEM)
    Buffer.from(pubKeyDer),
    // extensions
    asn1Explicit(3, asn1Sequence(
      isCA
        ? [asn1Sequence([asn1OID('2.5.29.19'), asn1Boolean(true), asn1OctetString(asn1Sequence([asn1Boolean(true)]))])]
        : [
            asn1Sequence([asn1OID('2.5.29.19'), asn1OctetString(asn1Sequence([]))]),
            // SAN: DNS:localhost, DNS:*, IP:127.0.0.1
            asn1Sequence([asn1OID('2.5.29.17'), asn1OctetString(asn1Sequence([
              asn1Context(2, Buffer.from('localhost')),
              asn1Context(2, Buffer.from('*')),
              asn1Context(7, Buffer.from([127, 0, 0, 1]))
            ]))])
          ]
    ))
  ]);

  // Sign TBS
  const sign = crypto.createSign('SHA256');
  sign.update(tbs);
  const signature = sign.sign(signerKeyPem);

  // Full certificate
  return asn1Sequence([tbs, sha256WithRSA(), asn1BitString(signature)]);
}

// ASN.1 DER encoding helpers
function asn1Tag(tag, content) {
  const len = encodeLength(content.length);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}
function asn1Sequence(items) { return asn1Tag(0x30, Buffer.concat(items)); }
function asn1Set(items) { return asn1Tag(0x31, Buffer.concat(items)); }
function asn1Integer(val) {
  if (typeof val === 'bigint') {
    let hex = val.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    if (parseInt(hex[0], 16) >= 8) hex = '00' + hex;
    return asn1Tag(0x02, Buffer.from(hex, 'hex'));
  }
  const buf = Buffer.alloc(1); buf.writeInt8(val);
  return asn1Tag(0x02, buf);
}
function asn1BitString(content) {
  return asn1Tag(0x03, Buffer.concat([Buffer.from([0x00]), content]));
}
function asn1OctetString(content) { return asn1Tag(0x04, content); }
function asn1Boolean(val) { return asn1Tag(0x01, Buffer.from([val ? 0xff : 0x00])); }
function asn1UTF8(str) { return asn1Tag(0x0c, Buffer.from(str, 'utf8')); }
function asn1OID(oid) {
  const parts = oid.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    if (v < 128) { bytes.push(v); }
    else {
      const enc = [];
      enc.push(v & 0x7f); v >>= 7;
      while (v > 0) { enc.push(0x80 | (v & 0x7f)); v >>= 7; }
      bytes.push(...enc.reverse());
    }
  }
  return asn1Tag(0x06, Buffer.from(bytes));
}
function asn1UTCTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  return asn1Tag(0x17, Buffer.from(s));
}
function asn1Explicit(tag, content) { return asn1Tag(0xa0 | tag, content); }
function asn1Context(tag, content) { return asn1Tag(0x80 | tag, content); }
function sha256WithRSA() {
  // OID 1.2.840.113549.1.1.11 + NULL
  return asn1Sequence([asn1OID('1.2.840.113549.1.1.11'), asn1Tag(0x05, Buffer.alloc(0))]);
}
function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  if (len < 256) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}
function pemToDer(pem, label) {
  const b64 = pem.replace(new RegExp(`-----(?:BEGIN|END) ${label}-----`, 'g'), '').replace(/\s/g, '');  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp -- RegExp built from an internal constant PEM label, not user input (audited)
  return Buffer.from(b64, 'base64');
}
