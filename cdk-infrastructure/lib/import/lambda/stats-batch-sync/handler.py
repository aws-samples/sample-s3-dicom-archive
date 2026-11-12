"""stats-batch-sync — incremental, batched, per-study datastore_statistics maintenance.

Replaces the former stats-recompute full-datastore recompute (a COUNT/SUM scan of
the ~160M-row instance table per dirty datastore, on a rate(1min) schedule) that
pinned Aurora and, stacking with GcSweep, wedged the writer behind metadata locks.

MODEL (per-study aggregates, model B):
  - study_stats holds ONE row per study: series_count, instance_count,
    total_size_bytes, modalities, synced_last_updated. Overwritten wholesale on
    re-sync — no delta math at the study grain (the row is absolute).
  - stats_sync_cursor holds a resumable (cursor_last_updated, cursor_study_pkey)
    position per datastore.
  - Each Step Function invocation processes ONE datastore's next batch of
    BATCH_SIZE studies past the cursor (index range scan on
    study.idx_study_ds_updated), recomputes only those studies' descendants
    (bounded by study_pkey IN (...)), upserts their study_stats rows, and rolls
    the delta into datastore_statistics IN THE SAME TRANSACTION. It returns
    {remaining: >0|0}; the Step Function loops until remaining == 0 (caught up),
    then advances to the next datastore or ends.

WHY THE DATASTORE ROLLUP DELTA IS SAFE (unlike a naive running total): we have the
study's OLD study_stats row (last thing THIS job wrote) and its NEW absolute value
in the same transaction, so the delta = new - old is authoritative, applied once,
and never drifts. A periodic reconcile (RECONCILE mode) re-derives the datastore
row from SUM(study_stats) to self-heal any drift.

Connection: PyMySQL over the RDS Proxy (DB_HOST = proxy endpoint), same as ingest.
"""

import json
import os
import uuid

import boto3
import pymysql

# Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
# (rds-global-bundle.pem, shipped beside this file) instead of the old
# check_hostname-only config that supplied NO CA and therefore skipped cert
# verification entirely. PyMySQL verifies the chain once 'ca' is set; hostname
# verification is ENFORCED (check_hostname=True, verify-full): the bundle also
# trusts public roots, so skipping it would accept ANY public cert for the DB.
# DB_SSL_CA_PATH overrides the bundle location.
_RDS_CA = os.environ.get(
    "DB_SSL_CA_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-global-bundle.pem"),
)


def _env_int(name, default):
    try:
        return int(os.environ.get(name, '') or default)
    except ValueError:
        return default


# Studies processed per invocation. Bounds the per-study descendant recompute so
# no single query scans more than BATCH_SIZE studies' instances.
BATCH_SIZE = _env_int('STATS_BATCH_SIZE', 100)

# Advisory-lock name serializing the whole stats-sync walk. A MySQL named lock
# (GET_LOCK) is server-wide and table-independent: it locks NOTHING in any table,
# so dashboard/QIDO readers never see it — only another stats-sync invocation
# that also calls GET_LOCK contends on it. It auto-releases when the holding
# connection drops, so a crashed lambda leaves no stuck lock (unlike a DB flag).
STATS_LOCK_NAME = os.environ.get('STATS_LOCK_NAME', 'stats_sync_walk')
# Seconds to wait for the lock before standing down. 0 = try-once, don't block.
STATS_LOCK_WAIT = _env_int('STATS_LOCK_WAIT', 0)


def _acquire_lock(conn):
    """Try to take the server-wide advisory lock. Returns True if acquired, False
    if another stats-sync invocation holds it (this run should stand down)."""
    cur = conn.cursor()
    try:
        cur.execute("SELECT GET_LOCK(%s, %s)", (STATS_LOCK_NAME, STATS_LOCK_WAIT))
        row = cur.fetchone()
        # GET_LOCK returns 1 (got it), 0 (timeout — someone else holds it), or
        # NULL (error). Treat anything but 1 as "did not acquire".
        return bool(row and row[0] == 1)
    finally:
        cur.close()


