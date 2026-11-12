#!/usr/bin/env bash
set -euo pipefail

# Live smoke test for the WADO-RS Rendered API (/rendered) on the S3-backed
# DICOMweb service.
#
# Discovers a renderable instance from QIDO, then exercises every rendering
# parameter and error path, asserting HTTP status, content type, and - when
# Pillow is available - that the returned bytes actually decode as an image.
# A 200 whose body is not a decodable image is the failure this catches that a
# status-only check cannot.
#
# Usage:
#   TOKEN=<jwt> scripts/dicomweb-s3-rendered-smoke-test.sh <datastore-id>
#   TOKEN=<jwt> scripts/dicomweb-s3-rendered-smoke-test.sh <datastore-id> \
#       <StudyUID> <SeriesUID> <InstanceUID>
#
# Environment:
#   TOKEN                 (required) bearer token for the caller.
#   STACK                 parent CloudFormation stack; defaults to stackPrefix
#                         from cdk-infrastructure/config.json.
#   DICOMWEB_BASE_URL     skip the CloudFormation lookup and use this instead.
#   OFFLINE_SOP_UID       an instance in this datastore whose Instance
#                         Availability (0008,0056) is OFFLINE or NEARLINE, used
#                         for the 503 assertion. Skipped with a warning if unset.
#   OFFLINE_STUDY_UID     study of OFFLINE_SOP_UID (defaults to the discovered
#                         study).
#   OFFLINE_SERIES_UID    series of OFFLINE_SOP_UID (defaults to the discovered
#                         series).
#   AWS_DEFAULT_REGION    defaults to us-east-1.
#
# Output carries UIDs and counts only - no patient identifiers.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

die() { printf "ERROR: %s\n" "$1" >&2; exit 2; }

DATASTORE_ID="${1:-}"
[[ -n "$DATASTORE_ID" ]] || die "usage: TOKEN=<jwt> $0 <datastore-id> [study series instance]"

# No unauthenticated fallback: without a token every case below would return 401
# and the error-path assertions would look like passes.
[[ -n "${TOKEN:-}" ]] || die "TOKEN is not set; /rendered requires a bearer token"

default_stack() {
  python3 - "$REPO_ROOT/cdk-infrastructure/config.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["stackPrefix"].replace("-", ""))
PY
}
STACK="${STACK:-$(default_stack)}"

if [[ -z "${DICOMWEB_BASE_URL:-}" ]]; then
  # Parent-level output: the nested service stack's own outputs are not visible
  # to describe-stacks on the parent.
  DICOMWEB_BASE_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='DicomWebS3BaseUrl'].OutputValue" \
    --output text)
fi
[[ -n "$DICOMWEB_BASE_URL" && "$DICOMWEB_BASE_URL" != "None" ]] \
  || die "could not resolve DicomWebS3BaseUrl from stack $STACK; set DICOMWEB_BASE_URL"

BASE="${DICOMWEB_BASE_URL}/${DATASTORE_ID}"
echo "Base:      $DICOMWEB_BASE_URL"
echo "Datastore: $DATASTORE_ID"

PASS=0; FAIL=0; SKIP=0
tmp=$(mktemp)
hdr=$(mktemp)
trap 'rm -f "$tmp" "$hdr"' EXIT

# assert_render <label> <expected_code> <url> [accept]
assert_render() {
  local label="$1" want="$2" url="$3" accept="${4:-}"
  local args=(-s -o "$tmp" -w '%{http_code} %{content_type}\n'
              -H "Authorization: Bearer ${TOKEN}")
  [[ -n "$accept" ]] && args+=(-H "Accept: $accept")
  # `|| true` guards `read`'s nonzero EOF return from tripping `set -e`.
  local code ctype
  read -r code ctype < <(curl "${args[@]}" "$url") || true
  if [[ "$code" != "$want" ]]; then
    printf "  FAIL %-38s got %s (want %s)\n" "$label" "$code" "$want"; FAIL=$((FAIL+1)); return
  fi
  # On a 200, verify the body really is a decodable image.
  if [[ "$want" == "200" ]]; then
    if ! decode_ok "$tmp"; then
      printf "  FAIL %-38s 200 but body not a valid image (%s)\n" "$label" "$ctype"; FAIL=$((FAIL+1)); return
    fi
  fi
  printf "  OK   %-38s %s %s\n" "$label" "$code" "$ctype"; PASS=$((PASS+1))
}

# decode_ok <file> - Pillow decode if available, else JPEG/PNG magic bytes.
decode_ok() {
  python3 - "$1" <<'PY' 2>/dev/null && return 0
import sys
data = open(sys.argv[1], 'rb').read()
try:
    import io
    from PIL import Image
    im = Image.open(io.BytesIO(data)); im.load()
    sys.exit(0)
except ImportError:
    # No Pillow: fall back to magic-byte sniff.
    if data[:2] == b'\xff\xd8' or data[:8] == b'\x89PNG\r\n\x1a\n':
        sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
PY
  return 1
}

