"""Tenancy: a request scoped to datastore A must never surface a datastore B row.

The highest-value file in the suite (spec 9.2). Our unique keys are composite
(`uq_study_uid (datastore_id, studyinstanceuid)` and friends), so a bare UID
identifies at most one row *per datastore* and every read-side query keys on a
bare UID. The `two_datastores` fixture puts the same StudyInstanceUID,
SeriesInstanceUID and SOPInstanceUIDs in both datastores with different buckets,
keys and pixel bytes, which is a legal state — so every assertion here is
reachable, not theoretical.

Three distinct failure modes are pinned:

  * a missing/unqualified `datastore_id` predicate (spec 5.1/5.2), asserted
    structurally over FakeCursor's recorded SQL so it cannot rot as the query
    builder changes;
  * a misordered `qparams` tuple (spec 5.3), which does not raise — it compares
    a StudyInstanceUID against a datastore_id and returns zero rows, looking
    like an ingest failure rather than a bug;
  * `Instancelocation` / `Instancemetadata` reached without the `instance` join.
    Those two tables carry neither `datastore_id` nor `deleted_at`, so such a
    query serves another tenant's PHI *and* PHI deleted up to GC_GRACE_SECONDS
    ago.
"""

import gzip
import json
import re

import pytest

import sql_queries
from conftest import (
    BUCKET_A, BUCKET_B, DS_A, DS_FORMER, DS_B, DS_DELETING, DS_SOFT_DELETED,
    DS_UNKNOWN, PATIENT_BIRTHDATE, PATIENT_BIRTHDATE_B, PATIENT_ID,
    PATIENT_NAME, PATIENT_NAME_B, PATIENT_SEX, PATIENT_SEX_B,
    SERIES_PENDING_UID, SERIES_UID, SERIES_UID_2, SOP_UID, SOP_UID_2,
    SOP_UID_3, SOP_UID_DELETED, STUDY_UID, base, normalize_sql, split_clauses,
)

# Tables the reader may scope on, and tables it may only reach through a join.
# `patient` is on this list: PatientID is institution-assigned and collides
# across datastores, so the row is scoped (uq_patient_ds_id) and the study-level
# QIDO join that reaches it must carry the predicate like any other level.
_HAS_DATASTORE_ID = frozenset({"patient", "study", "series", "instance"})
_HAS_DELETED_AT = frozenset({"patient", "study", "series", "instance"})
_UNSCOPED_TABLES = frozenset({"Instancelocation", "Instancemetadata"})
_INDEX_TABLES = _HAS_DELETED_AT | _UNSCOPED_TABLES

# The outer FROM/JOIN chain. split_clauses() already dropped the parenthesized
# derived columns' own FROMs by only splitting at paren depth zero.
_CHAIN_RE = re.compile(
    r"\b(?:FROM|JOIN)\s+(?P<table>\w+)"
    r"(?:\s+(?!ON\b|LEFT\b|RIGHT\b|INNER\b|JOIN\b|WHERE\b)(?P<alias>\w+))?",
    re.I)

# A datastore_id predicate that is not table-qualified. All three of study,
# series and instance declare the column, so MySQL rejects the bare form with
# 1052 the moment two of them are in the same join.
_BARE_DATASTORE_RE = re.compile(r"(?<![\w.])datastore_id\s*=", re.I)

# Marker written over datastore B's metadata blobs. The blobs are otherwise
# byte-identical between the two datastores (same UIDs, PixelData dropped), so
# without this a metadata leak would be invisible.
B_METADATA_MARKER = b'"LEAKED^FROM^DATASTORE^B"'


# ── SQL-shape helpers ────────────────────────────────────────────────────────
def _chain(sql):
    """{alias: table} for the outer FROM/JOIN chain of one SELECT."""
    from_clause = split_clauses(sql).get("from", "")
    chain = {}
    for m in _CHAIN_RE.finditer("FROM " + from_clause):
        table = m.group("table")
        chain[m.group("alias") or table] = table
    return chain


def _anchored_instances(sql, chain, scoped):
    """Instance aliases reached ONLY through a scoped parent, by the FK join.

    The UID-bearing reads (QIDO /studies/{uid}/instances, the WADO study/series
    constants) scope study/series instead of instance on purpose (7633af3): MySQL
    then resolves the study by uq_study_uid first and walks idx_instance_series,
    where an instance.datastore_id predicate made it scan every instance of the
    datastore. Such an instance is still tenant-bound: it is joined on
    <inst>.series_pkey = <series>.series_pkey to a scoped series, or to a series
    joined to a scoped study. A series/study pkey is one row of one datastore, so
    the join cannot reach another tenant's instance."""
    series = [a for a, t in chain.items() if t == "series"]
    studies = [a for a, t in chain.items() if t == "study"]
    anchored = set()
    for inst in (a for a, t in chain.items() if t == "instance"):
        for s_alias in series:
            if not re.search(rf"\b{inst}\.series_pkey\s*=\s*{s_alias}\.series_pkey\b|"
                             rf"\b{s_alias}\.series_pkey\s*=\s*{inst}\.series_pkey\b", sql):
                continue
            if s_alias in scoped:
                anchored.add(inst)
            for st in studies:
                if st in scoped and re.search(
                        rf"\b{st}\.study_pkey\s*=\s*{s_alias}\.study_pkey\b|"
                        rf"\b{s_alias}\.study_pkey\s*=\s*{st}\.study_pkey\b", sql):
                    anchored.add(inst)
    return anchored


