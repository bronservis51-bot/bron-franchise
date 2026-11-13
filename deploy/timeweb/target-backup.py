#!/usr/bin/env python3
"""Encrypted backups of the Russian self-hosted target; never uses the Mac tunnel.

Reuse the migration pipeline and restricted S3 uploader. No restore, deletion,
source access, container lifecycle changes or plaintext backup files.
"""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
WORKDIR = Path('/opt/bron/supabase/docker')
STORAGE = WORKDIR / 'volumes/storage'
STATE = Path('/root/bron-secrets/target-backup.state.json')
ALERT = Path('/root/bron-secrets/backup-alert')
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/root', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8'}


def dependency(name):
    path = HERE / name
    for directory in (HERE, HERE.parent):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise RuntimeError('UNSAFE_BACKUP_CODE_DIRECTORY')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise RuntimeError('UNSAFE_BACKUP_CODE_FILE')
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


source = dependency('source-backup.py')
s3 = dependency('backup-s3.py')
BackupError = s3.BackupError


def capture(command, timeout=30):
    try:
        return subprocess.run(command, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=timeout, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        raise BackupError('TARGET_COMMAND_FAILED') from None


def inspect(name):
    raw = capture(DOCKER + ['inspect', name])
    if len(raw) > 1024 * 1024:
        raise BackupError('TARGET_INSPECT_TOO_LARGE')
    record, = json.loads(raw)
    if record.get('Name') != '/' + name or not record.get('State', {}).get('Running'):
        raise BackupError('TARGET_CONTAINER_NOT_RUNNING')
    if not re.fullmatch(r'[0-9a-f]{64}', record.get('Id', '')):
        raise BackupError('TARGET_CONTAINER_ID_INVALID')
    return record


def values(record):
    result = {}
    for entry in record.get('Config', {}).get('Env', []):
        key, sep, value = entry.partition('=')
        if not sep or key in result:
            raise BackupError('TARGET_CONTAINER_ENV_INVALID')
        result[key] = value
    return result


def db_command(record, binary, *args, interactive=False):
    return DOCKER + ['exec'] + (['-i'] if interactive else []) + [
        '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=1200000',
        record['Id'], binary, '--host=127.0.0.1', '--username=supabase_admin',
        '--no-password', *args]


class TargetSnapshot(source.Snapshot):
    # The proven request/reply, heartbeat and transaction guards are inherited.
    def __init__(self, record):
        self.process = subprocess.Popen(db_command(record, 'psql', '--dbname=postgres',
            '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', interactive=True),
            env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True, bufsize=0)
        self.metadata = None
        self.deadline = time.monotonic() + 30 * 60
        self.last_heartbeat = None
        self.last_reply_bytes = 0
        self.capture_stderr = False


def preflight():
    s3.runtime_guard()
    source.secure_path(source.IDENTITY_FILE)  # Never generate a replacement recovery key.
    for name in ('docker', 'age', 'age-keygen', 'zstd', 'tar'):
        if shutil.which(name, path=ENV['PATH']) is None:
            raise BackupError('TARGET_EXECUTABLE_MISSING')
    if shutil.disk_usage(s3.BACKUP_ROOT).free < 2 * 1024 ** 3:
        raise BackupError('TARGET_DISK_HEADROOM_REQUIRED')
    db, storage = inspect('supabase-db'), inspect('supabase-storage')
    config = values(db)
    if (config.get('POSTGRES_USER') != 'supabase_admin' or config.get('POSTGRES_DB') != 'postgres'
            or not config.get('POSTGRES_PASSWORD') or config.get('PGPASSWORD') != config['POSTGRES_PASSWORD']):
        raise BackupError('TARGET_DATABASE_CONFIGURATION_MISMATCH')
    image = 'supabase/postgres:17.11.0.019'
    if db.get('Config', {}).get('Image') not in (image,
            image + '@sha256:eca9f664ced0c453ae499e75bb503283831c94f2eef69fc2e69bf86f70278ddc'):
        raise BackupError('TARGET_DATABASE_IMAGE_MISMATCH')
    for command in ('pg_dump', 'pg_dumpall'):
        version = capture(DOCKER + ['exec', db['Id'], command, '--version']).decode().strip()
        if not re.match(rf'^{command} \(PostgreSQL\) 17\.11(?:\s|$)', version):
            raise BackupError('TARGET_POSTGRES_CLIENT_VERSION_MISMATCH')
    if values(storage).get('STORAGE_BACKEND') != 'file':
        raise BackupError('TARGET_FILE_STORAGE_BACKEND_REQUIRED')
    mounts = [m for m in storage.get('Mounts', []) if m.get('Destination') == '/var/lib/storage']
    if len(mounts) != 1 or mounts[0].get('Type') != 'bind' or mounts[0].get('Source') != str(STORAGE):
        raise BackupError('TARGET_STORAGE_MOUNT_MISMATCH')
    if STORAGE.resolve() != STORAGE or not STORAGE.is_dir():
        raise BackupError('TARGET_STORAGE_DIRECTORY_MISMATCH')
    source.secure_path(WORKDIR / '.env')
    s3.sdk_modules()
    s3.credentials()
    s3.read_private_json(s3.PROBE_RECEIPT)
    return db, storage, config_paths(db)


def config_paths(db):
    paths = [WORKDIR / '.env', WORKDIR / 'docker-compose.yml']
    paths += sorted((WORKDIR / 'bron').glob('compose*.yml'))
    paths += sorted((WORKDIR / 'bron').glob('Caddyfile*'))
    # Capture runtime Envoy/init configuration too; never the adjacent PGDATA.
    if (WORKDIR / 'volumes/api/envoy').exists():
        paths.append(WORKDIR / 'volumes/api/envoy')
    paths += sorted((WORKDIR / 'volumes/db').glob('*.sql'))
    files = db.get('Config', {}).get('Labels', {}).get('com.docker.compose.project.config_files', '')
    if not files:
        raise BackupError('TARGET_COMPOSE_FILE_LABEL_REQUIRED')
    for value in files.split(','):
        path = Path(value)
        if not path.is_relative_to(WORKDIR) or path.suffix not in ('.yml', '.yaml'):
            raise BackupError('TARGET_COMPOSE_CONFIG_OUTSIDE_BACKUP_SCOPE')
        if path not in paths:
            paths.append(path)
    mounts = [m for m in db.get('Mounts', []) if m.get('Destination') == '/etc/postgresql-custom']
    if len(mounts) != 1:
        raise BackupError('TARGET_DB_CONFIG_MOUNT_REQUIRED')
    custom = Path(mounts[0]['Source'])
    if (mounts[0].get('Type') != 'volume' or not str(custom).startswith('/var/lib/docker/volumes/')
            or custom.name != '_data' or custom.resolve() != custom or not custom.is_dir()):
        raise BackupError('TARGET_DB_CONFIG_MOUNT_MISMATCH')
    paths.append(custom)  # Includes the pgsodium root key; excludes live PGDATA.
    for path in paths:
        if path.resolve() != path or not path.exists():
            raise BackupError('TARGET_CONFIG_PATH_INVALID')
    return paths


def tree_signature(paths):
    """Compare bytes too, not just mtimes. Names and digests never leave RAM."""
    digest = hashlib.sha256()
    def visit(path):
        info = path.lstat()
        digest.update(str(path).encode() + b'\0')
        if stat.S_ISDIR(info.st_mode):
            digest.update(b'd\0')
            for child in sorted(path.iterdir()):
                visit(child)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            digest.update(b'f\0')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                opened = os.fstat(stream.fileno())
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise BackupError('TARGET_FILE_CHANGED_DURING_SCAN')
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            after = path.stat()
            if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (
                    after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
                raise BackupError('TARGET_FILE_CHANGED_DURING_SCAN')
        else:
            raise BackupError('TARGET_ARCHIVE_UNSAFE_FILE_TYPE')
    for path in paths:
        visit(path)
    return digest.digest()


def storage_signature(record, keeper=None):
    sql = """SELECT json_build_object('storage', md5(coalesce((SELECT string_agg(row_value,'|' ORDER BY row_value)
      FROM (SELECT to_jsonb(o)::text AS row_value FROM storage.objects o
      UNION ALL SELECT to_jsonb(b)::text FROM storage.buckets b) x),'')));\n"""
    if keeper is not None:
        keeper._send(sql.encode())
        return keeper._read_json(30, 'target_storage_guard')['storage']
    output = capture(db_command(record, 'psql', '--dbname=postgres', '-X', '-q', '-A', '-t',
        '-v', 'ON_ERROR_STOP=1', '--command', 'BEGIN READ ONLY;' + sql + 'ROLLBACK;'))
    return json.loads(output)['storage']


def save_state(value):
    temporary = STATE.with_name('.target-backup.state.' + uuid.uuid4().hex)
    try:
        source.private_file(temporary, (json.dumps(value, sort_keys=True) + '\n').encode())
        os.replace(temporary, STATE)
    finally:
        temporary.unlink(missing_ok=True)


def existing_recipient():
    source.secure_path(source.IDENTITY_FILE)
    value = capture(['/usr/bin/age-keygen', '-y', str(source.IDENTITY_FILE)]).decode().strip()
    if not re.fullmatch(r'age1[0-9a-z]{40,100}', value):
        raise BackupError('TARGET_EXISTING_RECIPIENT_INVALID')
    return value


def upload(manifest, now):
    state = s3.read_private_json(STATE) if os.path.lexists(STATE) else {}
    with s3.operation_lock():
        credentials = s3.credentials()
        client = s3.s3_client(credentials, allow_target=True)
        try:
            s3.upload_target(manifest, credentials, client, 'hourly')
            # Only successful, read-back-verified uploads advance their state.
            state['last_success_utc'] = now.isoformat()
            save_state(state)
            for period, stamp in (('daily', now.strftime('%Y-%m-%d')),
                                  ('monthly', now.strftime('%Y-%m'))):
                if state.get(period) == stamp:
                    continue
                s3.upload_target(manifest, credentials, client, period)
                state[period] = stamp
                save_state(state)
        finally:
            client.close()


def backup(db, config):
    fd = os.open(s3.BACKUP_ROOT / '.target-backup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        source.secure_path(s3.BACKUP_ROOT / '.target-backup.lock')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError('TARGET_BACKUP_ALREADY_RUNNING') from None
        now = datetime.datetime.now(datetime.timezone.utc)
        stamp = now.strftime('%Y%m%dT%H%M%SZ')
        directory = s3.BACKUP_ROOT / f'target-{stamp}-{uuid.uuid4().hex[:8]}'
        directory.mkdir(mode=0o700)
        recipient = existing_recipient()
        keeper = TargetSnapshot(db)
        try:
            metadata = keeper.start()
            schema_signature = storage_signature(db, keeper)
            before = tree_signature([STORAGE, *config])
            snapshot = metadata['snapshot']
            logical = f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '{snapshot}';
COPY (SELECT id,name,description,decrypted_secret,created_at,updated_at
FROM vault.decrypted_secrets ORDER BY id) TO STDOUT WITH (FORMAT CSV, HEADER true);
ROLLBACK;"""
            commands = [
                ('database.dump', db_command(db, 'pg_dump', '--dbname=postgres', '--format=custom',
                    '--compress=0', '--lock-wait-timeout=5s', '--snapshot=' + snapshot)),
                ('roles.sql', db_command(db, 'pg_dumpall', '--globals-only', '--database=postgres')),
                ('vault-logical.csv', db_command(db, 'psql', '--dbname=postgres', '-X', '-q', '-A', '-t',
                    '-v', 'ON_ERROR_STOP=1', '--command', logical)),
                ('config.tar', ['/usr/bin/tar', '--create', '--file=-', '--directory=/',
                    *[str(path.relative_to('/')) for path in config]]),
                ('storage.tar', ['/usr/bin/tar', '--create', '--file=-', '--directory=' + str(STORAGE), '.']),
            ]
            artifacts = [source.encrypted_artifact(directory, name, command, ENV, recipient, keeper)
                         for name, command in commands]
            if before != tree_signature([STORAGE, *config]):
                raise BackupError('TARGET_FILES_CHANGED_DURING_BACKUP')
            keeper.finish()
            if schema_signature != storage_signature(db):
                raise BackupError('TARGET_STORAGE_METADATA_CHANGED_DURING_BACKUP')
            manifest = {'format': 1, 'status': 'target_backup_saved_restore_unverified',
                'complete': False, 'target': 'bron-franchise-russia', 'created_utc': stamp,
                'storage_objects': metadata['objects'], 'artifacts': artifacts,
                'metadata': {'postgres_version_num': metadata['server_version_num'],
                    'database_image': db['Image'], 'snapshot': snapshot,
                    'encryption_recipient': recipient, 'db_config_included': True,
                    'storage_consistency': 'stable_before_after'},
                'missing': ['isolated_target_restore_not_verified', 'independent_key_custody_not_verified',
                            'concurrent_storage_overwrite_not_verified']}
            source.private_file(directory / 'manifest.json.part', (json.dumps(manifest, sort_keys=True) + '\n').encode())
            os.rename(directory / 'manifest.json.part', directory / 'manifest.json')
            upload(directory / 'manifest.json', now)
            print(json.dumps({'status': 'TARGET_BACKUP_UPLOADS_READBACK_VERIFIED',
                'local_directory': str(directory), 'storage_objects': metadata['objects'],
                'complete': False, 'restore_verified': False}))
        finally:
            keeper.stop()


def check_age():
    state = s3.read_private_json(STATE)
    last = datetime.datetime.fromisoformat(state.get('last_success_utc', ''))
    if last.tzinfo is None or not 0 <= (datetime.datetime.now(datetime.timezone.utc) - last).total_seconds() <= 4200:
        raise BackupError('TARGET_BACKUP_STALE')
    print(json.dumps({'status': 'TARGET_BACKUP_FRESH', 'maximum_age_seconds': 4200}))


def check_health():
    check_age()
    if shutil.disk_usage(s3.BACKUP_ROOT).free < 2 * 1024 ** 3:
        raise BackupError('TARGET_DISK_HEADROOM_REQUIRED')
    memory = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, _, value = line.partition(':')
        if key == 'MemAvailable':
            memory[key] = int(value.split()[0])
    if memory.get('MemAvailable', 0) < 256 * 1024:
        raise BackupError('TARGET_MEMORY_HEADROOM_REQUIRED')
    for name in ('supabase-db', 'supabase-auth', 'supabase-rest', 'supabase-storage',
                 'supabase-envoy'):
        record = inspect(name)
        if record['State'].get('Health', {}).get('Status', 'healthy') != 'healthy':
            raise BackupError('TARGET_SERVICE_UNHEALTHY')
    names = capture(DOCKER + ['ps', '--all', '--filter', 'label=com.docker.compose.project=supabase',
        '--filter', 'label=com.docker.compose.service=web', '--format', '{{.Names}}']).decode().splitlines()
    if len(names) != 1 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', names[0]):
        raise BackupError('TARGET_WEB_SERVICE_MISSING_OR_AMBIGUOUS')
    inspect(names[0])
    print(json.dumps({'status': 'TARGET_HEALTH_CHECK_PASSED'}))


def alert():
    """A separately configured transport consumes a fixed, non-sensitive event."""
    info = ALERT.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise BackupError('TARGET_ALERT_TRANSPORT_NOT_CONFIGURED')
    capture([str(ALERT), 'BRON_TARGET_BACKUP_OR_HEALTH_FAILURE'], timeout=30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--backup', action='store_true')
    mode.add_argument('--check-age', action='store_true')
    mode.add_argument('--check-health', action='store_true')
    mode.add_argument('--alert', action='store_true')
    mode.add_argument('--alert-on-failure', action='store_true')
    args = parser.parse_args()
    s3.runtime_guard()
    if args.alert_on_failure:
        if os.environ.get('SERVICE_RESULT') != 'success':
            alert()
    elif args.alert:
        alert()
    elif args.check_age:
        check_age()
    elif args.check_health:
        check_health()
    else:
        db, _storage, config = preflight()
        if args.backup:
            backup(db, config)
        else:
            tree_signature([STORAGE, *config])
            print(json.dumps({'status': 'TARGET_LOCAL_PREFLIGHT_PASSED', 'database_dumped': False}))


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise BackupError('TARGET_BACKUP_INTERRUPTED')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        print(json.dumps({'status': 'TARGET_BACKUP_CANCELLED'}))
        sys.exit(130)
    except Exception as error:
        code = str(error) if isinstance(error, (BackupError, source.BackupError)) else 'TARGET_BACKUP_FAILED'
        print(json.dumps({'status': code, 'complete': False}))
        sys.exit(1)
