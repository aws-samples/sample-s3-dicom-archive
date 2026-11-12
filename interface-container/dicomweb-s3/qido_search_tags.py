"""Filter allowlists for QIDO-RS.

A *search key* is only honored if its tag appears in the allowlist for the query
level, so a client-supplied identifier never reaches the WHERE builder. A search
key outside the allowlist is *rejected* (400), not dropped: dropping a filter
widens the query, and a client asking for one patient would get the whole
datastore back under a 200. `filter_tag_for()` is the single gate — resolve every
candidate filter key through it.

Anything that is not a search key at all is ignored, not rejected — see
`is_search_key()` for where that line is drawn and why it has to exist.

Adding a tag here is not free: the WHERE builder emits the *bare* column name
from `db_mappings`, so a tag whose mapping is a select-list alias (leading `_`)
raises MySQL 1054, and a tag whose column exists on more than one joined table
raises 1052. `_FILTER_COLUMN_OVERRIDES` below is the escape hatch for the first
case; there is none for the second.
"""
import re

from pydicom.datadict import tag_for_keyword

_HEX_TAG = re.compile(r"[0-9A-Fa-f]{8}\Z")


def is_search_key(key: str) -> bool:
    """True when `key` names a DICOM attribute, i.e. the client meant it as a filter.

    This is the refuse-vs-ignore line, and both halves matter.

    PS3.18 §8.3.4 says an origin server ignores a query parameter it does not
    recognize, and plenty of them arrive: jQuery/axios cache-busters (`_=1699…`),
    viewer bookkeeping, CDN and vendor extensions. Refusing those breaks working
    clients and is a conformance defect, and ignoring them is safe because they
    were never going to narrow the result set.

    An attribute is the opposite case. Silently dropping one *widens* the query, so
    a one-patient question would be answered with the whole datastore under a 200
    — which is why an attribute this level cannot honor is refused instead. Only
    attributes reach `filter_tag_for()`.

    Accepts the hex form (`00100020`), the keyword form (`PatientID`) and the
    dotted sequence path of either (`00400275.00401001`), matching what a client
    is allowed to send.
    """
    # The empty-part guard is not cosmetic: pydicom's keyword table maps '' to a
    # real tag (retired entries with a blank keyword), so without it a stray `&`
    # in the query string would arrive as a search key and earn a 400.
    return all(part and (_HEX_TAG.match(part) or tag_for_keyword(part) is not None)
               for part in key.split("."))

# `00080061` (ModalitiesInStudy) maps to the computed alias `_modalitiesinstudy`,
# and MySQL rejects a select-list alias in WHERE. It is filterable anyway via the
# EXISTS translation in `_FILTER_EXISTS_SUBQUERIES` below, which goes to the real
# `series.modality` column instead of the alias. OHIF and Weasis both send this
# key on a study list, so refusing it 400'd the whole study query.
SearchForstudiesTags = {
    "00080020": "StudyDate",
    "00080030": "StudyTime",
    "00080050": "AccessionNumber",
    "00080061": "ModalitiesInStudy",
    "00081030": "StudyDescription",         #Not in the Standard but we should be able to support it.
    "00080090": "ReferringPhysicianName",
    "00100020": "PatientID",
    "00100010": "PatientName",
    "0020000D": "StudyInstanceUID",
    "00200010": "StudyID",
}

# The five 0040xxxx tags map to real series columns that no writer populates, so
# those filters always match zero rows. They stay because removing them is a
# client-visible behavior change and matching nothing is not a wrong answer.
SearchForSeriesTags = {
    "00080060": "Modality",
    "0020000E": "SeriesInstanceUID",
    "00200011": "SeriesNumber",
    "00400244": "PerformedProcedureStepStartDate",
    "00400245": "PerformedProcedureStepStartTime",
    "00400275": "RequestAttributesSequence",
    "00400009": "ScheduledProcedureStepID",
    "00401001": "RequestedProcedureID",
}

# Deliberately narrow. `timezoneoffsetfromutc` and `retrieveurl` exist on both `series` and
# `instance`, so widening this to either would make the unqualified WHERE builder
# emit an ambiguous column reference.
SearchForInstancesTags = {
    "00080016": "SOPClassUID",
    "00080018": "SOPInstanceUID",
    "00200013": "InstanceNumber",
}

