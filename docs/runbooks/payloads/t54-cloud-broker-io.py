#!/usr/bin/env python3
"""Cloud-side technical relay I/O; the separate orchestrator owns the real MCP call."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import types

sys.dont_write_bytecode = True
REPOSITORY = 'bronservis51-bot/bron-franchise'
BRANCH = 'ops/t54-ack-relay-20261115'
REQUEST_PATH = '.release-control/t54-proof/request.json'
RESPONSE_PATH = '.release-control/t54-proof/response.json'
WORKER = 'cloud-supabase-mcp-github-relay'
QUERY_SHA = '0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15'
DECODER_SHA = '7ebfdc5ed076d09c121d4efabd850113c129984a4df71a7cd9c6bae60f2353e0'
ENVELOPE_KEYS = {'format', 'task', 'protocol', 'manifestSha256', 'requestSha256', 'request'}
RELAY = {'repository': REPOSITORY, 'branch': BRANCH, 'requestPath': REQUEST_PATH,
         'responsePath': RESPONSE_PATH, 'workerId': WORKER}


class BrokerError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise BrokerError(code)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                       allow_nan=False) + '\n').encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def parse(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'T54_BROKER_DUPLICATE_KEY')
            value[key] = item
        return value
    def bad_constant(_):
        raise BrokerError('T54_BROKER_JSON_NONFINITE')
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=bad_constant)
    except BrokerError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise BrokerError('T54_BROKER_JSON_INVALID') from None


def private_directory(path):
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and
            s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700,
            'T54_BROKER_DIRECTORY')


def read(path, private=False, maximum=131072):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        a = os.fstat(fd)
        require(stat.S_ISREG(a.st_mode) and a.st_nlink == 1 and 0 < a.st_size <= maximum,
                'T54_BROKER_INPUT_FILE')
        require(not private or a.st_uid == os.getuid() and stat.S_IMODE(a.st_mode) == 0o600,
                'T54_BROKER_PRIVATE_FILE')
        raw = os.read(fd, maximum + 1)
        b, named = os.fstat(fd), path.lstat()
        require(len(raw) == a.st_size == b.st_size and a.st_dev == b.st_dev == named.st_dev
                and a.st_ino == b.st_ino == named.st_ino and a.st_mtime_ns == b.st_mtime_ns
                and a.st_ctime_ns == b.st_ctime_ns, 'T54_BROKER_INPUT_CHANGED')
        return raw
    finally:
        os.close(fd)


def durable_new(path, raw):
    private_directory(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw); stream.flush()
        os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    require(read(path, True) == raw, 'T54_BROKER_READBACK')


def load_code(path, expected, name):
    raw = read(path)
    require(sha(raw) == expected, 'T54_BROKER_DEPENDENCY_SHA')
    module = types.ModuleType(name); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def context(manifest_path, pin):
    require(re.fullmatch('[a-f0-9]{64}', pin or ''), 'T54_BROKER_MANIFEST_PIN')
    raw = read(manifest_path); require(sha(raw) == pin, 'T54_BROKER_MANIFEST_SHA')
    manifest = parse(raw)
    require(manifest.get('task') == 'T54' and manifest.get('execution_authorized') is True
            and manifest.get('relay') == RELAY and isinstance(manifest.get('files'), dict),
            'T54_BROKER_SCOPE')
    base = Path(__file__).parent
    helper_key = 'docs/runbooks/payloads/t54-mcp-ready.py'
    require(helper_key in manifest['files'], 'T54_BROKER_HELPER_PIN')
    helper = load_code(base / 't54-mcp-ready.py', manifest['files'][helper_key], 't54_custody')
    decoder = load_code(base / 'mcp-fence-result.py', DECODER_SHA, 't54_decoder')
    query = read(base / 't50-verify-fenced.sql')
    require(sha(query) == QUERY_SHA, 'T54_BROKER_QUERY_PIN')
    return helper, decoder, query


def validate_envelope(raw, manifest_pin, helper, now_ms):
    require(len(raw) <= 16384, 'T54_BROKER_ENVELOPE_BOUND')
    value = parse(raw)
    require(isinstance(value, dict) and set(value) == ENVELOPE_KEYS and canonical(value) == raw
            and type(value['format']) is int and value['format'] == 1 and value['task'] == 'T54'
            and value['protocol'] == 'BRON_GITHUB_FENCE_PROOF_V1'
            and value['manifestSha256'] == manifest_pin, 'T54_BROKER_ENVELOPE')
    request_raw = canonical(value['request'])
    request = helper.validate_request(request_raw)
    require(value['requestSha256'] == sha(request_raw), 'T54_BROKER_REQUEST_SHA')
    require(request['createdEpochMs'] - 5000 <= now_ms < request['createdEpochMs'] + 20000,
            'T54_BROKER_REQUEST_TOO_OLD')
    return request, request_raw


def github_read():
    endpoint = f'repos/{REPOSITORY}/contents/{REQUEST_PATH}?ref={BRANCH}'
    p = subprocess.run(['gh', 'api', '-H', 'Cache-Control: no-cache', endpoint],
                       capture_output=True, timeout=8)
    require(len(p.stdout) <= 65536, 'T54_BROKER_GITHUB_BODY_BOUND')
    value = parse(p.stdout) if p.stdout else {}
    if p.returncode != 0:
        if isinstance(value, dict) and str(value.get('status')) == '404':
            return None
        raise BrokerError('T54_BROKER_GITHUB_READ_FAILED')
    require(isinstance(value, dict) and value.get('type') == 'file'
            and value.get('encoding') == 'base64' and value.get('path') == REQUEST_PATH,
            'T54_BROKER_GITHUB_RESPONSE')
    try:
        raw = base64.b64decode(value['content'], validate=False)
    except (ValueError, TypeError):
        raise BrokerError('T54_BROKER_GITHUB_CONTENT') from None
    require(len(raw) <= 16384, 'T54_BROKER_GITHUB_CONTENT')
    return raw


def publish_response(job, response_raw):
    payload = {'branch': BRANCH, 'message': 'ops: T54 technical fence response [skip ci]',
               'content': base64.b64encode(response_raw).decode()}
    upload = job / 'github-response-upload.json'
    durable_new(upload, canonical(payload))
    p = subprocess.run(['gh', 'api', '--method', 'PUT',
        f'repos/{REPOSITORY}/contents/{RESPONSE_PATH}', '--input', str(upload)],
        capture_output=True, timeout=8)
    require(p.returncode == 0 and len(p.stdout) <= 65536, 'T54_BROKER_GITHUB_PUT_FAILED')
    result = parse(p.stdout)
    require(isinstance(result, dict) and result.get('content', {}).get('path') == RESPONSE_PATH,
            'T54_BROKER_GITHUB_PUT_READBACK')
    content_sha = result['content'].get('sha')
    wanted_sha = hashlib.sha1(b'blob ' + str(len(response_raw)).encode() + b'\0' + response_raw).hexdigest()
    require(content_sha == wanted_sha, 'T54_BROKER_GITHUB_PUT_CONTENT_SHA')
    return content_sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--job-directory', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true')
    mode.add_argument('--poll-and-claim', action='store_true')
    mode.add_argument('--receive-raw-json')
    mode.add_argument('--record-mcp-failure', choices=['MCP_RPC_FAILED', 'MCP_RAW_BOUND'])
    parser.add_argument('--failure-json')
    args = parser.parse_args()
    try:
        helper, decoder, query = context(args.manifest, args.sha256)
        job = args.job_directory
        if args.prepare:
            os.mkdir(job, 0o700)
            private_directory(job)
            durable_new(job / 'broker-prepared.json', canonical({'task': 'T54',
                'manifestSha256': args.sha256, 'querySha256': QUERY_SHA, 'workerId': WORKER}))
            output = {'status': 'BROKER_PREPARED', 'query': query.decode(), 'projectId': helper.PROJECT}
        elif args.poll_and_claim:
            private_directory(job)
            require(not (job / 'mcp-claim.json').exists(), 'T54_BROKER_ALREADY_CLAIMED')
            raw = github_read()
            if raw is None:
                output = {'status': 'WAITING'}
            else:
                now = time.time_ns() // 1000000
                request, request_raw = validate_envelope(raw, args.sha256, helper, now)
                durable_new(job / 'github-request-envelope.json', raw)
                durable_new(job / 'request.json', request_raw)
                durable_new(job / 'mcp-claim.json', canonical({'task': 'T54',
                    'manifestSha256': args.sha256, 'requestSha256': sha(request_raw),
                    'claimedEpochMs': now, 'mcpAllowanceClaimed': 1}))
                output = {'status': 'MCP_CLAIMED', 'requestSha256': sha(request_raw),
                          'createdEpochMs': request['createdEpochMs']}
        elif args.record_mcp_failure:
            private_directory(job)
            claim = parse(read(job / 'mcp-claim.json', True))
            require(claim.get('manifestSha256') == args.sha256, 'T54_BROKER_CLAIM_BINDING')
            output = {'task': 'T54', 'status': 'BLOCKED',
                      'code': 'T54_BROKER_' + args.record_mcp_failure,
                      'mcpCallAttempted': True, 'retryAuthorized': False}
            durable_new(job / 'mcp-failure.json', canonical(output))
            if args.failure_json is not None:
                detail_raw = args.failure_json.encode()
                require(0 < len(detail_raw) <= 32768, 'T54_BROKER_FAILURE_BOUND')
                # Keep an approval/transport failure reason private for truthful reporting.
                durable_new(job / 'mcp-failure-detail.json', detail_raw)
        else:
            private_directory(job)
            request_raw = read(job / 'request.json', True)
            request = helper.validate_request(request_raw)
            claim = parse(read(job / 'mcp-claim.json', True))
            require(claim.get('requestSha256') == sha(request_raw)
                    and claim.get('manifestSha256') == args.sha256, 'T54_BROKER_CLAIM_BINDING')
            raw = args.receive_raw_json.encode()
            require(0 < len(raw) <= 131072, 'T54_BROKER_RAW_BOUND')
            # Durable custody precedes ALL result interpretation, including provider errors.
            durable_new(job / 'mcp-raw-result.json', raw)
            row = decoder.decode(raw)
            now = time.time_ns() // 1000000
            response = {'format': 1, 'task': 'T54', 'actionId': helper.ACTION,
                'status': 'SOURCE_FENCE_VERIFIED', 'requestSha256': sha(request_raw),
                'nonceSha256': request['nonceSha256'], 'sourceProject': helper.PROJECT,
                'verifyFencedSqlSha256': helper.SQL_SHA, 'sourceBarrierReceiptSha256': helper.BARRIER_SHA,
                'sourceCheckedMicros': row['source_checked_micros'], 'workerId': WORKER,
                'observedUtc': datetime.fromtimestamp(now / 1000, timezone.utc).isoformat(timespec='milliseconds')}
            response_raw = canonical(response)
            helper.validate_response(response_raw, request_raw, now)
            require(now < request['createdEpochMs'] + 27000, 'T54_BROKER_DELIVERY_TOO_LATE')
            durable_new(job / 'response.json', response_raw)
            git_sha = publish_response(job, response_raw)
            output = {'status': 'RESPONSE_PUBLISHED', 'responseSha256': sha(response_raw),
                'rawSha256': sha(raw), 'githubBlobSha': git_sha,
                'sourceCheckedMicros': row['source_checked_micros'], 'brokerMcpCalls': 1}
            durable_new(job / 'broker-result.json', canonical(output))
        print(json.dumps(output, sort_keys=True, separators=(',', ':')))
        return 2 if output.get('status') == 'BLOCKED' else 0
    except Exception as error:
        code = str(error) if isinstance(error, BrokerError) else 'T54_BROKER_FAILED'
        if re.fullmatch(r'(?:T54_|MCP_FENCE_)[A-Z0-9_]+', str(error)):
            code = str(error)
        print(json.dumps({'status': 'BLOCKED', 'code': code}, sort_keys=True))
        return 2


if __name__ == '__main__':
    sys.exit(main())