def assert_scope_invariants(sql):
    """The spec-5.2 invariants that hold for EVERY read-side query.

    Applied to every statement a request emits, not just the one under test: the
    privilege and resolver lookups name no index table and are skipped, so a new
    query added anywhere on the read path is covered the day it appears.
    """
    sql = normalize_sql(sql)
    chain = _chain(sql)
    tables = set(chain.values())
    if not tables & _INDEX_TABLES:
        return                      # datastores / users / privilege_groups / SELECT 1

    where = split_clauses(sql).get("where", "")
    assert where, f"index-table query with no WHERE: {sql}"
    assert not _BARE_DATASTORE_RE.search(where), \
        f"datastore_id must be table-qualified (MySQL 1052): {sql}"

    scoped = {alias for alias, table in chain.items()
              if table in _HAS_DATASTORE_ID and f"{alias}.datastore_id = %s" in where}
    assert scoped, f"no table-qualified datastore_id predicate: {sql}"

    for alias, table in chain.items():
        if table in _HAS_DELETED_AT:
            assert f"{alias}.deleted_at IS NULL" in where, \
                f"{alias} ({table}) is joined without a liveness filter: {sql}"

    if tables & _UNSCOPED_TABLES:
        # Neither table has datastore_id or deleted_at of its own, so `instance`
        # is the only thing standing between them and another tenant's — or a
        # soft-deleted — object.
        instance_aliases = {a for a, t in chain.items() if t == "instance"}
        assert instance_aliases, \
            f"{sorted(tables & _UNSCOPED_TABLES)} reached without joining instance: {sql}"
        assert instance_aliases & (scoped | _anchored_instances(sql, chain, scoped)), \
            f"{sorted(tables & _UNSCOPED_TABLES)} reached through an unscoped instance: {sql}"


def assert_every_scopable_table_scoped(sql):
    """Stricter QIDO rule: every joined table that HAS datastore_id carries it.

    The redundant predicates are what let the optimizer use the composite unique
    keys instead of scanning on a bare UID, and they mean a future join reorder
    cannot quietly move the scope onto a table that is no longer the anchor.
    """
    sql = normalize_sql(sql)
    where = split_clauses(sql).get("where", "")
    chain = _chain(sql)
    scoped = {a for a, t in chain.items()
              if t in _HAS_DATASTORE_ID and f"{a}.datastore_id = %s" in where}
    anchored = _anchored_instances(sql, chain, scoped)
    for alias, table in chain.items():
        if table in _HAS_DATASTORE_ID and alias not in anchored:
            assert f"{alias}.datastore_id = %s" in where, \
                f"{alias} ({table}) is unscoped: {sql}"


def qido_statements(conn):
    """Every QIDO SELECT in the log. LIMIT is unique to the QIDO builder (the
    UID-bearing instance levels carry no ORDER BY, by design)."""
    return [(sql, params) for sql, params in conn.log if " LIMIT " in sql]


def qido_statement(conn):
    hits = qido_statements(conn)
    assert len(hits) == 1, f"expected exactly one QIDO query, got {len(hits)}"
    return hits[0]


def audit_all_sql(conn):
    for sql, _ in conn.log:
        assert_scope_invariants(sql)


def tag_values(payload, tag):
    return [entry[tag]["Value"][0] for entry in payload
            if entry.get(tag, {}).get("Value")]


def mark_datastore_b(world):
    """Make B's metadata blobs distinguishable from A's."""
    for sop_uid in (SOP_UID, SOP_UID_2, SOP_UID_3, SOP_UID_DELETED):
        world.metadata_row(DS_B, sop_uid)["metadata"] = gzip.compress(
            b'{"00100010": {"vr": "PN", "Value": [' + B_METADATA_MARKER + b']}}')


# level, path suffix, path-supplied UIDs in qparams order, datastore param count
QIDO_LEVELS = [
    ("STUDY", "/studies", (), 2),
    ("STUDY.SERIES", f"/studies/{STUDY_UID}/series", (STUDY_UID,), 2),
    # 2: the UID-bearing instance levels scope series and study, and reach
    # instance through them (see _anchored_instances).
    ("STUDY.INSTANCE", f"/studies/{STUDY_UID}/instances", (STUDY_UID,), 2),
    # 3: the flat series proto joins study and patient (both datastore-scoped)
    # so SearchForSeries can honor the study-level filters it accepts.
    ("SERIES", "/series", (), 3),
    ("STUDY.SERIES.INSTANCE",
     f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances",
     (STUDY_UID, SERIES_UID), 2),
    ("INSTANCE", "/instances", (), 3),
]

