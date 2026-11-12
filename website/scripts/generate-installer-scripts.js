#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Get values from environment variables (set by CodePipeline)
const API_ENDPOINT = process.env.REACT_APP_API_BASE_URL || '';
const COGNITO_CLIENT_ID = process.env.REACT_APP_USER_POOL_CLIENT_ID || '';
const COGNITO_USER_POOL_ID = process.env.REACT_APP_USER_POOL_ID || '';
const COGNITO_IDENTITY_POOL_ID = process.env.REACT_APP_IDENTITY_POOL_ID || '';
const AWS_REGION = process.env.REACT_APP_REGION || 'us-east-1';
const DIMSE_IMAGE_URI = process.env.DIMSE_SERVICE_IMAGE_URI || '';

// Extract ECR registry from image URI
const ECR_REGISTRY = DIMSE_IMAGE_URI ? DIMSE_IMAGE_URI.split('/')[0] : '';

console.log('Generating installer scripts with:');
console.log(`  API Endpoint: ${API_ENDPOINT}`);
console.log(`  Cognito Client ID: ${COGNITO_CLIENT_ID}`);
console.log(`  Cognito User Pool ID: ${COGNITO_USER_POOL_ID}`);
console.log(`  Cognito Identity Pool ID: ${COGNITO_IDENTITY_POOL_ID}`);
console.log(`  AWS Region: ${AWS_REGION}`);
console.log(`  DIMSE Image URI: ${DIMSE_IMAGE_URI}`);
console.log(`  ECR Registry: ${ECR_REGISTRY}`);

