#!/usr/bin/env python3
"""T60 control-plane-only driver: five fresh Root MCP replies, no working data."""
import argparse
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shlex
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
SELF = 'docs/runbooks/payloads/t60-relay-driver.py'
LAUNCHER = 'docs/runbooks/payloads/t60-final-window.mjs'
HOST = 'root@152.228.115.115'
NODE = '/opt/bron/node-v22.23.5-linux-x64/bin/node'
REMOTE = '/root/bron-secrets/t60-final-window.mjs'
ROOT = '/root/bron-secrets/t60-release'
PROJECT = 'vkkqffvmztpzgygzfxhq'
BARRIER_ACTION = 'T40.http_source_admission'
BARRIER = '0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6'
VERIFY = 'fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782'
STAGES = ('ready', 'start', 'before-target-write', 'before-final-audit', 'end')
RELAY = {'repository': 'bronservis51-bot/bron-franchise',
         'branch': 'ops/t60-final-relay-20261115',
         'requestPrefix': '.release-control/t60/',
         'workerId': 'cloud-supabase-mcp-github-relay'}
CONTEXT_KEYS = {'format', 'protocol', 'actionId', 'manifestSha256', 'sourceProject',
    'sourceBarrierActionId', 'sourceBarrierReceiptSha256', 'verifyFencedSqlSha256',
    'stage', 'nonceSha256', 'createdEpochMs', 'expiresEpochMs', 'requestPath', 'ackPath',
    'requestSha256', 'storageUid', 'storageGid', 'storageMode'}
ACK_KEYS = {'format', 'protocol', 'actionId', 'manifestSha256', 'sourceProject',
    'sourceBarrierActionId', 'sourceBarrierReceiptSha256', 'verifyFencedSqlSha256',
    'stage', 'nonceSha256', 'sourceCheckedMicros', 'expiresEpochMs',
    'normalConnectDenied', 'existingClientsDrained', 'providerBoundaryReviewed'}
READY_KEYS = {'format', 'protocol', 'task', 'actionId', 'manifestSha256', 'sourceProject',
    'sourceBarrierActionId', 'sourceBarrierReceiptSha256', 'verifyFencedSqlSha256',
    'requestSha256', 'contextSha256', 'nonceSha256', 'sourceCheckedMicros', 'workerId', 'connector'}
MAX = 131072


class DriverError(Exception):
    pass


def need(ok, code):
    if not ok:
        raise DriverError(code)


def digest(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                       allow_nan=False) + '\n').encode()


def parse(raw):
    need(isinstance(raw, bytes) and 0 < len(raw) <= MAX, 'T60_DRIVER_JSON_BOUND')
    def unique(items):
        result = {}
        for key, value in items:
            need(key not in result, 'T60_DRIVER_DUPLICATE_KEY')
            result[key] = value
        return result
    def nonfinite(_):
        raise DriverError('T60_DRIVER_JSON_NONFINITE')
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=nonfinite)
    except (ValueError, UnicodeError, RecursionError):
        raise DriverError('T60_DRIVER_JSON_INVALID') from None


def directory(path):
    s = path.lstat()
    need(path.is_absolute() and path.resolve() == path and stat.S_ISDIR(s.st_mode) and
         not stat.S_ISLNK(s.st_mode) and s.st_uid == os.getuid() and
         stat.S_IMODE(s.st_mode) == 0o700, 'T60_DRIVER_DIRECTORY')


def read(path, private=False, maximum=4194304):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and 0 < s.st_size <= maximum and
             (not private or (s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600)),
             'T60_DRIVER_INPUT_FILE')
        chunks = []; used = 0
        while True:
            chunk = os.read(fd, min(65536, maximum + 1 - used))
            if not chunk:
                break
            chunks.append(chunk); used += len(chunk)
            need(used <= maximum, 'T60_DRIVER_INPUT_BOUND')
        raw = b''.join(chunks); a, n = os.fstat(fd), path.lstat()
        need(len(raw) == s.st_size == a.st_size and s.st_dev == a.st_dev == n.st_dev and
             s.st_ino == a.st_ino == n.st_ino and s.st_mtime_ns == a.st_mtime_ns and
             s.st_ctime_ns == a.st_ctime_ns, 'T60_DRIVER_INPUT_CHANGED')
        return raw
    finally:
        os.close(fd)


def write_new(path, raw):
    directory(path.parent)
    need(isinstance(raw, bytes) and 0 < len(raw) <= MAX, 'T60_DRIVER_WRITE_BOUND')
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
    need(read(path, True) == raw, 'T60_DRIVER_WRITE_READBACK')


