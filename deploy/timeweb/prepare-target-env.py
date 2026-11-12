#!/usr/bin/env python3
"""Prepare a private, restore-only Supabase .env on the verified Russian VPS.

Legacy HS256 mode is intentional: the pinned Envoy supports it without enabling
the commented asymmetric/JWKS service wiring. No source credentials are read.
No containers, DNS, SMTP delivery, external requests or publication are started.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time

TARGET_IP = "152.228.115.115"
UPSTREAM_COMMIT = "0ed90ae4603ff58f6e170fed51ea23bbda11cf6f"
CHECKOUT = Path("/opt/bron/supabase")
WORKDIR = CHECKOUT / "docker"
ENV_FILE = WORKDIR / ".env"
DOCKER = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
EXPECTED_IMAGE = "supabase/postgres:17.11.0.019@sha256:eca9f664ced0c453ae499e75bb503283831c94f2eef69fc2e69bf86f70278ddc"
PINNED_FILES = {
    ".env.example": "bc2763a3676fd9f9b27fd8b166f54110c49773c2bedb09888c665b4be8025933",
    "docker-compose.yml": "91d706ea68ae8bc194aa278680a91c486f642f1e7ee89a1ebc096d4f72c9c157",
    "bron/compose.override.yml": "a83fbde612c11b9e37b1760dc670760b7e8d94d045b91e9d9f9d2c4b70f7ba4a",
    "bron/compose.restore.override.yml": "32b5700ce3f58bfa3c971a31e2e51cd9a0b255947dddd619cef23b693841a15b",
}
MODERN_FIELDS = ("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "JWT_KEYS",
                 "JWT_JWKS", "ANON_KEY_ASYMMETRIC", "SERVICE_ROLE_KEY_ASYMMETRIC")
# Matches pinned utils/generate-keys.sh. User JWT expiry is separately 3600s.
API_KEY_LIFETIME = 5 * 365 * 24 * 3600


class TargetEnvError(RuntimeError):
    """Fixed status codes only: never include command output or secrets."""


def clean_env():
    return {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/root",
            "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "DO_NOT_TRACK": "1",
            "SUPABASE_TELEMETRY_DISABLED": "1", "DOCKER_CLI_HINTS": "false"}


def capture(args, timeout=30):
    try:
        return subprocess.run(args, cwd=WORKDIR, env=clean_env(),
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        raise TargetEnvError("REQUIRED_COMMAND_FAILED") from None


def public_file(path):
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise TargetEnvError("UNSAFE_PINNED_FILE")
        with os.fdopen(fd, "rb") as stream:
            fd = None
            return stream.read()
    except OSError:
        raise TargetEnvError("PINNED_FILE_UNAVAILABLE") from None
    finally:
        if fd is not None:
            os.close(fd)


def preflight():
    if os.geteuid() != 0 or sys.platform != "linux":
        raise TargetEnvError("VERIFIED_RUSSIAN_VPS_ROOT_REQUIRED")
    if os.path.lexists("/opt/bron/production-enabled"):
        raise TargetEnvError("PRODUCTION_ALREADY_ENABLED")
    if os.path.lexists(ENV_FILE):
        raise TargetEnvError("ENV_ALREADY_EXISTS_REVIEW_WITHOUT_OVERWRITING")
    for directory in (CHECKOUT, WORKDIR, WORKDIR / "bron"):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise TargetEnvError("UNSAFE_TARGET_DIRECTORY")
    addresses = capture(["/usr/sbin/ip", "-4", "-o", "addr", "show", "scope", "global"])
    if TARGET_IP not in [line.split()[3].split("/")[0]
                         for line in addresses.decode().splitlines()]:
        raise TargetEnvError("WRONG_TARGET_VPS")
    if capture(["/usr/bin/git", "-C", str(CHECKOUT), "rev-parse", "HEAD"]).decode().strip() != UPSTREAM_COMMIT:
        raise TargetEnvError("UPSTREAM_COMMIT_MISMATCH")
    try:
        # Includes tracked Envoy entrypoints/templates and DB init SQL mounted by
        # Compose; a matching HEAD alone does not prove their working-tree bytes.
        capture(["/usr/bin/git", "-C", str(CHECKOUT), "diff", "--quiet",
                 UPSTREAM_COMMIT, "--", "docker"])
    except TargetEnvError:
        raise TargetEnvError("UPSTREAM_TRACKED_CONFIG_CHANGED_OR_UNREADABLE") from None
    files = {}
    for name, expected in PINNED_FILES.items():
        content = public_file(WORKDIR / name)
        if hashlib.sha256(content).hexdigest() != expected:
            raise TargetEnvError("PINNED_CONFIGURATION_MISMATCH")
        files[name] = content
    if capture(DOCKER + ["ps", "--all", "--quiet"]).strip():
        raise TargetEnvError("REVIEW_EXISTING_CONTAINERS_FIRST")
    version = capture(DOCKER + ["compose", "version", "--short"]).decode().strip()
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.-]+)?", version)
    if not match or tuple(map(int, match.groups())) < (2, 24, 4):
        raise TargetEnvError("COMPOSE_OVERRIDE_SUPPORT_REQUIRED")
    return files[".env.example"].decode("utf-8")


def b64url(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def legacy_jwt(role, jwt_secret, issued_at):
    if role not in ("anon", "service_role") or not isinstance(issued_at, int):
        raise TargetEnvError("INVALID_API_KEY_INPUT")
    header = b64url(b'{"alg":"HS256","typ":"JWT"}')
    payload = b64url(json.dumps({"role": role, "iss": "supabase", "iat": issued_at,
                                "exp": issued_at + API_KEY_LIFETIME},
                               separators=(",", ":")).encode("ascii"))
    body = header + "." + payload
    signature = b64url(hmac.new(jwt_secret.encode("ascii"), body.encode("ascii"),
                               hashlib.sha256).digest())
    return body + "." + signature


def fresh_values(entropy=None, issued_at=None):
    # Injectable only for deterministic offline tests; main never supplies it.
    entropy = secrets.token_bytes if entropy is None else entropy
    issued_at = int(time.time()) if issued_at is None else issued_at
    values = {"POSTGRES_PASSWORD": entropy(32).hex(), "JWT_SECRET": b64url(entropy(32)),
              "DASHBOARD_PASSWORD": entropy(32).hex(),
              "SECRET_KEY_BASE": base64.b64encode(entropy(48)).decode("ascii"),
              "REALTIME_DB_ENC_KEY": entropy(8).hex(), "VAULT_ENC_KEY": entropy(16).hex(),
              "PG_META_CRYPTO_KEY": b64url(entropy(32)),
              "LOGFLARE_PUBLIC_ACCESS_TOKEN": b64url(entropy(32)),
              "LOGFLARE_PRIVATE_ACCESS_TOKEN": b64url(entropy(32)),
              "S3_PROTOCOL_ACCESS_KEY_ID": entropy(16).hex(),
              "S3_PROTOCOL_ACCESS_KEY_SECRET": entropy(32).hex(),
              "MINIO_ROOT_PASSWORD": entropy(32).hex()}
    for name, role in (("ANON_KEY", "anon"), ("SERVICE_ROLE_KEY", "service_role")):
        values[name] = legacy_jwt(role, values["JWT_SECRET"], issued_at)
    values.update({name: "" for name in MODERN_FIELDS})
    values.update({
        "COMPOSE_FILE": "docker-compose.yml:bron/compose.override.yml:bron/compose.restore.override.yml",
        "DASHBOARD_USERNAME": "bron-admin", "POSTGRES_HOST": "db", "POSTGRES_DB": "postgres",
        "POSTGRES_PORT": "5432", "POOLER_TENANT_ID": "bron-franchise",
        "STUDIO_DEFAULT_ORGANIZATION": "Бронь Сервис", "STUDIO_DEFAULT_PROJECT": "Франшиза",
        "SUPABASE_PUBLIC_URL": "https://api.bronservis.ru",
        "API_EXTERNAL_URL": "https://api.bronservis.ru/auth/v1",
        "SITE_URL": "https://app.bronservis.ru",
        "ADDITIONAL_REDIRECT_URLS": "https://app.bronservis.ru",
        "JWT_EXPIRY": "3600", "DISABLE_SIGNUP": "true", "ENABLE_EMAIL_SIGNUP": "true",
        "ENABLE_EMAIL_AUTOCONFIRM": "false", "ENABLE_ANONYMOUS_USERS": "false",
        "ENABLE_PHONE_SIGNUP": "false", "ENABLE_PHONE_AUTOCONFIRM": "false",
        "SMTP_ADMIN_EMAIL": "", "SMTP_HOST": "", "SMTP_PORT": "587",
        "SMTP_USER": "", "SMTP_PASS": "", "SMTP_SENDER_NAME": "Бронь Сервис",
        "OPENAI_API_KEY": "", "GOOGLE_PROJECT_ID": "", "GOOGLE_PROJECT_NUMBER": "",
        "GLOBAL_S3_BUCKET": "bron-franchise", "REGION": "local",
        "MINIO_ROOT_USER": "bron-storage", "STORAGE_TENANT_ID": "bron-franchise",
        "FUNCTIONS_VERIFY_JWT": "true", "PGRST_DB_SCHEMAS": "public",
        "PROXY_DOMAIN": "api.bronservis.ru", "CERTBOT_EMAIL": "",
    })
    return values


def dotenv_value(value):
    if not isinstance(value, str) or any(char in value for char in "\r\n\0$"):
        raise TargetEnvError("UNSAFE_ENV_VALUE")
    return value if re.fullmatch(r"[A-Za-z0-9_./:+,=\-]*", value) else json.dumps(value, ensure_ascii=False)


def render_env(template, values):
    seen = set()
    lines = []
    for line in template.splitlines():
        match = re.match(r"^([A-Z][A-Z0-9_]*)=", line)
        if match:
            name = match.group(1)
            if name in seen:
                raise TargetEnvError("DUPLICATE_TEMPLATE_VARIABLE")
            seen.add(name)
            if name in values:
                line = name + "=" + dotenv_value(values[name])
        lines.append(line)
    if not set(values).issubset(seen):
        raise TargetEnvError("TEMPLATE_VARIABLE_MISSING")
    return ("# Private target configuration. Legacy HS256; isolated restore only.\n"
            "# SMTP delivery, backups/recovery and production release remain pending.\n" +
            "\n".join(lines) + "\n")


def validate_model(model, values):
    try:
        services = model["services"]
        db = services["db"]
        if db["image"] != EXPECTED_IMAGE:
            raise TargetEnvError("RESTORE_IMAGE_MISMATCH")
        ports = [(name, port) for name, service in services.items()
                 for port in service.get("ports", [])]
        if len(ports) != 1 or ports[0][0] != "db":
            raise TargetEnvError("UNEXPECTED_PUBLISHED_PORT")
        port = ports[0][1]
        if (port.get("host_ip") != "127.0.0.1" or str(port.get("published")) != "15433"
                or str(port.get("target")) != "5432" or port.get("protocol", "tcp") != "tcp"):
            raise TargetEnvError("UNSAFE_RESTORE_DB_PORT")
        if (not model["networks"] or any(network.get("internal") is not True or network.get("external")
                                         for network in model["networks"].values())):
            raise TargetEnvError("RESTORE_NETWORK_NOT_INTERNAL")
        if any(service.get("network_mode") for service in services.values()):
            raise TargetEnvError("RESTORE_NETWORK_MODE_FORBIDDEN")
        command = db["command"]
        expected_command = ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf",
                            "-c", "log_min_messages=fatal", "-c", "cron.launch_active_jobs=off",
                            "-c", "pg_net.batch_size=0"]
        if command != expected_command:
            raise TargetEnvError("RESTORE_JOB_FREEZE_MISSING")
        auth = services["auth"]["environment"]
        gateway = services["api-gw"]["environment"]
        if (auth.get("GOTRUE_DISABLE_SIGNUP") != "true"
                or auth.get("GOTRUE_EXTERNAL_EMAIL_ENABLED") != "true"
                or auth.get("GOTRUE_SITE_URL") != values["SITE_URL"]
                or auth.get("API_EXTERNAL_URL") != values["API_EXTERNAL_URL"]):
            raise TargetEnvError("AUTH_CONFIGURATION_MISMATCH")
        if (any(values[name] for name in MODERN_FIELDS)
                or any(gateway.get(name) for name in MODERN_FIELDS if name in gateway)
                or auth.get("GOTRUE_JWT_KEYS")
                or services["rest"]["environment"].get("PGRST_JWT_SECRET") != values["JWT_SECRET"]):
            raise TargetEnvError("LEGACY_KEY_MODE_MISMATCH")
        if (auth.get("GOTRUE_JWT_SECRET") != values["JWT_SECRET"]
                or gateway.get("ANON_KEY") != values["ANON_KEY"]
                or gateway.get("SERVICE_ROLE_KEY") != values["SERVICE_ROLE_KEY"]
                or services["storage"]["environment"].get("AUTH_JWT_SECRET") != values["JWT_SECRET"]
                or services["realtime"]["environment"].get("API_JWT_SECRET") != values["JWT_SECRET"]
                or services["functions"]["environment"].get("JWT_SECRET") != values["JWT_SECRET"]):
            raise TargetEnvError("LEGACY_SIGNING_KEY_MISMATCH")
        if any(service["environment"].get(name) for service, name in (
                (services["realtime"], "API_JWT_JWKS"),
                (services["storage"], "JWT_JWKS"),
                (services["functions"], "SUPABASE_JWKS"))):
            raise TargetEnvError("UNREVIEWED_ASYMMETRIC_WIRING")
    except (KeyError, TypeError, AttributeError):
        raise TargetEnvError("COMPOSE_MODEL_UNEXPECTED") from None


def validate_compose(path, values):
    args = DOCKER + ["compose", "--project-directory", str(WORKDIR),
            "--env-file", str(path), "-f", str(WORKDIR / "docker-compose.yml"),
            "-f", str(WORKDIR / "bron/compose.override.yml"),
            "-f", str(WORKDIR / "bron/compose.restore.override.yml"), "config"]
    capture(args + ["--quiet"])
    # Rendered secrets stay in this root process's memory; never print/save JSON.
    try:
        model = json.loads(capture(args + ["--format", "json"]))
    except (ValueError, UnicodeError):
        raise TargetEnvError("COMPOSE_MODEL_INVALID_JSON") from None
    validate_model(model, values)


def write_env_once(text, values, validator=validate_compose):
    if os.path.lexists(ENV_FILE):
        raise TargetEnvError("ENV_ALREADY_EXISTS_REVIEW_WITHOUT_OVERWRITING")
    fd, temporary = tempfile.mkstemp(prefix=".bron-env-", suffix=".tmp", dir=WORKDIR)
    temporary = Path(temporary)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(text.encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        validator(temporary, values)
        # Same directory: atomic no-replace commit; existing files/symlinks win.
        try:
            os.link(temporary, ENV_FILE, follow_symlinks=False)
        except FileExistsError:
            raise TargetEnvError("ENV_APPEARED_DURING_PREPARATION") from None
        directory = os.open(WORKDIR, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise TargetEnvError("USE_CHECK_OR_PREPARE_EXPLICITLY")
    parser = Parser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    template = preflight()
    if args.check:
        print("Target environment preflight passed. No secrets generated or services started.")
        return
    os.umask(0o077)
    values = fresh_values()
    write_env_once(render_env(template, values), values)
    print("Private target .env created: legacy HS256, restore isolation retained.")
    print("SMTP configuration and production release remain pending.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("STOP: CANCELLED", file=sys.stderr)
        sys.exit(130)
    except TargetEnvError as error:
        code = str(error)
        print("STOP: " + (code if re.fullmatch(r"[A-Z0-9_]+", code)
                          else "TARGET_ENV_PREPARATION_FAILED"), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError):
        # Never interpolate arbitrary exceptions, subprocess output or secrets.
        print("STOP: TARGET_ENV_PREPARATION_FAILED; review the failed phase privately.", file=sys.stderr)
        sys.exit(1)