# Expected live-row counts per datastore. A leak doubles them; a soft-delete
# regression adds the SOP_UID_DELETED row.
QIDO_COUNTS = {
    ("STUDY", DS_A): 1, ("STUDY", DS_B): 1,
    ("STUDY.SERIES", DS_A): 3, ("STUDY.SERIES", DS_B): 2,
    ("SERIES", DS_A): 3, ("SERIES", DS_B): 2,
    ("STUDY.INSTANCE", DS_A): 3, ("STUDY.INSTANCE", DS_B): 3,
    ("INSTANCE", DS_A): 3, ("INSTANCE", DS_B): 3,
    ("STUDY.SERIES.INSTANCE", DS_A): 2, ("STUDY.SERIES.INSTANCE", DS_B): 2,
}

WADO_CONSTANTS = [
    ("WADO_LOC_BY_STUDY", sql_queries.WADO_LOC_BY_STUDY, STUDY_UID, 3),
    ("WADO_LOC_BY_SERIES", sql_queries.WADO_LOC_BY_SERIES, SERIES_UID, 2),
    ("WADO_LOC_BY_INSTANCE", sql_queries.WADO_LOC_BY_INSTANCE, SOP_UID, 1),
    ("WADO_METADATA_STUDY", sql_queries.WADO_METADATA_STUDY, STUDY_UID, 3),
    ("WADO_METADATA_SERIES", sql_queries.WADO_METADATA_SERIES, SERIES_UID, 2),
    ("WADO_METADATA_INSTANCE", sql_queries.WADO_METADATA_INSTANCE, SOP_UID, 1),
    ("WADO_INSTANCE_LOC", sql_queries.WADO_INSTANCE_LOC, SOP_UID, 1),
]


# ── QIDO: no cross-tenant row, at every level ────────────────────────────────
@pytest.mark.parametrize("level,suffix,_uids,_n", QIDO_LEVELS)
@pytest.mark.parametrize("datastore_id,principal",
                         [(DS_A, "reader_a"), (DS_B, "reader_b")])
def test_qido_returns_only_the_scoped_datastores_rows(
        two_datastores, get, level, suffix, _uids, _n, datastore_id, principal):
    resp = get(base(datastore_id) + suffix, principal=principal)
    assert resp.status_code == 200
    payload = resp.get_json()
    assert len(payload) == QIDO_COUNTS[(level, datastore_id)], \
        f"{level} scoped to {datastore_id} returned {len(payload)} rows"


def test_qido_series_never_leaks_the_other_datastores_series(two_datastores, get):
    """SERIES_PENDING_UID exists only in A, so it is the one row that can be
    told apart despite the deliberate UID collision."""
    a_series = tag_values(get(base(DS_A) + "/series").get_json(), "0020000E")
    b_series = tag_values(get(base(DS_B) + "/series",
                              principal="reader_b").get_json(), "0020000E")

    assert SERIES_PENDING_UID in a_series
    assert SERIES_PENDING_UID not in b_series
    assert sorted(b_series) == sorted([SERIES_UID, SERIES_UID_2])


@pytest.mark.parametrize("level,suffix,_uids,_n", QIDO_LEVELS)
def test_qido_emits_a_table_qualified_predicate_for_every_scopable_table(
        two_datastores, get, level, suffix, _uids, _n):
    get(base(DS_A) + suffix)
    sql, _params = qido_statement(two_datastores.conn)
    assert_every_scopable_table_scoped(sql)
    audit_all_sql(two_datastores.conn)


@pytest.mark.parametrize("level,suffix,uids,n_ds", QIDO_LEVELS)
def test_qido_datastore_id_leads_the_positional_params(
        two_datastores, get, level, suffix, uids, n_ds):
    """spec 5.3: qparams.append(datastore_id) runs before every UID append."""
    get(base(DS_A) + suffix)
    _sql, params = qido_statement(two_datastores.conn)
    assert params[:n_ds] == (DS_A,) * n_ds, f"{level}: {params}"
    assert params[n_ds:] == uids, f"{level}: {params}"


@pytest.mark.parametrize("level,suffix,uids,n_ds",
                         [row for row in QIDO_LEVELS if row[2]])
def test_qido_swapped_params_return_zero_rows_rather_than_raising(
        two_datastores, get, level, suffix, uids, n_ds):
    """The silent failure mode: a misordered tuple compares a UID against
    datastore_id, which is legal SQL and simply matches nothing."""
    get(base(DS_A) + suffix)
    sql, params = qido_statement(two_datastores.conn)

    swapped = list(params)
    swapped[0], swapped[n_ds] = swapped[n_ds], swapped[0]
    cursor = two_datastores.conn.cursor()
    cursor.execute(sql, tuple(swapped))
    assert cursor.fetchall() == [], \
        f"{level}: a swapped params tuple still matched rows"


@pytest.mark.parametrize("level,suffix,uids,n_ds",
                         [row for row in QIDO_LEVELS if not row[2]])
def test_qido_levels_without_path_uids_pass_only_datastore_params(
        two_datastores, get, level, suffix, uids, n_ds):
    """With no UID in the tuple there is nothing to misorder; assert that, so a
    future extra placeholder cannot slip in ahead of the tenancy predicate."""
    get(base(DS_A) + suffix)
    _sql, params = qido_statement(two_datastores.conn)
    assert params == (DS_A,) * n_ds, f"{level}: {params}"


