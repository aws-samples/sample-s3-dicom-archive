"""Ingest lambda entry point — the LIVE single-stage ingest path.

Everything that reacts to an object landing in a datastore bucket runs this one
code base (lib/import/lambda/ingest/):

  handler.py     this file: SQS batch handling, the eventTime-debounced aggregate
  engine.py      the per-object indexing engine (content/instance writes, inline
                 parent get-or-create, DICOM/tar/archive/WSI dispatch)
  aggregate.py   series/study aggregate recompute + stats-dirty marking
  path_ingest.py, tar_ingest.py, archive_ingest.py, dicom_header.py,
  import_jobs.py, index_events.py, ingest_errors.py, s3_ranged_reader.py,
  dedupe_sweep.py   helpers

The same bundle is deployed as several functions (SQS ingest, pathology worker),
which differ only in environment, memory and concurrency (import-pipeline-stack.ts).

One SQS batch of S3 ObjectCreated events -> this lambda:

  1. For every object: parse + write storage_index + Instancemetadata + instance
     (linking series inline via get-or-create of patient/study/series). This is
     exactly the stage-1 work; the parent rows are created here so instances are
     never left unlinked (no backfill).  We record, per touched series, the max
     content_pkey AND the max S3 eventTime seen in this batch.

  2. After the instance writes are durable, for each touched series run the
     eventTime-debounced aggregate:
       a. Upsert series_update_tracker(datastore,series) raising last_content_pkey
          = GREATEST(existing, ours) and last_event_time = GREATEST(existing,ours).
       b. If our eventTime is NOT newer than what was already there (another,
          later batch owns this series) -> skip; that later owner will aggregate.
       c. Else sleep DEBOUNCE_MS, then re-read the row. If last_content_pkey has
          ADVANCED past ours, another lambda took newer instances -> skip (it
          will aggregate). If unchanged -> WE are the sole owner: recompute the
          series + study aggregates (numberof*related*, modalitiesinstudy) and
          mark the datastore stats dirty.
       d. Conditional DELETE of the tracker row guarded on last_content_pkey ==
          ours: if another lambda advanced it mid-work the delete no-ops and that
          lambda owns the (re)compute; if unchanged the row is removed = done.

  Correctness rests on: instance writes are idempotent (content-keyed upserts);
  the aggregate recompute is idempotent (full COUNT); the delete is monotonic on
  last_content_pkey. So any interleaving converges and no update is lost.

Routing, batch/commit semantics, and the S3 event shapes come from engine.py —
this module reuses that code directly.
"""

import json
import os
import re
import time

# engine does the content/instance writes + inline parent get-or-create;
# aggregate does the idempotent series/study recompute.
import engine
import aggregate


DEBOUNCE_MS = int(os.environ.get("INGEST_V3_DEBOUNCE_MS", "1000") or 1000)

# Dashboard stats refresh. After a batch changes a datastore's aggregates, start
# the stats-batch-sync Step Function so the dashboard catches up within minutes
# instead of at the next hourly run. The execution is named after the current
# time bucket, so every ingest invocation in the same bucket shares one run:
# StartExecution with a RUNNING execution's name and the same input is
# idempotent, and a CLOSED one raises ExecutionAlreadyExists, which is ignored.
# The state machine opens with a settle wait one bucket long, so a run covers
# everything committed in the bucket that named it. Each warm container sends
# at most one request per bucket. Unset STATS_SFN_ARN disables it.
STATS_SFN_ARN = os.environ.get("STATS_SFN_ARN", "")
STATS_TRIGGER_BUCKET_S = int(os.environ.get("STATS_TRIGGER_BUCKET_S", "60") or 60)
_stats_last_bucket = None
_sfn_client = None


