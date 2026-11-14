"""Synthetic only: guards and proof pipelines; never an owner identity."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'docs/runbooks/payloads/t29-owner-key-proof.py'
SPEC = importlib.util.spec_from_file_location('owner_key_proof', SCRIPT)
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)
SYNTHETIC = 'AGE-SECRET-KEY-1' + 'A' * 58


class OwnerKeyProofTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='bron-proof-tests-')
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)
        self.base = self.root / 'backups'
        self.base.mkdir(mode=0o700)
        self.backup = self.base / 'target-20261113T133022Z-c4d9bbfd'
        self.backup.mkdir(mode=0o700)
        self.patches = [mock.patch.object(proof, 'BACKUP_BASE', self.base),
            mock.patch.object(proof, 'BACKUP_ROOT', self.backup),
            mock.patch.object(proof, 'ANCESTOR_STOP', self.root),
            mock.patch.object(proof, 'OWNER_UID', os.getuid())]
        for patch in self.patches: patch.start()
        self.cipher = self.backup / 'roles.sql.zst.age'
        self.cipher.write_bytes(b'age-encryption.org/v1\nsynthetic fixture')
        self.cipher.chmod(0o600)
        self.sha = hashlib.sha256(self.cipher.read_bytes()).hexdigest()

    def tearDown(self):
        for patch in reversed(self.patches): patch.stop()
        self.tmp.cleanup()

    def test_cipher_is_private_hash_verified_and_fd_rewound(self):
        fd, size = proof.cipher_fd(str(self.cipher), self.sha)
        try:
            self.assertEqual(size, self.cipher.stat().st_size)
            self.assertEqual(os.read(fd, size), self.cipher.read_bytes())
        finally:
            os.close(fd)
        with self.assertRaisesRegex(proof.ProofError, 'SHA_MISMATCH'):
            proof.cipher_fd(str(self.cipher), '0' * 64)

    def test_untrusted_paths_permissions_symlinks_hardlinks_and_size_rejected(self):
        self.cipher.chmod(0o644)
        with self.assertRaises(proof.ProofError):
            proof.cipher_fd(str(self.cipher), self.sha)
        self.cipher.chmod(0o600)
        link = self.root / 'link.age'
        link.symlink_to(self.cipher)
        with self.assertRaises(proof.ProofError):
            proof.cipher_fd(str(link), self.sha)
        link.unlink()
        os.link(self.cipher, link)
        with self.assertRaises(proof.ProofError):
            proof.cipher_fd(str(self.cipher), self.sha)
        link.unlink()
        self.backup.chmod(0o750)
        with self.assertRaises(proof.ProofError):
            proof.cipher_fd(str(self.cipher), self.sha)
        self.backup.chmod(0o700)
        with mock.patch.object(proof, 'MAX_CIPHER', 1), self.assertRaises(proof.ProofError):
            proof.cipher_fd(str(self.cipher), self.sha)
        with self.assertRaises(proof.ProofError):
            proof.cipher_fd('/etc/passwd', self.sha)

    def test_check_never_prompts_and_errors_never_print_details(self):
        output = io.StringIO()
        with mock.patch.object(proof.os, 'getuid', return_value=0), mock.patch.object(proof.os, 'geteuid', return_value=0), mock.patch.object(proof, 'discover_tools', return_value={'age': '/usr/bin/age', 'zstd': '/usr/bin/zstd'}), \
             mock.patch.object(proof.getpass, 'getpass', side_effect=AssertionError('no secret prompt')), \
             contextlib.redirect_stdout(output):
            code = proof.main(['--check', '--ciphertext', str(self.cipher), '--sha256', self.sha])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())['identityRequested'], False)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = proof.main(['--check', '--ciphertext', str(self.cipher), '--sha256', self.sha, SYNTHETIC])
        self.assertEqual(code, 2)
        self.assertNotIn(SYNTHETIC, output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())

    def test_verify_refuses_noninteractive_input_before_getpass(self):
        with mock.patch.object(proof.os, 'getuid', return_value=0), mock.patch.object(proof.os, 'geteuid', return_value=0), mock.patch.object(proof, 'discover_tools', return_value={}), \
             mock.patch.object(proof.sys.stdin, 'isatty', return_value=False), \
             mock.patch.object(proof.getpass, 'getpass', side_effect=AssertionError('no fallback echo')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            code = proof.main(['--verify', '--ciphertext', str(self.cipher), '--sha256', self.sha])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())['code'], 'KEY_PROOF_TTY_REQUIRED')

    def test_mac_and_nonroot_cli_are_blocked_before_any_cipher_or_key_read(self):
        for platform, uid in [('darwin', 0), ('linux', 1000)]:
            with mock.patch.object(proof.sys, 'platform', platform), \
                 mock.patch.object(proof.os, 'getuid', return_value=uid), \
                 mock.patch.object(proof.os, 'geteuid', return_value=uid), \
                 mock.patch.object(proof, 'cipher_fd', side_effect=AssertionError('no backup read')), \
                 mock.patch.object(proof.getpass, 'getpass', side_effect=AssertionError('no key prompt')), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(proof.main(['--check', '--ciphertext', str(self.cipher), '--sha256', self.sha]), 2)
            self.assertEqual(json.loads(output.getvalue())['code'], 'KEY_PROOF_VPS_ROOT_REQUIRED')

    def test_tools_outside_trusted_prefix_or_absent_are_rejected(self):
        with mock.patch.object(proof.os.path, 'exists', return_value=False), self.assertRaises(proof.ProofError):
            proof.discover_tools()
        fake = self.root / 'age'
        fake.write_text('#!/bin/sh\nexit 0\n')
        fake.chmod(0o700)
        with mock.patch.object(proof.os.path, 'exists', return_value=True), mock.patch.object(proof.os.path, 'realpath', return_value=str(fake)), self.assertRaises(proof.ProofError):
            proof.discover_tools()

    def test_identity_cannot_appear_in_subprocess_arguments_and_output_is_discarded(self):
        fake_age = self.root / 'fake-age'
        fake_zstd = self.root / 'fake-zstd'
        fake_age.write_text('#!/usr/bin/env python3\nimport os,sys\nkey=os.read(int(sys.argv[-1].split("/")[-1]),1024).decode().strip()\nsys.stdin.buffer.read()\nif not key.endswith("A"):sys.exit(1)\nsys.stdout.buffer.write(b"PRIVATE_PLAINTEXT")\n')
        fake_zstd.write_text('#!/usr/bin/env python3\nimport sys\nsys.exit(0 if sys.stdin.buffer.read()==b"PRIVATE_PLAINTEXT" else 1)\n')
        for path in (fake_age, fake_zstd):
            path.chmod(0o700)
        tools = {'age': str(fake_age), 'zstd': str(fake_zstd)}
        original = subprocess.Popen
        calls = []
        def record(*args, **kwargs):
            calls.append((args, kwargs))
            return original(*args, **kwargs)
        fd, _ = proof.cipher_fd(str(self.cipher), self.sha)
        try:
            with mock.patch.object(proof.subprocess, 'Popen', side_effect=record):
                proof.verify_fd(fd, SYNTHETIC, tools)
            self.assertNotIn(SYNTHETIC, repr(calls))
            self.assertEqual(calls[0][1]['stderr'], subprocess.DEVNULL)
            self.assertEqual(set(calls[0][1]['env']), {'PATH', 'LANG', 'LC_ALL'})
            self.assertEqual(calls[1][1]['stdout'], subprocess.DEVNULL)
            self.assertEqual(calls[1][1]['stderr'], subprocess.DEVNULL)
            os.lseek(fd, 0, os.SEEK_SET)
            with self.assertRaisesRegex(proof.ProofError, 'DECRYPT_FAILED'):
                proof.verify_fd(fd, 'AGE-SECRET-KEY-1' + 'B' * 58, tools)
        finally:
            os.close(fd)

    def test_deadline_kills_and_reaps_both_pipeline_processes(self):
        fake = self.root / 'hanging-tool'
        fake.write_text('#!/usr/bin/python3\nimport time\ntime.sleep(30)\n')
        fake.chmod(0o700)
        processes = []
        original = subprocess.Popen
        def record(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process
        fd, _ = proof.cipher_fd(str(self.cipher), self.sha)
        try:
            with mock.patch.object(proof.subprocess, 'Popen', side_effect=record), \
                 self.assertRaisesRegex(proof.ProofError, 'KEY_PROOF_DEADLINE'):
                proof.verify_fd(fd, SYNTHETIC, {'age': str(fake), 'zstd': str(fake)}, timeout=0.05)
            self.assertEqual(len(processes), 2)
            self.assertTrue(all(process.poll() is not None for process in processes))
        finally:
            os.close(fd)


if __name__ == '__main__':
    unittest.main()
