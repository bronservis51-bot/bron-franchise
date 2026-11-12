"""Offline public fixtures; no VPS, SQL, real backup keys or network."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/timeweb/verify-source-backup.py"
SPEC = importlib.util.spec_from_file_location("bron_verify_backup", SCRIPT)
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)
PUBLIC_PAYLOAD = b"public fixture representing sensitive plaintext, never printed\n" * 20


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.backups = self.root / "backups"
        self.backups.mkdir(mode=0o700)
        self.directory = self.backups / "source-20261112T130000Z-1234abcd"
        self.directory.mkdir(mode=0o700)
        self.secrets = self.root / "secrets"
        self.secrets.mkdir(mode=0o700)
        self.identity = self.secrets / "source-backup.agekey"
        self.identity.write_bytes(b"public fixture key, not a valid age identity\n")
        self.identity.chmod(0o600)
        self.manifest_path = self.directory / "manifest.json"
        self.manifest = {"format": 1, "complete": False,
                         "source_project": "vkkqffvmztpzgygzfxhq",
                         "status": "sql_auth_stage_only_restore_unverified", "artifacts": []}
        for name in sorted(verify.EXPECTED_FILES):
            data = b"ciphertext-public-fixture:" + name.encode() + b"." * 150
            path = self.directory / name
            path.write_bytes(data)
            path.chmod(0o600)
            self.manifest["artifacts"].append({"file": name, "bytes": len(data),
                                               "sha256": hashlib.sha256(data).hexdigest()})
        self.save_manifest()
        self.patches = contextlib.ExitStack()
        self.addCleanup(self.patches.close)
        for name, value in (("BACKUP_ROOT", self.backups), ("SECRET_DIR", self.secrets),
                            ("IDENTITY_FILE", self.identity), ("OWNER_UID", os.getuid())):
            self.patches.enter_context(mock.patch.object(verify, name, value))
        self.patches.enter_context(mock.patch.object(verify.os, "geteuid", return_value=0))

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.manifest_path.chmod(0o600)


class ManifestAndFilesTests(Fixture):
    def test_valid_stage_checks_all_hashes_before_pipelines_and_remains_incomplete(self):
        before = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        with mock.patch.object(verify, "check_stream") as pipeline:
            result = verify.verify(self.manifest_path)
        self.assertEqual(pipeline.call_count, 7)
        self.assertTrue(result["verified"])
        self.assertIs(result["complete"], False)
        self.assertFalse(result["restore_performed"])
        self.assertFalse(result["plaintext_files_written"])
        self.assertFalse(result["manifest_modified"])
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.directory.iterdir()})

    def test_last_corrupt_artifact_prevents_all_decryption(self):
        entry = self.manifest["artifacts"][-1]
        path = self.directory / entry["file"]
        path.write_bytes(b"X" * entry["bytes"])
        with mock.patch.object(verify, "check_stream") as pipeline:
            with self.assertRaisesRegex(verify.VerificationError, "SHA256_MISMATCH"):
                verify.verify(self.manifest_path)
        pipeline.assert_not_called()

    def test_size_mismatch_is_not_accepted_with_old_hash(self):
        (self.directory / self.manifest["artifacts"][0]["file"]).write_bytes(b"short")
        with self.assertRaisesRegex(verify.VerificationError, "SIZE_MISMATCH"):
            verify.verify(self.manifest_path)

    def test_explicit_single_snapshot_manifest_required(self):
        for path in (Path("manifest.json"), self.directory / "../manifest.json",
                     self.directory / "roles.sql.zst.age", self.backups / "source-other/manifest.json"):
            with self.subTest(path=path), self.assertRaisesRegex(verify.VerificationError, "EXPLICIT_SOURCE"):
                verify.read_manifest(path)

    def test_duplicate_missing_traversal_or_other_snapshot_entries_are_rejected(self):
        for mutate in (
            lambda a: a.pop(),
            lambda a: a.__setitem__(0, a[1].copy()),
            lambda a: a[0].update(file="../other-source/roles.sql.zst.age"),
            lambda a: a[0].update(file="/tmp/roles.sql.zst.age"),
            lambda a: a[0].update(bytes=True),
            lambda a: a[0].update(sha256="not-a-checksum"),
        ):
            with self.subTest(mutate=mutate):
                original = json.loads(json.dumps(self.manifest))
                mutate(self.manifest["artifacts"])
                self.save_manifest()
                with self.assertRaises(verify.VerificationError):
                    verify.read_manifest(self.manifest_path)
                self.manifest = original

    def test_extra_parts_or_plaintext_are_rejected(self):
        for name in ("data.sql", "data.sql.zst.age.part"):
            extra = self.directory / name
            extra.write_bytes(b"public fixture")
            try:
                with self.assertRaisesRegex(verify.VerificationError, "CONTENTS_MISMATCH"):
                    verify.read_manifest(self.manifest_path)
            finally:
                extra.unlink()

    def test_wrong_project_or_complete_manifest_is_not_promoted(self):
        for key, value in (("source_project", "another-project"), ("complete", True),
                           ("status", "complete"), ("format", True)):
            original = self.manifest[key]
            self.manifest[key] = value
            self.save_manifest()
            with self.subTest(key=key), self.assertRaisesRegex(verify.VerificationError, "UNEXPECTED_SQL_AUTH"):
                verify.read_manifest(self.manifest_path)
            self.manifest[key] = original

    def test_symlink_or_public_permissions_on_any_input_are_rejected(self):
        for path in (self.manifest_path, self.identity,
                     self.directory / self.manifest["artifacts"][0]["file"]):
            path.chmod(0o640)
            try:
                with self.subTest(path=path), self.assertRaisesRegex(verify.VerificationError, "UNSAFE_PRIVATE"):
                    verify.verify(self.manifest_path)
            finally:
                path.chmod(0o600)
            replacement = self.root / "outside"
            path.rename(replacement)
            path.symlink_to(replacement)
            try:
                with self.subTest(symlink=path), self.assertRaises(verify.VerificationError):
                    verify.verify(self.manifest_path)
            finally:
                path.unlink()
                replacement.rename(path)

    def test_directory_symlink_and_permissions_are_rejected(self):
        self.directory.chmod(0o750)
        with self.assertRaisesRegex(verify.VerificationError, "UNSAFE_PRIVATE"):
            verify.read_manifest(self.manifest_path)
        self.directory.chmod(0o700)
        moved = self.root / "moved"
        self.directory.rename(moved)
        self.directory.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(verify.VerificationError, "UNSAFE_PRIVATE"):
            verify.read_manifest(self.manifest_path)

    def test_metadata_rejects_non_root_nonregular_or_inexact_private_mode(self):
        with mock.patch.object(verify, "OWNER_UID", 0):
            for uid, mode in ((1000, stat.S_IFREG | 0o600), (0, stat.S_IFLNK | 0o600),
                              (0, stat.S_IFREG | 0o400), (0, stat.S_IFREG | 0o640)):
                with self.subTest(uid=uid, mode=mode), self.assertRaises(verify.VerificationError):
                    verify.checked_metadata(SimpleNamespace(st_uid=uid, st_mode=mode))

    def test_nonroot_refuses_before_opening_manifest(self):
        with mock.patch.object(verify.os, "geteuid", return_value=1000), \
             mock.patch.object(verify, "read_manifest") as read:
            with self.assertRaisesRegex(verify.VerificationError, "VPS_ROOT_REQUIRED"):
                verify.verify(self.manifest_path)
        read.assert_not_called()


@unittest.skipUnless(shutil.which("zstd"), "zstd required for offline stream-integrity integration")
class StreamTests(Fixture):
    def setUp(self):
        super().setUp()
        self.compressed = subprocess.run([shutil.which("zstd"), "-q", "-c"], input=PUBLIC_PAYLOAD,
                                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         check=True).stdout
        self.artifact = self.root / "public-compressed-fixture"
        self.artifact.write_bytes(self.compressed)
        self.real_popen = subprocess.Popen

    def fake_age(self, script):
        def popen(args, **kwargs):
            if args[0] == "/usr/bin/age":
                self.assertEqual(args[1:4], ["--decrypt", "--identity", "/proc/self/fd/" + str(kwargs["pass_fds"][0])])
                self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
                self.assertNotIn("LD_PRELOAD", kwargs["env"])
                return self.real_popen([sys.executable, "-c", script], **kwargs)
            self.assertEqual(args, ["/usr/bin/zstd", "--test", "--quiet", "--memory=128MB"])
            self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
            self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
            return self.real_popen(args, **kwargs)
        return popen

    def run_stream(self, script):
        with self.artifact.open("rb") as stream, self.identity.open("rb") as identity, \
             mock.patch.object(verify.subprocess, "Popen", side_effect=self.fake_age(script)):
            return verify.check_stream(stream, identity)

    def test_real_zstd_stream_is_tested_without_plaintext_output_or_files(self):
        before = sorted(str(p) for p in self.root.rglob("*"))
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), \
             mock.patch.dict(os.environ, {"LD_PRELOAD": "unsafe", "PGPASSWORD": "public marker"}):
            self.run_stream("import shutil,sys; shutil.copyfileobj(sys.stdin.buffer,sys.stdout.buffer)")
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(before, sorted(str(p) for p in self.root.rglob("*")))

    def test_age_failure_is_rejected_even_if_emitted_zstd_stream_is_valid(self):
        with self.assertRaisesRegex(verify.VerificationError, "AGE_DECRYPTION_FAILED"):
            self.run_stream("import shutil,sys; shutil.copyfileobj(sys.stdin.buffer,sys.stdout.buffer); sys.exit(7)")

    def test_corrupt_compressed_stream_is_rejected(self):
        self.artifact.write_bytes(b"not a zstd stream; public fixture")
        with self.assertRaisesRegex(verify.VerificationError, "ZSTD_INTEGRITY_FAILED"):
            self.run_stream("import shutil,sys; shutil.copyfileobj(sys.stdin.buffer,sys.stdout.buffer)")

    def test_timeout_terminates_both_children_and_does_not_print_stderr(self):
        with mock.patch.object(verify, "PIPELINE_TIMEOUT", 0.05):
            with self.assertRaisesRegex(verify.VerificationError, "VERIFICATION_TIMEOUT"):
                self.run_stream("import sys,time; sys.stderr.write('public secret marker'); time.sleep(5)")


if __name__ == "__main__":
    unittest.main()
