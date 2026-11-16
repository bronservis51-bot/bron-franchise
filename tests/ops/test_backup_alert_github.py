"""Fixed relay contract and credential handling; no real GitHub calls."""
import importlib.util
import io
import json
from pathlib import Path
import ssl
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/timeweb/backup-alert-github.py'
SPEC = importlib.util.spec_from_file_location('backup_alert_github', SCRIPT)
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)
TOKEN = 'github_pat_' + 'synthetic_only_' * 4


class GitHubRelayTests(unittest.TestCase):
    def call(self, status=204, body=b'', error=None):
        opener = mock.MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.getcode.return_value = status
        response.read.return_value = body
        if error:
            opener.open.side_effect = error
        output = io.StringIO()
        with mock.patch.object(relay.sys, 'argv', ['backup-alert', relay.EVENT]), \
             mock.patch.object(relay, 'read_config', return_value=(TOKEN, 'main')), \
             mock.patch.object(relay.urllib.request, 'build_opener', return_value=opener) as build, \
             mock.patch('sys.stdout', output):
            code = relay.main()
        self.assertNotIn(TOKEN, output.getvalue())
        return code, output.getvalue(), opener, build

    def test_fixed_dispatch_has_no_event_data_and_acceptance_means_only_queued(self):
        code, output, opener, build = self.call()
        self.assertEqual(code, 0)
        self.assertEqual(output, 'GITHUB_ALERT_DISPATCH_ACCEPTED\n')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, relay.ENDPOINT)
        self.assertEqual(json.loads(request.data), {'ref': 'main'})
        self.assertEqual(request.get_header('Authorization'), 'Bearer ' + TOKEN)
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 15)
        proxy, https, redirect = build.call_args.args
        self.assertEqual(proxy.proxies, {})
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertIsInstance(redirect, relay.NoRedirect)

    def test_unexpected_status_or_large_response_is_not_success(self):
        for status, body in ((200, b'{}'), (204, b'x' * (relay.LIMIT + 1))):
            with self.subTest(status=status, size=len(body)):
                code, _, _, _ = self.call(status, body)
                self.assertEqual(code, 1)

    def test_exception_never_exposes_token_or_private_details(self):
        code, output, _, _ = self.call(error=RuntimeError(TOKEN))
        self.assertEqual(code, 1)
        self.assertEqual(output, 'GITHUB_ALERT_DISPATCH_FAILED\n')

    def test_redirect_is_refused(self):
        with self.assertRaisesRegex(relay.RelayError, 'REDIRECT_REFUSED'):
            relay.NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://elsewhere.invalid')

    def test_config_requires_root_private_permissions_fine_grained_token_and_fixed_ref(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'config.json'
            for token, ref, mode, valid in ((TOKEN, 'main', 0o600, True),
                    (TOKEN, 'unapproved', 0o600, False), ('ghp_' + 'a' * 40, 'main', 0o600, False),
                    (TOKEN, 'main', 0o640, False)):
                path.write_text(json.dumps({'token': token, 'ref': ref}))
                with self.subTest(ref=ref, mode=mode), \
                     mock.patch.object(relay.os, 'geteuid', return_value=0), \
                     mock.patch.object(relay.Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o700)), \
                     mock.patch.object(relay.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | mode)):
                    if valid:
                        self.assertEqual(relay.read_config(path), (TOKEN, ref))
                    else:
                        with self.assertRaises(relay.RelayError):
                            relay.read_config(path)

    def test_other_event_never_reads_credentials(self):
        with mock.patch.object(relay.sys, 'argv', ['backup-alert', 'unexpected']), \
             mock.patch.object(relay, 'read_config') as config, mock.patch('sys.stdout', io.StringIO()):
            self.assertEqual(relay.main(), 1)
        config.assert_not_called()


if __name__ == '__main__':
    unittest.main()
