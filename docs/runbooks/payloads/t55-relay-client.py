#!/usr/bin/env python3
"""One technical GitHub relay proof using existing strict SSH and gh credentials."""
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
SELF = 'docs/runbooks/payloads/t55-relay-client.py'
HELPER = 'docs/runbooks/payloads/t55-mcp-ready.py'
HOST = 'root@152.228.115.115'
RELAY = {'repository': 'bronservis51-bot/bron-franchise',
         'branch': 'ops/t55-ack-relay-20261115',
         'requestPath': '.release-control/t55-proof/request.json',
         'responsePath': '.release-control/t55-proof/response.json',
         'workerId': 'cloud-supabase-mcp-github-relay'}
PASS_CODE = 'T55_AUTOMATIC_MCP_RELAY_PROVEN'
MAX = 131072


class ClientError(Exception):
    pass


def need(ok, code):
    if not ok:
        raise ClientError(code)


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'),
                       ensure_ascii=True, allow_nan=False) + '\n').encode()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def parse(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'T55_CLIENT_DUPLICATE_KEY')
            result[key] = value
        return result
    def constant(_):
        raise ClientError('T55_CLIENT_JSON_CONSTANT')
    need(isinstance(raw, bytes) and 0 < len(raw) <= MAX, 'T55_CLIENT_JSON_BOUND')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise ClientError('T55_CLIENT_JSON_INVALID') from None


def read(path, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and 0 < s.st_size <= MAX,
             'T55_CLIENT_INPUT_FILE')
        need(not private or (s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600),
             'T55_CLIENT_PRIVATE_INPUT')
        raw = os.read(fd, MAX + 1)
        a, n = os.fstat(fd), Path(path).lstat()
        need(len(raw) == s.st_size == a.st_size and s.st_ino == a.st_ino == n.st_ino and
             s.st_dev == a.st_dev == n.st_dev and s.st_mtime_ns == a.st_mtime_ns and
             s.st_ctime_ns == a.st_ctime_ns, 'T55_CLIENT_INPUT_CHANGED')
        return raw
    finally:
        os.close(fd)


def directory(path):
    s = path.lstat()
    need(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and
         s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700,
         'T55_CLIENT_DIRECTORY')


def write_new(path, raw):
    directory(path.parent)
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
    need(read(path, True) == raw, 'T55_CLIENT_WRITE_READBACK')


def ssh_argv(raw):
    value = parse(raw)
    need(isinstance(value, dict) and set(value) == {'argv'}, 'T55_CLIENT_SSH_SHAPE')
    args = value['argv']
    need(isinstance(args, list) and 2 <= len(args) <= 64 and
         all(isinstance(x, str) and 0 < len(x) <= 8192 and '\x00' not in x for x in args) and
         Path(args[0]).name == 'ssh' and args[-1] == HOST, 'T55_CLIENT_SSH_TARGET')
    options = [x.lower().replace(' ', '') for x in args[1:-1]]
    strict = [x for x in options if 'stricthostkeychecking=' in x]
    need(strict and all(x in ('stricthostkeychecking=yes', '-ostricthostkeychecking=yes')
                        for x in strict), 'T55_CLIENT_STRICT_HOSTKEY_REQUIRED')
    need(not any(x in ('-M', '-S', '-n') for x in args[1:-1]) and
         not any('controlmaster=' in x or 'controlpersist=' in x or 'stdinnull=yes' in x
                 for x in options), 'T55_CLIENT_NO_NEW_CONTROLMASTER')
    return args


def process(args, data=None, timeout=10):
    try:
        result = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ClientError('T55_CLIENT_PROCESS_TIMEOUT') from None
    need(len(result.stdout) <= MAX, 'T55_CLIENT_PROCESS_OUTPUT_BOUND')
    return result


def gh_read(path):
    endpoint = 'repos/' + RELAY['repository'] + '/contents/' + path + '?ref=' + RELAY['branch']
    result = process(['gh', 'api', '-H', 'Cache-Control: no-cache', endpoint], timeout=5)
    if result.returncode != 0:
        if re.search(rb'HTTP 404\b', result.stderr):
            return None
        raise ClientError('T55_CLIENT_GITHUB_READ_FAILED')
    item = parse(result.stdout)
    need(isinstance(item, dict) and item.get('type') == 'file' and item.get('path') == path and
         item.get('encoding') == 'base64' and isinstance(item.get('content'), str),
         'T55_CLIENT_GITHUB_SHAPE')
    try:
        raw = base64.b64decode(''.join(item['content'].split()), validate=True)
    except ValueError:
        raise ClientError('T55_CLIENT_GITHUB_BASE64') from None
    need(0 < len(raw) <= 16384, 'T55_CLIENT_GITHUB_BODY_BOUND')
    return raw


