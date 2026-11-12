"""QIDO-RS: response shape, the filter allowlists, paging, and tenancy.

Six routes share one builder (`_construct_query`), so most of what can go wrong
here goes wrong at every level at once. The tests are therefore parameterized
over the six levels wherever the property is level-independent — a scoping or
ORDER BY regression that only reaches one proto is exactly the kind of thing a
hand-written per-route test misses.

Two properties get more attention than their line count suggests:

  * **Every WHERE leads with a table-qualified datastore predicate, and
    `datastore_id` is the leading positional param.** A misordered params tuple
    does not raise: it compares a StudyInstanceUID against a datastore id and
    returns zero rows, which reads like an ingest failure rather than a bug.
  * **The response cache is keyed by datastore *and* by privilege.** Colliding
    UIDs across datastores are legal (the unique keys are composite), so a key
    that omits either component serves one tenant another tenant's PHI — and,
    for a privileged payload, the backing S3 object key with it.
"""

import datetime
import importlib
import json
import sys

import pytest

from conftest import (DS_A, DS_B, PATIENT_ID, PATIENT_NAME, SERIES_UID,
                      SERIES_UID_2, SERIES_PENDING_UID, SOP_UID, SOP_UID_2,
                      SOP_UID_3, SOP_UID_DELETED, STUDY_UID, base,
                      split_clauses)
from db_mappings import table_unique_keys, tables
from qido_search_tags import (SearchForInstancesTags, SearchForSeriesTags,
                              SearchForstudiesTags)

PRIVATE_S3KEY_TAG = '77771001'

# (level, path under /dicomweb/<ds>, the table whose datastore_id must come
# first, the number of datastore predicates the proto carries, the pkey the
# proto must order by).
LEVELS = [
    # Two datastore predicates: the study proto joins patient, which is
    # datastore-scoped too (uq_patient_ds_id), and scopes it explicitly.
    ('STUDY', '/studies', 'study', 2, 'study.study_pkey'),
    ('STUDY.SERIES', f'/studies/{STUDY_UID}/series', 'series', 2,
     'series.series_pkey'),
    # Three: the flat series proto joins study AND patient, so it can honor the
    # study-level filters (PatientID, AccessionNumber, ...) that SearchForSeries
    # accepts. Each joined table is datastore-scoped, so each gets a predicate.
    ('SERIES', '/series', 'series', 3, 'series.series_pkey'),
    # The UID-bearing instance levels scope the PARENTS (series, study) and not
    # instance.datastore_id, and carry no ORDER BY: both steer MySQL to resolve
    # the series by UID first and then use idx_instance_series, instead of walking
    # the shared instance primary key (main.py, _uid_bearing / order_clause).
    # Tenancy still holds: every instance row is joined to a scoped series.
    ('STUDY.INSTANCE', f'/studies/{STUDY_UID}/instances', 'series', 2, None),
    ('STUDY.SERIES.INSTANCE',
     f'/studies/{STUDY_UID}/series/{SERIES_UID}/instances', 'series', 2, None),
    ('INSTANCE', '/instances', 'instance', 3, 'instance.instance_pkey'),
]

_AUTH_TABLES = ('datastores', 'privilege_groups', 'users')

# A filter that is allowlisted at the level and matches nothing. Each level has
# its own allowlist, so PatientID is only honored at study level — asking for it
# lower down is silently dropped and would return the whole datastore.
NO_MATCH_QUERY = {
    'STUDY': 'PatientID=NO-SUCH-PATIENT',
    'STUDY.SERIES': 'SeriesInstanceUID=1.2.3.4.5.6.7.8.9',
    'SERIES': 'SeriesInstanceUID=1.2.3.4.5.6.7.8.9',
    'STUDY.INSTANCE': 'SOPInstanceUID=1.2.3.4.5.6.7.8.9',
    'STUDY.SERIES.INSTANCE': 'SOPInstanceUID=1.2.3.4.5.6.7.8.9',
    'INSTANCE': 'SOPInstanceUID=1.2.3.4.5.6.7.8.9',
}


def qido_query(service):
    """The QIDO SELECT from the request that just ran, as (sql, params).

    Authentication resolves the datastore and the caller's privileges first, so
    the handler's own query is always the last one logged. Asserting that it is
    not an auth query keeps a handler that never reached the database (a cache
    hit, or an early return) from silently passing an assertion about SQL text.
    """
    sql, params = service.conn.log[-1]
    for table in _AUTH_TABLES:
        assert table not in sql, \
            f'expected a QIDO query, got the {table} lookup: {sql[:120]}'
    return sql, params


def entries(response):
    assert response.status_code == 200
    assert response.headers['Content-Type'] == 'application/dicom+json'
    return json.loads(response.data)


