#!/usr/bin/env python3
"""Synthetic PG17/pg8.23.1 actual TLS; cached image, tmpfs, no published ports."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
HOST = 'aws-1-us-west-2.pooler.supabase.com'


def main():
    if len(sys.argv) != 1:
        raise RuntimeError('NATIVE_TLS_NO_ARGUMENTS')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('fixture', HERE / 'restore-native-pg17.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    with tempfile.TemporaryDirectory(prefix='bron-native-tls-') as temporary:
        work = Path(temporary)
        def openssl(*arguments):
            subprocess.run([shutil.which('openssl'), *arguments], cwd=work, check=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
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
        fixture = native.Fixture(shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin'), temporary)
        try:
            fixture.create()
            fixture.sql('CREATE ROLE postgres LOGIN NOSUPERUSER')
            for source, destination in [('server.key', 'bron-native-tls.key'), ('server.crt', 'bron-native-tls.crt')]:
                fixture.execute(['sh', '-c', 'umask 077; cat > /var/lib/postgresql/data/' + destination
                    + '; chown postgres:postgres /var/lib/postgresql/data/' + destination
                    + '; chmod 600 /var/lib/postgresql/data/' + destination],
                    input=(work / source).read_text())
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
                raise RuntimeError('NATIVE_TLS_SERVER_NOT_READY')
            result = subprocess.run([shutil.which('node'), str(HERE / 'native-pg-tls.mjs'),
                fixture.container, temporary, fixture.docker], env=fixture.environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, timeout=45)
            if result.returncode:
                try:
                    child = json.loads(result.stderr.strip().splitlines()[-1])
                    print(json.dumps({'status': 'FAIL', 'phase': child.get('phase'), 'code': child.get('code')}))
                except Exception:
                    print(json.dumps({'status': 'FAIL', 'code': 'NATIVE_TLS_CHILD_FAILED'}))
                return 1
            summary = json.loads(result.stdout)
            assert summary['status'] == 'PASS'
        finally:
            fixture.cleanup()
        summary['ownedContainerRemoved'] = True
    assert not work.exists()
    summary['syntheticKeysRemoved'] = True
    print(json.dumps(summary, sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({'status': 'FAIL', 'code': 'NATIVE_TLS_FIXTURE_FAILED'}))
        sys.exit(1)
