#!/usr/bin/python3 -I
"""Publish one trusted CI package on the existing target, using the T64 exchange and ledger."""
import base64
import ctypes
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
import tarfile
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4


LIMIT = 64 * 1024 * 1024
MAX_FILES = 2000
CONFIG = Path('/etc/bron-release/config.json')
LOCK = Path('/run/lock/bron-production-release.lock')
DEPLOY_USER = 'bron-deploy'
DOCKER = '/usr/bin/docker'
PYTHON = '/usr/bin/python3'
APP = 'https://app.bronservis.ru'
API = 'https://api.bronservis.ru'
AUTH = API + '/auth/v1/health'
PING = API + '/rest/v1/rpc/ping'
LEAD = API + '/rest/v1/rpc/lead_submit'
MANIFEST = 'release-manifest.json'
CORE = ('index.html', 'app-version.json', 'manifest.webmanifest', 'sw.js', MANIFEST)
MIGRATION_PATTERN = r'^([0-9]{4}|[0-9]{14})_[a-zA-Z0-9_-]+\.sql$'
MIGRATION = re.compile(MIGRATION_PATTERN)
COMMIT = re.compile(r'[0-9a-f]{40}')
SHA = re.compile(r'[0-9a-f]{64}')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C.UTF-8'}
BACKENDS = ('supabase-auth', 'supabase-envoy', 'supabase-imgproxy', 'supabase-rest', 'supabase-storage')


class Blocked(Exception):
    pass


def digest(value):
    return hashlib.sha256(value).hexdigest()


def matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def unique_object(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise Blocked('DUPLICATE_JSON_KEY')
    return value


def document(raw):
    value = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise Blocked('JSON_OBJECT_REQUIRED')
    return value


def relative(name):
    if (not isinstance(name, str) or not 0 < len(name) <= 512 or '\\' in name
            or any(ord(letter) < 32 for letter in name) or name.startswith('/')
            or str(PurePosixPath(name)) != name
            or any(part in ('', '.', '..') or part.startswith('.') for part in name.split('/'))):
        raise Blocked('UNSAFE_ARTIFACT_PATH')
    return name


def checked_directory(path, *, private=False):
    info = path.lstat()
    mask = 0o077 if private else 0o022
    if (not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid() or info.st_gid != os.getegid() or info.st_mode & mask):
        raise Blocked('UNSAFE_DIRECTORY')
    return path


def read_file(path, *, limit=LIMIT, private=False):
    if not path.is_absolute() or path.resolve() != path:
        raise Blocked('UNSAFE_FILE_PATH')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        mask = 0o077 if private else 0o022
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_gid != os.getegid()
                or info.st_nlink != 1 or info.st_mode & mask or info.st_size > limit):
            raise Blocked('UNSAFE_FILE')
        value = source.read(limit + 1)
    if len(value) != info.st_size or len(value) > limit:
        raise Blocked('FILE_CHANGED_OR_BOUND')
    return value


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_new(path, value, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as dest:
        os.fchmod(dest.fileno(), mode)
        dest.write(value)
        dest.flush()
        os.fsync(dest.fileno())
    sync_dir(path.parent)


def receipt(state, name, value):
    candidate = state / ('.receipt-' + uuid4().hex)
    write_new(candidate, (json.dumps(value, sort_keys=True) + '\n').encode(), 0o600)
    os.replace(candidate, state / name)
    sync_dir(state)


def site_manifest(files, source):
    if not set(CORE) <= files.keys() or not any(name.startswith('assets/') for name in files):
        raise Blocked('REQUIRED_APP_FILE')
    manifest = document(files[MANIFEST])
    if (manifest.get('format') != 1 or manifest.get('sourceCommit') != source
            or manifest.get('base') != '/' or manifest.get('apiOrigin') != API):
        raise Blocked('RELEASE_IDENTITY')
    entries = manifest.get('files')
    if not isinstance(entries, list):
        raise Blocked('MANIFEST_FILES')
    declared = set()
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'file', 'bytes', 'sha256'}:
            raise Blocked('MANIFEST_ENTRY')
        name = relative(entry['file'])
        if name in declared or name == MANIFEST or type(entry['bytes']) is not int:
            raise Blocked('MANIFEST_ENTRY')
        blocks = files.get(name)
        if blocks is None or len(blocks) != entry['bytes'] or digest(blocks) != entry['sha256']:
            raise Blocked('CONTENT_SHA')
        declared.add(name)
    if declared | {MANIFEST} != files.keys():
        raise Blocked('UNLISTED_APP_CONTENT')
    webmanifest = document(files['manifest.webmanifest'])
    if webmanifest.get('scope') != '/' or webmanifest.get('start_url') != '/':
        raise Blocked('PWA_SCOPE')