def _request_stats_refresh():
    global _stats_last_bucket, _sfn_client
    if not STATS_SFN_ARN:
        return
    bucket = int(time.time() // STATS_TRIGGER_BUCKET_S)
    if bucket == _stats_last_bucket:
        return
    _stats_last_bucket = bucket
    try:
        if _sfn_client is None:
            import boto3
            _sfn_client = boto3.client("stepfunctions")
        _sfn_client.start_execution(
            stateMachineArn=STATS_SFN_ARN, name=f"ingest-{bucket}", input="{}")
        print(f"ingest-v3: stats refresh requested (ingest-{bucket})")
    except Exception as e:
        if "ExecutionAlreadyExists" not in str(e):
            print(f"ingest-v3: stats refresh request skipped: {e}")

# Per-VF database name derivation (mirrors vfDbName in
# virtual-folder-api/vf-database.js): 'vf_' + uuid.lower() with dashes removed.
# VF Per-Database Redesign moved each VF's de-id tree into its own database
# vf_<id>, severing the cross-schema FK ON DELETE CASCADE that used to purge
# virtual_instance pointers when a storage object was hard-deleted; the settle
# pass now purges them in application code, fanning out across every vf_<id> DB.
# A SQL identifier cannot be a bind param, so every derived name is validated
# against _VF_DB_RE before it is interpolated.
_VF_DB_RE = re.compile(r'^vf_[0-9a-f]{32}$')


def _list_vf_databases(conn):
    """Enumerate existing per-VF databases from information_schema.SCHEMATA.

    Robust to a stale virtual_folders table: lists the databases that ACTUALLY
    exist. Every name is re-validated against _VF_DB_RE so a schema merely
    starting with 'vf_' but not the exact 'vf_' + 32-hex shape is skipped."""
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA "
            "WHERE SCHEMA_NAME LIKE 'vf\\_%%'")  # %% : pymysql %-formats even with empty params
        return [row[0] for row in cur.fetchall()
                if row[0] and _VF_DB_RE.match(row[0])]
    finally:
        cur.close()


def _upsert_tracker(conn, datastore_id, study_uid, series_uid, content_pkey, event_time):
    """Raise the series' tracker watermark to (content_pkey, event_time).
    Returns (prev_max_pkey, prev_event_time) as seen BEFORE our write is not
    needed; we re-read after the debounce instead. Deadlock-retried by caller."""
    cur = conn.cursor()
    try:
        cur.execute(
            """INSERT INTO series_update_tracker
                 (datastore_id, series_instance_uid, study_instance_uid,
                  last_content_pkey, last_event_time)
               VALUES (%s,%s,%s,%s,%s)
               ON DUPLICATE KEY UPDATE
                 last_content_pkey = GREATEST(last_content_pkey, VALUES(last_content_pkey)),
                 last_event_time   = GREATEST(COALESCE(last_event_time, VALUES(last_event_time)),
                                              VALUES(last_event_time))""",
            (datastore_id, series_uid, study_uid, content_pkey, event_time))
    finally:
        cur.close()
    conn.commit()


def _read_tracker(conn, datastore_id, series_uid):
    """Return (last_content_pkey, last_event_time) or (None, None) if absent."""
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT last_content_pkey, last_event_time FROM series_update_tracker "
            "WHERE datastore_id=%s AND series_instance_uid=%s",
            (datastore_id, series_uid))
        row = cur.fetchone()
        return (row[0], row[1]) if row else (None, None)
    finally:
        cur.close()


def _delete_tracker_if_unchanged(conn, datastore_id, series_uid, our_pkey):
    """Delete the tracker row only if last_content_pkey still equals ours.
    Returns True if deleted (we owned it to the end), False if another lambda
    advanced it (it now owns the follow-up)."""
    cur = conn.cursor()
    try:
        cur.execute(
            "DELETE FROM series_update_tracker "
            "WHERE datastore_id=%s AND series_instance_uid=%s AND last_content_pkey=%s",
            (datastore_id, series_uid, our_pkey))
        deleted = cur.rowcount
    finally:
        cur.close()
    conn.commit()
    return deleted > 0


def _resolve_series_study_pkey(conn, datastore_id, series_uid):
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT series_pkey, study_pkey FROM series "
            "WHERE datastore_id=%s AND seriesinstanceuid=%s",
            (datastore_id, series_uid))
        row = cur.fetchone()
        return (row[0], row[1]) if row else (None, None)
    finally:
        cur.close()


