#!/usr/bin/env python3
"""VPS custody for one same-worker MCP readiness proof; no Source/network/secret I/O."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

sys.dont_write_bytecode = True
PROJECT = 'vkkqffvmztpzgygzfxhq'
SQL_SHA = 'fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782'
BARRIER_SHA = '0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6'
ACTION = 'T52.mcp_readiness'
STATE = Path('/root/bron-secrets/t52-mcp-readiness')
REQUEST_KEYS = {'format', 'task', 'actionId', 'sourceProject', 'verifyFencedSqlSha256',
                'sourceBarrierReceiptSha256', 'nonceSha256', 'createdEpochMs', 'expiresEpochMs'}
RESPONSE_KEYS = {'format', 'task', 'actionId', 'status', 'requestSha256', 'nonceSha256',
                 'sourceProject', 'verifyFencedSqlSha256', 'sourceBarrierReceiptSha256',
                 'sourceCheckedMicros', 'workerId', 'observedUtc'}


class RelayError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise RelayError(code)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def parse(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'T52_DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    require(isinstance(raw, bytes) and 0 < len(raw) <= 16384, 'T52_JSON_BOUND')
    try:
        value = json.loads(raw, object_pairs_hook=unique)
    except (UnicodeError, ValueError):
        raise RelayError('T52_JSON_INVALID') from None
    require(isinstance(value, dict), 'T52_JSON_OBJECT')
    return value


def context(value):
    require(type(value.get('format')) is int and value['format'] == 1 and
            value.get('task') == 'T52' and value.get('actionId') == ACTION and
            value.get('sourceProject') == PROJECT and value.get('verifyFencedSqlSha256') == SQL_SHA and
            value.get('sourceBarrierReceiptSha256') == BARRIER_SHA, 'T52_CONTEXT_MISMATCH')


def validate_request(raw):
    request = parse(raw)
    require(set(request) == REQUEST_KEYS and encode(request) == raw, 'T52_REQUEST_SHAPE')
    context(request)
    require(isinstance(request['nonceSha256'], str) and re.fullmatch('[a-f0-9]{64}', request['nonceSha256']) and
            type(request['createdEpochMs']) is int and 1000000000000 <= request['createdEpochMs'] <= 9007199254740991 and
            type(request['expiresEpochMs']) is int and
            request['expiresEpochMs'] == request['createdEpochMs'] + 60000, 'T52_REQUEST_CLOCK')
    return request


def validate_response(raw, request_raw, completed_ms):
    request, response = validate_request(request_raw), parse(raw)
    require(set(response) == RESPONSE_KEYS and encode(response) == raw, 'T52_RESPONSE_SHAPE')
    context(response)
    require(response['status'] == 'SOURCE_FENCE_VERIFIED' and response['requestSha256'] == sha(request_raw) and
            response['nonceSha256'] == request['nonceSha256'] and
            response['workerId'] == 'local-codex-supabase-mcp', 'T52_RESPONSE_BINDING')
    require(type(completed_ms) is int and request['createdEpochMs'] <= completed_ms < request['expiresEpochMs'],
            'T52_RESPONSE_EXPIRED')
    require(isinstance(response['sourceCheckedMicros'], str) and
            re.fullmatch(r'\d{12,20}', response['sourceCheckedMicros']), 'T52_SOURCE_CLOCK')
    checked = int(response['sourceCheckedMicros'])
    require((request['createdEpochMs'] - 5000) * 1000 <= checked <= (completed_ms + 5000) * 1000,
            'T52_SOURCE_CLOCK')
    try:
        observed = datetime.fromisoformat(response['observedUtc'].replace('Z', '+00:00'))
        require(observed.utcoffset().total_seconds() == 0, 'T52_OBSERVED_CLOCK')
        observed_ms = int(observed.timestamp() * 1000)
    except (TypeError, ValueError, AttributeError, OverflowError):
        raise RelayError('T52_OBSERVED_CLOCK') from None
    require(request['createdEpochMs'] - 5000 <= observed_ms <= completed_ms + 5000, 'T52_OBSERVED_CLOCK')
    return request, response


def private_directory(path):
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_uid == 0 and s.st_gid == 0 and
            stat.S_IMODE(s.st_mode) == 0o700, 'T52_DIRECTORY_UNSAFE')


def durable_new(path, raw):
    private_directory(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    require(read_private(path) == raw, 'T52_READBACK_FAILED')


def read_private(path):
    private_directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0 and
                before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600 and
                0 < before.st_size <= 16384, 'T52_FILE_UNSAFE')
        raw = os.read(fd, 16385)
        after, named = os.fstat(fd), path.lstat()
        require(len(raw) == before.st_size and before.st_ino == after.st_ino == named.st_ino and
                before.st_dev == after.st_dev == named.st_dev and
                before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns,
                'T52_FILE_CHANGED')
        return raw
    finally:
        os.close(fd)


def remote(mode):
    require(sys.platform == 'linux' and os.getuid() == 0 and os.getgid() == 0, 'T52_VPS_ROOT_REQUIRED')
    os.umask(0o077)
    for parent in [Path('/root'), Path('/root/bron-secrets')]:
        private_directory(parent)
    if mode == 'prepare':
        os.mkdir(STATE, 0o700)  # Existing directory is an intentional one-run stop.
        parent_fd = os.open(STATE.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        created_monotonic = time.monotonic_ns()
        created = time.time_ns() // 1000000
        request = {'format': 1, 'task': 'T52', 'actionId': ACTION, 'sourceProject': PROJECT,
                   'verifyFencedSqlSha256': SQL_SHA, 'sourceBarrierReceiptSha256': BARRIER_SHA,
                   'nonceSha256': sha(os.urandom(32)), 'createdEpochMs': created,
                   'expiresEpochMs': created + 60000}
        raw = encode(request)
        durable_new(STATE / 'request.json', raw)
        durable_new(STATE / 'guard.json', encode({'task': 'T52', 'actionId': ACTION,
                    'requestSha256': sha(raw), 'createdMonotonicNs': created_monotonic}))
        sys.stdout.buffer.write(raw)
        return True
    require(mode == 'complete', 'T52_REMOTE_MODE')
    request_raw = read_private(STATE / 'request.json')
    guard = parse(read_private(STATE / 'guard.json'))
    require(set(guard) == {'task', 'actionId', 'requestSha256', 'createdMonotonicNs'} and
            guard['task'] == 'T52' and guard['actionId'] == ACTION and guard['requestSha256'] == sha(request_raw) and
            type(guard['createdMonotonicNs']) is int, 'T52_GUARD_MISMATCH')
    # Claim completion before accepting any input; invalid/late input cannot be retried.
    durable_new(STATE / 'complete.guard.json', encode({'task': 'T52', 'actionId': ACTION,
                'requestSha256': sha(request_raw), 'completionAttempts': 1}))
    request = validate_request(request_raw)
    response_raw = sys.stdin.buffer.read(16385)
    completed = time.time_ns() // 1000000
    elapsed = completed - request['createdEpochMs']
    monotonic_elapsed = (time.monotonic_ns() - guard['createdMonotonicNs']) // 1000000
    result = {'format': 1, 'task': 'T52', 'actionId': ACTION, 'status': 'BLOCKED',
              'code': 'T52_PROOF_NOT_VALIDATED', 'requestSha256': sha(request_raw),
              'nonceSha256': request['nonceSha256'], 'createdEpochMs': request['createdEpochMs'],
              'completedEpochMs': completed, 'roundTripMs': elapsed, 'monotonicRoundTripMs': monotonic_elapsed,
              'sourceVerifyPassed': False, 'snapshotAttemptsUsed': 0, 'targetWrites': 0,
              'T49Started': False, 'macDataTransit': False}
    try:
        request, response = validate_response(response_raw, request_raw, completed)
        # End-to-end completion includes durable response delivery on the VPS.
        durable_new(STATE / 'response.json', response_raw)
        completed = time.time_ns() // 1000000
        elapsed = completed - request['createdEpochMs']
        monotonic_elapsed = (time.monotonic_ns() - guard['createdMonotonicNs']) // 1000000
        validate_response(response_raw, request_raw, completed)
        result.update(completedEpochMs=completed, roundTripMs=elapsed, monotonicRoundTripMs=monotonic_elapsed)
        require(abs(monotonic_elapsed - elapsed) <= 1000 and monotonic_elapsed >= 0, 'T52_VPS_CLOCK_CHANGED')
        result.update(responseSha256=sha(response_raw), sourceCheckedMicros=response['sourceCheckedMicros'],
                      sourceVerifyPassed=True)
        require(elapsed <= 30000 and monotonic_elapsed <= 30000, 'T52_ROUND_TRIP_TOO_SLOW')
        result.update(status='PASS', code='T52_SAME_WORKER_MCP_PROVEN')
    except RelayError as error:
        result['code'] = str(error)
    durable_new(STATE / 'result.json', encode(result))
    sys.stdout.buffer.write(encode(result))
    return result['status'] == 'PASS'



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--prepare', action='store_true')
    group.add_argument('--complete', action='store_true')
    args = parser.parse_args()
    try:
        passed = remote('prepare' if args.prepare else 'complete')
        return 0 if passed else 2
    except Exception as error:
        code = str(error) if isinstance(error, RelayError) else 'T52_UNEXPECTED_FAILURE'
        sys.stdout.buffer.write(encode({'task': 'T52', 'status': 'BLOCKED', 'code': code,
                                      'T49Started': False, 'targetWrites': 0, 'snapshotAttemptsUsed': 0}))
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
