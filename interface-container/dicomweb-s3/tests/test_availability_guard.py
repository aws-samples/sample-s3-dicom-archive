"""(0008,0056) Instance Availability: the retrieve guard and what QIDO reports.

S3 lifecycle can move an object to an archive storage class underneath us. A
ranged GET against an archived object fails deep inside the frame reader, which
is the worst place for it to fail: the handler has already committed 200 and
written part of a multipart body, so the client sees a truncated study rather
than an error. Spec 6.3 therefore refuses up front, and spec 6.4 judges a whole
study or series before the first byte.

The matrix below is the spec's, not a paraphrase: the exact status, the exact
`Retry-After` seconds, the exact body text and `Content-Type: text/plain`. The
body strings are duplicated here on purpose — importing them from availability.py
would make the assertion agree with whatever the module says.

Two asymmetries are deliberate and each has a test:
  * `/metadata` stays 200 at every availability, because the metadata blob is a
    database row. It is what a viewer needs to render "archived, request restore"
    with real patient and study context.
  * the writer's series rollup is best-state-wins ("is any of this reachable")
    while the bulk-retrieve pre-check is worst-state-wins ("is all of it
    reachable"). Getting either one backwards is invisible until a client
    silently receives a short study.

ONLINE assertions on the rendered and bulk/* endpoints only check that the guard
did not fire, since what those handlers do afterwards belongs to their own tests.
"""

import importlib
import json
import sys

import pytest

from conftest import (DS_A, SERIES_PENDING_UID, SERIES_UID, SERIES_UID_2,
                      SOP_UID, SOP_UID_2, SOP_UID_3, STUDY_UID, base)

NEARLINE_BODY = ('instance is NEARLINE (restore in progress); '
                 'retry after the restore completes')
OFFLINE_BODY = ('instance is OFFLINE (archived); '
                'a restore must be requested before retrieval')

RETRY_NEARLINE = '300'
RETRY_OFFLINE = '3600'

INSTANCE = f'/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}'

# Spec 6.3 rows 8-10, 14, 17-20: everything that reaches the object.
GUARDED = [
    ('study-dicom', f'/studies/{STUDY_UID}'),
    ('series-dicom', f'/studies/{STUDY_UID}/series/{SERIES_UID}'),
    ('instance-dicom', INSTANCE),
    ('frames', f'{INSTANCE}/frames/1'),
    ('instance-rendered', f'{INSTANCE}/rendered'),
    ('frames-rendered', f'{INSTANCE}/frames/1/rendered'),
    ('bulk-element', f'/bulk/element/{SOP_UID}/00081140'),
    ('bulk-icc', f'/bulk/icc/{SOP_UID}'),
]

# The subset that must actually serve bytes when the instance is readable.
SERVES_BYTES = GUARDED[:4]

# Spec 6.3 rows 11-13: never guarded.
METADATA = [
    ('study-metadata', f'/studies/{STUDY_UID}/metadata'),
    ('series-metadata', f'/studies/{STUDY_UID}/series/{SERIES_UID}/metadata'),
    ('instance-metadata', f'{INSTANCE}/metadata'),
]

# NULL is the normal case: the plain DICOM ingest path never writes the column,
# and an empty CS column is an unset column, not a state.
READABLE_VALUES = [None, 'ONLINE', '']

# Anything the build does not recognize is OFFLINE, including a value that is
# only cased differently: assuming an unknown state is readable is the one
# failure mode that produces a corrupt study instead of an error.
OFFLINE_VALUES = ['OFFLINE', 'ARCHIVED_DEEP', 'online']


def refused(response, retry_after, body):
    assert response.status_code == 503
    assert response.headers['Retry-After'] == retry_after
    assert response.headers['Content-Type'] == 'text/plain'
    assert response.data.decode() == body
    return response


def guard_did_not_fire(response):
    assert response.status_code != 503
    assert 'Retry-After' not in response.headers
    return response


