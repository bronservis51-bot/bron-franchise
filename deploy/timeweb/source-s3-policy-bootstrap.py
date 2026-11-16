#!/usr/bin/env python3
"""Prepare/check, or explicitly apply ONLY the reviewed Timeweb IAM user policy.

Default is offline --check. Applying needs separate owner authorization and a TTY.
No user/key creation, S3 object operations, uploader or credential persistence.
"""
import argparse
import contextlib
import getpass
import hashlib
import importlib.util
import json
import logging
import os
from pathlib import Path
import resource
import stat
import subprocess
import sys
from urllib.parse import unquote, urlsplit
import warnings

ENDPOINT = "https://s3.twcstorage.ru"
REGION = "ru-1"
USERNAME = "bron-franchise-backup"
POLICY_NAME = "bron-franchise-backup-no-delete"
POLICY_FILE = Path("/opt/bron/backup-uploader-policy.json")
POLICY_SHA256 = "7646f130270dc45d69a89bf101a6908934946d0b0ca613b7b80a61037755f02d"


class BootstrapError(RuntimeError):
    pass


def runtime_guard():
    if sys.platform != "linux" or os.geteuid() != 0:
        raise BootstrapError("REQUIRES_RUSSIAN_VPS_ROOT")
    if Path("/opt/bron/production-enabled").exists():
        raise BootstrapError("PRODUCTION_ENABLED_REVIEW_REQUIRED")
    try:
        result = subprocess.run(["/usr/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"],
                                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8"},
                                capture_output=True, text=True, timeout=5, check=True)
        addresses = [line.split()[3].split("/")[0] for line in result.stdout.splitlines()]
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        raise BootstrapError("VPS_IDENTITY_CHECK_FAILED") from None
    if "152.228.115.115" not in addresses:
        raise BootstrapError("WRONG_VPS")


def reviewed_policy():
    fd = None
    try:
        fd = os.open(POLICY_FILE, os.O_RDONLY | os.O_NOFOLLOW)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) not in (0o600, 0o644):
            raise BootstrapError("POLICY_FILE_UNSAFE")
        data = os.read(fd, 16385)
        if len(data) > 16384 or hashlib.sha256(data).hexdigest() != POLICY_SHA256:
            raise BootstrapError("POLICY_HASH_MISMATCH")
        text = data.decode("utf-8")
        parsed = json.loads(text)
        return text, parsed
    except (OSError, ValueError, UnicodeError):
        raise BootstrapError("POLICY_FILE_UNAVAILABLE_OR_INVALID") from None
    finally:
        if fd is not None:
            os.close(fd)


def sdk_available():
    return all(importlib.util.find_spec(name) is not None for name in ("boto3", "botocore"))


def guard_request(request, **_kwargs):
    try:
        url = urlsplit(request.url)
        valid = (url.scheme == "https" and url.hostname == "s3.twcstorage.ru"
                 and url.port in (None, 443) and url.path in ("", "/")
                 and url.username is None and url.password is None and not url.fragment)
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise BootstrapError("IAM_ENDPOINT_OR_REDIRECT_FORBIDDEN")


def guard_redirect(response=None, **_kwargs):
    if response is not None and response[0].status_code in (301, 302, 303, 307, 308):
        raise BootstrapError("IAM_REDIRECT_FORBIDDEN")


def iam_client(access_id, secret):
    # Explicit credentials bypass the default credential chain. Disable optional
    # monitoring/config discovery; no primary credential ever goes into env.
    for name in list(os.environ):
        if name.startswith("AWS_"):
            del os.environ[name]
    os.environ.update(AWS_EC2_METADATA_DISABLED="true", AWS_CSM_ENABLED="false",
                      AWS_CONFIG_FILE="/dev/null", AWS_SHARED_CREDENTIALS_FILE="/dev/null")
    import boto3
    from botocore.config import Config
    session = boto3.Session(aws_access_key_id=access_id, aws_secret_access_key=secret, region_name=REGION)
    client = session.client("iam", endpoint_url=ENDPOINT, region_name=REGION, verify=True,
                            config=Config(signature_version="v4", connect_timeout=5, read_timeout=15,
                                          retries={"total_max_attempts": 1, "mode": "standard"}, proxies={}))
    client.meta.events.register_first("before-send.iam", guard_request)
    client.meta.events.register_first("needs-retry.iam", guard_redirect)
    return client


