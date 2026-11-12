"""SQL for the V2 API. Every statement is parameterised; the only interpolated
identifiers are per-folder database names, which are derived from a validated
UUID and re-checked against ^vf_[0-9a-f]{32}$ before use."""
import datetime
import json
import re

from access import UUID_RE
from db import query, execute, executemany

_VF_DB_RE = re.compile(r'^vf_[0-9a-f]{32}$')


def vf_db_name(vf_id):
    """Same scheme as vf-tree-ddl.js vfDbName()."""
    if not isinstance(vf_id, str) or not UUID_RE.match(vf_id):
        raise ValueError('invalid virtual folder id')
    name = 'vf_' + vf_id.lower().replace('-', '')
    if not _VF_DB_RE.match(name):
        raise ValueError('invalid virtual folder database name')
    return name


def _vf_table(vf_id, leaf):
    db = vf_db_name(vf_id)
    return f'`{db}`.`{db}_{leaf}`'


def da(value):
    """DATE column -> 'YYYYMMDD' (DICOM DA), None stays None."""
    if value is None:
        return None
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.strftime('%Y%m%d')
    s = str(value).replace('-', '')
    return s[:8] or None


def like_escape(s):
    return s.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


# --- destinations -----------------------------------------------------------

DS_COLS = 'id, name, status, access_level, deleted, s3_bucket_name, s3_prefix'
VF_COLS = ('id, name, status, write_mode, write_datastore_id, deid_profile_id, '
           'deidentification_config, deleted')