def gh_publish_request(raw):
    body = {'message': 'T55 technical readiness request [skip ci]', 'branch': RELAY['branch'],
            'content': base64.b64encode(raw).decode()}
    # No sha is supplied: the Contents API refuses replacing an existing file.
    result = process(['gh', 'api', '--method', 'PUT',
        'repos/' + RELAY['repository'] + '/contents/' + RELAY['requestPath'], '--input', '-'],
        encode(body), timeout=5)
    need(result.returncode == 0, 'T55_CLIENT_GITHUB_CREATE_FAILED')


def gh_branch_exists():
    result = process(['gh', 'api', 'repos/' + RELAY['repository'] +
                      '/git/ref/heads/' + RELAY['branch']], timeout=5)
    need(result.returncode == 0, 'T55_CLIENT_RELAY_BRANCH_MISSING')
    ref = parse(result.stdout)
    need(ref.get('ref') == 'refs/heads/' + RELAY['branch'] and
         ref.get('object', {}).get('type') == 'commit' and
         re.fullmatch('[a-f0-9]{40}', ref['object'].get('sha', '')),
         'T55_CLIENT_RELAY_BRANCH_INVALID')


def load(manifest_path, pin):
    raw = read(manifest_path)
    need(re.fullmatch('[a-f0-9]{64}', pin) and sha(raw) == pin, 'T55_CLIENT_MANIFEST_SHA')
    manifest = parse(raw)
    need(isinstance(manifest, dict) and manifest.get('task') == 'T55' and
         manifest.get('execution_authorized') is True and manifest.get('relay') == RELAY and
         isinstance(manifest.get('files'), dict), 'T55_CLIENT_MANIFEST_SCOPE')
    repo = manifest_path.resolve().parents[3]
    for name, expected in manifest['files'].items():
        p = Path(name)
        need(not p.is_absolute() and '..' not in p.parts and re.fullmatch('[a-f0-9]{64}', expected)
             and sha(read(repo / p)) == expected, 'T55_CLIENT_FILE_PIN')
    need(SELF in manifest['files'] and HELPER in manifest['files'] and
         sha(read(Path(__file__))) == manifest['files'][SELF], 'T55_CLIENT_SELF_PIN')
    helper_raw = read(repo / HELPER)
    helper = types.ModuleType('verified_t55_custody'); helper.__file__ = str(repo / HELPER)
    exec(compile(helper_raw, helper.__file__, 'exec'), helper.__dict__)
    return helper


def preflight(pin, ssh, job):
    directory(job)
    gh_branch_exists()
    need(gh_read(RELAY['requestPath']) is None and gh_read(RELAY['responsePath']) is None,
         'T55_CLIENT_RELAY_ALREADY_USED')
    checked = process(ssh + ['printf T55_RELAY_SSH_READY'], timeout=10)
    need(checked.returncode == 0 and checked.stdout == b'T55_RELAY_SSH_READY',
         'T55_CLIENT_SSH_PREFLIGHT_FAILED')
    return {'task': 'T55', 'actionId': 'T55.github_relay_client',
            'status': 'T55_CLIENT_READY_NO_PREPARE', 'manifestSha256': pin,
            'sshArgvSha256': sha(encode(ssh)), 'observedEpochMs': time.time_ns() // 1000000,
            'prepareAttempted': False, 'completeAttempted': False, 'sourceQueriesByClient': 0,
            'snapshotAttemptsUsed': 0, 'targetWrites': 0, 'macDataTransit': False}


def validate_preflight(value, pin, ssh, now):
    need(isinstance(value, dict) and value.get('task') == 'T55' and
         value.get('actionId') == 'T55.github_relay_client' and
         value.get('status') == 'T55_CLIENT_READY_NO_PREPARE' and value.get('manifestSha256') == pin and
         value.get('sshArgvSha256') == sha(encode(ssh)) and value.get('prepareAttempted') is False and
         value.get('completeAttempted') is False and type(value.get('observedEpochMs')) is int and
         0 <= now - value['observedEpochMs'] <= 900000, 'T55_CLIENT_PREFLIGHT_NOT_CURRENT')


