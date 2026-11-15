import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('t51_response', ROOT / 'docs/runbooks/payloads/t51-mcp-response.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
START = 1794716000000


def request():
    return {'format': 1, 'task': 'T51', 'actionId': 'T51.mcp_readiness',
            'sourceProject': m.helper.PROJECT, 'verifyFencedSqlSha256': m.helper.SQL_SHA,
            'sourceBarrierReceiptSha256': m.helper.BARRIER_SHA, 'nonceSha256': 'a' * 64,
            'createdEpochMs': START, 'expiresEpochMs': START + 60000}


def reply(clock=START + 1200):
    return json.dumps({'Ok': {'content': [], 'structured_content': {
        'result': [{'status': 'SOURCE_FENCE_CURRENTLY_VERIFIED', 'source_checked_micros': str(clock * 1000)}]}}}).encode()


def marker(reply_raw, **changes):
    return {'format': 1, 'task': 'T51', 'actionId': 'T51.capture_recorded_mcp',
            'status': 'MCP_RESULT_CAPTURED', 'querySha256': m.QUERY_SHA,
            'resultSha256': m.helper.sha(reply_raw), 'sourceKind': 'exec_jsonl_item',
            'sourceLineSha256': 'b' * 64, 'toolError': False,
            'representation': 'CANONICAL_RECORDED_TOOL_RESULT', 'matchingCallsAtCapture': 1, **changes}


class ResponseTests(unittest.TestCase):
    def test_new_helper_is_only_exact_namespace_change_from_pinned_old(self):
        old = (ROOT / 'docs/runbooks/payloads/t50-mcp-ready.py').read_bytes()
        self.assertEqual(m.helper.sha(old), 'e032a9e692d5b31c18206cfb928fdd25d601e7c521f9c3bb78723e33a9d56cea')
        new = (ROOT / 'docs/runbooks/payloads/t51-mcp-ready.py').read_bytes()
        self.assertEqual(new, old.replace(b'T50', b'T51').replace(b't50-mcp-readiness', b't51-mcp-readiness'))

    def test_actual_ok_structured_reply_creates_bound_response(self):
        request_raw = m.helper.encode(request())
        result_raw = m.build_response(request_raw, reply(), START + 2000)
        parsed = m.helper.parse(result_raw)
        self.assertEqual(parsed['task'], 'T51')
        self.assertEqual(parsed['requestSha256'], m.helper.sha(request_raw))
        self.assertEqual(parsed['sourceCheckedMicros'], str((START + 1200) * 1000))
        self.assertEqual(result_raw, m.helper.encode(parsed))
        self.assertEqual(parsed['workerId'], 'local-codex-supabase-mcp')

    def test_old_t50_request_or_old_reply_never_authorizes_new_response(self):
        old = {**request(), 'task': 'T50', 'actionId': 'T50.mcp_readiness'}
        with self.assertRaises(m.helper.RelayError):
            m.build_response(m.helper.encode(old), reply(), START + 2000)
        with self.assertRaises(m.helper.RelayError):
            m.build_response(m.helper.encode(request()), reply(START - 6000), START + 2000)

    def test_provider_error_has_no_output_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory); parent.chmod(0o700)
            req, raw, output = parent / 'request.json', parent / 'raw.json', parent / 'response.json'
            req.write_bytes(m.helper.encode(request())); req.chmod(0o600)
            raw.write_bytes(b'{"Err":"provider failure must not print"}'); raw.chmod(0o600)
            ready = Path(str(raw) + '.ready.json')
            ready.write_bytes(m.helper.encode(marker(raw.read_bytes(), toolError=True))); ready.chmod(0o600)
            with mock.patch.object(m.sys, 'argv', ['builder', '--request', str(req), '--raw', str(raw),
                                                 '--output', str(output)]), \
                 mock.patch('builtins.print') as printed:
                self.assertEqual(m.main(), 2)
            self.assertFalse(output.exists())
            self.assertNotIn('provider failure', str(printed.call_args))

    def test_capture_marker_is_validated_before_reading_actual_result(self):
        path = Path('/private/fixture/raw.json')
        reply_raw = reply()
        calls = []
        def read(candidate):
            calls.append(candidate)
            return m.helper.encode(marker(reply_raw)) if candidate == Path(str(path) + '.ready.json') else reply_raw
        with mock.patch.object(m.decoder, 'read_private', side_effect=read):
            self.assertEqual(m.read_captured_reply(path), reply_raw)
        self.assertEqual(calls, [Path(str(path) + '.ready.json'), path])

    def test_absent_capture_marker_is_bounded_without_reading_raw(self):
        with mock.patch.object(m.decoder, 'read_private', side_effect=FileNotFoundError), \
             mock.patch.object(m.time, 'monotonic', side_effect=[0.0, 0.0, 2.1]), \
             mock.patch.object(m.time, 'sleep') as sleep:
            with self.assertRaisesRegex(m.BuildError, '^T51_CAPTURE_MARKER_MISSING$'):
                m.read_captured_reply(Path('/private/fixture/raw.json'))
        sleep.assert_called_once_with(0.05)

    def test_marker_wrong_sha_and_error_flags_are_rejected(self):
        reply_raw = reply()
        for changes, expected, raw_read in [({'resultSha256': 'c' * 64}, 'T51_CAPTURE_RESULT_SHA', True),
                                            ({'toolError': True}, 'T51_CAPTURE_PROVIDER_ERROR', False),
                                            ({'querySha256': 'c' * 64}, 'T51_CAPTURE_MARKER_INVALID', False),
                                            ({'matchingCallsAtCapture': True}, 'T51_CAPTURE_MARKER_INVALID', False),
                                            ({'sourceKind': 'invented'}, 'T51_CAPTURE_MARKER_INVALID', False)]:
            with self.subTest(changes=changes), \
                 mock.patch.object(m.decoder, 'read_private', side_effect=[m.helper.encode(marker(reply_raw, **changes)), reply_raw]) as read:
                with self.assertRaisesRegex(m.BuildError, '^' + expected + '$'):
                    m.read_captured_reply(Path('/private/fixture/raw.json'))
                self.assertEqual(read.call_count, 2 if raw_read else 1)

    def test_exclusive_private_write_and_readback(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory); parent.chmod(0o700)
            path = parent / 'response.json'
            response_raw = m.build_response(m.helper.encode(request()), reply(), START + 2000)
            m.write_private_new(path, response_raw)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.read_bytes(), response_raw)
            with self.assertRaises(FileExistsError):
                m.write_private_new(path, response_raw)

    def test_invalid_output_parent_does_not_create_file(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory); parent.chmod(0o755)
            path = parent / 'response.json'
            with self.assertRaises(m.BuildError):
                m.write_private_new(path, b'{}\n')
            self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