def values(entry, tag):
    return entry[tag]['Value']


def uids_of(payload, tag):
    return [values(entry, tag)[0] for entry in payload]


# ── Response shape ───────────────────────────────────────────────────────────
@pytest.mark.parametrize('level,path,_table,_n,_order', LEVELS)
def test_every_level_returns_200_dicom_json(get, two_datastores, level, path,
                                            _table, _n, _order):
    response = get(base() + path)
    assert response.status_code == 200
    assert response.headers['Content-Type'] == 'application/dicom+json'
    assert isinstance(json.loads(response.data), list)


@pytest.mark.parametrize('level,path,_table,_n,_order', LEVELS)
def test_no_matches_is_200_and_an_empty_array_never_204(get, two_datastores,
                                                        level, path, _table,
                                                        _n, _order):
    # 204 is legal QIDO but OHIF and every other client we serve treat it as an
    # error rather than "no results", so this service always returns a body.
    response = get(f'{base()}{path}?{NO_MATCH_QUERY[level]}')
    assert response.status_code == 200
    assert json.loads(response.data) == []


def test_every_element_carries_a_value_list(get, two_datastores):
    payload = entries(get(base() + '/studies'))

    assert payload, 'the seeded study should be discoverable'
    for entry in payload:
        for tag, element in entry.items():
            assert 'Value' in element, f'{tag} has no Value key'
            assert isinstance(element['Value'], list)
            assert re_hex(tag)


def re_hex(tag):
    int(tag, 16)          # a DICOM-JSON key is 8 hex digits, nothing else
    return len(tag) == 8


def test_normalize_qido_entry_forces_an_empty_value_list(service):
    # pydicom emits {"vr": "DA"} for an empty element; OHIF reads .Value.length
    # blindly and throws on undefined.
    entry = service.main._normalize_qido_entry({
        '00080020': {'vr': 'DA'},
        '00100010': {'vr': 'PN', 'Value': ['Doe^Jane']},
        '00081190': {'vr': 'UR', 'BulkDataURI': 'http://example/bulk'},
    })

    assert entry['00080020'] == {'vr': 'DA', 'Value': []}
    assert entry['00100010']['Value'] == ['Doe^Jane']
    assert 'Value' not in entry['00081190'], 'a BulkDataURI element has no Value'


# ── Tenancy: the datastore predicate leads every WHERE ───────────────────────
@pytest.mark.parametrize('level,path,table,predicates,_order', LEVELS)
def test_datastore_predicate_is_the_first_conjunct_and_the_first_param(
        get, service, two_datastores, level, path, table, predicates, _order):
    get(base() + path)
    sql, params = qido_query(service)
    where = split_clauses(sql)['where']

    assert where.split(' AND ')[0].strip() == f'{table}.datastore_id = %s'
    assert where.count('datastore_id = %s') == predicates, \
        f'{level} should scope {predicates} table(s): {where}'
    # Every datastore predicate precedes every UID predicate in the proto, so the
    # leading params are the datastore id repeated. Any other order returns zero
    # rows instead of raising.
    assert params[:predicates] == (DS_A,) * predicates


@pytest.mark.parametrize('level,path,_table,_n,_order', LEVELS)
def test_a_query_scoped_to_one_datastore_never_returns_the_other_rows(
        get, service, two_datastores, level, path, _table, _n, _order):
    # Both datastores hold the same study, series and SOP UIDs, so row *count* is
    # the only thing that can distinguish them at these levels.
    a_count = len(entries(get(base(DS_A) + path, principal='reader_a')))
    b_count = len(entries(get(base(DS_B) + path, principal='reader_b')))

    assert a_count > 0 and b_count > 0
    # Datastore A additionally owns a zero-instance pending series, so the two
    # tenants are distinguishable at every series level and identical elsewhere.
    if 'SERIES' in level and 'INSTANCE' not in level:
        assert a_count == b_count + 1
    else:
        assert a_count == b_count


# ── Filter allowlists ────────────────────────────────────────────────────────
@pytest.mark.parametrize('tag,keyword', sorted(SearchForstudiesTags.items()))
def test_every_allowlisted_study_tag_reaches_the_where_clause(
        get, service, two_datastores, tag, keyword):
    get(f'{base()}/studies?{keyword}=zzz')
    sql, params = qido_query(service)

    from db_mappings import studyTagsTofields
    from qido_search_tags import _FILTER_EXISTS_SUBQUERIES
    exists_tpl = _FILTER_EXISTS_SUBQUERIES.get(('STUDY', tag))
    if exists_tpl is None:
        assert f'AND {studyTagsTofields[tag]} = %s' in sql
    else:
        # An EXISTS-translated tag must NOT compare the select-list alias its
        # result mapping names - that is the MySQL 1054 trap. The predicate goes
        # to the child table's real column, inside the subquery.
        assert f'{exists_tpl["column"]} = %s' in sql
        assert studyTagsTofields[tag] not in split_clauses(sql)['where']
    assert params[-1] == 'zzz'


