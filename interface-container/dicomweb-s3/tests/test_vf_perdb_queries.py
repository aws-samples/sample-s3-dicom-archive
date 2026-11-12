"""Phase 3 (VF Per-Database Redesign): the container's VF de-id TREE reads now
target the folder's own database vf_<id> instead of the shared virtual_* tables.

These tests exercise ONLY sql_queries (the db-name deriver + the two qualified
de-id query builders); they touch no DB fixtures, so they run independently of
the shared conftest schema. conftest still puts the module dir on sys.path.
"""

import pytest

import sql_queries as q

# dfab76ff-7aa0-4901-9a62-359518ce4b1f -> vf_dfab76ff7aa049019a62359518ce4b1f
VF_ID = "dfab76ff-7aa0-4901-9a62-359518ce4b1f"
VF_DB = "vf_dfab76ff7aa049019a62359518ce4b1f"


def test_vf_db_name_matches_node_scheme():
    # Mirrors vf-database.js vfDbName: 'vf_' + uuid.toLowerCase().replace(/-/g,'')
    assert q.vf_db_name(VF_ID) == VF_DB
    # Uppercase input is lowercased, exactly like the Node helper.
    assert q.vf_db_name(VF_ID.upper()) == VF_DB
    assert q._VF_DB_RE.match(q.vf_db_name(VF_ID))


@pytest.mark.parametrize("bad", [
    "not-a-uuid",
    "",
    "dfab76ff-7aa0-4901-9a62-359518ce4b1f; DROP DATABASE dicomarchive;--",
    "'; DELETE FROM virtual_folders; --",
    None,
    123,
])
def test_vf_db_name_rejects_non_uuid(bad):
    # Never derive (and therefore never interpolate) from unvalidated input.
    with pytest.raises(ValueError):
        q.vf_db_name(bad)


@pytest.mark.parametrize("bad", [
    "dicomarchive",
    "vf_short",
    "vf_dfab76ff7aa049019a62359518ce4b1f; DROP",
    "VF_DFAB76FF7AA049019A62359518CE4B1F",  # uppercase fails ^vf_[0-9a-f]{32}$
])
def test_assert_vf_db_rejects_unexpected_name(bad):
    with pytest.raises(ValueError):
        q._assert_vf_db(bad)


def test_profile_and_membership_queries_stay_shared():
    # The de-id PROFILE reads (virtual_folders / virtual_folder_deid_profiles)
    # and the VF membership scope (virtual_folder_assignments) remain SHARED in
    # dicomarchive and keep their %s-bound vf id — they are NOT retargeted.
    assert "virtual_folders" in q.VF_DEID_PROFILE
    assert "virtual_folder_deid_profiles" in q.VF_DEID_PROFILE
    assert q.VF_DEID_PROFILE.strip().endswith("WHERE vf.id = %s")
    # The WADO VF variants still scope via the shared assignments membership set.
    assert "virtual_folder_assignments WHERE virtual_folder_id = %s" in q.WADO_LOC_BY_STUDY_VF
