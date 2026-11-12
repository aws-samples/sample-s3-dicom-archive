# Processing-job plugins

Status: in development on `feat/processing-job-plugins`.

## Goal

Let an operator add a new processing job to the archive without changing the
CDK app or redeploying: build a container image that follows a small contract,
push it to an in-account ECR repository, register it through the API (or the
Plugins page), and run it on any selection of series or studies from the UI.

The two built-in jobs (DICOM to NIfTI, Virtual Folder export) each needed a
dedicated nested stack, IAM role, expander lambda and DB seed. Plugins replace
that per-job plumbing with one shared runner.

## Concepts

| Term | Meaning |
|---|---|
| Plugin | A registered container image plus its manifest. Row in `processing_jobs` with `type = 'PLUGIN'`. |
| Manifest | JSON describing parameters, input granularity, resources and outputs. Validated at registration. |
| Run | One execution of a plugin over a target. Child row in `processing_jobs` (`parent_job_id` = plugin). |
| Step | One unit of work inside a run: one series (or one study). Row in `processing_job_steps`. Maps to one Batch array child. |

## Container contract

The container never receives database credentials or archive-bucket IAM
permissions. The platform resolves the selection, checks the caller's grants,
and hands the container only what it needs, through S3.

Environment variables set on every task:

| Variable | Value |
|---|---|
| `PLUGIN_RUN_ID` | Run id |
| `PLUGIN_IO_BUCKET` | Bucket holding inputs and outputs |
| `PLUGIN_RUN_PREFIX` | `runs/<runId>/` |
| `AWS_BATCH_JOB_ARRAY_INDEX` | Step index (0-based). Set by Batch for array jobs; `0` is assumed when absent. |
| `PLUGIN_PARAMS` | JSON object of the run parameters, already validated against the manifest |

For step `N` the container:

1. Reads `s3://$PLUGIN_IO_BUCKET/$PLUGIN_RUN_PREFIX/steps/N/input.json`.
2. Downloads the instances from the presigned URLs listed in it.
3. Writes any outputs under `s3://$PLUGIN_IO_BUCKET/$PLUGIN_RUN_PREFIX/steps/N/output/`.
4. Writes `s3://$PLUGIN_IO_BUCKET/$PLUGIN_RUN_PREFIX/steps/N/result.json` last.
5. Exits 0 on success, non-zero on failure.

`input.json`:

```json
{
  "runId": "…", "step": 0, "granularity": "series",
  "datastoreId": "…", "studyInstanceUid": "…", "seriesInstanceUid": "…",
  "modality": "CT", "seriesDescription": "…",
  "instances": [
    { "sopInstanceUid": "…", "instanceNumber": 1, "url": "https://…presigned…", "range": null }
  ],
  "expiresAt": "2026-10-04T05:00:00Z"
}
```

`range` is set when the instance is a member inside a larger object
(`{ "start": 1024, "length": 39208 }`); the container sends an HTTP `Range`
header.

`result.json`:

```json
{
  "status": "SUCCEEDED",
  "summary": "Rendered 1 thumbnail",
  "outputs": [ { "key": "output/thumb.png", "contentType": "image/png", "label": "Middle-slice thumbnail" } ],
  "metrics": { "instancesRead": 34 }
}
```

`status` is `SUCCEEDED`, `FAILED` or `SKIPPED`. If the task exits without a
`result.json`, the platform records the step as `FAILED` with the Batch status
reason.

## Manifest

```json
{
  "name": "DICOM thumbnail",
  "description": "Render a PNG of the middle slice of each series",
  "image": "<account>.dkr.ecr.<region>.amazonaws.com/<prefix>-plugin-thumbnail:1.0.0",
  "granularity": "series",
  "resources": { "vcpu": 1, "memoryMiB": 2048, "timeoutMinutes": 30 },
  "parameters": [
    { "name": "size", "type": "integer", "label": "Width in pixels", "default": 256, "min": 32, "max": 2048 },
    { "name": "window", "type": "enum", "label": "Window", "options": ["auto", "lung", "bone", "brain"], "default": "auto" }
  ],
  "maxSteps": 500
}
```

Validation rules:

* `image` must point at an ECR repository in this account and region whose
  name starts with `<stackPrefix>-plugin-`. Images from any other registry are
  refused, so a plugin cannot pull arbitrary code from the internet.
