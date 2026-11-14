"""Final timestamp window: synthetic cached PG17 only, no ports/host data."""
import importlib.util,json,shutil,subprocess,sys,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
if len(sys.argv)!=1:raise RuntimeError('FINAL_WINDOW_NATIVE_NO_ARGUMENTS')
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('native',str(HERE/'restore-native-pg17.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='bron-final-auth-window-') as conf:
 f=m.Fixture(shutil.which('docker',path='/usr/local/bin:/usr/bin:/bin'),conf)
 try:
  f.create();f.sql("""CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS;
CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE SCHEMA app_private;
CREATE TABLE auth.users(id uuid PRIMARY KEY,updated_at timestamptz,encrypted_password text,private_data jsonb);
CREATE TABLE auth.identities(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users);
CREATE TABLE storage.buckets(id text PRIMARY KEY);CREATE TABLE storage.objects(id uuid PRIMARY KEY);
CREATE TABLE public.partner(id integer PRIMARY KEY);CREATE TABLE public.location(id integer PRIMARY KEY);
CREATE TABLE public.role_assignment(id integer PRIMARY KEY);CREATE TABLE public.daily_revenue(id integer PRIMARY KEY,amount numeric(30,20));
CREATE TABLE public.franchise_lead(id integer PRIMARY KEY);CREATE TABLE public.article_revision(id integer PRIMARY KEY);
CREATE TABLE app_private.marker(id integer PRIMARY KEY,value text);INSERT INTO app_private.marker VALUES(1,'SYNTHETIC_MARKER');
CREATE SEQUENCE app_private.procurement_event_id_seq;CREATE SEQUENCE app_private.procurement_request_number_seq;
INSERT INTO auth.users SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
'2026-11-13T12:00:00.000001Z','SYNTHETIC_PRIVATE_PASSWORD',jsonb_build_object('large',9007199254740993,'unicode','Ёлка 🔒') FROM generate_series(1,16) i;
INSERT INTO public.daily_revenue VALUES(1,1.00000000000000000001);
GRANT USAGE ON SCHEMA public,app_private,auth,storage TO postgres;
GRANT SELECT ON ALL TABLES IN SCHEMA public,app_private,auth,storage TO postgres;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public,app_private TO postgres;""")
  f.sql('CREATE DATABASE source_window TEMPLATE postgres');f.sql('CREATE DATABASE target_window TEMPLATE postgres')
  result=subprocess.run([shutil.which('node'),str(HERE/'final-auth-window-native.mjs'),f.container,conf,f.docker],
   env=f.environment,text=True,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
  if result.returncode:
   try:print(json.dumps(json.loads(result.stderr)))
   except:print(json.dumps({'status':'FAIL','code':'FINAL_WINDOW_NATIVE_CHILD_FAILED'}))
   sys.exit(1)
  summary=json.loads(result.stdout);assert summary['status']=='PASS'
 finally:f.cleanup()
 summary['ownedContainerRemoved']=True;print(json.dumps(summary,sort_keys=True))
