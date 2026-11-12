-- PHI notice: this module handles Protected Health Information (patient name, ID,
-- birth date, sex, accession number and other DICOM identifiers). Deployers are
-- responsible for HIPAA (and, where applicable, GDPR) controls under the AWS shared
-- responsibility model; use only synthetic data for testing. See PHI-HANDLING.md.
-- ============================================================================
-- S3-NATIVE STORAGE INDEX SCHEMA
-- ============================================================================
-- Ported from reference/dicomweb-s3/dicomweb-service/schema.sql with two
-- locked modifications: tenancy (datastore_id on all four tree tables —
-- patient/study/series/instance — included in the unique keys) and a widened
-- instanceid (BIGINT UNSIGNED, 63-bit hash over
-- 'datastore_id|SOPInstanceUID').
--
-- Invariant: this file always describes the current end-state and runs in
-- full on fresh installs. Deployments are assumed to be FRESH — there is no
-- migrations/ directory and no in-place upgrade path for these tables; a
-- schema change here means Drop + reingest.
--
-- That is affordable because these six tables are a DERIVED index, not a
-- system of record: every row is computed from an object in a datastore's
-- S3 archive bucket, so dropping the tables and reingesting the bucket
-- rebuilds them exactly. Operator Drop/Truncate/Sweep modes must only ever
-- touch these six tables — the rest of the dicomarchive database (users,
-- privileges, audit, jobs) is system-of-record and must never be swept.
--
-- These tables serve datastores with datastores.storage_type = 'S3' only.
-- They are created unconditionally but stay empty (inert) until an S3
-- datastore exists.
--
-- MySQL 8 / Aurora MySQL 3.x. FK dependency order, which is also the order
-- below: patient -> study -> series -> instance -> Instancelocation ->
-- Instancemetadata.
--
-- `deleted_at` appears on the four tree tables: NULL means live, non-NULL is
-- when the row was marked. The ingest hot path only ever sets it; the GC
-- sweep cascades marks upward and hard-deletes rows past its grace window.
-- Every read query filters `deleted_at IS NULL`, so a soft-deleted row is
-- invisible while it waits to be reaped.
-- ============================================================================

-- Patients are datastore-scoped like every other table in this index. PatientID
-- is assigned by the sending institution, so two datastores routinely carry the
-- same one for two different people; a patient row deduplicated globally on
-- ============================================================================
-- STORAGE INDEX (physical-file source of truth, per storage)
-- ============================================================================
-- One row per physical object in a storage's S3 bucket, keyed on the object
-- identity (datastore_id + s3_key + s3_key_version), NOT on DICOM UIDs. This is
-- what lets the archive:
--   * keep every file in a bucket even when SOP Instance UIDs collide within or
--     across storages (two files with the same UID are two distinct rows);
--   * hold conflicting metadata for the same UID in different storages;
--   * track NON-DICOM content (e.g. pathology / WSI source files) that has no
--     DICOM UIDs at all.
-- The DICOMweb query tree (patient/study/series/instance below) references these
-- rows via instance.content_pkey. It replaces the former Instancelocation table
-- (bucket/key/offset/size now live here).