def _aggregate_series(conn, datastore_id, study_uid, series_uid, our_pkey, dirty):
    """Single-owner aggregate for one touched series. The debounce sleep is done
    ONCE per invocation by the caller (before the whole touched-series loop), NOT
    here per series -- so a batch touching N series waits ~1s total, not N*1s."""
    # Re-read the tracker after the caller's single debounce: if pkey advanced,
    # a later batch owns this series -> skip. Else recompute + conditional delete.
    cur_pkey, _ = _read_tracker(conn, datastore_id, series_uid)
    if cur_pkey is not None and cur_pkey > our_pkey:
        print(f"ingest-v3: agg SKIP series={series_uid} our_pkey={our_pkey} "
              f"cur_pkey={cur_pkey} (later owner will aggregate)")
        return
    series_pkey, study_pkey = _resolve_series_study_pkey(conn, datastore_id, series_uid)
    if series_pkey is None or study_pkey is None:
        print(f"ingest-v3: agg SKIP series={series_uid} parents not resolved "
              f"(series_pkey={series_pkey} study_pkey={study_pkey})")
        return
    # REVIVE-SIDE cascade MUST run BEFORE the live-count recompute. On a
    # delete-then-reingest, the reused series/study/patient rows are still
    # tombstoned (deleted_at set) when control reaches here -- the lean live path
    # links fresh LIVE instances via a plain SELECT and never calls the
    # _upsert_* get-or-create that would have revived them. _recompute_study
    # counts only LIVE (deleted_at IS NULL) series/instances, so if the series is
    # still soft-deleted at recompute time the study aggregates compute to
    # numberofstudyrelatedseries=0, numberofstudyrelatedinstances=0,
    # modalitiesinstudy=NULL. Reviving the series->study->patient chain first
    # makes those rows live so the recompute that follows counts them correctly.
    # Keyed off >0-live-instances; the empty-cascade (0-live) still runs after
    # recompute and is its exact mirror, so the two can never both fire.
    try:
        engine._with_deadlock_retry(
            _revive_populated_parents, conn, series_pkey, study_pkey)
    except Exception as e:
        print(f"ingest-v3: revive-cascade settle failed for series={series_uid}: {e}")
    engine._with_deadlock_retry(aggregate._recompute_series, conn, series_pkey)
    engine._with_deadlock_retry(aggregate._recompute_study, conn, study_pkey)
    # Redesign item 3b: apply ENABLED SERIES/STUDY/PATIENT index attributes to
    # the SETTLED rows, in this same coalesced single-writer-per-series
    # post-commit pass (covers an EXISTING series receiving new instances, whose
    # parent row was NOT freshly created this batch so item 3a did not fire).
    # Deadlock-retry-wrapped (item 4) — never swallowed-then-committed. Ordered
    # BEFORE the VF-assign emit (item 5), which runs after this whole loop.
    try:
        engine._with_deadlock_retry(
            _apply_settled_index_attributes,
            conn, datastore_id, series_uid, series_pkey, study_pkey)
    except Exception as e:
        # A persistent failure here must not lose the aggregate work already
        # committed nor the durable instances. Logged; the re-index backfill and
        # a later touch reconcile the attribute column.
        print(f"ingest-v3: index-attr settle failed for series={series_uid}: {e}")
    # DELETE-SIDE cascade (additive to the create/revive/index-attr path above).
    # Runs AFTER the live-count recompute (_recompute_series/_study wrote the
    # deleted_at-IS-NULL counts), in this same coalesced single-writer-per-series
    # post-commit pass, so concurrent series never race the shared study/patient
    # rows. Both steps are deadlock-retry-wrapped (item 4).
    #   (1) VF UNASSIGN (correctness, unconditional): drop any VF membership row
    #       (virtual_folder_assignments + virtual_instance) that still points at a
    #       now-removed storage instance of this series — no VF may serve a gone
    #       object. Hard-delete keyed on content_pkey (the tables' only key; they
    #       have NO deleted_at — VF removal is a hard delete, matching the
    #       existing convention and storage_index's ON DELETE CASCADE semantics).
    #   (2) UPWARD CASCADE: if the series' LIVE instance count is 0, soft-delete
    #       the series; then the study if its LIVE series count is 0; then the
    #       patient if its LIVE study count is 0. SOFT-delete only (deleted_at =
    #       NOW()) so _revive_parent stays symmetric on a later re-ingest. Same
    #       NOT EXISTS(... deleted_at IS NULL) + OFFLINE-exempt convention the GC
    #       sweep uses.
    try:
        engine._with_deadlock_retry(
            _unassign_removed_vf_instances, conn, datastore_id, series_uid)
    except Exception as e:
        print(f"ingest-v3: VF-unassign settle failed for series={series_uid}: {e}")
    # EMPTY-SIDE cascade (symmetric mirror of _revive_populated_parents, which
    # now runs BEFORE the recompute above). The live lean path (INGESTION_V2 +
    # STAGE1_CREATE_PARENTS) resolves an existing series via a plain SELECT and
    # links the instance INLINE, so it never calls the _upsert_* get-or-create
    # that would soft-delete an emptied parent. This settle pass handles the
    # 0-live-instance case: soft-delete series -> study -> patient up the chain.
    # Keyed off the SAME live-count / NOT EXISTS convention the revive uses, so
    # the two are exact mirror images (one is >0-live, the other 0-live) and can
    # never both fire for the same row in one pass.
    try:
        engine._with_deadlock_retry(
            _cascade_empty_parents, conn, series_pkey, study_pkey)
    except Exception as e:
        print(f"ingest-v3: delete-cascade settle failed for series={series_uid}: {e}")
    dirty.add(datastore_id)
    deleted = _delete_tracker_if_unchanged(conn, datastore_id, series_uid, our_pkey)
    print(f"ingest-v3: agg DONE series={series_uid} series_pkey={series_pkey} "
          f"study_pkey={study_pkey} our_pkey={our_pkey} tracker_deleted={deleted}")