# ── The 6.3 matrix, endpoint by endpoint ─────────────────────────────────────
@pytest.mark.parametrize('name,path', GUARDED)
def test_nearline_is_refused_with_the_short_retry(get, two_datastores, name, path):
    two_datastores.set_availability(DS_A, SOP_UID, 'NEARLINE')
    refused(get(base() + path), RETRY_NEARLINE, NEARLINE_BODY)


@pytest.mark.parametrize('name,path', GUARDED)
@pytest.mark.parametrize('value', OFFLINE_VALUES)
def test_offline_and_unrecognized_are_refused_with_the_long_retry(
        get, two_datastores, name, path, value):
    two_datastores.set_availability(DS_A, SOP_UID, value)
    refused(get(base() + path), RETRY_OFFLINE, OFFLINE_BODY)


@pytest.mark.parametrize('name,path', GUARDED)
@pytest.mark.parametrize('value', READABLE_VALUES)
def test_a_readable_instance_is_not_guarded(get, two_datastores, name, path,
                                           value):
    # A guard that treats NULL as unknown refuses every instance in the archive,
    # since nothing but the archive path ever writes the column.
    if value is not None:
        two_datastores.set_availability(DS_A, SOP_UID, value)
    guard_did_not_fire(get(base() + path))


@pytest.mark.parametrize('name,path', SERVES_BYTES)
@pytest.mark.parametrize('value', READABLE_VALUES)
def test_a_readable_instance_still_serves_bytes(get, service, two_datastores,
                                               name, path, value):
    if value is not None:
        two_datastores.set_availability(DS_A, SOP_UID, value)
    response = get(base() + path)

    assert response.status_code == 200
    assert service.s3.get_calls, f'{name} served no object'


# ── /metadata is deliberately exempt ─────────────────────────────────────────
@pytest.mark.parametrize('name,path', METADATA)
@pytest.mark.parametrize('value', [None, 'ONLINE', 'NEARLINE', 'OFFLINE', 'BOGUS'])
def test_metadata_is_200_at_every_availability(get, service, two_datastores,
                                              name, path, value):
    if value is not None:
        two_datastores.set_availability(DS_A, SOP_UID, value)
    response = get(base() + path)

    assert response.status_code == 200
    assert response.headers['Content-Type'].startswith('application/dicom+json')
    assert json.loads(response.data), 'metadata must still describe the study'
    # The exemption is only defensible because metadata comes from the database.
    assert service.s3.get_calls == []


# ── No object read on a refusal ───────────────────────────────────────────────
@pytest.mark.parametrize('name,path', GUARDED)
@pytest.mark.parametrize('value', ['NEARLINE', 'OFFLINE'])
def test_a_refused_retrieve_never_touches_s3(get, service, two_datastores,
                                             name, path, value):
    # The whole point of the guard: an archived object must not be requested at
    # all. A ranged GET against a Glacier-class object is billed, logged, and
    # then fails several hundred lines into the response.
    two_datastores.set_availability(DS_A, SOP_UID, value)
    assert get(base() + path).status_code == 503
    assert service.s3.get_calls == []


# ── Spec 6.4: study- and series-level pre-check is worst-state-wins ──────────
def test_study_bulk_with_one_nearline_and_one_offline_member_reports_offline(
        get, service, two_datastores):
    two_datastores.set_availability(DS_A, SOP_UID, 'NEARLINE')
    two_datastores.set_availability(DS_A, SOP_UID_2, 'OFFLINE')

    response = refused(get(f'{base()}/studies/{STUDY_UID}'),
                       RETRY_OFFLINE, OFFLINE_BODY)
    # A partial multipart body is worse than an error: the client cannot tell a
    # short study from a complete one.
    assert b'--' not in response.data
    assert 'multipart' not in response.headers['Content-Type']
    assert service.s3.get_calls == []


def test_study_bulk_with_only_nearline_members_reports_nearline(
        get, two_datastores):
    for sop_uid in (SOP_UID, SOP_UID_2, SOP_UID_3):
        two_datastores.set_availability(DS_A, sop_uid, 'NEARLINE')

    refused(get(f'{base()}/studies/{STUDY_UID}'), RETRY_NEARLINE, NEARLINE_BODY)


