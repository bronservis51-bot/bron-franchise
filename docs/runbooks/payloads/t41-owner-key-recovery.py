#!/usr/bin/env python3
"""One owner-console key escrow proof. Never sends backup/key plaintext to a client."""
import argparse
import contextlib
import datetime
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import resource
import stat
import sys
import time
import types
import uuid
from urllib.parse import urlsplit

METHOD = 'BRON_OWNER_KEY_ESCROW_V1'
ACTION = 'T41.owner-key-recovery'
OWNER_UID = 0
ANCESTOR_STOP = Path('/')
STATE_ROOT = Path('/root/bron-secrets/t41-owner-recovery')
RUNTIME_ROOT = Path('/root/bron-secrets/t41-recovery-runtime')
MANIFEST = STATE_ROOT / 'manifest.json'
IDENTITY = Path('/root/bron-secrets/source-backup.agekey')
CREDENTIALS = Path('/root/bron-secrets/timeweb-backup.credentials.json')
PROBE = Path('/root/bron-secrets/timeweb-backup.probe.json')
BACKUP_ROOT = Path('/var/backups/bron-franchise/target-20261113T133022Z-c4d9bbfd')
BACKUP_MANIFEST = BACKUP_ROOT / 'manifest.json'
BACKUP_MANIFEST_SHA = 'a1f6a1c9f187bd586aeec5d0189adc4f6648df29acb8c68490bf4fc77541d6b9'
BACKUP_CIPHER = BACKUP_ROOT / 'roles.sql.zst.age'
CRYPTO_REL = 'docs/runbooks/payloads/owner-key-escrow-crypto.py'
WORKFLOW_REL = 'docs/runbooks/payloads/t41-owner-key-recovery.py'
S3_REL = 'deploy/timeweb/backup-s3.py'
MAX_CIPHER = 65536
MAX_BACKUP = 10 * 1024 * 1024
SHA = re.compile(r'[0-9a-f]{64}')
OBJECT = re.compile(r'migration/owner-key-escrow-[0-9a-f]{32}/identity\.age')
PHASES = frozenset({'preflight', 'console', 'claim', 'credentials', 'seal', 'upload',
                    'download', 'verify', 'attest', 'complete'})


class RecoveryError(Exception):
    """Only constants supplied by this module are public errors."""


def require(condition, code):
    if not condition:
        raise RecoveryError(code)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def check_ancestors(path):
    current = path
    while True:
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER_UID
                and not info.st_mode & 0o022, 'RECOVERY_DIRECTORY_UNSAFE')
        if current == ANCESTOR_STOP:
            break
        require(current != current.parent, 'RECOVERY_DIRECTORY_UNSAFE')
        current = current.parent


def private_stat(path, maximum, minimum=1):
    check_ancestors(path.parent)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER_UID
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
            and minimum <= info.st_size <= maximum, 'RECOVERY_FILE_UNSAFE')
    return info


@contextlib.contextmanager
def private_open(path, maximum, minimum=1):
    original = private_stat(path, maximum, minimum)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        current = os.fstat(fd)
        require((current.st_dev, current.st_ino, current.st_size) ==
                (original.st_dev, original.st_ino, original.st_size), 'RECOVERY_FILE_CHANGED')
        yield fd
    finally:
        os.close(fd)


def digest_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    for block in iter(lambda: os.read(fd, 65536), b''):
        digest.update(block)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()


def read_json(path, maximum=131072):
    with private_open(path, maximum) as fd:
        raw = os.read(fd, maximum + 1)
    require(len(raw) <= maximum, 'RECOVERY_JSON_TOO_LARGE')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise RecoveryError('RECOVERY_JSON_INVALID') from None
    require(isinstance(value, dict), 'RECOVERY_JSON_INVALID')
    return value, hashlib.sha256(raw).hexdigest()


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_once(path, value):
    check_ancestors(path.parent)
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    fsync_directory(path.parent)
    readback, digest = read_json(path)
    require(readback == value and digest == hashlib.sha256(raw).hexdigest(),
            'RECOVERY_DURABLE_READBACK_FAILED')
    return digest


