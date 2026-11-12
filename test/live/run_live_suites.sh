#!/usr/bin/env bash
# Run the live test suites against a stack prepared by stack_setup.py.
#
#   test/live/run_live_suites.sh <workdir> [suite ...]     (default: all)
#
# Suites: privilege full get datauser workflow vf nondicom pluginfiles ts cstorets tar
#         stowidle queuemon overwrite indexattrs download ndv2 analyticseval
# analyticseval needs analyticsFeature + analyticsFeatureTextToSQL (calls Bedrock ~45 times);
#   it is not in the default list.
# queuemon compares the Queues Monitor API with SQS and creates/deletes <prefix>-qmtest-* queues.
# cstorets C-STOREs the ts suite's instances (one per transfer syntax); it generates them if ts has not run.
# Logs: <workdir>/results/<suite>.log; summary: <workdir>/results/summary.txt (ends with DONE).
# DIMSE suites open a temporary /32 ingress on the NLB SG for this host and remove it on exit.
#
# Sign-in goes through test/cognito_mfa.py, which completes the TOTP MFA challenge the
# deployment requires by default. TOTP secrets for the test users are kept in
# $TEST_MFA_DIR (default <workdir>/mfa), outside the repository.
#
# Env: AWS credentials/region for the target account; PYTHON (default python3) with boto3,
#      requests, pydicom and pynetdicom; TS_PYTHON (default python3.12) for the venvs the
#      transfer-syntax suites build; NODE_PATH with @aws-sdk/client-cognito-identity-provider.
set -u
WD=$(cd "$1" && pwd); shift
# shellcheck disable=SC1091
. "$WD/stack.env"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
T="$REPO/test"
R="$WD/results"; mkdir -p "$R"
PW=$(cat "$ADMIN_PW_FILE")
PY=${PYTHON:-python3}
TS_BASE_PY=${TS_PYTHON:-python3.12}
SUITES=${*:-privilege full get datauser workflow vf nondicom pluginfiles ts cstorets tar stowidle queuemon overwrite indexattrs download ndv2}
: > "$R/summary.txt"

# Suite processes keep their scratch files (test_*.json, token files) in the workdir.
export TEST_SCRATCH="$WD" SCRATCH="$WD" AWS_REGION="${AWS_REGION:-us-east-1}"
export TEST_MFA_DIR="${TEST_MFA_DIR:-$WD/mfa}"
# boto3 clients created without a region read AWS_DEFAULT_REGION.
export AWS_DEFAULT_REGION="$AWS_REGION"
export ARCHIVE_API="$API" ARCHIVE_CF="$CF" ARCHIVE_CLIENT="$CLIENT" ARCHIVE_POOL="$POOL" STACK_PREFIX