@pytest.mark.parametrize('tag,keyword', sorted(SearchForSeriesTags.items()))
def test_every_allowlisted_series_tag_reaches_the_where_clause(
        get, service, two_datastores, tag, keyword):
    get(f'{base()}/studies/{STUDY_UID}/series?{keyword}=zzz')
    sql, params = qido_query(service)

    from db_mappings import seriesTagsTofields
    assert f'AND {seriesTagsTofields[tag]} = %s' in sql
    assert params[-1] == 'zzz'


@pytest.mark.parametrize('tag,keyword', sorted(SearchForInstancesTags.items()))
def test_every_allowlisted_instance_tag_reaches_the_where_clause(
        get, service, two_datastores, tag, keyword):
    get(f'{base()}/instances?{keyword}=zzz')
    sql, params = qido_query(service)

    from db_mappings import instanceTagsTofields
    assert f'AND {instanceTagsTofields[tag]} = %s' in sql
    assert params[-1] == 'zzz'


@pytest.mark.parametrize('query', [
    'PatientBirthDate=19700101',      # a real tag, deliberately not searchable
    'InstanceAvailability=ONLINE',    # (0008,0056) is returned, never searched
    '77771001=a/b.dcm',               # the private S3 key is never a filter
    'NumberOfStudyRelatedSeries=3',   # a computed alias, MySQL 1054 if honored
])
def test_an_unhonorable_dicom_attribute_is_refused_not_dropped(
        get, service, two_datastores, query):
    """Silently dropping an attribute *widens* the query.

    Each of these names a real DICOM attribute this level cannot filter on. Dropping
    it answered a one-patient question with the whole datastore under a 200, and the
    client had no way to tell which of its constraints had been honored. The refusal
    echoes the key so the client can retry without it, and never the value - a
    filter value is patient name, accession number or birth date.
    """
    key, value = query.split('=', 1)
    response = get(f'{base()}/studies?{query}')

    assert response.status_code == 400
    body = response.get_data(as_text=True)
    assert body == f'Unsupported search key: {key}'
    assert value not in body


@pytest.mark.parametrize('query', [
    '_=1699999999',                   # jQuery/axios cache-buster
    'drop=table',
    'viewerstate=abc',
])
def test_a_non_attribute_parameter_is_ignored_not_refused(
        get, service, two_datastores, query):
    """PS3.18 §8.3.4: an origin server ignores a parameter it does not recognize.

    The other half of the refuse-vs-ignore line. A parameter that is not a DICOM
    attribute was never going to narrow anything, so refusing it breaks working
    clients - cache-busters and vendor extensions all arrive here - for no safety
    gain. It is reported in a Warning header instead.
    """
    key = query.split('=')[0]
    response = get(f'{base()}/studies?{query}')
    sql, params = qido_query(service)

    assert response.status_code == 200
    # The bind list is the assertion that matters: an ignored parameter reaches
    # neither the SQL text nor the parameters. `_` is too short to substring-search
    # for (the computed aliases are all `_`-prefixed), so it rests on this alone.
    assert params == (DS_A, DS_A), 'an ignored parameter contributed a bind value'
    if len(key) > 2:
        assert key.lower() not in sql.lower()
    assert response.headers['Warning'].startswith('299 dicomweb-s3:')
    assert key in response.headers['Warning']


def test_a_filter_value_is_bound_never_interpolated(get, service, two_datastores):
    get(f"{base()}/studies?PatientID=' OR 1=1--")
    sql, params = qido_query(service)

    assert "OR 1=1" not in sql
    assert params == (DS_A, DS_A, "' OR 1=1--")


def test_dated_range_becomes_between(get, service, two_datastores):
    payload = entries(get(f'{base()}/studies?StudyDate=20240101-20240131'))
    sql, params = qido_query(service)

    assert 'AND studydate BETWEEN %s AND %s' in sql
    assert params == (DS_A, DS_A, '20240101', '20240131')
    assert len(payload) == 1, 'the seeded study is dated 20240115'


def test_dated_range_outside_the_data_matches_nothing(get, two_datastores):
    assert entries(get(f'{base()}/studies?StudyDate=20240201-20240228')) == []