def test_qido_filter_value_lands_after_the_datastore_params(two_datastores, get):
    """where_extra is appended after the proto, so a filter value must never
    displace the leading datastore_id (spec 5.3)."""
    resp = get(base(DS_A) + f"/series?StudyInstanceUID={STUDY_UID}")
    assert resp.status_code == 200
    sql, params = qido_statement(two_datastores.conn)
    # Three datastore predicates: series, study and patient are all joined here.
    assert params == (DS_A, DS_A, DS_A, STUDY_UID), params

    swapped = (STUDY_UID, DS_A, DS_A, DS_A)
    cursor = two_datastores.conn.cursor()
    cursor.execute(sql, swapped)
    assert cursor.fetchall() == []


def test_qido_instance_rows_carry_the_scoped_parent_uids(two_datastores, get):
    """0020000D/0020000E come off the joined study/series rows, which must be
    the scoped datastore's rows and not the collision partner's."""
    payload = get(base(DS_A) + "/instances").get_json()
    assert {v for v in tag_values(payload, "0020000D")} == {STUDY_UID}
    assert {v for v in tag_values(payload, "0020000E")} == {SERIES_UID, SERIES_UID_2}


# ── Patient demographics: one PatientID, two datastores, two people ──────────
# PatientID is assigned by the sending institution, so a shared archive with
# per-institution datastores collides on it almost immediately — and the two
# rows are then two different humans. The fixture seeds exactly that: same
# PatientID in A and B, every other demographic different. A patient row
# resolved across the boundary therefore renders as the wrong name, MRN or birth
# date, which is what these tests read.
PATIENT_TAGS = ("00100010", "00100020", "00100030", "00100040")

# Per datastore: PatientName (PN, so a dict), PatientID, birth date, sex.
DEMOGRAPHICS = {
    DS_A: ({"Alphabetic": PATIENT_NAME}, PATIENT_ID, PATIENT_BIRTHDATE, PATIENT_SEX),
    DS_B: ({"Alphabetic": PATIENT_NAME_B}, PATIENT_ID, PATIENT_BIRTHDATE_B,
           PATIENT_SEX_B),
}


def mark_b_demographics(world):
    """Rewrite B's metadata blobs to carry B's PatientName.

    The seeded blobs are byte-identical between the two datastores, so without
    this a demographics leak through the metadata route would be invisible.
    """
    for sop_uid in (SOP_UID, SOP_UID_2, SOP_UID_3, SOP_UID_DELETED):
        world.metadata_row(DS_B, sop_uid)["metadata"] = gzip.compress(
            json.dumps({
                "00100010": {"vr": "PN", "Value": [{"Alphabetic": PATIENT_NAME_B}]},
                "00100030": {"vr": "DA", "Value": [PATIENT_BIRTHDATE_B]},
            }).encode())


def test_the_two_datastores_share_a_patientid_and_nothing_else(two_datastores):
    """Fixture invariant. Every assertion below rests on this being the state."""
    patients = two_datastores.conn.tables["patient"]
    assert len(patients) == 2
    assert {p["datastore_id"] for p in patients} == {DS_A, DS_B}
    assert {p["patientid"] for p in patients} == {PATIENT_ID}
    assert {p["patientname"] for p in patients} == {PATIENT_NAME, PATIENT_NAME_B}
    # Each study points at its own datastore's patient row.
    for study in two_datastores.conn.tables["study"]:
        patient = two_datastores.conn.find("patient",
                                          patient_pkey=study["patient_pkey"])
        assert patient["datastore_id"] == study["datastore_id"]


@pytest.mark.parametrize("datastore_id,principal",
                         [(DS_A, "reader_a"), (DS_B, "reader_b")])
def test_study_qido_renders_only_the_scoped_datastores_demographics(
        two_datastores, get, datastore_id, principal):
    payload = get(base(datastore_id) + "/studies", principal=principal).get_json()
    assert len(payload) == 1

    expected = DEMOGRAPHICS[datastore_id]
    assert tuple(tag_values(payload, tag)[0] for tag in PATIENT_TAGS) == expected

    other = DEMOGRAPHICS[DS_B if datastore_id == DS_A else DS_A]
    for tag, value in zip(PATIENT_TAGS, other):
        if value != PATIENT_ID:         # the one attribute they legitimately share
            assert tag_values(payload, tag) != [value], f"{tag} came from the other tenant"


def test_study_qido_scopes_the_patient_join_itself(two_datastores, get):
    """The join is on patient_pkey, so its own predicate is what makes the row
    this tenant's rather than whichever row the FK happens to point at."""
    get(base(DS_A) + "/studies")
    sql, params = qido_statement(two_datastores.conn)
    where = split_clauses(sql)["where"]

    assert "patient.datastore_id = %s" in where
    assert params[:2] == (DS_A, DS_A)
    assert_every_scopable_table_scoped(sql)


