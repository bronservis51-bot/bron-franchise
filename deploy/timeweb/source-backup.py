#!/usr/bin/env python3
"""Create an explicitly INCOMPLETE, encrypted SQL/Auth migration backup in Russia.

No restore, source writes, containers, Storage download, Management API or S3 upload.
Source passwords are consumed only by native libpq from existing root-only files.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

TARGET_IP = "152.228.115.115"
SOURCE_HOST = "aws-1-us-west-2.pooler.supabase.com"
SOURCE_USER = "postgres.vkkqffvmztpzgygzfxhq"
SECRET_DIR = Path("/root/bron-secrets")
SERVICE_FILE = SECRET_DIR / "source.pg_service.conf"
PASSWORD_FILE = SECRET_DIR / "source.pgpass"
IDENTITY_FILE = SECRET_DIR / "source-backup.agekey"
SOURCE_CERT = Path("/opt/bron/source-ca.crt")
SOURCE_CA = Path("/opt/bron/source-ca-bundle.pem")
BACKUP_ROOT = Path("/var/backups/bron-franchise")
CERT_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
DUMMY_URI = "postgresql://postgres:DRY_RUN_ONLY@127.0.0.1:1/postgres?sslmode=disable"
DUMMY_PREAMBLE = ("export PGHOST=\"127.0.0.1\"\nexport PGPORT=\"1\"\n"
                  "export PGUSER=\"postgres\"\nexport PGPASSWORD=\"DRY_RUN_ONLY\"\n"
                  "export PGDATABASE=\"postgres\"\n")
# CLI v3.1.0 pg-dump.scripts.ts + pg-dump.env.ts; keep-comments for roles/schema.
# Hash the untouched, LF-normalized script before adapting only transport/executable.
VENDOR_HASHES = {
    "roles": "a68086b94643dab5ab5dc11db37a564bd290ffc39fead270b174ce1860a31f6f",
    "schema": "dfb40eb1e3a3f838b71ded195a372022898a069dfae4e906739b2dac6fef3f91",
    "data": "f9fab9e7e5ac0241b0e12bd0f2c69300147d994ddb90fd895fd3fb35a8432cde",
}
MISSING = [
    "storage_object_bytes_and_checksums_not_backed_up",
    "auth_jwt_smtp_settings_edge_functions_and_other_server_secrets_not_backed_up",
    "independent_russian_s3_copy_not_created",
    "encryption_key_recovery_custody_not_verified",
    "isolated_restore_and_strict_migration_audit_not_performed",
    "roles_and_sequence_values_not_covered_by_shared_mvcc_snapshot",
]


class BackupError(RuntimeError):
    """Messages are fixed phase codes, never subprocess output or secrets."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


