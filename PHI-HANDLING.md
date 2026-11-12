# PHI / HIPAA — customer responsibility

This project processes and stores medical imaging data (DICOM) and HL7 messages
that typically contain Protected Health Information (PHI): patient names, IDs,
birth dates, accession numbers, study/series metadata, and the pixel data
itself.

## Shared-responsibility statement

This software is a building block, not a certified compliance solution. It does
NOT by itself make a deployment HIPAA-compliant. Deploying, configuring, and
operating it in a way that meets HIPAA (or any other regulatory regime) is the
**customer's / operator's responsibility**, including at least:

- **BAA**: execute a Business Associate Addendum with AWS and ensure only
  HIPAA-eligible AWS services are used in the account that holds PHI.
- **Encryption**: enable encryption at rest (S3 SSE/KMS, Aurora storage
  encryption, EBS) and in transit (TLS) for every component. Database
  connections in this stack verify TLS against the Amazon RDS CA bundle
  (verify-full); keep that enabled.
- **Access control**: scope IAM roles to least privilege, restrict the Cognito
  user pool, and review the privilege-group model before granting access.
- **Audit logging & retention**: configure CloudTrail, access logging, and the
  application audit trail, and set retention to satisfy your policies. The
  default application activity-log retention is 90 days and is configurable; it
  is not a HIPAA-mandated value.
- **De-identification**: where PHI must not leave a boundary, use the
  virtual-folder de-identification features and verify the output.
- **Network isolation**: deploy in-VPC (private subnets, no public PHI data
  plane) as the in-VPC deployment guide describes.
- **Logging hygiene**: application logs are written to avoid PHI values (IDs,
  names, accession numbers, tokens are redacted). Do not raise log verbosity in
  a way that reintroduces PHI, and control who can read CloudWatch logs.
- **Data lifecycle & breach response**: define backup, deletion, and incident
  procedures for the PHI you store.

No statement in this repository, its READMEs, its UI, or its code comments
should be read as a representation that a given deployment is HIPAA-compliant.
Assess compliance for your specific deployment with qualified counsel.
