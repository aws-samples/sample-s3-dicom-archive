"""Read-side SQL for the QIDO/WADO endpoints.

All queries use parameterized placeholders. Joins use the proper FK columns
(study.study_pkey, series.study_pkey, instance.series_pkey, and
Instancemetadata.instance_pkey — the metadata blob is keyed on the queryable
instance, not the physical object, so each WSI pyramid level carries its own
header and frame_offsets even though all levels share one storage_index row).

Every query filters `deleted_at IS NULL` on every joined level so soft-deleted
rows are invisible to readers. Without this, a study deleted from S3 would
remain visible until the GC sweep hard-deletes it (up to ~90s later).

Every query also leads its WHERE with a `<t>.datastore_id = %s` predicate on the
SAME table whose UID it filters (study for a study UID, series for a series UID,
instance for a SOP UID), and every parameter tuple is therefore
`(datastore_id, uid)`. This is not optional: our unique keys are composite
(`uq_study_uid (datastore_id, studyinstanceuid)`,
`uq_series_uid (datastore_id, seriesinstanceuid)`,
`uq_instance_uid (datastore_id, sopinstanceuid)`), so pairing the datastore
predicate with the UID on the matching table lets that composite unique key
resolve the single row directly. Scoping datastore_id on `instance` while
filtering a study/series UID on the parent (an earlier form) let the planner
drive from `instance` and scan every row in the datastore — the metadata/loc
hang fixed 2026-09. A bare UID identifies at most one row *per datastore*. Drop the
predicate and the query returns another tenant's rows.

No query here joins `patient`, and none should: WADO serves pixels and the
per-instance metadata blob, both of which carry their own demographics. The one
read-side patient join is the study-level QIDO proto in `_construct_query`, and
it scopes `patient.datastore_id` itself — `patient` is datastore-scoped
(`uq_patient_ds_id` is `(datastore_id, patientid)`) precisely because PatientID
is institution-assigned and collides across tenants.

`series` and `study` are joined even where only liveness needs them, because a
soft-deleted ancestor must hide its descendants. `Instancemetadata` is a
LEFT JOIN in every multi-instance query — an instance can exist without a
metadata row during a partial ingest, and the read path handles the NULLs. Only
the single-instance metadata query joins it inner (see the note there).
"""

import re


