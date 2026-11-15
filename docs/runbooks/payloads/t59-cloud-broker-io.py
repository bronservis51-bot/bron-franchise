#!/usr/bin/env python3
"""Cloud custody for the five fixed T59 technical MCP checks. No SQL client."""
import argparse
import base64
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
BRANCH = 'ops/t59-final-relay-20261115'
PREFIX = '.release-control/t59/'
WORKER = 'cloud-supabase-mcp-github-relay'
PROJECT = 'vkkqffvmztpzgygzfxhq'
BARRIER_ACTION = 'T40.http_source_admission'
BARRIER_SHA = '0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6'
VERIFY_SHA = 'fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782'
BASE_QUERY_SHA = '0f283284119a80520ed2c9f72273913da317961be6c6c7148b6f0c781b4bfd15'
DECODER_SHA = '28e9b858332946333752279f8a9ef8a94a36b46ba15c62c9bc305f7535f4a5aa'
STAGES = ('ready', 'start', 'before-target-write', 'before-final-audit', 'end')
VPS_DIR = '/root/bron-secrets/t59-release'
RELAY = {'repository': REPOSITORY, 'branch': BRANCH, 'requestPrefix': PREFIX, 'workerId': WORKER}
CONTEXT_KEYS = {'format', 'protocol', 'actionId', 'manifestSha256', 'sourceProject',
    'sourceBarrierActionId', 'sourceBarrierReceiptSha256', 'verifyFencedSqlSha256',
    'stage', 'nonceSha256', 'createdEpochMs', 'expiresEpochMs', 'requestPath', 'ackPath',
    'requestSha256', 'storageUid', 'storageGid', 'storageMode'}
ENVELOPE_KEYS = {'format', 'task', 'protocol', 'manifestSha256', 'stage', 'contextSha256', 'context'}


class BrokerError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise BrokerError(code)


def digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                       allow_nan=False) + '\n').encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def parse(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'T59_BROKER_DUPLICATE_KEY')
            value[key] = item
        return value
    def bad_constant(_):
        raise BrokerError('T59_BROKER_JSON_NONFINITE')
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=bad_constant)
    except BrokerError:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise BrokerError('T59_BROKER_JSON_INVALID') from None


def private_directory(path):
    s = path.lstat()
    require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode)
            and s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700,
            'T59_BROKER_DIRECTORY')


def read(path, private=False, maximum=131072):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        a = os.fstat(fd)
        require(stat.S_ISREG(a.st_mode) and a.st_nlink == 1 and 0 < a.st_size <= maximum,
                'T59_BROKER_INPUT_FILE')
        require(not private or a.st_uid == os.getuid() and stat.S_IMODE(a.st_mode) == 0o600,
                'T59_BROKER_PRIVATE_FILE')
        raw = os.read(fd, maximum + 1)
        b, named = os.fstat(fd), path.lstat()
        require(len(raw) == a.st_size == b.st_size and a.st_dev == b.st_dev == named.st_dev
                and a.st_ino == b.st_ino == named.st_ino and a.st_mtime_ns == b.st_mtime_ns
                and a.st_ctime_ns == b.st_ctime_ns, 'T59_BROKER_INPUT_CHANGED')
        return raw
    finally:
        os.close(fd)


def durable_new(path, raw):
    private_directory(path.parent)
    require(0 < len(raw) <= 131072, 'T59_BROKER_WRITE_BOUND')
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
    require(read(path, True) == raw, 'T59_BROKER_READBACK')


def dependency(path, pin, name=None):
    raw = read(path)
    require(sha(raw) == pin, 'T59_BROKER_DEPENDENCY_SHA')
    if name is None:
        return raw
    module = types.ModuleType(name); module.__file__ = str(path)
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    return module


def load_scope(manifest_path, pin):
    require(digest(pin), 'T59_BROKER_MANIFEST_PIN')
    raw = read(manifest_path); require(sha(raw) == pin, 'T59_BROKER_MANIFEST_SHA')
    m = parse(raw)
    require(m.get('task') == 'T59' and m.get('actionId') == 'T59.release_window'
            and m.get('execution_authorized') is True and m.get('mcpRelay') == RELAY,
            'T59_BROKER_SCOPE')
    base = Path(__file__).parent
    decoder = dependency(base / 'mcp-fence-result.py', DECODER_SHA, 't59_relay_decoder')
    query = dependency(base / 't50-verify-fenced.sql', BASE_QUERY_SHA)
    return decoder, query