def run_proof(helper, pin, ssh, job, actions=None, previous_preflight=None):
    if actions is None:
        actions = {}
    directory(job)
    gh_branch_exists()
    need(gh_read(RELAY['requestPath']) is None and gh_read(RELAY['responsePath']) is None,
         'T55_CLIENT_RELAY_ALREADY_USED')
    if previous_preflight is None:
        checked = process(ssh + ['printf T55_RELAY_SSH_READY'], timeout=10)
        need(checked.returncode == 0 and checked.stdout == b'T55_RELAY_SSH_READY',
             'T55_CLIENT_SSH_PREFLIGHT_FAILED')
    else:
        validate_preflight(previous_preflight, pin, ssh, time.time_ns() // 1000000)
    write_new(job / 'client-run.guard.json', encode({'task': 'T55',
        'actionId': 'T55.github_relay_client', 'manifestSha256': pin}))
    actions.update(phase='prepare', prepareAttempted=True)
    prepared = process(ssh + ['python3 -I /root/bron-secrets/t55-mcp-ready.py --prepare'], timeout=10)
    need(prepared.returncode == 0, 'T55_CLIENT_PREPARE_FAILED')
    request = helper.validate_request(prepared.stdout)
    actions['prepareValidated'] = True
    started = time.monotonic()
    write_new(job / 'fresh-request.json', prepared.stdout)
    envelope = {'format': 1, 'task': 'T55', 'protocol': 'BRON_GITHUB_FENCE_PROOF_V1',
                'manifestSha256': pin, 'requestSha256': sha(prepared.stdout), 'request': request}
    gh_publish_request(encode(envelope))
    actions.update(phase='wait-broker', requestPublished=True)
    response = None
    while time.monotonic() - started < 25:
        response = gh_read(RELAY['responsePath'])
        if response is not None:
            break
        time.sleep(min(2, max(0, 25 - (time.monotonic() - started))))
    need(response is not None, 'T55_CLIENT_BROKER_RESPONSE_TIMEOUT')
    helper.validate_response(response, prepared.stdout, time.time_ns() // 1000000)
    actions['brokerResponseValidated'] = True
    need(time.monotonic() - started < 27, 'T55_CLIENT_DELIVERY_HEADROOM')
    write_new(job / 'response.json', response)
    actions.update(phase='complete', completeAttempted=True)
    completed = process(ssh + ['python3 -I /root/bron-secrets/t55-mcp-ready.py --complete'],
                        response, timeout=max(1, 30 - (time.monotonic() - started)))
    if completed.stdout:
        write_new(job / 'vps-proof-result.json', completed.stdout)
    actions['completeExit'] = completed.returncode
    need(completed.returncode == 0, 'T55_CLIENT_COMPLETE_FAILED')
    outcome = parse(completed.stdout)
    need(isinstance(outcome, dict) and outcome.get('task') == 'T55' and outcome.get('status') == 'PASS' and
         outcome.get('code') == PASS_CODE and outcome.get('sourceVerifyPassed') is True and
         outcome.get('requestSha256') == sha(prepared.stdout) and
         outcome.get('nonceSha256') == request['nonceSha256'] and
         outcome.get('responseSha256') == sha(response) and
         type(outcome.get('roundTripMs')) is int and 0 <= outcome['roundTripMs'] <= 30000 and
         type(outcome.get('monotonicRoundTripMs')) is int and 0 <= outcome['monotonicRoundTripMs'] <= 30000 and
         outcome.get('snapshotAttemptsUsed') == 0 and outcome.get('targetWrites') == 0 and
         outcome.get('macDataTransit') is False, 'T55_CLIENT_PROOF_NOT_PASS')
    actions.update(phase='done', completeValidated=True)
    return {'task': 'T55', 'status': 'PASS', 'actionId': 'T55.github_relay_client',
            'manifestSha256': pin, 'requestSha256': sha(prepared.stdout), 'responseSha256': sha(response),
            'vpsResultSha256': sha(completed.stdout), 'roundTripMs': outcome['roundTripMs'],
            'monotonicRoundTripMs': outcome['monotonicRoundTripMs'], 'snapshotAttemptsUsed': 0,
            'targetWrites': 0, 'macDataTransit': False, 'actions': actions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--ssh-options-json', required=True, type=Path)
    parser.add_argument('--directory', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--run', action='store_true')
    args = parser.parse_args()
    actions = {'phase': 'preflight', 'prepareAttempted': False, 'completeAttempted': False}
    try:
        helper = load(args.manifest, args.sha256)
        ssh = ssh_argv(read(args.ssh_options_json, True))
        if args.preflight:
            result = preflight(args.sha256, ssh, args.directory)
        else:
            saved = parse(read(args.directory / 'client-preflight.json', True))
            result = run_proof(helper, args.sha256, ssh, args.directory, actions, saved)
    except Exception as error:
        code = str(error) if isinstance(error, ClientError) else 'T55_CLIENT_FAILED'
        result = {'task': 'T55', 'status': 'BLOCKED', 'actionId': 'T55.github_relay_client',
                  'code': code, 'snapshotAttemptsUsed': 0, 'targetWrites': 0,
                  'sourceFenceCurrent': 'UNVERIFIED', 'sourceMustRemainClosed': True,
                  'macDataTransit': False, 'actions': actions}
    try:
        filename = 'client-preflight.json' if args.preflight else 'client-result.json'
        write_new(args.directory / filename, encode(result))
    except Exception:
        result['receiptWriteFailed'] = True
        result['status'] = 'BLOCKED'
    print(encode(result).decode(), end='')
    return 0 if result['status'] in ('PASS', 'T55_CLIENT_READY_NO_PREPARE') else 2


if __name__ == '__main__':
    sys.exit(main())