def ssh_argv(raw):
    value = parse(raw)
    need(isinstance(value, dict) and set(value) == {'argv'}, 'T60_DRIVER_SSH_SHAPE')
    args = value['argv']
    need(isinstance(args, list) and 2 <= len(args) <= 64 and
         all(isinstance(x, str) and 0 < len(x) <= 8192 and '\x00' not in x for x in args) and
         Path(args[0]).name == 'ssh' and args[-1] == HOST, 'T60_DRIVER_SSH_TARGET')
    options = [x.lower().replace(' ', '') for x in args[1:-1]]
    strict = [x for x in options if 'stricthostkeychecking=' in x]
    need(strict and all(x in ('stricthostkeychecking=yes', '-ostricthostkeychecking=yes')
                        for x in strict), 'T60_DRIVER_STRICT_HOSTKEY')
    need(not any(x in ('-M', '-S', '-n') for x in args[1:-1]) and
         not any('controlmaster=' in x or 'controlpersist=' in x or 'stdinnull=yes' in x
                 for x in options), 'T60_DRIVER_SSH_BASELINE_REQUIRED')
    return args


def process(args, data=None, timeout=10):
    need(timeout > 0, 'T60_DRIVER_DEADLINE')
    try:
        result = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise DriverError('T60_DRIVER_PROCESS_TIMEOUT') from None
    need(len(result.stdout) <= 4194304 and len(result.stderr) <= MAX,
         'T60_DRIVER_PROCESS_BOUND')
    return result


def relay_path(stage, kind):
    need(stage in STAGES and kind in ('request', 'response'), 'T60_DRIVER_RELAY_PATH')
    return RELAY['requestPrefix'] + stage + '.' + kind + '.json'


def gh_read(path, timeout=5):
    endpoint = 'repos/' + RELAY['repository'] + '/contents/' + path + '?ref=' + RELAY['branch']
    result = process(['gh', 'api', '-H', 'Cache-Control: no-cache', endpoint], timeout=timeout)
    if result.returncode != 0:
        if re.search(rb'HTTP 404\b', result.stderr):
            return None
        raise DriverError('T60_DRIVER_GITHUB_READ_FAILED')
    item = parse(result.stdout)
    need(isinstance(item, dict) and item.get('type') == 'file' and item.get('path') == path and
         item.get('encoding') == 'base64' and isinstance(item.get('content'), str),
         'T60_DRIVER_GITHUB_SHAPE')
    try:
        raw = base64.b64decode(''.join(item['content'].split()), validate=True)
    except ValueError:
        raise DriverError('T60_DRIVER_GITHUB_BASE64') from None
    need(0 < len(raw) <= 32768, 'T60_DRIVER_GITHUB_BODY_BOUND')
    return raw


def gh_publish(stage, raw, timeout=5):
    body = {'message': 'T60 ' + stage + ' technical fence request [skip ci]',
            'branch': RELAY['branch'], 'content': base64.b64encode(raw).decode()}
    # No sha: the Contents API rejects overwriting an existing request.
    result = process(['gh', 'api', '--method', 'PUT', 'repos/' + RELAY['repository'] +
        '/contents/' + relay_path(stage, 'request'), '--input', '-'], encode(body), timeout)
    need(result.returncode == 0, 'T60_DRIVER_GITHUB_CREATE_FAILED')


def gh_unused():
    result = process(['gh', 'api', 'repos/' + RELAY['repository'] +
        '/git/ref/heads/' + RELAY['branch']], timeout=5)
    need(result.returncode == 0, 'T60_DRIVER_RELAY_BRANCH_MISSING')
    value = parse(result.stdout)
    need(value.get('ref') == 'refs/heads/' + RELAY['branch'] and
         value.get('object', {}).get('type') == 'commit' and
         re.fullmatch('[a-f0-9]{40}', value['object'].get('sha', '')),
         'T60_DRIVER_RELAY_BRANCH_INVALID')
    for stage in STAGES:
        for kind in ('request', 'response'):
            need(gh_read(relay_path(stage, kind)) is None, 'T60_DRIVER_RELAY_ALREADY_USED')


def paths(stage):
    if stage == 'ready':
        return ROOT + '/coordinator-ready.request.json', ROOT + '/coordinator-ready.json'
    return ROOT + '/fence-check-' + stage + '.request.json', ROOT + '/fence-check-' + stage + '.ack.json'


