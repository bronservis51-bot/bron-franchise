#!/usr/bin/env python3
"""One final T44 escrow invocation; the failed T41 records remain in place."""
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import types
import time
import uuid

ROOT = Path('/root/bron-secrets')
STATE = ROOT / 't44-owner-recovery'
MANIFEST = STATE / 'manifest.json'
PREPARED = STATE / 'prepared.json'
SELF = ROOT / 't44-owner-key-recovery.py'
SELF_REL = 'docs/runbooks/payloads/t44-owner-key-recovery.py'
OLD = ROOT / 't41-owner-recovery'
ORIGINAL = ROOT / 't41-recovery-runtime/docs/runbooks/payloads/t41-owner-key-recovery.py'
PARENT_SHA = '54c34e5abdf553fb36194aeca7f81251f1859af832b8406a48fe1520c4ae0321'
OLD_GUARD_SHA = 'b0dbe110d4fb66d87af93002d1fdcf91ae31e836a38fee9e51b234426d74889f'
OLD_RESULT_SHA = '7f201d9c8fd7293998e2285e90664b0afa5850a784d4f79870bf458e6849db11'
METHOD = 'BRON_OWNER_KEY_ESCROW_V1'
ACTION = 'T44.owner-key-recovery'
OWNER_UID = OWNER_GID = 0
ANCESTOR_STOP = Path('/')
PUBLIC_PINS = {
    str(ROOT / 't41-owner-console.py'): 'a341b39f5740ee294f3928dee97ab3fa15b1f8afcb5a2a8374ff30f3ff1b222e',
    str(OLD / 'manifest.json'): PARENT_SHA,
    str(OLD / 'approved-manifest.sha256'): '2d2b23617cc14ef16668a9c9260cad5f4f19d69e861a85126609b0335e6415a4',
    str(ROOT / 't41-recovery-runtime/deploy/timeweb/backup-s3.py'): 'cf6c9c0d5ac1b3f65ca1a8e1b96adf1c00b32cf3b1f5c0935651c26b597d8342',
    str(ROOT / 't41-recovery-runtime/docs/runbooks/payloads/owner-key-escrow-crypto.py'): 'f5fdc144a6640d06d4c07b3782f775ced9256c1b0b941fa27449d1f96c1a04d5',
    str(ORIGINAL): '5d34425751fab224e63129103ac2da5f5b2bcd2098faa28dbe70cdbce32d6ce2',
}
OLD_ABSENT = ('identity.sealed.age', 'put-intent.json', 'download-proof.json', 'identity.downloaded.age')
CRYPTO_CODES = frozenset(('ESCROW_AGE_VERSION_MISMATCH', 'ESCROW_BACKUP_DECOMPRESS_FAILED',
    'ESCROW_CIPHERTEXT_SIZE_INVALID', 'ESCROW_CRYPTO_DEADLINE', 'ESCROW_DEADLINE_INVALID',
    'ESCROW_ENCRYPTED_IDENTITY_VERIFY_FAILED', 'ESCROW_FILE_UNSAFE', 'ESCROW_FOREGROUND_TTY_REQUIRED',
    'ESCROW_NATIVE_CRYPTO_FAILED', 'ESCROW_NATIVE_OUTPUT_LIMIT', 'ESCROW_NATIVE_TOOL_UNAVAILABLE',
    'ESCROW_NATIVE_TOOL_UNSAFE', 'ESCROW_ORIGINAL_IDENTITY_VERIFY_FORBIDDEN',
    'ESCROW_OWNER_INPUT_INTERRUPTED', 'ESCROW_PASSPHRASE_CONFIRMATION_FAILED',
    'ESCROW_PASSPHRASE_INVALID', 'ESCROW_PHYSICAL_ROOT_CONSOLE_REQUIRED',
    'ESCROW_PHYSICAL_TTY_REQUIRED', 'ESCROW_PINNED_OWNER_WORKFLOW_REQUIRED',
    'ESCROW_REMOTE_SHELL_FORBIDDEN', 'ESCROW_SCRYPT_FORMAT_REQUIRED', 'ESCROW_UNEXPECTED_SECRET_PROMPT'))


class FinalRecoveryError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise FinalRecoveryError(code)


def safe_code(error, original_codes=()):
    value = error.args[0] if error.args else None
    if isinstance(error, FinalRecoveryError):
        return value
    if type(value) is str and value in CRYPTO_CODES | set(original_codes):
        return value
    return 'T44_PHASE_FAILED'


