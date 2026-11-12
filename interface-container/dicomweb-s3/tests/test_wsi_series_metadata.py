"""Regression: series /metadata for a virtualized WSI (SVS) study must return
one DISTINCT entry per pyramid level, not N copies of one level's header.

A whole-slide study virtualized from a single .svs object is N DICOM WSI
level-instances that all share ONE physical object, hence ONE `content_pkey` and
ONE `Instancemetadata` blob. The LEFT JOIN in WADO_METADATA_SERIES therefore maps
every level's `instance` row to the SAME gzipped blob (whichever level's header
was serialized at ingest). Serving that blob verbatim per row returned N
identical entries — same SOPInstanceUID, same (00480006,00480007) TotalPixelMatrix
dims — and SLIM >= 0.46 rejected the series with:

    "Multiple image instances for the same channel and focal plane have identical
     dimensions, but the instances are not part of a concatenation."

The fix, proven here on both surfaces:
  (a) WADO_METADATA_SERIES / _STUDY (+ _VF, + INSTANCE) carry each row's OWN
      identity columns out of the `instance` table as inst_* aliases; and
  (b) main._overlay_instance_identity writes those per-row values onto each
      entry's copy of the decoded blob, so the four levels come back distinct.

Values mirror the confirmed-live DB rows for study
2.25.335743071738833995079620327973077738827, series
2.25.172085635691869882347636847371946211095 (datastore e070bc5e...), a proper
4-level pyramid all sharing content_pkey=4.

This module is deliberately self-contained (its own minimal fake modelling the
production friendly-name `instance` schema) so it exercises the deployed SQL and
the real builder helper regardless of the older d######## fixtures in conftest.
"""
import copy
import gzip
import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))          # conftest stubs (pymysql/boto3/infra)
sys.path.insert(0, str(_HERE.parent))   # the service package

import conftest  # noqa: F401,E402  — installs the pymysql/boto3/infra stubs
import main  # noqa: E402
import sql_queries  # noqa: E402


# The confirmed-live 4-level pyramid. Each tuple:
#   (InstanceNumber, NumberOfFrames, TotalPixelMatrixColumns, TotalPixelMatrixRows, SOPInstanceUID)
CONTENT_PKEY = 4
STUDY_UID = "2.25.335743071738833995079620327973077738827"
SERIES_UID = "2.25.172085635691869882347636847371946211095"
DATASTORE_ID = "e070bc5e-02a6-452f-bba4-923aca1ba49c"
LEVELS = [
    (1, 177234, 83670, 138615, "2.25.49444599500415596225846755971392324890"),
    (3, 11152, 20917, 34653, "2.25.149168633722089377608249952301362171805"),
    (4, 714, 5229, 8663, "2.25.267778050277059948282556543784453649620"),
    (5, 54, 1307, 2165, "2.25.37614162633672833035795083978903063521"),
]
# The single shared blob every level maps to. It carries the LAST level's header
# (pkey7 in the ticket) — the exact bug shape: without the overlay all four
# entries would report 1307x2165 and SOP 2.25.376...521.
REPRESENTATIVE = LEVELS[-1]


def _shared_blob_json():
    inum, frames, tpmc, tpmr, sop = REPRESENTATIVE
    return {
        "00080016": {"vr": "UI", "Value": ["1.2.840.10008.5.1.4.1.1.77.1.6"]},
        "00080018": {"vr": "UI", "Value": [sop]},
        "00080060": {"vr": "CS", "Value": ["SM"]},
        "00200013": {"vr": "IS", "Value": [str(inum)]},
        "00280008": {"vr": "IS", "Value": [str(frames)]},
        "00480006": {"vr": "UL", "Value": [tpmc]},
        "00480007": {"vr": "UL", "Value": [tpmr]},
        "00209311": {"vr": "CS", "Value": ["TILED_FULL"]},
    }


