# In-VPC-Only (Private-Network) Deployment — Design Investigation

**Status:** IMPLEMENTED. This document began as the design feasibility study and is kept
as the design record; the in-VPC posture now ships. The final design differs from the
pre-implementation sketch below in two ways worth noting up front:
- **Config surface:** the posture is selected by the `networkMode` struct in `config.json`
  (`{"mode": "vpc", "dnsName": ..., "certArn": ..., "existingVpcId": ...}`), **not** the
  flat `inVpcOnly` / `internalUi*` keys this study proposed. When `certArn` is omitted the
  stack mints a **self-signed** certificate for `dnsName` automatically (test-grade).
- **Front door:** a **single** internal ALB does path-based routing — `/dicomweb/*` is
  forwarded directly to the DICOMweb-s3 Fargate service by an ALB listener rule (nginx is
  off that data path), and everything else goes to the nginx SPA front door. There is no
  separate second DICOMweb ALB.

**For the authoritative, current configuration and step-by-step deploy, see
[installation.md](installation.md) (the `networkMode` section).** The remainder of this
document is the original feasibility study and its reasoning; treat its flat-key examples
and "Current → Target / Phase" framing as historical.

The feasibility study of what it would take to deploy the solution so it is reachable
**only** from inside a private network (customer VPC, VPC peering, Direct Connect, or
VPN), with no public internet ingress and minimal/no public egress, follows.

**Audience:** security-conscious operators who will run this solution strictly inside
their own private network.

**Scope of the study:** read-only. No repository files were changed and no `cdk deploy`
/ `cdk destroy` was run to produce it. Citations are `path:line` against branch
`s3-only-port` as read on 2026-10-18; line numbers will drift as the code evolves.

---

## Executive summary / verdict

An in-VPC-only posture is **mostly achievable** with moderate CDK work, with **one hard
architectural blocker** (CloudFront) and **one qualified item** (Cognito, which turned out
to be easier than expected):

- **HARD BLOCKER — CloudFront.** One shared CloudFront distribution fronts every
  browser-facing surface (admin UI, data-user UI, OHIF, SLIM, VolView) and the
  `/dicomweb/*` data plane. CloudFront is an inherently public global edge; there is no
  "private CloudFront". A private-only posture must *replace* its viewer-facing role with
  an internal ALB serving the SPA bundles from S3. This is a real re-architecture, not a flag.
- **DOABLE — API Gateway.** Convert the REST API to a PRIVATE endpoint + interface endpoint
  + resource policy. Consumers are few and already in-VPC or build-time.
- **DOABLE — DIMSE NLB.** Flip `internetFacing: true` → `false` and move to private subnets.
  Breaks only external C-STORE/C-FIND reachability, which is the goal.
- **QUALIFIED — Cognito (easier than feared).** The SPAs authenticate with the Amplify
  **SRP (username/password)** flow directly against the regional `cognito-idp` API — there is
  **no hosted UI**. `cognito-idp` has a VPC interface endpoint, so interactive login can work
  fully in-VPC. (SES — Cognito's email path — also has an endpoint in us-east-2, so it is not a
  residual.)
- **Egress.** ~15 AWS services called by in-VPC Lambdas/containers have no interface endpoint
  yet; to drop NAT you add them (all verified present in us-east-2). **IAM** is a global service
  reached via the region-less `com.amazonaws.iam` endpoint in us-east-1 (cross-region wiring);
  SES, CodeBuild, CodePipeline have us-east-2 endpoints. No unavoidable egress residual remains.

**Recommended switch surface:** a single `config.json` `"inVpcOnly": true` flag, threaded
through `bin/cdk-infrastructure.ts` → `MainStack`, following the existing
`devAuthMode` / viewer-flag precedent.

### Prioritized summary

