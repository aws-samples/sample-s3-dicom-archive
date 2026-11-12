import ipaddress
import os
import socket
import ssl
import threading
import logging
import time
from datetime import datetime

# Security: client authentication and connection limits.
#   HL7_CLIENT_CA_FILE   - PEM bundle of client CAs / pinned client certs (mTLS)
#   HL7_ALLOWED_SOURCES  - comma-separated CIDRs allowed to connect
# At least one must be configured; with neither, every connection is refused.
HL7_MAX_CONNECTIONS = int(os.environ.get('HL7_MAX_CONNECTIONS', '8'))
HL7_CLIENT_CA_FILE = os.environ.get('HL7_CLIENT_CA_FILE', '')
HL7_ALLOWED_SOURCES = [c.strip() for c in os.environ.get('HL7_ALLOWED_SOURCES', '').split(',') if c.strip()]

class HL7Server:
    """
    HL7 MLLP Server implementation.
    Up to HL7_MAX_CONNECTIONS concurrent connections, each in its own thread;
    a silent connection is closed after message_timeout.
    """
    
    # MLLP protocol constants
    MLLP_START = b'\x0b'  # Start of block
    MLLP_END = b'\x1c\x0d'  # End of block + carriage return
    
    def __init__(self, port, message_processor, tls_enabled=True, message_timeout=30, max_message_size=1048576):
        self.port = port
        self.message_processor = message_processor
        self.tls_enabled = tls_enabled
        self.message_timeout = message_timeout
        self.max_message_size = max_message_size
        self.running = False
        self.server_socket = None
        self._slots = threading.BoundedSemaphore(HL7_MAX_CONNECTIONS)
        self._allowed_networks = []
        for cidr in HL7_ALLOWED_SOURCES:
            try:
                self._allowed_networks.append(ipaddress.ip_network(cidr, strict=False))
            except ValueError:
                logging.error(f"Ignoring invalid HL7_ALLOWED_SOURCES entry: {cidr}")
        self._ssl_context = None
        if tls_enabled:
            ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            ctx.load_cert_chain('server.crt', 'server.key')
            if HL7_CLIENT_CA_FILE:
                ctx.load_verify_locations(cafile=HL7_CLIENT_CA_FILE)
                ctx.verify_mode = ssl.CERT_REQUIRED   # mTLS
            self._ssl_context = ctx
        self._mtls = bool(tls_enabled and HL7_CLIENT_CA_FILE)
        if not self._mtls and not self._allowed_networks:
            logging.error("HL7: no client authentication configured (HL7_CLIENT_CA_FILE with TLS, "
                          "or HL7_ALLOWED_SOURCES); every connection will be refused")
        
        logging.info(f"HL7Server initialized on port {port}")
        logging.info(f"TLS enabled: {tls_enabled}")
        logging.info(f"Message timeout: {message_timeout}s")
        logging.info(f"Max message size: {max_message_size} bytes")
    
    def start(self):
        """
        Start the HL7 server and listen for connections.
        """
        self.running = True
        
        try:
            # Create server socket
            self.server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)  # nosemgrep: python.lang.security.audit.network.avoid-bind-to-all-interfaces -- container listener in a private subnet behind an internal load balancer (audited)
            self.server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.server_socket.bind(('0.0.0.0', self.port))  # nosec B104 - HL7 server requires binding to all interfaces
            self.server_socket.listen(HL7_MAX_CONNECTIONS * 2)
            
            logging.info(f"HL7 server listening on port {self.port}")
            
            while self.running:
                try:
                    # Accept single connection
                    client_socket, client_address = self.server_socket.accept()
                    logging.info(f"Connection accepted from {client_address}")
                    if not self._source_allowed(client_address):
                        logging.warning(f"HL7: refusing {client_address[0]} (not authenticated / not allowed)")
                        client_socket.close()
                        continue
                    if not self._slots.acquire(blocking=False):
                        logging.warning(f"HL7: refusing {client_address[0]} (connection limit reached)")
                        client_socket.close()
                        continue
                    threading.Thread(target=self._serve_client, args=(client_socket, client_address),
                                     daemon=True).start()
                    
                except socket.error as e:
                    if self.running:
                        logging.error(f"Socket error: {e}")
                        time.sleep(1)  # Brief pause before retrying
                except Exception as e:
                    logging.error(f"Unexpected error accepting connection: {e}")
                    if self.running:
                        time.sleep(1)
        
        except Exception as e:
            logging.error(f"Failed to start HL7 server: {e}")
            raise
        finally:
            self.stop()
    
    def stop(self):
        """
        Stop the HL7 server.
        """
        logging.info("Stopping HL7 server...")
        self.running = False
        
        if self.server_socket:
            try:
                self.server_socket.close()
            except:
                pass
        
        logging.info("HL7 server stopped")
    
    def _source_allowed(self, client_address) -> bool:
        if self._mtls:
            return True                    # the TLS handshake authenticates the client
        try:
            ip = ipaddress.ip_address(client_address[0])
        except ValueError:
            return False
        return any(ip in net for net in self._allowed_networks)

    def _serve_client(self, client_socket, client_address):
        try:
            # Bound the TLS handshake too: a peer that connects and never
            # completes it must not hold a slot.
            client_socket.settimeout(self.message_timeout)
            if self._ssl_context is not None:
                try:
                    client_socket = self._ssl_context.wrap_socket(client_socket, server_side=True)
                    logging.info("TLS connection established")
                except Exception as e:
                    logging.error(f"TLS setup failed, rejecting connection: {e}")
                    client_socket.close()
                    return
            self._handle_connection(client_socket, client_address)
        finally:
            self._slots.release()

    def _handle_connection(self, client_socket, client_address):
        """
        Handle a single client connection.
        Process messages until connection is closed.
        """
        try:
            client_socket.settimeout(self.message_timeout)
            
            while self.running:
                try:
                    # Receive MLLP message
                    message_data = self._receive_mllp_message(client_socket)
                    
                    if message_data is None:
                        # Connection closed or timeout
                        break
                    
                    if len(message_data) == 0:
                        # Empty message
                        continue
                    
                    logging.debug(f"Received message of {len(message_data)} bytes")
                    
                    # Process the HL7 message
                    response = self.message_processor.process_message(message_data)
                    
                    # Send MLLP response
                    self._send_mllp_message(client_socket, response)
                    
                except socket.timeout:
                    # Security: an idle connection is closed, not kept forever.
                    logging.info(f"HL7: closing idle connection from {client_address}")
                    break
                except socket.error as e:
                    logging.info(f"Client disconnected: {e}")
                    break
                except Exception as e:
                    logging.error(f"Error processing message: {e}")
                    # Send NAK response
                    nak_response = self.message_processor.create_nak_response("Processing error")
                    try:
                        self._send_mllp_message(client_socket, nak_response)
                    except:
                        pass
                    break
        
        except Exception as e:
            logging.error(f"Error handling connection from {client_address}: {e}")
        finally:
            try:
                client_socket.close()
                logging.info(f"Connection closed for {client_address}")
            except:
                pass
    
    def _receive_mllp_message(self, client_socket):
        """
        Receive an MLLP-wrapped message from the client socket.
        
        Returns:
            bytes: The HL7 message content (without MLLP wrapper) or None if connection closed
        """
        try:
            # Look for start of block
            start_byte = client_socket.recv(1)
            if not start_byte:
                return None  # Connection closed
            
            if start_byte != self.MLLP_START:
                logging.warning(f"Invalid MLLP start byte: {start_byte}")
                return b''
            
            # Read message content until end of block
            message_data = b''
            while len(message_data) < self.max_message_size:
                chunk = client_socket.recv(1024)
                if not chunk:
                    logging.warning("Connection closed while reading message")
                    return None
                
                message_data += chunk
                
                # Check for end of block
                if message_data.endswith(self.MLLP_END):
                    # Remove the end of block marker
                    message_data = message_data[:-len(self.MLLP_END)]
                    break
            else:
                logging.error(f"Message too large: {len(message_data)} bytes")
                return b''
            
            return message_data
        
        except socket.timeout:
            raise
        except socket.error:
            raise
        except Exception as e:
            logging.error(f"Error receiving MLLP message: {e}")
            return b''
    
    def _send_mllp_message(self, client_socket, message_data):
        """
        Send an MLLP-wrapped message to the client socket.
        
        Args:
            client_socket: The client socket
            message_data (str or bytes): The HL7 message to send
        """
        try:
            if isinstance(message_data, str):
                message_data = message_data.encode('utf-8')
            
            # Wrap message with MLLP protocol
            mllp_message = self.MLLP_START + message_data + self.MLLP_END
            
            # Send the message
            client_socket.sendall(mllp_message)
            logging.debug(f"Sent MLLP message of {len(mllp_message)} bytes")
        
        except Exception as e:
            logging.error(f"Error sending MLLP message: {e}")
            raise
