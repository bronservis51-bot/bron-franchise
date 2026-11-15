#!/usr/bin/env python3
"""T63: swap only /srv/app contents; retain old assets; never change services or DB."""
import argparse
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile

SITE = Path('/opt/bron/supabase/docker/bron/site')
BACKENDS = {
 'supabase-db': '51071996d381fbfa6a1b6c530045881a5cee6a8c82ee482d83bbf8b47ccf8117',
 'supabase-auth': '2bcaf7d6ca9dfb6354e7faf4c64f5214e437d6f9b3536d937e97637776c49513',
 'supabase-envoy': '0e6bd75c4c74b731e5646aa3b3af73dca765dd0238c776dbdab9b26486c957ec',
 'supabase-imgproxy': '22272064135c9f15ba6a5d3cc9d01841b27132fa0062ffb5843eeeab2f45b166',
 'supabase-rest': '5497a7f68341d4f7618fe03e5eb29bc5ec7e2b750d01da17cb564beeacfdf803',
 'supabase-storage': '2a9198acaadd18f6f43ba20e4b7a78ba4ccab2a7cc6a180145b23516059772dc',
}
MIGRATIONS = ('20261116010000_daily_payroll.sql', '20261116020000_staff_scopes.sql',
              '20261116030000_partner_preparation.sql')
MAX_FILES = 2000
MAX_BYTES = 64 * 1024 * 1024


class Blocked(Exception):
    pass


def digest(value):
    return hashlib.sha256(value).hexdigest()


def relative(value):
    if (not isinstance(value, str) or not value or len(value) > 512 or '\\' in value or '\x00' in value
            or value.startswith('/') or str(PurePosixPath(value)) != value
            or any(part in ('', '.', '..', '.git') or part.startswith('.env') for part in value.split('/'))):
        raise Blocked('UNSAFE_ARTIFACT_PATH')
    return value


def safe_directory(path, private=False, owner=0):
    path = Path(path)
    entry = path.lstat()
    if (not stat.S_ISDIR(entry.st_mode) or entry.st_uid != owner or entry.st_gid != owner
            or entry.st_mode & (0o077 if private else 0o022) or path.resolve() != path):
        raise Blocked('UNSAFE_DIRECTORY')
    return path


def read_file(path, limit=MAX_BYTES, private=False, owner=0):
    path = Path(path)
    if path.resolve() != path:
        raise Blocked('UNSAFE_FILE_PATH')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        entry = os.fstat(fd)
        if (not stat.S_ISREG(entry.st_mode) or entry.st_uid != owner or entry.st_gid != owner
                or entry.st_nlink != 1 or entry.st_mode & (0o077 if private else 0o022)
                or entry.st_size > limit):
            raise Blocked('UNSAFE_FILE')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            value = source.read(limit + 1)
        if len(value) != entry.st_size or len(value) > limit:
            raise Blocked('FILE_CHANGED_OR_BOUND')
        return value
    finally:
        os.close(fd)


def sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_new(path, value, mode=0o600):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, 'wb') as output:
        os.fchmod(output.fileno(), mode)
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    sync_dir(Path(path).parent)


def json_new(path, value):
    write_new(path, (json.dumps(value, sort_keys=True) + '\n').encode())


