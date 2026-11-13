"""No Telegram connection or real credentials; check delivery and secret handling."""
import importlib.util
import io
import json
import os
from pathlib import Path
import ssl
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import urllib.error

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/timeweb/backup-alert-telegram.py'
SPEC = importlib.util.spec_from_file_location('backup_alert_telegram', SCRIPT)
alert = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(alert)
TOKEN = '123456789:' + 'synthetic_token_only_' * 2
CHAT_ID = '123456789'


class TelegramAlertTests(unittest.TestCase):
    def invoke(self, response=None, error=None):
        opener = mock.MagicMock()
        context = opener.open.return_value.__enter__.return_value = mock.Mock()
        context.getcode.return_value = 200
        context.read.return_value = json.dumps(response or {'ok': True,
            'result': {'chat': {'id': int(CHAT_ID)}}}).encode()
        if error:
            opener.open.side_effect = error
        output = io.StringIO()
        with mock.patch.object(alert.sys, 'argv', ['backup-alert', alert.EVENT]), \
             mock.patch.object(alert, 'read_config', return_value=(TOKEN, CHAT_ID)), \
             mock.patch.object(alert.urllib.request, 'build_opener', return_value=opener) as build, \
             mock.patch('sys.stdout', output):
            code = alert.main()
        self.assertNotIn(TOKEN, output.getvalue())
        self.assertNotIn('https://', output.getvalue())
        return code, output.getvalue(), opener, build

    def test_success_is_plaintext_to_pinned_recipient_with_tls_no_proxy_and_timeout(self):
        code, output, opener, build = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(output, 'TELEGRAM_ALERT_ACCEPTED\n')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.telegram.org/bot' + TOKEN + '/sendMessage')
        self.assertEqual(opener.open.call_args.kwargs['timeout'], 15)
        body = json.loads(request.data)
        self.assertEqual(body['chat_id'], CHAT_ID)
        self.assertEqual(set(body), {'chat_id', 'text'})
        self.assertNotIn(TOKEN, body['text'])
        self.assertNotIn(CHAT_ID, body['text'])
        self.assertNotIn('https://', body['text'])
        self.assertIn('UTC', body['text'])
        proxy, https, redirect = build.call_args.args
        self.assertEqual(proxy.proxies, {})
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        self.assertIsInstance(redirect, alert.NoRedirect)

    def test_api_rejection_and_wrong_recipient_fail_without_response_content(self):
        for response in ({'ok': False, 'description': TOKEN},
                         {'ok': True, 'result': {'chat': {'id': 999}}}):
            with self.subTest(response_type=response['ok']):
                code, output, _, _ = self.invoke(response=response)
                self.assertEqual(code, 1)
                self.assertNotIn('999', output)

    def test_exception_with_secret_url_never_leaks(self):
        error = urllib.error.URLError('https://api.telegram.org/bot' + TOKEN + '/sendMessage')
        code, output, _, _ = self.invoke(error=error)
        self.assertEqual(code, 1)
        self.assertEqual(output, 'TELEGRAM_ALERT_FAILED\n')

    def test_response_is_bounded_before_parsing(self):
        code, output, opener, _ = self.invoke(response={'ok': True, 'extra': 'x' * alert.MAX_BYTES})
        self.assertEqual(code, 1)
        self.assertEqual(output, 'TELEGRAM_RESPONSE_TOO_LARGE\n')
        opener.open.return_value.__enter__.return_value.read.assert_called_once_with(alert.MAX_BYTES + 1)

    def test_redirect_is_refused_before_following_private_url(self):
        with self.assertRaisesRegex(alert.AlertError, 'REDIRECT_REFUSED'):
            alert.NoRedirect().redirect_request(None, None, 302, 'redirect', {},
                'https://untrusted.invalid/' + TOKEN)

    def test_config_requires_root_owner_and_exact_private_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'telegram-alert.json'
            config.write_text(json.dumps({'token': TOKEN, 'chat_id': CHAT_ID}))
            for uid, mode in ((1000, 0o600), (0, 0o640), (0, 0o600)):
                with self.subTest(uid=uid, mode=mode), \
                     mock.patch.object(alert.os, 'geteuid', return_value=0), \
                     mock.patch.object(alert.Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o700)), \
                     mock.patch.object(alert.os, 'fstat', return_value=SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | mode)):
                    if uid == 0 and mode == 0o600:
                        self.assertEqual(alert.read_config(config), (TOKEN, CHAT_ID))
                    else:
                        with self.assertRaisesRegex(alert.AlertError, 'PRIVATE_CONFIG_REQUIRED'):
                            alert.read_config(config)
            with mock.patch.object(alert.os, 'geteuid', return_value=0), \
                 mock.patch.object(alert.Path, 'lstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o750)), \
                 mock.patch.object(alert.os, 'open') as open_file:
                with self.assertRaisesRegex(alert.AlertError, 'PRIVATE_DIRECTORY_REQUIRED'):
                    alert.read_config(config)
                open_file.assert_not_called()

    def test_unknown_event_is_rejected_before_reading_config_or_network(self):
        with mock.patch.object(alert.sys, 'argv', ['backup-alert', 'untrusted input']), \
             mock.patch.object(alert, 'read_config') as config, mock.patch('sys.stdout', io.StringIO()):
            self.assertEqual(alert.main(), 1)
        config.assert_not_called()


if __name__ == '__main__':
    unittest.main()
