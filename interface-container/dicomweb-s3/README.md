# DICOMweb S3 Service

> **PHI / HIPAA notice:** This service serves and stores DICOM data containing
> Protected Health Information. Operating it compliantly is a customer
> responsibility — see [`PHI-HANDLING.md`](../../PHI-HANDLING.md) at the
> repository root.

DICOMweb (QIDO-RS + WADO-RS, plus STOW-RS and delete) over the S3 storage index.
Runs as a Fargate service behind an internal ALB, reached from the browser through
the CloudFront VPC origin at `/dicomweb/*`. Deployed only when the `s3StorageFeature`
flag is on.

Reads are the common path: pixels are never copied into this service, and every
retrieve is a ranged GET against the datastore's own archive bucket, resolved
through `Instancelocation`. Writes (STOW-RS store, DELETE) and the download paths
exist too, but are gated: a write only reaches a datastore whose `access_level` is
writable (`is_writable_access_level`, see `writable_destination.py`), and
per-interface tokens (`dicom_service_token.py`) scope who may call them. A read-only
storage refuses every write at the middleware boundary as defense in depth.

## The tenancy rule

Every route is `/dicomweb/{datastoreId}/...`, and **the only datastore id that may
reach SQL is `g.identity.datastore_id`** — the value `auth_middleware` resolved from
the caller's token and authorized against `datastore_privileges`. The path segment
is untrusted input.

This is not stylistic. The index's unique keys are composite:

```
uq_study_uid    (datastore_id, studyinstanceuid)
uq_series_uid   (datastore_id, d0020000e)
uq_instance_uid (datastore_id, d00080018)
```

A bare UID identifies at most one row *per datastore*. A query that omits its
datastore predicate does not fail — it returns another tenant's PHI.

Two mechanisms enforce it:

1. No handler declares the path variable. Flask passes view args as keyword
   arguments, so `datastore_id` is absorbed into `**_` and using the wrong value is
   unreachable from the handler body, not merely discouraged.
2. Every constant in `sql_queries.py` leads its `WHERE` with `i.datastore_id = %s`,
   and every `_construct_query` prototype leads with the datastore predicate and
   binds `datastore_id` as its first parameter. There are deliberately no
   unscoped query aliases left in the module.

Soft delete rides along: every query filters `deleted_at IS NULL` on every joined
level, so a soft-deleted ancestor hides its descendants until the GC sweep
hard-deletes them.

## Routes

`{ds}` = `datastoreId`.

| Method | Path | Notes |
|---|---|---|
| GET | `/dicomweb/health` | Auth-exempt, never audited. `200 {"status":"ok"}` / `503 {"status":"degraded"}` |
| GET | `/dicomweb/{ds}/studies` | QIDO SearchForStudies |
| GET | `/dicomweb/{ds}/studies/{study}/series` | QIDO SearchForSeries (in study) |
| GET | `/dicomweb/{ds}/studies/{study}/instances` | QIDO SearchForInstances (in study) |
| GET | `/dicomweb/{ds}/series` | QIDO SearchForSeries (all) |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/instances` | QIDO SearchForInstances (in series) |
| GET | `/dicomweb/{ds}/instances` | QIDO SearchForInstances (all) |
| GET | `/dicomweb/{ds}/studies/{study}` | WADO bulk DICOM, `multipart/related; type="application/dicom"` |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}` | WADO bulk DICOM |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/instances/{sop}` | WADO bulk DICOM |
| GET | `/dicomweb/{ds}/studies/{study}/metadata` | `application/dicom+json` |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/metadata` | `application/dicom+json` |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/instances/{sop}/metadata` | `application/dicom+json` |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/instances/{sop}/frames/{list}` | `multipart/related`, honors `Accept` transfer-syntax |
| GET | `/dicomweb/{ds}/studies/{study}/rendered` | `501` (unbounded on large studies) |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/rendered` | `501` |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/instances/{sop}/rendered` | JPEG/PNG |
| GET | `/dicomweb/{ds}/studies/{study}/series/{series}/instances/{sop}/frames/{n}/rendered` | JPEG/PNG, exactly one frame |
| GET | `/dicomweb/{ds}/bulk/element/{sop}/{tagHex}` | BulkDataURI target emitted by ingest |
| GET | `/dicomweb/{ds}/bulk/icc/{sop}` | ICC profile for a virtualized WSI level |
| POST | `/dicomweb/{ds}/studies` | STOW-RS store. Writable datastores only; invokes the ingest Lambda synchronously so the object is indexed before the response returns |
| POST | `/dicomweb/{ds}/studies/{study}` | STOW-RS store into a specific study |
| DELETE | `/dicomweb/{ds}/studies/{study}` | Delete a study (writable datastores only) |
| DELETE | `/dicomweb/{ds}/studies/{study}/series/{series}` | Delete a series |
| DELETE | `/dicomweb/{ds}/studies/{study}/series/{series}/instances/{sop}` | Delete an instance |
| GET | `/dicomweb/{ds}/download-access` | Whether the caller may download from this datastore |
| GET | `/dicomweb/{ds}/studies/{study}/download` | Download a study (gated by download privilege) |