def private_prompt(label):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        value = getpass.getpass(label)
    if not value or len(value) > 4096 or any(char in value for char in "\r\n\x00"):
        raise BootstrapError("CREDENTIAL_INPUT_INVALID")
    return value


def apply_policy(text, expected):
    if not sys.stdin.isatty():
        raise BootstrapError("INTERACTIVE_TTY_REQUIRED")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # Do not claim strict RAM-only handling if the OS can page these strings out.
    if len(Path("/proc/swaps").read_text().splitlines()) > 1:
        raise BootstrapError("ACTIVE_SWAP_REVIEW_REQUIRED")
    logging.disable(logging.CRITICAL)
    access_id = secret = client = None
    try:
        access_id = private_prompt("Primary S3 Access Key ID (hidden): ")
        secret = private_prompt("Primary S3 Secret Key (hidden): ")
        client = iam_client(access_id, secret)
        try:
            client.put_user_policy(UserName=USERNAME, PolicyName=POLICY_NAME, PolicyDocument=text)
        except BootstrapError:
            raise
        except Exception:
            raise BootstrapError("IAM_PUT_FAILED_OR_RESULT_UNKNOWN") from None
        result = {"policy_put_acknowledged": True, "policy_readback": "pending",
                  "backup_access_verified": False, "credentials_persisted": False,
                  "policy_sha256": POLICY_SHA256}
        try:
            document = client.get_user_policy(UserName=USERNAME, PolicyName=POLICY_NAME)["PolicyDocument"]
            if isinstance(document, str):
                try:
                    document = json.loads(document)
                except ValueError:
                    document = json.loads(unquote(document))
            result["policy_readback"] = "verified" if document == expected else "mismatch"
        except BootstrapError:
            raise
        except Exception:
            # Provider GetUserPolicy support is not established. Never turn a
            # failed readback into a claim that setup/backup access is verified.
            result["policy_readback"] = "pending_unsupported_or_failed"
        return result
    finally:
        if client is not None:
            with contextlib.suppress(Exception):
                client.close()
        access_id = secret = client = None
        # Python strings/SDK internals cannot promise deterministic zeroization.
        # This short-lived process exits; no key is written to files/env/argv.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Offline guards only (default)")
    mode.add_argument("--apply-reviewed-policy", action="store_true")
    parser.add_argument("--user", help="Explicit, nonsecret target additional-user name")
    args = parser.parse_args()
    if args.user not in (None, USERNAME) or (args.apply_reviewed_policy and args.user != USERNAME):
        raise BootstrapError("EXPLICIT_REVIEWED_USERNAME_REQUIRED")
    runtime_guard()
    text, expected = reviewed_policy()
    if not sdk_available():
        raise BootstrapError("SDK_MISSING_INSTALL_OFFICIAL_PYTHON3_BOTO3")
    if not args.apply_reviewed_policy:
        print(json.dumps({"mode": "offline_check", "network_used": False, "policy_applied": False,
                          "policy_sha256": POLICY_SHA256, "endpoint": ENDPOINT, "region": REGION}, sort_keys=True))
        return 0
    result = apply_policy(text, expected)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["policy_readback"] == "verified" else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("STOP: CANCELLED", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        code = str(error) if isinstance(error, BootstrapError) else "BOOTSTRAP_FAILED"
        print("STOP: " + code, file=sys.stderr)
        sys.exit(1)
