#!/usr/bin/env python3
"""Restore only the rehearsal target's existing loopback endpoint. No DB/secret I/O."""
import argparse
import grp
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import resource
import stat
import subprocess
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True
ROOT = Path('/root/bron-secrets')
STATE = ROOT / 't46-loopback-repair'
SELF = ROOT / 't46-loopback-repair.py'
MANIFEST = STATE / 'manifest.json'
SELF_REL = 'docs/runbooks/payloads/t46-loopback-repair.py'
UNIT_DIR = Path('/run/systemd/system')
SOCKET = 'bron-t46-target-loopback.socket'
SERVICE = 'bron-t46-target-loopback.service'
PROXY = Path('/usr/lib/systemd/systemd-socket-proxyd')
NODE_NAMES = ('supabase-db', 'supabase-auth', 'supabase-rest', 'supabase-storage',
              'supabase-imgproxy', 'supabase-envoy')
DB_ID = '51071996d381fbfa6a1b6c530045881a5cee6a8c82ee482d83bbf8b47ccf8117'
DB_IMAGE = 'sha256:eca9f664ced0c453ae499e75bb503283831c94f2eef69fc2e69bf86f70278ddc'
ACTION = 'T46.restore_target_loopback'
INSPECT = ('{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
           '"running":{{json .State.Running}},"health":{{if .State.Health}}'
           '{{json .State.Health.Status}}{{else}}null{{end}},'
           '"networks":{{json .NetworkSettings.Networks}}}')


class RepairError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise RepairError(code)


def utc():
    return datetime.now(timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def absent(path):
    try:
        path.lstat()
    except FileNotFoundError:
        return
    raise RepairError('T46_PREEXISTING_PATH')


def directory(path, private=False):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid == 0
            and info.st_gid == 0 and not info.st_mode & 0o022
            and (not private or stat.S_IMODE(info.st_mode) == 0o700), 'T46_DIRECTORY_UNSAFE')


def read_metadata(path, limit=1048576):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        a = os.fstat(fd)
        require(stat.S_ISREG(a.st_mode) and a.st_uid == 0 and a.st_gid == 0
                and a.st_nlink == 1 and stat.S_IMODE(a.st_mode) == 0o600
                and 0 < a.st_size <= limit, 'T46_PRIVATE_FILE_UNSAFE')
        raw = os.read(fd, limit + 1)
        b, named = os.fstat(fd), path.lstat()
        require(len(raw) == a.st_size and (a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns, a.st_ctime_ns) ==
                (b.st_dev, b.st_ino, b.st_size, b.st_mtime_ns, b.st_ctime_ns) and
                (named.st_dev, named.st_ino) == (a.st_dev, a.st_ino), 'T46_METADATA_CHANGED')
        return raw
    finally:
        os.close(fd)


def save_new(path, raw, mode=0o600, claim=None):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        if claim is not None:
            claim()
        os.fchmod(fd, mode)
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    d = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(d)
    finally:
        os.close(d)
    check = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(check)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == mode
                and os.read(check, len(raw) + 1) == raw, 'T46_WRITE_READBACK_FAILED')
    finally:
        os.close(check)


def read_unit(path):
    require(path in (UNIT_DIR / SOCKET, UNIT_DIR / SERVICE), 'T46_UNIT_PATH_INVALID')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o644
                and 0 < info.st_size <= 8192, 'T46_UNIT_FILE_UNSAFE')
        raw = os.read(fd, 8193)
        require(len(raw) == info.st_size, 'T46_UNIT_FILE_UNSAFE')
        return raw
    finally:
        os.close(fd)


def validate_manifest(raw, pin, self_sha):
    require(re.fullmatch('[a-f0-9]{64}', pin or '') and sha(raw) == pin, 'T46_MANIFEST_SHA')
    m = json.loads(raw)
    require(m.get('task') == 'T46' and m.get('actionId') == ACTION
            and m.get('execution_authorized') is True and m.get('maxStartAttempts') == 1
            and m.get('listen') == '127.0.0.1:15433' and m.get('runtimeUnitDirectory') == str(UNIT_DIR)
            and m.get('target', {}).get('container_id') == DB_ID
            and m.get('target', {}).get('image_id') == DB_IMAGE
            and m.get('files', {}).get(SELF_REL) == self_sha, 'T46_SCOPE_INVALID')
    return m


