#!/usr/bin/env python3
"""T39: inert public static placement; never activates preview or reads database data."""
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import platform
import signal
import socket
import ssl
import stat
import subprocess
import sys
from datetime import datetime, timezone

PRIVATE = Path('/root/bron-secrets')
SELF = PRIVATE / 't39-stage-static.py'
MANIFEST = PRIVATE / 't39-stage-static.json'
GUARD = PRIVATE / 't39-stage-static.guard'
RESULT = PRIVATE / 't39-stage-static.result.json'
SITE = Path('/opt/bron/supabase/docker/bron/site')
CADDY = SITE.parent / 'Caddyfile.maintenance'
COMPOSE = SITE.parent / 'compose.maintenance.override.yml'
CADDY_SHA = 'd79a799fa4f91354b2ff49e15358db7633f95c52cbbdc62a35180366e3f2f7ff'
COMPOSE_SHA = 'a34d2860a902b0064dbadbe4c09f1012aa2202d7f15e5763a01e86ecc09e4424'
MAX_FILES, MAX_BYTES = 1000, 32 * 1024 * 1024
WORKDIR = '/opt/bron/supabase/docker'
CHAIN = [WORKDIR + '/' + f for f in ('docker-compose.yml', 'bron/compose.override.yml',
    'bron/compose.rehearsal-retry.override.yml', 'bron/compose.restore.override.yml',
    'bron/compose.maintenance.override.yml')]
NAMES = ('supabase-auth', 'supabase-db', 'supabase-envoy', 'supabase-imgproxy',
         'supabase-rest', 'supabase-storage', 'supabase-web-1')
PACKAGES = (
    {'bundle': 'app-root', 'destination': 'app', 'sourceCommit': 'e487ec88120056a54078c3ff1d9ff13d9245ac36',
     'base': '/', 'apiOrigin': 'https://api.bronservis.ru', 'fileCount': 56,
     'manifestSha256': 'e7e9acc8c54631d54b095dd6448130d38266491ab3f810f7bb6affe046efc1c4'},
    {'bundle': 'landing-root', 'destination': 'landing', 'sourceCommit': 'fb5210c6de3ac6df93bad2ddf0306a1856e98b73',
     'base': '/', 'apiOrigin': 'https://api.bronservis.ru', 'fileCount': 11,
     'manifestSha256': '4c3f2b8efd9be02ecc089a1b44a5d86d7cb830e5c685c9f3246c38c494e081b8'},
)


class StagingError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fail(code):
    raise StagingError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def safe_directory(p, owner_uid=0, exact_mode=None):
    s = Path(p).lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != owner_uid or s.st_mode & 0o022 or (
            exact_mode is not None and stat.S_IMODE(s.st_mode) != exact_mode):
        fail('T39_UNSAFE_DIRECTORY')


def safe_ancestors(p, owner_uid=0):
    for item in reversed(Path(p).parents):
        # Root/ancestors of synthetic fixtures are outside their ownership scope.
        s = item.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_mode & 0o022 and str(item) != '/tmp':
            fail('T39_UNSAFE_ANCESTOR')
        if owner_uid == 0 and s.st_uid != 0:
            fail('T39_UNSAFE_ANCESTOR')


def read_regular(p, limit, owner_uid=0, modes=(0o600,)):
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        fail('T39_UNSAFE_FILE')
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != owner_uid or s.st_nlink != 1 or (
                stat.S_IMODE(s.st_mode) not in modes) or s.st_size > limit:
            fail('T39_UNSAFE_FILE')
        with os.fdopen(fd, 'rb', closefd=False) as f:
            value = f.read(limit + 1)
        if len(value) > limit or len(value) != s.st_size:
            fail('T39_FILE_CHANGED_OR_BOUND')
        return value
    finally:
        os.close(fd)