def _apply_settled_index_attributes(conn, datastore_id, series_uid,
                                    series_pkey, study_pkey):
    """Populate ENABLED SERIES/STUDY/PATIENT index-attribute columns on the
    settled rows from the representative instance's metadata (MAX content_pkey).

    Reuses stage-1's config loader/coercion (single source of truth for the
    enabled-attrs list + physical column + data-type coercion) and stage-2's
    _load_one_metadata/_dcm for the DICOM-JSON read. INSTANCE-level attrs are NOT
    handled here — they are written inline on the instance's own row in stage-1.
    A no-op single cached SELECT when no SERIES/STUDY/PATIENT STORAGE attr is
    enabled (the common case). Runs INSIDE the deadlock-retry wrapper the caller
    provides, so a 1213/1205 rolls back and retries; it is never swallowed then
    committed. Own commit at the end."""
    attrs = engine._load_index_attributes(conn, datastore_id)
    parent_attrs = [a for a in attrs if a['dicom_level'] in ('SERIES', 'STUDY', 'PATIENT')]
    if not parent_attrs:
        return
    loaded = aggregate._load_one_metadata(conn, datastore_id, series_uid)
    if not loaded:
        # No live instance metadata yet — nothing to read the values from. A
        # later touch (or the re-index backfill) will populate it.
        return
    _cpk, md = loaded
    # Resolve patient_pkey lazily only if a PATIENT-level attr is enabled.
    patient_pkey = None
    if any(a['dicom_level'] == 'PATIENT' for a in parent_attrs) and study_pkey is not None:
        cur = conn.cursor()
        try:
            cur.execute("SELECT patient_pkey FROM study WHERE study_pkey=%s", (study_pkey,))
            r = cur.fetchone()
            patient_pkey = r[0] if r else None
        finally:
            cur.close()
    pkey_val = {'PATIENT': patient_pkey, 'STUDY': study_pkey, 'SERIES': series_pkey}
    wrote = False
    for a in parent_attrs:
        level = a['dicom_level']
        pk = pkey_val.get(level)
        if pk is None:
            continue
        table = engine._INDEX_ATTR_CACHE_TABLE.get(level)
        col = a.get('physical_column') or engine._keyword_column_for_tag(a['dicom_tag'])
        value = engine._coerce_attr_value(aggregate._dcm(md, a['dicom_tag']), a['data_type'])
        cur = conn.cursor()
        try:
            # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
            cur.execute(
                f"UPDATE `{table}` SET `{col}`=%s WHERE {engine._INDEX_ATTR_PKEY[level]}=%s",  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                (value, pk))
            wrote = True
        except Exception as e:
            # A missing column (config/ingest race) must not fail the settle
            # pass — re-index backfill fills it once the ALTER lands. This is the
            # ONLY swallowed case, and it is a DDL-race, not a deadlock: 1213/1205
            # propagate to the retry wrapper (never caught here).
            if isinstance(e, engine.pymysql.err.OperationalError) and (e.args[0] if e.args else None) in (1213, 1205):
                raise
            print(f"ingest-v3: index-attr {col} settle skipped: {e}")
        finally:
            cur.close()
    if wrote:
        conn.commit()


