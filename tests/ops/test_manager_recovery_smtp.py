"""Synthetic recipient and transport for the worker’s SMTP boundary."""
import importlib.util
import io
import json
from pathlib import Path
import ssl
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/manager-recovery-smtp.py'
SPEC = importlib.util.spec_from_file_location('manager_recovery_smtp', SCRIPT)
relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(relay)

FROM = 'sender@example.invalid'
TO = 'recipient@example.invalid'
URL = 'https://app.example.invalid/bron/#/recover/confirm/' + 'f' * 64
SMTP = {'host': 'smtp.example.invalid', 'port': 465, 'tls': 'implicit',
        'from': FROM, 'username': 'synthetic-login', 'password': 'synthetic-password'}


class RecoveryMailTests(unittest.TestCase):
    def test_implicit_tls_sends_a_single_plain_email_with_verifying_context(self):
        with mock.patch.object(relay.smtplib, 'SMTP_SSL') as ssl_smtp:
            ssl_smtp.return_value.send_message.return_value = {}
            relay.deliver({'mode': 'send', 'smtp': SMTP, 'email': TO, 'kind': 'confirm', 'link': URL,
                           'login': '+79000001234'})
        self.assertEqual(ssl_smtp.call_args.args, ('smtp.example.invalid', 465))
        context = ssl_smtp.call_args.kwargs['context']
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertGreaterEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
        client = ssl_smtp.return_value
        client.login.assert_called_once_with('synthetic-login', 'synthetic-password')
        message = client.send_message.call_args.args[0]
        self.assertEqual(message.get_content_type(), 'text/plain')
        self.assertEqual(message['From'].addresses[0].addr_spec, FROM)
        self.assertEqual(message['To'].addresses[0].addr_spec, TO)
        self.assertEqual(client.send_message.call_args.kwargs, {'from_addr': FROM, 'to_addrs': [TO]})
        self.assertEqual(message.get_content().count(URL), 1)
        self.assertNotIn('synthetic-password', message.get_content())
        self.assertNotIn('+79000001234', message.get_content())
        client.close.assert_called_once_with()

    def test_reset_contains_the_login_as_text_outside_the_link(self):
        with mock.patch.object(relay.smtplib, 'SMTP_SSL') as ssl_smtp:
            ssl_smtp.return_value.send_message.return_value = {}
            reset_url = URL.replace('/confirm/', '/reset/')
            relay.deliver({'mode': 'send', 'smtp': SMTP, 'email': TO, 'kind': 'reset', 'link': reset_url,
                           'login': '+79000001234'})
        body = ssl_smtp.return_value.send_message.call_args.args[0].get_content()
        self.assertIn('\nЛогин +79000001234\n', body)
        self.assertIn('\n' + reset_url + '\n', body)

    def test_starttls_failure_never_authenticates_in_cleartext(self):
        with mock.patch.object(relay.smtplib, 'SMTP') as smtp:
            smtp.return_value.starttls.side_effect = ssl.SSLError('synthetic relay failure')
            with self.assertRaises(ssl.SSLError):
                relay.deliver({'mode': 'check', 'smtp': {**SMTP, 'tls': 'starttls', 'port': 587}})
            smtp.return_value.login.assert_not_called()
            smtp.return_value.send_message.assert_not_called()
            self.assertTrue(smtp.return_value.starttls.call_args.kwargs['context'].check_hostname)
            smtp.return_value.close.assert_called_once_with()

    def test_health_checks_authenticate_without_sending(self):
        with mock.patch.object(relay.smtplib, 'SMTP') as smtp:
            relay.deliver({'mode': 'check', 'smtp': {**SMTP, 'tls': 'starttls', 'port': 587}})
        client = smtp.return_value
        self.assertEqual([call[0] for call in client.mock_calls], ['starttls', 'login', 'close'])

    def test_response_and_exceptions_cannot_print_private_data(self):
        payload = json.dumps({'mode': 'send', 'smtp': SMTP, 'email': TO, 'kind': 'confirm', 'link': URL})
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(relay.sys, 'stdin', io.StringIO(payload)), mock.patch.object(relay.sys, 'stdout', out), \
                mock.patch.object(relay.sys, 'stderr', err), mock.patch.object(relay.smtplib, 'SMTP_SSL') as smtp:
            smtp.return_value.send_message.side_effect = RuntimeError(TO + URL + SMTP['password'])
            self.assertEqual(relay.main(), 1)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(err.getvalue(), '')

    def test_address_injection_fails_before_connecting(self):
        with mock.patch.object(relay.smtplib, 'SMTP_SSL') as smtp:
            with self.assertRaises(ValueError):
                relay.deliver({'mode': 'send', 'smtp': SMTP, 'email': TO + '\r\nBcc: other@example.invalid',
                               'kind': 'confirm', 'link': URL})
        smtp.assert_not_called()


if __name__ == '__main__':
    unittest.main()