| Surface | Current state | In-VPC target | Effort | Blocker? |
|---|---|---|---|---|
| CloudFront (UI + viewers + `/dicomweb/*`) | Public global edge, 1 distribution, 6+ behaviors (`cdk-infrastructure/lib/main/ui-hosting-stack.ts:134`, `cdk-infrastructure/lib/main/main-stack.ts:509`) | Internal ALB serving SPA from S3 + internal DICOMweb ALB; CloudFront removed | High (re-arch) | **HARD** |
| API Gateway | DEFAULT (regional/public) RestApi, CORS=ALL_ORIGINS (`cdk-infrastructure/lib/main/api-stack.ts:57`, `:65`) | PRIVATE endpoint + interface endpoint + resource policy | Medium | No |
| DIMSE NLB | `internetFacing: true`, PUBLIC subnets (`cdk-infrastructure/lib/dicom-service/dicom-service-stack.ts:101`, `:104`) | `internetFacing: false`, PRIVATE subnets | Low | No (by design) |
| Cognito auth (SPA login) | Amplify SRP vs regional `cognito-idp`, no hosted UI (`website/src/services/amplifyAuthService.ts:30-45`) | Add `cognito-idp` + `cognito-identity` interface endpoints | Low | No |
| Cognito OHIF OAuth callback | Code-flow callback → CloudFront domain, no UserPoolDomain (`cdk-infrastructure/lib/ohif/lambda/update-cognito-callbacks/index.js:26-37`) | Repoint callback to internal host | Low–Med | Qualified |
| Egress / VPC endpoints | 5 interface + 1 gateway endpoint present; ~15 called services missing (`cdk-infrastructure/lib/main/network-stack.ts:44-73`) | Add missing interface endpoints; `natGateways: 0` | Medium | No |
| Config switch | No in-VPC flag; flags parsed in `bin` (`cdk-infrastructure/bin/cdk-infrastructure.ts`) | Add `inVpcOnly` flag threaded to nested stacks | Low (plumbing) | No |

---

## Q1 — API Gateway → PRIVATE API, and every consumer of the execute-api URL

### Current state
- `cdk-infrastructure/lib/main/api-stack.ts:57` — `new apigateway.RestApi(this, 'Api', {...})`
  with **no `endpointConfiguration`**, so it defaults to the public regional endpoint.
- `api-stack.ts:65-69` — `defaultCorsPreflightOptions.allowOrigins = apigateway.Cors.ALL_ORIGINS`.
- `api-stack.ts:85` — the URL is hand-built:
  `this.apiUrl = https://${this.api.restApiId}.execute-api.${region}.amazonaws.com/v1/api`.

### What must change
1. Set `endpointConfiguration: { types: [EndpointType.PRIVATE], vpcEndpoints: [executeApiEndpoint] }`.
2. Add a `com.amazonaws.<region>.execute-api` interface endpoint in `network-stack.ts` with
   `privateDnsEnabled: true`, so the standard `*.execute-api.<region>.amazonaws.com` name
   resolves to the endpoint inside the VPC.
3. Attach a **resource policy** restricting `aws:sourceVpce` to that endpoint (a PRIVATE API
   with no resource policy denies all).
4. Tighten CORS at `api-stack.ts:65` from `ALL_ORIGINS` to the internal UI origin(s).

With private DNS enabled, the hand-built `apiUrl` keeps working unchanged for any in-VPC
caller.

### Consumers of the execute-api URL
In-VPC / server-side (resolve the private endpoint automatically once private DNS is on):
- **DIMSE container** — `main-stack.ts:938-939` → `dicom-service-stack.ts:20`, `:365`
  (`CONFIGURATION_API_ENDPOINT`). IAM grant at `dicom-service-stack.ts:326`.
- **Interoperability lambdas** — `interoperability-stack.ts:127-128` (`execute-api:Invoke`).
- **Auth authenticated role** — `auth-stack.ts:212-213` (IAM grant only).
- **API resource tracker** — `api-stack.ts:88-100` (DB write, not an HTTP call to execute-api).

Browser / build-time (the ones to watch):
- **Admin SPA** — API base baked into `config.js` at build time: `cicd/ci-cd-construct.ts:87-88`
  (`REACT_APP_API_BASE_URL`), emitted at `:186`, `:192`; read as
  `window.REACT_APP_CONFIG.API_BASE_URL` (`website/src/components/NonDicomImport.tsx:14-15,32`).
  Works for an in-VPC browser via private DNS — no code change — provided the browser's DNS is
  the VPC resolver (Route 53 inbound resolver for on-prem clients).
- **Data-user SPA** — `data-user-ui-stack.ts:16,38,71,96` (`CONFIG_API_URL`). Same as above.
- **CICD / outputs** — `cicd-stack.ts:19,49`, `ci-cd-construct.ts:19,48`, `main-stack.ts:914,918`
  (build-time); CfnOutputs at `main-stack.ts:985`, `:991`.

### Options
- **(A) PRIVATE API + private DNS, keep the execute-api hostname** — least churn; in-VPC
  browsers resolve the baked-in URL privately. On-prem clients need a Route 53 Resolver inbound
  endpoint.
