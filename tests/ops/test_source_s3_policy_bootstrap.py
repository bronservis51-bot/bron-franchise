"""Offline IAM bootstrap tests: no SDK/network or real credentials are used."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.parse import quote

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/timeweb/source-s3-policy-bootstrap.py"
SPEC = importlib.util.spec_from_file_location("bron_policy_bootstrap", SCRIPT)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)
TEXT = (SCRIPT.parent / "backup-uploader-policy.json").read_text()
POLICY = json.loads(TEXT)


class BootstrapTests(unittest.TestCase):
    def apply(self, client, tty=True):
        swaps = mock.Mock()
        swaps.read_text.return_value = "Filename Type Size Used Priority\n"
        with mock.patch.object(bootstrap.sys.stdin, "isatty", return_value=tty), \
             mock.patch.object(bootstrap, "Path", return_value=swaps), \
             mock.patch.object(bootstrap.resource, "setrlimit"), \
             mock.patch.object(bootstrap.logging, "disable"), \
             mock.patch.object(bootstrap, "private_prompt", side_effect=["synthetic-access", "synthetic-secret"]), \
             mock.patch.object(bootstrap, "iam_client", return_value=client) as create:
            result = bootstrap.apply_policy(TEXT, POLICY)
        create.assert_called_once_with("synthetic-access", "synthetic-secret")
        return result

    def test_default_is_offline_and_never_prompts_or_creates_client(self):
        with mock.patch.object(bootstrap.sys, "argv", [str(SCRIPT)]), \
             mock.patch.object(bootstrap, "runtime_guard"), \
             mock.patch.object(bootstrap, "reviewed_policy", return_value=(TEXT, POLICY)), \
             mock.patch.object(bootstrap, "sdk_available", return_value=True), \
             mock.patch.object(bootstrap, "iam_client") as client, \
             mock.patch.object(bootstrap, "private_prompt") as prompt, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(bootstrap.main(), 0)
        client.assert_not_called(); prompt.assert_not_called()
        self.assertFalse(json.loads(output.getvalue())["network_used"])

    def test_apply_requires_explicit_exact_user_before_any_guard_or_prompt(self):
        for args in (["--apply-reviewed-policy"], ["--apply-reviewed-policy", "--user", "other-user"]):
            with self.subTest(args=args), mock.patch.object(bootstrap.sys, "argv", [str(SCRIPT), *args]), \
                 mock.patch.object(bootstrap, "runtime_guard") as guard:
                with self.assertRaisesRegex(bootstrap.BootstrapError, "EXPLICIT_REVIEWED_USERNAME_REQUIRED"):
                    bootstrap.main()
                guard.assert_not_called()

    def test_nonroot_wrong_host_and_production_are_refused(self):
        with mock.patch.object(bootstrap.os, "geteuid", return_value=1000):
            with self.assertRaisesRegex(bootstrap.BootstrapError, "REQUIRES_RUSSIAN_VPS_ROOT"):
                bootstrap.runtime_guard()
        marker = mock.Mock(); marker.exists.return_value = True
        with mock.patch.object(bootstrap.os, "geteuid", return_value=0), mock.patch.object(bootstrap, "Path", return_value=marker):
            with self.assertRaisesRegex(bootstrap.BootstrapError, "PRODUCTION_ENABLED"):
                bootstrap.runtime_guard()
        marker.exists.return_value = False
        with mock.patch.object(bootstrap.os, "geteuid", return_value=0), \
             mock.patch.object(bootstrap, "Path", return_value=marker), \
             mock.patch.object(bootstrap.subprocess, "run", return_value=SimpleNamespace(stdout="")):
            with self.assertRaisesRegex(bootstrap.BootstrapError, "WRONG_VPS"):
                bootstrap.runtime_guard()

    def test_policy_hash_owner_mode_and_no_follow_guard(self):
        for uid, mode, data, success in [(0, 0o100600, TEXT.encode(), True), (0, 0o100644, TEXT.encode(), True),
                                        (1000, 0o100600, TEXT.encode(), False), (0, 0o100666, TEXT.encode(), False),
                                        (0, 0o100600, b"changed policy", False)]:
            with self.subTest(uid=uid, mode=mode), \
                 mock.patch.object(bootstrap.os, "open", return_value=99) as opened, \
                 mock.patch.object(bootstrap.os, "fstat", return_value=SimpleNamespace(st_uid=uid, st_mode=mode)), \
                 mock.patch.object(bootstrap.os, "read", return_value=data), \
                 mock.patch.object(bootstrap.os, "close"):
                if success: self.assertEqual(bootstrap.reviewed_policy(), (TEXT, POLICY))
                else:
                    with self.assertRaises(bootstrap.BootstrapError): bootstrap.reviewed_policy()
                self.assertTrue(opened.call_args.args[1] & bootstrap.os.O_NOFOLLOW)

    def test_no_tty_never_requests_credentials(self):
        with mock.patch.object(bootstrap.sys.stdin, "isatty", return_value=False), \
             mock.patch.object(bootstrap, "private_prompt") as prompt:
            with self.assertRaisesRegex(bootstrap.BootstrapError, "INTERACTIVE_TTY_REQUIRED"):
                bootstrap.apply_policy(TEXT, POLICY)
        prompt.assert_not_called()

    def test_sdk_uses_only_explicit_ram_credentials_and_fixed_verified_endpoint(self):
        sdk = mock.Mock(); config = mock.Mock()
        client = sdk.Session.return_value.client.return_value
        with mock.patch.dict(bootstrap.sys.modules, {"boto3": sdk,
                "botocore": mock.Mock(), "botocore.config": SimpleNamespace(Config=config)}), \
             mock.patch.dict(bootstrap.os.environ, {"AWS_ACCESS_KEY_ID": "ambient-must-not-be-used",
                                                   "AWS_PROFILE": "wrong"}, clear=True):
            self.assertIs(bootstrap.iam_client("synthetic-access", "synthetic-secret"), client)
            self.assertNotIn("synthetic-access", bootstrap.os.environ.values())
            self.assertNotIn("synthetic-secret", bootstrap.os.environ.values())
            self.assertNotIn("AWS_ACCESS_KEY_ID", bootstrap.os.environ)
        sdk.Session.assert_called_once_with(aws_access_key_id="synthetic-access",
            aws_secret_access_key="synthetic-secret", region_name="ru-1")
        options = sdk.Session.return_value.client.call_args
        self.assertEqual(options.args, ("iam",))
        self.assertEqual(options.kwargs["endpoint_url"], bootstrap.ENDPOINT)
        self.assertIs(options.kwargs["verify"], True)
        self.assertEqual(config.call_args.kwargs["retries"]["total_max_attempts"], 1)
        self.assertEqual(config.call_args.kwargs["proxies"], {})
        client.meta.events.register_first.assert_any_call("before-send.iam", bootstrap.guard_request)

    def test_active_swap_refuses_before_prompting_for_an_owner_key(self):
        swaps = mock.Mock(); swaps.read_text.return_value = "Filename Type Size Used Priority\n/swap file 1 0 -2\n"
        with mock.patch.object(bootstrap.sys.stdin, "isatty", return_value=True), \
             mock.patch.object(bootstrap, "Path", return_value=swaps), \
             mock.patch.object(bootstrap.resource, "setrlimit"), \
             mock.patch.object(bootstrap, "private_prompt") as prompt:
            with self.assertRaisesRegex(bootstrap.BootstrapError, "ACTIVE_SWAP_REVIEW_REQUIRED"):
                bootstrap.apply_policy(TEXT, POLICY)
        prompt.assert_not_called()

    def test_exact_put_and_verified_native_or_encoded_readback(self):
        for document in (POLICY, quote(TEXT, safe="")):
            client = mock.Mock()
            client.get_user_policy.return_value = {"PolicyDocument": document}
            result = self.apply(client)
            self.assertEqual(result["policy_readback"], "verified")
            self.assertFalse(result["credentials_persisted"])
            self.assertFalse(result["backup_access_verified"])
            client.put_user_policy.assert_called_once_with(UserName=bootstrap.USERNAME,
                PolicyName=bootstrap.POLICY_NAME, PolicyDocument=TEXT)
            client.close.assert_called_once()

    def test_unsupported_readback_is_pending_not_full_success(self):
        client = mock.Mock(); client.get_user_policy.side_effect = RuntimeError("sensitive-server-text")
        result = self.apply(client)
        self.assertTrue(result["policy_put_acknowledged"])
        self.assertEqual(result["policy_readback"], "pending_unsupported_or_failed")
        self.assertNotIn("sensitive", json.dumps(result))

    def test_put_exception_never_exposes_credentials_or_sdk_message(self):
        client = mock.Mock(); client.put_user_policy.side_effect = RuntimeError("synthetic-secret PRIVATE")
        with self.assertRaisesRegex(bootstrap.BootstrapError, "^IAM_PUT_FAILED_OR_RESULT_UNKNOWN$"):
            self.apply(client)
        client.get_user_policy.assert_not_called(); client.close.assert_called_once()

    def test_redirect_or_different_endpoint_is_refused(self):
        bootstrap.guard_request(SimpleNamespace(url=bootstrap.ENDPOINT + "/"))
        for url in ("http://s3.twcstorage.ru/", "https://wrong.invalid/", "https://s3.twcstorage.ru:444/",
                    "https://s3.twcstorage.ru/private/path", "https://key@s3.twcstorage.ru/"):
            with self.subTest(url=url), self.assertRaises(bootstrap.BootstrapError):
                bootstrap.guard_request(SimpleNamespace(url=url))
        with self.assertRaisesRegex(bootstrap.BootstrapError, "IAM_REDIRECT_FORBIDDEN"):
            bootstrap.guard_redirect((SimpleNamespace(status_code=307), {}))


if __name__ == "__main__":
    unittest.main()
