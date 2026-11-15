BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='5s';
WITH edges(caller,callee) AS (VALUES
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
), names(fn) AS (SELECT caller FROM edges UNION SELECT callee FROM edges), funcs AS (
 SELECT n.fn,p.oid,p.proowner,p.prosecdef,pg_get_userbyid(p.proowner) AS owner,
        r.rolsuper AS native_superuser
 FROM names n LEFT JOIN pg_proc p ON p.oid=to_regprocedure(n.fn)
 LEFT JOIN pg_roles r ON r.oid=p.proowner
)
SELECT jsonb_build_object('kind','T63_STAFF_CATALOG_ONLY',
 'functions',(SELECT jsonb_agg(jsonb_build_object('signature',fn,'exists',oid IS NOT NULL,
   'owner',owner,'securityDefiner',prosecdef,'ownerNativeSuperuser',native_superuser,
   'authenticatedExecute',CASE WHEN oid IS NOT NULL THEN has_function_privilege('authenticated',oid,'EXECUTE') END)
   ORDER BY fn) FROM funcs),
 'edges',(SELECT jsonb_agg(jsonb_build_object('caller',e.caller,'callee',e.callee,
   'callerOwnerCanExecute',CASE WHEN c.oid IS NOT NULL AND h.oid IS NOT NULL
     THEN has_function_privilege(c.proowner,h.oid,'EXECUTE') END) ORDER BY e.caller,e.callee)
   FROM edges e JOIN funcs c ON c.fn=e.caller JOIN funcs h ON h.fn=e.callee));
ROLLBACK;