def _release_lock(conn):
    cur = conn.cursor()
    try:
        cur.execute("SELECT RELEASE_LOCK(%s)", (STATS_LOCK_NAME,))
        cur.fetchall()
    except Exception:
        pass  # auto-releases on connection drop anyway
    finally:
        cur.close()

_conn = None


def _connect_db():
    sm = boto3.client('secretsmanager')
    sec = json.loads(sm.get_secret_value(SecretId=os.environ['DB_SECRET_ARN'])['SecretString'])
    return pymysql.connect(
        host=os.environ.get('DB_HOST') or sec['host'],
        user=sec['username'], password=sec['password'],
        database=os.environ.get('DB_NAME') or sec.get('dbname'),
        port=_env_int('DB_PORT', int(sec.get('port', 3306))),
        charset='utf8mb4',
        # autocommit OFF: each batch is one explicit transaction (upsert the
        # study rows + roll the datastore delta), committed atomically so a
        # crash mid-batch never leaves the datastore total inconsistent with the
        # study rows or the cursor.
        autocommit=False,
        connect_timeout=10,
        # A bounded batch (BATCH_SIZE studies) is fast; generous read/write
        # timeouts guard a legitimately slow batch without abandoning it (an
        # abandoned-but-still-running server-side query is the anti-pattern that
        # caused this incident).
        read_timeout=100,
        write_timeout=100,
        ssl={"ca": _RDS_CA, "check_hostname": True},
    )


def _get_db_conn():
    global _conn
    if _conn is not None:
        try:
            _conn.ping(reconnect=True)
            return _conn
        except Exception:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
    _conn = _connect_db()
    return _conn


_SCHEMA_READY = False


def _ensure_schema(conn):
    """Self-heal study_stats + stats_sync_cursor on an already-deployed DB (fresh
    installs get them from schema-s3-index.sql). Once per warm container."""
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    cur = conn.cursor()
    try:
        cur.execute(
            """CREATE TABLE IF NOT EXISTS study_stats (
                 study_pkey          BIGINT UNSIGNED NOT NULL,
                 datastore_id        VARCHAR(36) NOT NULL,
                 series_count        INT UNSIGNED NOT NULL DEFAULT 0,
                 instance_count      INT UNSIGNED NOT NULL DEFAULT 0,
                 total_size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
                 modalities          VARCHAR(128) NULL,
                 modality_series_counts JSON NULL,
                 synced_last_updated TIMESTAMP NOT NULL,
                 computed_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
                 PRIMARY KEY (study_pkey),
                 KEY idx_study_stats_ds (datastore_id)
               ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
        cur.execute(
            """CREATE TABLE IF NOT EXISTS stats_sync_cursor (
                 datastore_id        VARCHAR(36) NOT NULL,
                 cursor_last_updated TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:01',
                 cursor_study_pkey   BIGINT UNSIGNED NOT NULL DEFAULT 0,
                 resync_pending      BOOLEAN NOT NULL DEFAULT TRUE,
                 updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP,
                 PRIMARY KEY (datastore_id)
               ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""")
        conn.commit()
        _SCHEMA_READY = True
    except Exception as e:
        print(f"stats-batch-sync: ensure schema skipped: {e}")
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        cur.close()


_MSC_COL = None


def _has_modality_series_counts(conn):
    """True if study_stats has the modality_series_counts column. This project
    rebuilds the DB from scratch (db-init, not migrations), so the column only
    exists after a from-scratch redeploy. Cached per warm container; on any
    detection error assume absent (use the safe live-COUNT fallback)."""
    global _MSC_COL
    if _MSC_COL is not None:
        return _MSC_COL
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE table_schema=DATABASE() AND table_name='study_stats'
                  AND column_name='modality_series_counts'""")
        row = cur.fetchone()
        _MSC_COL = bool(row and row[0])
    except Exception as e:
        print(f"stats-batch-sync: column check failed, assuming absent: {e}")
        _MSC_COL = False
    finally:
        cur.close()
    return _MSC_COL


def _active_datastores(conn):
    """All datastores we should keep in sync — every datastore with a study row
    OR an existing cursor. Ordered so the walk is deterministic."""
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT DISTINCT datastore_id FROM (
                 SELECT datastore_id FROM stats_sync_cursor
                 UNION
                 SELECT DISTINCT datastore_id FROM study WHERE deleted_at IS NULL
               ) d ORDER BY datastore_id""")
        return [r[0] for r in cur.fetchall()]
    finally:
        cur.close()


def _get_cursor(conn, datastore_id):
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT cursor_last_updated, cursor_study_pkey FROM stats_sync_cursor "
            "WHERE datastore_id=%s", (datastore_id,))
        row = cur.fetchone()
        if row:
            return row[0], int(row[1])
        # First run for this datastore — seed the cursor at epoch.
        cur.execute(
            "INSERT INTO stats_sync_cursor (datastore_id) VALUES (%s) "
            "ON DUPLICATE KEY UPDATE datastore_id=datastore_id", (datastore_id,))
        conn.commit()
        return '1970-01-01 00:00:01', 0
    finally:
        cur.close()


def _next_batch_studies(conn, datastore_id, wm_time, wm_pkey):
    """The next BATCH_SIZE studies past the cursor, in (last_updated, study_pkey)
    order — a clean index range scan on idx_study_ds_updated. Deleted studies are
    INCLUDED so their study_stats row gets zeroed/removed as they pass the cursor."""
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT study_pkey, last_updated, deleted_at
                 FROM study
                WHERE datastore_id=%s
                  AND (last_updated > %s
                       OR (last_updated = %s AND study_pkey > %s))
                ORDER BY last_updated, study_pkey
                LIMIT %s""",
            (datastore_id, wm_time, wm_time, wm_pkey, BATCH_SIZE))
        return cur.fetchall()
    finally:
        cur.close()


