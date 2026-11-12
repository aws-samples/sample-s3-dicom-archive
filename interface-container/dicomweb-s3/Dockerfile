# Base image pulled from the Amazon ECR Public mirror (not Docker Hub) to keep
# the supply chain on an AWS-hosted registry and avoid Docker Hub rate limits.
FROM public.ecr.aws/docker/library/python:3.11-slim
WORKDIR /app
COPY requirements.txt .
# Retries and a raised timeout for slow wheel downloads during image
# builds; kept generous because a 16 MB botocore wheel can trip pip's 15s default.
RUN pip install --no-cache-dir --retries 10 --timeout 120 -r requirements.txt
# Fail the build if any installed package is GPL-family licensed (GPL/LGPL/AGPL).
COPY build/license_check.py /tmp/license_check.py
RUN python /tmp/license_check.py && rm /tmp/license_check.py
COPY *.py .
# Amazon RDS CA bundle for verify-ca TLS to Aurora/RDS-Proxy (mysqlConnectionFactory.py).
COPY rds-global-bundle.pem .
# The task role is the only credential this process needs; nothing here writes to
# the filesystem, so it runs unprivileged.
RUN useradd --create-home --shell /usr/sbin/nologin dicomweb
USER dicomweb
EXPOSE 8080
# main.py's entrypoint runs waitress single-process when WEB_CONCURRENCY<=1, and
# execs gunicorn (one gthread worker per vCPU, serving wsgi:application) when
# WEB_CONCURRENCY>1. The CDK task definition sets WEB_CONCURRENCY to use all
# 4 vCPU; local/test runs default to the single-process path.
CMD ["python", "main.py"]