def secure_path(path, directory=False):
    info = path.lstat()
    wanted = stat.S_ISDIR if directory else stat.S_ISREG
    if (not wanted(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077):
        raise BackupError("unsafe_protected_path")


def private_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def clean_env(home):
    return {"PATH": "/usr/bin:/bin", "HOME": str(home), "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8", "NO_COLOR": "1", "TERM": "dumb",
            "SUPABASE_HOME": str(home), "SUPABASE_TELEMETRY_DISABLED": "1",
            "DO_NOT_TRACK": "1", "SUPABASE_EXPERIMENTAL_STACK": "0",
            "PSQL_HISTORY": "/dev/null"}


def source_env(home, tunnel):
    env = clean_env(home)
    env.update(PGSERVICEFILE=str(SERVICE_FILE), PGPASSFILE=str(PASSWORD_FILE),
               PGSERVICE="bron_source", PGHOST=SOURCE_HOST,
               PGPORT="15432" if tunnel else "5432", PGUSER=SOURCE_USER,
               PGDATABASE="postgres", PGSSLMODE="verify-full", PGSSLROOTCERT=str(SOURCE_CA),
               PGGSSENCMODE="disable", PGCONNECT_TIMEOUT="15",
               PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=1200000")
    if tunnel:
        env["PGHOSTADDR"] = "127.0.0.1"
    return env


def validate_credentials(tunnel):
    secure_path(SECRET_DIR, directory=True)
    for path in (SERVICE_FILE, PASSWORD_FILE, SOURCE_CERT, SOURCE_CA):
        secure_path(path)
    port = 15432 if tunnel else 5432
    hostaddr = "hostaddr=127.0.0.1\n" if tunnel else ""
    expected = (f"[bron_source]\nhost={SOURCE_HOST}\n{hostaddr}port={port}\n"
                f"user={SOURCE_USER}\ndbname=postgres\nsslmode=verify-full\n"
                f"sslrootcert={SOURCE_CA}\nconnect_timeout=15\n"
                "application_name=bron-migration-readonly\n")
    if SERVICE_FILE.read_text() != expected:
        raise BackupError("source_service_transport_or_tls_mismatch")
    lines = PASSWORD_FILE.read_text().splitlines()
    prefix = f"{SOURCE_HOST}:{port}:postgres:{SOURCE_USER}:"
    if (len(lines) != 1 or not lines[0].startswith(prefix)
            or len(lines[0]) == len(prefix) or "\x00" in lines[0]):
        raise BackupError("source_password_file_mismatch")
    cert = SOURCE_CERT.read_bytes()
    if digest(cert) != CERT_SHA256 or cert.strip() not in SOURCE_CA.read_bytes():
        raise BackupError("source_ca_not_verified")


def capture(args, env, timeout=30):
    try:
        result = subprocess.run(args, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=True)
    except (OSError, subprocess.SubprocessError):
        raise BackupError("required_command_failed") from None
    return result.stdout.decode("utf-8")


def preflight(tunnel):
    if os.geteuid() != 0:
        raise BackupError("run_only_on_verified_russian_vps_as_root")
    if Path("/opt/bron/production-enabled").exists():
        raise BackupError("production_already_enabled_review_runbook")
    env = clean_env("/root")
    addresses = capture(["/usr/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"], env)
    if TARGET_IP not in [line.split()[3].split("/")[0] for line in addresses.splitlines()]:
        raise BackupError("wrong_target_vps")
    for name in ("psql", "pg_dump", "pg_dumpall", "supabase", "age", "age-keygen", "zstd"):
        if shutil.which(name, path=env["PATH"]) is None:
            raise BackupError("missing_required_executable")
    for name in ("psql", "pg_dump", "pg_dumpall"):
        if not re.match(rf"^{name} \(PostgreSQL\) 17\.11(?:\s|$)",
                        capture([f"/usr/bin/{name}", "--version"], env).strip()):
            raise BackupError("native_postgres_client_17_11_required")
    if capture(["/usr/bin/supabase", "--version"], env).strip() != "3.1.0":
        raise BackupError("supabase_cli_3_1_0_required")
    validate_credentials(tunnel)
    secure_path(BACKUP_ROOT, directory=True)
    if shutil.disk_usage(BACKUP_ROOT).free < 2 * 1024 ** 3:
        raise BackupError("less_than_2gib_free")


def normalize_script(script):
    return script.replace("\r\n", "\n").rstrip() + "\n"


def adapt_vendor_script(mode, script, snapshot):
    script = normalize_script(script)
    if digest(script.encode()) != VENDOR_HASHES[mode]:
        raise BackupError("vendor_dry_run_hash_mismatch")
    if script.count(DUMMY_PREAMBLE) != 1 or not script.startswith("#!/usr/bin/env bash\nset -euo pipefail\n"):
        raise BackupError("vendor_dry_run_preamble_mismatch")
    script = script.replace(DUMMY_PREAMBLE, "", 1)
    command = "pg_dumpall" if mode == "roles" else "pg_dump"
    marker = command + " \\\n"
    if script.count(marker) != 1:
        raise BackupError("vendor_native_command_mismatch")
    replacement = f"/usr/bin/{command} --no-password"
    if mode != "roles":
        if not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", snapshot):
            raise BackupError("invalid_exported_snapshot")
        replacement += f" --snapshot={snapshot} --lock-wait-timeout=5s"
    return script.replace(marker, replacement + " \\\n", 1)


def vendor_scripts(home):
    env = clean_env(home)
    result = {}
    for mode, flags in (("roles", ["--role-only"]), ("schema", []),
                        ("data", ["--data-only", "--use-copy"])):
        args = ["/usr/bin/supabase", "db", "dump", f"--remote={DUMMY_URI}",
                "--dry-run", *([] if mode == "data" else ["--keep-comments"]), *flags]
        # cwd isolates CLI config discovery and local telemetry state from any checkout.
        try:
            proc = subprocess.run(args, cwd=home, env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  timeout=60, check=True)
        except (OSError, subprocess.SubprocessError):
            raise BackupError("vendor_dry_run_generation_failed") from None
        text = normalize_script(proc.stdout.decode("utf-8"))
        if digest(text.encode()) != VENDOR_HASHES[mode]:
            raise BackupError("vendor_dry_run_hash_mismatch_" + mode + "_" + digest(text.encode()))
        result[mode] = text
    return result


class Snapshot:
    def __init__(self, env):
        self.process = subprocess.Popen(
            ["/usr/bin/psql", "-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1",
             "--dbname", "service=bron_source"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, start_new_session=True)
        self.metadata = None
        self.deadline = time.monotonic() + 30 * 60

    def start(self):
        sql = """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '35min';
SELECT json_build_object(
 'snapshot',pg_export_snapshot(),
 'server_version_num',current_setting('server_version_num')::integer,
 'read_only',current_setting('transaction_read_only'),
 'default_read_only',current_setting('default_transaction_read_only'),
 'extensions',(select json_agg(json_build_object('name',e.extname,
   'version',e.extversion,'schema',n.nspname) order by e.extname)
   from pg_extension e join pg_namespace n on n.oid=e.extnamespace),
 'auth_users',(select count(*) from auth.users),
 'identities',(select count(*) from auth.identities),
 'buckets',(select count(*) from storage.buckets),
 'objects',(select count(*) from storage.objects),
 'vault_secrets',(select count(*) from vault.secrets));
"""
        self.process.stdin.write(sql.encode())
        self.process.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if not selector.select(45):
                raise BackupError("snapshot_guard_timeout")
        try:
            data = json.loads(self.process.stdout.readline())
        except (ValueError, UnicodeError):
            raise BackupError("snapshot_guard_failed") from None
        if not isinstance(data, dict):
            raise BackupError("snapshot_guard_failed")
        if (not isinstance(data.get("server_version_num"), int)
                or data["server_version_num"] // 10000 != 17 or data.get("read_only") != "on"):
            raise BackupError("snapshot_version_or_actual_read_only_guard_failed")
        if not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", data.get("snapshot", "")):
            raise BackupError("invalid_exported_snapshot")
        self.metadata = data
        return data

    def alive(self):
        if self.process.poll() is not None:
            raise BackupError("snapshot_keeper_lost")
        if time.monotonic() >= self.deadline:
            raise BackupError("snapshot_total_time_budget_exceeded")

    def finish(self):
        self.alive()
        self.process.stdin.write(b"ROLLBACK;\n\\q\n")
        self.process.stdin.flush()
        self.process.stdin.close()
        try:
            if self.process.wait(timeout=15) != 0:
                raise BackupError("snapshot_keeper_failed")
        except subprocess.TimeoutExpired:
            raise BackupError("snapshot_keeper_close_timeout") from None

    def stop(self):
        if self.process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGTERM)
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.process.wait(timeout=5)
            if self.process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait()


def recipient(home):
    if IDENTITY_FILE.is_symlink():
        raise BackupError("unsafe_protected_path")
    if not IDENTITY_FILE.exists():
        # age-keygen refuses an existing output file; the root directory is protected.
        capture(["/usr/bin/age-keygen", "-o", str(IDENTITY_FILE)], clean_env(home))
    secure_path(IDENTITY_FILE)
    value = capture(["/usr/bin/age-keygen", "-y", str(IDENTITY_FILE)], clean_env(home)).strip()
    if not re.fullmatch(r"age1[0-9a-z]{40,100}", value):
        raise BackupError("invalid_age_recipient")
    return value


def stop_processes(processes):
    for process in processes:
        # A shell leader can already have exited while its pg_dump child remains.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
    for process in processes:
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=5)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        if process.poll() is None:
            process.wait()


def encrypted_artifact(directory, name, command, env, age_recipient, keeper, input_data=None):
    path = directory / (name + ".zst.age.part")
    final = directory / (name + ".zst.age")
    if final.exists():
        raise BackupError("artifact_already_exists")
    processes = []
    # Never persist/echo raw diagnostics: they can contain SQL context or row values.
    try:
        keeper.alive()
        producer = subprocess.Popen(command, env=env, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
        processes.append(producer)
        compressor = subprocess.Popen(["/usr/bin/zstd", "-q", "-c"], env=env,
                                      stdin=producer.stdout, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, start_new_session=True)
        processes.append(compressor)
        producer.stdout.close()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            encryptor = subprocess.Popen(["/usr/bin/age", "-r", age_recipient], env=env,
                                         stdin=compressor.stdout, stdout=output,
                                         stderr=subprocess.DEVNULL, start_new_session=True)
            processes.append(encryptor)
            compressor.stdout.close()
            if input_data is not None:
                producer.stdin.write(input_data)
                producer.stdin.close()
            deadline = time.monotonic() + 1200
            while any(process.poll() is None for process in processes):
                keeper.alive()
                if any(process.poll() not in (None, 0) for process in processes):
                    raise BackupError("artifact_pipeline_failed")
                if time.monotonic() > deadline:
                    raise BackupError("artifact_pipeline_timeout")
                time.sleep(0.1)
            if any(process.returncode != 0 for process in processes):
                raise BackupError("artifact_pipeline_failed")
            keeper.alive()
            output.flush()
            os.fsync(output.fileno())
        if path.stat().st_size < 100:
            raise BackupError("empty_encrypted_artifact")
        os.rename(path, final)
        checksum = hashlib.sha256()
        with final.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
        return {"file": final.name, "bytes": final.stat().st_size,
                "sha256": checksum.hexdigest()}
    finally:
        stop_processes(processes)
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def archive_commands(snapshot):
    if not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", snapshot):
        raise BackupError("invalid_exported_snapshot")
    common = ["/usr/bin/pg_dump", "--no-password", f"--snapshot={snapshot}",
              "--lock-wait-timeout=5s", "--quote-all-identifiers", "--role=postgres"]
    # Unfiltered definitions are an archive for review, NOT a restore recipe.
    logical_vault = f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '{snapshot}';
COPY (SELECT id,name,description,decrypted_secret,created_at,updated_at,key_id,
 encode(nonce,'hex') AS nonce_hex FROM vault.decrypted_secrets ORDER BY id)
 TO STDOUT WITH (FORMAT CSV, HEADER true);
ROLLBACK;"""
    return [
        ("raw-schema-archive.sql", common + ["--schema-only"]),
        ("vault-ciphertext.sql", common + ["--data-only", "--table=vault.secrets"]),
        ("managed-migration-versions.sql", common + ["--data-only",
             "--table=auth.schema_migrations", "--table=storage.migrations",
             "--table=supabase_functions.migrations"]),
        ("vault-logical.csv", ["/usr/bin/psql", "-X", "-q", "-A", "-t", "-w",
             "-v", "ON_ERROR_STOP=1", "--dbname", "service=bron_source", "--command", logical_vault]),
    ]


def backup(tunnel):
    os.umask(0o077)
    lockfd = os.open(BACKUP_ROOT / ".source-backup.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, "w") as lock:
        secure_path(BACKUP_ROOT / ".source-backup.lock")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("another_backup_is_running") from None
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        directory = BACKUP_ROOT / f"source-{stamp}-{uuid.uuid4().hex[:8]}"
        directory.mkdir(mode=0o700)
        with tempfile.TemporaryDirectory(prefix=".cli-", dir=directory) as temporary:
            home = Path(temporary)
            scripts = vendor_scripts(home)  # No source password or source URL enters CLI.
            public_recipient = recipient(home)
            env = source_env(home, tunnel)
            keeper = Snapshot(env)
            try:
                metadata = keeper.start()
                snapshot = metadata["snapshot"]
                artifacts = []
                for mode in ("roles", "schema", "data"):
                    print(f"Encrypting {mode} SQL on Russian VPS...", flush=True)
                    script = adapt_vendor_script(mode, scripts[mode], snapshot)
                    artifacts.append(encrypted_artifact(
                        directory, mode + ".sql", ["/usr/bin/bash", "-s"], env,
                        public_recipient, keeper, script.encode()))
                for name, command in archive_commands(snapshot):
                    print(f"Encrypting {name} supplement...", flush=True)
                    artifacts.append(encrypted_artifact(
                        directory, name, command, env, public_recipient, keeper))
                keeper.finish()
                missing = list(MISSING)
                if metadata["vault_secrets"]:
                    missing.append("vault_logical_uuid_preserving_reencryption_restore_not_verified")
                manifest = {"format": 1, "complete": False,
                            "status": "sql_auth_stage_only_restore_unverified",
                            "source_project": "vkkqffvmztpzgygzfxhq", "created_utc": stamp,
                            "route": "loopback_ssh" if tunnel else "direct",
                            "native_client": "17.11", "vendor_cli": "3.1.0",
                            "vendor_script_sha256": VENDOR_HASHES,
                            "encryption_recipient": public_recipient,
                            "encryption_identity_file": str(IDENTITY_FILE),
                            "vault_root_key_copied": False,
                            "snapshot_metadata": metadata, "artifacts": artifacts,
                            "missing": missing,
                            "restore_warnings": [
                                "raw_schema_and_managed_versions_are_archive_only_review_before_restore",
                                "vendor_data_contains_cron_net_disable_target_jobs_before_import",
                                "vendor_roles_omit_db_login_passwords_auth_user_hashes_remain_in_data_sql",
                                "never_restore_over_source_or_live_target",
                            ]}
                private_file(directory / "manifest.json.part",
                             (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode())
                os.rename(directory / "manifest.json.part", directory / "manifest.json")
                directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                print(f"SQL/Auth stage saved in {directory}; complete=false.", flush=True)
                return manifest
            finally:
                keeper.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--backup", action="store_true")
    mode.add_argument("--prepare-key", action="store_true",
                      help="Prepare/reuse the protected local age identity; no source query")
    parser.add_argument("--tunnel", action="store_true", help="Explicit loopback SSH route at 127.0.0.1:15432")
    args = parser.parse_args()
    existing = os.environ.get("BRON_SOURCE_TUNNEL_PORT")
    if existing is not None and existing != "15432":
        raise BackupError("unreviewed_tunnel_environment")
    tunnel = args.tunnel or existing == "15432"
    os.umask(0o077)
    preflight(tunnel)
    if args.prepare_key:
        with tempfile.TemporaryDirectory(prefix=".source-key-", dir=BACKUP_ROOT) as temporary:
            recipient(Path(temporary))
        print(f"Protected backup key ready at {IDENTITY_FILE}; recovery custody is not verified. No source query.")
    elif args.backup:
        backup(tunnel)
    else:
        with tempfile.TemporaryDirectory(prefix=".source-backup-check-", dir=BACKUP_ROOT) as temporary:
            vendor_scripts(Path(temporary))
        print("Local credentials, CA, clients and vendor scripts checked; no source query or backup made.")


if __name__ == "__main__":
    def interrupted(_signum, _frame):
        raise BackupError("interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        print("STOP: cancelled; backup is not complete.", file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, subprocess.SubprocessError, BackupError) as error:
        # Do not expose stdout/stderr, arbitrary OS paths, SQL context or credentials.
        code = str(error) if isinstance(error, BackupError) else "required_operation_failed"
        print("STOP: " + code + "; backup is not complete.", file=sys.stderr)
        sys.exit(1)