def _recompute_study(cur, study_pkey):
    """Absolute per-study aggregates over its LIVE descendants, bounded to this one
    study. `instance` has NO study_pkey column — it links to a study only via
    series (instance.series_pkey -> series.series_pkey -> series.study_pkey), so
    the instance count and size SUM join through series (idx_instance_series /
    idx_series_study), never a datastore-wide scan. A live instance under a
    soft-deleted series is excluded (se.deleted_at IS NULL)."""
    cur.execute(
        """SELECT
             (SELECT COUNT(*) FROM series
               WHERE study_pkey=%s AND deleted_at IS NULL),
             (SELECT COUNT(*)
                FROM instance i
                JOIN series se ON se.series_pkey = i.series_pkey
               WHERE se.study_pkey=%s AND se.deleted_at IS NULL
                 AND i.deleted_at IS NULL),
             (SELECT COALESCE(SUM(si.size_bytes), 0)
                FROM instance i
                JOIN series se ON se.series_pkey = i.series_pkey
                JOIN storage_index si ON si.content_pkey = i.content_pkey
               WHERE se.study_pkey=%s AND se.deleted_at IS NULL
                 AND i.deleted_at IS NULL AND si.deleted_at IS NULL)""",
        (study_pkey, study_pkey, study_pkey))
    series_count, instance_count, total_size = cur.fetchone()
    cur.execute(
        """SELECT modality, COUNT(*)
             FROM series
            WHERE study_pkey=%s AND deleted_at IS NULL
              AND modality IS NOT NULL AND modality <> ''
            GROUP BY modality""",
        (study_pkey,))
    rows = cur.fetchall()
    # Per-study {MODALITY: series_count} — values sum to this study's non-blank
    # series count. Blank/NULL modality series are excluded (per product decision),
    # so SUM over all studies == datastore breakdown total (<= series_count by the
    # blank-modality count). Kept as JSON so the datastore reconcile sums the same
    # source as series_count instead of a separate live COUNT.
    modality_series_counts = {str(m): int(c) for (m, c) in rows}
    # Legacy DISTINCT-set string, kept for backward compatibility.
    modalities = '\\'.join(sorted(modality_series_counts.keys())) or None
    return {
        'series_count': int(series_count or 0),
        'instance_count': int(instance_count or 0),
        'total_size_bytes': int(total_size or 0),
        'modalities': modalities,
        'modality_series_counts': modality_series_counts,
    }


