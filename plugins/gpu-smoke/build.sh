#!/usr/bin/env bash
# Build and push the GPU smoke plugin to <prefix>-plugin-gpu-smoke.
# Usage: build.sh <stack-prefix> [region]
set -euo pipefail
PREFIX=${1:?stack prefix, e.g. myarchive}; REGION=${2:-${AWS_REGION:-us-east-1}}
HERE=$(cd "$(dirname "$0")" && pwd); CTX=$(dirname "$HERE")
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REPO="$PREFIX-plugin-gpu-smoke"; REG="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
rm -rf "$HERE/vendor"
python3 -m pip install --quiet --target "$HERE/vendor" --platform manylinux2014_x86_64 \
  --python-version 3.12 --only-binary=:all: --implementation cp boto3
aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REG" >/dev/null
docker build --platform linux/amd64 -f "$HERE/Dockerfile" -t "$REG/$REPO:1.0.0" "$CTX"
docker push "$REG/$REPO:1.0.0" >/dev/null
echo "$REG/$REPO:1.0.0"
