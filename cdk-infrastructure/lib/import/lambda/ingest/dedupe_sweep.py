"""One-off sweep: retire duplicate LIVE instance rows that share one content_pkey.

Before the overwrite fix, re-uploading a key with new UIDs reused the key's
storage_index row (content_pkey) but wrote a new instance row and left the old
one live, so one physical object could back several live instances (e.g.
content_pkey 578 on the burner). New overwrites are handled at ingest by
engine._retire_superseded_instances; this sweep applies the SAME retire
logic to rows left behind earlier.

Invoke (direct, never via SQS) on the deployed ingest function:

    {"mode": "dedupe-sweep"}                         dry run, all datastores
    {"mode": "dedupe-sweep", "apply": true, ...}     retire

Optional fields:
    datastoreId          limit to one datastore
    afterContentPkey     resume cursor (default 0); pass back nextAfterContentPkey
    windowSize           content_pkey range scanned per discovery query (20000)
    maxGroups            duplicate content_pkeys handled per invocation (200)
    lockWaitSeconds      innodb_lock_wait_timeout for this session (5)
    s3Check              read the object's current SOP UID from S3 (true)
    maxReportRows        detail rows returned (500)

SURVIVOR RULE (per content_pkey, first rule that decides wins):
  1. s3:  read the object's header (member range for a tar slot) and keep the
          live row whose SOPInstanceUID matches. If the object is gone
          (object_missing) or holds a SOP no live row has (s3_uid_not_indexed),
          the group is SKIPPED, never guessed: the removal path / a re-ingest
          owns those.
  2. storage_index_uid: if S3 cannot be read, keep the row matching
          storage_index.sop_instance_uid (the UIDs the last ingest of that slot
          recorded).
  3. newest: else keep the row with the greatest (last_updated, instance_pkey).
Groups containing a WSI instance are skipped (pyramid levels legitimately share
one content_pkey), as are groups whose storage_index row is soft-deleted.

APPLY, per content_pkey, in its own transaction: re-read the live rows with
FOR UPDATE (bounded by lockWaitSeconds), re-decide, and if still >1 live call
_retire_superseded_instances (soft-delete the stale rows, purge the object's VF
membership, register their series/studies). Then one settle pass over every
touched series (handler._settle_touched): recompute series/study counts,
empty-parent cascade, VF-unassign, stats refresh, and a per-series VF-assign
message so folder rules are re-evaluated (the survivor's series is included,
since the purge also removed its membership). A lock-wait timeout or deadlock
skips that group (reported under errors); re-running picks it up.
Idempotent: a group already down to one live row is not rediscovered.
"""

import time
from io import BytesIO

import engine

WSI_SOP_CLASS_UID = engine.WSI_SOP_CLASS_UID
_HEADER_PROBE_BYTES = 262144
_TIME_RESERVE_MS = 60000


def _int_arg(event, name, default, lo, hi):
    try:
        v = int(event.get(name, default))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def _exec_all(conn, sql, params=()):
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return list(cur.fetchall())
    finally:
        cur.close()


_LOAD_SQL = """
    SELECT i.instance_pkey, i.instanceid, i.sopinstanceuid, i.sopclassuid,
           i.last_updated, se.seriesinstanceuid, st.studyinstanceuid,
           si.s3_bucket_name, si.s3_key, si.member_offset, si.member_length,
           si.sop_instance_uid, si.deleted_at
    FROM instance i
    JOIN storage_index si ON si.content_pkey = i.content_pkey
    LEFT JOIN series se ON se.series_pkey = i.series_pkey
    LEFT JOIN study st ON st.study_pkey = se.study_pkey
    WHERE i.datastore_id = %s AND i.content_pkey = %s AND i.deleted_at IS NULL
    ORDER BY i.instance_pkey
"""


def _load_group(conn, datastore_id, content_pkey, for_update=False):
    rows = _exec_all(conn, _LOAD_SQL + (" FOR UPDATE" if for_update else ""),
                     (datastore_id, content_pkey))
    return [{
        'instance_pkey': r[0], 'instanceid': r[1], 'sopUID': r[2] or '',
        'sopClassUID': r[3] or '', 'last_updated': r[4],
        'seriesUID': r[5] or '', 'studyUID': r[6] or '',
        'bucket': r[7], 'key': r[8], 'member_offset': r[9],
        'member_length': r[10], 'si_sop': r[11] or '', 'si_deleted_at': r[12],
    } for r in rows]