def test_star_becomes_like_with_a_percent(get, service, two_datastores):
    payload = entries(get(f'{base()}/studies?PatientName=Do*'))
    sql, params = qido_query(service)

    assert 'AND patientname LIKE %s' in sql
    assert params == (DS_A, DS_A, 'Do%')
    assert values(payload[0], '00100010') == [{'Alphabetic': PATIENT_NAME}]


def test_comma_becomes_in(get, service, two_datastores):
    payload = entries(get(f'{base()}/studies?PatientID=NOBODY,{PATIENT_ID}'))
    sql, params = qido_query(service)

    assert 'AND patientid IN (%s,%s)' in sql
    assert params == (DS_A, DS_A, 'NOBODY', PATIENT_ID)
    assert len(payload) == 1


def test_plain_value_becomes_equals(get, service, two_datastores):
    entries(get(f'{base()}/studies?PatientID={PATIENT_ID}'))
    sql, params = qido_query(service)

    assert 'AND patientid = %s' in sql
    assert params == (DS_A, DS_A, PATIENT_ID)


STUDY_UID_MR = STUDY_UID + '.77'


def _study_with_only_modality(world, modality, study_uid, **series_extra):
    """Add a second DS_A study whose one series carries `modality`.

    The shared fixture holds exactly one study per datastore, and without a
    second one a ModalitiesInStudy filter cannot be shown to NARROW anything:
    "CT matched the only study" passes just as well when the filter is dropped
    entirely, which is the failure mode these tests exist to catch.
    """
    patient = world.conn.find('patient', datastore_id=DS_A, patientid=PATIENT_ID)
    study = world.conn.insert(
        'study', patient_pkey=patient['patient_pkey'], datastore_id=DS_A,
        studyinstanceuid=study_uid, studydate='20240116', studytime='11:00:00',
        accessionnumber='ACC-2', studydescription='OTHER STUDY', studyid='ST2')
    world.conn.insert(
        'series', study_pkey=study['study_pkey'], datastore_id=DS_A,
        seriesinstanceuid=study_uid + '.1', modality=modality, seriesdescription='OTHER',
        seriesnumber=1, **series_extra)
    return study


def test_modalities_in_study_filters_via_exists_rather_than_400ing(
        get, service, two_datastores):
    """(0008,0061) is honored as a filter, and all three wrong answers are excluded.

    It maps to the computed alias `_modalitiesinstudy`, and MySQL rejects a
    select-list alias in WHERE - so emitting it bare was a 500, and refusing the
    key 400'd the study list that OHIF and Weasis both send. Dropping it would
    be worst of all: `?ModalitiesInStudy=CT` would answer with the MR studies
    too, under a 200. The EXISTS translation targets the real
    `series.modality` column instead of the alias.
    """
    _study_with_only_modality(two_datastores, 'MR', STUDY_UID_MR)

    assert sorted(uids_of(entries(get(f'{base()}/studies')), '0020000D')) == \
        sorted([STUDY_UID, STUDY_UID_MR])

    mr = uids_of(entries(get(f'{base()}/studies?ModalitiesInStudy=MR')), '0020000D')
    sql, params = qido_query(service)
    assert mr == [STUDY_UID_MR]
    # The one study that has no MR series must be absent, not merely last.
    assert STUDY_UID not in mr
    assert 'EXISTS (SELECT 1 FROM series mis' in sql
    assert '_modalitiesinstudy' not in split_clauses(sql)['where']
    assert params[-1] == 'MR'

    ct = uids_of(entries(get(f'{base()}/studies?ModalitiesInStudy=CT')), '0020000D')
    assert ct == [STUDY_UID]


def test_modalities_in_study_keeps_the_list_and_wildcard_forms(get, two_datastores):
    """IN (...) and LIKE must survive the EXISTS wrapper.

    The wrapper is applied AFTER the comparison is built, so every operator
    lands inside the subquery. Wrapping first would silently reduce all of them
    to equality, and `?ModalitiesInStudy=CT,MR` would match nothing.
    """
    _study_with_only_modality(two_datastores, 'MR', STUDY_UID_MR)

    both = uids_of(entries(get(f'{base()}/studies?ModalitiesInStudy=CT,MR')), '0020000D')
    assert sorted(both) == sorted([STUDY_UID, STUDY_UID_MR])

    # The base study holds CT/SR/SM, so `M*` must match only the MR study - a
    # LIKE that leaked the wrapper would match on the wrong side.
    assert uids_of(entries(get(f'{base()}/studies?ModalitiesInStudy=M*')),
                   '0020000D') == [STUDY_UID_MR]