def vps_paths(stage):
    require(stage in STAGES, 'T59_BROKER_STAGE')
    if stage == 'ready':
        return VPS_DIR + '/coordinator-ready.request.json', VPS_DIR + '/coordinator-ready.json'
    stem = VPS_DIR + '/fence-check-' + stage
    return stem + '.request.json', stem + '.ack.json'


def validate_context(value, manifest_sha, stage, now_ms):
    require(digest(manifest_sha) and isinstance(value, dict) and set(value) == CONTEXT_KEYS,
            'T59_BROKER_CONTEXT_SHAPE')
    require(stage in STAGES and value['stage'] == stage and type(value['format']) is int
            and value['format'] == 1, 'T59_BROKER_CONTEXT_SHAPE')
    protocol = 'T59.preflight_nonce' if stage == 'ready' else 'BRON_COORDINATOR_FENCE_REQUEST_V1'
    action = 'T59.coordinator_ready' if stage == 'ready' else 'T59.final_https_window'
    require(value['protocol'] == protocol and value['actionId'] == action
            and value['manifestSha256'] == manifest_sha and value['sourceProject'] == PROJECT
            and value['sourceBarrierActionId'] == BARRIER_ACTION
            and value['sourceBarrierReceiptSha256'] == BARRIER_SHA
            and value['verifyFencedSqlSha256'] == VERIFY_SHA
            and digest(value['nonceSha256']) and digest(value['requestSha256']),
            'T59_BROKER_CONTEXT_BINDING')
    require((value['requestPath'], value['ackPath']) == vps_paths(stage)
            and type(value['storageUid']) is int and value['storageUid'] == 0
            and type(value['storageGid']) is int and value['storageGid'] == 0
            and type(value['storageMode']) is int and value['storageMode'] == 0o600,
            'T59_BROKER_CONTEXT_CUSTODY')
    require(type(value['createdEpochMs']) is int and type(value['expiresEpochMs']) is int
            and 1000000000000 <= value['createdEpochMs'] <= 9007199254740991
            and value['expiresEpochMs'] == value['createdEpochMs'] + 60000
            and type(now_ms) is int and value['createdEpochMs'] - 5000 <= now_ms < value['expiresEpochMs'],
            'T59_BROKER_CONTEXT_EXPIRED')
    return value


def validate_envelope(raw, pin, stage, now_ms):
    require(0 < len(raw) <= 16384, 'T59_BROKER_ENVELOPE_BOUND')
    value = parse(raw)
    require(isinstance(value, dict) and set(value) == ENVELOPE_KEYS and canonical(value) == raw
            and type(value['format']) is int and value['format'] == 1 and value['task'] == 'T59'
            and value['protocol'] == 'BRON_GITHUB_FENCE_WINDOW_V1'
            and value['manifestSha256'] == pin and value['stage'] == stage,
            'T59_BROKER_ENVELOPE')
    context = validate_context(value['context'], pin, stage, now_ms)
    require(value['contextSha256'] == sha(canonical(context)), 'T59_BROKER_CONTEXT_SHA')
    admission_age = 20000 if stage == 'ready' else 45000
    require(now_ms < context['createdEpochMs'] + admission_age, 'T59_BROKER_REQUEST_TOO_OLD')
    return context


def query_for(context, base):
    require(sha(base) == BASE_QUERY_SHA, 'T59_BROKER_BASE_QUERY_SHA')
    comment = {'task': 'T59', 'stage': context['stage'], 'contextSha256': sha(canonical(context)),
               'nonceSha256': context['nonceSha256'], 'requestSha256': context['requestSha256']}
    return b'-- BRON_T59_FENCE_CONTEXT ' + canonical(comment).rstrip(b'\n') + b'\n' + base


def build_response(context, pin, source_clock, now_ms):
    stage = context['stage']; validate_context(context, pin, stage, now_ms)
    require(isinstance(source_clock, str) and re.fullmatch('[0-9]{12,20}', source_clock),
            'T59_BROKER_SOURCE_CLOCK')
    require((context['createdEpochMs'] - 5000) * 1000 <= int(source_clock) <= (now_ms + 5000) * 1000,
            'T59_BROKER_SOURCE_CLOCK')
    common = {k: context[k] for k in ['actionId', 'manifestSha256', 'sourceProject',
              'sourceBarrierActionId', 'sourceBarrierReceiptSha256', 'verifyFencedSqlSha256']}
    if stage == 'ready':
        require(now_ms < context['createdEpochMs'] + 27000, 'T59_BROKER_READY_DELIVERY_TOO_LATE')
        return {'format': 1, 'protocol': 'BRON_T59_READY_RESPONSE_V1', 'task': 'T59', **common,
                'requestSha256': context['requestSha256'], 'contextSha256': sha(canonical(context)),
                'nonceSha256': context['nonceSha256'], 'sourceCheckedMicros': source_clock,
                'workerId': WORKER, 'connector': 'Supabase MCP'}
    require(now_ms < context['expiresEpochMs'] - 3000, 'T59_BROKER_ACK_DELIVERY_TOO_LATE')
    ack = {'format': 1, 'protocol': 'BRON_COORDINATOR_FENCE_ACK_V1', **common,
           'stage': stage, 'nonceSha256': context['nonceSha256'], 'sourceCheckedMicros': source_clock,
           'expiresEpochMs': context['expiresEpochMs'], 'normalConnectDenied': True,
           'existingClientsDrained': True, 'providerBoundaryReviewed': True}
    raw = canonical(ack)
    return {'ackJson': raw.decode(), 'rootAckSha256': sha(raw)}


