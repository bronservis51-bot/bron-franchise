#!/usr/bin/env python3
"""Native PG17 restore regression using only synthetic data in an owned container.

Run manually with an already-cached postgres:17-alpine image. This script never
pulls images, publishes ports, mounts host data, or connects to an external DB.
Every Docker command selects the local Unix socket explicitly; caller context,
TLS selectors, credentials and Docker configuration are not inherited.
"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


SOCKET = 'unix:///var/run/docker.sock'
IMAGE_TAG = 'postgres:17-alpine'
LABEL = 'bron.test.native-pg17'
DATABASE_ENTRY = re.compile(r'^\d+;\s+\d+\s+\d+\s+DATABASE\s+-\s+postgres\s', re.M)
PROPERTIES_ENTRY = re.compile(r'^\d+;\s+\d+\s+\d+\s+DATABASE PROPERTIES\s+-\s+postgres\s', re.M)
DATABASE_METADATA = re.compile(
    r'^\d+;\s+\d+\s+\d+\s+(DATABASE(?: PROPERTIES)?\s+-\s+postgres(?:\s|$)'
    r'|(?:ACL|COMMENT|SECURITY LABEL)\s+-\s+DATABASE postgres(?:\s|$))')
METADATA_SQL = """SELECT jsonb_build_object(
  'owner',pg_get_userbyid(d.datdba), 'connection_limit',d.datconnlimit,
  'acl',d.datacl::text, 'comment',shobj_description(d.oid,'pg_database'),
  'settings',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'role',CASE WHEN s.setrole=0 THEN '' ELSE pg_get_userbyid(s.setrole) END,
    'settings',s.setconfig) ORDER BY s.setrole)
    FROM pg_db_role_setting s WHERE s.setdatabase=d.oid),'[]'::jsonb))
  FROM pg_database d WHERE d.datname='postgres'"""


class FixtureFailure(RuntimeError):
    """Only fixed codes, never command output, reach the caller."""


def require(condition, code):
    if not condition:
        raise FixtureFailure(code)


class Fixture:
    def __init__(self, docker, config_directory):
        self.docker = docker
        self.environment = {
            'PATH': '/usr/local/bin:/usr/bin:/bin',
            'LANG': 'C.UTF-8',
            'LC_ALL': 'C.UTF-8',
            'DOCKER_CONFIG': config_directory,
        }
        self.marker = uuid.uuid4().hex
        self.name = 'bron-native-pg17-' + self.marker
        self.container = None
        self.image = None

    def run(self, arguments, *, input=None, check=True, timeout=30):
        options = {'input': input} if input is not None else {'stdin': subprocess.DEVNULL}
        try:
            result = subprocess.run(
                [self.docker, '--host', SOCKET, *arguments],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=timeout, env=self.environment, **options)
        except (OSError, subprocess.SubprocessError):
            raise FixtureFailure('LOCAL_DOCKER_COMMAND_FAILED') from None
        if check and result.returncode:
            raise FixtureFailure('NATIVE_FIXTURE_COMMAND_FAILED')
        return result

    def execute(self, arguments, **options):
        require(self.container is not None, 'OWNED_CONTAINER_REQUIRED')
        flags = ['-i'] if options.get('input') is not None else []
        return self.run(['exec', *flags, self.container, *arguments], **options)

    def sql(self, statement, database='postgres'):
        return self.execute([
            'psql', '-U', 'supabase_admin', '-d', database,
            '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--command', statement,
        ]).stdout

    def create(self):
        # Inspect never pulls. Run by immutable image ID even if the tag moves later.
        cached = self.run(['image', 'inspect', IMAGE_TAG], check=False)
        if cached.returncode:
            raise FixtureFailure('CACHED_POSTGRES_17_ALPINE_REQUIRED')
        image, = json.loads(cached.stdout)
        self.image = image.get('Id', '')
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', self.image) is not None,
                'CACHED_IMAGE_ID_INVALID')
        created = self.run([
            'run', '--detach', '--pull=never', '--name', self.name,
            '--label', LABEL + '=' + self.marker,
            '--network', 'none', '--restart=no', '--memory', '512m', '--cpus', '1',
            '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=256m',
            '--tmpfs', '/proof:rw,nosuid,nodev,size=32m,mode=0700',
            '-e', 'POSTGRES_USER=supabase_admin', '-e', 'POSTGRES_DB=postgres',
            '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', self.image,
        ])
        self.container = created.stdout.strip()
        require(re.fullmatch(r'[0-9a-f]{64}', self.container) is not None,
                'OWNED_CONTAINER_ID_INVALID')
        record, = json.loads(self.run(['inspect', self.container]).stdout)
        require(record.get('Config', {}).get('Labels', {}).get(LABEL) == self.marker
                and record.get('HostConfig', {}).get('NetworkMode') == 'none'
                and not record.get('HostConfig', {}).get('PortBindings')
                and record.get('Image') == self.image
                and all(m.get('Type') == 'tmpfs' and m.get('Destination') in (
                    '/var/lib/postgresql/data', '/proof') for m in record.get('Mounts', [])),
                'FIXTURE_ISOLATION_FAILED')
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            # Avoid the entrypoint's temporary init server, which also accepts Unix connections.
            process = self.execute(['cat', '/proc/1/comm'], check=False, timeout=3)
            ready = self.execute(['pg_isready', '-U', 'supabase_admin', '-d', 'postgres'],
                                 check=False, timeout=3)
            if process.returncode == 0 and process.stdout.strip() == 'postgres' and ready.returncode == 0:
                return
            time.sleep(0.1)
        raise FixtureFailure('NATIVE_POSTGRES_NOT_READY')

    def cleanup(self):
        # Also handles a run timeout after Docker created the container but before returning its ID.
        result = self.run(['inspect', self.container or self.name], check=False)
        if result.returncode:
            return
        record, = json.loads(result.stdout)
        require(record.get('Name') == '/' + self.name
                and record.get('Config', {}).get('Labels', {}).get(LABEL) == self.marker
                and (self.container is None or record.get('Id') == self.container),
                'FIXTURE_CLEANUP_OWNERSHIP_FAILED')
        self.run(['rm', '--force', '--volumes', record['Id']])
        remaining = self.run(['inspect', record['Id']], check=False)
        require(remaining.returncode != 0, 'FIXTURE_CONTAINER_STILL_EXISTS')


def exercise(fixture):
    version = int(fixture.sql("SELECT current_setting('server_version_num')").strip())
    require(170000 <= version < 180000, 'CACHED_IMAGE_IS_NOT_POSTGRES_17')
    bootstrap = json.loads(fixture.sql("""SELECT json_build_object('role',rolname,'oid',oid::integer,
        'superuser',rolsuper) FROM pg_roles WHERE oid=10"""))
    require(bootstrap == {'role': 'supabase_admin', 'oid': 10, 'superuser': True},
            'BOOTSTRAP_IDENTITY_MISMATCH')

    def rejected(statement, sqlstate, message_fragment, code):
        result = fixture.execute([
            'psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q',
            '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '--command', statement,
        ], check=False)
        require(result.returncode != 0 and re.search(r'ERROR:\s+' + sqlstate + r':', result.stderr)
                and message_fragment in result.stderr, code)

    # IF NOT EXISTS does not bypass PG17's reserved-name check, even for an existing schema.
    catalog_owner = fixture.sql("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='pg_catalog'").strip()
    rejected('CREATE SCHEMA IF NOT EXISTS pg_catalog AUTHORIZATION supabase_admin', '42939',
             'unacceptable schema name', 'RESERVED_SCHEMA_FAILURE_NOT_REPRODUCED')
    require(fixture.sql("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='pg_catalog'").strip()
            == catalog_owner == 'supabase_admin', 'RESERVED_SCHEMA_OWNER_CHANGED')

    # pg_cron and other extension scripts use DO without declaring builtin plpgsql in requires.
    plpgsql_sql = """SELECT json_build_object('name',e.extname,'version',e.extversion,
        'schema',n.nspname,'owner',pg_get_userbyid(e.extowner))
        FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='plpgsql'"""
    builtin = json.loads(fixture.sql(plpgsql_sql))
    require(builtin == {'name': 'plpgsql', 'version': '1.0', 'schema': 'pg_catalog',
                        'owner': 'supabase_admin'}, 'BUILTIN_PLPGSQL_METADATA_MISMATCH')
    fixture.sql('DO $$ BEGIN PERFORM 1; END $$')
    fixture.sql('DROP EXTENSION plpgsql')
    rejected('DO $$ BEGIN PERFORM 1; END $$', '42704', 'language "plpgsql" does not exist',
             'BUILTIN_LANGUAGE_FAILURE_NOT_REPRODUCED')
    fixture.sql("CREATE EXTENSION plpgsql WITH SCHEMA pg_catalog VERSION '1.0'")
    require(json.loads(fixture.sql(plpgsql_sql)) == builtin, 'BUILTIN_PLPGSQL_NOT_RESTORED_EXACTLY')
    fixture.sql('DO $$ BEGIN PERFORM 1; END $$')

    # The explicit grantor needs ADMIN OPTION unless it is the original bootstrap OID 10.
    # Making another role SUPERUSER does not make it equivalent to the bootstrap identity.
    fixture.sql("""CREATE ROLE qa_anon NOLOGIN NOINHERIT;
        CREATE ROLE qa_authenticator LOGIN NOINHERIT;
        CREATE ROLE qa_grantor SUPERUSER LOGIN;""")
    rejected('GRANT qa_anon TO qa_authenticator GRANTED BY qa_grantor', '42501',
             'The grantor must have the ADMIN option', 'NONBOOTSTRAP_GRANTOR_FAILURE_NOT_REPRODUCED')
    fixture.sql('GRANT qa_anon TO qa_authenticator GRANTED BY supabase_admin')
    membership = json.loads(fixture.sql("""SELECT json_build_object(
        'grantor',pg_get_userbyid(grantor),'grantor_oid',grantor::integer,
        'admin',admin_option,'inherit',inherit_option,'set',set_option)
        FROM pg_auth_members WHERE roleid='qa_anon'::regrole AND member='qa_authenticator'::regrole"""))
    require(membership == {'grantor': 'supabase_admin', 'grantor_oid': 10,
                           'admin': False, 'inherit': False, 'set': True},
            'BOOTSTRAP_GRANTOR_OR_OPTIONS_CHANGED')
    require(fixture.sql("SELECT count(*) FROM pg_auth_members WHERE roleid='qa_anon'::regrole").strip() == '1',
            'ARTIFICIAL_GRANTOR_MEMBERSHIP_ADDED')

    fixture.sql("""CREATE ROLE qa_reader LOGIN;
        CREATE ROLE qa_owner NOLOGIN;
        CREATE TABLE public.t16_marker(id int PRIMARY KEY);
        INSERT INTO public.t16_marker VALUES(42);
        ALTER DATABASE postgres OWNER TO qa_owner;
        REVOKE ALL ON DATABASE postgres FROM PUBLIC;
        GRANT CONNECT,TEMPORARY ON DATABASE postgres TO qa_reader;
        COMMENT ON DATABASE postgres IS 'Synthetic native restore regression';
        ALTER DATABASE postgres CONNECTION LIMIT 12;
        ALTER DATABASE postgres SET statement_timeout='123s';
        ALTER ROLE qa_reader IN DATABASE postgres SET search_path=public,pg_catalog;""")
    before = json.loads(fixture.sql(METADATA_SQL))
    fixture.execute([
        'pg_dump', '-U', 'supabase_admin', '-d', 'postgres', '--format=custom',
        '--create', '--compress=0', '--file=/proof/native.dump',
    ])
    ordinary = fixture.execute(['pg_restore', '--list', '/proof/native.dump']).stdout
    complete = fixture.execute(['pg_restore', '--list', '--create', '/proof/native.dump']).stdout
    database = [line for line in complete.splitlines() if DATABASE_ENTRY.match(line)]
    properties = [line for line in complete.splitlines() if PROPERTIES_ENTRY.match(line)]
    metadata = [line for line in complete.splitlines() if DATABASE_METADATA.match(line)]
    require(not DATABASE_ENTRY.search(ordinary) and not PROPERTIES_ENTRY.search(ordinary),
            'ORDINARY_LIST_UNEXPECTED_DATABASE_METADATA')
    require(len(database) == 1 and len(properties) == 1, 'CREATE_LIST_METADATA_MISSING')
    require(len(metadata) == 4 and any(' COMMENT - DATABASE postgres ' in line for line in metadata)
            and any(' ACL - DATABASE postgres ' in line for line in metadata),
            'DATABASE_ACL_OR_COMMENT_MISSING')
    fixture.execute(['tee', '/proof/properties.list'], input='\n'.join(properties) + '\n')
    fixture.execute(['tee', '/proof/metadata.list'], input='\n'.join(metadata) + '\n')
    # PG17 handles DATABASE/PROPERTIES before idWanted; a filtered final --create is unsafe.
    wrong = fixture.execute([
        'pg_restore', '-U', 'supabase_admin', '--dbname=template1', '--create',
        '--exit-on-error', '--use-list=/proof/properties.list', '/proof/native.dump',
    ], check=False)
    require(wrong.returncode != 0 and 'database "postgres" already exists' in wrong.stderr,
            'PROPERTIES_ONLY_CREATE_DID_NOT_REPRODUCE_BUG')
    fixture.sql('ALTER DATABASE postgres RENAME TO source_preserved', 'template1')
    fixture.sql('CREATE DATABASE postgres', 'template1')
    fixture.execute([
        'pg_restore', '-U', 'supabase_admin', '--dbname=template1', '--create',
        '--clean', '--if-exists', '--exit-on-error', '--use-list=/proof/metadata.list',
        '/proof/native.dump',
    ])
    require(json.loads(fixture.sql(METADATA_SQL)) == before, 'INITIAL_DATABASE_METADATA_MISMATCH')
    require(fixture.sql("SELECT to_regclass('public.t16_marker') IS NULL").strip() == 't',
            'INITIAL_METADATA_PASS_RESTORED_APPLICATION_DATA')
    # Restore application objects/data without --create; database metadata must stay intact.
    fixture.execute([
        'pg_restore', '-U', 'supabase_admin', '--dbname=postgres', '--single-transaction',
        '--exit-on-error', '/proof/native.dump',
    ])
    require(json.loads(fixture.sql(METADATA_SQL)) == before, 'FINAL_DATABASE_METADATA_MISMATCH')
    require(fixture.sql('SELECT id FROM public.t16_marker').strip() == '42',
            'APPLICATION_DATA_NOT_RESTORED')
    return {
        'status': 'PASS', 'postgres_version_num': version, 'runtime_image_id': fixture.image,
        'plain_list_hides_database_metadata': True, 'create_list_includes_database_metadata': True,
        'properties_only_create_bug_reproduced': True, 'single_metadata_pass_exact': True,
        'full_data_restore_exact': True, 'final_metadata_exact': True,
        'bootstrap_identity_preserved': True, 'no_final_create_pass': True,
        'reserved_schema_42939_reproduced': True, 'reserved_schema_owner_unchanged': True,
        'builtin_plpgsql_metadata_exact': True, 'missing_language_42704_reproduced': True,
        'do_before_drop_and_after_exact_recreation': True,
        'nonbootstrap_super_grantor_42501_reproduced': True,
        'bootstrap_grantor_and_membership_options_exact': True,
    }


def main():
    require(len(sys.argv) == 1, 'THIS_FIXTURE_ACCEPTS_NO_ARGUMENTS')
    docker = shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin')
    require(docker is not None, 'LOCAL_DOCKER_CLI_REQUIRED')
    with tempfile.TemporaryDirectory(prefix='bron-native-pg17-config-') as configuration:
        fixture = Fixture(docker, configuration)
        try:
            fixture.create()
            summary = exercise(fixture)
        finally:
            fixture.cleanup()
        summary['owned_container_removed'] = True
        print(json.dumps(summary, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except FixtureFailure as error:
        print(json.dumps({'status': 'FAIL', 'code': str(error)}))
        sys.exit(1)
    except (ValueError, OSError, subprocess.SubprocessError):
        print(json.dumps({'status': 'FAIL', 'code': 'NATIVE_FIXTURE_FAILED'}))
        sys.exit(1)