def validate_context(value, stage, pin, now):
    need(isinstance(value, dict) and set(value) == CONTEXT_KEYS and stage in STAGES,
         'T60_DRIVER_CONTEXT_SHAPE')
    ready = stage == 'ready'
    need(type(value['format']) is int and value['format'] == 1 and value['stage'] == stage and
         value['protocol'] == ('T60.preflight_nonce' if ready else 'BRON_COORDINATOR_FENCE_REQUEST_V1') and
         value['actionId'] == ('T60.coordinator_ready' if ready else 'T60.final_https_window') and
         value['manifestSha256'] == pin and value['sourceProject'] == PROJECT and
         value['sourceBarrierActionId'] == BARRIER_ACTION and value['sourceBarrierReceiptSha256'] == BARRIER and
         value['verifyFencedSqlSha256'] == VERIFY and digest(value['nonceSha256']) and
         digest(value['requestSha256']) and (value['requestPath'], value['ackPath']) == paths(stage) and
         type(value['storageUid']) is int and value['storageUid'] == 0 and
         type(value['storageGid']) is int and value['storageGid'] == 0 and
         type(value['storageMode']) is int and value['storageMode'] == 384,
         'T60_DRIVER_CONTEXT_BINDING')
    need(type(value['createdEpochMs']) is int and type(value['expiresEpochMs']) is int and
         0 <= value['createdEpochMs'] <= now + 5000 and
         value['expiresEpochMs'] - value['createdEpochMs'] == 60000 and
         now < value['expiresEpochMs'], 'T60_DRIVER_CONTEXT_CLOCK')
    return value


def validate_response(raw, context, pin, now):
    value = parse(raw)
    need(encode(value) == raw, 'T60_DRIVER_RESPONSE_NONCANONICAL')
    stage = context['stage']; validate_context(context, stage, pin, now)
    if stage == 'ready':
        need(isinstance(value, dict) and set(value) == READY_KEYS and type(value['format']) is int and
             value['format'] == 1 and value['protocol'] == 'BRON_T60_READY_RESPONSE_V1' and
             value['task'] == 'T60' and value['actionId'] == 'T60.coordinator_ready' and
             value['requestSha256'] == context['requestSha256'] and
             value['contextSha256'] == sha(encode(context)) and
             value['workerId'] == RELAY['workerId'] and value['connector'] == 'Supabase MCP',
             'T60_DRIVER_READY_BINDING')
        ack = value
    else:
        need(isinstance(value, dict) and set(value) == {'ackJson', 'rootAckSha256'} and
             isinstance(value['ackJson'], str) and digest(value['rootAckSha256']) and
             sha(value['ackJson'].encode()) == value['rootAckSha256'], 'T60_DRIVER_ACK_SHA')
        ack = parse(value['ackJson'].encode())
        need(isinstance(ack, dict) and set(ack) == ACK_KEYS and encode(ack).decode() == value['ackJson'] and
             type(ack['format']) is int and ack['format'] == 1 and
             ack['protocol'] == 'BRON_COORDINATOR_FENCE_ACK_V1' and ack['actionId'] == 'T60.final_https_window' and
             ack['stage'] == stage and ack['expiresEpochMs'] == context['expiresEpochMs'] and
             all(ack[k] is True for k in ('normalConnectDenied', 'existingClientsDrained', 'providerBoundaryReviewed')),
             'T60_DRIVER_ACK_BINDING')
    need(all(ack[k] == context[k] for k in ('manifestSha256', 'sourceProject', 'sourceBarrierActionId',
         'sourceBarrierReceiptSha256', 'verifyFencedSqlSha256', 'nonceSha256')),
         'T60_DRIVER_RESPONSE_CONTEXT')
    checked = ack.get('sourceCheckedMicros')
    need(isinstance(checked, str) and re.fullmatch('[0-9]{12,20}', checked) and
         (context['createdEpochMs'] - 5000) * 1000 <= int(checked) <= (now + 5000) * 1000,
         'T60_DRIVER_SOURCE_CLOCK')
    return value


def verified_files(path, files):
    need(isinstance(files, dict), 'T60_DRIVER_FILES_SHAPE')
    repo = path.resolve().parents[3]
    for name, expected in files.items():
        p = Path(name)
        need(not p.is_absolute() and '..' not in p.parts and digest(expected) and
             sha(read(repo / p)) == expected, 'T60_DRIVER_FILE_PIN')


def load(path, pin, t55_pin, transport_path=None, transport_pin=None):
    raw = read(path)
    need(digest(pin) and sha(raw) == pin, 'T60_DRIVER_MANIFEST_SHA')
    value = parse(raw)
    need(isinstance(value, dict) and value.get('task') == 'T60' and value.get('actionId') == 'T60.release_window' and
         value.get('execution_authorized') is True and value.get('maxSuccessorWindows') == 1 and
         value.get('mcpRelay') == RELAY and value.get('t55ReceiptSha256') == t55_pin and digest(t55_pin) and
         isinstance(value.get('files'), dict), 'T60_DRIVER_MANIFEST_SCOPE')
    verified_files(path, value['files'])
    need(LAUNCHER in value['files'], 'T60_DRIVER_LAUNCHER_PIN')
    files = value['files']
    if transport_path is not None or transport_pin is not None:
        need(transport_path is not None and digest(transport_pin), 'T60_DRIVER_APPENDIX_INPUT')
        transport_raw = read(transport_path)
        need(sha(transport_raw) == transport_pin, 'T60_DRIVER_APPENDIX_SHA')
        appendix = parse(transport_raw)
        need(isinstance(appendix, dict) and appendix.get('task') == 'T60' and
             appendix.get('protocol') == 'BRON_T60_TRANSPORT_APPENDIX_V1' and
             appendix.get('manifestSha256') == pin and appendix.get('execution_authorized') is True and
             appendix.get('mcpRelay') == RELAY, 'T60_DRIVER_APPENDIX_SCOPE')
        verified_files(transport_path, appendix.get('files'))
        files = appendix['files']
    need(SELF in files and sha(read(Path(__file__))) == files[SELF], 'T60_DRIVER_SELF_PIN')
    return value


