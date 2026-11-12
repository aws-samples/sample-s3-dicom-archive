# DICOM TLS Support

## Overview

This feature adds TLS (Transport Layer Security) support to the DICOM DIMSE service, enabling encrypted DICOM communication on the standard DICOM TLS port (2762) alongside the existing unencrypted port (11112). It supports optional mutual TLS (mTLS) for client certificate verification.

## Architecture

### Dual-Listener Design

The DICOM service runs two server instances simultaneously:
- **Port 11112** — Plain DICOM (unencrypted, existing behavior)
- **Port 2762** — DICOM over TLS (encrypted)

This is required because pynetdicom cannot serve both TLS and plain DICOM on the same port. Each listener runs in its own thread.

### Network Load Balancer

The NLB exposes both ports using TCP passthrough (not TLS termination). TCP passthrough is required because:
- NLB TLS termination does not support mTLS (client certificate verification)
- The application must handle TLS directly to verify client certificates
- pynetdicom manages the TLS handshake internally

### Certificate Management

#### Server Certificate (Auto-Generated)
At CDK deployment time, a custom resource Lambda generates:
- A self-signed CA (Certificate Authority) key + certificate
- A server key + certificate signed by the CA
- Stored in AWS Secrets Manager as `{stackPrefix}-dicom-tls-certs`
- Only generated on initial deployment; subsequent deploys preserve existing certs

#### Client Certificates (Admin-Managed)
Admins upload client certificate PEM data per DICOM entity via the admin UI. These certificates are:
- Stored in the `client_certificate` column of the `dicom_entities` table
- Returned by the config service to the DICOM service at startup
- Used to build a CA bundle for mTLS verification when `tls_verify_client` is enabled

## Configuration

### Location Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dicom_tls_port` | INT | 2762 | TLS listener port |
| `tls_verify_client` | BOOLEAN | FALSE | Enable mTLS (require client certificates) |

### Config Service Response

The config service includes a `tlsConfig` block in its response:

```json
{
  "tlsConfig": {
    "port": 2762,
    "verifyClient": false,
    "serverCert": "-----BEGIN CERTIFICATE-----\n...",
    "serverKey": "-----BEGIN PRIVATE KEY-----\n...",
    "caCert": "-----BEGIN CERTIFICATE-----\n...",
    "clientCertificates": [
      "-----BEGIN CERTIFICATE-----\n..."
    ]
  }
}
```

## pynetdicom Constraints

- **TLS 1.2 maximum**: pynetdicom does not support TLS 1.3. The SSL context must be capped at TLS 1.2:
  ```python
  ssl_ctx.maximum_version = ssl.TLSVersion.TLSv1_2
  ```
- **Dynamic SSL context swap**: The server's `ssl_context` attribute can be replaced at runtime to update client certificates without restarting the service
- **Separate server instances**: TLS and plain DICOM require separate `start_server()` calls on different ports

## Database Schema Changes

The following SQL statements must be run manually on existing deployments:

```sql
ALTER TABLE locations ADD COLUMN dicom_tls_port INT DEFAULT NULL;
ALTER TABLE locations ADD COLUMN tls_verify_client BOOLEAN DEFAULT FALSE;
ALTER TABLE dicom_entities ADD COLUMN client_certificate TEXT DEFAULT NULL;
ALTER TABLE dicom_entities ADD COLUMN tls_enabled BOOLEAN DEFAULT FALSE;
```

## Testing

### Prerequisites

Install DCMTK: `brew install dcmtk`

### C-ECHO over TLS (no client cert)

```bash
echoscu --tls12 --anonymous-tls --ignore-peer-cert <hostname> 2762
```

### C-ECHO over mTLS (with client cert)

```bash
echoscu --tls12 \
  +cf /path/to/client-cert.pem \
  +pk /path/to/client-key.pem \
  +ca /path/to/ca-cert.pem \
  <hostname> 2762
```

### C-STORE over mTLS

```bash
storescu --tls12 \
  +cf /path/to/client-cert.pem \
  +pk /path/to/client-key.pem \
  +ca /path/to/ca-cert.pem \
  <hostname> 2762 /path/to/file.dcm
```

## Weasis Note

As of Weasis 4.6.6, there is no built-in support for DICOM DIMSE over TLS. Alternatives:
- Use DICOMWeb (WADO-RS/QIDO-RS) over HTTPS instead (supported)
- Use a TLS-terminating proxy (stunnel, nginx, envoy)
