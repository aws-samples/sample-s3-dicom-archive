-- ============================================================================
-- VIRTUAL FOLDERS SCHEMA
-- ============================================================================

CREATE TABLE IF NOT EXISTS virtual_folder_indexing_profiles (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    patient_attributes JSON NOT NULL,
    study_attributes JSON NOT NULL,
    series_attributes JSON NOT NULL,
    instance_attributes JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL,
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    INDEX idx_deleted (deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS virtual_folder_deid_profiles (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    tag_actions JSON NOT NULL,
    drop_private_tags BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL,
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    INDEX idx_deleted (deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS virtual_folders (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(28) NOT NULL,
    description TEXT,
    status ENUM('ACTIVE', 'DISABLED', 'DELETING') NOT NULL DEFAULT 'ACTIVE',
    indexing_profile_id VARCHAR(36),
    deid_profile_id VARCHAR(36),
    deidentification_config JSON,
    write_mode ENUM('NONE', 'EXISTING', 'DEDICATED') NOT NULL DEFAULT 'NONE',
    write_datastore_id VARCHAR(36) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL,
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    INDEX idx_status (status),
    INDEX idx_deleted (deleted),
    FOREIGN KEY (indexing_profile_id) REFERENCES virtual_folder_indexing_profiles(id) ON DELETE SET NULL,
    FOREIGN KEY (deid_profile_id) REFERENCES virtual_folder_deid_profiles(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS virtual_assignment_rules (
    id VARCHAR(36) PRIMARY KEY,
    virtual_folder_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    enabled BOOLEAN DEFAULT TRUE,
    priority INT DEFAULT 0,
    conditions JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted BOOLEAN DEFAULT FALSE,
    INDEX idx_virtual_folder (virtual_folder_id),
    FOREIGN KEY (virtual_folder_id) REFERENCES virtual_folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ASSIGNMENT RULES (normalized conditions/datastore scoping used by
-- assignment-rules-api and the assignment-rules evaluator)
-- ============================================================================

-- Column order is load-bearing: assignment-rules-api reads SELECT r.* by ordinal
CREATE TABLE IF NOT EXISTS virtual_folder_assignment_rules (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    virtual_folder_id VARCHAR(36) NOT NULL,
    priority INT NOT NULL DEFAULT 0,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    INDEX idx_virtual_folder (virtual_folder_id),
    INDEX idx_enabled (enabled),
    FOREIGN KEY (virtual_folder_id) REFERENCES virtual_folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS virtual_folder_assignment_rule_conditions (
    id VARCHAR(36) PRIMARY KEY,
    rule_id VARCHAR(36) NOT NULL,
    attribute_name VARCHAR(255) NOT NULL,
    operator VARCHAR(32) NOT NULL,
    value VARCHAR(1024) NOT NULL,
    value_end VARCHAR(1024) NULL,
    attribute_vr VARCHAR(16) NULL,
    logic_operator ENUM('AND', 'OR') NOT NULL DEFAULT 'AND',
    is_exclusion BOOLEAN DEFAULT FALSE,
    INDEX idx_rule (rule_id),
    FOREIGN KEY (rule_id) REFERENCES virtual_folder_assignment_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS virtual_folder_assignment_rule_datastores (
    rule_id VARCHAR(36) NOT NULL,
    datastore_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (rule_id, datastore_id),
    INDEX idx_datastore (datastore_id),
    FOREIGN KEY (rule_id) REFERENCES virtual_folder_assignment_rules(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Materialized membership of a VF index: a set of physical-file rows (storage_index
-- content_pkey) drawn from N datastores, produced by evaluating the VF's assignment
-- rules against storage_index. Repointed from the legacy imageset_id to content_pkey.
CREATE TABLE IF NOT EXISTS virtual_folder_assignments (
    assignment_pkey BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    virtual_folder_id VARCHAR(36) NOT NULL,
    datastore_id VARCHAR(64) NOT NULL,
    content_pkey BIGINT UNSIGNED NOT NULL,
    study_instance_uid VARCHAR(64) NULL,
    series_instance_uid VARCHAR(64) NULL,
    sop_instance_uid VARCHAR(64) NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (assignment_pkey),
    -- One physical file appears at most once per VF index.
    UNIQUE KEY uk_vf_assignment (virtual_folder_id, content_pkey),
    INDEX idx_content (content_pkey),
    INDEX idx_vf_ds (virtual_folder_id, datastore_id),
    FOREIGN KEY (virtual_folder_id) REFERENCES virtual_folders(id) ON DELETE CASCADE,
    FOREIGN KEY (content_pkey) REFERENCES storage_index(content_pkey) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VIRTUAL FOLDER DATA TABLES — REMOVED (VF Per-Database Redesign, Phase 5)
-- ============================================================================
-- The shared virtual_patient/study/series/instance/imageset de-id tree is DEAD:
-- each VF's de-id tree now lives in its OWN MySQL database vf_<id> (tables
-- vf_<id>_patient/study/series/instance + vf_<id>_series_tracker), provisioned
-- at VF-create time by the VF API's provisionVfDatabase() (vf-database.js) and
-- dropped at VF-delete by deprovisionVfDatabase(). See
-- plans/VF-PER-DATABASE-REDESIGN.md.
--
-- So schema-init no longer CREATEs these shared tables — it DROPs them (reverse
-- FK order) to purge any left over from a pre-redesign install of dicomarchive. The
-- cross-schema FK from virtual_instance/virtual_folder_assignments to
-- storage_index is gone with the tables; the per-VF vf_<id>_instance carries
-- content_pkey/instance_pkey as plain indexed columns (no cross-DB FK, which
-- MySQL cannot enforce anyway). DROP TABLE IF EXISTS is harmless when absent.
--
-- NOTE: virtual_folder_assignments is ALSO dropped-and-recreated in
-- schema-s3-index.sql (it FKs storage_index and must be pre-dropped before the
-- storage_index rebuild). It stays SHARED — it is the control-plane membership
-- table, NOT the de-id tree — and its CREATE remains above in this file.
DROP TABLE IF EXISTS virtual_instance;
DROP TABLE IF EXISTS virtual_imageset;
DROP TABLE IF EXISTS virtual_series;
DROP TABLE IF EXISTS virtual_study;
DROP TABLE IF EXISTS virtual_patient;
-- virtual_issuer: legacy separate-issuer entity, already retired.
DROP TABLE IF EXISTS virtual_issuer;

CREATE TABLE IF NOT EXISTS virtual_folder_statistics (
    id VARCHAR(36) PRIMARY KEY,
    virtual_folder_id VARCHAR(36) NOT NULL,
    patient_count INT DEFAULT 0,
    study_count INT DEFAULT 0,
    series_count INT DEFAULT 0,
    instance_count INT DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_vf_stats (virtual_folder_id),
    FOREIGN KEY (virtual_folder_id) REFERENCES virtual_folders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VF DE-ID SERIES TRACKER — MOVED PER-VF (VF Per-Database Redesign, Phase 5)
-- ============================================================================
-- The vf-deid-consumer's per-series watermark tracker now lives in each VF's
-- own database as vf_<id>_series_tracker (rendered by provisionVfDatabase()).
-- The former SHARED vf_series_tracker in dicomarchive is dead; drop it so a
-- pre-redesign install does not keep a stale shared copy. DROP IF EXISTS is
-- harmless when absent.
DROP TABLE IF EXISTS vf_series_tracker;

INSERT INTO virtual_folder_indexing_profiles (id, name, description, patient_attributes, study_attributes, series_attributes, instance_attributes, created_by)
VALUES (
    'default-full-index',
    'Full Index (Default)',
    'Indexes all supported DICOM attributes including QIDO-RS mandatory fields',
    JSON_ARRAY('00100010', '00100020', '00100030', '00100040'),
    JSON_ARRAY('0020000D', '00080020', '00080030', '00080050', '00200010', '00081030', '00080090', '00080061'),
    JSON_ARRAY('0020000E', '00080060', '0008103E', '00200011', '00180015', '00200060'),
    JSON_ARRAY('00080018', '00080016', '00200013', '00080023', '00080033', '00280010', '00280011', '00280008'),
    'system'
) ON DUPLICATE KEY UPDATE 
    patient_attributes = VALUES(patient_attributes),
    study_attributes = VALUES(study_attributes),
    series_attributes = VALUES(series_attributes),
    instance_attributes = VALUES(instance_attributes),
    description = VALUES(description);