- **(B) PRIVATE API behind the internal UI ALB at `/api/*`** — pairs with the CloudFront
  replacement (Q2); the SPA calls same-origin `/api`, eliminating CORS. More ALB routing.

**Verdict: DOABLE (Medium).** No blocker.

---

## Q2 — CloudFront: inherently public edge — what replaces it

### Current state — every CloudFront usage and what it fronts
- **One shared distribution** at `ui-hosting-stack.ts:134`; default behavior serves the SPA
  bundles for admin/, data-user/, ohif/, slim/, volview/ from S3 via Origin Access Control
  (SPA-routing CF Function allowlist `ui-hosting-stack.ts:66`).
- **`/dicomweb/*` behavior** at `main-stack.ts:509` via
  `origins.VpcOrigin.withApplicationLoadBalancer(dicomWebServiceStack.alb, ...)` — CloudFront
  reaches the **internal** DICOMweb ALB over the AWS private network; `CACHING_DISABLED` so PHI
  never caches at the edge (`main-stack.ts:524`).
- Distribution handed to every viewer stack as `sharedDistribution`
  (`data-user-ui-stack.ts:28`, `ohif-viewer-stack.ts:39`, `slim-viewer-stack.ts:34`,
  `volview-viewer-stack.ts:22`).
- The CF domain is the app base URL: `main-stack.ts:438`
  `baseUrl = https://${distribution.distributionDomainName}`, reused for viewer launch URLs
  (`main-stack.ts:615-617`), the DICOMweb endpoint (`main-stack.ts:790`), and the Cognito
  admin-invite email URL.
- Edge already hardened: TLS1.2 floor (`ui-hosting-stack.ts:150`), security-headers policy
  (`ui-hosting-stack.ts:117-139`); WAF intentionally OFF (`ui-hosting-stack.ts:155-161`).

### Why this is the hard part
CloudFront is a global, public, anycast edge by definition. OAC protects the *origin* (S3),
not the *viewer* side — the distribution domain is still internet-resolvable. A true
in-VPC-only posture cannot make CloudFront private; it must replace CloudFront's viewer role.

### Options
- **(a) Internal ALB serving the SPA from S3 via a VPC origin — NOT possible.** VPC origins are
  a CloudFront→ALB feature; they don't run in reverse, and S3 is not an ALB target. Rejected.
- **(b) Internal ALB + a small in-VPC static tier (RECOMMENDED).** Internal ALB
  (`internetFacing:false`, private subnets) in front of a small Fargate/nginx (or S3-proxy
  Lambda) that serves the SPA objects from the existing UI bucket over the S3 gateway endpoint.
  Re-implement the SPA-routing logic from the CloudFront Function (`ui-hosting-stack.ts:52-110`)
  as ALB path rules / nginx `try_files`. Route `/dicomweb/*` on the **same** internal ALB
  directly to the DICOMweb service (the VPC-origin indirection collapses into a normal target
  group). Tradeoff: lose edge caching/compression and the managed security-headers + TLS policy
  — re-add headers at the ALB/nginx and terminate TLS with ACM-on-internal or a private CA.
- **(c) Keep CloudFront, restrict with WAF/geo/IP** (`ui-hosting-stack.ts:155-158` already
  anticipates a `webAclId`). **Does not meet "no public ingress"** — the endpoint stays public
  and internet-resolvable. Acceptable only as a weaker "restricted public" posture.

**Verdict: HARD BLOCKER for strict in-VPC-only.** (a) is impossible as framed; (c) cannot
satisfy "no public ingress"; (b) is the real path and a genuine re-architecture of
`ui-hosting-stack.ts` + viewer wiring + `baseUrl` derivation, and requires private TLS + a
private DNS name to replace `distributionDomainName` (which ripples into the Cognito invite URL
and all viewer launch URLs).

---

## Q3 — DIMSE NLB `internetFacing: true` → internal

### Current state
- `dicom-service-stack.ts:101` — `new elbv2.NetworkLoadBalancer(this, 'DicomNLB', { vpc,
  internetFacing: true, crossZoneEnabled: true, vpcSubnets: { subnetType: PUBLIC },
  securityGroups: [nlbSecurityGroup] })`.
