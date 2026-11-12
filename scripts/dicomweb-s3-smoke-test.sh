#!/usr/bin/env bash
set -euo pipefail

# Live smoke test for the DICOMweb service backed by S3 storage.
#
# Walks one instance end to end - S3 upload, QIDO visibility, WADO metadata and
# frame retrieve, delete, disappearance - then checks the three things the
# reference smoke test could not check because it predates authentication:
# that /health is reachable without a token, that a data-plane route is not,
# and that a token cannot reach a datastore it is not privileged for.
#
# Usage:
#   TOKEN=<jwt> scripts/dicomweb-s3-smoke-test.sh <datastore-id> [path-to-test.dcm]
#
# Environment:
#   TOKEN                 (required) bearer token for the caller.
#   STACK                 parent CloudFormation stack; defaults to stackPrefix
#                         from cdk-infrastructure/config.json.
#   DICOMWEB_BASE_URL     skip the CloudFormation lookup and use this instead.
#   INGEST_BUCKET         bucket the ingest pipeline watches. Without it the
#                         write/delete round trip is skipped and only the
#                         read-side assertions run.
#   INGEST_PREFIX         key prefix inside INGEST_BUCKET (default: smoke/).
#   DLQ_URL               ingest dead-letter queue; depth is reported, never fatal.
#   FOREIGN_DATASTORE_ID  a datastore this token is NOT privileged for. Required
#                         for the 403 assertion; skipped with a warning if unset.
#   AWS_DEFAULT_REGION    defaults to us-east-1.
#
# Output carries UIDs and counts only - no patient identifiers.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
INGEST_PREFIX="${INGEST_PREFIX:-smoke/}"

PASS=0; FAIL=0; SKIP=0

pass() { printf "  OK    %s\n" "$1"; PASS=$((PASS + 1)); }
fail() { printf "  FAIL  %s\n" "$1"; FAIL=$((FAIL + 1)); }
skip() { printf "  SKIP  %s\n" "$1"; SKIP=$((SKIP + 1)); }
die()  { printf "ERROR: %s\n" "$1" >&2; exit 2; }

# ── Inputs ───────────────────────────────────────────────────────────────────
DATASTORE_ID="${1:-}"
TEST_DCM="${2:-}"

[[ -n "$DATASTORE_ID" ]] || die "usage: TOKEN=<jwt> $0 <datastore-id> [path-to-test.dcm]"

# No unauthenticated fallback: a run without a token would pass every data-plane
# assertion as a 401 and report a healthy service.
[[ -n "${TOKEN:-}" ]] || die "TOKEN is not set; every data-plane route requires a bearer token"

# The stack name is the config stackPrefix with dashes stripped, matching
# bin/cdk-infrastructure.ts.
default_stack() {
  python3 - "$REPO_ROOT/cdk-infrastructure/config.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["stackPrefix"].replace("-", ""))
PY
}
STACK="${STACK:-$(default_stack)}"

if [[ -z "${DICOMWEB_BASE_URL:-}" ]]; then
  # The nested service stack's own outputs are invisible to describe-stacks on
  # the parent, so this reads the parent-level output.
  DICOMWEB_BASE_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='DicomWebS3BaseUrl'].OutputValue" \
    --output text)
fi
[[ -n "$DICOMWEB_BASE_URL" && "$DICOMWEB_BASE_URL" != "None" ]] \
  || die "could not resolve DicomWebS3BaseUrl from stack $STACK; set DICOMWEB_BASE_URL"

BASE="${DICOMWEB_BASE_URL}/${DATASTORE_ID}"

echo "Stack:     $STACK"
echo "Base:      $DICOMWEB_BASE_URL"
echo "Datastore: $DATASTORE_ID"
echo ""

# ── Helpers ──────────────────────────────────────────────────────────────────
# Authenticated status probe. Every data-plane call goes through here so no call
# site can forget the header.
# 000 stands for "no answer at all", so an unreachable endpoint is reported as a
# failed assertion instead of a bare `set -e` exit with no summary.
status_of() {
  curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${TOKEN}" "$1" || echo "000"
}

assert_code() {
  local label="$1" want="$2" url="$3" code
  code=$(status_of "$url")
  if [[ "$code" == "$want" ]]; then pass "$label ($code)"; else
    fail "$label got $code, want $want"
  fi
}

get_json() {
  curl -s -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/dicom+json" "$1"
}

# Length of a JSON array on stdin, 0 for anything that is not one.
json_len() {
  python3 -c 'import sys, json
try:
    d = json.load(sys.stdin)
    print(len(d) if isinstance(d, list) else 0)
except Exception:
    print(0)'
}

first_value() {
  # first_value <dicom-json-tag> - reads DICOM JSON from stdin.
  python3 -c 'import sys, json
d = json.load(sys.stdin)
print(d[0][sys.argv[1]]["Value"][0])' "$1"
}

# ── 1. Auth boundary ─────────────────────────────────────────────────────────
echo "-- Auth boundary --------------------------------------------"

HEALTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "${DICOMWEB_BASE_URL}/health" || echo "000")
if [[ "$HEALTH_CODE" == "200" ]]; then
  pass "health without a token (200)"
else
  # 503 means the container is up but cannot reach the database; either way the
  # probe answered, so distinguish it from an unreachable endpoint.
  fail "health without a token got $HEALTH_CODE, want 200"
fi

UNAUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/studies" || echo "000")
if [[ "$UNAUTH_CODE" == "401" ]]; then
  pass "data-plane route without Authorization (401)"
