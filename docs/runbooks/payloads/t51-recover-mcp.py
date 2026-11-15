#!/usr/bin/env python3
"""Recover only the recorded, checksum-bound T50 technical MCP result. No network."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

SERVER = 'bron-release-source'
TOOL = 'execute_sql'
PROJECT = 'vkkqffvmztpzgygzfxhq'
QUERY_SHA = '0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15'
MAX_FILE = 16 * 1024 * 1024
MAX_LINE = 512 * 1024
MAX_QUERY_BYTES = 64 * 1024


class RecoveryError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise RecoveryError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, ensure_ascii=True, sort_keys=True,
                       separators=(',', ':'), allow_nan=False) + '\n').encode()


def parse(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'T51_DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def bad_constant(_):
        raise RecoveryError('T51_JSON_NONFINITE')
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=bad_constant)
    except RecoveryError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise RecoveryError('T51_JSON_INVALID') from None


def matching_arguments(value):
    if not (isinstance(value, dict) and set(value) in ({'query'}, {'query', 'project_id'})
            and ('project_id' not in value or value['project_id'] == PROJECT)
            and isinstance(value.get('query'), str)):
        return False
    try:
        raw = value['query'].encode()
    except UnicodeError:
        return False
    return len(raw) <= MAX_QUERY_BYTES and sha(raw) == QUERY_SHA


def matching_invocation(value):
    return (isinstance(value, dict) and value.get('server') == SERVER
            and value.get('tool') == TOOL and matching_arguments(value.get('arguments')))


def function_is_target(value):
    name, namespace = value.get('name'), value.get('namespace')
    return ((name == 'mcp__' + SERVER + '__' + TOOL and namespace in (None, 'functions'))
            or (name == TOOL and namespace == 'mcp__' + SERVER))


def error_flag(value):
    if isinstance(value, dict):
        if 'Err' in value:
            return True
        if set(value) == {'Ok'}:
            return error_flag(value['Ok'])
        return value.get('isError') is True or value.get('is_error') is True
    return False


class Collector:
    def __init__(self, stream=False, on_capture=None):
        self.stream = stream
        self.on_capture = on_capture
        self.calls = {}
        self.candidates = {}
        self.line_count = 0
        self.total_bytes = 0
        self.failure = None
        self.captured = None
        self.duplicate_representations = 0
        self.rejected_query_calls = 0
        self.observed_query_sha256 = None

    def fail(self, code):
        if self.failure is None:
            self.failure = code

    def register(self, call_id):
        require(isinstance(call_id, str) and 0 < len(call_id) <= 200,
                'T51_CALL_ID_INVALID')
        if call_id not in self.calls:
            self.calls[call_id] = True
        require(len(self.calls) == 1, 'T51_MATCHING_CALL_AMBIGUOUS')
        return call_id

    def validate_arguments(self, value):
        if matching_arguments(value):
            return
        self.rejected_query_calls += 1
        query = value.get('query') if isinstance(value, dict) else None
        query_raw = None
        if isinstance(query, str):
            try:
                query_raw = query.encode()
            except UnicodeError:
                pass
        if query_raw is not None and len(query_raw) <= MAX_QUERY_BYTES:
            self.observed_query_sha256 = sha(query_raw)
        require(isinstance(value, dict) and set(value) in ({'query'}, {'query', 'project_id'})
                and ('project_id' not in value or value['project_id'] == PROJECT)
                and query_raw is not None, 'T51_QUERY_ARGUMENTS_INVALID')
        require(len(query_raw) <= MAX_QUERY_BYTES, 'T51_QUERY_BOUND')
        raise RecoveryError('T51_QUERY_SHA_MISMATCH')

    def target_invocation(self, value):
        if not isinstance(value, dict) or value.get('server') != SERVER or value.get('tool') != TOOL:
            return False
        self.validate_arguments(value.get('arguments'))
        return True

    def candidate(self, call_id, result, source_kind, priority, source_status,
                  error_present, line_raw):
        self.register(call_id)
        raw = canonical(result)
        require(len(raw) <= MAX_LINE, 'T51_RESULT_BOUND')
        value = {'raw': raw, 'sourceKind': source_kind, 'priority': priority,
                 'sourceStatus': source_status, 'errorPresent': error_present,
                 'sourceLineSha256': sha(line_raw), 'callIdSha256': sha(call_id.encode()),
                 'toolError': error_flag(result), 'representation': 'CANONICAL_RECORDED_TOOL_RESULT'}
        prior = self.candidates.get(call_id)
        if prior is not None:
            self.duplicate_representations += 1
            require(prior['toolError'] == value['toolError'] or source_kind == 'response_item_output'
                    or prior['sourceKind'] == 'response_item_output', 'T51_RECORDED_RESULT_CONFLICT')
            if prior['priority'] == priority:
                require(prior['raw'] == raw, 'T51_RECORDED_RESULT_CONFLICT')
            if prior['priority'] >= priority:
                return
        self.candidates[call_id] = value
        if self.stream and self.captured is None:
            self.on_capture(value)
            self.captured = value

    def native_item(self, item, source_kind, line_raw):
        if not isinstance(item, dict) or item.get('type') not in ('mcp_tool_call', 'McpToolCall'):
            return
        if not self.target_invocation(item):
            return
        call_id = self.register(item.get('id'))
        status = item.get('status')
        require(status in ('completed', 'failed'), 'T51_NATIVE_STATUS_INVALID')
        error = item.get('error')
        result = item.get('result')
        if status == 'failed' or error is not None:
            result = {'Err': error}
        else:
            require(result is not None, 'T51_NATIVE_RESULT_MISSING')
        self.candidate(call_id, result, source_kind, 3, status, error is not None, line_raw)

    def process(self, line_raw):
        record = parse(line_raw)
        require(isinstance(record, dict), 'T51_RECORD_NOT_OBJECT')
        # --json stdout is a different protocol from persisted rollout JSONL.
        if record.get('type') == 'item.completed':
            self.native_item(record.get('item'), 'exec_jsonl_item', line_raw)
            return
        if self.stream:
            return
        payload = record.get('payload')
        if not isinstance(payload, dict):
            return
        if record.get('type') == 'event_msg':
            if payload.get('type') == 'mcp_tool_call_end' and self.target_invocation(payload.get('invocation')):
                require('result' in payload, 'T51_LEGACY_RESULT_MISSING')
                result = payload['result']
                require(isinstance(result, dict) and set(result) in ({'Ok'}, {'Err'}),
                        'T51_LEGACY_RESULT_INVALID')
                self.candidate(payload.get('call_id'), result, 'legacy_mcp_end', 4,
                               'recorded_end', 'Err' in result, line_raw)
            elif payload.get('type') == 'item_completed':
                self.native_item(payload.get('item'), 'rollout_completed_item', line_raw)
            return
        if record.get('type') != 'response_item':
            return
        if payload.get('type') == 'function_call' and function_is_target(payload):
            arguments = payload.get('arguments')
            if not isinstance(arguments, str):
                self.rejected_query_calls += 1
                raise RecoveryError('T51_QUERY_ARGUMENTS_INVALID')
            try:
                arguments = parse(arguments)
            except RecoveryError:
                self.rejected_query_calls += 1
                raise RecoveryError('T51_QUERY_ARGUMENTS_INVALID') from None
            self.validate_arguments(arguments)
            self.register(payload.get('call_id'))
        elif payload.get('type') == 'function_call_output' and payload.get('call_id') in self.calls:
            require('output' in payload, 'T51_FUNCTION_RESULT_MISSING')
            self.candidate(payload['call_id'], payload['output'], 'response_item_output', 1,
                           'recorded_output', False, line_raw)

    def consume(self, source):
        # Drain stream even after capture/error, so the producer is never interrupted by SIGPIPE.
        oversized_line = False
        while True:
            raw = source.readline(MAX_LINE + 1)
            if not raw:
                break
            self.total_bytes += len(raw)
            if self.total_bytes > MAX_FILE:
                self.fail('T51_INPUT_BOUND')
            if oversized_line:
                oversized_line = not raw.endswith(b'\n')
                continue
            if len(raw) > MAX_LINE:
                self.fail('T51_LINE_BOUND')
                oversized_line = not raw.endswith(b'\n')
                continue
            self.line_count += 1
            if self.failure is not None or not raw.strip():
                continue
            try:
                self.process(raw)
            except RecoveryError as error:
                self.fail(str(error))
            except (TypeError, ValueError, UnicodeError, RecursionError):
                self.fail('T51_RECORD_INVALID')
            except Exception:
                self.fail('T51_CAPTURE_RECORD_FAILED')
        return self

    def finish(self):
        require(self.failure is None, self.failure or 'T51_CAPTURE_FAILED')
        require(len(self.calls) == 1, 'T51_MATCHING_CALL_NOT_FOUND')
        require(len(self.candidates) == 1, 'T51_MATCHING_RESULT_NOT_FOUND')
        return next(iter(self.candidates.values()))


def private_parent(path):
    s = path.parent.stat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid()
            and stat.S_IMODE(s.st_mode) & 0o077 == 0, 'T51_OUTPUT_PARENT_UNSAFE')


def durable_new(path, raw):
    private_parent(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        pending = memoryview(raw)
        while pending:
            wrote = os.write(fd, pending)
            require(wrote > 0, 'T51_OUTPUT_WRITE_FAILED')
            pending = pending[wrote:]
        os.fsync(fd)
    finally:
        os.close(fd)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1
                and stat.S_IMODE(s.st_mode) == 0o600 and os.read(fd, len(raw) + 1) == raw,
                'T51_OUTPUT_READBACK')
    finally:
        os.close(fd)


def read_session(path, collector):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1
                and stat.S_IMODE(before.st_mode) & 0o022 == 0 and before.st_size <= MAX_FILE,
                'T51_SESSION_FILE_UNSAFE')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            collector.consume(source)
        after, named = os.fstat(fd), path.lstat()
        require(before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns
                and before.st_ctime_ns == after.st_ctime_ns and before.st_ino == after.st_ino == named.st_ino
                and before.st_dev == after.st_dev == named.st_dev, 'T51_SESSION_FILE_CHANGED')
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--session-file', type=Path)
    mode.add_argument('--json-stream', action='store_true')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    summary = {'task': 'T51', 'actionId': 'T51.capture_recorded_mcp', 'status': 'BLOCKED',
               'sourceQueries': 0, 'targetWrites': 0, 'snapshotAttemptsUsed': 0,
               'representation': 'CANONICAL_RECORDED_TOOL_RESULT'}
    captured = False
    def capture(value):
        nonlocal captured
        durable_new(args.output, value['raw'])
        captured = True
        durable_new(Path(str(args.output) + '.ready.json'), canonical({
            'format': 1, 'task': 'T51', 'actionId': 'T51.capture_recorded_mcp',
            'status': 'MCP_RESULT_CAPTURED', 'querySha256': QUERY_SHA,
            'resultSha256': sha(value['raw']), 'sourceKind': value['sourceKind'],
            'sourceLineSha256': value['sourceLineSha256'], 'toolError': value['toolError'],
            'representation': 'CANONICAL_RECORDED_TOOL_RESULT', 'matchingCallsAtCapture': 1}))
    collector = Collector(stream=args.json_stream, on_capture=capture)
    try:
        private_parent(args.output)
        # Both output paths are immutable. Existing evidence is never replaced.
        require(not args.output.exists() and not Path(str(args.output) + '.summary.json').exists()
                and not Path(str(args.output) + '.ready.json').exists(),
                'T51_OUTPUT_ALREADY_EXISTS')
        if args.json_stream:
            collector.consume(sys.stdin.buffer)
        else:
            read_session(args.session_file, collector)
        value = collector.finish()
        if not captured:
            capture(value)
        summary.update(status='RECOVERED', resultSha256=sha(value['raw']),
                       sourceKind=value['sourceKind'], sourceStatus=value['sourceStatus'],
                       sourceLineSha256=value['sourceLineSha256'], callIdSha256=value['callIdSha256'],
                       toolError=value['toolError'], errorPresent=value['errorPresent'],
                       matchingCalls=1, duplicateRepresentations=collector.duplicate_representations)
    except RecoveryError as error:
        summary['code'] = str(error)
        if args.json_stream:
            collector.fail(str(error))
            collector.consume(sys.stdin.buffer)
    except Exception:
        summary['code'] = 'T51_RECOVERY_FAILED'
        if args.json_stream:
            collector.fail('T51_RECOVERY_FAILED')
            collector.consume(sys.stdin.buffer)
    summary.update(resultArtifactWritten=captured, inputBytes=collector.total_bytes,
                   linesProcessed=collector.line_count, rejectedQueryCalls=collector.rejected_query_calls)
    if collector.observed_query_sha256 is not None:
        summary['observedQuerySha256'] = collector.observed_query_sha256
    try:
        durable_new(Path(str(args.output) + '.summary.json'), canonical(summary))
    except Exception:
        summary.update(status='BLOCKED', code='T51_SUMMARY_WRITE_FAILED')
    print(canonical(summary).decode(), end='')
    return 0 if summary['status'] == 'RECOVERED' else 2


if __name__ == '__main__':
    sys.exit(main())
