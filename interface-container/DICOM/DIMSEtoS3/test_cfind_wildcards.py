"""C-FIND -> QIDO parameter conversion keeps DICOM wildcards.

Regression: '*' and '?' were rewritten to SQL '%' / '_' before the QIDO call,
so dicomweb-s3 (which takes DICOM wildcard syntax, PS3.18 8.3.4.6) matched the
literal characters and every wildcard C-FIND returned no studies.
"""
from pydicom.dataset import Dataset

import cfind_handler


def _params(**attrs):
    h = cfind_handler.CFindHandler.__new__(cfind_handler.CFindHandler)
    h.attribute_mapping = {'PatientID': 'PatientID', 'PatientName': 'PatientName',
                           'StudyDescription': 'StudyDescription'}
    ds = Dataset()
    for k, v in attrs.items():
        setattr(ds, k, v)
    return h._convert_dicom_to_qido_params(ds, 'STUDY')


def test_star_wildcard_is_passed_through():
    assert _params(PatientID='C1E2E*')['PatientID'] == 'C1E2E*'


def test_question_mark_wildcard_is_passed_through():
    assert _params(PatientName='DOE^J?HN')['PatientName'] == 'DOE^J?HN'


def test_no_sql_wildcards_are_introduced():
    p = _params(PatientID='*', StudyDescription='CT*HEAD?')
    assert '%' not in ''.join(p.values()) and '_' not in ''.join(p.values())


def test_empty_attributes_are_not_sent():
    assert 'PatientID' not in _params(PatientID='')
