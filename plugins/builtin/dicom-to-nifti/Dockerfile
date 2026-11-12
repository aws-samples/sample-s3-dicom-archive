# DICOM to NIfTI as a processing-job plugin. Same dcm2niix package as the
# legacy NIfTI job (Debian bookworm), plus the shared plugin SDK. libgdcm-tools
# (gdcmconv, BSD) decompresses transfer syntaxes this dcm2niix build cannot read
# (JPEG-LS, HTJ2K, ...) before a second conversion attempt.
# Build context is plugins/: docker build -f builtin/dicom-to-nifti/Dockerfile plugins/
FROM public.ecr.aws/docker/library/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        dcm2niix \
        libgdcm-tools \
        python3 \
        python3-boto3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY builtin/dicom-to-nifti/nifti.py sdk/plugin_sdk.py /opt/plugin/

ENV PYTHONUNBUFFERED=1
WORKDIR /opt/plugin
# Security: run as an unprivileged user (work dir is tempfile.mkdtemp under /tmp).
RUN useradd --system --uid 10001 --create-home --home-dir /home/plugin plugin
USER 10001
ENTRYPOINT ["python3", "/opt/plugin/nifti.py"]
