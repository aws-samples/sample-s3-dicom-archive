# HL7 Server Container

> **PHI / HIPAA notice:** This service receives and indexes HL7 messages that
> contain Protected Health Information (patient demographics, identifiers,
> accession numbers). Operating it compliantly is a customer responsibility —
> see [`PHI-HANDLING.md`](../../PHI-HANDLING.md) at the repository root.

A containerized HL7 server built with Python 3.13 for integration with the DICOM Archive project. This server receives, processes, and forwards HL7 messages while integrating with AWS services for storage and messaging.

## Overview

This HL7 server is designed to work as part of a larger DICOM archive system, providing HL7 message processing capabilities that complement the DICOM listener functionality. The server is deployed as an AWS Fargate container and follows the same architectural patterns as the DICOM server component.

The server implements a single-connection, single-threaded HL7 interface per port, focusing on message validation, patient demographic synchronization, and secure storage of HL7 messages.

## Features

- **HL7 Message Processing**: Receives and processes HL7 v2.3+ messages using HL7apy library
- **Message Validation**: MSH segment validation for sending/receiving facility and application IDs
- **Patient Demographics Sync**: Extracts PID segments to maintain patient data consistency across imaging sets
- **AWS Integration**: Seamless integration with S3 for storage, SQS for message queuing, and DynamoDB for indexing
- **TLS/SSL Support**: Secure HL7 message transmission
- **Single Connection Architecture**: One connection per port, monothreaded processing
- **Flexible Configuration**: Environment variable-based configuration for different deployment scenarios
- **Health Monitoring**: Built-in health checks and monitoring capabilities
- **Logging**: Configurable logging levels with structured output
- **Container Ready**: Optimized for AWS Fargate deployment with 2GB memory allocation

## Architecture

The HL7 server follows a modular architecture similar to the DICOM listener:

```
HL7 Server
├── Message Receiver (MLLP/TCP)
├── Message Parser & Validator
├── Processing Engine
├── AWS Integration Layer
│   ├── S3 Storage Manager
│   ├── SQS Message Manager
│   └── Database Query Interface
└── Monitoring & Logging
```

## Configuration

The server is configured through environment variables, supporting both standalone and AWS Greengrass deployment modes.

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `BUCKETNAME` | S3 bucket for message storage | `my-hl7-archive-bucket` |
| `AWS_IOT_THING_NAME` | Edge device identifier | `hl7-edge-001` |
| `HL7_PORT` | Port for HL7 MLLP listener | `2575` |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOGLEVEL` | `INFO` | Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL) |
| `THREADCOUNT` | `1` | Single-threaded processing (fixed at 1) |
| `S3_TRANSFER_ACCELERATION` | `false` | Enable S3 transfer acceleration |
| `STORAGE_THROTTLE` | `1000` | Storage throttling threshold |
| `STORAGE_OOR` | `100` | Out-of-range storage limit |
| `MESSAGE_TIMEOUT` | `30` | HL7 message timeout in seconds |
| `MAX_MESSAGE_SIZE` | `1048576` | Maximum message size in bytes (1MB) |
| `TLS_ENABLED` | `true` | Enable TLS/SSL for HL7 connections |
| `SENDING_FACILITIES` | `""` | Comma-separated list of approved sending facilities |
| `SENDING_APPLICATIONS` | `""` | Comma-separated list of approved sending applications |
| `RECEIVING_FACILITY` | `""` | Configured receiving facility ID |
| `RECEIVING_APPLICATION` | `""` | Configured receiving application ID |

## HL7 Message Support

The server supports HL7 v2.3+ messages with the following capabilities:

### Supported Message Types
- **ADT^A01** (Admit Patient)
- **ADT^A04** (Register Patient)
- **ADT^A08** (Update Patient Information)
- **ORM** (Order Messages)

### Message Processing Flow
1. **Reception**: Messages received via MLLP over TCP (single connection per port)
2. **MSH Validation**: Validates sending facility, sending application, receiving facility, and receiving application IDs
3. **Syntax Validation**: Ensures HL7 message structure is valid (v2.3+)
4. **PID Extraction**: Extracts Patient ID from PID segment for demographic synchronization
5. **Storage**: Archive raw messages to S3 with metadata indexing in DynamoDB
6. **Routing**: Forward message metadata to serverless processing via SQS Extended Client
7. **Acknowledgment**: Send ACK for valid messages, NAK for malformed messages

### Message Validation Rules
- **ACK Response**: Sent when message syntax is valid AND MSH segment parameters are validated
- **NAK Response**: Sent for malformed messages or invalid MSH parameters
- **MSH Segment Validation**:
  - Sending Facility ID must be in approved list
  - Sending Application ID must be in approved list
  - Receiving Facility ID must match configured service identity
  - Receiving Application ID must match configured service identity

### Patient Demographics Synchronization
- Extracts Patient ID from PID segment
- Ensures demographic consistency across all imaging sets sharing the same Patient ID
- Correlates HL7 messages with DICOM studies via Patient ID matching

### Message Storage and Indexing
- **S3 Storage**: Raw HL7 messages stored without compression
- **DynamoDB Indexing**: Message metadata indexed with the following fields:
  - Timestamp (message received time)
  - S3 Location (bucket/key path)
  - Patient ID (extracted from PID segment, if available)
  - Accession Number (if available)
  - Message Type (ADT^A01, ADT^A04, ADT^A08, ORM)
- **SQS Extended Client**: Used for large message handling to serverless architecture
| `MESSAGE_TIMEOUT` | `30` | HL7 message timeout in seconds |
| `MAX_MESSAGE_SIZE` | `1048576` | Maximum message size in bytes (1MB) |

### AWS Credentials

Credentials always come from an **IAM role** through the default AWS credential
chain: the ECS task role, the Greengrass token exchange role, or IAM Roles
Anywhere. Do not configure long-lived access keys.

- `REGION_NAME` / `AWS_REGION` - AWS Region (`AWS_REGION` is provided automatically by Greengrass and ECS)

Static keys in `AWS_ACCESS_KEY` / `AWS_SECRET_KEY` are **ignored** unless
`HL7_ALLOW_STATIC_CREDENTIALS=true` is set explicitly. That opt-in exists only
for isolated local testing with short-lived, least-privilege credentials; never
use it in a deployment.

## Deployment

### Docker Build

```bash
docker build -t hl7-server:latest .
```

### Local Development

```bash
# Set environment variables
export BUCKETNAME=my-test-bucket
export AWS_IOT_THING_NAME=hl7-dev-001
export HL7_PORT=2575
export LOGLEVEL=DEBUG

