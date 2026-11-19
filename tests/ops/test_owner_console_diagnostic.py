"""Synthetic public-code fixtures. No VPS/key/backup/S3 or real owner-console proof."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / 'docs/runbooks/payloads/t42-owner-console-diagnostic.py'
SPEC = importlib.util.spec_from_file_location('console_diagnostic', SCRIPT)
diag = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(diag)
sha = lambda data: hashlib.sha256(data).hexdigest()
ISOLATED_SYS = SimpleNamespace(platform=sys.platform, flags=SimpleNamespace(isolated=True))


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='bron-t42-public-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.runtime = self.root / 'runtime'
        self.state.mkdir(mode=0o700)
        self.runtime.mkdir(mode=0o700)
        self.paths = {'WRAPPER': str(self.root / 'wrapper.py'),
            'MANIFEST': str(self.state / 'manifest.json'),
            'MARKER': str(self.state / 'approved-manifest.sha256'),
            'WORKFLOW': str(self.runtime / diag.RELATIVES['WORKFLOW']),
            'CRYPTO': str(self.runtime / diag.RELATIVES['CRYPTO']),
            'S3_CODE': str(self.runtime / diag.RELATIVES['S3_CODE'])}
        self.code = {
            'WRAPPER': (REPO / 'docs/runbooks/payloads/t41-owner-console.py').read_bytes(),
            'CRYPTO': b'def require_owner_console():\n    return {"syntheticOnly": True}\n',
            'WORKFLOW': b'raise AssertionError("WORKFLOW_MUST_NOT_EXECUTE")\n',
            'S3_CODE': b'raise AssertionError("S3_MUST_NOT_EXECUTE")\n'}
        for key, raw in self.code.items():
            p = Path(self.paths[key]);p.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            self.write(p, raw)
        self.parent = {'task': 'T41', 'execution_authorized': True,
            'files': {diag.RELATIVES[key]: sha(raw) for key, raw in self.code.items()},
            'ownerRecovery': {'method': 'BRON_OWNER_KEY_ESCROW_V1',
                'ownerPhoneConsoleRequired': True, 'executionAuthorized': True,
                'stateRoot': str(self.state), 'runtimeRoot': str(self.runtime),
                'runtimeFiles': {self.paths[key]: sha(raw) for key, raw in self.code.items()
                                 if key != 'WRAPPER'}}}
        raw = json.dumps(self.parent).encode()
        self.write(Path(self.paths['MANIFEST']), raw)
        self.write(Path(self.paths['MARKER']), (sha(raw) + '\n').encode())
        self.result_dir = self.root / 'diagnostic'
        self.result_dir.mkdir(mode=0o700)
        values = {'PATHS': self.paths, 'PARENT_SHA': sha(raw), 'WRAPPER_SHA': sha(self.code['WRAPPER']),
                  'CRYPTO_SHA': sha(self.code['CRYPTO']), 'OWNER_UID': os.getuid(),
                  'OWNER_GID': os.getgid(), 'ANCESTOR_STOP': self.root,
                  'RESULT_PATH': self.result_dir / 'phone-result.json'}
        for name, value in values.items():
            patch = mock.patch.object(diag, name, value);patch.start();self.addCleanup(patch.stop)
        self.actual_load = diag.load_wrapper

    @staticmethod
    def write(path, data):
        path.write_bytes(data);path.chmod(0o600)

    def loader(self, raw):
        module = self.actual_load(raw)
        module.SELF = module.__file__ = self.paths['WRAPPER']
        module.STATE = self.state;module.RUNTIME = self.runtime
        module.MANIFEST = Path(self.paths['MANIFEST']);module.APPROVED = Path(self.paths['MARKER'])
        module.OWNER_UID = diag.OWNER_UID;module.OWNER_GID = diag.OWNER_GID
        module.ANCESTOR_STOP = self.root
        module.preliminary_console_guard = lambda: None
        return module

    def evaluate(self, mode='--diagnose', loader=None):
        with mock.patch.object(diag, 'load_wrapper', side_effect=loader or self.loader), \
             mock.patch.object(diag.os, 'execve', side_effect=AssertionError('EXEC_MUST_NOT_RUN')):
            return diag.evaluate(mode)

    def assert_safe(self, result):
        raw = json.dumps(result)
        self.assertNotIn(str(self.root), raw)
        self.assertNotIn('SYNTHETIC_PRIVATE', raw)
        self.assertNotIn('Traceback', raw)
        self.assertFalse(result['diagnosticIsOwnerRecoveryProof'])
        self.assertFalse(result['secretInputRequested'])
        self.assertFalse(result['workflowExecuted'])

    def test_ssh_inspection_matches_public_pins_without_crypto_import_guard_or_writes(self):
        before = set(self.root.rglob('*'))
        with mock.patch.object(diag, 'load_wrapper', side_effect=AssertionError('NO_IMPORT')):
            result = diag.evaluate('--inspect-files')
        self.assertEqual(result['status'], 'INSPECTION_COMPLETE')
        self.assertFalse(result['cryptoImported']);self.assertFalse(result['ownerTtyGuardInvoked'])
        self.assertEqual(set(self.root.rglob('*')), before)
        self.assertEqual(set(result['files']), set(self.paths));self.assert_safe(result)

    def test_success_walks_original_check_path_without_exec_workflow_or_secret_reads(self):
        result = self.evaluate()
        self.assertEqual(result['status'], 'CHECK_PATH_COMPLETE_NO_EXEC')
        self.assertTrue(result['ownerTtyGuardInvoked']);self.assert_safe(result)

    def test_missing_marker_is_named_without_reading_or_executing_other_target(self):
        Path(self.paths['MARKER']).unlink()
        with mock.patch.object(diag, 'load_wrapper', side_effect=AssertionError('NO_IMPORT')):
            result = diag.evaluate('--diagnose')
        self.assertEqual(result['status'], 'BLOCKED');self.assertEqual(result['fileId'], 'MARKER')
        self.assertEqual(result['files']['MARKER']['exceptionClass'], 'FileNotFoundError')
        self.assertEqual(result['files']['MARKER']['errno'], 2);self.assert_safe(result)

    def test_unexpected_tcgetpgrp_error_has_safe_class_errno_without_raw_text(self):
        def loader(raw):
            module = self.loader(raw)
            def failing():
                raise OSError(25, 'SYNTHETIC_PRIVATE_TTY_TEXT')
            module.preliminary_console_guard = failing
            return module
        result = self.evaluate(loader=loader)
        self.assertEqual(result['phase'], 'PRELIMINARY_TTY')
        self.assertEqual(result['exceptionClass'], 'OSError');self.assertEqual(result['errno'], 25)
        self.assert_safe(result)

    def test_actual_crypto_devtty_failure_is_identified_without_raw_traceback(self):
        body = (REPO / 'docs/runbooks/payloads/owner-key-escrow-crypto.py').read_bytes()
        self.write(Path(self.paths['CRYPTO']), body)
        self.parent['files'][diag.RELATIVES['CRYPTO']] = sha(body)
        self.parent['ownerRecovery']['runtimeFiles'][self.paths['CRYPTO']] = sha(body)
        raw = json.dumps(self.parent).encode();self.write(Path(self.paths['MANIFEST']), raw)
        self.write(Path(self.paths['MARKER']), (sha(raw) + '\n').encode())
        actual_open, actual_fstat = os.open, os.fstat
        def opened(path, *args, **kwargs):
            if str(path) == '/dev/tty':
                raise OSError(6, 'SYNTHETIC_PRIVATE_DEVICE_TEXT')
            return actual_open(path, *args, **kwargs)
        def fstat(fd):
            if fd in (0, 1, 2):
                class Info:
                    st_mode = stat.S_IFCHR | 0o600
                    st_rdev = 123
                return Info()
            return actual_fstat(fd)
        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(diag, 'PARENT_SHA', sha(raw)))
            stack.enter_context(mock.patch.object(diag, 'CRYPTO_SHA', sha(body)))
            for name in ('getuid', 'geteuid', 'getgid', 'getegid'):
                stack.enter_context(mock.patch.object(os, name, return_value=0))
            stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
            stack.enter_context(mock.patch.object(os, 'isatty', return_value=True))
            stack.enter_context(mock.patch.object(os, 'ttyname', return_value='/dev/tty1'))
            stack.enter_context(mock.patch.object(os, 'tcgetpgrp', return_value=os.getpgrp()))
            stack.enter_context(mock.patch.object(os, 'open', side_effect=opened))
            stack.enter_context(mock.patch.object(os, 'fstat', side_effect=fstat))
            result = self.evaluate()
        self.assertEqual(result['phase'], 'PINNED_CRYPTO_IMPORT_OR_TTY')
        self.assertEqual(result['exceptionClass'], 'EscrowCryptoError')
        self.assertEqual(result['causeCode'], 'ESCROW_PHYSICAL_TTY_REQUIRED')
        self.assertEqual(result['fileId'], 'CRYPTO');self.assertTrue(result['frames'])
        self.assert_safe(result)

    def test_changed_wrapper_crypto_or_parent_pins_never_execute(self):
        for key in ('WRAPPER', 'CRYPTO', 'MANIFEST'):
            path = Path(self.paths[key]);original = path.read_bytes()
            self.write(path, original + b'\n# SYNTHETIC_PRIVATE_TAMPER\n')
            with self.subTest(key=key), mock.patch.object(diag, 'load_wrapper',
                    side_effect=AssertionError('NO_IMPORT')):
                result = diag.evaluate('--diagnose')
                self.assertEqual(result['status'], 'BLOCKED');self.assert_safe(result)
            self.write(path, original)

    def test_parent_symlink_and_group_writable_directory_are_rejected_before_file_read(self):
        workflow = Path(self.paths['WORKFLOW']);parent = workflow.parent
        parent.chmod(0o770)
        result = diag.evaluate('--inspect-files')
        self.assertEqual(result['files']['WORKFLOW']['causeCode'], 'T42_PUBLIC_DIRECTORY_UNSAFE')
        parent.chmod(0o700)
        renamed = parent.with_name('renamed');parent.rename(renamed);parent.symlink_to(renamed, target_is_directory=True)
        result = diag.evaluate('--inspect-files')
        self.assertEqual(result['files']['WORKFLOW']['causeCode'], 'T42_PUBLIC_DIRECTORY_UNSAFE')

    def test_arbitrary_path_symlink_and_hardlink_file_reads_refused(self):
        with self.assertRaisesRegex(diag.DiagnosticError, 'PUBLIC_PATH_FORBIDDEN'):
            diag.read_public('/root/bron-secrets/source-backup.agekey')
        p = Path(self.paths['MARKER']);raw = p.read_bytes()
        os.link(p, self.state / 'link')
        self.assertEqual(diag.evaluate('--inspect-files')['files']['MARKER']['causeCode'], 'T42_PUBLIC_FILE_UNSAFE')
        (self.state / 'link').unlink();p.unlink()
        other = self.state / 'other';self.write(other, raw);p.symlink_to(other)
        self.assertEqual(diag.evaluate('--inspect-files')['files']['MARKER']['exceptionClass'], 'OSError')

    def test_unknown_exceptions_and_unapproved_text_never_escape(self):
        for error in (RuntimeError('SYNTHETIC_PRIVATE_PASSWORD'), ValueError('OWNER_CONSOLE_SECRET')):
            result = diag.safe_exception(error)
            self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(result));self.assertNotIn('causeCode', result)

    def test_terminal_errors_report_each_fd_without_guard_or_exception_text(self):
        with mock.patch.object(os, 'ttyname', side_effect=OSError(25, 'SYNTHETIC_PRIVATE_NAME')), \
             mock.patch.object(os, 'tcgetpgrp', side_effect=OSError(25, 'SYNTHETIC_PRIVATE_GROUP')):
            result = diag.tty_metadata()
        self.assertEqual(len(result['fds']), 3)
        self.assertEqual(result['fds'][0]['foregroundError']['errno'], 25)
        self.assertNotIn('SYNTHETIC_PRIVATE', json.dumps(result))

    def test_fixed_diagnostic_artifact_is_exclusive_private_fsynced_and_hash_verified(self):
        fd = diag.claim_result()
        try:
            value = {'format': 1, 'task': 'T42', 'status': 'BLOCKED', 'code': 'T42_FIXTURE'}
            digest = diag.persist_result(fd, value)
        finally:
            os.close(fd)
        self.assertEqual(sha(diag.RESULT_PATH.read_bytes()), digest)
        self.assertEqual(json.loads(diag.RESULT_PATH.read_bytes()), value)
        self.assertEqual(stat.S_IMODE(diag.RESULT_PATH.stat().st_mode), 0o600)
        with self.assertRaisesRegex(diag.DiagnosticError, 'RESULT_ALREADY_EXISTS'):
            diag.claim_result()

    def test_actual_cli_unsupported_nonroot_modes_are_inert_and_safe(self):
        for args in ([], ['--recover'], ['--diagnose'], ['--inspect-files']):
            child = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT), *args],
                capture_output=True, text=True, timeout=3)
            self.assertEqual(child.returncode, 2);self.assertEqual(child.stderr, '')
            self.assertEqual(json.loads(child.stdout)['status'], 'BLOCKED')
            self.assertNotIn('Traceback', child.stdout)

    def test_phone_main_preserves_stdio_and_saves_only_own_immutable_diagnostic_result(self):
        value = {'format': 1, 'task': 'T42', 'status': 'CHECK_PATH_COMPLETE_NO_EXEC',
                 'code': 'T42_WRAPPER_CHECK_PATH_PASSED', 'phase': 'COMPLETE',
                 'files': {'SYNTHETIC': {'status': 'MATCH'}}, 'terminal': {'synthetic': True}}
        with contextlib.ExitStack() as stack:
            for name in ('getuid', 'geteuid', 'getgid', 'getegid'):
                stack.enter_context(mock.patch.object(os, name, return_value=0))
            stack.enter_context(mock.patch.object(diag, 'sys', ISOLATED_SYS))
            stack.enter_context(mock.patch.object(diag, 'SELF', diag.__file__))
            evaluate = stack.enter_context(mock.patch.object(diag, 'evaluate', return_value=value))
            stack.enter_context(mock.patch.object(os, 'dup2', side_effect=AssertionError('NO_STDIO_REDIRECT')))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                rc = diag.main(['--diagnose'])
            self.assertEqual(rc, 0)
            saved = diag.RESULT_PATH.read_bytes();shown = json.loads(output.getvalue())
            self.assertEqual(sha(saved), shown['diagnosticResultSha256'])
            self.assertIn('terminal', json.loads(saved));self.assertNotIn('terminal', shown)
            self.assertNotIn('diagnosticResultSha256', json.loads(saved))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                rc = diag.main(['--diagnose'])
            self.assertEqual(rc, 2);self.assertEqual(evaluate.call_count, 1)
            self.assertEqual(json.loads(output.getvalue())['causeCode'], 'T42_RESULT_ALREADY_EXISTS')
            self.assertEqual(diag.RESULT_PATH.read_bytes(), saved)

    def test_interrupt_emits_safe_code_and_preserves_spent_diagnostic_result(self):
        with contextlib.ExitStack() as stack:
            for name in ('getuid', 'geteuid', 'getgid', 'getegid'):
                stack.enter_context(mock.patch.object(os, name, return_value=0))
            stack.enter_context(mock.patch.object(diag, 'sys', ISOLATED_SYS))
            stack.enter_context(mock.patch.object(diag, 'SELF', diag.__file__))
            stack.enter_context(mock.patch.object(diag, 'evaluate', side_effect=KeyboardInterrupt()))
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(diag.main(['--diagnose']), 2)
            self.assertEqual(json.loads(output.getvalue())['code'], 'T42_DIAGNOSTIC_INTERRUPTED')
            self.assertNotIn('Traceback', output.getvalue())
            self.assertEqual(json.loads(diag.RESULT_PATH.read_bytes())['code'], 'T42_DIAGNOSTIC_INTERRUPTED')


if __name__ == '__main__':
    unittest.main()
