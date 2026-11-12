# PHI notice: this module handles Protected Health Information (patient name, ID,
# birth date, sex, accession number and other DICOM identifiers). Deployers are
# responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
# responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
"""vf-deid-consumer — standalone Virtual-Folder de-identification module.

NOT part of the ingest pipeline. Fed by the {stackPrefix}-vf-deid-queue (standard
SQS). One message = one (VF, series) unit of de-id work:

    {"op": "deid",   "virtual_folder_id": "...", "datastore_id": "...",
     "series_instance_uid": "1.2.3.4", "study_instance_uid": "1.2.3"}
    {"op": "delete", "virtual_folder_id": "...", "series_instance_uid": "1.2.3.4",
     "datastore_id": "..."}

Producers (source-agnostic):
  * rule path   — vf-assign-consumer emits one message per matched series;
  * manual path — assign-study / assign-series API emits one per assigned series.

For a 'deid' message the consumer:
  1. Loads the VF's de-id profile (tag_actions) — salt = "{pepper}:{VF id}".
  2. Reads the ORIGINAL patient/study/series/instance values for that series from
     the SHARED index tree (patient/study/series/instance joined by pkey).
  3. Applies the swap with vf_deid.apply_deid_action (the SAME engine the WADO
     retrieve path uses — byte-identical index vs retrieve, the consistency
     contract in the shared-layer de-id engine).
  4. Upserts vf_<id>_patient/study/series + one vf_<id>_instance per instance for
     THIS series, in ONE transaction, writing ONLY de-identified values into the
     de-id columns. The tree stores NO original identifier: the
     patient row is keyed on an opaque HMAC of (PatientID, issuer) made with the
     per-deployment pepper, and study/series/instance rows on their UIDs. A
     REMOVE/EMPTY rule stores NULL, never the source value.
     (Phase 2, VF Per-Database Redesign: each VF's de-id tree lives in its own
     database vf_<id>; the database is the scope so there is no virtual_folder_id
     column. vf_<id>_instance keys on instance_pkey and carries content_pkey too.)
  5. Upserts vf_<id>_series_tracker (monotonic last_content_pkey) for coordination.

Per-message try/except (like index-stats-consumer): a poison message fails only
its own SQS item (reportBatchItemFailures).
"""

import datetime
import hashlib
import hmac
import json
import os
import re

import pymysql

import vf_deid  # synced copy of interface-container/dicomweb-s3/vf_deid.py

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


_conn = None

