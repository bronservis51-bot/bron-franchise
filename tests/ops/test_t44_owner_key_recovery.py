"""Offline T44 isolation and outcome tests; synthetic crypto/S3 only."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'docs/runbooks/payloads/t44-owner-key-recovery.py'
ORIGINAL = REPO / 'docs/runbooks/payloads/t41-owner-key-recovery.py'


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


FAKES = module(REPO / 'tests/ops/test_owner_key_recovery.py', 't44_synthetic_fakes')


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


class FinalAttemptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bron-t44-final-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.m = module(SCRIPT, 't44_new_runner')
        m = self.m
        m.ROOT = self.root; m.OLD = self.root / 'old-state'; m.STATE = self.root / 'new-state'
        m.MANIFEST = m.STATE / 'manifest.json'; m.PREPARED = m.STATE / 'prepared.json'
        m.SELF = self.root / 'runner.py'; m.ORIGINAL = self.root / 'original.py'
        m.OWNER_UID, m.OWNER_GID = os.getuid(), os.getgid(); m.ANCESTOR_STOP = self.root
        for directory in (m.OLD, m.STATE): directory.mkdir(mode=0o700)
        self.write(m.SELF, SCRIPT.read_bytes()); self.write(m.ORIGINAL, ORIGINAL.read_bytes())
        m.PUBLIC_PINS = {str(m.ORIGINAL): hashlib.sha256(ORIGINAL.read_bytes()).hexdigest()}
        for number in range(5):
            path = self.root / ('public-' + str(number)); raw = ('SYNTHETIC_PUBLIC_' + str(number)).encode()
            self.write(path, raw); m.PUBLIC_PINS[str(path)] = hashlib.sha256(raw).hexdigest()
        guard = {'task': 'T41', 'actionId': 'T41.owner-key-recovery', 'method': m.METHOD,
                 'manifestSha256': m.PARENT_SHA, 'oneAttempt': True, 'startedUtc': '2026-11-14T22:11:00Z'}
        failure = {**guard, 'status': 'BLOCKED', 'phase': 'seal', 'code': 'RECOVERY_PHASE_FAILED',
                   'retryAuthorized': False}
        self.old_guard, self.old_failure = encode(guard), encode(failure)
        self.write(m.OLD / 'guard.json', self.old_guard); self.write(m.OLD / 'result.json', self.old_failure)
        m.OLD_GUARD_SHA = hashlib.sha256(self.old_guard).hexdigest()
        m.OLD_RESULT_SHA = hashlib.sha256(self.old_failure).hexdigest()
        self.wf = module(ORIGINAL, 't44_original_fixture_primitives')
        self.wf.OWNER_UID = os.getuid(); self.wf.ANCESTOR_STOP = self.root
        self.wf.IDENTITY = self.root / 'synthetic-identity'
        self.wf.BACKUP_CIPHER = self.root / 'synthetic-backup'
        self.write(self.wf.IDENTITY, b'SYNTHETIC-KEY-NOT-AGE\n')
        self.write(self.wf.BACKUP_CIPHER, b'SYNTHETIC-PINNED-AGE-BACKUP\n')
        self.client = FAKES.FakeClient(); self.crypto = FAKES.FakeCrypto(); self.s3 = FAKES.FakeS3(self.client)
        self.manifest = {'task': 'T44', 'actionId': m.ACTION, 'execution_authorized': True,
            'parentT41ManifestSha256': m.PARENT_SHA, 'failedT41GuardSha256': m.OLD_GUARD_SHA,
            'failedT41ResultSha256': m.OLD_RESULT_SHA, 'ownerFinalAttemptAuthorized': True,
            'maxAdditionalOwnerRecoverAttempts': 1, 'attemptNumber': 2, 'stateRoot': str(m.STATE),
            'expected_t41_public_files': m.PUBLIC_PINS,
            'files': {m.SELF_REL: hashlib.sha256(SCRIPT.read_bytes()).hexdigest()}}
        self.update_manifest()
        self.context = {'wf': self.wf, 'crypto': self.crypto, 's3': self.s3,
            'manifest': self.manifest, 'manifestSha256': self.manifest_sha,
            'selfSha256': self.manifest['files'][m.SELF_REL], 'tools': self.crypto.discover_tools(),
            'backup': {'sha256': hashlib.sha256(self.wf.BACKUP_CIPHER.read_bytes()).hexdigest(),
                       'bytes': self.wf.BACKUP_CIPHER.stat().st_size},
            'originalCodes': {'RECOVERY_DOWNLOAD_SIZE_MISMATCH', 'RECOVERY_DOWNLOAD_SHA_MISMATCH'}}

    @staticmethod
    def write(path, raw):
        path.write_bytes(raw); path.chmod(0o600)

    def update_manifest(self):
        raw = encode(self.manifest); self.write(self.m.MANIFEST, raw)
        self.manifest_sha = hashlib.sha256(raw).hexdigest()

    def assert_old_unchanged(self):
        self.assertEqual((self.m.OLD / 'guard.json').read_bytes(), self.old_guard)
        self.assertEqual((self.m.OLD / 'result.json').read_bytes(), self.old_failure)
        self.assertEqual((self.m.OLD / 'guard.json').stat().st_nlink, 1)
        self.assertEqual((self.m.OLD / 'result.json').stat().st_nlink, 1)
        for name in self.m.OLD_ABSENT: self.assertFalse((self.m.OLD / name).exists())

    def run_recover(self):
        return self.m.owner_recover(self.context)

    def test_full_success_is_isolated_and_verifies_only_downloaded_ciphertext(self):
        original_globals = (self.wf.STATE_ROOT, self.wf.MANIFEST, self.wf.ACTION)
        self.m.prepare(self.context)
        with mock.patch('builtins.input', side_effect=AssertionError('NO_EXTRA_INPUT')):
            result = self.run_recover()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['task'], 'T44'); self.assertEqual(result['attemptNumber'], 2)
        self.assertEqual(result['manifestSha256'], self.manifest_sha)
        self.assertEqual(result['parentT41ManifestSha256'], self.m.PARENT_SHA)
        self.assertEqual(result['putAttempts'], 1); self.assertEqual(result['getAttempts'], 1)
        self.assertEqual(result['putOutcome'], 'CONFIRMED_BY_READBACK')
        self.assertEqual(self.crypto.verify_paths, [self.m.STATE / 'identity.downloaded.age'])
        self.assertEqual(self.crypto.prompts, [True, False])
        self.assertTrue(result['backupProbe']['zstdVerified'])
        self.assertFalse(result['originalIdentityReadForVerification'])
        self.assertTrue((self.m.STATE / 'guard.json').is_file())
        self.assertEqual(original_globals, (self.wf.STATE_ROOT, self.wf.MANIFEST, self.wf.ACTION))
        self.assert_old_unchanged()
        self.assertEqual([kind for kind, _key in self.client.calls], ['HEAD', 'PUT', 'GET'])

    def test_physical_guard_runs_before_claim_input_credentials_or_s3(self):
        self.crypto.console_available = False
        with self.assertRaises(RuntimeError): self.run_recover()
        self.assertFalse((self.m.STATE / 'guard.json').exists())
        self.assertEqual(self.crypto.prompts, [])
        self.assertEqual(self.s3.credential_reads, 0); self.assertEqual(self.client.calls, [])
        self.assert_old_unchanged()

    def test_invalid_input_consumes_final_guard_but_has_no_credentials_key_or_s3(self):
        error = type('EscrowCryptoError', (Exception,), {})('ESCROW_PASSPHRASE_INVALID')
        with mock.patch.object(self.crypto, 'read_owner_passphrase', side_effect=error):
            result = self.run_recover()
        self.assertEqual(result['status'], 'BLOCKED'); self.assertEqual(result['phase'], 'input')
        self.assertEqual(result['code'], 'ESCROW_PASSPHRASE_INVALID')
        self.assertEqual(result['putAttempts'], 0); self.assertEqual(result['getAttempts'], 0)
        self.assertEqual(self.s3.credential_reads, 0); self.assertEqual(self.client.calls, [])
        self.assertEqual(self.crypto.sealed_identity_reads, 0)
        self.assertTrue((self.m.STATE / 'guard.json').exists())
        with self.assertRaises(self.m.FinalRecoveryError): self.run_recover()
        self.assert_old_unchanged()

    def test_confirmation_error_is_safe_and_has_no_retry_loop(self):
        error = type('EscrowCryptoError', (Exception,), {})('ESCROW_PASSPHRASE_CONFIRMATION_FAILED')
        with mock.patch.object(self.crypto, 'read_owner_passphrase', side_effect=error) as call:
            result = self.run_recover()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(result['code'], 'ESCROW_PASSPHRASE_CONFIRMATION_FAILED')
        self.assertFalse(result['retryAuthorized'])
        self.assertEqual(self.client.calls, [])

    def test_busy_local_lock_waits_before_claim_and_input_without_network_retry(self):
        calls, held = [], [False]
        @contextlib.contextmanager
        def lease():
            calls.append('LOCK')
            self.assertFalse((self.m.STATE / 'guard.json').exists())
            self.assertEqual(self.crypto.prompts, [])
            self.assertEqual(self.s3.credential_reads, 0)
            if len(calls) == 1:
                raise self.s3.BackupError('ANOTHER_S3_OPERATION_IS_RUNNING')
            held[0] = True
            try:
                yield
            finally:
                held[0] = False
        original = self.crypto.read_owner_passphrase
        def phrase(confirm=True):
            self.assertTrue(held[0])
            self.assertTrue((self.m.STATE / 'guard.json').exists())
            return original(confirm=confirm)
        with mock.patch.object(self.s3, 'operation_lock', side_effect=lease), \
             mock.patch.object(self.m.time, 'sleep') as sleep, \
             mock.patch.object(self.crypto, 'read_owner_passphrase', side_effect=phrase):
            result = self.run_recover()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(calls, ['LOCK', 'LOCK'])
        self.assertEqual(sleep.call_count, 1)
        self.assertFalse(held[0])
        self.assertEqual([k for k, _ in self.client.calls], ['HEAD', 'PUT', 'GET'])
        self.assert_old_unchanged()

    def test_lock_timeout_never_claims_final_guard_or_prompts_for_secret(self):
        error = self.m.FinalRecoveryError('T44_S3_LOCK_TIMEOUT')
        with mock.patch.object(self.m, 'acquire_local_lock', side_effect=error):
            result = self.run_recover()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['phase'], 's3-lock')
        self.assertFalse(result['attemptClaimed'])
        self.assertEqual(result['code'], 'T44_S3_LOCK_TIMEOUT')
        self.assertFalse((self.m.STATE / 'guard.json').exists())
        self.assertEqual(self.crypto.prompts, [])
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.s3.credential_reads, 0)
        self.assert_old_unchanged()

    def test_only_literal_busy_lock_is_retried_with_bounded_deadline(self):
        @contextlib.contextmanager
        def busy():
            raise self.s3.BackupError('ANOTHER_S3_OPERATION_IS_RUNNING')
            yield
        with mock.patch.object(self.s3, 'operation_lock', side_effect=busy), \
             self.assertRaisesRegex(self.m.FinalRecoveryError, 'T44_S3_LOCK_TIMEOUT'):
            self.m.acquire_local_lock(self.s3, timeout=0)
        @contextlib.contextmanager
        def invalid():
            raise self.s3.BackupError('PRIVATE_STRING_NEVER_PUBLIC')
            yield
        with mock.patch.object(self.s3, 'operation_lock', side_effect=invalid), \
             mock.patch.object(self.m.time, 'sleep', side_effect=AssertionError('NO_RETRY')), \
             self.assertRaisesRegex(self.m.FinalRecoveryError, 'T44_S3_LOCK_FAILED'):
            self.m.acquire_local_lock(self.s3)

    def test_unknown_crypto_text_never_leaves_the_result(self):
        with mock.patch.object(self.crypto, 'read_owner_passphrase', side_effect=RuntimeError('PRIVATE_VALUE_MUST_NOT_ESCAPE')):
            result = self.run_recover()
        self.assertEqual(result['code'], 'T44_PHASE_FAILED')
        self.assertNotIn('PRIVATE_VALUE', json.dumps(result))
        self.assert_old_unchanged()

    def test_lost_put_response_uses_single_get_never_second_put(self):
        self.client.lost_response = True
        result = self.run_recover()
        self.assertEqual(result['status'], 'PASS')
        self.assertTrue(result['putResponseUncertain'])
        self.assertEqual(result['putOutcome'], 'CONFIRMED_BY_READBACK')
        self.assertEqual([k for k, _ in self.client.calls], ['HEAD', 'PUT', 'GET'])
        self.assert_old_unchanged()

    def test_failed_readback_preserves_acknowledged_put_and_no_retry(self):
        self.client.corrupt = True
        result = self.run_recover()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['phase'], 'download')
        self.assertEqual(result['putOutcome'], 'ACKNOWLEDGED')
        self.assertEqual(result['putAttempts'], 1); self.assertEqual(result['getAttempts'], 1)
        self.assertFalse(result['retryAuthorized'])
        self.assert_old_unchanged()

    def test_collision_does_not_download_or_overwrite(self):
        self.client.collision = True
        result = self.run_recover()
        self.assertEqual(result['code'], 'T44_REMOTE_COLLISION')
        self.assertEqual(result['putOutcome'], 'COLLISION_NO_OVERWRITE')
        self.assertEqual(result['getAttempts'], 0)
        self.assertEqual(len(self.client.objects), 0)
        self.assert_old_unchanged()

    def test_late_old_state_drift_keeps_actual_confirmed_remote_outcome(self):
        original = self.crypto.verify_encrypted_identity
        def verify(*args, **kwargs):
            answer = original(*args, **kwargs)
            self.write(self.m.OLD / 'result.json', self.old_failure + b' ')
            return answer
        with mock.patch.object(self.crypto, 'verify_encrypted_identity', side_effect=verify):
            result = self.run_recover()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertFalse(result['oldT41Unchanged'])
        self.assertEqual(result['putOutcome'], 'CONFIRMED_BY_READBACK')
        self.assertEqual(result['putAttempts'], 1); self.assertEqual(result['getAttempts'], 1)

    def test_durability_failure_never_changes_known_put_outcome(self):
        original = self.wf.save_once
        def save(path, value):
            if path == self.m.STATE / 'result.json': raise OSError(5, 'RAW_NOT_PUBLIC')
            return original(path, value)
        with mock.patch.object(self.wf, 'save_once', side_effect=save):
            result = self.run_recover()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['code'], 'T44_RESULT_DURABILITY_FAILED')
        self.assertEqual(result['putOutcome'], 'CONFIRMED_BY_READBACK')
        self.assertEqual(result['putAttempts'], 1)
        self.assert_old_unchanged()

    def test_client_cleanup_failure_keeps_confirmed_remote_outcome(self):
        with mock.patch.object(self.client, 'close', side_effect=RuntimeError('PRIVATE_SDK_DETAIL')):
            result = self.run_recover()
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['code'], 'T44_CLIENT_CLOSE_FAILED')
        self.assertEqual(result['putOutcome'], 'CONFIRMED_BY_READBACK')
        self.assertEqual(result['putAttempts'], 1)
        self.assertNotIn('PRIVATE_SDK_DETAIL', json.dumps(result))
        self.assert_old_unchanged()

    def test_attestation_is_separate_result_sha_bound_and_t44_only(self):
        self.assertEqual(self.run_recover()['status'], 'PASS')
        raw = (self.m.STATE / 'result.json').read_bytes()
        with mock.patch('builtins.input', side_effect=['yes', 'yes', 'yes']):
            answer = self.m.attest(self.context)
        self.assertEqual(answer['status'], 'CONFIRMED')
        self.assertEqual(answer['task'], 'T44')
        self.assertEqual(answer['actionId'], 'T44.owner-key-recovery-attestation')
        self.assertEqual(answer['resultSha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(answer['manifestSha256'], self.manifest_sha)
        self.assert_old_unchanged()

    def test_refused_attestation_never_creates_false_confirmation(self):
        self.assertEqual(self.run_recover()['status'], 'PASS')
        with mock.patch('builtins.input', side_effect=['yes', 'no']), self.assertRaises(self.m.FinalRecoveryError):
            self.m.attest(self.context)
        self.assertFalse((self.m.STATE / 'attestation.json').exists())
        self.assert_old_unchanged()

    def test_real_manifest_self_parent_pins_checked_without_importing_unverified_code(self):
        context = {k: v for k, v in self.context.items() if k not in ('wf', 'manifest', 'selfSha256', 'originalCodes')}
        self.wf.load_context = mock.Mock(return_value=context)
        with mock.patch.object(self.m, 'load_original', return_value=self.wf):
            loaded = self.m.load_context(self.manifest_sha)
            self.assertEqual(loaded['manifestSha256'], self.manifest_sha)
            self.assertEqual(self.m.prepare(loaded)['status'], 'PREPARED')
            again = self.m.ready_context()
            self.assertEqual(again['manifestSha256'], self.manifest_sha)
        self.assertEqual(self.s3.credential_reads, 0); self.assertEqual(self.client.calls, [])
        self.assertEqual(self.crypto.prompts, [])
        self.assert_old_unchanged()
        self.write(self.m.SELF, b'UNVERIFIED_CODE')
        with mock.patch.object(self.m, 'load_original', side_effect=AssertionError('NO_UNVERIFIED_IMPORT')), \
             self.assertRaises(self.m.FinalRecoveryError):
            self.m.load_context(self.manifest_sha)

    def test_unpinned_manifest_invalid_state_and_existing_side_effect_block(self):
        with self.assertRaises(self.m.FinalRecoveryError): self.m.load_context(None)
        with self.assertRaises(self.m.FinalRecoveryError): self.m.load_context('0' * 64)
        self.write(self.m.OLD / 'identity.sealed.age', b'')
        with self.assertRaises(self.m.FinalRecoveryError): self.run_recover()
        self.assertFalse((self.m.STATE / 'guard.json').exists())
        self.assertEqual(self.client.calls, [])

    def test_original_workflow_loader_never_calls_original_entrypoints(self):
        loaded = self.m.load_original(ORIGINAL.read_bytes())
        self.assertEqual(loaded.STATE_ROOT, Path('/root/bron-secrets/t41-owner-recovery'))
        self.assertEqual(loaded.ACTION, 'T41.owner-key-recovery')
        self.assertNotEqual(loaded.__name__, '__main__')
        self.assert_old_unchanged()

    def test_new_process_no_args_is_inert_and_never_prints_traceback(self):
        run = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT)], capture_output=True,
                             text=True, timeout=5)
        self.assertEqual(run.returncode, 2); self.assertEqual(run.stderr, '')
        self.assertIn('BLOCKED', run.stdout); self.assertNotIn('Traceback', run.stdout)
        self.assert_old_unchanged()

    @unittest.skipUnless(os.environ.get('BRON_TEST_AGE_BINARY') and os.environ.get('BRON_TEST_AGE_KEYGEN_BINARY'),
                         'explicit synthetic native tools not supplied')
    def test_native_t44_flow_uses_downloaded_identity_after_raw_fixture_deleted(self):
        age = os.environ['BRON_TEST_AGE_BINARY']; keygen = os.environ['BRON_TEST_AGE_KEYGEN_BINARY']
        self.assertIn(subprocess.check_output([age, '--version']).strip(), (b'1.1.1', b'v1.1.1'))
        self.wf.IDENTITY.unlink()
        subprocess.run([keygen, '-o', str(self.wf.IDENTITY)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        self.wf.IDENTITY.chmod(0o600)
        recipient = subprocess.check_output([keygen, '-y', str(self.wf.IDENTITY)], timeout=10).decode().strip()
        compressed = subprocess.check_output(['/usr/bin/zstd', '-q', '-c'], input=b'SYNTHETIC_ROLE_BACKUP\n', timeout=10)
        cipher = subprocess.check_output([age, '-r', recipient], input=compressed, timeout=10)
        self.write(self.wf.BACKUP_CIPHER, cipher)
        self.context['backup'] = {'sha256': hashlib.sha256(cipher).hexdigest(), 'bytes': len(cipher)}
        native = module(REPO / 'docs/runbooks/payloads/owner-key-escrow-crypto.py', 't44_native_fixture_crypto')
        native.OWNER_UID = os.getuid()
        tools = {'age': age, 'zstd': '/usr/bin/zstd'}
        phrase = 'synthetic native owner phrase for T44 only'
        verified = []
        def verify(path, backup_fd, value, tools=None):
            self.assertFalse(self.wf.IDENTITY.exists())
            self.assertEqual(path, self.m.STATE / 'identity.downloaded.age')
            answer = native.verify_encrypted_identity(path, backup_fd, value, tools=tools)
            verified.append(True)
            return answer
        self.context['crypto'] = SimpleNamespace(require_owner_console=lambda: None,
            read_owner_passphrase=lambda confirm=True: phrase,
            seal_identity=native.seal_identity, verify_encrypted_identity=verify)
        self.context['tools'] = tools
        original_put = self.client.put_object
        def put(**kwargs):
            original_put(**kwargs)
            self.wf.IDENTITY.unlink()  # Removes only the freshly generated synthetic raw key.
        with mock.patch.object(self.client, 'put_object', side_effect=put):
            answer = self.run_recover()
        self.assertEqual(answer['status'], 'PASS')
        self.assertEqual(verified, [True])
        self.assertEqual(answer['putOutcome'], 'CONFIRMED_BY_READBACK')
        self.assertEqual(answer['putAttempts'], 1); self.assertEqual(answer['getAttempts'], 1)
        self.assert_old_unchanged()


if __name__ == '__main__':
    unittest.main()
