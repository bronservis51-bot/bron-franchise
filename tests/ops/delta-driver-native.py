#!/usr/bin/env python3
"""Real node-pg protocol preflight in cached PG17; synthetic, network none, no ports."""
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
        raise RuntimeError('NATIVE_DRIVER_ACCEPTS_NO_ARGUMENTS')
    node = shutil.which('node')
    docker = shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin')
    if node is None or docker is None:
        raise RuntimeError('NATIVE_DRIVER_TOOLS_REQUIRED')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('native_driver_fixture', HERE / 'restore-native-pg17.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    with tempfile.TemporaryDirectory(prefix='bron-delta-driver-config-') as configuration:
        fixture = native.Fixture(docker, configuration)
        try:
            fixture.create()
            fixture.sql("""CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN BYPASSRLS;
                CREATE ROLE authenticator LOGIN NOINHERIT;
                CREATE ROLE postgres LOGIN INHERIT CREATEDB CREATEROLE BYPASSRLS;
                GRANT pg_read_all_data TO postgres;
                CREATE SCHEMA app_private; CREATE SCHEMA auth; CREATE SCHEMA storage;
                CREATE TABLE auth.users(id int PRIMARY KEY);
                CREATE TABLE auth.identities(id int PRIMARY KEY);
                CREATE TABLE storage.buckets(id int PRIMARY KEY);
                CREATE TABLE storage.objects(id int PRIMARY KEY);
                CREATE TABLE public.partner(id int PRIMARY KEY);
                CREATE TABLE public.location(id int PRIMARY KEY);
                CREATE TABLE public.role_assignment(id int PRIMARY KEY);
                CREATE TABLE public.franchise_lead(id int PRIMARY KEY);
                CREATE TABLE public.article_revision(id int PRIMARY KEY);
                CREATE TABLE public.daily_revenue(id uuid NOT NULL,period int NOT NULL,huge bigint,
                    amount numeric(30,20),observed_at timestamptz,memo text,PRIMARY KEY(id,period));
                INSERT INTO public.daily_revenue SELECT '00000000-0000-4000-8000-000000000001'::uuid,
                    generate_series(1,4),9007199254740993,1.00000000000000000001,
                    '2026-11-13T12:00:00.000001Z','PRIVATE_FIXTURE_VALUE';
                CREATE TABLE public.unkeyed(value text);
                INSERT INTO public.unkeyed VALUES('PRIVATE_FIXTURE_VALUE'),('PRIVATE_FIXTURE_VALUE');""")
            result = subprocess.run([node, str(HERE / 'delta-driver-native.mjs'), fixture.container,
                configuration, docker], env=fixture.environment, text=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35)
            if result.returncode:
                raise RuntimeError('NATIVE_DRIVER_CHILD_FAILED')
            summary = json.loads(result.stdout)
            if summary.get('status') != 'PASS':
                raise RuntimeError('NATIVE_DRIVER_SUMMARY_INVALID')
        finally:
            fixture.cleanup()
        summary['ownedContainerRemoved'] = True
        print(json.dumps(summary, sort_keys=True))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'status': 'FAIL', 'code': 'NATIVE_DRIVER_PREFLIGHT_FAILED'}))
        sys.exit(1)
