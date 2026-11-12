"""Deterministic public fixtures only; never generate deployment secrets here."""
import base64
import hashlib
import hmac
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
import contextlib

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/timeweb/prepare-target-env.py"
SPEC = importlib.util.spec_from_file_location("bron_target_env", SCRIPT)
target = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(target)


def fixture_values():
    counter = 0

    def public_entropy(size):
        nonlocal counter
        counter += 1
        return bytes([counter]) * size

    with mock.patch.object(target.secrets, "token_bytes", side_effect=AssertionError("real randomness forbidden")):
        return target.fresh_values(entropy=public_entropy, issued_at=2000000000)


def fixture_model(values):
    return {"networks": {"default": {"internal": True}}, "services": {
        "db": {"image": target.EXPECTED_IMAGE,
               "ports": [{"host_ip": "127.0.0.1", "published": "15433", "target": 5432, "protocol": "tcp"}],
               "command": ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf",
                           "-c", "log_min_messages=fatal", "-c", "cron.launch_active_jobs=off",
                           "-c", "pg_net.batch_size=0"]},
        "auth": {"environment": {"GOTRUE_DISABLE_SIGNUP": "true", "GOTRUE_EXTERNAL_EMAIL_ENABLED": "true",
                                  "GOTRUE_SITE_URL": values["SITE_URL"], "API_EXTERNAL_URL": values["API_EXTERNAL_URL"],
                                  "GOTRUE_JWT_SECRET": values["JWT_SECRET"]}},
        "api-gw": {"environment": {"ANON_KEY": values["ANON_KEY"], "SERVICE_ROLE_KEY": values["SERVICE_ROLE_KEY"],
                                    **{name: "" for name in target.MODERN_FIELDS}}},
        "rest": {"environment": {"PGRST_JWT_SECRET": values["JWT_SECRET"]}},
        "storage": {"environment": {"AUTH_JWT_SECRET": values["JWT_SECRET"]}},
        "realtime": {"environment": {"API_JWT_SECRET": values["JWT_SECRET"]}},
        "functions": {"environment": {"JWT_SECRET": values["JWT_SECRET"]}},
        "web": {"profiles": ["publish-only"], "ports": []},
    }}