The two `/bulk/...` shapes are frozen: they are what the ingest Lambdas write into
stored metadata as `BulkDataURI`. Changing either shape orphans every already-ingested
instance.

There is **no** `/bulk/{bucket}/{key}` route. The reference had one; it read any
bucket and any key with the task role, unscoped by datastore, and nothing in this
pipeline emits it.

### Rendered query parameters

`viewport=vw,vh[,sx,sy,sw,sh]`, `window=center,width,function`
(`linear`|`linear-exact`|`sigmoid`), `quality=1..100` (default 90),
`iccprofile=no|yes|srgb|adobergb|rommrgb|displayp3` (default `no`),
`annotation=patient,technique`. Output type is negotiated from `Accept`
(`image/jpeg` default, `image/png`); an `Accept` we cannot satisfy gets `406`.

## Instance availability — `(0008,0056)`

`series.availability` and `instance.d00080056` are written by ingest. `NULL` means
`ONLINE` (the plain DICOM path never writes the column), so QIDO `COALESCE`s it.

QIDO returns `(0008,0056)` at all three levels. Study level has no column — there
is no `study.availability` and Phase 2 adds no DDL — so it is rolled up from the
study's live series, **best state wins**: a study is reachable if any of it is.

Every endpoint that ranged-GETs a backing object refuses when the object is out of
reach:

| State | Response |
|---|---|
| `ONLINE` / `NULL` | served |
| `NEARLINE` | `503` + `Retry-After: 300` (restore in progress) |
| `OFFLINE` / anything unrecognized | `503` + `Retry-After: 3600` (restore must be requested) |

An unrecognized value is treated as `OFFLINE` on purpose: a future availability
value this build has never heard of must not be assumed readable.

**`/metadata` is the deliberate exception** and stays `200`. The blob is a database
row, so serving it reads no archived object — and it is exactly what a client needs
to render an "archived, request restore" affordance with real study/series/instance
context.

**Study- and series-level bulk retrieve refuse as a whole.** If *any* instance under
the UID is not ONLINE, the entire request gets the `503` for the worst state present,
before a single byte of the multipart body. The alternative — stream the ONLINE
members and omit the rest — produces a `200 multipart/related` body that looks like a
complete study, and a silently short study is a patient-safety defect. The client is
not stuck: QIDO reports `(0008,0056)` per instance, and instance-level retrieval of
each ONLINE member still returns `200`.

## Private tags

Instance-level QIDO can surface the backing object location in a proper private block:

```
(7777,0010) LO  "DICOMWEBS3"     Private Creator
(7777,1001) LO  <s3 key>
(7777,1002) LO  <bucket name>
```

Gated three ways, because a key plus a bucket is enough to read the object directly
and bypass this service's authorization entirely: the columns are not selected, the
injector is not called, and any `0x7777` element is stripped from the assembled
entry. The gate is `management_privileges.datastores.canEdit` on the caller's token,
surfaced as `RequestIdentity.include_private_tags`; the QIDO cache is namespaced on
it so a privileged response can never be served from cache to an unprivileged
caller.

## Documented behaviors that look like bugs

- **A deletion stays visible for up to 30 s.** QIDO responses are cached for
  `QIDO_CACHE_TTL` seconds per (datastore, privilege, level, query). A study deleted
  from S3 can keep appearing in search results until the entry expires. Retrieve is
  not cached, so the same study 404s immediately.
