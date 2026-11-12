"""STOW-RS synchronous ingest: transport errors on the Lambda invoke are retried.

The Lambda client has botocore retries off; _invoke_sync_ingest retries a closed
connection, a timeout or a throttle, and gives up on anything else at once.
"""
import io
import json

import pytest
from botocore.exceptions import ClientError, ConnectionClosedError, EndpointConnectionError, ReadTimeoutError

import main


class FakeLambda:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def invoke(self, **kw):
        self.calls += 1
        o = self.outcomes.pop(0)
        if isinstance(o, Exception):
            raise o
        return {'StatusCode': 200, 'Payload': io.BytesIO(json.dumps(o).encode())}


def _client_error(code):
    return ClientError({'Error': {'Code': code, 'Message': code}}, 'Invoke')


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    monkeypatch.setattr(main, 'INGEST_FUNCTION_ARN', 'arn:aws:lambda:us-east-1:1:function:ingest')
    monkeypatch.setattr(main, 'STOW_INGEST_ATTEMPTS', 3)
    monkeypatch.setattr(main.time, 'sleep', lambda s: None)


@pytest.mark.parametrize('err', [
    ConnectionClosedError(endpoint_url='https://lambda'),
    ReadTimeoutError(endpoint_url='https://lambda'),
    EndpointConnectionError(endpoint_url='https://lambda'),
    _client_error('TooManyRequestsException'),
    _client_error('ServiceException'),
])
def test_transient_error_then_success(monkeypatch, err):
    fake = FakeLambda([err, {'ok': True}])
    monkeypatch.setattr(main, 'lambda_client', fake)
    resp, payload = main._invoke_sync_ingest('b', 'k', '1.2.3')
    assert payload == {'ok': True} and fake.calls == 2


def test_gives_up_after_the_attempt_budget(monkeypatch):
    fake = FakeLambda([ConnectionClosedError(endpoint_url='x')] * 3)
    monkeypatch.setattr(main, 'lambda_client', fake)
    with pytest.raises(ConnectionClosedError):
        main._invoke_sync_ingest('b', 'k', '1.2.3')
    assert fake.calls == 3


def test_permanent_error_is_not_retried(monkeypatch):
    fake = FakeLambda([_client_error('AccessDeniedException')])
    monkeypatch.setattr(main, 'lambda_client', fake)
    with pytest.raises(ClientError):
        main._invoke_sync_ingest('b', 'k', '1.2.3')
    assert fake.calls == 1


def test_function_error_payload_is_returned_not_retried(monkeypatch):
    fake = FakeLambda([{'ok': False, 'error': 'bad file'}])
    monkeypatch.setattr(main, 'lambda_client', fake)
    resp, payload = main._invoke_sync_ingest('b', 'k', '1.2.3')
    assert payload['error'] == 'bad file' and fake.calls == 1
