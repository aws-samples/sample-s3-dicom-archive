#!/usr/bin/env python3
"""
Diagnostic script to check association completion state.
Run this after sending DICOM files to see the state of associations.
"""

import sys
import time

# Add current directory to path
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))

from config import ConfigManager

def main():
    print("🔍 Checking Association Completion State\n")
    
    # This would need to connect to the running service
    # For now, let's just provide guidance
    
    print("To diagnose the SQS notification issue:")
    print("1. Send DICOM files to the service")
    print("2. Watch the logs for these key messages:")
    print("   - '📥 Added pending upload' - shows files being registered")
    print("   - '✅ Upload completed' - shows files finishing upload")
    print("   - '🔒 COMPLETION HANDLER: Association closed' - shows when DICOM connection ends")
    print("   - '🔔 Attempting to send SQS notification' - shows SQS send attempt")
    print()
    print("3. Check if pending uploads count reaches 0 when association closes")
    print()
    print("Common issues:")
    print("   - If pending > 0 when closed: Files still uploading (expected)")
    print("   - If pending = 0 but no SQS: Check _send_sqs_notification logic")
    print("   - If SQS sent but not received: Check SQS queue configuration")
    print()
    print("Run: tail -f /path/to/logs | grep -E '📥|✅|🔒|🔔'")

if __name__ == '__main__':
    main()
