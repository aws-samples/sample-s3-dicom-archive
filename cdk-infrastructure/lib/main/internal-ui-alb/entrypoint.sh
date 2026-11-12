#!/usr/bin/env bash
# Sync the SPA bundles from the UI S3 bucket into the nginx doc root, then run nginx.
# The bucket is read over the S3 gateway VPC endpoint (no NAT). A background loop re-syncs
# every UI_RESYNC_SECONDS so a UI rebuild (CodeBuild sync into the bucket) is picked up
# without a task restart; this is the in-VPC equivalent of the CloudFront invalidation.
set -euo pipefail

: "${UI_BUCKET:?UI_BUCKET env var is required}"
UI_ROOT="${UI_ROOT:-/usr/share/nginx/html}"
UI_RESYNC_SECONDS="${UI_RESYNC_SECONDS:-60}"
DICOMWEB_UPSTREAM="${DICOMWEB_UPSTREAM:-}"
# AWS CLI is copied in as a tree with no /usr/local/bin/aws symlink (the image is RUN-free,
# so the symlink can't be created at build time). Call it by full path.
AWS_CLI="${AWS_CLI:-/usr/local/aws-cli/v2/current/bin/aws}"

# DICOMweb upstream is injected at container start by the task definition (never baked into
# the image). Without one (dicomWebService disabled), /dicomweb/* answers 503.
if [ -n "${DICOMWEB_UPSTREAM}" ]; then
  sed -i "s|DICOMWEB_UPSTREAM_PLACEHOLDER|${DICOMWEB_UPSTREAM}|" /etc/nginx/nginx.conf
else
  sed -i 's|set \$dicomweb_upstream DICOMWEB_UPSTREAM_PLACEHOLDER;|return 503;|' /etc/nginx/nginx.conf
  sed -i '/proxy_pass \$dicomweb_upstream;/d' /etc/nginx/nginx.conf
fi
nginx -t

echo "[entrypoint] syncing s3://${UI_BUCKET}/ -> ${UI_ROOT}"
"$AWS_CLI" s3 sync "s3://${UI_BUCKET}/" "${UI_ROOT}/" --delete --only-show-errors

(
  while sleep "${UI_RESYNC_SECONDS}"; do
    "$AWS_CLI" s3 sync "s3://${UI_BUCKET}/" "${UI_ROOT}/" --delete --only-show-errors \
      || echo "[entrypoint] periodic sync failed; keeping the current bundles"
  done
) &

echo "[entrypoint] starting nginx"
exec nginx -g 'daemon off;'