- **The same patient id in two datastores is two patient rows.** `patient` is
  datastore-scoped like every other table in the index (`uq_patient_ds_id` is
  `(datastore_id, patientid)`), because `PatientID` is assigned by the sending
  institution and collides across tenants. Ingest upserts and the study-level QIDO
  join are both scoped, so demographics never cross a datastore boundary — an
  earlier revision deduplicated `patient` globally and did leak them. There is no
  cross-datastore patient view, and nothing here merges the two rows.
- **A study or series may legitimately have zero instances.** SVS ingest creates a
  discoverable OFFLINE series with no instances when a sidecar arrives before its
  slide, and the GC sweep exempts it. `NumberOfSeriesRelatedInstances` returns 0,
  `/instances` returns `200 []`, and series-level bulk retrieve returns `404`.
- **Studies can reappear.** Every upsert resets `deleted_at = NULL` up the whole
  ancestor chain, so new bytes revive a soft-deleted study between two QIDO calls.
- **`?ModalitiesInStudy=` is not a supported filter.** It maps to a computed alias
  and MySQL rejects an alias in `WHERE`. It is still *returned*, just not searchable.
  `(0008,0056)` is likewise returned but not searchable, for the same reason.
  Sending either is a `400`, not a silently widened `200`: dropping the filter
  answered `?InstanceAvailability=ONLINE` with the OFFLINE instances too.