# PS3.18 §6.7.1.2 relational queries: an instance-level query may be FILTERED by
# attributes of its parent Study and Series (a study/{uid}/instances?Modality=PR
# is "instances of this study whose series modality is PR"). The instance protos
# in _construct_query already JOIN series and study, so those columns are
# reachable — they just need to be allowlisted and mapped to the qualified parent
# column via _FILTER_COLUMN_OVERRIDES / _FILTER_EXISTS_SUBQUERIES below.
#
# Patient-level keys (PatientID/PatientName) are intentionally EXCLUDED: the
# instance protos do NOT join `patient`, so those filters have no column to bind.
# Only series columns and study columns that are NOT patient demographics.
_ParentSearchForInstancesTags = {
    **SearchForInstancesTags,
    # Series-level
    "00080060": "Modality",
    "0020000E": "SeriesInstanceUID",
    "00200011": "SeriesNumber",
    "00400244": "PerformedProcedureStepStartDate",
    "00400245": "PerformedProcedureStepStartTime",
    "00400009": "ScheduledProcedureStepID",
    "00401001": "RequestedProcedureID",
    # Study-level (non-patient)
    "00080020": "StudyDate",
    "00080030": "StudyTime",
    "00080050": "AccessionNumber",
    "00080061": "ModalitiesInStudy",
    "00081030": "StudyDescription",
    "00080090": "ReferringPhysicianName",
    "0020000D": "StudyInstanceUID",
    "00200010": "StudyID",
}

# (0008,0056) Instance Availability is intentionally in none of the three lists.
# It maps to the `_availability` alias at every level, so filtering on it would
# hit the same MySQL 1054 trap as ModalitiesInStudy. In Phase 2 availability is a
# returned attribute, not a searchable one.


class UnsupportedFilterError(ValueError):
    """A query parameter that is not a filter this level can honor.

    Carries the offending key so the handler can name it in the 400 body. The key
    is client-supplied and may be echoed; the *value* never is — a filter value is
    PHI (patient name, accession number, birth date).
    """

    def __init__(self, key: str):
        super().__init__(f"unsupported query parameter '{key}'")
        self.key = key


def filter_tag_for(filter_tags: dict, key: str) -> str:
    """Resolve a query parameter to its allowlisted tag, or raise.

    Accepts either the hex tag (`00100020`) or the keyword (`PatientID`), matching
    what PS3.18 §8.3.4 lets a client send.
    """
    if key in filter_tags:
        return key
    for tag, keyword in filter_tags.items():
        if key == keyword:
            return tag
    raise UnsupportedFilterError(key)


# Real qualified columns for filter tags whose db_mappings value is a read-time
# alias. Keyed (query level, tag); consulted only by the WHERE builder, so the
# result-dict entries keep their aliases.
#
# Without this, `GET /series?StudyInstanceUID=X` either drops the filter (as the
# reference did, silently returning every series in the datastore) or emits
# `AND _studyinstanceuid = %s` and 500s.
_FILTER_COLUMN_OVERRIDES = {
    ("SERIES", "0020000D"): "{study_table}.studyinstanceuid",
    # The instance levels do not currently accept either parent UID as a filter,
    # but the overrides are here so that widening SearchForInstancesTags is a
    # one-line change instead of a 1054 in production.
    ("INSTANCE", "0020000D"): "{study_table}.studyinstanceuid",
    ("INSTANCE", "0020000E"): "{series_table}.seriesinstanceuid",
    ("STUDY.INSTANCE", "0020000D"): "{study_table}.studyinstanceuid",
    ("STUDY.INSTANCE", "0020000E"): "{series_table}.seriesinstanceuid",
    ("STUDY.SERIES.INSTANCE", "0020000D"): "{study_table}.studyinstanceuid",
    ("STUDY.SERIES.INSTANCE", "0020000E"): "{series_table}.seriesinstanceuid",

    # SearchForSeries accepts every study-level key (_filter_tag_dict merges
    # SearchForstudiesTags into the SERIES level), but none of these tags exist in
    # `seriesTagsTofields` — so before these entries the WHERE builder hit its
    # `tag not in tag_dict` branch and DROPPED the filter. `GET /series?PatientID=X`
    # answered with every series in the datastore under a 200. The columns are all
    # reachable: SERIES joins `study` and (as of this change) `patient`.
    ("SERIES", "00080020"): "{study_table}.studydate",
    ("SERIES", "00080030"): "{study_table}.studytime",
    ("SERIES", "00080050"): "{study_table}.accessionnumber",
    ("SERIES", "00080090"): "{study_table}.referringphysicianname",
    ("SERIES", "00081030"): "{study_table}.studydescription",
    ("SERIES", "00200010"): "{study_table}.studyid",
    ("SERIES", "00100010"): "{patient_table}.patientname",
    ("SERIES", "00100020"): "{patient_table}.patientid",
}

