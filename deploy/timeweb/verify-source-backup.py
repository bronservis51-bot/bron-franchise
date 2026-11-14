#!/usr/bin/env python3
"""Read-only integrity/decryption check of one existing SQL/Auth backup stage.

No SQL, restore, network, plaintext files, credential output or manifest mutation.
Successful verification does not make the project backup complete.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys

BACKUP_ROOT = Path("/var/backups/bron-franchise")
SECRET_DIR = Path("/root/bron-secrets")
IDENTITY_FILE = SECRET_DIR / "source-backup.agekey"
OWNER_UID = 0
PIPELINE_TIMEOUT = 300
EXPECTED_FILES = frozenset(name + ".zst.age" for name in (
    "roles.sql", "schema.sql", "data.sql", "raw-schema-archive.sql",
    "vault-ciphertext.sql", "managed-migration-versions.sql", "vault-logical.csv"))


class VerificationError(RuntimeError):
    """Only fixed error codes may reach the report."""


def clean_env():
    return {"PATH": "/usr/bin:/bin", "HOME": "/root", "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8", "PSQL_HISTORY": "/dev/null"}


def checked_metadata(info, directory=False):
    wanted = stat.S_ISDIR if directory else stat.S_ISREG
    mode = 0o700 if directory else 0o600
    if (not wanted(info.st_mode) or info.st_uid != OWNER_UID
            or stat.S_IMODE(info.st_mode) != mode):
        raise VerificationError("UNSAFE_PRIVATE_PATH")


def checked_directory(path):
    try:
        checked_metadata(path.lstat(), directory=True)
    except OSError:
        raise VerificationError("PRIVATE_DIRECTORY_UNAVAILABLE") from None


@contextlib.contextmanager
def private_file(path):
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        checked_metadata(os.fstat(fd))
        with os.fdopen(fd, "rb") as stream:
            fd = None
            yield stream
    except OSError:
        raise VerificationError("PRIVATE_FILE_UNAVAILABLE") from None
    finally:
        if fd is not None:
            os.close(fd)


def read_manifest(path):
    if (not path.is_absolute() or path.name != "manifest.json"
            or path.parent.parent != BACKUP_ROOT
            or not re.fullmatch(r"source-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", path.parent.name)):
        raise VerificationError("EXPLICIT_SOURCE_MANIFEST_REQUIRED")
    checked_directory(BACKUP_ROOT)
    checked_directory(path.parent)
    with private_file(path) as stream:
        content = stream.read(131073)
    if len(content) > 131072:
        raise VerificationError("MANIFEST_TOO_LARGE")
    try:
        manifest = json.loads(content)
    except (ValueError, UnicodeError):
        raise VerificationError("MANIFEST_INVALID_JSON") from None
    if (not isinstance(manifest, dict) or type(manifest.get("format")) is not int
            or manifest["format"] != 1 or manifest.get("complete") is not False
            or manifest.get("source_project") != "vkkqffvmztpzgygzfxhq"
            or manifest.get("status") != "sql_auth_stage_only_restore_unverified"):
        raise VerificationError("UNEXPECTED_SQL_AUTH_MANIFEST")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != len(EXPECTED_FILES):
        raise VerificationError("SEVEN_ARTIFACTS_REQUIRED")
    names = []
    for entry in artifacts:
        if (not isinstance(entry, dict) or entry.get("file") not in EXPECTED_FILES
                or type(entry.get("bytes")) is not int or entry["bytes"] < 100
                or not isinstance(entry.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])):
            raise VerificationError("INVALID_ARTIFACT_ENTRY")
        names.append(entry["file"])
    if set(names) != EXPECTED_FILES:
        raise VerificationError("DUPLICATE_OR_MISSING_ARTIFACT")
    try:
        if {entry.name for entry in path.parent.iterdir()} != EXPECTED_FILES | {"manifest.json"}:
            raise VerificationError("BACKUP_DIRECTORY_CONTENTS_MISMATCH")
    except OSError:
        raise VerificationError("PRIVATE_DIRECTORY_UNAVAILABLE") from None
    return artifacts


def checksum(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    stream.seek(0)
    return digest.hexdigest()


def check_stream(stream, identity):
    """Decrypt into a pipe and test the compressed stream; discard all plaintext."""
    processes = []
    try:
        # Passing the already checked fd avoids reopening a substituted key path.
        decrypt = subprocess.Popen(
            ["/usr/bin/age", "--decrypt", "--identity", f"/proc/self/fd/{identity.fileno()}"],
            stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            pass_fds=(identity.fileno(),), env=clean_env())
        processes.append(decrypt)
        integrity = subprocess.Popen(
            ["/usr/bin/zstd", "--test", "--quiet", "--memory=128MB"],
            stdin=decrypt.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=clean_env())
        processes.append(integrity)
        decrypt.stdout.close()
        try:
            zstd_status = integrity.wait(timeout=PIPELINE_TIMEOUT)
            age_status = decrypt.wait(timeout=5)
        except subprocess.TimeoutExpired:
            raise VerificationError("ARTIFACT_VERIFICATION_TIMEOUT") from None
        if age_status != 0:
            raise VerificationError("AGE_DECRYPTION_FAILED")
        if zstd_status != 0:
            raise VerificationError("ZSTD_INTEGRITY_FAILED")
    except OSError:
        raise VerificationError("VERIFICATION_EXECUTABLE_FAILED") from None
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if processes and processes[0].stdout is not None:
            processes[0].stdout.close()


def verify(path):
    if os.geteuid() != 0 or sys.platform != "linux":
        raise VerificationError("VPS_ROOT_REQUIRED")
    # Child processes inherit this limit; a crash must not persist key/plaintext RAM.
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    artifacts = read_manifest(path)
    checked_directory(SECRET_DIR)
    with contextlib.ExitStack() as stack:
        identity = stack.enter_context(private_file(IDENTITY_FILE))
        streams = []
        # Validate every recorded ciphertext before decrypting any artifact.
        for entry in artifacts:
            stream = stack.enter_context(private_file(path.parent / entry["file"]))
            if os.fstat(stream.fileno()).st_size != entry["bytes"]:
                raise VerificationError("ARTIFACT_SIZE_MISMATCH")
            if checksum(stream) != entry["sha256"]:
                raise VerificationError("ARTIFACT_SHA256_MISMATCH")
            streams.append(stream)
        for stream in streams:
            check_stream(stream, identity)
    return {"verified": True, "complete": False,
            "status": "sql_auth_artifacts_verified_restore_unverified",
            "artifact_count": len(artifacts),
            "encrypted_bytes": sum(entry["bytes"] for entry in artifacts),
            "sha256_verified": True, "age_decryption_verified": True,
            "zstd_integrity_verified": True, "plaintext_files_written": False,
            "manifest_modified": False, "restore_performed": False}


def main():
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise VerificationError("USE_EXPLICIT_MANIFEST_ARGUMENT")
    parser = Parser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.manifest), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({"verified": False, "complete": False, "error": "CANCELLED"}))
        sys.exit(130)
    except Exception as error:
        code = str(error) if isinstance(error, VerificationError) else "VERIFICATION_FAILED"
        print(json.dumps({"verified": False, "complete": False, "error": code}))
        sys.exit(1)