def health_check(now):
    request = urllib.request.Request('https://api.bronservis.ru/.well-known/bron-health.json',
                                     headers={'Cache-Control': 'no-cache'})
    try:
        response = urllib.request.urlopen(request, timeout=8)
    except urllib.error.HTTPError as error:
        need(error.code == 503, 'T60_DRIVER_HEALTH_STATUS')
        response = error
    with response:
        need(response.code == 503 and response.geturl() == request.full_url,
             'T60_DRIVER_HEALTH_ENDPOINT')
        raw = response.read(4097)
    need(len(raw) <= 4096, 'T60_DRIVER_HEALTH_BOUND')
    value = parse(raw)
    need(isinstance(value, dict) and set(value) == {'checked_at', 'last_backup_utc', 'healthy'} and
         value['healthy'] is True, 'T60_DRIVER_HEALTH_NOT_PASS')
    def epoch(text):
        need(isinstance(text, str) and text.endswith('Z'), 'T60_DRIVER_HEALTH_CLOCK')
        try:
            return int(datetime.fromisoformat(text[:-1] + '+00:00').timestamp() * 1000)
        except ValueError:
            raise DriverError('T60_DRIVER_HEALTH_CLOCK') from None
    check_age = now - epoch(value['checked_at']); backup_age = now - epoch(value['last_backup_utc'])
    need(-5000 <= check_age <= 1500000 and -5000 <= backup_age <= 4200000,
         'T60_DRIVER_BACKUP_STALE')
    return {'tlsVerified': True, 'httpStatus': response.code, 'checkAgeMs': check_age,
            'backupAgeMs': backup_age, 'bodySha256': sha(raw), 'observedEpochMs': now}


def common_command(mode, pin, args, ready=None):
    command = [NODE, REMOTE, mode, '--manifest', ROOT + '/manifest.json', '--sha256', pin,
        '--t55-receipt-sha256', args.t55_receipt_sha256, '--prepared-sha256', args.prepared_sha256,
        '--deployment-proof-sha256', args.deployment_proof_sha256]
    if ready is not None:
        command += ['--ready-input-sha256', ready]
    return shlex.join(command)


def parsed_output(raw, expected_prefixes):
    events = []
    for line in raw.splitlines():
        prefix, separator, body = line.partition(b' ')
        need(separator and prefix.decode('ascii') in expected_prefixes, 'T60_DRIVER_UNEXPECTED_STDOUT')
        events.append((prefix.decode('ascii'), parse(body)))
    return events