def test_study_qido_refuses_a_study_pointed_at_another_tenants_patient(
        two_datastores, get):
    """The writer-regression case, which is the whole reason the read side keeps
    a predicate it could argue the FK already implies: re-point A's study at B's
    patient row and A's study must disappear rather than render B's name."""
    world = two_datastores
    study_a = world.conn.find("study", datastore_id=DS_A, studyinstanceuid=STUDY_UID)
    patient_b = world.conn.find("patient", datastore_id=DS_B, patientid=PATIENT_ID)
    study_a["patient_pkey"] = patient_b["patient_pkey"]

    payload = get(base(DS_A) + "/studies").get_json()
    assert payload == []
    assert PATIENT_NAME_B not in get(base(DS_A) + "/studies").data.decode()


def test_patient_filters_never_match_the_other_tenants_row(two_datastores, get):
    """A QIDO filter on a patient attribute is evaluated against the scoped row,
    so B's name is unqueryable from A — including as a wildcard."""
    prefix = PATIENT_NAME_B.split("^")[0]

    assert get(base(DS_A) + f"/studies?PatientName={PATIENT_NAME_B}").get_json() == []
    assert get(base(DS_A) + f"/studies?PatientName={prefix}*").get_json() == []

    # Reachable from B, so the assertions above are not vacuous.
    assert len(get(base(DS_B) + f"/studies?PatientName={prefix}*",
                   principal="reader_b").get_json()) == 1

    # The shared attribute is the interesting one: searching the colliding
    # PatientID from A must return A's study with A's demographics, one row.
    payload = get(base(DS_A) + f"/studies?PatientID={PATIENT_ID}").get_json()
    assert len(payload) == 1
    assert tag_values(payload, "00100010") == [{"Alphabetic": PATIENT_NAME}]


@pytest.mark.parametrize("suffix", [
    "/series",
    "/instances",
    f"/studies/{STUDY_UID}/series",
    f"/studies/{STUDY_UID}/instances",
    f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances",
])
def test_series_and_instance_levels_expose_no_patient_attributes_at_all(
        two_datastores, get, suffix):
    """These levels never join patient, so the leak cannot reappear there — but
    only as long as they keep not selecting patient columns."""
    body = get(base(DS_A) + suffix).data.decode()
    assert PATIENT_NAME_B not in body
    assert PATIENT_BIRTHDATE_B not in body
    for entry in json.loads(body):
        assert not set(entry) & set(PATIENT_TAGS), f"{suffix} returned patient tags"


@pytest.mark.parametrize("suffix", [
    f"/studies/{STUDY_UID}/metadata",
    f"/studies/{STUDY_UID}/series/{SERIES_UID}/metadata",
    f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/metadata",
])
def test_metadata_never_serves_the_other_tenants_demographics(
        two_datastores, get, suffix):
    mark_b_demographics(two_datastores)
    resp = get(base(DS_A) + suffix)
    assert resp.status_code == 200
    body = resp.data.decode()
    assert PATIENT_NAME_B not in body
    assert PATIENT_BIRTHDATE_B not in body


def test_metadata_scoped_to_b_serves_bs_demographics(two_datastores, get):
    """The mirror: B's name has to be reachable somewhere or the test above
    proves nothing."""
    mark_b_demographics(two_datastores)
    resp = get(base(DS_B) + f"/studies/{STUDY_UID}/metadata", principal="reader_b")
    assert resp.status_code == 200
    assert PATIENT_NAME_B in resp.data.decode()


# ── WADO: bytes, not just row counts ─────────────────────────────────────────
def test_instance_retrieve_serves_the_scoped_datastores_bytes(two_datastores, get):
    world = two_datastores
    path = f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}"

    a_resp = get(base(DS_A) + path)
    assert a_resp.status_code == 200
    assert world.object_bytes(DS_A, SOP_UID) in a_resp.data
    assert world.object_bytes(DS_B, SOP_UID) not in a_resp.data

    b_resp = get(base(DS_B) + path, principal="reader_b")
    assert b_resp.status_code == 200
    assert world.object_bytes(DS_B, SOP_UID) in b_resp.data
    assert world.object_bytes(DS_A, SOP_UID) not in b_resp.data


def test_instance_retrieve_is_deterministic_across_repeated_calls(
        two_datastores, get):
    """WADO_INSTANCE_LOC feeds _fetch_one, which keeps one arbitrary row: with a
    UID in two datastores, an unscoped query would be nondeterministic."""
    world = two_datastores
    path = (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}")
    for _ in range(4):
        resp = get(base(DS_A) + path)
        assert world.object_bytes(DS_A, SOP_UID) in resp.data
        assert world.object_bytes(DS_B, SOP_UID) not in resp.data


def test_frames_serve_the_scoped_datastores_pixels(two_datastores, get):
    """The strongest instance-level assertion: A's pixel pattern differs from
    B's, so a cross-tenant row shows up as the wrong pixels."""
    world = two_datastores
    path = (f"/studies/{STUDY_UID}/series/{SERIES_UID}"
            f"/instances/{SOP_UID}/frames/1")

    a_resp = get(base(DS_A) + path)
    assert a_resp.status_code == 200, a_resp.data[:200]
    assert world.pixel[DS_A] * 8 in a_resp.data
    assert world.pixel[DS_B] * 8 not in a_resp.data

    b_resp = get(base(DS_B) + path, principal="reader_b")
    assert b_resp.status_code == 200
    assert world.pixel[DS_B] * 8 in b_resp.data
    assert world.pixel[DS_A] * 8 not in b_resp.data


