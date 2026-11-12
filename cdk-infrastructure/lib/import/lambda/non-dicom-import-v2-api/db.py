"""PyMySQL over the RDS Proxy (same connection pattern as dicom-encapsulator)."""
import json
import os

import boto3
import pymysql

# Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
# (rds-global-bundle.pem, shipped beside this file) instead of the old
# check_hostname-only config that supplied NO CA and therefore skipped cert
# verification entirely. PyMySQL verifies the chain once 'ca' is set; hostname
# verification is ENFORCED (check_hostname=True, verify-full): the bundle also
# trusts public roots, so skipping it would accept ANY public cert for the DB.
# DB_SSL_CA_PATH overrides the bundle location.
_RDS_CA = os.environ.get(
    "DB_SSL_CA_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-global-bundle.pem"),
)

DB_HOST = os.environ.get('DB_HOST', '')
DB_SECRET_ARN = os.environ.get('DB_SECRET_ARN', '')
DB_NAME = os.environ.get('DB_NAME', 'dicom_archive')
DB_PORT = int(os.environ.get('DB_PORT', '3306'))

_conn = None


def _connect():
    sm = boto3.client('secretsmanager')
    sec = json.loads(sm.get_secret_value(SecretId=DB_SECRET_ARN)['SecretString'])
    return pymysql.connect(
        host=DB_HOST or sec['host'],
        user=sec['username'], password=sec['password'],
        database=DB_NAME or sec.get('dbname'),
        port=DB_PORT,
        charset='utf8mb4',
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
        ssl={"ca": _RDS_CA, "check_hostname": True},
        connect_timeout=5,
        read_timeout=20,
        write_timeout=20,
    )


def get_conn():
    """Warm-container reuse: ping-and-reconnect, else a fresh connection."""
    global _conn
    if _conn is not None:
        try:
            _conn.ping(reconnect=True)
            return _conn
        except Exception:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
    _conn = _connect()
    return _conn


def query(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        return list(cur.fetchall())


def execute(conn, sql, params=None):
    with conn.cursor() as cur:
        return cur.execute(sql, params or ())


def executemany(conn, sql, rows):
    with conn.cursor() as cur:
        return cur.executemany(sql, rows)
