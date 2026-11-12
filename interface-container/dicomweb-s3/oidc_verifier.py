"""
OIDC Token Verifier with Caching for Cognito JWT tokens
"""
import time
import hashlib
import logging
import requests
import jwt
from jwt.exceptions import ExpiredSignatureError, InvalidTokenError

logger = logging.getLogger(__name__)

class OIDCVerifier:
    def __init__(self, user_pool_id, region, app_client_id=None, cache_ttl=300):
        # Fail closed at boot rather than at request time: an unset app client id
        # disables the audience check below, which accepts a token minted for any
        # other client in the same user pool. The CDK always supplies
        # USER_POOL_CLIENT_ID, so a missing value is a misconfiguration, not a mode.
        if not app_client_id:
            raise ValueError(
                "app_client_id is required. Without it, audience validation is "
                "skipped and a token minted for any other app client in the same "
                "user pool would be accepted. Set USER_POOL_CLIENT_ID."
            )
        self.user_pool_id = user_pool_id
        self.region = region
        self.app_client_id = app_client_id
        self.cache_ttl = cache_ttl
        self.token_cache = {}
        self.jwks_cache = None
        self.jwks_cache_time = 0
        self.issuer = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}"

    def _get_jwks(self):
        """Fetch JWKS from Cognito with caching"""
        if self.jwks_cache and (time.time() - self.jwks_cache_time) < 3600:
            return self.jwks_cache

        jwks_url = f"{self.issuer}/.well-known/jwks.json"
        # An un-timed fetch parks a waitress worker thread for as long as Cognito
        # stalls; at 32 threads a single network hang wedges the whole task.
        response = requests.get(jwks_url, timeout=5)
        response.raise_for_status()
        self.jwks_cache = response.json()
        self.jwks_cache_time = time.time()
        return self.jwks_cache

    def verify_token(self, token):
        """
        Verify JWT token and return user info
        Returns: (user_id, username) or raises exception
        """
        # Check cache
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        if token_hash in self.token_cache:
            cached = self.token_cache[token_hash]
            if time.time() < cached['expiry']:
                return cached['user_id'], cached['username']
            else:
                del self.token_cache[token_hash]

        # Verify token
        try:
            jwks = self._get_jwks()
            header = jwt.get_unverified_header(token)

            # Find matching key
            key = None
            for k in jwks['keys']:
                if k['kid'] == header['kid']:
                    key = jwt.algorithms.RSAAlgorithm.from_jwk(k)
                    break

            if not key:
                raise ValueError("Public key not found in JWKS")

            # Verify signature and claims. verify_aud is disabled here because
            # Cognito access tokens carry no 'aud' claim (they use 'client_id');
            # the audience check is performed manually below to support both
            # token types.
            claims = jwt.decode(
                token,
                key,
                algorithms=['RS256'],
                issuer=self.issuer,
                options={'verify_aud': False}
            )

            # Enforce a recognized Cognito token type (rejects malformed/other tokens).
            token_use = claims.get('token_use')
            if token_use not in ('id', 'access'):
                raise ValueError("Unexpected token_use claim")

            # Defense-in-depth: confirm the token was minted for our app client, so
            # a token issued to a different client in the same user pool is rejected.
            # ID tokens carry 'aud'; access tokens carry 'client_id'. app_client_id is
            # guaranteed non-empty by the constructor, so this is never skipped.
            # B105 false positive: 'id' is a JWT token_use value, not a password
            token_client_id = claims.get('aud') if token_use == 'id' else claims.get('client_id')  # nosec B105
            if token_client_id != self.app_client_id:
                raise ValueError("Token client_id/aud does not match expected app client")

            user_id = claims.get('sub')
            username = claims.get('cognito:username', claims.get('username', user_id))

            # Cache result. The entry must never outlive the token's own 'exp',
            # otherwise a revoked-by-expiry bearer token keeps returning PHI for up
            # to cache_ttl after Cognito stopped honoring it.
            expiry = time.time() + self.cache_ttl
            token_exp = claims.get('exp')
            if token_exp is not None:
                expiry = min(expiry, float(token_exp))
            if expiry > time.time():
                self.token_cache[token_hash] = {
                    'user_id': user_id,
                    'username': username,
                    'expiry': expiry
                }

            return user_id, username

        except ExpiredSignatureError:
            raise ValueError("Token has expired")
        except InvalidTokenError as e:
            raise ValueError(f"Invalid token: {e}")
        except Exception as e:
            logger.error(f"Token verification failed: {e}")
            raise ValueError(f"Token verification failed: {e}")
