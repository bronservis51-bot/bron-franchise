#!/usr/bin/env python3
"""Build one private technical T52 response from preserved real MCP reply bytes."""
import argparse
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
import time
import types

sys.dont_write_bytecode = True
DECODER_SHA = '7ebfdc5ed076d09c121d4efabd850113c129984a4df71a7cd9c6bae60f2353e0'
HELPER_SHA = '1d74d088617491d32fc4038054db9709932cd87841617803662426e6420cc83b'
QUERY_SHA = '0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15'
CAPTURE_KEYS = {'format', 'task', 'actionId', 'status', 'querySha256', 'resultSha256',
                'sourceKind', 'sourceLineSha256', 'toolError', 'representation', 'matchingCallsAtCapture'}
SOURCE_KINDS = {'exec_jsonl_item', 'legacy_mcp_end', 'rollout_completed_item', 'response_item_output'}


class BuildError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise BuildError(code)


def load_verified(name, filename, pin):
    path = Path(__file__).with_name(filename)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                0 < before.st_size <= 131072, 'T52_DEPENDENCY_FILE')
        raw = os.read(fd, 131073)
        after, named = os.fstat(fd), path.lstat()
        require(len(raw) == before.st_size and before.st_dev == after.st_dev == named.st_dev and
                before.st_ino == after.st_ino == named.st_ino and before.st_mtime_ns == after.st_mtime_ns and
                before.st_ctime_ns == after.st_ctime_ns and hashlib.sha256(raw).hexdigest() == pin,
                'T52_DEPENDENCY_SHA')
    finally:
        os.close(fd)
    module = types.ModuleType(name)
    module.__file__ = str(path)
    # Execute the exact bytes already verified above, without a second path lookup.
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


decoder = load_verified('t52_fence_decoder', 'mcp-fence-result.py', DECODER_SHA)
helper = load_verified('t52_fence_custody', 't52-mcp-ready.py', HELPER_SHA)


def build_response(request_raw, reply_raw, now_ms):
    request = helper.validate_request(request_raw)
    row = decoder.decode(reply_raw)
    require(type(now_ms) is int and now_ms >= 0, 'T52_BUILDER_CLOCK')
    response = {'format': 1, 'task': 'T52', 'actionId': 'T52.mcp_readiness',
                'status': 'SOURCE_FENCE_VERIFIED', 'requestSha256': helper.sha(request_raw),
                'nonceSha256': request['nonceSha256'], 'sourceProject': request['sourceProject'],
                'verifyFencedSqlSha256': request['verifyFencedSqlSha256'],
                'sourceBarrierReceiptSha256': request['sourceBarrierReceiptSha256'],
                'sourceCheckedMicros': row['source_checked_micros'],
                'workerId': 'local-codex-supabase-mcp',
                'observedUtc': datetime.fromtimestamp(now_ms / 1000, timezone.utc).isoformat(timespec='milliseconds')}
    raw = helper.encode(response)
    # Catch stale/replayed technical replies before delivering anything to the VPS.
    helper.validate_response(raw, request_raw, now_ms)
    return raw


def read_captured_reply(path):
    marker_path = Path(str(path) + '.ready.json')
    deadline = time.monotonic() + 2.0
    while True:
        try:
            marker_raw = decoder.read_private(marker_path)
            break
        except FileNotFoundError:
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'T52_CAPTURE_MARKER_MISSING')
            time.sleep(min(0.05, remaining))
    marker = helper.parse(marker_raw)
    require(set(marker) == CAPTURE_KEYS and type(marker['format']) is int and marker['format'] == 1 and
            marker['task'] == 'T52' and marker['actionId'] == 'T52.capture_recorded_mcp' and
            marker['status'] == 'MCP_RESULT_CAPTURED' and marker['querySha256'] == QUERY_SHA and
            marker['sourceKind'] in SOURCE_KINDS and type(marker['toolError']) is bool and
            marker['representation'] == 'CANONICAL_RECORDED_TOOL_RESULT' and
            type(marker['matchingCallsAtCapture']) is int and marker['matchingCallsAtCapture'] == 1 and
            isinstance(marker['resultSha256'], str) and re.fullmatch('[a-f0-9]{64}', marker['resultSha256']) and
            isinstance(marker['sourceLineSha256'], str) and re.fullmatch('[a-f0-9]{64}', marker['sourceLineSha256']),
            'T52_CAPTURE_MARKER_INVALID')
    require(marker['toolError'] is False, 'T52_CAPTURE_PROVIDER_ERROR')
    reply_raw = decoder.read_private(path)
    require(helper.sha(reply_raw) == marker['resultSha256'], 'T52_CAPTURE_RESULT_SHA')
    return reply_raw


def write_private_new(path, raw):
    parent = path.parent
    before_parent = parent.lstat()
    require(stat.S_ISDIR(before_parent.st_mode) and not stat.S_ISLNK(before_parent.st_mode) and
            before_parent.st_uid == os.getuid() and stat.S_IMODE(before_parent.st_mode) == 0o700,
            'T52_OUTPUT_DIRECTORY')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    directory_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    require(decoder.read_private(path) == raw, 'T52_OUTPUT_READBACK')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--raw', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    raw_sha = None
    try:
        request_raw = decoder.read_private(args.request)
        reply_raw = read_captured_reply(Path(args.raw))
        raw_sha = helper.sha(reply_raw)
        response_raw = build_response(request_raw, reply_raw, time.time_ns() // 1000000)
        write_private_new(Path(args.output), response_raw)
        output = {'task': 'T52', 'status': 'RESPONSE_PREPARED', 'rawSha256': raw_sha,
                  'requestSha256': helper.sha(request_raw), 'responseSha256': helper.sha(response_raw)}
        code = 0
    except Exception as error:
        candidate = str(error)
        safe = candidate if isinstance(error, (BuildError, decoder.DecodeError, helper.RelayError)) and \
            re.fullmatch(r'(?:T52_|MCP_FENCE_)[A-Z0-9_]+', candidate) else 'T52_RESPONSE_BUILD_FAILED'
        output = {'task': 'T52', 'status': 'BLOCKED', 'code': safe}
        if raw_sha is not None:
            output['rawSha256'] = raw_sha
        code = 2
    print(helper.encode(output).decode(), end='')
    return code


if __name__ == '__main__':
    sys.exit(main())