# Run locally
python3 main.py
```

### AWS Fargate Deployment

The container is designed for deployment on AWS Fargate with the following specifications:

- **CPU**: 0.25 - 1.0 vCPU (configurable based on load)
- **Memory**: 512MB - 2GB (configurable based on message volume)
- **Network**: VPC with appropriate security groups
- **Storage**: Ephemeral storage for temporary message processing
- **Architecture**: Single connection per port, monothreaded processing

### Task Definition Example

```json
{
  "family": "hl7-server",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::ACCOUNT:role/hl7-server-task-role",
  "containerDefinitions": [
    {
      "name": "hl7-server",
      "image": "your-account.dkr.ecr.region.amazonaws.com/hl7-server:latest",
      "portMappings": [
        {
          "containerPort": 2575,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "BUCKETNAME", "value": "your-hl7-bucket"},
        {"name": "AWS_IOT_THING_NAME", "value": "hl7-fargate-001"},
        {"name": "HL7_PORT", "value": "2575"},
        {"name": "LOGLEVEL", "value": "INFO"},
        {"name": "TLS_ENABLED", "value": "true"},
        {"name": "THREADCOUNT", "value": "1"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/hl7-server",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

## HL7 Message Support

The server supports HL7 v2.x messages with the following capabilities:

### Supported Message Types
- **ADT** (Admit, Discharge, Transfer)
- **ORM** (Order Messages)
- **ORU** (Observation Result)
- **SIU** (Scheduling Information)
- **MDM** (Medical Document Management)

### Message Processing Flow
1. **Reception**: Messages received via MLLP over TCP
2. **Validation**: HL7 structure and content validation
3. **Parsing**: Extract relevant fields and metadata
4. **Storage**: Archive to S3 with metadata indexing
5. **Routing**: Forward to appropriate downstream systems via SQS
6. **Acknowledgment**: Send appropriate ACK/NAK responses

## Integration with DICOM Archive

The HL7 server integrates with the larger DICOM archive project by:

- **Shared Storage**: Using the same S3 bucket structure for consistent archiving
- **Message Correlation**: Linking HL7 messages with DICOM studies via patient/study identifiers
- **Unified Monitoring**: Leveraging the same CloudWatch logging and monitoring infrastructure
- **Database Integration**: Sharing metadata database for cross-referencing HL7 and DICOM data

## Monitoring and Logging

### Health Checks
- **Container Health**: Built-in Docker health check on HL7 port
- **Application Health**: Internal health monitoring with configurable intervals
- **AWS Health**: Integration with ECS health checks

### Logging
- **Structured Logging**: JSON-formatted logs for easy parsing
- **CloudWatch Integration**: Automatic log forwarding to CloudWatch Logs
- **Log Levels**: Configurable verbosity for different environments

## Security Considerations

- **Network Security**: Runs in private VPC subnets
- **IAM Roles**: Least-privilege access to AWS services
- **Message Encryption**: HL7 messages encrypted at rest in S3
- **Transport Security**: Support for TLS encryption for HL7 connections
- **Container Security**: Non-root user execution, minimal base image

## Development

### Prerequisites
- Python 3.13+
- Docker
- AWS CLI configured
- Access to test HL7 systems

### Local Development Setup

```bash
# Clone the repository
git clone <repository-url>
cd hl7-server

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Run tests
python -m pytest tests/

# Start development server
python main.py
```

### Testing

The project includes comprehensive testing:

- **Unit Tests**: Individual component testing
- **Integration Tests**: AWS service integration testing
- **HL7 Message Tests**: Sample message processing validation
- **Performance Tests**: Load testing with concurrent connections

## Troubleshooting

### Common Issues

1. **Connection Refused**: Check HL7_PORT configuration and security groups
2. **AWS Permissions**: Verify IAM roles have necessary S3 and SQS permissions
3. **Message Parsing Errors**: Validate HL7 message format and encoding
4. **Storage Issues**: Check S3 bucket permissions and regional configuration

### Debug Mode

Enable debug logging for detailed troubleshooting:

```bash
export LOGLEVEL=DEBUG
python main.py
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

This project is part of the DICOM Archive system and follows the same licensing terms.

## Support

For issues and questions:
- Check the troubleshooting section
- Review CloudWatch logs
- Contact the development team

---

**Note**: This HL7 server is designed to work in conjunction with the DICOM listener component. Ensure both services are properly configured and deployed for full archive functionality.
