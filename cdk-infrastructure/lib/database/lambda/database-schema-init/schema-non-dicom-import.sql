-- ============================================================================
-- NON-DICOM IMPORTS TABLE
-- Tracks non-DICOM file encapsulation and import jobs
-- ============================================================================

CREATE TABLE IF NOT EXISTS non_dicom_imports (
    id VARCHAR(36) PRIMARY KEY,
    -- V1: the target datastore. V2: the storage the files are written to (for a
    -- virtual-folder destination, the folder's write storage).
    datastore_id VARCHAR(36) NOT NULL,

    -- Non-DICOM Import V2 (plans/NON-DICOM-IMPORT-V2-CONTRACT.md). V1 rows keep
    -- version 1 and NULL / FALSE in the V2-only columns.
    version INT NOT NULL DEFAULT 1,
    destination_kind VARCHAR(20) NULL,
    virtual_folder_id VARCHAR(36) NULL,
    content_not_deid_ack BOOLEAN NOT NULL DEFAULT FALSE,

    -- Status tracking (PARTIAL: V2, some files failed and the rest are indexed)
    status ENUM('SUBMITTED', 'PROCESSING', 'IMPORTING', 'COMPLETED', 'PARTIAL', 'FAILED') NOT NULL DEFAULT 'SUBMITTED',
    status_description TEXT,

    -- S3 references
    s3_input_keys JSON,
    s3_encapsulated_uri VARCHAR(500),

    -- DICOM context (patient/study/series attributes for encapsulation)
    patient_attrs JSON,
    study_attrs JSON,
    series_assignments JSON,

    -- Link to the import job (for status-updater to cascade COMPLETED/FAILED)
    import_job_id VARCHAR(255),

    -- S3 cleanup tracking
    s3_cleanup_status ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED') DEFAULT 'PENDING',

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by VARCHAR(255),

    FOREIGN KEY (datastore_id) REFERENCES datastores(id) ON DELETE CASCADE,
    INDEX idx_ndi_datastore (datastore_id),
    INDEX idx_ndi_status (status),
    INDEX idx_ndi_import_job_id (import_job_id),
    INDEX idx_ndi_created_by (created_by),
    INDEX idx_ndi_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- NON-DICOM IMPORT FILES (V2)
-- One row per file of a V2 import: the API inserts it PENDING, the V2
-- encapsulator moves it to ENCAPSULATING / WRITTEN / FAILED, and the API sets
-- INDEXED once ingest has indexed the SOP Instance UID.
-- ============================================================================

CREATE TABLE IF NOT EXISTS non_dicom_import_files (
    id VARCHAR(36) PRIMARY KEY,
    import_id VARCHAR(36) NOT NULL,
    file_index INT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    s3_key VARCHAR(1024) NOT NULL,
    content_type VARCHAR(100),
    size_bytes BIGINT,
    modality VARCHAR(8),
    series_instance_uid VARCHAR(64),
    sop_instance_uid VARCHAR(64),
    document_title VARCHAR(255),
    content_date VARCHAR(8),
    institution_name VARCHAR(255),
    -- Video only (XC), as read by the browser from the file; NULL when unknown
    -- (the encapsulator then writes 0 x 0, 1 frame, 33.33 ms like V1).
    video_width INT NULL,
    video_height INT NULL,
    number_of_frames INT NULL,
    frame_time DECIMAL(10,3) NULL,
    status ENUM('PENDING', 'ENCAPSULATING', 'WRITTEN', 'INDEXED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    error_message VARCHAR(1000),
    output_key VARCHAR(1024),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ndif_import (import_id),
    INDEX idx_ndif_sop (sop_instance_uid),
    CONSTRAINT fk_ndif_import FOREIGN KEY (import_id) REFERENCES non_dicom_imports(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
