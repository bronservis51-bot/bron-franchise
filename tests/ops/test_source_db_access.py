"""Offline security regressions for the optional owned-server SSH transport."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "deploy/timeweb/source-db-access.py"
SPEC = importlib.util.spec_from_file_location("bron_source_access", SCRIPT)
access = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(access)


def credential_file(text):
    path = mock.Mock()
    path.exists.return_value = True
    path.is_symlink.return_value = False
    path.stat.return_value = SimpleNamespace(st_uid=0, st_mode=0o100600)
    path.read_text.return_value = text
    return path


class SourceTransportTests(unittest.TestCase):
    def test_direct_route_remains_the_default(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            route = access.source_transport()
        self.assertEqual((route["socket_host"], route["port"], route["hostaddr"]),
                         (access.SOURCE_HOST, 5432, None))

    def test_only_reviewed_loopback_port_can_be_selected(self):
        for value in ("", "5432", "15433", "127.0.0.1:15432", " 15432", "0"):
            with self.subTest(value=value), mock.patch.dict(
                    os.environ, {"BRON_SOURCE_TUNNEL_PORT": value}, clear=True):
                with self.assertRaises(RuntimeError):
                    access.source_transport()

    def test_loopback_probe_keeps_canonical_tls_identity(self):
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        connection.recv.return_value = b"S"
        tls_context = mock.Mock()
        tls_context.wrap_socket.return_value = mock.MagicMock()
        secure = tls_context.wrap_socket.return_value.__enter__.return_value
        secure.version.return_value = "TLSv1.3"
        ca = mock.MagicMock()
        ca.is_file.return_value = True
        ca.is_symlink.return_value = False
        ca.__str__.return_value = "/test/source-ca.pem"

        def command(args, **_kwargs):
            if args[:1] == ["ip"]:
                return "2: eth0 inet 152.228.115.115/24 scope global eth0"
            if args[:2] == ["systemctl", "is-active"]:
                return "active"
            if args[:1] == ["pg_dump"]:
                return "pg_dump (PostgreSQL) 17.11"
            if args[:1] == ["supabase"]:
                return "3.1.0"
            if args == ["uname", "-r"]:
                return "offline-kernel"
            return ""

        with mock.patch.dict(os.environ, {"BRON_SOURCE_TUNNEL_PORT": "15432"}, clear=True), \
             mock.patch.object(access.os, "geteuid", return_value=0), \
             mock.patch.object(access.Path, "exists", return_value=False), \
             mock.patch.object(access, "SOURCE_CA", ca), \
             mock.patch.object(access, "run", side_effect=command), \
             mock.patch.object(access, "private_directory"), \
             mock.patch.object(access.ssl, "create_default_context", return_value=tls_context) as create_tls, \
             mock.patch.object(access.socket, "create_connection", return_value=connection) as connect, \
             mock.patch.object(access.signal, "signal"), \
             mock.patch.object(access.signal, "alarm"), \
             contextlib.redirect_stdout(io.StringIO()):
            access.preflight()
        connect.assert_called_once_with(("127.0.0.1", 15432), timeout=10)
        create_tls.assert_called_once_with(cafile="/test/source-ca.pem")
        tls_context.wrap_socket.assert_called_once_with(
            connection, server_hostname=access.SOURCE_HOST)

    def test_changed_transport_refuses_before_prompt_write_or_query(self):
        direct = {"socket_host": access.SOURCE_HOST, "port": 5432, "hostaddr": None}
        service = credential_file(access.source_service(direct))
        password = credential_file(access.password_prefix(direct) + "offline-fixture\n")
        with mock.patch.dict(os.environ, {"BRON_SOURCE_TUNNEL_PORT": "15432"}, clear=True), \
             mock.patch.object(access, "SERVICE_FILE", service), \
             mock.patch.object(access, "PASSWORD_FILE", password), \
             mock.patch.object(access.getpass, "getpass") as prompt, \
             mock.patch.object(access, "write_private") as write, \
             mock.patch.object(access, "run") as query:
            with self.assertRaisesRegex(RuntimeError, "different or unsafe transport"):
                access.connect()
        prompt.assert_not_called()
        write.assert_not_called()
        query.assert_not_called()
        service.unlink.assert_not_called()
        password.unlink.assert_not_called()

    def test_existing_tls_or_password_port_mismatch_is_not_reused(self):
        route = {"socket_host": "127.0.0.1", "port": 15432, "hostaddr": "127.0.0.1"}
        cases = [
            (access.source_service(route).replace("sslmode=verify-full", "sslmode=require"),
             access.password_prefix(route) + "offline-fixture\n"),
            (access.source_service(route),
             access.password_prefix(route).replace(":15432:", ":5432:") + "offline-fixture\n"),
        ]
        for service_text, password_text in cases:
            with self.subTest(service=service_text), \
                 mock.patch.object(access, "SERVICE_FILE", credential_file(service_text)), \
                 mock.patch.object(access, "PASSWORD_FILE", credential_file(password_text)):
                with self.assertRaises(RuntimeError):
                    access.validate_existing_credentials(route)

    def test_verified_service_uses_loopback_but_password_and_tls_use_hostname(self):
        route = {"socket_host": "127.0.0.1", "port": 15432, "hostaddr": "127.0.0.1"}
        text = access.source_service(route)
        self.assertIn(f"host={access.SOURCE_HOST}\nhostaddr=127.0.0.1\nport=15432\n", text)
        self.assertIn("sslmode=verify-full\n", text)
        service = credential_file(text)
        password = credential_file(access.password_prefix(route) + "offline-fixture\n")
        with mock.patch.dict(os.environ, {"BRON_SOURCE_TUNNEL_PORT": "15432",
                                         "PGHOST": "untrusted.example",
                                         "PGSSLMODE": "disable"}, clear=True), \
             mock.patch.object(access, "SERVICE_FILE", service), \
             mock.patch.object(access, "PASSWORD_FILE", password), \
             mock.patch.object(access, "run", return_value=json.dumps(
                 {"server_version": "17.11", "server_version_num": 170011,
                  "read_only": "on", "default_read_only": "on"})) as query, \
             contextlib.redirect_stdout(io.StringIO()):
            access.connect()
        env = query.call_args.kwargs["env"]
        self.assertNotIn("PGHOST", env)
        self.assertNotIn("PGSSLMODE", env)
        self.assertNotIn("PGPASSWORD", env)
        self.assertIn("default_transaction_read_only=on", env["PGOPTIONS"])


class SourceReadOnlyTests(unittest.TestCase):
    def connect_with_result(self, result):
        route = {"socket_host": access.SOURCE_HOST, "port": 5432, "hostaddr": None}
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(access, "SERVICE_FILE", credential_file(access.source_service(route))), \
             mock.patch.object(access, "PASSWORD_FILE", credential_file(
                 access.password_prefix(route) + "offline-fixture\n")), \
             mock.patch.object(access.getpass, "getpass") as prompt, \
             mock.patch.object(access, "write_private") as write, \
             mock.patch.object(access, "run", return_value=json.dumps(result)) as command, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            access.connect()
        prompt.assert_not_called()
        write.assert_not_called()
        return command.call_args.args[0], output.getvalue()

    def test_pooler_session_default_off_accepts_explicit_read_only_transaction(self):
        args, output = self.connect_with_result({
            "server_version": "17.11", "server_version_num": 170011,
            "read_only": "on", "default_read_only": "off",
            "auth_users": 16, "identities": 16, "buckets": 1, "objects": 0,
        })
        self.assertIn("-q", args)  # BEGIN/ROLLBACK tags must not corrupt JSON.
        sql = args[args.index("--command") + 1]
        self.assertTrue(sql.startswith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"))
        self.assertIn("current_setting('transaction_read_only')", sql)
        self.assertTrue(sql.rstrip().endswith("ROLLBACK;"))
        self.assertIn('"default_read_only": "off"', output)
        self.assertIn("Read-only source connection verified", output)

    def test_actual_transaction_read_write_is_rejected_even_if_default_is_on(self):
        with self.assertRaises(RuntimeError) as failure:
            self.connect_with_result({
                "server_version": "17.11", "server_version_num": 170011,
                "read_only": "off", "default_read_only": "on",
                "unexpected_private_field": "do-not-expose",
            })
        diagnostic = str(failure.exception)
        self.assertIn('"read_only": "off"', diagnostic)
        self.assertIn('"default_read_only": "on"', diagnostic)
        self.assertIn('"server_version_num": 170011', diagnostic)
        self.assertNotIn("do-not-expose", diagnostic)

    def test_numeric_major_version_is_required_instead_of_display_prefix(self):
        for number in (160011, 180000, "170011", None):
            with self.subTest(number=number), self.assertRaises(RuntimeError):
                self.connect_with_result({
                    "server_version": "17.11", "server_version_num": number,
                    "read_only": "on", "default_read_only": "off",
                })


class SourceCommandLineTests(unittest.TestCase):
    def test_explicit_tunnel_flag_selects_only_reviewed_loopback_for_both_modes(self):
        for mode in ("--check", "--connect"):
            with self.subTest(mode=mode), \
                 mock.patch.dict(os.environ, {}, clear=True), \
                 mock.patch.object(access.sys, "argv", [str(SCRIPT), "--tunnel", mode]), \
                 mock.patch.object(access, "preflight", side_effect=access.source_transport) as preflight, \
                 mock.patch.object(access, "connect", side_effect=access.source_transport) as connect, \
                 mock.patch.object(access.os, "umask"):
                access.main()
                self.assertEqual(access.source_transport(), {
                    "socket_host": "127.0.0.1", "port": 15432, "hostaddr": "127.0.0.1",
                })
                preflight.assert_called_once_with()
                self.assertEqual(connect.call_count, int(mode == "--connect"))

    def test_tunnel_flag_refuses_conflicting_environment_before_any_probe(self):
        for value in ("", "5432", "15433", "127.0.0.1:15432"):
            with self.subTest(value=value), \
                 mock.patch.dict(os.environ, {"BRON_SOURCE_TUNNEL_PORT": value}, clear=True), \
                 mock.patch.object(access.sys, "argv", [str(SCRIPT), "--tunnel", "--check"]), \
                 mock.patch.object(access, "preflight") as preflight, \
                 mock.patch.object(access, "connect") as connect:
                with self.assertRaisesRegex(RuntimeError, "conflicts"):
                    access.main()
                self.assertEqual(os.environ["BRON_SOURCE_TUNNEL_PORT"], value)
                preflight.assert_not_called()
                connect.assert_not_called()

    def test_cli_remains_direct_without_tunnel_opt_in(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(access.sys, "argv", [str(SCRIPT), "--check"]), \
             mock.patch.object(access, "preflight", side_effect=access.source_transport), \
             mock.patch.object(access, "connect") as connect, \
             mock.patch.object(access.os, "umask"):
            access.main()
            self.assertEqual(access.source_transport()["socket_host"], access.SOURCE_HOST)
            self.assertNotIn("BRON_SOURCE_TUNNEL_PORT", os.environ)
            connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