def directories(path):
    current = Path(path)
    while True:
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER_UID
                and info.st_gid == OWNER_GID and not info.st_mode & 0o022, 'T44_PRIVATE_DIRECTORY_REQUIRED')
        if current == ANCESTOR_STOP:
            break
        require(current != current.parent, 'T44_PRIVATE_DIRECTORY_REQUIRED')
        current = current.parent


def read_metadata(path, pin=None):
    allowed = {SELF, MANIFEST, PREPARED, OLD / 'guard.json', OLD / 'result.json',
               *(Path(p) for p in PUBLIC_PINS)}
    require(Path(path) in allowed, 'T44_METADATA_PATH_FORBIDDEN')
    directories(Path(path).parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER_UID
                and before.st_gid == OWNER_GID and stat.S_IMODE(before.st_mode) == 0o600
                and before.st_nlink == 1 and 0 < before.st_size <= 1048576, 'T44_PRIVATE_METADATA_REQUIRED')
        raw = os.read(fd, 1048577)
        after, named = os.fstat(fd), Path(path).lstat()
        require(len(raw) == before.st_size and
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                (named.st_dev, named.st_ino) == (after.st_dev, after.st_ino), 'T44_METADATA_CHANGED')
        digest = hashlib.sha256(raw).hexdigest()
        require(pin is None or digest == pin, 'T44_METADATA_SHA_MISMATCH')
        return raw, digest
    finally:
        os.close(fd)


def absent(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise FinalRecoveryError('T44_EXPECTED_ABSENT_PATH_PRESENT')


def old_unchanged():
    for filename, pin in PUBLIC_PINS.items():
        read_metadata(Path(filename), pin)
    guard = json.loads(read_metadata(OLD / 'guard.json', OLD_GUARD_SHA)[0])
    result = json.loads(read_metadata(OLD / 'result.json', OLD_RESULT_SHA)[0])
    require(all(x.get('task') == 'T41' and x.get('actionId') == 'T41.owner-key-recovery'
                and x.get('manifestSha256') == PARENT_SHA and x.get('method') == METHOD
                for x in (guard, result)) and result.get('status') == 'BLOCKED'
            and result.get('phase') == 'seal' and result.get('code') == 'RECOVERY_PHASE_FAILED'
            and result.get('retryAuthorized') is False, 'T44_OLD_FAILURE_MISMATCH')
    for name in OLD_ABSENT:
        absent(OLD / name)  # lstat only; no ciphertext opened or hashed.


def load_context(pin):
    require(type(pin) is str and re.fullmatch(r'[0-9a-f]{64}', pin), 'T44_MANIFEST_PIN_REQUIRED')
    raw, actual = read_metadata(MANIFEST, pin)
    m = json.loads(raw)
    require(m.get('task') == 'T44' and m.get('actionId') == ACTION
            and m.get('execution_authorized') is True and m.get('parentT41ManifestSha256') == PARENT_SHA
            and m.get('failedT41GuardSha256') == OLD_GUARD_SHA and m.get('failedT41ResultSha256') == OLD_RESULT_SHA
            and m.get('ownerFinalAttemptAuthorized') is True and m.get('maxAdditionalOwnerRecoverAttempts') == 1
            and m.get('attemptNumber') == 2 and m.get('stateRoot') == str(STATE)
            and m.get('expected_t41_public_files') == PUBLIC_PINS,
            'T44_SCOPE_INVALID')
    self_sha = m.get('files', {}).get(SELF_REL)
    require(type(self_sha) is str and re.fullmatch(r'[0-9a-f]{64}', self_sha), 'T44_SELF_PIN_REQUIRED')
    read_metadata(SELF, self_sha)
    directories(STATE)
    require(stat.S_IMODE(STATE.lstat().st_mode) == 0o700, 'T44_PRIVATE_DIRECTORY_REQUIRED')
    old_unchanged()
    source = read_metadata(ORIGINAL, PUBLIC_PINS[str(ORIGINAL)])[0]
    wf = load_original(source)
    # This original function only reads public metadata and stats protected files.
    # It does not execute old main/recover/attest, import values, or call S3.
    import ast
    original_codes = frozenset(node.value for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Constant) and type(node.value) is str and re.fullmatch(r'RECOVERY_[A-Z_]+', node.value))
    try:
        context = wf.load_context(PARENT_SHA, OLD / 'manifest.json')
    except BaseException as error:
        raise FinalRecoveryError(safe_code(error, original_codes)) from None
    context.update({'wf': wf, 'manifestSha256': actual, 'manifest': m, 'selfSha256': self_sha})
    context['originalCodes'] = original_codes
    return context


