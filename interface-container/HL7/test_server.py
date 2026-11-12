#!/usr/bin/env python3

"""
Simple test script to test the HL7 server with a mock client.
"""

import socket
import time
import threading
import logging
import os

# Set up environment variables for testing
os.environ['BUCKETNAME'] = 'test-hl7-bucket'
os.environ['AWS_IOT_THING_NAME'] = 'test-hl7-device'
os.environ['HL7_PORT'] = '12575'  # Use different port for testing
os.environ['LOGLEVEL'] = 'INFO'
os.environ['SENDING_FACILITIES'] = 'TEST_FACILITY'
os.environ['SENDING_APPLICATIONS'] = 'TEST_APP'
os.environ['RECEIVING_FACILITY'] = 'HL7_SERVER'
os.environ['RECEIVING_APPLICATION'] = 'HL7_RECEIVER'
os.environ['TLS_ENABLED'] = 'false'  # Disable TLS for testing

from main import main

# MLLP protocol constants
MLLP_START = b'\x0b'
MLLP_END = b'\x1c\x0d'

# Test HL7 message
TEST_MESSAGE = "MSH|^~\\&|TEST_APP|TEST_FACILITY|HL7_RECEIVER|HL7_SERVER|20231201120000||ADT^A01|TEST001|P|2.3\rEVN|A01|20231201120000\rPID|1||TEST123^^^MRN||TEST^PATIENT||19800101|M"

def send_hl7_message(host='localhost', port=12575, message=TEST_MESSAGE):
    """
    Send an HL7 message to the server using MLLP protocol.
    """
    try:
        # Create socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10)
        
        # Connect to server
        print(f"Connecting to {host}:{port}...")
        sock.connect((host, port))
        print("Connected!")
        
        # Wrap message with MLLP
        mllp_message = MLLP_START + message.encode('utf-8') + MLLP_END
        
        # Send message
        print(f"Sending message ({len(mllp_message)} bytes)...")
        sock.sendall(mllp_message)
        print("Message sent!")
        
        # Receive response
        print("Waiting for response...")
        response_data = b''
        
        # Read start byte
        start_byte = sock.recv(1)
        if start_byte == MLLP_START:
            # Read until end of message
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                response_data += chunk
                if response_data.endswith(MLLP_END):
                    response_data = response_data[:-2]  # Remove end bytes
                    break
        
        # Decode response
        response_text = response_data.decode('utf-8')
        print(f"Received response: {response_text}")
        
        # Check if it's an ACK or NAK
        if 'MSA|AA|' in response_text:
            print("✓ Received ACK - Message accepted!")
        elif 'MSA|AR|' in response_text:
            print("✗ Received NAK - Message rejected!")
        else:
            print("? Unknown response format")
        
        sock.close()
        return True
        
    except Exception as e:
        print(f"Error sending message: {e}")
        return False

def test_client():
    """
    Test client that sends messages to the server.
    """
    print("HL7 Client Test")
    print("=" * 30)
    
    # Wait for server to start
    print("Waiting for server to start...")
    time.sleep(3)
    
    # Test 1: Valid message
    print("\n1. Testing valid ADT^A01 message:")
    success = send_hl7_message()
    
    if success:
        print("✓ Test 1 completed")
    else:
        print("✗ Test 1 failed")
    
    # Test 2: Invalid facility
    print("\n2. Testing message with invalid facility:")
    invalid_message = TEST_MESSAGE.replace("TEST_FACILITY", "INVALID_FACILITY")
    success = send_hl7_message(message=invalid_message)
    
    if success:
        print("✓ Test 2 completed")
    else:
        print("✗ Test 2 failed")
    
    print("\nClient tests completed!")

def run_server():
    """
    Run the HL7 server in a separate thread.
    """
    try:
        print("Starting HL7 server...")
        main()
    except Exception as e:
        print(f"Server error: {e}")

if __name__ == "__main__":
    # Set up logging
    logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
    
    print("HL7 Server Integration Test")
    print("=" * 40)
    
    # Note: This test requires AWS credentials or will use mock services
    print("Note: This test will use mock AWS services for S3/SQS operations")
    print("Make sure you have AWS credentials configured or expect some errors")
    
    try:
        # Start server in background thread
        server_thread = threading.Thread(target=run_server)
        server_thread.daemon = True
        server_thread.start()
        
        # Run client tests
        test_client()
        
    except KeyboardInterrupt:
        print("\nTest interrupted by user")
    except Exception as e:
        print(f"Test failed: {e}")
    
    print("Integration test completed!")
