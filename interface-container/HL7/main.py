#!/usr/bin/env python3

import os
import sys
import logging
import time
import socket
import threading
from datetime import datetime
import collections
import json
import uuid

from hl7apy.parser import parse_message
from hl7apy.core import Message
from hl7apy.exceptions import InvalidName, ChildNotFound

from SQSManager import SQSManager
from S3FileManager import S3FileManager
from DBQuery import DBQuery
from HL7MessageProcessor import HL7MessageProcessor
from HL7Server import HL7Server

# Global variables
EdgeId = None
bucketname = None
hl7_port = 2575
mode = None  # 'greengrass' or 'standalone'
ThreadCount = 1
s3_transfer_acceleration = False
message_timeout = 30
max_message_size = 1048576
tls_enabled = True
sending_facilities = []
sending_applications = []
receiving_facility = ""
receiving_application = ""

# Message queues
HL7Incoming = collections.deque([])

def setLogLevel():
    """
    Set the log level based on the LOGLEVEL environment variable.
    If not provided or invalid, defaults to INFO.
    
    Supported levels: ERROR, WARNING, INFO, DEBUG, CRITICAL
    """
    try:
        loglevel = os.environ["LOGLEVEL"]
        if loglevel.upper() == "INFO":
            logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
            return
        if loglevel.upper() == "WARNING":
            logging.basicConfig(level=logging.WARNING, format='%(asctime)s - %(levelname)s - %(message)s')
            return
        if loglevel.upper() == "ERROR":
            logging.basicConfig(level=logging.ERROR, format='%(asctime)s - %(levelname)s - %(message)s')
            return
        if loglevel.upper() == "DEBUG":
            logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
            return
        if loglevel.upper() == "CRITICAL":
            logging.basicConfig(level=logging.CRITICAL, format='%(asctime)s - %(levelname)s - %(message)s')
            return
        # Default to INFO if no match
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
    except:
        logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def load_configuration():
    """
    Load configuration from environment variables.
    """
    global EdgeId, bucketname, hl7_port, mode, ThreadCount, s3_transfer_acceleration
    global message_timeout, max_message_size, tls_enabled
    global sending_facilities, sending_applications, receiving_facility, receiving_application
    
    logging.info("Loading configuration from environment variables...")
    
    # Required variables
    try:
        bucketname = os.environ['BUCKETNAME']
        logging.info(f"S3 Bucket: {bucketname}")
    except KeyError:
        logging.error("BUCKETNAME environment variable is required")
        sys.exit("Exiting: No BUCKETNAME environment variable defined.")
    
    try:
        EdgeId = os.environ['AWS_IOT_THING_NAME']
        logging.info(f"Edge ID: {EdgeId}")
    except KeyError:
        logging.error("AWS_IOT_THING_NAME environment variable is required")
        sys.exit("Exiting: No AWS_IOT_THING_NAME environment variable defined.")
    
    # Optional variables with defaults
    try:
        hl7_port = int(os.environ['HL7_PORT'])
        logging.info(f"HL7 Port: {hl7_port}")
    except (KeyError, ValueError):
        logging.warning(f"No valid HL7_PORT provided, defaulting to {hl7_port}")
    
    try:
        ThreadCount = int(os.environ['THREADCOUNT'])
        if ThreadCount <= 0:
            ThreadCount = 1
        logging.info(f"Thread Count: {ThreadCount}")
    except (KeyError, ValueError):
        logging.warning(f"Defaulting to {ThreadCount} thread (single-threaded)")
    
    # AWS credentials detection
    try:
        aws_access_key = os.environ['AWS_ACCESS_KEY']
        aws_secret_key = os.environ['AWS_SECRET_KEY']
        mode = 'standalone'
        logging.info("Running in standalone mode with explicit AWS credentials")
    except KeyError:
        mode = 'greengrass'
        logging.info("Running in Greengrass mode with IAM roles")
    
    # S3 transfer acceleration
    try:
        if os.environ['S3_TRANSFER_ACCELERATION'].lower() in ("yes", "true", "t", "1"):
            s3_transfer_acceleration = True
            logging.info("S3 transfer acceleration enabled")
    except KeyError:
        logging.info("S3 transfer acceleration disabled (default)")
    
    # Message processing settings
    try:
        message_timeout = int(os.environ['MESSAGE_TIMEOUT'])
        logging.info(f"Message timeout: {message_timeout} seconds")
    except (KeyError, ValueError):
        logging.info(f"Message timeout defaulting to {message_timeout} seconds")
    
    try:
        max_message_size = int(os.environ['MAX_MESSAGE_SIZE'])
        logging.info(f"Max message size: {max_message_size} bytes")
    except (KeyError, ValueError):
        logging.info(f"Max message size defaulting to {max_message_size} bytes")
    
    # TLS settings
    try:
        tls_enabled = os.environ['TLS_ENABLED'].lower() in ("yes", "true", "t", "1")
        logging.info(f"TLS enabled: {tls_enabled}")
    except KeyError:
        logging.info(f"TLS enabled defaulting to {tls_enabled}")
    
    # MSH validation settings
    try:
        facilities = os.environ['SENDING_FACILITIES']
        sending_facilities = [f.strip() for f in facilities.split(',') if f.strip()]
        logging.info(f"Approved sending facilities: {sending_facilities}")
    except KeyError:
        logging.warning("No SENDING_FACILITIES configured - all facilities will be accepted")
    
    try:
        applications = os.environ['SENDING_APPLICATIONS']
        sending_applications = [a.strip() for a in applications.split(',') if a.strip()]
        logging.info(f"Approved sending applications: {sending_applications}")
    except KeyError:
        logging.warning("No SENDING_APPLICATIONS configured - all applications will be accepted")
    
    try:
        receiving_facility = os.environ['RECEIVING_FACILITY']
        logging.info(f"Receiving facility: {receiving_facility}")
    except KeyError:
        logging.warning("No RECEIVING_FACILITY configured")
    
    try:
        receiving_application = os.environ['RECEIVING_APPLICATION']
        logging.info(f"Receiving application: {receiving_application}")
    except KeyError:
        logging.warning("No RECEIVING_APPLICATION configured")