def test_series_bulk_is_refused_when_any_member_is_unavailable(get,
                                                              two_datastores):
    # SOP_UID_2 is the other live instance of this series; SOP_UID stays ONLINE.
    two_datastores.set_availability(DS_A, SOP_UID_2, 'OFFLINE')

    refused(get(f'{base()}/studies/{STUDY_UID}/series/{SERIES_UID}'),
            RETRY_OFFLINE, OFFLINE_BODY)


def test_a_sibling_series_is_unaffected_by_an_archived_series(get, service,
                                                             two_datastores):
    two_datastores.set_availability(DS_A, SOP_UID, 'OFFLINE')
    two_datastores.set_availability(DS_A, SOP_UID_2, 'OFFLINE')

    response = get(f'{base()}/studies/{STUDY_UID}/series/{SERIES_UID_2}')
    assert response.status_code == 200
    assert service.s3.get_calls


def test_a_refused_retrieve_is_audited_with_the_availability(get, service,
                                                            two_datastores):
    # Spec 3.6: the refusal is an outcome, not a failure, so it is audited rather
    # than dropped — "why did this study stop rendering" is the question this
    # answers months later.
    two_datastores.set_availability(DS_A, SOP_UID, 'OFFLINE')
    get(base() + INSTANCE)

    details = service.events.details()
    assert len(details) == 1
    assert 'OFFLINE' in json.dumps(details[0])


# ── What QIDO reports ────────────────────────────────────────────────────────
def availability_of(payload, uid_tag, uid):
    for entry in payload:
        if entry[uid_tag]['Value'] == [uid]:
            return entry['00080056']['Value']
    raise AssertionError(f'{uid} was not discoverable')


def search(get, path):
    response = get(base() + path)
    assert response.status_code == 200
    return json.loads(response.data)


@pytest.mark.parametrize('value,reported', [
    (None, 'ONLINE'),          # COALESCE: a NULL column reports ONLINE
    ('ONLINE', 'ONLINE'),
    ('NEARLINE', 'NEARLINE'),
    ('OFFLINE', 'OFFLINE'),
])
def test_instance_search_reports_availability(get, two_datastores, value,
                                             reported):
    if value is not None:
        two_datastores.set_availability(DS_A, SOP_UID, value)
    payload = search(get, '/instances')

    assert availability_of(payload, '00080018', SOP_UID) == [reported]


@pytest.mark.parametrize('value,reported', [
    (None, 'ONLINE'),
    ('NEARLINE', 'NEARLINE'),
    ('OFFLINE', 'OFFLINE'),
])
def test_series_search_reports_availability(get, two_datastores, value, reported):
    if value is not None:
        two_datastores.set_series_availability(DS_A, SERIES_UID, value)
    payload = search(get, '/series')

    assert availability_of(payload, '0020000E', SERIES_UID) == [reported]


@pytest.mark.parametrize('series_states,reported', [
    ((None, None, 'OFFLINE'), 'ONLINE'),           # one readable series is enough
    (('NEARLINE', 'OFFLINE', 'OFFLINE'), 'NEARLINE'),
    (('OFFLINE', 'OFFLINE', 'OFFLINE'), 'OFFLINE'),
    (('ONLINE', 'NEARLINE', 'OFFLINE'), 'ONLINE'),
])
def test_study_search_rolls_up_best_state_wins(get, two_datastores,
                                              series_states, reported):
    # A study is worth opening if any of it can be read; a viewer that hides an
    # OFFLINE study hides the online series inside it.
    for series_uid, state in zip((SERIES_UID, SERIES_UID_2, SERIES_PENDING_UID),
                                 series_states):
        if state is not None:
            two_datastores.set_series_availability(DS_A, series_uid, state)
    payload = search(get, '/studies')

    assert availability_of(payload, '0020000D', STUDY_UID) == [reported]