def test_modalities_in_study_ignores_a_soft_deleted_series(get, two_datastores):
    """The subquery carries its own `deleted_at IS NULL`.

    Without it a reaped series keeps contributing its modality, so a study whose
    only XA series was deleted would still answer `?ModalitiesInStudy=XA`.
    """
    _study_with_only_modality(two_datastores, 'XA', STUDY_UID_MR,
                              deleted_at=datetime.datetime(2024, 2, 1, 12, 0, 0))

    assert entries(get(f'{base()}/studies?ModalitiesInStudy=XA')) == []
    # The study row itself is not deleted, so it still lists unfiltered - the
    # filter is what must ignore it.
    assert STUDY_UID_MR in uids_of(entries(get(f'{base()}/studies')), '0020000D')


def test_series_level_modalities_in_study_asks_about_the_parent_study(
        get, two_datastores):
    """At SERIES level the tag still means "the STUDY contains this modality".

    That is deliberately not `?Modality=`: every live series of a CT-bearing
    study matches, including its SR and SM series.
    """
    _study_with_only_modality(two_datastores, 'MR', STUDY_UID_MR)

    matched = uids_of(entries(get(f'{base()}/series?ModalitiesInStudy=CT')), '0020000E')
    assert sorted(matched) == sorted([SERIES_UID, SERIES_UID_2, SERIES_PENDING_UID])
    assert uids_of(entries(get(f'{base()}/series?Modality=CT')), '0020000E') == \
        [SERIES_UID]


def test_modalities_in_study_is_still_returned_in_the_payload(get, two_datastores):
    """Filterable and returned are separate lists; it has to be in both."""
    payload = entries(get(f'{base()}/studies'))
    assert values(payload[0], '00080061')


def test_series_level_study_uid_filter_actually_filters(get, service,
                                                        two_datastores):
    # The reference dropped this filter and returned every series in the
    # datastore. (0020,000D) maps to the _studyinstanceuid alias at series level,
    # so it needs the qualified column from _FILTER_COLUMN_OVERRIDES.
    matched = entries(get(f'{base()}/series?StudyInstanceUID={STUDY_UID}'))
    sql, _ = qido_query(service)
    assert 'AND study.studyinstanceuid = %s' in sql
    assert len(matched) == 3

    assert entries(get(f'{base()}/series?StudyInstanceUID=1.2.3.4.999')) == []


# The study-level keys SearchForSeries accepts. None of them exists in
# `seriesTagsTofields`, so before _FILTER_COLUMN_OVERRIDES covered them the WHERE
# builder took its `tag not in tag_dict` branch and DROPPED the filter -
# `GET /series?PatientID=X` answered with every series in the datastore, under a
# 200. Within one datastore (the tenancy predicate still applied), but a wrong
# answer that reads like a right one.
SERIES_LEVEL_STUDY_FILTERS = [
    ('PatientID', 'NO-SUCH-PATIENT'),
    ('PatientName', 'NoSuchPerson'),
    ('AccessionNumber', 'NO-SUCH-ACCESSION'),
    ('StudyDate', '19000101'),
    ('StudyTime', '000000'),
    ('ReferringPhysicianName', 'NoSuchDoctor'),
    ('StudyDescription', 'NOSUCHDESCRIPTION'),
    ('StudyID', 'NO-SUCH-STUDY-ID'),
]


@pytest.mark.parametrize('keyword,unmatchable', SERIES_LEVEL_STUDY_FILTERS)
def test_series_level_study_filters_narrow_instead_of_being_dropped(
        get, service, keyword, unmatchable, two_datastores):
    """A value that matches nothing must return nothing, not everything."""
    assert entries(get(f'{base()}/series')), 'fixture must hold series to narrow'

    payload = entries(get(f'{base()}/series?{keyword}={unmatchable}'))
    sql, params = qido_query(service)
    assert payload == [], \
        f'{keyword} was dropped: {len(payload)} series returned for a value ' \
        'that matches no row'
    # Not just empty by accident: the value has to have reached the WHERE.
    assert unmatchable in params, f'{keyword} never became a bound param: {sql}'


@pytest.mark.parametrize('keyword,value', [
    ('PatientID', PATIENT_ID),
    ('AccessionNumber', 'ACC-2'),
    ('StudyID', 'ST2'),
])
def test_series_level_study_filters_still_match_what_they_should(
        get, two_datastores, keyword, value):
    """The mirror of the above: a filter that is always-empty is equally wrong.

    `ACC-2`/`ST2` belong only to the second study, so these also prove the
    predicate discriminates rather than matching every row.
    """
    _study_with_only_modality(two_datastores, 'MR', STUDY_UID_MR)
    matched = uids_of(entries(get(f'{base()}/series?{keyword}={value}')), '0020000E')

    assert matched, f'{keyword}={value} matched nothing'
    if keyword == 'PatientID':
        # Both studies hang off the one DS_A patient row.
        assert sorted(matched) == sorted(
            [SERIES_UID, SERIES_UID_2, SERIES_PENDING_UID, STUDY_UID_MR + '.1'])
    else:
        assert matched == [STUDY_UID_MR + '.1']