# ── (b) the builder helper: overlay yields four distinct entries ─────────────
def _rows_from_series_query():
    """The rows WADO_METADATA_SERIES yields for this series: one row per level,
    every row carrying the SAME shared blob but its OWN inst_* identity columns."""
    blob = gzip.compress(json.dumps(_shared_blob_json()).encode())
    rows = []
    for inum, frames, tpmc, tpmr, sop in LEVELS:
        rows.append({
            "metadata": blob,               # identical across all four rows
            "metadataendoffset": 0,
            "availability": "ONLINE",
            "inst_sopinstanceuid": sop,
            "inst_instancenumber": inum,
            "inst_numberofframes": frames,
            "inst_totalpixelmatrixcolumns": tpmc,
            "inst_totalpixelmatrixrows": tpmr,
        })
    return rows


def _build_entries(rows):
    """Mirror the production stream loop: decode the shared blob per row and
    overlay this instance's identity onto its own copy."""
    entries = []
    for row in rows:
        obj = json.loads(gzip.decompress(row["metadata"]))
        main._overlay_instance_identity(obj, row)
        entries.append(obj)
    return entries


def test_builder_emits_four_distinct_entries_from_one_shared_blob():
    rows = _rows_from_series_query()
    # Precondition: the raw blob really is identical for every row (the bug).
    assert len({r["metadata"] for r in rows}) == 1

    entries = _build_entries(rows)
    assert len(entries) == 4

    sops = [e["00080018"]["Value"][0] for e in entries]
    dims = [(e["00480006"]["Value"][0], e["00480007"]["Value"][0]) for e in entries]
    inums = [e["00200013"]["Value"][0] for e in entries]
    frames = [e["00280008"]["Value"][0] for e in entries]

    assert sops == [lvl[4] for lvl in LEVELS]
    assert dims == [(lvl[2], lvl[3]) for lvl in LEVELS]
    assert inums == [str(lvl[0]) for lvl in LEVELS]
    assert frames == [str(lvl[1]) for lvl in LEVELS]

    # The SLIM crash condition: no two entries share both dims (per level).
    assert len(set(dims)) == 4, "TotalPixelMatrix dims must be distinct per level"
    assert len(set(sops)) == 4, "SOPInstanceUID must be distinct per level"

    # UL geometry stays numeric DICOM-JSON, not stringified.
    for e in entries:
        assert isinstance(e["00480006"]["Value"][0], int)
        assert isinstance(e["00480007"]["Value"][0], int)


def test_overlay_leaves_non_wsi_blob_untouched_when_row_lacks_columns():
    """A plain instance whose row does not carry the WSI columns keeps its blob
    values (the overlay is a no-op on missing/NULL columns)."""
    blob = _shared_blob_json()
    before = copy.deepcopy(blob)
    main._overlay_instance_identity(blob, {"metadata": b"", "availability": "ONLINE"})
    assert blob == before

    # A row present but NULL also leaves the blob value untouched.
    blob2 = _shared_blob_json()
    main._overlay_instance_identity(blob2, {"inst_totalpixelmatrixcolumns": None})
    assert blob2["00480006"]["Value"] == before["00480006"]["Value"]


# ── (a) the SQL result shape: query carries per-instance identity out ────────
_INSTANCE_COLS = {
    "content_pkey", "datastore_id", "series_pkey", "deleted_at",
    "sopinstanceuid", "instancenumber", "numberofframes",
    "totalpixelmatrixcolumns", "totalpixelmatrixrows", "instanceavailability",
}
_META_ALIASES = {
    "inst_sopinstanceuid": "sopinstanceuid",
    "inst_instancenumber": "instancenumber",
    "inst_numberofframes": "numberofframes",
    "inst_totalpixelmatrixcolumns": "totalpixelmatrixcolumns",
    "inst_totalpixelmatrixrows": "totalpixelmatrixrows",
}


