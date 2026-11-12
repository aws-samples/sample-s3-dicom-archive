"""Self-signed ACM certificate custom resource (cr.Provider onEvent handler).

In-VPC mode: when the operator supplies no ACM certificate ARN, this mints a
self-signed certificate for the solution's private hostname and imports it to
ACM, returning the ARN. The internal UI front-door ALB terminates TLS with it.
A self-signed cert produces browser-trust warnings; it exists so an in-VPC
deployment just works for testing. Production operators supply networkMode.certArn
for a trusted (imported or private-CA) certificate.

This is a `@aws-cdk/custom-resources` Provider onEvent handler: it RETURNS a dict
{ PhysicalResourceId, Data } and the Provider framework posts the CloudFormation
response. It must NOT post to event.ResponseURL itself (the framework strips that
field), and an unhandled exception is reported by the framework as FAILED.

Lifecycle:
  Create / Update -> generate key+cert for DomainName, import to ACM, return the
                     ARN as PhysicalResourceId (a changed DomainName yields a new
                     physical id, so CFN replaces the resource and the listener
                     swaps certs; CFN then Deletes the old physical id).
  Delete          -> delete the ACM certificate named by PhysicalResourceId.

Runs OUTSIDE the VPC (control-plane only): it reaches the ACM public API like any
non-VPC Lambda; the in-VPC posture has no ACM interface endpoint.
"""
import datetime
import boto3

acm = boto3.client("acm")


def _generate_self_signed(domain):
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domain)])
    now = datetime.datetime.utcnow()
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(domain)]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return cert_pem, key_pem


def handler(event, context):
    rtype = event["RequestType"]
    props = event.get("ResourceProperties", {}) or {}
    domain = (props.get("DomainName") or "").strip()
    physical_id = event.get("PhysicalResourceId")

    if rtype == "Delete":
        # physical_id is the ACM ARN we imported (unless a create failed before import,
        # in which case it is the framework's fallback id and names no ACM cert).
        if physical_id and physical_id.startswith("arn:") and ":acm:" in physical_id:
            try:
                acm.delete_certificate(CertificateArn=physical_id)
            except acm.exceptions.ResourceNotFoundException:
                pass
            # A cert still attached to the (being-deleted) listener can briefly block
            # delete; CloudFormation deletes the listener first, so a later retry in the
            # same stack-delete succeeds. Surface other errors.
        return {"PhysicalResourceId": physical_id}

    if not domain:
        raise ValueError("DomainName resource property is required")

    # Create, or Update (unchanged domain updates in place; a changed domain yields a
    # new ARN -> new PhysicalResourceId -> CFN replace + delete-old).
    cert_pem, key_pem = _generate_self_signed(domain)
    resp = acm.import_certificate(
        Certificate=cert_pem,
        PrivateKey=key_pem,
        Tags=[
            {"Key": "ManagedBy", "Value": "SelfSignedCertProvider"},
            {"Key": "DomainName", "Value": domain},
        ],
    )
    arn = resp["CertificateArn"]
    print(f"Imported self-signed cert for {domain}: {arn}")
    return {"PhysicalResourceId": arn, "Data": {"CertificateArn": arn}}
