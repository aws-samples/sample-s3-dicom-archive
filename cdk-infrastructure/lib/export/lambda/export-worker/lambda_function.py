# HIPAA Compliance: This function processes Protected Health Information (PHI) during
# DICOM export and de-identification. Deploying organizations must ensure:
# (1) AWS Business Associate Agreement (BAA) is in place
# (2) Encryption at rest enabled for S3, RDS, and Lambda environment variables
# (3) Encryption in transit (TLS) for all API calls
# (4) CloudWatch Logs encryption enabled
# (5) Audit logging enabled via EventBridge
# De-identification is configurable via profiles and does not guarantee Safe Harbor
# or Expert Determination compliance without proper profile configuration.


def handler(event, context):
    # TODO(s3-parity): PARKED. This worker fetched instances from the removed
    # cloud imaging DICOMweb endpoint and its step input is keyed on the legacy
    # imageset id / datastore id shape produced by export-init. Both the init
    # (which now builds no steps) and this worker are parked until the export path
    # is repointed to read object bytes from S3 via storage_index and to key steps
    # on content_pkey. Fail fast and honestly rather than run against a source that
    # no longer exists.
    raise NotImplementedError(
        'TODO(s3-parity): VF export worker parked — DICOM fetch/export not yet ported to S3 (storage_index)'
    )
