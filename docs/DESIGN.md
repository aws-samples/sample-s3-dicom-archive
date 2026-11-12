# DICOM Archive — Architecture

> Canonical architecture reference. Every diagram is authored as Mermaid **in this
> file** and also rendered to a PNG in `docs/diagrams/`, so the diagrams stay in
> version control and regenerate deterministically (see
> [§9 Regenerating the diagrams](#9-regenerating-the-diagrams)).
> Last verified against the code: 2026-10-17.

## Contents

1. [Overview](#1-overview)
2. [System architecture](#2-system-architecture)
3. [Stack composition](#3-stack-composition)
4. [Network topology](#4-network-topology)
5. [Data model](#5-data-model)
6. [Authentication & authorization](#6-authentication--authorization)
7. [Ingest pipeline](#7-ingest-pipeline)
8. [Serving: DICOMweb, DIMSE, HL7, viewers](#8-serving-dicomweb-dimse-hl7-viewers)
9. [Regenerating the diagrams](#9-regenerating-the-diagrams)

---

## 1. Overview

The DICOM Archive is a serverless medical-imaging platform on AWS. It ingests
imaging data over multiple protocols, indexes it in a relational database, keeps
pixel data in per-datastore object storage, and serves it back through standard
DICOMweb and several in-browser viewers. Every access is scoped to a single
*datastore* (the tenancy boundary) and enforced by a token-based authorizer.

**Design principles**

| Principle | How it shows up |
|---|---|
| Serverless-first | Lambda for APIs and ingest; Fargate only for the long-lived protocol listeners (DIMSE, HL7, DICOMweb). |
| Metadata and pixels separated | The database holds the searchable index; pixels never leave their datastore's S3 bucket — reads are ranged GETs. |
| Tenancy by datastore | The authorizer resolves one `datastore_id` from the caller's token; that id — never a path segment — is what reaches SQL. |
| Feature-flagged composition | One root stack nests 25 stacks; optional subsystems switch on/off via `cdk-infrastructure/config.json`. |
| Least privilege at the edges | Private-isolated subnets for data, TLS to the database via RDS Proxy, per-interface tokens for the protocol services. |

**Primary building blocks**

| Layer | Components |
|---|---|
| Edge & identity | CloudFront, Cognito (User Pool + MFA), API Gateway + Lambda authorizer |
| Protocol services (Fargate) | DIMSE (C-STORE/FIND/MOVE/GET), DICOMweb-S3 (QIDO/WADO/STOW), HL7 (MLLP) |
| Serverless compute | API Lambdas, the ingest pipeline, Step Functions datastore workflow |
| Data & storage | Aurora MySQL 8.4.8 via RDS Proxy, per-datastore S3 buckets, Secrets Manager |
| Viewers | OHIF, SLIM, VolView (static web apps on S3 behind CloudFront) |

---

## 2. System architecture

End-to-end: browsers reach the API and static viewers through CloudFront; DICOM
and HL7 clients reach the Fargate listeners directly over TLS; all three write
paths converge on the same ingest pipeline, which indexes into Aurora and stores
pixels in the datastore bucket.

![System architecture](diagrams/system-architecture.png)

```mermaid
graph TB
    classDef edge fill:#E3F2FD,stroke:#1565C0,color:#0D47A1;
    classDef svc fill:#FFF3E0,stroke:#EF6C00,color:#E65100;
    classDef compute fill:#F3E5F5,stroke:#8E24AA,color:#4A148C;
    classDef data fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20;

    admin["Clinician / Admin<br/>(browser)"]
    dicom["DICOM client<br/>C-STORE / C-FIND / C-MOVE / C-GET"]
    hl7src["HIS / RIS<br/>(HL7 v2 over MLLP)"]

    cf["CloudFront"]:::edge
    cognito["Cognito<br/>User Pool + MFA"]:::edge
    apigw["API Gateway<br/>REST + Lambda authorizer"]:::edge

    dimse["DIMSE service<br/>(Fargate, NLB TLS)"]:::svc
    dweb["DICOMweb-S3<br/>(Fargate) QIDO/WADO/STOW"]:::svc
    hl7["HL7 service<br/>(Fargate, MLLP)"]:::svc

    apil["API Lambdas"]:::compute
    ingest["Ingest pipeline<br/>(SQS + Lambda)"]:::compute
    sfn["Step Functions<br/>datastore workflow"]:::compute

    aurora["Aurora MySQL 8.4.8<br/>(RDS Proxy, TLS)"]:::data
    s3["S3 datastore buckets"]:::data
    secrets["Secrets Manager"]:::data
    viewers["Viewers on S3<br/>OHIF · SLIM · VolView"]:::edge

    admin --> cf
    cf --> apigw
    cf --> viewers
    apigw --> cognito
    apigw --> apil
    dicom --> dimse
    hl7src --> hl7
    viewers --> dweb

    dimse --> ingest
    dweb --> ingest
    apil --> aurora
    ingest --> aurora
    ingest --> s3
    dweb --> aurora
    dweb --> s3
    hl7 --> aurora
    apil --> secrets
    sfn --> aurora
```

---

## 3. Stack composition

The platform deploys as one root `MainStack` that nests 25 stacks. The
**Foundation** tier is always deployed; the **Feature-flagged** tier is switched
per `config.json`. The diagram reads bottom-up: everything composes into the root.

![Stack composition](diagrams/stack-map.png)

```mermaid
block-beta
  columns 1

  block:optional["Feature-flagged (config.json)"]:1
    columns 2
    dicomsvc["DicomServiceStack — enableDicomService"]
    dwebsvc["DicomWebServiceStack — dicomWebService"]
    vf["VirtualFolderStack — virtualFolderFeature"]
    analytics["AnalyticsStack — analyticsFeature"]
    export["ExportStack — exportFeature"]
    ohifs["OhifViewerStack"]
    slims["SlimViewerStack"]
    volviews["VolviewViewerStack"]
    interop["InteroperabilityStack (HL7)"]
    importp["ImportPipelineStack"]
    importc["ImportCleanupPipelineStack"]
    procjobs["ProcessingJobsStack"]
    dsflow["DatastoreWorkflowStack"]
    datauser["DataUserUiStack"]
    dash["DashboardStack"]
    space
  end

  block:foundation["Foundation (always deployed)"]:1
    columns 2
    net["NetworkStack (VPC)"]
    db["DatabaseStack — Aurora MySQL 8.4.8 + RDS Proxy"]
    auth["AuthStack — Cognito + authorizer"]
    api["ApiStack (REST)"]
    audit["AuditStack"]
    config["ConfigServiceStack"]
    sysmgmt["SystemManagementStack"]
    datamgmt["DataManagementStack"]
    uihost["UiHostingStack"]
    cicd["CicdStack"]
  end

  main["MainStack (root)"]

  optional --> main
  foundation --> main

  style main fill:#E3F2FD,stroke:#1565C0
```

**Selected flags** (`cdk-infrastructure/config.json`)

| Flag | Enables |
|---|---|
| `enableDicomService` | DIMSE Fargate listener (C-STORE/FIND/MOVE/GET) |
| `dicomWebService` / `s3StorageFeature` | DICOMweb-S3 Fargate service (QIDO/WADO/STOW) |
| `virtualFolderFeature` | Virtual folders + de-identified per-folder databases |
| `analyticsFeature` | Analytics API (direct-SQL over the index) |
| `ohifViewer` / `slimViewer` / `volviewFeature` | The respective in-browser viewers |
| `exportFeature` | Study/series export |

---

## 4. Network topology

The VPC has three subnet tiers. Data (Aurora, RDS Proxy) sits in **private-isolated**
subnets with no internet route. Fargate tasks and Lambdas that need outbound access
run in **private-with-egress** subnets through a single NAT gateway. Gateway/interface
VPC endpoints (S3, ECR, …) keep most traffic off the NAT. Only the load balancers
live in **public** subnets.

![Network topology](diagrams/network.png)

```mermaid
graph TB
    classDef pub fill:#FFEBEE,stroke:#C62828,color:#B71C1C;
    classDef egress fill:#FFF8E1,stroke:#F9A825,color:#F57F17;
    classDef iso fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20;

    internet(["Internet"])

    subgraph vpc["VPC"]
        subgraph public["Public subnets"]
            nlb["NLB (DIMSE/HL7 TLS)"]:::pub
            alb["ALB (internal apps)"]:::pub
            nat["NAT gateway"]:::pub
        end
        subgraph egresssn["Private-with-egress subnets"]
            fargate["Fargate tasks<br/>DIMSE · DICOMweb · HL7"]:::egress
            lambdas["Lambdas (VPC-attached)"]:::egress
        end
        subgraph isolated["Private-isolated subnets"]
            proxy["RDS Proxy"]:::iso
            aurora["Aurora MySQL 8.4.8"]:::iso
        end
        vpce["VPC endpoints<br/>S3 (gateway) · ECR (interface)"]
    end

    internet --> nlb
    internet --> alb
    fargate --> proxy --> aurora
    lambdas --> proxy
    fargate --> vpce
    lambdas --> vpce
    fargate --> nat --> internet
```

---

## 5. Data model

Indexing follows the DICOM information hierarchy — **patient → study → series →
instance** — with each instance pointing at its object in S3 via `storage_index`
and its DICOM header in `Instancemetadata`. Soft deletes cascade down the chain
(`deleted_at`), and per-study/per-datastore rollups (`study_stats`,
`datastore_statistics`) keep counts cheap without re-scanning.

![Data model](diagrams/data-model.png)

```mermaid
erDiagram
    PATIENT ||--o{ STUDY : has
    STUDY ||--o{ SERIES : has
    SERIES ||--o{ INSTANCE : has
    INSTANCE ||--|| STORAGE_INDEX : "located by"
    INSTANCE ||--o| INSTANCEMETADATA : "header"
    STUDY ||--o| STUDY_STATS : "rolled up"

    PATIENT {
      bigint patient_pkey PK
      string datastore_id
      string patient_id
    }
    STUDY {
      bigint study_pkey PK
      string studyinstanceuid
      datetime deleted_at
    }
    SERIES {
      bigint series_pkey PK
      string seriesinstanceuid
    }
    INSTANCE {
      bigint content_pkey PK
      string sopinstanceuid
      string datastore_id
    }
    STORAGE_INDEX {
      string s3_key
      bigint byte_offset
    }
    STUDY_STATS {
      bigint study_pkey PK
      int instance_count
      bigint total_size_bytes
    }
```

Virtual folders get their **own** database (`vf_` + the folder UUID, validated
against `^vf_[0-9a-f]{32}$`) so a de-identified view can carry rewritten metadata
without touching the source datastore's tables.

---

## 6. Authentication & authorization

Cognito issues a JWT (with MFA); API Gateway's Lambda authorizer resolves the
caller's privileges and injects a scoped context. The **tenancy rule** is absolute:
the only `datastore_id` that reaches SQL is the one the authorizer validated against
`datastore_privileges` — the path segment is treated as untrusted input.

![Auth flow](diagrams/auth-flow.png)

```mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant C as Cognito
    participant G as API Gateway
    participant A as Lambda authorizer
    participant L as API Lambda
    participant D as Aurora (RDS Proxy)

    U->>C: Sign in (+ MFA)
    C-->>U: JWT (id / access token)
    Note over C: cognito-pre-token enriches claims.<br/>cognito-post-auth records login
    U->>G: Request + Bearer token
    G->>A: Authorize
    A->>D: Resolve datastore_privileges for sub
    A-->>G: Allow/Deny + scoped context (datastore_id)
    G->>L: Invoke with authorizer context
    L->>D: Query scoped to the authorized datastore_id
    D-->>L: Rows
    L-->>U: Response
```

The DIMSE and DICOMweb services apply the same rule with **per-interface tokens**
(`dicom_service_token.py`): each protocol interface carries its own credential, and
writes are refused unless the target datastore's `access_level` is writable.

---

## 7. Ingest pipeline

All three write paths (DIMSE C-STORE, DICOMweb STOW, browser/bucket import) land an
object in the datastore bucket; an S3 event drives the ingest Lambda, which parses
the header, writes the index rows, and updates the incremental stats rollup. Object
removal soft-deletes the matching rows.

![Ingest pipeline](diagrams/ingest-flow.png)

```mermaid
graph LR
    classDef src fill:#FFF3E0,stroke:#EF6C00,color:#E65100;
    classDef proc fill:#F3E5F5,stroke:#8E24AA,color:#4A148C;
    classDef data fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20;

    cstore["DIMSE C-STORE"]:::src
    stow["DICOMweb STOW-RS"]:::src
    upload["Browser upload /<br/>bucket import"]:::src

    s3["S3 datastore bucket"]:::data
    evt["S3 ObjectCreated →<br/>EventBridge / SQS"]:::proc
    v3["Ingest<br/>(lambda/ingest)"]:::proc
    idx["Index rows<br/>patient/study/series/instance"]:::data
    stats["Stats rollup<br/>study_stats → datastore_statistics"]:::data
    aurora["Aurora MySQL"]:::data

    cstore --> s3
    stow --> s3
    upload --> s3
    s3 --> evt --> v3
    v3 --> idx --> aurora
    v3 --> stats --> aurora
    v3 -.->|soft-delete on ObjectRemoved| aurora
```

> All S3-event ingest is one code base in `lib/import/lambda/ingest/`:
> `handler.py` (SQS entry), `engine.py` (per-object indexing) and `aggregate.py`
> (series/study recompute). Statistics use an incremental three-tier rollup rather
> than a full re-scan of the index.

Pathology (SVS/BIF) imported through the Non-DICOM Import (V2) UI does not go
through the encapsulator: the V2 encapsulator copies the slide into the datastore
bucket and writes a `{slide}.json` sidecar (`{filepath, DICOM:{…}}`), then the
same `s3-ingest`/`path_ingest` whole-slide virtualization runs — so a slide
imported via the UI and one copied straight into a bucket share one ingest path.

---

## 8. Serving: DICOMweb, DIMSE, HL7, viewers

**DICOMweb-S3** is the browser-facing read/write service. Reads (QIDO search, WADO
retrieve, download) are the common path and stream ranged GETs straight from the
datastore bucket — pixels are never copied into the service. Writes (STOW store,
DELETE) are gated on a writable `access_level`.

![DICOMweb read & write paths](diagrams/dicomweb-paths.png)

```mermaid
graph TB
    classDef read fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20;
    classDef write fill:#FFEBEE,stroke:#C62828,color:#B71C1C;

    client["Browser / viewer"]
    mw["auth_middleware<br/>token → identity, tenancy check"]

    qido["QIDO-RS (search)"]:::read
    wado["WADO-RS (ranged GET)"]:::read
    dl["Download (privilege-gated)"]:::read
    stow["STOW-RS (store)"]:::write
    del["DELETE study/series/instance"]:::write

    gate{"access_level<br/>writable?"}

    client --> mw
    mw --> qido
    mw --> wado
    mw --> dl
    mw --> stow
    mw --> del
    stow --> gate
    del --> gate
    gate -->|yes| ingestlambda["invoke ingest lambda<br/>(synchronous index)"]
    gate -->|no / read-only storage| refuse["refuse (defense in depth)"]
```

**DIMSE service** (Fargate behind a TLS NLB) implements C-STORE, C-FIND, C-MOVE
and C-GET. C-MOVE and C-GET share a single `RETRIEVE` privilege and reuse the same
WADO-RS retrieval internally. Routing rules decide which datastore bucket an
association's objects land in.

**HL7 service** (Fargate, MLLP) receives HL7 v2 messages one connection at a time,
validates them, synchronises patient demographics into the index, and stores the
raw message.

**Viewers** (OHIF, SLIM, VolView) are static web apps on S3 served through
CloudFront; each talks to DICOMweb-S3 for pixels and metadata using the signed-in
user's token.

**Virtual folders & de-identification** — assigning content to a virtual folder
runs it through the de-id consumer, which writes rewritten metadata into that
folder's own `vf_<hex>` database; viewers then read the folder through the same
DICOMweb service.

![Virtual folder de-identification](diagrams/vf-deid.png)

```mermaid
graph LR
    classDef proc fill:#F3E5F5,stroke:#8E24AA,color:#4A148C;
    classDef data fill:#E8F5E9,stroke:#2E7D32,color:#1B5E20;

    assign["Assign content to<br/>virtual folder"]:::proc
    q["vf-assign-consumer /<br/>vf-deid-consumer (SQS)"]:::proc
    vfdb["Per-VF database<br/>vf_&lt;32hex&gt;"]:::data
    deid["On-the-fly de-id<br/>metadata rewrite"]:::proc
    view["Viewers read VF<br/>via DICOMweb-S3"]

    assign --> q --> vfdb
    q --> deid --> vfdb
    vfdb --> view
```

---

## 9. Regenerating the diagrams

Each diagram is a Mermaid fenced block in this file, mirrored by a `.mmd` source in
`docs/diagrams/`. To re-render the PNGs after editing:

```bash
# one-time: npm install @mermaid-js/mermaid-cli
# puppeteer.json: {"args":["--no-sandbox","--disable-setuid-sandbox"]}
for name in system-architecture stack-map network data-model auth-flow \
            ingest-flow dicomweb-paths vf-deid; do
  mmdc -p puppeteer.json -i docs/diagrams/$name.mmd -o docs/diagrams/$name.png -b white -w 1100
done
```

A Word export (`DESIGN.docx`) can be produced from this file with `python-docx`; it
is a generated artifact (gitignored), not a source of truth.