def test_series_metadata_query_selects_per_instance_identity_columns():
    """The deployed SELECT must carry each row's own identity out of `instance`,
    or the builder has nothing to overlay and the bug returns."""
    q = " ".join(sql_queries.WADO_METADATA_SERIES.split())
    for alias, col in _META_ALIASES.items():
        assert f"i.{col} AS {alias}".lower() in q.lower(), \
            f"WADO_METADATA_SERIES must select i.{col} AS {alias}"
    # And it must still drive from `instance` (LEFT JOIN blob) so a blob-less
    # instance is a NULL row, not a dropped one.
    assert "from instance i" in q.lower()
    assert "left join instancemetadata m" in q.lower()


def test_all_metadata_queries_carry_the_overlay_columns():
    for name in ("WADO_METADATA_STUDY", "WADO_METADATA_SERIES",
                 "WADO_METADATA_INSTANCE", "WADO_METADATA_STUDY_VF",
                 "WADO_METADATA_SERIES_VF", "WADO_METADATA_INSTANCE_VF"):
        q = " ".join(getattr(sql_queries, name).split()).lower()
        for alias, col in _META_ALIASES.items():
            assert f"i.{col} as {alias}" in q, f"{name} missing i.{col} AS {alias}"


class _SharedBlobFake:
    """A minimal executor modelling the production friendly-name `instance`
    schema (which conftest's older d######## fixtures do not), just enough to run
    WADO_METADATA_SERIES over a WSI series whose four rows share one content_pkey
    and one Instancemetadata blob, and to prove the query returns four rows with
    distinct dims sourced from the instance columns."""

    def __init__(self):
        self.instances = []      # friendly-name instance rows
        self.metadata = {}       # content_pkey -> blob
        self.series = {}         # series_pkey -> seriesinstanceuid
        self.studies = {}        # study_pkey -> studyinstanceuid
        self.series_study = {}   # series_pkey -> study_pkey

    def run_series_metadata(self, datastore_id, series_uid):
        # Faithful to the query: instance i JOIN series JOIN study LEFT JOIN blob,
        # filtered by datastore + series UID + deleted_at IS NULL at every level.
        out = []
        for i in self.instances:
            if i["datastore_id"] != datastore_id or i["deleted_at"] is not None:
                continue
            spk = i["series_pkey"]
            if self.series.get(spk) != series_uid:
                continue
            stpk = self.series_study.get(spk)
            if stpk not in self.studies:
                continue
            blob = self.metadata.get(i["content_pkey"])
            out.append({
                "metadata": blob,
                "metadataendoffset": 0,
                "availability": i.get("instanceavailability") or "ONLINE",
                "inst_sopinstanceuid": i["sopinstanceuid"],
                "inst_instancenumber": i["instancenumber"],
                "inst_numberofframes": i["numberofframes"],
                "inst_totalpixelmatrixcolumns": i["totalpixelmatrixcolumns"],
                "inst_totalpixelmatrixrows": i["totalpixelmatrixrows"],
            })
        return out


def _seed_wsi_series():
    db = _SharedBlobFake()
    db.studies[10] = STUDY_UID
    db.series[20] = SERIES_UID
    db.series_study[20] = 10
    db.metadata[CONTENT_PKEY] = gzip.compress(json.dumps(_shared_blob_json()).encode())
    for inum, frames, tpmc, tpmr, sop in LEVELS:
        row = {c: None for c in _INSTANCE_COLS}
        row.update(
            content_pkey=CONTENT_PKEY, datastore_id=DATASTORE_ID, series_pkey=20,
            deleted_at=None, sopinstanceuid=sop, instancenumber=inum,
            numberofframes=frames, totalpixelmatrixcolumns=tpmc,
            totalpixelmatrixrows=tpmr, instanceavailability=None,
        )
        db.instances.append(row)
    return db