def _ensure_latest_row(cur, datastore_id):
    """Return the id of the single latest datastore_statistics row, creating it if
    absent and self-healing duplicate latest rows (keep newest, demote the rest)."""
    cur.execute(
        "SELECT id FROM datastore_statistics "
        "WHERE datastore_id=%s AND latest=TRUE ORDER BY last_updated DESC, id",
        (datastore_id,))
    rows = cur.fetchall()
    if not rows:
        new_id = str(uuid.uuid4())
        cur.execute(
            """INSERT INTO datastore_statistics
                 (id, datastore_id, study_count, series_count, instance_count,
                  total_size_bytes, modality_breakdown, latest)
               VALUES (%s,%s,0,0,0,0,'{"series":{}}',TRUE)""",
            (new_id, datastore_id))
        return new_id
    if len(rows) > 1:
        keep = rows[0][0]
        cur.execute(
            "UPDATE datastore_statistics SET latest=FALSE "
            "WHERE datastore_id=%s AND latest=TRUE AND id<>%s",
            (datastore_id, keep))
        return keep
    return rows[0][0]


def _process_batch(conn, datastore_id):
    """Process one batch of studies for a datastore. Returns the number of studies
    processed this batch (0 == caught up)."""
    wm_time, wm_pkey = _get_cursor(conn, datastore_id)
    studies = _next_batch_studies(conn, datastore_id, wm_time, wm_pkey)
    if not studies:
        return 0

    cur = conn.cursor()
    try:
        # Accumulate datastore-level deltas across the batch, applied once at the end.
        d_study = 0        # net new/removed studies
        d_series = 0
        d_instance = 0
        d_size = 0

        last_time = wm_time
        last_pkey = wm_pkey

        for study_pkey, last_updated, deleted_at in studies:
            study_pkey = int(study_pkey)
            # Old absolute values for this study (0/absent on first sight).
            cur.execute(
                "SELECT series_count, instance_count, total_size_bytes "
                "FROM study_stats WHERE study_pkey=%s", (study_pkey,))
            old = cur.fetchone()
            old_present = old is not None
            old_series = int(old[0]) if old else 0
            old_instance = int(old[1]) if old else 0
            old_size = int(old[2]) if old else 0

            if deleted_at is not None:
                # Study is (soft-)deleted: remove its stats row, subtract its old
                # contribution. If it had no row, nothing to do.
                if old_present:
                    cur.execute("DELETE FROM study_stats WHERE study_pkey=%s", (study_pkey,))
                    d_study -= 1
                    d_series -= old_series
                    d_instance -= old_instance
                    d_size -= old_size
            else:
                agg = _recompute_study(cur, study_pkey)
                if _has_modality_series_counts(conn):
                    cur.execute(
                        """INSERT INTO study_stats
                             (study_pkey, datastore_id, series_count, instance_count,
                              total_size_bytes, modalities, modality_series_counts,
                              synced_last_updated)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                           ON DUPLICATE KEY UPDATE
                             series_count=VALUES(series_count),
                             instance_count=VALUES(instance_count),
                             total_size_bytes=VALUES(total_size_bytes),
                             modalities=VALUES(modalities),
                             modality_series_counts=VALUES(modality_series_counts),
                             synced_last_updated=VALUES(synced_last_updated)""",
                        (study_pkey, datastore_id, agg['series_count'], agg['instance_count'],
                         agg['total_size_bytes'], agg['modalities'],
                         json.dumps(agg['modality_series_counts']), last_updated))
                else:
                    # Pre-rebuild DB without the modality_series_counts column:
                    # maintain the other aggregates; the breakdown falls back to
                    # the live COUNT(series) path in _reconcile.
                    cur.execute(
                        """INSERT INTO study_stats
                             (study_pkey, datastore_id, series_count, instance_count,
                              total_size_bytes, modalities, synced_last_updated)
                           VALUES (%s,%s,%s,%s,%s,%s,%s)
                           ON DUPLICATE KEY UPDATE
                             series_count=VALUES(series_count),
                             instance_count=VALUES(instance_count),
                             total_size_bytes=VALUES(total_size_bytes),
                             modalities=VALUES(modalities),
                             synced_last_updated=VALUES(synced_last_updated)""",
                        (study_pkey, datastore_id, agg['series_count'], agg['instance_count'],
                         agg['total_size_bytes'], agg['modalities'], last_updated))
                if not old_present:
                    d_study += 1
                d_series += agg['series_count'] - old_series
                d_instance += agg['instance_count'] - old_instance
                d_size += agg['total_size_bytes'] - old_size

            last_time = last_updated
            last_pkey = study_pkey

        # Roll the accumulated delta into the datastore's latest row (one row),
        # and rebuild the modality breakdown from study_stats for this datastore
        # (cheap: study-count rows, indexed). GREATEST(0, ...) guards against a
        # transient negative from an out-of-order first sight; RECONCILE mode is
        # the authoritative self-heal.
        ds_row_id = _ensure_latest_row(cur, datastore_id)
        cur.execute(
            """UPDATE datastore_statistics
                  SET study_count    = GREATEST(0, CAST(study_count AS SIGNED) + %s),
                      series_count   = GREATEST(0, CAST(series_count AS SIGNED) + %s),
                      instance_count = GREATEST(0, CAST(instance_count AS SIGNED) + %s),
                      total_size_bytes = GREATEST(0, CAST(total_size_bytes AS SIGNED) + %s),
                      last_updated = NOW()
                WHERE id=%s""",
            (d_study, d_series, d_instance, d_size, ds_row_id))

        # Advance the cursor to the last study processed this batch.
        cur.execute(
            """UPDATE stats_sync_cursor
                  SET cursor_last_updated=%s, cursor_study_pkey=%s,
                      resync_pending = %s
                WHERE datastore_id=%s""",
            (last_time, last_pkey, len(studies) >= BATCH_SIZE, datastore_id))

        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cur.close()

    n = len(studies)
    print(f"stats-batch-sync {datastore_id}: processed {n} studies "
          f"(dStudy={d_study} dSeries={d_series} dInst={d_instance} dSize={d_size})")
    return n


