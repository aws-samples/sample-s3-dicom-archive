# DICOM Archive DIMSE Service Installer for Windows - Auto-configured

$ErrorActionPreference = "Stop"
$SCRIPT_VERSION = "undefined"
$INSTALL_DIR = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$env:USERPROFILE\dicom-archive-dimse-service" }

# Pre-configured values
$API_ENDPOINT = ""
$AWS_REGION = "us-east-1"
$COGNITO_CLIENT_ID = ""

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "DICOM Archive DIMSE Service Installer v$SCRIPT_VERSION" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# Prompt for credentials (location selected after auth)
$USERNAME = Read-Host "Username"
$PASSWORD = Read-Host "Password" -AsSecureString
$PASSWORD_TEXT = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($PASSWORD))

# Cognito authentication
Write-Host "Authenticating..." -ForegroundColor Yellow

$authBody = @{
    AuthFlow = "USER_PASSWORD_AUTH"
    ClientId = $COGNITO_CLIENT_ID
    AuthParameters = @{
        USERNAME = $USERNAME
        PASSWORD = $PASSWORD_TEXT
    }
} | ConvertTo-Json

$authResponse = Invoke-RestMethod -Uri "https://cognito-idp.$AWS_REGION.amazonaws.com/" `
    -Method Post `
    -Headers @{
        "X-Amz-Target" = "AWSCognitoIdentityProviderService.InitiateAuth"
        "Content-Type" = "application/x-amz-json-1.1"
    } `
    -Body $authBody

# Check for MFA challenge
if ($authResponse.ChallengeName -eq "SOFTWARE_TOKEN_MFA" -or $authResponse.ChallengeName -eq "SMS_MFA") {
    $MFA_CODE = Read-Host "MFA Code"
    
    $challengeBody = @{
        ChallengeName = $authResponse.ChallengeName
        ClientId = $COGNITO_CLIENT_ID
        ChallengeResponses = @{
            USERNAME = $USERNAME
            "$($authResponse.ChallengeName)_CODE" = $MFA_CODE
        }
        Session = $authResponse.Session
    } | ConvertTo-Json
    
    $authResponse = Invoke-RestMethod -Uri "https://cognito-idp.$AWS_REGION.amazonaws.com/" `
        -Method Post `
        -Headers @{
            "X-Amz-Target" = "AWSCognitoIdentityProviderService.RespondToAuthChallenge"
            "Content-Type" = "application/x-amz-json-1.1"
        } `
        -Body $challengeBody
}

# Extract JWT token (sensitive - do not log in production)
$JWT_TOKEN = $authResponse.AuthenticationResult.AccessToken

if (-not $JWT_TOKEN) {
    Write-Host "Authentication failed. Please check your credentials." -ForegroundColor Red
    exit 1
}

Write-Host "Authentication successful!" -ForegroundColor Green
Write-Host ""

# Fetch and select location
Write-Host "Fetching available locations..." -ForegroundColor Yellow
$locationsResponse = Invoke-RestMethod -Uri "$API_ENDPOINT/locations" `
    -Method Get `
    -Headers @{ "Authorization" = "Bearer $JWT_TOKEN" }

$locations = $locationsResponse.data
Write-Host ""
Write-Host "Available Locations:" -ForegroundColor Cyan
Write-Host "====================" -ForegroundColor Cyan
for ($i = 0; $i -lt $locations.Count; $i++) {
    Write-Host "$($i + 1)) $($locations[$i].name) (port: $($locations[$i].dicomPort))"
}
Write-Host ""
$selection = [int](Read-Host "Select location (1-$($locations.Count))") - 1
if ($selection -lt 0 -or $selection -ge $locations.Count) {
    Write-Host "Invalid selection." -ForegroundColor Red; exit 1
}
$LOCATION_ID = $locations[$selection].id
$dicomPort = if ($locations[$selection].dicomPort) { $locations[$selection].dicomPort } else { 11112 }
Write-Host "Selected: $($locations[$selection].name) (ID: $LOCATION_ID, DICOM port: $dicomPort)" -ForegroundColor Green
Write-Host ""

# Check for Podman or Docker
$CONTAINER_CMD = $null
$COMPOSE_CMD = $null

if (Get-Command podman -ErrorAction SilentlyContinue) {
    $CONTAINER_CMD = "podman"
    if (Get-Command podman-compose -ErrorAction SilentlyContinue) {
        $COMPOSE_CMD = "podman-compose"
    } else {
        $COMPOSE_CMD = "podman compose"
    }
    Write-Host "Found Podman" -ForegroundColor Green
} elseif (Get-Command docker -ErrorAction SilentlyContinue) {
    $CONTAINER_CMD = "docker"
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
        $COMPOSE_CMD = "docker-compose"
    } else {
        $COMPOSE_CMD = "docker compose"
    }
    Write-Host "Found Docker" -ForegroundColor Green
} else {
    Write-Host "Neither Podman nor Docker found." -ForegroundColor Yellow
    Write-Host "Please install Podman Desktop from: https://podman-desktop.io/downloads" -ForegroundColor Yellow
    Write-Host "Or Docker Desktop from: https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    exit 1
}

Write-Host "Using: $CONTAINER_CMD with $COMPOSE_CMD" -ForegroundColor Cyan
Write-Host ""

# Create installation directory
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
Set-Location $INSTALL_DIR

# Download service package
Write-Host "Downloading service package..." -ForegroundColor Yellow
$headers = @{
    "Authorization" = "Bearer $JWT_TOKEN"
}