@pytest.mark.parametrize("suffix,parts", [
    (f"/studies/{STUDY_UID}", 3),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}", 2),
    (f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}", 1),
])
def test_bulk_retrieve_streams_only_the_scoped_datastores_members(
        two_datastores, get, suffix, parts):
    world = two_datastores
    resp = get(base(DS_A) + suffix)
    assert resp.status_code == 200
    body = resp.data
    assert body.count(b"Content-Type: application/dicom\r\n\r\n") == parts

    for sop_uid in (SOP_UID, SOP_UID_2, SOP_UID_3):
        assert world.object_bytes(DS_B, sop_uid) not in body
    # The soft-deleted instance keeps its Instancelocation row, so its object is
    # still in the bucket and still reachable if the instance join is dropped.
    assert world.object_bytes(DS_A, SOP_UID_DELETED) not in body


@pytest.mark.parametrize("suffix", [
    f"/studies/{STUDY_UID}/metadata",
    f"/studies/{STUDY_UID}/series/{SERIES_UID}/metadata",
    f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/metadata",
])
def test_metadata_never_serves_the_other_datastores_blob(
        two_datastores, get, suffix):
    """The highest-severity leak: the blob is a full gzipped DICOM-JSON header,
    i.e. another tenant's complete PHI."""
    mark_datastore_b(two_datastores)
    resp = get(base(DS_A) + suffix)
    assert resp.status_code == 200
    assert B_METADATA_MARKER not in resp.data
    assert json.loads(resp.data)          # still well-formed DICOM-JSON


def test_metadata_scoped_to_b_serves_bs_blob(two_datastores, get):
    """The mirror of the test above: proving A is clean is only half of it, the
    marker has to be reachable at all or the assertion is vacuous."""
    mark_datastore_b(two_datastores)
    resp = get(base(DS_B) + f"/studies/{STUDY_UID}/metadata",
               principal="reader_b")
    assert resp.status_code == 200
    assert B_METADATA_MARKER in resp.data


def test_every_statement_a_request_emits_is_scoped(two_datastores, get):
    """One sweep over a representative request of each shape."""
    for suffix in (
        "/studies", "/series", "/instances",
        f"/studies/{STUDY_UID}/series",
        f"/studies/{STUDY_UID}/instances",
        f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances",
        f"/studies/{STUDY_UID}",
        f"/studies/{STUDY_UID}/metadata",
        f"/studies/{STUDY_UID}/series/{SERIES_UID}",
        f"/studies/{STUDY_UID}/series/{SERIES_UID}/metadata",
        f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}",
        f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/metadata",
        f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}/frames/1",
    ):
        resp = get(base(DS_A) + suffix)
        resp.data                       # drain streaming bodies
        assert resp.status_code == 200, f"{suffix}: {resp.status_code}"
    audit_all_sql(two_datastores.conn)


# ── The seven sql_queries constants ──────────────────────────────────────────
@pytest.mark.parametrize("name,query,uid,rows", WADO_CONSTANTS)
def test_wado_constant_obeys_the_scope_invariants(name, query, uid, rows):
    assert_scope_invariants(query)


@pytest.mark.parametrize("name,query,uid,rows", WADO_CONSTANTS)
@pytest.mark.parametrize("datastore_id,bucket", [(DS_A, BUCKET_A), (DS_B, BUCKET_B)])
def test_wado_constant_returns_only_the_scoped_datastores_rows(
        two_datastores, name, query, uid, rows, datastore_id, bucket):
    mark_datastore_b(two_datastores)
    cursor = two_datastores.conn.cursor()
    cursor.execute(query, (datastore_id, uid))
    result = cursor.fetchall()

    assert len(result) == rows, f"{name}: {len(result)} rows for {datastore_id}"
    for row in result:
        if "bucketname" in row:
            assert row["bucketname"] == bucket, f"{name}: {row['bucketname']}"
        if "metadata" in row:
            # The column holds the gzipped DICOM-JSON header the handler streams.
            blob = gzip.decompress(row["metadata"]) if row["metadata"] else b""
            leaked = B_METADATA_MARKER in blob
            assert leaked == (datastore_id == DS_B), f"{name}: wrong tenant's blob"


@pytest.mark.parametrize("name,query,uid,rows", WADO_CONSTANTS)
def test_wado_constant_is_deterministic_across_repeated_calls(
        two_datastores, name, query, uid, rows):
    cursor = two_datastores.conn.cursor()
    seen = []
    for _ in range(4):
        cursor.execute(query, (DS_A, uid))
        seen.append([row.get("bucketname") for row in cursor.fetchall()])
    assert seen[1:] == seen[:-1]
    assert all(bucket in (None, BUCKET_A) for row in seen for bucket in row)


