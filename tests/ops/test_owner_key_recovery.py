"""Offline escrow orchestration: fake crypto/S3 only; no owner key or network."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import py_compile
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('t41_owner_key_recovery',
    ROOT / 'docs/runbooks/payloads/t41-owner-key-recovery.py')
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class RemoteError(Exception):
    def __init__(self, status):
        self.response = {'ResponseMetadata': {'HTTPStatusCode': status}}


class FakeClient:
    def __init__(self):
        self.meta = SimpleNamespace(events=SimpleNamespace(register_first=lambda *_args: None))
        self.objects = {}
        self.calls = []
        self.lost_response = False
        self.collision = False
        self.corrupt = False
        self.wrong_size = False
        self.closed = False

    def head_object(self, Bucket, Key):
        self.calls.append(('HEAD', Key))
        if Key not in self.objects:
            raise RemoteError(404)
        return {}

    def put_object(self, Bucket, Key, Body, ContentLength, ContentType):
        self.calls.append(('PUT', Key))
        if self.collision:
            raise RemoteError(412)
        data = Body.read()
        assert len(data) == ContentLength
        self.objects[Key] = data
        if self.lost_response:
            raise RuntimeError('secret-sdk-message-must-never-escape')

    def get_object(self, Bucket, Key):
        self.calls.append(('GET', Key))
        data = self.objects[Key]
        if self.corrupt:
            data = b'x' + data[1:]
        return {'Body': io.BytesIO(data), 'ContentLength': len(data) + int(self.wrong_size)}

    def close(self):
        self.closed = True


class FakeS3:
    BUCKET = 'bron-franchise-backups'
    ENDPOINT = 'https://s3.twcstorage.ru'
    BackupError = type('BackupError', (Exception,), {})

    def __init__(self, client):
        self.client = client
        self.credential_reads = 0
        self.probe_checks = 0
        self.runtime_checks = 0

    def runtime_guard(self):
        self.runtime_checks += 1

    def credentials(self):
        self.credential_reads += 1
        return {'neverPrint': 'synthetic-private-fixture'}

    def require_probe(self, _value):
        self.probe_checks += 1

    @contextlib.contextmanager
    def operation_lock(self):
        yield

    def s3_client(self, _value):
        return self.client

    @staticmethod
    def error_status(error):
        return getattr(error, 'response', {}).get('ResponseMetadata', {}).get('HTTPStatusCode')

    def absent(self, client, key):
        try:
            client.head_object(Bucket=self.BUCKET, Key=key)
        except RemoteError as error:
            if self.error_status(error) == 404:
                return
        raise self.BackupError('must not expose remote text')


class FakeCrypto:
    def __init__(self):
        self.console_available = True
        self.console_checks = 0
        self.prompts = []
        self.sealed_identity_reads = 0
        self.verify_paths = []
        self.fail_verify = False
        self.cipher = b'age-encryption.org/v1\n-> scrypt synthetic-fixture\n' + b'x' * 100

    def require_owner_console(self):
        self.console_checks += 1
        if not self.console_available:
            raise RuntimeError('NO_CONSOLE_PRIVATE_INTERNAL')

    def read_owner_passphrase(self, confirm=True):
        self.prompts.append(confirm)
        return 'synthetic-only-passphrase-never-real'

    def discover_tools(self):
        return {'age': 'synthetic-age', 'zstd': 'synthetic-zstd'}

    def seal_identity(self, identity_fd, output_fd, _phrase, tools=None):
        assert os.read(identity_fd, 100) == b'SYNTHETIC-KEY-NOT-AGE\n'
        self.sealed_identity_reads += 1
        os.write(output_fd, self.cipher)
        return {'status': 'PASS'}

    def verify_encrypted_identity(self, cipher_path, backup_fd, _phrase, tools=None):
        self.verify_paths.append(Path(cipher_path))
        assert Path(cipher_path).read_bytes() == self.cipher
        assert os.read(backup_fd, 500) == b'SYNTHETIC-PINNED-AGE-BACKUP\n'
        if self.fail_verify:
            raise RuntimeError('sensitive native stderr must not escape')
        return {'status': 'PASS'}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state = self.root / 'state'
        self.runtime = self.root / 'runtime'
        self.backup = self.root / 'backup'
        for path in (self.state, self.runtime, self.backup):
            path.mkdir(mode=0o700)
        self.identity = self.root / 'identity.agekey'
        self.credentials = self.root / 'credentials.json'
        self.probe = self.root / 'probe.json'
        self.backup_cipher = self.backup / 'roles.sql.zst.age'
        for path, data in ((self.identity, b'SYNTHETIC-KEY-NOT-AGE\n'),
                           (self.credentials, b'not opened in check'),
                           (self.probe, b'not opened in check'),
                           (self.backup_cipher, b'SYNTHETIC-PINNED-AGE-BACKUP\n')):
            self.write_private(path, data)
        self.backup_entry = {'file': 'roles.sql.zst.age',
            'bytes': self.backup_cipher.stat().st_size,
            'sha256': hashlib.sha256(self.backup_cipher.read_bytes()).hexdigest()}
        self.backup_manifest = self.backup / 'manifest.json'
        backup_raw = json.dumps({'artifacts': [self.backup_entry]}).encode()
        self.write_private(self.backup_manifest, backup_raw)
        self.backup_sha = hashlib.sha256(backup_raw).hexdigest()
        for key, value in {
            'OWNER_UID': os.getuid(), 'ANCESTOR_STOP': self.root,
            'STATE_ROOT': self.state, 'RUNTIME_ROOT': self.runtime,
            'MANIFEST': self.state / 'manifest.json', 'IDENTITY': self.identity,
            'CREDENTIALS': self.credentials, 'PROBE': self.probe,
            'BACKUP_ROOT': self.backup, 'BACKUP_MANIFEST': self.backup_manifest,
            'BACKUP_MANIFEST_SHA': self.backup_sha, 'BACKUP_CIPHER': self.backup_cipher,
            '__file__': str(self.runtime / recovery.WORKFLOW_REL),
        }.items():
            patcher = mock.patch.object(recovery, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = FakeClient()
        self.s3 = FakeS3(self.client)
        self.crypto = FakeCrypto()
        self.context = {'manifest': {'execution_authorized': True},
            'recovery': {'executionAuthorized': True}, 'manifestSha256': 'c' * 64,
            's3': self.s3, 'crypto': self.crypto, 'backup': self.backup_entry}

    @staticmethod
    def write_private(path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def run_recovery(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return recovery.owner_recover(self.context)

    def test_success_proves_downloaded_object_with_no_raw_identity_verify(self):
        result = self.run_recovery()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual([method for method, _key in self.client.calls], ['HEAD', 'PUT', 'GET'])
        self.assertEqual(self.crypto.prompts, [True, False])
        self.assertEqual(self.crypto.sealed_identity_reads, 1)
        self.assertEqual(self.crypto.verify_paths, [self.state / 'identity.downloaded.age'])
        self.assertFalse(result['originalIdentityReadForVerification'])
        self.assertFalse(result['plaintextRecoveredIdentityStored'])
        self.assertTrue(result['encryptedIdentity']['scrypt'])
        self.assertEqual(result['backupProbe']['cipherSha256'], self.backup_entry['sha256'])
        self.assertTrue(result['downloadedCipherShaVerified'])
        self.assertTrue(self.client.closed)
        for filename in ('guard.json', 'put-intent.json', 'download-proof.json', 'result.json'):
            self.assertEqual((self.state / filename).stat().st_mode & 0o777, 0o600)
            self.assertEqual((self.state / filename).stat().st_nlink, 1)

    def test_authorization_denied_before_console_or_secret_or_guard(self):
        self.context['manifest']['execution_authorized'] = False
        with self.assertRaisesRegex(recovery.RecoveryError, 'EXECUTION_NOT_AUTHORIZED'):
            self.run_recovery()
        self.assertEqual(self.crypto.console_checks, 0)
        self.assertEqual(self.s3.credential_reads, 0)
        self.assertFalse((self.state / 'guard.json').exists())

    def test_console_denied_before_credentials_identity_or_upload(self):
        self.crypto.console_available = False
        with self.assertRaisesRegex(recovery.RecoveryError, 'OWNER_PHONE_ROOT_CONSOLE_REQUIRED'):
            self.run_recovery()
        self.assertEqual(self.s3.credential_reads, 0)
        self.assertEqual(self.crypto.sealed_identity_reads, 0)
        self.assertEqual(self.client.calls, [])
        self.assertFalse((self.state / 'guard.json').exists())

    def test_guard_survives_failure_and_disallows_reentry_before_secret_read(self):
        self.client.corrupt = True
        with self.assertRaisesRegex(recovery.RecoveryError, 'DOWNLOAD_SHA_MISMATCH'):
            self.run_recovery()
        self.assertEqual(self.crypto.verify_paths, [])
        reads = self.s3.credential_reads
        with self.assertRaisesRegex(recovery.RecoveryError, 'ALREADY_CLAIMED_NO_RETRY'):
            self.run_recovery()
        self.assertEqual(self.s3.credential_reads, reads)
        self.assertEqual([method for method, _key in self.client.calls].count('PUT'), 1)

    def test_lost_put_response_only_gets_own_unique_object_once(self):
        self.client.lost_response = True
        result = self.run_recovery()
        self.assertTrue(result['putResponseUncertain'])
        self.assertEqual([method for method, _key in self.client.calls], ['HEAD', 'PUT', 'GET'])
        self.assertEqual(len({key for _method, key in self.client.calls}), 1)

    def test_collision_cannot_get_or_verify_or_overwrite(self):
        self.client.collision = True
        with self.assertRaisesRegex(recovery.RecoveryError, 'REMOTE_OBJECT_COLLISION'):
            self.run_recovery()
        self.assertEqual([method for method, _key in self.client.calls], ['HEAD', 'PUT'])
        self.assertEqual(self.crypto.verify_paths, [])

    def test_no_plaintext_or_non_scrypt_identity_can_reach_put(self):
        self.crypto.cipher = b'SYNTHETIC-RAW-KEY-WRONG-OUTPUT\n'
        with self.assertRaisesRegex(recovery.RecoveryError, 'SCRYPT_CIPHERTEXT_REQUIRED'):
            self.run_recovery()
        self.assertEqual([method for method, _key in self.client.calls], ['HEAD'])
        self.assertEqual(self.crypto.verify_paths, [])

    def test_declared_oversized_readback_rejected_before_file_creation(self):
        self.client.wrong_size = True
        with self.assertRaisesRegex(recovery.RecoveryError, 'DOWNLOAD_SIZE_MISMATCH'):
            self.run_recovery()
        self.assertFalse((self.state / 'identity.downloaded.age').exists())
        self.assertEqual(self.crypto.verify_paths, [])

    def test_existing_cipher_download_is_never_overwritten(self):
        path = self.state / 'identity.downloaded.age'
        self.write_private(path, b'preserve-fixture')
        with self.assertRaisesRegex(recovery.RecoveryError, 'PHASE_FAILED'):
            self.run_recovery()
        self.assertEqual(path.read_bytes(), b'preserve-fixture')

    def test_crypto_failure_outputs_fixed_code_without_native_message(self):
        self.crypto.fail_verify = True
        with self.assertRaisesRegex(recovery.RecoveryError, '^RECOVERY_PHASE_FAILED$'):
            self.run_recovery()
        output = (self.state / 'result.json').read_text()
        self.assertNotIn('sensitive', output)
        self.assertNotIn('passphrase-never-real', output)
        self.assertEqual(json.loads(output)['phase'], 'verify')

    def test_pinned_backup_cipher_hash_checked_before_crypto_verification(self):
        self.context['backup'] = {**self.backup_entry, 'sha256': 'a' * 64}
        with self.assertRaisesRegex(recovery.RecoveryError, 'BACKUP_CIPHER_SHA_MISMATCH'):
            self.run_recovery()
        self.assertEqual(self.crypto.verify_paths, [])

    def test_attestation_is_separate_explicit_and_sha_bound_to_crypto_result(self):
        self.run_recovery()
        self.assertFalse((self.state / 'attestation.json').exists())
        with mock.patch('builtins.input', side_effect=['yes', 'yes', 'yes']):
            result = recovery.attest(self.context)
        self.assertEqual(result['status'], 'CONFIRMED')
        self.assertEqual(result['resultSha256'],
                         hashlib.sha256((self.state / 'result.json').read_bytes()).hexdigest())
        self.assertTrue(result['independentPassphraseCopy'])
        self.assertTrue(result['adminVpsPhoneAccess'])
        self.assertTrue(result['timewebPhoneAccess'])
        self.assertFalse(result['macRequired'])

    def test_attestation_refusal_does_not_create_false_confirmation(self):
        self.run_recovery()
        with mock.patch('builtins.input', side_effect=['yes', 'no']):
            with self.assertRaisesRegex(recovery.RecoveryError, 'ATTESTATION_PENDING'):
                recovery.attest(self.context)
        self.assertFalse((self.state / 'attestation.json').exists())

    def build_manifest(self):
        pins = {}
        for relative in (recovery.CRYPTO_REL, recovery.WORKFLOW_REL, recovery.S3_REL):
            path = self.runtime / relative
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.write_private(path, b'# synthetic pinned runtime\n')
            pins[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        value = {'task': 'T41', 'execution_authorized': False, 'ownerRecovery': {
            'method': recovery.METHOD, 'executionAuthorized': False,
            'ownerPhoneConsoleRequired': True, 'runtimeRoot': str(self.runtime),
            'stateRoot': str(self.state), 'backupManifestPath': str(self.backup_manifest),
            'backupManifestSha256': self.backup_sha, 'runtimeFiles': pins}}
        raw = json.dumps(value).encode()
        self.write_private(self.state / 'manifest.json', raw)
        return value, hashlib.sha256(raw).hexdigest()

    def test_check_verifies_pins_and_only_stats_secrets_and_ciphertext(self):
        _manifest, sha = self.build_manifest()
        original_open = os.open
        forbidden = {self.identity, self.credentials, self.probe, self.backup_cipher}
        def read_guard(path, *args, **kwargs):
            if Path(path) in forbidden:
                raise AssertionError('check tried reading a secret/cipher')
            return original_open(path, *args, **kwargs)
        def module_loader(path, _name, _pinned_source):
            return self.crypto if Path(path).name == 'owner-key-escrow-crypto.py' else self.s3
        with mock.patch.object(recovery, 'load_module', side_effect=module_loader), \
             mock.patch.object(recovery.os, 'open', side_effect=read_guard):
            context = recovery.load_context(sha, self.state / 'manifest.json')
            result = recovery.check(context)
        self.assertEqual(result['status'], 'READY')
        self.assertFalse(result['credentialsRead'])
        self.assertEqual(self.s3.credential_reads, 0)
        self.assertEqual(self.crypto.console_checks, 0)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(sorted(p.name for p in self.state.iterdir()), ['manifest.json'])

    def test_runtime_tamper_stops_before_import_and_before_secret_reads(self):
        _manifest, sha = self.build_manifest()
        path = self.runtime / recovery.CRYPTO_REL
        self.write_private(path, b'tampered fixture')
        with mock.patch.object(recovery, 'load_module') as loader:
            with self.assertRaisesRegex(recovery.RecoveryError, 'RUNTIME_SHA_MISMATCH'):
                recovery.load_context(sha, self.state / 'manifest.json')
        loader.assert_not_called()

    def test_loader_executes_captured_source_despite_valid_rogue_pyc_and_later_file_change(self):
        path = self.runtime / 'rogue_cache_probe.py'
        pinned_source = b"executed = 'PINNED'\n"
        rogue_source = b"executed = 'ROGUE!'\n"
        self.assertEqual(len(pinned_source), len(rogue_source))
        self.write_private(path, rogue_source)
        original = path.stat()
        cache = Path(py_compile.compile(str(path), doraise=True))
        self.write_private(path, pinned_source)
        os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
        # A timestamp/size-valid cache exists. The loader must never consult it.
        legacy_spec = importlib.util.spec_from_file_location('legacy_cache_probe', path)
        legacy_module = importlib.util.module_from_spec(legacy_spec)
        legacy_spec.loader.exec_module(legacy_module)
        self.assertEqual(legacy_module.executed, 'ROGUE!')
        self.assertTrue(cache.exists())
        # The path can change after SHA/capture; only captured pinned bytes execute.
        self.write_private(path, rogue_source)
        with mock.patch.object(recovery.os, 'open', side_effect=AssertionError('second open forbidden')):
            loaded = recovery.load_module(path, 'captured_source_probe', pinned_source)
        self.assertEqual(loaded.executed, 'PINNED')
        self.assertEqual(loaded.__file__, str(path))

    def test_backup_metadata_hash_must_match_exact_pinned_copy(self):
        _manifest, sha = self.build_manifest()
        self.write_private(self.backup_manifest, b'{"artifacts": []}')
        with mock.patch.object(recovery, 'load_module',
                               side_effect=[self.crypto, self.s3]):
            with self.assertRaisesRegex(recovery.RecoveryError, 'BACKUP_MANIFEST_SHA_MISMATCH'):
                recovery.load_context(sha, self.state / 'manifest.json')

    def test_symlink_identity_is_rejected_even_in_metadata_check(self):
        original = self.root / 'keep-fixture'
        self.identity.rename(original)
        self.identity.symlink_to(original)
        with self.assertRaisesRegex(recovery.RecoveryError, 'FILE_UNSAFE'):
            recovery.private_stat(self.identity, 16384)

    def test_hardlinked_identity_is_rejected(self):
        os.link(self.identity, self.root / 'second-link')
        with self.assertRaisesRegex(recovery.RecoveryError, 'FILE_UNSAFE'):
            recovery.private_stat(self.identity, 16384)

    def test_scoped_s3_guard_allows_only_exact_cipher_key_and_conditional_put(self):
        key = 'migration/owner-key-escrow-' + 'a' * 32 + '/identity.age'
        url = 'https://s3.twcstorage.ru/bron-franchise-backups/' + key
        for method in ('HEAD', 'GET', 'PUT'):
            recovery.scoped_request(SimpleNamespace(url=url, method=method,
                headers={'If-None-Match': '*'}), key)
        invalid = [(url, 'DELETE', {}), (url, 'PUT', {}),
            (url + '?acl', 'GET', {}), (url.replace('identity.age', 'roles.sql.zst.age'), 'PUT',
                                      {'If-None-Match': '*'}),
            (url.replace('https:', 'http:'), 'GET', {}),
            (url.replace('s3.twcstorage.ru', 'elsewhere.invalid'), 'GET', {})]
        for forbidden, method, headers in invalid:
            with self.subTest(url=forbidden, method=method):
                with self.assertRaisesRegex(recovery.RecoveryError, 'S3_REQUEST_FORBIDDEN'):
                    recovery.scoped_request(SimpleNamespace(url=forbidden,
                        method=method, headers=headers), key)

    def test_no_generic_uploader_or_raw_verifier_can_be_called(self):
        code = (ROOT / 'docs/runbooks/payloads/t41-owner-key-recovery.py').read_text()
        self.assertNotIn('s3.upload(', code)
        self.assertNotIn('upload_target(', code)
        self.assertNotIn('t30-owner-verify', code)
        self.assertNotIn('t29-owner-key-proof', code)


if __name__ == '__main__':
    unittest.main()
