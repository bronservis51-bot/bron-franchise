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
MAX_REPLY_BYTES = 65536
HEARTBEAT_SECONDS = 25
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
    def __init__(self, env, capture_stderr=False):
        self.process = subprocess.Popen(
            ["/usr/bin/psql", "-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1",
             "--dbname", "service=bron_source"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if capture_stderr else subprocess.DEVNULL,
            start_new_session=True, bufsize=0)
        self.metadata = None
        self.deadline = time.monotonic() + 30 * 60
        self.last_heartbeat = None
        self.last_reply_bytes = 0
        self.capture_stderr = capture_stderr
        self.stderr_bytes = bytearray()
        self.stderr_limit_exceeded = False

    def _read_stderr(self):
        """Diagnostic only: keep bounded bytes in RAM; never return their contents."""
        remaining = MAX_REPLY_BYTES - len(self.stderr_bytes)
        if remaining <= 0:
            self.stderr_limit_exceeded = True
            raise BackupError("DIAG_STDERR_LIMIT_EXCEEDED")
        try:
            chunk = os.read(self.process.stderr.fileno(), min(4096, remaining))
        except BlockingIOError:
            return None
        except OSError:
            raise BackupError("DIAG_STDERR_READ_FAILED") from None
        self.stderr_bytes.extend(chunk)
        return bool(chunk)

    def _send(self, sql):
        try:
            if self.process.stdin.write(sql) != len(sql):
                raise BackupError("snapshot_keeper_write_failed")
            self.process.stdin.flush()
        except (OSError, ValueError):
            raise BackupError("snapshot_keeper_write_failed") from None

    def _read_json(self, timeout, phase):
        # One unbuffered request/reply at a time. Never mix readline buffering
        # with fd polling, or block forever after only a partial JSON line arrives.
        deadline = time.monotonic() + timeout
        response = bytearray()
        self.last_reply_bytes = 0
        with selectors.DefaultSelector() as selector:
            selector.register(self.process.stdout, selectors.EVENT_READ)
            if getattr(self, "capture_stderr", False):
                selector.register(self.process.stderr, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BackupError(phase + "_timeout")
                events = selector.select(remaining)
                if not events:
                    raise BackupError(phase + "_timeout")
                if getattr(self, "capture_stderr", False):
                    stdout_ready = False
                    for key, _mask in events:
                        if key.fileobj is self.process.stderr:
                            if self._read_stderr() is False:
                                selector.unregister(self.process.stderr)
                        elif key.fileobj is self.process.stdout:
                            stdout_ready = True
                    if not stdout_ready:
                        continue
                try:
                    chunk = os.read(self.process.stdout.fileno(), 4096)
                except OSError:
                    raise BackupError("snapshot_keeper_read_failed") from None
                if not chunk:
                    raise BackupError("snapshot_keeper_lost")
                response.extend(chunk)
                self.last_reply_bytes = len(response)
                if len(response) > MAX_REPLY_BYTES:
                    raise BackupError("snapshot_reply_limit_exceeded")
                if b"\n" not in response:
                    continue
                line, extra = response.split(b"\n", 1)
                if extra.strip():
                    raise BackupError("snapshot_reply_protocol_failed")
                try:
                    data = json.loads(line)
                except (ValueError, UnicodeError):
                    raise BackupError(phase + "_failed") from None
                if not isinstance(data, dict):
                    raise BackupError(phase + "_failed")
                return data

    def start(self):
        sql = """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '35min';
SELECT json_build_object(
 'phase','snapshot_start',
 'snapshot',pg_export_snapshot(),
 'backend_pid',pg_backend_pid(),
 'isolation',current_setting('transaction_isolation'),
 'mvcc_snapshot',pg_current_snapshot()::text,
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
        self._send(sql.encode())
        data = self._read_json(45, "snapshot_guard")
        if (not isinstance(data.get("server_version_num"), int)
                or data["server_version_num"] // 10000 != 17 or data.get("read_only") != "on"):
            raise BackupError("snapshot_version_or_actual_read_only_guard_failed")
        if (data.get("phase") != "snapshot_start" or not isinstance(data.get("backend_pid"), int)
                or data["backend_pid"] <= 0 or data.get("isolation") != "repeatable read"
                or not isinstance(data.get("mvcc_snapshot"), str)
                or not re.fullmatch(r"[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?", data.get("mvcc_snapshot", ""))):
            raise BackupError("snapshot_identity_guard_failed")
        if not re.fullmatch(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+", data.get("snapshot", "")):
            raise BackupError("invalid_exported_snapshot")
        self.metadata = data
        self.last_heartbeat = time.monotonic()
        return data

    def alive(self, force=False):
        if self.process.poll() is not None:
            raise BackupError("snapshot_keeper_lost")
        now = time.monotonic()
        if now >= self.deadline:
            raise BackupError("snapshot_total_time_budget_exceeded")
        if self.metadata is None or self.last_heartbeat is None:
            raise BackupError("snapshot_not_started")
        if not force and now - self.last_heartbeat < HEARTBEAT_SECONDS:
            return
        self._send(b"SELECT json_build_object('phase','snapshot_heartbeat',"
                   b"'backend_pid',pg_backend_pid(),'read_only',current_setting('transaction_read_only'),"
                   b"'isolation',current_setting('transaction_isolation'),"
                   b"'mvcc_snapshot',pg_current_snapshot()::text);\n")
        data = self._read_json(15, "snapshot_heartbeat")
        if (data.get("phase") != "snapshot_heartbeat" or data.get("read_only") != "on"
                or data.get("isolation") != "repeatable read"):
            raise BackupError("snapshot_heartbeat_mode_changed")
        if data.get("backend_pid") != self.metadata["backend_pid"]:
            raise BackupError("snapshot_heartbeat_backend_changed")
        if data.get("mvcc_snapshot") != self.metadata["mvcc_snapshot"]:
            raise BackupError("snapshot_heartbeat_snapshot_changed")
        self.last_heartbeat = time.monotonic()

    def finish(self, check_heartbeat=True):
        if check_heartbeat:
            self.alive(force=True)
        self._send(b"ROLLBACK;\n\\q\n")
        self.process.stdin.close()
        try:
            if self.process.wait(timeout=15) != 0:
                raise BackupError("snapshot_keeper_failed")
        except subprocess.TimeoutExpired:
            raise BackupError("snapshot_keeper_close_timeout") from None

    def diagnostic_state(self):
        """Only counts, fixed classes and numeric syscall/fd may leave this method."""
        state = {"last_reply_bytes": self.last_reply_bytes,
                 "process_poll": self.process.poll(), "wchan_class": "unavailable",
                 "syscall_number": None, "syscall_fd": None}
        waits = {"pipe_read": "pipe_read", "pipe_write": "pipe_write",
                 "poll_schedule_timeout": "poll", "do_poll": "poll",
                 "do_select": "poll", "ep_poll": "poll",
                 "wait_woken": "wait", "futex_wait_queue": "futex",
                 "hrtimer_nanosleep": "sleep", "0": "running"}
        if state["process_poll"] is None:
            process_dir = Path("/proc") / str(self.process.pid)
            try:
                wait = (process_dir / "wchan").read_text().strip()
                state["wchan_class"] = waits.get(wait, "other")
            except OSError:
                pass
            # On x86-64 only these syscall first arguments are file descriptors.
            # Never emit syscall pointer arguments or proc file contents.
            if os.uname().machine == "x86_64":
                try:
                    fields = (process_dir / "syscall").read_text().split()
                    number = int(fields[0], 0)
                    if -1 <= number <= 1024:
                        state["syscall_number"] = number
                    if number in (0, 1, 17, 18, 19, 20, 44, 45):
                        fd = int(fields[1], 0)
                        if 0 <= fd <= 1048576:
                            state["syscall_fd"] = fd
                except (OSError, ValueError, IndexError):
                    pass
        stderr_code = "DIAG_STDERR_EMPTY"
        if not self.stderr_limit_exceeded:
            try:
                os.set_blocking(self.process.stderr.fileno(), False)
                while self._read_stderr():
                    pass
            except (OSError, BackupError):
                stderr_code = "DIAG_STDERR_READ_FAILED"
        if self.stderr_limit_exceeded:
            stderr_code = "DIAG_STDERR_LIMIT_EXCEEDED"
        elif self.stderr_bytes:
            stderr_code = classify_managed_error(self.stderr_bytes, 1)
        state["stderr_diagnostic"] = stderr_code
        return state

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


def classify_managed_error(stderr, returncode):
    """Only fixed codes leave the process; stderr may contain sensitive SQL context."""
    if returncode == 0:
        return "DIAG_MANAGED_OK"
    text = stderr.lower()
    rules = [
        ("DIAG_INVALID_SNAPSHOT", (b"invalid snapshot", b"snapshot does not exist", b"could not import")),
        ("DIAG_AUTH_FAILED", (b"authentication failed", b"no password supplied", b"tenant or user not found")),
        ("DIAG_PERMISSION_DENIED", (b"permission denied", b"must be owner", b"must be superuser")),
        ("DIAG_NO_MATCHING_TABLES", (b"no matching tables", b"no matching relations")),
        ("DIAG_LOCK_TIMEOUT", (b"lock timeout", b"could not obtain lock")),
        ("DIAG_STATEMENT_TIMEOUT", (b"statement timeout",)),
        ("DIAG_TLS_FAILED", (b"certificate verify failed", b"server certificate", b"root certificate")),
        ("DIAG_CONNECTION_LOST", (b"server closed the connection", b"connection reset", b"broken pipe",
                                 b"ssl syscall error", b"connection to server", b"terminating connection")),
    ]
    for code, patterns in rules:
        if any(pattern in text for pattern in patterns):
            return code
    if b"does not exist" in text and (b"relation" in text or b"schema" in text):
        return "DIAG_RELATION_OR_SCHEMA_MISSING"
    return "DIAG_UNKNOWN_ERROR"


def run_managed_diagnostic(command, env, keeper):
    keeper.alive(force=True)
    process = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                               start_new_session=True, bufsize=0)
    error_bytes = bytearray()
    try:
        deadline = time.monotonic() + 180
        eof = False
        with selectors.DefaultSelector() as selector:
            selector.register(process.stderr, selectors.EVENT_READ)
            while not eof or process.poll() is None:
                keeper.alive()
                if time.monotonic() >= deadline:
                    raise BackupError("DIAG_PROCESS_TIMEOUT")
                events = selector.select(0.25) if not eof else []
                if events:
                    try:
                        chunk = os.read(process.stderr.fileno(), 4096)
                    except OSError:
                        raise BackupError("DIAG_STDERR_READ_FAILED") from None
                    if not chunk:
                        eof = True
                        selector.unregister(process.stderr)
                    else:
                        error_bytes.extend(chunk)
                        if len(error_bytes) > MAX_REPLY_BYTES:
                            raise BackupError("DIAG_STDERR_LIMIT_EXCEEDED")
                elif eof:
                    time.sleep(0.05)
        keeper.alive(force=True)
        return classify_managed_error(error_bytes, process.returncode), process.returncode
    finally:
        stop_processes([process])
        process.stderr.close()
        error_bytes.clear()


def diagnose_managed(tunnel):
    # New snapshot only: never retry/reconnect the keeper or mix partial backups.
    with tempfile.TemporaryDirectory(prefix=".managed-diagnostic-", dir=BACKUP_ROOT) as temporary:
        env = source_env(Path(temporary), tunnel)
        keeper = Snapshot(env)
        try:
            metadata = keeper.start()
            command = dict(archive_commands(metadata["snapshot"]))["managed-migration-versions.sql"]
            print("Checking managed migration metadata with a fresh read-only snapshot...", flush=True)
            code, status = run_managed_diagnostic(command, env, keeper)
            keeper.finish()
            print(json.dumps({"diagnostic": code, "command_exit": status,
                              "source_read_only": "on", "backup_created": False}, sort_keys=True), flush=True)
            if status != 0:
                raise BackupError(code)
            return code
        finally:
            keeper.stop()


def diagnose_keeper(tunnel):
    # No dump, key, backup directory or reconnect: isolate the first heartbeat.
    keeper = None
    phase = "snapshot_spawn"
    try:
        keeper = Snapshot(source_env("/root", tunnel), capture_stderr=True)
        phase = "snapshot_start"
        keeper.start()
        phase = "first_heartbeat"
        keeper.alive(force=True)
        phase = "rollback"
        keeper.finish(check_heartbeat=False)
        print(json.dumps({"diagnostic": "DIAG_KEEPER_PASS", "source_read_only": "on",
                          "backup_created": False}, sort_keys=True), flush=True)
        return "DIAG_KEEPER_PASS"
    except (OSError, ValueError, subprocess.SubprocessError, BackupError, KeyboardInterrupt):
        state = keeper.diagnostic_state() if keeper is not None else {
            "last_reply_bytes": 0, "process_poll": None, "wchan_class": "unavailable",
            "syscall_number": None, "syscall_fd": None, "stderr_diagnostic": "DIAG_STDERR_EMPTY"}
        state.update(diagnostic="DIAG_KEEPER_FAILED", phase=phase, backup_created=False)
        print(json.dumps(state, sort_keys=True), flush=True)
        raise
    finally:
        if keeper is not None:
            keeper.stop()
            keeper.process.stderr.close()
            keeper.stderr_bytes.clear()


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
    mode.add_argument("--diagnose-managed", action="store_true",
                      help="Diagnose only managed metadata under a fresh read-only snapshot; no backup")
    mode.add_argument("--diagnose-keeper", action="store_true",
                      help="Diagnose only a fresh read-only snapshot and its first heartbeat; no backup")
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
    if args.diagnose_keeper:
        diagnose_keeper(tunnel)
    elif args.diagnose_managed:
        diagnose_managed(tunnel)
    elif args.prepare_key:
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