def get_datastore(conn, ds_id):
    rows = query(conn, f'SELECT {DS_COLS} FROM datastores WHERE id = %s', (ds_id,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    return rows[0] if rows else None


def get_folder(conn, vf_id):
    try:
        rows = query(conn, f'SELECT {VF_COLS} FROM virtual_folders WHERE id = %s', (vf_id,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    except Exception as e:  # virtual-folder feature off: no table
        if _missing_table(e):
            return None
        raise
    return rows[0] if rows else None


def list_datastores(conn):
    return query(conn, f'SELECT {DS_COLS} FROM datastores WHERE deleted = FALSE')  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)


def list_folders(conn):
    try:
        return query(conn, f'SELECT {VF_COLS} FROM virtual_folders WHERE deleted = FALSE')  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    except Exception as e:
        if _missing_table(e):
            return []
        raise


def _missing_table(e):
    return getattr(e, 'args', None) and e.args and e.args[0] in (1146, 1049)


# --- patients ---------------------------------------------------------------

def _patient_out(r):
    return {
        'patientId': r.get('patientid'),
        'patientName': r.get('patientname'),
        'birthDate': da(r.get('patientbirthdate')),
        'sex': r.get('patientsex'),
        '_pkey': r.get('patient_pkey'),
    }


def _patient_source(kind, dest_id, write_ds_id):
    """(FROM clause, scope predicate, params) for the destination's patient rows."""
    if kind == 'datastore':
        return 'patient', 'datastore_id = %s AND deleted_at IS NULL', [dest_id]
    return _vf_table(dest_id, 'patient'), '1=1', []


def fetch_candidates(conn, kind, dest_id, pid, birth_date, name_tokens, limit=300):
    """Prefilter rows that could match (ID, birth date, any name token)."""
    table, scope, params = _patient_source(kind, dest_id, None)
    ors = []
    if pid:
        ors.append('patientid = %s')
        params.append(pid)
    if birth_date:
        ors.append('patientbirthdate = %s')
        params.append(birth_date)
    for t in name_tokens:
        ors.append("patientname LIKE %s ESCAPE '\\\\'")
        params.append(f'%{like_escape(t)}%')
    if not ors:
        return []
    sql = (f'SELECT patient_pkey, patientid, patientname, patientbirthdate, patientsex '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
           f'FROM {table} WHERE {scope} AND ({" OR ".join(ors)}) LIMIT {int(limit)}')
    return [_patient_out(r) for r in query(conn, sql, params)]


def search_patients(conn, kind, dest_id, q, limit=25):
    """GET /patients: ID prefix, or every whitespace/^/, token in the name."""
    table, scope, params = _patient_source(kind, dest_id, None)
    tokens = [t for t in re.split(r'[\s^,]+', q) if t][:5]
    conds = ["patientid LIKE %s ESCAPE '\\\\'"]
    params.append(f'{like_escape(q)}%')
    if tokens:
        conds.append('(' + ' AND '.join(["patientname LIKE %s ESCAPE '\\\\'"] * len(tokens)) + ')')
        params.extend(f'%{like_escape(t)}%' for t in tokens)
    sql = (f'SELECT patient_pkey, patientid, patientname, patientbirthdate, patientsex '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
           f'FROM {table} WHERE {scope} AND ({" OR ".join(conds)}) '
           f'ORDER BY patientname, patientid LIMIT {int(limit)}')
    return [_patient_out(r) for r in query(conn, sql, params)]


def studies_for(conn, kind, dest_id, patient_pkeys, per_patient=20):
    """{patient_pkey: [study, ...]} newest first."""
    if not patient_pkeys:
        return {}
    ph = ','.join(['%s'] * len(patient_pkeys))
    if kind == 'datastore':
        # Aggregate each study's distinct series modalities (a study can hold
        # several, e.g. DOC + SC) so the UI can show a Modality column.
        sql = (f'SELECT s.patient_pkey, s.studyinstanceuid, s.studydate, s.studydescription, '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
               f's.accessionnumber, '
               f'GROUP_CONCAT(DISTINCT se.modality ORDER BY se.modality SEPARATOR \',\') AS modalities '
               f'FROM study s '
               f'LEFT JOIN series se ON se.study_pkey = s.study_pkey AND se.deleted_at IS NULL '
               f'WHERE s.datastore_id = %s AND s.deleted_at IS NULL AND s.patient_pkey IN ({ph}) '
               f'GROUP BY s.study_pkey, s.patient_pkey, s.studyinstanceuid, s.studydate, '
               f's.studydescription, s.accessionnumber '
               f'ORDER BY s.studydate DESC')
        params = [dest_id, *patient_pkeys]
    else:
        st = _vf_table(dest_id, 'study')
        se = _vf_table(dest_id, 'series')
        sql = (f'SELECT vs.patient_pkey, vs.studyinstanceuid, vs.studydate, vs.studydescription, '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
               f'vs.accessionnumber, '
               f'GROUP_CONCAT(DISTINCT vse.modality ORDER BY vse.modality SEPARATOR \',\') AS modalities '
               f'FROM {st} vs '
               f'LEFT JOIN {se} vse ON vse.study_pkey = vs.study_pkey '
               f'WHERE vs.patient_pkey IN ({ph}) '
               f'GROUP BY vs.patient_pkey, vs.studyinstanceuid, vs.studydate, vs.studydescription, '
               f'vs.accessionnumber '
               f'ORDER BY vs.studydate DESC')
        params = list(patient_pkeys)
    out = {}
    for r in query(conn, sql, params):
        lst = out.setdefault(r['patient_pkey'], [])
        if len(lst) < per_patient:
            mods = r.get('modalities')
            lst.append({
                'studyInstanceUID': r['studyinstanceuid'],
                'studyDate': da(r.get('studydate')),
                'description': r.get('studydescription'),
                'accessionNumber': r.get('accessionnumber'),
                'modalities': [m for m in (mods.split(',') if mods else []) if m],
            })
    return out


def public_patient(p, studies):
    out = {k: v for k, v in p.items() if not k.startswith('_')}
    out['studies'] = studies
    return out


# --- existing patient / study / series (create) -----------------------------

_SRC_PATIENT_COLS = ('p.patient_pkey, p.patientid, p.issuerofpatientid, p.patientname, '
                     'p.patientbirthdate, p.patientsex')
_SRC_STUDY_COLS = ('s.study_pkey, s.patient_pkey, s.datastore_id, s.studyinstanceuid, s.studydate, '
                   's.studydescription, s.accessionnumber, s.referringphysicianname')


def ds_patients_by_id(conn, ds_id, patient_id):
    return query(conn, f'SELECT {_SRC_PATIENT_COLS} FROM patient p '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                       'WHERE p.datastore_id = %s AND p.patientid = %s AND p.deleted_at IS NULL LIMIT 3',
                 (ds_id, patient_id))


def ds_study(conn, ds_id, study_uid):
    rows = query(conn, f'SELECT {_SRC_STUDY_COLS} FROM study s '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                       'WHERE s.datastore_id = %s AND s.studyinstanceuid = %s AND s.deleted_at IS NULL',
                 (ds_id, study_uid))
    return rows[0] if rows else None


def ds_patient_by_pkey(conn, pkey):
    rows = query(conn, f'SELECT {_SRC_PATIENT_COLS} FROM patient p WHERE p.patient_pkey = %s', (pkey,))  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    return rows[0] if rows else None


def ds_series(conn, ds_id, series_uid):
    rows = query(conn, 'SELECT series_pkey, study_pkey, seriesinstanceuid, modality, seriesdescription '
                       'FROM series WHERE datastore_id = %s AND seriesinstanceuid = %s AND deleted_at IS NULL',
                 (ds_id, series_uid))
    return rows[0] if rows else None


def _vf_join(vf_id):
    """vf study -> vf series -> vf instance -> shared instance/series/study/patient.
    The folder's (possibly de-identified) tree resolves to the source rows
    through instance_pkey, the only link the de-id keeps."""
    return (f'FROM {_vf_table(vf_id, "study")} vs '
            f'JOIN {_vf_table(vf_id, "series")} vse ON vse.study_pkey = vs.study_pkey '
            f'JOIN {_vf_table(vf_id, "instance")} vi ON vi.series_pkey = vse.series_pkey '
            'JOIN instance i ON i.instance_pkey = vi.instance_pkey AND i.deleted_at IS NULL '
            'JOIN series se ON se.series_pkey = i.series_pkey AND se.deleted_at IS NULL '
            'JOIN study s ON s.study_pkey = se.study_pkey AND s.deleted_at IS NULL '
            'JOIN patient p ON p.patient_pkey = s.patient_pkey AND p.deleted_at IS NULL ')


def vf_source_patients(conn, vf_id, folder_patient_id):
    """Distinct source patients behind the folder patient(s) with this ID."""
    return query(conn, f'SELECT DISTINCT {_SRC_PATIENT_COLS} {_vf_join(vf_id)}'
                       f'JOIN {_vf_table(vf_id, "patient")} vp ON vp.patient_pkey = vs.patient_pkey '
                       'WHERE vp.patientid = %s LIMIT 3', (folder_patient_id,))


def vf_source_study(conn, vf_id, folder_study_uid):
    rows = query(conn, f'SELECT DISTINCT {_SRC_STUDY_COLS} {_vf_join(vf_id)}'
                       'WHERE vs.studyinstanceuid = %s LIMIT 2', (folder_study_uid,))
    return rows


def vf_source_series(conn, vf_id, folder_series_uid):
    return query(conn, 'SELECT DISTINCT se.series_pkey, se.study_pkey, se.seriesinstanceuid, se.modality, '
                       f'se.datastore_id {_vf_join(vf_id)}WHERE vse.seriesinstanceuid = %s LIMIT 2',
                 (folder_series_uid,))


# --- imports ----------------------------------------------------------------

def insert_import(conn, imp, files):
    conn.begin()
    try:
        execute(conn, (
            'INSERT INTO non_dicom_imports (id, datastore_id, status, status_description, version, '
            'destination_kind, virtual_folder_id, content_not_deid_ack, s3_input_keys, patient_attrs, '
            'study_attrs, series_assignments, created_by) '
            "VALUES (%s, %s, 'SUBMITTED', NULL, 2, %s, %s, %s, %s, %s, %s, %s, %s)"),
            (imp['id'], imp['datastore_id'], imp['destination_kind'], imp['virtual_folder_id'],
             bool(imp['ack']), json.dumps(imp['s3_input_keys']), json.dumps(imp['patient_attrs']),
             json.dumps(imp['study_attrs']), json.dumps(imp['series_assignments']), imp['created_by']))
        executemany(conn, (
            'INSERT INTO non_dicom_import_files (id, import_id, file_index, file_name, s3_key, '
            'content_type, size_bytes, modality, series_instance_uid, document_title, content_date, '
            'institution_name, video_width, video_height, number_of_frames, frame_time, status) '
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'PENDING')"),
            [(f['id'], imp['id'], f['file_index'], f['file_name'], f['s3_key'], f['content_type'],
              f['size_bytes'], f['modality'], f['series_instance_uid'], f['document_title'] or None,
              f['content_date'] or None, f['institution_name'] or None, f.get('video_width'),
              f.get('video_height'), f.get('number_of_frames'), f.get('frame_time')) for f in files])
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def mark_files_failed(conn, file_ids, message):
    if not file_ids:
        return
    ph = ','.join(['%s'] * len(file_ids))
    execute(conn, f"UPDATE non_dicom_import_files SET status = 'FAILED', error_message = %s "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                  f"WHERE id IN ({ph})", (message, *file_ids))


IMPORT_COLS = ('id, datastore_id, status, version, destination_kind, virtual_folder_id, '
               'content_not_deid_ack, study_attrs, series_assignments, created_by, created_at')


def get_import(conn, import_id):
    rows = query(conn, f'SELECT {IMPORT_COLS} FROM non_dicom_imports WHERE id = %s AND version = 2',  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                 (import_id,))
    return rows[0] if rows else None


def get_files(conn, import_id):
    return query(conn, 'SELECT id, file_index, file_name, status, sop_instance_uid, series_instance_uid, '
                       'error_message FROM non_dicom_import_files WHERE import_id = %s ORDER BY file_index',
                 (import_id,))


def mark_indexed(conn, datastore_id, files):
    """WRITTEN -> INDEXED for files whose SOP Instance UID is in `instance`.
    Returns the set of file ids updated."""
    written = {f['sop_instance_uid']: f['id'] for f in files
               if f['status'] == 'WRITTEN' and f.get('sop_instance_uid')}
    if not written:
        return set()
    uids = list(written)
    ph = ','.join(['%s'] * len(uids))
    rows = query(conn, f'SELECT sopinstanceuid FROM instance WHERE datastore_id = %s AND deleted_at IS NULL '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                       f'AND sopinstanceuid IN ({ph})', (datastore_id, *uids))
    found = [written[r['sopinstanceuid']] for r in rows if r['sopinstanceuid'] in written]
    if found:
        ph = ','.join(['%s'] * len(found))
        execute(conn, f"UPDATE non_dicom_import_files SET status = 'INDEXED' "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                      f"WHERE status = 'WRITTEN' AND id IN ({ph})", tuple(found))
    return set(found)


def set_import_status(conn, import_id, status):
    execute(conn, 'UPDATE non_dicom_imports SET status = %s WHERE id = %s AND status <> %s',
            (status, import_id, status))


def list_imports(conn, created_by=None, limit=50):
    where = 'WHERE i.version = 2'
    params = []
    if created_by is not None:
        where += ' AND i.created_by = %s'
        params.append(created_by)
    return query(conn, f'SELECT {", ".join("i." + c.strip() for c in IMPORT_COLS.split(","))}, '  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
                       '(SELECT COUNT(*) FROM non_dicom_import_files f WHERE f.import_id = i.id) AS file_count '
                       f'FROM non_dicom_imports i {where} ORDER BY i.created_at DESC LIMIT {int(limit)}',
                 params)