def read_package(raw):
    if len(raw) > LIMIT:
        raise Blocked('ARTIFACT_BOUND')
    files, directories, seen = {}, set(), set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as archive:
        for entry in archive:
            name = relative(entry.name.rstrip('/') if entry.isdir() else entry.name)
            if name in seen or len(seen) >= MAX_FILES:
                raise Blocked('DUPLICATE_OR_EXCESS_TAR_PATHS')
            seen.add(name)
            if entry.isdir():
                directories.add(name)
                continue
            if not entry.isfile() or not 0 <= entry.size <= LIMIT - total:
                raise Blocked('TAR_LINK_SPECIAL_OR_BOUND')
            data = archive.extractfile(entry).read(entry.size + 1)
            if len(data) != entry.size:
                raise Blocked('TAR_SIZE')
            total += entry.size
            files[name] = data
    manifest = document(files.pop('manifest.json', b''))
    if (set(manifest) != {'format_version', 'source_sha', 'expected_live_source_sha', 'files'}
            or type(manifest['format_version']) is not int or manifest['format_version'] != 1
            or not matches(COMMIT, manifest['source_sha']) or not matches(COMMIT, manifest['expected_live_source_sha'])):
        raise Blocked('PACKAGE_IDENTITY')
    declared = manifest['files']
    if not isinstance(declared, dict) or declared.keys() != files.keys():
        raise Blocked('UNLISTED_OR_MISSING_CONTENT')
    if not directories <= {parent.as_posix() for name in files for parent in PurePosixPath(name).parents}:
        raise Blocked('UNLISTED_DIRECTORY')
    site, migrations = {}, {}
    for name, value in files.items():
        if declared[name] != digest(value):
            raise Blocked('PACKAGE_CONTENT_SHA')
        folder, slash, inner = name.partition('/')
        if slash and folder == 'site':
            site[inner] = value
        elif slash and folder == 'migrations' and matches(MIGRATION, inner):
            migrations[inner] = value
        else:
            raise Blocked('PACKAGE_SECTION')
    if not migrations:
        raise Blocked('MIGRATION_HISTORY_MISSING')
    site_manifest(site, manifest['source_sha'])
    return {'source': manifest['source_sha'], 'expected': manifest['expected_live_source_sha'],
            'site': site, 'migrations': migrations}


def plan_migrations(migrations, ledger):
    if not ledger or not any(name in ledger for name in migrations):
        raise Blocked('TARGET_LEDGER_BASELINE_MISSING')
    pending = {}
    for name, value in sorted(migrations.items()):
        if name in ledger:
            if ledger[name] != digest(value):
                raise Blocked('MIGRATION_CHECKSUM_CONFLICT')
        elif len(name.split('_', 1)[0]) != 14 or name <= max(ledger):
            raise Blocked('MISSING_OLD_MIGRATION')
        else:
            pending[name] = value
    return pending


