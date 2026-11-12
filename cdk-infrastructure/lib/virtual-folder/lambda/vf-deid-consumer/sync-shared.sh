#!/usr/bin/env bash
# Copy the AUTHORITATIVE VF de-id engine (interface-container/dicomweb-s3/vf_deid.py)
# into this consumer's dir under the same import name, so index-time de-id and the
# on-the-fly retrieve de-id share ONE implementation (the documented consistency
# contract: a hashed/shifted tag reads identically in QIDO search and WADO retrieve).
#
# The CDK Docker bundling mounts ONLY this lambda's own dir as /asset-input, so the
# origin file cannot be reached at bundle time — this sync MUST run before cdk deploy.
# The copy is .gitignored so the dicomweb-s3 file stays the single source of truth.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/../../../../../interface-container/dicomweb-s3/vf_deid.py"
if [ ! -f "$SRC" ]; then
  echo "sync-shared: source not found: $SRC" >&2
  exit 1
fi
cp "$SRC" "$HERE/vf_deid.py"
echo "sync-shared: copied vf_deid.py into vf-deid-consumer"