def test_a_zero_instance_series_is_offline_but_still_discoverable(get,
                                                                 two_datastores):
    # An in-flight ingest: the series row exists, no instance has landed. Hiding
    # it makes the import look stalled; claiming ONLINE makes every retrieve fail.
    payload = search(get, '/series')

    assert availability_of(payload, '0020000E', SERIES_PENDING_UID) == ['OFFLINE']


def test_availability_is_not_a_searchable_key(get, two_datastores):
    """(0008,0056) is derived, so honoring it as a filter means an alias in WHERE
    and MySQL 1054. It is returned, never searched - and asking to search on it is
    refused rather than dropped, because dropping it answered
    `?InstanceAvailability=ONLINE` with the OFFLINE instances too."""
    two_datastores.set_availability(DS_A, SOP_UID, 'OFFLINE')
    response = get(base() + '/instances?InstanceAvailability=ONLINE')

    assert response.status_code == 400
    assert response.get_data(as_text=True) == \
        'Unsupported search key: InstanceAvailability'


def test_availability_is_still_reported_when_it_is_not_filtered_on(get,
                                                                  two_datastores):
    """The returned-attribute half, so the refusal above cannot be read as
    "availability is not part of the QIDO response"."""
    two_datastores.set_availability(DS_A, SOP_UID, 'OFFLINE')
    payload = search(get, '/instances')

    assert availability_of(payload, '00080018', SOP_UID) == ['OFFLINE']
    assert len(payload) == 3


# ── availability.py in isolation ─────────────────────────────────────────────
@pytest.mark.parametrize('value', [None, '', 'ONLINE'])
def test_is_readable_accepts_online_and_null(service, value):
    assert service.main.availability.is_readable(value) is True
    assert service.main.availability.unavailable_response(value) is None


@pytest.mark.parametrize('value', ['NEARLINE', 'OFFLINE', 'online', 'Offline',
                                   'RESTORING', 'unknown'])
def test_is_readable_rejects_everything_else(service, value):
    assert service.main.availability.is_readable(value) is False


@pytest.mark.parametrize('values,worst', [
    ([], None),
    ([None, 'ONLINE', ''], None),
    ([None, 'NEARLINE'], 'NEARLINE'),
    (['NEARLINE', 'NEARLINE'], 'NEARLINE'),
    ([None, 'OFFLINE'], 'OFFLINE'),
    (['NEARLINE', 'OFFLINE'], 'OFFLINE'),
    (['OFFLINE', 'NEARLINE'], 'OFFLINE'),
    (['ONLINE', 'WHO_KNOWS'], 'OFFLINE'),
])
def test_worst_availability(service, values, worst):
    assert service.main.availability.worst_availability(values) == worst


def test_worst_availability_accepts_a_generator(service):
    # The bulk pre-check passes a generator over the row set; consuming it twice
    # would silently judge nothing.
    rows = ({'availability': v} for v in ('ONLINE', 'NEARLINE'))
    worst = service.main.availability.worst_availability(
        row['availability'] for row in rows)
    assert worst == 'NEARLINE'


def test_retry_after_defaults_and_env_overrides(service, monkeypatch):
    module = service.main.availability
    assert module.RETRY_AFTER_NEARLINE == 300
    assert module.RETRY_AFTER_OFFLINE == 3600

    saved = sys.modules['availability']
    monkeypatch.setenv('AVAILABILITY_RETRY_AFTER_NEARLINE', '30')
    monkeypatch.setenv('AVAILABILITY_RETRY_AFTER_OFFLINE', '86400')
    del sys.modules['availability']
    try:
        reloaded = importlib.import_module('availability')
        assert reloaded.RETRY_AFTER_NEARLINE == 30
        assert reloaded.RETRY_AFTER_OFFLINE == 86400
        assert reloaded.unavailable_response('NEARLINE').headers['Retry-After'] == '30'
        assert reloaded.unavailable_response('OFFLINE').headers['Retry-After'] == '86400'
    finally:
        sys.modules['availability'] = saved