// Bash script template with embedded values
const bashScript = `#!/bin/bash
set -e

# DICOM Archive DIMSE Service Installer - Auto-configured
SCRIPT_VERSION="${process.env.REACT_APP_VERSION}"
INSTALL_DIR="\${INSTALL_DIR:-$HOME/dicom-archive-dimse-service}"

# Pre-configured values
API_ENDPOINT="${API_ENDPOINT}"
AWS_REGION="${AWS_REGION}"
COGNITO_CLIENT_ID="${COGNITO_CLIENT_ID}"
COGNITO_USER_POOL_ID="${COGNITO_USER_POOL_ID}"
COGNITO_IDENTITY_POOL_ID="${COGNITO_IDENTITY_POOL_ID}"
ECR_REGISTRY="${ECR_REGISTRY}"

echo "==================================="
echo "DICOM Archive DIMSE Service Installer v\${SCRIPT_VERSION}"
echo "==================================="
echo ""

# Check if already installed
if [ -d "\$INSTALL_DIR" ] && [ -f "\$INSTALL_DIR/docker-compose.yml" ]; then
    echo "⚠️  Existing installation detected at: \$INSTALL_DIR"
    
    # Get installed version
    INSTALLED_VERSION="unknown"
    if [ -f "\$INSTALL_DIR/.version" ]; then
        INSTALLED_VERSION=$(cat "\$INSTALL_DIR/.version")
    fi
    
    echo "   Installed version: \$INSTALLED_VERSION"
    echo "   Available version: \$SCRIPT_VERSION"
    echo ""
    
    read -p "Do you want to re-install? This will stop and remove the current service. (y/N): " REINSTALL
    
    if [[ ! "\$REINSTALL" =~ ^[Yy]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
    
    echo ""
    echo "Stopping and removing existing service..."
    cd "\$INSTALL_DIR"
    
    # Detect compose command
    if command -v podman-compose &> /dev/null; then
        COMPOSE_CMD="podman-compose"
    elif command -v podman &> /dev/null; then
        COMPOSE_CMD="podman compose"
    elif command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
    elif command -v docker &> /dev/null; then
        COMPOSE_CMD="docker compose"
    fi
    
    # Stop service
    if [ -n "\$COMPOSE_CMD" ]; then
        \$COMPOSE_CMD down 2>/dev/null || true
    fi
    
    # Remove container
    if command -v podman &> /dev/null; then
        podman rm -f dicom-archive-dimse-service 2>/dev/null || true
    elif command -v docker &> /dev/null; then
        docker rm -f dicom-archive-dimse-service 2>/dev/null || true
    fi
    
    # Remove old installation directory
    cd "\$HOME"
    rm -rf "\$INSTALL_DIR"
    
    echo "✅ Previous installation removed"
    echo ""
fi

# Check and install dependencies
echo "Checking dependencies..."

# Check for unzip
if ! command -v unzip &> /dev/null; then
    echo "Installing unzip..."
    if [[ "\$OSTYPE" == "linux-gnu"* ]]; then
        if command -v apt-get &> /dev/null; then
            sudo apt-get update && sudo apt-get install -y unzip
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y unzip
        elif command -v yum &> /dev/null; then
            sudo yum install -y unzip
        fi
    elif [[ "\$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            brew install unzip
        fi
    fi
fi

# Check for AWS CLI
if ! command -v aws &> /dev/null; then
    echo "Installing AWS CLI..."
    if [[ "\$OSTYPE" == "linux-gnu"* ]]; then
        ARCH=\$(uname -m)
        if [[ "\$ARCH" == "aarch64" ]] || [[ "\$ARCH" == "arm64" ]]; then
            curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
        else
            curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
        fi
        unzip -q awscliv2.zip
        sudo ./aws/install
        rm -rf aws awscliv2.zip
    elif [[ "\$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            brew install awscli
        else
            curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
            sudo installer -pkg AWSCLIV2.pkg -target /
            rm AWSCLIV2.pkg
        fi
    fi
fi

echo "Dependencies installed!"
echo ""

# Prompt for configuration
read -p "Username: " USERNAME
# WARNING: PASSWORD contains sensitive data - do not log or persist
read -sp "Password: " PASSWORD
echo ""

# Cognito authentication
echo "Authenticating..."

AUTH_RESPONSE=$(curl -s -X POST \\
    -H "X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth" \\
    -H "Content-Type: application/x-amz-json-1.1" \\
    -d "{
        \\"AuthFlow\\": \\"USER_PASSWORD_AUTH\\",
        \\"ClientId\\": \\"\$COGNITO_CLIENT_ID\\",
        \\"AuthParameters\\": {
            \\"USERNAME\\": \\"\$USERNAME\\",
            \\"PASSWORD\\": \\"\$PASSWORD\\"
        }
    }" \\
    "https://cognito-idp.\${AWS_REGION}.amazonaws.com/")

# Check for MFA challenge
CHALLENGE_NAME=$(echo "\$AUTH_RESPONSE" | grep -o '"ChallengeName":"[^"]*"' | cut -d'"' -f4)
SESSION=$(echo "\$AUTH_RESPONSE" | grep -o '"Session":"[^"]*"' | cut -d'"' -f4)

if [ "\$CHALLENGE_NAME" = "SOFTWARE_TOKEN_MFA" ] || [ "\$CHALLENGE_NAME" = "SMS_MFA" ]; then
    read -p "MFA Code: " MFA_CODE
    
    AUTH_RESPONSE=$(curl -s -X POST \\
        -H "X-Amz-Target: AWSCognitoIdentityProviderService.RespondToAuthChallenge" \\
        -H "Content-Type: application/x-amz-json-1.1" \\
        -d "{
            \\"ChallengeName\\": \\"\$CHALLENGE_NAME\\",
            \\"ClientId\\": \\"\$COGNITO_CLIENT_ID\\",
            \\"ChallengeResponses\\": {
                \\"USERNAME\\": \\"\$USERNAME\\",
                \\"\${CHALLENGE_NAME}_CODE\\": \\"\$MFA_CODE\\"
            },
            \\"Session\\": \\"\$SESSION\\"
        }" \\
        "https://cognito-idp.\${AWS_REGION}.amazonaws.com/")
fi

# Extract JWT token (sensitive - do not log in production)
JWT_TOKEN=$(echo "\$AUTH_RESPONSE" | grep -o '"AccessToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "\$JWT_TOKEN" ]; then
    echo "Authentication failed. Please check your credentials."
    exit 1
fi

echo "Authentication successful!"
echo ""

# List available locations
echo "Fetching available locations..."
LOCATIONS_RESPONSE=$(curl -s -X GET \\
    -H "Authorization: Bearer \$JWT_TOKEN" \\
    "\${API_ENDPOINT}/locations")

echo ""
echo "Available Locations:"
echo "===================="

# Parse and display locations with numbers
declare -a LOCATION_IDS
declare -a LOCATION_NAMES
INDEX=1

echo "\$LOCATIONS_RESPONSE" | grep -o '"id":"[^"]*","name":"[^"]*"' | while IFS= read -r line; do
    LOCATION_ID_TEMP=$(echo "\$line" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    LOCATION_NAME=$(echo "\$line" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)
    echo "\$INDEX) \$LOCATION_NAME"
    LOCATION_IDS[\$INDEX]=\$LOCATION_ID_TEMP
    LOCATION_NAMES[\$INDEX]=\$LOCATION_NAME
    INDEX=\$((INDEX + 1))
done > /tmp/locations_display.txt

# Store location data for selection (id:port per line)
echo "\$LOCATIONS_RESPONSE" | grep -o '"id":"[^"]*"[^}]*"dicomPort":[0-9]*' | while IFS= read -r line; do
    LOCATION_ID_TEMP=$(echo "\$line" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    DICOM_PORT_TEMP=$(echo "\$line" | grep -o '"dicomPort":[0-9]*' | cut -d':' -f2)
    echo "\${LOCATION_ID_TEMP}:\${DICOM_PORT_TEMP:-11112}"
done > /tmp/location_ids.txt

cat /tmp/locations_display.txt
echo ""

# Get location count
LOCATION_COUNT=$(wc -l < /tmp/location_ids.txt | tr -d ' ')

read -p "Select location (1-\$LOCATION_COUNT): " LOCATION_SELECTION
echo ""

# Validate selection
if ! [[ "\$LOCATION_SELECTION" =~ ^[0-9]+$ ]] || [ "\$LOCATION_SELECTION" -lt 1 ] || [ "\$LOCATION_SELECTION" -gt "\$LOCATION_COUNT" ]; then
    echo "Invalid selection. Please run the script again."
    rm -f /tmp/locations_display.txt /tmp/location_ids.txt
    exit 1
fi

# Get selected location ID and port
LOCATION_ENTRY=$(sed -n "\${LOCATION_SELECTION}p" /tmp/location_ids.txt)
LOCATION_ID=$(echo "\$LOCATION_ENTRY" | cut -d':' -f1)
DICOM_PORT=$(echo "\$LOCATION_ENTRY" | cut -d':' -f2)
DICOM_PORT=\${DICOM_PORT:-11112}
rm -f /tmp/locations_display.txt /tmp/location_ids.txt

echo "Selected location ID: \$LOCATION_ID (DICOM port: \$DICOM_PORT)"
echo ""

# Get AWS credentials from Cognito Identity Pool
echo "Getting AWS credentials..."
# Extract ID token (sensitive - do not log)
ID_TOKEN=$(echo "\$AUTH_RESPONSE" | grep -o '"IdToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "\$ID_TOKEN" ]; then
    echo "Error: Failed to get ID token from authentication response"
    exit 1
fi

# Get Identity ID
IDENTITY_RESPONSE=$(curl -s -X POST \\
    -H "X-Amz-Target: AWSCognitoIdentityService.GetId" \\
    -H "Content-Type: application/x-amz-json-1.1" \\
    -d "{
        \\"IdentityPoolId\\": \\"\$COGNITO_IDENTITY_POOL_ID\\",
        \\"Logins\\": {
            \\"cognito-idp.\${AWS_REGION}.amazonaws.com/\${COGNITO_USER_POOL_ID}\\": \\"\$ID_TOKEN\\"
        }
    }" \\
    "https://cognito-identity.\${AWS_REGION}.amazonaws.com/")

IDENTITY_ID=$(echo "\$IDENTITY_RESPONSE" | grep -o '"IdentityId":"[^"]*"' | cut -d'"' -f4)

if [ -z "\$IDENTITY_ID" ]; then
    echo "Failed to get Identity ID"
    echo "Response: \$IDENTITY_RESPONSE"
    exit 1
fi

# Get AWS credentials
CREDENTIALS_RESPONSE=$(curl -s -X POST \\
    -H "X-Amz-Target: AWSCognitoIdentityService.GetCredentialsForIdentity" \\
    -H "Content-Type: application/x-amz-json-1.1" \\
    -d "{
        \\"IdentityId\\": \\"\$IDENTITY_ID\\",
        \\"Logins\\": {
            \\"cognito-idp.\${AWS_REGION}.amazonaws.com/\${COGNITO_USER_POOL_ID}\\": \\"\$ID_TOKEN\\"
        }
    }" \\
    "https://cognito-identity.\${AWS_REGION}.amazonaws.com/")

# Extract temporary AWS credentials (sensitive - do not log)
AWS_ACCESS_KEY_ID=$(echo "\$CREDENTIALS_RESPONSE" | grep -o '"AccessKeyId":"[^"]*"' | cut -d'"' -f4)
AWS_SECRET_ACCESS_KEY=$(echo "\$CREDENTIALS_RESPONSE" | grep -o '"SecretKey":"[^"]*"' | cut -d'"' -f4)
AWS_SESSION_TOKEN=$(echo "\$CREDENTIALS_RESPONSE" | grep -o '"SessionToken":"[^"]*"' | cut -d'"' -f4)

if [ -z "\$AWS_ACCESS_KEY_ID" ]; then
    echo "Failed to get AWS credentials"
    exit 1
fi

export AWS_ACCESS_KEY_ID
export AWS_SECRET_ACCESS_KEY
export AWS_SESSION_TOKEN
export AWS_DEFAULT_REGION=\$AWS_REGION

echo "AWS credentials obtained!"
echo ""

# Check for Podman or Docker
CONTAINER_CMD=""
COMPOSE_CMD=""

if command -v podman &> /dev/null; then
    CONTAINER_CMD="podman"
    if command -v podman-compose &> /dev/null; then
        COMPOSE_CMD="podman-compose"
    else
        # Force podman compose, not docker-compose
        COMPOSE_CMD="podman compose"
        # Disable docker-compose fallback
        export PODMAN_IGNORE_CGROUPSV1_WARNING=1
    fi
    echo "Found Podman"
elif command -v docker &> /dev/null; then
    CONTAINER_CMD="docker"
    if command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
    else
        COMPOSE_CMD="docker compose"
    fi
    echo "Found Docker"
else
    echo "Neither Podman nor Docker found. Installing Podman..."
    
    if [[ "\$OSTYPE" == "linux-gnu"* ]]; then
        if command -v apt-get &> /dev/null; then
            sudo apt-get update
            sudo apt-get install -y podman podman-compose
        elif command -v dnf &> /dev/null; then
            sudo dnf install -y podman podman-compose
        elif command -v yum &> /dev/null; then
            sudo yum install -y podman podman-compose
        else
            echo "Unsupported Linux distribution. Please install Podman manually."
            exit 1
        fi
    elif [[ "\$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            brew install podman podman-compose
            podman machine init
            podman machine start
        else
            echo "Homebrew not found. Please install Homebrew first: https://brew.sh"
            exit 1
        fi
    else
        echo "Unsupported operating system"
        exit 1
    fi
    
    CONTAINER_CMD="podman"
    COMPOSE_CMD="podman-compose"
fi

echo "Using: \$CONTAINER_CMD with \$COMPOSE_CMD"
echo ""

# Login to ECR
echo "Logging in to ECR..."
if command -v aws &> /dev/null; then
    # Unset any AWS profile and ensure we use our Cognito credentials
    unset AWS_PROFILE
    export AWS_ACCESS_KEY_ID
    export AWS_SECRET_ACCESS_KEY
    export AWS_SESSION_TOKEN
    export AWS_DEFAULT_REGION=\$AWS_REGION
    
    # Debug: verify credentials are set
    if [ -z "\$AWS_ACCESS_KEY_ID" ]; then
        echo "Error: AWS credentials not set"
        exit 1
    fi
    
    ECR_PASSWORD=$(aws ecr get-login-password --region \$AWS_REGION)
    if [ -z "\$ECR_PASSWORD" ]; then
        echo "Error: Failed to get ECR password"
        exit 1
    fi
    
    # Login to both podman and docker if available
    if [ "\$CONTAINER_CMD" = "podman" ]; then
        echo "\$ECR_PASSWORD" | podman login --username AWS --password-stdin \$ECR_REGISTRY
    fi
    
    if command -v docker &> /dev/null; then
        echo "\$ECR_PASSWORD" | docker login --username AWS --password-stdin \$ECR_REGISTRY
    fi
    
    echo "ECR login successful!"
else
    echo "Error: AWS CLI is required for ECR authentication. Please install it."
    exit 1
fi
echo ""

# Create installation directory
mkdir -p "\$INSTALL_DIR"
cd "\$INSTALL_DIR"

# Download service package
echo "Downloading service package..."
HTTP_CODE=$(curl -w "%{http_code}" -o service-package.b64 -L \\
    -H "Authorization: Bearer \$JWT_TOKEN" \\
    "\${API_ENDPOINT}/locations/\${LOCATION_ID}/certificates/dicom")

if [ "\$HTTP_CODE" != "200" ]; then
    echo "Failed to download service package (HTTP \$HTTP_CODE)"
    rm -f service-package.b64
    exit 1
fi

# Decode base64 response
if command -v base64 &> /dev/null; then
    base64 -D -i service-package.b64 -o service-package.zip 2>/dev/null || base64 -d service-package.b64 > service-package.zip
else
    echo "base64 command not found"
    exit 1
fi
rm service-package.b64

# Place encrypted config.zip in config directory (DO NOT EXTRACT)
echo "Placing encrypted config package..."
mkdir -p config
mv service-package.zip config/config.zip

# Lock the encrypted credential package to the invoking user only. It holds the
# IAM Roles Anywhere client certificate + private key; even though the archive is
# AES-encrypted, no other local account should be able to read it off the host.
# The container mounts ./config read-only as the same user, so 0600/0700 still
# lets the service read it while shutting out every other host user.
chmod 700 config
chmod 600 config/config.zip

# Create logs directory
mkdir -p logs

# Create .env file
cat > .env << ENV_FILE
# DICOM Service Configuration
DICOM_PORT=\${DICOM_PORT}
STATUS_PORT=8080
LOG_LEVEL=INFO
THREAD_COUNT=0
ENV_FILE

# Create docker-compose.yml
cat > docker-compose.yml << 'COMPOSE_FILE'
version: '3.8'

services:
  dimse-service:
    image: \${DIMSE_DOCKER_IMAGE:-${DIMSE_IMAGE_URI}}
    container_name: dicom-archive-dimse-service
    restart: unless-stopped
    ports:
      - "\${DICOM_PORT}:\${DICOM_PORT}"
      - "\${STATUS_PORT}:8080"
    volumes:
      - ./config:/app/config:ro
      - ./logs:/app/logs
      - dimse-temp:/app/in
    environment:
      - SCP_PORT=\${DICOM_PORT}
      - STATUS_PORT=8080
      - LOGLEVEL=\${LOG_LEVEL:-INFO}
      - THREADCOUNT=\${THREAD_COUNT:-0}
      - S3_TRANSFER_ACCELERATION=false
      - STORAGE_THROTTLE=1000
      - STORAGE_OOR=100
      - PYTHONUNBUFFERED=1
      - USE_IAM_ANYWHERE=true
      - AWS_REGION=${AWS_REGION}
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
COMPOSE_FILE

# Create management script
cat > dimse-service.sh << 'MGMT_SCRIPT'
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "\$SCRIPT_DIR"
if command -v podman-compose &> /dev/null; then COMPOSE_CMD="podman-compose"
elif command -v podman &> /dev/null; then COMPOSE_CMD="podman compose"
elif command -v docker-compose &> /dev/null; then COMPOSE_CMD="docker-compose"
elif command -v docker &> /dev/null; then COMPOSE_CMD="docker compose"
else echo "Error: Neither Podman nor Docker found"; exit 1; fi
case "\$1" in
  start) echo "Starting..."; \$COMPOSE_CMD up -d ;;
  stop) echo "Stopping..."; \$COMPOSE_CMD down ;;
  restart) echo "Restarting..."; \$COMPOSE_CMD restart ;;
  status) \$COMPOSE_CMD ps ;;
  logs) \$COMPOSE_CMD logs -f ;;
  update) echo "Updating..."; \$COMPOSE_CMD pull; \$COMPOSE_CMD up -d ;;
  *) echo "Usage: \$0 {start|stop|restart|status|logs|update}"; exit 1 ;;
esac
MGMT_SCRIPT
chmod +x dimse-service.sh

# Start service
echo "Starting DICOM service..."
\$COMPOSE_CMD up -d

# Save version file
echo "\$SCRIPT_VERSION" > .version

# Configure auto-start on reboot
if [[ "\$OSTYPE" == "linux-gnu"* ]]; then
    echo "Configuring systemd service..."
    sudo tee /etc/systemd/system/dicom-archive-dimse-service.service > /dev/null <<EOF
[Unit]
Description=DICOM Archive DIMSE Service
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=\$INSTALL_DIR
ExecStart=\$COMPOSE_CMD up -d
ExecStop=\$COMPOSE_CMD down
User=\$USER

[Install]
WantedBy=multi-user.target
EOF
    
    sudo systemctl daemon-reload
    sudo systemctl enable dicom-archive-dimse-service.service
    echo "Service configured to start on boot"
fi

echo ""
echo "==================================="
echo "Installation complete!"
echo "==================================="
echo "Service installed at: \$INSTALL_DIR"
echo "DICOM Port: $(grep DICOM_PORT .env | cut -d'=' -f2)"
echo "Status Port: $(grep STATUS_PORT .env | cut -d'=' -f2)"
echo ""
echo "Management commands:"
echo "  ./dimse-service.sh start"
echo "  ./dimse-service.sh stop"
echo "  ./dimse-service.sh restart"
echo "  ./dimse-service.sh status"
echo "  ./dimse-service.sh logs"
echo "  ./dimse-service.sh update"
echo ""
`;

