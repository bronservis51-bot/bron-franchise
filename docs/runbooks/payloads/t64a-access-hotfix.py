#!/usr/bin/env python3
"""T64A: target-only migrations/catalogs. No account inventory, passwords or Source reads."""
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
    '20261116040000_staff_helper_execute.sql',
)
PREREQUISITES = {
    '20261116010000_daily_payroll.sql': '97ea41528818cebc49fc7ef88553cdcbfad671881299974c35f99295c6b3cdcd',
    '20261116020000_staff_scopes.sql': 'ace1af3e7edb101e36dff6608723e26a2ff18aadf7b74fd27e4e7a6cd34266a0',
    '20261116030000_partner_preparation.sql': '3c0a29883bea205a2da495a0d52b290fc2626a8cd9d166042be9a4e674187f53',
}
LIVE_MANIFEST = Path('/opt/bron/supabase/docker/bron/site/app/release-manifest.json')
PREVIOUS_MANIFEST_SHA = 'bad92bd51cb6a36b2af339560b23675163e1a7c68ee683db17d563693b500fac'
BACKUP_STATE = Path('/root/bron-secrets/target-backup.state.json')
HEALTH = Path('/opt/bron/supabase/docker/bron/site/status/bron-health.json')

# System catalogs only: no auth/public application rows are selected.
CATALOG_SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout='5s';\nWITH edges(caller,callee) AS (VALUES\n ('public.staff_list(uuid,date)','app_private.staff_member_scope(uuid)'),\n ('public.staff_list(uuid,date)','app_private.staff_location_scope(uuid)'),\n ('public.staff_list(uuid,date)','app_private.can_manage_user(uuid)'),\n ('public.staff_list(uuid,date)','app_private.staff_pay_policy(uuid,date)'),\n ('public.staff_home(date)','app_private.staff_pay_policy(uuid,date)'),\n ('app_private.staff_pay_policy(uuid,date)','app_private.motivation_default(text)'),\n ('public.motivation_get(uuid)','app_private.motivation_default(text)'),\n ('app_private.can_manage_user(uuid)','app_private.staff_owner(uuid)'),\n ('app_private.can_manage_user(uuid)','app_private.staff_location_scope(uuid)'),\n ('app_private.staff_location_scope(uuid)','app_private.staff_owner(uuid)'),\n ('app_private.staff_member_scope(uuid)','app_private.staff_location_scope(uuid)')\n), names(fn) AS (SELECT caller FROM edges UNION SELECT callee FROM edges), funcs AS (\n SELECT n.fn,p.oid,p.proowner,p.prosecdef,pg_get_userbyid(p.proowner) AS owner,\n        r.rolsuper AS native_superuser\n FROM names n LEFT JOIN pg_proc p ON p.oid=to_regprocedure(n.fn)\n LEFT JOIN pg_roles r ON r.oid=p.proowner\n)\nSELECT jsonb_build_object('kind','T64A_STAFF_CATALOG_ONLY',\n 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',fn,'exists',oid IS NOT NULL,\n   'owner',owner,'securityDefiner',prosecdef,'ownerNativeSuperuser',native_superuser,\n   'authenticatedExecute',CASE WHEN oid IS NOT NULL THEN has_function_privilege('authenticated',oid,'EXECUTE') END)\n   ORDER BY fn) FROM funcs),\n 'edges',(SELECT jsonb_agg(jsonb_build_object('caller',e.caller,'callee',e.callee,\n   'callerOwnerCanExecute',CASE WHEN c.oid IS NOT NULL AND h.oid IS NOT NULL\n     THEN has_function_privilege(c.proowner,h.oid,'EXECUTE') END) ORDER BY e.caller,e.callee)\n   FROM edges e JOIN funcs c ON c.fn=e.caller JOIN funcs h ON h.fn=e.callee));\nROLLBACK;\n"

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
    if (manifest.get('format') != 1 or manifest.get('task') != 'T64A'
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


def prerequisite_sql():
    values = ','.join("('%s','%s')" % item for item in PREREQUISITES.items())
    return ("DO $prerequisites$ BEGIN IF EXISTS(SELECT 1 FROM (VALUES " + values +
            ") expected(name,checksum) LEFT JOIN app_private.schema_migration m USING(name) "
            "WHERE m.name IS NULL OR m.checksum IS DISTINCT FROM expected.checksum) THEN "
            "RAISE EXCEPTION 'T64A_T63_PREREQUISITE_MISMATCH'; END IF; END $prerequisites$;")


def migration_sql(scripts):
    parts = ["BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s';",
             "SELECT pg_advisory_xact_lock(hashtextextended('bron.product.update',0));",
             prerequisite_sql()]
    for number, (entry, body) in enumerate(scripts):
        name, digest = entry['name'], entry['sha256']
        parts.extend([
            "DO $check$ BEGIN IF EXISTS(SELECT 1 FROM app_private.schema_migration "
            f"WHERE name='{name}' AND checksum<>'{digest}') THEN "
            "RAISE EXCEPTION 'MIGRATION_CHECKSUM_CONFLICT'; END IF; END $check$;",
            fr"SELECT NOT EXISTS(SELECT 1 FROM app_private.schema_migration WHERE name='{name}') AS apply_{number} \gset",
            fr"\if :apply_{number}", body,
            f"INSERT INTO app_private.schema_migration(name,checksum) VALUES('{name}','{digest}');",
            r"\endif",
        ])
    parts.extend(["NOTIFY pgrst, 'reload schema';", 'COMMIT;', "SELECT 'T64A_MIGRATIONS_COMMITTED';"])
    return '\n'.join(parts) + '\n'


def catalog():
    record = json.loads(sql(CATALOG_SQL))
    if (not isinstance(record, dict) or record.get('kind') != 'T64A_STAFF_CATALOG_ONLY'
            or len(record.get('functions', [])) != 9 or len(record.get('edges', [])) != 11):
        raise Blocked('CATALOG_SHAPE')
    if any(entry.get('exists') is not True for entry in record['functions']):
        raise Blocked('CATALOG_FUNCTION_MISSING')
    if any(entry.get('callerOwnerCanExecute') not in (True, False) for entry in record['edges']):
        raise Blocked('CATALOG_EDGE_UNVERIFIED')
    return record


def gaps(record):
    return [{'caller': entry['caller'], 'callee': entry['callee']}
            for entry in record['edges'] if entry['callerOwnerCanExecute'] is False]


def needed_grants(record):
    owners = {entry['signature']: entry.get('owner') for entry in record['functions']}
    pairs = {(owners.get(entry['caller']), entry['callee']) for entry in gaps(record)}
    return [{'databaseRole': role, 'function': function} for role, function in
            sorted(pairs, key=lambda pair: (str(pair[0]), pair[1]))]


def perform(base, manifest_path):
    if any(os.path.lexists(base / name) for name in (
            'migration-receipt.json', 'migration-intent.json', 'migration-commit.json',
            'catalog-before.json', 'catalog-after.json')):
        raise Blocked('OUTPUT_ALREADY_EXISTS_NO_REPEAT')
    scripts = migration_bundle(manifest_path)
    target_ready()
    if sha(checked_file(LIVE_MANIFEST, private=False)) != PREVIOUS_MANIFEST_SHA:
        raise Blocked('T63_LIVE_MANIFEST_MISMATCH')
    fresh = freshness()
    before = catalog()
    before_bytes = (json.dumps(before, sort_keys=True) + '\n').encode()
    private_write(base / 'catalog-before.json', before_bytes)
    private_write(base / 'migration-intent.json', (json.dumps({
        'task': 'T64A', 'status': 'APPLYING', 'migrations': [entry for entry, _ in scripts],
        'freshness': fresh, 'catalogBeforeSha256': sha(before_bytes),
        'createdUtc': dt.datetime.now(dt.timezone.utc).isoformat()
    }, sort_keys=True) + '\n').encode())
    output = sql(migration_sql(scripts), timeout=150)
    if output.splitlines()[-1:] != [b'T64A_MIGRATIONS_COMMITTED']:
        raise Blocked('MIGRATION_COMMIT_UNVERIFIED')
    result = {'task': 'T64A', 'status': 'MIGRATIONS_COMMITTED',
              'migrations': [entry for entry, _ in scripts], 'freshness': fresh,
              'catalogBeforeSha256': sha(before_bytes), 'missingExecuteBefore': gaps(before),
              'neededExecuteGrantsBefore': needed_grants(before),
              'sourceQueries': 0, 'authRowsRead': 0, 'passwordsReset': 0,
              'roleAssignmentsChanged': 0, 'actualPhoneChanges': 0,
              'staticPublished': False, 'servingMode': 'PRODUCTION_PUBLIC',
              'postgrestSchemaReloadNotified': True}
    private_write(base / 'migration-commit.json', (json.dumps(result, sort_keys=True) + '\n').encode())
    try:
        after = catalog()
        after_bytes = (json.dumps(after, sort_keys=True) + '\n').encode()
        private_write(base / 'catalog-after.json', after_bytes)
        result.update({'catalogAfterSha256': sha(after_bytes), 'missingExecuteAfter': gaps(after),
                       'neededExecuteGrantsAfter': needed_grants(after),
                       'aclGapObservedBefore': bool(gaps(before)),
                       'aclCatalogPostcheck': 'PASS' if not gaps(after) else 'BLOCKED'})
        if gaps(after):
            result['status'] = 'COMMITTED_POSTCHECK_BLOCKED'
    except (Blocked, OSError, ValueError, TypeError, KeyError) as error:
        result.update({'status': 'COMMITTED_POSTCHECK_BLOCKED',
                       'postcheckCode': str(error) if isinstance(error, Blocked) else type(error).__name__})
    private_write(base / 'migration-receipt.json', (json.dumps(result, sort_keys=True) + '\n').encode())
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--migrate', action='store_true', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise Blocked('VPS_ROOT_ONLY')
    result = perform(directory(args.directory), args.manifest)
    print(json.dumps(result, sort_keys=True))
    if result['status'] != 'MIGRATIONS_COMMITTED':
        sys.exit(2)


if __name__ == '__main__':
    try:
        main()
    except (Blocked, OSError, ValueError, TypeError, KeyError, IndexError) as error:
        code = str(error) if isinstance(error, Blocked) else type(error).__name__
        print(json.dumps({'status': 'BLOCKED', 'code': code, 'servingMode': 'PRODUCTION_PUBLIC',
                          'commitOutcome': 'INSPECT_DURABLE_COMMIT_OR_LEDGER'}))
        sys.exit(2)
