#!/usr/bin/env bash
#
# Tear down a DICOM-Archive CDK deployment (burner / dev / QA) completely,
# including the resources CloudFormation leaves behind because of RETAIN /
# snapshot-on-delete removal policies.
#
# Why this exists: `cdk destroy` alone does NOT fully remove a stack. The Aurora
# cluster has DeletionProtection + a RETAIN policy, so CFN skips it and the
# Database nested stack (and the root) end in DELETE_FAILED with the cluster
# still billing. Several S3 buckets are also retained. And a stack left in
# ROLLBACK_FAILED (a deploy that never finished) will not delete via cdk at all.
# This script clears those blockers in the right order, then verifies.
#
# Usage:
#   scripts/teardown.sh <stackPrefix> --profile <aws-profile> [--region <region>]
#                       [--yes] [--dry-run]
#
#   scripts/teardown.sh qa6 --profile burner --region us-east-2
#   scripts/teardown.sh qa5 --profile burner --dry-run
#
# Flags:
#   --profile  (required) AWS CLI profile to use.
#   --region   AWS region. Default: us-east-2.
#   --yes      Skip the interactive confirmation prompt.
#   --dry-run  Print every destructive command instead of running it.
#
# The prefix is normalized the same way bin/cdk-infrastructure.ts normalizes it:
# lowercased and hyphen-stripped, so "QA-6" and "qa6" both target stack "qa6".
#
# SAFETY: this deletes live infrastructure and data irreversibly. It refuses to
# run against a stack whose Deployment/prefix does not match <stackPrefix>, and
# it will not touch resources tagged for a different deployment (e.g. it will
# not delete qa5's NAT gateway while tearing down qa6).

set -euo pipefail

# ---- arg parsing ---------------------------------------------------------
PREFIX=""
PROFILE=""
REGION="us-east-2"
ASSUME_YES=0
DRY_RUN=0

usage() {
  sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --region)  REGION="${2:-}"; shift 2 ;;
    --yes|-y)  ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    -*)        echo "Unknown flag: $1" >&2; usage 1 ;;
    *)
      if [[ -z "$PREFIX" ]]; then PREFIX="$1"; else echo "Unexpected arg: $1" >&2; usage 1; fi
      shift ;;
  esac
done

[[ -z "$PREFIX" ]]  && { echo "ERROR: <stackPrefix> is required." >&2; usage 1; }
[[ -z "$PROFILE" ]] && { echo "ERROR: --profile is required." >&2; usage 1; }

# Normalize exactly like bin/cdk-infrastructure.ts: lowercase + strip hyphens.
PREFIX="$(echo "$PREFIX" | tr '[:upper:]' '[:lower:]' | tr -d '-')"

AWS=(aws --profile "$PROFILE" --region "$REGION")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_DIR="$(dirname "$SCRIPT_DIR")"