def initialize_services():
    """
    Initialize AWS services and database connections.
    """
    logging.info("Initializing services...")
    
    # Initialize database interface
    try:
        db_query = DBQuery(EdgeId)
        logging.info("Database interface initialized")
    except Exception as e:
        logging.error(f"Failed to initialize database interface: {e}")
        return None
    
    # Initialize S3 file manager
    try:
        s3_manager = S3FileManager(
            bucket_name=bucketname,
            edge_id=EdgeId,
            transfer_acceleration=s3_transfer_acceleration
        )
        logging.info("S3 file manager initialized")
    except Exception as e:
        logging.error(f"Failed to initialize S3 file manager: {e}")
        return None
    
    # Initialize SQS manager
    try:
        sqs_manager = SQSManager(
            edge_id=EdgeId,
            queue_name="hl7_messages",
            sqs_bucket=bucketname
        )
        logging.info("SQS manager initialized")
    except Exception as e:
        logging.error(f"Failed to initialize SQS manager: {e}")
        return None
    
    return {
        'db_query': db_query,
        's3_manager': s3_manager,
        'sqs_manager': sqs_manager
    }

def main():
    """
    Main application entry point.
    """
    print("Starting HL7 Server Container...")
    print("=" * 50)
    
    # Set up logging
    setLogLevel()
    
    logging.info("HL7 Server Container starting up...")
    logging.info("=" * 50)
    
    # Load configuration
    load_configuration()
    
    # Log only the NAMES of the environment variables present, never their
    # values. The previous substring redaction (KEY/SECRET/PASSWORD) still
    # dumped everything else in clear text — tokens, endpoints, connection
    # strings, DB coordinates — at DEBUG. Names alone are enough to debug config.
    logging.debug("Environment variable names present: %s", sorted(os.environ.keys()))
    
    # Initialize services
    services = initialize_services()
    if not services:
        logging.error("Failed to initialize required services")
        sys.exit(1)
    
    # Initialize HL7 message processor
    try:
        message_processor = HL7MessageProcessor(
            s3_manager=services['s3_manager'],
            sqs_manager=services['sqs_manager'],
            db_query=services['db_query'],
            sending_facilities=sending_facilities,
            sending_applications=sending_applications,
            receiving_facility=receiving_facility,
            receiving_application=receiving_application
        )
        logging.info("HL7 message processor initialized")
    except Exception as e:
        logging.error(f"Failed to initialize HL7 message processor: {e}")
        sys.exit(1)
    
    # Initialize and start HL7 server
    try:
        hl7_server = HL7Server(
            port=hl7_port,
            message_processor=message_processor,
            tls_enabled=tls_enabled,
            message_timeout=message_timeout,
            max_message_size=max_message_size
        )
        
        logging.info(f"Starting HL7 server on port {hl7_port}")
        logging.info(f"TLS enabled: {tls_enabled}")
        logging.info(f"Single-threaded processing mode")
        
        # Start the server (this will block)
        hl7_server.start()
        
    except KeyboardInterrupt:
        logging.info("Received shutdown signal")
    except Exception as e:
        logging.error(f"HL7 server error: {e}")
        sys.exit(1)
    finally:
        logging.info("HL7 Server shutting down...")

if __name__ == "__main__":
    main()
