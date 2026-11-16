"""Synthetic-only owner escrow crypto tests. No VPS/S3/actual key inputs."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('owner_escrow_crypto',
    ROOT / 'docs/runbooks/payloads/owner-key-escrow-crypto.py')
CRYPTO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CRYPTO)
SYNTHETIC_PHRASE = 'synthetic only owner phrase november 2026'
NATIVE_DIR = Path('/tmp/bron-age-v111-native-xj1zskny')


class InputTests(unittest.TestCase):
    def test_invalid_phrase_never_reaches_native_or_owner_terminal(self):
        for phrase in ('', ' ' * 30, 'a' * 30, 'short', 'has\nnewline and twenty characters',
                       'has\x00null and twenty characters', 'x' * 1025, 'valid-looking\u200bzero-width-text',
                       'surrogate synthetic phrase \ud800 denied'):
            with self.subTest(phraseLength=len(phrase)):
                with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_PASSPHRASE_INVALID$'):
                    CRYPTO._validate_passphrase(phrase)

    def test_hidden_confirm_exact_no_strip_or_key_read(self):
        phrase = ' leading exact synthetic phrase 2026 '
        with mock.patch.object(CRYPTO, 'require_owner_console') as console, \
             mock.patch.object(CRYPTO.getpass, 'getpass', side_effect=[phrase, phrase]) as read, \
             mock.patch.object(CRYPTO.os, 'open', side_effect=AssertionError('file read forbidden')):
            self.assertEqual(CRYPTO.read_owner_passphrase(), phrase)
            self.assertEqual(read.call_count, 2)
            console.assert_called_once()

    def test_third_input_is_independent_and_does_not_confirm(self):
        with mock.patch.object(CRYPTO, 'require_owner_console'), \
             mock.patch.object(CRYPTO.getpass, 'getpass', return_value=SYNTHETIC_PHRASE) as read:
            self.assertEqual(CRYPTO.read_owner_passphrase(confirm=False), SYNTHETIC_PHRASE)
            self.assertEqual(read.call_count, 1)

    def test_confirmation_difference_fails_without_secret_in_error(self):
        with mock.patch.object(CRYPTO, 'require_owner_console'), \
             mock.patch.object(CRYPTO.getpass, 'getpass', side_effect=[SYNTHETIC_PHRASE, SYNTHETIC_PHRASE.upper()]):
            with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_PASSPHRASE_CONFIRMATION_FAILED$'):
                CRYPTO.read_owner_passphrase()

    def test_console_must_pass_before_hidden_input(self):
        with mock.patch.object(CRYPTO, 'require_owner_console',
                               side_effect=CRYPTO.EscrowCryptoError('ESCROW_PHYSICAL_TTY_REQUIRED')), \
             mock.patch.object(CRYPTO.getpass, 'getpass') as read:
            with self.assertRaises(CRYPTO.EscrowCryptoError):
                CRYPTO.read_owner_passphrase()
            read.assert_not_called()

    def _root_context(self):
        stack = contextlib.ExitStack()
        for name in ('getuid', 'geteuid', 'getgid', 'getegid'):
            stack.enter_context(mock.patch.object(CRYPTO.os, name, return_value=0))
        stack.enter_context(mock.patch.dict(CRYPTO.os.environ, {}, clear=True))
        return stack

    def test_ssh_rejected_even_if_it_supplies_tty(self):
        with self._root_context(), mock.patch.dict(CRYPTO.os.environ, {'SSH_CONNECTION': 'synthetic'}), \
             mock.patch.object(CRYPTO.os, 'isatty') as isatty:
            with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_REMOTE_SHELL_FORBIDDEN$'):
                CRYPTO.require_owner_console()
            isatty.assert_not_called()

    def test_devpts_and_pipes_rejected(self):
        with self._root_context(), mock.patch.object(CRYPTO.os, 'isatty', return_value=True), \
             mock.patch.object(CRYPTO.os, 'ttyname', return_value='/dev/pts/1'):
            with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_PHYSICAL_TTY_REQUIRED$'):
                CRYPTO.require_owner_console()
        with self._root_context(), mock.patch.object(CRYPTO.os, 'isatty', return_value=False):
            with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_PHYSICAL_TTY_REQUIRED$'):
                CRYPTO.require_owner_console()

    def test_physical_foreground_console_metadata_accepted_as_synthetic_only(self):
        for name in ('/dev/tty1', '/dev/ttyS0', '/dev/hvc0'):
            with self.subTest(name=name), self._root_context(), \
                 mock.patch.object(CRYPTO.os, 'isatty', return_value=True), \
                 mock.patch.object(CRYPTO.os, 'ttyname', return_value=name), \
                 mock.patch.object(CRYPTO.os, 'fstat', return_value=types.SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=4)), \
                 mock.patch.object(CRYPTO.os, 'getpgrp', return_value=42), \
                 mock.patch.object(CRYPTO.os, 'tcgetpgrp', return_value=42), \
                 mock.patch.object(CRYPTO.os, 'open', return_value=123), \
                 mock.patch.object(CRYPTO.os, 'close'), \
                 mock.patch.object(CRYPTO.resource, 'setrlimit'):
                value = CRYPTO.require_owner_console()
                self.assertTrue(value['physicalRootConsole'])
                self.assertEqual(value['phoneOwnership'], 'OWNER_ATTESTATION_REQUIRED')


class NativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.age = NATIVE_DIR / 'age'
        cls.gen = NATIVE_DIR / 'age-keygen'
        cls.zstd = Path('/usr/bin/zstd')
        if not all(path.is_file() for path in (cls.age, cls.gen, cls.zstd)):
            raise unittest.SkipTest('exact native synthetic age1.1.1 fixture not installed')
        version = subprocess.check_output([str(cls.age), '--version'], text=True).strip()
        if version not in ('1.1.1', 'v1.1.1'):
            raise unittest.SkipTest('fixture is not exact age1.1.1')
        cls.tools = {'age': str(cls.age), 'zstd': str(cls.zstd)}

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='bron-escrow-crypto-synthetic-')
        self.root = Path(self.directory.name)
        os.chmod(self.root, 0o700)
        self.key = self.root / 'synthetic-identity'
        self.backup = self.root / 'synthetic-roles.sql.zst.age'
        self.wrapped = self.root / 'synthetic-downloaded-identity.age'
        subprocess.run([str(self.gen), '-o', str(self.key)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        recipient = subprocess.check_output([str(self.gen), '-y', str(self.key)], text=True).strip()
        body = subprocess.check_output([str(self.zstd), '--compress', '--quiet', '--stdout'],
                                       input=b'SYNTHETIC ROLES ONLY\n')
        with self.backup.open('wb') as output:
            subprocess.run([str(self.age), '--recipient', recipient], input=body,
                           stdout=output, stderr=subprocess.DEVNULL, check=True)
        os.chmod(self.backup, 0o600)
        self.uid_patch = mock.patch.object(CRYPTO, 'OWNER_UID', os.getuid())
        self.uid_patch.start()

    def tearDown(self):
        self.uid_patch.stop()
        self.directory.cleanup()

    def _seal(self):
        raw = os.open(self.key, os.O_RDONLY | os.O_NOFOLLOW)
        output = os.open(self.wrapped, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            return CRYPTO.seal_identity(raw, output, SYNTHETIC_PHRASE, tools=self.tools)
        finally:
            os.close(raw)
            os.close(output)

    def test_native_roundtrip_after_raw_identity_deleted_and_wrong_phrase_rejected(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            sealed = self._seal()
            self.key.unlink()  # Verification cannot fall back to this identity.
            backup_fd = os.open(self.backup, os.O_RDONLY | os.O_NOFOLLOW)
            original_open = CRYPTO.os.open
            opened = []
            def restricted_open(path, *args, **kwargs):
                opened.append(os.fspath(path))
                if os.fspath(path) == '/root/bron-secrets/source-backup.agekey':
                    raise AssertionError('original production identity read forbidden')
                return original_open(path, *args, **kwargs)
            try:
                with mock.patch.object(CRYPTO.os, 'open', side_effect=restricted_open):
                    checked = CRYPTO.verify_encrypted_identity(self.wrapped, backup_fd,
                                                               SYNTHETIC_PHRASE, tools=self.tools)
                with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_NATIVE_CRYPTO_FAILED$'):
                    CRYPTO.verify_encrypted_identity(self.wrapped, backup_fd,
                        'different synthetic passphrase november 2026', tools=self.tools)
            finally:
                os.close(backup_fd)
        self.assertEqual(sealed['status'], 'SEALED')
        self.assertEqual(checked['status'], 'PASS')
        self.assertFalse(checked['originalIdentityRead'])
        self.assertEqual([path for path in opened if path != '/dev/null'], [str(self.wrapped)])
        self.assertFalse(stdout.getvalue())
        self.assertFalse(stderr.getvalue())
        self.assertNotIn(SYNTHETIC_PHRASE, json.dumps([sealed, checked]))
        self.assertEqual(sorted(path.name for path in self.root.iterdir()),
                         sorted([self.backup.name, self.wrapped.name]))

    def test_original_identity_path_is_forbidden_before_open(self):
        backup_fd = os.open(self.backup, os.O_RDONLY)
        try:
            with mock.patch.object(CRYPTO.os, 'open', side_effect=AssertionError('no file may be opened')) as opened:
                with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_ORIGINAL_IDENTITY_VERIFY_FORBIDDEN$'):
                    CRYPTO.verify_encrypted_identity(CRYPTO.ORIGINAL_IDENTITY_PATH, backup_fd,
                                                    SYNTHETIC_PHRASE, tools=self.tools)
                opened.assert_not_called()
        finally:
            os.close(backup_fd)

    def test_valid_age_with_invalid_zstd_is_not_a_restore_pass(self):
        self._seal()
        recipient = subprocess.check_output([str(self.gen), '-y', str(self.key)], text=True).strip()
        with self.backup.open('wb') as output:
            subprocess.run([str(self.age), '--recipient', recipient], input=b'SYNTHETIC NOT ZSTD\n',
                           stdout=output, stderr=subprocess.DEVNULL, check=True)
        self.key.unlink()
        backup_fd = os.open(self.backup, os.O_RDONLY)
        try:
            with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_BACKUP_DECOMPRESS_FAILED$'):
                CRYPTO.verify_encrypted_identity(self.wrapped, backup_fd, SYNTHETIC_PHRASE, tools=self.tools)
        finally:
            os.close(backup_fd)

    def test_existing_output_file_and_writable_source_rejected_before_native(self):
        self.wrapped.write_bytes(b'existing ciphertext')
        os.chmod(self.wrapped, 0o600)
        raw = os.open(self.key, os.O_RDONLY)
        output = os.open(self.wrapped, os.O_RDWR)
        try:
            with mock.patch.object(CRYPTO, '_age_terminal') as run:
                with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_FILE_UNSAFE$'):
                    CRYPTO.seal_identity(raw, output, SYNTHETIC_PHRASE, tools=self.tools)
                run.assert_not_called()
        finally:
            os.close(raw)
            os.close(output)
        self.assertEqual(self.wrapped.read_bytes(), b'existing ciphertext')

    def test_symlink_encrypted_identity_rejected_without_original_read(self):
        self.wrapped.symlink_to(self.key)
        backup_fd = os.open(self.backup, os.O_RDONLY)
        try:
            with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_ENCRYPTED_IDENTITY_VERIFY_FAILED$'):
                CRYPTO.verify_encrypted_identity(self.wrapped, backup_fd, SYNTHETIC_PHRASE, tools=self.tools)
        finally:
            os.close(backup_fd)

    def test_timeout_kills_private_native_child_without_output_forwarding(self):
        fake = self.root / 'synthetic-stalling-age'
        fake.write_text('#!/usr/bin/python3\nimport os,time\nos.write(2,b"Enter passphrase: ")\n'
                        'fd=os.open("/dev/tty",os.O_RDONLY)\nos.read(fd,2048)\n'
                        'os.write(2,b"SYNTHETIC_PRIVATE_NATIVE_STDERR")\ntime.sleep(20)\n')
        fake.chmod(0o700)
        raw = os.open(self.key, os.O_RDONLY)
        output = os.open(self.wrapped, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
        begin = time.monotonic()
        try:
            with self.assertRaisesRegex(CRYPTO.EscrowCryptoError, '^ESCROW_CRYPTO_DEADLINE$'):
                CRYPTO.seal_identity(raw, output, SYNTHETIC_PHRASE,
                    tools={'age': str(fake), 'zstd': str(self.zstd)}, timeout=0.3)
        finally:
            os.close(raw)
            os.close(output)
        self.assertLess(time.monotonic() - begin, 3)
        self.assertEqual(self.wrapped.read_bytes(), b'')
        with self.assertRaises(ChildProcessError):
            os.waitpid(-1, os.WNOHANG)


if __name__ == '__main__':
    unittest.main()