# ── Per-VF database name derivation (Phase 2, VF Per-Database Redesign) ────────
# Each VF's de-id tree lives in its OWN database vf_<sanitized-uuid> with tables
# vf_<id>_patient/study/series/instance (+ vf_<id>_series_tracker). This MUST
# derive the name byte-identically to the Phase 1 JS helper vfDbName in
# cdk-infrastructure/lib/virtual-folder/lambda/virtual-folder-api/vf-database.js:
#   'vf_' + uuid.lower().replace('-', '')  ->  'vf_' + 32 hex chars.
# The UUID is validated BEFORE any interpolation (identifiers cannot be
# parameterized). The shared physical tree stays in dicomarchive (app-only), so
# cross-database reads are qualified explicitly.
_UUID_RE = re.compile(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')


def _vf_db_name(vf_id):
    """Derive the per-VF database name from a validated VF UUID.
    Mirrors vfDbName() in vf-database.js exactly."""
    if not isinstance(vf_id, str) or not _UUID_RE.match(vf_id):
        raise ValueError(f"Invalid virtual folder id (must be a UUID): {vf_id}")
    return 'vf_' + vf_id.lower().replace('-', '')


def _vf_tbl(vf_db, leaf):
    """Fully-qualified backtick-quoted VF tree table: `vf_x`.`vf_x_patient`.
    The connection default database is pinned to DB_NAME, so every VF-tree
    statement must be database-qualified to reach vf_<id>."""
    if not re.match(r'^vf_[0-9a-f]{32}$', vf_db):
        raise ValueError(f"Refusing to build SQL for unexpected vf-db name: {vf_db}")
    return f"`{vf_db}`.`{vf_db}_{leaf}`"


# The shared physical index tree stays in this database (app-only, never granted
# to a VF SQL user). Cross-database reads are qualified with it.
_SHARED_DB = os.environ.get('DB_NAME') or 'dicomarchive'


def _shared_tbl(name):
    return f"`{_SHARED_DB}`.`{name}`"


# ── Security: opaque per-folder patient key ─────────────────────────────────
# MUST match sourcePatientKey() in the shared layer's vf-tree-ddl.js byte for
# byte (the indexer and this consumer write the same tree). The pepper is the
# per-deployment de-id secret; without it the key would be a brute-forceable
# hash of a PatientID, so this fails closed and the SQS message is retried.
_PEPPER = None


def _pepper():
    global _PEPPER
    if _PEPPER:
        return _PEPPER
    name = os.environ.get('DEID_HASH_PEPPER_SECRET_NAME', '')
    if not name:
        raise RuntimeError('DEID_HASH_PEPPER_SECRET_NAME is not set; refusing to key folder patients')
    import boto3
    val = boto3.client('secretsmanager').get_secret_value(SecretId=name).get('SecretString') or ''
    if not val:
        raise RuntimeError('de-id pepper secret is empty; refusing to key folder patients')
    _PEPPER = val  # cache only a successful resolution
    return val


def _source_patient_key(vf_id, patient_id, issuer):
    msg = f"{vf_id}\x1f{patient_id or ''}\x1f{issuer or ''}".encode('utf-8')
    return hmac.new(_pepper().encode('utf-8'), msg, hashlib.sha256).hexdigest()


_TREE_CURRENT = set()


def _assert_tree_current(conn, vf_db):
    """A tree built by an older release still has original_* columns and no
    source_key. Only the indexer rebuilds trees (it owns the DDL), so refuse
    here and let the message retry after the indexer's rebuild."""
    if vf_db in _TREE_CURRENT:
        return
    row = _dict_one(conn, """
        SELECT (SUM(COLUMN_NAME='source_key') > 0
                AND SUM(COLUMN_NAME='patientsex' AND CHARACTER_MAXIMUM_LENGTH >= 64) > 0) AS n
          FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=%s AND TABLE_NAME=%s
    """, (vf_db, f"{vf_db}_patient"))
    if not row or not row['n']:
        raise RuntimeError(f"{vf_db} tree schema is outdated; waiting for the indexer to rebuild it")
    _TREE_CURRENT.add(vf_db)


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


def _dict_all(conn, sql, params):
    cur = conn.cursor(pymysql.cursors.DictCursor)
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    finally:
        cur.close()


def _dict_one(conn, sql, params):
    cur = conn.cursor(pymysql.cursors.DictCursor)
    try:
        cur.execute(sql, params)
        return cur.fetchone()
    finally:
        cur.close()


def _exec(conn, sql, params):
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return cur.lastrowid
    finally:
        cur.close()


# ── De-id profile (cached per VF id, short TTL) ───────────────────────────────
import time
_profile_cache = {}
_PROFILE_TTL_S = 60


def _load_profile(conn, vf_id):
    """Return (tag_action_index, salt) for a VF, or (None, salt) if the VF is gone.
    Security: salt = "{pepper}:{vf_id}", the SAME effective salt as the
    indexer's effectiveSalt() and the retrieve path's vf_deid.effective_salt().
    It was the bare VF id, which is public, so hashes written here were
    brute-forceable and did not match the values /metadata and WADO return.
    Fails closed without the pepper (see _pepper)."""
    salt = f"{_pepper()}:{vf_id}"
    c = _profile_cache.get(vf_id)
    if c and (time.time() - c[0]) < _PROFILE_TTL_S:
        return c[1]
    row = _dict_one(conn, """
        SELECT dp.tag_actions AS tag_actions
        FROM virtual_folders vf
        LEFT JOIN virtual_folder_deid_profiles dp ON vf.deid_profile_id = dp.id
        WHERE vf.id = %s AND vf.deleted = FALSE AND vf.status = 'ACTIVE'
    """, (vf_id,))
    if not row:
        result = (None, salt)  # VF gone/inactive: caller skips
        _profile_cache[vf_id] = (time.time(), result)
        return result
    ta = row.get('tag_actions')
    if isinstance(ta, str):
        try:
            ta = json.loads(ta)
        except Exception:
            ta = None
    action_index = vf_deid.build_action_index(ta) if isinstance(ta, list) else {}
    result = (action_index, salt)
    _profile_cache[vf_id] = (time.time(), result)
    return result


# Per-level (tag, column, vr) the VF tree carries — mirrors hydrateVfTree in
# virtual-folder-indexer/index.js. Only the de-identified value is stored.
_PATIENT_FIELDS = [  # (col, tag, vr)
    ('patientname', '00100010', 'PN'),
    ('patientid', '00100020', 'LO'),
    ('patientbirthdate', '00100030', 'DA'),
]
_STUDY_FIELDS = [
    ('accessionnumber', '00080050', 'SH'),
    ('studydate', '00080020', 'DA'),
    ('studydescription', '00081030', 'LO'),
    ('referringphysicianname', '00080090', 'PN'),
]
_SERIES_FIELDS = [
    ('seriesdescription', '0008103E', 'LO'),
]


def _deid(action_index, salt, col, tag, vr, value, patient_id):
    """Swap one value per the profile. Absent action -> source value passes
    through (KEEP semantics). None means REMOVE/EMPTY and is stored as NULL by
    the caller; it never falls back to the source value.
    DATE columns arrive as datetime.date / 'YYYY-MM-DD' and are normalised to
    DICOM DA (YYYYMMDD) first, so SHIFT_DATE applies and _da_or_none stores them."""
    if value is None or value == '':
        return None
    if vr == 'DA':
        value = _to_dicom_da(value)
    rule = action_index.get(vf_deid._norm_tag(tag)) if action_index else None
    if not rule:
        return value
    return vf_deid.apply_deid_action(str(value), tag, rule, salt, vr, patient_id or '')


def _to_dicom_da(v):
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.strftime('%Y%m%d')
    s = str(v).strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
    return f"{m.group(1)}{m.group(2)}{m.group(3)}" if m else s


def _da_or_none(v):
    s = str(v).strip() if v is not None else ''
    if len(s) >= 8 and s[:8].isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    return None


def _process_deid(conn, vf_id, datastore_id, series_uid, study_uid):
    action_index, salt = _load_profile(conn, vf_id)
    if salt is None:  # unreachable; salt is always "{pepper}:{vf_id}"
        return
    vf_db = _vf_db_name(vf_id)
    vf_patient = _vf_tbl(vf_db, 'patient')
    vf_study = _vf_tbl(vf_db, 'study')
    vf_series = _vf_tbl(vf_db, 'series')
    vf_instance = _vf_tbl(vf_db, 'instance')
    vf_tracker = _vf_tbl(vf_db, 'series_tracker')
    _assert_tree_current(conn, vf_db)

    # Read the series' instances + parents from the SHARED (dicomarchive) tree
    # (originals). virtual_folder_assignments STAYS shared in dicomarchive (qualified).
    # Select i.instance_pkey too — the vf_<id>_instance row keys on instance_pkey
    # so WSI pyramid levels (sharing a content_pkey) stay distinct.
    rows = _dict_all(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        SELECT i.content_pkey, i.instance_pkey,
               pt.patientid, pt.patientname, pt.patientbirthdate, pt.patientsex, pt.issuerofpatientid,
               st.studyinstanceuid, st.studydate, st.studytime, st.accessionnumber,
               st.studyid, st.studydescription, st.referringphysicianname, st.modalitiesinstudy,
               se.seriesinstanceuid, se.modality, se.seriesdescription, se.seriesnumber,
               i.sopinstanceuid, i.sopclassuid, i.instancenumber
        FROM {_shared_tbl('series')} se
        JOIN {_shared_tbl('study')} st   ON st.study_pkey  = se.study_pkey
        JOIN {_shared_tbl('patient')} pt ON pt.patient_pkey = st.patient_pkey
        JOIN {_shared_tbl('instance')} i ON i.series_pkey = se.series_pkey AND i.deleted_at IS NULL
        WHERE se.datastore_id = %s AND se.seriesinstanceuid = %s AND se.deleted_at IS NULL
          AND i.content_pkey IS NOT NULL
          AND EXISTS (SELECT 1 FROM {_shared_tbl('virtual_folder_assignments')} vfa
                      WHERE vfa.virtual_folder_id = %s AND vfa.content_pkey = i.content_pkey
                        AND vfa.datastore_id = i.datastore_id)
    """, (datastore_id, series_uid, vf_id))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    if not rows:
        # Nothing assigned for this series (or series gone). Ensure any stale
        # virtual rows for it are removed, then no-op.
        _delete_series(conn, vf_id, series_uid, datastore_id)
        conn.commit()
        return

    r0 = rows[0]
    pid = r0.get('patientid') or ''
    issuer = r0.get('issuerofpatientid') or ''
    max_cpk = 0

    # ── vf_<id>_patient (de-id demographics) ─────────────────────────────────
    # Phase 2: the DATABASE is the scope, so there is no virtual_folder_id column.
    d_name = _deid(action_index, salt, 'patientname', '00100010', 'PN', r0.get('patientname'), pid)
    d_id = _deid(action_index, salt, 'patientid', '00100020', 'LO', r0.get('patientid'), pid)
    d_bd = _deid(action_index, salt, 'patientbirthdate', '00100030', 'DA', r0.get('patientbirthdate'), pid)
    # Security: sex and StudyID follow the profile like every other column.
    d_sex = _deid(action_index, salt, 'patientsex', '00100040', 'CS', r0.get('patientsex'), pid)
    src_key = _source_patient_key(vf_id, pid, issuer)
    _exec(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        INSERT INTO {vf_patient}
          (source_key, issuerofpatientid, source_datastoreid,
           patientid, patientname, patientbirthdate, patientsex)
        VALUES (%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE patientname = VALUES(patientname),
                                patientid = VALUES(patientid),
                                patientbirthdate = VALUES(patientbirthdate),
                                patientsex = VALUES(patientsex)
    """, (src_key, issuer, datastore_id, d_id, d_name,  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
          (_da_or_none(d_bd) if d_bd is not None else None),
          d_sex))
    prow = _dict_one(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        SELECT patient_pkey FROM {vf_patient} WHERE source_key=%s
    """, (src_key,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    patient_pkey = prow['patient_pkey']

    # ── vf_<id>_study ────────────────────────────────────────────────────────
    d_acc = _deid(action_index, salt, 'accessionnumber', '00080050', 'SH', r0.get('accessionnumber'), pid)
    d_sd = _deid(action_index, salt, 'studydate', '00080020', 'DA', r0.get('studydate'), pid)
    d_sdesc = _deid(action_index, salt, 'studydescription', '00081030', 'LO', r0.get('studydescription'), pid)
    d_ref = _deid(action_index, salt, 'referringphysicianname', '00080090', 'PN', r0.get('referringphysicianname'), pid)
    d_stid = _deid(action_index, salt, 'studyid', '00200010', 'SH', r0.get('studyid'), pid)
    _exec(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        INSERT INTO {vf_study}
          (patient_pkey, source_datastoreid, studyinstanceuid,
           accessionnumber, studyid, studydate, studydescription,
           referringphysicianname, modalitiesinstudy)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE accessionnumber = VALUES(accessionnumber),
                                studydate = VALUES(studydate),
                                studydescription = VALUES(studydescription),
                                studyid = VALUES(studyid),
                                referringphysicianname = VALUES(referringphysicianname),
                                modalitiesinstudy = VALUES(modalitiesinstudy)
    """, (patient_pkey, datastore_id, r0.get('studyinstanceuid'),  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
          d_acc, d_stid,
          (_da_or_none(d_sd) if d_sd is not None else None),
          d_sdesc, d_ref, r0.get('modalitiesinstudy')))
    strow = _dict_one(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        SELECT study_pkey FROM {vf_study}
        WHERE studyinstanceuid=%s
    """, (r0.get('studyinstanceuid'),))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    study_pkey = strow['study_pkey']

    # ── vf_<id>_series ───────────────────────────────────────────────────────
    d_sedesc = _deid(action_index, salt, 'seriesdescription', '0008103E', 'LO', r0.get('seriesdescription'), pid)
    _exec(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        INSERT INTO {vf_series}
          (study_pkey, source_datastoreid,
           seriesinstanceuid, modality, seriesnumber, seriesdescription)
        VALUES (%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE modality = VALUES(modality),
                                seriesnumber = VALUES(seriesnumber),
                                seriesdescription = VALUES(seriesdescription)
    """, (study_pkey, datastore_id,  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
          series_uid, r0.get('modality'), r0.get('seriesnumber'), d_sedesc))
    serow = _dict_one(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        SELECT series_pkey FROM {vf_series}
        WHERE seriesinstanceuid=%s AND source_datastoreid=%s
    """, (series_uid, datastore_id))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    series_pkey = serow['series_pkey']

    # ── vf_<id>_instance (one row per assigned instance) ─────────────────────
    # Phase 2: carries BOTH instance_pkey (PK / dedup key — WSI pyramid levels
    # stay distinct) AND content_pkey (shared S3 pointer). Keyed on instance_pkey.
    for r in rows:
        cpk = r.get('content_pkey')
        if cpk and cpk > max_cpk:
            max_cpk = cpk
        _exec(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
            conn, f"""
            INSERT INTO {vf_instance}
              (instance_pkey, content_pkey, series_pkey, source_datastoreid,
               sopinstanceuid, sopclassuid, instancenumber)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE content_pkey = VALUES(content_pkey),
                                    series_pkey = VALUES(series_pkey)
        """, (r.get('instance_pkey'), cpk, series_pkey, datastore_id,  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
              r.get('sopinstanceuid'),
              r.get('sopclassuid') or '', r.get('instancenumber')))

    # ── Count-column settle (idempotent recompute) ───────────────────────────
    # The INSERTs above leave the three DICOM count columns NULL. QIDO now reads
    # them STORED from the vf_<id> tree (dicomweb-s3 _construct_query VF branch:
    # numberofstudyrelatedseries / numberofstudyrelatedinstances on _study,
    # numberofseriesrelatedinstances on _series) instead of computing COUNT
    # subqueries on the fly, so they must be maintained here. Recompute from the
    # ACTUAL vf_<id> rows (not increment) so it is idempotent under SQS
    # redelivery and correct as a series streams in across many messages:
    #   * this series' instance count       -> vf_<id>_series row
    #   * this study's series + instance counts -> vf_<id>_study row
    _exec(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        UPDATE {vf_series} se
        SET se.numberofseriesrelatedinstances =
            (SELECT COUNT(*) FROM {vf_instance} i WHERE i.series_pkey = se.series_pkey)
        WHERE se.series_pkey = %s
    """, (series_pkey,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    _exec(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        UPDATE {vf_study} st
        SET st.numberofstudyrelatedseries =
              (SELECT COUNT(*) FROM {vf_series} s WHERE s.study_pkey = st.study_pkey),
            st.numberofstudyrelatedinstances =
              (SELECT COUNT(*) FROM {vf_instance} i
               JOIN {vf_series} s ON s.series_pkey = i.series_pkey
               WHERE s.study_pkey = st.study_pkey)
        WHERE st.study_pkey = %s
    """, (study_pkey,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)

    # ── vf_<id>_series_tracker (per-VF monotonic watermark) ──────────────────
    # Phase 2 decision: the tracker moved PER-VF into vf_<id> (was shared
    # dicomarchive.vf_series_tracker keyed on (virtual_folder_id, series_instance_uid)).
    # The database is now the VF scope, so virtual_folder_id is dropped and the
    # PK is series_instance_uid. Phase 1 renderTreeDDL creates this table.
    _exec(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        INSERT INTO {vf_tracker}
          (series_instance_uid, study_instance_uid, datastore_id, last_content_pkey)
        VALUES (%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          last_content_pkey = GREATEST(last_content_pkey, VALUES(last_content_pkey)),
          study_instance_uid = VALUES(study_instance_uid),
          datastore_id = VALUES(datastore_id)
    """, (series_uid, study_uid or r0.get('studyinstanceuid'), datastore_id, max_cpk))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)

    conn.commit()
    print(f"vf-deid: vf={vf_id} db={vf_db} series={series_uid} deid'd {len(rows)} instance(s) "
          f"(profile {'on' if action_index else 'off'})")


def _delete_series(conn, vf_id, series_uid, datastore_id):
    """Remove a series' vf_<id> rows + tracker entry (unassign path). Leaves
    parent study/patient rows (they may hold other series); harmless if orphaned.
    Phase 2: scoped to the VF's own database (no virtual_folder_id filter)."""
    vf_db = _vf_db_name(vf_id)
    vf_series = _vf_tbl(vf_db, 'series')
    vf_instance = _vf_tbl(vf_db, 'instance')
    vf_tracker = _vf_tbl(vf_db, 'series_tracker')
    serow = _dict_one(  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        conn, f"""
        SELECT series_pkey FROM {vf_series}
        WHERE seriesinstanceuid=%s AND source_datastoreid=%s
    """, (series_uid, datastore_id))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    if serow:
        sp = serow['series_pkey']
        _exec(conn, f"DELETE FROM {vf_instance} WHERE series_pkey=%s", (sp,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
        _exec(conn, f"DELETE FROM {vf_series} WHERE series_pkey=%s", (sp,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    _exec(conn, f"DELETE FROM {vf_tracker} WHERE series_instance_uid=%s", (series_uid,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)


def handler(event, context):
    conn = _get_db_conn()
    records = event.get('Records', []) if isinstance(event, dict) else []
    print(f"vf-deid: {len(records)} message(s)")
    failures = []
    for rec in records:
        mid = rec.get('messageId')
        try:
            msg = json.loads(rec.get('body') or '{}')
            op = msg.get('op', 'deid')
            vf_id = msg.get('virtual_folder_id')
            datastore_id = msg.get('datastore_id')
            series_uid = msg.get('series_instance_uid')
            study_uid = msg.get('study_instance_uid')
            if not vf_id or not series_uid or not datastore_id:
                print(f"vf-deid: message {mid} missing vf/series/datastore, skipping")
                continue
            if op == 'delete':
                _delete_series(conn, vf_id, series_uid, datastore_id)
                conn.commit()
            else:
                _process_deid(conn, vf_id, datastore_id, series_uid, study_uid)
        except Exception as e:
            print(f"vf-deid: ERROR processing message {mid}: {e}")
            try:
                conn.rollback()
            except Exception:
                pass
            failures.append({'itemIdentifier': mid})
    return {'batchItemFailures': failures}