# Relational instance-level filters on PARENT attributes (PS3.18 §6.7.1.2). The
# instance protos JOIN series and study, so these resolve to the qualified parent
# column. Applied to all three instance levels (bare INSTANCE, STUDY.INSTANCE,
# STUDY.SERIES.INSTANCE). Patient columns are absent — the instance protos do not
# join `patient`, so PatientID/PatientName are not in the instance allowlist.
_INSTANCE_PARENT_FILTERS = {
    # Series-level columns (seriesTagsTofields → real `series` columns)
    "00080060": "{series_table}.modality",
    "0020000E": "{series_table}.seriesinstanceuid",
    "00200011": "{series_table}.seriesnumber",
    "00400244": "{series_table}.performedprocedurestepstartdate",
    "00400245": "{series_table}.performedprocedurestepstarttime",
    "00400009": "{series_table}.scheduledprocedurestepid",
    "00401001": "{series_table}.requestedprocedureid",
    # Study-level columns (studyTagsTofields → real `study` columns; non-patient)
    "0020000D": "{study_table}.studyinstanceuid",
    "00080020": "{study_table}.studydate",
    "00080030": "{study_table}.studytime",
    "00080050": "{study_table}.accessionnumber",
    "00081030": "{study_table}.studydescription",
    "00080090": "{study_table}.referringphysicianname",
    "00200010": "{study_table}.studyid",
}
for _lvl in ("INSTANCE", "STUDY.INSTANCE", "STUDY.SERIES.INSTANCE"):
    for _tag, _col in _INSTANCE_PARENT_FILTERS.items():
        _FILTER_COLUMN_OVERRIDES.setdefault((_lvl, _tag), _col)

# Filter tags that cannot be expressed as a single column because the value they
# match lives in a one-to-many child table. The template is wrapped around the
# comparison the WHERE builder produces, so `=`, `IN (...)` and `LIKE` all keep
# working; `{predicate}` is where that comparison lands.
#
# ModalitiesInStudy is the only such tag today. Its DICOM semantics are "this
# study contains at least one series with this modality", which is EXISTS — a
# join would multiply the study row once per matching series.
#
# `{alias}` is deliberately not a real table name: an unqualified inner column
# would be ambiguous against the outer `series` at the SERIES level.
#
# No datastore predicate belongs inside the subquery. It correlates on
# `study_pkey`, and that study row is already tenancy-scoped by the outer WHERE —
# the same reasoning the derived read-time subqueries in _construct_query use.
_FILTER_EXISTS_SUBQUERIES = {
    ("STUDY", "00080061"): {
        "column": "mis.modality",
        "wrap": ("EXISTS (SELECT 1 FROM {series_table} mis "
                 "WHERE mis.{study_pkey} = {study_table}.{study_pkey} "
                 "{live}AND {predicate})"),
    },
    # Same template at SERIES level: `study` is joined there too, so the
    # correlation is identical. Answers "series whose study contains modality X".
    ("SERIES", "00080061"): {
        "column": "mis.modality",
        "wrap": ("EXISTS (SELECT 1 FROM {series_table} mis "
                 "WHERE mis.{study_pkey} = {study_table}.{study_pkey} "
                 "{live}AND {predicate})"),
    },
}

# Instance-level ModalitiesInStudy (PS3.18 relational): the instance protos join
# `study`, so the same study-correlated EXISTS answers "instances of a study that
# contains modality X". Registered for all three instance levels.
for _lvl in ("INSTANCE", "STUDY.INSTANCE", "STUDY.SERIES.INSTANCE"):
    _FILTER_EXISTS_SUBQUERIES[(_lvl, "00080061")] = {
        "column": "mis.modality",
        "wrap": ("EXISTS (SELECT 1 FROM {series_table} mis "
                 "WHERE mis.{study_pkey} = {study_table}.{study_pkey} "
                 "{live}AND {predicate})"),
    }


def filter_is_mappable(level: str, tag: str, result_tags: dict) -> bool:
    """Can this level actually turn `tag` into SQL?

    The allowlists say what a client may *send*; this says what the WHERE builder
    can *emit*. They drifted apart once already, and the failure was silent and
    one-directional: a filter the builder could not map was skipped, which widens
    the result set rather than narrowing it. Checked while parsing so the answer
    is a 400, not a 200 carrying rows the client never asked for.

    Mappable means one of: an EXISTS translation, a column override, or a real
    (non-alias) column in the level's own result dict. A leading underscore marks
    a read-time alias, which MySQL rejects in WHERE (error 1054).
    """
    if (level, tag) in _FILTER_EXISTS_SUBQUERIES:
        return True
    if (level, tag) in _FILTER_COLUMN_OVERRIDES:
        return True
    column = result_tags.get(tag)
    return column is not None and not column.startswith("_")
