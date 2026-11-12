import datetime

import pytest

import extraction as ex

TODAY = datetime.date(2026, 10, 13)


@pytest.mark.parametrize('raw,expected', [
    ('DOE^JANE', 'DOE^JANE'),
    ('doe^jane^marie', 'DOE^JANE^MARIE'),
    ('Jane Doe', 'DOE^JANE'),
    ('Jane Marie Doe', 'DOE^JANE^MARIE'),
    ('Doe, Jane', 'DOE^JANE'),
    ('Doe, Jane Marie', 'DOE^JANE^MARIE'),
    ('Mrs. Jane Doe', 'DOE^JANE'),
    ('Dr Jean-Luc Picard', 'PICARD^JEAN-LUC'),
    ('  Jane    Doe  ', 'DOE^JANE'),
    ('Müller, Jürgen', 'MÜLLER^JÜRGEN'),
    ('DOE^JANE=ドウ^ジェーン', 'DOE^JANE'),
    ('DOE^JANE^^^', 'DOE^JANE'),
    ('Cher', 'CHER'),
    ('', None),
    ('Mr.', None),
    (None, None),
])
def test_normalise_pn(raw, expected):
    assert ex.normalise_pn(raw) == expected


def test_pn_length_cap_and_backslash():
    pn = ex.normalise_pn('A' * 100 + '^B')
    assert len(pn) <= 64
    assert '\\' not in ex.normalise_pn('DOE\\JANE')


@pytest.mark.parametrize('raw,expected', [
    ('19800101', '19800101'),
    ('1980-01-31', '19800131'),
    ('1980/1/2', '19800102'),
    ('31/01/1980', '19800131'),   # day first (31 > 12)
    ('01/31/1980', '19800131'),   # month first (31 > 12)
    ('05.05.1980', '19800505'),   # equal, unambiguous
    ('03/04/1980', None),         # ambiguous: refused, not guessed
    ('12 March 1980', '19800312'),
    ('12-Mar-1980', '19800312'),
    ('March 12, 1980', '19800312'),
    ('Mar 2nd 1980', '19800302'),
    ('19801301', None),           # month 13
    ('20270101', None),           # in the future
    ('20261015', '20261015'),     # two days of time-zone slack
    ('18000101', None),           # before 1880
    ('yesterday', None),
    ('', None),
])
def test_normalise_da(raw, expected):
    assert ex.normalise_da(raw, today=TODAY) == expected


@pytest.mark.parametrize('raw,expected', [
    ('M', 'M'), ('f', 'F'), ('Female', 'F'), ('male', 'M'), ('Other', 'O'), ('femme', 'F'),
    ('unknown', None), ('', None), (None, None),
])
def test_normalise_sex(raw, expected):
    assert ex.normalise_sex(raw) == expected


def _model(fields):
    return {'fields': fields}


def test_normalise_full_output():
    out = ex.normalise(_model({
        'patientName': {'value': 'Jane Doe', 'confidence': 0.93, 'evidence': 'Patient: Jane Doe'},
        'patientId': {'value': ' MRN123 ', 'confidence': 0.9, 'evidence': 'MRN: MRN123'},
        'birthDate': {'value': '1980-01-01', 'confidence': 1, 'evidence': 'DOB 1980-01-01'},
        'sex': {'value': 'Female', 'confidence': 0.7, 'evidence': None},
        'accessionNumber': {'value': 'A' * 40, 'confidence': 0.6, 'evidence': 'x' * 500},
        'documentType': {'value': None, 'confidence': 0.0, 'evidence': None},
        'madeUpField': {'value': 'drop me', 'confidence': 1},
    }), today=TODAY)
    assert set(out) == set(ex.FIELD_NAMES)  # unknown key dropped, every known key present
    assert out['patientName'] == {'value': 'DOE^JANE', 'confidence': 0.93, 'evidence': 'Patient: Jane Doe'}
    assert out['patientId']['value'] == 'MRN123'
    assert out['birthDate']['value'] == '19800101'
    assert out['birthDate']['confidence'] == 1.0
    assert out['sex']['value'] == 'F'
    assert len(out['accessionNumber']['value']) == 16  # SH cap
    assert len(out['accessionNumber']['evidence']) == ex.EVIDENCE_MAX
    assert out['documentType'] is None
    assert out['institution'] is None


def test_validation_rejects_bad_types():
    with pytest.raises(ex.SchemaError):
        ex.validate({'nofields': {}})
    with pytest.raises(ex.SchemaError):
        ex.validate({'fields': []})
    with pytest.raises(ex.SchemaError):
        ex.validate(_model({'patientName': 'DOE^JANE'}))
    with pytest.raises(ex.SchemaError):
        ex.validate(_model({'patientName': {'value': ['x'], 'confidence': 0.5}}))
    with pytest.raises(ex.SchemaError):
        ex.validate(_model({'patientName': {'value': 'x', 'confidence': 'high'}}))
    with pytest.raises(ex.SchemaError):
        ex.validate(_model({'patientName': {'value': 'x', 'confidence': True}}))
    with pytest.raises(ex.SchemaError):
        ex.validate(_model({'patientName': {'value': 'x', 'confidence': 0.5, 'evidence': 3}}))
    with pytest.raises(ex.SchemaError):
        ex.validate(_model({'patientName': {'value': 'x', 'confidence': float('nan')}}))
    # 1.4 is out of range for the schema; normalise() never sees it unclamped
    with pytest.raises(ex.SchemaError):
        ex.validate(_model({'patientName': {'value': 'x', 'confidence': 1.4}}))


def test_validation_accepts_nulls_and_missing():
    assert ex.validate(_model({'patientName': None}))
    assert ex.validate(_model({}))
    assert ex.normalise(_model({})) == ex.empty_fields()


def test_ambiguous_date_becomes_not_found():
    out = ex.normalise(_model({'birthDate': {'value': '03/04/1980', 'confidence': 0.9}}), today=TODAY)
    assert out['birthDate'] is None


def test_numeric_values_are_accepted():
    out = ex.normalise(_model({'patientId': {'value': 123456, 'confidence': 0.8}}), today=TODAY)
    assert out['patientId']['value'] == '123456'


def test_parse_model_json():
    assert ex.parse_model_json('```json\n{"fields": {}}\n```') == {'fields': {}}
    assert ex.parse_model_json('Here you go: {"fields": {"a": 1}} done') == {'fields': {'a': 1}}
    for bad in ('', 'no json here', '{not json}', '[1, 2]', None):
        with pytest.raises(ex.SchemaError):
            ex.parse_model_json(bad)


def test_printed_identifiers_and_overall_confidence():
    fields = ex.empty_fields()
    fields['patientName'] = {'value': 'DOE^JANE', 'confidence': 0.9, 'evidence': None}
    fields['birthDate'] = {'value': '19800101', 'confidence': 0.5, 'evidence': None}
    fields['patientId'] = {'value': 'X', 'confidence': 0.49, 'evidence': None}
    fields['institution'] = {'value': 'General', 'confidence': 1.0, 'evidence': None}
    assert ex.printed_identifiers(fields) == ['patientName', 'birthDate']
    assert ex.overall_confidence(fields) == pytest.approx((0.9 + 0.5 + 0.49 + 1.0) / 4, abs=1e-3)
    assert ex.overall_confidence(ex.empty_fields()) == 0.0
