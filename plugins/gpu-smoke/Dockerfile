# GPU smoke-test plugin. x86_64 because the Batch GPU AMI is x86_64 only.
# COPY-only on purpose: it builds on an arm64 host without emulation. boto3 is
# vendored as pure-Python wheels by build.sh.
FROM --platform=linux/amd64 public.ecr.aws/docker/library/python:3.12-slim
COPY gpu-smoke/vendor /opt/vendor
COPY gpu-smoke/gpu_smoke.py sdk/plugin_sdk.py /opt/plugin/
ENV PYTHONPATH=/opt/vendor PYTHONUNBUFFERED=1
WORKDIR /opt/plugin
# Security: run as an unprivileged user (work dir is tempfile.mkdtemp under /tmp).
RUN useradd --system --uid 10001 --create-home --home-dir /home/plugin plugin
USER 10001
ENTRYPOINT ["python3", "/opt/plugin/gpu_smoke.py"]