* `granularity` is `series` or `study`.
* `resources` must be valid Fargate combinations, with `timeoutMinutes` between 1 and 720.
* Parameter types: `string`, `integer`, `number`, `boolean`, `enum`. Names
  match `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`.
* `maxSteps` from 1 to 5000 (default 500).

## Architecture

```
UI ── POST /processing-jobs/plugins ──► plugin-registry (lambda)
          validate manifest, RegisterJobDefinition (shared job role), insert processing_jobs PLUGIN row

UI ── POST /processing-jobs/{id}/execute ──► processing-jobs-api
          F10 grant check, run row, async invoke plugin-runner

plugin-runner (lambda, in VPC)
          expand target -> steps (series or study), re-check grants against the persisted scope,
          write steps/N/input.json with presigned URLs, insert processing_job_steps,
          SubmitJob (array) on PluginJobQueue

AWS Batch (Fargate) ──► plugin container ──► S3 plugin-io bucket

EventBridge "Batch Job State Change" (PluginJobQueue, SUCCEEDED|FAILED)
          ──► plugin-recorder (lambda): read result.json per child, update steps, roll up the run
```

IAM:

* `PluginJobRole` (ecs-tasks): `s3:GetObject` on `runs/*/steps/*/input.json`
  and `s3:PutObject` on `runs/*/steps/*/output/*` and `runs/*/steps/*/result.json`
  in the plugin-io bucket. Nothing else.
* Plugin execution role (ecs-tasks): ECR pull limited to `<prefix>-plugin-*` repositories, plus CloudWatch Logs.
* Module role (lambda): the registry, runner and recorder share one role
  (Batch register/submit/describe on the plugin queue and job definitions,
  `iam:PassRole` for the two plugin roles only, S3 on the plugin-io bucket,
  read of the archive buckets for presigning, DB secret).

## UI

* A **Plugins** tab in Processing Jobs lists registered plugins and lets an
  operator register one from a manifest (with live validation), enable or
  disable it, and delete it.
* Running a plugin reuses the existing job modal: the parameter form is
  generated from the manifest, and the target is chosen the same way as for the
  built-in jobs.
* The run view lists steps with status and summary, and each output links to a
  short-lived download URL.

## Reference plugin

`plugins/builtin/dicom-to-nifti/` is the plugin to copy when writing your own:
a Debian image with the tool it wraps (dcm2niix), the shared SDK, and one
Python entry point (`nifti.py`). The stack builds it and registers it on
deploy, so a fresh deployment has a working plugin to run.

## Writing a plugin

### 1. Write the container

Python plugins can copy `plugins/sdk/plugin_sdk.py` into
the image. It loads the step input, downloads instances (honouring byte
ranges), uploads outputs and always writes `result.json`, including on a crash:

```python
from plugin_sdk import Step

def main():
    with Step() as step:
        if not step.instances:
            step.skip('Series has no readable instances')
            return
        paths = step.download_all()                 # local .dcm files
        report = analyse(paths, step.params)        # your code
        step.put_output('report.json', report.encode(), 'application/json', label='Report')
        step.metric('instances', len(paths))
        step.succeed('Analysed %d instances' % len(paths))

if __name__ == '__main__':
    main()
```

Any language works: the contract is only S3 objects and environment variables.
Outputs whose `contentType` starts with `image/` are shown inline in the run
view.

### 2. Push the image to ECR

The repository name must start with `<stackPrefix>-plugin-`:

```bash
PREFIX=<stackPrefix>; ACCOUNT=$(aws sts get-caller-identity --query Account --output text); REGION=us-east-1
aws ecr create-repository --repository-name $PREFIX-plugin-myplugin --image-scanning-configuration scanOnPush=true
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker build --platform linux/amd64 -t $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$PREFIX-plugin-myplugin:1.0.0 .
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$PREFIX-plugin-myplugin:1.0.0
```

Set `architecture` in the manifest to match the image (`X86_64` or `ARM64`).

### 3. Register it

In the admin UI: **Processing Jobs → Plugins → Register plugin**, paste the
manifest; problems are listed as you type. Or through the API:

```bash
curl -X POST "$API/processing-jobs/plugins" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"manifest\": $(cat manifest.json)}"
```

