# syntax=docker/dockerfile:1

# Build stage - compile Python to binary
FROM public.ecr.aws/docker/library/python:3.13-slim as builder

WORKDIR /app

# Install system dependencies including PyInstaller requirements
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    build-essential \
    binutils \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install dependencies
COPY requirements.txt .
# Use the base image's pip (no unpinned self-upgrade) and a pinned PyInstaller.
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir pyinstaller==6.22.3

# Copy application code
COPY . .

# Compile to binary
RUN pyinstaller --onefile \
    --name dicom-service \
    --add-data "*.py:." \
    --hidden-import=pydicom \
    --hidden-import=pynetdicom \
    --hidden-import=boto3 \
    --hidden-import=botocore \
    --hidden-import=pyzipper \
    --hidden-import=iam_rolesanywhere_session \
    --hidden-import=cryptography \
    main.py

# Runtime stage - minimal image
FROM public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app

# Install only runtime dependencies
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy compiled binary from builder
COPY --from=builder /app/dist/dicom-service /app/dicom-service

# Create necessary directories
RUN mkdir -p /app/in /app/out /app/logs /app/config

# Set environment variables
ENV LOGLEVEL=INFO
ENV SCP_PORT=11112
ENV STATUS_PORT=8080
ENV THREADCOUNT=0
ENV S3_TRANSFER_ACCELERATION=false
ENV STORAGE_THROTTLE=1000
ENV STORAGE_OOR=100
ENV PYTHONUNBUFFERED=1
ENV INTERFACE_ID=default-dicom-interface
ENV CONFIGURATION_API_ENDPOINT=""
ENV AWS_REGION=us-east-1

# Create non-root user
RUN groupadd -r dicom && useradd -r -g dicom dicom && \
    chown -R dicom:dicom /app && \
    chmod +x /app/dicom-service
USER dicom

# Expose ports
EXPOSE 11112
EXPOSE 2762
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run compiled binary
CMD ["/app/dicom-service"]
