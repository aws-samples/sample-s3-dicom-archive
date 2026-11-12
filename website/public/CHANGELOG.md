# Changelog

## **Version 0.40** - 2026-10-13

### New Data-User Website
- The data-user website now has the same look as the admin site: a sidebar listing your storages and virtual folders, a details panel under the study table, and the same color themes
- All viewers and actions are in one Tools panel that you can open or close; star a tool to keep it as a button next to Tools (OHIF Viewer is starred by default). Your stars and the panel's open or closed state are remembered in your browser
- Tools that open one study at a time (SLIM, VolView, Attach files) are disabled while several studies are selected, with the reason shown when you hover over them
- Download a study as a .zip file when your privilege group allows it on that storage or folder. Downloads from a de-identified folder are de-identified, like everything else you read there

### 3D Viewing with VolView
- New "VolView" tool on the data-user website: 3D volume rendering, multi-planar views (MPR), segmentation painting, PET/CT overlays, measurements and cropping, all running in your browser
- VolView opens the selected study with your own sign-in, so your folder privileges and de-identification apply. It cannot load data from outside the archive
- Administrators turn it on or off with `volviewFeature` in `config.json`

### Importing PDFs, Images and Videos (new import)
- A new three-step import: choose the files and the destination, choose the patient, then review and submit
- For PDFs and images, the archive reads the patient name, ID, birth date and sex, and the document's date, type, title, referring physician, institution and accession number. It shows where in the document each value was found, and suggests matching patients from the destination. You always confirm the patient; nothing is attached automatically
- When no patient matches, a new patient is pre-filled from the document
- A warning appears when the files seem to belong to different patients
- "Attach files" on a study adds documents to that study directly
- Imports into a de-identified folder are allowed, but you must confirm that the files' contents are not de-identified: only DICOM tags are. The confirmation is recorded in the audit trail
- Each file shows its own status and a readable error, for example "PDF is encrypted"
- Document Title, Referring Physician, Content Date and Institution are now filled in the created DICOM files
- Limits: 100 MB per PDF or image, 2 GB per video, 50 files per import. Videos are imported but not analyzed
- Available on the admin site (Import > second tab) and on the data-user website for users who can store into at least one writable storage or folder. Administrators turn it on with `nonDicomImportV2` in `config.json`; the previous import stays available

### Admin Site
- New Queues Monitor page: every queue of the deployment, including the DICOM service's, with depth, dead-letter queues, oldest message age and throughput
- Searchable Attributes: a new attribute is filled in for existing studies in the background, without a full Sync. Progress is shown and you can re-run it
- Privilege groups have a new Download column for storages and virtual folders
- The unused Service Users page was removed

### Analytics
- The AI assistant now checks its own queries against your data before answering, understands DICOM terms (modalities, SOP classes, transfer syntaxes) and retries hard questions with a stronger model
- Paging through results and asking follow-ups in saved conversations work correctly

### DICOM Service (DIMSE)
- C-STORE accepts compressed images, including JPEG XL, and stores them as received; C-GET only sends a file in a format the receiving system accepts
- A query or retrieve with an invalid study, series or instance UID now gets a clear failure status instead of an empty result
- Every association, query and retrieve is recorded in the audit trail, including refused connections
- A DIMSE routing rule can no longer target a read-only storage

---

## **Version 0.39** - 2026-10-07

### New Admin UI
- New admin interface (website-2) is now the default at `/admin/`, with its own UI kit and app shell; it passes WCAG A/AA accessibility checks in light and dark mode
- Color themes in Settings > Appearance > Theme: Light, a lighter Dark, Nord, Catppuccin Frappé, Solarized Dark and Solarized Light; the sun/moon button switches between your last light and last dark theme
- Analytics page: storage / virtual folder multi-select above the SQL editor, saved conversations in the AI assistant header, full-width layout
- Tables and cards keep their rows on screen while refreshing
- "Index Attributes" renamed to "Searchable Attributes"
- The unused "Navigation style" preference was removed
- Privilege group editor covers Processing Jobs and System Monitor
- Password hints and checks require 12 characters, matching the sign-in policy

### Processing Plug-ins
- New plug-in framework: register container plug-ins, run them on studies, series or virtual folders, and download their outputs
- GPU queue, multi-stage pipelines, and write-back of DICOM results to a chosen storage
- DICOM to NIfTI ships as a built-in plug-in
- Scheduled plug-in runs now start correctly and run with the schedule owner's current permissions
- Run files can be deleted from the run detail page; plug-in containers run as a non-root user

### Virtual Folders and De-identification
- STOW-RS into a virtual folder stores into its storage and assigns the instances to the folder
- Folder readers get de-identified data on every DICOMweb path, including search results (StudyID, PatientSex)
- De-identification hashes are keyed by a deployment secret; folder trees store no original identifiers

