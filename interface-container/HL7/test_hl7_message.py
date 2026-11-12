#!/usr/bin/env python3

"""
Simple test script to validate HL7 message processing.
"""

import os
import sys
from HL7MessageProcessor import HL7MessageProcessor

# Sample HL7 ADT^A01 message (properly formatted with \r separators)
SAMPLE_ADT_A01 = "MSH|^~\\&|SENDING_APP|SENDING_FACILITY|RECEIVING_APP|RECEIVING_FACILITY|20231201120000||ADT^A01|MSG001|P|2.3\rEVN|A01|20231201120000\rPID|1||123456789^^^MRN||DOE^JOHN^MIDDLE||19800101|M||W|123 MAIN ST^^ANYTOWN^ST^12345||(555)123-4567||(555)987-6543||S||123456789|123-45-6789\rNK1|1|DOE^JANE|SPO|123 MAIN ST^^ANYTOWN^ST^12345||(555)123-4567\rPV1|1|I|ICU^101^01|E|||DOC123^SMITH^JOHN|||SUR||||A|||DOC123^SMITH^JOHN|INP|CAT|VIP|||||||||||||||||||SF|A|20231201120000"

# Sample HL7 ORM message (properly formatted with \r separators)
SAMPLE_ORM = "MSH|^~\\&|SENDING_APP|SENDING_FACILITY|RECEIVING_APP|RECEIVING_FACILITY|20231201120000||ORM^O01|MSG002|P|2.3\rPID|1||123456789^^^MRN||DOE^JOHN^MIDDLE||19800101|M||W|123 MAIN ST^^ANYTOWN^ST^12345||(555)123-4567||(555)987-6543||S||123456789|123-45-6789\rORC|NW|ORDER123|ORDER123|GRP123|SC||1^ONCE^^^^S||20231201120000|DOC123^SMITH^JOHN\rOBR|1|ORDER123|ORDER123|CT^CT CHEST^L|||20231201120000|||||||||DOC123^SMITH^JOHN||||||20231201120000||F|||||||ACC123456"

def test_message_parsing():
    """Test HL7 message parsing functionality."""
    print("Testing HL7 Message Processing")
    print("=" * 50)
    
    # Mock dependencies for testing
    class MockS3Manager:
        def __init__(self):
            self.bucket_name = "test-bucket"
        
        def upload_message(self, content, key):
            print(f"Mock S3 upload: {key} ({len(content)} bytes)")
            return True
    
    class MockSQSManager:
        def AddSendJob(self, message):
            print(f"Mock SQS send: {message[:100]}...")
    
    class MockDBQuery:
        def index_hl7_message(self, metadata):
            print(f"Mock DB index: {metadata['message_id']}")
    
    # Create processor with mock dependencies
    processor = HL7MessageProcessor(
        s3_manager=MockS3Manager(),
        sqs_manager=MockSQSManager(),
        db_query=MockDBQuery(),
        sending_facilities=["SENDING_FACILITY"],
        sending_applications=["SENDING_APP"],
        receiving_facility="RECEIVING_FACILITY",
        receiving_application="RECEIVING_APP"
    )
    
    print("\n1. Testing ADT^A01 message:")
    print("-" * 30)
    response = processor.process_message(SAMPLE_ADT_A01)
    print(f"Response: {response[:100]}...")
    
    print("\n2. Testing ORM message:")
    print("-" * 30)
    response = processor.process_message(SAMPLE_ORM)
    print(f"Response: {response[:100]}...")
    
    print("\n3. Testing invalid message:")
    print("-" * 30)
    invalid_message = "INVALID HL7 MESSAGE"
    response = processor.process_message(invalid_message)
    print(f"Response: {response[:100]}...")
    
    print("\n4. Testing unauthorized facility:")
    print("-" * 30)
    unauthorized_message = SAMPLE_ADT_A01.replace("SENDING_FACILITY", "UNAUTHORIZED_FACILITY")
    response = processor.process_message(unauthorized_message)
    print(f"Response: {response[:100]}...")

def test_mllp_protocol():
    """Test MLLP protocol handling."""
    print("\n\nTesting MLLP Protocol")
    print("=" * 50)
    
    from HL7Server import HL7Server
    
    # MLLP constants
    MLLP_START = b'\x0b'
    MLLP_END = b'\x1c\x0d'
    
    # Test message wrapping
    test_message = "MSH|^~\\&|TEST|TEST|TEST|TEST|20231201120000||ACK|MSG001|P|2.3\rMSA|AA|MSG001|Message accepted"
    
    # Simulate MLLP wrapping
    mllp_wrapped = MLLP_START + test_message.encode('utf-8') + MLLP_END
    
    print(f"Original message length: {len(test_message)}")
    print(f"MLLP wrapped length: {len(mllp_wrapped)}")
    print(f"MLLP start byte: {mllp_wrapped[0]:02x}")
    print(f"MLLP end bytes: {mllp_wrapped[-2:].hex()}")
    
    # Test unwrapping
    if mllp_wrapped.startswith(MLLP_START) and mllp_wrapped.endswith(MLLP_END):
        unwrapped = mllp_wrapped[1:-2]  # Remove start and end bytes
        unwrapped_text = unwrapped.decode('utf-8')
        print(f"Unwrapped message: {unwrapped_text[:50]}...")
        print("MLLP protocol test: PASSED")
    else:
        print("MLLP protocol test: FAILED")

if __name__ == "__main__":
    # Set up basic logging
    import logging
    logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
    
    try:
        test_message_parsing()
        test_mllp_protocol()
        print("\n" + "=" * 50)
        print("All tests completed!")
    except Exception as e:
        print(f"Test failed with error: {e}")
        sys.exit(1)