def test_series_query_returns_four_rows_with_distinct_dims_from_shared_blob():
    db = _seed_wsi_series()
    rows = db.run_series_metadata(DATASTORE_ID, SERIES_UID)

    # Four instance rows, ONE shared physical object / blob.
    assert len(rows) == 4
    assert len({r["metadata"] for r in rows}) == 1, "all four share one blob"
    assert len({id(db.metadata[CONTENT_PKEY])}) == 1

    # The per-instance identity carried out of the instance columns is distinct.
    dims = [(r["inst_totalpixelmatrixcolumns"], r["inst_totalpixelmatrixrows"]) for r in rows]
    assert dims == [(lvl[2], lvl[3]) for lvl in LEVELS]
    assert len(set(dims)) == 4
    assert len({r["inst_sopinstanceuid"] for r in rows}) == 4

    # End-to-end: feeding these rows through the real builder yields four
    # distinct DICOM-JSON entries.
    entries = _build_entries(rows)
    served_dims = {(e["00480006"]["Value"][0], e["00480007"]["Value"][0]) for e in entries}
    assert served_dims == {(lvl[2], lvl[3]) for lvl in LEVELS}


# ── PRIMARY FIX: Instancemetadata re-keyed to instance_pkey ──────────────────
# The real bug was not just identical identity tags — it was that ONE shared blob
# per content_pkey meant every WSI level served the SAME PixelSpacing AND the
# SAME frame_offsets (pixel-locators), so non-base levels could not tile. The fix
# re-keys Instancemetadata on instance_pkey, so each level persists+serves its
# OWN complete header (incl per-level PixelSpacing) and its OWN frame_offsets.
# These tests assert the read-side joins now key on instance_pkey and that a
# per-instance-blob model yields distinct PixelSpacing/frame_offsets per level.

# Per-level PixelSpacing (52009229>00289110>00280030) and a distinct 1-entry
# frame_offsets stand-in per level. Base ~4x smaller spacing than the next level.
_LEVEL_SPACING = ["0.00025000", "0.00100000", "0.00400000", "0.01600000"]


def _per_level_blob_json(level_idx):
    inum, frames, tpmc, tpmr, sop = LEVELS[level_idx]
    sp = _LEVEL_SPACING[level_idx]
    return {
        "00080016": {"vr": "UI", "Value": ["1.2.840.10008.5.1.4.1.1.77.1.6"]},
        "00080018": {"vr": "UI", "Value": [sop]},
        "00080060": {"vr": "CS", "Value": ["SM"]},
        "00200013": {"vr": "IS", "Value": [str(inum)]},
        "00280008": {"vr": "IS", "Value": [str(frames)]},
        "00480006": {"vr": "UL", "Value": [tpmc]},
        "00480007": {"vr": "UL", "Value": [tpmr]},
        "00209311": {"vr": "CS", "Value": ["TILED_FULL"]},
        # SharedFunctionalGroupsSequence > PixelMeasuresSequence > PixelSpacing
        "52009229": {"vr": "SQ", "Value": [{
            "00289110": {"vr": "SQ", "Value": [{
                "00280030": {"vr": "DS", "Value": [sp, sp]},
            }]},
        }]},
    }


def test_metadata_queries_key_on_instance_pkey_not_content_pkey():
    """The primary fix: WADO metadata/location joins must resolve the blob per
    instance (m.instance_pkey = i.instance_pkey), NOT per shared object
    (m.content_pkey = i.content_pkey), or WSI levels collapse to one blob again."""
    for name in ("WADO_METADATA_STUDY", "WADO_METADATA_SERIES",
                 "WADO_METADATA_INSTANCE", "WADO_METADATA_STUDY_VF",
                 "WADO_METADATA_SERIES_VF", "WADO_METADATA_INSTANCE_VF",
                 "WADO_INSTANCE_LOC", "WADO_INSTANCE_LOC_VF",
                 "WADO_LOC_BY_STUDY", "WADO_LOC_BY_SERIES", "WADO_LOC_BY_INSTANCE"):
        q = " ".join(getattr(sql_queries, name).split()).lower()
        keyed_on_instance = (
            "m.instance_pkey = i.instance_pkey" in q
            or "i.instance_pkey = m.instance_pkey" in q
        )
        assert keyed_on_instance, \
            f"{name} must join Instancemetadata on instance_pkey"
        assert "m.content_pkey = i.content_pkey" not in q, \
            f"{name} must NOT join Instancemetadata on content_pkey (collapses WSI levels)"
        assert "i.content_pkey = m.content_pkey" not in q, \
            f"{name} must NOT join Instancemetadata on content_pkey (collapses WSI levels)"


