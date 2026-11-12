"""Shared exception types for the s3-ingest Lambda.

Kept in their own module so handler.py, tar_ingest.py and archive_ingest.py can
all raise/catch them without circular imports.
"""


class PermanentIngestError(Exception):
    """The object can never be ingested, no matter how often SQS redelivers.

    Raising this (instead of a generic Exception) tells the handler to fail the
    object VISIBLY — record the failure on its import job, emit an
    'Import Object Failed' synthetic event, forward a description to the ingest
    DLQ — and then succeed the SQS message so the failure is not double-counted
    by redelivery. Transient errors (S3 5xx, DB connectivity) must NOT use this
    type: they propagate normally so SQS retries the message.
    """