def test_an_unmappable_allowlisted_filter_is_a_400_not_a_500_or_a_widened_200(
        get, service, monkeypatch, two_datastores):
    """The gate itself, exercised by forcing the drift it exists to catch.

    Every allowlisted tag is mappable today, so the gate never fires and its
    removal breaks nothing - this simulates a tag added to an allowlist without
    a column mapping. 400 is the required answer: emitting the alias bare is a
    MySQL 1054 (a 500), and skipping the predicate returns every study in the
    datastore under a 200.

    (0008,0056) is the honest stand-in - it maps to the `_availability` alias at
    every level and is deliberately in no allowlist.
    """
    monkeypatch.setitem(SearchForstudiesTags, '00080056', 'InstanceAvailability')

    response = get(f'{base()}/studies?InstanceAvailability=ONLINE')

    assert response.status_code == 400, \
        f'unmappable filter answered {response.status_code}'
    assert response.get_data(as_text=True) == \
        'Unsupported search key: InstanceAvailability'


def test_every_allowlisted_filter_is_mappable_at_every_level(service):
    """The two gates must not drift apart again.

    The allowlists say what a client may SEND; `filter_is_mappable` says what
    the WHERE builder can EMIT. When these drifted, the failure was silent and
    one-directional: an unmappable filter was skipped, which WIDENS the result
    set instead of narrowing it. This asserts the property directly, so a tag
    added to an allowlist without a column mapping fails here rather than in
    production.
    """
    from qido_search_tags import filter_is_mappable
    main = service.main

    for level, _path, _table, _n, _order in LEVELS:
        results = main._result_tag_dict(level)
        for tag in main._filter_tag_dict(level):
            assert filter_is_mappable(level, tag, results), \
                f'{level}: {tag} is allowlisted but the WHERE builder cannot map it'


# ── limit / offset ───────────────────────────────────────────────────────────
def limit_clause(service):
    return split_clauses(qido_query(service)[0])['limit']


def test_absent_limit_falls_back_to_the_default(get, service, two_datastores):
    get(base() + '/studies')
    assert limit_clause(service) == f'0, {service.main.QIDO_DEFAULT_LIMIT}'


def test_limit_pages_the_result_set(get, service, two_datastores):
    payload = entries(get(f'{base()}/series?limit=2'))
    assert limit_clause(service) == '0, 2'
    assert uids_of(payload, '0020000E') == [SERIES_UID, SERIES_UID_2]


def test_offset_pages_deterministically(get, service, two_datastores):
    payload = entries(get(f'{base()}/series?limit=1&offset=1'))
    assert limit_clause(service) == '1, 1'
    assert uids_of(payload, '0020000E') == [SERIES_UID_2]


def test_offset_past_the_end_is_an_empty_array(get, two_datastores):
    assert entries(get(f'{base()}/series?limit=5&offset=50')) == []


@pytest.mark.parametrize('raw', ['99999', '1001'])
def test_limit_is_clamped_to_the_configured_maximum(get, service,
                                                    two_datastores, raw):
    get(f'{base()}/studies?limit={raw}')
    assert limit_clause(service) == f'0, {service.main.QIDO_MAX_LIMIT}'


@pytest.mark.parametrize('raw', ['0', '-5', 'abc', ''])
def test_a_useless_limit_falls_back_to_the_default(get, service,
                                                  two_datastores, raw):
    get(f'{base()}/studies?limit={raw}')
    assert limit_clause(service) == f'0, {service.main.QIDO_DEFAULT_LIMIT}'


@pytest.mark.parametrize('raw', ['-5', 'abc', ''])
def test_a_useless_offset_becomes_zero(get, service, two_datastores, raw):
    get(f'{base()}/studies?offset={raw}')
    assert limit_clause(service).startswith('0, ')


def test_max_limit_env_knob_is_what_clamps(get, service, two_datastores,
                                           monkeypatch):
    monkeypatch.setattr(service.main, 'QIDO_MAX_LIMIT', 2)
    payload = entries(get(f'{base()}/series?limit=50'))

    assert limit_clause(service) == '0, 2'
    assert len(payload) == 2


def test_default_limit_env_knob_is_what_applies_with_no_limit(
        get, service, two_datastores, monkeypatch):
    monkeypatch.setattr(service.main, 'QIDO_DEFAULT_LIMIT', 1)
    payload = entries(get(f'{base()}/series'))

    assert limit_clause(service) == '0, 1'
    assert len(payload) == 1