def load_original(source):
    wf = types.ModuleType('bron_t44_original_primitives')
    wf.__file__ = str(ORIGINAL)
    exec(compile(source, wf.__file__, 'exec', dont_inherit=True), wf.__dict__)
    return wf


def binding(context):
    return {'format': 1, 'task': 'T44', 'actionId': ACTION, 'method': METHOD,
            'manifestSha256': context['manifestSha256'], 'parentT41ManifestSha256': PARENT_SHA,
            'failedT41GuardSha256': OLD_GUARD_SHA, 'failedT41ResultSha256': OLD_RESULT_SHA,
            'attemptNumber': 2, 'oldT41Unchanged': True}


def prepare(context):
    old_unchanged()
    for name in ('prepared.json', 'guard.json', 'result.json', 'attestation.json', 'identity.sealed.age',
                 'identity.downloaded.age', 'put-intent.json', 'download-proof.json'):
        absent(STATE / name)
    record = {**binding(context), 'status': 'PREPARED', 'selfSha256': context['selfSha256'],
              'metadataOnly': True, 'keyRead': False, 'credentialsRead': False, 'S3Requested': False}
    context['wf'].save_once(PREPARED, record)
    old_unchanged()
    return record


def ready_context():
    record = json.loads(read_metadata(PREPARED)[0])
    require(record.get('status') == 'PREPARED', 'T44_PREPARED_REQUIRED')
    context = load_context(record.get('manifestSha256'))
    require(all(record.get(k) == v for k, v in binding(context).items())
            and record.get('selfSha256') == context['selfSha256'], 'T44_PREPARED_BINDING_MISMATCH')
    return context


def acquire_local_lock(s3, timeout=60):
    require(0 <= timeout <= 60, 'T44_LOCK_DEADLINE_INVALID')
    deadline = time.monotonic() + timeout
    while True:
        lease = s3.operation_lock()
        try:
            lease.__enter__()
            return lease
        except BaseException as error:
            code = error.args[0] if error.args else None
            if type(code) is not str or code != 'ANOTHER_S3_OPERATION_IS_RUNNING':
                raise FinalRecoveryError('T44_S3_LOCK_FAILED') from None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FinalRecoveryError('T44_S3_LOCK_TIMEOUT') from None
            time.sleep(min(0.5, remaining))