class _PerInstanceBlobFake(_SharedBlobFake):
    """Models the FIXED schema: Instancemetadata keyed on instance_pkey, so each
    WSI level row resolves to its OWN blob (own PixelSpacing + frame_offsets)."""

    def __init__(self):
        super().__init__()
        self.metadata_by_instance = {}   # instance_pkey -> blob
        self.frame_offsets = {}          # instance_pkey -> frame_offsets list

    def run_series_metadata(self, datastore_id, series_uid):
        out = []
        for i in self.instances:
            if i["datastore_id"] != datastore_id or i["deleted_at"] is not None:
                continue
            spk = i["series_pkey"]
            if self.series.get(spk) != series_uid:
                continue
            if self.series_study.get(spk) not in self.studies:
                continue
            ipk = i["instance_pkey"]
            out.append({
                "metadata": self.metadata_by_instance.get(ipk),
                "frame_offsets": self.frame_offsets.get(ipk),
                "metadataendoffset": 0,
                "availability": "ONLINE",
                "inst_sopinstanceuid": i["sopinstanceuid"],
                "inst_instancenumber": i["instancenumber"],
                "inst_numberofframes": i["numberofframes"],
                "inst_totalpixelmatrixcolumns": i["totalpixelmatrixcolumns"],
                "inst_totalpixelmatrixrows": i["totalpixelmatrixrows"],
            })
        return out


def _seed_wsi_series_per_instance():
    db = _PerInstanceBlobFake()
    db.studies[10] = STUDY_UID
    db.series[20] = SERIES_UID
    db.series_study[20] = 10
    for idx, (inum, frames, tpmc, tpmr, sop) in enumerate(LEVELS):
        ipk = 100 + idx            # distinct storage instance_pkey per level
        row = {c: None for c in _INSTANCE_COLS}
        row.update(
            content_pkey=CONTENT_PKEY,   # all levels STILL share one object
            datastore_id=DATASTORE_ID, series_pkey=20, deleted_at=None,
            sopinstanceuid=sop, instancenumber=inum, numberofframes=frames,
            totalpixelmatrixcolumns=tpmc, totalpixelmatrixrows=tpmr,
            instanceavailability=None,
        )
        row["instance_pkey"] = ipk
        db.instances.append(row)
        db.metadata_by_instance[ipk] = gzip.compress(json.dumps(_per_level_blob_json(idx)).encode())
        # A distinct per-level frame_offsets (one [start,end] per frame stand-in).
        db.frame_offsets[ipk] = [[idx * 1000, idx * 1000 + 99]]
    return db


def test_per_instance_blob_yields_distinct_pixelspacing_and_frame_offsets():
    """With Instancemetadata keyed on instance_pkey, each level serves its OWN
    header (distinct PixelSpacing) and its OWN frame_offsets — the actual fix."""
    db = _seed_wsi_series_per_instance()
    rows = db.run_series_metadata(DATASTORE_ID, SERIES_UID)
    assert len(rows) == 4

    # Distinct blob per level now (not one shared blob).
    assert len({r["metadata"] for r in rows}) == 4, "each level has its own blob"

    def _pixel_spacing(blob):
        obj = json.loads(gzip.decompress(blob))
        return tuple(obj["52009229"]["Value"][0]["00289110"]["Value"][0]["00280030"]["Value"])

    spacings = [_pixel_spacing(r["metadata"]) for r in rows]
    assert spacings == [(s, s) for s in _LEVEL_SPACING]
    assert len(set(spacings)) == 4, "PixelSpacing must be distinct per level"
    # Base spacing (level 0) ~4x smaller than the next level.
    assert float(spacings[0][0]) * 4 == float(spacings[1][0])

    # Distinct frame_offsets per level (non-base levels can now tile).
    fos = [tuple(map(tuple, r["frame_offsets"])) for r in rows]
    assert len(set(fos)) == 4, "frame_offsets must be distinct per level"