# Sent as immutable code plus bounded metadata stdin. Reads raw request ONLY on VPS;
# its nonce never leaves the VPS. Holds directory FD and rejects paths/symlinks/races.
ACK_WRITER = r'''
import hashlib,json,os,stat,sys,time
def need(ok):
 if not ok: raise ValueError('T60_ACK_WRITE_BLOCKED')
def enc(v): return (json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=True)+'\n').encode()
def parse(raw):
 def pairs(items):
  out={}
  for k,v in items:
   need(k not in out);out[k]=v
  return out
 return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:need(False))
def digest(raw): return hashlib.sha256(raw).hexdigest()
def safe(s): need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_gid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==384 and 0<s.st_size<=32768)
need(sys.platform=='linux' and os.getuid()==0 and os.getgid()==0)
data=sys.stdin.buffer.read(32769);need(0<len(data)<=32768);v=parse(data);need(set(v)=={'context','response'})
c=v['context'];r=v['response'];stage=c['stage'];need(stage in ('start','before-target-write','before-final-audit','end'))
root='/root/bron-secrets/t60-release';request='fence-check-'+stage+'.request.json';ack='fence-check-'+stage+'.ack.json'
need(c['requestPath']==root+'/'+request and c['ackPath']==root+'/'+ack and c['storageUid']==0 and c['storageGid']==0 and c['storageMode']==384)
for p in ('/root','/root/bron-secrets',root):
 s=os.lstat(p);need(stat.S_ISDIR(s.st_mode) and s.st_uid==0 and s.st_gid==0 and stat.S_IMODE(s.st_mode)==448 and os.path.realpath(p)==p)
d=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);initial=os.fstat(d)
try:
 f=os.open(request,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
 try:
  s=os.fstat(f);safe(s);raw=os.read(f,32769);a=os.fstat(f);named=os.stat(request,dir_fd=d,follow_symlinks=False);safe(a);safe(named)
  need(len(raw)==s.st_size==a.st_size and s.st_dev==a.st_dev==named.st_dev and s.st_ino==a.st_ino==named.st_ino and s.st_mtime_ns==a.st_mtime_ns and s.st_ctime_ns==a.st_ctime_ns)
 finally: os.close(f)
 need(digest(raw)==c['requestSha256']);q=parse(raw);need(enc(q)==raw);nonce=q.pop('nonce');need(isinstance(nonce,str) and digest(nonce.encode())==q['nonceSha256'])
 public={**q,'requestPath':c['requestPath'],'ackPath':c['ackPath'],'requestSha256':digest(raw),'storageUid':0,'storageGid':0,'storageMode':384};need(public==c)
 need(set(r)=={'ackJson','rootAckSha256'} and isinstance(r['ackJson'],str) and digest(r['ackJson'].encode())==r['rootAckSha256']);a=parse(r['ackJson']);need(enc(a).decode()==r['ackJson'])
 need(set(a)=={'format','protocol','actionId','manifestSha256','sourceProject','sourceBarrierActionId','sourceBarrierReceiptSha256','verifyFencedSqlSha256','stage','nonceSha256','sourceCheckedMicros','expiresEpochMs','normalConnectDenied','existingClientsDrained','providerBoundaryReviewed'})
 need(a['format']==1 and a['protocol']=='BRON_COORDINATOR_FENCE_ACK_V1' and all(a[k]==q[k] for k in ('actionId','manifestSha256','sourceProject','sourceBarrierActionId','sourceBarrierReceiptSha256','verifyFencedSqlSha256','stage','nonceSha256','expiresEpochMs')) and all(a[k] is True for k in ('normalConnectDenied','existingClientsDrained','providerBoundaryReviewed')))
 now=time.time_ns()//1000000;need(now<q['expiresEpochMs'] and (q['createdEpochMs']-5000)*1000<=int(a['sourceCheckedMicros'])<=(now+5000)*1000)
 need(os.stat(root,follow_symlinks=False).st_ino==initial.st_ino and os.stat(root,follow_symlinks=False).st_dev==initial.st_dev)
 output=enc(r);f=os.open(ack,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,384,dir_fd=d)
 try:
  with os.fdopen(f,'wb',closefd=False) as stream: stream.write(output);stream.flush()
  os.fsync(f);safe(os.fstat(f))
 finally: os.close(f)
 os.fsync(d);f=os.open(ack,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=d)
 try: safe(os.fstat(f));need(os.read(f,32769)==output)
 finally: os.close(f)
 need(time.time_ns()//1000000<q['expiresEpochMs'])
 print(json.dumps({'status':'ACK_DURABLE','stage':stage,'sha256':digest(output)},sort_keys=True,separators=(',',':')))
finally: os.close(d)
'''


def deliver_ack(ssh, context, response, timeout):
    result = process(ssh + ['python3 -I -c ' + shlex.quote(ACK_WRITER)],
        encode({'context': context, 'response': response}), timeout=timeout)
    need(result.returncode == 0, 'T60_DRIVER_ACK_DELIVERY_FAILED')
    value = parse(result.stdout)
    need(value == {'status': 'ACK_DURABLE', 'stage': context['stage'], 'sha256': sha(encode(response))},
         'T60_DRIVER_ACK_READBACK')
    return value


