# syntax=docker/dockerfile:1
# Base image from the Amazon ECR Public mirror (not Docker Hub) — AWS-hosted
# supply chain, no Docker Hub rate limits.
FROM --platform=linux/amd64 public.ecr.aws/docker/library/python:3.13-slim as build

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
# Use the base image's pip (no unpinned self-upgrade).
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p /app/in /app/out

# Set environment variables with defaults
ENV LOGLEVEL=INFO
ENV HL7_PORT=2575
ENV THREADCOUNT=1
ENV S3_TRANSFER_ACCELERATION=false
ENV STORAGE_THROTTLE=1000
ENV STORAGE_OOR=100
ENV MESSAGE_TIMEOUT=30
ENV MAX_MESSAGE_SIZE=1048576
ENV TLS_ENABLED=true
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# Create a non-root user for security
RUN groupadd -r hl7 && useradd -r -g hl7 hl7 && \
    chown -R hl7:hl7 /app
USER hl7

# Expose HL7 port
EXPOSE 2575

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python3 -c "import socket; import os; s=socket.socket(); s.settimeout(5); s.connect(('localhost', int(os.environ.get('HL7_PORT', '2575')))); s.close()" || exit 1

# Run the application
CMD ["python3", "main.py"]