refresh_tokens() {
  "$PY" - "$CLIENT" "$PW" "$WD" "$T" <<'EOF'
import boto3, os, sys
c, pw, wd, t = sys.argv[1:5]
sys.path.insert(0, t)
from cognito_mfa import access_token
tok = access_token(boto3.client('cognito-idp'), c, 'admin', pw)
for n in ('test_admin_token.txt', 'admin_token'):
    with open(os.open(os.path.join(wd, n), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        f.write(tok)
EOF
  (cd "$REPO" && API_BASE_URL="$API" USER_POOL_ID="$POOL" CLIENT_ID="$CLIENT" \
     node test/authenticate-test-users.js > "$R/tokens.log" 2>&1)
}

RULES=()
open_dimse() {
  [ ${#RULES[@]} -gt 0 ] && return
  # In-VPC runners have no internet egress: RUNNER_IP supplies the private IP.
  local ip; ip=${RUNNER_IP:-$(curl -s https://checkip.amazonaws.com)}
  for p in 11112 2762; do
    RULES+=("$(aws ec2 authorize-security-group-ingress --group-id "$NLB_SG" --protocol tcp --port $p \
      --cidr "$ip/32" --query 'SecurityGroupRules[0].SecurityGroupRuleId' --output text 2>/dev/null)")
  done
  echo "temp ingress ${RULES[*]} from $ip" >> "$R/summary.txt"
}
close_dimse() {
  for r in "${RULES[@]}"; do
    [ -n "$r" ] && [ "$r" != None ] && aws ec2 revoke-security-group-ingress --group-id "$NLB_SG" \
      --security-group-rule-ids "$r" >/dev/null && echo "revoked $r" >> "$R/summary.txt"
  done
  RULES=()
}
trap close_dimse EXIT

TS_PY="$WD/ts-venv/bin/python"
ts_venv() {
  [ -x "$TS_PY" ] && return
  "$TS_BASE_PY" -m venv "$WD/ts-venv"
  "$TS_PY" -m pip install -q "pydicom==2.4.5" imagecodecs imageio-ffmpeg python-gdcm numpy requests boto3 "setuptools<81"
}

# C-STORE suite: same pydicom/pynetdicom as the DIMSE image (pydicom 2.4 cannot write HTJ2K).
CTS_PY="$WD/cts-venv/bin/python"
cts_venv() {
  [ -x "$CTS_PY" ] && return
  "$TS_BASE_PY" -m venv "$WD/cts-venv"
  "$CTS_PY" -m pip install -q "pydicom==3.0.2" "pynetdicom==3.0.4" boto3 requests
}

run() {
  local s=$1
  refresh_tokens
  local log="$R/$s.log" rc
  echo "=== $s $(date -u +%H:%M:%S)" > "$log"
  case $s in
    privilege) (cd "$REPO" && API_BASE_URL="$API" node test/api-privilege-test-suite.js \
                 $(node -p "const t=require('./test/test-tokens.json');[t.ADMIN,t.DATA_ACCESS,t.READ_ONLY,t.DATASTORE_MANAGER,t.SYSTEM_MANAGER,t.NO_ACCESS].join(' ')")) >> "$log" 2>&1 ;;
    full)      (cd "$T" && "$PY" run-full-suite.py) >> "$log" 2>&1 ;;
    get)       (cd "$T" && "$PY" run-get-matrix.py) >> "$log" 2>&1 ;;
    datauser)  (cd "$T" && "$PY" run-datauser-suite.py) >> "$log" 2>&1 ;;
    workflow)  (cd "$T" && "$PY" run-workflow-suite.py) >> "$log" 2>&1 ;;
    vf)        (cd "$T" && VF_E2E_API="$API" VF_E2E_CF="$CF" VF_E2E_CLIENT_ID="$CLIENT" VF_E2E_ADMIN_PW="$PW" \
                 VF_E2E_DICOM_DIR="$VF_DIR" VF_E2E_RESULTS="$R/vf.json" "$PY" run-vf-write-modes-suite.py) >> "$log" 2>&1 ;;
    nondicom)  (cd "$T" && ND_E2E_API="$API" ND_E2E_CF="$CF" ND_E2E_CLIENT_ID="$CLIENT" ND_E2E_ADMIN_PW="$PW" \
                 ND_E2E_DATASTORE=demo-studies "$PY" run-non-dicom-import-check.py) >> "$log" 2>&1 ;;
    pluginfiles) (cd "$T" && PF_E2E_API="$API" PF_E2E_CF="$CF" PF_E2E_CLIENT_ID="$CLIENT" PF_E2E_BUCKET="$PLUGIN_BUCKET" \
                 PF_E2E_DATASTORE=demo-studies "$PY" run-plugin-files-delete-suite.py) >> "$log" 2>&1 ;;
    ts)        ts_venv >> "$log" 2>&1
               (cd "$T/ts-conformance" && export TSC_WORKDIR="$WD/tsconf-work" &&
                 { [ -f "$TSC_WORKDIR/tsconf/refs.json" ] || { "$TS_PY" generate.py && "$TS_PY" references.py; }; } &&
                 aws s3 cp "$TSC_WORKDIR/tsconf/" "s3://$DS_BUCKET/ts-conformance/" --recursive --only-show-errors \
                   --exclude '*.json' --exclude '*.npy' && sleep 90 &&
                 TSC_BASE="$CF/dicomweb/$DS_ID" TSC_TOKEN_FILE="$WD/admin_token" "$TS_PY" check.py) >> "$log" 2>&1 ;;
    cstorets)  ts_venv >> "$log" 2>&1; cts_venv >> "$log" 2>&1; open_dimse
               (cd "$T/ts-conformance" && export TSC_WORKDIR="$WD/tsconf-work" &&
                 { [ -f "$TSC_WORKDIR/tsconf/refs.json" ] || { "$TS_PY" generate.py && "$TS_PY" references.py; }; } &&
                 cd "$T" && CTS_E2E_API="$API" CTS_E2E_CLIENT_ID="$CLIENT" CTS_E2E_HOST="$NLB_DNS" \
                 CTS_E2E_INTERFACE="$AE" CTS_E2E_DICOMWEB="$CF/dicomweb/$DS_ID" CTS_E2E_RESULTS="$R/cstorets.json" \
                 "$CTS_PY" run-dimse-cstore-ts-suite.py) >> "$log" 2>&1 ;;
    analyticseval) (cd "$T" && AE_API="$API" AE_DS="$DS_ID" AE_TOKEN_FILE="$WD/admin_token" \
                 AE_RESULTS="$R/analyticseval.json" "$PY" run-analytics-eval.py) >> "$log" 2>&1 ;;
    queuemon)  (cd "$T" && QM_API="$API" QM_TOKEN_FILE="$WD/admin_token" QM_PREFIX="$STACK_PREFIX" \
                 QM_RESULTS="$R/queuemon.json" "$PY" run-queue-monitor-suite.py) >> "$log" 2>&1 ;;
    indexattrs) (cd "$T" && IA_E2E_API="$API" IA_E2E_CF="$CF" IA_E2E_CLIENT_ID="$CLIENT" IA_E2E_ADMIN_PW="$PW" \
                 IA_E2E_DS="$DS_ID" IA_E2E_BUCKET="$DS_BUCKET" IA_E2E_TEMPLATE="$VF_DIR/mr1.dcm" \
                 IA_E2E_REGION="$AWS_REGION" IA_E2E_RESULTS="$R/indexattrs.json" \
                 "$PY" run-index-attributes-suite.py) >> "$log" 2>&1 ;;
    download)  (cd "$T" && "$PY" run-download-suite.py "$WD") >> "$log" 2>&1 ;;
    overwrite) (cd "$T" && "$PY" run-overwrite-suite.py "$WD") >> "$log" 2>&1 ;;
    ndv2)      (cd "$T" && "$PY" run-non-dicom-v2-suite.py "$WD") >> "$log" 2>&1 ;;
    tar)       (cd "$T/live" && "$PY" tar_members_check.py "$WD") >> "$log" 2>&1 ;;
    stowidle)  (cd "$T" && STOW_E2E_API="$API" STOW_E2E_CF="$CF" STOW_E2E_CLIENT_ID="$CLIENT" \
                 "$PY" run-stow-idle-retry-check.py) >> "$log" 2>&1 ;;
    *) echo "unknown suite $s" >> "$log"; false ;;
  esac
  rc=$?
  case $s in cstorets) close_dimse ;; esac
  echo "$s rc=$rc $(grep -cE '\[?PASS\]?|✅' "$log") pass-lines $(grep -cE '\[FAIL\]|❌|FAILED' "$log") fail-lines" >> "$R/summary.txt"
}

for s in $SUITES; do run "$s"; done
close_dimse
echo DONE >> "$R/summary.txt"
