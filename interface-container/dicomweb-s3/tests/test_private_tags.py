"""Private S3-location tags: bucket and key reach admins only.

(7777,1001) key + (7777,1002) bucket is everything a caller needs to read the
object straight out of the archive bucket, bypassing this service and therefore
bypassing its datastore-scope check and its audit trail. So the privilege that
gates them is the one that permits reconfiguring a datastore
(management_privileges.datastores.canEdit), not read access to its data: both
seeded groups hold datastoreId '*' with all four data privileges, so no data
privilege can tell an admin from a data user.

Three independent gates, tested independently, because any one of them being the
only gate is a single point of failure:

  1. SQL - the `_s3bucket`/`_s3key` columns and the `LEFT JOIN Instancelocation`
     are not emitted at all for an unprivileged caller, so the values never leave
     the database;
  2. the injector - `_add_private_s3_location` takes `include_s3_location`
     positionally with no default;
  3. `filter_private_tags` - a final sweep of every 0x7777 element off the
     assembled entry.
"""

import pytest

from conftest import (
    BUCKET_A, BUCKET_B, DS_A, DS_B, PRIVATE_CREATOR_TAG, PRIVATE_S3BUCKET_TAG,
    PRIVATE_S3KEY_TAG, SERIES_UID, SOP_UID, STUDY_UID, base,
)

PRIVATE_TAGS = (PRIVATE_CREATOR_TAG, PRIVATE_S3KEY_TAG, PRIVATE_S3BUCKET_TAG)

INSTANCE_LEVEL_PATHS = [
    "/instances",
    f"/studies/{STUDY_UID}/instances",
    f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances",
]
PARENT_LEVEL_PATHS = [
    "/studies",
    "/series",
    f"/studies/{STUDY_UID}/series",
]

# Every caller the middleware admits without the storage-location privilege.
UNPRIVILEGED_CALLERS = ["reader_a", "reader_star", "mgmt_missing", "mgmt_malformed"]


@pytest.fixture
def M(service):
    """The service module, reached through a fixture rather than imported at
    module scope: main freezes several env-derived globals at import time, and
    importing it during collection would freeze them before conftest has set the
    test environment up for every other file in the suite."""
    return service.main


def private_tags_in(payload):
    return {tag for entry in payload for tag in entry if str(tag).startswith("7777")}


def qido_sql(conn):
    """The last QIDO SELECT. LIMIT is unique to the QIDO builder (the UID-bearing
    instance levels carry no ORDER BY, by design: main.py order_clause)."""
    hits = [sql for sql, _ in conn.log if " LIMIT " in sql]
    assert hits, "no QIDO query was emitted"
    return hits[-1]


def values(entry, tag):
    return entry[tag]["Value"]


# ── The admin view ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("suffix", INSTANCE_LEVEL_PATHS)
def test_admin_sees_the_private_block_at_every_instance_level(
        two_datastores, get, suffix):
    payload = get(base(DS_A) + suffix, principal="admin").get_json()
    assert payload
    for entry in payload:
        for tag in PRIVATE_TAGS:
            assert tag in entry, f"{suffix}: {tag} missing for an admin"
        assert values(entry, PRIVATE_S3BUCKET_TAG) == [BUCKET_A]


def test_admin_private_block_is_a_well_formed_private_block(two_datastores, get):
    """A private creator element is what makes (7777,1001) parseable rather than
    an unknown tag a client has to guess at."""
    payload = get(base(DS_A) + "/instances", principal="admin").get_json()
    entry = next(e for e in payload
                 if e["00080018"]["Value"] == [SOP_UID])

    assert values(entry, PRIVATE_CREATOR_TAG) == ["DICOMWEBS3"]
    assert values(entry, PRIVATE_S3KEY_TAG) == [two_datastores.key(DS_A, SOP_UID)]
    assert values(entry, PRIVATE_S3BUCKET_TAG) == [BUCKET_A]
    for tag in PRIVATE_TAGS:
        assert entry[tag]["vr"] == "LO"