### DICOM Service (DIMSE)
- C-STORE writes directly to the storage bucket
- C-FIND, C-MOVE and C-GET use the called interface's storages and privileges; C-MOVE only sends to nodes configured on that interface
- DICOM TLS always requires a pinned client certificate
- C-FIND wildcard queries return matches; C-GET accepts lists of study, series or instance UIDs
- The service renews its DICOMweb session automatically (queries no longer fail one hour after start)
- Whole-slide images imported as raw slide files are refused quickly over C-GET (view them in SLIM)

### DICOMweb
- STOW-RS validates UIDs and never overwrites an existing instance with different content
- STOW-RS retries indexing when a connection is dropped (no more intermittent 409)
- Faster study search using stored study aggregates

### Import and Statistics
- Non-DICOM import works again and its status moves to Completed or Failed
- Bucket import refuses the deployment's own buckets and requires the bucket to be tagged for this deployment
- Dashboard statistics are maintained incrementally and refresh within about 2 minutes of ingest

### Security
- Security remediation across access control, cross-tenant access, PHI exposure and analytics SQL (SQL is parsed and scoped to the selected storages)
- Delegated user admins cannot edit, demote, delete or reset users who hold more privileges than they do
- Least-privilege database users with 30-day password rotation
- Security headers (HSTS, nosniff, frame and referrer policy), API throttling, IAM permissions boundaries and one execution role per module
- Dependency upgrades (mysql2, PyMySQL, node-forge, axios, cryptography, AWS SDK and CDK)
- Production settings are the default deployment posture; viewers are pinned to verified builds

---

## **Version 0.38** - 2026-06-12

### DICOM C-GET Support

- DIMSE service now supports the C-GET retrieval operation (Patient Root and Study Root information models), in addition to the existing C-STORE, C-FIND, and C-MOVE
- Instances are returned to the requesting peer via C-STORE sub-operations over the same association (SCP/SCU Role Selection), so a separate inbound port for C-MOVE is not required
- Shares the same `RETRIEVE` privilege as C-MOVE — no new configuration needed
- Storage presentation contexts negotiate uncompressed transfer syntaxes (Explicit/Implicit VR Little Endian) for reliable delivery
- Supports STUDY, SERIES, and INSTANCE level retrieval

---

## **Version 0.37** - 2026-04-01

### Data Analytics Feature

- New analytics projects for indexing DICOM metadata from datastores
- S3 Datalake storage using Apache Iceberg tables, integrated with AWS analytics services
- Automatic indexing via EventBridge — ImageSet create/update/delete events sync to analytics tables
- 22 default indexed DICOM attributes across Patient, Study, Series levels plus full JSON blobs
- Custom attributes with Iceberg schema evolution (add_column)
- Backfill pipeline extracts new attribute values from stored JSON — no external API calls needed
- SQL query interface with execution against Athena
- Natural language to SQL via Amazon Bedrock Nova Micro (optional, gated by `analyticsFeatureTextToSQL`)
- Daily Iceberg compaction via scheduled Athena OPTIMIZE
- New `analytics` management privilege area with canList, canEdit, canDelete, canQuery permissions
- Admin UI: Analytics Projects management page and Analytics Query workspace
- Query workspace features: project selector, table schema panel, dynamic results table

---

## **Version 0.36** - 2026-03-26

### DICOM TLS Support

- DICOM TLS endpoint on port 2762 with self-signed CA certificates auto-generated at deploy time
- Mutual TLS (mTLS) with per-entity client certificate validation
- Dynamic TLS context reload — toggling client verification takes effect without service restart
- Client certificate upload on DICOM entity configuration

### Security Enhancements

- AE title authorization enforced at association level — unauthorized connections aborted immediately on both plain and TLS endpoints
- Per-port security group ingress rules — choose TLS (2762), plain DICOM (11112), or both when adding IP allowlist entries
- DICOM port fields disabled for infrastructure-managed Fargate locations

### DICOM Service Improvements

- C-MOVE and C-STORE operations now log at INFO level for better observability
- Datastore read permissions added to ECS task role (SearchDICOM, GetDICOMInstance, etc.)

### Viewer

- OHIF viewer accept header now adapts to datastore transcode format (HTJ2K vs JPEG 2000 Lossless)

---

## **Version 0.35** - 2026-03-24

### Non-DICOM Import

- Import PDFs, images (JPEG/PNG), and videos (MP4) as DICOM objects into any datastore
- Encapsulates files as Encapsulated PDF, Secondary Capture, or Video Endoscopic SOP classes
- Add files to existing studies or create new patients and studies
- Series management with file assignment, thumbnail previews, and modality validation
- Import job tracking with status history and auto-refresh

### DICOM Thumbnails

