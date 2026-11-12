# Documentation

## User guides

Start with [Installation](installation.md), then [Getting started](getting-started.md).

| Guide | Covers |
|---|---|
| [Installation](installation.md) | Prerequisites, `config.json` and `-c` flag reference, deploying, first sign-in, on-premises DIMSE install, updates, teardown |
| [Getting started](getting-started.md) | First setup step by step, then a tour of the admin UI |
| [Storage](storage.md) | Creating and importing storages, automatic indexing, storage classes, deletion |
| [Searchable attributes](searchable-attributes.md) | Adding DICOM tags as search columns |
| [Importing data](importing-data.md) | Supported file types, browser upload, import jobs, non-DICOM import, AWS CLI, whole-slide images |
| [Studies](studies.md) | Searching, viewing, editing metadata, deleting |
| [Data-user website](data-user-view.md) | The website for clinicians and researchers |
| [Virtual folders](virtual-folders.md) | Folders, de-identification profiles, assignment rules |
| [DICOM networking](dicom-networking.md) | Locations, interfaces, entities, routing rules, TLS, on-premises gateway |
| [Analytics](analytics.md) | Natural-language and SQL queries |
| [Processing jobs](processing-jobs.md) | Plug-ins, running jobs, schedules |
| [Users and access](users-and-access.md) | Users, privilege groups, MFA |
| [Audit trail](audit-trail.md) | What is recorded, searching, exporting |
| [Monitoring](monitoring.md) | Queues, AWS resources, exceptions, CloudWatch |
| [DICOMweb and REST API](dicomweb-api.md) | Authentication, endpoints, curl examples, connecting viewers |

### Screenshots

The images under `images/` are captured from a live deployment by [`tools/capture.mjs`](tools/capture.mjs), with the shot lists in [`tools/shots/`](tools/shots/). The tool signs in through the UI, draws the numbered callouts the guides refer to, and replaces account IDs, hostnames, user-pool and client IDs, tokens, real email addresses and IP addresses before each capture. To refresh the images after a UI change:

```bash
NODE_PATH=$(npm root -g) DOCS_BASE_URL=https://<cloudfront-domain> \
DOCS_PASSWORD_FILE=<file holding the admin password> DOCS_TOKEN=<access token> \
  node docs/tools/capture.mjs docs/tools/shots/<area>.json
```

It needs Node.js with the `playwright` package and its Chromium browser installed. Check every refreshed image before committing it: redaction covers the patterns above, not everything a page might show.

## Design and reference

These documents describe how the system is built. Where one disagrees with a user guide or the code, the code is correct.

| Document | Subject |
|---|---|
| [DESIGN.md](DESIGN.md) | Full architecture with system, stack, auth, ingest, DICOMweb and virtual-folder diagrams (Mermaid sources and rendered PNGs in [diagrams/](diagrams/)) |
| [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) | Overall architecture, stacks, APIs, Lambda functions |
| [database-schema.md](database-schema.md) | Database tables |
| [PLUGINS.md](PLUGINS.md) | Writing processing-job plug-ins (container contract, manifest) |
| [dicom-tls-support.md](dicom-tls-support.md) | DICOM TLS and mutual TLS |
| [IN-VPC-ONLY-DEPLOYMENT.md](IN-VPC-ONLY-DEPLOYMENT.md) | Deploying in the private, in-VPC network posture |
| [../PHI-HANDLING.md](../PHI-HANDLING.md) | PHI / HIPAA shared-responsibility statement |
