"""Series / study aggregate recompute and stats-dirty marking for the ingest Lambda.

Extracted from the retired ingest-v2-stage2 Lambda (its two-stage pipeline, SQS
handler, series locks and own DB connector are gone). What remains is the part the
live ingest path (handler.py) calls after a batch has been written:

  _recompute_series / _recompute_study   rebuild the NumberOf*Related* aggregates,
                                         ModalitiesInStudy and availability
  _load_one_metadata / _dcm              read one instance's DICOM-JSON metadata
  _mark_datastores_dirty                 flag datastores for the stats batch sync
"""


import json

import gzip

import uuid

def _dcm(md, tag):
    """Read a DICOM-JSON element's first Value from the decompressed metadata
    dict. Returns None when absent/empty."""
    el = md.get(tag)
    if not el:
        return None
    v = el.get('Value')
    if not v:
        return None
    x = v[0]
    if isinstance(x, dict):  # PersonName -> {"Alphabetic": "..."}
        return x.get('Alphabetic') or None
    return x

def _load_one_metadata(conn, datastore_id, series_uid):
    """Return (content_pkey, decompressed DICOM-JSON dict) for the LATEST instance
    (MAX content_pkey) of this series -- the deterministic tiebreaker -- so the
    parent rows are populated from a single, stable instance's header. None if no
    live instance exists yet."""
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT x.content_pkey, im.metadata
               FROM storage_index x
               JOIN Instancemetadata im ON im.content_pkey = x.content_pkey
               WHERE x.datastore_id=%s AND x.series_instance_uid=%s
                 AND x.deleted_at IS NULL
               ORDER BY x.content_pkey DESC LIMIT 1""",
            (datastore_id, series_uid))
        row = cur.fetchone()
    finally:
        cur.close()
    if not row:
        return None
    cpk, blob = row
    try:
        md = json.loads(gzip.decompress(blob).decode())
    except Exception as e:
        print(f"stage-2: metadata decompress failed for content_pkey={cpk}: {e}")
        return None
    return cpk, md

def _recompute_series(conn, series_pkey):
    """series.numberofseriesrelatedinstances = COUNT(live instances). Single
    writer per series (FIFO group), so contention-free; own transaction. Also
    bumps series.last_updated here (moved out of stage-1, which under V2 does no
    contended parent write) -- tolerant of an un-migrated DB with no such column."""
    cur = conn.cursor()
    try:
        cur.execute(
            """UPDATE series se
               LEFT JOIN (
                   SELECT series_pkey, COUNT(*) c FROM instance
                   WHERE deleted_at IS NULL AND series_pkey=%s
                   GROUP BY series_pkey
               ) x ON x.series_pkey = se.series_pkey
               SET se.numberofseriesrelatedinstances = COALESCE(x.c, 0)
               WHERE se.series_pkey=%s""",
            (series_pkey, series_pkey))
        try:
            cur.execute("UPDATE series SET last_updated = NOW() WHERE series_pkey=%s",
                        (series_pkey,))
        except Exception as e:
            print(f"stage-2: series.last_updated bump skipped: {e}")
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            cur.close()
        except Exception:
            pass
        raise
    finally:
        try:
            cur.close()
        except Exception:
            pass
    conn.commit()

_STATS_DIRTY_SCHEMA_READY = False

def _ensure_stats_dirty_column(conn):
    """Idempotently add datastore_statistics.stats_dirty to an already-deployed
    DB. schema.sql carries the column for fresh installs, but CREATE TABLE IF NOT
    EXISTS is a no-op on the existing table, so an in-place deployment (dicoms3v2)
    never gets it from schema-init -- self-heal it here on first use. Runs once
    per warm container (module-flag guarded). MySQL 8 has no ADD COLUMN IF NOT
    EXISTS, so check information_schema first."""
    global _STATS_DIRTY_SCHEMA_READY
    if _STATS_DIRTY_SCHEMA_READY:
        return
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE()
                 AND TABLE_NAME = 'datastore_statistics'
                 AND COLUMN_NAME = 'stats_dirty'""")
        exists = cur.fetchone()[0]
        if not exists:
            print("stage-2: adding datastore_statistics.stats_dirty (self-heal)")
            cur.execute(
                "ALTER TABLE datastore_statistics "
                "ADD COLUMN stats_dirty BOOLEAN DEFAULT FALSE, "
                "ADD INDEX idx_stats_dirty (stats_dirty, latest)")
            conn.commit()
        _STATS_DIRTY_SCHEMA_READY = True
    except Exception as e:
        # Never fail a recompute over the flag -- a concurrent container may be
        # mid-ALTER, or the index may already exist. Log and carry on; the mark
        # step below tolerates the column being absent.
        print(f"stage-2: ensure stats_dirty column skipped: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        cur.close()

def _mark_datastores_dirty(conn, datastore_ids):
    """Flag each touched datastore's latest stats row dirty so the scheduled
    stats-recompute lambda picks it up. UPDATE-ONLY on the latest=TRUE row.

    Historically this did `UPDATE ...; if rowcount==0: INSERT a zeroed latest
    row`. That `if rowcount==0` guard is NOT concurrency-safe: under a high-rate
    ingest flood many invocations race, the UPDATE transiently matches 0 rows
    (or two invocations both see "no latest"), and each INSERTs a fresh
    latest=TRUE zeroed row WITHOUT demoting the others. There is no DB uniqueness
    on (datastore_id, latest), so these accumulate into hundreds of duplicate
    latest=TRUE zero-count rows -> the dashboard reads one of the zero rows and
    shows 0 bytes / 0 series, and stats-recompute cannot collapse them faster
    than the flood creates them.

    Fix: NEVER insert a fresh latest row from the hot ingest path. Just UPDATE
    the existing latest row dirty. The genuine "no stats row exists yet" case is
    seeded ONCE, race-safe, via an INSERT ... SELECT ... WHERE NOT EXISTS so a
    second concurrent invocation cannot create a duplicate. Own transaction,
    committed here; best-effort -- a failure never fails the series recompute
    that already succeeded and committed."""
    if not datastore_ids:
        return
    _ensure_stats_dirty_column(conn)
    cur = conn.cursor()
    try:
        for ds_id in datastore_ids:
            cur.execute(
                "UPDATE datastore_statistics SET stats_dirty = TRUE "
                "WHERE datastore_id = %s AND latest = TRUE",
                (ds_id,))
            if cur.rowcount == 0:
                # No latest row yet: seed exactly one, race-safe. The WHERE NOT
                # EXISTS makes a concurrent second invocation a no-op instead of
                # inserting a duplicate latest=TRUE row. dirty=TRUE so recompute
                # fills the real numbers on its next pass.
                cur.execute(
                    """INSERT INTO datastore_statistics
                         (id, datastore_id, study_count, series_count, instance_count,
                          total_size_bytes, modality_breakdown,
                          latest, stats_dirty)
                       SELECT %s, %s, 0, 0, 0, 0, '{"series":{}}', TRUE, TRUE
                       FROM DUAL
                       WHERE NOT EXISTS (
                         SELECT 1 FROM datastore_statistics
                         WHERE datastore_id = %s AND latest = TRUE
                       )""",
                    (str(uuid.uuid4()), ds_id, ds_id))
        conn.commit()
    except Exception as e:
        print(f"stage-2: mark stats dirty skipped ({e})")
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        cur.close()

def _recompute_study(conn, study_pkey):
    """Recompute the study-level aggregates. Wrapped by _with_deadlock_retry
    because sibling series of the same study (different FIFO groups) can touch
    this same study row concurrently. Own transaction -- commit or full
    rollback, never a swallowed mid-transaction 1213."""
    try:
        cur = conn.cursor()
        try:
            cur.execute(
                """UPDATE study st
                   LEFT JOIN (
                       SELECT study_pkey, COUNT(*) c FROM series
                       WHERE deleted_at IS NULL AND study_pkey=%s
                       GROUP BY study_pkey
                   ) x ON x.study_pkey = st.study_pkey
                   SET st.numberofstudyrelatedseries = COALESCE(x.c, 0)
                   WHERE st.study_pkey=%s""",
                (study_pkey, study_pkey))
            cur.execute(
                """UPDATE study st
                   LEFT JOIN (
                       SELECT se.study_pkey, COUNT(*) c
                       FROM instance i JOIN series se ON se.series_pkey = i.series_pkey
                       WHERE i.deleted_at IS NULL AND se.deleted_at IS NULL
                         AND se.study_pkey=%s
                       GROUP BY se.study_pkey
                   ) x ON x.study_pkey = st.study_pkey
                   SET st.numberofstudyrelatedinstances = COALESCE(x.c, 0)
                   WHERE st.study_pkey=%s""",
                (study_pkey, study_pkey))
            cur.execute(
                """UPDATE study st
                   LEFT JOIN (
                       SELECT study_pkey,
                              GROUP_CONCAT(DISTINCT modality ORDER BY modality
                                           SEPARATOR '\\\\') m
                       FROM series
                       WHERE deleted_at IS NULL AND modality IS NOT NULL
                         AND modality <> '' AND study_pkey=%s
                       GROUP BY study_pkey
                   ) x ON x.study_pkey = st.study_pkey
                   SET st.modalitiesinstudy = x.m
                   WHERE st.study_pkey=%s""",
                (study_pkey, study_pkey))
            # last_updated bump for study + its patient (moved out of stage-1).
            try:
                cur.execute("UPDATE study SET last_updated = NOW() WHERE study_pkey=%s",
                            (study_pkey,))
                cur.execute(
                    """UPDATE patient p
                       JOIN study s ON s.patient_pkey = p.patient_pkey
                       SET p.last_updated = NOW()
                       WHERE s.study_pkey=%s""",
                    (study_pkey,))
            except Exception as e:
                print(f"stage-2: study/patient.last_updated bump skipped: {e}")
        finally:
            cur.close()
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
