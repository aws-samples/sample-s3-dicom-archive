"""ingest handler: an invocation must not end inside an open transaction.

Run: cd cdk-infrastructure/lib/import/lambda/ingest && python3.12 -m pytest tests/
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import handler as h  # noqa: E402


class _Conn:
    def __init__(self):
        self.calls = []

    def commit(self):
        self.calls.append('commit')

    def rollback(self):
        self.calls.append('rollback')


class _Sqs:
    def send_message_batch(self, **kw):
        return {}


def test_handler_commits_after_the_trailing_vf_assign_lookup(monkeypatch):
    conn = _Conn()
    monkeypatch.setattr(h.engine, '_get_db_conn', lambda: conn)

    def process(c, rec, _a, cache=None):
        cache.touched_study_series_v2 = {('ds-1', 'st-1', 'se-1'): 5}
    monkeypatch.setattr(h.engine, '_process_message', process)
    monkeypatch.setattr(h, '_upsert_tracker', lambda *a: None)
    monkeypatch.setattr(h, '_aggregate_series', lambda *a: None)
    monkeypatch.setattr(h, 'DEBOUNCE_MS', 0)
    monkeypatch.setattr(h.engine, '_VF_ASSIGN_QUEUE_URL', 'https://sqs/q')
    monkeypatch.setattr(h.engine, 'sqs_client', _Sqs())

    def lookup(c, *a):
        c.calls.append('select series')  # a read that opens a transaction
        return 7
    monkeypatch.setattr(h.engine, '_select_parent_pkey', lookup)

    out = h.handler({'Records': [{'messageId': 'm1', 'body': '{}'}]}, None)
    assert out == {'batchItemFailures': []}
    assert 'select series' in conn.calls
    assert conn.calls[-1] == 'commit', conn.calls


def test_failed_message_does_not_leak_rolled_back_parent_pkeys(monkeypatch):
    """A message that fails is rolled back, so any patient/study/series rows it
    inserted are gone. The next message must not reuse their pkeys from the
    shared parent cache (that produced FK 1216 on every later message)."""
    conn = _Conn()
    monkeypatch.setattr(h.engine, '_get_db_conn', lambda: conn)
    seen = []

    def process(c, rec, _a, cache=None):
        seen.append(dict(cache.series))
        if rec['messageId'] == 'm1':
            cache.series[('ds-1', 'st-1', 'se-1')] = 99  # inserted, then rolled back
            raise RuntimeError('boom')
        cache.touched_study_series_v2 = {}
    monkeypatch.setattr(h.engine, '_process_message', process)
    monkeypatch.setattr(h, '_upsert_tracker', lambda *a: None)
    monkeypatch.setattr(h, '_aggregate_series', lambda *a: None)
    monkeypatch.setattr(h, 'DEBOUNCE_MS', 0)
    monkeypatch.setattr(h.engine, '_VF_ASSIGN_QUEUE_URL', '')

    out = h.handler({'Records': [{'messageId': 'm1', 'body': '{}'},
                                 {'messageId': 'm2', 'body': '{}'}]}, None)
    assert out == {'batchItemFailures': [{'itemIdentifier': 'm1'}]}
    assert seen[1] == {}, seen
