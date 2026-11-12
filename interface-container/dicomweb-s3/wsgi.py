"""Gunicorn WSGI entrypoint for the multi-process (WEB_CONCURRENCY>1) model.

Gunicorn imports this module once PER FORKED WORKER, so calling bootstrap() at
import time gives every worker its own DB connection pool, S3 client and
in-process caches (QIDO, WSI-tables, frame-location). That is exactly what we
want: nothing DB-backed is shared across the fork boundary, so there are no
sockets shared between processes.

The task's total DB connection footprint is therefore
WEB_CONCURRENCY * DB_POOL_SIZE — see main.py's WEB_CONCURRENCY comment and the
CDK task definition, which size DB_POOL_SIZE down so the product stays within the
Aurora connection budget.

The single-process path (`python main.py` with WEB_CONCURRENCY<=1) does NOT use
this module; it bootstraps and serves via waitress in main.py's __main__ block.
"""
from main import app, bootstrap

# Runs in the worker process (gunicorn forks first, then imports the app).
bootstrap()

# The WSGI callable gunicorn serves.
application = app