@pytest.mark.parametrize("name,query,uid,rows", WADO_CONSTANTS)
def test_wado_constant_swapped_params_return_zero_rows(
        two_datastores, name, query, uid, rows):
    cursor = two_datastores.conn.cursor()
    cursor.execute(query, (uid, DS_A))
    assert cursor.fetchall() == [], f"{name}: a swapped tuple still matched"


# ── Soft delete ──────────────────────────────────────────────────────────────
def test_soft_deleted_instance_is_invisible_to_every_query(two_datastores, get):
    world = two_datastores
    path = (f"/studies/{STUDY_UID}/series/{SERIES_UID}"
            f"/instances/{SOP_UID_DELETED}")

    assert get(base(DS_A) + path).status_code == 404
    assert get(base(DS_A) + path + "/metadata").status_code == 404
    assert get(base(DS_A) + path + "/frames/1").status_code == 404

    sops = tag_values(get(base(DS_A) + "/instances").get_json(), "00080018")
    assert SOP_UID_DELETED not in sops
    assert sorted(sops) == sorted([SOP_UID, SOP_UID_2, SOP_UID_3])

    # Its location/metadata rows are deliberately still there: this is the state
    # between an ingest delete and the GC sweep.
    assert world.location_row(DS_A, SOP_UID_DELETED) is not None
    assert world.metadata_row(DS_A, SOP_UID_DELETED) is not None


def test_soft_deleted_series_hides_its_instances(two_datastores, get):
    world = two_datastores
    world.soft_delete_series(DS_A, SERIES_UID)

    assert get(base(DS_A) + f"/studies/{STUDY_UID}/series/{SERIES_UID}"
               ).status_code == 404
    assert get(base(DS_A) + f"/studies/{STUDY_UID}/series/{SERIES_UID}"
               f"/instances/{SOP_UID}").status_code == 404

    series = tag_values(get(base(DS_A) + "/series").get_json(), "0020000E")
    assert SERIES_UID not in series
    sops = tag_values(get(base(DS_A) + "/instances").get_json(), "00080018")
    assert sops == [SOP_UID_3]


def test_soft_deleted_study_hides_the_whole_tree(two_datastores, get):
    world = two_datastores
    world.soft_delete_study(DS_A, STUDY_UID)

    assert get(base(DS_A) + f"/studies/{STUDY_UID}").status_code == 404
    assert get(base(DS_A) + f"/studies/{STUDY_UID}/metadata").status_code == 404
    assert get(base(DS_A) + "/studies").get_json() == []
    assert get(base(DS_A) + "/series").get_json() == []
    assert get(base(DS_A) + "/instances").get_json() == []

    # B's identically-UID'd study is untouched by A's delete.
    assert len(get(base(DS_B) + "/studies", principal="reader_b").get_json()) == 1


def test_soft_deleting_one_datastore_does_not_hide_the_other(two_datastores, get):
    world = two_datastores
    world.soft_delete_instance(DS_B, SOP_UID)

    path = f"/studies/{STUDY_UID}/series/{SERIES_UID}/instances/{SOP_UID}"
    assert get(base(DS_B) + path, principal="reader_b").status_code == 404
    assert get(base(DS_A) + path).status_code == 200


# ── datastore_resolver ───────────────────────────────────────────────────────
@pytest.mark.parametrize("identifier,reason", [
    (DS_UNKNOWN, "no row at all"),
    (DS_FORMER, "former storage-type datastore id, no row in the S3-only schema"),
    (DS_SOFT_DELETED, "deleted = TRUE"),
    (DS_DELETING, "status='DELETING'"),
])
def test_resolver_refuses_every_non_servable_datastore(
        two_datastores, identifier, reason):
    import datastore_resolver

    assert datastore_resolver.resolve_datastore(
        identifier, two_datastores.conn) is None, reason


@pytest.mark.parametrize("identifier,reason", [
    (DS_UNKNOWN, "unknown id"),
    (DS_FORMER, "former storage type"),
    (DS_SOFT_DELETED, "soft-deleted"),
    (DS_DELETING, "deleting"),
    ("ds-a", "a name, not an id"),
])
def test_non_servable_datastore_is_a_404_over_http(
        two_datastores, get, identifier, reason):
    resp = get(base(identifier) + "/studies")
    assert resp.status_code == 404, reason


def test_resolver_never_accepts_a_name_as_an_identifier(two_datastores):
    """A datastore whose NAME equals another datastore's ID is seeded on
    purpose: accepting a name here would be an authorization bypass, because the
    privilege check keys on the UUID."""
    import datastore_resolver

    conn = two_datastores.conn
    assert datastore_resolver.resolve_datastore("ds-a", conn) is None
    assert datastore_resolver.resolve_datastore("ds-b", conn) is None

    resolved = datastore_resolver.resolve_datastore(DS_A, conn)
    assert resolved is not None
    assert resolved["id"] == DS_A
    assert resolved["s3_bucket_name"] == BUCKET_A
    assert resolved["s3_bucket_name"] != "archive-ds-imposter"


