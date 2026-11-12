# Database TLS CA bundle

`rds-global-bundle.pem` is the trust store used to VERIFY the server certificate
on every database connection (Node lambdas via the shared `database.js` and each
inline `mysql2` connector; Python lambdas + the `dicomweb-s3` container via
PyMySQL `ssl={'ca': ...}`). It replaces the old `rejectUnauthorized: false` /
`check_hostname: False`-with-no-CA configuration that skipped verification and
left the in-VPC DB path open to a MITM presenting any certificate.

## Why it is a COMBINED bundle (RDS CA + public roots)

Connections take two shapes and chain to two different roots:

- **RDS Proxy endpoint** (`*.proxy-*.rds.amazonaws.com`) — what most lambdas use
  via `DB_HOST`. The proxy presents a certificate issued by **Amazon Trust
  Services**, chained to a **public Amazon root CA** — NOT the Amazon RDS CA.
- **Aurora cluster writer endpoint** — used by the secret-rotation lambda. Its
  certificate chains to the **Amazon RDS regional root CA** (e.g.
  `rds-ca-rsa2048-g1`).

Both Node (`ssl.ca`) and PyMySQL (`ssl={'ca': ...}`) REPLACE the runtime's
built-in public root set when you pass a `ca`. So a bundle containing only the
RDS CA roots makes the proxy connection fail with
`unable to get local issuer certificate`. The bundle therefore carries BOTH:

1. the Amazon RDS global CA bundle (all regions, RSA2048/4096 + ECC roots), and
2. the public root CAs (incl. Amazon Trust Services) from the runtime trust store.

Hostname verification is **enforced (verify-full, not verify-ca)** on every
database connection: Node connectors use `rejectUnauthorized: true` with
mysql2/Node's default `checkServerIdentity` (never overridden), and PyMySQL
connectors pass `ssl={'ca': <bundle>, 'check_hostname': True}`. Because the
bundle also trusts public roots (needed for the RDS Proxy chain), checking the
chain alone would accept any publicly-trusted certificate for any host; the
hostname check closes that, so the presented certificate's SAN must match the
proxy / cluster endpoint actually being connected to. RDS Proxy and Aurora
endpoint certificates cover their endpoint DNS names, so verify-full works
against the private endpoints with no extra configuration.

## Regenerating the bundle

```bash
# 1. Amazon RDS global CA bundle (all regions)
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o rds.pem

# 2. Public roots from the Node trust store (includes Amazon Trust Services)
node -e "const tls=require('tls');process.stdout.write(tls.rootCertificates.join('\n')+'\n')" > public.pem

# 3. Combine (RDS roots first, then public roots)
cat rds.pem public.pem > rds-global-bundle.pem

# 4. Copy to every DB-connecting lambda/container dir (see scripts or the
#    bundling `cp *.pem` steps). The canonical copy lives here.
```

`DB_SSL_CA_PATH` overrides the bundle path at runtime in every connector.