def render_units(address):
    try:
        ip = ipaddress.IPv4Address(address)
    except (ValueError, TypeError):
        raise RepairError('T46_TARGET_IP_INVALID') from None
    require(any(ip in ipaddress.IPv4Network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')),
            'T46_TARGET_IP_INVALID')
    socket = ('[Unit]\nDescription=Bron T46 temporary rehearsal target loopback\n'
              '[Socket]\nListenStream=127.0.0.1:15433\nAccept=no\nService=' + SERVICE + '\n')
    service = ('[Unit]\nDescription=Bron T46 temporary target socket proxy\n'
               '[Service]\nUser=nobody\nGroup=nogroup\nNoNewPrivileges=yes\n'
               'ExecStart=' + str(PROXY) + ' ' + str(ip) + ':5432\n')
    return {SOCKET: socket.encode(), SERVICE: service.encode()}


def inventory(raw):
    rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
    require(len(rows) == len(NODE_NAMES), 'T46_BACKEND_INVENTORY_INVALID')
    result = {}
    for row in rows:
        name = row.get('name', '').removeprefix('/')
        require(name in NODE_NAMES and name not in result and row.get('running') is True
                and row.get('health') == 'healthy' and re.fullmatch('[a-f0-9]{64}', row.get('id', '')),
                'T46_BACKEND_INVENTORY_INVALID')
        result[name] = row
    db = result['supabase-db']
    require(db['id'] == DB_ID and db.get('image') == DB_IMAGE and
            set(db.get('networks', {})) == {'supabase_default'}, 'T46_TARGET_IDENTITY_INVALID')
    address = db['networks']['supabase_default'].get('IPAddress')
    render_units(address)
    return result, address


def listener(raw, expected):
    lines = [line.split() for line in raw.splitlines() if line.strip()]
    require((not lines) if not expected else (len(lines) == 1 and len(lines[0]) >= 5
            and lines[0][0] == 'LISTEN' and lines[0][3] == '127.0.0.1:15433'),
            'T46_LISTENER_MISMATCH')


def run_command(args, record, timeout=15, allowed=(0,)):
    record.append({'argv': args, 'status': 'STARTED'})
    try:
        p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        record[-1]['status'] = 'TIMEOUT_UNKNOWN'
        raise RepairError('T46_COMMAND_TIMEOUT_UNKNOWN') from None
    except OSError:
        record[-1]['status'] = 'NOT_STARTED'
        raise RepairError('T46_COMMAND_UNAVAILABLE') from None
    record[-1].update(status='EXITED', exit=p.returncode)
    require(p.returncode in allowed and len(p.stdout) <= 1048576, 'T46_COMMAND_FAILED')
    return p.stdout.decode('utf-8', errors='strict')


def verify_proxy():
    directory(PROXY.parent)
    require(PROXY.resolve() == PROXY, 'T46_PROXY_UNSAFE')
    info = PROXY.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
            and info.st_nlink >= 1 and not info.st_mode & 0o022 and info.st_mode & 0o111,
            'T46_PROXY_UNSAFE')
    with PROXY.open('rb') as source:
        require(source.read(4) == b'\x7fELF', 'T46_PROXY_UNSAFE')
    require(pwd.getpwnam('nobody').pw_uid != 0 and grp.getgrnam('nogroup').gr_gid != 0,
            'T46_UNPRIVILEGED_USER_REQUIRED')