-- FRESH INSTALL: drop the derived index tables first, in reverse-FK order, so a
-- pre-existing table from an earlier schema (e.g. a legacy `instance` without
-- content_pkey) can never be silently kept by CREATE TABLE IF NOT EXISTS and
-- then break the view that references the new columns. These six tables are a
-- DERIVED index (see header) — dropping and reingesting rebuilds them exactly.
-- The view is dropped too because it binds to the tables' columns.
DROP VIEW IF EXISTS v_datastore_summary;
-- virtual_folder_assignments (defined in schema-virtual-folder.sql, which runs
-- AFTER this file) carries a FOREIGN KEY to storage_index(content_pkey). On a
-- re-run that table already exists and its FK would block DROP TABLE
-- storage_index (error 3730). Drop it here first; virtual-folder.sql recreates
-- it with a fresh FK moments later. It is a rebuildable derived table (see
-- header).
--
-- VF Per-Database Redesign (Phase 5): the shared virtual_* de-id tree
-- (virtual_instance/imageset/series/study/patient) is GONE — each VF's tree now
-- lives in its own vf_<id> database with no cross-schema FK to storage_index —
-- so storage_index's DROP no longer depends on virtual_instance. The
-- DROP TABLE IF EXISTS lines for the old shared tree are kept purely to purge
-- any leftover pre-redesign tables from dicomarchive, and are harmless no-ops when
-- absent. (schema-virtual-folder.sql also drops them; either order is fine since
-- they no longer reference storage_index.)
DROP TABLE IF EXISTS virtual_folder_assignments;
DROP TABLE IF EXISTS virtual_instance;
DROP TABLE IF EXISTS virtual_imageset;
DROP TABLE IF EXISTS virtual_series;
DROP TABLE IF EXISTS virtual_study;
DROP TABLE IF EXISTS virtual_patient;
DROP TABLE IF EXISTS Instancemetadata;
DROP TABLE IF EXISTS Instancelocation;
DROP TABLE IF EXISTS instance;
DROP TABLE IF EXISTS series;
-- study_stats and its cursor are derived from study (FK fk_study_stats_study),
-- so they go before study; both are recreated below and refilled by stats sync.
DROP TABLE IF EXISTS study_stats;
DROP TABLE IF EXISTS stats_sync_cursor;
DROP TABLE IF EXISTS study;
DROP TABLE IF EXISTS patient;
DROP TABLE IF EXISTS storage_index;