def load_module(path, name, pinned_source):
    """Execute only captured SHA-verified source, never import an existing .pyc."""
    require(isinstance(pinned_source, bytes), 'RECOVERY_RUNTIME_SOURCE_REQUIRED')
    module = types.ModuleType(name)
    module.__file__ = str(path)
    module.__package__ = ''
    exec(compile(pinned_source, str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


def load_context(manifest_sha, manifest_path=MANIFEST):
    require(SHA.fullmatch(manifest_sha or '') is not None, 'RECOVERY_MANIFEST_SHA_INVALID')
    require(Path(manifest_path) == MANIFEST, 'RECOVERY_MANIFEST_PATH_INVALID')
    manifest, actual_sha = read_json(MANIFEST, 1024 * 1024)
    require(actual_sha == manifest_sha, 'RECOVERY_MANIFEST_SHA_MISMATCH')
    recovery = manifest.get('ownerRecovery')
    require(manifest.get('task') == 'T41' and isinstance(recovery, dict)
            and recovery.get('method') == METHOD
            and recovery.get('ownerPhoneConsoleRequired') is True
            and recovery.get('runtimeRoot') == str(RUNTIME_ROOT)
            and recovery.get('stateRoot') == str(STATE_ROOT)
            and recovery.get('backupManifestPath') == str(BACKUP_MANIFEST)
            and recovery.get('backupManifestSha256') == BACKUP_MANIFEST_SHA,
            'RECOVERY_SCOPE_INVALID')
    expected = recovery.get('runtimeFiles')
    minimum = {str(RUNTIME_ROOT / relative) for relative in (CRYPTO_REL, WORKFLOW_REL, S3_REL)}
    require(isinstance(expected, dict) and set(expected) == minimum,
            'RECOVERY_RUNTIME_PINS_REQUIRED')
    sources = {}
    for filename, pinned in expected.items():
        require(SHA.fullmatch(pinned or '') is not None, 'RECOVERY_RUNTIME_PIN_INVALID')
        with private_open(Path(filename), 1024 * 1024) as fd:
            source = os.read(fd, 1024 * 1024 + 1)
            require(len(source) <= 1024 * 1024
                    and hashlib.sha256(source).hexdigest() == pinned,
                    'RECOVERY_RUNTIME_SHA_MISMATCH')
            sources[filename] = source
    require(Path(__file__).resolve() == RUNTIME_ROOT / WORKFLOW_REL,
            'RECOVERY_RUNTIME_LOCATION_INVALID')
    # These imports are permitted only after their exact complete files were hashed.
    crypto = load_module(RUNTIME_ROOT / CRYPTO_REL, 'bron_owner_escrow_crypto',
                         sources[str(RUNTIME_ROOT / CRYPTO_REL)])
    s3 = load_module(RUNTIME_ROOT / S3_REL, 'bron_owner_escrow_s3',
                     sources[str(RUNTIME_ROOT / S3_REL)])
    s3.runtime_guard()
    require(stat.S_IMODE(STATE_ROOT.stat().st_mode) == 0o700, 'RECOVERY_STATE_DIRECTORY_UNSAFE')
    backup, backup_sha = read_json(BACKUP_MANIFEST)
    require(backup_sha == BACKUP_MANIFEST_SHA, 'RECOVERY_BACKUP_MANIFEST_SHA_MISMATCH')
    entries = backup.get('artifacts')
    require(isinstance(entries, list), 'RECOVERY_BACKUP_ARTIFACT_INVALID')
    roles = [entry for entry in entries if isinstance(entry, dict)
             and entry.get('file') == BACKUP_CIPHER.name]
    require(len(roles) == 1 and SHA.fullmatch(roles[0].get('sha256') or '') is not None
            and type(roles[0].get('bytes')) is int and 0 < roles[0]['bytes'] <= MAX_BACKUP,
            'RECOVERY_BACKUP_ARTIFACT_INVALID')
    private_stat(BACKUP_CIPHER, roles[0]['bytes'], roles[0]['bytes'])
    private_stat(IDENTITY, 16384)
    private_stat(CREDENTIALS, 131072)
    private_stat(PROBE, 131072)
    tools = crypto.discover_tools()  # Fixed binaries/version only; before owner secret entry.
    return {'manifest': manifest, 'recovery': recovery, 'manifestSha256': manifest_sha,
            'crypto': crypto, 's3': s3, 'backup': roles[0], 'tools': tools}


def check(context):
    return {'format': 1, 'method': METHOD, 'status': 'READY', 'metadataOnly': True,
            'identityRequested': False, 'identityRead': False, 'credentialsRead': False,
            'S3Requested': False, 'backupManifestSha256': BACKUP_MANIFEST_SHA,
            'manifestSha256': context['manifestSha256']}


def require_owner_console(crypto):
    try:
        crypto.require_owner_console()
    except Exception:
        raise RecoveryError('RECOVERY_PHYSICAL_OWNER_PHONE_ROOT_CONSOLE_REQUIRED') from None


def scoped_request(request, key):
    require(OBJECT.fullmatch(key) is not None, 'RECOVERY_OBJECT_KEY_INVALID')
    try:
        url = urlsplit(request.url)
        method = request.method.decode() if isinstance(request.method, bytes) else request.method
        valid = (url.scheme == 'https' and url.hostname == 's3.twcstorage.ru'
                 and url.port in (None, 443) and url.username is None and url.password is None
                 and not url.query and not url.fragment
                 and url.path == '/bron-franchise-backups/' + key
                 and method in ('HEAD', 'PUT', 'GET'))
        if method == 'PUT':
            valid = valid and request.headers.get('If-None-Match') in ('*', b'*')
    except (TypeError, ValueError, AttributeError):
        valid = False
    require(valid, 'RECOVERY_S3_REQUEST_FORBIDDEN')


def downloaded_once(client, s3, key, destination, size, expected_sha):
    """Retain only exact bounded S3 ciphertext, never original sealed-file fallback."""
    response = body = None
    fd = None
    try:
        response = client.get_object(Bucket=s3.BUCKET, Key=key)
        body = response['Body']
        require(response.get('ContentLength') == size, 'RECOVERY_DOWNLOAD_SIZE_MISMATCH')
        fd = os.open(destination, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        digest = hashlib.sha256()
        count = 0
        deadline = time.monotonic() + 90
        while True:
            require(time.monotonic() < deadline, 'RECOVERY_DOWNLOAD_DEADLINE')
            block = body.read(min(8192, size + 1 - count))
            if not block:
                break
            count += len(block)
            require(count <= size, 'RECOVERY_DOWNLOAD_SIZE_MISMATCH')
            digest.update(block)
            view = memoryview(block)
            while view:
                written = os.write(fd, view)
                view = view[written:]
        require(count == size and digest.hexdigest() == expected_sha,
                'RECOVERY_DOWNLOAD_SHA_MISMATCH')
        os.fsync(fd)
        require(digest_fd(fd) == expected_sha, 'RECOVERY_DOWNLOAD_READBACK_FAILED')
    finally:
        if fd is not None:
            os.close(fd)
        if body is not None:
            body.close()
    fsync_directory(destination.parent)


def owner_recover(context):
    crypto, s3 = context['crypto'], context['s3']
    require(context['manifest'].get('execution_authorized') is True
            and context['recovery'].get('executionAuthorized') is True,
            'RECOVERY_EXECUTION_NOT_AUTHORIZED')
    require_owner_console(crypto)  # Before credentials, raw identity, phrase or any S3 operation.
    key = 'migration/owner-key-escrow-' + uuid.uuid4().hex + '/identity.age'
    guard = {'format': 1, 'task': 'T41', 'actionId': ACTION, 'method': METHOD,
             'manifestSha256': context['manifestSha256'], 'objectKey': key,
             'startedUtc': utc(), 'oneAttempt': True}
    try:
        save_once(STATE_ROOT / 'guard.json', guard)
    except FileExistsError:
        raise RecoveryError('RECOVERY_ALREADY_CLAIMED_NO_RETRY') from None
    phase, client = 'credentials', None
    try:
        tools = context.get('tools') or crypto.discover_tools()
        with s3.operation_lock():
            value = s3.credentials()
            s3.require_probe(value)
            client = s3.s3_client(value)
            del value
            client.meta.events.register_first('before-send.s3',
                lambda request, **_kwargs: scoped_request(request, key))
            # No secret entered if this unique object already exists or access is unavailable.
            s3.absent(client, key)
            phase = 'seal'
            phrase = crypto.read_owner_passphrase(confirm=True)
            sealed = STATE_ROOT / 'identity.sealed.age'
            output = os.open(sealed, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with private_open(IDENTITY, 16384) as identity:
                    crypto.seal_identity(identity, output, phrase, tools=tools)
                os.fsync(output)
                size = os.fstat(output).st_size
                require(0 < size <= MAX_CIPHER, 'RECOVERY_SEALED_SIZE_INVALID')
                header = os.pread(output, min(size, 512), 0)
                require(header.startswith(b'age-encryption.org/v1\n-> scrypt ')
                        and header.count(b'\n-> ') == 1,
                        'RECOVERY_SCRYPT_CIPHERTEXT_REQUIRED')
                cipher_sha = digest_fd(output)
            finally:
                del phrase
                os.close(output)
            fsync_directory(STATE_ROOT)
            save_once(STATE_ROOT / 'put-intent.json', {**guard, 'cipherBytes': size,
                'cipherSha256': cipher_sha, 'conditionalPut': True, 'putAttempts': 1})
            phase, uncertain = 'upload', False
            with private_open(sealed, MAX_CIPHER) as fd:
                try:
                    with os.fdopen(os.dup(fd), 'rb') as body:
                        client.put_object(Bucket=s3.BUCKET, Key=key, Body=body,
                            ContentLength=size, ContentType='application/octet-stream')
                except Exception as error:
                    if s3.error_status(error) in (409, 412):
                        raise RecoveryError('RECOVERY_REMOTE_OBJECT_COLLISION') from None
                    if isinstance(error, (RecoveryError, s3.BackupError)):
                        raise RecoveryError('RECOVERY_PUT_GUARD_REJECTED') from None
                    uncertain = True  # Never another PUT; one bounded GET of this claim's unique key.
            phase = 'download'
            downloaded = STATE_ROOT / 'identity.downloaded.age'
            downloaded_once(client, s3, key, downloaded, size, cipher_sha)
            save_once(STATE_ROOT / 'download-proof.json', {**guard, 'cipherBytes': size,
                'cipherSha256': cipher_sha, 'getAttempts': 1, 'downloadShaVerified': True,
                'putResponseUncertain': uncertain})
            phase = 'verify'
            print('Сохраните фразу в независимой личной копии. Теперь введите её из этой копии.', flush=True)
            phrase = crypto.read_owner_passphrase(confirm=False)
            try:
                with private_open(BACKUP_CIPHER, MAX_BACKUP) as backup:
                    require(digest_fd(backup) == context['backup']['sha256'],
                            'RECOVERY_BACKUP_CIPHER_SHA_MISMATCH')
                    crypto.verify_encrypted_identity(downloaded, backup, phrase, tools=tools)
            finally:
                del phrase
        result = {**guard, 'status': 'PASS', 'completedUtc': utc(),
            'parentManifestSha256': context['manifestSha256'], 'guardAction': ACTION,
            'endpoint': s3.ENDPOINT, 'bucket': s3.BUCKET, 'cipherSha256': cipher_sha,
            'cipherBytes': size, 'backupManifestSha256': BACKUP_MANIFEST_SHA,
            'backupCipherSha256': context['backup']['sha256'],
            'backupCipherBytes': context['backup']['bytes'], 'conditionalPut': True,
            'putAttempts': 1, 'getAttempts': 1, 'putResponseUncertain': uncertain,
            'downloadShaVerified': True, 'cipherShaVerified': True, 'decryptionVerified': True,
            'encryptedIdentity': {'objectKey': key, 'ciphertextSha256': cipher_sha,
                'bytes': size, 'scrypt': True},
            'backupProbe': {'manifestSha256': BACKUP_MANIFEST_SHA,
                'artifact': BACKUP_CIPHER.name, 'cipherSha256': context['backup']['sha256'],
                'cipherBytes': context['backup']['bytes'], 'decryptionVerified': True,
                'zstdVerified': True}, 'downloadedCipherShaVerified': True,
            'originalIdentityReadForVerification': False, 'plaintextStored': False,
            'plaintextRecoveredIdentityStored': False,
            'identityStored': False, 'macDataTransit': False,
            'externalCustody': 'OWNER_CONFIRMATION_REQUIRED'}
        save_once(STATE_ROOT / 'result.json', result)
        return result
    except BaseException as error:
        code = str(error) if isinstance(error, RecoveryError) else 'RECOVERY_PHASE_FAILED'
        require(phase in PHASES, 'RECOVERY_PHASE_INVALID')
        result = {**guard, 'status': 'BLOCKED', 'phase': phase, 'code': code,
                  'completedUtc': utc(), 'retryAuthorized': False}
        # On durability failure never overwrite/fabricate any previously created result.
        if not os.path.lexists(STATE_ROOT / 'result.json'):
            save_once(STATE_ROOT / 'result.json', result)
        raise RecoveryError(code) from None
    finally:
        if client is not None:
            client.close()


def attest(context):
    require_owner_console(context['crypto'])
    result, result_sha = read_json(STATE_ROOT / 'result.json')
    require(result.get('status') == 'PASS' and result.get('method') == METHOD
            and result.get('manifestSha256') == context['manifestSha256'],
            'RECOVERY_CRYPTO_PASS_REQUIRED')
    prompts = (('independentPassphraseCopy', 'Фраза сохранена лично и доступна без VPS/Mac'),
               ('adminVpsPhoneAccess', 'Личный вход в AdminVPS и root-консоль с телефона выполнен'),
               ('timewebPhoneAccess', 'Личный вход в Timeweb S3 с телефона выполнен'))
    for _name, label in prompts:
        require(input(label + ' (введите yes): ').strip() == 'yes',
                'RECOVERY_OWNER_ATTESTATION_PENDING')
    attestation = {'format': 1, 'task': 'T41', 'method': METHOD, 'status': 'CONFIRMED',
        'actionId': 'T41.owner-key-recovery-attestation', 'observedUtc': utc(),
        'resultSha256': result_sha, 'manifestSha256': context['manifestSha256'],
        'independentPassphraseCopy': True, 'adminVpsPhoneAccess': True,
        'timewebPhoneAccess': True, 'macRequired': False, 'confirmedUtc': utc()}
    save_once(STATE_ROOT / 'attestation.json', attestation)
    return attestation


def main(argv=None):
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise RecoveryError('RECOVERY_ARGUMENTS_INVALID')
    try:
        require(sys.platform == 'linux' and os.geteuid() == 0 and os.getuid() == 0,
                'RECOVERY_VPS_ROOT_REQUIRED')
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        logging.disable(logging.CRITICAL)
        parser = Parser(description=__doc__)
        mode = parser.add_mutually_exclusive_group(required=True)
        mode.add_argument('--check', action='store_true')
        mode.add_argument('--owner-recover', action='store_true')
        mode.add_argument('--attest', action='store_true')
        parser.add_argument('--manifest', required=True)
        parser.add_argument('--manifest-sha256', required=True)
        args = parser.parse_args(argv)
        context = load_context(args.manifest_sha256, Path(args.manifest))
        result = check(context) if args.check else attest(context) if args.attest else owner_recover(context)
        print(json.dumps(result, sort_keys=True))
        return 0
    except RecoveryError as error:
        code = str(error)
    except (EOFError, KeyboardInterrupt):
        code = 'RECOVERY_OWNER_INPUT_INTERRUPTED'
    except Exception:
        code = 'RECOVERY_FAILED'
    print(json.dumps({'format': 1, 'method': METHOD, 'status': 'BLOCKED', 'code': code}))
    return 2


if __name__ == '__main__':
    sys.exit(main())