def assert_healthy(job):
    try:
        (job / 'broker-failure.json').lstat()
    except FileNotFoundError:
        return
    raise BrokerError('T59_BROKER_FAILED_HOLD_SOURCE_CLOSED')


def require_stage_order(job, stage, pin):
    require(stage in STAGES, 'T59_BROKER_STAGE')
    index = STAGES.index(stage)
    for previous in STAGES[:index]:
        result = parse(read(job / ('result-' + previous + '.json'), True))
        require(result.get('status') == 'RESPONSE_PUBLISHED' and result.get('stage') == previous
                and result.get('manifestSha256') == pin, 'T59_BROKER_STAGE_ORDER')
    for future in STAGES[index:]:
        require(not (job / ('claim-' + future + '.json')).exists(), 'T59_BROKER_STAGE_ALREADY_CLAIMED')


def github_read(stage):
    path = PREFIX + stage + '.request.json'
    p = subprocess.run(['gh', 'api', '-H', 'Cache-Control: no-cache',
        f'repos/{REPOSITORY}/contents/{path}?ref={BRANCH}'], capture_output=True, timeout=8)
    require(len(p.stdout) <= 65536, 'T59_BROKER_GITHUB_BODY_BOUND')
    value = parse(p.stdout) if p.stdout else {}
    if p.returncode != 0:
        if isinstance(value, dict) and str(value.get('status')) == '404':
            return None
        raise BrokerError('T59_BROKER_GITHUB_READ_FAILED')
    require(isinstance(value, dict) and value.get('type') == 'file' and value.get('encoding') == 'base64'
            and value.get('path') == path, 'T59_BROKER_GITHUB_RESPONSE')
    try:
        raw = base64.b64decode(value['content'], validate=False)
    except (ValueError, TypeError):
        raise BrokerError('T59_BROKER_GITHUB_CONTENT') from None
    require(len(raw) <= 16384, 'T59_BROKER_GITHUB_CONTENT')
    return raw


def github_publish(job, stage, response_raw):
    payload = {'branch': BRANCH, 'message': 'ops: T59 technical ' + stage + ' response [skip ci]',
               'content': base64.b64encode(response_raw).decode()}
    upload = job / ('github-upload-' + stage + '.json'); durable_new(upload, canonical(payload))
    path = PREFIX + stage + '.response.json'
    assert_healthy(job)
    p = subprocess.run(['gh', 'api', '--method', 'PUT',
        f'repos/{REPOSITORY}/contents/{path}', '--input', str(upload)], capture_output=True, timeout=8)
    require(p.returncode == 0 and len(p.stdout) <= 65536, 'T59_BROKER_GITHUB_PUT_FAILED')
    value = parse(p.stdout)
    wanted = hashlib.sha1(b'blob ' + str(len(response_raw)).encode() + b'\0' + response_raw).hexdigest()
    require(isinstance(value, dict) and value.get('content', {}).get('path') == path
            and value['content'].get('sha') == wanted, 'T59_BROKER_GITHUB_PUT_READBACK')
    return wanted


