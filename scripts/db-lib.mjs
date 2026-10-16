// Общая сборка локальной БД на PGlite: эмуляция Supabase + миграции + seed (ADR-0006).
// Используется тестами, генератором контракта и локальным бэкендом разработки.
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const demoUsers = JSON.parse(readFileSync(join(root, 'supabase/seed/demo-users.json'), 'utf8'));

export function migrationFiles() {
  const dir = join(root, 'supabase/migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => join(dir, f));
}

async function run(db, file, label) {
  try {
    await db.exec(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${label}: ${e.message}${e.detail ? ` (${e.detail})` : ''}`);
  }
}

/** Новая БД. dataDir — каталог для сохранения между запусками (локальный бэкенд); без него — в памяти. */
export async function createDb({ dataDir, seed = true, users = true, onUser } = {}) {
  const db = dataDir ? new PGlite(dataDir, { extensions: { pg_trgm } }) : new PGlite({ extensions: { pg_trgm } });
  await run(db, join(root, 'supabase/tests-shim/00_supabase_shim.sql'), 'Эмуляция Supabase');
  for (const f of migrationFiles()) await run(db, f, `Миграция ${f.split('/').pop()}`);
  if (seed) {
    await run(db, join(root, 'supabase/seed/seed.sql'), 'Seed');
    if (users) {
      for (const u of demoUsers) {
        const r = await db.query(
          `insert into auth.users(email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3) returning id`,
          [u.email, JSON.stringify({ full_name: u.name, locale: u.locale ?? 'ru' }), JSON.stringify({ demo_seed: true })],
        );
        if (onUser) await onUser(db, u, r.rows[0].id);
      }
      await run(db, join(root, 'supabase/seed/seed_after_users.sql'), 'Seed после пользователей');
      await run(db, join(root, 'supabase/seed/seed_v2.sql'), 'Seed v2 (каталог, выручка)');
      await run(db, join(root, 'supabase/seed/seed_v3.sql'), 'Seed v3 (роли, смены, прозрачность, поставки)');
      await run(db, join(root, 'supabase/seed/seed_v4.sql'), 'Seed v4 (имена франчайзи и города)');
      await run(db, join(root, 'supabase/seed/seed_v5.sql'), 'Seed v5 (заметки к точкам)');
      await run(db, join(root, 'supabase/seed/seed_v6.sql'), 'Seed v6 (CRM)');
      await run(db, join(root, 'supabase/seed/seed_v7.sql'), 'Seed v7 (должностные инструкции)');
      await run(db, join(root, 'supabase/seed/seed_v8.sql'), 'Seed v8 (продажи на точках)');
    }
  }
  return db;
}

/** Описание клиентских команд из pg_proc: имена аргументов, типы и форма результата. */
export async function readContract(db) {
  const r = await db.query(`
    select p.proname as name,
      coalesce(p.proargnames[1:p.pronargs], '{}') as args,
      array(select format_type(x, null) from unnest(p.proargtypes) x) as types,
      p.pronargdefaults as defaults,
      case when p.proretset then 'set'
           when t.typname = 'void' then 'void'
           when t.typtype = 'c' then 'single'
           else 'scalar' end as returns
    from app_private.client_command c
    join pg_proc p on p.oid = c.fn
    join pg_type t on t.oid = p.prorettype
    order by p.proname`);
  return r.rows;
}
