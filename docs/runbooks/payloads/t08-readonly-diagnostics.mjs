// Temporary read-only migration payload T08; run only from the pinned private VPS runtime.
import { execFileSync, spawnSync } from 'node:child_process';
import { databaseConfig } from '/opt/bron/audit-runtime-c128f9b/scripts/database-config.mjs';
import { sourceServiceConfig, assertMigrationTarget } from '/opt/bron/audit-runtime-c128f9b/scripts/migration-source.mjs';

let phase = 'source-config';
let target;
let inTransaction = false;
const fail = code => { throw Object.assign(new Error(code), { code }); };
try {
  sourceServiceConfig(); // Validates the VPS and canonical source TLS without connecting.
  phase = 'target-container-config';
  const records = JSON.parse(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', 'supabase-db'], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const container = records[0];
  if (records.length !== 1 || container?.Name !== '/supabase-db' || !container.State?.Running)
    fail('TARGET_CONTAINER_NOT_RUNNING');
  const wanted = ['POSTGRES_PASSWORD', 'PGPASSWORD', 'POSTGRES_USER', 'POSTGRES_DB'];
  const values = {};
  for (const entry of container.Config?.Env ?? []) {
    const split = entry.indexOf('=');
    const key = entry.slice(0, split);
    if (split < 1 || !wanted.includes(key)) continue;
    if (Object.hasOwn(values, key)) fail('TARGET_DUPLICATE_CONFIG');
    values[key] = entry.slice(split + 1);
  }
  if (!values.POSTGRES_PASSWORD) fail('TARGET_PASSWORD_CONFIG_MISSING');
  if (values.PGPASSWORD !== undefined && values.PGPASSWORD !== values.POSTGRES_PASSWORD)
    fail('TARGET_PASSWORD_CONFIG_CONFLICT');
  if (values.POSTGRES_USER !== 'supabase_admin') fail('TARGET_ADMIN_ROLE_UNEXPECTED');
  if (values.POSTGRES_DB !== 'postgres') fail('TARGET_DATABASE_UNEXPECTED');
  const addresses = Object.values(container.NetworkSettings?.Networks ?? {})
    .flatMap(network => [network.IPAddress, network.GlobalIPv6Address]).filter(Boolean);
  if (!addresses.length) fail('TARGET_CONTAINER_ADDRESS_MISSING');

  const url = new URL('postgresql://supabase_admin@127.0.0.1:15433/postgres?sslmode=disable');
  url.password = encodeURIComponent(values.POSTGRES_PASSWORD);
  assertMigrationTarget(url.href);
  const childEnv = { ...process.env, BRON_DB_ALLOW_LOCAL_PLAIN: '1', TARGET_DATABASE_URL: url.href };
  phase = 'target-readonly-probe';
  const { default: pg } = await import('pg');
  target = new pg.Client({ ...databaseConfig(url.href, childEnv), query_timeout: 30000 });
  await target.connect();
  await target.query('BEGIN READ ONLY');
  inTransaction = true;
  const row = (await target.query(`SELECT current_database() AS db, current_user AS role,
    host(inet_server_addr()) AS server_addr, inet_server_port() AS server_port,
    current_setting('transaction_read_only') AS read_only,
    current_setting('cron.launch_active_jobs') AS cron_launch,
    current_setting('pg_net.batch_size') AS net_batch`)).rows[0];
  if (row?.db !== 'postgres' || row.role !== 'supabase_admin' ||
      !addresses.includes(row.server_addr) || row.read_only !== 'on')
    fail('TARGET_IDENTITY_OR_READONLY_MISMATCH');
  if (row.cron_launch !== 'off' || row.net_batch !== '0') fail('TARGET_ISOLATION_SETTINGS_MISMATCH');
  await target.query('ROLLBACK');
  inTransaction = false;
  await target.end();
  target = undefined;
  console.log('TARGET_PROBE_OK', JSON.stringify(row));

  phase = 'extended-readonly-diagnostics';
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
      .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  function counts(left, right, key = 'id') {
    const a = new Map(left.map(row => [row[key], row]));
    const b = new Map(right.map(row => [row[key], row]));
    if (a.size !== left.length || b.size !== right.length) fail('DUPLICATE_DIAGNOSTIC_KEYS');
    let changedMatchedRows = 0;
    const columns = new Map();
    for (const [id, row] of a) {
      if (!b.has(id)) continue;
      const other = b.get(id);
      const fields = [...new Set([...Object.keys(row), ...Object.keys(other)])]
        .filter(name => stable(row[name]) !== stable(other[name]));
      if (fields.length) changedMatchedRows++;
      for (const field of fields) columns.set(field, (columns.get(field) ?? 0) + 1);
    }
    return { sourceRows: a.size, targetRows: b.size,
      sourceOnlyRows: [...a.keys()].filter(id => !b.has(id)).length,
      targetOnlyRows: [...b.keys()].filter(id => !a.has(id)).length,
      changedMatchedRows, columns: [...columns].sort(([a],[b]) => a.localeCompare(b))
        .map(([name,rows]) => ({ name, rows })) };
  }
  async function capture(config) {
    const db = new pg.Client({ ...config, query_timeout: 60000 });
    async function optional(sql) {
      await db.query('SAVEPOINT diagnostic_optional');
      try {
        const rows = (await db.query(sql)).rows;
        await db.query('RELEASE SAVEPOINT diagnostic_optional');
        return { ok: true, rows };
      } catch (error) {
        await db.query('ROLLBACK TO SAVEPOINT diagnostic_optional');
        await db.query('RELEASE SAVEPOINT diagnostic_optional');
        return { ok: false, code: /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : 'QUERY_FAILED' };
      }
    }
    try {
      await db.connect();
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query("SET LOCAL timezone='UTC'");
      await db.query('SET LOCAL search_path=pg_catalog');
      const meta = (await db.query(`SELECT current_database() AS db,current_user AS role,
        current_setting('transaction_read_only') AS read_only`)).rows[0];
      if (meta.read_only !== 'on') fail('DIAGNOSTICS_NOT_READ_ONLY');
      const users = (await db.query(`SELECT to_jsonb(u) AS record,
        (extract(epoch FROM u.updated_at)*1000000)::bigint::text AS micros
        FROM auth.users u`)).rows;
      const triggers = (await db.query(`SELECT n.nspname||'.'||c.relname||'.'||t.tgname AS id,
        t.tgenabled,t.tgtype,pg_get_triggerdef(t.oid,true) AS definition,
        pn.nspname AS function_schema,p.proname AS function_name,p.prosecdef,p.proconfig,
        pg_get_functiondef(p.oid) AS function_definition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
        JOIN pg_namespace pn ON pn.oid=p.pronamespace
        WHERE n.nspname='auth' AND c.relname='users' AND NOT t.tgisinternal`)).rows;
      const vault = await optional(`SELECT to_jsonb(v) AS record FROM
        (SELECT id,name,description,decrypted_secret,created_at,updated_at
         FROM vault.decrypted_secrets) v`);
      const cron = await optional(`SELECT jobname AS id,schedule,command,database,username,active
        FROM cron.job`);
      const storage = (await db.query(`SELECT (SELECT count(*)::int FROM storage.buckets) AS buckets,
        (SELECT count(*)::int FROM storage.objects) AS objects`)).rows[0];
      await db.query('ROLLBACK');
      return { meta,users,triggers,vault,cron,storage };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { await db.end().catch(() => {}); }
  }
  const source = await capture(sourceServiceConfig());
  const destination = await capture(databaseConfig(url.href, childEnv));
  console.log('T08_READ_ONLY', JSON.stringify({ source: source.meta,target: destination.meta }));
  console.log('AUTH_USERS_DIFF_COUNTS', JSON.stringify(counts(source.users.map(x=>x.record),
    destination.users.map(x=>x.record))));
  const byId = new Map(destination.users.map(x=>[x.record.id,x]));
  const direction = { sourceNewerRows:0,targetNewerRows:0,nullMismatchRows:0 };
  for (const a of source.users) {
    const b = byId.get(a.record.id);
    if (!b || a.micros === b.micros) continue;
    if (a.micros === null || b.micros === null) direction.nullMismatchRows++;
    else if (BigInt(a.micros) > BigInt(b.micros)) direction.sourceNewerRows++;
    else direction.targetNewerRows++;
  }
  console.log('AUTH_UPDATED_AT_DIRECTION', JSON.stringify(direction));
  console.log('AUTH_USER_TRIGGERS_DIFF', JSON.stringify(counts(source.triggers,destination.triggers)));
  console.log('AUTH_TARGET_TRIGGER_METADATA', JSON.stringify(destination.triggers.map(t=>({
    object:t.id,enabled:t.tgenabled,type:t.tgtype,function_schema:t.function_schema,
    function_name:t.function_name,security_definer:t.prosecdef }))));
  for (const kind of ['vault','cron']) {
    const a = source[kind], b = destination[kind];
    console.log(kind.toUpperCase()+'_DIFF', JSON.stringify(a.ok && b.ok
      ? { available:true,...counts(a.rows.map(x=>x.record ?? x),b.rows.map(x=>x.record ?? x)) }
      : { available:false,sourceCode:a.ok?'OK':a.code,targetCode:b.ok?'OK':b.code }));
  }
  console.log('STORAGE_COUNTS', JSON.stringify({ source:source.storage,target:destination.storage }));
  phase = 'migration-audit';
  const audit = spawnSync(process.execPath, ['scripts/migration-check.mjs','--source-service'], {
    cwd:'/opt/bron/audit-runtime-c128f9b',env:childEnv,stdio:['ignore','inherit','inherit'],
  });
  if (audit.error || audit.signal || audit.status === null) fail('AUDIT_EXIT_STATUS_UNAVAILABLE');
  console.log('AUDIT_EXIT_STATUS', audit.status);
  process.exitCode = audit.status;
} catch (error) {
  const code = /^[A-Z0-9_]{3,60}$/.test(error.code ?? '') ? error.code : 'TARGET_BOOTSTRAP_FAILED';
  console.error('T08_BLOCKED', phase, code);
  process.exitCode = 2;
} finally {
  if (target) {
    if (inTransaction) await target.query('ROLLBACK').catch(() => {});
    await target.end().catch(() => {});
  }
}
