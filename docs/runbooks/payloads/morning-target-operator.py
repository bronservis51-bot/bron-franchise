#!/usr/bin/env python3
"""Target-only morning inventory/migrations. Never reads Auth secrets or resets accounts."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

DB_ID = '51071996d381fbfa6a1b6c530045881a5cee6a8c82ee482d83bbf8b47ccf8117'
DB_IMAGE = 'sha256:eca9f664ced0c453ae499e75bb503283831c94f2eef69fc2e69bf86f70278ddc'
MIGRATIONS = (
    '20261116010000_daily_payroll.sql',
    '20261116020000_staff_scopes.sql',
    '20261116030000_partner_preparation.sql',
)
BACKUP_STATE = Path('/root/bron-secrets/target-backup.state.json')
HEALTH = Path('/opt/bron/supabase/docker/bron/site/status/bron-health.json')

# Public application metadata only. No auth.users, auth.identities, sessions,
# tokens, encrypted_password, environment, or backup contents are selected.
INVENTORY_SQL = """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='15s'; SET LOCAL timezone='UTC';
SELECT json_build_object(
 'users',coalesce((SELECT json_agg(json_build_object(
   'id',u.id,'full_name',u.full_name,'email',u.email,'status',u.status,'is_demo',u.is_demo,
   'roles',coalesce((SELECT json_agg(json_build_object('role',a.role,'partner_id',a.scope_id))
      FROM public.role_assignment a WHERE a.user_id=u.id AND a.revoked_at IS NULL),'[]'::json),
   'staff',(SELECT json_build_object('partner_id',s.partner_id,'phone',s.phone,
      'location_ids',s.location_ids,'active',s.active,'employee_kind',s.employee_kind,
      'internship_from',s.internship_from,'internship_until',s.internship_until,
      'internship_floor_minor',s.internship_floor_minor,'rate_bp',s.rate_bp,
      'shift_fee_minor',s.shift_fee_minor,'use_partner_motivation',s.use_partner_motivation)
      FROM public.staff_member s WHERE s.user_id=u.id)) ORDER BY u.full_name,u.id)
   FROM public.app_user u),'[]'::json),
 'partners',coalesce((SELECT json_agg(json_build_object('id',p.id,'name',p.name,
   'contact_name',p.contact_name,'currency',p.currency,'status',p.status) ORDER BY p.id)
   FROM public.partner p),'[]'::json),
 'locations',coalesce((SELECT json_agg(json_build_object('id',l.id,'name',l.name,
   'partner_id',l.partner_id,'currency',l.currency,'timezone',l.timezone,
   'status',l.status) ORDER BY l.id) FROM public.location l),'[]'::json)
);
ROLLBACK;
"""


class Blocked(Exception):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked_file(path, private=True):
    path = Path(path)
    info = path.lstat()
    mask = 0o077 if private else 0o022
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0
            or info.st_gid != 0 or info.st_mode & mask or path.resolve() != path):
        raise Blocked('UNSAFE_FILE')
    return path.read_bytes()


def directory(path):
    path = Path(path)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
            or info.st_mode & 0o077 or path.resolve() != path):
        raise Blocked('UNSAFE_DIRECTORY')
    return path


def private_write(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    parent = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    if checked_file(path) != data:
        raise Blocked('FILE_READBACK')


def run(argv, data=None, timeout=25):
    try:
        result = subprocess.run(argv, input=data, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked('TARGET_COMMAND_FAILED') from None
    # Do not include native stdout/stderr: they can contain private SQL values.
    if result.returncode:
        # VERBOSITY=sqlstate prevents native diagnostics from disclosing input.
        # Retain only the fixed PostgreSQL error code for an actionable stop.
        code = re.search(rb'ERROR:\s+([0-9A-Z]{5})(?:\s|$)', result.stderr)
        raise Blocked('TARGET_SQL_' + code.group(1).decode() if code else 'TARGET_COMMAND_FAILED')
    if len(result.stdout) > 2 * 1024 * 1024:
        raise Blocked('TARGET_COMMAND_FAILED')
    return result.stdout


def target_ready():
    raw = run(['docker', 'inspect', '--format',
               '{{json .Id}} {{json .Image}} {{json .State.Running}} {{json .State.Health.Status}}', DB_ID])
    fields = raw.decode().strip().split()
    if fields != [json.dumps(DB_ID), json.dumps(DB_IMAGE), 'true', '"healthy"']:
        raise Blocked('TARGET_IDENTITY_OR_HEALTH')


def sql(data, timeout=30):
    return run(['docker', 'exec', '-i', DB_ID, 'psql', '-U', 'supabase_admin',
                '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                '-v', 'VERBOSITY=sqlstate'],
               data.encode(), timeout)


def login_for(user):
    email = user.get('email') or ''
    for suffix in ('@access.bron.local', '@staff.bron.local'):
        if email.endswith(suffix):
            return email[:-len(suffix)]
    return email or (user.get('staff') or {}).get('phone') or 'Логин не указан'


def norm(text):
    return ' '.join(str(text or '').casefold().split())


def inventory(directory_path, private_input):
    # Exactly one target snapshot. Subject matching occurs in memory, not via extra queries.
    record = json.loads(sql(INVENTORY_SQL))
    if set(record) != {'users', 'partners', 'locations'} or any(
            not isinstance(record[key], list) or len(record[key]) > 10000 for key in record):
        raise Blocked('INVENTORY_SHAPE')
    subjects = private_input.get('subjects', [])
    if not isinstance(subjects, list) or len(subjects) > 10:
        raise Blocked('INPUT_SUBJECTS')
    matches = {}
    for item in subjects:
        if (not isinstance(item, dict) or set(item) != {'key', 'name'}
                or not re.fullmatch(r'[a-z][a-z0-9_]{0,39}', item['key']) or not norm(item['name'])):
            raise Blocked('INPUT_SUBJECTS')
        name = norm(item['name'])
        users = [user for user in record['users'] if norm(user['full_name']) == name]
        partners = [partner for partner in record['partners']
                    if norm(partner['name']) == name or norm(partner['contact_name']) == name]
        partner_ids = {partner['id'] for partner in partners}
        for user in users:
            if user.get('staff'):
                partner_ids.add(user['staff']['partner_id'])
            partner_ids.update(role['partner_id'] for role in user['roles'] if role.get('partner_id'))
        locations = [location for location in record['locations']
                     if location['partner_id'] in partner_ids]
        matches[item['key']] = {'users': users, 'partners': partners, 'locations': locations,
                                'uniqueLocation': len(locations) == 1}
    record['subjects'] = matches
    json_bytes = (json.dumps(record, ensure_ascii=False, sort_keys=True) + '\n').encode()
    text = ['Доступы к https://app.bronservis.ru/',
            'Конфиденциально. Только для владельца и личной передачи соответствующему пользователю.',
            'Существующие пароли не извлекаются из хешей. Пароли НЕ сбрасывались.',
            'Восстановление: владелец меняет пароль сотрудника в кабинете; сотрудник — свой в профиле.', '']
    role_names = {'franchise_manager': 'Менеджер по франшизе', 'franchisee': 'Франчайзи',
                  'franchisee_manager': 'Управляющий точки', 'franchisee_staff': 'Сотрудник',
                  'technical_specialist': 'Технический специалист'}
    for user in record['users']:
        roles = ', '.join(role_names.get(role['role'], role['role']) for role in user['roles']) or 'Нет действующего назначения'
        text.extend([user['full_name'], 'Логин: ' + login_for(user), 'Статус: ' + user['status'],
                     'Роли: ' + roles, 'Пароль: не хранится в открытом виде; ранее выданный пароль не изменён.', ''])
    text_bytes = ('\n'.join(text) + '\n').encode()
    private_write(directory_path / 'account-inventory.json', json_bytes)
    private_write(directory_path / 'owner-logins.txt', text_bytes)
    return {'status': 'INVENTORY_SAVED', 'targetReadSnapshots': 1, 'users': len(record['users']),
            'locations': len(record['locations']), 'passwordsRead': 0, 'passwordsReset': 0,
            'subjectCounts': {key: {'users': len(value['users']), 'locations': len(value['locations']),
                                   'uniqueLocation': value['uniqueLocation']} for key, value in matches.items()},
            'inventorySha256': sha(json_bytes), 'ownerTxtSha256': sha(text_bytes),
            'ownerTxtPath': str(directory_path / 'owner-logins.txt')}


def freshness(now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    backup = json.loads(checked_file(BACKUP_STATE))
    health = json.loads(checked_file(HEALTH, private=False))
    try:
        def age(value):
            parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError()
            return (now - parsed).total_seconds()
        backup_age = age(backup['last_success_utc'])
        health_backup_age = age(health['last_backup_utc'])
        check_age = age(health['checked_at'])
        if (health['healthy'] is not True or not 0 <= backup_age <= 4200
                or not 0 <= health_backup_age <= 4200 or not 0 <= check_age <= 1800):
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise Blocked('BACKUP_OR_HEALTH_STALE') from None
    return {'backupAgeSeconds': round(backup_age), 'healthAgeSeconds': round(check_age)}


def migration_bundle(manifest_path):
    manifest_path = Path(manifest_path)
    manifest = json.loads(checked_file(manifest_path))
    entries = manifest.get('migrations', [])
    if (manifest.get('format') != 1 or manifest.get('task') != 'T63'
            or not isinstance(entries, list) or tuple(entry.get('name') for entry in entries) != MIGRATIONS):
        raise Blocked('MIGRATION_ALLOWLIST')
    scripts = []
    for entry in entries:
        if set(entry) != {'name', 'sha256'} or not re.fullmatch(r'[0-9a-f]{64}', entry['sha256']):
            raise Blocked('MIGRATION_MANIFEST')
        content = checked_file(manifest_path.parent / entry['name'])
        if sha(content) != entry['sha256']:
            raise Blocked('MIGRATION_SHA')
        # The SHA-pinned reviewed migrations cannot contain psql meta commands or
        # transaction boundaries that escape the surrounding atomic transaction.
        body = content.decode('utf-8')
        if any(line.lstrip().startswith('\\') for line in body.splitlines()):
            raise Blocked('MIGRATION_PSQL_COMMAND')
        scripts.append((entry, body))
    return scripts


def migration_sql(scripts):
    parts = ["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';",
             "SELECT pg_advisory_xact_lock(hashtextextended('bron.morning.migrations',0));"]
    for number, (entry, body) in enumerate(scripts):
        name, digest = entry['name'], entry['sha256']
        # Names and digests are exact allowlisted values, never arbitrary SQL input.
        parts.extend([
            "DO $check$ BEGIN IF EXISTS(SELECT 1 FROM app_private.schema_migration "
            f"WHERE name='{name}' AND checksum<>'{digest}') THEN "
            "RAISE EXCEPTION 'MIGRATION_CHECKSUM_CONFLICT'; END IF; END $check$;",
            f"SELECT NOT EXISTS(SELECT 1 FROM app_private.schema_migration WHERE name='{name}') AS apply_{number} \\gset",
            f"\\if :apply_{number}", body,
            f"INSERT INTO app_private.schema_migration(name,checksum) VALUES('{name}','{digest}');",
            "\\endif",
        ])
    parts.extend(['COMMIT;', "SELECT 'T63_MIGRATIONS_COMMITTED';"])
    return '\n'.join(parts) + '\n'


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--inventory', action='store_true')
    group.add_argument('--migrate', action='store_true')
    parser.add_argument('--directory', required=True)
    parser.add_argument('--private-input')
    parser.add_argument('--manifest')
    args = parser.parse_args()
    os.umask(0o077)
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise Blocked('VPS_ROOT_ONLY')
    base = directory(args.directory)
    receipt = base / ('inventory-receipt.json' if args.inventory else 'migration-receipt.json')
    outputs = [receipt]
    if args.inventory:
        outputs.extend([base / 'account-inventory.json', base / 'owner-logins.txt'])
    else:
        outputs.append(base / 'migration-intent.json')
    if any(os.path.lexists(path) for path in outputs):
        raise Blocked('OUTPUT_ALREADY_EXISTS_NO_REPEAT')
    target_ready()
    if args.inventory:
        inputs = json.loads(checked_file(args.private_input)) if args.private_input else {}
        result = inventory(base, inputs)
    else:
        if not args.manifest:
            raise Blocked('MIGRATION_MANIFEST_REQUIRED')
        scripts = migration_bundle(args.manifest)
        fresh = freshness()
        private_write(base / 'migration-intent.json', (json.dumps({
            'task': 'T63', 'status': 'APPLYING', 'migrations': [entry for entry, _ in scripts],
            'freshness': fresh, 'createdUtc': dt.datetime.now(dt.timezone.utc).isoformat()
        }, sort_keys=True) + '\n').encode())
        output = sql(migration_sql(scripts), timeout=150)
        if output.splitlines()[-1:] != [b'T63_MIGRATIONS_COMMITTED']:
            raise Blocked('MIGRATION_COMMIT_UNVERIFIED')
        result = {'status': 'MIGRATIONS_COMMITTED', 'migrations': [entry for entry, _ in scripts],
                  'freshness': fresh, 'sourceQueries': 0, 'passwordsReset': 0,
                  'staticPublished': False, 'servingMode': 'PRODUCTION_PUBLIC'}
    private_write(receipt, (json.dumps(result, sort_keys=True) + '\n').encode())
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (Blocked, OSError, ValueError, TypeError, KeyError, IndexError) as error:
        code = str(error) if isinstance(error, Blocked) else type(error).__name__
        print(json.dumps({'status': 'BLOCKED', 'code': code, 'servingMode': 'PRODUCTION_PUBLIC'}))
        sys.exit(2)
