#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Format: "rel_path:python_version"
ENTRIES=(
  "cdk-infrastructure/lib/export/lambda/export-worker/requirements.txt:3.12"
  "cdk-infrastructure/lib/import/lambda/dicom-encapsulator/requirements.txt:3.12"
  "cdk-infrastructure/lib/analytics/lambda/analytics-s3-writer/requirements.txt:3.12"
  "interface-container/virtual-dicomweb/requirements.txt:3.13"
  "interface-container/HL7/requirements.txt:3.13"
  "interface-container/DICOM/DIMSEtoS3/requirements.txt:3.13"
)

for ENTRY in "${ENTRIES[@]}"; do
  REL_PATH="${ENTRY%%:*}"
  PY_VER="${ENTRY##*:}"
  ABS_PATH="$REPO_ROOT/$REL_PATH"

  echo "==> $REL_PATH (python:${PY_VER})"

  CONTAINER_RUNTIME=$(command -v docker || command -v podman)
  FREEZE=$("$CONTAINER_RUNTIME" run --rm -i "python:${PY_VER}-slim" \
    sh -c "pip install -q -r /dev/stdin 2>/dev/null && pip freeze" \
    < "$ABS_PATH")

  PINNED=""
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue

    PKG_NAME=$(echo "$line" | sed 's/[>=<!;[].*//' | tr '[:upper:]' '[:lower:]' | tr -d ' ')
    NORMALIZED=$(echo "$PKG_NAME" | tr '-' '_')

    MATCH=$(echo "$FREEZE" | grep -i "^${PKG_NAME}==" || true)
    [[ -z "$MATCH" ]] && MATCH=$(echo "$FREEZE" | grep -i "^${NORMALIZED}==" || true)

    if [[ -z "$MATCH" ]]; then
      echo "  WARNING: could not resolve '$PKG_NAME' — keeping original: $line"
      PINNED+="$line"$'\n'
    else
      FIRST=$(echo "$MATCH" | head -1)
      PINNED+="$FIRST"$'\n'
      echo "  $FIRST"
    fi
  done < "$ABS_PATH"

  if $DRY_RUN; then
    echo "  [dry-run] would write to $REL_PATH"
  else
    printf '%s' "$PINNED" > "$ABS_PATH"
    echo "  written."
  fi
  echo
done
