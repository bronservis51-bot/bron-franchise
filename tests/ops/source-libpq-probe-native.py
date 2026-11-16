#!/usr/bin/env python3
"""Synthetic cached-PG17 libpq TLS proof; no source/VPS calls or published ports.

The unmodified native PG17 fixture owns the server. Each psql client shares that
server's network-none namespace, uses only synthetic credentials, and has no
server data mount. SQL and output validation come from the reviewed probe helper.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
HELPER = HERE.parent.parent / 'docs/runbooks/payloads/source-libpq-probe.mjs'
HOST = 'aws-1-us-west-2.pooler.supabase.com'
LABEL = 'bron.test.source-libpq-client'
PASSWORD = r'a:b\c'


def main():
    if len(sys.argv) != 1:
        raise RuntimeError('LIBPQ_NATIVE_NO_ARGUMENTS')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('fixture', HERE / 'restore-native-pg17.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    native.require(HELPER.is_file(), 'LIBPQ_NATIVE_HELPER_REQUIRED')
    node = shutil.which('node')
    with tempfile.TemporaryDirectory(prefix='bron-libpq-native-') as temporary:
        work = Path(temporary)
        credentials = work / 'client'
        credentials.mkdir(mode=0o700)
        def openssl(*arguments):
            subprocess.run([shutil.which('openssl'), *arguments], cwd=work, check=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        # Keep the existing native-pg-tls.py certificate recipe unchanged.
        for prefix, name in [('ca', 'bron-synthetic-ca'), ('wrong', 'bron-wrong-synthetic-ca')]:
            openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                '-subj', '/CN=' + name, '-addext', 'basicConstraints=critical,CA:TRUE',
                '-keyout', prefix + '.key', '-out', prefix + '.crt')
        openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=' + HOST,
            '-keyout', 'server.key', '-out', 'server.csr')
        (work / 'extensions.cnf').write_text('subjectAltName=DNS:' + HOST + '\n'
            'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
        openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
            '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-extfile', 'extensions.cnf')
        for name in ['ca.crt', 'wrong.crt']:
            shutil.copyfile(work / name, credentials / name)
            (credentials / name).chmod(0o600)

        fixture = native.Fixture(shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin'), temporary)
        clients = []
        def remove_client(name, marker):
            inspected = fixture.run(['inspect', name], check=False, timeout=3)
            if inspected.returncode:
                return
            record, = json.loads(inspected.stdout)
            native.require(record.get('Name') == '/' + name
                and record.get('Config', {}).get('Labels', {}).get(LABEL) == marker
                and record.get('Image') == fixture.image,
                'LIBPQ_NATIVE_CLIENT_OWNERSHIP')
            fixture.run(['rm', '--force', '--volumes', record['Id']], timeout=3)
            native.require(fixture.run(['inspect', record['Id']], check=False, timeout=3).returncode != 0,
                'LIBPQ_NATIVE_CLIENT_REMAINS')

        def credential_owner(uid, gid):
            # CI runs as UID1000; the production helper writes these files as root.
            # Change only this synthetic directory so the proof can keep --user=0
            # with all client capabilities dropped and actual 0700/0600 files.
            marker = uuid.uuid4().hex
            name = 'bron-libpq-native-' + marker
            clients.append((name, marker))
            fixture.run(['run', '--rm', '--pull=never', '--name', name,
                '--label', LABEL + '=' + marker, '--network', 'none', '--read-only',
                '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE',
                '--security-opt=no-new-privileges', '--user=0', '--log-driver=none',
                '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=1m,mode=0700',
                '--mount', 'type=bind,src=' + str(credentials) + ',dst=/probe',
                '--entrypoint', 'chown', fixture.image, '-R', str(uid) + ':' + str(gid), '/probe'],
                timeout=5)
            remove_client(name, marker)

        try:
            fixture.create()
            # SQL stdin keeps even the fixed synthetic password out of argv.
            fixture.execute(['psql', '-U', 'supabase_admin', '-d', 'postgres', '-X', '-q',
                '-v', 'ON_ERROR_STOP=1'], input="SET password_encryption='scram-sha-256';\n"
                "CREATE ROLE postgres LOGIN NOSUPERUSER PASSWORD '" + PASSWORD + "';\n")
            for source, destination in [('server.key', 'bron-native-tls.key'), ('server.crt', 'bron-native-tls.crt')]:
                fixture.execute(['sh', '-c', 'umask 077; cat > /var/lib/postgresql/data/' + destination
                    + '; chown postgres:postgres /var/lib/postgresql/data/' + destination
                    + '; chmod 600 /var/lib/postgresql/data/' + destination],
                    input=(work / source).read_text())
            # Prepend a mandatory SCRAM rule for this synthetic TCP role only.
            fixture.execute(['sh', '-c', 'umask 077; cat > /proof/hba-prefix; '
                'cat /proof/hba-prefix /var/lib/postgresql/data/pg_hba.conf > /proof/hba-new; '
                'cat /proof/hba-new > /var/lib/postgresql/data/pg_hba.conf; '
                'chown postgres:postgres /var/lib/postgresql/data/pg_hba.conf'],
                input='hostssl postgres postgres 127.0.0.1/32 scram-sha-256\n')
            for sql in ["ALTER SYSTEM SET ssl='on'",
                "ALTER SYSTEM SET ssl_cert_file='/var/lib/postgresql/data/bron-native-tls.crt'",
                "ALTER SYSTEM SET ssl_key_file='/var/lib/postgresql/data/bron-native-tls.key'"]:
                fixture.sql(sql)
            fixture.sql('SELECT pg_reload_conf()')
            for _ in range(20):
                if fixture.sql('SHOW ssl').strip() == 'on':
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('LIBPQ_NATIVE_TLS_SERVER_NOT_READY')

            # This temporary driver imports a side-effect-free helper and exercises
            # its actual streaming parser with deliberately fragmented output.
            driver = work / 'parse-native.mjs'
            driver.write_text('import fs from "node:fs";\n'
                'import {syntheticSql,SyntheticOutputParser,unsetPgEnvironment} from ' + json.dumps(HELPER.as_uri()) + ';\n'
                'if(process.argv[2]==="sql"){process.stdout.write(syntheticSql);}\n'
                'else if(process.argv[2]==="unset"){console.log(JSON.stringify(unsetPgEnvironment));}\n'
                'else {const p=new SyntheticOutputParser();const b=fs.readFileSync(0);\n'
                'for(let i=0;i<b.length;i+=8191)p.push(b.subarray(i,i+8191));\n'
                'console.log(JSON.stringify(p.finish()));}\n')
            sql = subprocess.run([node, str(driver), 'sql'], check=True, env=fixture.environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, timeout=5).stdout
            native.require(0 < len(sql) < 16384, 'LIBPQ_NATIVE_SQL_INVALID')
            unset = json.loads(subprocess.run([node, str(driver), 'unset'], check=True,
                env=fixture.environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, timeout=5).stdout)
            native.require(isinstance(unset, list) and len(unset) == len(set(unset))
                and all(isinstance(key, str) and re.fullmatch(r'PG[A-Z0-9_]+', key) for key in unset)
                and {'PGPASSWORD', 'PGOPTIONS', 'PGSSLMODE', 'PGSSLROOTCERT'}.issubset(unset)
                and not any(key.startswith('PG') for key in fixture.environment),
                'LIBPQ_NATIVE_UNSET_ENVIRONMENT_INVALID')
            unset_arguments = [value for key in unset for value in ['--env', key]]

            def probe(host=HOST, certificate='ca.crt', password=PASSWORD):
                escaped = password.replace('\\', '\\\\').replace(':', '\\:')
                (credentials / 'pgpass').write_text(host + ':5432:postgres:postgres:' + escaped + '\n')
                (credentials / 'pg_service.conf').write_text('[probe]\nhost=' + host
                    + '\nhostaddr=127.0.0.1\nport=5432\ndbname=postgres\nuser=postgres\n'
                    'sslmode=verify-full\nsslrootcert=/probe/' + certificate + '\nconnect_timeout=5\n')
                for name in ['pgpass', 'pg_service.conf']:
                    (credentials / name).chmod(0o600)
                marker = uuid.uuid4().hex
                name = 'bron-libpq-native-' + marker
                clients.append((name, marker))
                try:
                    credential_owner(0, 0)
                    result = fixture.run(['run', '--interactive', '--rm', '--pull=never', '--name', name,
                    '--label', LABEL + '=' + marker, '--network', 'container:' + fixture.container,
                    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=0',
                    '--restart=no', '--log-driver=none', '--pids-limit=32', '--memory=64m',
                    '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=1m,mode=0700',
                    '--mount', 'type=bind,src=' + str(credentials) + ',dst=/probe,readonly',
                    '--env', 'PGPASSWORD=synthetic-poison-not-password',
                    '--env', 'PGOPTIONS=-c default_transaction_read_only=off',
                    '--env', 'PGSSLMODE=disable', '--env', 'PGSSLROOTCERT=/does-not-exist',
                    *unset_arguments,
                    '--env', 'PGSERVICEFILE=/probe/pg_service.conf', '--env', 'PGPASSFILE=/probe/pgpass',
                    '--env', 'PGSERVICE=probe',
                    '--env', 'LANG=C', '--env', 'LC_ALL=C', '--entrypoint', 'psql', fixture.image,
                    '-X', '-w', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
                    input=sql, check=False, timeout=15)
                finally:
                    try:
                        remove_client(name, marker)
                    finally:
                        credential_owner(os.getuid(), os.getgid())
                native.require(len(result.stdout.encode()) <= 2 * 1024 * 1024
                    and len(result.stderr.encode()) < 16384, 'LIBPQ_NATIVE_OUTPUT_LIMIT')
                return result

            result = probe()
            if result.returncode:
                classifications = [('bind source path does not exist', 'BIND_SOURCE_MISSING'),
                    ('Permission denied', 'CREDENTIAL_PERMISSIONS'),
                    ('certificate verify failed', 'CERTIFICATE_REJECTED'),
                    ('does not match host name', 'HOSTNAME_REJECTED'),
                    ('password authentication failed', 'PASSWORD_REJECTED'),
                    ('no password supplied', 'PASSWORD_FILE_NOT_USED'),
                    ('No such file or directory', 'CLIENT_FILE_MISSING'),
                    ('syntax error', 'SERVICE_SYNTAX'),
                    ('not found', 'SERVICE_NOT_FOUND'),
                    ('invalid', 'SERVICE_PARAMETER_INVALID'),
                    ('service file', 'SERVICE_FILE_INVALID'),
                    ('SSL is not enabled', 'SERVER_TLS_NOT_READY'),
                    ('no pg_hba.conf entry', 'HBA_REJECTED'),
                    ('Connection refused', 'SERVER_NOT_REACHABLE')]
                reason = next((code for text, code in classifications if text in result.stderr),
                    'EXIT_' + str(result.returncode))
                raise RuntimeError('LIBPQ_NATIVE_VERIFIED_TLS_' + reason)
            parsed = subprocess.run([node, str(driver), 'parse'], env=fixture.environment,
                input=result.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
            native.require(parsed.returncode == 0, 'LIBPQ_NATIVE_SYNTHETIC_PARSE_FAILED')
            summary = json.loads(parsed.stdout)
            native.require(summary.get('frontendTls') is True and summary.get('readOnly') is True
                and summary.get('bulkBytes') == 1048576, 'LIBPQ_NATIVE_SYNTHETIC_NOT_PASS')
            summary['status'] = 'PASS'
            wrong_ca = probe(certificate='wrong.crt')
            native.require(wrong_ca.returncode != 0 and 'certificate verify failed' in wrong_ca.stderr,
                'LIBPQ_NATIVE_WRONG_CA_NOT_REJECTED')
            wrong_host = probe(host='wrong.invalid')
            native.require(wrong_host.returncode != 0 and 'does not match host name' in wrong_host.stderr,
                'LIBPQ_NATIVE_WRONG_HOST_NOT_REJECTED')
            wrong_password = probe(password='synthetic-wrong-password')
            native.require(wrong_password.returncode != 0
                and 'password authentication failed' in wrong_password.stderr,
                'LIBPQ_NATIVE_SCRAM_NOT_ENFORCED')
            version = fixture.execute(['psql', '--version']).stdout.strip()
            native.require(re.fullmatch(r'psql \(PostgreSQL\) 17\.[0-9]+', version) is not None,
                'LIBPQ_NATIVE_CLIENT_NOT_PG17')
            summary.update({'client': version, 'cachedImageId': fixture.image, 'actualLibpqTls': True,
                'actualRootOnlyCredentials': True, 'actualHelperSqlAndParser': True,
                'poisonedPgEnvironmentCleared': True,
                'canonicalHostnameVerified': True, 'wrongCaRejected': True,
                'wrongHostnameRejected': True, 'escapedPgpassScramAuthenticated': True,
                'wrongPasswordRejected': True, 'sourceOrVpsContact': False,
                'hostPorts': False, 'realKeysOrData': False})
        finally:
            for name, marker in clients:
                remove_client(name, marker)
            fixture.cleanup()
        summary['ownedContainersRemoved'] = True
    assert not work.exists()
    summary['syntheticKeysRemoved'] = True
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        code = str(error)
        if re.fullmatch(r'[A-Z][A-Z0-9_]{1,80}', code) is None:
            code = 'LIBPQ_NATIVE_FIXTURE_FAILED'
        print(json.dumps({'status': 'FAIL', 'code': code}))
        sys.exit(1)