def scan_archive(raw, pin):
    if digest(raw) != pin['archiveSha256']:
        raise Blocked('ARCHIVE_SHA')
    files, directories, seen = {}, set(), set()
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
            for member in archive:
                name = relative(member.name.rstrip('/') if member.isdir() else member.name)
                if name in seen:
                    raise Blocked('DUPLICATE_TAR_PATH')
                seen.add(name)
                if member.isdir():
                    directories.add(name)
                    continue
                if not member.isfile() or member.size < 0:
                    raise Blocked('TAR_LINK_OR_SPECIAL')
                total += member.size
                if len(files) >= MAX_FILES or total > MAX_BYTES:
                    raise Blocked('ARTIFACT_BOUND')
                source = archive.extractfile(member)
                value = source.read(member.size + 1)
                if len(value) != member.size:
                    raise Blocked('TAR_SIZE')
                files[name] = value
    except (tarfile.TarError, EOFError):
        raise Blocked('TAR_INVALID') from None
    manifest_raw = files.get('release-manifest.json', b'')
    if digest(manifest_raw) != pin['manifestSha256']:
        raise Blocked('RELEASE_MANIFEST_SHA')
    manifest = json.loads(manifest_raw)
    if (manifest.get('format') != 1 or manifest.get('sourceCommit') != pin['sourceCommit']
            or manifest.get('base') != '/' or manifest.get('apiOrigin') != 'https://api.bronservis.ru'):
        raise Blocked('RELEASE_IDENTITY')
    declared = set()
    entries = manifest.get('files')
    if not isinstance(entries, list) or not 0 < len(entries) < MAX_FILES:
        raise Blocked('MANIFEST_FILES')
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'file', 'bytes', 'sha256'}:
            raise Blocked('MANIFEST_ENTRY')
        name = relative(entry['file'])
        if name == 'release-manifest.json' or name in declared or type(entry['bytes']) is not int:
            raise Blocked('MANIFEST_ENTRY')
        declared.add(name)
        value = files.get(name)
        if value is None or len(value) != entry['bytes'] or digest(value) != entry['sha256']:
            raise Blocked('CONTENT_SHA')
    if set(files) != declared | {'release-manifest.json'}:
        raise Blocked('UNLISTED_OR_MISSING_CONTENT')
    allowed_dirs = {parent.as_posix() for name in declared for parent in PurePosixPath(name).parents
                    if parent.as_posix() != '.'}
    if not directories <= allowed_dirs:
        raise Blocked('UNLISTED_DIRECTORY')
    for required in ('index.html', 'app-version.json', 'manifest.webmanifest', 'sw.js'):
        if required not in files:
            raise Blocked('REQUIRED_APP_FILE')
    webmanifest = json.loads(files['manifest.webmanifest'])
    if webmanifest.get('scope') != '/' or webmanifest.get('start_url') != '/':
        raise Blocked('PWA_SCOPE')
    return files


def existing_assets(live, owner=0):
    root = Path(live) / 'assets'
    safe_directory(root, owner=owner)
    found = {}
    total = 0
    for current, dirs, names in os.walk(root, followlinks=False):
        safe_directory(current, owner=owner)
        for name in dirs:
            safe_directory(Path(current) / name, owner=owner)
        for name in names:
            path = Path(current) / name
            relative_name = relative(path.relative_to(live).as_posix())
            value = read_file(path, owner=owner)
            found[relative_name] = value
            total += len(value)
            if len(found) > MAX_FILES or total > MAX_BYTES:
                raise Blocked('OLD_ASSET_BOUND')
    return found


def retain_assets(new, old):
    retained = []
    for name, value in old.items():
        if not name.startswith('assets/'):
            raise Blocked('RETAIN_OUTSIDE_ASSETS')
        if name in new and new[name] != value:
            raise Blocked('SAME_ASSET_PATH_DIFFERENT_CONTENT')
        if name not in new:
            new[name] = value
            retained.append(name)
    return retained


def stage(path, files):
    path.mkdir(mode=0o755)
    os.chmod(path, 0o755)
    for name, value in files.items():
        target = path / relative(name)
        parent = path
        for part in PurePosixPath(name).parts[:-1]:
            parent = parent / part
            if not parent.exists():
                parent.mkdir(mode=0o755)
                os.chmod(parent, 0o755)
            safe_directory(parent)
        write_new(target, value, 0o644)
        if read_file(target) != value:
            raise Blocked('STAGE_READBACK')
    sync_dir(path)
    sync_dir(path.parent)


