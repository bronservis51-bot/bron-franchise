-- T63 added private helpers as the installation role, while CREATE OR REPLACE
-- retained the original application RPC owners. Restore only this trusted
-- definer-to-helper EXECUTE edge; no client or business-role grants change.
do $repair$
declare
  v_callers text[] := array[
    'public.staff_list(uuid,date)', 'public.staff_home(date)',
    'app_private.can_manage_user(uuid)', 'app_private.staff_pay_policy(uuid,date)',
    'public.motivation_get(uuid)'];
  v_helpers text[] := array[
    'app_private.staff_owner(uuid)', 'app_private.staff_location_scope(uuid)',
    'app_private.staff_member_scope(uuid)', 'app_private.motivation_default(text)'];
  v_signature text;
  v_fn record;
  v_before jsonb := '{}'::jsonb;
  v_client_acl jsonb;
  v_changed integer := 0;
  v_owner oid := to_regrole('postgres');
  v_postgres_caller boolean := false;
  v_edge record;
begin
  perform pg_advisory_xact_lock(hashtextextended('bron.morning.migrations',0));
  if v_owner is null then raise exception 'STAFF_HELPER_TRUSTED_OWNER_MISSING'; end if;

  -- Check every expected object before making the first ACL change. Fresh
  -- installations have postgres as both owners and require no repair.
  foreach v_signature in array v_callers loop
    select p.oid,p.proowner,p.prosecdef,p.prokind,pg_get_userbyid(p.proowner) as owner_name into v_fn
      from pg_proc p where p.oid=to_regprocedure(v_signature);
    if not found or v_fn.owner_name not in ('postgres','supabase_admin') or not v_fn.prosecdef or v_fn.prokind<>'f' then
      raise exception 'STAFF_HELPER_UNEXPECTED_CALLER';
    end if;
    v_postgres_caller:=v_postgres_caller or v_fn.proowner=v_owner;
  end loop;
  foreach v_signature in array v_helpers loop
    select p.oid,p.proowner,p.proacl,p.prokind,pg_get_userbyid(p.proowner) as owner_name into v_fn
      from pg_proc p where p.oid=to_regprocedure(v_signature);
    if not found or v_fn.owner_name not in ('postgres','supabase_admin') or v_fn.prokind<>'f' then
      raise exception 'STAFF_HELPER_UNEXPECTED_CALLEE';
    end if;
    v_client_acl:=jsonb_build_object(
      'anon',has_function_privilege('anon',v_fn.oid,'EXECUTE'),
      'authenticated',has_function_privilege('authenticated',v_fn.oid,'EXECUTE'),
      'public',exists(select 1 from aclexplode(coalesce(v_fn.proacl,acldefault('f',v_fn.proowner))) a
                      where a.grantee=0 and a.privilege_type='EXECUTE'));
    v_before:=v_before||jsonb_build_object(v_signature,v_client_acl);
  end loop;

  foreach v_signature in array v_helpers loop
    if v_postgres_caller and not has_function_privilege(v_owner,to_regprocedure(v_signature),'EXECUTE') then
      execute format('grant execute on function %s to postgres',to_regprocedure(v_signature));
      v_changed:=v_changed+1;
    end if;
    select p.oid,p.proowner,p.proacl into v_fn from pg_proc p where p.oid=to_regprocedure(v_signature);
    v_client_acl:=jsonb_build_object(
      'anon',has_function_privilege('anon',v_fn.oid,'EXECUTE'),
      'authenticated',has_function_privilege('authenticated',v_fn.oid,'EXECUTE'),
      'public',exists(select 1 from aclexplode(coalesce(v_fn.proacl,acldefault('f',v_fn.proowner))) a
                      where a.grantee=0 and a.privilege_type='EXECUTE'));
    if v_client_acl is distinct from v_before->v_signature
       or (v_postgres_caller and not has_function_privilege(v_owner,v_fn.oid,'EXECUTE')) then
      raise exception 'STAFF_HELPER_ACL_POSTCHECK';
    end if;
  end loop;
  -- Mixed trusted ownership is permitted only when every affected call edge is
  -- actually executable. An all-admin installation is a genuine NO_CHANGE;
  -- it does not receive an unnecessary postgres grant or claim the incident fixed.
  for v_edge in select c.proowner,h.oid from (values
    ('public.staff_list(uuid,date)','app_private.staff_member_scope(uuid)'),
    ('public.staff_list(uuid,date)','app_private.staff_location_scope(uuid)'),
    ('public.staff_list(uuid,date)','app_private.can_manage_user(uuid)'),
    ('public.staff_list(uuid,date)','app_private.staff_pay_policy(uuid,date)'),
    ('public.staff_home(date)','app_private.staff_pay_policy(uuid,date)'),
    ('app_private.staff_pay_policy(uuid,date)','app_private.motivation_default(text)'),
    ('public.motivation_get(uuid)','app_private.motivation_default(text)'),
    ('app_private.can_manage_user(uuid)','app_private.staff_owner(uuid)'),
    ('app_private.can_manage_user(uuid)','app_private.staff_location_scope(uuid)'),
    ('app_private.staff_location_scope(uuid)','app_private.staff_owner(uuid)'),
    ('app_private.staff_member_scope(uuid)','app_private.staff_location_scope(uuid)')
  ) e(caller,callee) join pg_proc c on c.oid=to_regprocedure(e.caller)
    join pg_proc h on h.oid=to_regprocedure(e.callee) loop
    if not has_function_privilege(v_edge.proowner,v_edge.oid,'EXECUTE') then
      raise exception 'STAFF_HELPER_UNREPAIRED_EXECUTE_EDGE';
    end if;
  end loop;
  -- This connection-local technical receipt survives separate psql statements;
  -- it is not Auth session data and disappears with the migration connection.
  perform set_config('bron.t64_helper_execute_changed',v_changed::text,false);
end
$repair$;

select jsonb_build_object(
  'kind','T64_STAFF_HELPER_EXECUTE',
  'status',case when current_setting('bron.t64_helper_execute_changed')::integer=0
                then 'NO_CHANGE' else 'KNOWN_EXECUTE_GAP_REPAIRED' end,
  'grantsApplied',current_setting('bron.t64_helper_execute_changed')::integer,
  'trustedApplicationOwner','postgres', 'businessRolesChanged',false,
  'clientPrivilegesChanged',false, 'passwordsReset',0);