def test_qido_limit_env_vars_are_read_at_import(service, monkeypatch):
    """The two knobs come from the env, with the spec's 1000/1000 defaults.

    Re-imported rather than subprocessed: conftest's stubs are already installed
    in this interpreter, and a subprocess would need pymysql and boto3 for real.
    The freshly built module is discarded; sys.modules keeps the fixture's.
    """
    assert service.main.QIDO_DEFAULT_LIMIT == 1000
    assert service.main.QIDO_MAX_LIMIT == 1000

    saved = sys.modules['main']
    monkeypatch.setenv('QIDO_DEFAULT_LIMIT', '7')
    monkeypatch.setenv('QIDO_MAX_LIMIT', '9')
    del sys.modules['main']
    try:
        reloaded = importlib.import_module('main')
        assert reloaded.QIDO_DEFAULT_LIMIT == 7
        assert reloaded.QIDO_MAX_LIMIT == 9
    finally:
        sys.modules['main'] = saved


@pytest.mark.parametrize('level,path,_table,_n,order', LEVELS)
def test_paging_order_is_the_result_tables_pkey(get, service, two_datastores,
                                                level, path, _table, _n, order):
    # LIMIT/OFFSET without a total order lets a client see a row twice, or never.
    get(base() + path)
    clauses = split_clauses(qido_query(service)[0])
    if order is None:
        # A single study/series' instances: one page in practice, unordered on purpose.
        assert 'order' not in clauses
        return
    assert clauses['order'] == order
    table, _, pkey = order.partition('.')
    assert tables[f'{table}_table'] == table
    assert table_unique_keys[f'{table}_table'] == pkey


# ── Derived attributes and parent UIDs ───────────────────────────────────────
def test_study_level_derived_counts_and_modalities(get, two_datastores):
    study = entries(get(base() + '/studies'))[0]

    # Three live series (CT, SR, and the zero-instance pending SM series), three
    # live instances: the soft-deleted one must not inflate either count.
    assert values(study, '00201206') == [3]
    assert values(study, '00201208') == [3]
    assert values(study, '00080061') == ['CT', 'SM', 'SR']


def test_study_level_derived_counts_are_datastore_scoped(get, two_datastores):
    study_b = entries(get(base(DS_B) + '/studies', principal='reader_b'))[0]

    assert values(study_b, '00201206') == [2]
    assert values(study_b, '00201208') == [3]
    assert values(study_b, '00080061') == ['CT', 'SR']


def test_series_level_instance_count(get, two_datastores):
    by_uid = {values(e, '0020000E')[0]: e
              for e in entries(get(base() + '/series'))}

    assert values(by_uid[SERIES_UID], '00201209') == [2]      # one is deleted
    assert values(by_uid[SERIES_UID_2], '00201209') == [1]
    # A series whose instances have not landed yet is still discoverable, with an
    # honest count of zero rather than an absent attribute.
    assert values(by_uid[SERIES_PENDING_UID], '00201209') == [0]


@pytest.mark.parametrize('path', ['/series', f'/studies/{STUDY_UID}/series'])
def test_series_results_carry_the_parent_study_uid(get, two_datastores, path):
    # PS3.18 requires it; the reference emitted no StudyInstanceUID at all.
    for entry in entries(get(base() + path)):
        assert values(entry, '0020000D') == [STUDY_UID]


@pytest.mark.parametrize('path', [
    '/instances',
    f'/studies/{STUDY_UID}/instances',
    f'/studies/{STUDY_UID}/series/{SERIES_UID}/instances',
])
def test_instance_results_carry_both_parent_uids(get, two_datastores, path):
    payload = entries(get(base() + path))

    assert payload
    for entry in payload:
        assert values(entry, '0020000D') == [STUDY_UID]
        assert values(entry, '0020000E')[0] in (SERIES_UID, SERIES_UID_2)


def test_soft_deleted_instances_are_invisible(get, two_datastores):
    payload = entries(get(base() + '/instances'))
    assert uids_of(payload, '00080018') == [SOP_UID, SOP_UID_2, SOP_UID_3]
    assert SOP_UID_DELETED not in uids_of(payload, '00080018')


def test_series_scoped_instance_search_returns_only_that_series(get,
                                                                two_datastores):
    payload = entries(
        get(f'{base()}/studies/{STUDY_UID}/series/{SERIES_UID}/instances'))
    assert uids_of(payload, '00080018') == [SOP_UID, SOP_UID_2]


def test_includefield_all_is_accepted(get, two_datastores):
    # Every mapped tag is already returned, so `includefield=all` is a no-op —
    # but it must not 500, because viewers send it unconditionally.
    assert len(entries(get(f'{base()}/studies?includefield=all'))) == 1


