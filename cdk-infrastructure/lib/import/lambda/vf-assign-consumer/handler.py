"""vf-assign-consumer — per-series virtual-folder assignment-rule evaluation.

Fed by the {stackPrefix}-vf-assign-queue (standard SQS). The ingest producer
(ingest / s3-ingest) NO LONGER evaluates VF rules on the per-instance
write path; instead, at batch finalize it emits ONE message per touched series:

    {"datastore_id": "...", "series_pkey": 123,
     "study_uid": "1.2.3", "series_uid": "1.2.3.4"}

For each message this consumer:
  1. Loads the (post-recompute) series row and its parent study + patient rows
     by pkey — so aggregates like modalitiesinstudy are settled.
  2. Evaluates the datastore's ENABLED VF rules against those ROW values (not a
     DICOM header): Modality->series.modality, ModalitiesInStudy->
     study.modalitiesinstudy, EquipmentModality->series.modality,
     StudyDescription/StudyDate/AccessionNumber->study.*, StudyInstanceUID->
     study.studyinstanceuid, SeriesInstanceUID->series.seriesinstanceuid,
     PatientID/PatientName->patient.*, plus custom physical_column / x_<col> /
     d<tag> references resolved from index_attribute_defs to a physical column
     on the loaded rows. Operators EQUALS/=, LIKE/CONTAINS, IN, is_exclusion,
     and AND/OR logic are identical to the ingest handler's _vf_cond_matches.
  3. On a match, inserts virtual_folder_assignments for EVERY instance of the
     series (one row per content_pkey via instance JOIN storage_index),
     idempotent ON DUPLICATE KEY (uk_vf_assignment = virtual_folder_id +
     content_pkey).

The VF-indexer remains the authoritative full reconciler; this is the fast
incremental path. Per-message try/except (matching the index-stats-consumer
error pattern) so a single poison message fails only its own SQS item.
"""

import json
import os
import time

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


# VF de-id queue: after we insert assignments for a matched series, we emit ONE
# per-series message to the standalone VF de-id module's queue. Its consumer reads
# the series' originals, applies the VF de-id profile, and upserts virtual_* with
# ONLY swapped values. Source-agnostic: the manual assign API emits the same
# message shape. Replaces the old coarse indexer hydrate on this path.
_VF_DEID_QUEUE_URL = os.environ.get('VF_DEID_QUEUE_URL', '') or ''
_sqs = None


def _get_sqs():
    global _sqs
    if _sqs is None:
        import boto3

        _sqs = boto3.client('sqs')
    return _sqs


def _enqueue_vf_deid(units):
    """Emit one de-id message per (vf_id, datastore_id, series_uid, study_uid) unit
    (deduped by caller). Best-effort: the assignments are already committed and the
    VF-indexer full reconcile remains the backstop."""
    if not _VF_DEID_QUEUE_URL or not units:
        return
    for u in units:
        try:
            _get_sqs().send_message(
                QueueUrl=_VF_DEID_QUEUE_URL,
                MessageBody=json.dumps({
                    'op': 'deid',
                    'virtual_folder_id': u[0],
                    'datastore_id': u[1],
                    'series_instance_uid': u[2],
                    'study_instance_uid': u[3],
                }),
            )
        except Exception as e:
            print(f"WARNING: vf-deid enqueue skipped (vf={u[0]} series={u[2]}): {e}")


# ── DB connection (reused across warm invocations), identical config to the
# ingest lambdas: PyMySQL text protocol (no RDS-Proxy pin), SSL for
# caching_sha2_password, READ COMMITTED. ───────────────────────────────────────
_conn = None


def _env_int(name, default):
    try:
        return int(os.environ.get(name, '') or default)
    except ValueError:
        return default


