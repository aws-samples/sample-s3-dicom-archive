"""Audit events on the shared EventBridge bus (source 'dicom.archive').

Same wire shape as the Node layer's sendAuditEvent (lib/main/lambda/layers/
shared/nodejs/audit-helper.js), read by lib/audit/lambda/audit-trail. Emission
never fails a request: errors are logged, not raised. Extracted values and
document text are never put in an audit event.
"""
import json
import logging
import os

import boto3
from botocore.config import Config

logger = logging.getLogger()

EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')

ANALYZE_DOCUMENT = 'ANALYZE_DOCUMENT'
CREATE_NON_DICOM_IMPORT = 'CREATE_NON_DICOM_IMPORT'
RESOURCE_TYPE = 'non_dicom_import'
DETAIL_TYPES = {
    ANALYZE_DOCUMENT: 'DocumentAnalyzed',
    CREATE_NON_DICOM_IMPORT: 'NonDicomImportCreated',
}

_events = None


def _client():
    global _events
    if _events is None:
        # Short timeouts: the event is sent on the response path of /analyze,
        # inside the few seconds left before API Gateway's 29 s limit.
        _events = boto3.client('events', config=Config(
            connect_timeout=2, read_timeout=3, retries={'max_attempts': 2, 'mode': 'standard'}))
    return _events


def send(action, caller, event, resource_id, new_values, status='SUCCESS', error_message=None):
    if not EVENT_BUS_NAME:
        logger.warning('EVENT_BUS_NAME not set, skipping audit event')
        return
    rc = (event or {}).get('requestContext') or {}
    detail = {
        'action': action,
        'resourceType': RESOURCE_TYPE,
        'resourceId': resource_id,
        'user': caller.user_id or caller.username or 'unknown',
        'username': caller.username or 'unknown',
        'ipAddress': (rc.get('identity') or {}).get('sourceIp'),
        'requestId': rc.get('requestId'),
        'apiEndpoint': (event or {}).get('path'),
        'httpMethod': (event or {}).get('httpMethod'),
        'newValues': new_values,
        'status': status,
    }
    if error_message:
        detail['errorMessage'] = error_message[:1000]
    try:
        resp = _client().put_events(Entries=[{
            'Source': 'dicom.archive',
            'DetailType': DETAIL_TYPES.get(action, action),
            'Detail': json.dumps(detail, default=str),
            'EventBusName': EVENT_BUS_NAME,
        }])
        if resp.get('FailedEntryCount'):
            logger.error('Audit event NOT accepted by EventBridge: action=%s', action)
    except Exception as e:  # never fail the request on audit
        logger.error('Failed to send audit event: %s', e.__class__.__name__)