# ---- helpers -------------------------------------------------------------
log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    WARN: %s\033[0m\n' "$*"; }

# run <description> <cmd...> : execute or, in dry-run, just print.
run() {
  local desc="$1"; shift
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '    [dry-run] %s\n              %s\n' "$desc" "$*"
  else
    info "$desc"
    "$@"
  fi
}

# ---- 0. identity + guard -------------------------------------------------
log "Verifying account and target"
ACCT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
info "Account: $ACCT   Region: $REGION   Profile: $PROFILE"
info "Target stack prefix: '$PREFIX'"

ROOT_STATUS="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$PREFIX" \
  --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NONE")"
info "Root stack '$PREFIX' status: $ROOT_STATUS"

if [[ "$ROOT_STATUS" == "NONE" ]]; then
  warn "No root stack named '$PREFIX' found. Will still sweep for tagged orphan resources."
fi

if [[ "$ASSUME_YES" -ne 1 && "$DRY_RUN" -ne 1 ]]; then
  printf '\n\033[1;31mThis will IRREVERSIBLY delete the "%s" deployment in account %s (%s).\033[0m\n' \
    "$PREFIX" "$ACCT" "$REGION"
  read -r -p 'Type the prefix to confirm: ' CONFIRM
  [[ "$CONFIRM" == "$PREFIX" ]] || { echo "Confirmation did not match. Aborting."; exit 1; }
fi

# ---- 1. Aurora: disable deletion protection + delete ---------------------
# These are the RETAIN'd clusters that keep billing after cdk destroy.
log "Aurora clusters for '$PREFIX'"
mapfile -t CLUSTERS < <("${AWS[@]}" rds describe-db-clusters \
  --query "DBClusters[?contains(DBClusterIdentifier, '${PREFIX}-')].DBClusterIdentifier" \
  --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)

if [[ "${#CLUSTERS[@]}" -eq 0 ]]; then
  info "No Aurora clusters found."
else
  for C in "${CLUSTERS[@]}"; do
    info "Cluster: $C"
    PROT="$("${AWS[@]}" rds describe-db-clusters --db-cluster-identifier "$C" \
      --query "DBClusters[0].DeletionProtection" --output text 2>/dev/null || echo "unknown")"
    if [[ "$PROT" == "True" ]]; then
      run "Disabling deletion protection on $C" \
        "${AWS[@]}" rds modify-db-cluster --db-cluster-identifier "$C" \
          --no-deletion-protection --apply-immediately
    fi
    # Delete member instances first.
    mapfile -t INSTS < <("${AWS[@]}" rds describe-db-clusters --db-cluster-identifier "$C" \
      --query "DBClusters[0].DBClusterMembers[].DBInstanceIdentifier" --output text 2>/dev/null \
      | tr '\t' '\n' | grep -v '^$' || true)
    for I in "${INSTS[@]:-}"; do
      [[ -z "$I" || "$I" == "None" ]] && continue
      run "Deleting DB instance $I (no final snapshot)" \
        "${AWS[@]}" rds delete-db-instance --db-instance-identifier "$I" --skip-final-snapshot
    done
    run "Deleting DB cluster $C (no final snapshot)" \
      "${AWS[@]}" rds delete-db-cluster --db-cluster-identifier "$C" --skip-final-snapshot
  done
fi

# ---- 2. Delete the CloudFormation stack ----------------------------------
# cdk destroy for the normal case; fall back to raw delete-stack for a
# ROLLBACK_FAILED / broken root that cdk refuses to handle.
if [[ "$ROOT_STATUS" != "NONE" ]]; then
  log "Deleting CloudFormation stack '$PREFIX' (status: $ROOT_STATUS)"
  if [[ "$ROOT_STATUS" == "ROLLBACK_FAILED" || "$ROOT_STATUS" == *"_FAILED" ]]; then
    warn "Stack is in $ROOT_STATUS; cdk destroy often cannot handle this. Using CloudFormation delete-stack."
    run "delete-stack $PREFIX" \
      "${AWS[@]}" cloudformation delete-stack --stack-name "$PREFIX"
  else
    if [[ "$DRY_RUN" -eq 1 ]]; then
      printf '    [dry-run] cdk destroy %s\n              (cd %s && AWS_PROFILE=%s npx cdk destroy %s --context stackPrefix=%s --force)\n' \
        "$PREFIX" "$CDK_DIR" "$PROFILE" "$PREFIX" "$PREFIX"
    else
      info "cdk destroy $PREFIX"
      ( cd "$CDK_DIR" && AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" \
          npx cdk destroy "$PREFIX" --context stackPrefix="$PREFIX" --force ) \
        || {
          warn "cdk destroy failed; retrying with CloudFormation delete-stack."
          "${AWS[@]}" cloudformation delete-stack --stack-name "$PREFIX"
        }
    fi
  fi

  if [[ "$DRY_RUN" -ne 1 ]]; then
    info "Waiting for stack delete to complete (up to ~30 min)..."
    "${AWS[@]}" cloudformation wait stack-delete-complete --stack-name "$PREFIX" 2>/dev/null \
      && info "Stack '$PREFIX' deleted." \
      || warn "Stack did not reach DELETE_COMPLETE in the wait window. Check the console / re-run; a retained resource may still be blocking."
  fi
else
  log "No root stack to delete; skipping stack deletion."
fi

# ---- 3. S3 buckets: empty (incl. versions) then remove -------------------
log "S3 buckets for '$PREFIX'"
mapfile -t BUCKETS < <("${AWS[@]}" s3api list-buckets \
  --query "Buckets[?starts_with(Name, '${PREFIX}-')].Name" --output text 2>/dev/null \
  | tr '\t' '\n' | grep -v '^$' || true)

if [[ "${#BUCKETS[@]}" -eq 0 ]]; then
  info "No buckets found."
else
  for B in "${BUCKETS[@]}"; do
    info "Bucket: $B"
    VERS="$("${AWS[@]}" s3api get-bucket-versioning --bucket "$B" --query Status --output text 2>/dev/null || echo None)"
    if [[ "$VERS" == "Enabled" || "$VERS" == "Suspended" ]]; then
      # Delete all object versions and delete-markers (1000 at a time).
      while :; do
        PAYLOAD="$("${AWS[@]}" s3api list-object-versions --bucket "$B" --max-items 1000 \
          --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][]}' \
          --output json 2>/dev/null || echo '{"Objects":null}')"
        if echo "$PAYLOAD" | grep -q '"Objects": null'; then break; fi
        run "Deleting a batch of object versions in $B" \
          "${AWS[@]}" s3api delete-objects --bucket "$B" --delete "$PAYLOAD"
        [[ "$DRY_RUN" -eq 1 ]] && break   # avoid an infinite loop in dry-run
      done
    else
      run "Emptying unversioned bucket $B" \
        "${AWS[@]}" s3 rm "s3://$B" --recursive
    fi
    run "Removing bucket $B" "${AWS[@]}" s3 rb "s3://$B"
  done
fi

# ---- 4. NAT gateways: only those tagged for THIS deployment --------------
# Guard against deleting another environment's NAT (e.g. qa5's while on qa6).
log "NAT gateways tagged Deployment=$PREFIX"
mapfile -t NATS < <("${AWS[@]}" ec2 describe-nat-gateways \
  --filter "Name=tag:Deployment,Values=${PREFIX}" "Name=state,Values=available" \
  --query "NatGateways[].NatGatewayId" --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)

if [[ "${#NATS[@]}" -eq 0 ]]; then
  info "No available NAT gateways tagged for '$PREFIX' (the stack delete usually removes them)."
else
  for N in "${NATS[@]}"; do
    run "Deleting NAT gateway $N" "${AWS[@]}" ec2 delete-nat-gateway --nat-gateway-id "$N"
  done
fi

# ---- 5. Verify -----------------------------------------------------------
log "Verification for '$PREFIX'"
STACKS_LEFT="$("${AWS[@]}" cloudformation describe-stacks \
  --query "Stacks[?starts_with(StackName, '${PREFIX}')].StackName" --output text 2>/dev/null || true)"
CLUSTERS_LEFT="$("${AWS[@]}" rds describe-db-clusters \
  --query "DBClusters[?contains(DBClusterIdentifier, '${PREFIX}-')].DBClusterIdentifier" --output text 2>/dev/null || true)"
BUCKETS_LEFT="$("${AWS[@]}" s3api list-buckets \
  --query "Buckets[?starts_with(Name, '${PREFIX}-')].Name" --output text 2>/dev/null || true)"
NATS_LEFT="$("${AWS[@]}" ec2 describe-nat-gateways \
  --filter "Name=tag:Deployment,Values=${PREFIX}" "Name=state,Values=available" \
  --query "NatGateways[].NatGatewayId" --output text 2>/dev/null || true)"

printf '    Stacks:   %s\n' "${STACKS_LEFT:-<none>}"
printf '    Clusters: %s\n' "${CLUSTERS_LEFT:-<none>}"
printf '    Buckets:  %s\n' "${BUCKETS_LEFT:-<none>}"
printf '    NAT gws:  %s\n' "${NATS_LEFT:-<none>}"

if [[ -z "$STACKS_LEFT$CLUSTERS_LEFT$BUCKETS_LEFT$NATS_LEFT" ]]; then
  log "'$PREFIX' is fully torn down. ✅"
else
  warn "Some resources remain (see above). RDS cluster deletion is async and can take several minutes; re-run to sweep, or check the console."
fi
