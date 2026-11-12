#!/bin/bash
# DICOM Archive DIMSE Service Management Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Detect container command
if command -v podman-compose &> /dev/null; then
    COMPOSE_CMD="podman-compose"
elif command -v podman &> /dev/null; then
    COMPOSE_CMD="podman compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
elif command -v docker &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    echo "Error: Neither Podman nor Docker found"
    exit 1
fi

case "$1" in
    start)
        echo "Starting DICOM service..."
        $COMPOSE_CMD up -d
        ;;
    stop)
        echo "Stopping DICOM service..."
        $COMPOSE_CMD down
        ;;
    restart)
        echo "Restarting DICOM service..."
        $COMPOSE_CMD restart
        ;;
    status)
        $COMPOSE_CMD ps
        ;;
    logs)
        $COMPOSE_CMD logs -f
        ;;
    update)
        echo "Updating DICOM service..."
        $COMPOSE_CMD pull
        $COMPOSE_CMD up -d
        ;;
    health)
        STATUS_PORT=$(grep STATUS_PORT .env | cut -d'=' -f2)
        curl -f "http://localhost:${STATUS_PORT}/health" && echo "Service is healthy" || echo "Service is unhealthy"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs|update|health}"
        exit 1
        ;;
esac