@pytest.mark.parametrize("suffix", PARENT_LEVEL_PATHS)
def test_admin_gets_no_private_block_above_instance_level(
        two_datastores, get, suffix):
    """A study or series maps to many objects, so there is no single bucket/key
    to report; the level gate keeps a half-true answer out of the payload."""
    payload = get(base(DS_A) + suffix, principal="admin").get_json()
    assert payload
    assert private_tags_in(payload) == set()


def test_admin_private_block_names_only_the_scoped_datastores_bucket(
        two_datastores, get):
    """Privilege and tenancy are separate: '*' means every datastore the caller
    asks for one at a time, not every datastore at once."""
    a_payload = get(base(DS_A) + "/instances", principal="admin").get_json()
    b_payload = get(base(DS_B) + "/instances", principal="admin").get_json()

    a_buckets = {v for e in a_payload for v in values(e, PRIVATE_S3BUCKET_TAG)}
    b_buckets = {v for e in b_payload for v in values(e, PRIVATE_S3BUCKET_TAG)}
    assert a_buckets == {BUCKET_A}
    assert b_buckets == {BUCKET_B}

    a_keys = {v for e in a_payload for v in values(e, PRIVATE_S3KEY_TAG)}
    assert two_datastores.key(DS_B, SOP_UID) not in a_keys


# ── The unprivileged view ────────────────────────────────────────────────────
@pytest.mark.parametrize("principal", UNPRIVILEGED_CALLERS)
@pytest.mark.parametrize("suffix", INSTANCE_LEVEL_PATHS)
def test_an_unprivileged_caller_sees_no_private_tag(
        two_datastores, get, principal, suffix):
    resp = get(base(DS_A) + suffix, principal=principal)
    assert resp.status_code == 200
    payload = resp.get_json()
    assert payload, f"{principal} {suffix}: nothing returned, assertion is vacuous"
    assert private_tags_in(payload) == set()


@pytest.mark.parametrize("principal", UNPRIVILEGED_CALLERS)
@pytest.mark.parametrize("suffix", INSTANCE_LEVEL_PATHS)
def test_an_unprivileged_querys_sql_cannot_leak_the_location(
        two_datastores, get, principal, suffix):
    """The strongest of the three gates: the values are never read out of the
    database, so no later bug in the injector or the filter can expose them."""
    get(base(DS_A) + suffix, principal=principal)
    sql = qido_sql(two_datastores.conn)

    assert "_s3bucket" not in sql
    assert "_s3key" not in sql
    assert "s3_bucket_name" not in sql
    assert "storage_index" not in sql, f"{principal} {suffix}: {sql}"


@pytest.mark.parametrize("suffix", INSTANCE_LEVEL_PATHS)
def test_an_admin_query_does_read_the_location_columns(two_datastores, get, suffix):
    """The mirror of the test above: if the columns were never selected for
    anyone, the SQL-gate assertions would pass for the wrong reason."""
    get(base(DS_A) + suffix, principal="admin")
    sql = qido_sql(two_datastores.conn)

    assert "il.s3_bucket_name AS _s3bucket" in sql
    assert "il.s3_key AS _s3key" in sql
    assert "LEFT JOIN storage_index il" in sql


@pytest.mark.parametrize("suffix", PARENT_LEVEL_PATHS)
def test_no_location_join_above_instance_level_even_for_an_admin(
        two_datastores, get, suffix):
    get(base(DS_A) + suffix, principal="admin")
    assert "storage_index" not in qido_sql(two_datastores.conn)


@pytest.mark.parametrize("principal", UNPRIVILEGED_CALLERS)
def test_metadata_carries_no_private_element_for_an_unprivileged_caller(
        two_datastores, get, principal):
    """/metadata streams a stored blob with no privilege gate of its own, so the
    blob must not be a second route to the bucket and key."""
    resp = get(base(DS_A) + f"/studies/{STUDY_UID}/metadata", principal=principal)
    assert resp.status_code == 200
    body = resp.get_data(as_text=True)
    assert "7777" not in body
    assert BUCKET_A not in body


# ── Cache namespacing ────────────────────────────────────────────────────────
def test_an_admin_query_does_not_prime_the_cache_for_everyone(two_datastores, get):
    """Same datastore, same query string, different privilege: if the QIDO cache
    key ignored the privilege, the admin's payload - bucket and key included -
    would be served to the next caller."""
    admin_payload = get(base(DS_A) + "/instances", principal="admin").get_json()
    assert private_tags_in(admin_payload) == set(PRIVATE_TAGS)

    reader_payload = get(base(DS_A) + "/instances", principal="reader_a").get_json()
    assert private_tags_in(reader_payload) == set()