def _connect_db():
    import boto3
    sm = boto3.client('secretsmanager')
    sec = json.loads(sm.get_secret_value(SecretId=os.environ['DB_SECRET_ARN'])['SecretString'])
    return pymysql.connect(
        host=os.environ.get('DB_HOST') or sec['host'],
        user=sec['username'], password=sec['password'],
        database=os.environ.get('DB_NAME') or sec.get('dbname'),
        port=_env_int('DB_PORT', int(sec.get('port', 3306))),
        charset='utf8mb4',
        autocommit=False,
        init_command="SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
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


def _exec_all(conn, sql, params):
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    finally:
        cur.close()


def _exec_one(conn, sql, params):
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return cur.fetchone()
    finally:
        cur.close()


def _exec(conn, sql, params):
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return cur.rowcount
    finally:
        cur.close()


# ── VF rules (ported from the ingest handler, cached per datastore) ───────────
# Rule attribute names that map to a ROW column rather than a custom index attr.
# 'EquipmentModality' means the same as 'Modality' (the live rule form); it and
# 'ModalitiesInStudy' were the two names the ingest path had to add so their
# conditions stopped silently no-matching.
_VF_RULE_ATTR_COL = {
    'StudyInstanceUID': ('study', 'studyinstanceuid'),
    'SeriesInstanceUID': ('series', 'seriesinstanceuid'),
    'Modality': ('series', 'modality'),
    'EquipmentModality': ('series', 'modality'),
    'ModalitiesInStudy': ('study', 'modalitiesinstudy'),
    'SeriesDescription': ('series', 'seriesdescription'),
    'StudyDescription': ('study', 'studydescription'),
    'StudyDate': ('study', 'studydate'),
    'AccessionNumber': ('study', 'accessionnumber'),
    'PatientID': ('patient', 'patientid'),
    'PatientName': ('patient', 'patientname'),
}

_vf_rules_cache = {}
_VF_RULES_TTL_S = 60


def _load_vf_rules(conn, datastore_id):
    """Enabled VF rules whose datastore scope includes this datastore (cached).
    Also returns x_cols: a map of custom-attribute reference forms
    (physical_column, x_<column>, d<tag>) -> physical column name, so a rule
    condition naming a custom index attribute resolves to a ROW column."""
    c = _vf_rules_cache.get(datastore_id)
    if c and (time.time() - c[0]) < _VF_RULES_TTL_S:
        return c[1]
    rows = _exec_all(conn, """
        SELECT r.id, r.virtual_folder_id
        FROM virtual_folder_assignment_rules r
        JOIN virtual_folder_assignment_rule_datastores d ON d.rule_id = r.id
        WHERE r.enabled = TRUE AND d.datastore_id = %s
    """, (datastore_id,))
    rules = []
    for rule_id, vf_id in rows:
        conds = _exec_all(conn, """
            SELECT attribute_name, operator, value, logic_operator, is_exclusion
            FROM virtual_folder_assignment_rule_conditions WHERE rule_id = %s
        """, (rule_id,))
        rules.append({'vf_id': vf_id, 'rule_id': rule_id, 'conds': conds})
    # Custom index attributes: map any reference form to its physical column.
    xrows = _exec_all(conn,
        "SELECT physical_column, dicom_tag FROM index_attribute_defs", ())
    x_cols = {}
    for (pc, tag) in xrows:
        x_cols[str(pc)] = str(pc)
        x_cols[f"d{str(tag).lower()}"] = str(pc)
        x_cols[f"x_{pc}"] = str(pc)
    result = (rules, x_cols)
    _vf_rules_cache[datastore_id] = (time.time(), result)
    return result


def _row_value(attr, x_cols, rowvals):
    """Resolve a rule attribute name to a value from the loaded rows.
    rowvals is a flat dict of available column values keyed by physical column
    name (series.* and study.* and patient.* columns, plus the custom columns
    that live on series/study). Returns the value or None if unresolvable."""
    mapping = _VF_RULE_ATTR_COL.get(attr)
    if mapping is not None:
        return rowvals.get(mapping[1])
    col = x_cols.get(attr)
    if col is not None:
        return rowvals.get(col)
    return None


def _vf_cond_matches_row(cond, x_cols, rowvals):
    """Match one condition against ROW values. Operators + is_exclusion + the
    return-None-on-unresolvable semantics are identical to the ingest handler's
    _vf_cond_matches (which matched against a DICOM ds)."""
    attr, op, val, _logic, is_excl = cond
    actual = _row_value(attr, x_cols, rowvals)
    if actual is None:
        return None
    op = (op or '').upper()
    if op in ('EQUALS', '='):
        res = (str(actual) == str(val))
    elif op in ('LIKE', 'CONTAINS'):
        res = (str(val).lower() in str(actual).lower())
    elif op == 'IN':
        vals = [s.strip() for s in str(val).split(',') if s.strip()]
        res = (str(actual) in vals)
    else:
        return None
    return (not res) if is_excl else res


def _dict_query_one(conn, sql, params):
    cur = conn.cursor(pymysql.cursors.DictCursor)
    try:
        cur.execute(sql, params)
        return cur.fetchone()
    finally:
        cur.close()


def _load_rowvals(conn, series_pkey):
    """Return a flat dict of series+study+patient column values for a series, or
    None if the series row is gone/soft-deleted. Study/patient columns are
    prefixed only where they would collide; the rule attribute map targets known
    column names (studydescription, patientid, ...) so we merge with study/
    patient taking precedence for their own columns."""
    se = _dict_query_one(conn,
        "SELECT * FROM series WHERE series_pkey = %s AND deleted_at IS NULL",
        (series_pkey,))
    if not se:
        return None
    rowvals = dict(se)
    st = _dict_query_one(conn,
        "SELECT * FROM study WHERE study_pkey = %s", (se['study_pkey'],))
    if st:
        rowvals.update(st)  # study columns (studydescription, accessionnumber, modalitiesinstudy, ...)
        pt = _dict_query_one(conn,
            "SELECT * FROM patient WHERE patient_pkey = %s", (st['patient_pkey'],))
        if pt:
            rowvals.update(pt)  # patient columns (patientid, patientname, ...)
    return rowvals


def _assign_series_to_vf(conn, vf_id, datastore_id, series_pkey):
    """Insert virtual_folder_assignments for EVERY live instance of the series,
    one row per content_pkey, idempotent on uk_vf_assignment. UID columns come
    from storage_index (the physical-object row the original per-instance insert
    used). Returns the number of assignment rows attempted."""
    return _exec(conn, """
        INSERT INTO virtual_folder_assignments
            (virtual_folder_id, datastore_id, content_pkey,
             study_instance_uid, series_instance_uid, sop_instance_uid)
        SELECT %s, %s, si.content_pkey,
               si.study_instance_uid, si.series_instance_uid, si.sop_instance_uid
        FROM instance i
        JOIN storage_index si ON si.content_pkey = i.content_pkey
        WHERE i.series_pkey = %s
          AND i.deleted_at IS NULL
          AND si.deleted_at IS NULL
        ON DUPLICATE KEY UPDATE datastore_id = VALUES(datastore_id)
    """, (vf_id, datastore_id, series_pkey))


def _process_series(conn, datastore_id, series_pkey, study_uid, series_uid):
    rules, x_cols = _load_vf_rules(conn, datastore_id)
    if not rules:
        return []
    rowvals = _load_rowvals(conn, series_pkey)
    if rowvals is None:
        print(f"vf-assign: series_pkey={series_pkey} gone/deleted, skipping")
        return []
    matched_vf_ids = []
    for r in rules:
        conds = r['conds']
        results = [m for m in (_vf_cond_matches_row(c, x_cols, rowvals) for c in conds)
                   if m is not None]
        logic = (conds[0][3] if conds else 'AND')
        matched = True if not results else (
            any(results) if str(logic).upper() == 'OR' else all(results))
        if not matched:
            continue
        try:
            n = _assign_series_to_vf(conn, r['vf_id'], datastore_id, series_pkey)
            matched_vf_ids.append(r['vf_id'])
            print(f"vf-assign: vf={r['vf_id']} series={series_uid} "
                  f"series_pkey={series_pkey} assigned {n} instance-rows")
        except Exception as e:
            print(f"WARNING: vf-assign insert skipped (vf={r['vf_id']} "
                  f"series_pkey={series_pkey}): {e}")
    conn.commit()
    if not matched_vf_ids:
        print(f"vf-assign: series={series_uid} matched no enabled rules")
    # De-id units for the standalone VF de-id module: one per matched VF for THIS series.
    return [(vf_id, datastore_id, series_uid, study_uid) for vf_id in matched_vf_ids]


def handler(event, context):
    """SQS batch entry. One message = one touched series. Per-message try/except
    (like index-stats-consumer): a poison message fails only its own item."""
    conn = _get_db_conn()
    records = event.get('Records', []) if isinstance(event, dict) else []
    print(f"vf-assign: {len(records)} message(s)")
    failures = []
    deid_units = []
    for rec in records:
        mid = rec.get('messageId')
        try:
            msg = json.loads(rec.get('body') or '{}')
            datastore_id = msg.get('datastore_id')
            series_pkey = msg.get('series_pkey')
            study_uid = msg.get('study_uid')
            series_uid = msg.get('series_uid')
            if not datastore_id or series_pkey is None:
                print(f"vf-assign: message {mid} missing datastore_id/series_pkey, skipping")
                continue
            deid_units.extend(
                _process_series(conn, datastore_id, int(series_pkey), study_uid, series_uid))
        except Exception as e:
            print(f"vf-assign: ERROR processing message {mid}: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            failures.append({'itemIdentifier': mid})
    # After all assignments are committed, hand each matched series to the
    # standalone VF de-id module (deduped) to de-identify and write virtual_*.
    _enqueue_vf_deid(sorted(set(deid_units)))
    return {'batchItemFailures': failures}