TOKEN = re.compile(r"--[^\n]*|/\*|\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$|[eE]?'|\"|\\|;|[a-zA-Z_][a-zA-Z_0-9$]*")
TRANSACTION = {'begin', 'start', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release', 'prepare'}


def checked_sql(raw):
    """Inspect top-level SQL only, skipping quoted PL/pgSQL bodies and comments."""
    body = raw.decode('utf-8')
    if not body.strip() or '\x00' in body:
        raise Blocked('MIGRATION_ENCODING_OR_EMPTY')
    offset, starts_statement = 0, True
    while (token := TOKEN.search(body, offset)) is not None:
        key = token.group()
        offset = token.end()
        if key.startswith('--'):
            continue
        if key == '/*':
            depth = 1
            while depth:
                nested = re.search(r'/\*|\*/', body[offset:])
                if nested is None:
                    raise Blocked('MIGRATION_UNTERMINATED_COMMENT')
                depth += 1 if nested.group() == '/*' else -1
                offset += nested.end()
            continue
        if key.startswith('$'):
            end = body.find(key, offset)
            if end < 0:
                raise Blocked('MIGRATION_UNTERMINATED_QUOTE')
            offset = end + len(key)
        elif key.endswith("'") or key == '"':
            quote_char = key[-1]
            match = (re.compile(r"(?:''|\\[\s\S]|[^'\\])*'") if len(key) == 2 else
                     re.compile(r"(?:''|[^'])*'") if quote_char == "'" else re.compile(r'(?:""|[^"])*"')).match(body, offset)
            if match is None:
                raise Blocked('MIGRATION_UNTERMINATED_QUOTE')
            offset = match.end()
        elif key == '\\' or (starts_statement and key.lower() in TRANSACTION):
            raise Blocked('MIGRATION_TRANSACTION_OR_PSQL')
        starts_statement = key == ';'
    # Scripts must end their own SQL statement before the ledger INSERT.
    if not starts_statement:
        raise Blocked('MIGRATION_TERMINATOR')
    return body


def ledger_guard(ledger):
    expected = json.dumps(ledger, sort_keys=True)
    return (f"DO $ledger$ BEGIN IF (SELECT coalesce(jsonb_object_agg(name,checksum),'{{}}'::jsonb) "
            f"FROM app_private.schema_migration WHERE name ~ '{MIGRATION_PATTERN}') "
            f"IS DISTINCT FROM $expected${expected}$expected$::jsonb THEN "
            "RAISE EXCEPTION 'BRON_RELEASE_LEDGER_CHANGED'; END IF; END $ledger$;")


def migration_sql(ledger, pending):
    parts = ["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';",
             "SET LOCAL standard_conforming_strings=on;",
             "SELECT pg_advisory_xact_lock(hashtextextended('bron.product.update',0));",
             'LOCK TABLE app_private.schema_migration IN SHARE ROW EXCLUSIVE MODE;',
             ledger_guard(ledger)]
    expected = dict(ledger)
    for name, body in pending.items():
        checksum = digest(body)
        expected[name] = checksum
        parts.extend([checked_sql(body),
                      f"INSERT INTO app_private.schema_migration(name,checksum) VALUES('{name}','{checksum}');"])
    parts.extend([ledger_guard(expected), "NOTIFY pgrst, 'reload schema';", 'COMMIT;', "SELECT 'BRON_RELEASE_MIGRATIONS_COMMITTED';"])
    return ('\n'.join(parts) + '\n').encode()


def immutable_asset(name):
    return name.startswith('assets/') or re.fullmatch(r'workbox-[a-fA-F0-9]{8,64}\.js', name) is not None


def existing_assets(live):
    found = {}
    total = 0
    for current, dirs, names in os.walk(checked_directory(live / 'assets'), followlinks=False):
        current = checked_directory(Path(current))
        for name in dirs:
            checked_directory(current / name)
        for name in names:
            path = current / name
            value = read_file(path)
            found[relative(path.relative_to(live).as_posix())] = value
            total += len(value)
            if len(found) > MAX_FILES or total > LIMIT:
                raise Blocked('OLD_ASSET_BOUND')
    for path in live.glob('workbox-*.js'):
        if immutable_asset(path.name):
            value = read_file(path)
            found[path.name] = value
            total += len(value)
            if len(found) > MAX_FILES or total > LIMIT:
                raise Blocked('OLD_ASSET_BOUND')
    return found


def asset_additions(existing, incoming):
    if any(not immutable_asset(name) for name in incoming):
        raise Blocked('RETAIN_OUTSIDE_ASSETS')
    if any(name in existing and existing[name] != value for name, value in incoming.items()):
        raise Blocked('SAME_ASSET_PATH_DIFFERENT_CONTENT')
    additions = {name: value for name, value in incoming.items() if name not in existing}
    if len(existing) + len(additions) > MAX_FILES or sum(map(len, existing.values())) + sum(map(len, additions.values())) > LIMIT:
        raise Blocked('RETAINED_ASSET_BOUND')
    return additions


def stage_files(path, files, *, atomic_additions=False):
    for name, value in files.items():
        target = path / relative(name)
        parent = path
        for part in PurePosixPath(name).parts[:-1]:
            parent /= part
            if not parent.exists():
                parent.mkdir(mode=0o755)
                parent.chmod(0o755)
                sync_dir(parent.parent)
            checked_directory(parent)
        written = parent / ('.asset-' + uuid4().hex) if atomic_additions else target
        try:
            write_new(written, value, 0o644)
            if read_file(written) != value:
                raise Blocked('STAGE_READBACK')
            if atomic_additions:
                rename_atomic(written, target, 1)  # RENAME_NOREPLACE
        finally:
            if atomic_additions:
                written.unlink(missing_ok=True)
    sync_dir(path)
    sync_dir(path.parent)


def stage(path, files):
    path.mkdir(mode=0o755)
    path.chmod(0o755)
    stage_files(path, files)


def prepare_rollback_assets(live, additions):
    # With both sets present before SQL, inverse exchange needs no file copies.
    stage_files(live, additions, atomic_additions=True)


def rename_atomic(first, second, flags):
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, 'renameat2', None)
    if function is None:
        raise Blocked('ATOMIC_EXCHANGE_UNAVAILABLE')
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(first), -100, os.fsencode(second), flags):
        raise Blocked('ATOMIC_RENAME_FAILED')
    sync_dir(first.parent)


