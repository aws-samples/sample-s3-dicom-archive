# DICOM Archive DIMSE Service Management Script for Windows

$ErrorActionPreference = "Stop"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $SCRIPT_DIR

# Detect container command
$COMPOSE_CMD = $null
if (Get-Command podman-compose -ErrorAction SilentlyContinue) {
    $COMPOSE_CMD = "podman-compose"
} elseif (Get-Command podman -ErrorAction SilentlyContinue) {
    $COMPOSE_CMD = "podman compose"
} elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $COMPOSE_CMD = "docker-compose"
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    $COMPOSE_CMD = "docker compose"
} else {
    Write-Host "Error: Neither Podman nor Docker found" -ForegroundColor Red
    exit 1
}

$command = $args[0]

switch ($command) {
    "start" {
        Write-Host "Starting DICOM service..." -ForegroundColor Yellow
        & $COMPOSE_CMD up -d
    }
    "stop" {
        Write-Host "Stopping DICOM service..." -ForegroundColor Yellow
        & $COMPOSE_CMD down
    }
    "restart" {
        Write-Host "Restarting DICOM service..." -ForegroundColor Yellow
        & $COMPOSE_CMD restart
    }
    "status" {
        & $COMPOSE_CMD ps
    }
    "logs" {
        & $COMPOSE_CMD logs -f
    }
    "update" {
        Write-Host "Updating DICOM service..." -ForegroundColor Yellow
        & $COMPOSE_CMD pull
        & $COMPOSE_CMD up -d
    }
    "health" {
        $envContent = Get-Content ".env"
        $statusPort = ($envContent | Select-String "STATUS_PORT=").ToString().Split("=")[1]
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$statusPort/health" -UseBasicParsing
            Write-Host "Service is healthy" -ForegroundColor Green
        } catch {
            Write-Host "Service is unhealthy" -ForegroundColor Red
        }
    }
    default {
        Write-Host "Usage: .\dimse-service.ps1 {start|stop|restart|status|logs|update|health}" -ForegroundColor Yellow
        exit 1
    }
}
