#!/usr/bin/env python3
"""Native auditor capture preflight; cached local image, synthetic data, no VPS."""
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
        raise RuntimeError('NATIVE_CAPTURE_ACCEPTS_NO_ARGUMENTS')
    node = shutil.which('node')
    docker = shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin')
    if node is None or docker is None:
        raise RuntimeError('NATIVE_CAPTURE_LOCAL_TOOLS_REQUIRED')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('native_pg17_fixture', HERE / 'restore-native-pg17.py')
    native = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(native)
    with tempfile.TemporaryDirectory(prefix='bron-native-capture-config-') as configuration:
        fixture = native.Fixture(docker, configuration)
        try:
            fixture.create()
            fixture.sql("""CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN BYPASSRLS;
                CREATE ROLE authenticator LOGIN NOINHERIT;
                CREATE SCHEMA app_private; CREATE SCHEMA auth; CREATE SCHEMA storage;
                CREATE TABLE auth.users(id int PRIMARY KEY);
                CREATE TABLE auth.identities(id int PRIMARY KEY);
                CREATE TABLE storage.buckets(id int PRIMARY KEY);
                CREATE TABLE storage.objects(id int PRIMARY KEY);
                CREATE TABLE public.partner(id int PRIMARY KEY);
                CREATE TABLE public.location(id int PRIMARY KEY);
                CREATE TABLE public.role_assignment(id int PRIMARY KEY);
                CREATE TABLE public.daily_revenue(id int PRIMARY KEY);
                CREATE TABLE public.franchise_lead(id int PRIMARY KEY);
                CREATE TABLE public.article_revision(id int PRIMARY KEY);
                CREATE VIEW public.capture_view AS
                    SELECT id,'fixture-secret-before'::text AS memo FROM public.partner;""")
            result = subprocess.run([
                node, str(HERE / 'restore-native-capture.mjs'), fixture.container, configuration, docker,
            ], env=fixture.environment, text=True, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35)
            if result.returncode:
                raise RuntimeError('NATIVE_CAPTURE_CHILD_FAILED')
            summary = json.loads(result.stdout)
            if summary.get('status') != 'PASS':
                raise RuntimeError('NATIVE_CAPTURE_SUMMARY_INVALID')
        finally:
            fixture.cleanup()
        summary['ownedContainerRemoved'] = True
        print(json.dumps(summary, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never forward stderr, SQL, parsed rows or exception bodies.
        print(json.dumps({'status': 'FAIL', 'code': 'NATIVE_CAPTURE_PREFLIGHT_FAILED'}))
        sys.exit(1)