- Listeners: cleartext DICOM on 11112 (`:131`), TLS passthrough on 2762 (`:153`). The SG is
  created with no synth-time ingress; the locations API adds per-user source-CIDR ingress at
  runtime (`:86-97`).

### What must change
- `internetFacing: false` and `vpcSubnets: { subnetType: PRIVATE_ISOLATED }` (or
  `PRIVATE_WITH_EGRESS`) at `:101-105`. Listeners/target groups/SG logic unchanged.

### What breaks (intentionally)
- External C-STORE/C-FIND traffic from the public internet stops. Clients (PACS, modalities,
  routers) must reach the NLB over VPC-internal, peered, Direct Connect, or VPN paths.
- The runtime per-user CIDR allowlist (`:86-97`) now admits private/on-prem CIDRs.
- The installer download references `window.location.origin`
  (`website/src/components/Locations.tsx:858,870`), which becomes the internal host from Q2 —
  stays self-consistent.

**Verdict: DOABLE (Low).** A one-line posture flip that intentionally breaks public ingress.

---

## Q4 — Cognito: can auth work fully in-VPC?

### Current state — corrects a common assumption
- The admin + data-user SPAs use the **Amplify SRP (username/password) flow**, **not** the
  hosted UI: `website/src/services/amplifyAuthService.ts:30-45` configures `Auth.Cognito`
  with pool/client/identity-pool IDs and **deliberately omits the `oauth` block** (comment at
  `:38-39`). Sign-in is `signIn({ username, password })` (`amplifyAuthService.ts:92`,
  `LoginModal.tsx:48-49`) — the SRP API against `cognito-idp.<region>.amazonaws.com`.
- Pool client: `userPassword: true` + `userSrp: true`, `generateSecret: false`
  (`auth-stack.ts:166-174`). **No `cognito.UserPoolDomain` is provisioned anywhere.**
- The only OAuth/code-flow usage: the OHIF `update-cognito-callbacks` custom resource sets
  `AllowedOAuthFlows: ['code']` and `CallbackURLs: [https://${distributionDomain}/viewer/callback]`
  (`ohif/lambda/update-cognito-callbacks/index.js:26-37`). With no UserPoolDomain, this
  configures the client for code flow but provisions no hosted login page.

### Can it work in-VPC?
- **Yes for the primary login path.** `cognito-idp` and `cognito-identity` (Identity-Pool
  credential vending, `auth-stack.ts:180-205`) both have VPC interface endpoints. Add them
  (missing today — Q5) with `privateDnsEnabled: true` and the browser's SRP calls resolve
  privately. No hosted UI means no public redirect dependency.
- **Qualified part:** the OHIF OAuth callback (`update-cognito-callbacks:29-30`) is pinned to
  the CloudFront domain; under Q2 that domain goes away, so repoint it to the internal host.

### Options
- **(A) Keep Cognito, add `cognito-idp` + `cognito-identity` interface endpoints (RECOMMENDED).**
  Login works fully in-VPC with existing code. Repoint the OHIF callback. SES (Cognito email)
  has a `com.amazonaws.us-east-2.email` endpoint, so it can stay in-VPC too — no residual here.
- **(B) Replace Cognito with a private OIDC IdP (e.g. in-VPC Keycloak).** Large auth rewrite
  touching the API authorizer and every SPA. Only if policy forbids any AWS auth endpoint.
- **(C) Accept the Cognito API as a privately-reached AWS service** — effectively (A).

**Verdict: DOABLE / QUALIFIED (Low).** Not a hard blocker, because there is no hosted UI.
Hard requirements: add the two Cognito interface endpoints and repoint the OHIF callback.

---

## Q5 — Egress: the missing VPC interface endpoints the workload actually calls

### Already present (`network-stack.ts`)
- Gateway: **S3** (`:44`).
- Interface: **ECR** (`:49`), **ECR_DOCKER** (`:54`), **CLOUDWATCH_LOGS** (`:59`),
  **SECRETS_MANAGER** (`:64`), **STS** (`:69`).
- Lambdas run in `PRIVATE_WITH_EGRESS`; everything not covered by an endpoint egresses via the
  single NAT gateway (`network-stack.ts:19`, `natGateways: 1`).

### First-party SDK clients (grep of `@aws-sdk/client-*` over `cdk-infrastructure/lib` +
`interface-container`, node_modules excluded), mapped to the endpoint to add

