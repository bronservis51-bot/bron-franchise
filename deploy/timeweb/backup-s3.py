#!/usr/bin/env python3
"""Limited-key setup, throwaway probe and encrypted migration/target S3 upload.

Only validated encrypted artifacts and their metadata manifest are uploaded.
No scheduler, bucket/ACL operations, multipart or backup deletion.
"""
import argparse
import contextlib
import datetime
import fcntl
import getpass
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import unquote, urlsplit
import warnings

ENDPOINT = "https://s3.twcstorage.ru"
REGION = "ru-1"
BUCKET = "bron-franchise-backups"
USER_ID = "9d3e01f1-27ae-4d38-a2a9-33d46560d191"
POLICY_SHA256 = "7646f130270dc45d69a89bf101a6908934946d0b0ca613b7b80a61037755f02d"
SECRET_DIR = Path("/root/bron-secrets")
CREDENTIALS = SECRET_DIR / "timeweb-backup.credentials.json"
PROBE_RECEIPT = SECRET_DIR / "timeweb-backup.probe.json"
BACKUP_ROOT = Path("/var/backups/bron-franchise")
OWNER_UID = 0
BUCKET_BUDGET = 800_000_000  # 200 MB headroom below the paid decimal 1 GB limit.
RUN_BUDGET = 100_000_000
AGE_HEADER = b"age-encryption.org/v1\n"
SOURCE_FILES = frozenset(name + ".zst.age" for name in (
    "roles.sql", "schema.sql", "data.sql", "raw-schema-archive.sql",
    "vault-ciphertext.sql", "managed-migration-versions.sql", "vault-logical.csv"))
SUPPLEMENT_FILES = frozenset({"managed-metadata.json.zst.age"})
TARGET_FILES = frozenset({"database.dump.zst.age", "roles.sql.zst.age",
    "vault-logical.csv.zst.age", "config.tar.zst.age", "storage.tar.zst.age"})
TARGET_PERIODS = frozenset({"hourly", "daily", "monthly"})
TARGET_MISSING = frozenset({"isolated_target_restore_not_verified",
    "independent_key_custody_not_verified", "concurrent_storage_overwrite_not_verified"})
PROBE_PATTERN = r"migration/probe-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}/permission-probe\.txt"


class BackupError(RuntimeError):
    """Only fixed status codes may be printed."""


def private_directory(path):
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != OWNER_UID
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise BackupError("UNSAFE_PRIVATE_DIRECTORY")


@contextlib.contextmanager
def private_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise BackupError("UNSAFE_PRIVATE_FILE")
        yield stream


def runtime_guard():
    if os.geteuid() != 0 or sys.platform != "linux":
        raise BackupError("RUSSIAN_VPS_ROOT_REQUIRED")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    result = subprocess.run(["/usr/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"],
                            env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=5, check=True)
    if "152.228.115.115" not in [line.split()[3].split("/")[0]
                               for line in result.stdout.decode().splitlines()]:
        raise BackupError("WRONG_VPS")
    private_directory(SECRET_DIR)
    private_directory(BACKUP_ROOT)