- Support for MONOCHROME1, RGB, YBR_FULL, and YBR_FULL_422 photometric interpretations
- Compressed transfer syntax handling (JPEG/JPEG2000 color frames)
- Shared reusable thumbnail component across admin pages

### Data-User Website

- Added series thumbnails to the series table

---

## **Version 0.34** - 2026-03-12

### Password & Account Management

- Reset MFA now fully removes the TOTP token by recreating the Cognito user, so old authenticator codes no longer work
- Custom branded emails for all account events:
  - **Welcome email** when a new account is created (subject: "DICOM Archive - Welcome to your new account")
  - **MFA reset email** when an admin resets MFA (subject: "DICOM Archive - Your MFA has been reset")
  - **Password reset email** with clickable reset link (subject: "DICOM Archive - Reset your password")
- All emails include the login URL and clear instructions for next steps
- New `deploymentName` config in `config.json` for human-readable branding in emails (default: "DICOM Archive")

### UI

- Datastore name field is now disabled in the edit modal when MedDream mode is enabled, with explanatory text

---

## **Version 0.33** - 2026-03-11

### Virtual Folders — Write Mode

- Virtual folders can now be configured with a write-enabled datastore
- Three write modes: Read-only, Write to existing storage, or Create dedicated storage
- "Create dedicated storage" automatically provisions a new datastore via the existing creation workflow
- Write mode and datastore status visible in the virtual folders table
- Folder names limited to 28 characters (alphanumeric, dots, underscores, hyphens, spaces)
- Datastore quota exceeded errors are now handled gracefully during creation

### Virtual DICOMweb Service

- Fixed MySQL connection pool exceeding the 32-connection hard cap
- Added connection retry with exponential backoff
- Fixed DICOM metadata compliance: removed group 0002 tags, normalized multi-value strings, TM values, and PersonName formatting
- Fixed numeric VR types (US, SS, UL, SL, IS, FL, FD) returned as proper numbers instead of strings
- Fixed de-identification value swap overwriting unrelated DICOM tags (e.g. ImageType, Rows, Columns)

### Data-User UI

- Added per-row viewer launch button with modality-based app preferences
- Users can configure default viewer app per modality (e.g. CT → OHIF, SM → SLIM)

---

## **Version 0.32** - 2026-03-06

### Security

- Config download packages are now AES-256 encrypted
- DICOM service binary compiled with PyInstaller for additional protection
- Audit trail sanitizes sensitive location data (certificates, ARNs, bucket info)
- Security group descriptions normalized to `[DO NOT MODIFY] <stackName> - <purpose>` convention
- Fixed security group rule rejection when IP descriptions contained apostrophes
- DICOM association authorization now rejects unauthorized connections immediately instead of after data transfer

### Storage

- Storage names restricted to valid characters (alphanumeric, dots, underscores, hyphens)
- MedDream mode enforces 16-character name limit
- Fixed de-identification profile column reference (`operations` → `tag_actions`)

### DICOM Service

- Fixed `get_credentials()` method preventing service startup
- Dynamic configuration reload when entity privileges or interface settings change
- Default max associations reduced from 100 to 20
- Default log level changed to WARNING
- AE titles can now be reused after interface deletion
- Installation script improved with numbered location selection and re-install support

### UI Improvements

- Compact density mode enabled globally
- Import jobs table column preferences now work correctly, sort icons removed
- Dashboard shows info alert for users without privileges instead of empty page
- Fixed stale table selection after editing rows across all management tables
- Virtual folders table supports multi-select and bulk delete
- Virtual folders de-identification column now shows profile name
- Privilege groups details modal shows associated users and virtual folder names
- Location config tab for Fargate locations (NLB endpoint, task scaling, IP allowlist)
- Config download button shows loading spinner
- Security group rules support user-provided descriptions
- AWS Resources table shows creation date column

### Data Model & APIs

- Record versioning added to privilege groups, users, routing rules, and virtual folders
- Users table now includes optional description field
- Fixed privilege group associated users null field handling

---

## **Version 0.31** - 2026-02-26

### Routing Rules

- **Conditional Routing with AND/OR Logic**: Routing rules now support complex conditions with per-condition logic operators
  - Add multiple conditions to a single rule with AND/OR operators between them
  - Operators appear between conditions for intuitive rule building
  - Example: Route CT OR MR studies to one datastore, RF studies to another
  - DICOM service evaluates conditions in order, combining results with specified logic
  - Rules evaluated by priority (lowest number first), first match wins

### Security & Access Control

- **Deployment Privileges**: Added granular deployment permissions allowing users to deploy remote services to specific locations without full management access
- **DICOM Association Authorization**: DICOM service now validates privileges at association time, rejecting unauthorized connections immediately before data transfer
- **Dynamic Config Updates**: DICOM services automatically reload configuration when entity privileges or interface settings change

### UI Improvements

