"""Lifecycle-aware availability (assessment §11.3, locked).

Objects tiered below Glacier Instant Retrieval => instance.instanceavailability='OFFLINE'
(+ series rollup); restore-in-progress => 'NEARLINE'; restored/instant tiers =>
'ONLINE'. Tar members inherit the containing object's availability (they share
one s3key). The mapping itself and the DB effects are pinned here; the event
*shapes* are covered by test_index_events.py and the wire normalization by
test_event_normalization.py.
"""

import engine as H
from conftest import DS_A, make_dicom as _dicom, make_tar as _tar


# ── storage-class / access-tier mapping ───────────────────────────────────────
def test_availability_for_transition_mapping():
    f = H._availability_for_transition
    # Below Glacier Instant Retrieval -> OFFLINE
    assert f("GLACIER", None) == "OFFLINE"
    assert f("DEEP_ARCHIVE", None) == "OFFLINE"
    # Ranged-GET-addressable classes stay ONLINE
    assert f("GLACIER_IR", None) == "ONLINE"
    assert f("STANDARD_IA", None) == "ONLINE"
    assert f("INTELLIGENT_TIERING", None) == "ONLINE"
    assert f("ONEZONE_IA", None) == "ONLINE"
    assert f(None, None) == "ONLINE"
    # Intelligent-Tiering archive tiers -> OFFLINE; frequent/infrequent -> ONLINE
    assert f(None, "ARCHIVE_ACCESS") == "OFFLINE"
    assert f(None, "DEEP_ARCHIVE_ACCESS") == "OFFLINE"
    assert f(None, "FREQUENT_ACCESS") == "ONLINE"
    assert f(None, "INFREQUENT_ACCESS") == "ONLINE"
    # case-insensitive
    assert f("glacier", None) == "OFFLINE"


# ── DB effects ────────────────────────────────────────────────────────────────
def _ingest_tar(fake_conn, fake_s3, monkeypatch, n=3, key="in/study.tar"):
    data = _tar([(f"{i}.dcm", _dicom(sop_uid=f"1.2.860.{i}")) for i in range(n)])
    fake_s3.put("bkt", key, data)
    monkeypatch.setattr(H, "s3_client", fake_s3)
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    H._handle_created(fake_conn, ds, "bkt", key)
    return ds, key


def test_transition_offline_flips_every_tar_member(fake_conn, fake_s3, monkeypatch):
    """One lifecycle transition on the archive object flips all member rows."""
    ds, key = _ingest_tar(fake_conn, fake_s3, monkeypatch, n=3)

    changed = H._handle_availability(fake_conn, ds, "bkt", key, "OFFLINE")

    assert len(changed) == 3
    assert all(r["instanceavailability"] == "OFFLINE" for r in fake_conn.rows("instance"))
    assert fake_conn.rows("series")[0]["availability"] == "OFFLINE"
    # previousAvailability rides along for the event payload (NULL reads ONLINE)
    assert all(c["previousAvailability"] is None for c in changed)


def test_restore_lifecycle_nearline_then_online_then_offline(fake_conn, fake_s3,
                                                             monkeypatch):
    ds, key = _ingest_tar(fake_conn, fake_s3, monkeypatch, n=2)
    H._handle_availability(fake_conn, ds, "bkt", key, "OFFLINE")

    # Restore Initiated -> NEARLINE
    changed = H._handle_availability(fake_conn, ds, "bkt", key, "NEARLINE")
    assert len(changed) == 2
    assert all(r["instanceavailability"] == "NEARLINE" for r in fake_conn.rows("instance"))
    assert fake_conn.rows("series")[0]["availability"] == "NEARLINE"

    # Restore Completed -> ONLINE
    H._handle_availability(fake_conn, ds, "bkt", key, "ONLINE")
    assert all(r["instanceavailability"] == "ONLINE" for r in fake_conn.rows("instance"))
    assert fake_conn.rows("series")[0]["availability"] == "ONLINE"

    # Restore Expired -> OFFLINE again
    H._handle_availability(fake_conn, ds, "bkt", key, "OFFLINE")
    assert all(r["instanceavailability"] == "OFFLINE" for r in fake_conn.rows("instance"))
    assert fake_conn.rows("series")[0]["availability"] == "OFFLINE"


def test_unchanged_availability_reports_no_changes(fake_conn, fake_s3, monkeypatch):
    """NULL reads as ONLINE, so ONLINE->ONLINE is not a change (no event spam)."""
    ds, key = _ingest_tar(fake_conn, fake_s3, monkeypatch, n=2)

    changed = H._handle_availability(fake_conn, ds, "bkt", key, "ONLINE")

    assert changed == []


def test_series_rollup_best_state_wins(fake_conn, fake_s3, monkeypatch):
    """A series is reachable while ANY of its instances is."""
    # Two separate objects in the same series.
    for i in range(2):
        fake_s3.put("bkt", f"in/{i}.dcm",
                    _dicom(sop_uid=f"1.2.870.{i}", series_uid="1.2.870.9"))
    monkeypatch.setattr(H, "s3_client", fake_s3)
    ds = H.Datastore(id=DS_A, bucket="bkt", prefix="")
    for i in range(2):
        H._handle_created(fake_conn, ds, "bkt", f"in/{i}.dcm")
    assert len(fake_conn.rows("series")) == 1

    # Only object 0 tiers away: the series stays ONLINE.
    H._handle_availability(fake_conn, ds, "bkt", "in/0.dcm", "OFFLINE")
    assert fake_conn.rows("series")[0]["availability"] == "ONLINE"

    # Object 1 goes NEARLINE: best remaining state is NEARLINE.
    H._handle_availability(fake_conn, ds, "bkt", "in/1.dcm", "NEARLINE")
    assert fake_conn.rows("series")[0]["availability"] == "NEARLINE"

    # Object 1 gone OFFLINE too: nothing reachable.
    H._handle_availability(fake_conn, ds, "bkt", "in/1.dcm", "OFFLINE")
    assert fake_conn.rows("series")[0]["availability"] == "OFFLINE"


def test_availability_change_on_unknown_key_is_noop(fake_conn, datastore):
    changed = H._handle_availability(fake_conn, datastore, "bkt",
                                     "never/ingested.dcm", "OFFLINE")
    assert changed == []
    assert fake_conn.commits == 1


def test_availability_change_skips_deleted_instances(fake_conn, fake_s3,
                                                     monkeypatch, datastore):
    ds, key = _ingest_tar(fake_conn, fake_s3, monkeypatch, n=2)
    H._handle_removed(fake_conn, ds, "bkt", key)

    changed = H._handle_availability(fake_conn, ds, "bkt", key, "OFFLINE")

    assert changed == []
    assert all(r["instanceavailability"] is None for r in fake_conn.rows("instance"))