def exchange(first, second):
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        function = libc.renameat2
    except AttributeError:
        raise Blocked('ATOMIC_EXCHANGE_UNAVAILABLE') from None
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(-100, os.fsencode(first), -100, os.fsencode(second), 2):
        raise Blocked('ATOMIC_EXCHANGE_FAILED')
    sync_dir(Path(first).parent)


def command(argv, data=None, timeout=20):
    try:
        result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                check=False, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('METADATA_COMMAND_FAILED') from None
    if result.returncode or len(result.stdout) > 1024 * 1024:
        raise Blocked('METADATA_COMMAND_FAILED')
    return result.stdout


def inspect_backends():
    output = command(['docker', 'inspect', '--format', '{{json .Id}} {{json .State.Running}}', *BACKENDS])
    rows = output.decode().splitlines()
    if len(rows) != len(BACKENDS):
        raise Blocked('BACKEND_COUNT')
    for row, identity in zip(rows, BACKENDS.values()):
        if row.split() != [json.dumps(identity), 'true']:
            raise Blocked('BACKEND_IDENTITY')
    web = json.loads(command(['docker', 'inspect', '--format',
        '{"user":{{json .Config.User}},"mounts":{{json .Mounts}},"running":{{json .State.Running}}}', 'supabase-web-1']))
    mounts = [entry for entry in web.get('mounts', []) if entry.get('Destination') == '/srv']
    if (web.get('running') is not True or web.get('user') != '' or len(mounts) != 1
            or mounts[0].get('Type') != 'bind' or mounts[0].get('Source') != str(SITE)
            or mounts[0].get('RW') is not False):
        raise Blocked('WEB_PARENT_BIND_NOT_PRODUCTION')
    return dict(BACKENDS)