try {
    Invoke-WebRequest -Uri "$API_ENDPOINT/locations/$LOCATION_ID/certificates/dicom" `
        -Headers $headers `
        -OutFile "service-package.b64"
    
    # Decode base64 response
    $base64Content = Get-Content "service-package.b64" -Raw
    $bytes = [System.Convert]::FromBase64String($base64Content)
    [System.IO.File]::WriteAllBytes("$PWD\service-package.zip", $bytes)
    Remove-Item "service-package.b64"
} catch {
    Write-Host "Failed to download service package: $_" -ForegroundColor Red
    exit 1
}

# Place encrypted config.zip in config directory (DO NOT EXTRACT)
Write-Host "Placing encrypted config package..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "config" | Out-Null
Move-Item -Path "service-package.zip" -Destination "config\config.zip" -Force

# Lock the encrypted credential package to the invoking user only. It holds the
# IAM Roles Anywhere client certificate + private key; even though the archive is
# AES-encrypted, no other local account should be able to read it. Break ACL
# inheritance and grant Read to just this user (SYSTEM/Administrators retain
# access implicitly as owners/root-equivalent).
icacls "config\config.zip" /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
icacls "config" /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)(RX)" | Out-Null

# Create logs directory
New-Item -ItemType Directory -Force -Path "logs" | Out-Null

# Create .env file
$envContent = @"
# DICOM Service Configuration
DICOM_PORT=$dicomPort
STATUS_PORT=8080
LOG_LEVEL=INFO
THREAD_COUNT=0
"@
Set-Content -Path ".env" -Value $envContent

# Create docker-compose.yml
$composeContent = @'
version: '3.8'

services:
  dimse-service:
    image: ${DIMSE_DOCKER_IMAGE:-}
    container_name: dicom-archive-dimse-service
    restart: unless-stopped
    ports:
      - "${DICOM_PORT}:${DICOM_PORT}"
      - "${STATUS_PORT}:8080"
    volumes:
      - ./config:/app/config:ro
      - ./logs:/app/logs
      - dimse-temp:/app/in
    environment:
      - SCP_PORT=${DICOM_PORT}
      - STATUS_PORT=8080
      - LOGLEVEL=${LOG_LEVEL:-INFO}
      - THREADCOUNT=${THREAD_COUNT:-0}
      - S3_TRANSFER_ACCELERATION=false
      - STORAGE_THROTTLE=1000
      - STORAGE_OOR=100
      - PYTHONUNBUFFERED=1
      - USE_IAM_ANYWHERE=true
      - AWS_REGION=us-east-1
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    networks:
      - dimse-network

volumes:
  dimse-temp:
    driver: local

networks:
  dimse-network:
    driver: bridge
'@
Set-Content -Path "docker-compose.yml" -Value $composeContent

# Create management script
$mgmtScript = @'
# DICOM Archive DIMSE Service Management Script
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (Get-Command podman-compose -EA SilentlyContinue) { $COMPOSE_CMD = "podman-compose" }
elseif (Get-Command podman -EA SilentlyContinue) { $COMPOSE_CMD = "podman compose" }
elseif (Get-Command docker-compose -EA SilentlyContinue) { $COMPOSE_CMD = "docker-compose" }
elseif (Get-Command docker -EA SilentlyContinue) { $COMPOSE_CMD = "docker compose" }
else { Write-Host "Error: Neither Podman nor Docker found" -ForegroundColor Red; exit 1 }
switch ($args[0]) {
  "start" { Write-Host "Starting..."; & $COMPOSE_CMD up -d }
  "stop" { Write-Host "Stopping..."; & $COMPOSE_CMD down }
  "restart" { Write-Host "Restarting..."; & $COMPOSE_CMD restart }
  "status" { & $COMPOSE_CMD ps }
  "logs" { & $COMPOSE_CMD logs -f }
  "update" { Write-Host "Updating..."; & $COMPOSE_CMD pull; & $COMPOSE_CMD up -d }
  default { Write-Host "Usage: .\dimse-service.ps1 {start|stop|restart|status|logs|update}"; exit 1 }
}
'@
Set-Content -Path "dimse-service.ps1" -Value $mgmtScript

# Start service
Write-Host "Starting DICOM service..." -ForegroundColor Yellow
& $COMPOSE_CMD up -d

# Configure auto-start on reboot (Windows Task Scheduler)
Write-Host "Configuring Windows service..." -ForegroundColor Yellow
$taskName = "DICOM-Archive-DIMSE-Service"
$action = New-ScheduledTaskAction -Execute $COMPOSE_CMD -Argument "up -d" -WorkingDirectory $INSTALL_DIR
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Service configured to start on boot" -ForegroundColor Green

Write-Host ""
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "Service installed at: $INSTALL_DIR" -ForegroundColor White
$envContent = Get-Content ".env"
$dicomPort = ($envContent | Select-String "DICOM_PORT=").ToString().Split("=")[1]
$statusPort = ($envContent | Select-String "STATUS_PORT=").ToString().Split("=")[1]
Write-Host "DICOM Port: $dicomPort" -ForegroundColor White
Write-Host "Status Port: $statusPort" -ForegroundColor White
Write-Host ""
Write-Host "Management commands:" -ForegroundColor Cyan
Write-Host "  .\dimse-service.ps1 start" -ForegroundColor White
Write-Host "  .\dimse-service.ps1 stop" -ForegroundColor White
Write-Host "  .\dimse-service.ps1 restart" -ForegroundColor White
Write-Host "  .\dimse-service.ps1 status" -ForegroundColor White
Write-Host "  .\dimse-service.ps1 logs" -ForegroundColor White
Write-Host "  .\dimse-service.ps1 update" -ForegroundColor White
Write-Host ""
