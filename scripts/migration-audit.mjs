// No row values, credentials or password fingerprints are printed by the CLI.
import { createHash } from 'node:crypto';

const quote = name => `"${name.replaceAll('"', '""')}"`;
const canonicalAcl = (acl, owner, kindExpression) => `coalesce((
  select jsonb_agg(jsonb_build_object(
    'grantee', coalesce(pg_get_userbyid(x.grantee), 'PUBLIC'),
    'grantor', pg_get_userbyid(x.grantor),
    'privilege', x.privilege_type,
    'grantable', x.is_grantable or x.grantee = ${owner}
  ) order by coalesce(pg_get_userbyid(x.grantee), 'PUBLIC'),
    pg_get_userbyid(x.grantor), x.privilege_type, x.is_grantable)
  from pg_catalog.aclexplode(case
    when ${acl} is null
      then pg_catalog.acldefault(${kindExpression}, ${owner})
    else ${acl}
  end) x
), '[]'::jsonb)`;
const canonicalColumnAcl = (acl, owner) => `coalesce((
  select jsonb_agg(jsonb_build_object(
    'grantee', coalesce(pg_get_userbyid(x.grantee), 'PUBLIC'),
    'grantor', pg_get_userbyid(x.grantor),
    'privilege', x.privilege_type,
    'grantable', x.is_grantable or x.grantee = ${owner}
  ) order by coalesce(pg_get_userbyid(x.grantee), 'PUBLIC'),
    pg_get_userbyid(x.grantor), x.privilege_type, x.is_grantable)
  from pg_catalog.aclexplode(case
    when ${acl} is null or cardinality(${acl}) = 0 then null::aclitem[]
    else ${acl}
  end) x
), '[]'::jsonb)`;
export function fingerprintRows(rows) {
  const hash = createHash('sha256');
  for (const row of rows) {
    const bytes = Buffer.from(row, 'utf8');
    hash.update(`${bytes.length}:`).update(bytes).update('\n');
  }
  return hash.digest('hex');
}