# ── Cache keying ─────────────────────────────────────────────────────────────
@pytest.fixture
def qido_cache_on(service, monkeypatch):
    """The QIDO cache is off by default (QIDO_CACHE_TTL=0, 503fc37: newly stored
    instances must show on the next refresh). These tests are about how it keys
    entries when an operator turns it on."""
    monkeypatch.setattr(service.main, 'QIDO_CACHE_ENABLED', True)
    service.main.qido_cache.clear()
    return service


def test_the_qido_cache_is_off_by_default(get, service, two_datastores):
    get(base() + '/studies')
    get(base() + '/studies')
    assert len(service.main.qido_cache) == 0
    assert sum('FROM study' in sql for sql, _ in service.conn.log) == 2


def test_cache_key_leads_with_the_datastore_id(service):
    key = service.main._qido_cache_key(DS_A, None, False, 'STUDY', {}, b'limit=10')
    assert key.startswith(f'{DS_A}|')


def test_cache_key_differs_by_datastore_and_by_privilege(service):
    key = service.main._qido_cache_key
    baseline = key(DS_A, None, False, 'INSTANCE', {}, b'')

    assert key(DS_B, None, False, 'INSTANCE', {}, b'') != baseline
    assert key(DS_A, None, True, 'INSTANCE', {}, b'') != baseline
    # A virtual-folder request never shares an entry with its source datastore's.
    assert key(DS_A, 'vf-1', False, 'INSTANCE', {}, b'') != baseline


def test_identical_query_strings_do_not_share_a_payload_across_datastores(
        get, service, two_datastores, qido_cache_on):
    # The two datastores hold the same SOP UIDs, so the only visible difference is
    # the S3 key the privileged payload carries. A cache key without the
    # datastore id would serve tenant B tenant A's object keys for up to 30 s.
    a_keys = [values(e, PRIVATE_S3KEY_TAG)[0]
              for e in entries(get(base(DS_A) + '/instances', principal='admin'))]
    b_keys = [values(e, PRIVATE_S3KEY_TAG)[0]
              for e in entries(get(base(DS_B) + '/instances', principal='admin'))]

    assert all(k.startswith(DS_A[:8] + '/') for k in a_keys)
    assert all(k.startswith(DS_B[:8] + '/') for k in b_keys)
    assert len(service.main.qido_cache) == 2


def test_privileged_and_unprivileged_callers_do_not_share_a_payload(
        get, service, two_datastores, qido_cache_on):
    path = base(DS_A) + '/instances'
    privileged = entries(get(path, principal='admin'))
    unprivileged = entries(get(path, principal='reader_a'))

    assert all(PRIVATE_S3KEY_TAG in entry for entry in privileged)
    assert not any(PRIVATE_S3KEY_TAG in entry for entry in unprivileged)
    assert len(service.main.qido_cache) == 2


def test_a_repeated_identical_query_is_served_from_the_cache(get, service,
                                                            two_datastores, qido_cache_on):
    first = entries(get(base() + '/studies'))
    queries = len(service.conn.log)
    second = entries(get(base() + '/studies'))

    assert first == second
    # Auth still runs (it must: privileges can be revoked mid-TTL); the QIDO
    # SELECT does not.
    assert not any('FROM study' in sql for sql, _ in service.conn.log[queries:])


# ── _serialize_value ─────────────────────────────────────────────────────────
def test_serialize_value_date_becomes_dicom_da(service):
    assert service.main._serialize_value(datetime.date(2024, 1, 15)) == '20240115'
    assert service.main._serialize_value(
        datetime.datetime(2024, 1, 15, 10, 15)) == '20240115'


def test_serialize_value_timedelta_becomes_dicom_tm(service):
    serialize = service.main._serialize_value
    assert serialize(datetime.timedelta(hours=10, minutes=15)) == '101500.000000'
    assert serialize(datetime.timedelta(seconds=0)) == '000000.000000'
    assert serialize(
        datetime.timedelta(hours=1, seconds=2, microseconds=345678)) == '010002.345678'


def test_serialize_value_bytes_become_utf8(service):
    serialize = service.main._serialize_value
    assert serialize(b'CT\\MR') == 'CT\\MR'
    assert serialize(bytearray(b'SM')) == 'SM'
    # Never raises: a GROUP_CONCAT over mixed collations can hand back bad bytes,
    # and one bad series description must not 500 a whole study search.
    assert serialize(b'\xff\xfe') == '��'


def test_serialize_value_passes_everything_else_through(service):
    serialize = service.main._serialize_value
    assert serialize(3) == 3
    assert serialize('CT') == 'CT'
    assert serialize(None) is None
