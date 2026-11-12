"""
MySQL Connection Factory adapted for AWS Secrets Manager

This module owns every piece of DB-configuration truth for the service. The
reference service branched on `if 'DB_HOST' in os.environ` and then demanded all
five of DB_HOST/DB_USER/DB_PASSWORD/DB_NAME/DB_PORT, which forces a plaintext
database password into the ECS task definition. Here credentials come only from
Secrets Manager; the environment may override the non-secret coordinates
(host/port/database) so the CDK can point the task at the cluster endpoint.
"""
import json
import logging
import os
import time
from contextlib import contextmanager

import boto3
import pymysql
import pymysql.cursors
from dbutils.pooled_db import PooledDB

logger = logging.getLogger(__name__)

# Verify the Aurora/RDS-Proxy server cert against the bundled Amazon RDS CA
# (rds-global-bundle.pem, COPYed into the image beside this module) instead of
# the old check_hostname-only config that supplied NO CA and skipped cert
# verification. PyMySQL verifies the chain once 'ca' is set; hostname check
# stays off (verify-ca). DB_SSL_CA_PATH overrides the location.
_RDS_CA = os.environ.get(
    "DB_SSL_CA_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "rds-global-bundle.pem"),
)

DB_POOL_SIZE = int(os.environ.get('DB_POOL_SIZE', '32'))

# Per-connection server-side statement timeout (milliseconds), applied once to
# every pooled connection via SET SESSION. This is the backstop that prevents a
# single expensive QIDO read from running for hours: MySQL aborts the statement
# server-side at this cap and returns error 3024 to the client. It is a hard
# safety net independent of the RDS parameter group (which we cannot modify on a
# default PG) and of SUPER/GLOBAL privileges (SESSION scope needs neither).
#
# It affects ONLY read-only SELECTs (max_execution_time is SELECT-only by
# design), so it can never abort an ingest write. Set to 0 to disable. Default
# 20s: comfortably above every intended QIDO/WADO query (all sub-second on the
# optimal plans) yet far below the multi-hour runaway that wedged the writer on
# 2026-09-28 behind stacked correlated scans of the 160M-row instance table.
DB_STMT_TIMEOUT_MS = int(os.environ.get('DB_STMT_TIMEOUT_MS', '20000'))

sql_pool = None
_db_config = None


def resolve_db_config() -> dict:
    """{'host','port','user','password','db'} - the single source of DB truth.

    The secret is read once and memoized: it is fetched on the request path the
    first time only, and re-reading it per connection would add a Secrets Manager
    call to every pool refill.
    """
    global _db_config

    if _db_config is not None:
        return _db_config

    secret_arn = (os.environ.get('DB_SECRET_ARN') or '').strip()
    if not secret_arn:
        raise ValueError(
            "DB_SECRET_ARN is required. Database credentials are never read from "
            "the environment, so there is no fallback."
        )

    region = os.environ.get('AWS_REGION', 'us-east-1')
    client = boto3.client('secretsmanager', region_name=region)
    secret = json.loads(client.get_secret_value(SecretId=secret_arn)['SecretString'])

    # The environment may relocate the endpoint (the CDK passes the cluster
    # writer endpoint, which can differ from the value baked into the secret),
    # but never the credentials.
    host = (os.environ.get('DB_HOST') or '').strip() or secret.get('host')
    port = int(os.environ.get('DB_PORT') or secret.get('port') or 3306)
    database = (os.environ.get('DB_NAME') or '').strip() or secret.get('dbname')
    user = secret.get('username')
    password = secret.get('password')

    missing = [name for name, value in (('host', host), ('db', database),
                                        ('user', user), ('password', password))
               if not value]
    if missing:
        raise ValueError(f"Incomplete database configuration, missing: {', '.join(missing)}")

    _db_config = {
        'host': host,
        'port': port,
        'user': user,
        'password': password,
        'db': database,
    }
    logger.info("Resolved database configuration for %s:%d/%s", host, port, database)
    return _db_config


def init_connection_pool():
    """Initialize the MySQL connection pool. Idempotent."""
    global sql_pool

    if sql_pool is not None:
        return sql_pool

    cfg = resolve_db_config()

    # Run once per newly-created pooled connection. SET SESSION max_execution_time
    # caps every SELECT on this connection server-side (see DB_STMT_TIMEOUT_MS).
    # Empty when disabled (0), so the pool behaves exactly as before.
    setsession = []
    if DB_STMT_TIMEOUT_MS > 0:
        setsession.append(f"SET SESSION max_execution_time={DB_STMT_TIMEOUT_MS}")

    try:
        sql_pool = PooledDB(
            pymysql,
            maxconnections=DB_POOL_SIZE,
            mincached=2,
            blocking=True,                          # block instead of raising when the pool is full
            cursorclass=pymysql.cursors.DictCursor,  # every query reads row['col'] by name
            setsession=setsession,                  # per-connection SET SESSION statements (stmt timeout)
            host=cfg['host'],
            port=cfg['port'],
            user=cfg['user'],
            password=cfg['password'],
            db=cfg['db'],
            autocommit=True,                        # read-only service; avoids long-held transactions
            charset='utf8mb4',                      # tables are utf8mb4_unicode_ci; omitting it mojibakes non-ASCII names
            # Aurora MySQL 8's default auth plugin (caching_sha2_password) needs
            # TLS for the full-auth path, which is what runs on any fast-auth
            # cache miss. Verify the server chain against the bundled Amazon RDS
            # CA (verify-ca); hostname check stays off since we connect by the
            # private endpoint DNS.
            ssl={"ca": _RDS_CA, "check_hostname": True},
        )
    except pymysql.MySQLError as err:
        # PyMySQL surfaces errno via err.args[0]
        errno = err.args[0] if err.args else None
        if errno == 1045:
            logger.error("Access denied: bad username or password")
        elif errno == 1049:
            logger.error("Database '%s' does not exist", cfg['db'])
        else:
            logger.error("MySQL pool init error: %s", err)
        raise

    logger.info("MySQL connection pool initialized with %d connections", DB_POOL_SIZE)
    return sql_pool


def get_connection():
    """Get a connection from the pool"""
    global sql_pool
    if sql_pool is None:
        init_connection_pool()
    return sql_pool.connection()


def _is_auth_error(err):
    """ER_ACCESS_DENIED_ERROR (1045): the DB password was rotated since the pool
    cached it."""
    return isinstance(err, pymysql.MySQLError) and bool(err.args) and err.args[0] == 1045


def reset_connection_pool():
    """Forget the cached credentials and pool so the next connection re-reads the
    secret. Called after a password rotation (1045)."""
    global sql_pool, _db_config
    old = sql_pool
    sql_pool = None
    _db_config = None
    if old is not None:
        try:
            old.close()
        except Exception:  # best effort
            pass


def connection_with_rotation_retry():
    """A pooled connection. On an authentication failure (rotated password) the
    pool is reset once and the connection retried with freshly read credentials."""
    try:
        return get_connection()
    except Exception as err:
        if not _is_auth_error(err):
            raise
        logger.warning("DB authentication failed; re-reading the DB secret (password rotation)")
        reset_connection_pool()
        return get_connection()


@contextmanager
def get_db_connection(retries=3, delay=0.1):
    """Context manager that guarantees connection is returned to pool, with retry on exhaustion.
    An authentication failure (rotated password) resets the pool once and retries
    with freshly read credentials."""
    for attempt in range(retries):
        try:
            conn = connection_with_rotation_retry()
            break
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(delay * (2 ** attempt))
    try:
        yield conn
    finally:
        conn.close()