- **Sticky Top Navigation**: Top navigation bar now remains fixed at the top of the window when scrolling
- **Interface Server Monitor Grouping**: Added location-based grouping with expandable sections for better organization
- **AWS Resources Table**: Fixed expand/collapse buttons and replaced toggle with button for grouping control
- **Deployer User Mode**: New privilege group mode for users who only need deployment access to specific locations
- **Routing Rules Count**: DICOM interfaces table now shows routing rules count with warning indicator when no rules configured

### Installation & Deployment

- **DICOM Service Installation**: Added installation instructions modal with copy-to-clipboard commands in Locations table
- **Installation Script Refactor**: Reorganized installation flow into logical steps with clear progress indicators
- **Website UI Auto-Deploy**: Website UI pipeline now triggers automatically on CDK deploy

### Bug Fixes & Enhancements

- **ImageSetProcessor Lambda**: Added graceful handling of ConflictException when datastores are not active
- **Config Cleanup**: Removed unused aws-exports.js file, simplified configuration to use runtime config only
- **DICOM Privileges API**: Disabled unused DICOM privileges API (functionality merged into dicom-entities API)
- **Dashboard Storage Growth**: Fixed to exclude deleted datastores from storage growth widgets

---

## **Version 0.30** - 2026-02-03

### Virtual Folders

- Create virtual folders to organize and share DICOM studies with deidentification
- Assign studies to virtual folders for controlled access
- Filter DICOM studies by virtual folder assignment
- Configure granular access privileges for virtual folders (read, store permissions)
- Manage virtual folders from the Data Management section
- View virtual folder assignments in privilege group details

---

## **Version 0.25** - 2025-12-04

### Datastore Import and Deletion Improvements

- Added support for importing existing datastores into the application
- Import feature allows users to manage pre-existing datastores without recreating them
- Imported datastores are properly tagged with Project, Environment, ManagedBy, Deployment, and datastore-id tags
- Optional IAM role creation during import for read-only and store access
- Fixed datastore deletion workflow to properly delete all ImageSets before removing the datastore
- Added 2-minute wait after ImageSet deletion to ensure complete cleanup before datastore removal
- Extended deletion workflow timeout from 30 minutes to 1 year for large datastores
- Fixed privilege group soft-deletion when datastores are deleted
- Both DEREGISTER and DELETE_ALL operations now properly mark datastores as deleted in the database
- Updated UI deletion modal to remove incorrect S3 bucket references

---

## **Version 0.24** - 2025-12-03

### DICOM Service Improvements

- Fixed missing audit logs for update and deletion of DICOM interfaces
- Fixed config update signaling for the DICOM service
- Fixed interface server cleanup Lambda to properly handle queue deletion
- Updated pynetdicom to version 3.0.4 for improved DICOM protocol support
- Fixed AE title extraction in association requests using proper pynetdicom API
- Added deleted filter to interfaces query in config service
- Changed association tracker logs to debug level to reduce log verbosity

---

## **Version 0.22** - 2025-11-29

### S3-per-Location Architecture

- S3 buckets for data import are now associated with the Location application construct instead of the Storage (datastore) construct
- Simplified datastore lifecycle management by removing S3 bucket creation/deletion from datastore workflows
- Added complete solution tags to location S3 buckets: Project, Environment, ManagedBy, and Deployment
- Implemented tag-based S3 bucket policies for location-specific access control

---

## **Version 0.21** - 2025-11-29

### Interface Server Cleanup Fixes

- Fixed cleanup function deletion order - now deletes SQS queues BEFORE deleting interface_servers database records
- Prevents orphaned SQS queues when cleanup process fails partway through

### Dashboard Refresh All Fix

- Fixed "Refresh All" button to properly refresh all dashboard widgets
- Now refreshes: dashboard stats, modality data, DLQ status, storage growth trend, and storage changes
- Previously only refreshed dashboard stats and utilization

---

## **Version 0.2** - 2025-11-29

### Dashboard Storage graphs DateRangePicker fix

- Updated DateRangePicker presets to include: Last day, Last 7 days, Last 30 days, Last 3 months, Last 6 months, Last 12 months
- Removed hourly presets (Last 1 hour, Last 6 hours) for better long-term storage trend analysis
- Improved date range calculation to properly handle day, month, and year units for both relative and absolute date ranges
- Added client-side monthly chunking to split large date range requests into smaller batches, preventing backend overload
- Fixed Storage Growth Trend and Storage Changes widgets to correctly process all date range selections

---

## **Version 0.1** - 2025-11-29

### Initial Release

- Added version number display in top navigation
- Removed Support menu from navigation
- Implemented datastore deletion with two modes: DEREGISTER and DELETE_ALL
- Fixed dashboard to filter out deleted datastores
- Resolved infinite image loading loop in Studies UI
