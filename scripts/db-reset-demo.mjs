// Пересоздание ДЕМО-базы с нуля: удаляет все таблицы и функции приложения (схемы public и app_private)
// и демо-пользователей, которых нет в supabase/seed/demo-users.json. Схему public и служебные объекты Supabase не трогает.
//   npm run db:reset-demo -- --confirm-wipe
// Затем: npm run db:apply -- --seed → npm run seed:users → npm run db:apply -- --after-users
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { demoUsers } from './db-lib.mjs';
import { loadEnv, need } from './env.mjs';

loadEnv();
if (!process.argv.includes('--confirm-wipe')) {
  console.error('Все данные демо-базы будут удалены. Запустите с --confirm-wipe, если это действительно демо-проект.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: need('DATABASE_URL'), ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const real = (await client.query(`select count(*)::int n from public.app_user where not is_demo`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  if (real > 0) throw new Error(`В базе есть ${real} не-демо пользователей — это не демо-стенд, сброс отменён.`);
  await client.query('begin');
  await client.query('drop schema if exists app_private cascade');
  const objs = await client.query(`
    select 'drop view if exists public.' || quote_ident(viewname) || ' cascade' as sql from pg_views where schemaname = 'public'
    union all select 'drop table if exists public.' || quote_ident(tablename) || ' cascade' from pg_tables where schemaname = 'public'
    union all select 'drop function if exists ' || p.oid::regprocedure || ' cascade' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`);
  for (const r of objs.rows) await client.query(r.sql);
  await client.query(`delete from storage.objects where bucket_id = 'private-files'`).catch(() => undefined);
  await client.query(`delete from storage.buckets where id = 'private-files'`).catch(() => undefined);
  await client.query('commit');
  console.log(`Удалено объектов: ${objs.rows.length} (+ схема app_private).`);
} catch (e) {
  await client.query('rollback').catch(() => undefined);
  throw e;
} finally {
  await client.end();
}

// Демо-пользователи прежней версии, которых больше нет в demo-users.json
const admin = createClient(need('VITE_SUPABASE_URL'), need('SUPABASE_SECRET_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const keep = new Set(demoUsers.map((u) => u.email));
const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
if (error) throw error;
for (const u of data.users) {
  // при пересоздании базы профили приложения удалены, поэтому все пользователи создаются заново
  if (!u.app_metadata?.demo_seed) continue;
  const { error: e } = await admin.auth.admin.deleteUser(u.id);
  if (e) throw new Error(`${u.email}: ${e.message}`);
  console.log(`  − ${u.email}${keep.has(u.email) ? ' (будет создан заново)' : ''}`);
}
console.log('Готово. Дальше: npm run db:apply -- --seed → npm run seed:users → npm run db:apply -- --after-users');
