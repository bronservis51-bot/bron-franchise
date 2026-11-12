#!/usr/bin/env python3
"""Prepare verified, read-only source DB access on the owner's Russian VPS.

No dump, source changes, target containers, password changes or public endpoints.
The existing DB password is entered directly at the VPS TTY, never in argv/git.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import socket
import ssl
import struct
import subprocess
import sys
import signal

TARGET_IP = "152.228.115.115"
SOURCE_HOST = "aws-1-us-west-2.pooler.supabase.com"
SOURCE_USER = "postgres.vkkqffvmztpzgygzfxhq"
SECRET_DIR = Path("/root/bron-secrets")
SERVICE_FILE = SECRET_DIR / "source.pg_service.conf"
PASSWORD_FILE = SECRET_DIR / "source.pgpass"
STATE_DIR = Path("/opt/bron")
SOURCE_CA = STATE_DIR / "source-ca-bundle.pem"


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True,
                          timeout=45, **kwargs).stdout.strip()


def private_directory(path):
    if path.is_symlink():
        raise RuntimeError("Refusing a symlink at a protected directory")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_uid != 0:
        raise RuntimeError("Protected directory must belong to root")
    path.chmod(0o700)


def write_private(path, content):
    # Exclusive creation: never follow a symlink or replace an existing secret.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)


def preflight():
    if os.geteuid() != 0:
        raise RuntimeError("Run only as root on the verified Russian VPS")
    if Path("/opt/bron/production-enabled").exists():
        raise RuntimeError("Use the production runbook after release")
    addresses = run(["ip", "-4", "-o", "addr", "show", "scope", "global"])
    if TARGET_IP not in [line.split()[3].split("/")[0]
                         for line in addresses.splitlines()]:
        raise RuntimeError("This is not the verified target VPS")
    for service in ("docker", "ssh"):
        if run(["systemctl", "is-active", service]) != "active":
            raise RuntimeError(f"Required service is inactive: {service}")
    if run(["docker", "ps", "--all", "--quiet"]):
        raise RuntimeError("Review existing containers before preparing access")
    if not run(["pg_dump", "--version"]).startswith("pg_dump (PostgreSQL) 17."):
        raise RuntimeError("PostgreSQL client 17 is required")
    if run(["supabase", "--version"]) != "3.1.0":
        raise RuntimeError("Review CLI behavior before changing the pinned version")
    private_directory(SECRET_DIR)
    private_directory(STATE_DIR)
    # PostgreSQL SSLRequest, then normal system CA + hostname verification.
    # No credentials are sent by this network check. No insecure fallback.
    if not SOURCE_CA.is_file() or SOURCE_CA.is_symlink():
        raise RuntimeError("Prepare the verified source CA bundle first")
    context = ssl.create_default_context(cafile=str(SOURCE_CA))
    def deadline(_signum, _frame):
        raise TimeoutError("Source network check exceeded 30 seconds")
    previous_handler = signal.signal(signal.SIGALRM, deadline)
    signal.alarm(30)
    try:
        print("Checking source DNS and TCP/5432...", flush=True)
        with socket.create_connection((SOURCE_HOST, 5432), timeout=10) as connection:
            print("TCP connected; checking PostgreSQL TLS...", flush=True)
            connection.sendall(struct.pack("!II", 8, 80877103))
            if connection.recv(1) != b"S":
                raise RuntimeError("Source does not offer PostgreSQL TLS")
            with context.wrap_socket(connection, server_hostname=SOURCE_HOST) as secure:
                tls_version = secure.version()
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)
    print(f"Target checks passed; kernel {run(['uname', '-r'])}.")
    print(f"Source TCP/5432, certificate and hostname verified: {tls_version}.")


def connect():
    if SERVICE_FILE.exists() != PASSWORD_FILE.exists():
        raise RuntimeError("Incomplete source credential files require review")
    if not SERVICE_FILE.exists():
        if not sys.stdin.isatty():
            raise RuntimeError("Enter the password at the server TTY")
        password = getpass.getpass("Existing SUPABASE DATABASE password (hidden): ")
        if not password or any(char in password for char in "\r\n\x00"):
            raise RuntimeError("Empty or multiline password is not accepted")
        if password == "[YOUR-PASSWORD]":
            raise RuntimeError("The connection template is not the database password")
        escaped_password = password.replace("\\", "\\\\").replace(":", "\\:")
        service = ("[bron_source]\n" + f"host={SOURCE_HOST}\nport=5432\n"
                   + f"user={SOURCE_USER}\ndbname=postgres\n"
                   + "sslmode=verify-full\n"
                   + f"sslrootcert={SOURCE_CA}\n"
                   + "connect_timeout=15\napplication_name=bron-migration-readonly\n")
        write_private(SERVICE_FILE, service)
        try:
            write_private(PASSWORD_FILE,
                          f"{SOURCE_HOST}:5432:postgres:{SOURCE_USER}:{escaped_password}\n")
        except BaseException:
            SERVICE_FILE.unlink()
            raise
        password = escaped_password = ""
    for path in (SERVICE_FILE, PASSWORD_FILE):
        if path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
            raise RuntimeError("Unsafe source credential file permissions")
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith("PG")}
    environment.update(PGSERVICEFILE=str(SERVICE_FILE), PGPASSFILE=str(PASSWORD_FILE),
                       PGSERVICE="bron_source",
                       PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000")
    query = """select json_build_object(
      'server_version',current_setting('server_version'),
      'read_only',current_setting('default_transaction_read_only'),
      'auth_users',(select count(*) from auth.users),
      'identities',(select count(*) from auth.identities),
      'buckets',(select count(*) from storage.buckets),
      'objects',(select count(*) from storage.objects));"""
    result = json.loads(run(["psql", "-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1",
                             "--dbname", "service=bron_source", "--command", query],
                            env=environment))
    if not result["server_version"].startswith("17.") or result["read_only"] != "on":
        raise RuntimeError("Unexpected source version or access mode")
    print("Read-only source connection verified: " + json.dumps(result, sort_keys=True))
    print("Existing DB credentials are protected on this VPS (root only).")
    print("No database copied or modified. Next: consistent backup and restore rehearsal.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--connect", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    preflight()
    if args.connect:
        connect()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Cancelled; no database changes.", file=sys.stderr)
        sys.exit(130)
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        # Do not print subprocess stdout/stderr or connection details with secrets.
        print(f"STOP: {type(error).__name__}: " +
              (str(error) if not isinstance(error, subprocess.SubprocessError)
               else "A required command failed; no source changes."), file=sys.stderr)
        sys.exit(1)