// One consistent, read-only snapshot per server. Run during the final write freeze.
export async function snapshotDatabase(db) {
  await db.query('begin isolation level repeatable read read only');
  try {
    const mode = (await db.query("select current_setting('transaction_read_only') as mode")).rows[0]?.mode;
    if (mode !== 'on') throw Object.assign(new Error('Migration audit requires an actual read-only transaction.'),
      { code: 'MIGRATION_TRANSACTION_NOT_READ_ONLY' });
    await db.query("set local timezone = 'UTC'");
    await db.query('set local search_path = pg_catalog');
    const tables = (await db.query(`select n.nspname as schema, c.relname as name
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p') and (
        n.nspname in ('public','app_private') or
        (n.nspname='auth' and c.relname in ('users','identities')) or
        (n.nspname='storage' and c.relname in ('buckets','objects')))
      and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
      order by n.nspname, c.relname`)).rows;
    for (const required of ['auth.users','auth.identities','public.partner','public.location',
      'public.role_assignment','public.daily_revenue','public.franchise_lead','public.article_revision',
      'storage.buckets','storage.objects']) {
      if (!tables.some(t => `${t.schema}.${t.name}` === required)) throw new Error(`Missing required table: ${required}`);
    }
    const result = {};
    for (const t of tables) {
      const qualified = `${quote(t.schema)}.${quote(t.name)}`;
      const rows = (await db.query(`select to_jsonb(t)::text as value from ${qualified} t order by to_jsonb(t)::text collate "C"`)).rows;
      result[`data:${t.schema}.${t.name}`] = { count: rows.length, hash: fingerprintRows(rows.map(r => r.value)) };
    }
    const catalogs = {
      columns: `select n.nspname,c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) as type,
        a.attnotnull,a.attidentity,a.attgenerated,${canonicalColumnAcl('a.attacl', 'c.relowner')} as attacl,
        pg_get_expr(d.adbin,d.adrelid) as default_value
        from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
        left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
        where n.nspname in ('public','app_private') and c.relkind in ('r','p','v') and a.attnum>0 and not a.attisdropped`,
      relations: `select n.nspname,c.relname,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) as owner,c.relrowsecurity,c.relforcerowsecurity,
        ${canonicalAcl('c.relacl', 'c.relowner', "case when c.relkind='S' then 's'::\"char\" else 'r'::\"char\" end")} as relacl,
        case when c.relkind='v' then pg_get_viewdef(c.oid,true) end as view_definition
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','app_private') and c.relkind in ('r','p','v','S')`,
      policies: `select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
        from pg_policies where schemaname in ('public','app_private')`,
      storage_policies: `select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
        from pg_policies where schemaname='storage'`,
      storage_grants: `select n.nspname,c.relname,pg_get_userbyid(c.relowner) as owner,c.relrowsecurity,c.relforcerowsecurity,
        ${canonicalAcl('c.relacl', 'c.relowner', "'r'::\"char\"")} as relacl,
        a.attname,${canonicalColumnAcl('a.attacl', 'c.relowner')} as attacl
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        where n.nspname='storage' and c.relname in ('buckets','objects')`,
      triggers: `select n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) as definition
        from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','app_private') and not t.tgisinternal`,
      extensions: `select e.extname,e.extversion,n.nspname as schema from pg_extension e
        join pg_namespace n on n.oid=e.extnamespace`,
      constraints: `select n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid,true) as definition
        from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname in ('public','app_private')`,
      indexes: `select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in ('public','app_private')`,
      routines: `select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as args,
        pg_get_functiondef(p.oid) as definition,pg_get_userbyid(p.proowner) as owner,
        ${canonicalAcl('p.proacl', 'p.proowner', "'f'::\"char\"")} as proacl,p.prosecdef,p.proconfig
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','app_private') and p.prokind in ('f','p')
        and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`,
      enums: `select n.nspname,t.typname,e.enumsortorder,e.enumlabel from pg_enum e
        join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
        where n.nspname in ('public','app_private')`,
      schemas: `select nspname,pg_get_userbyid(nspowner) as owner,nspacl from pg_namespace where nspname in ('public','app_private','storage')`,
      default_grants: `select pg_get_userbyid(d.defaclrole) as owner,n.nspname,d.defaclobjtype,
        ${canonicalColumnAcl('d.defaclacl', 'd.defaclrole')} as defaclacl
        from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
        where n.nspname in ('public','app_private') or d.defaclnamespace=0`,
      client_roles: `select rolname,rolsuper,rolinherit,rolbypassrls,rolcanlogin from pg_roles
        where rolname in ('anon','authenticated','service_role','authenticator')`,
      role_memberships: `select pg_get_userbyid(roleid) as role,pg_get_userbyid(member) as member,admin_option,inherit_option,set_option
        from pg_auth_members where pg_get_userbyid(member) in ('anon','authenticated','service_role','authenticator')`,
    };
    for (const [name, sql] of Object.entries(catalogs)) {
      const rows = (await db.query(`select to_jsonb(x)::text as value from (${sql}) x order by to_jsonb(x)::text collate "C"`)).rows;
      result[`schema:${name}`] = { count: rows.length, hash: fingerprintRows(rows.map(r => r.value)) };
    }
    const sequences = (await db.query("select schemaname,sequencename from pg_sequences where schemaname in ('public','app_private') order by schemaname,sequencename")).rows;
    for (const s of sequences) {
      result[`sequence:${s.schemaname}.${s.sequencename}`] = (await db.query(`select last_value::text,is_called from ${quote(s.schemaname)}.${quote(s.sequencename)}`)).rows[0];
    }
    await db.query('commit');
    return result;
  } catch (error) { await db.query('rollback'); throw error; }
}

export function compareSnapshots(source, target) {
  return [...new Set([...Object.keys(source), ...Object.keys(target)])].sort()
    .filter(key => JSON.stringify(source[key]) !== JSON.stringify(target[key]));
}
