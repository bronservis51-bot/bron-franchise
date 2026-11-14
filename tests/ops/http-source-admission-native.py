#!/usr/bin/env python3
"""Synthetic cached PostgreSQL17/real pg proof; no network, source or VPS."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent

def main():
    if len(sys.argv) != 1:
        raise RuntimeError('HTTP_NATIVE_NO_ARGUMENTS')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('fixture', HERE / 'restore-native-pg17.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    with tempfile.TemporaryDirectory(prefix='bron-http-admission-') as configuration:
        fixture = native.Fixture(shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin'), configuration)
        try:
            fixture.create()
            fixture.sql("""CREATE ROLE postgres LOGIN NOSUPERUSER;
              GRANT pg_monitor,pg_signal_backend TO postgres;
              CREATE ROLE pgbouncer LOGIN NOINHERIT; CREATE ROLE dashboard_user NOLOGIN;
              CREATE ROLE authenticator LOGIN NOINHERIT; CREATE ROLE anon NOLOGIN;
              CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
              GRANT service_role TO authenticator; ALTER DATABASE postgres OWNER TO postgres;
              GRANT CONNECT ON DATABASE postgres TO dashboard_user;
              CREATE SCHEMA app_private AUTHORIZATION postgres;
              CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA vault;
              CREATE SCHEMA net; CREATE TABLE net.http_request_queue(id int);
              CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text,username text,command text,active boolean);
              INSERT INTO cron.job VALUES('bron-jobs','postgres','select app_private.run_jobs(''cron'');',true);
              GRANT USAGE ON SCHEMA net,cron TO postgres;
              GRANT SELECT ON net.http_request_queue,cron.job TO postgres;
              CREATE TABLE app_private.admission_probe(memo text);
              GRANT USAGE ON SCHEMA app_private TO service_role;
              GRANT INSERT ON app_private.admission_probe TO service_role;
              CREATE SCHEMA pgbouncer;
              CREATE FUNCTION pgbouncer.get_auth(text) RETURNS TABLE(username text,password text)
                LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT $1,NULL::text';
              REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
              GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer;
              GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer;""")
            result = subprocess.run([shutil.which('node'),str(HERE / 'http-source-admission-native.mjs'),
                fixture.container,configuration,fixture.docker],env=fixture.environment,text=True,
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45)
            if result.returncode:
                raise RuntimeError('HTTP_NATIVE_CHILD_FAILED')
            summary = json.loads(result.stdout)
            assert summary['status'] == 'PASS'
        finally:
            fixture.cleanup()
        summary['ownedContainerRemoved'] = True
        print(json.dumps(summary,sort_keys=True))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status':'FAIL','code':'HTTP_ADMISSION_NATIVE_FAILED'}))
        sys.exit(1)
