"""De-identification security tests for the vf-deid-consumer.

D-5: a REMOVE/EMPTY rule must store NULL, never the source value.
D-3: the folder tree must not receive any original identifier at all; the
     patient row is keyed on an opaque HMAC that matches the JS indexer.

Run (after sync-shared.sh): python -m pytest tests/
"""
import datetime
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault('DEID_HASH_PEPPER_SECRET_NAME', 'test')

import handler  # noqa: E402

VF = '11111111-1111-1111-1111-111111111111'
SRC = {
    'content_pkey': 7, 'instance_pkey': 70,
    'patientid': 'MRN-1234567', 'patientname': 'DOE^JANE', 'patientbirthdate': datetime.date(1961, 3, 4),
    'patientsex': 'F', 'issuerofpatientid': 'HOSP',
    'studyinstanceuid': '1.2.3', 'studydate': datetime.date(2020, 5, 6), 'studytime': None,
    'accessionnumber': 'ACC-998877', 'studyid': 'S1', 'studydescription': 'CT CHEST JANE DOE',
    'referringphysicianname': 'SMITH^JOHN', 'modalitiesinstudy': 'CT',
    'seriesinstanceuid': '1.2.3.4', 'modality': 'CT', 'seriesdescription': 'AXIAL', 'seriesnumber': '1',
    'sopinstanceuid': '1.2.3.4.5', 'sopclassuid': '1.2.840.10008.5.1.4.1.1.2', 'instancenumber': 1,
}
IDENTIFIERS = ['MRN-1234567', 'DOE^JANE', '1961-03-04', '19610304', 'ACC-998877', 'CT CHEST JANE DOE', 'SMITH^JOHN', '2020-05-06']


class FakeConn:
    def __init__(self):
        self.writes = []

    def commit(self):
        pass


def _run(tag_actions, monkeypatch):
    conn = FakeConn()
    handler._PEPPER = 'pepper-secret'
    handler._TREE_CURRENT.add(handler._vf_db_name(VF))
    monkeypatch.setattr(handler, '_load_profile',
                        lambda c, v: (handler.vf_deid.build_action_index(tag_actions), v))
    monkeypatch.setattr(handler, '_dict_all', lambda c, sql, p: [dict(SRC)])
    monkeypatch.setattr(handler, '_dict_one', lambda c, sql, p: {'patient_pkey': 1, 'study_pkey': 2, 'series_pkey': 3})
    monkeypatch.setattr(handler, '_exec', lambda c, sql, p: conn.writes.append((sql, p)))
    handler._process_deid(conn, VF, 'ds-1', '1.2.3.4', '1.2.3')
    return conn.writes


def _insert(writes, table):
    return next(p for sql, p in writes if 'INSERT INTO' in sql and f'_{table}`' in sql)


ALL_REMOVE = [{'tag': t, 'action': 'REMOVE'} for t in
              ('00100010', '00100020', '00100030', '00080050', '00080020', '00081030', '00080090')]


def test_remove_stores_null_not_the_source(monkeypatch):
    w = _run(ALL_REMOVE, monkeypatch)
    pat = _insert(w, 'patient')   # source_key, issuer, ds, patientid, patientname, birthdate, sex
    assert pat[3] is None and pat[4] is None and pat[5] is None
    st = _insert(w, 'study')      # patient_pkey, ds, uid, accession, studyid, studydate, desc, referring, mods
    assert st[3] is None and st[5] is None and st[6] is None and st[7] is None


def test_no_original_identifier_reaches_the_tree(monkeypatch):
    for actions in (ALL_REMOVE, [{'tag': '00100020', 'action': 'HASH_16'}, {'tag': '00100010', 'action': 'EMPTY'},
                                 {'tag': '00100030', 'action': 'SHIFT_DATE', 'shiftDaysMin': 5, 'shiftDaysMax': 9},
                                 {'tag': '00080050', 'action': 'HASH'}, {'tag': '00080020', 'action': 'REMOVE'},
                                 {'tag': '00081030', 'action': 'REPLACE', 'replacement': 'X'},
                                 {'tag': '00080090', 'action': 'REMOVE'}]):
        dumped = repr(_run(actions, monkeypatch))
        for ident in IDENTIFIERS:
            assert ident not in dumped, (ident, actions)
        assert 'original_' not in dumped


def test_keep_without_rule_still_stores_values_including_dates(monkeypatch):
    pat = _insert(_run([], monkeypatch), 'patient')
    assert pat[3] == 'MRN-1234567' and pat[5] == '1961-03-04'


def test_patient_key_matches_js_indexer():
    handler._PEPPER = 'pep'
    # Value produced by sourcePatientKey('pep', VF, 'PID1', 'ISS') in vf-tree-ddl.js.
    assert handler._source_patient_key(VF, 'PID1', 'ISS') == \
        'c7060a133c71a03d7e1a4bb67be99a7f2521b2d8fc98c92d7db069d4cd201523'


def test_missing_pepper_fails_closed(monkeypatch):
    handler._PEPPER = None
    monkeypatch.delenv('DEID_HASH_PEPPER_SECRET_NAME', raising=False)
    try:
        handler._source_patient_key(VF, 'PID1', '')
    except RuntimeError:
        return
    raise AssertionError('expected a refusal without the pepper')


def test_hash_salt_is_peppered_like_the_retrieve_path(monkeypatch):
    # D-6: the consumer must hash with the same "{pepper}:{vf_id}" salt as the
    # indexer and the DICOMweb retrieve path, or QIDO and WADO disagree.
    handler._PEPPER = 'pep'
    handler._profile_cache.clear()
    monkeypatch.setattr(handler, '_dict_one', lambda c, sql, p: {'tag_actions': '[]'})
    _, salt = handler._load_profile(None, VF)
    assert salt == f'pep:{VF}'
    monkeypatch.setenv('DEID_HASH_PEPPER', 'pep')
    handler.vf_deid._PEPPER_CACHE = None
    assert salt == handler.vf_deid.effective_salt(VF)