def _unassign_removed_vf_instances(conn, datastore_id, series_uid):
    """Hard-delete VF membership rows that point at a now-removed storage instance
    of this series.

    A removed object is soft-deleted on the storage side (storage_index.deleted_at
    / instance.deleted_at = NOW()) but the storage_index row itself lingers until
    the GC hard-delete past the grace window — and the FK ON DELETE CASCADE from
    virtual_folder_assignments/virtual_instance only fires on that HARD delete. So
    between soft-delete and GC, the VF still points at a gone object; QIDO/WADO on
    that VF would try to serve bytes that are no longer live. This removes those
    dangling pointers immediately, at settle time.

    virtual_folder_assignments (shared, dicomarchive) still keys on content_pkey and
    is deleted directly. The per-VF de-id INSTANCE rows now live in each VF's own
    database vf_<id>.vf_<id>_instance (VF Per-Database Redesign) — the old shared
    virtual_instance table and its ON DELETE CASCADE are gone — so the instance
    pointers are purged by fanning out a keyed-by-content_pkey delete across EVERY
    existing vf_<id> database. Both tables have NO deleted_at (VF membership is a
    HARD delete, per the existing convention), so we hard-delete every membership
    row whose content_pkey is a now-not-live storage instance of this series.
    Scoped to THIS series' objects (datastore_id + series_instance_uid) so the
    single-writer-per-series settle pass only ever touches its own series' rows.
    Idempotent: a second run deletes zero rows. Own transaction; deadlock-retry-
    wrapped by the caller."""
    cur = conn.cursor()
    try:
        # content_pkeys of THIS series that are no longer live (removed).
        removed_pkeys_sql = (
            "SELECT content_pkey FROM storage_index "
            "WHERE datastore_id=%s AND series_instance_uid=%s "
            "  AND deleted_at IS NOT NULL")
        vf_asn = cur.execute(
            "DELETE FROM virtual_folder_assignments "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
            f"WHERE content_pkey IN ({removed_pkeys_sql})",
            (datastore_id, series_uid))
        # Fan the instance-pointer purge out across every per-VF database. Each
        # vf_db is validated against _VF_DB_RE (identifier — cannot be a bind
        # param); datastore_id/series_uid remain bind params inside the subquery.
        vf_inst = 0
        for vf_db in _list_vf_databases(conn):
            # nosemgrep: python.sqlalchemy.security.sqlalchemy-execute-raw-query -- trusted identifier + bound %s params; no user value interpolated (audited)
            vf_inst += cur.execute(
                f"DELETE FROM `{vf_db}`.`{vf_db}_instance` "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                f"WHERE content_pkey IN ({removed_pkeys_sql})",
                (datastore_id, series_uid))
        if vf_asn or vf_inst:
            print(f"ingest-v3: VF-unassign series={series_uid} "
                  f"assignments_removed={vf_asn} vf_instances_removed={vf_inst}")
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cur.close()
    conn.commit()


def _revive_populated_parents(conn, series_pkey, study_pkey):
    """Clear deleted_at upward (series -> study -> patient) when live children exist.

    The exact mirror of _cascade_empty_parents. On a re-import into a fully
    deleted study, the lean live path (INGESTION_V2 + STAGE1_CREATE_PARENTS)
    links fresh LIVE instances by resolving the existing (tombstoned) series via
    a plain SELECT — it never calls _upsert_* on a HIT, so the _revive_parent
    baked into get-or-create never fires and the reused series/study/patient stay
    soft-deleted. This settle-time pass fixes that regardless of parent-cache
    state: it revives, in order,
      (1) the series   if it has >0 LIVE (deleted_at IS NULL) instances,
      (2) the study    if it has >0 LIVE series,
      (3) the patient  if it has >0 LIVE studies.
    Each step is guarded by `AND <tbl>.deleted_at IS NOT NULL`, so the ordinary
    already-live parent (the overwhelming common case) matches zero rows and pays
    no write — only a genuinely tombstoned parent that now holds live children is
    touched. Ordered UP the tree (series before study before patient) so a study
    is only revived AFTER its series is live, keeping the >0-live-child guard
    truthful at each level. Runs as one transaction inside the caller's
    deadlock-retry wrapper (sibling series of the same study can touch the shared
    study/patient row); commit-or-rollback, never a swallowed mid-txn deadlock.
    Idempotent: a second run revives zero rows. This step and the empty-cascade
    are mutually exclusive by live count (a series is either >0 or 0 live), so
    they cannot both act on the same row in one pass."""
    cur = conn.cursor()
    try:
        # 1: series -> has any live instance? revive it.
        series_revived = cur.execute(
            "UPDATE series se SET se.deleted_at = NULL "
            "WHERE se.series_pkey=%s AND se.deleted_at IS NOT NULL "
            "  AND EXISTS (SELECT 1 FROM instance i "
            "              WHERE i.series_pkey = se.series_pkey "
            "                AND i.deleted_at IS NULL)",
            (series_pkey,))
        # 2: study -> has any live series? revive it.
        study_revived = 0
        if study_pkey is not None:
            study_revived = cur.execute(
                "UPDATE study st SET st.deleted_at = NULL "
                "WHERE st.study_pkey=%s AND st.deleted_at IS NOT NULL "
                "  AND EXISTS (SELECT 1 FROM series s "
                "              WHERE s.study_pkey = st.study_pkey "
                "                AND s.deleted_at IS NULL)",
                (study_pkey,))
        # 3: patient -> has any live study? revive it (resolve patient via study;
        # patient is datastore-scoped so this touches only its own tenant's row).
        patient_revived = 0
        if study_pkey is not None:
            patient_revived = cur.execute(
                "UPDATE patient p "
                "JOIN study s ON s.patient_pkey = p.patient_pkey "
                "SET p.deleted_at = NULL "
                "WHERE s.study_pkey=%s AND p.deleted_at IS NOT NULL "
                "  AND EXISTS (SELECT 1 FROM study st "
                "              WHERE st.patient_pkey = p.patient_pkey "
                "                AND st.deleted_at IS NULL)",
                (study_pkey,))
        if series_revived or study_revived or patient_revived:
            print(f"ingest-v3: revive-cascade series_pkey={series_pkey} "
                  f"study_pkey={study_pkey} series_revived={series_revived} "
                  f"study_revived={study_revived} patient_revived={patient_revived}")
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cur.close()
    conn.commit()