def record_failure(job, code, stage):
    try:
        durable_new(job / 'broker-failure.json', canonical({'task': 'T59', 'status': 'BLOCKED',
            'stage': stage, 'code': code, 'sourceMustRemainClosed': True, 'retryAuthorized': False}))
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True); parser.add_argument('--sha256', required=True)
    parser.add_argument('--job-directory', type=Path, required=True)
    parser.add_argument('--stage', choices=STAGES)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true'); mode.add_argument('--poll-and-claim', action='store_true')
    mode.add_argument('--receive-raw-json'); mode.add_argument('--record-mcp-failure', action='store_true')
    parser.add_argument('--failure-json')
    args = parser.parse_args(); job = args.job_directory
    try:
        decoder, base = load_scope(args.manifest, args.sha256)
        if args.prepare:
            require(args.stage is None, 'T59_BROKER_STAGE')
            os.mkdir(job, 0o700); private_directory(job)
            durable_new(job / 'broker-prepared.json', canonical({'task': 'T59',
                'manifestSha256': args.sha256, 'baseQuerySha256': BASE_QUERY_SHA,
                'workerId': WORKER, 'stages': list(STAGES)}))
            output = {'status': 'BROKER_PREPARED', 'projectId': PROJECT, 'stages': list(STAGES)}
        else:
            private_directory(job); assert_healthy(job); require(args.stage in STAGES, 'T59_BROKER_STAGE')
            stage = args.stage
            if args.poll_and_claim:
                require_stage_order(job, stage, args.sha256)
                raw = github_read(stage)
                if raw is None:
                    output = {'status': 'WAITING', 'stage': stage}
                else:
                    now = time.time_ns() // 1000000
                    context = validate_envelope(raw, args.sha256, stage, now)
                    if STAGES.index(stage):
                        previous = parse(read(job / ('context-' + STAGES[STAGES.index(stage) - 1] + '.json'), True))
                        require(context['createdEpochMs'] >= previous['createdEpochMs']
                                and context['nonceSha256'] != previous['nonceSha256'], 'T59_BROKER_STAGE_REPLAY')
                    query = query_for(context, base)
                    durable_new(job / ('envelope-' + stage + '.json'), raw)
                    durable_new(job / ('context-' + stage + '.json'), canonical(context))
                    durable_new(job / ('query-' + stage + '.sql'), query)
                    durable_new(job / ('claim-' + stage + '.json'), canonical({'task': 'T59',
                        'stage': stage, 'manifestSha256': args.sha256, 'contextSha256': sha(canonical(context)),
                        'querySha256': sha(query), 'claimedEpochMs': now, 'mcpAllowanceClaimed': 1}))
                    output = {'status': 'MCP_CLAIMED', 'stage': stage, 'projectId': PROJECT,
                              'query': query.decode(), 'contextSha256': sha(canonical(context))}
            else:
                context = parse(read(job / ('context-' + stage + '.json'), True))
                claim = parse(read(job / ('claim-' + stage + '.json'), True))
                require(claim.get('manifestSha256') == args.sha256 and claim.get('stage') == stage
                        and claim.get('contextSha256') == sha(canonical(context))
                        and claim.get('querySha256') == sha(query_for(context, base)), 'T59_BROKER_CLAIM_BINDING')
                if args.record_mcp_failure:
                    if args.failure_json is not None:
                        raw = args.failure_json.encode(); require(len(raw) <= 32768, 'T59_BROKER_FAILURE_BOUND')
                        durable_new(job / ('mcp-failure-detail-' + stage + '.json'), raw)
                    raise BrokerError('T59_BROKER_MCP_RPC_FAILED')
                raw = args.receive_raw_json.encode(); require(0 < len(raw) <= 131072, 'T59_BROKER_RAW_BOUND')
                # This durable write precedes ALL provider-result interpretation.
                durable_new(job / ('mcp-raw-' + stage + '.json'), raw)
                row = decoder.decode(raw)
                now = time.time_ns() // 1000000
                response = canonical(build_response(context, args.sha256, row['source_checked_micros'], now))
                assert_healthy(job)
                durable_new(job / ('response-' + stage + '.json'), response)
                git_sha = github_publish(job, stage, response)
                output = {'task': 'T59', 'status': 'RESPONSE_PUBLISHED', 'stage': stage,
                    'manifestSha256': args.sha256, 'contextSha256': sha(canonical(context)),
                    'responseSha256': sha(response), 'rawSha256': sha(raw), 'githubBlobSha': git_sha,
                    'sourceCheckedMicros': row['source_checked_micros'], 'brokerMcpCallsThisStage': 1}
                durable_new(job / ('result-' + stage + '.json'), canonical(output))
        print(json.dumps(output, sort_keys=True, separators=(',', ':'))); return 0
    except Exception as error:
        value = str(error)
        code = value if re.fullmatch(r'(?:T59_|MCP_FENCE_)[A-Z0-9_]+', value) else 'T59_BROKER_FAILED'
        if job.exists():
            record_failure(job, code, args.stage)
        print(json.dumps({'task': 'T59', 'status': 'BLOCKED', 'stage': args.stage, 'code': code,
                          'sourceMustRemainClosed': True}, sort_keys=True)); return 2


if __name__ == '__main__':
    sys.exit(main())