| SDK client | Representative first-party caller | Plane | Endpoint to add |
|---|---|---|---|
| `client-sqs` | `virtual-folder-assignment-api`, `DataManagement/api-handlers/*`, `config/get-config` | runtime | **SQS** |
| `client-s3` | many | runtime | S3 gateway ✓ |
| `client-lambda` | `processing-jobs/*`, `config/get-config`, `ohif-update-lambda-env` | runtime (invoke) | **LAMBDA** |
| `client-secrets-manager` | many | runtime | ✓ |
| `client-bedrock-runtime` | `analytics/nl-agent.js`, `text-to-sql.js` (in-VPC, `analytics-stack.ts:88-89`) | runtime | **BEDROCK_RUNTIME** |
| `client-sfn` | `processing-jobs/*`, `virtual-folder-api`, `datastore-api` | runtime | **STEP_FUNCTIONS** (`states`) |
| `client-sns` | `config/get-config`, `interface-servers-cleanup` | runtime | **SNS** |
| `client-eventbridge` | `DataManagement/queue-consumer.js`, `datastore/update-status`, shared layer helpers | runtime | **EVENTBRIDGE** (`events`) |
| `client-cognito-identity-provider` | `auth/set-admin-password`, `users-api`, `update-cognito-callbacks` | runtime | **cognito-idp** (Q4) |
| `client-cognito-identity` | same | runtime | **cognito-identity** (Q4) |
| `client-ssm` | `datastore/import-datastore` | runtime | **SSM** |
| `client-ecs` | `dicom-service/ecr-push-redeploy`, `locations-api` | runtime/deploy | **ECS** |
| `client-cloudwatch` | `dashboard/system-monitor-api` | runtime | **CLOUDWATCH_MONITORING** |
| `client-application-auto-scaling` | `locations-api` | runtime | **APPLICATION_AUTOSCALING** |
| `client-ec2` | `locations-api` (SG ingress mgmt) | runtime | **EC2** |
| `client-batch` | `processing-jobs/plugin-*` | runtime | **BATCH** (raw service name `com.amazonaws.<region>.batch` if no CDK enum) |
| `client-codebuild` | viewer/image build triggers | deploy-time | **CODEBUILD** (build-time; can stay on NAT) |
| `client-codepipeline` | `cicd/trigger-pipeline` | deploy-time | **CODEPIPELINE** (build-time) |
| `client-iam` | `ohif-update-lambda-env`, `certificate-generator`, `import-datastore` | runtime | **IAM — global-service endpoint.** No regional `com.amazonaws.us-east-2.iam`, but a global **`com.amazonaws.iam`** endpoint exists in **us-east-1** (verified 2026-10-18; note the region-less name = global-service signature, like CloudFront/Route53 control-plane APIs). Reachable via a us-east-1 endpoint / centralized-endpoint pattern; not a NAT residual. |
| `client-rds-data` | legacy Data API path | runtime | **RDS_DATA** (most DB access migrated to the RDS **Proxy** in-VPC) |

Plus for Q1: **execute-api**.

`client-sso` / `client-sso-oidc` / most `client-sts` hits are transitive credential-provider
deps, not app calls.

### Exact interface endpoints to ADD to `network-stack.ts`
SQS, SNS, EVENTBRIDGE (`events`), STEP_FUNCTIONS (`states`), LAMBDA, SSM, ECS,
CLOUDWATCH_MONITORING, APPLICATION_AUTOSCALING, EC2, BEDROCK_RUNTIME, cognito-idp,
cognito-identity, execute-api, Batch, RDS_DATA (if retained), KMS, and **SES** (`email` — for
Cognito invite/reset mail). All verified present in us-east-2 on 2026-10-18 via
`describe-vpc-endpoint-services`.

**IAM** is covered too, but specially: it is a **global service**, so there is no
`com.amazonaws.us-east-2.iam` — instead a region-less **`com.amazonaws.iam`** endpoint lives in
**us-east-1** (verified). Reach it via a us-east-1 interface endpoint and the appropriate
cross-region/centralized-endpoint + private-DNS setup (same model as other global control-plane
APIs). The three IAM-calling lambdas (`ohif-update-lambda-env`, `certificate-generator`,
`import-datastore`) then need no NAT.

### Residuals
With the global IAM endpoint in place, there is **no unavoidable egress residual** for the
runtime data plane in a us-east-2 deployment. SES, CodeBuild, and CodePipeline all have
us-east-2 endpoints (verified). The only operational caveat is the cross-region hop for the
global IAM endpoint, which must be wired deliberately.

