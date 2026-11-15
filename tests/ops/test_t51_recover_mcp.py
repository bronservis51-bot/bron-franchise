import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('recover', ROOT / 'docs/runbooks/payloads/t51-recover-mcp.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
QUERY = (ROOT / 'docs/runbooks/payloads/t50-verify-fenced.sql').read_text()
RESULT = {'content': [{'type': 'text', 'text': '[{"status":"SOURCE_FENCE_CURRENTLY_VERIFIED",'
                       '"source_checked_micros":"1794716000000000"}]'}], 'isError': False}


def invocation(query=QUERY):
    return {'server': m.SERVER, 'tool': m.TOOL, 'arguments': {'query': query}}


def legacy(call_id='call-test', result=None):
    return {'type': 'event_msg', 'payload': {'type': 'mcp_tool_call_end', 'call_id': call_id,
            'invocation': invocation(), 'result': {'Ok': RESULT} if result is None else result}}


def native(call_id='call-test', status='completed', result=None, error=None):
    return {'type': 'item.completed', 'item': {'type': 'mcp_tool_call', 'id': call_id,
            **invocation(), 'status': status, 'result': RESULT if result is None else result, 'error': error}}


def encoded(*records):
    return b''.join(m.canonical(x) for x in records)


class RecoveryTests(unittest.TestCase):
    def collect(self, *records, stream=False, capture=None):
        return m.Collector(stream=stream, on_capture=capture).consume(io.BytesIO(encoded(*records)))

    def test_exact_pinned_query(self):
        self.assertEqual(m.sha(QUERY.encode()), m.QUERY_SHA)
        self.assertFalse(m.matching_arguments({'query': QUERY.rstrip()}))
        self.assertFalse(m.matching_arguments({'query': QUERY, 'unexpected': 'value'}))
        self.assertFalse(m.matching_arguments({'query': QUERY, 'project_id': 'other'}))
        self.assertTrue(m.matching_arguments({'query': QUERY, 'project_id': m.PROJECT}))

    def test_legacy_rust_result_is_preserved(self):
        found = self.collect(legacy()).finish()
        self.assertEqual(json.loads(found['raw']), {'Ok': RESULT})
        self.assertEqual(found['sourceKind'], 'legacy_mcp_end')
        self.assertFalse(found['toolError'])

    def test_legacy_recorded_error_is_exported_for_diagnosis_without_success_claim(self):
        found = self.collect(legacy(result={'Err': 'recorded provider error'})).finish()
        self.assertEqual(json.loads(found['raw']), {'Err': 'recorded provider error'})
        self.assertTrue(found['toolError'])

    def test_exec_result_and_failed_status_preserve_failure(self):
        found = self.collect(native()).finish()
        self.assertEqual(json.loads(found['raw']), RESULT)
        failed = self.collect(native(status='failed', error={'message': 'recorded failure'})).finish()
        self.assertEqual(json.loads(failed['raw']), {'Err': {'message': 'recorded failure'}})
        self.assertTrue(failed['toolError'])

    def test_native_is_error_not_stripped(self):
        result = {**RESULT, 'isError': True}
        self.assertTrue(self.collect(native(result=result)).finish()['toolError'])

    def test_new_paginated_rollout_item_supported(self):
        item = native()['item']; item['type'] = 'McpToolCall'
        record = {'type': 'event_msg', 'payload': {'type': 'item_completed', 'item': item}}
        self.assertEqual(self.collect(record).finish()['sourceKind'], 'rollout_completed_item')

    def test_response_function_call_output_is_paired_by_id(self):
        call = {'type': 'response_item', 'payload': {'type': 'function_call',
                'name': 'mcp__' + m.SERVER + '__execute_sql', 'call_id': 'call-func',
                'arguments': json.dumps({'query': QUERY})}}
        output = {'type': 'response_item', 'payload': {'type': 'function_call_output',
                  'call_id': 'call-func', 'output': json.dumps(RESULT)}}
        unmatched = {'type': 'response_item', 'payload': {'type': 'function_call_output',
                     'call_id': 'different-call', 'output': 'unrelated private output'}}
        found = self.collect(call, unmatched, output).finish()
        self.assertEqual(json.loads(found['raw']), json.dumps(RESULT))

    def test_unknown_server_query_or_user_text_never_exported(self):
        for mutation in ['server', 'tool', 'query']:
            record = legacy()
            if mutation == 'query':
                record['payload']['invocation']['arguments']['query'] = 'SELECT * FROM auth.users'
            else:
                record['payload']['invocation'][mutation] = 'unrelated'
            with self.subTest(mutation=mutation), self.assertRaises(m.RecoveryError):
                self.collect(record).finish()
        text = {'type': 'response_item', 'payload': {'type': 'message',
                'content': [{'type': 'text', 'text': json.dumps(legacy())}]}}
        with self.assertRaises(m.RecoveryError):
            self.collect(text).finish()

    def test_expected_server_wrong_query_reports_actual_hash_and_never_captures(self):
        changed = QUERY.rstrip('\n')
        record = native()
        record['item']['arguments']['query'] = changed
        captured = []
        source = io.BytesIO(encoded(record, {'type': 'turn.completed'}))
        collector = m.Collector(stream=True, on_capture=captured.append).consume(source)
        with self.assertRaisesRegex(m.RecoveryError, 'T51_QUERY_SHA_MISMATCH'):
            collector.finish()
        self.assertEqual(collector.rejected_query_calls, 1)
        self.assertEqual(collector.observed_query_sha256, m.sha(changed.encode()))
        self.assertEqual(captured, [])
        self.assertEqual(source.tell(), len(source.getvalue()))
        unrelated = native(); unrelated['item']['server'] = 'unrelated'
        unrelated['item']['arguments']['query'] = changed
        collector = self.collect(unrelated)
        self.assertEqual(collector.rejected_query_calls, 0)
        self.assertIsNone(collector.observed_query_sha256)

    def test_expected_function_call_bad_query_or_arguments_is_diagnostic_not_missing(self):
        call = {'type': 'response_item', 'payload': {'type': 'function_call',
                'name': 'mcp__' + m.SERVER + '__execute_sql', 'call_id': 'call-func',
                'arguments': json.dumps({'query': QUERY + ' '})}}
        collector = self.collect(call)
        with self.assertRaisesRegex(m.RecoveryError, 'T51_QUERY_SHA_MISMATCH'):
            collector.finish()
        self.assertEqual(collector.observed_query_sha256, m.sha((QUERY + ' ').encode()))
        call['payload']['arguments'] = json.dumps({'query': QUERY, 'extra': 'not allowed'})
        collector = self.collect(call)
        with self.assertRaisesRegex(m.RecoveryError, 'T51_QUERY_ARGUMENTS_INVALID'):
            collector.finish()
        self.assertEqual(collector.rejected_query_calls, 1)

    def test_second_unique_call_is_ambiguous_even_identical_result(self):
        with self.assertRaisesRegex(m.RecoveryError, 'AMBIGUOUS'):
            self.collect(legacy(), legacy('call-second')).finish()

    def test_one_call_multiple_wire_representations_not_extra_query(self):
        collector = self.collect(native(), legacy())
        found = collector.finish()
        self.assertEqual(len(collector.calls), 1)
        self.assertEqual(collector.duplicate_representations, 1)
        self.assertEqual(found['sourceKind'], 'legacy_mcp_end')

    def test_duplicate_json_keys_line_and_total_bounds_reject(self):
        for raw in [b'{"type":"event_msg","type":"event_msg"}\n',
                    b'{"value":NaN}\n']:
            with self.subTest(raw=raw), self.assertRaises(m.RecoveryError):
                m.Collector().consume(io.BytesIO(raw)).finish()
        with mock.patch.object(m, 'MAX_LINE', 10):
            with self.assertRaisesRegex(m.RecoveryError, 'LINE_BOUND'):
                self.collect({'type': 'anything', 'value': 'long'}).finish()
        with mock.patch.object(m, 'MAX_FILE', 10):
            with self.assertRaisesRegex(m.RecoveryError, 'INPUT_BOUND'):
                self.collect({'type': 'anything'}).finish()

    def test_stream_capture_precedes_eof_and_drain_keeps_producer_alive(self):
        class CheckDrain(io.BytesIO):
            def __init__(self, raw):
                super().__init__(raw)
                self.read_count = 0
            def readline(self, limit):
                self.read_count += 1
                return super().readline(limit)
        source = CheckDrain(encoded(native(), {'type': 'turn.completed', 'usage': {}},
                                    {'type': 'error', 'message': 'not exported'}))
        captured_at = []
        collector = m.Collector(stream=True, on_capture=lambda _: captured_at.append(source.read_count))
        collector.consume(source).finish()
        self.assertEqual(captured_at, [1])
        self.assertEqual(source.tell(), len(source.getvalue()))

    def test_stream_drains_after_capture_callback_failure_and_ambiguity(self):
        source = io.BytesIO(encoded(native(), native('call-second'), {'type': 'turn.completed'}))
        def fail(_):
            raise OSError('output could not be written')
        collector = m.Collector(stream=True, on_capture=fail).consume(source)
        with self.assertRaises(m.RecoveryError):
            collector.finish()
        self.assertEqual(source.tell(), len(source.getvalue()))
        captured = []
        source = io.BytesIO(encoded(native(), native('call-second'), {'type': 'turn.completed'}))
        collector = m.Collector(stream=True, on_capture=captured.append).consume(source)
        with self.assertRaisesRegex(m.RecoveryError, 'AMBIGUOUS'):
            collector.finish()
        self.assertEqual(len(captured), 1)
        self.assertEqual(source.tell(), len(source.getvalue()))

    def test_file_safety_and_exclusive_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            source = directory / 'session.jsonl'; source.write_bytes(encoded(legacy()))
            source.chmod(0o644)
            self.assertEqual(m.read_session(source, m.Collector()), None)
            link = directory / 'source-link'; link.symlink_to(source)
            with self.assertRaises(OSError):
                m.read_session(link, m.Collector())
            source.chmod(0o666)
            with self.assertRaises(m.RecoveryError):
                m.read_session(source, m.Collector())
            output = directory / 'recovered.json'
            m.durable_new(output, m.canonical(RESULT))
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                m.durable_new(output, b'overwrite forbidden')

    def test_main_stream_marker_is_written_before_drain_and_summary_after_eof(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'result.json'
            raw = encoded(native(), {'type': 'turn.completed'})
            observed_ready = []
            class Producer(io.BytesIO):
                def readline(self, limit):
                    if self.tell() != 0:
                        observed_ready.append(Path(str(output) + '.ready.json').exists())
                    return super().readline(limit)
            writer = io.StringIO()
            with mock.patch.object(m.sys, 'argv', ['recover', '--json-stream', '--output', str(output)]), \
                 mock.patch.object(m.sys, 'stdin', type('Input', (), {'buffer': Producer(raw)})()), \
                 mock.patch.object(m.sys, 'stdout', writer):
                self.assertEqual(m.main(), 0)
            self.assertTrue(all(observed_ready))
            ready = json.loads(Path(str(output) + '.ready.json').read_bytes())
            self.assertEqual(ready['resultSha256'], m.sha(output.read_bytes()))
            self.assertEqual(ready['matchingCallsAtCapture'], 1)
            summary = json.loads(Path(str(output) + '.summary.json').read_bytes())
            self.assertEqual(summary['status'], 'RECOVERED')
            self.assertEqual(summary['matchingCalls'], 1)


if __name__ == '__main__':
    unittest.main()