def test_an_unprivileged_query_does_not_strip_the_admins_later_view(
        two_datastores, get):
    """The reverse order, which is the one that silently breaks the admin view
    rather than leaking - still a bug, and the same missing cache dimension."""
    reader_payload = get(base(DS_A) + "/instances", principal="reader_a").get_json()
    assert private_tags_in(reader_payload) == set()

    admin_payload = get(base(DS_A) + "/instances", principal="admin").get_json()
    assert private_tags_in(admin_payload) == set(PRIVATE_TAGS)


def test_the_cache_does_not_carry_a_private_block_across_datastores(
        two_datastores, get):
    a_payload = get(base(DS_A) + "/instances", principal="admin").get_json()
    b_payload = get(base(DS_B) + "/instances", principal="admin").get_json()
    assert {v for e in a_payload for v in values(e, PRIVATE_S3BUCKET_TAG)} == {BUCKET_A}
    assert {v for e in b_payload for v in values(e, PRIVATE_S3BUCKET_TAG)} == {BUCKET_B}


# ── filter_private_tags ──────────────────────────────────────────────────────
@pytest.mark.parametrize("tag", [
    PRIVATE_CREATOR_TAG, PRIVATE_S3KEY_TAG, PRIVATE_S3BUCKET_TAG,
    "77770011", "7777abcd", "7777ABCD", "7777FFFF", "77771003",
])
def test_filter_private_tags_strips_any_group_7777_element(M, tag):
    """Group-wide, not a three-tag denylist: a new derived column that lands in
    0x7777 is caught the day it is added."""
    entry = {"00080018": {"vr": "UI", "Value": ["1.2.3"]},
             tag: {"vr": "LO", "Value": ["secret"]}}
    M.filter_private_tags(entry)
    assert tag not in entry
    assert "00080018" in entry


@pytest.mark.parametrize("tag", ["00080018", "0020000D", "77780010", "07770010",
                                 "77", "", "notatag"])
def test_filter_private_tags_keeps_everything_else(M, tag):
    entry = {tag: {"vr": "LO", "Value": ["keep"]}}
    M.filter_private_tags(entry)
    assert tag in entry


def test_filter_private_tags_mutates_and_returns_the_same_entry(M):
    """The QIDO path relies on the in-place mutation; returning a copy would
    leave the private block on the object that is actually serialized."""
    entry = {PRIVATE_S3KEY_TAG: {"vr": "LO", "Value": ["a/b.dcm"]}}
    assert M.filter_private_tags(entry) is entry
    assert entry == {}


def test_filter_private_tags_survives_a_non_string_key(M):
    entry = {0x77771001: {"vr": "LO", "Value": ["x"]}, None: {}}
    M.filter_private_tags(entry)          # must not raise


@pytest.mark.parametrize("tag,expected", [
    (PRIVATE_S3KEY_TAG, True), (PRIVATE_S3BUCKET_TAG, True),
    (PRIVATE_CREATOR_TAG, True), ("7777ffff", True),
    ("00080018", False), ("0020000D", False), ("77780010", False),
    ("", False), ("zzzz0010", False), (None, False), (12345, False),
])
def test_is_private_s3_tag(M, tag, expected):
    assert M._is_private_s3_tag(tag) is expected


# ── The injector ─────────────────────────────────────────────────────────────
def test_add_private_s3_location_requires_the_flag_positionally(M):
    """No default on purpose: True would reintroduce the leak at any call site
    that forgot it, and False would silently break the admin view."""
    with pytest.raises(TypeError):
        M._add_private_s3_location({}, "INSTANCE", {"_s3key": "a/b.dcm"})


def test_add_private_s3_location_adds_nothing_when_unprivileged(M):
    entry = {}
    M._add_private_s3_location(
        entry, "INSTANCE", {"_s3key": "a/b.dcm", "_s3bucket": BUCKET_A}, False)
    assert entry == {}


