BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5000';
SET LOCAL lock_timeout = '5000';
SET LOCAL timezone = 'UTC';
SET LOCAL search_path = pg_catalog;
SELECT jsonb_build_object(
  'format',1,
  'task','T57',
  'kind','AUTH_USERS_CATALOG_ONLY',
  'database',current_database(),
  'role',current_user,
  'session_role',session_user,
  'read_only',current_setting('transaction_read_only'),
  'isolation',current_setting('transaction_isolation'),
  'timezone',current_setting('TimeZone'),
  'date_style',current_setting('DateStyle'),
  'client_encoding',current_setting('client_encoding'),
  'server_version_num',current_setting('server_version_num'),
  'columns',(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',a.attname,
      'ordinal',a.attnum,
      'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,
      'identity',a.attidentity,
      'generated',a.attgenerated,
      'default_sha256',encode(sha256(convert_to(coalesce(pg_get_expr(d.adbin,d.adrelid),''),'UTF8')),'hex')
    ) ORDER BY a.attname),'[]'::jsonb)
    FROM pg_attribute a
    JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname='auth' AND c.relname='users'
      AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
  )
) AS auth_catalog;
ROLLBACK;