def _discover(conn, lo, hi, datastore_id):
    sql = ("SELECT i.datastore_id, i.content_pkey, COUNT(*) FROM instance i "
           "WHERE i.content_pkey > %s AND i.content_pkey <= %s "
           "  AND i.deleted_at IS NULL")
    params = [lo, hi]
    if datastore_id:
        sql += " AND i.datastore_id = %s"
        params.append(datastore_id)
    sql += (" GROUP BY i.datastore_id, i.content_pkey HAVING COUNT(*) > 1"
            " ORDER BY i.content_pkey")
    return [(r[0], int(r[1]), int(r[2])) for r in _exec_all(conn, sql, params)]


def _is_missing(exc):
    if type(exc).__name__ in ('NoSuchKey', 'NoSuchBucket'):
        return True
    code = (getattr(exc, 'response', None) or {}).get('Error', {}).get('Code')
    return code in ('NoSuchKey', 'NoSuchBucket', '404', 'NotFound')


def _read_s3_sop(bucket, key, member_offset, member_length):
    """('ok', sop) | ('missing', None) | ('error', reason)."""
    import pydicom
    start = int(member_offset or 0)
    length = _HEADER_PROBE_BYTES
    if member_length:
        length = min(length, int(member_length))
    try:
        resp = engine.s3_client.get_object(
            Bucket=bucket, Key=key, Range=f"bytes={start}-{start + length - 1}")
        data = resp['Body'].read()
    except Exception as e:
        if _is_missing(e):
            return 'missing', None
        return 'error', f"s3 read failed: {e}"
    try:
        ds = pydicom.dcmread(BytesIO(data), stop_before_pixels=True, force=True,
                             specific_tags=[0x00080018])
        sop = str(getattr(ds, 'SOPInstanceUID', '') or '')
    except Exception as e:
        return 'error', f"header parse failed: {e}"
    return ('ok', sop) if sop else ('error', 'no SOPInstanceUID in header')


def _decide(rows, s3_result):
    """Return (survivor_row | None, rule_or_skip_reason)."""
    if len(rows) < 2:
        return None, 'already_unique'
    if any(r['sopClassUID'] == WSI_SOP_CLASS_UID for r in rows):
        return None, 'wsi'
    if rows[0]['si_deleted_at'] is not None:
        return None, 'storage_deleted'
    if s3_result is not None:
        status, val = s3_result
        if status == 'missing':
            return None, 'object_missing'
        if status == 'ok':
            match = [r for r in rows if r['sopUID'] == val]
            if len(match) == 1:
                return match[0], 's3'
            return None, 's3_uid_not_indexed'
    si_sop = rows[0]['si_sop']
    match = [r for r in rows if si_sop and r['sopUID'] == si_sop]
    if len(match) == 1:
        return match[0], 'storage_index_uid'
    newest = max(rows, key=lambda r: (r['last_updated'] is not None,
                                      r['last_updated'], int(r['instance_pkey'])))
    return newest, 'newest'


def _retire_group(conn, datastore_id, content_pkey, s3_result, cache):
    """Locked re-read + re-decide + retire, one transaction. Returns
    (survivor, rule, retired_summaries)."""
    rows = _load_group(conn, datastore_id, content_pkey, for_update=True)
    survivor, rule = _decide(rows, s3_result)
    if survivor is None:
        conn.rollback()
        return None, rule, []
    retired = engine._retire_superseded_instances(
        conn, datastore_id, [content_pkey], [survivor['instanceid']], cache=cache)
    conn.commit()
    return survivor, rule, retired


