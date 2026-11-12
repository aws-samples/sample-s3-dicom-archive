"""(0008,0056) Instance Availability guard for the retrieve paths.

Every retrieve endpoint that performs a ranged GET against the backing S3 object
has to refuse when that object is no longer ranged-GET addressable. The three
values are written by the ingest Lambda and defined normatively by the DDL
comment in schema-s3-index.sql:

    'ONLINE' or NULL  object is reachable now
    'NEARLINE'        a restore is in progress
    'OFFLINE'         tiered to an archive class, restore expired, or removed

NULL means ONLINE: the plain DICOM ingest path never writes the column and its
UPDATE branch explicitly resets it to NULL, so a missing value is the normal
case for the overwhelming majority of instances.

WADO /metadata deliberately does NOT use this guard — the metadata blob lives in
the database, so serving it touches no archived object and is exactly what a
client needs to render an "archived, request restore" affordance with real
study/series/instance context.
"""

import os

from flask import Response

# How long a client should wait before retrying. A NEARLINE restore from Glacier
# Flexible Retrieval completes in minutes; an OFFLINE object needs an operator or
# a restore workflow to act first, so there is no point in a tight retry loop.
RETRY_AFTER_OFFLINE = int(os.environ.get('AVAILABILITY_RETRY_AFTER_OFFLINE', '3600'))
RETRY_AFTER_NEARLINE = int(os.environ.get('AVAILABILITY_RETRY_AFTER_NEARLINE', '300'))

_NEARLINE_BODY = 'instance is NEARLINE (restore in progress); retry after the restore completes'
_OFFLINE_BODY = 'instance is OFFLINE (archived); a restore must be requested before retrieval'

_READABLE = (None, '', 'ONLINE')


def is_readable(availability: str | None) -> bool:
    """True when a ranged GET against the object is expected to succeed."""
    return availability in _READABLE


def worst_availability(values) -> str | None:
    """Worst state in an iterable of availability values, or None if all readable.

    Study- and series-level bulk retrieve commit a status code before the first
    byte of the multipart body, so the whole row set has to be judged up front.
    Worst-wins is the opposite of the writer's best-wins series rollup, and
    deliberately so: the rollup answers "is any of this reachable", while a bulk
    retrieve has to answer "is all of it reachable", because a silently short
    multipart study is indistinguishable from a complete one.
    """
    nearline = False
    for value in values:
        if is_readable(value):
            continue
        if value == 'NEARLINE':
            nearline = True
        else:
            return 'OFFLINE'
    return 'NEARLINE' if nearline else None


def unavailable_response(availability: str | None) -> Response | None:
    """None when the object is readable now (ONLINE or NULL).

    Otherwise a 503 text/plain Response with a Retry-After header. text/plain
    matches the error style the rest of the read path uses.
    """
    if is_readable(availability):
        return None
    if availability == 'NEARLINE':
        return Response(status=503, response=_NEARLINE_BODY, content_type='text/plain',
                        headers={'Retry-After': str(RETRY_AFTER_NEARLINE)})
    # Anything we do not recognize is treated as OFFLINE. Fail-safe direction: a
    # future availability value this build has never heard of must not be assumed
    # readable.
    return Response(status=503, response=_OFFLINE_BODY, content_type='text/plain',
                    headers={'Retry-After': str(RETRY_AFTER_OFFLINE)})