def ledger(pin):
    entries = pin.get('migrations')
    if not isinstance(entries, list) or tuple(entry.get('name') for entry in entries) != MIGRATIONS:
        raise Blocked('MIGRATION_ALLOWLIST')
    conditions = []
    for entry in entries:
        if set(entry) != {'name', 'sha256'} or not re.fullmatch('[0-9a-f]{64}', entry['sha256']):
            raise Blocked('MIGRATION_PIN')
        conditions.append(f"(name='{entry['name']}' AND checksum='{entry['sha256']}')")
    sql = ("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT count(*) "
           "FROM app_private.schema_migration WHERE " + ' OR '.join(conditions) + "; ROLLBACK;\n")
    output = command(['docker', 'exec', '-i', BACKENDS['supabase-db'], 'psql', '-U', 'supabase_admin',
                      '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql.encode())
    if output.strip() != b'3':
        raise Blocked('REQUIRED_MIGRATIONS_NOT_APPLIED')


def publish(directory, archive_path, pin_path):
    pin = json.loads(read_file(pin_path, private=True))
    if (pin.get('format') != 1 or pin.get('task') != 'T63'
            or any(not re.fullmatch('[0-9a-f]{64}', pin.get(key, '')) for key in ('archiveSha256', 'manifestSha256'))
            or not re.fullmatch('[0-9a-f]{40}', pin.get('sourceCommit', ''))):
        raise Blocked('PUBLISH_PIN')
    files = scan_archive(read_file(archive_path, private=True), pin)
    safe_directory(SITE)
    live = safe_directory(SITE / 'app')
    old_manifest_sha = digest(read_file(live / 'release-manifest.json'))
    suffix = pin['archiveSha256'][:16]
    staged = SITE / ('.app-stage-t63-' + suffix)
    before = SITE / ('.app-before-t63-' + suffix)
    if any(os.path.lexists(path) for path in (staged, before, directory / 'publish-intent.json', directory / 'publish-result.json')):
        raise Blocked('PUBLISH_STATE_EXISTS_NO_REPEAT')
    ids = inspect_backends()
    ledger(pin)
    retained = retain_assets(files, existing_assets(live))
    stage(staged, files)
    intent = {'task': 'T63', 'status': 'SWITCH_PENDING', 'live': str(live), 'stage': str(staged),
              'beforeImage': str(before), 'oldManifestSha256': old_manifest_sha,
              'newManifestSha256': pin['manifestSha256'], 'archiveSha256': pin['archiveSha256'],
              'retainedAssets': retained, 'backendIds': ids}
    json_new(directory / 'publish-intent.json', intent)
    exchanged = False
    try:
        exchange(live, staged)
        exchanged = True
        os.rename(staged, before)
        sync_dir(SITE)
        if digest(read_file(live / 'release-manifest.json')) != pin['manifestSha256']:
            raise Blocked('LIVE_MANIFEST_READBACK')
        if inspect_backends() != ids:
            raise Blocked('BACKENDS_CHANGED')
        result = {**intent, 'status': 'APP_PUBLISHED', 'sourceCommit': pin['sourceCommit'],
                  'retainedAssetCount': len(retained), 'serviceChanges': 0, 'dbWrites': 0,
                  'sourceQueries': 0, 'servingMode': 'PRODUCTION_PUBLIC', 'httpsChecks': 'PENDING'}
        json_new(directory / 'publish-result.json', result)
    except Exception:
        if exchanged:
            original = before if before.exists() else staged
            try:
                exchange(live, original)
                json_new(directory / 'publish-recovery.json', {'status': 'ROLLED_BACK', 'candidate': str(original)})
            except Exception:
                raise Blocked('PUBLISH_COMMIT_UNKNOWN_INSPECT_REQUIRED') from None
        raise
    return result


def rollback(directory):
    result = json.loads(read_file(directory / 'publish-result.json', private=True))
    if result.get('task') != 'T63' or result.get('status') != 'APP_PUBLISHED':
        raise Blocked('ROLLBACK_LINEAGE')
    live = SITE / 'app'
    before = Path(result['beforeImage'])
    if (before.parent != SITE or not re.fullmatch(r'\.app-before-t63-[0-9a-f]{16}', before.name)
            or os.path.lexists(directory / 'rollback-result.json')):
        raise Blocked('ROLLBACK_PATH_OR_STATE')
    safe_directory(live)
    safe_directory(before)
    if (digest(read_file(live / 'release-manifest.json')) != result['newManifestSha256']
            or digest(read_file(before / 'release-manifest.json')) != result['oldManifestSha256']):
        raise Blocked('ROLLBACK_MANIFEST_CHANGED')
    ids = inspect_backends()
    exchange(live, before)
    if (digest(read_file(live / 'release-manifest.json')) != result['oldManifestSha256']
            or inspect_backends() != ids):
        raise Blocked('ROLLBACK_RESULT_UNKNOWN')
    outcome = {'task': 'T63', 'status': 'STATIC_ROLLBACK_PASS', 'servingMode': 'PRODUCTION_PUBLIC',
               'activeManifestSha256': result['oldManifestSha256'], 'candidate': str(before), 'dbWrites': 0}
    json_new(directory / 'rollback-result.json', outcome)
    return outcome


def main():
    parser = argparse.ArgumentParser()
    flags = parser.add_mutually_exclusive_group(required=True)
    flags.add_argument('--publish', action='store_true')
    flags.add_argument('--rollback', action='store_true')
    parser.add_argument('--directory', required=True)
    parser.add_argument('--archive')
    parser.add_argument('--pin')
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise Blocked('VPS_ROOT_ONLY')
    os.umask(0o077)
    directory = safe_directory(args.directory, private=True)
    if args.publish:
        if not args.archive or not args.pin:
            raise Blocked('PUBLISH_INPUT_REQUIRED')
        result = publish(directory, args.archive, args.pin)
    else:
        result = rollback(directory)
    print(json.dumps({key: value for key, value in result.items() if key != 'retainedAssets'}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (Blocked, OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({'status': 'BLOCKED', 'code': str(error) if isinstance(error, Blocked) else type(error).__name__,
                          'servingMode': 'PRODUCTION_PUBLIC', 'dbWrites': 0}))
        sys.exit(2)