// PowerShell script template with embedded values
const powershellScript = `# DICOM Archive DIMSE Service Installer for Windows - Auto-configured

$ErrorActionPreference = "Stop"
$SCRIPT_VERSION = "${process.env.REACT_APP_VERSION}"
$INSTALL_DIR = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { "$env:USERPROFILE\\dicom-archive-dimse-service" }

# Pre-configured values
$API_ENDPOINT = "${API_ENDPOINT}"
$AWS_REGION = "${AWS_REGION}"
$COGNITO_CLIENT_ID = "${COGNITO_CLIENT_ID}"

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

$authResponse = Invoke-RestMethod -Uri "https://cognito-idp.$AWS_REGION.amazonaws.com/" \`
    -Method Post \`
    -Headers @{
        "X-Amz-Target" = "AWSCognitoIdentityProviderService.InitiateAuth"
        "Content-Type" = "application/x-amz-json-1.1"
    } \`
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
    
    $authResponse = Invoke-RestMethod -Uri "https://cognito-idp.$AWS_REGION.amazonaws.com/" \`
        -Method Post \`
        -Headers @{
            "X-Amz-Target" = "AWSCognitoIdentityProviderService.RespondToAuthChallenge"
            "Content-Type" = "application/x-amz-json-1.1"
        } \`
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
$locationsResponse = Invoke-RestMethod -Uri "$API_ENDPOINT/locations" \`
    -Method Get \`
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
    Invoke-WebRequest -Uri "$API_ENDPOINT/locations/$LOCATION_ID/certificates/dicom" \`
        -Headers $headers \`
        -OutFile "service-package.b64"
    
    # Decode base64 response
    $base64Content = Get-Content "service-package.b64" -Raw
    $bytes = [System.Convert]::FromBase64String($base64Content)
    [System.IO.File]::WriteAllBytes("$PWD\\service-package.zip", $bytes)
    Remove-Item "service-package.b64"
} catch {
    Write-Host "Failed to download service package: $_" -ForegroundColor Red
    exit 1
}

# Place encrypted config.zip in config directory (DO NOT EXTRACT)
Write-Host "Placing encrypted config package..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "config" | Out-Null
Move-Item -Path "service-package.zip" -Destination "config\\config.zip" -Force

# Lock the encrypted credential package to the invoking user only. It holds the
# IAM Roles Anywhere client certificate + private key; even though the archive is
# AES-encrypted, no other local account should be able to read it. Break ACL
# inheritance and grant Read to just this user (SYSTEM/Administrators retain
# access implicitly as owners/root-equivalent).
icacls "config\\config.zip" /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
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
    image: \${DIMSE_DOCKER_IMAGE:-${DIMSE_IMAGE_URI}}
    container_name: dicom-archive-dimse-service
    restart: unless-stopped
    ports:
      - "\${DICOM_PORT}:\${DICOM_PORT}"
      - "\${STATUS_PORT}:8080"
    volumes:
      - ./config:/app/config:ro
      - ./logs:/app/logs
      - dimse-temp:/app/in
    environment:
      - SCP_PORT=\${DICOM_PORT}
      - STATUS_PORT=8080
      - LOGLEVEL=\${LOG_LEVEL:-INFO}
      - THREADCOUNT=\${THREAD_COUNT:-0}
      - S3_TRANSFER_ACCELERATION=false
      - STORAGE_THROTTLE=1000
      - STORAGE_OOR=100
      - PYTHONUNBUFFERED=1
      - USE_IAM_ANYWHERE=true
      - AWS_REGION=${AWS_REGION}
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
  default { Write-Host "Usage: .\\dimse-service.ps1 {start|stop|restart|status|logs|update}"; exit 1 }
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
Write-Host "  .\\dimse-service.ps1 start" -ForegroundColor White
Write-Host "  .\\dimse-service.ps1 stop" -ForegroundColor White
Write-Host "  .\\dimse-service.ps1 restart" -ForegroundColor White
Write-Host "  .\\dimse-service.ps1 status" -ForegroundColor White
Write-Host "  .\\dimse-service.ps1 logs" -ForegroundColor White
Write-Host "  .\\dimse-service.ps1 update" -ForegroundColor White
Write-Host ""
`;

// Write installer scripts
const installersDir = path.join(__dirname, '../public/installers');
fs.mkdirSync(installersDir, { recursive: true });

fs.writeFileSync(path.join(installersDir, 'install-dimse-service.sh'), bashScript, { mode: 0o755 });
fs.writeFileSync(path.join(installersDir, 'install-dimse-service.ps1'), powershellScript);

console.log('✅ Installer scripts generated successfully!');
console.log(`   - ${path.join(installersDir, 'install-dimse-service.sh')}`);
console.log(`   - ${path.join(installersDir, 'install-dimse-service.ps1')}`);
