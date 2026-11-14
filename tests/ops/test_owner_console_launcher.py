"""Synthetic launcher metadata only; no real root files, secrets or execution."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'docs/runbooks/payloads/t41-owner-console.py'
SPEC = importlib.util.spec_from_file_location('owner_console_launcher', SCRIPT)
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)
sha = lambda value: hashlib.sha256(value).hexdigest()


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='bron-console-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.state, self.runtime = self.root / 'state', self.root / 'runtime'
        self.state.mkdir(mode=0o700)
        self.runtime.mkdir(mode=0o700)
        self.self_path = self.root / 'console.py'
        values = {'STATE': self.state, 'RUNTIME': self.runtime,
                  'MANIFEST': self.state / 'manifest.json',
                  'APPROVED': self.state / 'approved-manifest.sha256',
                  'SELF': str(self.self_path), '__file__': str(self.self_path),
                  'OWNER_UID': os.getuid(), 'OWNER_GID': os.getgid(), 'ANCESTOR_STOP': self.root}
        for name, value in values.items():
            patcher = mock.patch.object(launcher, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.files = {launcher.SELF_REL: b'# synthetic wrapper\n',
                      launcher.WORKFLOW_REL: b'raise AssertionError("must never import workflow")\n',
                      launcher.CRYPTO_REL: b'def require_owner_console():\n    return {"syntheticOnly": True}\n',
                      launcher.S3_REL: b'raise AssertionError("must never import S3")\n'}
        for name, body in self.files.items():
            path = self.self_path if name == launcher.SELF_REL else self.runtime / name
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.write(path, body)
        self.manifest = {'task': 'T41', 'execution_authorized': True,
            'files': {name: sha(body) for name, body in self.files.items()},
            'ownerRecovery': {'method': 'BRON_OWNER_KEY_ESCROW_V1',
                'ownerPhoneConsoleRequired': True, 'executionAuthorized': True,
                'stateRoot': str(self.state), 'runtimeRoot': str(self.runtime),
                'runtimeFiles': {str(self.runtime / name): sha(body)
                    for name, body in self.files.items() if name != launcher.SELF_REL}}}
        self.save_manifest()

    @staticmethod
    def write(path, body):
        path.write_bytes(body)
        path.chmod(0o600)

    def save_manifest(self):
        body = json.dumps(self.manifest).encode()
        self.write(launcher.MANIFEST, body)
        self.pin = sha(body)
        self.write(launcher.APPROVED, (self.pin + '\n').encode())

    def launch(self, mode='check'):
        with mock.patch.object(launcher, 'preliminary_console_guard'):
            return launcher.verify_and_guard(mode)

    def test_three_modes_make_only_fixed_isolated_workflow_command(self):
        for mode, flag in launcher.MODES.items():
            with self.subTest(mode=mode):
                self.assertEqual(self.launch(mode), [launcher.PYTHON, '-I',
                    str(self.runtime / launcher.WORKFLOW_REL), flag,
                    '--manifest', str(launcher.MANIFEST), '--manifest-sha256', self.pin])
        self.assertEqual(set(self.state.iterdir()), {launcher.MANIFEST, launcher.APPROVED})

    def test_missing_or_unknown_action_rejected_before_console_or_files(self):
        for mode in ('', 'run', '--recover', 'check extra'):
            with mock.patch.object(launcher, 'preliminary_console_guard') as console:
                with self.assertRaisesRegex(launcher.ConsoleError, 'EXPLICIT_ACTION_REQUIRED'):
                    launcher.verify_and_guard(mode)
                console.assert_not_called()

    def test_all_modes_require_console_before_any_file_read(self):
        for mode in launcher.MODES:
            with mock.patch.object(launcher, 'preliminary_console_guard',
                    side_effect=launcher.ConsoleError('OWNER_CONSOLE_LOCAL_TTY_REQUIRED')), \
                 mock.patch.object(launcher, 'private_bytes') as read:
                with self.assertRaisesRegex(launcher.ConsoleError, 'LOCAL_TTY_REQUIRED'):
                    launcher.verify_and_guard(mode)
                read.assert_not_called()

    def test_approval_is_exact_lowercase_64_hex_and_one_newline(self):
        for value in (self.pin.encode(), (self.pin + '\n\n').encode(),
                      (self.pin.upper() + '\n').encode(), b'0' * 63 + b'\n'):
            self.write(launcher.APPROVED, value)
            with self.assertRaises(launcher.ConsoleError):
                self.launch()

    def test_manifest_sha_or_scope_cannot_be_substituted(self):
        self.write(launcher.APPROVED, b'0' * 64 + b'\n')
        with self.assertRaisesRegex(launcher.ConsoleError, 'MANIFEST_SHA_MISMATCH'):
            self.launch()
        self.manifest['ownerRecovery']['runtimeRoot'] = '/tmp/elsewhere'
        self.save_manifest()
        with self.assertRaisesRegex(launcher.ConsoleError, 'SCOPE_INVALID'):
            self.launch()

    def test_recovery_and_attest_need_authorization_check_remains_readonly(self):
        self.manifest['execution_authorized'] = False
        self.save_manifest()
        self.launch('check')
        for mode in ('recover', 'attest'):
            with self.assertRaisesRegex(launcher.ConsoleError, 'EXECUTION_NOT_AUTHORIZED'):
                self.launch(mode)

    def test_exact_three_runtime_pins_exclude_wrapper_and_extra_modules(self):
        self.manifest['ownerRecovery']['runtimeFiles'][str(self.self_path)] = '0' * 64
        self.save_manifest()
        with self.assertRaisesRegex(launcher.ConsoleError, 'RUNTIME_PINS_REQUIRED'):
            self.launch()

    def test_every_module_and_self_sha_checked_before_crypto_import(self):
        for name in self.files:
            path = self.self_path if name == launcher.SELF_REL else self.runtime / name
            body = path.read_bytes()
            self.write(path, b'raise AssertionError("UNVERIFIED_CODE_EXECUTED")\n')
            with self.subTest(name=name), self.assertRaisesRegex(launcher.ConsoleError, 'RUNTIME_SHA_MISMATCH'):
                self.launch()
            self.write(path, body)

    def test_parent_and_runtime_pins_must_agree(self):
        self.manifest['ownerRecovery']['runtimeFiles'][str(self.runtime / launcher.CRYPTO_REL)] = '0' * 64
        self.save_manifest()
        with self.assertRaisesRegex(launcher.ConsoleError, 'RUNTIME_PIN_INVALID'):
            self.launch()

    def test_verified_crypto_guard_is_mandatory_before_command(self):
        body = b'def require_owner_console():\n    raise RuntimeError("SYNTHETIC_GUARD_DENIED")\n'
        self.write(self.runtime / launcher.CRYPTO_REL, body)
        self.manifest['files'][launcher.CRYPTO_REL] = sha(body)
        self.manifest['ownerRecovery']['runtimeFiles'][str(self.runtime / launcher.CRYPTO_REL)] = sha(body)
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_GUARD_DENIED'):
            self.launch()

    def test_symlink_hardlink_and_weak_permissions_fail_closed(self):
        path = launcher.APPROVED
        original = path.read_bytes()
        path.chmod(0o644)
        with self.assertRaisesRegex(launcher.ConsoleError, 'PRIVATE_FILE_REQUIRED'):
            self.launch()
        path.chmod(0o600)
        os.link(path, self.state / 'link')
        with self.assertRaisesRegex(launcher.ConsoleError, 'PRIVATE_FILE_REQUIRED'):
            self.launch()
        (self.state / 'link').unlink()
        path.unlink()
        target = self.state / 'target'
        self.write(target, original)
        path.symlink_to(target)
        with self.assertRaises(OSError):
            self.launch()

    def test_ssh_env_and_pipe_devpts_rejected_before_file_or_helper_load(self):
        with contextlib.ExitStack() as stack:
            for name in ('getuid', 'geteuid', 'getgid', 'getegid'):
                stack.enter_context(mock.patch.object(launcher.os, name, return_value=0))
            stack.enter_context(mock.patch.dict(launcher.os.environ, {'SSH_CONNECTION': 'synthetic'}, clear=True))
            with self.assertRaisesRegex(launcher.ConsoleError, 'LOCAL_TTY_REQUIRED'):
                launcher.preliminary_console_guard()
            os.environ.clear()
            for isatty, ttyname in ((False, '/dev/tty1'), (True, '/dev/pts/2')):
                with mock.patch.object(launcher.os, 'isatty', return_value=isatty), \
                     mock.patch.object(launcher.os, 'ttyname', return_value=ttyname):
                    with self.assertRaisesRegex(launcher.ConsoleError, 'LOCAL_TTY_REQUIRED'):
                        launcher.preliminary_console_guard()

    def test_bootstrap_is_fixed_isolated_and_preserves_ssh_denial(self):
        with contextlib.ExitStack() as stack:
            for name in ('getuid', 'geteuid', 'getgid', 'getegid'):
                stack.enter_context(mock.patch.object(launcher.os, name, return_value=0))
            stack.enter_context(mock.patch.object(launcher.sys, 'flags', types.SimpleNamespace(isolated=0)))
            stack.enter_context(mock.patch.object(launcher.sys, 'argv', [str(self.self_path), 'recover']))
            stack.enter_context(mock.patch.dict(launcher.os.environ, {'SSH_TTY': '/dev/pts/2'}, clear=True))
            execute = stack.enter_context(mock.patch.object(launcher.os, 'execve', side_effect=OSError('PRIVATE_OS_TEXT')))
            output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            with self.assertRaises(SystemExit):
                launcher.isolated_bootstrap()
            program, args, env = execute.call_args.args
            self.assertEqual((program, args), (launcher.PYTHON, [launcher.PYTHON, '-I', str(self.self_path), 'recover']))
            self.assertEqual(env['SSH_TTY'], '/dev/pts/2')
            self.assertNotIn('PRIVATE_OS_TEXT', output.getvalue())

    def test_cli_noargs_and_nonroot_never_emit_traceback_or_access_real_files(self):
        for arguments in ([], ['unknown'], ['check']):
            child = subprocess.run([sys.executable, '-I', str(SCRIPT), *arguments],
                capture_output=True, text=True, timeout=3)
            self.assertEqual(child.returncode, 2)
            self.assertEqual(child.stderr, '')
            self.assertRegex(child.stdout, r'^OWNER_CONSOLE_[A-Z_]+\n$')


if __name__ == '__main__':
    unittest.main()