**Verdict: DOABLE (Medium).** `natGateways: 0` is reachable for the runtime data plane with the
verified endpoints above, including IAM via the us-east-1 global `com.amazonaws.iam` endpoint.
Endpoint availability and global-vs-regional naming are region-specific — re-verify with
`describe-vpc-endpoint-services` (and check for region-less `com.amazonaws.<svc>` names for
global services) in any other region.

**Cross-region verification (2026-10-18).** The regional endpoint set above was confirmed
identical in **us-east-2, eu-west-1, and us-west-2** (all of sqs, sns, events, states, lambda,
ssm, ecs, monitoring, application-autoscaling, ec2, bedrock-runtime, cognito-idp,
cognito-identity, execute-api, batch, rds-data, kms, email present in each). **IAM has no
regional endpoint in any of the three** — it is always the global `com.amazonaws.iam` endpoint
(us-east-1). So the plan's endpoint set is portable across these regions, with the single
constant caveat that IAM is reached via the us-east-1 global endpoint regardless of deployment
region.

---

## Q6 — The config/CDK switch that gates "inVpcOnly"

### Current switch surface
- `config.json` is parsed in `bin/cdk-infrastructure.ts` and flags map to `MainStack` props
  (e.g. `ohifViewer`, `slimViewer`, `volviewFeature`, `dicomWebService`, `devAuthMode`).
  `MainStack` gates each nested stack (`main-stack.ts:472` `dicomWebServiceEnabled`, viewer
  `if (props.ohifViewer)` blocks). Per-deploy `--context` overrides already exist.

### Sketch (design only)
1. **`config.json`**: add `"inVpcOnly": true` (or `--context inVpcOnly=true`).
2. **`bin/cdk-infrastructure.ts`**: read it, pass `inVpcOnly: config.inVpcOnly === true` into
   `MainStack`; add a validation guard (mirror of the `devAuthMode` guard) to forbid
   incompatible combos.
3. **Stacks it toggles when true:**
   - `network-stack.ts` — `natGateways: 0` + the full Q5 endpoint set (incl. `execute-api`,
     `cognito-idp`, `cognito-identity`).
   - `api-stack.ts:57` — PRIVATE endpoint + execute-api endpoint + `aws:sourceVpce` resource
     policy; tighten CORS at `:65`.
   - `dicom-service-stack.ts:101-105` — `internetFacing: false`, private subnets.
   - `ui-hosting-stack.ts:134` + `main-stack.ts:438,509` — skip CloudFront, provision the
     internal ALB static-serve path (Q2 option b); recompute `baseUrl` from the internal ALB
     DNS / private hostname. **This is the heavy toggle.**
   - `ohif/update-cognito-callbacks` + viewer launch URLs (`main-stack.ts:615-617,790`) —
     repoint from the CF domain to the internal host.

**Verdict: DOABLE (Low plumbing, gated by Q2 effort).** The flag is cheap; what it switches on
(the CloudFront replacement) is where the real work lives.

---

## Suggested phasing

1. **Phase 1 (low-risk, high-value):** DIMSE NLB → internal (Q3); add the missing VPC interface
   endpoints (Q5) while keeping `natGateways: 1`; add `cognito-idp`/`cognito-identity` endpoints
   (Q4). These harden egress and private the DICOM plane with no UI re-architecture.
2. **Phase 2:** API Gateway → PRIVATE + resource policy (Q1). Validate in-VPC browser DNS
   resolution and on-prem Route 53 Resolver.
3. **Phase 3 (the re-architecture):** replace CloudFront with the internal ALB static tier (Q2),
   recompute `baseUrl`, repoint the OHIF callback and viewer launch URLs, add private TLS.
4. **Phase 4:** gate all of the above behind the `inVpcOnly` flag (Q6); optionally
   `natGateways: 0` is achievable with no unavoidable residual — IAM via the us-east-1 global
   `com.amazonaws.iam` endpoint, everything else via us-east-2 endpoints.

## Open items requiring live validation (not covered by this static study)
- ENI/AZ count and monthly cost of the added interface endpoints.
- Whether any third-party viewer bundle (OHIF/SLIM/VolView) makes a hardcoded public call at
  runtime beyond the AWS SDK surface.
- Route 53 Resolver inbound-endpoint sizing for on-prem DNS resolution of the private names.
- A full `cdk synth`/`deploy` of the `inVpcOnly` path once implemented.
