"""
Authentication Middleware for the S3-native DICOMweb service

Handles OIDC token verification, datastore resolution and datastore-scoped
authorization for every /dicomweb/{datastoreId}/... request. This is the only
datastore-scope check in the service: handlers read the validated id off
g.identity and never re-derive it from the path.
"""
import json
import logging
import os
from dataclasses import dataclass

from flask import Response, request

from datastore_resolver import (
    DatastoreResolutionError,
    resolve_datastore,
    resolve_virtual_folder,
)
from dicom_service_token import DicomServiceTokenError
from mysqlConnectionFactory import get_db_connection
from privilege_checker import (
    check_datastore_delete_access,
    check_datastore_download_access,
    check_datastore_read_access,
    check_datastore_store_access,
    check_storage_location_visibility,
    check_virtual_folder_download_access,
    check_virtual_folder_read_access,
    check_virtual_folder_store_access,
)
from writable_destination import (
    FOLDER_READ_ONLY,
    FOLDER_STORAGE_READ_ONLY,
    folder_mode_is_writable,
    is_writable_access_level,
    storage_write_problem,
)

logger = logging.getLogger(__name__)

# Running without authentication must be an explicit, deliberate operator choice.
# When OIDC is disabled, requests are refused unless this flag is explicitly set,
# preventing a misconfiguration from silently serving imaging data unauthenticated.
ALLOW_UNAUTHENTICATED_ACCESS = os.getenv('ALLOW_UNAUTHENTICATED_ACCESS', 'false').lower() == 'true'
# The only methods ever served without authentication (DEV/DEBUG ONLY mode).
# An allow-list, so PATCH or any other method is refused too.
UNAUTHENTICATED_METHODS = frozenset({'GET', 'HEAD'})


class DatastoreNotFound(LookupError):
    """A deliberate "this datastore is not servable" signal.

    A bare LookupError is not usable for this: KeyError and IndexError subclass it,
    so any stray internal lookup failure in the auth path would otherwise be
    answered as 404 with the missing key's name in the response body.
    """


@dataclass(frozen=True)
class RequestIdentity:
    """The authenticated, authorized scope of one request.

    Frozen so a handler cannot widen its own scope mid-request.
    """
    username: str | None          # cognito_username; None ONLY in the explicit unauthenticated mode
    datastore_id: str             # validated internal datastores.id UUID
    include_private_tags: bool    # management_privileges.datastores.canEdit
    virtual_folder_id: str | None = None  # set when this request targets a VF index, not a datastore
    # canDownload on this storage/folder. Evaluated ONLY on the download routes
    # (is_download_path) so the viewer's hot path pays no extra privilege lookup;
    # False everywhere else.
    can_download: bool = False


# The routes that hand out a .zip copy of a study, plus the probe the data-user
# site calls to decide whether to offer Download. Both are GETs, so they also
# need canRead; the download itself additionally needs canDownload.
DOWNLOAD_SEGMENT = 'download'
DOWNLOAD_ACCESS_SEGMENT = 'download-access'


def is_download_path(path):
    """/dicomweb/{id}/studies/{uid}/download"""
    parts = path.split('/')
    return (len(parts) == 6 and parts[1] == 'dicomweb' and parts[3] == 'studies'
            and parts[5] == DOWNLOAD_SEGMENT)


def is_download_access_path(path):
    """/dicomweb/{id}/download-access"""
    parts = path.split('/')
    return len(parts) == 4 and parts[1] == 'dicomweb' and parts[3] == DOWNLOAD_ACCESS_SEGMENT