def exchange(context, pin, job, actions, ssh):
    now = time.time_ns() // 1000000; stage = context['stage']
    validate_context(context, stage, pin, now)
    # Leave delivery time inside the actual VPS deadline; READY has a stricter 30s wall+mono gate.
    deadline = min(context['expiresEpochMs'] - 3000,
                   context['createdEpochMs'] + (26000 if stage == 'ready' else 57000))
    def left():
        remaining = (deadline - time.time_ns() // 1000000) / 1000
        need(remaining > 0, 'T60_DRIVER_BROKER_RESPONSE_TIMEOUT')
        return remaining
    raw = encode({'format': 1, 'task': 'T60', 'protocol': 'BRON_GITHUB_FENCE_WINDOW_V1',
        'manifestSha256': pin, 'stage': stage, 'contextSha256': sha(encode(context)), 'context': context})
    write_new(job / (stage + '.request.json'), raw)
    event = {'stage': stage, 'contextSha256': sha(encode(context)), 'requestSha256': sha(raw),
        'published': False, 'responseValidated': False, 'delivered': False}
    actions['events'].append(event)
    gh_publish(stage, raw, min(5, left())); event['published'] = True
    while True:
        response = gh_read(relay_path(stage, 'response'), min(20, left()))
        if response is not None:
            break
        time.sleep(min(2, left()))
    value = validate_response(response, context, pin, time.time_ns() // 1000000)
    write_new(job / (stage + '.response.json'), response)
    event.update(responseValidated=True, responseSha256=sha(response))
    if stage != 'ready':
        deliver_ack(ssh, context, value, min(8, left()))
        event.update(delivered=True, deliveredEpochMs=time.time_ns() // 1000000)
    return response


def preflight(pin, ssh, job, args):
    directory(job); gh_unused()
    checked = process(ssh + ['printf T60_RELAY_SSH_READY'], timeout=10)
    need(checked.returncode == 0 and checked.stdout == b'T60_RELAY_SSH_READY', 'T60_DRIVER_SSH_PREFLIGHT')
    return {'task': 'T60', 'status': 'T60_CLIENT_READY_NO_NONCE', 'manifestSha256': pin,
        'sshArgvSha256': sha(encode(ssh)), 'preparedSha256': args.prepared_sha256,
        'deploymentProofSha256': args.deployment_proof_sha256, 't55ReceiptSha256': args.t55_receipt_sha256,
        'observedEpochMs': time.time_ns() // 1000000, 'sourceQueriesByDriver': 0,
        'snapshotAttemptsByDriver': 0, 'macDataTransit': False, 'maintenanceRequired': True}


def final_result(value, pin):
    need(isinstance(value, dict) and value.get('task') == 'T60' and
         value.get('actionId') == 'T60.final_https_window' and value.get('macDataTransit') is False and
         value.get('sourceMustRemainClosed') is True and value.get('targetWriteOutcome') in
         ('UNCHANGED', 'ROLLED_BACK', 'COMMITTED', 'UNKNOWN') and value.get('status') in ('PASS', 'BLOCKED'),
         'T60_DRIVER_FINAL_SHAPE')
    if value['status'] == 'PASS':
        need(value.get('finalFreezeAudit') is True and value.get('strictMismatchGroups') == [] and
             value.get('sourceFrameAttempts') == 2 and value.get('authBudgetUsed') == 6 and
             type(value.get('changedAuthTimestampRows')) is int and 0 <= value['changedAuthTimestampRows'] <= 2 and
             value.get('sourceUnchangedUnderFence') is True and value.get('targetRolesAndDatabaseUnchanged') is True and
             value.get('oldT45Unchanged') is True and value.get('oldT53Unchanged') is True and
             value.get('oldT56Unchanged') is True and value.get('oldT58Unchanged') is True and value['targetWriteOutcome'] ==
             ('COMMITTED' if value['changedAuthTimestampRows'] else 'UNCHANGED'),
             'T60_DRIVER_FINAL_NOT_PASS')
    return value


def window_metadata(value):
    """Only already fixed, technical core fields; no rows, digests or raw errors."""
    out = {key: value[key] for key in ('status', 'targetWriteOutcome')}
    for key in ('phase', 'code'):
        item = value.get(key)
        if isinstance(item, str) and re.fullmatch('[A-Za-z0-9_-]{1,128}', item):
            out[key] = item
    attempts = value.get('sourceFrameAttempts', value.get('recovery', {}).get('sourceFrameAttempts'))
    if type(attempts) is int and 0 <= attempts <= 2:
        out['sourceFrameAttempts'] = attempts
    for key in ('authBudgetUsed', 'changedAuthTimestampRows'):
        item = value.get(key)
        if type(item) is int and 0 <= item <= (6 if key == 'authBudgetUsed' else 16):
            out[key] = item
    if value.get('finalFreezeAudit') is True:
        out['finalFreezeAudit'] = True
    for key in ('strictMismatchGroups', 'mismatchGroups'):
        items = value.get(key)
        if isinstance(items, list) and len(items) <= 200 and all(isinstance(x, str) and
                re.fullmatch('[A-Za-z0-9_.:]{1,160}', x) for x in items):
            out[key] = items
    plan = value.get('authPlanSummary')
    counts = ('sourceRows', 'targetRows', 'sourceOnlyRows', 'targetOnlyRows', 'changedMatchedRows',
        'changedTimestampRows', 'updatedAtChangedRows', 'lastSignInChangedRows', 'otherChangedRows',
        'updatedAtSourceNewerRows', 'updatedAtTargetNewerRows', 'updatedAtNullChangedRows',
        'lastSignInSourceNewerRows', 'lastSignInTargetNewerRows', 'lastSignInNullChangedRows')
    flags = ('diagnosticComplete', 'applyAuthorized', 'finalFreezeAudit', 'canReconcileTwoTimestamps')
    if isinstance(plan, dict) and set(plan) == set(counts + flags) and all(
            type(plan[k]) is int and 0 <= plan[k] <= 16 for k in counts) and all(
            type(plan[k]) is bool for k in flags):
        out['authPlanSummary'] = {key: plan[key] for key in counts + flags}
    return out


def pump(stream, channel, events):
    try:
        while True:
            line = stream.readline(MAX + 1)
            if not line:
                break
            events.put((channel, line))
    finally:
        events.put((channel, None))


def drain_final(child, pin, job, actions, on_challenge, timeout=540):
    """Drain both pipes even after relay failure. Never kill/retry a possibly committed window."""
    events = queue.Queue(maxsize=32); threads = []
    for channel, stream in (('stdout', child.stdout), ('stderr', child.stderr)):
        thread = threading.Thread(target=pump, args=(stream, channel, events), daemon=True)
        thread.start(); threads.append(thread)
    closed = set(); received = None; stages = []; first_error = None; started = time.monotonic()
    opaque = hashlib.sha256(); opaque_count = 0
    while len(closed) < 2:
        if time.monotonic() - started > timeout:
            first_error = first_error or 'T60_DRIVER_FINAL_OBSERVATION_TIMEOUT'
            break
        try:
            channel, raw = events.get(timeout=min(1, max(.01, timeout - (time.monotonic() - started))))
        except queue.Empty:
            continue
        if raw is None:
            closed.add(channel); continue
        if channel == 'stderr':
            opaque.update(raw); opaque_count += len(raw); continue
        try:
            need(len(raw) <= MAX and raw.endswith(b'\n'), 'T60_DRIVER_STDOUT_BOUND')
            prefix, _, body = raw.partition(b' ')
            if prefix == b'COORDINATOR_FENCE_CHALLENGE':
                value = parse(body); need(len(stages) < 4, 'T60_DRIVER_EXTRA_CHALLENGE')
                stage = STAGES[len(stages) + 1]
                validate_context(value, stage, pin, time.time_ns() // 1000000); stages.append(stage)
                # Once a relay fails, observe the guarded VPS result without issuing further actions.
                if first_error is None:
                    on_challenge(value)
            elif prefix == b'T60_RESULT':
                need(received is None, 'T60_DRIVER_DUPLICATE_FINAL_RESULT')
                value = parse(body)
                # Capture write outcome before later schema/receipt checks can fail.
                if isinstance(value, dict) and value.get('targetWriteOutcome') in ('COMMITTED', 'UNKNOWN'):
                    actions['targetWriteOutcome'] = value['targetWriteOutcome']
                received = final_result(value, pin)
                actions['targetWriteOutcome'] = received['targetWriteOutcome']
                actions['window'] = window_metadata(received)
                write_new(job / 'vps-final-result.json', encode(received))
                actions['vpsFinalResultSha256'] = sha(encode(received))
            else:
                opaque.update(raw); opaque_count += len(raw)
                raise DriverError('T60_DRIVER_UNEXPECTED_STDOUT')
        except Exception as error:
            first_error = first_error or (str(error) if isinstance(error, DriverError) else 'T60_DRIVER_EVENT_FAILED')
    actions.update(observedFenceStages=stages, opaqueOutputBytes=opaque_count,
                   opaqueOutputSha256=opaque.hexdigest())
    if len(closed) == 2:
        try:
            actions['runExit'] = child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            first_error = first_error or 'T60_DRIVER_SSH_EXIT_UNKNOWN'
    else:
        actions['runExit'] = child.poll()
    need(received is not None, first_error or 'T60_DRIVER_FINAL_RESULT_MISSING')
    need(first_error is None, first_error)
    need(actions.get('runExit') == (0 if received['status'] == 'PASS' else 2), 'T60_DRIVER_FINAL_EXIT_MISMATCH')
    if received['status'] == 'PASS':
        need(stages == list(STAGES[1:]), 'T60_DRIVER_FINAL_STAGE_COUNT')
    return received


def run(pin, ssh, job, args, actions):
    saved = parse(read(job / 'client-preflight.json', True)); now = time.time_ns() // 1000000
    expected = {'task': 'T60', 'status': 'T60_CLIENT_READY_NO_NONCE', 'manifestSha256': pin,
        'sshArgvSha256': sha(encode(ssh)), 'preparedSha256': args.prepared_sha256,
        'deploymentProofSha256': args.deployment_proof_sha256, 't55ReceiptSha256': args.t55_receipt_sha256}
    need(all(saved.get(k) == v for k, v in expected.items()) and
         type(saved.get('observedEpochMs')) is int and 0 <= now - saved['observedEpochMs'] <= 900000,
         'T60_DRIVER_PREFLIGHT_NOT_CURRENT')
    # Recheck only time-sensitive backup health; closed product/restore gates are not repeated.
    actions['backupHealth'] = health_check(now)
    write_new(job / 'client-run.guard.json', encode({'task': 'T60', 'manifestSha256': pin,
        'actionId': 'T60.github_relay_driver', 'createdEpochMs': now}))
    actions.update(phase='prepare-ready', prepareReadyAttempted=True)
    prepared = process(ssh + [common_command('--prepare-ready', pin, args)], timeout=15)
    need(prepared.returncode == 0, 'T60_DRIVER_PREPARE_READY_FAILED')
    out = parsed_output(prepared.stdout, {'COORDINATOR_READY_CHALLENGE', 'T60_RESULT'})
    need([x[0] for x in out] == ['COORDINATOR_READY_CHALLENGE', 'T60_RESULT'] and
         out[1][1].get('status') == 'READY_CHALLENGE_PREPARED', 'T60_DRIVER_READY_CHALLENGE_MISSING')
    context = validate_context(out[0][1], 'ready', pin, time.time_ns() // 1000000)
    response = exchange(context, pin, job, actions, ssh)
    actions.update(phase='accept-ready', acceptReadyAttempted=True)
    accepted = process(ssh + [common_command('--accept-ready', pin, args)], response,
                       timeout=max(.1, (context['createdEpochMs'] + 30000 - time.time_ns() // 1000000) / 1000))
    need(accepted.returncode == 0, 'T60_DRIVER_ACCEPT_READY_FAILED')
    events = parsed_output(accepted.stdout, {'T60_RESULT'})
    need(len(events) == 1 and events[0][1].get('status') == 'COORDINATOR_READY' and
         digest(events[0][1].get('readySha256')), 'T60_DRIVER_READY_NOT_ACCEPTED')
    ready = events[0][1]['readySha256']; actions['readySha256'] = ready
    # No GitHub probes, owner handoffs or other work between READY acceptance and run-final.
    actions.update(phase='run-final', finalRunAttempted=True, targetWriteOutcome='UNKNOWN')
    child = subprocess.Popen(ssh + [common_command('--run-final', pin, args, ready)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    result = drain_final(child, pin, job, actions,
                         lambda context: exchange(context, pin, job, actions, ssh))
    actions['phase'] = 'done'
    return {'task': 'T60', 'actionId': 'T60.github_relay_driver', 'status': result['status'],
        'manifestSha256': pin, 'targetWriteOutcome': result['targetWriteOutcome'],
        'vpsFinalResultSha256': actions['vpsFinalResultSha256'],
        'window': actions.get('window', window_metadata(result)),
        'sourceMustRemainClosed': True, 'maintenanceRequired': True, 'macDataTransit': False,
        'sourceQueriesByDriver': 0, 'snapshotAttemptsByDriver': 0, 'actions': actions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--transport-manifest', type=Path)
    parser.add_argument('--transport-sha256')
    parser.add_argument('--ssh-options-json', required=True, type=Path)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--prepared-sha256', required=True)
    parser.add_argument('--deployment-proof-sha256', required=True)
    parser.add_argument('--t55-receipt-sha256', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preflight', action='store_true')
    mode.add_argument('--run', action='store_true')
    args = parser.parse_args(); actions = {'phase': 'preflight', 'events': [],
        'prepareReadyAttempted': False, 'acceptReadyAttempted': False, 'finalRunAttempted': False,
        'targetWriteOutcome': 'UNCHANGED'}
    try:
        need(all(digest(x) for x in (args.sha256, args.prepared_sha256,
             args.deployment_proof_sha256, args.t55_receipt_sha256)), 'T60_DRIVER_EXPLICIT_PINS')
        load(args.manifest, args.sha256, args.t55_receipt_sha256,
             args.transport_manifest, args.transport_sha256)
        directory(args.directory)
        ssh = ssh_argv(read(args.ssh_options_json, True))
        result = preflight(args.sha256, ssh, args.directory, args) if args.preflight else run(
            args.sha256, ssh, args.directory, args, actions)
    except Exception as error:
        code = str(error) if isinstance(error, DriverError) else 'T60_DRIVER_FAILED'
        result = {'task': 'T60', 'actionId': 'T60.github_relay_driver', 'status': 'BLOCKED',
            'code': code, 'manifestSha256': args.sha256, 'targetWriteOutcome': actions['targetWriteOutcome'],
            'sourceMustRemainClosed': True, 'maintenanceRequired': True, 'macDataTransit': False,
            'sourceQueriesByDriver': 0, 'snapshotAttemptsByDriver': 0, 'actions': actions}
    try:
        filename = 'client-preflight.json' if args.preflight else 'client-result.json'
        write_new(args.directory / filename, encode(result))
    except Exception:
        # Never relabel COMMITTED/UNKNOWN as unchanged when receipt writing fails.
        result['receiptWriteFailed'] = True; result['status'] = 'BLOCKED'
    print(encode(result).decode(), end='')
    return 0 if result['status'] in ('PASS', 'T60_CLIENT_READY_NO_NONCE') else 2


if __name__ == '__main__':
    sys.exit(main())