def _reconcile(conn, datastore_id):
    """Authoritative self-heal: re-derive the datastore's latest row from
    SUM(study_stats) (study-count rows, indexed — NOT an instance scan). Corrects
    any drift the incremental deltas accumulated. Cheap enough to run periodically."""
    cur = conn.cursor()
    try:
        cur.execute(
            """SELECT COUNT(*), COALESCE(SUM(series_count),0),
                      COALESCE(SUM(instance_count),0), COALESCE(SUM(total_size_bytes),0)
                 FROM study_stats WHERE datastore_id=%s""",
            (datastore_id,))
        study_count, series_count, instance_count, total_size = cur.fetchone()
        # Rebuild the modality breakdown the dashboard pie reads
        # (modality_breakdown JSON = {"series": {MODALITY: series_count, ...}}).
        # PREFERRED source: SUM the per-study modality_series_counts JSON maps in
        # study_stats — the SAME table series_count is summed from — so the
        # breakdown total always equals SUM(series_count) minus blank-modality
        # series (blanks excluded per product decision), even mid-backfill.
        # study_stats is one row per study (indexed by datastore): study-count
        # rows, never an instance scan; small maps summed in Python (MySQL
        # JSON_TABLE cannot bind object keys), streamed via an unbuffered cursor
        # so a huge datastore never buffers the whole result set.
        #
        # FALLBACK: the modality_series_counts column only exists after the DB is
        # rebuilt from scratch (this project does db-init, not migrations). Until
        # then we fall back to the live COUNT(series) GROUP BY modality (index-only
        # on idx_series_ds_modality), which is correct but can transiently disagree
        # with series_count during an active backfill. The switch is automatic.
        series_by_modality = {}
        if _has_modality_series_counts(conn):
            sscur = conn.cursor(pymysql.cursors.SSCursor)
            try:
                sscur.execute(
                    """SELECT modality_series_counts
                         FROM study_stats
                        WHERE datastore_id=%s AND modality_series_counts IS NOT NULL""",
                    (datastore_id,))
                for (msc,) in sscur:
                    if not msc:
                        continue
                    try:
                        m = msc if isinstance(msc, dict) else json.loads(msc)
                    except (ValueError, TypeError):
                        continue
                    for mod, cnt in m.items():
                        if not mod:
                            continue
                        series_by_modality[mod] = series_by_modality.get(mod, 0) + int(cnt or 0)
            finally:
                sscur.close()
        else:
            cur.execute(
                """SELECT modality, COUNT(*)
                     FROM series
                    WHERE datastore_id=%s AND deleted_at IS NULL
                      AND modality IS NOT NULL AND modality <> ''
                    GROUP BY modality""",
                (datastore_id,))
            series_by_modality = {str(m): int(c) for (m, c) in cur.fetchall()}
        modality_breakdown = json.dumps({'series': series_by_modality})
        ds_row_id = _ensure_latest_row(cur, datastore_id)
        cur.execute(
            """UPDATE datastore_statistics
                  SET study_count=%s, series_count=%s, instance_count=%s,
                      total_size_bytes=%s, modality_breakdown=%s, last_updated=NOW()
                WHERE id=%s""",
            (int(study_count or 0), int(series_count or 0), int(instance_count or 0),
             int(total_size or 0), modality_breakdown, ds_row_id))
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cur.close()
    print(f"stats-batch-sync reconcile {datastore_id}: {study_count} studies, "
          f"{series_count} series, {instance_count} instances, {total_size} bytes, "
          f"{len(series_by_modality)} modalities")


