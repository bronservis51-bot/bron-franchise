"""Cached native PG17 fixture; synthetic only, no source or VPS access."""
import importlib.util,json,pathlib,shutil,subprocess,sys,tempfile
sys.dont_write_bytecode=True
HERE=pathlib.Path(__file__).resolve().parent
if len(sys.argv)!=1: raise RuntimeError('NATIVE_T23_ACCEPTS_NO_ARGUMENTS')
spec=importlib.util.spec_from_file_location('native',str(HERE/'restore-native-pg17.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='t23-native-config-') as conf:
 f=m.Fixture(shutil.which('docker',path='/usr/local/bin:/usr/bin:/bin'),conf)
 try:
  f.create();f.sql("""CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE SCHEMA app_private;CREATE SCHEMA auth;CREATE SCHEMA storage;
CREATE TABLE auth.users(id int PRIMARY KEY);CREATE TABLE auth.identities(id int PRIMARY KEY);CREATE TABLE storage.buckets(id int PRIMARY KEY);CREATE TABLE storage.objects(id int PRIMARY KEY);
CREATE TABLE public.partner(id int PRIMARY KEY);CREATE TABLE public.location(id int PRIMARY KEY);CREATE TABLE public.role_assignment(id int PRIMARY KEY);CREATE TABLE public.franchise_lead(id int PRIMARY KEY);CREATE TABLE public.article_revision(id int PRIMARY KEY);
CREATE TABLE public.daily_revenue(id uuid NOT NULL,period int NOT NULL,huge bigint,amount numeric(30,20),observed_at timestamptz,memo text,PRIMARY KEY(id,period));
INSERT INTO public.daily_revenue SELECT '00000000-0000-4000-8000-000000000001'::uuid,generate_series(1,4),9007199254740993,1.00000000000000000001,'2026-11-13T12:00:00.000001Z','PRIVATE_FIXTURE_VALUE';
CREATE TABLE public.unkeyed(value text);INSERT INTO public.unkeyed VALUES('PRIVATE_FIXTURE_VALUE'),('PRIVATE_FIXTURE_VALUE');""")
  r=subprocess.run([shutil.which('node'),str(HERE/'delta-native-capture.mjs'),f.container,conf,f.docker],env=f.environment,text=True,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=35)
  if r.returncode:raise RuntimeError('NATIVE_T23_CHILD_FAILED')
  summary=json.loads(r.stdout);assert summary['status']=='PASS'
 finally:f.cleanup()
 summary['ownedContainerRemoved']=True
 print(json.dumps(summary,sort_keys=True))
