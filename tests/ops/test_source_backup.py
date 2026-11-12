"""Offline safety/failure tests; no network, real DB, credentials or native dump."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/timeweb/source-backup.py"
SPEC = importlib.util.spec_from_file_location("bron_source_backup", SCRIPT)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
SNAPSHOT = "00000004-00000048-1"
RECIPIENT = "age1" + "a" * 58
METADATA = {"snapshot": SNAPSHOT, "server_version_num": 170011, "read_only": "on",
            "default_read_only": "off", "auth_users": 16, "identities": 16,
            "buckets": 1, "objects": 0, "vault_secrets": 1,
            "phase": "snapshot_start", "backend_pid": 31415,
            "isolation": "repeatable read", "mvcc_snapshot": "100:105:102,104"}
HEARTBEAT = {key: METADATA[key] for key in ("backend_pid", "read_only", "isolation", "mvcc_snapshot")}
HEARTBEAT["phase"] = "snapshot_heartbeat"


def vendor_fixture(mode):
    command = "pg_dumpall" if mode == "roles" else "pg_dump"
    # Deliberately non-production fixture. Runtime accepts only the pinned vendor hash.
    return ("#!/usr/bin/env bash\nset -euo pipefail\n\n" + backup.DUMMY_PREAMBLE
            + f"\n{command} \\\n    --schema-only \\\n| sed -E 's/^SENSITIVE_INTERNAL/-- &/'\n")


class VendorAndEnvironmentTests(unittest.TestCase):
    def test_hostile_parent_environment_never_reaches_libpq_or_cli(self):
        with mock.patch.dict(os.environ, {"PGPASSWORD": "do-not-expose", "PGSSLMODE": "disable",
                                         "LD_PRELOAD": "/unsafe", "BASH_ENV": "/unsafe"}):
            env = backup.source_env(Path("/private/home"), True)
        for key in ("PGPASSWORD", "LD_PRELOAD", "BASH_ENV"):
            self.assertNotIn(key, env)
        self.assertEqual(env["PGHOST"], backup.SOURCE_HOST)
        self.assertEqual(env["PGHOSTADDR"], "127.0.0.1")
        self.assertEqual(env["PGPORT"], "15432")
        self.assertEqual(env["PGSSLMODE"], "verify-full")
        self.assertEqual(env["PGPASSFILE"], str(backup.PASSWORD_FILE))
        self.assertNotIn("PGHOSTADDR", backup.source_env(Path("/private/home"), False))

    def test_vendor_transport_adaptation_preserves_filter_and_requires_known_bytes(self):
        script = vendor_fixture("schema")
        with mock.patch.dict(backup.VENDOR_HASHES, {"schema": backup.digest(script.encode())}):
            adapted = backup.adapt_vendor_script("schema", script, SNAPSHOT)
            self.assertNotIn("DRY_RUN_ONLY", adapted)
            self.assertNotIn("export PG", adapted)
            self.assertIn(f"/usr/bin/pg_dump --no-password --snapshot={SNAPSHOT}", adapted)
            self.assertIn("| sed -E 's/^SENSITIVE_INTERNAL/-- &/'", adapted)
            with self.assertRaisesRegex(backup.BackupError, "hash_mismatch"):
                backup.adapt_vendor_script("schema", script.replace("INTERNAL", "ALLOW"), SNAPSHOT)
            with self.assertRaisesRegex(backup.BackupError, "invalid_exported_snapshot"):
                backup.adapt_vendor_script("schema", script, "$(touch /unsafe)")

    def test_roles_use_native_catalog_only_dump_without_unsupported_snapshot_flag(self):
        script = vendor_fixture("roles")
        with mock.patch.dict(backup.VENDOR_HASHES, {"roles": backup.digest(script.encode())}):
            adapted = backup.adapt_vendor_script("roles", script, SNAPSHOT)
        self.assertIn("/usr/bin/pg_dumpall --no-password", adapted)
        self.assertNotIn("--snapshot=", adapted)
        self.assertNotIn("PGPASSWORD", adapted)

    def test_dry_run_only_sees_dummy_url_and_isolated_home(self):
        fixtures = {mode: vendor_fixture(mode) for mode in backup.VENDOR_HASHES}
        expected = {mode: backup.digest(script.encode()) for mode, script in fixtures.items()}
        def invoke(args, **kwargs):
            self.assertIn(f"--remote={backup.DUMMY_URI}", args)
            self.assertNotIn(backup.SOURCE_HOST, " ".join(args))
            self.assertEqual(kwargs["cwd"], Path("/isolated"))
            self.assertNotIn("PGPASSWORD", kwargs["env"])
            self.assertEqual(kwargs["env"]["DO_NOT_TRACK"], "1")
            mode = "roles" if "--role-only" in args else "data" if "--data-only" in args else "schema"
            if mode == "data":
                self.assertIn("--use-copy", args)
                self.assertNotIn("--keep-comments", args)  # CLI rejects this pair.
            else:
                self.assertIn("--keep-comments", args)
            return SimpleNamespace(stdout=fixtures[mode].encode())
        with mock.patch.dict(backup.VENDOR_HASHES, expected), \
             mock.patch.object(backup.subprocess, "run", side_effect=invoke) as invoke_mock:
            self.assertEqual(backup.vendor_scripts(Path("/isolated")), fixtures)
        self.assertEqual(invoke_mock.call_count, 3)

    def test_changed_vendor_output_fails_closed_before_native_clients(self):
        with mock.patch.object(backup.subprocess, "run", return_value=SimpleNamespace(
                stdout=b"unreviewed shell\n")):
            with self.assertRaisesRegex(backup.BackupError, "vendor_dry_run_hash_mismatch_roles"):
                backup.vendor_scripts(Path("/isolated"))

    def test_secret_or_group_readable_and_symlink_paths_are_rejected(self):
        for uid, mode in ((1000, 0o100600), (0, 0o100640), (0, 0o120777)):
            path = mock.Mock()
            path.lstat.return_value = SimpleNamespace(st_uid=uid, st_mode=mode)
            with self.subTest(uid=uid, mode=mode), self.assertRaises(backup.BackupError):
                backup.secure_path(path)

    def test_existing_credential_transport_or_tls_changes_are_refused(self):
        expected = (f"[bron_source]\nhost={backup.SOURCE_HOST}\nhostaddr=127.0.0.1\nport=15432\n"
                    f"user={backup.SOURCE_USER}\ndbname=postgres\nsslmode=verify-full\n"
                    f"sslrootcert={backup.SOURCE_CA}\nconnect_timeout=15\n"
                    "application_name=bron-migration-readonly\n")
        for changed in (expected.replace("verify-full", "require"),
                        expected.replace("127.0.0.1", "203.0.113.2"),
                        expected.replace("port=15432", "port=5432")):
            service = mock.Mock()
            service.read_text.return_value = changed
            password = mock.Mock()
            with self.subTest(changed=changed), \
                 mock.patch.object(backup, "secure_path"), \
                 mock.patch.object(backup, "SERVICE_FILE", service), \
                 mock.patch.object(backup, "PASSWORD_FILE", password):
                with self.assertRaisesRegex(backup.BackupError, "transport_or_tls_mismatch"):
                    backup.validate_credentials(True)
            password.read_text.assert_not_called()


class SnapshotTests(unittest.TestCase):
    def start_with(self, metadata):
        process = mock.Mock()
        process.stdin.write.side_effect = len
        selector = mock.MagicMock()
        selector.__enter__.return_value = selector
        selector.select.return_value = [True]
        with mock.patch.object(backup.subprocess, "Popen", return_value=process) as start, \
             mock.patch.object(backup.selectors, "DefaultSelector", return_value=selector), \
             mock.patch.object(backup.os, "read", return_value=json.dumps(metadata).encode() + b"\n"):
            snapshot = backup.Snapshot({"PGPASSWORD_MUST_NOT_EXIST": "not-a-password"})
            result = snapshot.start()
        return snapshot, result, process, start

    def test_explicit_read_only_is_guarded_when_pooler_default_is_off(self):
        snapshot, result, process, start = self.start_with(METADATA)
        self.assertEqual(result["read_only"], "on")
        sql = process.stdin.write.call_args.args[0].decode()
        self.assertTrue(sql.startswith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"))
        self.assertIn("current_setting('transaction_read_only')", sql)
        self.assertIn("pg_export_snapshot()", sql)
        self.assertEqual(start.call_args.kwargs["stderr"], backup.subprocess.DEVNULL)
        self.assertIn("-q", start.call_args.args[0])
        self.assertEqual(start.call_args.kwargs["bufsize"], 0)
        process.stdout.readline.assert_not_called()
        self.assertEqual(snapshot.metadata["snapshot"], SNAPSHOT)

    def test_actual_read_write_or_wrong_major_version_cannot_start_backup(self):
        for changed in ({"read_only": "off"}, {"server_version_num": 180001},
                        {"snapshot": "bad'; SQL"}):
            with self.subTest(changed=changed), self.assertRaises(backup.BackupError):
                self.start_with({**METADATA, **changed})

    def test_lost_keeper_is_not_success(self):
        snapshot = object.__new__(backup.Snapshot)
        snapshot.process = mock.Mock()
        snapshot.process.poll.return_value = 1
        with self.assertRaisesRegex(backup.BackupError, "snapshot_keeper_lost"):
            snapshot.alive()

    def test_total_snapshot_budget_precedes_idle_timeout(self):
        snapshot = object.__new__(backup.Snapshot)
        snapshot.process = mock.Mock()
        snapshot.process.poll.return_value = None
        snapshot.deadline = 100
        with mock.patch.object(backup.time, "monotonic", return_value=100):
            with self.assertRaisesRegex(backup.BackupError, "snapshot_total_time_budget_exceeded"):
                snapshot.alive()

    def test_all_supplementary_dumps_share_snapshot_and_logical_vault_is_read_only(self):
        commands = dict(backup.archive_commands(SNAPSHOT))
        self.assertIn("raw-schema-archive.sql", commands)
        self.assertIn("vault-ciphertext.sql", commands)
        for name, args in commands.items():
            if args[0].endswith("pg_dump"):
                self.assertIn(f"--snapshot={SNAPSHOT}", args)
                self.assertIn("--no-password", args)
            else:
                sql = args[args.index("--command") + 1]
                self.assertTrue(sql.startswith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"))
                self.assertIn(f"SET TRANSACTION SNAPSHOT '{SNAPSHOT}'", sql)
                self.assertIn("decrypted_secret", sql)
                self.assertIn("TO STDOUT", sql)
                self.assertTrue(sql.rstrip().endswith("ROLLBACK;"))
        with self.assertRaisesRegex(backup.BackupError, "invalid_exported_snapshot"):
            backup.archive_commands("snapshot'; unsafe SQL")


class HeartbeatTests(unittest.TestCase):
    def keeper(self):
        keeper = object.__new__(backup.Snapshot)
        keeper.process = mock.Mock()
        keeper.process.poll.return_value = None
        keeper.process.stdin.write.side_effect = len
        keeper.metadata = METADATA.copy()
        keeper.deadline = 9999
        keeper.last_heartbeat = 0
        return keeper

    def test_due_heartbeat_uses_same_transaction_without_reexporting_snapshot(self):
        keeper = self.keeper()
        with mock.patch.object(backup.time, "monotonic", return_value=25), \
             mock.patch.object(keeper, "_read_json", return_value=HEARTBEAT.copy()) as reply:
            keeper.alive()
        sql = keeper.process.stdin.write.call_args.args[0]
        self.assertIn(b"pg_backend_pid()", sql)
        self.assertIn(b"transaction_read_only", sql)
        self.assertNotIn(b"BEGIN", sql)
        self.assertNotIn(b"pg_export_snapshot", sql)
        self.assertEqual(keeper.metadata["snapshot"], SNAPSHOT)
        self.assertEqual(keeper.last_heartbeat, 25)
        reply.assert_called_once_with(15, "snapshot_heartbeat")

    def test_no_ping_before_interval_but_forced_final_check_is_real(self):
        keeper = self.keeper()
        with mock.patch.object(backup.time, "monotonic", return_value=10), \
             mock.patch.object(keeper, "_read_json", return_value=HEARTBEAT.copy()) as reply:
            keeper.alive()
            keeper.process.stdin.write.assert_not_called()
            keeper.alive(force=True)
            reply.assert_called_once()

    def test_backend_mvcc_read_only_isolation_or_phase_changes_fail_closed(self):
        for change, code in [({"backend_pid": 22}, "backend_changed"),
                             ({"mvcc_snapshot": "200:201:"}, "snapshot_changed"),
                             ({"read_only": "off"}, "mode_changed"),
                             ({"isolation": "read committed"}, "mode_changed"),
                             ({"phase": "snapshot_start"}, "mode_changed")]:
            keeper = self.keeper()
            with self.subTest(change=change), \
                 mock.patch.object(backup.time, "monotonic", return_value=30), \
                 mock.patch.object(keeper, "_read_json", return_value={**HEARTBEAT, **change}):
                with self.assertRaisesRegex(backup.BackupError, code):
                    keeper.alive()

    def test_broken_stdin_reports_only_a_fixed_code(self):
        keeper = self.keeper()
        keeper.process.stdin.write.side_effect = BrokenPipeError("private-context-must-not-leak")
        with mock.patch.object(backup.time, "monotonic", return_value=30):
            with self.assertRaisesRegex(backup.BackupError, "^snapshot_keeper_write_failed$"):
                keeper.alive()

    def read_reply(self, chunks, clock=None):
        keeper = self.keeper()
        selector = mock.MagicMock()
        selector.__enter__.return_value = selector
        selector.select.return_value = [True]
        with mock.patch.object(backup.selectors, "DefaultSelector", return_value=selector), \
             mock.patch.object(backup.os, "read", side_effect=chunks), \
             mock.patch.object(backup.time, "monotonic", side_effect=clock or [0, 0, 1, 2, 3]):
            try:
                return keeper._read_json(15, "snapshot_heartbeat")
            finally:
                keeper.process.stdout.readline.assert_not_called()

    def test_partial_json_cannot_block_past_deadline(self):
        with self.assertRaisesRegex(backup.BackupError, "snapshot_heartbeat_timeout"):
            self.read_reply([b'{"phase":'], [0, 0, 16])

    def test_partial_json_is_reassembled_without_buffered_readline(self):
        self.assertEqual(self.read_reply([b'{"ok":', b'true}\n']), {"ok": True})

    def test_server_eof_oversized_malformed_or_stale_replies_fail_closed(self):
        for chunks, code in [([b""], "snapshot_keeper_lost"),
                             ([b"x" * (backup.MAX_REPLY_BYTES + 1)], "snapshot_reply_limit_exceeded"),
                             ([b"not-json\n"], "snapshot_heartbeat_failed"),
                             ([b"[]\n"], "snapshot_heartbeat_failed"),
                             ([b'{}\n{"stale":true}\n'], "snapshot_reply_protocol_failed")]:
            with self.subTest(code=code), self.assertRaisesRegex(backup.BackupError, code):
                self.read_reply(chunks)


class ManagedDiagnosticTests(unittest.TestCase):
    def test_classifier_never_returns_raw_sql_or_credentials(self):
        for raw, code in [(b"invalid snapshot identifier", "DIAG_INVALID_SNAPSHOT"),
                          (b"password authentication failed", "DIAG_AUTH_FAILED"),
                          (b"permission denied for table", "DIAG_PERMISSION_DENIED"),
                          (b"no matching tables were found", "DIAG_NO_MATCHING_TABLES"),
                          (b"canceling statement due to lock timeout", "DIAG_LOCK_TIMEOUT"),
                          (b"SSL SYSCALL error: EOF detected", "DIAG_CONNECTION_LOST"),
                          (b"server certificate does not match", "DIAG_TLS_FAILED"),
                          (b"unrecognised error", "DIAG_UNKNOWN_ERROR")]:
            self.assertEqual(backup.classify_managed_error(raw + b" PRIVATE-CONTEXT", 1), code)
        self.assertEqual(backup.classify_managed_error(b"", 0), "DIAG_MANAGED_OK")

    def run_command(self, chunks, clock=None):
        process = mock.Mock()
        process.poll.return_value = 1
        process.returncode = 1
        keeper = mock.Mock()
        selector = mock.MagicMock()
        selector.__enter__.return_value = selector
        selector.select.return_value = [True]
        command = dict(backup.archive_commands(SNAPSHOT))["managed-migration-versions.sql"]
        with mock.patch.object(backup.subprocess, "Popen", return_value=process) as start, \
             mock.patch.object(backup.selectors, "DefaultSelector", return_value=selector), \
             mock.patch.object(backup.os, "read", side_effect=chunks), \
             mock.patch.object(backup.time, "monotonic", side_effect=clock or [0, 0, 1, 2, 3]), \
             mock.patch.object(backup, "stop_processes") as stop:
            try:
                result = backup.run_managed_diagnostic(command, {}, keeper)
            finally:
                stop.assert_called_once_with([process])
                process.stderr.close.assert_called_once()
                self.assertEqual(start.call_args.kwargs["stdout"], backup.subprocess.DEVNULL)
                self.assertEqual(start.call_args.kwargs["stderr"], backup.subprocess.PIPE)
                self.assertIn("--table=auth.schema_migrations", start.call_args.args[0])
                self.assertNotIn("--table=auth.users", start.call_args.args[0])
        keeper.alive.assert_any_call(force=True)
        return result

    def test_stderr_is_drained_and_classified_without_creating_a_dump(self):
        result = self.run_command([b"permission denied PRIVATE-CONTEXT", b""])
        self.assertEqual(result, ("DIAG_PERMISSION_DENIED", 1))

    def test_error_volume_and_time_are_bounded_and_process_is_stopped(self):
        with self.assertRaisesRegex(backup.BackupError, "DIAG_STDERR_LIMIT_EXCEEDED"):
            self.run_command([b"x" * (backup.MAX_REPLY_BYTES + 1)])
        with self.assertRaisesRegex(backup.BackupError, "DIAG_PROCESS_TIMEOUT"):
            self.run_command([], [0, 181])

    def test_diagnosis_uses_a_fresh_snapshot_and_never_calls_backup_key_or_manifest(self):
        keeper = mock.Mock()
        keeper.start.return_value = METADATA.copy()
        with tempfile.TemporaryDirectory() as temporary, \
             mock.patch.object(backup, "BACKUP_ROOT", Path(temporary)), \
             mock.patch.object(backup, "Snapshot", return_value=keeper), \
             mock.patch.object(backup, "run_managed_diagnostic", return_value=("DIAG_MANAGED_OK", 0)) as run, \
             mock.patch.object(backup, "recipient") as key, \
             mock.patch.object(backup, "encrypted_artifact") as artifact, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(backup.diagnose_managed(True), "DIAG_MANAGED_OK")
            self.assertEqual(list(Path(temporary).iterdir()), [])
        keeper.start.assert_called_once()
        keeper.finish.assert_called_once()
        keeper.stop.assert_called_once()
        key.assert_not_called()
        artifact.assert_not_called()
        self.assertIn(f"--snapshot={SNAPSHOT}", run.call_args.args[0])
        self.assertIn('"backup_created": false', output.getvalue())


class AtomicPipelineTests(unittest.TestCase):
    def pipeline(self, directory, codes, keeper=None):
        processes = []
        def start(args, **kwargs):
            process = mock.Mock()
            process.returncode = codes[len(processes)]
            process.poll.return_value = process.returncode
            process.wait.return_value = process.returncode
            process.stdout = io.BytesIO(b"synthetic-pipe-only")
            process.stdin = mock.Mock()
            if args[0] == "/usr/bin/age":
                kwargs["stdout"].write(b"ENCRYPTED-TEST-ONLY" * 20)
            self.assertEqual(kwargs["stderr"], backup.subprocess.DEVNULL)
            processes.append(process)
            return process
        with mock.patch.object(backup.subprocess, "Popen", side_effect=start), \
             mock.patch.object(backup.os, "killpg"):
            result = backup.encrypted_artifact(
                directory, "schema.sql", ["/usr/bin/bash", "-s"], {}, RECIPIENT,
                keeper or mock.Mock(), b"synthetic SQL never written to disk")
        return result, processes

    def test_success_finalizes_only_ciphertext_after_all_exit_codes(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            result, processes = self.pipeline(directory, [0, 0, 0])
            self.assertEqual(result["sha256"], backup.digest((directory / result["file"]).read_bytes()))
            self.assertFalse(list(directory.glob("*.part")))
            self.assertEqual(len(list(directory.iterdir())), 1)
            self.assertNotIn(b"synthetic SQL", (directory / result["file"]).read_bytes())
            processes[0].stdin.write.assert_called_once_with(b"synthetic SQL never written to disk")

    def test_failed_producer_cannot_publish_even_if_compressor_and_age_succeed(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaisesRegex(backup.BackupError, "pipeline_failed"):
                self.pipeline(directory, [1, 0, 0])
            self.assertEqual(list(directory.iterdir()), [])

    def test_cleanup_also_signals_descendants_of_an_exited_leader(self):
        exited = mock.Mock(pid=987654)
        exited.poll.return_value = 0
        with mock.patch.object(backup.os, "killpg") as kill:
            backup.stop_processes([exited])
        kill.assert_any_call(987654, backup.signal.SIGTERM)
        kill.assert_any_call(987654, backup.signal.SIGKILL)

    def test_lost_snapshot_before_finalize_cannot_publish(self):
        keeper = mock.Mock()
        keeper.alive.side_effect = [None, backup.BackupError("snapshot_keeper_lost")]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaisesRegex(backup.BackupError, "snapshot_keeper_lost"):
                self.pipeline(directory, [0, 0, 0], keeper)
            self.assertEqual(list(directory.iterdir()), [])

    def test_interruption_stops_independent_children_and_removes_partial_ciphertext(self):
        keeper = mock.Mock()
        keeper.alive.side_effect = [None, backup.BackupError("interrupted")]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with mock.patch.object(backup, "stop_processes") as stop:
                with self.assertRaisesRegex(backup.BackupError, "interrupted"):
                    self.pipeline(directory, [None, None, None], keeper)
            self.assertEqual(len(stop.call_args.args[0]), 3)
            self.assertEqual(list(directory.iterdir()), [])


class ManifestTests(unittest.TestCase):
    def run_backup(self, directory, failed_finish=False, failed_artifact=False):
        snapshot = mock.Mock()
        snapshot.start.return_value = METADATA.copy()
        if failed_finish:
            snapshot.finish.side_effect = backup.BackupError("snapshot_keeper_failed")
        artifact = mock.Mock(return_value={"file": "synthetic.age", "bytes": 200, "sha256": "public-test"})
        if failed_artifact:
            artifact.side_effect = backup.BackupError("artifact_pipeline_failed")
        with mock.patch.object(backup, "BACKUP_ROOT", directory), \
             mock.patch.object(backup, "secure_path"), \
             mock.patch.object(backup, "vendor_scripts", return_value=dict.fromkeys(backup.VENDOR_HASHES, "fixture")), \
             mock.patch.object(backup, "adapt_vendor_script", return_value="fixture"), \
             mock.patch.object(backup, "recipient", return_value=RECIPIENT), \
             mock.patch.object(backup, "Snapshot", return_value=snapshot), \
             mock.patch.object(backup, "encrypted_artifact", artifact), \
             contextlib.redirect_stdout(io.StringIO()):
            try:
                result = backup.backup(True)
            finally:
                snapshot.stop.assert_called_once_with()
        return result, artifact

    def test_stage_never_claims_full_backup_and_records_every_missing_part(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            manifest, artifact = self.run_backup(directory)
            self.assertFalse(manifest["complete"])
            self.assertIn("independent_russian_s3_copy_not_created", manifest["missing"])
            self.assertIn("vault_logical_uuid_preserving_reencryption_restore_not_verified", manifest["missing"])
            self.assertFalse(manifest["vault_root_key_copied"])
            self.assertEqual(artifact.call_count, 7)
            paths = list(directory.glob("source-*/manifest.json"))
            self.assertEqual(len(paths), 1)
            self.assertEqual(paths[0].stat().st_mode & 0o777, 0o600)
            self.assertFalse(list(directory.glob("source-*/*.part")))

    def test_keeper_or_artifact_failure_never_publishes_manifest(self):
        for finish, artifact in ((True, False), (False, True)):
            with self.subTest(finish=finish), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                with self.assertRaises(backup.BackupError):
                    self.run_backup(directory, finish, artifact)
                self.assertFalse(list(directory.glob("source-*/manifest.json")))


class EncryptionKeyTests(unittest.TestCase):
    def test_existing_identity_is_reused_without_overwrite_or_secret_output(self):
        identity = mock.Mock()
        identity.exists.return_value = True
        identity.is_symlink.return_value = False
        with mock.patch.object(backup, "IDENTITY_FILE", identity), \
             mock.patch.object(backup, "secure_path") as guard, \
             mock.patch.object(backup, "capture", return_value=RECIPIENT) as capture:
            self.assertEqual(backup.recipient(Path("/isolated")), RECIPIENT)
        guard.assert_called_once_with(identity)
        self.assertEqual(capture.call_count, 1)
        self.assertEqual(capture.call_args.args[0][:2], ["/usr/bin/age-keygen", "-y"])

    def test_identity_symlink_refuses_before_key_command(self):
        identity = mock.Mock()
        identity.is_symlink.return_value = True
        with mock.patch.object(backup, "IDENTITY_FILE", identity), \
             mock.patch.object(backup, "capture") as capture:
            with self.assertRaises(backup.BackupError):
                backup.recipient(Path("/isolated"))
        capture.assert_not_called()

    def test_prepare_key_cli_has_no_source_query_or_dump(self):
        with tempfile.TemporaryDirectory() as temporary, \
             mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(backup.sys, "argv", [str(SCRIPT), "--tunnel", "--prepare-key"]), \
             mock.patch.object(backup, "BACKUP_ROOT", Path(temporary)), \
             mock.patch.object(backup, "preflight") as preflight, \
             mock.patch.object(backup, "recipient", return_value=RECIPIENT) as key, \
             mock.patch.object(backup, "Snapshot") as source, \
             mock.patch.object(backup, "backup") as dump, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            backup.main()
        preflight.assert_called_once_with(True)
        key.assert_called_once()
        source.assert_not_called()
        dump.assert_not_called()
        self.assertIn("recovery custody is not verified", output.getvalue())
        self.assertNotIn(RECIPIENT, output.getvalue())


if __name__ == "__main__":
    unittest.main()
