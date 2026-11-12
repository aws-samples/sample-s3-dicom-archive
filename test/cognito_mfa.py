"""Cognito sign-in for the live test suites, with TOTP MFA.

The deployment requires TOTP MFA by default ("mfa": true), so a bare
USER_PASSWORD_AUTH call returns a challenge instead of tokens. sign_in() completes
the flow:

  * MFA_SETUP (user not enrolled yet): AssociateSoftwareToken -> VerifySoftwareToken
    with a generated code, then RespondToAuthChallenge. The TOTP secret is stored,
    mode 0600, so later sign-ins (from any suite) can answer the MFA challenge.
  * SOFTWARE_TOKEN_MFA: answers with the current TOTP code.

Cognito refuses a TOTP code that was already used, so each user gets at most one
sign-in per 30-second step; a second sign-in in the same step waits for the next.

Secrets live in $TEST_MFA_DIR (default: <system temp dir>/dicom-archive-test-mfa),
outside the repository. They are TEST-ONLY credentials for disposable test users.
"""
import base64
import fcntl
import hashlib
import hmac
import os
import struct
import tempfile
import time

STEP = 30


def _mfa_dir():
    d = os.environ.get('TEST_MFA_DIR') or os.path.join(tempfile.gettempdir(), 'dicom-archive-test-mfa')
    os.makedirs(d, mode=0o700, exist_ok=True)
    return d


def _path(pool_or_client, username, kind):
    safe = ''.join(c if c.isalnum() or c in '-_.' else '_' for c in f'{pool_or_client}__{username}')
    return os.path.join(_mfa_dir(), f'{safe}.{kind}')


def totp(secret_b32, step_index=None):
    key = base64.b32decode(secret_b32.upper() + '=' * (-len(secret_b32) % 8))
    counter = int(time.time() // STEP) if step_index is None else step_index
    digest = hmac.new(key, struct.pack('>Q', counter), hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    code = (struct.unpack('>I', digest[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f'{code:06d}'


def _fresh_step(client_id, username):
    """Block until a 30 s step not yet used for this user, record it, return it."""
    lock_path = _path(client_id, username, 'step')
    with open(lock_path, 'a+') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.seek(0)
        last = int(f.read().strip() or -1)
        now = int(time.time() // STEP)
        if now <= last:
            time.sleep((last + 1) * STEP - time.time() + 0.5)
            now = int(time.time() // STEP)
        f.seek(0); f.truncate(); f.write(str(now)); f.flush()
        return now


def _write_secret(path, secret):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        f.write(secret)


def sign_in(cog, client_id, username, password):
    """Return Cognito AuthenticationResult (AccessToken, IdToken, ...) for the user."""
    secret_path = _path(client_id, username, 'totp')
    r = cog.initiate_auth(ClientId=client_id, AuthFlow='USER_PASSWORD_AUTH',
                          AuthParameters={'USERNAME': username, 'PASSWORD': password})
    for _ in range(3):
        if 'AuthenticationResult' in r:
            return r['AuthenticationResult']
        name, session = r.get('ChallengeName'), r.get('Session')
        if name == 'MFA_SETUP':
            secret = cog.associate_software_token(Session=session)
            step = _fresh_step(client_id, username)
            v = cog.verify_software_token(Session=secret['Session'], UserCode=totp(secret['SecretCode'], step),
                                          FriendlyDeviceName='e2e-tests')
            assert v.get('Status') == 'SUCCESS', v
            _write_secret(secret_path, secret['SecretCode'])
            r = cog.respond_to_auth_challenge(ClientId=client_id, ChallengeName='MFA_SETUP', Session=v['Session'],
                                              ChallengeResponses={'USERNAME': username})
        elif name == 'SOFTWARE_TOKEN_MFA':
            if not os.path.exists(secret_path):
                raise RuntimeError(f'{username} is enrolled in TOTP but no secret is stored in {_mfa_dir()}; '
                                   'reset the user\'s MFA (admin-set-user-mfa-preference) or point TEST_MFA_DIR '
                                   'at the directory used when it was enrolled')
            step = _fresh_step(client_id, username)
            r = cog.respond_to_auth_challenge(
                ClientId=client_id, ChallengeName='SOFTWARE_TOKEN_MFA', Session=session,
                ChallengeResponses={'USERNAME': username,
                                    'SOFTWARE_TOKEN_MFA_CODE': totp(open(secret_path).read().strip(), step)})
        else:
            raise RuntimeError(f'unexpected Cognito challenge for {username}: {name}')
    raise RuntimeError(f'sign-in for {username} did not complete: {r.get("ChallengeName")}')


def access_token(cog, client_id, username, password):
    return sign_in(cog, client_id, username, password)['AccessToken']


if __name__ == '__main__':
    # CLI for shell scripts: python cognito_mfa.py <client-id> <username>  (password on stdin)
    import sys
    import boto3
    print(access_token(boto3.client('cognito-idp'), sys.argv[1], sys.argv[2], sys.stdin.readline().strip()))
