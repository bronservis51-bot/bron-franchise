import importlib.util
import io
from pathlib import Path
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('t50', ROOT / 'docs/runbooks/payloads/t50-mcp-ready.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
START = 1794716000000


def request():
    return {'format': 1, 'task': 'T50', 'actionId': m.ACTION, 'sourceProject': m.PROJECT,
            'verifyFencedSqlSha256': m.SQL_SHA, 'sourceBarrierReceiptSha256': m.BARRIER_SHA,
            'nonceSha256': 'a' * 64, 'createdEpochMs': START, 'expiresEpochMs': START + 60000}


def response(request_raw):
    return {'format': 1, 'task': 'T50', 'actionId': m.ACTION, 'sourceProject': m.PROJECT,
            'verifyFencedSqlSha256': m.SQL_SHA, 'sourceBarrierReceiptSha256': m.BARRIER_SHA,
            'nonceSha256': 'a' * 64, 'requestSha256': m.sha(request_raw), 'status': 'SOURCE_FENCE_VERIFIED',
            'sourceCheckedMicros': str((START + 1200) * 1000), 'workerId': 'local-codex-supabase-mcp',
            'observedUtc': '2026-11-15T03:33:21.200Z'}


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.req = m.encode(request())
        self.response = response(self.req)
        self.response['observedUtc'] = m.datetime.fromtimestamp((START + 1200) / 1000, m.timezone.utc).isoformat()

    def test_valid_response_is_bound_to_fresh_source_operation(self):
        req, res = m.validate_response(m.encode(self.response), self.req, START + 2000)
        self.assertEqual(req['nonceSha256'], res['nonceSha256'])

    def test_rejects_replayed_or_different_context_response(self):
        for key, value in [('requestSha256', 'b' * 64), ('nonceSha256', 'b' * 64),
                           ('sourceProject', 'other'), ('verifyFencedSqlSha256', 'b' * 64),
                           ('sourceBarrierReceiptSha256', 'b' * 64), ('workerId', 'unverified-worker'),
                           ('status', 'PASS'), ('format', True)]:
            with self.subTest(key=key), self.assertRaises(m.RelayError):
                m.validate_response(m.encode({**self.response, key: value}), self.req, START + 2000)

    def test_rejects_missing_extra_duplicate_and_noncanonical_fields(self):
        missing = dict(self.response); del missing['sourceCheckedMicros']
        candidates = [m.encode(missing), m.encode({**self.response, 'rawNonce': 'forbidden'}),
                      m.encode(self.response).rstrip(b'\n'), b'{"task":"T50","task":"T50"}\n']
        for raw in candidates:
            with self.subTest(raw=raw), self.assertRaises(m.RelayError):
                m.validate_response(raw, self.req, START + 2000)

    def test_rejects_future_and_old_source_clock(self):
        for checked in [START - 5001, START + 7001]:
            with self.subTest(checked=checked), self.assertRaises(m.RelayError):
                m.validate_response(m.encode({**self.response, 'sourceCheckedMicros': str(checked * 1000)}),
                                    self.req, START + 2000)

    def test_rejects_expired_or_backwards_vps_clock(self):
        for completed in [START - 1, START + 60000]:
            with self.subTest(completed=completed), self.assertRaises(m.RelayError):
                m.validate_response(m.encode(self.response), self.req, completed)

    def run_complete(self, elapsed=30000, raw=None, monotonic_elapsed=None, saved=None):
        if saved is None:
            saved = {m.STATE / 'request.json': self.req,
                     m.STATE / 'guard.json': m.encode({'task': 'T50', 'actionId': m.ACTION,
                         'requestSha256': m.sha(self.req), 'createdMonotonicNs': 1000000000})}
        def save(path, content):
            if path in saved:
                raise FileExistsError('one attempt already consumed')
            saved[path] = content
        stream = io.BytesIO()
        with mock.patch.object(m, 'private_directory'), mock.patch.object(m.os, 'getuid', return_value=0), \
             mock.patch.object(m.os, 'getgid', return_value=0), mock.patch.object(m, 'read_private', side_effect=saved.__getitem__), \
             mock.patch.object(m, 'durable_new', side_effect=save), \
             mock.patch.object(m.time, 'time_ns', return_value=(START + elapsed) * 1000000), \
             mock.patch.object(m.time, 'monotonic_ns', return_value=1000000000 +
                               (elapsed if monotonic_elapsed is None else monotonic_elapsed) * 1000000), \
             mock.patch.object(m.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(raw or m.encode(self.response)))), \
             mock.patch.object(m.sys, 'stdout', types.SimpleNamespace(buffer=stream)):
            m.remote('complete')
        return m.parse(stream.getvalue()), saved

    def test_full_path_exactly_30_seconds_passes(self):
        result, saved = self.run_complete(30000)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['roundTripMs'], 30000)
        self.assertEqual(result['snapshotAttemptsUsed'], 0)
        self.assertFalse(result['T49Started'])
        self.assertIn(m.STATE / 'complete.guard.json', saved)

    def test_30_seconds_plus_one_millisecond_is_persisted_blocked(self):
        result, saved = self.run_complete(30001)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['code'], 'T50_ROUND_TRIP_TOO_SLOW')
        self.assertEqual(m.parse(saved[m.STATE / 'result.json']), result)

    def test_monotonic_clock_detects_wallclock_adjustment(self):
        result, _ = self.run_complete(2000, monotonic_elapsed=5000)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['code'], 'T50_VPS_CLOCK_CHANGED')

    def test_invalid_complete_consumes_one_attempt_without_retry_or_response_storage(self):
        result, saved = self.run_complete(2000, raw=b'{"raw":"not accepted"}\n')
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertNotIn(m.STATE / 'response.json', saved)
        with self.assertRaises(FileExistsError):
            self.run_complete(2200, saved=saved)

    def test_cli_exit_zero_requires_prepare_or_actual_pass(self):
        for flag, passed, expected in [('--prepare', True, 0), ('--complete', True, 0),
                                        ('--complete', False, 2)]:
            with self.subTest(flag=flag, passed=passed), \
                 mock.patch.object(m.sys, 'argv', ['t50-mcp-ready.py', flag]), \
                 mock.patch.object(m, 'remote', return_value=passed) as remote:
                self.assertEqual(m.main(), expected)
                remote.assert_called_once_with(flag[2:])

    def test_no_network_subprocess_secret_or_t49_operation(self):
        text = (ROOT / 'docs/runbooks/payloads/t50-mcp-ready.py').read_text()
        for forbidden in ['import subprocess', 'import socket', 'import urllib', 'final-capability',
                          'owner-recovery', 'supabase_execute_sql', 'systemctl', 'docker', 't49-release/']:
            self.assertNotIn(forbidden, text)

    def test_mcp_sql_contains_exact_unchanged_fence_assertions_and_source_clock(self):
        original = (ROOT / 'docs/runbooks/payloads/worker-t45-verify-fenced.sql').read_bytes()
        full = (ROOT / 'docs/runbooks/payloads/t50-verify-fenced.sql').read_bytes()
        prefix = b"BEGIN ISOLATION LEVEL READ COMMITTED;\nSET LOCAL statement_timeout='30000';\nSET LOCAL lock_timeout='5000';\n"
        suffix = b"\nSELECT 'SOURCE_FENCE_CURRENTLY_VERIFIED' AS status,\n floor(extract(epoch FROM clock_timestamp())*1000000)::numeric::text AS source_checked_micros;\nCOMMIT;\n"
        self.assertEqual(m.sha(original), m.SQL_SHA)
        self.assertEqual(full, prefix + original + suffix)


if __name__ == '__main__':
    unittest.main()
