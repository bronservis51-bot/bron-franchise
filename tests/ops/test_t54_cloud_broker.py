import base64
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


m = module('broker_io', 'docs/runbooks/payloads/t54-cloud-broker-io.py')
h = module('t54_custody', 'docs/runbooks/payloads/t54-mcp-ready.py')
PIN = 'a' * 64
START = 1794716000000


def request():
    return {'format': 1, 'task': 'T54', 'actionId': h.ACTION, 'sourceProject': h.PROJECT,
            'verifyFencedSqlSha256': h.SQL_SHA, 'sourceBarrierReceiptSha256': h.BARRIER_SHA,
            'nonceSha256': 'b' * 64, 'createdEpochMs': START, 'expiresEpochMs': START + 60000}


def envelope(value=None):
    value = request() if value is None else value
    return {'format': 1, 'task': 'T54', 'protocol': 'BRON_GITHUB_FENCE_PROOF_V1',
            'manifestSha256': PIN, 'requestSha256': m.sha(m.canonical(value)), 'request': value}


class BrokerTests(unittest.TestCase):
    def test_exact_bound_public_envelope_is_accepted(self):
        r, raw = m.validate_envelope(m.canonical(envelope()), PIN, h, START + 1000)
        self.assertEqual(r, request())
        self.assertEqual(m.sha(raw), envelope()['requestSha256'])

    def test_wrong_context_manifest_hash_and_extra_nonce_are_rejected(self):
        cases = [{**envelope(), 'manifestSha256': 'c' * 64},
                 {**envelope(), 'requestSha256': 'c' * 64},
                 {**envelope(), 'rawNonce': 'not-authorized'},
                 envelope({**request(), 'sourceProject': 'other'})]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(Exception):
                m.validate_envelope(m.canonical(value), PIN, h, START + 1000)

    def test_noncanonical_duplicate_and_too_old_requests_fail_before_mcp(self):
        for raw in [m.canonical(envelope()).rstrip(b'\n'),
                    b'{"task":"T54","task":"T54"}']:
            with self.subTest(raw=raw), self.assertRaises(m.BrokerError):
                m.validate_envelope(raw, PIN, h, START + 1000)
        for now in [START - 5001, START + 20000]:
            with self.subTest(now=now), self.assertRaises(m.BrokerError):
                m.validate_envelope(m.canonical(envelope()), PIN, h, now)

    def test_private_claim_and_raw_files_never_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'claim.json'
            m.durable_new(p, b'{"claimed":true}\n')
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                m.durable_new(p, b'overwrite')
            self.assertEqual(p.read_bytes(), b'{"claimed":true}\n')

    def test_github_put_is_no_overwrite_and_response_only(self):
        response_raw = m.canonical({'clock': '1794716000000000'})
        git_sha = m.hashlib.sha1(b'blob ' + str(len(response_raw)).encode() + b'\0' + response_raw).hexdigest()
        with tempfile.TemporaryDirectory() as d:
            def send(args, **kwargs):
                payload = json.loads((Path(d) / 'github-response-upload.json').read_bytes())
                self.assertNotIn('sha', payload)
                self.assertEqual(payload['branch'], m.BRANCH)
                self.assertEqual(base64.b64decode(payload['content']), response_raw)
                self.assertNotIn('--header', args)
                return types.SimpleNamespace(returncode=0, stdout=m.canonical({'content':
                    {'path': m.RESPONSE_PATH, 'sha': git_sha}}))
            with mock.patch.object(m.subprocess, 'run', side_effect=send):
                self.assertEqual(m.publish_response(Path(d), response_raw), git_sha)

    def test_raw_reply_is_fsynced_before_provider_error_decode(self):
        raw = '{"isError":true,"content":[]}'
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            req = request(); req['createdEpochMs'] = time.time_ns() // 1000000
            req['expiresEpochMs'] = req['createdEpochMs'] + 60000
            request_raw = m.canonical(req)
            m.durable_new(p / 'request.json', request_raw)
            m.durable_new(p / 'mcp-claim.json', m.canonical({'manifestSha256': PIN,
                'requestSha256': m.sha(request_raw)}))
            def reject(actual):
                self.assertEqual((p / 'mcp-raw-result.json').read_bytes(), actual)
                self.assertEqual((p / 'mcp-raw-result.json').stat().st_mode & 0o777, 0o600)
                raise m.BrokerError('MCP_FENCE_PROVIDER_ERROR')
            args = ['broker', '--manifest', '/unused-manifest', '--sha256', PIN,
                    '--job-directory', d, '--receive-raw-json', raw]
            with mock.patch.object(m.sys, 'argv', args), \
                 mock.patch.object(m, 'context', return_value=(h, types.SimpleNamespace(decode=reject), b'')), \
                 mock.patch.object(m, 'publish_response') as send, redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(), 2)
                send.assert_not_called()
            self.assertFalse((p / 'response.json').exists())

    def test_poll_only_404_is_waiting_other_network_failures_are_not_success(self):
        with mock.patch.object(m.subprocess, 'run', return_value=types.SimpleNamespace(
                returncode=1, stdout=b'{"message":"Not Found","status":"404"}')):
            self.assertIsNone(m.github_read())
        with mock.patch.object(m.subprocess, 'run', return_value=types.SimpleNamespace(
                returncode=1, stdout=b'')):
            with self.assertRaises(m.BrokerError):
                m.github_read()


if __name__ == '__main__':
    unittest.main()