Registering needs the `processingJobs.canCreate` management privilege;
deleting needs `canDelete`. Editing the manifest registers a new job-definition
revision; runs already submitted keep the revision they started with.

### 4. Run it

Select studies or series on the **DICOM Studies** screen (or run an Analytics
query) and choose **Run Processing Job**. The plugin's parameters are rendered
from its manifest. Progress, per-step summaries and outputs appear under
**Processing Jobs → Job Executions**.

### Troubleshooting

| Symptom | Cause |
|---|---|
| Step FAILED: "Container exited 0 without writing result.json" | The container must write `result.json` last. |
| Step FAILED: "CannotPullContainerError" | Image not in a `<prefix>-plugin-*` repository, wrong tag, or architecture mismatch. |
| Run FAILED: "Nothing to process" | Every selected item was skipped: outside your datastore read grants, datastore not ACTIVE, or series not ONLINE. |
| 403 downloading an instance | The presigned URL expired: it lives for the plugin timeout plus two hours. Keep `timeoutMinutes` realistic. |

Container logs are in CloudWatch under `/aws/batch/<prefix>-plugins`, stream
prefix `plugin-<pluginId>`.

## GPU plugins

Set `resources.gpu` (1-4) in the manifest. The plugin then runs on
`<prefix>-plugin-gpu-queue`, an EC2 compute environment of g4dn, g5 and g6
instances on the `ECS_AL2023_NVIDIA` AMI, instead of Fargate.

- The environment scales from 0 vCPU: nothing runs, and nothing is billed,
  until a GPU step is queued. Batch stops idle instances. The cap is 32 vCPU.
- The image must be `X86_64`. The Batch GPU AMI has no arm64 build.
- `vcpu` is an integer from 1 to 32 and `memoryMiB` 1024 to 122880. The
  Fargate pairing table does not apply. Leave a few GiB for the ECS agent:
  a g4dn.xlarge has 16 GiB, so ask for at most about 14000 MiB to fit on it.
- The NVIDIA runtime mounts the driver and `nvidia-smi` into the container.
  `plugins/gpu-smoke/` is a minimal check (`build.sh <prefix>` builds and
  pushes it without emulation on an arm64 host).

## Writing DICOM back to the archive

A plugin that sets `producesDicom: true` gets a "Write DICOM outputs back to
the archive" choice on its run form (`writeBack`: `no` | `source` |
`datastore`). `source` stores each step's DICOM in that step's own source
datastore. `datastore` stores every step's DICOM in one destination datastore,
picked in the form (`writeBackDatastoreId`). Either way:

1. The caller needs store permission on the datastore written to. For
   `source`, explicit selections are checked when the run is submitted, and
   Analytics (SQL) selections by the runner, which skips steps on datastores
   without it. For `datastore`, the destination must exist, be ACTIVE and be
   writable by the caller; it is checked at submit and again when the run
   starts, and the run fails if it no longer qualifies. Each pipeline stage can
   have its own destination.
2. The plugin writes Part 10 files as outputs (`step.put_dicom(name, bytes)`,
   or any output with content type `application/dicom` or a `.dcm` name). It
   must mint new UIDs (`pydicom.uid.generate_uid()`).
3. When the step completes, the recorder checks each file: the `DICM`
   preamble, a valid MediaStorageSOPInstanceUID, not one of the step's input
   SOP Instance UIDs, and not duplicated within the step. It then copies
   accepted files to `plugin-derived/<runId>/<step>/` in the write-back
   datastore's bucket. The normal ingest pipeline indexes them like any other upload.
4. The step output records `writeBack: { stored, rejected[] }`, and the run
   detail shows it.

The pipeline check under "Verification of GPU, write-back, pipelines and NIfTI"
below is the worked example: a thumbnail stage writes one Secondary Capture per
series back into the source study.

## Pipelines (chaining plugins)

The execute request accepts up to four more stages:

```json
{ "params": {...}, "target": {...},
  "chain": [ { "pluginId": "<id>", "params": {...}, "writeBack": "no" } ] }
```

The run modal builds this through "Add a pipeline stage". Rules:

- Every stage must exist, be enabled, and use the same granularity as the
  first. Its params are validated when the pipeline is submitted.
