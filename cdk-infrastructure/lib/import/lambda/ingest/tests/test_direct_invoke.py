"""ingest handler: the synchronous {"direct": {bucket, key}} path (STOW-RS, WSI).

The STOW-RS service and the non-DICOM encapsulator invoke the ingest function
RequestResponse and read {'ok', 'instanceCount', 'datastoreId'} / {'ok': False,
'error'}. The object must be fully settled (series/study aggregate, VF-assign
emit) before the call returns, without the SQS path's debounce sleep.

Run: cd cdk-infrastructure/lib/import/lambda/ingest && python3.12 -m pytest tests/
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import handler as h  # noqa: E402

DS = 'ds-1'
TRI = (DS, 'st-1', 'se-1')


class _Conn:
    def __init__(self):
        self.calls = []

    def commit(self):
        self.calls.append('commit')

    def rollback(self):
        self.calls.append('rollback')


class _Result:
    def __init__(self, kind, instances):
        self.kind = kind
        self.instances = instances


class _Datastore:
    id = DS


def _wire(monkeypatch, conn, *, created=None, datastore=_Datastore()):
    """Stub the engine around _handle_created; record the settle + events."""
    seen = {'settle': [], 'events': [], 'handle': []}
    monkeypatch.setattr(h.engine, '_get_db_conn', lambda: conn)
    monkeypatch.setattr(h.engine, '_resolve_datastore', lambda c, b: datastore)

    def handle_created(c, ds, bucket, key, cache=None):
        seen['handle'].append((ds.id, bucket, key))
        if created is None:
            return _Result('created', ['i1', 'i2'])
        return created(cache)
    monkeypatch.setattr(h.engine, '_handle_created', handle_created)
    # Real retry wrapper semantics are not under test; call straight through
    # (it pops _dl_cache before forwarding, so mirror that).
    monkeypatch.setattr(h.engine, '_with_deadlock_retry',
                        lambda fn, *a, _dl_cache=None, **k: fn(*a, **k))
    monkeypatch.setattr(h, '_settle_touched',
                        lambda c, touched, debounce=True: seen['settle'].append((dict(touched), debounce)))
    monkeypatch.setattr(h.engine.index_events, 'emit_instances_indexed',
                        lambda *a: seen['events'].append(a))
    return seen


def _touching(cache):
    cache.touched_study_series_v2 = {TRI: 42}
    return _Result('created', ['i1'])


def test_direct_indexes_settles_without_debounce_and_reports(monkeypatch):
    conn = _Conn()
    seen = _wire(monkeypatch, conn, created=_touching)
    out = h.handler({'direct': {'bucket': 'b', 'key': 'k.dcm'}}, None)
    assert out == {'ok': True, 'instanceCount': 1, 'datastoreId': DS}
    assert seen['handle'] == [(DS, 'b', 'k.dcm')]
    # Committed BEFORE the settle step, as on the SQS path.
    assert conn.calls and conn.calls[0] == 'commit'
    (touched, debounce), = seen['settle']
    assert debounce is False
    assert list(touched) == [TRI]
    pkey, ev = touched[TRI]
    assert pkey == 42
    assert ev[:4] == time.strftime('%Y', time.gmtime()) and len(ev) == 26  # DATETIME(6)
    assert seen['events'] == [(DS, 'b', 'k.dcm', ['i1'])]


def test_direct_does_not_go_through_the_sqs_loop(monkeypatch):
    conn = _Conn()
    _wire(monkeypatch, conn)
    monkeypatch.setattr(h.engine, '_process_message',
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError('SQS path used')))
    assert h.handler({'direct': {'bucket': 'b', 'key': 'k'}}, None)['ok'] is True


def test_direct_settle_really_skips_the_debounce_sleep(monkeypatch):
    """The unstubbed _settle_touched must not sleep when debounce=False."""
    conn = _Conn()
    monkeypatch.setattr(h, 'DEBOUNCE_MS', 60_000)
    monkeypatch.setattr(h, '_upsert_tracker', lambda *a: None)
    monkeypatch.setattr(h, '_aggregate_series', lambda *a: None)
    monkeypatch.setattr(h.engine, '_VF_ASSIGN_QUEUE_URL', '')
    monkeypatch.setattr(h.time, 'sleep', lambda s: (_ for _ in ()).throw(AssertionError(f'slept {s}')))
    h._settle_touched(conn, {TRI: [1, None]}, debounce=False)
    assert conn.calls[-1] == 'commit'


def test_direct_missing_bucket_or_key_is_refused_without_db(monkeypatch):
    monkeypatch.setattr(h.engine, '_get_db_conn',
                        lambda: (_ for _ in ()).throw(AssertionError('DB opened')))
    for bad in ({'bucket': 'b'}, {'key': 'k'}, {'bucket': '', 'key': 'k'}, 'b/k'):
        out = h.handler({'direct': bad}, None)
        assert out == {'ok': False, 'error': 'direct invoke requires bucket and key'}, bad


def test_direct_unregistered_bucket(monkeypatch):
    conn = _Conn()
    seen = _wire(monkeypatch, conn, datastore=None)
    out = h.handler({'direct': {'bucket': 'nope', 'key': 'k'}}, None)
    assert out == {'ok': False, 'error': 'bucket nope not registered to any S3 datastore'}
    assert seen['handle'] == [] and seen['settle'] == []


def test_direct_missing_object_reports_not_found_and_does_not_settle(monkeypatch):
    conn = _Conn()
    seen = _wire(monkeypatch, conn, created=lambda cache: _Result('skipped', []))
    out = h.handler({'direct': {'bucket': 'b', 'key': 'gone'}}, None)
    assert out == {'ok': False, 'error': 'object not found: s3://b/gone'}
    assert seen['settle'] == [] and seen['events'] == []


def test_direct_permanent_error_rolls_back_and_reports(monkeypatch):
    conn = _Conn()

    def boom(cache):
        raise h.engine.PermanentIngestError('not a DICOM file')
    seen = _wire(monkeypatch, conn, created=boom)
    out = h.handler({'direct': {'bucket': 'b', 'key': 'k'}}, None)
    assert out == {'ok': False, 'error': 'not a DICOM file'}
    assert conn.calls == ['rollback']
    assert seen['settle'] == []


def test_direct_unexpected_error_rolls_back_and_reports(monkeypatch):
    conn = _Conn()

    def boom(cache):
        raise RuntimeError('db went away')
    _wire(monkeypatch, conn, created=boom)
    out = h.handler({'direct': {'bucket': 'b', 'key': 'k'}}, None)
    assert out == {'ok': False, 'error': 'db went away'}
    assert conn.calls == ['rollback']


def test_direct_index_event_failure_does_not_fail_the_ingest(monkeypatch):
    conn = _Conn()
    _wire(monkeypatch, conn)
    monkeypatch.setattr(h.engine.index_events, 'emit_instances_indexed',
                        lambda *a: (_ for _ in ()).throw(RuntimeError('bus down')))
    out = h.handler({'direct': {'bucket': 'b', 'key': 'k'}}, None)
    assert out == {'ok': True, 'instanceCount': 2, 'datastoreId': DS}


def test_sqs_path_still_debounces(monkeypatch):
    """The SQS batch path keeps its debounce (default debounce=True)."""
    conn = _Conn()
    slept = []
    monkeypatch.setattr(h, 'DEBOUNCE_MS', 5)
    monkeypatch.setattr(h, '_upsert_tracker', lambda *a: None)
    monkeypatch.setattr(h, '_aggregate_series', lambda *a: None)
    monkeypatch.setattr(h.engine, '_VF_ASSIGN_QUEUE_URL', '')
    monkeypatch.setattr(h.time, 'sleep', lambda s: slept.append(s))
    h._settle_touched(conn, {TRI: [1, None]})
    assert slept == [0.005]
