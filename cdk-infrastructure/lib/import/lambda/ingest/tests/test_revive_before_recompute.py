"""ingest handler: revive MUST precede the study aggregate recompute.

Regression for the delete-then-reingest bug: deleting a study (soft-delete
cascading up) then re-sending it made the study reappear with 0 series, 0
instances and no ModalitiesInStudy.

Root cause: in _aggregate_series the study-level recompute counts only LIVE
(deleted_at IS NULL) series/instances. On a re-ingest into a tombstoned study
the lean live path links fresh LIVE instances via a plain SELECT and never calls
the _upsert_* get-or-create that would revive the parents, so the
series/study/patient stay soft-deleted. The revive settle-pass used to run AFTER
_recompute_study, so the study aggregates were computed while the series was
still soft-deleted -> numberofstudyrelatedseries=0, numberofstudyrelatedinstances
=0, modalitiesinstudy=NULL. The revive then made the (zero-count) study live
again -> it reappears empty.

Fix: run _revive_populated_parents BEFORE _recompute_series/_recompute_study so
the counts see live rows. This test pins that ordering.

Run: cd cdk-infrastructure/lib/import/lambda/ingest && python3.12 -m pytest tests/
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import handler as h  # noqa: E402


class _Conn:
    pass


def _install_order_tracer(monkeypatch):
    """Patch the settle-pass collaborators to record the order they run in.

    _with_deadlock_retry(fn, *args) normally invokes fn(*args) with retry; here
    we make it record the target function's name and skip the real DB work so the
    test is pure-ordering and needs no database.
    """
    order = []

    def fake_retry(fn, *args, **kwargs):
        name = getattr(fn, '__name__', repr(fn))
        order.append(name)
        return None

    monkeypatch.setattr(h.engine, '_with_deadlock_retry', fake_retry)
    # Tracker reads/writes are irrelevant to ordering -> stub them out.
    monkeypatch.setattr(h, '_read_tracker', lambda *a: (None, None))
    monkeypatch.setattr(h, '_resolve_series_study_pkey', lambda *a: (42, 14))
    monkeypatch.setattr(h, '_delete_tracker_if_unchanged', lambda *a: True)
    return order


def test_revive_runs_before_study_recompute(monkeypatch):
    order = _install_order_tracer(monkeypatch)
    dirty = set()

    h._aggregate_series(_Conn(), 'ds-1', 'st-1', 'se-1', our_pkey=100, dirty=dirty)

    # All three must have run.
    for name in ('_revive_populated_parents', '_recompute_series', '_recompute_study'):
        assert name in order, (name, order)

    revive_at = order.index('_revive_populated_parents')
    series_at = order.index('_recompute_series')
    study_at = order.index('_recompute_study')

    # The core invariant: revive the tombstoned chain BEFORE the live-count
    # recompute, so numberofstudyrelatedseries / numberofstudyrelatedinstances /
    # modalitiesinstudy are computed against live rows.
    assert revive_at < series_at, order
    assert revive_at < study_at, order


def test_empty_cascade_runs_after_recompute(monkeypatch):
    """The empty-side cascade (0-live-child soft-delete) is the mirror of revive
    and must still run AFTER the recompute, so it reaps a genuinely emptied
    series using the counts the recompute just wrote. Revive (>0 live) and
    empty-cascade (0 live) are mutually exclusive, so their relative order is
    only a concern for the empty path."""
    order = _install_order_tracer(monkeypatch)

    h._aggregate_series(_Conn(), 'ds-1', 'st-1', 'se-1', our_pkey=100, dirty=set())

    assert '_cascade_empty_parents' in order, order
    study_at = order.index('_recompute_study')
    empty_at = order.index('_cascade_empty_parents')
    assert empty_at > study_at, order