def _cascade_empty_parents(conn, series_pkey, study_pkey):
    """Soft-delete the series/study/patient upward when they empty out.

    Keyed off LIVE (deleted_at IS NULL) counts, using the SAME NOT EXISTS
    convention + OFFLINE-exemption the GC sweep applies, and the SAME
    deleted_at = NOW() timestamp the removal path uses. SOFT-delete only — never
    a hard delete — so a later re-ingest's _revive_parent (which clears
    deleted_at) stays symmetric and the row (and its pkey) survives for revival.

    Each step is guarded so it only marks a parent that (a) is still live and
    (b) has no remaining live child: a series still holding a live instance, a
    study still holding a live series, or a patient still holding a live study is
    left untouched. Runs as one transaction inside the caller's deadlock-retry
    wrapper (sibling series of the same study can touch the shared study/patient
    row); commit-or-rollback, never a swallowed mid-transaction deadlock."""
    cur = conn.cursor()
    try:
        # 1: series -> empty of live instances? (OFFLINE series exempt, matching
        # the GC sweep: a pending/known-but-unavailable series legitimately holds
        # zero live instances and must not be reaped.)
        series_marked = cur.execute(
            "UPDATE series se SET se.deleted_at = NOW() "
            "WHERE se.series_pkey=%s AND se.deleted_at IS NULL "
            "  AND (se.availability IS NULL OR se.availability <> 'OFFLINE') "
            "  AND NOT EXISTS (SELECT 1 FROM instance i "
            "                  WHERE i.series_pkey = se.series_pkey "
            "                    AND i.deleted_at IS NULL)",
            (series_pkey,))
        # 2: study -> all its series soft-deleted?
        study_marked = 0
        if study_pkey is not None:
            study_marked = cur.execute(
                "UPDATE study st SET st.deleted_at = NOW() "
                "WHERE st.study_pkey=%s AND st.deleted_at IS NULL "
                "  AND NOT EXISTS (SELECT 1 FROM series s "
                "                  WHERE s.study_pkey = st.study_pkey "
                "                    AND s.deleted_at IS NULL)",
                (study_pkey,))
        # 3: patient -> all its studies soft-deleted? (resolve the patient from
        # the study; patient is datastore-scoped so this touches only its own
        # tenant's row.)
        patient_marked = 0
        if study_pkey is not None:
            patient_marked = cur.execute(
                "UPDATE patient p "
                "JOIN study s ON s.patient_pkey = p.patient_pkey "
                "SET p.deleted_at = NOW() "
                "WHERE s.study_pkey=%s AND p.deleted_at IS NULL "
                "  AND NOT EXISTS (SELECT 1 FROM study st "
                "                  WHERE st.patient_pkey = p.patient_pkey "
                "                    AND st.deleted_at IS NULL)",
                (study_pkey,))
        if series_marked or study_marked or patient_marked:
            print(f"ingest-v3: delete-cascade series_pkey={series_pkey} "
                  f"study_pkey={study_pkey} series_marked={series_marked} "
                  f"study_marked={study_marked} patient_marked={patient_marked}")
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cur.close()
    conn.commit()


