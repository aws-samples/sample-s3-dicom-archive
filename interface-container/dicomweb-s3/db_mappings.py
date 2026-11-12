"""DICOM tag <-> index-column maps for the QIDO result builder.

Column names are looked up through these dicts and interpolated into SQL, so a
tag that is not a key here can never reach the database. That is the whole
reason the maps exist — `_construct_query` never sees a client-supplied
identifier.

Underscore-prefixed values are NOT real columns. They are read-time aliases
produced by subqueries or COALESCE expressions in `_construct_query`. MySQL
forbids a select-list alias in `WHERE`, so any tag whose value starts with `_`
must either stay out of the filter allowlists in `qido_search_tags.py` or carry
an entry in `_FILTER_COLUMN_OVERRIDES` there.
"""

tables = {
    "study_table" : "study",
    "patient_table" : "patient",
    "series_table" : "series",
    "instance_table" : "instance",
}

table_unique_keys = {
    "study_table" : "study_pkey",
    "patient_table" : "patient_pkey",
    "series_table" : "series_pkey",
    "instance_table" : "instance_pkey",
}

# Patient-level fields (also surfaced through study-level QIDO responses)
patientTagsfields = {
    "00100010" : "patientname",
    "00100020" : "patientid",
    "00100030" : "patientbirthdate",
    "00100040" : "patientsex",
}

# Study-level QIDO output tags. Underscore-prefixed columns are computed at read
# time via subqueries in _construct_query (they don't exist on the study table).
studyTagsTofields = {
    # Study
    "00080005" : "specificcharacterset",  # Specific Character Set
    "00080020" : "studydate",            # Study Date
    "00080030" : "studytime",            # Study Time
    "00080050" : "accessionnumber",      # Accession Number
    # Instance Availability, rolled up from the study's series (computed). There
    # is no study.availability column and Phase 2 adds no DDL.
    "00080056" : "_availability",
    "00080061" : "_modalitiesinstudy",   # Modalities In Study (computed)
    "00080090" : "referringphysicianname",
    "00081030" : "studydescription",
    "0020000D" : "studyinstanceuid",
    "00200010" : "studyid",
    "00201206" : "_numstudyseries",      # Number of Study Related Series (computed)
    "00201208" : "_numstudyinstances",   # Number of Study Related Instances (computed)
    # Patient (joined from patient table)
    "00100010" : "patientname",
    "00100020" : "patientid",
    "00100030" : "patientbirthdate",
    "00100040" : "patientsex",
}

seriesTagsTofields = {
    "00080060" : "modality",             # Modality
    "00080201" : "timezoneoffsetfromutc",  # Timezone Offset From UTC
    "00080021" : "seriesdate",           # Series Date
    "00080056" : "_availability",        # Instance Availability (COALESCEd)
    "0008103E" : "seriesdescription",    # Series Description
    "00081190" : "retrieveurl",          # Retrieve URL
    # Parent UID, from the joined study row. PS3.18 requires SearchForSeries to
    # return it; the reference had no entry, so its /series responses carried no
    # StudyInstanceUID at all.
    "0020000D" : "_studyinstanceuid",
    "0020000E" : "seriesinstanceuid",    # Series Instance UID
    "00200011" : "seriesnumber",         # Series Number
    "00201209" : "_seriesinstances",     # Number of Series Related Instances (computed)
    "00400244" : "performedprocedurestepstartdate",
    "00400245" : "performedprocedurestepstarttime",
    "00400275" : "requestattributessequence",
    "00400009" : "scheduledprocedurestepid",
    "00401001" : "requestedprocedureid",
}

instanceTagsTofields = {
    "00080016" : "sopclassuid",          # SOP Class UID
    "00080018" : "sopinstanceuid",       # SOP Instance UID
    # Instance Availability. COALESCEd to 'ONLINE' in the proto, hence the alias
    # rather than the bare d00080056 column: a NULL means ONLINE and clients
    # must not have to know that.
    "00080056" : "_availability",
    "00080201" : "timezoneoffsetfromutc",  # Timezone Offset From UTC
    "00081190" : "retrieveurl",          # Retrieve URL
    # Parent UIDs, from the joined series/study rows. Same PS3.18 gap as above —
    # SearchForInstances has to return both.
    "0020000D" : "_studyinstanceuid",
    "0020000E" : "_seriesinstanceuid",
    "00200013" : "instancenumber",       # Instance Number
    "00280010" : "rows",                 # Rows
    "00280011" : "columns",              # Columns
    "00280100" : "bitsallocated",        # Bits Allocated
    "00280008" : "numberofframes",       # Number of Frames
    # WSI geometry (whole-slide microscopy). OHIF reads these from WADO
    # /metadata, not QIDO, so they're optional here — surfaced for completeness
    # and for clients that request them via includefield.
    "00480006" : "totalpixelmatrixcolumns",  # Total Pixel Matrix Columns
    "00480007" : "totalpixelmatrixrows",     # Total Pixel Matrix Rows
    "00209311" : "dimensionorganizationtype",  # Dimension Organization Type
}