CREATE TABLE IF NOT EXISTS storage_index (
    content_pkey    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- Tenancy: internal datastore UUID (datastores.id).
    datastore_id    VARCHAR(36) NOT NULL,
    -- Physical object identity.
    s3_bucket_name  VARCHAR(255) NOT NULL,
    s3_key          VARCHAR(1024) NOT NULL,
    -- S3 object version id; '' (not NULL) when the bucket is unversioned, so it
    -- stays part of the unique key without tripping NULL-comparison semantics.
    s3_key_version  VARCHAR(128) NOT NULL DEFAULT '',
    -- What kind of content this object is.
    content_kind    ENUM('DICOM','NON_DICOM') NOT NULL DEFAULT 'DICOM',
    -- For non-DICOM (pathology, etc.): a free MIME/type label.
    non_dicom_type  VARCHAR(128) NULL,
    -- DICOM UIDs AS READ FROM THIS FILE. NULL for non-DICOM content, or for a
    -- DICOM file whose header could not be parsed yet. Deliberately NOT unique:
    -- conflicts are allowed and expected.
    study_instance_uid  VARCHAR(128) NULL,
    series_instance_uid VARCHAR(128) NULL,
    sop_instance_uid    VARCHAR(128) NULL,
    transfer_syntax     VARCHAR(64)  NULL,
    -- Slice of the backing object this content occupies, for objects that hold
    -- more than one (uncompressed .tar indexed in place). NULL means the whole
    -- object is the content (every plain .dcm and every extracted member).
    member_offset   BIGINT UNSIGNED NULL,
    member_length   BIGINT UNSIGNED NULL,
    -- Stored bytes this row accounts for (whole object size, or member_length
    -- for a tar member). Written at ingest so statistics can SUM it after the
    -- S3 object is gone.
    size_bytes      BIGINT UNSIGNED NULL,
    -- S3 ETag of the backing object as read at ingest (quotes stripped). Used
    -- by delta sync (datastore-backfill mode='delta') to skip objects that are
    -- already indexed AND unchanged: the crawler compares ListObjectsV2's ETag
    -- to this value and only re-enqueues new-or-changed keys. NULL for rows
    -- written before this column existed, for a tar member (the member has no
    -- object-level ETag distinct from its container), and for any object whose
    -- ETag could not be captured — a NULL simply forces that key to re-enqueue
    -- (never skipped), so delta stays correct, just less efficient, for it.
    s3_etag         VARCHAR(64) NULL,
    -- Physical-object uniqueness rides on (datastore_id, s3_key, s3_key_version),
    -- but s3_key is VARCHAR(1024) and utf8mb4 makes that key 4752 bytes — over
    -- InnoDB's 3072-byte index limit (MySQL error 1071). So the UNIQUE index uses
    -- a STORED generated SHA-256 of s3_key (deterministic, 64 hex chars) instead
    -- of the raw column: (datastore_id, s3_key_hash, s3_key_version) is 912 bytes.
    -- Full-key uniqueness is preserved; ingest never has to compute the hash.
    s3_key_hash     CHAR(64) AS (SHA2(s3_key, 256)) STORED,
    -- Which slice of the object this row is: -1 for a whole object, else the
    -- member's byte offset. Part of the unique key, so each member of a tar
    -- indexed in place gets its own row (and content_pkey) instead of every
    -- member collapsing onto one row that carries the last member's window.
    member_slot     BIGINT AS (COALESCE(member_offset, -1)) STORED,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (content_pkey),
    -- Physical-object identity: the ingest upsert rides on this (via the hash).
    UNIQUE KEY uq_storage_object (datastore_id, s3_key_hash, s3_key_version, member_slot),
    KEY idx_storage_ds (datastore_id),
    KEY idx_storage_ds_kind (datastore_id, content_kind),
    -- Non-unique UID lookups (conflicts allowed): resolve a UID to its physical
    -- object(s) within a datastore.
    KEY idx_storage_sop (datastore_id, sop_instance_uid),
    KEY idx_storage_study (datastore_id, study_instance_uid),
    -- ingestion-v2: stage-2's backfill links instance.series_pkey by joining
    -- storage_index on (datastore_id, series_instance_uid); without this index
    -- that UPDATE full-scans storage_index (millions of rows) and times out, so
    -- instances never link to their series and study/series aggregate counts
    -- stay 0. content_pkey is included so it also covers the MAX(content_pkey)
    -- "latest instance" lookup stage-2 uses to build the parent rows.
    KEY idx_storage_series (datastore_id, series_instance_uid, content_pkey),
    KEY idx_storage_deleted (deleted_at),
    -- Covering index for the datastore statistics size rollup: the stats
    -- recompute does SUM(size_bytes) over instance JOIN storage_index filtered
    -- by (datastore_id, deleted_at). Including size_bytes makes that SUM
    -- index-only. Without it the recompute full-scanned storage_index (~800k+
    -- rows) and timed out, which is what pinned Aurora when stats ran per-instance.
    KEY idx_storage_ds_deleted (datastore_id, deleted_at, size_bytes)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ingestionV2 stage-2 watermark tracker  (a PENDING-WORK set)
-- ============================================================================
-- A row exists ONLY while a series has recompute work pending. stage-1 upserts
-- the row (raising last_content_pkey = GREATEST(...) to the batch max) whenever
-- it writes instances for a series. stage-2, after recomputing, DELETES the row
-- -- but only if last_content_pkey has not advanced past what it recomputed
-- (delete-if-unchanged), so a new instance arriving mid-recompute keeps the row
-- and re-triggers work. So: row present => pending; row absent => done. This
-- collapses the ~N-messages-per-series recompute storm (one per stage-1 batch
-- that touched the series) to ~1 real recompute per series, with an exact
-- content_pkey watermark rather than a time-based debounce. The table stays
-- small (only in-flight series), self-cleaning as work completes.
CREATE TABLE IF NOT EXISTS series_update_tracker (
    datastore_id          VARCHAR(64) NOT NULL,
    series_instance_uid   VARCHAR(64) NOT NULL,
    study_instance_uid    VARCHAR(64) NOT NULL,
    last_content_pkey     BIGINT UNSIGNED NOT NULL DEFAULT 0,
    -- Newest S3 eventTime seen for this series' pending instances. Single-stage
    -- coordination: a lambda upserts the row raising both last_content_pkey and
    -- last_event_time; it debounces, then does the aggregate only if the row is
    -- unchanged. The conditional DELETE still guards on last_content_pkey (it
    -- advances monotonically as new instances arrive), so if another lambda
    -- bumped the row mid-work the delete no-ops and that lambda owns the recompute.
    last_event_time       DATETIME(6) NULL,
    updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (datastore_id, series_instance_uid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- patientid would then be shared, and study-level QIDO in datastore A would
-- render B's PatientName, MRN and birth date because the demographics live in
-- the shared row rather than behind a crossable join. Scoping the row makes
-- that leak structurally impossible instead of merely unqueried.
CREATE TABLE IF NOT EXISTS patient (
    patient_pkey     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- Tenancy: internal datastore UUID (datastores.id, storage_type='S3'),
    -- same column and shape as study/series/instance below.
    datastore_id     VARCHAR(36) NOT NULL,
    patientid        VARCHAR(64),
    -- IssuerOfPatientID (0010,0021): the authority that assigned PatientID.
    -- PatientID alone is not globally unique — two sources can assign the same
    -- one to different people — so patient identity is
    -- (datastore_id, patientid, issuerofpatientid). Absent tag is stored as ''
    -- (NOT NULL) so no-issuer patients still dedup: NULL compares distinct in a
    -- unique key and would re-insert on every ingest.
    issuerofpatientid VARCHAR(64) NOT NULL DEFAULT '',
    patientname      VARCHAR(255),
    patientbirthdate DATE,
    patientsex       CHAR(1),
    -- last_updated tracks the newest change to this row OR any descendant
    -- (study/series/instance): the ingest path bumps it upward on child change,
    -- and ON UPDATE covers self-modification. The processing-job scheduler reads
    -- it to find data modified within a run window. See PROCESSING-JOB-SCHEDULER.
    last_updated     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at       TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (patient_pkey),
    -- Patient dedup, per datastore: the ingest upsert's ON DUPLICATE KEY rides
    -- on this composite key, so dedup stops at the tenancy boundary.
    UNIQUE KEY uq_patient_ds_id (datastore_id, patientid, issuerofpatientid),
    KEY idx_patient_deleted (deleted_at),
    KEY idx_patient_ds_updated (datastore_id, last_updated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS study (
    study_pkey                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    patient_pkey                  BIGINT UNSIGNED NOT NULL,
    -- Tenancy: internal datastore UUID (datastores.id, storage_type='S3').
    -- The archive supports the same StudyInstanceUID in more than one
    -- datastore, so the UID is only unique per datastore.
    datastore_id                  VARCHAR(36) NOT NULL,
    specificcharacterset          VARCHAR(64),
    studydate                     DATE,
    studytime                     TIME,
    accessionnumber               VARCHAR(64),
    -- modalitiesinstudy / numberofstudyrelated* are DERIVED aggregates computed
    -- at ingest (a study's modality set + series/instance counts), not copied
    -- from a single instance header (which almost never carries them).
    modalitiesinstudy             VARCHAR(128),
    referringphysicianname        VARCHAR(255),
    studydescription              VARCHAR(255),
    studyinstanceuid              VARCHAR(128) NOT NULL,
    studyid                       VARCHAR(64),
    numberofstudyrelatedseries    INT,
    numberofstudyrelatedinstances INT,
    last_updated                  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at                    TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (study_pkey),
    UNIQUE KEY uq_study_uid (datastore_id, studyinstanceuid),
    -- Join path for the FK below, plus the two QIDO study filters — the
    -- filters are datastore-prefixed because every QIDO query carries a
    -- datastore_id predicate.
    KEY idx_study_patient (patient_pkey),
    KEY idx_study_ds_date (datastore_id, studydate),
    KEY idx_study_ds_accession (datastore_id, accessionnumber),
    KEY idx_study_deleted (deleted_at),
    KEY idx_study_ds_updated (datastore_id, last_updated),
    CONSTRAINT fk_study_patient FOREIGN KEY (patient_pkey) REFERENCES patient (patient_pkey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS series (
    series_pkey  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    study_pkey   BIGINT UNSIGNED NOT NULL,
    -- Tenancy: denormalized from study so series-level QIDO scans and the
    -- unique key never need a join to establish scope.
    datastore_id VARCHAR(36) NOT NULL,
    modality     VARCHAR(16),
    seriesdate   DATE,
    seriesdescription VARCHAR(255),
    seriesinstanceuid VARCHAR(128) NOT NULL,
    seriesnumber INT,
    imagecount   INT,
    -- numberofseriesrelatedinstances is a DERIVED aggregate (count of this
    -- series' instances) computed at ingest, not read from a header.
    numberofseriesrelatedinstances INT,
    performedprocedurestepstartdate DATE,
    performedprocedurestepstarttime TIME,
    requestattributessequence       TEXT,
    scheduledprocedurestepid         VARCHAR(64),
    requestedprocedureid             VARCHAR(64),
    patientposition                  VARCHAR(16),
    -- STORAGE-scope index attribute (target_type=STORAGE, level=SERIES, tag
    -- 0018,0015). The pre-redesign seed in schema.sql enables 'bodypartexamined'
    -- for a datastore, and ingest's _apply_index_attributes writes
    -- `series`.`bodypartexamined`. That column previously existed ONLY on
    -- virtual_series, so the STORAGE seed's ingest UPDATE hit a non-existent
    -- column and was WARNING-skipped. Declared here (series is DROP+recreated by
    -- schema-init, so this applies on redeploy; the /defs create-path ALTERs the
    -- correct table for any future STORAGE/SERIES attr — this only covers the
    -- pre-seeded one). Width matches virtual_series.bodypartexamined.
    bodypartexamined                 VARCHAR(16) NULL,
    -- Series-level availability, app-level because DICOM has no attribute for
    -- it. Rollup of the instances' d00080056 under the lifecycle-aware model:
    -- 'OFFLINE' while a sidecar has created a study/series whose slide is not
    -- yet ingested, whose backing object was removed, or whose objects have
    -- tiered below Glacier Instant Retrieval; 'NEARLINE' while a restore is
    -- in progress; 'ONLINE' once pixels are indexed and ranged-GET-reachable.
    -- NULL is treated as ONLINE. The GC sweep skips OFFLINE series so a
    -- pending one with zero instances is not reaped before its slide lands.
    availability VARCHAR(16) NULL,
    last_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at   TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (series_pkey),
    UNIQUE KEY uq_series_uid (datastore_id, seriesinstanceuid),
    KEY idx_series_study (study_pkey),
    -- QIDO modality filter, datastore-prefixed like the study filters.
    KEY idx_series_ds_modality (datastore_id, modality),
    KEY idx_series_deleted (deleted_at),
    KEY idx_series_ds_updated (datastore_id, last_updated),
    CONSTRAINT fk_series_study FOREIGN KEY (study_pkey) REFERENCES study (study_pkey)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- instanceid is a separate application-level key used as the FK target by
-- Instancelocation/Instancemetadata. Widened from the reference's 31-bit
-- SHA1(SOPInstanceUID)[:4] to BIGINT UNSIGNED: a 63-bit hash over
-- 'datastore_id|SOPInstanceUID'. The reference's 31-bit key reaches ~1%
-- collision probability around 65k instances, and a collision is a silent
-- row merge via ON DUPLICATE KEY; 63 bits with the datastore in the hash
-- input removes that risk and scopes the key per tenant.
CREATE TABLE IF NOT EXISTS instance (
    instance_pkey BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    instanceid    BIGINT UNSIGNED NOT NULL,
    -- Physical object this instance is served from (storage_index row). This is
    -- how a queryable instance resolves to concrete S3 bytes; it replaces the
    -- former Instancelocation join. NULL only transiently before the ingest
    -- links them.
    content_pkey  BIGINT UNSIGNED NULL,
    -- Tenancy: denormalized from series, same rationale as series.
    datastore_id  VARCHAR(36) NOT NULL,
    seriesid      BIGINT UNSIGNED,
    series_pkey   BIGINT UNSIGNED,
    transfersyntaxuid VARCHAR(64),            -- (0002,0010) from file_meta
    sopclassuid   VARCHAR(128),
    sopinstanceuid VARCHAR(128) NOT NULL,
    -- (0008,0056) Instance Availability, surfaced in QIDO at every level:
    -- 'ONLINE'   = object in Standard / Standard-IA / Glacier Instant
    --              Retrieval / a non-archive Intelligent-Tiering tier (or a
    --              temporary restored copy is available);
    -- 'NEARLINE' = restore from an archive tier is in progress;
    -- 'OFFLINE'  = object tiered to Glacier Flexible Retrieval / Deep Archive
    --              / an Intelligent-Tiering archive tier (no longer
    --              ranged-GET-addressable), or removed.
    -- Tar members inherit the containing object's availability — one
    -- lifecycle transition flips every member row.
    instanceavailability VARCHAR(32),
    timezoneoffsetfromutc VARCHAR(32),
    retrieveurl   VARCHAR(512),
    instancenumber INT,
    samplesperpixel INT,                       -- (0028,0002)
    numberofframes INT,
    `rows`        INT,
    `columns`     INT,
    bitsallocated INT,
    -- Whole-slide geometry, surfaced to QIDO for completeness. Viewers read it
    -- from WADO /metadata rather than QIDO, so these are cheap extras.
    totalpixelmatrixcolumns INT,               -- (0048,0006)
    totalpixelmatrixrows    INT,               -- (0048,0007)
    dimensionorganizationtype VARCHAR(16),      -- (0020,9311)
    imagelaterality VARCHAR(16),               -- (0020,0062)
    last_updated  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at    TIMESTAMP NULL DEFAULT NULL,
    PRIMARY KEY (instance_pkey),
    UNIQUE KEY uq_instance_uid (datastore_id, sopinstanceuid),
    UNIQUE KEY uq_instanceid (instanceid),
    KEY idx_instance_series (series_pkey),
    KEY idx_instance_content (content_pkey),
    -- NOTE: idx_instance_seriesid_legacy (seriesid) was REMOVED (2026-09). A
    -- full-codebase audit (ingest lambdas, dicomweb-s3 container QIDO/WADO,
    -- datastore/analytics APIs) confirmed NOTHING filters/joins/sorts on
    -- instance.seriesid — every instance↔series relationship uses series_pkey
    -- (idx_instance_series above). seriesid is still written as a redundant
    -- duplicate of series_pkey, but is never read as a predicate, so the index
    -- was pure per-insert write overhead. This CREATE TABLE IF NOT EXISTS edit
    -- only prevents recreation on a fresh DB; the live table still carries the
    -- index until an explicit `ALTER TABLE instance DROP INDEX
    -- idx_instance_seriesid_legacy;` is run in a low-traffic window.
    -- Per-datastore availability scans (lifecycle rollups, restore sweeps).
    KEY idx_instance_ds_availability (datastore_id, instanceavailability),
    KEY idx_instance_deleted (deleted_at),
    -- Covering index for the datastore statistics COUNT: the stats recompute
    -- does COUNT(*) FROM instance WHERE datastore_id=? AND deleted_at IS NULL.
    -- Without this composite the COUNT full-scanned the (multi-million-row)
    -- instance table (~49s, statement timeout), so the stats row never updated
    -- and the recompute pinned Aurora. This turns it into an index range scan.
    KEY idx_instance_ds_deleted (datastore_id, deleted_at),
    KEY idx_instance_ds_updated (datastore_id, last_updated),
    CONSTRAINT fk_instance_series FOREIGN KEY (series_pkey) REFERENCES series (series_pkey),
    CONSTRAINT fk_instance_content FOREIGN KEY (content_pkey) REFERENCES storage_index (content_pkey)
        ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Instancelocation was removed in the storage_index redesign: bucket / key /
-- member offset+length / size now live on storage_index, which instance links
-- to via instance.content_pkey. The read path resolves an instance to its S3
-- bytes through that FK instead of a UID-keyed location row.

CREATE TABLE IF NOT EXISTS Instancemetadata (
    id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
    -- Keyed on the queryable instance (instance.instance_pkey), NOT the physical
    -- object (storage_index.content_pkey). A virtualized whole-slide image is N
    -- DICOM WSI pyramid-level instances over ONE physical .svs object: all N
    -- share a single content_pkey but each is a DISTINCT instance row with its
    -- OWN per-level header (PixelSpacing, TotalPixelMatrix dims) and its OWN
    -- pixel-locators (frame_offsets, per-level jpeg tables). Keying the blob on
    -- content_pkey collapsed all N level headers to ONE row (INSERT..ON DUPLICATE
    -- KEY collided on uq_meta_content, last writer won) so /metadata served the
    -- same header+frame_offsets for every level and non-base levels could not
    -- tile. Keying on instance_pkey gives each level its own row. For ordinary
    -- (non-WSI) DICOM the mapping is 1:1 (one object = one instance), so this is
    -- identical behaviour there.
    instance_pkey      BIGINT UNSIGNED NOT NULL,
    -- The physical object this metadata's bytes live in (storage_index row).
    -- Retained for the S3-object linkage and so storage-level cleanup can cascade
    -- to the blob; NOT the row key (many WSI levels share one content_pkey).
    content_pkey       BIGINT UNSIGNED NOT NULL,
    metadata           LONGBLOB     NOT NULL,
    -- Absolute offset of the main (7FE0,0010) tag in the backing object, or
    -- NULL when there is none to point at: the object carries no pixel data
    -- (RTSTRUCT, SR, presentation state), or its header ran past the ingest
    -- scan cap. The NULL is load-bearing — the read path has to tell "no
    -- offset" apart from a real one, or it range-GETs from the wrong place
    -- and serves header bytes as pixels.
    --
    -- BIGINT, not INT: for an instance inside a tar this offset is absolute
    -- within the archive, and an archive can exceed the 4 GB an INT UNSIGNED
    -- holds.
    metadataendoffset  BIGINT UNSIGNED NULL,
    -- Per-frame byte ranges for encapsulated transfer syntaxes (JPEG,
    -- JPEG 2000, HTJ2K, RLE): compact JSON, one [start, end] inclusive
    -- absolute pair per frame. Lets the read path serve an encapsulated frame
    -- with a single ranged GET instead of fetching the whole instance. NULL
    -- means no offsets — a native syntax, or multi-fragment encapsulation we
    -- could not parse.
    frame_offsets      MEDIUMBLOB NULL,
    -- Shared JPEG tables (TIFF tag 347). Aperio and Ventana tiles are
    -- abbreviated JPEG streams that share one quant/Huffman blob; the read
    -- path fetches this range once per file and splices it into each tile to
    -- form a decodable JPEG. NULL means the tiles are self-contained and need
    -- no merge.
    jpeg_tables_offset INT UNSIGNED NULL,
    jpeg_tables_length INT UNSIGNED NULL,
    -- ICC color profile (TIFF tag 34675). Slides carry ~140 KB of it, too
    -- large to inline in the metadata blob, so the range is stored and
    -- exposed as a BulkDataURI the viewer fetches for color-managed
    -- rendering. NULL when the slide has no profile.
    icc_profile_offset INT UNSIGNED NULL,
    icc_profile_length INT UNSIGNED NULL,
    PRIMARY KEY (id),
    -- One metadata row per queryable instance. WSI pyramid levels are distinct
    -- instances, so each level gets its own row even though they share one
    -- content_pkey.
    UNIQUE KEY uq_meta_instance (instance_pkey),
    -- content_pkey is a plain lookup key now (non-unique): many WSI level
    -- instances point at the same physical object.
    KEY idx_meta_content (content_pkey),
    CONSTRAINT fk_meta_instance FOREIGN KEY (instance_pkey) REFERENCES instance (instance_pkey)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_meta_content FOREIGN KEY (content_pkey) REFERENCES storage_index (content_pkey)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- Incremental statistics: per-study aggregates + per-datastore sync cursor
-- ============================================================================
-- Replaces the former full-datastore recompute (a COUNT/SUM scan over the whole
-- ~160M-row instance table PER dirty datastore, every 60s) that pinned Aurora
-- and, via stacked long-running scans holding shared metadata locks on
-- `instance`, wedged the QIDO /instances endpoint (incident 2026-09-28).
--
-- Model: keep ONE aggregate row per study here. A batched Step Function walks
-- studies in (datastore_id, last_updated, study_pkey) order, 100 at a time,
-- recomputes only those studies' descendants (bounded by study_pkey IN (...)),
-- upserts their study_stats rows, advances the cursor, and loops until a batch
-- returns < 100 rows (== caught up). The datastore rollup published to
-- datastore_statistics is then a cheap SUM over this small table (one row per
-- study, millions not 160M), never a scan of `instance`.
--
-- Idempotent & self-correcting: reprocessing a study just overwrites its row,
-- so a missed/double run only converges to the correct answer. A study whose
-- counts change re-enters the walk because ingest bumps study.last_updated
-- (ON UPDATE CURRENT_TIMESTAMP) when it rewrites the study's derived counts.
CREATE TABLE IF NOT EXISTS study_stats (
    study_pkey          BIGINT UNSIGNED NOT NULL,
    -- Denormalized from study so the datastore rollup SUM never needs a join.
    datastore_id        VARCHAR(36) NOT NULL,
    series_count        INT UNSIGNED NOT NULL DEFAULT 0,
    instance_count      INT UNSIGNED NOT NULL DEFAULT 0,
    -- Sum of storage_index.size_bytes over this study's live instances. Carried
    -- per study so the datastore storage total is SUM(total_size_bytes) here.
    total_size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
    -- Backslash-joined DISTINCT modality set for this study (feeds the datastore
    -- modality breakdown rollup). NULL when the study has no live series.
    modalities          VARCHAR(128) NULL,
    -- Per-study {MODALITY: series_count} JSON (blank/NULL-modality series
    -- excluded), whose values sum to this study's non-blank series count. The
    -- datastore modality_breakdown is rebuilt by SUMMING these maps in reconcile,
    -- so the pie total is derived from the same table as series_count and always
    -- agrees with it (minus blank-modality series).
    modality_series_counts JSON NULL,
    -- The study.last_updated value this row was computed FROM. Lets a run detect
    -- a study whose row is stale (study.last_updated > this) without recounting.
    synced_last_updated TIMESTAMP NOT NULL,
    computed_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (study_pkey),
    -- The rollup SUM(...) WHERE datastore_id=? is an index range scan on this.
    KEY idx_study_stats_ds (datastore_id),
    CONSTRAINT fk_study_stats_study FOREIGN KEY (study_pkey) REFERENCES study (study_pkey)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per datastore tracking how far the incremental walk has caught up.
-- The walk fetches the next 100 studies past (cursor_last_updated,
-- cursor_study_pkey) via the study.idx_study_ds_updated index, so the cursor is
-- a resumable, monotonic position — not a time-based debounce. The epoch-second
-- default means a fresh datastore's first run backfills from the beginning in
-- bounded 100-study batches (never one big scan).
CREATE TABLE IF NOT EXISTS stats_sync_cursor (
    datastore_id        VARCHAR(36) NOT NULL,
    cursor_last_updated TIMESTAMP NOT NULL DEFAULT '1970-01-01 00:00:01',
    cursor_study_pkey   BIGINT UNSIGNED NOT NULL DEFAULT 0,
    -- Set FALSE while caught up; a study touch can flip it TRUE as a "run now"
    -- nudge (optional — the scheduled Step Function run also just re-walks).
    resync_pending      BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (datastore_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VIEW: v_datastore_summary (moved here from schema.sql in the S3-only port)
-- ============================================================================
-- Defined here because it joins the S3 index tables above; schema.sql loads
-- before this file, so it cannot see them. Live rows only (deleted_at IS NULL).
CREATE VIEW v_datastore_summary AS
SELECT
    d.*,
    COUNT(DISTINCT st.studyinstanceuid) AS actual_study_count,
    COUNT(DISTINCT se.seriesinstanceuid) AS actual_series_count,
    COUNT(DISTINCT i.instance_pkey)     AS actual_instance_count,
    SUM(si.size_bytes)                  AS actual_total_size
FROM datastores d
LEFT JOIN study  st ON st.datastore_id = d.id AND st.deleted_at IS NULL
LEFT JOIN series se ON se.datastore_id = d.id AND se.deleted_at IS NULL
LEFT JOIN instance i ON i.datastore_id = d.id AND i.deleted_at IS NULL
LEFT JOIN storage_index si ON si.content_pkey = i.content_pkey AND si.deleted_at IS NULL
GROUP BY d.id;