# assert_unavailable <label> <url> - a 503 that also carries Retry-After.
# The header is the whole point: without it a viewer cannot tell a restore in
# progress from a permanent failure, and retries immediately.
assert_unavailable() {
  local label="$1" url="$2" code retry
  code=$(curl -s -o "$tmp" -D "$hdr" -w '%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" "$url" || echo "000")
  if [[ "$code" != "503" ]]; then
    printf "  FAIL %-38s got %s (want 503)\n" "$label" "$code"; FAIL=$((FAIL+1)); return
  fi
  retry=$(tr -d '\r' < "$hdr" | awk 'tolower($1) == "retry-after:" { print $2 }' | tail -n1)
  if [[ -z "$retry" ]]; then
    printf "  FAIL %-38s 503 without Retry-After\n" "$label"; FAIL=$((FAIL+1)); return
  fi
  printf "  OK   %-38s 503 Retry-After=%s\n" "$label" "$retry"; PASS=$((PASS+1))
}

get_json() {
  curl -s -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/dicom+json" "$1"
}

# ── Resolve a renderable instance ─────────────────────────────────────────────
if [[ $# -eq 4 ]]; then
  STUDY="$2"; SERIES="$3"; SOP="$4"
else
  echo "Discovering an instance from QIDO..."
  STUDY=$(get_json "${BASE}/studies?limit=50" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Prefer an SM (whole-slide) study; else the first study.
sm = [s for s in d if 'SM' in (s.get('00080061', {}).get('Value') or [])]
pick = (sm or d)[0]
print(pick['0020000D']['Value'][0])
") || die "no studies returned for datastore ${DATASTORE_ID}"
  SERIES=$(get_json "${BASE}/studies/${STUDY}/series" | python3 -c "
import sys, json; print(json.load(sys.stdin)[0]['0020000E']['Value'][0])") \
    || die "no series returned for the discovered study"
  # Smallest instance (fewest frames) keeps the render cheap.
  SOP=$(get_json "${BASE}/studies/${STUDY}/series/${SERIES}/instances" | python3 -c "
import sys, json
d = json.load(sys.stdin)
pick = min(d, key=lambda i: int((i.get('00280008', {}).get('Value') or [1])[0]))
print(pick['00080018']['Value'][0])") || die "no instances returned for the discovered series"
fi

INST="${BASE}/studies/${STUDY}/series/${SERIES}/instances/${SOP}"
echo "Study:    $STUDY"
echo "Series:   $SERIES"
echo "Instance: $SOP"
echo ""

echo "-- Happy paths ----------------------------------------------"
assert_render "instance default (jpeg)"   200 "${INST}/rendered"
assert_render "instance png"              200 "${INST}/rendered" "image/png"
assert_render "viewport scale"            200 "${INST}/rendered?viewport=128,128"
assert_render "viewport crop+scale"       200 "${INST}/rendered?viewport=256,256,0,0,1024,1024"
assert_render "viewport flip"             200 "${INST}/rendered?viewport=256,256,1024,0,-1024,1024"
assert_render "iccprofile=srgb"           200 "${INST}/rendered?iccprofile=srgb"
assert_render "annotation"                200 "${INST}/rendered?annotation=patient,technique"
assert_render "frame 1 jpeg q=50"         200 "${INST}/frames/1/rendered?quality=50"
assert_render "frame 1 png"               200 "${INST}/frames/1/rendered" "image/png"

echo "-- Error paths ----------------------------------------------"
assert_render "bad viewport -> 400"       400 "${INST}/rendered?viewport=notanumber"
assert_render "unsupported accept -> 406" 406 "${INST}/rendered" "application/pdf"
assert_render "frame oob -> 404"          404 "${INST}/frames/99999/rendered"
assert_render "study-level -> 501"        501 "${BASE}/studies/${STUDY}/rendered"
assert_render "unknown instance -> 404"   404 "${BASE}/studies/${STUDY}/series/${SERIES}/instances/9.9.9/rendered"

echo "-- Availability ---------------------------------------------"
if [[ -n "${OFFLINE_SOP_UID:-}" ]]; then
  OFF_STUDY="${OFFLINE_STUDY_UID:-$STUDY}"
  OFF_SERIES="${OFFLINE_SERIES_UID:-$SERIES}"
  assert_unavailable "archived instance -> 503" \
    "${BASE}/studies/${OFF_STUDY}/series/${OFF_SERIES}/instances/${OFFLINE_SOP_UID}/rendered"
else
  printf "  SKIP %-38s set OFFLINE_SOP_UID\n" "archived instance -> 503"
  SKIP=$((SKIP+1))
fi

echo ""
echo "Passed: $PASS   Failed: $FAIL   Skipped: $SKIP"
[[ "$FAIL" -eq 0 ]] || { echo "rendered smoke test FAILED"; exit 1; }
echo "rendered smoke test passed."