- **An unrecognized query parameter is ignored, not refused.** PS3.18 §8.3.4 only
  allows a refusal for a *search key* the level cannot honor. Anything that is not a
  DICOM attribute (a cache-buster, a viewer's own parameter) is dropped, and the
  response carries `Warning: 299 dicomweb-s3: query parameters ignored: ...`.
- **A bare `/studies` returns at most `QIDO_DEFAULT_LIMIT` rows** even with no
  `limit=`, and `limit=` is clamped to `QIDO_MAX_LIMIT`.

## Environment

Set by the CDK stack; every value has a container-side default except the five
marked required.

| Variable | Default | Purpose |
|---|---|---|
| `DB_SECRET_ARN` | **required** | Secrets Manager ARN for the Aurora credentials |
| `DB_NAME` | **required** | Schema name |
| `DB_HOST` | secret's `host` | Cluster writer endpoint |
| `DB_PORT` | `3306` | |
| `DB_POOL_SIZE` | `32` | Connection pool size **and** waitress thread count |
| `USER_POOL_ID` | **required** | Cognito user pool (JWKS issuer) |
| `USER_POOL_CLIENT_ID` | **required** | Expected token audience; boot fails if empty |
| `OIDC_ENABLED` | `true` | `false` disables token verification |
| `ALLOW_UNAUTHENTICATED_ACCESS` | `false` | Local development only |
| `AWS_REGION` | `us-east-1` | |
| `EVENT_BUS_NAME` | `''` | Audit target; empty skips emission with a warning |
| `STACK_NAME` | `''` | Audit event source qualifier |
| `ARCHIVE_BUCKET_PREFIX` | `''` | Refuse any bucket outside this prefix; empty disables |
| `SOLUTION_VERSION` | `unknown` | Reported by `/dicomweb/health` |
| `LOG_LEVEL` | `INFO` | |
| `PORT` | `8080` | |
| `CORS_ALLOWED_ORIGINS` | `''` | Comma-separated; empty leaves CORS off |
| `QIDO_CACHE_TTL` | `30` | Seconds |
| `QIDO_CACHE_MAX` | `1024` | Entries |
| `QIDO_DEFAULT_LIMIT` | `1000` | Applied when the client sends no `limit=` |
| `QIDO_MAX_LIMIT` | `1000` | Ceiling on a client-supplied `limit=` |
| `WSI_TABLES_CACHE_TTL` | `3600` | Seconds |
| `WSI_TABLES_CACHE_MAX` | `256` | Entries |
| `WORKER_THREADS` | `32` | Parallel frame reads |
| `RENDER_MAX_DIM` | `4096` | Cap on a rendered image with no `viewport=` |
| `DATASTORE_CACHE_TTL_SECONDS` | `300` | How long an *unresolvable* datastore id is remembered. Successful resolutions are never cached |
| `DATASTORE_CACHE_MAX` | `512` | Unresolvable ids held at once |
| `AVAILABILITY_RETRY_AFTER_NEARLINE` | `300` | Seconds |
| `AVAILABILITY_RETRY_AFTER_OFFLINE` | `3600` | Seconds |
| `AUDIT_WORKERS` | `4` | Audit emitter threads |
| `AUDIT_QUEUE_MAX` | `256` | |

`DB_USER` and `DB_PASSWORD` are **never** read from the environment. Credentials come
only from `DB_SECRET_ARN` via the task role, so they are never visible in a task
definition, a `docker inspect`, or a CloudFormation template.

CORS is off unless an operator names explicit origins. In the supported topology one
CloudFront distribution fronts both the SPA and this service, so the browser makes no
cross-origin request; `*` on a PHI data plane is never acceptable.

## Auditing

Every data-plane request emits exactly one EventBridge audit event, including the
ones that serve no bytes — "the client asked for an instance that is not there" is
what an access review needs to see. Streaming handlers emit from a `finally` inside
the generator, so a client that disconnects mid-study is still audited with the bytes
it actually received.

Audit payloads carry filter *keys*, never filter *values*, and `request.path`, never
`request.full_path`. A QIDO query string contains patient names, accession numbers
and birth dates; the audit bus is not a PHI store. The same reason is why
`_execute_query` logs the SQL text and a parameter count but not the parameters.

`/dicomweb/health` is auth-exempt and never audited.

## Local run

```bash
cd interface-container/dicomweb-s3
python3 -m venv venv && . venv/bin/activate
pip install -r requirements.txt

export DB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:my-db-xxxx
export DB_NAME=dicomweb
export USER_POOL_ID=us-east-1_xxxxxxxxx
export USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
export AWS_REGION=us-east-1
export LOG_LEVEL=DEBUG
python main.py
```

Needs AWS credentials that can read the secret and the archive buckets, plus network
reach to Aurora — so in practice a bastion or a VPN into the deployment's VPC. To
skip token verification against a real user pool:

```bash
export OIDC_ENABLED=false
export ALLOW_UNAUTHENTICATED_ACCESS=true
```

Never set either in a deployed environment. `ALLOW_UNAUTHENTICATED_ACCESS=true`
removes the datastore authorization check, which is the only thing separating
tenants.

## Tests

```bash
cd interface-container/dicomweb-s3
pip install -r requirements.txt -r requirements-test.txt
python3 -m pytest tests/ -q
```

No MySQL, no AWS and no network: `tests/conftest.py` installs the `pymysql` and
`boto3` stubs before any service module is imported. Install both requirements files
into the same venv — a `pydicom` from the system site-packages is a different major
version than the pinned one, and the writer's output differs enough to pass tests
that would fail in the image.

Smoke test:

```bash
curl -s localhost:8080/dicomweb/health
curl -s -H "Authorization: Bearer $TOKEN" \
  "localhost:8080/dicomweb/$DATASTORE_ID/studies?limit=5" | python3 -m json.tool
```

## Module layout

| File | Role |
|---|---|
| `main.py` | Routes, QIDO pipeline, WADO read paths, bootstrap |
| `sql_queries.py` | WADO SQL constants — all datastore-scoped |
| `db_mappings.py` | DICOM tag to index column maps (the only source of SQL identifiers) |
| `qido_search_tags.py` | Filter allowlists per level + qualified-column overrides |
| `availability.py` | `(0008,0056)` guard and the 503 responses |
| `render.py` | Pure image pipeline for WADO-RS Rendered (no S3, no DB) |
| `auth_middleware.py` | `before_request` hook: token to authorized `RequestIdentity` |
| `oidc_verifier.py` | Cognito JWT/JWKS verification |
| `privilege_checker.py` | Datastore read / store / storage-location privilege checks |
| `datastore_resolver.py` | Datastore row lookup; caches unresolvable ids only, so a datastore flipped to `DELETING` stops serving on the next request |
| `mysqlConnectionFactory.py` | Aurora pool; credentials from Secrets Manager only |
| `audit_events.py` | EventBridge audit emission |
| `dicom_service_token.py` | Per-interface token minting/verification for the protocol services |
| `writable_destination.py` | Write-path gate: STOW-RS/DELETE allowed only for a writable `access_level` |
| `vf_deid.py` | On-the-fly virtual-folder de-identification at WADO `/metadata` (mirrors the indexer) |
| `pixel_codecs.py` | Transfer-syntax capabilities + frame decoding (JPEG 2000/HTJ2K via pylibjpeg) |