# ── Per-VF database name derivation (VF Per-Database Redesign, Phase 3) ───────
#
# Each virtual folder's DE-ID TREE (patient/study/series/instance) now lives in
# its OWN MySQL database `vf_<id>` so a raw-SQL customer can be GRANT-ed access
# to exactly one folder. This Python deriver MIRRORS the Node helper
# cdk-infrastructure/lib/virtual-folder/lambda/virtual-folder-api/vf-database.js
# (vfDbName): 'vf_' + uuid.toLowerCase().replace(/-/g,'') -> 'vf_' + 32 hex.
#
# The db name is an IDENTIFIER, so it can never be a bind param — it must be
# interpolated into the SQL string. We therefore build it ONLY from a validated
# UUID and re-assert the derived shape against ^vf_[0-9a-f]{32}$ before it is
# ever placed in a query, so no unvalidated input can reach the SQL text.
_UUID_RE = re.compile(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
_VF_DB_RE = re.compile(r'^vf_[0-9a-f]{32}$')


def vf_db_name(vf_id: str) -> str:
    """Derive the per-VF database name from a VF UUID.

    Scheme (identical to vf-database.js vfDbName): 'vf_' + the lowercased UUID
    with hyphens stripped -> 'vf_' + 32 hex chars. Raises ValueError if the
    input is not a valid UUID — we NEVER interpolate unvalidated input into SQL.
    """
    if not isinstance(vf_id, str) or not _UUID_RE.match(vf_id):
        raise ValueError(f"Invalid virtual folder id (must be a UUID): {vf_id!r}")
    return 'vf_' + vf_id.lower().replace('-', '')


def _assert_vf_db(vf_db: str) -> str:
    """Defensive re-check before interpolating a db name into a query string.

    The name must already have come from vf_db_name(); this guards against any
    future caller passing a raw value. Returns the name so callers can inline it.
    """
    if not isinstance(vf_db, str) or not _VF_DB_RE.match(vf_db):
        raise ValueError(f"Refusing to interpolate unexpected vf-db name: {vf_db!r}")
    return vf_db


# WADO bulk DICOM retrieve — return s3 location for every instance under a UID.
# `availability` rides along so the §6 guard costs no extra round trip.
#
# `metadataendoffset` and `jpeg_tables_offset` ride along too, because they are
# what tells a Part 10 instance apart from a virtualized WSI pyramid level whose
# backing object is a raw `.svs` TIFF. Streaming that object as
# `application/dicom` would hand the client a multi-GB TIFF labelled DICOM, so
# `_is_virtualized_object()` excludes those rows. The SOP class cannot be the
# discriminator: a genuine Part 10 WSI `.dcm` carries the same one and is
# perfectly servable.
WADO_LOC_BY_STUDY = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.jpeg_tables_offset, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    # study-first via uq_study_uid (see WADO_METADATA_STUDY note); scoping on
    # i.datastore_id let the planner scan all datastore instances.
    "WHERE st.datastore_id = %s AND st.studyinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

WADO_LOC_BY_SERIES = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.jpeg_tables_offset, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    # series-first via uq_series_uid (see WADO_METADATA_SERIES note); scoping on
    # i.datastore_id let the planner scan all datastore instances.
    "WHERE s.datastore_id = %s AND s.seriesinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

WADO_LOC_BY_INSTANCE = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.jpeg_tables_offset, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.datastore_id = %s AND i.sopinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

# WADO metadata — return precomputed gzipped JSON metadata for each instance.
# The blob is a full DICOM-JSON header, so a missing datastore predicate here
# leaks another tenant's complete PHI rather than just its object keys.
#
# The multi-instance forms drive from `instance`, not from `Instancemetadata`.
# Driving from the metadata table turns the join into an inner one, and an
# instance still mid-ingest (row present, blob not yet written) then vanishes
# from the response — a partial study that looks complete to the client, with no
# signal that anything is missing. Driving from `instance` surfaces it as a NULL
# blob instead, which `_retrieve_metadata` already skips explicitly.
#
# WSI OVERLAY COLUMNS. A virtualized whole-slide study is N DICOM WSI level
# instances backed by ONE physical `.svs` object: all N `instance` rows share a
# single `content_pkey`, so the LEFT JOIN to `Instancemetadata` maps every level
# to the SAME gzipped blob (the header of whichever level was serialized at
# ingest). Serving that blob verbatim per row returns N IDENTICAL entries — same
# SOPInstanceUID, same TotalPixelMatrix dims — and SLIM 0.46+ then rejects the
# series ("Multiple image instances ... identical dimensions ... not part of a
# concatenation"). Per-instance identity lives on the `instance` row's OWN
# columns, not in the shared blob, so each row carries them out and
# `_retrieve_metadata` overlays them onto its copy of the decoded blob. These
# ride along on non-WSI queries too, harmlessly (they match the single blob).
_METADATA_INSTANCE_COLS = (
    "       i.sopinstanceuid          AS inst_sopinstanceuid, "
    "       i.instancenumber          AS inst_instancenumber, "
    "       i.numberofframes          AS inst_numberofframes, "
    "       i.totalpixelmatrixcolumns AS inst_totalpixelmatrixcolumns, "
    "       i.totalpixelmatrixrows    AS inst_totalpixelmatrixrows, "
)

WADO_METADATA_STUDY = (
    "SELECT m.metadata, m.metadataendoffset, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    + _METADATA_INSTANCE_COLS +
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    # Scope on study.datastore_id (not instance.datastore_id): the pair
    # (datastore_id, studyinstanceuid) hits uq_study_uid, resolving the single
    # study row first, then reaching its instances via idx_instance_series.
    # Scoping on i.datastore_id instead let the planner drive from `instance`
    # and scan every instance in the datastore (tens of millions on a large
    # datastore) before filtering by UID — the metadata hang.
    "WHERE st.datastore_id = %s AND st.studyinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

WADO_METADATA_SERIES = (
    "SELECT m.metadata, m.metadataendoffset, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    + _METADATA_INSTANCE_COLS +
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    # Scope on series.datastore_id (not instance.datastore_id): the pair
    # (datastore_id, seriesinstanceuid) hits uq_series_uid, resolving the single
    # series row first, then reaching its instances via idx_instance_series.
    # Scoping on i.datastore_id let the planner drive from `instance` and scan
    # every instance in the datastore before filtering by series UID — the hang.
    "WHERE s.datastore_id = %s AND s.seriesinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

# The single-instance form keeps the inner join on purpose: with nothing to be
# partial about, a blob-less instance should read as 404, not as an empty array.
# It carries the same overlay columns: a level's shared blob holds another
# level's SOP UID and dims, so an instance-level /metadata request for a
# non-representative level would otherwise return the wrong identity.
WADO_METADATA_INSTANCE = (
    "SELECT m.metadata, m.metadataendoffset, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    + _METADATA_INSTANCE_COLS +
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM Instancemetadata m "
    "JOIN instance i  ON i.instance_pkey  = m.instance_pkey "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "WHERE i.datastore_id = %s AND i.sopinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

# Single-instance pixel-data retrieval — returns metadataendoffset so the
# native-frame fetcher can range-read from S3 without re-parsing the header,
# and frame_offsets so the encapsulated-frame fetcher can range-read each
# JPEG/JPEG2000/etc payload directly.
#
# This is the sole row source for /frames, /rendered, /bulk/element and
# /bulk/icc, and it feeds _fetch_one, which keeps one arbitrary row. The
# datastore predicate is what makes "arbitrary" deterministic — without it a
# UID present in two datastores makes those four endpoints serve whichever row
# MySQL happened to return first.
#
# sop_class_uid / dimension_organization_type / total_pixel_matrix_* let
# _is_wsi() and the §6.5 WSI bulk guard decide from the index row alone, with no
# metadata-blob round trip.
WADO_INSTANCE_LOC = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.frame_offsets, "
    "       m.jpeg_tables_offset, m.jpeg_tables_length, "
    "       m.icc_profile_offset, m.icc_profile_length, "
    "       i.transfersyntaxuid AS transfer_syntax, "
    "       i.`rows` AS rows_, "
    "       i.`columns` AS columns_, "
    "       i.bitsallocated AS bits_allocated, "
    "       i.samplesperpixel AS samples_per_pixel, "
    "       i.numberofframes AS number_of_frames, "
    "       i.sopclassuid AS sop_class_uid, "
    "       i.dimensionorganizationtype AS dimension_organization_type, "
    "       i.totalpixelmatrixcolumns AS total_pixel_matrix_columns, "
    "       i.totalpixelmatrixrows AS total_pixel_matrix_rows, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il        ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s              ON s.series_pkey = i.series_pkey "
    "JOIN study    st             ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.datastore_id = %s AND i.sopinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

# There are deliberately no WADO_STUDY / WADO_SERIES / WADO_INSTANCE aliases.
# The reference kept them for its old route names; an alias that survives a
# rewrite is how an unscoped query silently comes back.


# ── Virtual-folder-scoped WADO variants ──────────────────────────────────────
#
# A virtual folder is a rule-built INDEX over content ingested across N
# datastores (see virtual_folder_assignments). A VF request therefore has NO
# single datastore to scope on — auth_middleware sets RequestIdentity.
# datastore_id='' and RequestIdentity.virtual_folder_id=<vfId> — and the
# datastore-equality predicate the queries above lead with would match nothing
# (or, worse, every row of an empty-string datastore if one ever existed).
#
# These variants REPLACE the `i.datastore_id = %s` tenancy predicate with a
# VF-membership predicate:
#     i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments
#                        WHERE virtual_folder_id = %s)
# TENANCY IS SECURITY: the membership subquery IS the scope — it is never
# additive/optional, so an absent vf id can never widen to all rows. Every
# parameter tuple is `(virtual_folder_id, uid)` — the vf id leads, exactly where
# the datastore id led, and is always a bound %s (never interpolated). A VF
# spans datastores, so there is deliberately no `i.datastore_id` equality left
# in these variants. All deleted_at IS NULL filters and the storage_index /
# Instancemetadata joins are preserved unchanged from the datastore variants.

WADO_LOC_BY_STUDY_VF = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.jpeg_tables_offset, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments WHERE virtual_folder_id = %s) "
    "  AND st.studyinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

WADO_LOC_BY_SERIES_VF = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.jpeg_tables_offset, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments WHERE virtual_folder_id = %s) "
    "  AND s.seriesinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

WADO_LOC_BY_INSTANCE_VF = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.jpeg_tables_offset, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments WHERE virtual_folder_id = %s) "
    "  AND i.sopinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

# VF de-id lookup: the swapped identity values the per-VF tree holds for a set of
# content_pkeys, so the WADO /metadata path can overwrite the source header tags
# on the fly. {placeholders} is filled with the right number of %s at call time.
# The VF's de-id profile-level flag: strip ALL private tags when set. Private
# DICOM tags have an ODD group number (PS3.5). Read once per request.
VF_DEID_DROP_PRIVATE = (
    "SELECT COALESCE(dp.drop_private_tags, 0) AS drop_private_tags "
    "FROM virtual_folders vf LEFT JOIN virtual_folder_deid_profiles dp ON vf.deid_profile_id = dp.id "
    "WHERE vf.id = %s"
)

# The VF's FULL de-id profile: the tag_actions JSON list + the drop-private flag.
# Used by the on-the-fly metadata de-id path to apply the SAME profile actions the
# virtual-folder-indexer applies at index time, to EVERY covered header element
# (including tags that are not indexed columns). Read once per request.
VF_DEID_PROFILE = (
    "SELECT dp.tag_actions AS tag_actions, COALESCE(dp.drop_private_tags, 0) AS drop_private_tags, "
    "       vf.deid_profile_id AS deid_profile_id, dp.id AS profile_id "
    "FROM virtual_folders vf LEFT JOIN virtual_folder_deid_profiles dp ON vf.deid_profile_id = dp.id "
    "WHERE vf.id = %s"
)

# VF QIDO de-id: UID-keyed de-id'd values from the VF tree. QIDO objects always
# carry their (real, in v1) Study/Series/SOP UIDs, so we rewrite by UID — exact,
# unlike a value-based swap. Study-level values (patient + study) keyed by the
# real StudyInstanceUID; series description keyed by the real SeriesInstanceUID.
#
# PER-DATABASE (Phase 3): the de-id TREE now lives in the folder's OWN database
# `vf_<id>` (tables vf_<id>_patient/study/series/instance) — the DATABASE is the
# scope, so there is no longer a `virtual_folder_id` column or WHERE clause. The
# db + table names are IDENTIFIERS (cannot be bind params), so they are built
# from the validated derived name (vf_db_name -> _assert_vf_db, matched against
# ^vf_[0-9a-f]{32}$) and interpolated; user input never reaches the SQL text.
# These are the ONLY tree reads that move — virtual_folders /
# virtual_folder_deid_profiles (the PROFILE, read by VF_DEID_PROFILE above and
# vf_deid.py) and virtual_folder_assignments (the membership scope) STAY SHARED
# in dicomarchive and keep their %s-bound `vf.id` / `virtual_folder_id` params.
WADO_METADATA_STUDY_VF = (
    "SELECT m.metadata, m.metadataendoffset, i.content_pkey AS content_pkey, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    + _METADATA_INSTANCE_COLS +
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    "FROM instance i "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments WHERE virtual_folder_id = %s) "
    "  AND st.studyinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

WADO_METADATA_SERIES_VF = (
    "SELECT m.metadata, m.metadataendoffset, i.content_pkey AS content_pkey, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    + _METADATA_INSTANCE_COLS +
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    "FROM instance i "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments WHERE virtual_folder_id = %s) "
    "  AND s.seriesinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

# Single-instance form keeps the inner join on Instancemetadata, same as the
# datastore variant: with nothing to be partial about, a blob-less instance
# reads as 404 rather than an empty array.
WADO_METADATA_INSTANCE_VF = (
    "SELECT m.metadata, m.metadataendoffset, i.content_pkey AS content_pkey, "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    + _METADATA_INSTANCE_COLS +
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "  # nosec B608 - trusted identifier + bound %s params; no user value interpolated (audited)
    "FROM Instancemetadata m "
    "JOIN instance i  ON i.instance_pkey  = m.instance_pkey "
    "JOIN series   s  ON s.series_pkey = i.series_pkey "
    "JOIN study    st ON st.study_pkey = s.study_pkey "
    "WHERE i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments WHERE virtual_folder_id = %s) "
    "  AND i.sopinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)

WADO_INSTANCE_LOC_VF = (
    "SELECT il.s3_bucket_name AS bucketname, il.s3_key AS s3key, il.member_offset, il.member_length, "
    "       m.metadataendoffset, m.frame_offsets, "
    "       m.jpeg_tables_offset, m.jpeg_tables_length, "
    "       m.icc_profile_offset, m.icc_profile_length, "
    "       i.transfersyntaxuid AS transfer_syntax, "
    "       i.`rows` AS rows_, "
    "       i.`columns` AS columns_, "
    "       i.bitsallocated AS bits_allocated, "
    "       i.samplesperpixel AS samples_per_pixel, "
    "       i.numberofframes AS number_of_frames, "
    "       i.sopclassuid AS sop_class_uid, "
    "       i.dimensionorganizationtype AS dimension_organization_type, "
    "       i.totalpixelmatrixcolumns AS total_pixel_matrix_columns, "
    "       i.totalpixelmatrixrows AS total_pixel_matrix_rows, "
    "       COALESCE(i.instanceavailability, 'ONLINE') AS availability "
    "FROM instance i "
    "JOIN storage_index il        ON il.content_pkey = i.content_pkey AND il.deleted_at IS NULL "
    "JOIN series   s              ON s.series_pkey = i.series_pkey "
    "JOIN study    st             ON st.study_pkey = s.study_pkey "
    "LEFT JOIN Instancemetadata m ON m.instance_pkey = i.instance_pkey "
    "WHERE i.content_pkey IN (SELECT content_pkey FROM virtual_folder_assignments WHERE virtual_folder_id = %s) "
    "  AND i.sopinstanceuid = %s "
    "  AND i.deleted_at IS NULL AND s.deleted_at IS NULL AND st.deleted_at IS NULL"
)