def owner_recover(context):
    wf, crypto, s3 = context['wf'], context['crypto'], context['s3']
    crypto.require_owner_console()  # Before credentials, input, identity, or S3.
    old_unchanged()
    for name in ('guard.json', 'result.json', 'attestation.json', 'identity.sealed.age',
                 'identity.downloaded.age', 'put-intent.json', 'download-proof.json'):
        absent(STATE / name)
    key = 'migration/owner-key-escrow-' + uuid.uuid4().hex + '/identity.age'
    guard = {**binding(context), 'objectKey': key, 'startedUtc': wf.utc(), 'oneAttempt': True,
             'oneFinalInvocation': True}
    try:
        lease = acquire_local_lock(s3)
    except BaseException as error:
        old_unchanged()
        return {**guard, 'status': 'BLOCKED', 'phase': 's3-lock', 'code': safe_code(error),
                'attemptClaimed': False, 'putAttempts': 0, 'getAttempts': 0,
                'putOutcome': 'NOT_ATTEMPTED', 'retryAuthorized': False}
    try:
        wf.save_once(STATE / 'guard.json', guard)
    except BaseException as error:
        try:
            lease.__exit__(None, None, None)
        except BaseException:
            pass
        old_unchanged()
        return {**guard, 'status': 'BLOCKED', 'phase': 'guard-claim',
                'code': safe_code(error, context['originalCodes']),
                'attemptClaimed': os.path.lexists(STATE / 'guard.json'),
                'putAttempts': 0, 'getAttempts': 0, 'putOutcome': 'NOT_ATTEMPTED', 'retryAuthorized': False}
    phase, client, phrase = 'input', None, None
    progress = {'putAttempts': 0, 'getAttempts': 0, 'putOutcome': 'NOT_ATTEMPTED',
                'originalIdentityOpened': False, 'putResponseUncertain': False}
    result = {**guard, 'status': 'BLOCKED'}
    try:
        phrase = crypto.read_owner_passphrase(confirm=True)  # No retry loop.
        phase = 'credentials'
        value = s3.credentials(); s3.require_probe(value)
        client = s3.s3_client(value); del value
        client.meta.events.register_first('before-send.s3',
            lambda request, **_kwargs: wf.scoped_request(request, key))
        phase = 'remote-object-precheck'
        s3.absent(client, key)
        phase = 'seal'
        sealed = STATE / 'identity.sealed.age'
        output = os.open(sealed, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with wf.private_open(wf.IDENTITY, 16384) as identity:
                progress['originalIdentityOpened'] = True
                crypto.seal_identity(identity, output, phrase, tools=context['tools'])
            os.fsync(output)
            size = os.fstat(output).st_size
            require(0 < size <= 65536, 'T44_SEALED_SIZE_INVALID')
            header = os.pread(output, min(size, 512), 0)
            require(header.startswith(b'age-encryption.org/v1\n-> scrypt ')
                    and header.count(b'\n-> ') == 1, 'T44_SCRYPT_REQUIRED')
            cipher_sha = wf.digest_fd(output)
        finally:
            phrase = None; os.close(output)
        wf.fsync_directory(STATE)
        wf.save_once(STATE / 'put-intent.json', {**guard, 'cipherBytes': size,
            'cipherSha256': cipher_sha, 'conditionalPut': True, 'putAttempts': 1})
        phase = 'upload'
        with wf.private_open(sealed, 65536) as fd:
            try:
                with os.fdopen(os.dup(fd), 'rb') as body:
                    progress.update({'putAttempts': 1, 'putOutcome': 'UNKNOWN'})
                    client.put_object(Bucket=s3.BUCKET, Key=key, Body=body,
                        ContentLength=size, ContentType='application/octet-stream')
                progress['putOutcome'] = 'ACKNOWLEDGED'
            except Exception as error:
                if s3.error_status(error) in (409, 412):
                    progress['putOutcome'] = 'COLLISION_NO_OVERWRITE'
                    raise FinalRecoveryError('T44_REMOTE_COLLISION') from None
                if isinstance(error, (wf.RecoveryError, s3.BackupError)):
                    raise FinalRecoveryError('T44_PUT_GUARD_REJECTED') from None
                progress['putResponseUncertain'] = True
        phase = 'download'
        downloaded = STATE / 'identity.downloaded.age'
        progress['getAttempts'] = 1
        wf.downloaded_once(client, s3, key, downloaded, size, cipher_sha)
        progress['putOutcome'] = 'CONFIRMED_BY_READBACK'
        wf.save_once(STATE / 'download-proof.json', {**guard, 'cipherBytes': size,
            'cipherSha256': cipher_sha, 'getAttempts': 1, 'downloadShaVerified': True})
        phase = 'verify-input'
        print('Введите фразу из независимой личной копии; ввод скрыт.', flush=True)
        phrase = crypto.read_owner_passphrase(confirm=False)
        phase = 'verify-backup'
        try:
            with wf.private_open(wf.BACKUP_CIPHER, 10 * 1024 * 1024) as backup:
                require(wf.digest_fd(backup) == context['backup']['sha256'], 'T44_BACKUP_SHA_MISMATCH')
                crypto.verify_encrypted_identity(downloaded, backup, phrase, tools=context['tools'])
        finally:
            phrase = None
        phase = 'postcheck'
        old_unchanged()
        result.update({'status': 'PASS', 'completedUtc': wf.utc(), 'guardAction': ACTION,
            'endpoint': s3.ENDPOINT, 'bucket': s3.BUCKET, 'cipherSha256': cipher_sha, 'cipherBytes': size,
            'backupManifestSha256': wf.BACKUP_MANIFEST_SHA, 'backupCipherSha256': context['backup']['sha256'],
            'backupCipherBytes': context['backup']['bytes'], 'conditionalPut': True,
            'encryptedIdentity': {'objectKey': key, 'ciphertextSha256': cipher_sha, 'bytes': size, 'scrypt': True},
            'backupProbe': {'manifestSha256': wf.BACKUP_MANIFEST_SHA, 'artifact': 'roles.sql.zst.age',
                'cipherSha256': context['backup']['sha256'], 'cipherBytes': context['backup']['bytes'],
                'decryptionVerified': True, 'zstdVerified': True},
            'downloadShaVerified': True, 'cipherShaVerified': True, 'decryptionVerified': True,
            'downloadedCipherShaVerified': True, 'originalIdentityReadForVerification': False,
            'plaintextStored': False, 'plaintextRecoveredIdentityStored': False, 'identityStored': False,
            'macDataTransit': False, 'externalCustody': 'OWNER_CONFIRMATION_REQUIRED'})
    except BaseException as error:
        result.update({'status': 'BLOCKED', 'phase': phase, 'code': safe_code(error, context['originalCodes']),
                       'completedUtc': wf.utc(), 'retryAuthorized': False})
    finally:
        phrase = None
        if client is not None:
            try:
                client.close()
            except BaseException:
                result.update({'status': 'BLOCKED', 'phase': 'client-close',
                               'code': 'T44_CLIENT_CLOSE_FAILED', 'retryAuthorized': False})
        try:
            old_unchanged()
        except BaseException:
            result.update({'status': 'BLOCKED', 'phase': 'old-state-postcheck',
                           'code': 'T44_OLD_STATE_CHANGED', 'oldT41Unchanged': False, 'retryAuthorized': False})
        try:
            lease.__exit__(None, None, None)
        except BaseException:
            result.update({'status': 'BLOCKED', 'phase': 'local-lock-release',
                           'code': 'T44_S3_LOCK_RELEASE_FAILED', 'retryAuthorized': False})
        result.update(progress)
        try:
            wf.save_once(STATE / 'result.json', result)
        except BaseException:
            result.update({'status': 'BLOCKED', 'phase': 'result-durability',
                           'code': 'T44_RESULT_DURABILITY_FAILED', 'retryAuthorized': False})
    return result


def attest(context):
    wf = context['wf']
    context['crypto'].require_owner_console()
    old_unchanged()
    result, digest = wf.read_json(STATE / 'result.json')
    require(result.get('status') == 'PASS' and result.get('task') == 'T44'
            and all(result.get(k) == v for k, v in binding(context).items())
            and result.get('putAttempts') == 1 and result.get('getAttempts') == 1,
            'T44_CRYPTO_PASS_REQUIRED')
    for label in ('Фраза сохранена и доступна без VPS/Mac',
                  'Личный вход AdminVPS/root с телефона выполнен', 'Личный вход Timeweb S3 с телефона выполнен'):
        require(input(label + ' (yes): ').strip() == 'yes', 'T44_OWNER_ATTESTATION_PENDING')
    old_unchanged()
    answer = {**binding(context), 'actionId': 'T44.owner-key-recovery-attestation', 'status': 'CONFIRMED',
        'resultSha256': digest, 'independentPassphraseCopy': True, 'adminVpsPhoneAccess': True,
        'timewebPhoneAccess': True, 'macRequired': False, 'observedUtc': wf.utc(), 'confirmedUtc': wf.utc()}
    wf.save_once(STATE / 'attestation.json', answer)
    return answer


def main(argv=None):
    context = None
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise FinalRecoveryError('T44_ARGUMENTS_INVALID')
    try:
        require(sys.platform == 'linux' and os.getuid() == 0 and os.geteuid() == 0
                and os.getgid() == 0 and os.getegid() == 0 and bool(sys.flags.isolated), 'T44_ROOT_ISOLATED_REQUIRED')
        require(Path(__file__) == SELF, 'T44_LOCATION_INVALID')
        os.umask(0o077); resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        parser = Parser(); group = parser.add_mutually_exclusive_group(required=True)
        for name in ('prepare', 'owner-recover', 'attest'):
            group.add_argument('--' + name, action='store_true')
        parser.add_argument('--manifest'); parser.add_argument('--sha256')
        args = parser.parse_args(argv)
        if args.prepare:
            require(args.manifest == str(MANIFEST) and type(args.sha256) is str
                    and re.fullmatch(r'[0-9a-f]{64}', args.sha256), 'T44_EXPLICIT_PREPARE_REQUIRED')
            context = load_context(args.sha256)
            answer = prepare(context)
        else:
            require(args.manifest is None and args.sha256 is None, 'T44_SHORT_OWNER_ACTION_REQUIRED')
            context = ready_context()
            answer = attest(context) if args.attest else owner_recover(context)
    except BaseException as error:
        answer = {'format': 1, 'task': 'T44', 'method': METHOD, 'status': 'BLOCKED',
                  'code': safe_code(error, context.get('originalCodes', ()) if context else ()), 'retryAuthorized': False}
    if context is not None:
        try:
            old_unchanged()
        except BaseException:
            answer.update({'status': 'BLOCKED', 'code': 'T44_OLD_STATE_CHANGED',
                           'oldT41Unchanged': False, 'retryAuthorized': False})
    summary = 'T44_RESULT ' + answer['status']
    if answer['status'] == 'BLOCKED':
        summary += ' ' + answer.get('code', 'T44_PHASE_FAILED')
    print(summary, flush=True)
    print(json.dumps(answer, sort_keys=True))
    return 0 if answer['status'] in ('PREPARED', 'PASS', 'CONFIRMED') else 2


if __name__ == '__main__':
    raise SystemExit(main())