else
  fail "data-plane route without Authorization got $UNAUTH_CODE, want 401"
fi

if [[ -n "${FOREIGN_DATASTORE_ID:-}" ]]; then
  assert_code "datastore this token is not privileged for" 403 \
    "${DICOMWEB_BASE_URL}/${FOREIGN_DATASTORE_ID}/studies"
else
  skip "cross-datastore 403 (set FOREIGN_DATASTORE_ID to a datastore this token cannot read)"
fi

# ── 2. Ingest ────────────────────────────────────────────────────────────────
echo "-- Ingest and retrieve --------------------------------------"

UPLOADED=""
if [[ -n "${INGEST_BUCKET:-}" && -n "$TEST_DCM" ]]; then
  [[ -f "$TEST_DCM" ]] || die "no such file: $TEST_DCM"
  UPLOADED="s3://${INGEST_BUCKET}/${INGEST_PREFIX}smoke.dcm"
  aws s3 cp "$TEST_DCM" "$UPLOADED" --region "$REGION" >/dev/null
  echo "  uploaded 1 object to ${INGEST_PREFIX}"

  # 60 s: the reference's budget, and the ingest Lambda's own visibility target.
  elapsed=0
  until [[ "$(get_json "${BASE}/studies" | json_len)" -gt 0 ]]; do
    sleep 5; elapsed=$((elapsed + 5))
    if [[ $elapsed -ge 60 ]]; then break; fi
  done
  if [[ "$(get_json "${BASE}/studies" | json_len)" -gt 0 ]]; then
    pass "study visible in QIDO within ${elapsed}s"
  else
    fail "study not visible in QIDO within 60s"
  fi
else
  skip "ingest round trip (set INGEST_BUCKET and pass a .dcm path)"
fi

# ── 3. QIDO walk ─────────────────────────────────────────────────────────────
STUDIES=$(get_json "${BASE}/studies")
STUDY_COUNT=$(printf '%s' "$STUDIES" | json_len)
if [[ "$STUDY_COUNT" -eq 0 ]]; then
  fail "no studies in datastore; nothing to retrieve"
  echo ""
  echo "Passed: $PASS  Failed: $FAIL  Skipped: $SKIP"
  exit 1
fi
pass "QIDO studies returned $STUDY_COUNT result(s)"

STUDY=$(printf '%s' "$STUDIES" | first_value 0020000D) \
  || die "QIDO studies response carries no StudyInstanceUID"
echo "  StudyInstanceUID:  $STUDY"

assert_code "QIDO series" 200 "${BASE}/studies/${STUDY}/series"
SERIES=$(get_json "${BASE}/studies/${STUDY}/series" | first_value 0020000E) \
  || die "QIDO series response carries no SeriesInstanceUID"
echo "  SeriesInstanceUID: $SERIES"

assert_code "QIDO instances" 200 "${BASE}/studies/${STUDY}/series/${SERIES}/instances"
SOP=$(get_json "${BASE}/studies/${STUDY}/series/${SERIES}/instances" \
  | first_value 00080018) || die "QIDO instances response carries no SOPInstanceUID"
echo "  SOPInstanceUID:    $SOP"

INST="${BASE}/studies/${STUDY}/series/${SERIES}/instances/${SOP}"

# ── 4. WADO-RS ───────────────────────────────────────────────────────────────
assert_code "WADO instance metadata"  200 "${INST}/metadata"
assert_code "WADO instance retrieve"  200 "${INST}"
assert_code "WADO frame 1"            200 "${INST}/frames/1"
assert_code "WADO series metadata"    200 "${BASE}/studies/${STUDY}/series/${SERIES}/metadata"
assert_code "unknown SOP UID is 404"  404 \
  "${BASE}/studies/${STUDY}/series/${SERIES}/instances/9.9.9.9.9/frames/1"

# ── 5. Delete and disappearance ──────────────────────────────────────────────
if [[ -n "$UPLOADED" ]]; then
  echo "-- Delete ---------------------------------------------------"
  aws s3 rm "$UPLOADED" --region "$REGION" >/dev/null

  elapsed=0
  while [[ "$(get_json "${BASE}/studies" | json_len)" -gt 0 ]]; do
    sleep 5; elapsed=$((elapsed + 5))
    if [[ $elapsed -ge 60 ]]; then break; fi
  done
  if [[ "$(get_json "${BASE}/studies" | json_len)" -eq 0 ]]; then
    pass "study removed from QIDO within ${elapsed}s"
  else
    fail "study still in QIDO 60s after delete"
  fi
fi

# ── 6. Dead-letter queue: informational ──────────────────────────────────────
if [[ -n "${DLQ_URL:-}" ]]; then
  DLQ_DEPTH=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
    --attribute-names ApproximateNumberOfMessages --region "$REGION" \
    --query 'Attributes.ApproximateNumberOfMessages' --output text)
  # Warn-only by design: the queue may hold messages from an unrelated run, and
  # that is not a reason to fail a smoke test.
  if [[ "$DLQ_DEPTH" == "0" ]]; then
    echo "  DLQ depth 0"
  else
    echo "  WARN: DLQ depth $DLQ_DEPTH"
  fi
else
  skip "DLQ depth (set DLQ_URL)"
fi

echo ""
echo "Passed: $PASS  Failed: $FAIL  Skipped: $SKIP"
[[ "$FAIL" -eq 0 ]] || { echo "SMOKE TEST FAILED"; exit 1; }
echo "Smoke test passed."