class LegacyKeyFixtureTests(unittest.TestCase):
    def test_legacy_api_tokens_verify_roles_signatures_and_pinned_lifetime(self):
        values = fixture_values()
        for name, expected_role in (("ANON_KEY", "anon"), ("SERVICE_ROLE_KEY", "service_role")):
            head, body, signature = values[name].split(".")
            decode = lambda value: json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
            self.assertEqual(decode(head), {"alg": "HS256", "typ": "JWT"})
            payload = decode(body)
            self.assertEqual(payload["role"], expected_role)
            self.assertEqual(payload["iss"], "supabase")
            self.assertEqual(payload["iat"], 2000000000)
            self.assertEqual(payload["exp"] - payload["iat"], 5 * 365 * 24 * 3600)
            expected = base64.urlsafe_b64encode(hmac.new(
                values["JWT_SECRET"].encode(), (head + "." + body).encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
            self.assertTrue(hmac.compare_digest(signature, expected))
        self.assertEqual(values["JWT_EXPIRY"], "3600")
        self.assertNotEqual(values["ANON_KEY"], values["SERVICE_ROLE_KEY"])

    def test_source_or_ambient_password_is_not_reused_and_modern_mode_stays_off(self):
        with mock.patch.dict(os.environ, {"PGPASSWORD": "public-source-fixture", "POSTGRES_PASSWORD": "public-source-fixture"}):
            values = fixture_values()
        self.assertNotIn("public-source-fixture", values.values())
        self.assertTrue(all(values[name] == "" for name in target.MODERN_FIELDS))
        self.assertEqual(values["DISABLE_SIGNUP"], "true")
        self.assertEqual(values["ENABLE_EMAIL_SIGNUP"], "true")
        self.assertEqual(values["ENABLE_PHONE_SIGNUP"], "false")
        self.assertEqual(values["SMTP_HOST"], "")
        self.assertEqual(values["SMTP_PASS"], "")
        self.assertEqual(values["SUPABASE_PUBLIC_URL"], "https://api.bronservis.ru")
        self.assertEqual(values["API_EXTERNAL_URL"], "https://api.bronservis.ru/auth/v1")
        self.assertEqual(values["SITE_URL"], "https://app.bronservis.ru")
        self.assertTrue(values["COMPOSE_FILE"].endswith(":bron/compose.restore.override.yml"))
        self.assertEqual(len(values["REALTIME_DB_ENC_KEY"]), 16)
        self.assertEqual(len(values["VAULT_ENC_KEY"]), 32)
        self.assertGreaterEqual(len(values["SECRET_KEY_BASE"]), 64)

    def test_render_requires_exact_known_variables_and_rejects_interpolation(self):
        values = fixture_values()
        template = "# public fixture\n" + "\n".join(name + "=old-public-value" for name in values)
        rendered = target.render_env(template, values)
        self.assertNotIn("old-public-value", rendered)
        self.assertIn("JWT_KEYS=\n", rendered)
        self.assertIn('STUDIO_DEFAULT_ORGANIZATION="Бронь Сервис"', rendered)
        with self.assertRaisesRegex(target.TargetEnvError, "TEMPLATE_VARIABLE_MISSING"):
            target.render_env("JWT_SECRET=fixture\n", values)
        with self.assertRaisesRegex(target.TargetEnvError, "DUPLICATE_TEMPLATE_VARIABLE"):
            target.render_env("A=1\nA=2\n", {})
        for value in ("$INTERPOLATION", "line\nbreak", "nul\0byte"):
            with self.subTest(value=value), self.assertRaises(target.TargetEnvError):
                target.dotenv_value(value)


class RestoreModelTests(unittest.TestCase):
    def test_verified_legacy_restore_model_is_accepted(self):
        values = fixture_values()
        target.validate_model(fixture_model(values), values)

    def test_public_ports_network_egress_or_missing_freeze_are_rejected(self):
        values = fixture_values()
        mutations = [
            lambda m: m["services"]["db"]["ports"][0].update(host_ip="0.0.0.0"),
            lambda m: m["services"]["api-gw"].update(ports=[{"target":8000,"published":"8000"}]),
            lambda m: m["networks"]["default"].update(internal=False),
            lambda m: m["services"]["db"].update(network_mode="host"),
            lambda m: m["services"]["db"].update(command=["postgres"]),
            lambda m: m["services"]["db"].update(image="supabase/postgres:latest"),
        ]
        for mutation in mutations:
            model = fixture_model(values)
            mutation(model)
            with self.subTest(model=model), self.assertRaises(target.TargetEnvError):
                target.validate_model(model, values)

    def test_email_disable_signing_mismatch_or_partial_new_key_wiring_are_rejected(self):
        values = fixture_values()
        mutations = [
            lambda m: m["services"]["auth"]["environment"].update(GOTRUE_EXTERNAL_EMAIL_ENABLED="false"),
            lambda m: m["services"]["auth"]["environment"].update(GOTRUE_DISABLE_SIGNUP="false"),
            lambda m: m["services"]["storage"]["environment"].update(AUTH_JWT_SECRET="wrong-public-fixture"),
            lambda m: m["services"]["api-gw"]["environment"].update(SUPABASE_SECRET_KEY="sb_secret_public-fixture"),
            lambda m: m["services"]["realtime"]["environment"].update(API_JWT_JWKS="[]"),
        ]
        for mutation in mutations:
            model = fixture_model(values)
            mutation(model)
            with self.subTest(model=model), self.assertRaises(target.TargetEnvError):
                target.validate_model(model, values)


class PrivateEnvCommitTests(unittest.TestCase):
    def paths(self, directory):
        return mock.patch.multiple(target, WORKDIR=Path(directory), ENV_FILE=Path(directory) / ".env")

    def test_atomic_commit_is_private_and_validator_runs_before_final_file_exists(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(directory):
            def validate(path, values):
                self.assertFalse(target.ENV_FILE.exists())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(path.read_text(), "PUBLIC_TEST_ONLY=fixture\n")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                target.write_env_once("PUBLIC_TEST_ONLY=fixture\n", {}, validate)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(target.ENV_FILE.read_text(), "PUBLIC_TEST_ONLY=fixture\n")
            self.assertEqual(stat.S_IMODE(target.ENV_FILE.stat().st_mode), 0o600)
            self.assertEqual([p.name for p in Path(directory).iterdir()], [".env"])

    def test_existing_or_dangling_symlink_env_is_never_overwritten(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory() as directory, self.paths(directory):
                if symlink:
                    target.ENV_FILE.symlink_to(Path(directory) / "missing-target")
                else:
                    target.ENV_FILE.write_text("PUBLIC_OLD_FIXTURE=keep\n")
                with mock.patch.object(target.tempfile, "mkstemp") as temporary:
                    with self.assertRaisesRegex(target.TargetEnvError, "ENV_ALREADY_EXISTS"):
                        target.write_env_once("PUBLIC_NEW_FIXTURE=discard\n", {}, mock.Mock())
                temporary.assert_not_called()
                if symlink:
                    self.assertTrue(target.ENV_FILE.is_symlink())
                    self.assertFalse((Path(directory) / "missing-target").exists())
                else:
                    self.assertEqual(target.ENV_FILE.read_text(), "PUBLIC_OLD_FIXTURE=keep\n")

    def test_failed_model_validation_leaves_no_env_or_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(directory):
            validator = mock.Mock(side_effect=target.TargetEnvError("PUBLIC_VALIDATION_FAILURE"))
            with self.assertRaises(target.TargetEnvError):
                target.write_env_once("PUBLIC_TEST_ONLY=fixture\n", {}, validator)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_concurrent_env_creation_wins_without_overwrite(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(directory):
            def concurrent_creation(path, values):
                target.ENV_FILE.write_text("PUBLIC_CONCURRENT_FIXTURE=keep\n")
            with self.assertRaisesRegex(target.TargetEnvError, "ENV_APPEARED"):
                target.write_env_once("PUBLIC_NEW_FIXTURE=discard\n", {}, concurrent_creation)
            self.assertEqual(target.ENV_FILE.read_text(), "PUBLIC_CONCURRENT_FIXTURE=keep\n")
            self.assertEqual([p.name for p in Path(directory).iterdir()], [".env"])


class PreflightRefusalTests(unittest.TestCase):
    def test_compose_validation_uses_local_daemon_even_with_hostile_context(self):
        values = fixture_values()
        responses = [b"", json.dumps(fixture_model(values)).encode()]
        with mock.patch.dict(os.environ, {"DOCKER_HOST": "tcp://192.0.2.1:2375",
                                         "DOCKER_CONTEXT": "unrelated-remote"}), \
             mock.patch.object(target, "capture", side_effect=responses) as invoke:
            target.validate_compose(Path("/private/public-fixture.env"), values)
        for call in invoke.call_args_list:
            self.assertEqual(call.args[0][:3],
                             ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"])
        self.assertNotIn("DOCKER_HOST", target.clean_env())
        self.assertNotIn("DOCKER_CONTEXT", target.clean_env())

    def test_changed_tracked_runtime_bind_file_refuses_before_secret_generation(self):
        directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        def command(args):
            if args[0].endswith("/ip"):
                return b"2: eth0 inet 152.228.115.115/24 scope global eth0\n"
            if "rev-parse" in args:
                return target.UPSTREAM_COMMIT.encode()
            if "diff" in args:
                raise target.TargetEnvError("REQUIRED_COMMAND_FAILED")
            raise AssertionError("Unexpected command")
        with mock.patch.object(target.os, "geteuid", return_value=0), \
             mock.patch.object(target.sys, "platform", "linux"), \
             mock.patch.object(target.os.path, "lexists", return_value=False), \
             mock.patch.object(target.Path, "lstat", return_value=directory), \
             mock.patch.object(target, "capture", side_effect=command), \
             mock.patch.object(target, "fresh_values") as generate, \
             mock.patch.object(target.sys, "argv", [str(SCRIPT), "--prepare"]):
            with self.assertRaisesRegex(target.TargetEnvError, "UPSTREAM_TRACKED_CONFIG_CHANGED"):
                target.main()
        generate.assert_not_called()

    def test_wrong_vps_refuses_before_generating_secrets_or_writing_files(self):
        directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with mock.patch.object(target.os, "geteuid", return_value=0), \
             mock.patch.object(target.sys, "platform", "linux"), \
             mock.patch.object(target.os.path, "lexists", return_value=False), \
             mock.patch.object(target.Path, "lstat", return_value=directory), \
             mock.patch.object(target, "capture", return_value=b"2: eth0 inet 192.0.2.1/24 scope global eth0\n"), \
             mock.patch.object(target, "fresh_values") as generate, \
             mock.patch.object(target, "write_env_once") as write, \
             mock.patch.object(target.sys, "argv", [str(SCRIPT), "--prepare"]):
            with self.assertRaisesRegex(target.TargetEnvError, "WRONG_TARGET_VPS"):
                target.main()
        generate.assert_not_called()
        write.assert_not_called()

    def test_changed_pinned_configuration_refuses_before_secret_generation(self):
        directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        def command(args):
            return (b"2: eth0 inet 152.228.115.115/24 scope global eth0\n" if args[0].endswith("/ip")
                    else target.UPSTREAM_COMMIT.encode())
        with mock.patch.object(target.os, "geteuid", return_value=0), \
             mock.patch.object(target.sys, "platform", "linux"), \
             mock.patch.object(target.os.path, "lexists", return_value=False), \
             mock.patch.object(target.Path, "lstat", return_value=directory), \
             mock.patch.object(target, "capture", side_effect=command), \
             mock.patch.object(target, "public_file", return_value=b"unapproved-public-fixture"), \
             mock.patch.object(target, "fresh_values") as generate, \
             mock.patch.object(target.sys, "argv", [str(SCRIPT), "--prepare"]):
            with self.assertRaisesRegex(target.TargetEnvError, "PINNED_CONFIGURATION_MISMATCH"):
                target.main()
        generate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
