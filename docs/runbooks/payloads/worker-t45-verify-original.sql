DO $bron_http_admission$
DECLARE s jsonb; b record;
BEGIN
IF NOT (current_database()='postgres' AND current_user='postgres' AND session_user='postgres'
 AND (SELECT pg_get_userbyid(datdba)='postgres' FROM pg_database WHERE datname=current_database())
 AND pg_has_role(current_user,'pg_signal_backend','USAGE')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='HTTP_ADMISSION_IDENTITY'; END IF;
 IF NOT (current_setting('transaction_isolation')='read committed') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='HTTP_ADMISSION_ISOLATION'; END IF;
 IF NOT (pg_try_advisory_xact_lock(1268926533178359066::bigint)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='HTTP_ADMISSION_OPERATION_IN_FLIGHT'; END IF;
PERFORM pg_stat_clear_snapshot(); SELECT state INTO s FROM (SELECT jsonb_build_object(
 'db',current_database(),'actor',current_user,'session',session_user,'pid',pg_backend_pid(),
 'readOnly',current_setting('transaction_read_only'),'owner',pg_get_userbyid(d.datdba),
 'signal',pg_has_role(current_user,'pg_signal_backend','USAGE'),
 'prepared',(SELECT count(*) FROM pg_prepared_xacts),
 'netQueued',(SELECT count(*) FROM net.http_request_queue),
 'runJobsExists',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='run_jobs'),
 'unexpectedActiveCron',(SELECT count(*) FROM cron.job WHERE active AND (jobname<>'bron-jobs'
   OR username<>'postgres' OR command !~* '^[[:space:]]*select[[:space:]]+app_private\.run_jobs\([[:space:]]*(''cron''[[:space:]]*)?\)[[:space:]]*;?[[:space:]]*$'
   OR (command ~ '''' AND command !~ '''cron'''))),
 'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
   'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable)
   ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable)
   FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) x),
 'roles',(SELECT jsonb_agg(jsonb_build_object('name',r.rolname,'super',r.rolsuper,'login',r.rolcanlogin,
   'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'replication',r.rolreplication,'bypass',r.rolbypassrls,
   'connect',has_database_privilege(r.oid,d.oid,'CONNECT'),
   'ownerPath',pg_has_role(r.oid,'postgres','MEMBER') OR pg_has_role(r.oid,'dashboard_user','MEMBER')
      OR pg_has_role(r.oid,'supabase_admin','MEMBER')) ORDER BY r.rolname) FROM pg_roles r),
 'lookupOtherSetRoles',(SELECT count(*) FROM pg_roles r
   WHERE r.rolname<>'pgbouncer' AND pg_has_role('pgbouncer',r.oid,'SET')),
 'lookupCriticalWrites',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','app_private','auth','storage','vault') AND c.relkind IN('r','p')
   AND CASE WHEN c.relkind IN('r','p') THEN has_table_privilege('pgbouncer',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') ELSE false END),
 'lookupSequenceWrites',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','app_private') AND c.relkind='S'
   AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('pgbouncer',c.oid,'USAGE,UPDATE') ELSE false END),
 'lookupCriticalDefiners',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN('public','app_private','auth','storage','vault') AND p.prosecdef
   AND has_function_privilege('pgbouncer',p.oid,'EXECUTE')),
 'backends',(SELECT coalesce(jsonb_agg(jsonb_build_object('pid',a.pid,'role',a.usename,
   'type',a.backend_type,'state',a.state,'openTransaction',a.xact_start IS NOT NULL,
   'super',coalesce(r.rolsuper,false),'providerAppKnown',a.application_name IN('postgres_exporter',''))
   ORDER BY a.pid),'[]'::jsonb) FROM pg_stat_activity a LEFT JOIN pg_roles r ON r.rolname=a.usename
   WHERE a.datname=current_database())
) AS state FROM pg_database d WHERE d.datname=current_database()) AS metadata; IF NOT ((SELECT coalesce(jsonb_agg(value ORDER BY value::text COLLATE "C"),'[]'::jsonb) FROM jsonb_array_elements(s->'acl') AS e(value)) = (SELECT coalesce(jsonb_agg(value ORDER BY value::text COLLATE "C"),'[]'::jsonb) FROM jsonb_array_elements(E'[{"grantable":false,"grantee":"PUBLIC","grantor":"postgres","privilege":"CONNECT"},{"grantable":false,"grantee":"PUBLIC","grantor":"postgres","privilege":"TEMPORARY"},{"grantable":false,"grantee":"postgres","grantor":"postgres","privilege":"CONNECT"},{"grantable":false,"grantee":"postgres","grantor":"postgres","privilege":"CREATE"},{"grantable":false,"grantee":"postgres","grantor":"postgres","privilege":"TEMPORARY"},{"grantable":false,"grantee":"supabase_etl_admin","grantor":"postgres","privilege":"CREATE"},{"grantable":false,"grantee":"supabase_storage_admin","grantor":"postgres","privilege":"CREATE"},{"grantable":false,"grantee":"dashboard_user","grantor":"postgres","privilege":"CONNECT"},{"grantable":false,"grantee":"dashboard_user","grantor":"postgres","privilege":"CREATE"},{"grantable":false,"grantee":"dashboard_user","grantor":"postgres","privilege":"TEMPORARY"}]'::jsonb) AS e(value))) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='HTTP_ADMISSION_ORIGINAL_ACL_MISMATCH'; END IF;
END
$bron_http_admission$;