def exchange(first, second):
    rename_atomic(first, second, 2)  # RENAME_EXCHANGE


def command(arguments, *, stdin=None, timeout=30):
    try:
        result = subprocess.run(arguments, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, cwd='/', env=ENV, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('TARGET_COMMAND_UNAVAILABLE') from None
    if result.returncode or len(result.stdout) > 2 * 1024 * 1024:
        code = re.search(rb'ERROR:\s+([0-9A-Z]{5})(?:\s|$)', result.stderr)
        raise Blocked('TARGET_SQL_' + code[1].decode() if code else 'TARGET_COMMAND_FAILED')
    return result.stdout


def inspect(identifier):
    metadata = ('{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},'
                '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},'
                '"mounts":{{json .Mounts}},"user":{{json .Config.User}}}')
    record = document(command([DOCKER, 'inspect', '--type', 'container', '--format', metadata, identifier]))
    if not matches(SHA, record.get('id')) or record.get('running') is not True:
        raise Blocked('TARGET_CONTAINER_UNAVAILABLE')
    return record


def inspect_target(config, site):
    db = inspect('supabase-db')
    if (db['id'] != config['target_db_id'] or db['image'] != config['target_db_image']
            or db['health'] != 'healthy'):
        raise Blocked('TARGET_DB_IDENTITY_OR_HEALTH')
    web = inspect('supabase-web-1')
    binds = [item for item in web['mounts'] if item['Destination'] == '/srv']
    if (len(binds) != 1 or binds[0]['Type'] != 'bind' or binds[0]['Source'] != str(site)
            or binds[0]['RW'] is not False or web['user'] != ''):
        raise Blocked('WEB_PARENT_BIND_NOT_PRODUCTION')
    backends = tuple(inspect(name) for name in BACKENDS)
    if any(record['health'] not in (None, 'healthy') for record in backends):
        raise Blocked('TARGET_BACKEND_UNHEALTHY')
    return (db['id'], web['id'], *(record['id'] for record in backends))


def sql(db, statement):
    return command([DOCKER, 'exec', '-i', db, 'psql', '-U', 'supabase_admin', '-d', 'postgres',
                    '-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'],
                   stdin=statement, timeout=150)


def read_ledger(db):
    statement = (f"BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; "
                 f"SELECT coalesce(jsonb_object_agg(name,checksum),'{{}}'::jsonb) FROM app_private.schema_migration "
                 f"WHERE name ~ '{MIGRATION_PATTERN}'; ROLLBACK;").encode()
    ledger = document(sql(db, statement))
    if any(not matches(MIGRATION, name) or not matches(SHA, value) for name, value in ledger.items()):
        raise Blocked('TARGET_LEDGER_SHAPE')
    return ledger


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def public_key(key):
    if not isinstance(key, str) or not 0 < len(key) <= 4096:
        return False
    if re.fullmatch(r'sb_publishable_[a-zA-Z0-9_-]+', key):
        return True
    if not re.fullmatch(r'[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+', key):
        return False
    try:
        header, payload, _signature = key.split('.')
        header, payload = [document(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
                           for part in (header, payload)]
        return header.get('alg') == 'HS256' and payload.get('role') == 'anon'
    except (Blocked, ValueError):
        return False


def download(url, limit, *, key=None, body=None):
    headers = {'Cache-Control': 'no-cache'}
    if key is not None:
        if url not in (AUTH, PING, LEAD):
            raise Blocked('PUBLIC_PROBE_ORIGIN')
        if not public_key(key):
            raise Blocked('PUBLIC_PROBE_KEY_INVALID')
        headers['apikey'] = key
        headers['Content-Type'] = 'application/json'
    request = Request(url, data=body, headers=headers)
    try:
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=8) as response:
            value = response.read(limit + 1)
            if response.status != 200 or len(value) > limit:
                raise Blocked('PUBLIC_RESPONSE_INVALID')
            return value
    except (OSError, URLError):
        raise Blocked('PUBLIC_RESPONSE_UNAVAILABLE') from None


def probe_services(key):
    probes = (
        ('AUTH', AUTH, None, lambda value: isinstance(value, dict) and value.get('name') == 'GoTrue'),
        ('DATA', PING, b'{}', lambda value: value == 'ok'),
        ('LANDING', LEAD, b'{"p_lead":{"website":"availability-check"}}',
         lambda value: isinstance(value, dict) and value.get('ok') is True),
    )
    for name, url, body, valid in probes:
        try:
            response = json.loads(download(url, 65536, key=key, body=body), object_pairs_hook=unique_object)
            if not valid(response):
                raise Blocked('USABILITY_PROBE_RESPONSE')
        except (Blocked, ValueError):
            raise Blocked('PUBLIC_' + name + '_PROBE') from None


def public_health(files, probe_key):
    for name, value in files.items():
        endpoint = '/' if name == 'index.html' else '/' + quote(name)
        if download(APP + endpoint, len(value)) != value:
            raise Blocked('PUBLIC_ARTIFACT_MISMATCH')
    health = document(download(API + '/.well-known/bron-health.json', 65536))
    now = dt.datetime.now(dt.timezone.utc)
    for key, bound in [('checked_at', 1800), ('last_backup_utc', 4200)]:
        stamp = dt.datetime.fromisoformat(health[key].replace('Z', '+00:00'))
        if stamp.tzinfo is None or not 0 <= (now - stamp).total_seconds() <= bound:
            raise Blocked('PUBLIC_HEALTH_STALE')
    if health.get('healthy') is not True:
        raise Blocked('PUBLIC_HEALTH_UNHEALTHY')
    probe_services(probe_key)


def live_core(site):
    live = checked_directory(site / 'app')
    return {name: read_file(live / name) for name in CORE}


def publish_frontend(site, state, package, *, probe_key, before_switch=lambda: None, after_switch=lambda: None):
    live = checked_directory(site / 'app')
    prior = live_core(site)
    if document(prior[MANIFEST]).get('sourceCommit') != package['expected']:
        raise Blocked('EXPECTED_LIVE_SOURCE_MISMATCH')
    files = dict(package['site'])
    old_assets = existing_assets(live)
    candidate_assets = {name: value for name, value in files.items() if immutable_asset(name)}
    retained = asset_additions(candidate_assets, old_assets)
    additions = asset_additions(old_assets, candidate_assets)
    new_chunk = next((name for name in additions if name.startswith('assets/') and name.endswith('.js')), None)
    new_chunk_probe = {new_chunk: additions[new_chunk]} if new_chunk else {}
    files.update(retained)
    before = site / ('.app-before-release-' + package['source'][:12] + '-' + uuid4().hex)
    stage(before, files)
    prepare_rollback_assets(live, additions)
    note = {'source_sha': package['source'], 'previous_source_sha': package['expected'], 'before': before.name,
            'old_manifest_sha256': digest(prior[MANIFEST]), 'new_manifest_sha256': digest(files[MANIFEST]),
            'retained_assets': len(retained)}
    receipt(state, 'latest.json', {**note, 'status': 'PREPARED'})
    before_switch()
    if live_core(site)[MANIFEST] != prior[MANIFEST]:
        raise Blocked('LIVE_CHANGED_BEFORE_SWITCH')
    receipt(state, 'latest.json', {**note, 'status': 'SWITCH_PENDING'})
    try:
        exchange(live, before)
        if live_core(site)[MANIFEST] != files[MANIFEST]:
            raise Blocked('LIVE_MANIFEST_READBACK')
        after_switch()
        public_files = {name: files[name] for name in (*CORE, *tuple(retained)[:1])}
        public_health({**public_files, **new_chunk_probe}, probe_key)
        result = {**note, 'status': 'PUBLISHED'}
        receipt(state, 'latest.json', result)
        return result
    except Exception:
        try:
            active = live_core(site)[MANIFEST]
            if active == files[MANIFEST] and read_file(before / MANIFEST) == prior[MANIFEST]:
                exchange(live, before)
                if live_core(site)[MANIFEST] != prior[MANIFEST]:
                    raise Blocked('ROLLBACK_MANIFEST_READBACK')
                receipt(state, 'latest.json', {**note, 'status': 'FRONTEND_ROLLED_BACK_POSTCHECK_PENDING'})
            elif active == prior[MANIFEST]:
                raise Blocked('ATOMIC_SWITCH_UNCONFIRMED')
            else:
                raise Blocked('PUBLISH_STATE_UNCONFIRMED')
        except Exception:
            raise Blocked('PUBLISH_OR_ROLLBACK_INSPECTION_REQUIRED') from None
        try:
            public_health({**prior, **new_chunk_probe}, probe_key)
        except Exception:
            receipt(state, 'latest.json', {**note, 'status': 'FRONTEND_ROLLED_BACK_PUBLIC_UNVERIFIED'})
            raise Blocked('FRONTEND_ROLLED_BACK_PUBLIC_UNVERIFIED') from None
        receipt(state, 'latest.json', {**note, 'status': 'FRONTEND_ROLLED_BACK'})
        raise Blocked('FRONTEND_ROLLED_BACK') from None


def trusted_config():
    checked_directory(CONFIG.parent, private=True)
    config = document(read_file(CONFIG, limit=65536, private=True))
    keys = {'site_root', 'state_dir', 'backup_program', 'restore_receipt', 'restore_receipt_sha256',
            'target_db_id', 'target_db_image', 'public_probe_key'}
    if (set(config) != keys or not matches(SHA, config['target_db_id'])
            or not matches(SHA, config['restore_receipt_sha256'])
            or not isinstance(config['target_db_image'], str) or not config['target_db_image'].startswith('sha256:')
            or not matches(SHA, config['target_db_image'][7:])):
        raise Blocked('CONFIG_INVALID')
    if not public_key(config['public_probe_key']):
        raise Blocked('PUBLIC_PROBE_KEY_INVALID')
    return config


def readiness(config, site):
    if digest(read_file(Path(config['restore_receipt']), private=True)) != config['restore_receipt_sha256']:
        raise Blocked('RESTORE_RECEIPT_MISMATCH')
    backup = Path(config['backup_program'])
    read_file(backup)
    command([PYTHON, '-I', str(backup), '--check-age'])
    containers = inspect_target(config, site)
    public_health(live_core(site), config['public_probe_key'])
    return containers


def main():
    args = sys.argv[1:]
    if sys.platform != 'linux' or os.geteuid() != 0 or os.getegid() != 0:
        raise Blocked('VPS_ROOT_ONLY')
    if args not in ([], ['--check']) or (not args and os.getenv('SUDO_USER') != DEPLOY_USER):
        raise Blocked('RESTRICTED_DEPLOY_IDENTITY')
    os.umask(0o077)
    config = trusted_config()
    site = checked_directory(Path(config['site_root']))
    state = checked_directory(Path(config['state_dir']), private=True)
    if state == site or site in state.parents:
        raise Blocked('STATE_MUST_BE_PRIVATE')
    if args:
        db = readiness(config, site)[0]
        read_ledger(db)
        return {'status': 'READY', 'live_source_sha': document(live_core(site)[MANIFEST])['sourceCommit']}
    package = read_package(sys.stdin.buffer.read(LIMIT + 1))
    lock = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock, 'rb') as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
            raise Blocked('UNSAFE_RELEASE_LOCK')
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        containers = readiness(config, site)
        db = containers[0]
        ledger = read_ledger(db)
        pending = plan_migrations(package['migrations'], ledger)
        if pending and package['source'] == package['expected']:
            raise Blocked('SAME_SOURCE_PENDING_MIGRATIONS')
        migration_bundle = migration_sql(ledger, pending) if pending else None

        def apply_migrations():
            if inspect_target(config, site) != containers:
                raise Blocked('TARGET_CONTAINERS_CHANGED')
            # The check is repeated close to COMMIT after staging has completed.
            command([PYTHON, '-I', config['backup_program'], '--check-age'])
            if migration_bundle is None:
                return
            details = {'source_sha': package['source'], 'migrations': {name: digest(body) for name, body in pending.items()}}
            receipt(state, 'migration.json', {**details, 'status': 'COMMIT_UNCONFIRMED'})
            output = sql(db, migration_bundle)
            if output.splitlines()[-1:] != [b'BRON_RELEASE_MIGRATIONS_COMMITTED']:
                raise Blocked('MIGRATION_COMMIT_UNVERIFIED')
            applied = read_ledger(db)
            if any(applied.get(name) != checksum for name, checksum in details['migrations'].items()):
                raise Blocked('MIGRATION_COMMIT_UNVERIFIED')
            receipt(state, 'migration.json', {**details, 'status': 'COMMITTED'})

        def check_target():
            if inspect_target(config, site) != containers:
                raise Blocked('TARGET_CONTAINERS_CHANGED')

        return publish_frontend(site, state, package, probe_key=config['public_probe_key'],
                                before_switch=apply_migrations, after_switch=check_target)


def interrupted(_signal_number, _frame):
    raise Blocked('RELEASE_INTERRUPTED')


if __name__ == '__main__':
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, interrupted)
    try:
        print(json.dumps(main(), sort_keys=True))
    except (Blocked, OSError, ValueError, TypeError, KeyError, IndexError, tarfile.TarError) as error:
        print(json.dumps({'status': 'BLOCKED', 'code': str(error) if isinstance(error, Blocked) else type(error).__name__}))
        sys.exit(2)