def handler(event, context):
    """Step Function task. Event shapes:

      {}                                  -> pick the first active datastore, seed
                                             {datastore_id, remaining} for the loop.
      {"datastore_id": "..."}             -> process ONE batch for that datastore,
                                             return {datastore_id, remaining, done}.
      {"mode": "reconcile",
       "datastore_id": "..."}             -> SUM-reconcile that datastore.
      {"mode": "list"}                    -> {datastores: [...]} for a Map fan-out.

    The Step Function drives the loop (Choice on remaining>0) and iterates
    datastores; this lambda stays a single bounded unit of work.
    """
    conn = _get_db_conn()
    _ensure_schema(conn)

    mode = (event or {}).get('mode')

    if mode == 'list':
        return {'datastores': _active_datastores(conn)}

    # Everything below walks/writes the shared cursor + rollup, so serialize it
    # under the advisory lock. If another stats-sync execution holds it, stand
    # down WITHOUT advancing anything and signal the SFN to retry (its Retry on
    # States.TaskFailed backs off), so overlap can never interleave two walkers.
    if not _acquire_lock(conn):
        print("stats-batch-sync: another run holds the lock — standing down")
        raise RuntimeError('stats_sync_lock_unavailable')
    try:
        if mode == 'reconcile':
            ds = event.get('datastore_id')
            targets_ = [ds] if ds else _active_datastores(conn)
            for d in targets_:
                _reconcile(conn, d)
            return {'reconciled': len(targets_)}

        datastore_id = (event or {}).get('datastore_id')
        if not datastore_id:
            actives = _active_datastores(conn)
            if not actives:
                return {'datastore_id': None, 'remaining': 0, 'done': True}
            datastore_id = actives[0]

        processed = _process_batch(conn, datastore_id)
        # remaining>0 means the batch was full — more studies past the new cursor.
        remaining = processed if processed >= BATCH_SIZE else 0
        return {
            'datastore_id': datastore_id,
            'processed': processed,
            'remaining': remaining,
            'done': remaining == 0,
        }
    finally:
        _release_lock(conn)
