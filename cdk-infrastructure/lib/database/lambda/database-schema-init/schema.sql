-- ============================================================================
-- DICOM Archive - MySQL Schema Proposal
-- ============================================================================
-- This schema replaces DynamoDB with a normalized relational model
-- Optimized for DICOM medical imaging workflows
--
-- Invariant: the base schema files (schema*.sql) always describe the current
-- end-state and run in full on fresh installs; already-deployed databases
-- reach the same end-state through the ordered files in migrations/, tracked
-- in the schema_migrations table.
-- ============================================================================

-- ============================================================================
-- CORE INFRASTRUCTURE TABLES
-- ============================================================================

-- Datastores: Main storage containers for DICOM data.
-- S3-only: every datastore is backed by an S3 archive bucket. The former
-- managed-service columns (datastore_arn, external_datastore_id, storage_type,
-- transcode_to, read_only_role_arn, store_role_arn) have been removed — see
-- the S3-only port. DICOM instances are indexed by the six-table tree in
-- schema-s3-index.sql (patient/study/series/instance/Instancelocation/
-- Instancemetadata), keyed on this table's id.
CREATE TABLE datastores (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status ENUM('CREATING', 'ACTIVE', 'DELETING', 'DELETED', 'ERROR', 'SYNCING') NOT NULL DEFAULT 'CREATING',
    status_description VARCHAR(500),

    -- Encryption
    kms_key_id VARCHAR(255),

    -- S3-native storage references (the only backend)
    s3_bucket_name VARCHAR(255),
    s3_prefix VARCHAR(512),

    -- Import flag
    imported BOOLEAN DEFAULT FALSE,

    -- Access level for an IMPORTED bucket: 'read-only' (default; the archive
    -- indexes but never writes — safe for a clinical PACS/VNA-managed bucket)
    -- or 'read-write' (the archive may write .extracted/ unpack output and
    -- staged-upload copies). read-only also disables "Upload from Computer"
    -- into this datastore (upload needs write). NULL for a normal S3 datastore
    -- (the app owns its bucket outright).
    access_level ENUM('read-only', 'read-write') DEFAULT NULL,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NOT NULL,
    created_by_username VARCHAR(255),
    tags JSON,
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit Trail: Comprehensive audit logging
CREATE TABLE audit_logs (
    id VARCHAR(36) PRIMARY KEY,
    timestamp TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    
    -- Action details
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id VARCHAR(255),
    resource_name VARCHAR(255),
    
    -- User context
    user_id VARCHAR(255) NOT NULL,
    username VARCHAR(255),
    user_ip VARCHAR(45),
    
    -- Request details
    request_id VARCHAR(255),
    api_endpoint VARCHAR(500),
    http_method VARCHAR(10),
    
    -- Change tracking
    old_values JSON,
    new_values JSON,
    
    -- Result
    status ENUM('SUCCESS', 'FAILURE', 'PARTIAL') NOT NULL,
    error_message TEXT,
    
    INDEX idx_timestamp (timestamp),
    INDEX idx_user_id (user_id),
    INDEX idx_resource (resource_type, resource_id),
    INDEX idx_action (action),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- DICOM INTERFACE MANAGEMENT
-- ============================================================================

-- Locations: Physical or logical locations where DICOM services run.
-- location-as-app-construct (Stage 2/schema): a location is a PURE APP CONSTRUCT
-- (name, network ports, TLS config, status). The former per-location storage
-- columns (s3_bucket_name, s3_bucket_arn, trust_anchor_arn, dicom_role_arn,
-- hl7_role_arn, dicom_profile_arn, hl7_profile_arn, certificate_data) have been
-- removed — DICOM writes directly to the datastore `-ds-` bucket via the service
-- task role, and the DICOM mTLS peer identity is a deployment-level TLS cert.
CREATE TABLE locations (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    -- Network configuration
    dicom_port INT NOT NULL,
    hl7_port INT,
    address VARCHAR(500),
    
    -- Fargate service configuration
    config JSON DEFAULT NULL,
    
    -- Status
    status ENUM('ACTIVE', 'INACTIVE', 'DELETING') NOT NULL DEFAULT 'ACTIVE',
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    -- TLS configuration
    dicom_tls_port INT DEFAULT NULL,
    tls_verify_client BOOLEAN DEFAULT FALSE,
    
    INDEX idx_status (status),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DICOM Interfaces: Network endpoints for DICOM communication
CREATE TABLE dicom_interfaces (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    location_id VARCHAR(36) NOT NULL,
    
    -- Network configuration
    ae_title VARCHAR(16) NOT NULL,
    host VARCHAR(255),
    
    -- Interface type and status
    interface_type ENUM('SCP', 'SCU', 'BOTH') NOT NULL DEFAULT 'SCP',
    status ENUM('ACTIVE', 'INACTIVE', 'ERROR') NOT NULL DEFAULT 'ACTIVE',
    
    -- Configuration
    max_associations INT DEFAULT 10,
    timeout_seconds INT DEFAULT 30,
    config JSON,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE,
    INDEX idx_ae_title (ae_title),
    INDEX idx_location (location_id),
    INDEX idx_status (status),
    INDEX idx_interface_type (interface_type),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DICOM Entities: Remote DICOM systems
CREATE TABLE dicom_entities (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    ae_title VARCHAR(16) NOT NULL,
    host VARCHAR(255) NOT NULL,
    port INT NOT NULL,
    
    -- Entity type
    entity_type ENUM('MODALITY', 'PACS', 'WORKSTATION', 'CLIENT', 'OTHER') NOT NULL,
    
    -- Status
    status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    last_verified_at TIMESTAMP NULL,
    
    -- TLS
    client_certificate TEXT,
    tls_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Configuration
    description TEXT,
    config JSON,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    UNIQUE KEY uk_ae_title_host_port (ae_title, host, port),
    INDEX idx_entity_type (entity_type),
    INDEX idx_status (status),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DICOM Privileges: Junction table for interface-entity permissions
CREATE TABLE dicom_privileges (
    id VARCHAR(36) PRIMARY KEY,
    dicom_interface_id VARCHAR(36) NOT NULL,
    dicom_entity_id VARCHAR(36) NOT NULL,
    
    -- Permissions
    can_store BOOLEAN DEFAULT FALSE,
    can_query BOOLEAN DEFAULT FALSE,
    can_retrieve BOOLEAN DEFAULT FALSE,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    UNIQUE KEY uk_interface_entity (dicom_interface_id, dicom_entity_id),
    FOREIGN KEY (dicom_interface_id) REFERENCES dicom_interfaces(id) ON DELETE CASCADE,
    FOREIGN KEY (dicom_entity_id) REFERENCES dicom_entities(id) ON DELETE CASCADE,
    INDEX idx_interface (dicom_interface_id),
    INDEX idx_entity (dicom_entity_id),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DICOM Interface Datastore Access: Maps which datastores each interface can access for retrieval
CREATE TABLE dicom_interface_datastores (
    id VARCHAR(36) PRIMARY KEY,
    dicom_interface_id VARCHAR(36) NOT NULL,
    datastore_id VARCHAR(36) NOT NULL,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Constraints
    UNIQUE KEY uk_interface_datastore (dicom_interface_id, datastore_id),
    FOREIGN KEY (dicom_interface_id) REFERENCES dicom_interfaces(id) ON DELETE CASCADE,
    FOREIGN KEY (datastore_id) REFERENCES datastores(id) ON DELETE CASCADE,
    INDEX idx_interface (dicom_interface_id),
    INDEX idx_datastore (datastore_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Routing Rules: Define how DICOM data is routed to datastores
CREATE TABLE routing_rules (
    id VARCHAR(36) PRIMARY KEY,
    interface_id VARCHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    priority INT NOT NULL DEFAULT 100,
    rule_type ENUM('AUTO_ROUTE', 'DESTINATION') NOT NULL DEFAULT 'DESTINATION',
    conditions JSON,
    action JSON NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    FOREIGN KEY (interface_id) REFERENCES dicom_interfaces(id) ON DELETE CASCADE,
    INDEX idx_interface (interface_id),
    INDEX idx_priority (priority),
    INDEX idx_enabled (enabled),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- DICOM IMAGING DATA
-- ============================================================================
-- S3-only: the former managed-service `imagesets` table has been removed. DICOM
-- instances are indexed by the six-table tree in schema-s3-index.sql
-- (patient/study/series/instance/Instancelocation/Instancemetadata), which is
-- the system of record for the S3 backend.

-- ============================================================================
-- IMPORT MANAGEMENT
-- ============================================================================

-- Import Jobs: Track DICOM import operations (S3-only)
CREATE TABLE import_jobs (
    id VARCHAR(36) PRIMARY KEY,
    datastore_id VARCHAR(36) NOT NULL,

    -- Job identification
    job_name VARCHAR(255),
    association_id VARCHAR(255),
    calling_ae_title VARCHAR(16),
    called_ae_title VARCHAR(16),
    
    -- Source information
    source_location VARCHAR(500),
    source_type ENUM('S3', 'DICOM_SCP', 'FILE_SYSTEM', 'STOW') NOT NULL,
    s3_input_uri VARCHAR(500),
    s3_output_uri VARCHAR(500),
    
    -- Status tracking
    status ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    progress_percentage DECIMAL(5,2) DEFAULT 0.00,
    
    -- Statistics
    total_files INT DEFAULT 0,
    processed_files INT DEFAULT 0,
    failed_files INT DEFAULT 0,
    total_size_bytes BIGINT DEFAULT 0,
    
    -- Results
    instances_imported INT DEFAULT 0,
    error_message TEXT,
    error_details JSON,
    
    -- S3 Cleanup tracking
    s3_cleanup_status ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED') DEFAULT 'PENDING',
    s3_cleanup_date TIMESTAMP NULL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    failed_at TIMESTAMP NULL,
    created_by VARCHAR(255),
    
    FOREIGN KEY (datastore_id) REFERENCES datastores(id) ON DELETE CASCADE,
    INDEX idx_datastore (datastore_id),
    INDEX idx_status (status),
    INDEX idx_s3_cleanup_status (s3_cleanup_status),
    INDEX idx_created_by (created_by),
    INDEX idx_association_id (association_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- HL7 INTEGRATION (Optional - if needed)
-- ============================================================================

-- HL7 Entities: HL7 systems
CREATE TABLE hl7_entities (
    id VARCHAR(36) PRIMARY KEY,
    hl7_interface_id VARCHAR(36),
    
    -- HL7 identification
    application_name VARCHAR(255) NOT NULL,
    facility_name VARCHAR(255),
    
    -- Configuration
    description TEXT,
    config JSON,
    status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    INDEX idx_application (application_name),
    INDEX idx_facility (facility_name),
    INDEX idx_status (status),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- HL7 Mappings: Field mappings for HL7 messages
CREATE TABLE hl7_mappings (
    id VARCHAR(36) PRIMARY KEY,
    hl7_entity_id VARCHAR(36) NOT NULL,
    
    -- Message type
    hl7_message_type VARCHAR(10) NOT NULL,
    
    -- Mapping configuration
    source_field VARCHAR(255) NOT NULL,
    target_field VARCHAR(255) NOT NULL,
    transformation_rule TEXT,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    FOREIGN KEY (hl7_entity_id) REFERENCES hl7_entities(id) ON DELETE CASCADE,
    INDEX idx_entity (hl7_entity_id),
    INDEX idx_message_type (hl7_message_type),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- SYSTEM MANAGEMENT
-- ============================================================================

-- Interface Servers: Active interface server instances
CREATE TABLE interface_servers (
    client_id VARCHAR(255) PRIMARY KEY,
    location_id VARCHAR(36),
    interface_type ENUM('DICOM', 'HL7') NOT NULL,
    
    -- Server info
    hostname VARCHAR(255),
    ip_address VARCHAR(45),
    port INT,
    
    -- Queue ARNs
    inbound_queue_arn VARCHAR(255),
    heartbeat_queue_arn VARCHAR(255),
    outbound_queue_arn VARCHAR(255),
    
    -- Status
    status ENUM('ACTIVE', 'INACTIVE', 'ERROR', 'SHUTDOWN') NOT NULL DEFAULT 'ACTIVE',
    last_heartbeat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    service_version VARCHAR(50),
    
    -- Metadata
    server_metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_location (location_id),
    INDEX idx_interface_type (interface_type),
    INDEX idx_status (status),
    INDEX idx_last_heartbeat (last_heartbeat)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Statistics: Aggregated datastore statistics
CREATE TABLE datastore_statistics (
    id VARCHAR(36) PRIMARY KEY,
    datastore_id VARCHAR(36) NOT NULL,
    
    -- Counts
    study_count INT DEFAULT 0,
    series_count INT DEFAULT 0,
    instance_count INT DEFAULT 0,
    
    -- Storage
    total_size_bytes BIGINT DEFAULT 0,
    
    -- Breakdown by modality
    modality_breakdown JSON,
    
    -- Latest flag
    latest BOOLEAN DEFAULT FALSE,

    -- Debounce flag: stage-2 (ingestion-v2) sets this TRUE on the latest row when
    -- it touches a series in this datastore; the scheduled stats-recompute lambda
    -- recomputes only dirty datastores and clears it. This replaces the former
    -- per-instance 'Instance Indexed' -> stats-queue firehose (~1 full-datastore
    -- recompute per instance) with one recompute per datastore per timer tick,
    -- so stats maintenance no longer scales with ingest volume.
    stats_dirty BOOLEAN DEFAULT FALSE,

    -- Timestamps
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (datastore_id) REFERENCES datastores(id) ON DELETE CASCADE,
    INDEX idx_datastore_date (datastore_id, last_updated),
    -- Partial-ish scan target for the recompute lambda's 'find dirty' query.
    INDEX idx_stats_dirty (stats_dirty, latest)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- View: v_datastore_summary is defined in schema-s3-index.sql, which loads
-- after this file — it references the S3 index tables (study/series/instance/
-- Instancelocation) created there, so defining it here would fail on load.

-- View: Active import jobs with progress
CREATE VIEW v_active_imports AS
SELECT 
    ij.*,
    d.name as datastore_name,
    TIMESTAMPDIFF(MINUTE, ij.started_at, NOW()) as duration_minutes
FROM import_jobs ij
JOIN datastores d ON ij.datastore_id = d.id
WHERE ij.status IN ('PENDING', 'IN_PROGRESS');

-- View: DICOM entity privileges
CREATE VIEW v_entity_privileges AS
SELECT 
    de.id as entity_id,
    de.name as entity_name,
    de.ae_title as entity_ae_title,
    di.id as interface_id,
    di.name as interface_name,
    di.ae_title as interface_ae_title,
    dp.can_store,
    dp.can_query,
    dp.can_retrieve
FROM dicom_entities de
JOIN dicom_privileges dp ON de.id = dp.dicom_entity_id
JOIN dicom_interfaces di ON dp.dicom_interface_id = di.id
WHERE de.status = 'ACTIVE' AND di.status = 'ACTIVE';

-- ============================================================================
-- RESOURCE TRACKING TABLE
-- ============================================================================

-- Resources: Track all AWS resources used by the application
CREATE TABLE aws_resources (
    id VARCHAR(36) PRIMARY KEY,
    resource_type VARCHAR(100) NOT NULL,
    resource_arn VARCHAR(500) NOT NULL,
    resource_name VARCHAR(255) NOT NULL,
    description TEXT,
    service VARCHAR(50) NOT NULL,
    region VARCHAR(50),
    account_id VARCHAR(12),
    deployment VARCHAR(100),
    construct VARCHAR(100),
    construct_id VARCHAR(255),
    construct_name VARCHAR(255),
    status ENUM('ACTIVE', 'DELETED', 'ERROR') DEFAULT 'ACTIVE',
    tags JSON,
    metadata JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_resource_type (resource_type),
    INDEX idx_service (service),
    INDEX idx_deployment (deployment),
    INDEX idx_construct (construct),
    INDEX idx_construct_id (construct_id),
    INDEX idx_status (status),
    UNIQUE KEY uk_resource_arn (resource_arn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ANALYTICS TABLES
-- ============================================================================

-- (Removed: analytics_projects + analytics_custom_attributes — the analytics
-- projects model was retired. Analytics scope now comes from body.source
-- {kind, ids}; attribute definitions live in the index-attributes tables below.
-- Per the schema-init rule these CREATE statements are simply dropped from
-- fresh deployments; existing databases keep the now-unused tables.)

-- Index Attributes (redesign — see docs/searchable-attributes.md):
-- split the former single `index_attributes` table into what is GLOBAL (the
-- physical column/index/type on the shared tables — Tab 1 "Table structure")
-- and what is PER-SCOPE (whether a scope populates that attribute on ingest —
-- Tab 2 "Population"). The physical column/index live ONCE on the shared
-- patient/study/series/instance tree (STORAGE) or the virtual_* tree (VF); a
-- per-scope switch only gates whether that scope's own rows are populated.
--
-- Fresh-install / Drop+recreate per the schema philosophy (these are small
-- config tables, no in-place migration path). The 2 live custom attributes on
-- the deployed DB are preserved by the idempotent seed INSERTs at the end of
-- this block.

-- GLOBAL schema definitions (Tab 1). One row per (target_type, level, physical
-- column). The physical column + optional index live on the shared table for
-- that target_type. This is what makes the shared column a first-class,
-- single-owner concept instead of N scope rows racing to create it.
-- STORAGE defs are GLOBAL (virtual_folder_id IS NULL) — one shared structure
-- across all datastores. VF defs are PER-VIRTUAL-FOLDER (virtual_folder_id = the
-- VF id): each VF customizes columns on its own vf_<id> database. MySQL treats
-- NULL as distinct in a unique key, so the global STORAGE rows (NULL) never
-- collide with each other on virtual_folder_id and one def per (level, column)
-- still holds globally. Population is UNCONDITIONAL (Phase 6): every def is
-- populated by ingest; the per-scope opt-in table (index_attribute_scope) is
-- retired.
CREATE TABLE index_attribute_defs (
    id                VARCHAR(36) PRIMARY KEY,
    target_type       ENUM('STORAGE', 'VF') NOT NULL,   -- which table tree
    virtual_folder_id VARCHAR(36) NULL,                 -- NULL = global STORAGE def; VF id = that VF's def
    dicom_tag         VARCHAR(8)  NOT NULL,             -- 8-hex, e.g. 00180015
    dicom_level       ENUM('PATIENT', 'STUDY', 'SERIES', 'INSTANCE') NOT NULL,
    column_name       VARCHAR(64) NOT NULL,             -- human label
    physical_column   VARCHAR(64) NOT NULL,             -- actual column on the table
    data_type         ENUM('STRING', 'INT', 'DATE', 'DECIMAL') NOT NULL DEFAULT 'STRING',
    is_indexed        BOOLEAN NOT NULL DEFAULT FALSE,   -- physical DB index present
    description       TEXT,
    created_by        VARCHAR(64),
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Non-NULL scope key: '' for a global STORAGE def, the VF id for a VF def.
    -- uq_def below cannot stop two concurrent adds of the same STORAGE def,
    -- because a UNIQUE index treats NULL virtual_folder_id values as distinct.
    -- uq_def_scope keys on this generated column instead, so the database
    -- itself rejects the second row (ER_DUP_ENTRY, mapped to 409 by the API).
    scope_key         VARCHAR(36) GENERATED ALWAYS AS (IFNULL(virtual_folder_id, '')) STORED NOT NULL,
    -- One definition per (type, VF, level, physical column). NULL VF = global.
    UNIQUE KEY uq_def (target_type, virtual_folder_id, dicom_level, physical_column),
    UNIQUE KEY uq_def_scope (target_type, scope_key, dicom_level, physical_column),
    KEY idx_type (target_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The PHYSICAL columns these seeds populate are declared on their owning tables'
-- CREATE TABLE (both DROP+recreated by schema-init so the declaration applies on
-- redeploy): series.bodypartexamined in schema-s3-index.sql (STORAGE/SERIES) and
-- virtual_instance.imagelaterality in schema-virtual-folder.sql (VF/INSTANCE).
-- Declaring on CREATE rather than a guarded ALTER here is deliberate: schema-init
-- splits this file on ';' and runs each statement as a single RDS-Data call (no
-- multi-statement PREPARE/EXECUTE guard block survives the split), and it only
-- swallows errors containing 'already exists' — a bare 'ALTER TABLE ADD COLUMN'
-- would throw 'Duplicate column name' on the second deploy and ABORT schema-init.
-- CREATE-column on a DROP+recreated table is idempotent by construction. The
-- index-attributes /defs create-path (index-attributes-api addDef) ALTERs the
-- correct tree table via levelTable(targetType, level) for any FUTURE attribute.
-- One-time idempotent preservation of the 2 live custom index_attributes rows
-- carried over from the pre-redesign model (confirmed by the operator). Each
-- becomes ONE def. STORAGE defs are global (virtual_folder_id NULL); a VF def
-- carries its VF id in virtual_folder_id (the per-scope opt-in table is retired,
-- so the VF binding lives on the def row itself). IDs are deterministic literals
-- so re-running schema-init is a no-op.
--   (a) STORAGE (global) tag 00180015 SERIES column bodypartexamined STRING
--       not-indexed.
--   (b) VF e2f2e9ae-09a1-487f-803a-79bf13619460 tag 00200062 INSTANCE column
--       imagelaterality STRING not-indexed.
INSERT INTO index_attribute_defs
    (id, target_type, virtual_folder_id, dicom_tag, dicom_level, column_name, physical_column, data_type, is_indexed, description, created_by)
VALUES
    ('iadef-seed-bodypartexamined', 'STORAGE', NULL, '00180015', 'SERIES',
     'bodypartexamined', 'bodypartexamined', 'STRING', FALSE,
     'Preserved from pre-redesign index_attributes (BodyPartExamined).', 'system'),
    ('iadef-seed-imagelaterality', 'VF', 'e2f2e9ae-09a1-487f-803a-79bf13619460', '00200062', 'INSTANCE',
     'imagelaterality', 'imagelaterality', 'STRING', FALSE,
     'Preserved from pre-redesign index_attributes (ImageLaterality).', 'system')
ON DUPLICATE KEY UPDATE physical_column = VALUES(physical_column);

-- Back-fill job per STORAGE index-attribute def (one row per def: the latest
-- run). The index-attributes-backfill worker walks the def's level table
-- (patient/study/series/instance) by primary key from cursor_pkey up to the
-- max_pkey snapshot taken when the job first runs, reading the stored gzipped
-- DICOM-JSON headers (Instancemetadata) and writing the attribute column. The
-- cursor advances in the SAME transaction as each batch's writes, so a job
-- resumes exactly where it stopped. chain_token identifies the one live SQS
-- message of the job's self-requeue chain; a stale or duplicate message whose
-- token no longer matches does nothing. Deleting the def deletes its job.
CREATE TABLE index_attribute_backfill_jobs (
    def_id        VARCHAR(36) PRIMARY KEY,
    status        ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    chain_token   VARCHAR(36) NOT NULL,
    cursor_pkey   BIGINT UNSIGNED NOT NULL DEFAULT 0,
    max_pkey      BIGINT UNSIGNED NULL,               -- set on first run
    rows_scanned  BIGINT UNSIGNED NOT NULL DEFAULT 0,
    rows_written  BIGINT UNSIGNED NOT NULL DEFAULT 0,
    batches       INT UNSIGNED NOT NULL DEFAULT 0,
    hops          INT UNSIGNED NOT NULL DEFAULT 0,    -- SQS self-requeues (hard-stop counter)
    error         TEXT NULL,
    requested_by  VARCHAR(64) NULL,
    requested_at  TIMESTAMP NULL,
    started_at    TIMESTAMP NULL,
    finished_at   TIMESTAMP NULL,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_iabf_status (status),
    CONSTRAINT fk_iabf_def FOREIGN KEY (def_id) REFERENCES index_attribute_defs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Analytics Conversations: per-user, per-INDEX AI chat history so text-to-sql
-- loads/persists conversation context SERVER-SIDE instead of trusting the client
-- to pass it back. Fresh-install only (no migration path); DROP+recreate.
-- NO-PROJECTS: project_id holds the SELECTED INDEX id (a datastore or virtual
-- folder id), not an analytics_projects row. The FK to analytics_projects was
-- REMOVED so the column can carry any index id (analytics no longer has a
-- Projects concept). The column name is kept for schema/query stability.
CREATE TABLE analytics_conversations (
    id VARCHAR(36) PRIMARY KEY,
    project_id VARCHAR(36) NOT NULL,       -- SELECTED INDEX id (datastore/vf id); not an FK
    username VARCHAR(255) NOT NULL,        -- cognito username (per-user context)
    title VARCHAR(255),                    -- optional, derived from first message
    messages JSON NOT NULL,                -- [{role:'user'|'assistant', text, sql?, ts}]
    last_sql TEXT NULL,                    -- last generated/run SQL for follow-ups
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_project_user (project_id, username),
    INDEX idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- PROCESSING JOBS TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS processing_jobs (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(32) NOT NULL DEFAULT 'STEP_FUNCTION',
    status VARCHAR(32) NOT NULL DEFAULT 'DEFINED',
    description TEXT,
    config JSON,
    parent_job_id VARCHAR(36) NULL,
    processed_steps_count INT NOT NULL DEFAULT 0,
    total_steps_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    INDEX idx_status (status),
    INDEX idx_type (type),
    INDEX idx_parent (parent_job_id),
    INDEX idx_deleted (deleted),
    FOREIGN KEY (parent_job_id) REFERENCES processing_jobs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS processing_job_steps (
    id VARCHAR(36) PRIMARY KEY,
    processing_job_id VARCHAR(36) NOT NULL,
    step_number INT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    input JSON,
    output JSON,
    error_message TEXT,
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    INDEX idx_job_id (processing_job_id),
    INDEX idx_status (status),
    FOREIGN KEY (processing_job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- DICOM series -> NIfTI file relationship, written by the DICOM to NIFTI Batch
-- job. One row per *output file*, not per series: dcm2niix splits a series
-- whenever the frames disagree on echo time, phase, orientation or coil, so a
-- single series legitimately yields several .nii.gz files (suffixed _e2, _ph,
-- _i00002, ...). A series that produced nothing still gets exactly one row,
-- with status 'FAILED' or 'SKIPPED' and output_key NULL, so the reason a
-- series is missing from the destination bucket is recorded rather than
-- inferred from absence.
--
-- The DICOM side of the relationship is stored as (datastore_id,
-- series_instance_uid) with no foreign key to `series`: that table lives in
-- schema-s3-index.sql, which is loaded after this file and only when the S3
-- storage feature is enabled, so an FK here would fail to resolve on a
-- deployment without the S3 index. series_pkey is kept as a convenience join key for
-- deployments that do have the index, and is nullable for the same reason.
CREATE TABLE IF NOT EXISTS nifti_conversions (
    id VARCHAR(36) PRIMARY KEY,
    processing_job_id VARCHAR(36) NOT NULL,
    processing_job_step_id VARCHAR(36) NULL,
    -- Internal datastore UUID (datastores.id), never an external datastore id.
    datastore_id VARCHAR(36) NOT NULL,
    study_instance_uid VARCHAR(128) NOT NULL,
    series_instance_uid VARCHAR(128) NOT NULL,
    series_pkey BIGINT UNSIGNED NULL,
    modality VARCHAR(16) NULL,
    series_description VARCHAR(255) NULL,
    -- Instances actually handed to the converter, which can be fewer than
    -- series.imagecount when instances were skipped (non-Part-10 object,
    -- availability not ONLINE).
    instance_count INT NULL,
    output_bucket VARCHAR(255) NULL,
    -- NULL when nothing was produced (see status).
    output_key VARCHAR(1024) NULL,
    -- The BIDS JSON sidecar dcm2niix writes beside the volume, when the job
    -- parameter asked for one.
    sidecar_key VARCHAR(1024) NULL,
    -- Diffusion gradient tables, written only for DWI series.
    bval_key VARCHAR(1024) NULL,
    bvec_key VARCHAR(1024) NULL,
    output_size_bytes BIGINT UNSIGNED NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    error_message TEXT NULL,
    converter_version VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(255) NULL,
    INDEX idx_nifti_job (processing_job_id),
    INDEX idx_nifti_series (datastore_id, series_instance_uid),
    INDEX idx_nifti_study (datastore_id, study_instance_uid),
    INDEX idx_nifti_status (status),
    FOREIGN KEY (processing_job_id) REFERENCES processing_jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- USER MANAGEMENT TABLES
-- ============================================================================

-- Privilege Groups: Define sets of permissions for users
CREATE TABLE privilege_groups (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    user_mode ENUM('SYSTEM_USER', 'DATA_USER', 'DEPLOYER_USER') DEFAULT 'SYSTEM_USER',
    datastore_privileges JSON,
    virtual_folder_privileges JSON,
    management_privileges JSON,
    deployment_privileges JSON,
    locked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    INDEX idx_name (name),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version),
    INDEX idx_user_mode (user_mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Users: Application users linked to Cognito
CREATE TABLE users (
    id VARCHAR(36) PRIMARY KEY,
    -- NOTE: no column-level UNIQUE on email/cognito_username. Uniqueness is
    -- enforced at the application layer scoped to LIVE users (users-api checks
    -- `WHERE email/cognito_username = ? AND deleted = false`). A hard UNIQUE
    -- here is incompatible with the soft-delete model: a soft-deleted row would
    -- permanently reserve the email/username and block recreation (F4).
    email VARCHAR(255) NOT NULL,
    cognito_username VARCHAR(255),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    description TEXT,
    -- NOTE: a user's privilege-group membership is a MANY-TO-MANY relation held
    -- in user_privilege_groups (below), not a scalar column here. A user's
    -- effective privileges are the UNION of every group they belong to; all of
    -- those groups must share one user_mode (enforced in users-api via
    -- privilege-merge.assertUniformMode).
    status ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') DEFAULT 'ACTIVE',
    last_login TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- Versioning and soft delete
    current_version INT NOT NULL DEFAULT 1,
    previous_versions JSON DEFAULT NULL,
    deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP NULL,
    deleted_by VARCHAR(255) NULL,
    
    INDEX idx_email (email),
    INDEX idx_deleted (deleted),
    INDEX idx_current_version (current_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- User <-> Privilege Group membership (many-to-many).
-- A user belongs to zero or more groups; a group holds zero or more users.
-- Effective privileges = UNION of all the user's groups (see privilege-merge).
-- ON DELETE CASCADE on both sides: deleting a user or a group removes its
-- membership rows (a group row is itself soft-deleted, so a cascade here only
-- fires on a genuine hard delete). The composite PK makes (user_id, group_id)
-- unique, so a user cannot be added to the same group twice.
CREATE TABLE user_privilege_groups (
    user_id VARCHAR(36) NOT NULL,
    privilege_group_id VARCHAR(36) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, privilege_group_id),
    INDEX idx_upg_user (user_id),
    INDEX idx_upg_group (privilege_group_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (privilege_group_id) REFERENCES privilege_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default admin privilege group
INSERT INTO privilege_groups (id, name, description, user_mode, datastore_privileges, virtual_folder_privileges, management_privileges, deployment_privileges, locked)
VALUES (
    'admin-group',
    'Administrators',
    'Full access to all datastores and management operations',
    'SYSTEM_USER',
    JSON_ARRAY(JSON_OBJECT('datastoreId', '*', 'canRead', true, 'canStore', true, 'canUpdate', true, 'canDelete', true)),
    JSON_ARRAY(JSON_OBJECT('virtualFolderId', '*', 'canRead', true, 'canStore', true)),
    JSON_OBJECT(
        'interfaces', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'dicomEntities', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'datastores', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'locations', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'routingRules', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'privilegeGroups', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'users', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'auditTrail', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', true),
        'statistics', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', true),
        'systemMonitor', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', true),
        'serviceUsers', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true),
        'virtualFolders', JSON_OBJECT('canCreate', true, 'canEdit', true, 'canDelete', true, 'canList', true),
        'analytics', JSON_OBJECT('canList', true, 'canEdit', true, 'canDelete', true, 'canQuery', true),
        'processingJobs', JSON_OBJECT('canCreate', true, 'canDelete', true, 'canRead', true, 'canRun', true),
        'indexAttributes', JSON_OBJECT('canEdit', true, 'canDelete', true, 'canList', true)
    ),
    JSON_ARRAY(JSON_OBJECT('locationId', '*', 'canDeploy', true)),
    TRUE
) ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    description = VALUES(description),
    user_mode = VALUES(user_mode),
    datastore_privileges = VALUES(datastore_privileges),
    virtual_folder_privileges = VALUES(virtual_folder_privileges),
    management_privileges = VALUES(management_privileges),
    deployment_privileges = VALUES(deployment_privileges),
    locked = VALUES(locked),
    updated_at = CURRENT_TIMESTAMP;

INSERT INTO privilege_groups (id, name, description, user_mode, datastore_privileges, management_privileges, deployment_privileges, locked)
VALUES (
    'data-access-group',
    'Data Access',
    'Full Access to all datastores data. No system management privileges',
    'SYSTEM_USER',
    JSON_ARRAY(JSON_OBJECT('datastoreId', '*', 'canRead', true, 'canStore', true, 'canUpdate', true, 'canDelete', true)),
    JSON_OBJECT(
        'interfaces', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', false),
        'dicomEntities', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', false),
        'datastores', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', false),
        'privilegeGroups', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', false),
        'users', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', false),
        'auditTrail', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', false),
        'statistics', JSON_OBJECT('canEdit', false, 'canDelete', false, 'canList', true)
    ),
    NULL,
    TRUE
) ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    description = VALUES(description),
    user_mode = VALUES(user_mode),
    datastore_privileges = VALUES(datastore_privileges),
    management_privileges = VALUES(management_privileges),
    deployment_privileges = VALUES(deployment_privileges),
    locked = VALUES(locked),
    updated_at = CURRENT_TIMESTAMP;

-- Insert default admin user
INSERT INTO users (id, email, first_name, last_name, cognito_username, status)
VALUES (
    'admin-user-001',
    'admin@example.com',
    'System',
    'Administrator',
    'admin',
    'ACTIVE'
) ON DUPLICATE KEY UPDATE
    updated_at = CURRENT_TIMESTAMP;

-- Default admin user belongs to the built-in Administrators group.
INSERT INTO user_privilege_groups (user_id, privilege_group_id)
VALUES ('admin-user-001', 'admin-group')
ON DUPLICATE KEY UPDATE created_at = created_at;



-- ============================================================================
-- QC OPERATIONS / DATA MANAGEMENT
-- ============================================================================

CREATE TABLE IF NOT EXISTS study_modification_jobs (
    id VARCHAR(36) PRIMARY KEY,
    datastore_id VARCHAR(36) NOT NULL,
    study_instance_uid VARCHAR(255) NOT NULL,
    series_instance_uid VARCHAR(255),
    operation_type ENUM('UPDATE_PATIENT', 'UPDATE_STUDY', 'UPDATE_SERIES', 'DELETE_STUDY', 'DELETE_SERIES', 'DELETE_INSTANCE', 'DELETE_INSTANCES', 'VF_UNASSIGN', 'SPLIT_SERIES', 'SPLIT_INSTANCES') NOT NULL,
    modifications JSON,
    status ENUM('PENDING', 'PREPARING', 'READY', 'IN_PROGRESS', 'VERIFYING', 'COMPLETED', 'FAILED', 'ROLLED_BACK') NOT NULL,
    current_step VARCHAR(100),
    steps JSON,
    image_sets JSON,
    initiated_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    error_message TEXT,
    INDEX idx_datastore_status (datastore_id, status),
    INDEX idx_study_status (study_instance_uid, status),
    INDEX idx_status (status),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