def save_private_once(path, value):
    if os.path.lexists(path):
        raise BackupError("PRIVATE_FILE_ALREADY_EXISTS")
    fd, temporary = tempfile.mkstemp(prefix=".s3-private-", dir=path.parent)
    temporary = Path(temporary)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write((json.dumps(value, sort_keys=True) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            raise BackupError("PRIVATE_FILE_ALREADY_EXISTS") from None
    finally:
        temporary.unlink(missing_ok=True)


def read_private_json(path):
    with private_file(path) as stream:
        content = stream.read(131073)
    if len(content) > 131072:
        raise BackupError("PRIVATE_JSON_TOO_LARGE")
    try:
        value = json.loads(content)
    except (ValueError, UnicodeError):
        raise BackupError("PRIVATE_JSON_INVALID") from None
    if not isinstance(value, dict):
        raise BackupError("PRIVATE_JSON_INVALID")
    return value


def credential_value(value):
    if (not isinstance(value, str) or not value or len(value) > 4096
            or any(ord(c) < 33 or ord(c) > 126 for c in value)):
        raise BackupError("CREDENTIAL_INPUT_INVALID")
    return value


def hidden_prompt(label, hex_input=False):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        value = getpass.getpass(label)
    if hex_input:
        if (not value or len(value) > 8192 or len(value) % 2
                or not re.fullmatch(r"[0-9a-f]+", value)):
            raise BackupError("HEX_CREDENTIAL_INPUT_INVALID")
        try:
            value = bytes.fromhex(value).decode("utf-8")
        except (ValueError, UnicodeError):
            raise BackupError("HEX_CREDENTIAL_INPUT_INVALID") from None
    return credential_value(value)


def credentials():
    value = read_private_json(CREDENTIALS)
    if value.get("format") != 1 or value.get("limited_user_id") != USER_ID:
        raise BackupError("LIMITED_CREDENTIAL_FILE_REQUIRED")
    return {"access_key_id": credential_value(value.get("access_key_id")),
            "secret_access_key": credential_value(value.get("secret_access_key"))}


def credential_fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


@contextlib.contextmanager
def operation_lock():
    fd = os.open(SECRET_DIR / ".s3-upload.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != OWNER_UID or stat.S_IMODE(info.st_mode) != 0o600:
            raise BackupError("UNSAFE_UPLOAD_LOCK")
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("ANOTHER_S3_OPERATION_IS_RUNNING") from None
        yield


def guard_request(request, allow_probe_delete=False, allow_target=False):
    try:
        url = urlsplit(request.url)
        path = unquote(url.path)
        method = request.method.decode() if isinstance(request.method, bytes) else request.method
        valid = (url.scheme == "https" and url.hostname == "s3.twcstorage.ru"
                 and url.port in (None, 443) and url.username is None and url.password is None
                 and not url.fragment and path in (f"/{BUCKET}", f"/{BUCKET}/")
                 and method == "GET")
        migration = path.startswith(f"/{BUCKET}/migration/")
        target = allow_target and re.fullmatch(
            rf"/{BUCKET}/(?:hourly|daily|monthly)/target-[0-9]{{8}}T[0-9]{{6}}Z-[0-9a-f]{{32}}/"
            r"(?:database\.dump\.zst\.age|roles\.sql\.zst\.age|vault-logical\.csv\.zst\.age|config\.tar\.zst\.age|storage\.tar\.zst\.age|manifest\.json)", path)
        if migration or target:
            key = path[len(BUCKET) + 2:]
            valid = (url.scheme == "https" and url.hostname == "s3.twcstorage.ru"
                     and url.port in (None, 443) and not url.username and not url.password
                     and not url.fragment and method in ("GET", "HEAD", "PUT"))
            if method == "DELETE":
                valid = (url.scheme == "https" and url.hostname == "s3.twcstorage.ru"
                         and url.port in (None, 443) and not url.username and not url.password
                         and not url.fragment and allow_probe_delete and migration
                         and re.fullmatch(PROBE_PATTERN, key) is not None)
    except (ValueError, TypeError, AttributeError):
        valid = False
    if not valid:
        raise BackupError("S3_ENDPOINT_OR_OPERATION_FORBIDDEN")


def no_redirect(response=None, **_kwargs):
    if response is not None and response[0].status_code in (301, 302, 303, 307, 308):
        raise BackupError("S3_REDIRECT_FORBIDDEN")


def conditional_put_header(request, **_kwargs):
    # Compatible with Ubuntu's older botocore model, before this header is signed.
    request.headers["If-None-Match"] = "*"


def sdk_modules():
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        raise BackupError("INSTALL_UBUNTU_PYTHON3_BOTO3") from None
    if not str(boto3.__file__).startswith("/usr/lib/python3/dist-packages/boto3/"):
        raise BackupError("UBUNTU_APT_BOTO3_REQUIRED")
    return boto3, Config


def s3_client(value, allow_probe_delete=False, allow_target=False):
    boto3, Config = sdk_modules()
    for name in list(os.environ):
        if name.startswith("AWS_"):
            del os.environ[name]
    os.environ.update(AWS_EC2_METADATA_DISABLED="true", AWS_CSM_ENABLED="false",
                      AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null")
    session = boto3.Session(aws_access_key_id=value["access_key_id"],
                            aws_secret_access_key=value["secret_access_key"], region_name=REGION)
    client = session.client("s3", endpoint_url=ENDPOINT, region_name=REGION, verify=True,
                            config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=60,
                                          retries={"total_max_attempts": 1, "mode": "standard"},
                                          s3={"addressing_style": "path"}, proxies={}))
    client.meta.events.register_first("before-send.s3",
        lambda request, **_kwargs: guard_request(request, allow_probe_delete, allow_target))
    client.meta.events.register_first("needs-retry.s3", no_redirect)
    client.meta.events.register_first("before-sign.s3.PutObject", conditional_put_header)
    return client


def error_status(error):
    response = getattr(error, "response", {})
    return response.get("ResponseMetadata", {}).get("HTTPStatusCode")


def access_denied(error):
    return (error_status(error) == 403
            and getattr(error, "response", {}).get("Error", {}).get("Code") == "AccessDenied")


def bucket_usage(client):
    total = count = 0
    token = None
    seen = set()
    for _page in range(1000):
        args = {"Bucket": BUCKET, "MaxKeys": 1000}
        if token:
            args["ContinuationToken"] = token
        page = client.list_objects_v2(**args)
        for entry in page.get("Contents", []):
            size = entry.get("Size")
            if type(size) is not int or size < 0:
                raise BackupError("INVALID_BUCKET_SIZE_RESPONSE")
            total += size
            count += 1
        if not page.get("IsTruncated"):
            return total, count
        token = page.get("NextContinuationToken")
        if not isinstance(token, str) or not token or token in seen:
            raise BackupError("INVALID_BUCKET_PAGINATION")
        seen.add(token)
    raise BackupError("BUCKET_LIST_LIMIT_REACHED")


def absent(client, key):
    try:
        client.head_object(Bucket=BUCKET, Key=key)
    except Exception as error:
        if error_status(error) == 404:
            return
        raise BackupError("REMOTE_EXISTENCE_CHECK_FAILED") from None
    raise BackupError("REMOTE_OBJECT_ALREADY_EXISTS")


def readback(client, key, size, expected_sha256):
    body = None
    try:
        response = client.get_object(Bucket=BUCKET, Key=key)
        body = response["Body"]
        if response.get("ContentLength") != size:
            raise BackupError("READBACK_SIZE_MISMATCH")
        digest = hashlib.sha256()
        count = 0
        while True:
            chunk = body.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > size:
                raise BackupError("READBACK_SIZE_MISMATCH")
            digest.update(chunk)
        if count != size or digest.hexdigest() != expected_sha256:
            raise BackupError("READBACK_SHA256_MISMATCH")
    except BackupError:
        raise
    except Exception:
        raise BackupError("READBACK_FAILED") from None
    finally:
        if body is not None:
            body.close()


def put_once(client, key, body, size, sha256):
    try:
        client.put_object(Bucket=BUCKET, Key=key, Body=body,
                          ContentLength=size, ContentType="application/octet-stream")
    except Exception as error:
        if isinstance(error, BackupError):
            raise
        if error_status(error) in (409, 412):
            raise BackupError("REMOTE_OBJECT_ALREADY_EXISTS") from None
        # A lost PUT response must not trigger a second PUT. Only read it back.
        readback(client, key, size, sha256)
        return
    readback(client, key, size, sha256)


def setup(hex_input=False):
    if os.path.lexists(CREDENTIALS):
        raise BackupError("LIMITED_CREDENTIALS_ALREADY_EXIST")
    if not sys.stdin.isatty():
        raise BackupError("HIDDEN_INTERACTIVE_TTY_REQUIRED")
    sdk_modules()  # Missing apt dependency must be discovered before secret entry.
    value = {"access_key_id": hidden_prompt("Limited S3 Access ID (hidden): ", hex_input),
             "secret_access_key": hidden_prompt("Limited S3 Secret Key (hidden): ", hex_input)}
    client = s3_client(value)
    try:
        bucket_usage(client)  # Read-only authentication check before persisting.
    finally:
        client.close()
    save_private_once(CREDENTIALS, {"format": 1, "limited_user_id": USER_ID, **value})
    return {"status": "LIMITED_CREDENTIALS_SAVED_PROBE_PENDING", "credentials_printed": False}


def run_prefix(kind):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"migration/{kind}-{stamp}-{uuid.uuid4().hex}/"


def probe(value, client):
    if os.path.lexists(PROBE_RECEIPT):
        raise BackupError("PROBE_RECEIPT_EXISTS_REVIEW_BEFORE_REPEATING")
    data = ("bron-franchise-nonpersonal-permission-probe:" + uuid.uuid4().hex + "\n").encode()
    key = run_prefix("probe") + "permission-probe.txt"
    used, _count = bucket_usage(client)
    if used + len(data) > BUCKET_BUDGET:
        raise BackupError("BUCKET_HEADROOM_REQUIRED")
    absent(client, key)
    put_once(client, key, io.BytesIO(data), len(data), hashlib.sha256(data).hexdigest())
    # This is the sole deletion operation in the program, on the fresh marker.
    if not re.fullmatch(PROBE_PATTERN, key):
        raise BackupError("INVALID_THROWAWAY_PROBE_KEY")
    try:
        client.delete_object(Bucket=BUCKET, Key=key)
    except Exception as error:
        if not access_denied(error):
            raise BackupError("DELETE_DENIAL_NOT_VERIFIED") from None
    else:
        raise BackupError("CREDENTIALS_CAN_DELETE_REFUSE_BACKUP_UPLOAD")
    readback(client, key, len(data), hashlib.sha256(data).hexdigest())
    save_private_once(PROBE_RECEIPT, {"format": 1, "limited_user_id": USER_ID,
        "credential_sha256": credential_fingerprint(value), "policy_sha256": POLICY_SHA256,
        "probe_key": key, "put_get_sha256_verified": True, "delete_denied_403": True})
    return {"status": "LIMITED_PUT_GET_VERIFIED_DELETE_DENIED", "nonpersonal_probe_retained": True,
            "backup_deleted": False}


def require_probe(value):
    receipt = read_private_json(PROBE_RECEIPT)
    if (receipt.get("credential_sha256") != credential_fingerprint(value)
            or receipt.get("policy_sha256") != POLICY_SHA256
            or receipt.get("put_get_sha256_verified") is not True
            or receipt.get("delete_denied_403") is not True):
        raise BackupError("MATCHING_LIMITED_CREDENTIAL_PROBE_REQUIRED")


def upload(manifest_path, value, client):
    require_probe(value)
    if (not manifest_path.is_absolute() or manifest_path.name != "manifest.json"
            or manifest_path.parent.parent != BACKUP_ROOT
            or not re.fullmatch(r"(source|supplement)-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", manifest_path.parent.name)):
        raise BackupError("EXPLICIT_BACKUP_MANIFEST_REQUIRED")
    private_directory(manifest_path.parent)
    manifest = read_private_json(manifest_path)
    status = manifest.get("status")
    expected = (SOURCE_FILES if status == "sql_auth_stage_only_restore_unverified" else
                SUPPLEMENT_FILES if status == "metadata_supplement_only_restore_unverified" else None)
    if (expected is None or manifest.get("format") != 1 or manifest.get("complete") is not False
            or manifest.get("source_project") != "vkkqffvmztpzgygzfxhq"):
        raise BackupError("SUPPORTED_INCOMPLETE_MIGRATION_MANIFEST_REQUIRED")
    return upload_artifacts(manifest_path, manifest, expected, client,
        run_prefix("source" if expected == SOURCE_FILES else "supplement"),
        "MIGRATION_UPLOAD_READBACK_VERIFIED")


def upload_target(manifest_path, value, client, period="hourly"):
    require_probe(value)
    if period not in TARGET_PERIODS:
        raise BackupError("TARGET_BACKUP_PERIOD_INVALID")
    if (not manifest_path.is_absolute() or manifest_path.name != "manifest.json"
            or manifest_path.parent.parent != BACKUP_ROOT
            or not re.fullmatch(r"target-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}", manifest_path.parent.name)):
        raise BackupError("EXPLICIT_TARGET_BACKUP_MANIFEST_REQUIRED")
    private_directory(manifest_path.parent)
    manifest = read_private_json(manifest_path)
    required = {"format", "status", "complete", "target", "created_utc", "artifacts", "storage_objects"}
    if (set(manifest) not in (required, required | {"metadata", "missing"})
            or type(manifest.get("format")) is not int or manifest["format"] != 1
            or manifest.get("status") != "target_backup_saved_restore_unverified"
            or manifest.get("complete") is not False
            or manifest.get("target") != "bron-franchise-russia"
            or type(manifest.get("storage_objects")) is not int or manifest["storage_objects"] < 0
            or manifest.get("created_utc") != manifest_path.parent.name[7:23]):
        raise BackupError("SUPPORTED_TARGET_MANIFEST_REQUIRED")
    if "metadata" in manifest:
        metadata = manifest["metadata"]
        patterns = {"database_image": r"sha256:[0-9a-f]{64}",
                    "snapshot": r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[0-9]+",
                    "encryption_recipient": r"age1[0-9a-z]{40,100}"}
        missing = manifest["missing"]
        if (not isinstance(metadata, dict)
                or set(metadata) != set(patterns) | {"postgres_version_num", "db_config_included", "storage_consistency"}
                or type(metadata.get("postgres_version_num")) is not int or metadata["postgres_version_num"] != 170011
                or metadata.get("db_config_included") is not True
                or metadata.get("storage_consistency") != "stable_before_after"
                or any(not isinstance(metadata.get(key), str)
                       or re.fullmatch(pattern, metadata[key]) is None for key,pattern in patterns.items())
                or not isinstance(missing, list) or len(missing) != len(TARGET_MISSING)
                or any(not isinstance(item, str) for item in missing) or set(missing) != TARGET_MISSING):
            raise BackupError("TARGET_METADATA_WHITELIST_REQUIRED")
    try:
        datetime.datetime.strptime(manifest["created_utc"], "%Y%m%dT%H%M%SZ")
    except (ValueError, TypeError):
        raise BackupError("TARGET_MANIFEST_TIME_INVALID") from None
    entries = manifest.get("artifacts")
    if (not isinstance(entries, list) or any(not isinstance(entry, dict)
            or set(entry) != {"file", "bytes", "sha256"} for entry in entries)):
        raise BackupError("TARGET_ARTIFACT_METADATA_INVALID")
    prefix = f"{period}/target-{manifest['created_utc']}-{uuid.uuid4().hex}/"
    return upload_artifacts(manifest_path, manifest, TARGET_FILES, client, prefix,
                            "TARGET_UPLOAD_READBACK_VERIFIED", unversioned=True)


def upload_artifacts(manifest_path, manifest, expected, client, prefix, status, unversioned=False):
    entries = manifest.get("artifacts")
    if (not isinstance(entries, list) or len(entries) != len(expected)
            or any(not isinstance(e, dict) or not isinstance(e.get("file"), str) for e in entries)
            or {e["file"] for e in entries} != expected):
        raise BackupError("EXACT_ENCRYPTED_ARTIFACT_SET_REQUIRED")
    if {p.name for p in manifest_path.parent.iterdir()} != expected | {"manifest.json"}:
        raise BackupError("BACKUP_DIRECTORY_CONTENTS_MISMATCH")
    with contextlib.ExitStack() as stack:
        plan = []
        for entry in entries:
            stream = stack.enter_context(private_file(manifest_path.parent / entry["file"]))
            if (type(entry.get("bytes")) is not int or entry["bytes"] < 100
                    or not isinstance(entry.get("sha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
                    or os.fstat(stream.fileno()).st_size != entry["bytes"]):
                raise BackupError("ARTIFACT_SIZE_OR_HASH_ENTRY_INVALID")
            if stream.read(len(AGE_HEADER)) != AGE_HEADER:
                raise BackupError("AGE_CIPHERTEXT_REQUIRED")
            stream.seek(0)
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            stream.seek(0)
            if digest.hexdigest() != entry["sha256"]:
                raise BackupError("LOCAL_ARTIFACT_SHA256_MISMATCH")
            plan.append((entry["file"], stream, entry["bytes"], entry["sha256"]))
        with private_file(manifest_path) as stream:
            manifest_bytes = stream.read(131073)
        if len(manifest_bytes) > 131072 or json.loads(manifest_bytes) != manifest:
            raise BackupError("LOCAL_MANIFEST_CHANGED")
        plan.append(("manifest.json", io.BytesIO(manifest_bytes), len(manifest_bytes),
                     hashlib.sha256(manifest_bytes).hexdigest()))  # Commit marker last.
        size = sum(item[2] for item in plan)
        if unversioned and client.get_bucket_versioning(Bucket=BUCKET).get("Status") not in (None, ""):
            raise BackupError("UNVERSIONED_TARGET_BUCKET_REQUIRED")
        used, _count = bucket_usage(client)
        if size > RUN_BUDGET or used + size > BUCKET_BUDGET:
            raise BackupError("FIXED_BUCKET_OR_RUN_BUDGET_EXCEEDED")
        for name, _stream, _size, _sha in plan:
            absent(client, prefix + name)
        for name, stream, object_size, sha in plan:
            put_once(client, prefix + name, stream, object_size, sha)
    return {"status": status, "prefix": prefix,
            "objects": len(plan), "encrypted_artifact_bytes": size - len(manifest_bytes),
            "bucket_bytes_before": used, "complete": False, "restore_performed": False}


def main():
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise BackupError("USE_EXPLICIT_SETUP_PROBE_UPLOAD_OR_CHECK")
    parser = Parser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--setup", action="store_true")
    modes.add_argument("--probe", action="store_true")
    modes.add_argument("--upload", action="store_true")
    modes.add_argument("--upload-target", action="store_true")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--hex-input", action="store_true")
    parser.add_argument("--period", choices=sorted(TARGET_PERIODS))
    args = parser.parse_args()
    if ((args.hex_input and not args.setup)
            or bool(args.manifest) != bool(args.upload or args.upload_target)
            or (args.period is not None and not args.upload_target)):
        raise BackupError("INVALID_MODE_ARGUMENTS")
    if args.manifest == Path("manifest.json"):
        args.manifest = Path.cwd() / args.manifest
    runtime_guard()
    if args.check:
        sdk_modules()
        print(json.dumps({"status": "LOCAL_GUARDS_PASSED", "network_used": False,
                          "bucket_budget_bytes": BUCKET_BUDGET, "run_budget_bytes": RUN_BUDGET}))
        return
    with operation_lock():
        if args.setup:
            print(json.dumps(setup(args.hex_input), sort_keys=True))
            return
        value = credentials()
        client = s3_client(value, allow_probe_delete=args.probe, allow_target=args.upload_target)
        try:
            if args.probe:
                result = probe(value, client)
            elif args.upload_target:
                result = upload_target(args.manifest, value, client, args.period or "hourly")
            else:
                result = upload(args.manifest, value, client)
            print(json.dumps(result, sort_keys=True))
        finally:
            client.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({"status": "CANCELLED_RESULT_REQUIRES_VERIFICATION", "complete": False}))
        sys.exit(130)
    except Exception as error:
        code = str(error) if isinstance(error, BackupError) else "S3_OPERATION_FAILED_RESULT_REQUIRES_VERIFICATION"
        print(json.dumps({"status": code, "complete": False}))
        sys.exit(1)