def test_resolver_never_caches_a_positive_resolution(two_datastores):
    """The row carries the status the gate keys on, so it is re-read every request.

    Caching it would keep serving PHI out of a datastore flipped to DELETING for
    up to DATASTORE_CACHE_TTL_SECONDS, and there is no cross-task invalidation
    channel to shorten that window with. The cost is one primary-key lookup on a
    connection the request already holds.
    """
    import datastore_resolver

    conn = two_datastores.conn
    conn.log.clear()
    for _ in range(3):
        assert datastore_resolver.resolve_datastore(DS_A, conn)["id"] == DS_A
    assert len(conn.log) == 3, "a resolved datastore must be re-read every time"


def test_resolver_caches_negative_results(two_datastores):
    """The unresolvable half of the cache stays: a junk id costs one query per TTL.

    Nothing about "this id is not a live S3 datastore" can become *more* permissive
    while cached, which is why this direction is safe and the positive one is not.
    """
    import datastore_resolver

    conn = two_datastores.conn
    conn.log.clear()
    for _ in range(3):
        assert datastore_resolver.resolve_datastore(DS_UNKNOWN, conn) is None
    assert len(conn.log) == 1, "a negative result must be cached"


def test_resolver_invalidate_drops_one_entry_and_all_entries(two_datastores):
    """invalidate() operates on the unresolvable entries, the only ones there are."""
    import datastore_resolver

    conn = two_datastores.conn
    assert datastore_resolver.resolve_datastore(DS_UNKNOWN, conn) is None
    assert datastore_resolver.resolve_datastore("ds-b", conn) is None

    conn.log.clear()
    datastore_resolver.invalidate(DS_UNKNOWN)
    assert datastore_resolver.resolve_datastore(DS_UNKNOWN, conn) is None
    assert datastore_resolver.resolve_datastore("ds-b", conn) is None
    assert len(conn.log) == 1, "only DS_UNKNOWN should have been re-read"

    conn.log.clear()
    datastore_resolver.invalidate()
    assert datastore_resolver.resolve_datastore(DS_UNKNOWN, conn) is None
    assert datastore_resolver.resolve_datastore("ds-b", conn) is None
    assert len(conn.log) == 2


@pytest.mark.parametrize("identifier", ["", None, 42, "x" * 37])
def test_resolver_rejects_unusable_identifiers_without_a_query(
        two_datastores, identifier):
    """datastores.id is VARCHAR(36): a longer segment can never match, so it is
    refused without a query and without occupying a cache slot."""
    import datastore_resolver

    conn = two_datastores.conn
    conn.log.clear()
    assert datastore_resolver.resolve_datastore(identifier, conn) is None
    assert conn.log == []


def test_resolver_raises_rather_than_reporting_absence_when_the_database_fails(
        two_datastores):
    """A database problem must not open the gate - and must not be a 404 either.

    Returning None here conflated "no such datastore" with "we could not tell",
    and the caller then answered 404: a permanent, unretryable-looking verdict for
    a transient fault. DatastoreResolutionError still fails closed (no datastore
    is returned on any path) but lets the caller answer 503.
    """
    import datastore_resolver

    conn = two_datastores.conn
    conn.fail_next = RuntimeError("connection reset")
    with pytest.raises(datastore_resolver.DatastoreResolutionError):
        datastore_resolver.resolve_datastore(DS_A, conn)


def test_a_resolution_failure_is_not_cached_as_unresolvable(two_datastores):
    """A transient fault must not poison the negative cache for a whole TTL."""
    import datastore_resolver

    conn = two_datastores.conn
    conn.fail_next = RuntimeError("connection reset")
    with pytest.raises(datastore_resolver.DatastoreResolutionError):
        datastore_resolver.resolve_datastore(DS_A, conn)

    assert datastore_resolver.resolve_datastore(DS_A, conn)["id"] == DS_A


def test_a_resolution_failure_is_a_503_not_a_404(two_datastores, get):
    """The whole point of the distinct exception, at the route boundary."""
    two_datastores.conn.fail_next = RuntimeError("connection reset")
    response = get(f'{base(DS_A)}/studies')
    assert response.status_code == 503
    assert response.get_json() == {"error": "Service temporarily unavailable"}


# ── The anchoring rule cannot excuse a genuinely unscoped instance ───────────
@pytest.mark.parametrize("sql", [
    # instance joined to a series that nothing scopes
    "SELECT m.metadata FROM instance i JOIN series s ON s.series_pkey = i.series_pkey "
    "JOIN study st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE st.studyinstanceuid = %s AND i.deleted_at IS NULL AND s.deleted_at IS NULL "
    "AND st.deleted_at IS NULL",
    # scoped study, but the instance is not joined through the series FK
    "SELECT m.metadata FROM instance i JOIN series s ON s.datastore_id = i.datastore_id "
    "JOIN study st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE st.datastore_id = %s AND i.deleted_at IS NULL AND s.deleted_at IS NULL "
    "AND st.deleted_at IS NULL",
])
def test_an_instance_not_anchored_to_a_scoped_parent_still_fails(sql):
    with pytest.raises(AssertionError):
        assert_scope_invariants(sql)