@pytest.mark.parametrize("level", ["STUDY", "SERIES", "STUDY.SERIES", "", None])
def test_add_private_s3_location_adds_nothing_above_instance_level(M, level):
    entry = {}
    M._add_private_s3_location(
        entry, level, {"_s3key": "a/b.dcm", "_s3bucket": BUCKET_A}, True)
    assert entry == {}


@pytest.mark.parametrize("level", ["INSTANCE", "STUDY.INSTANCE",
                                   "STUDY.SERIES.INSTANCE"])
def test_add_private_s3_location_populates_all_three_elements(M, level):
    entry = {}
    M._add_private_s3_location(
        entry, level, {"_s3key": "a/b.dcm", "_s3bucket": BUCKET_A}, True)
    assert entry[PRIVATE_CREATOR_TAG]["Value"] == ["DICOMWEBS3"]
    assert entry[PRIVATE_S3KEY_TAG]["Value"] == ["a/b.dcm"]
    assert entry[PRIVATE_S3BUCKET_TAG]["Value"] == [BUCKET_A]


@pytest.mark.parametrize("result", [{}, {"_s3key": None}, {"_s3key": ""},
                                    {"_s3bucket": BUCKET_A}])
def test_add_private_s3_location_adds_nothing_without_a_key(M, result):
    """A sidecar-first row has index entries before its object exists; an empty
    private block would look like a real location."""
    entry = {}
    M._add_private_s3_location(entry, "INSTANCE", result, True)
    assert entry == {}


def test_add_private_s3_location_omits_the_bucket_when_it_is_unknown(M):
    entry = {}
    M._add_private_s3_location(entry, "INSTANCE", {"_s3key": "a/b.dcm"}, True)
    assert PRIVATE_S3KEY_TAG in entry
    assert PRIVATE_S3BUCKET_TAG not in entry


# ── check_storage_location_visibility ────────────────────────────────────────
@pytest.mark.parametrize("username,expected,reason", [
    ("admin", True, "management_privileges.datastores.canEdit is True"),
    ("reader_a", False, "canEdit is False"),
    ("reader_star", False, "datastoreId '*' does not imply canEdit"),
    ("mgmt_missing", False, "management_privileges is NULL"),
    ("mgmt_malformed", False, "management_privileges is not valid JSON"),
    ("nogroup", False, "no privilege group row"),
    ("inactive", False, "users.status is not ACTIVE"),
    ("ghost", False, "verified token, no users row"),
    ("", False, "empty username"),
    (None, False, "no username (unauthenticated mode)"),
])
def test_storage_location_visibility_is_admin_only(
        two_datastores, username, expected, reason):
    from privilege_checker import check_storage_location_visibility

    assert check_storage_location_visibility(
        username, two_datastores.conn) is expected, reason


def test_storage_location_visibility_is_false_when_the_database_fails(
        two_datastores):
    """Fail closed: an error must not be read as 'no restriction'."""
    from privilege_checker import check_storage_location_visibility

    two_datastores.conn.fail_next = RuntimeError("connection reset")
    assert check_storage_location_visibility("admin", two_datastores.conn) is False


@pytest.mark.parametrize("can_edit", [False, "true", 1, None, "True"])
def test_only_a_real_boolean_true_grants_visibility(two_datastores, can_edit):
    """`is True` on purpose: a hand-edited privilege group holding the string
    "true" (or 1) must not be treated as an admin."""
    import json

    from privilege_checker import check_storage_location_visibility

    group = two_datastores.conn.find("privilege_groups", id="grp-admin")
    group["management_privileges"] = json.dumps(
        {"datastores": {"canEdit": can_edit, "canView": True}})
    assert check_storage_location_visibility("admin", two_datastores.conn) is False


# ── The identity is the only input ───────────────────────────────────────────
@pytest.mark.parametrize("principal,expected", [
    ("admin", True), ("reader_a", False), ("reader_star", False),
    ("mgmt_missing", False), ("mgmt_malformed", False),
])
def test_identity_include_private_tags_matches_the_privilege(
        two_datastores, service, identities, principal, expected):
    with service.app.test_request_context(
            base(DS_A) + "/instances", headers=identities[principal].headers):
        identity = service.main.auth_middleware.authenticate_request()
    assert identity.include_private_tags is expected