def relative_file(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        fail('T39_UNSAFE_ARTIFACT_PATH')
    parts = value.split('/')
    if value.startswith('/') or any(x in ('', '.', '..', '.git') or x.startswith('.env') for x in parts):
        fail('T39_UNSAFE_ARTIFACT_PATH')
    if len(parts) > 16 or str(PurePosixPath(value)) != value:
        fail('T39_UNSAFE_ARTIFACT_PATH')
    return value


def catalog(root, owner_uid, exact_mode=None, allowed_dirs=None):
    found = set()
    def walk(p, depth):
        if depth > 16:
            fail('T39_ARTIFACT_DEPTH')
        safe_directory(p, owner_uid, exact_mode)
        if allowed_dirs is not None and p != root and p.relative_to(root).as_posix() not in allowed_dirs:
            fail('T39_EXTRA_DIRECTORY')
        for entry in sorted(os.scandir(p), key=lambda e: e.name):
            q = Path(entry.path)
            s = q.lstat()
            if stat.S_ISDIR(s.st_mode):
                walk(q, depth + 1)
            elif stat.S_ISREG(s.st_mode):
                found.add(q.relative_to(root).as_posix())
                if len(found) > MAX_FILES + 1:
                    fail('T39_ARTIFACT_COUNT_BOUND')
            else:
                fail('T39_ARTIFACT_LINK_OR_SPECIAL')
    walk(root, 0)
    return found


def scan_package(root, pin, owner_uid=0):
    root = Path(root)
    safe_ancestors(root, owner_uid)
    safe_directory(root, owner_uid)
    # Inspect all components before opening any artifact content: O_NOFOLLOW protects only the leaf.
    known = catalog(root, owner_uid)
    raw = read_regular(root / 'release-manifest.json', 262144, owner_uid, (0o600, 0o644))
    if digest(raw) != pin['manifestSha256']:
        fail('T39_PACKAGE_MANIFEST_SHA')
    m = json.loads(raw)
    if m.get('format') != 1 or any(m.get(k) != pin[k] for k in ('sourceCommit', 'base')) or (
            'apiOrigin' in pin and m.get('apiOrigin') != pin['apiOrigin']):
        fail('T39_PACKAGE_IDENTITY')
    entries = m.get('files')
    if not isinstance(entries, list) or len(entries) != pin['fileCount'] or not 0 < len(entries) <= MAX_FILES:
        fail('T39_PACKAGE_FILE_COUNT')
    declared, total = {}, 0
    for e in entries:
        if not isinstance(e, dict) or set(e) != {'file', 'bytes', 'sha256'}:
            fail('T39_PACKAGE_ENTRY')
        name = relative_file(e['file'])
        if name == 'release-manifest.json' or name in declared or type(e['bytes']) is not int or e['bytes'] < 0:
            fail('T39_PACKAGE_ENTRY')
        total += e['bytes']
        if total > MAX_BYTES:
            fail('T39_PACKAGE_BYTE_BOUND')
        declared[name] = e
    if known != set(declared) | {'release-manifest.json'}:
        fail('T39_PACKAGE_EXTRA_OR_MISSING_FILE')
    allowed_dirs = {p.as_posix() for name in declared for p in PurePosixPath(name).parents if p.as_posix() != '.'}
    catalog(root, owner_uid, allowed_dirs=allowed_dirs)
    content = {}
    for name, e in declared.items():
        safe_ancestors(root / name, owner_uid)
        value = read_regular(root / name, e['bytes'], owner_uid, (0o600, 0o644))
        if len(value) != e['bytes'] or digest(value) != e['sha256']:
            fail('T39_PACKAGE_FILE_SHA')
        content[name] = value
    content['release-manifest.json'] = raw
    if catalog(root, owner_uid) != set(content):
        fail('T39_PACKAGE_EXTRA_OR_MISSING_FILE')
    return {'files': content, 'manifestSha256': digest(raw), 'contentFiles': len(entries), 'bytes': total}


def validate_destination(dest, package, owner_uid=0):
    dest = Path(dest)
    safe_ancestors(dest, owner_uid)
    try:
        dest.lstat()
    except FileNotFoundError:
        return 'MISSING'
    allowed_dirs = {p.as_posix() for name in package['files'] for p in PurePosixPath(name).parents if p.as_posix() != '.'}
    if catalog(dest, owner_uid, 0o755, allowed_dirs) != set(package['files']):
        fail('T39_EXISTING_DESTINATION_CONFLICT')
    for name, value in package['files'].items():
        if read_regular(dest / name, len(value), owner_uid, (0o644,)) != value:
            fail('T39_EXISTING_DESTINATION_CONFLICT')
    return 'REUSED'


def sync_dir(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def exclusive_write(p, value, mode=0o600):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(value)
            f.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    sync_dir(Path(p).parent)


def stage_package(dest, package, owner_uid=0, created=None):
    dest = Path(dest)
    changed = created if created is not None else []
    safe_ancestors(dest, owner_uid)
    os.mkdir(dest, 0o755)  # Exclusive; never replace an unknown destination.
    os.chmod(dest, 0o755)
    changed.append(str(dest))
    for name, value in package['files'].items():
        q = dest / name
        parent = dest
        for part in PurePosixPath(name).parts[:-1]:
            parent = parent / part
            try:
                os.mkdir(parent, 0o755)
                os.chmod(parent, 0o755)
                changed.append(str(parent))
            except FileExistsError:
                safe_directory(parent, owner_uid, 0o755)
        fd = os.open(q, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        changed.append(str(q))
        try:
            os.fchmod(fd, 0o644)
            with os.fdopen(fd, 'wb', closefd=False) as f:
                f.write(value)
                f.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        sync_dir(q.parent)
    sync_dir(dest.parent)
    validate_destination(dest, package, owner_uid)
    return changed


def command(args):
    try:
        r = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=15, check=False)
    except Exception:
        fail('T39_METADATA_COMMAND_FAILED')
    if r.returncode or len(r.stdout) > 1048576:
        fail('T39_METADATA_COMMAND_FAILED')
    return r.stdout.decode('utf8')


def inspect_state(pins):
    values = command(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'inspect', '--type', 'container',
                      '--format', '{{json .Id}}', *NAMES]).splitlines()
    if len(values) != len(NAMES):
        fail('T39_CONTAINER_IDENTITY')
    ids = dict(zip(NAMES, (json.loads(v) for v in values)))
    if ids != pins:
        fail('T39_CONTAINER_IDENTITY')
    template = ('{"mounts":{{json .Mounts}},"user":{{json .Config.User}},"project":'
                '{{json (index .Config.Labels "com.docker.compose.project")}},"working_dir":'
                '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"config_files":'
                '{{json (index .Config.Labels "com.docker.compose.project.config_files")}}}')
    web = json.loads(command(['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock', 'inspect', '--type',
        'container', '--format', template, 'supabase-web-1']))
    if web.get('user') != '' or web.get('project') != 'supabase' or web.get('working_dir') != WORKDIR or (
            web.get('config_files', '').split(',') != CHAIN):
        fail('T39_WEB_COMPOSE_IDENTITY')
    mounts = web.get('mounts')
    if not isinstance(mounts, list):
        fail('T39_WEB_MOUNTS')
    srv = [x for x in mounts if x.get('Destination', '').startswith('/srv')]
    cfg = [x for x in mounts if x.get('Destination') == '/etc/caddy/Caddyfile']
    if len(srv) != 1 or srv[0].get('Type') != 'bind' or srv[0].get('Source') != str(SITE / 'status') or (
            srv[0].get('Destination') != '/srv/status' or srv[0].get('RW') is not False) or (
            len(cfg) != 1 or cfg[0].get('Type') != 'bind' or cfg[0].get('Source') != str(CADDY) or cfg[0].get('RW') is not False):
        fail('T39_ACTIVE_WEB_NOT_MAINTENANCE_ONLY')
    for p, h in ((CADDY, CADDY_SHA), (COMPOSE, COMPOSE_SHA)):
        safe_ancestors(p)
        if digest(read_regular(p, 262144, modes=(0o600, 0o644))) != h:
            fail('T39_ACTIVE_CONFIGURATION_CHANGED')
    return {'containerIds': ids, 'web': web, 'caddySha256': CADDY_SHA, 'composeSha256': COMPOSE_SHA}


def https_maintenance():
    result = []
    ctx = ssl.create_default_context()
    for host in ('bronservis.ru', 'app.bronservis.ru', 'api.bronservis.ru'):
        connection = http.client.HTTPSConnection(host, 443, timeout=8, context=ctx)
        try:
            connection.sock = ctx.wrap_socket(socket.create_connection(('152.228.115.115', 443), timeout=8),
                                              server_hostname=host)
            connection.request('GET', '/', headers={'Host': host, 'Connection': 'close'})
            response = connection.getresponse()
            response.read(1)  # Discard, never persist or report response bodies.
            if response.status != 503:
                fail('T39_MAINTENANCE_HTTP_STATUS')
            result.append({'host': host, 'http': 503, 'tlsVerified': True})
        except StagingError:
            raise
        except Exception:
            fail('T39_MAINTENANCE_HTTPS_FAILED')
        finally:
            connection.close()
    return result


def main():
    result = {'task': 'T39', 'status': 'BLOCKED', 'sourceDataRead': False, 'sourceAuthUserRead': False,
              'macDataTransit': False, 'previewApplied': False, 'changedPaths': []}
    guard, phase = False, 'preflight'
    try:
        if len(sys.argv) != 5 or sys.argv[1] != '--manifest' or sys.argv[2] != str(MANIFEST) or sys.argv[3] != '--sha256':
            fail('T39_EXPLICIT_REVIEW_REQUIRED')
        if platform.system() != 'Linux' or os.getuid() != 0 or Path(__file__).absolute() != SELF:
            fail('T39_PINNED_VPS_RUNTIME')
        safe_ancestors(SELF)
        safe_directory(PRIVATE, exact_mode=0o700)
        raw = read_regular(MANIFEST, 262144)
        m = json.loads(raw)
        if digest(raw) != sys.argv[4] or m.get('task') != 'T39' or m.get('files', {}).get(
                'docs/runbooks/payloads/t39-stage-static.py') != digest(read_regular(SELF, MAX_BYTES)):
            fail('T39_MANIFEST_OR_SELF_SHA')
        pins = m.get('container_ids')
        if not isinstance(pins, dict) or set(pins) != set(NAMES) or any(
                not isinstance(v, str) or len(v) != 64 or any(c not in '0123456789abcdef' for c in v) for v in pins.values()):
            fail('T39_CONTAINER_PINS')
        ip = '/usr/sbin/ip' if Path('/usr/sbin/ip').exists() else '/sbin/ip'
        interfaces = json.loads(command([ip, '-j', 'address', 'show']))
        if not any(a.get('local') == '152.228.115.115' for i in interfaces for a in i.get('addr_info', [])):
            fail('T39_PINNED_VPS_ADDRESS')
        for existing in (GUARD, RESULT):
            try:
                existing.lstat()
            except FileNotFoundError:
                continue
            fail('T39_ALREADY_STARTED')
        exclusive_write(GUARD, (json.dumps({'task': 'T39', 'manifestSha256': sys.argv[4],
            'startedUtc': datetime.now(timezone.utc).isoformat()}) + '\n').encode())
        guard = True
        def interrupted(signum, _frame):
            fail('T39_WALL_DEADLINE' if signum == signal.SIGALRM else 'T39_INTERRUPTED')
        for signum in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, interrupted)
        signal.alarm(180)
        phase = 'maintenance-preflight'
        before = inspect_state(pins)
        result['httpsBefore'] = https_maintenance()
        safe_ancestors(SITE)
        safe_directory(SITE)
        safe_directory(SITE / 'status')
        phase = 'public-artifact-preflight'
        packages = []
        for pin in PACKAGES:
            result['checkingBundle'] = pin['bundle']
            package = scan_package(Path('/opt/bron/stage/release-e487ec8') / pin['bundle'], pin)
            state = validate_destination(SITE / pin['destination'], package)
            packages.append((pin, package, state))
        phase = 'inert-static-copy'
        result['packages'] = []
        for pin, package, state in packages:
            if state == 'MISSING':
                stage_package(SITE / pin['destination'], package, created=result['changedPaths'])
            result['packages'].append({'bundle': pin['bundle'], 'state': 'STAGED_NEW' if state == 'MISSING' else 'REUSED',
                'contentFiles': package['contentFiles'], 'bytes': package['bytes'], 'manifestSha256': package['manifestSha256']})
        phase = 'maintenance-postcheck'
        after = inspect_state(pins)
        if before != after:
            fail('T39_RUNTIME_METADATA_CHANGED')
        result['httpsAfter'] = https_maintenance()
        result.update(status='PASS_INERT_STAGED', maintenance=True, activeConfigurationUnchanged=True,
                      containerIdsUnchanged=True, statusTreeUntouched=True)
    except Exception as e:
        result.update(status='BLOCKED', phase=phase, code=e.code if isinstance(e, StagingError) else 'T39_FAILED')
    finally:
        signal.alarm(0)
        if guard:
            try:
                exclusive_write(RESULT, (json.dumps(result, sort_keys=True) + '\n').encode())
            except Exception:
                result.update(status='BLOCKED', code='T39_RESULT_WRITE')
    print('T39_STATIC_RESULT', json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'PASS_INERT_STAGED' else 2


if __name__ == '__main__':
    sys.exit(main())