- Each stage is a normal run row of its own plugin, named `<plugin> - stage n/N`.
  Its `config.pipeline` holds `{ rootRunId, stage, totalStages, upstreamRunId, next }`.
- When a stage finishes with at least one COMPLETED step, the recorder creates
  the next run on target `{ mode: 'upstream', runId }`. A conditional update
  claims the launch, so duplicate Batch events start it only once. A stage
  with no completed step stops the pipeline and records why in
  `config.pipeline.error`.
- The next stage runs on the series (or studies) the previous stage
  completed. Each step's `input.json` carries `upstream: { runId, step,
  summary, outputs[] }`, with presigned URLs for the previous stage's outputs
  for the same series. In the SDK: `step.upstream`, `step.download_upstream(suffix)`.
- Every stage runs with the caller's authorization snapshot from submit time.

## Bundled plugins

| Slug | What it does |
|---|---|
| `dicom-to-nifti` | dcm2niix conversion: `.nii.gz`, BIDS sidecar (anonymized, full or none), bval/bvec. It replaced the standalone NIfTI job and stack, and runs without database access or archive IAM. |

It is built by CDK with build context `plugins/`, so it shares
`plugins/sdk/plugin_sdk.py`, and is upserted by slug at deploy. NIfTI outputs are plugin outputs, so they expire
with the I/O bucket after 30 days; copy them elsewhere if you need them longer.
The old NIfTI stack's bucket is retained on stack deletion, so files written
before the switch are still there.

## Security model

* Plugin code never receives database credentials, the archive bucket names,
  or any IAM permission on archive data. It sees exactly the instances listed
  in its step input, through presigned URLs that expire.
* What a run may read is decided by the caller's datastore read grants at
  submit time, persisted on the run, and re-checked by the runner for every
  resolved series (including Analytics-query selections).
* Images come only from `<prefix>-plugin-*` repositories in this account, so
  which code can run is controlled by who can push to those repositories.
* Tasks run in private subnets without a public IP.

## Verified on a test deployment (2026-10-04)

The thumbnail rows in both tables below used the sample `dicom-thumbnail`
plugin, which was removed afterwards.

| Check | Result |
|---|---|
| Sample plugin seeded at deploy (upsert by slug) | registered, enabled |
| Run over 2 series (CT, MR), after the recorder reconcile fix | COMPLETED 2/2 in about 60 s, twice in a row; both outputs are valid PNGs |
| Parameter out of range (`size: 5`) | 400 |
| Parameter not in enum | 400 |
| Run of a disabled plugin | 409; re-enable OK |
| `/plugins/validate` on a bad manifest | lists each error |
| Image outside `<prefix>-plugin-*` ECR repos | 400 |
| Unit tests (`test/standalone/plugins/plugins.test.js`) | 10/10 |
| Admin UI (headless Chromium) | Plugins table, enable toggle, run detail with inline thumbnails, register dialog with live validation |

Known issue fixed during verification: Batch emits the array parent's SUCCEEDED event before
some child events, so the recorder marked runs PARTIAL. The recorder now reads each child's
real status with `batch:DescribeJobs` when the parent finishes.

### Verification of GPU, write-back, pipelines and NIfTI (2026-10-04)

| Check | Result |
|---|---|
| Thumbnail regression (2 series) | COMPLETED 2/2 in 80 s, valid PNGs |
| NIfTI plugin (CT, MR) | COMPLETED 2/2 in 60 s; NIfTI-1 header valid (`sizeof_hdr` 348, `n+1`), BIDS sidecar present |
| Pipeline NIfTI -> thumbnail with Secondary Capture + write-back | stage 1 COMPLETED; recorder launched stage 2; stage 2 steps saw `_1.nii.gz` upstream; 1 SC stored per step, 0 rejected; each source study went from 1 to 2 series in QIDO (CT+OT, MR+OT) |
| GPU smoke plugin (`resources.gpu: 1`) | COMPLETED in 160 s from a cold queue; `nvidia-smi`: Tesla T4, 15360 MiB, driver 580.178.04 |
| Write-back on a plugin without producesDicom | 400 |
| Chain with an unknown plugin / more than 4 stages | 404 / 400 |
| GPU manifest with ARM64 | invalid ("must use architecture X86_64") |
| Earlier negatives (bounds, enum, disabled, public image) | 6/6 |
| Unit tests | 17/17 |