def run(event, context):
    apply = event.get('apply') is True
    datastore_id = event.get('datastoreId') or None
    after = _int_arg(event, 'afterContentPkey', 0, 0, 2 ** 63)
    window = _int_arg(event, 'windowSize', 20000, 100, 500000)
    max_groups = _int_arg(event, 'maxGroups', 200, 1, 5000)
    lock_wait = _int_arg(event, 'lockWaitSeconds', 5, 1, 50)
    max_report = _int_arg(event, 'maxReportRows', 500, 0, 5000)
    s3_check = event.get('s3Check', True) is not False

    def time_left_ok():
        rem = getattr(context, 'get_remaining_time_in_millis', None)
        return rem is None or rem() > _TIME_RESERVE_MS

    conn = engine._get_db_conn()
    prev_lock_wait = None
    per_ds = {}
    rows_out = []
    errors = []
    cache = engine._ParentCache()
    touched = {}
    groups = 0
    cursor = after
    stopped = None
    try:
        r = _exec_all(conn, "SELECT @@SESSION.innodb_lock_wait_timeout")
        prev_lock_wait = int(r[0][0]) if r and r[0] and r[0][0] is not None else None
        _exec_all(conn, "SET SESSION innodb_lock_wait_timeout = %s", (lock_wait,))
        top = _exec_all(conn, "SELECT COALESCE(MAX(content_pkey), 0) FROM storage_index")
        max_cpk = int(top[0][0]) if top and top[0] and top[0][0] is not None else 0
        conn.commit()  # end the read snapshot before any locking work

        lo = after
        while lo < max_cpk and stopped is None:
            hi = min(lo + window, max_cpk)
            found = _discover(conn, lo, hi, datastore_id)
            conn.commit()
            for (ds, cpk, n_live) in found:
                if groups >= max_groups:
                    stopped = 'maxGroups'
                elif not time_left_ok():
                    stopped = 'timeBudget'
                if stopped:
                    cursor = cpk - 1
                    break
                groups += 1
                stats = per_ds.setdefault(ds, {
                    'duplicateGroups': 0, 'liveInstancesInGroups': 0,
                    'staleInstances': 0, 'retiredInstances': 0,
                    'skipped': {}, 'rules': {}, 'errors': 0})
                stats['duplicateGroups'] += 1
                stats['liveInstancesInGroups'] += n_live
                rows = _load_group(conn, ds, cpk)
                conn.commit()
                s3_result = None
                if s3_check and rows and rows[0]['key']:
                    s3_result = _read_s3_sop(rows[0]['bucket'], rows[0]['key'],
                                             rows[0]['member_offset'],
                                             rows[0]['member_length'])
                survivor, rule = _decide(rows, s3_result)
                if survivor is None:
                    stats['skipped'][rule] = stats['skipped'].get(rule, 0) + 1
                    if len(rows_out) < max_report:
                        rows_out.append({'datastoreId': ds, 'contentPkey': cpk,
                                         's3Key': rows[0]['key'] if rows else None,
                                         'skipped': rule})
                    continue
                stale = [r for r in rows if r['instanceid'] != survivor['instanceid']]
                stats['staleInstances'] += len(stale)
                stats['rules'][rule] = stats['rules'].get(rule, 0) + 1
                entry = {
                    'datastoreId': ds, 'contentPkey': cpk, 's3Key': survivor['key'],
                    'rule': rule,
                    'survivor': {'instanceid': survivor['instanceid'],
                                 'sopUID': survivor['sopUID']},
                    'retire': [{'instanceid': r['instanceid'], 'sopUID': r['sopUID'],
                                'seriesUID': r['seriesUID'], 'studyUID': r['studyUID']}
                               for r in stale],
                }
                if s3_result is not None and s3_result[0] == 'error':
                    entry['s3'] = s3_result[1]
                if apply:
                    try:
                        surv, rule2, retired = engine._with_deadlock_retry(
                            _retire_group, conn, ds, cpk, s3_result, cache)
                    except Exception as e:
                        try:
                            conn.rollback()
                        except Exception:
                            pass
                        stats['errors'] += 1
                        errors.append({'datastoreId': ds, 'contentPkey': cpk,
                                       'error': str(e)})
                        continue
                    entry['retired'] = len(retired)
                    if surv is None:
                        entry['skippedAtApply'] = rule2
                    else:
                        stats['retiredInstances'] += len(retired)
                        # The VF purge also dropped the survivor's membership:
                        # settle its series too so folder rules re-assign it.
                        cache.touched_study_series_v2.setdefault(
                            (ds, surv['studyUID'], surv['seriesUID']), 0)
                        for tri in list(cache.touched_study_series_v2):
                            cur = touched.get(tri)
                            touched[tri] = [max(cur[0], cpk) if cur else cpk, None]
                        cache.touched_study_series_v2 = {}
                        if retired:
                            try:
                                engine.index_events.emit_instances_deleted(
                                    ds, surv['bucket'], surv['key'], retired)
                            except Exception as e:
                                print(f"dedupe-sweep: event emit skipped: {e}")
                if len(rows_out) < max_report:
                    rows_out.append(entry)
            if stopped is None:
                lo = hi
                cursor = hi
        if apply and touched:
            import handler as h
            h._settle_touched(conn, touched)
    finally:
        try:
            conn.rollback()
        except Exception:
            pass
        if prev_lock_wait is not None:
            try:
                _exec_all(conn, "SET SESSION innodb_lock_wait_timeout = %s",
                          (prev_lock_wait,))
            except Exception as e:
                print(f"dedupe-sweep: lock-wait restore failed: {e}")

    result = {
        'mode': 'dedupe-sweep', 'apply': apply, 'datastoreId': datastore_id,
        'groupsExamined': groups, 'perDatastore': per_ds,
        'settledSeries': len(touched) if apply else 0,
        'nextAfterContentPkey': cursor,
        'done': stopped is None,
        'stoppedBy': stopped,
        'rows': rows_out, 'errors': errors,
    }
    print(f"dedupe-sweep: apply={apply} groups={groups} next={cursor} "
          f"done={stopped is None} perDatastore={per_ds}")
    return result