class AuthMiddleware:
    # /dicomweb/health is the ALB's target-group probe and carries no PHI. Every
    # other path shape - including any route a later phase adds outside
    # /dicomweb/{datastoreId}/... - falls through to the path parse below and is
    # refused, so the default is deny.
    EXEMPT_PATHS = frozenset({'/dicomweb/health'})

    def __init__(self, oidc_verifier, sql_pool, dicom_token_verifier=None):
        self.oidc_verifier = oidc_verifier
        self.sql_pool = sql_pool
        self.enabled = oidc_verifier is not None
        # Optional DIMSE session-token verifier. When set, a request carrying a
        # valid DICOM_SERVICE_AUTH header is authorized as the DIMSE service
        # (read + storage-location scope) without a Cognito token.
        self.dicom_token_verifier = dicom_token_verifier

    def authenticate_request(self):
        """Authenticate and authorize the current request.

        Returns:
            RequestIdentity for a permitted request, or None when the path is
            exempt (health, OPTIONS preflight) - the caller must then skip both
            auth and audit.

        Raises:
            ValueError               -> 401 (malformed path, missing/invalid bearer, bad token)
            DatastoreNotFound        -> 404 (unknown / non-S3 / non-ACTIVE / deleted datastore)
            PermissionError          -> 403 (authenticated but not authorized for this datastore)
            DatastoreResolutionError -> 503 (the datastore lookup itself failed)
        """
        if request.path in self.EXEMPT_PATHS or request.method == 'OPTIONS':
            return None

        # Path format: /dicomweb/{datastoreId}/studies/...
        # Four parts minimum ('', 'dicomweb', id, resource): there is no bare
        # /dicomweb/{datastoreId} route, so a two-segment path is malformed.
        parts = request.path.split('/')
        if len(parts) < 4 or parts[1] != 'dicomweb':
            raise ValueError("Invalid path format. Expected /dicomweb/{datastoreId}/...")

        datastore_identifier = parts[2]

        # One pooled connection for the whole request, not one per lookup. The
        # resolver caches only negatives (a datastore flipped to DELETING must stop
        # serving PHI on the very next request), so the resolve checkout can never
        # be skipped on the success path — two checkouts per request meant the pool
        # of 32 was really a pool of 16, and DBUtils blocks without a deadline when
        # it runs dry.
        #
        # verify_token runs inside the same block on purpose. Doing it first would
        # be tidier for pool-hold time, but resolving before authenticating is
        # deliberate (see below) and OIDCVerifier caches both the JWKS and verified
        # tokens, so the hold covers a network round trip only on a cold key.
        with get_db_connection() as conn:
            # Resolved before authentication on purpose: the datastore id is in a URL
            # the caller already holds, and resolving first means an unknown id never
            # reaches the index tables.
            ds = resolve_datastore(datastore_identifier, conn)
            if ds is None:
                # Not a datastore — try resolving it as a virtual-folder index,
                # which is addressed on the same /dicomweb/{id}/... path but is a
                # DISTINCT authorization subject gated on virtual_folder_privileges.
                vf = resolve_virtual_folder(datastore_identifier, conn)
                if vf is not None:
                    return self._authorize_virtual_folder(vf['id'], conn)
                raise DatastoreNotFound(f"Datastore '{datastore_identifier}' not found")

            datastore_id = ds['id']

            # DIMSE session-token path: a request from this solution's own DICOM
            # DIMSE service carries a DICOM_SERVICE_AUTH header holding the signed
            # token the (SigV4-protected) config service minted. It is verified
            # statelessly against the shared HMAC secret and, when valid, grants
            # read + storage-location scope for the token's datastores WITHOUT a
            # Cognito token. The DIMSE query/retrieve path only reads, so a write
            # or delete method is refused even with a valid token.
            # X-Dicom-Service-Auth is the header the DIMSE service sends; the
            # legacy DICOM_SERVICE_AUTH name is still read for direct calls, but
            # never survives the ALB or gunicorn (both drop underscore headers).
            dicom_token = (request.headers.get('X-Dicom-Service-Auth')
                           or request.headers.get('DICOM_SERVICE_AUTH'))
            if dicom_token and self.dicom_token_verifier is not None:
                try:
                    claims = self.dicom_token_verifier.verify(dicom_token, datastore_id)
                except DicomServiceTokenError as e:
                    raise ValueError(f"Invalid DICOM service token: {e}")
                if request.method in ('POST', 'PUT', 'DELETE'):
                    raise PermissionError(
                        "DICOM service token grants read-only query/retrieve; "
                        f"{request.method} is not permitted")
                principal = claims.get('principal') or claims.get('sub') or 'dicom-service'
                # storage-location scope -> include_private_tags True so QIDO
                # emits the private S3 key/bucket tags for direct-S3 retrieve.
                include_private = bool(claims.get('storageLocation', True))
                logger.info("Authenticated DICOM service %s for datastore %s (private_tags=%s)",
                            principal, datastore_id, include_private)
                return RequestIdentity(principal, datastore_id, include_private)

            # If OIDC is disabled, only serve the request when an operator has
            # explicitly opted into unauthenticated access. Otherwise fail closed.
            if not self.enabled:
                if not ALLOW_UNAUTHENTICATED_ACCESS:
                    raise PermissionError(
                        "Authentication is required but OIDC is disabled. Refusing "
                        "unauthenticated access. Set OIDC_ENABLED=true, or explicitly "
                        "set ALLOW_UNAUTHENTICATED_ACCESS=true to deliberately run "
                        "without authentication."
                    )
                logger.warning(
                    "SECURITY: serving datastore %s WITHOUT authentication "
                    "(ALLOW_UNAUTHENTICATED_ACCESS=true)", datastore_id
                )
                # Security: unauthenticated mode (DEV/DEBUG ONLY) is read-only.
                # A STOW, an update or a hard S3 DELETE is never served without
                # an authenticated, authorized caller, as on the VF branch.
                if request.method not in UNAUTHENTICATED_METHODS:
                    raise PermissionError(
                        f"{request.method} on a datastore requires authentication")
                # include_private_tags is False unconditionally: an unidentified caller
                # can never be shown the bucket/key that would let them bypass this
                # service entirely.
                return RequestIdentity(None, datastore_id, False)

            auth_header = request.headers.get('Authorization', '')
            if not auth_header.startswith('Bearer '):
                raise ValueError("Missing or invalid Authorization header")

            token = auth_header[7:]
            try:
                user_id, username = self.oidc_verifier.verify_token(token)
            except Exception as e:
                logger.error(f"Token verification failed: {e}")
                raise ValueError(f"Invalid token: {str(e)}")

            # Authorization keys on the cognito username, not on 'sub': privilege_checker
            # joins users.cognito_username. verify_token's first element (sub) is not an
            # authorization identity here.
            # Method-aware authorization. A write (STOW-RS POST) requires
            # canStore; a DELETE requires canDelete; a read (QIDO/WADO GET)
            # requires canRead. All fail closed.
            is_write = request.method in ('POST', 'PUT')
            is_delete = request.method == 'DELETE'
            if is_delete:
                if not check_datastore_delete_access(username, datastore_id, conn):
                    raise PermissionError(
                        f"User {username} does not have delete access to datastore {datastore_id}"
                    )
            elif is_write:
                if not check_datastore_store_access(username, datastore_id, conn):
                    raise PermissionError(
                        f"User {username} does not have store access to datastore {datastore_id}"
                    )
            else:
                if not check_datastore_read_access(username, datastore_id, conn):
                    raise PermissionError(
                        f"User {username} does not have read access to datastore {datastore_id}"
                    )
            # A STOW writes objects into the storage's bucket and a DELETE removes
            # them: neither is allowed on a read-only (imported) storage, whatever
            # the caller's privileges. Checked after authorization so only an
            # authorized caller learns the storage's access level.
            if is_write or is_delete:
                self._assert_datastore_writable(datastore_id, conn)
            include_private_tags = check_storage_location_visibility(username, conn)
            can_download = self._download_decision(
                check_datastore_download_access(username, datastore_id, conn)
                if self._wants_download_decision() else False,
                username, f"datastore {datastore_id}")

        logger.info("Authenticated user %s for datastore %s (private_tags=%s)",
                    username, datastore_id, include_private_tags)
        return RequestIdentity(username, datastore_id, include_private_tags,
                               can_download=can_download)

    @staticmethod
    def _wants_download_decision():
        return (request.method == 'GET'
                and (is_download_path(request.path) or is_download_access_path(request.path)))

    @staticmethod
    def _download_decision(allowed, username, subject):
        """canDownload verdict; refuses the download route itself (403) when
        absent. The probe route only reports the verdict."""
        if not allowed and request.method == 'GET' and is_download_path(request.path):
            raise PermissionError(f"User {username} does not have download access to {subject}")
        return bool(allowed)

    def _authorize_virtual_folder(self, vf_id, conn):
        """Authorize a request that targets a VF index (not a datastore).

        A VF index is gated on virtual_folder_privileges, a DISTINCT subject from
        the datastores that feed it — a user may read a de-identified VF index
        without read access to its source datastores, and vice versa. Same
        fail-closed unauthenticated-mode handling as the datastore path.

        include_private_tags is always False for a VF index: the bucket/key of the
        underlying object belongs to the source datastore's admin scope, never to
        a VF reader. datastore_id is set to '' — handlers key off virtual_folder_id.
        """
        # STOW-RS into a virtual folder depends on the folder's write mode:
        #   NONE      -> refused: the folder is a read-only de-identified projection.
        #   EXISTING / DEDICATED -> the instances are stored in the folder's write
        #                storage (virtual_folders.write_datastore_id) and then
        #                assigned to the folder. Gated on VF canStore. For an
        #                EXISTING (shared) storage the caller must ALSO hold store
        #                on that storage: the folder creator's right
        #                was checked when the folder was pointed at it, but any
        #                other folder writer's was not. A DEDICATED storage
        #                belongs to the folder, so VF canStore is enough.
        # A DELETE unassigns content from THIS folder only (never touching S3 or
        # the source tree): a membership mutation gated on VF canStore (below).
        is_write = request.method in ('POST', 'PUT')
        is_delete = request.method == 'DELETE'
        write_datastore_id = None
        write_mode = None
        if is_write:
            if not self.enabled:
                # Writes are never served unauthenticated, whatever the read-side knob says.
                raise PermissionError("Storing into a virtual folder requires authentication")
            write_datastore_id, write_mode = self._vf_write_datastore(vf_id, conn)
        if not self.enabled:
            if not ALLOW_UNAUTHENTICATED_ACCESS:
                raise PermissionError(
                    "Authentication is required but OIDC is disabled. Refusing "
                    "unauthenticated access to virtual folder."
                )
            # Security: read-only, as on the datastore branch. This also
            # refuses an unauthenticated DELETE (unassign from the folder).
            if request.method not in UNAUTHENTICATED_METHODS:
                raise PermissionError(
                    f"{request.method} on a virtual folder requires authentication")
            logger.warning(
                "SECURITY: serving virtual folder %s WITHOUT authentication "
                "(ALLOW_UNAUTHENTICATED_ACCESS=true)", vf_id)
            return RequestIdentity(None, '', False, virtual_folder_id=vf_id)

        auth_header = request.headers.get('Authorization', '')
        if not auth_header.startswith('Bearer '):
            raise ValueError("Missing or invalid Authorization header")
        token = auth_header[7:]
        try:
            _sub, username = self.oidc_verifier.verify_token(token)
        except Exception as e:
            logger.error(f"Token verification failed: {e}")
            raise ValueError(f"Invalid token: {str(e)}")

        # A DELETE on a VF index unassigns content from this folder, and a STOW
        # stores into the folder's storage and assigns it: both are gated on VF
        # canStore. A read is gated on VF canRead.
        if is_write:
            if not check_virtual_folder_store_access(username, vf_id, conn):
                raise PermissionError(
                    f"User {username} does not have store access to virtual folder {vf_id}")
            if write_mode == 'EXISTING' and not check_datastore_store_access(username, write_datastore_id, conn):
                raise PermissionError(
                    f"User {username} does not have store access to the storage of virtual folder {vf_id}")
            logger.info("Authenticated user %s for STOW into virtual folder %s (storage %s)",
                        username, vf_id, write_datastore_id)
            # datastore_id is the storage written to; virtual_folder_id tells the
            # STOW handler to assign what it stored to this folder.
            return RequestIdentity(username, write_datastore_id, False, virtual_folder_id=vf_id)
        if is_delete:
            if not check_virtual_folder_store_access(username, vf_id, conn):
                raise PermissionError(
                    f"User {username} does not have store (unassign) access to virtual folder {vf_id}")
        elif not check_virtual_folder_read_access(username, vf_id, conn):
            raise PermissionError(
                f"User {username} does not have read access to virtual folder {vf_id}")
        can_download = False
        if not is_delete and self._wants_download_decision():
            can_download = self._download_decision(
                check_virtual_folder_download_access(username, vf_id, conn),
                username, f"virtual folder {vf_id}")

        logger.info("Authenticated user %s for virtual folder %s", username, vf_id)
        # TODO(s3-parity): the DICOMweb query handlers are still datastore-scoped;
        # they must learn to hydrate a VF index from virtual_folder_assignments ->
        # storage_index (across N datastores) and apply the VF's de-id tag_actions
        # at read time. Access control is enforced here; the hydration read is the
        # remaining data-plane work (Phase D.3 indexer materializes the membership).
        return RequestIdentity(username, '', False, virtual_folder_id=vf_id,
                               can_download=can_download)

    @staticmethod
    def _assert_datastore_writable(datastore_id, conn):
        """PermissionError (403) unless the storage may be written to: not
        deleted, ACTIVE, access_level NULL or 'read-write' (writable_destination)."""
        cursor = conn.cursor()
        try:
            cursor.execute(
                "SELECT status, access_level FROM datastores "
                "WHERE id = %s AND deleted = FALSE", (datastore_id,))
            row = cursor.fetchone()
        finally:
            cursor.close()
        problem = storage_write_problem(row)
        if problem:
            raise PermissionError(problem)

    @staticmethod
    def _vf_write_datastore(vf_id, conn):
        """The ACTIVE, writable storage a writable folder stores into.
        PermissionError when the folder is read-only or its storage is read-only
        (access_level 'read-only'); DatastoreNotFound when its storage is gone or
        not ACTIVE yet (a dedicated storage is still being created)."""
        cursor = conn.cursor()
        try:
            cursor.execute(
                "SELECT vf.write_mode, vf.write_datastore_id, d.status AS ds_status, "
                "d.access_level AS ds_access_level "
                "FROM virtual_folders vf LEFT JOIN datastores d "
                "  ON d.id = vf.write_datastore_id AND d.deleted = FALSE "
                "WHERE vf.id = %s AND vf.deleted = FALSE", (vf_id,))
            row = cursor.fetchone()
        finally:
            cursor.close()
        mode = (row or {}).get('write_mode') or 'NONE'
        if not folder_mode_is_writable(mode, (row or {}).get('write_datastore_id')):
            raise PermissionError(FOLDER_READ_ONLY)
        if not is_writable_access_level(row.get('ds_access_level')):
            raise PermissionError(FOLDER_STORAGE_READ_ONLY)
        if row.get('ds_status') != 'ACTIVE':
            raise DatastoreNotFound(
                f"Storage of virtual folder '{vf_id}' is not available ({row.get('ds_status') or 'missing'})")
        return row['write_datastore_id'], mode

    def handle_auth_error(self, error):
        """Convert authentication errors to HTTP responses"""
        if isinstance(error, ValueError):
            return Response(json.dumps({"error": str(error)}), status=401, mimetype="application/json")
        elif isinstance(error, DatastoreNotFound):
            # Body is fixed text rather than str(error): only DatastoreNotFound is a
            # deliberate refusal, and a stray LookupError must not reach a caller
            # (it falls through to the generic 500 below).
            logger.info("Datastore refused: %s", error)
            return Response(json.dumps({"error": "Datastore not found"}), status=404, mimetype="application/json")
        elif isinstance(error, DatastoreResolutionError):
            # Transient: the datastore may well be servable, we just could not tell.
            # 404 here would tell the client to stop asking.
            logger.error("Datastore resolution failed: %s", error)
            return Response(json.dumps({"error": "Service temporarily unavailable"}),
                            status=503, mimetype="application/json")
        elif isinstance(error, PermissionError):
            return Response(json.dumps({"error": str(error)}), status=403, mimetype="application/json")
        else:
            # An unexpected exception's text can carry SQL or connection detail, so the
            # body stays generic and the detail goes to the log only.
            logger.error(f"Unexpected auth error: {error}")
            return Response(json.dumps({"error": "Internal server error"}), status=500, mimetype="application/json")
