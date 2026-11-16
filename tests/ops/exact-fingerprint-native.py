"""Exact audit parity; only synthetic cached PG17, owned tmpfs, no host ports."""
import importlib.util,json,shutil,subprocess,sys,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
if len(sys.argv)!=1:raise RuntimeError('EXACT_NATIVE_NO_ARGUMENTS')
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('native',str(HERE/'restore-native-pg17.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory(prefix='bron-exact-fingerprint-') as conf:
 f=m.Fixture(shutil.which('docker',path='/usr/local/bin:/usr/bin:/bin'),conf)
 try:
  f.create();f.sql("""CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS;
CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;GRANT authenticated TO authenticator;
CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE SCHEMA app_private;
CREATE TABLE auth.users(id uuid PRIMARY KEY,updated_at timestamptz,private_data jsonb);
CREATE TABLE auth.identities(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users);
CREATE TABLE storage.buckets(id text PRIMARY KEY);
CREATE TABLE storage.objects(id uuid PRIMARY KEY,bucket_id text REFERENCES storage.buckets);
CREATE TABLE public.partner(id int PRIMARY KEY,name text);
CREATE TABLE public.location(id int PRIMARY KEY,partner_id int REFERENCES public.partner);
CREATE TABLE public.role_assignment(id int PRIMARY KEY);
CREATE TABLE public.daily_revenue(id int PRIMARY KEY,amount bigint,currency text);
CREATE TABLE public.franchise_lead(id int PRIMARY KEY,memo text);
CREATE TABLE public.article_revision(id int PRIMARY KEY,body text);
CREATE TYPE app_private.state AS ENUM ('draft','accepted');
CREATE TABLE app_private.marker(id int PRIMARY KEY,state app_private.state);
CREATE SEQUENCE app_private.procurement_event_id_seq;
CREATE SEQUENCE app_private.procurement_request_number_seq START 7;
GRANT SELECT,USAGE ON SEQUENCE app_private.procurement_event_id_seq TO anon;
GRANT SELECT,UPDATE ON SEQUENCE app_private.procurement_request_number_seq TO authenticated;
GRANT SELECT(name) ON public.partner TO anon;
GRANT SELECT ON storage.buckets TO anon;
ALTER TABLE public.partner ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner FORCE ROW LEVEL SECURITY;
CREATE POLICY read_own ON public.partner TO authenticated USING (id>0);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_storage ON storage.objects TO authenticated USING (true);
CREATE VIEW public.partner_names WITH (security_invoker=true) AS SELECT id,name FROM public.partner;
CREATE FUNCTION app_private.touch_partner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS
$$BEGIN RETURN NEW; END$$;
CREATE TRIGGER touch_partner BEFORE UPDATE ON public.partner FOR EACH ROW EXECUTE FUNCTION app_private.touch_partner();
CREATE FUNCTION public.add_one(v integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT v+1';
REVOKE ALL ON FUNCTION public.add_one(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_one(integer) TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO authenticated;
CREATE TABLE public.partitioned(id integer,memo text) PARTITION BY RANGE(id);
CREATE TABLE public.partitioned_one PARTITION OF public.partitioned FOR VALUES FROM (0) TO (10);
INSERT INTO public.partitioned VALUES(1,'partition row');
CREATE TABLE public.hash_empty(id uuid,huge bigint,amount numeric(30,20),observed_at timestamptz,memo text,optional text,payload jsonb);
CREATE TABLE public.hash_fixture(LIKE public.hash_empty INCLUDING ALL);
INSERT INTO public.hash_fixture SELECT ('00000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,
9007199254740993+(i%2),1.00000000000000000001+(i%2)*0.00000000000000000001,
'2026-11-13T12:00:00.000001Z'::timestamptz+(i%3)*interval '0.000001 second',
CASE WHEN i%3=0 THEN NULL ELSE 'Unicode Ёлка 🔒 café café 東京' || chr(10) || 'line2' || chr(13) || chr(9) || 'quote"slash' || chr(92) || repeat('x',400) END,
NULL,jsonb_build_object('n',9007199254740993,'unicode','Й 東京','list',jsonb_build_array(1,null,'quote"'))
FROM generate_series(1,3000) AS i;
INSERT INTO public.hash_fixture SELECT * FROM public.hash_fixture WHERE id='00000000-0000-4000-8000-000000000001';
INSERT INTO public.hash_fixture SELECT * FROM public.hash_fixture WHERE id='00000000-0000-4000-8000-000000000001' LIMIT 1;
INSERT INTO auth.users VALUES('00000000-0000-4000-8000-000000000001','2026-11-13T12:00:00.000001Z','{"private":"SYNTHETIC_ONLY"}');
INSERT INTO public.partner VALUES(1,'Ёлка');
INSERT INTO public.daily_revenue VALUES(1,9007199254740993,'RUB');
GRANT USAGE ON SCHEMA public,app_private,auth,storage TO postgres;
GRANT SELECT ON ALL TABLES IN SCHEMA public,app_private,auth,storage TO postgres;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public,app_private TO postgres;""")
  r=subprocess.run([shutil.which('node'),str(HERE/'exact-fingerprint-native.mjs'),f.container,conf,f.docker],
    env=f.environment,text=True,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
  if r.returncode:
   try:print(json.dumps(json.loads(r.stderr)))
   except:print(json.dumps({'status':'FAIL','code':'EXACT_NATIVE_CHILD_FAILED'}))
   sys.exit(1)
  summary=json.loads(r.stdout);assert summary['status']=='PASS'
 finally:f.cleanup()
 summary['ownedContainerRemoved']=True;print(json.dumps(summary,sort_keys=True))
