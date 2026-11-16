"""Offline metadata-capture boundary tests; public fixtures, no live database."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/timeweb/source-metadata-supplement.py"
SPEC = importlib.util.spec_from_file_location("bron_source_metadata", SCRIPT)
supplement = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(supplement)
OLD_SNAPSHOT = "00000004-00000048-1"
NEW_SNAPSHOT = "00000005-00000049-1"
RECIPIENT = "age1" + "a" * 58


class MetadataSqlTests(unittest.TestCase):
    def test_metadata_read_is_explicitly_read_only_and_imports_only_its_new_snapshot(self):
        sql = supplement.metadata_sql(NEW_SNAPSHOT)
        self.assertTrue(sql.startswith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"))
        self.assertIn(f"SET TRANSACTION SNAPSHOT '{NEW_SNAPSHOT}';", sql)
        self.assertNotIn(OLD_SNAPSHOT, sql)
        self.assertIn("current_setting('transaction_read_only')", sql)
        self.assertIn("'independent_new_read_only_snapshot'", sql)
        self.assertTrue(sql.endswith("ROLLBACK;\n"))
        self.assertNotRegex(sql.lower(), r"\b(insert|update|delete|alter|create|drop|grant|revoke|truncate|commit)\b")

    def test_snapshot_injection_cannot_reach_psql(self):
        for value in ("bad' ; COMMIT;", "", "00000005-00000049-1\nSQL", None):
            with self.subTest(value=value), self.assertRaises(supplement.SupplementError):
                supplement.metadata_sql(value)

    def test_exact_auth_triggers_and_storage_policy_grants_are_captured(self):
        sql = supplement.metadata_sql(NEW_SNAPSHOT)
        self.assertIn("pg_get_triggerdef(t.oid,true)", sql)
        self.assertIn("t.tgenabled", sql)
        self.assertIn("n.nspname in ('auth','storage') and not t.tgisinternal", sql)
        self.assertIn("policyname,permissive,roles,cmd,qual,with_check", sql)
        for field in ("c.relrowsecurity", "c.relforcerowsecurity", "c.relacl", "a.attacl", "nspacl", "d.defaclacl"):
            self.assertIn(field, sql)

    def test_metadata_includes_full_column_compatibility_histories_and_queue_hash(self):
        sql = supplement.metadata_sql(NEW_SNAPSHOT)
        for field in ("format_type", "a.attnum", "a.attnotnull", "a.attidentity", "a.attgenerated",
                      "default_value", "pg_get_constraintdef", "pg_get_functiondef",
                      "auth.schema_migrations", "storage.migrations", "storage.objects", "cron.job",
                      "net.http_request_queue", "sha256(convert_to", "pg_db_role_setting"):
            self.assertIn(field, sql)
        self.assertNotIn("pg_authid", sql)
        self.assertNotIn("rolpassword", sql)
        self.assertNotIn("decrypted_secret", sql)
        self.assertNotIn("supabase_functions.migrations", sql)  # Known absent on source.


class DriverPinTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "deploy/timeweb").mkdir(parents=True)
        self.driver_file = self.root / "deploy/timeweb/source-backup.py"
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (("CHECKOUT", self.root), ("DRIVER_FILE", self.driver_file),
                            ("OWNER_UID", os.getuid())):
            self.stack.enter_context(mock.patch.object(supplement, name, value))

    def test_real_pinned_driver_bytes_are_loaded_without_running_its_main(self):
        actual = SCRIPT.parent / "source-backup.py"
        self.driver_file.write_bytes(actual.read_bytes())
        driver = supplement.load_driver()
        self.assertEqual(driver.SOURCE_HOST, "aws-1-us-west-2.pooler.supabase.com")
        self.assertEqual(driver.SOURCE_USER, "postgres.vkkqffvmztpzgygzfxhq")
        self.assertEqual(str(driver.BACKUP_ROOT), "/var/backups/bron-franchise")

    def test_modified_driver_is_rejected_before_code_execution(self):
        self.driver_file.write_text("raise RuntimeError('PUBLIC-MARKER-MUST-NOT-EXECUTE')\n")
        with self.assertRaisesRegex(supplement.SupplementError, "SHA256_MISMATCH"):
            supplement.load_driver()

    def test_symlink_or_writable_driver_is_rejected(self):
        self.driver_file.write_bytes((SCRIPT.parent / "source-backup.py").read_bytes())
        self.driver_file.chmod(0o666)
        with self.assertRaisesRegex(supplement.SupplementError, "UNSAFE_PINNED_DRIVER_FILE"):
            supplement.load_driver()
        self.driver_file.chmod(0o644)
        moved = self.root / "outside.py"
        self.driver_file.rename(moved)
        self.driver_file.symlink_to(moved)
        with self.assertRaises(OSError):
            supplement.load_driver()

    def test_writable_or_symlink_checkout_directory_is_rejected(self):
        self.driver_file.write_bytes((SCRIPT.parent / "source-backup.py").read_bytes())
        self.root.chmod(0o777)
        with self.assertRaisesRegex(supplement.SupplementError, "UNSAFE_PINNED_DRIVER_DIRECTORY"):
            supplement.load_driver()
        self.root.chmod(0o700)
        with mock.patch.object(supplement, "OWNER_UID", os.getuid() + 1):
            with self.assertRaisesRegex(supplement.SupplementError, "UNSAFE_PINNED_DRIVER_DIRECTORY"):
                supplement.load_driver()


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.directory = self.root / "source-20261112T161139Z-0f8917c7"
        self.directory.mkdir(mode=0o700)
        self.path = self.directory / "manifest.json"
        self.original = {"format": 1, "complete": False,
                         "status": "sql_auth_stage_only_restore_unverified",
                         "source_project": supplement.SOURCE_PROJECT,
                         "encryption_recipient": RECIPIENT,
                         "snapshot_metadata": {"snapshot": OLD_SNAPSHOT},
                         "artifacts": [{"file": name, "bytes": 200, "sha256": "a" * 64}
                                       for name in sorted(supplement.EXPECTED_FILES)]}
        self.save_original()
        self.keeper = mock.Mock()
        self.keeper.start.return_value = {"snapshot": NEW_SNAPSHOT}
        self.driver = SimpleNamespace(
            BACKUP_ROOT=self.root, IDENTITY_FILE=self.root / "fixture.agekey",
            preflight=mock.Mock(), secure_path=mock.Mock(), capture=mock.Mock(return_value=RECIPIENT),
            clean_env=mock.Mock(return_value={"PATH": "/usr/bin:/bin"}),
            source_env=mock.Mock(return_value={"PGSERVICE": "bron_source", "PGHOST": "canonical-host"}),
            Snapshot=mock.Mock(return_value=self.keeper),
            encrypted_artifact=mock.Mock(side_effect=self.fake_encrypted),
            private_file=mock.Mock(side_effect=lambda path, data: path.write_bytes(data)),
        )
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(supplement, "OWNER_UID", os.getuid()))
        self.stack.enter_context(mock.patch.object(supplement.os, "geteuid", return_value=0))
        self.stack.enter_context(mock.patch.object(supplement, "load_driver", return_value=self.driver))

    def save_original(self):
        self.path.write_text(json.dumps(self.original))
        self.path.chmod(0o600)

    def fake_encrypted(self, directory, name, command, env, recipient, keeper):
        self.assertEqual(command[:9], ["/usr/bin/psql", "-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "--dbname"])
        self.assertEqual(command[9:11], ["service=bron_source", "--command"])
        self.assertIn(NEW_SNAPSHOT, command[11])
        self.assertNotIn(OLD_SNAPSHOT, command[11])
        self.assertIs(keeper, self.keeper)
        self.assertEqual(recipient, RECIPIENT)
        data = b"public-encrypted-fixture" * 10
        path = directory / (name + ".zst.age")
        path.write_bytes(data)
        return {"file": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

    def manifests(self):
        return list(self.root.glob("supplement-*/manifest.json"))

    def test_independent_capture_preserves_original_and_uses_encrypted_pipeline_only(self):
        original_bytes = self.path.read_bytes()
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = supplement.capture(self.path)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(original_bytes, self.path.read_bytes())
        self.assertEqual(len(self.manifests()), 1)
        manifest = json.loads(self.manifests()[0].read_bytes())
        self.assertEqual(manifest["original_manifest_sha256"], hashlib.sha256(original_bytes).hexdigest())
        self.assertEqual(manifest["original_snapshot"], OLD_SNAPSHOT)
        self.assertEqual(manifest["new_snapshot"], NEW_SNAPSHOT)
        self.assertFalse(manifest["same_snapshot_as_sql"])
        self.assertFalse(manifest["complete"])
        self.assertFalse(result["complete"])
        self.assertFalse(result["source_modified"])
        self.assertIn("auth_provider_jwt_smtp_runtime_configuration", manifest["not_captured"])
        self.assertNotIn("catalog", manifest)  # Metadata belongs only inside encryption.
        self.driver.preflight.assert_called_once_with(True)
        self.driver.source_env.assert_called_once()
        self.assertIs(self.driver.source_env.call_args.args[1], True)
        self.driver.encrypted_artifact.assert_called_once()
        self.keeper.finish.assert_called_once()
        self.keeper.stop.assert_called_once()
        self.assertEqual({p.name for p in self.manifests()[0].parent.iterdir()},
                         {"manifest.json", "managed-metadata.json.zst.age"})

    def test_pipeline_failure_never_publishes_success_manifest_or_changes_original(self):
        before = self.path.read_bytes()
        self.driver.encrypted_artifact.side_effect = RuntimeError("public-sensitive-native-diagnostic")
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(RuntimeError):
                supplement.capture(self.path)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(self.manifests(), [])
        self.keeper.finish.assert_not_called()
        self.keeper.stop.assert_called_once()

    def test_terminal_interrupt_unwinds_snapshot_and_does_not_publish_success(self):
        self.driver.encrypted_artifact.side_effect = lambda *args: supplement.interrupted(None, None)
        with self.assertRaisesRegex(supplement.SupplementError, "INTERRUPTED"):
            supplement.capture(self.path)
        self.keeper.stop.assert_called_once()
        self.keeper.finish.assert_not_called()
        self.assertEqual(self.manifests(), [])

    def test_original_concurrent_change_prevents_attestation(self):
        def changed(*args):
            artifact = self.fake_encrypted(*args)
            self.original["other_administrator_change"] = True
            self.save_original()
            return artifact
        self.driver.encrypted_artifact.side_effect = changed
        with self.assertRaisesRegex(supplement.SupplementError, "ORIGINAL_MANIFEST_CHANGED"):
            supplement.capture(self.path)
        self.assertEqual(self.manifests(), [])
        self.keeper.stop.assert_called_once()

    def test_recipient_change_or_missing_key_cannot_silently_generate_replacement(self):
        self.driver.capture.return_value = "age1" + "b" * 58
        with self.assertRaisesRegex(supplement.SupplementError, "RECIPIENT_MISMATCH"):
            supplement.capture(self.path)
        self.driver.Snapshot.assert_not_called()
        self.driver.secure_path.assert_any_call(self.driver.IDENTITY_FILE)
        self.driver.capture.assert_called_once()
        self.assertEqual(self.driver.capture.call_args.args[0],
                         ["/usr/bin/age-keygen", "-y", str(self.driver.IDENTITY_FILE)])
        self.assertEqual(self.manifests(), [])

    def test_busy_export_lock_refuses_before_starting_snapshot(self):
        with mock.patch.object(supplement.fcntl, "flock", side_effect=BlockingIOError):
            with self.assertRaisesRegex(supplement.SupplementError, "ALREADY_RUNNING"):
                supplement.capture(self.path)
        self.driver.Snapshot.assert_not_called()
        self.assertEqual(self.manifests(), [])

    def test_wrong_original_project_stage_or_artifact_references_cannot_be_linked(self):
        for mutate in (
            lambda m: m.update(source_project="wrong-project"),
            lambda m: m.update(complete=True),
            lambda m: m.update(status="complete"),
            lambda m: m["artifacts"][0].update(file="../other-source/roles.sql.zst.age"),
            lambda m: m["artifacts"].pop(),
            lambda m: m["snapshot_metadata"].update(snapshot="injected' SQL"),
        ):
            original = json.loads(json.dumps(self.original))
            mutate(self.original)
            self.save_original()
            with self.subTest(mutate=mutate), self.assertRaises(supplement.SupplementError):
                supplement.capture(self.path)
            self.original = original
        self.driver.Snapshot.assert_not_called()

    def test_original_mode_symlink_and_foreign_path_are_rejected(self):
        self.path.chmod(0o644)
        with self.assertRaisesRegex(supplement.SupplementError, "UNSAFE_ORIGINAL"):
            supplement.capture(self.path)
        self.path.chmod(0o600)
        outside = self.root / "outside"
        self.path.rename(outside)
        self.path.symlink_to(outside)
        with self.assertRaises(OSError):
            supplement.capture(self.path)
        with self.assertRaisesRegex(supplement.SupplementError, "EXPLICIT_SOURCE_MANIFEST_REQUIRED"):
            supplement.capture(Path("manifest.json"))

    def test_nonroot_refuses_before_importing_driver(self):
        with mock.patch.object(supplement.os, "geteuid", return_value=1000), \
             mock.patch.object(supplement, "load_driver") as load:
            with self.assertRaisesRegex(supplement.SupplementError, "VPS_ROOT_REQUIRED"):
                supplement.capture(self.path)
        load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
