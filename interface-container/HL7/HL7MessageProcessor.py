import logging
import uuid
import json
from datetime import datetime
from hl7apy.parser import parse_message
from hl7apy.core import Message
from hl7apy.exceptions import InvalidName, ChildNotFound, UnsupportedVersion

class HL7MessageProcessor:
    """
    Processes HL7 messages including validation, parsing, storage, and response generation.
    """
    
    # Supported message types
    SUPPORTED_MESSAGE_TYPES = ['ADT^A01', 'ADT^A04', 'ADT^A08', 'ORM^O01']
    
    def __init__(self, s3_manager, sqs_manager, db_query, 
                 sending_facilities=None, sending_applications=None,
                 receiving_facility="", receiving_application=""):
        self.s3_manager = s3_manager
        self.sqs_manager = sqs_manager
        self.db_query = db_query
        self.sending_facilities = sending_facilities or []
        self.sending_applications = sending_applications or []
        self.receiving_facility = receiving_facility
        self.receiving_application = receiving_application
        
        logging.info("HL7MessageProcessor initialized")
        logging.info(f"Approved sending facilities: {self.sending_facilities}")
        logging.info(f"Approved sending applications: {self.sending_applications}")
        logging.info(f"Receiving facility: {self.receiving_facility}")
        logging.info(f"Receiving application: {self.receiving_application}")
    
    def process_message(self, message_data):
        """
        Process an incoming HL7 message.
        
        Args:
            message_data (bytes): Raw HL7 message data
            
        Returns:
            str: ACK or NAK response message
        """
        try:
            # Convert bytes to string
            if isinstance(message_data, bytes):
                message_text = message_data.decode('utf-8')
            else:
                message_text = message_data
            
            logging.info("Processing HL7 message")
            logging.debug(f"Message received: length={len(message_text)} bytes")
            
            # Parse the HL7 message
            try:
                hl7_message = parse_message(message_text)
                logging.info("HL7 message parsed successfully")
            except (InvalidName, UnsupportedVersion) as e:
                logging.error(f"HL7 parsing error: {e}")
                return self.create_nak_response(f"Invalid HL7 message format: {str(e)}")
            except Exception as e:
                logging.error(f"Unexpected parsing error: {e}")
                return self.create_nak_response(f"Message parsing failed: {str(e)}")
            
            # Validate MSH segment
            validation_result = self._validate_msh_segment(hl7_message)
            if not validation_result['valid']:
                logging.warning(f"MSH validation failed: {validation_result['error']}")
                return self.create_nak_response(validation_result['error'])
            
            # Extract message metadata
            metadata = self._extract_message_metadata(hl7_message, message_text)
            
            # Check if message type is supported
            if metadata['message_type'] not in self.SUPPORTED_MESSAGE_TYPES:
                logging.warning(f"Unsupported message type: {metadata['message_type']}")
                return self.create_nak_response(f"Unsupported message type: {metadata['message_type']}")
            
            # Store message to S3
            s3_location = self._store_message_to_s3(message_text, metadata)
            if not s3_location:
                logging.error("Failed to store message to S3")
                return self.create_nak_response("Storage error")
            
            # Update metadata with S3 location
            metadata['s3_location'] = s3_location
            
            # Index message in DynamoDB
            self._index_message_in_dynamodb(metadata)
            
            # Send message metadata to SQS for serverless processing
            self._send_to_sqs(metadata)
            
            # Create ACK response
            ack_response = self.create_ack_response(hl7_message)
            logging.info("HL7 message processed successfully")
            
            return ack_response
            
        except Exception as e:
            logging.error(f"Unexpected error processing HL7 message: {e}")
            return self.create_nak_response("Internal processing error")
    
    def _validate_msh_segment(self, hl7_message):
        """
        Validate the MSH segment for sending/receiving facility and application.
        
        Args:
            hl7_message: Parsed HL7 message
            
        Returns:
            dict: {'valid': bool, 'error': str}
        """
        try:
            msh = hl7_message.msh
            
            # Extract MSH fields
            sending_application = str(msh.msh_3.value) if msh.msh_3.value else ""
            sending_facility = str(msh.msh_4.value) if msh.msh_4.value else ""
            receiving_application = str(msh.msh_5.value) if msh.msh_5.value else ""
            receiving_facility = str(msh.msh_6.value) if msh.msh_6.value else ""
            
            logging.debug(f"MSH validation - Sending App: {sending_application}, "
                         f"Sending Facility: {sending_facility}, "
                         f"Receiving App: {receiving_application}, "
                         f"Receiving Facility: {receiving_facility}")
            
            # Validate sending facility
            # Security: the approved-facility list is mandatory; an empty list
            # used to mean "accept everyone".
            if not self.sending_facilities or sending_facility not in self.sending_facilities:
                return {
                    'valid': False,
                    'error': f"Sending facility '{sending_facility}' not in approved list"
                }
            
            # Validate sending application
            if self.sending_applications and sending_application not in self.sending_applications:
                return {
                    'valid': False,
                    'error': f"Sending application '{sending_application}' not in approved list"
                }
            
            # Validate receiving facility
            if self.receiving_facility and receiving_facility != self.receiving_facility:
                return {
                    'valid': False,
                    'error': f"Receiving facility '{receiving_facility}' does not match expected '{self.receiving_facility}'"
                }
            
            # Validate receiving application
            if self.receiving_application and receiving_application != self.receiving_application:
                return {
                    'valid': False,
                    'error': f"Receiving application '{receiving_application}' does not match expected '{self.receiving_application}'"
                }
            
            return {'valid': True, 'error': None}
            
        except Exception as e:
            logging.error(f"Error validating MSH segment: {e}")
            return {'valid': False, 'error': f"MSH validation error: {str(e)}"}
    
    def _extract_message_metadata(self, hl7_message, message_text):
        """
        Extract metadata from the HL7 message.
        
        Args:
            hl7_message: Parsed HL7 message
            message_text: Raw message text
            
        Returns:
            dict: Message metadata
        """
        metadata = {
            'timestamp': datetime.utcnow().isoformat(),
            'message_id': str(uuid.uuid4()),
            'message_size': len(message_text),
            'patient_id': None,
            'accession_number': None,
            'message_type': None,
            's3_location': None
        }
        
        try:
            # Extract message type from MSH
            msh = hl7_message.msh
            message_type = f"{msh.msh_9.msh_9_1.value}^{msh.msh_9.msh_9_2.value}"
            metadata['message_type'] = message_type
            
            # Extract Patient ID from PID segment
            try:
                pid = hl7_message.pid
                if pid and pid.pid_3:
                    # PID.3 can have multiple patient identifiers
                    patient_id = str(pid.pid_3.pid_3_1.value) if pid.pid_3.pid_3_1.value else None
                    metadata['patient_id'] = patient_id
                    # PHI: never log the patient ID value itself, only presence.
                    logging.debug("Patient ID extracted: %s", "present" if patient_id else "absent")
            except (ChildNotFound, AttributeError):
                logging.debug("No PID segment found or no patient ID available")
            
            # Extract Accession Number (varies by message type)
            try:
                if message_type.startswith('ORM'):
                    # For ORM messages, check OBR segment
                    obr = hl7_message.obr
                    if obr and obr.obr_18:
                        accession_number = str(obr.obr_18.value) if obr.obr_18.value else None
                        metadata['accession_number'] = accession_number
                        # PHI: log presence only, not the accession number value.
                        logging.debug("Accession number extracted from OBR: %s", "present" if accession_number else "absent")
                # For other message types, accession number might be in different segments
                # This can be extended based on specific requirements
            except (ChildNotFound, AttributeError):
                logging.debug("No accession number found")
            
            # PHI: the metadata dict holds patient ID / accession number — log
            # only which keys were populated, never their values.
            logging.info("Extracted metadata fields: %s", sorted(metadata.keys()))
            
        except Exception as e:
            logging.error(f"Error extracting message metadata: {type(e).__name__}")
        
        return metadata
    
    def _store_message_to_s3(self, message_text, metadata):
        """
        Store the raw HL7 message to S3.
        
        Args:
            message_text (str): Raw HL7 message
            metadata (dict): Message metadata
            
        Returns:
            str: S3 location (bucket/key) or None if failed
        """
        try:
            # Create S3 key based on timestamp and message ID
            timestamp = datetime.utcnow()
            s3_key = f"hl7/{timestamp.year}/{timestamp.month:02d}/{timestamp.day:02d}/{metadata['message_id']}.hl7"
            
            # Store message
            success = self.s3_manager.upload_message(message_text, s3_key)
            
            if success:
                s3_location = f"{self.s3_manager.bucket_name}/{s3_key}"
                logging.info(f"Message stored to S3: {s3_location}")
                return s3_location
            else:
                logging.error("Failed to upload message to S3")
                return None
                
        except Exception as e:
            logging.error(f"Error storing message to S3: {e}")
            return None
    
    def _index_message_in_dynamodb(self, metadata):
        """
        Index message metadata in DynamoDB.
        
        Args:
            metadata (dict): Message metadata
        """
        try:
            # This would be implemented based on your DynamoDB schema
            # For now, we'll log the action
            logging.info(f"Indexing message in DynamoDB: {metadata['message_id']}")
            
            # Example implementation:
            # self.db_query.index_hl7_message(metadata)
            
        except Exception as e:
            logging.error(f"Error indexing message in DynamoDB: {e}")
    
    def _send_to_sqs(self, metadata):
        """
        Send message metadata to SQS for serverless processing.
        
        Args:
            metadata (dict): Message metadata
        """
        try:
            sqs_message = {
                'message_type': 'hl7_message_received',
                'metadata': metadata
            }
            
            self.sqs_manager.AddSendJob(json.dumps(sqs_message))
            logging.info(f"Message metadata sent to SQS: {metadata['message_id']}")
            
        except Exception as e:
            logging.error(f"Error sending message to SQS: {e}")
    
    def create_ack_response(self, hl7_message):
        """
        Create an ACK response for a valid HL7 message.
        
        Args:
            hl7_message: Parsed HL7 message
            
        Returns:
            str: ACK response message
        """
        try:
            msh = hl7_message.msh
            
            # Create ACK message
            ack_message = f"MSH|^~\\&|{self.receiving_application}|{self.receiving_facility}|{msh.msh_3.value}|{msh.msh_4.value}|{datetime.now().strftime('%Y%m%d%H%M%S')}||ACK^{msh.msh_9.msh_9_2.value}|{str(uuid.uuid4())[:8]}|P|2.3\r"
            ack_message += f"MSA|AA|{msh.msh_10.value}|Message accepted\r"
            
            logging.debug(f"Created ACK response: {ack_message}")
            return ack_message
            
        except Exception as e:
            logging.error(f"Error creating ACK response: {e}")
            return self.create_nak_response("Error creating ACK")
    
    def create_nak_response(self, error_message):
        """
        Create a NAK response for an invalid HL7 message.
        
        Args:
            error_message (str): Error description
            
        Returns:
            str: NAK response message
        """
        try:
            timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
            control_id = str(uuid.uuid4())[:8]
            
            nak_message = f"MSH|^~\\&|{self.receiving_application}|{self.receiving_facility}|||{timestamp}||ACK|{control_id}|P|2.3\r"
            nak_message += f"MSA|AR|{control_id}|{error_message}\r"
            
            logging.debug(f"Created NAK response: {nak_message}")
            return nak_message
            
        except Exception as e:
            logging.error(f"Error creating NAK response: {e}")
            # Return a basic NAK if we can't create a proper one
            return "MSH|^~\\&||||||||ACK||P|2.3\rMSA|AR||Message rejected\r"