def repair(m, manifest_sha):
    commands, guarded = [], False
    result = {'format': 1, 'task': 'T46', 'actionId': ACTION, 'manifestSha256': manifest_sha,
              'startedUtc': utc(), 'status': 'BLOCKED', 'startAttempts': 0, 'startOutcome': 'NOT_ATTEMPTED',
              'sourceActions': 0, 'databaseQueries': 0, 'secretReads': 0, 'macDataTransit': False,
              'maintenanceUnchanged': True, 'commands': commands}
    phase = 'preflight'
    inspect_args = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'inspect', '--format', INSPECT, *NODE_NAMES]
    ss_args = ['/usr/bin/ss', '-Hlt', 'sport = :15433']
    try:
        for directory_path in (Path('/root'), ROOT, STATE, Path('/run'), Path('/run/systemd'), UNIT_DIR):
            directory(directory_path, directory_path in (ROOT, STATE))
        for file_path in (STATE / 'guard.json', STATE / 'result.json', UNIT_DIR / SOCKET, UNIT_DIR / SERVICE):
            absent(file_path)
        verify_proxy()
        listener(run_command(ss_args, commands), False)
        loaded = run_command(['/usr/bin/systemctl', 'show', '--property=LoadState', '--value', SOCKET, SERVICE],
                             commands, allowed=(0, 1, 4))
        require(loaded.split() == ['not-found', 'not-found'], 'T46_EXISTING_NAMED_UNIT')
        before, address = inventory(run_command(inspect_args, commands))
        units = render_units(address)
        hashes = {name: sha(content) for name, content in units.items()}
        phase = 'claim'
        def claimed():
            nonlocal guarded
            guarded = True
        save_new(STATE / 'guard.json', encode({'task': 'T46', 'actionId': ACTION, 'manifestSha256': manifest_sha,
                 'startedUtc': result['startedUtc'], 'targetAddress': address, 'unitSha256': hashes, 'oneStart': True}), claim=claimed)
        result.update(targetAddress=address, unitSha256=hashes,
                      backendIdsBefore={name: row['id'] for name, row in before.items()})
        phase = 'write-units'
        for name, content in units.items():
            save_new(UNIT_DIR / name, content, 0o644)
        phase = 'validate-units'
        run_command(['/usr/bin/systemd-analyze', 'verify', str(UNIT_DIR / SOCKET), str(UNIT_DIR / SERVICE)], commands)
        phase = 'daemon-reload'
        run_command(['/usr/bin/systemctl', 'daemon-reload'], commands)
        phase = 'effective-unit-check'
        for name in units:
            observed = run_command(['/usr/bin/systemctl', 'show', '--property=Id,LoadState,FragmentPath,DropInPaths', name], commands)
            properties = dict(line.split('=', 1) for line in observed.splitlines() if '=' in line)
            require(properties.get('Id') == name and properties.get('LoadState') == 'loaded'
                    and properties.get('FragmentPath') == str(UNIT_DIR / name) and properties.get('DropInPaths') == ''
                    and read_unit(UNIT_DIR / name) == units[name], 'T46_EFFECTIVE_UNIT_MISMATCH')
        phase = 'socket-start'
        result.update(startAttempts=1, startOutcome='UNKNOWN', startCommandOutcome='UNKNOWN')
        try:
            run_command(['/usr/bin/systemctl', 'start', SOCKET], commands)
            result['startCommandOutcome'] = 'ACKNOWLEDGED'
        except RepairError as error:
            if str(error) != 'T46_COMMAND_TIMEOUT_UNKNOWN':
                raise
            # One observation is permitted; never repeat an uncertain start.
            result['startCommandOutcome'] = 'TIMEOUT_UNKNOWN'
        phase = 'postcheck'
        state = run_command(['/usr/bin/systemctl', 'show', '--property=ActiveState,SubState,Listen,Triggers', SOCKET], commands)
        fields = dict(line.split('=', 1) for line in state.splitlines() if '=' in line)
        require(fields.get('ActiveState') == 'active' and fields.get('SubState') == 'listening'
                and fields.get('Listen') == '127.0.0.1:15433 (Stream)' and fields.get('Triggers') == SERVICE,
                'T46_SOCKET_STATE_INVALID')
        listener(run_command(ss_args, commands), True)
        require(all(read_unit(UNIT_DIR / name) == content for name, content in units.items()), 'T46_UNIT_CHANGED')
        after, after_address = inventory(run_command(inspect_args, commands))
        require(before == after and address == after_address, 'T46_BACKEND_CHANGED')
        result.update(status='PASS', startOutcome='ACTIVE_VERIFIED', listener='127.0.0.1:15433', unitState='active/listening',
                      backendIdsAfter={name: row['id'] for name, row in after.items()},
                      backendUnchanged=True, targetAddressUnchanged=True, targetIdentityProbe='DEFERRED_TO_T45_PREPARE_FINAL')
    except BaseException as error:
        result.update(status='BLOCKED', phase=phase,
                      code=str(error) if isinstance(error, RepairError) else 'T46_UNEXPECTED_FAILURE', retryAuthorized=False)
    result['completedUtc'] = utc()
    if guarded:
        try:
            save_new(STATE / 'result.json', encode(result))
        except BaseException:
            result.update(status='BLOCKED', phase='result-durability', code='T46_RESULT_DURABILITY_FAILED', retryAuthorized=False)
    return result


def main(argv=None):
    try:
        require(sys.platform == 'linux' and os.getuid() == 0 and os.getgid() == 0
                and sys.flags.isolated and Path(__file__) == SELF, 'T46_PINNED_ROOT_RUNTIME_REQUIRED')
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        parser = argparse.ArgumentParser()
        parser.add_argument('--run', action='store_true', required=True)
        parser.add_argument('--manifest', required=True)
        parser.add_argument('--sha256', required=True)
        args = parser.parse_args(argv)
        require(args.manifest == str(MANIFEST), 'T46_MANIFEST_PATH_REQUIRED')
        manifest = validate_manifest(read_metadata(MANIFEST), args.sha256, sha(read_metadata(SELF)))
        result = repair(manifest, args.sha256)
    except BaseException as error:
        result = {'task': 'T46', 'status': 'BLOCKED', 'code': str(error) if isinstance(error, RepairError)
                  else 'T46_ACTIVATION_FAILED', 'retryAuthorized': False}
    print('T46_RESULT ' + result['status'])
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'PASS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