def handler(event, context):
    """SQS batch entry point. Reuses the stage-1 batch processing to write the
    content/instance rows, then runs the eventTime-debounced aggregate per
    touched series."""
    if isinstance(event, dict) and event.get("mode") == "dedupe-sweep":
        # Operator-invoked one-off sweep (direct `aws lambda invoke`, never an
        # SQS record). See dedupe_sweep.py.
        import dedupe_sweep
        return dedupe_sweep.run(event, context)
    if isinstance(event, dict) and event.get("direct"):
        return _handle_direct(event["direct"])
    conn = engine._get_db_conn()
    records = event.get("Records", []) if isinstance(event, dict) else []
    print(f"ingest-v3: handler start, {len(records)} record(s)")
    if not records:
        return {"batchItemFailures": []}

    # Per (datastore, study, series): the max content_pkey and max eventTime we
    # wrote this batch. Populated by _handle_created via the parent cache's
    # touched-series map (reused from stage-1's V2 lean path).
    cache = engine._ParentCache()
    failures = []
    touched = {}  # (ds, study, series) -> [max_content_pkey, max_event_time]

    for rec in records:
        mid = rec.get("messageId")
        try:
            event_time = _event_time_of(rec)
            # Reuse the stage-1 per-message processing (parses S3 event, calls
            # _handle_created which — with STAGE1_CREATE_PARENTS on — creates
            # parents + links inline, and records touched series in the cache).
            engine._DEFER_COMMIT = False
            engine._process_message(conn, rec, {}, cache=cache)
            conn.commit()
            _tmap = getattr(cache, "touched_study_series_v2", {})
            print(f"ingest-v3: msg {mid} processed, event_time={event_time}, "
                  f"touched {len(_tmap)} series this msg")
            # Fold this message's touched series into our map with event_time.
            for tri, cpk in list(_tmap.items()):
                cur = touched.get(tri)
                if cur is None:
                    touched[tri] = [cpk or 0, event_time]
                else:
                    cur[0] = max(cur[0], cpk or 0)
                    if event_time and (cur[1] is None or event_time > cur[1]):
                        cur[1] = event_time
            cache.touched_study_series_v2 = {}
        except Exception as e:
            print(f"ingest-v3: ERROR processing message {mid}: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            # The rollback undid any patient/study/series rows this message
            # inserted, but the shared parent cache still maps their natural
            # keys to those pkeys. Reusing it would make every later message in
            # the batch reference rows that no longer exist (FK 1216). Start a
            # fresh cache; committed messages' touched series are already in
            # `touched`.
            cache = engine._ParentCache()
            failures.append({"itemIdentifier": mid})

    _settle_touched(conn, touched)

    return {"batchItemFailures": failures}


def _utc_event_time():
    """Now, in the DATETIME(6) shape _event_time_of returns."""
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")


def _handle_direct(direct):
    """Synchronous single-object ingest: {"direct": {"bucket", "key"}}.

    Called with RequestResponse by the STOW-RS service (dicomweb-s3) and the
    non-DICOM encapsulator (WSI) so the object is fully indexed (instance rows,
    series/study aggregates, VF assignment) BEFORE they answer. Same per-object
    engine call and settle step as the SQS path, so row identities are identical
    and the object's own S3 ObjectCreated event later re-runs it idempotently.
    The settle step does not debounce: a caller is waiting, and any concurrent
    same-series write re-aggregates under the tracker's content_pkey guard.

    Returns {'ok': True, 'instanceCount', 'datastoreId'} or {'ok': False, 'error'}
    (the contract the callers read)."""
    bucket = (direct or {}).get("bucket") if isinstance(direct, dict) else None
    key = (direct or {}).get("key") if isinstance(direct, dict) else None
    if not bucket or not key:
        return {"ok": False, "error": "direct invoke requires bucket and key"}
    conn = engine._get_db_conn()
    try:
        datastore = engine._resolve_datastore(conn, bucket)
        if datastore is None:
            return {"ok": False, "error": f"bucket {bucket} not registered to any S3 datastore"}
        cache = engine._ParentCache()
        engine._DEFER_COMMIT = False
        result = engine._with_deadlock_retry(
            engine._handle_created, conn, datastore, bucket, key,
            cache=cache, _dl_cache=cache)
        conn.commit()  # instance rows durable before the aggregate phase
        if result.kind == "skipped":
            return {"ok": False, "error": f"object not found: s3://{bucket}/{key}"}
        now = _utc_event_time()
        touched = {tri: [cpk or 0, now]
                   for tri, cpk in getattr(cache, "touched_study_series_v2", {}).items()}
        _settle_touched(conn, touched, debounce=False)
        # The same index event the async path emits, so stats/analytics see a
        # STOW'd object identically.
        try:
            if result.instances:
                engine.index_events.emit_instances_indexed(
                    datastore.id, bucket, key, result.instances)
        except Exception as e:
            print(f"ingest-v3: index event emit skipped (direct): {e}")
        return {"ok": True, "instanceCount": len(result.instances),
                "datastoreId": datastore.id}
    except engine.PermanentIngestError as exc:
        _rollback_quietly(conn)
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        _rollback_quietly(conn)
        print(f"ingest-v3: ERROR direct ingest failed for s3://{bucket}/{key}: {exc}")
        return {"ok": False, "error": str(exc)}


def _rollback_quietly(conn):
    try:
        conn.rollback()
    except Exception:
        pass


def _settle_touched(conn, touched, debounce=True):
    """Post-commit settle for every touched series: tracker watermark, ONE
    debounce, per-series aggregate/cascade/VF-unassign, stats dirty + refresh,
    per-series VF-assign emit, end-of-batch commit. `touched` maps
    (datastore, study_uid, series_uid) -> [max_content_pkey, max_event_time].
    Shared by the SQS handler and the dedupe sweep (dedupe_sweep.py)."""
    # Instance rows are durable. Aggregate phase, debounced ONCE per invocation:
    #   (1) upsert every touched series' tracker watermark,
    #   (2) sleep DEBOUNCE_MS a SINGLE time (let same-series arrivals from other
    #       in-flight invocations land / raise the watermark),
    #   (3) aggregate each touched series (sleep-free): re-read tracker, and only
    #       recompute if our pkey is still the max (else a later owner has it).
    dirty = set()
    for (ds, study_uid, series_uid), (max_pkey, ev) in touched.items():
        try:
            engine._with_deadlock_retry(
                _upsert_tracker, conn, ds, study_uid, series_uid, max_pkey, ev)
        except Exception as e:
            print(f"ingest-v3: tracker upsert failed for {study_uid}/{series_uid}: {e}")
    if debounce and touched and DEBOUNCE_MS > 0:
        time.sleep(DEBOUNCE_MS / 1000.0)   # ONE debounce for the whole batch
    for (ds, study_uid, series_uid), (max_pkey, ev) in touched.items():
        try:
            _aggregate_series(conn, ds, study_uid, series_uid, max_pkey, dirty)
        except Exception as e:
            print(f"ingest-v3: aggregate failed for {study_uid}/{series_uid}: {e}")
            # Aggregate failure does NOT lose data — instances are durable and
            # the tracker row (if left) re-triggers on the next touch. Do not
            # fail the SQS items whose instances already committed.
    if dirty:
        try:
            aggregate._mark_datastores_dirty(conn, dirty)
        except Exception as e:
            print(f"ingest-v3: mark stats dirty skipped: {e}")
        _request_stats_refresh()

    # VF assignment (per-series, OFF the per-instance write path). AFTER the
    # aggregates are recomputed above, emit ONE message per touched series to the
    # VF_ASSIGN_QUEUE so the vf-assign-consumer evaluates the datastore's enabled
    # rules against the settled series/study/patient rows and assigns all of the
    # series' instances. series_pkey resolved with the lock-free MVCC read. No-op
    # when the queue url is unset. A send failure does NOT fail the SQS items
    # (instances are durable; assignment INSERTs are idempotent) — it is logged
    # and the VF-indexer remains the authoritative reconciler.
    if touched and engine._VF_ASSIGN_QUEUE_URL:
        try:
            bodies = []
            for (ds, study_uid, series_uid) in touched.keys():
                series_pkey = engine._select_parent_pkey(
                    conn, 'series_pkey', 'series', 'seriesinstanceuid',
                    ds, series_uid)
                if series_pkey is None:
                    continue
                bodies.append(json.dumps({
                    'datastore_id': ds,
                    'series_pkey': int(series_pkey),
                    'study_uid': study_uid,
                    'series_uid': series_uid,
                }, separators=(',', ':')))
            for i in range(0, len(bodies), 10):
                chunk = bodies[i:i + 10]
                entries = [{'Id': str(n), 'MessageBody': b}
                           for n, b in enumerate(chunk)]
                resp = engine.sqs_client.send_message_batch(
                    QueueUrl=engine._VF_ASSIGN_QUEUE_URL, Entries=entries)
                failed = resp.get('Failed') or []
                if failed:
                    print(f"ingest-v3: VF-assign send failed for "
                          f"{len(failed)}/{len(entries)}: {failed}")
        except Exception as e:
            print(f"ingest-v3: VF-assign emit skipped: {e}")

    # End the read transaction the lookups above opened (autocommit is off and
    # the connection is reused by the warm container). Left open, it holds a
    # shared metadata lock on `series` (and whatever else the batch last read)
    # for as long as the container idles, so an ALTER TABLE from the Searchable
    # Attributes API queues behind it — and every later query on that table
    # queues behind the ALTER, stalling QIDO, ingest and deletes.
    try:
        conn.commit()
    except Exception as e:
        print(f"ingest-v3: end-of-batch commit skipped: {e}")


def _event_time_of(rec):
    """Extract the S3 eventTime (ISO-8601) from an SQS record body as a string
    MySQL DATETIME(6) accepts ('YYYY-MM-DD HH:MM:SS.ffffff'). Best-effort: None
    when the shape has no eventTime (the aggregate then debounces without an
    ordering hint, still correct via the content_pkey guard)."""
    import json
    try:
        body = rec.get("body")
        payload = json.loads(body) if body else {}
        s3recs = payload.get("Records") or []
        if s3recs:
            et = s3recs[0].get("eventTime")  # e.g. 2026-09-18T00:51:54.123Z
            if et:
                return et.replace("T", " ").replace("Z", "").strip()
    except Exception:
        pass
    return None
