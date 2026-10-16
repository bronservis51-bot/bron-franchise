// Применяет миграции к проекту Supabase по прямому подключению (DATABASE_URL из .env.local, НЕ коммитится).
// Учитывает уже применённые файлы (app_private.schema_migration) и проверяет, что их содержимое не менялось.
//   npm run db:apply            — миграции
//   npm run db:apply -- --seed  — миграции + синтетический seed (только для демо-проекта)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { migrationFiles, root } from './db-lib.mjs';
import { loadEnv, need } from './env.mjs';

loadEnv();
const url = need('DATABASE_URL', 'Supabase → Project Settings → Database → Connection string (Session pooler). Пароль БД — секрет: только в .env.local.');
const withSeed = process.argv.includes('--seed');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(`create schema if not exists app_private;
  create table if not exists app_private.schema_migration(name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
const done = new Map((await client.query('select name, checksum from app_private.schema_migration')).rows.map((r) => [r.name, r.checksum]));

async function apply(name, sql) {
  const sum = createHash('sha256').update(sql).digest('hex');
  if (done.has(name)) {
    if (done.get(name) !== sum) {
      // Демо-данные уже лежат в базе; правка файла seed влияет только на новые установки
      if (name.startsWith('seed')) { console.log(`  = ${name} (файл изменён после применения — для новых установок)`); return; }
      throw new Error(`${name} уже применена, но файл изменён. Новые изменения — новой миграцией.`);
    }
    console.log(`  = ${name}`);
    return;
  }
  await client.query('begin');
  try {
    await client.query(sql);
    await client.query('insert into app_private.schema_migration(name, checksum) values ($1, $2)', [name, sum]);
    await client.query('commit');
    console.log(`  + ${name}`);
  } catch (e) {
    await client.query('rollback');
    throw new Error(`${name}: ${e.message}${e.detail ? ` (${e.detail})` : ''}`);
  }
}

try {
  for (const f of migrationFiles()) await apply(f.split('/').pop(), readFileSync(f, 'utf8'));
  if (withSeed) await apply('seed.sql', readFileSync(join(root, 'supabase/seed/seed.sql'), 'utf8'));
  if (process.argv.includes('--after-users')) await apply('seed_after_users.sql', readFileSync(join(root, 'supabase/seed/seed_after_users.sql'), 'utf8'));
  if (process.argv.includes('--after-users') || process.argv.includes('--seed-v2')) await apply('seed_v2.sql', readFileSync(join(root, 'supabase/seed/seed_v2.sql'), 'utf8'));
  if (process.argv.includes('--after-users') || process.argv.includes('--seed-v3')) await apply('seed_v3.sql', readFileSync(join(root, 'supabase/seed/seed_v3.sql'), 'utf8'));
  if (process.argv.includes('--after-users') || process.argv.includes('--seed-v4')) await apply('seed_v4.sql', readFileSync(join(root, 'supabase/seed/seed_v4.sql'), 'utf8'));
  if (process.argv.includes('--after-users') || process.argv.includes('--seed-v5')) await apply('seed_v5.sql', readFileSync(join(root, 'supabase/seed/seed_v5.sql'), 'utf8'));
  if (process.argv.includes('--after-users') || process.argv.includes('--seed-v6')) await apply('seed_v6.sql', readFileSync(join(root, 'supabase/seed/seed_v6.sql'), 'utf8'));
  if (process.argv.includes('--after-users') || process.argv.includes('--seed-v7')) await apply('seed_v7.sql', readFileSync(join(root, 'supabase/seed/seed_v7.sql'), 'utf8'));
  if (process.argv.includes('--after-users') || process.argv.includes('--seed-v8')) await apply('seed_v8.sql', readFileSync(join(root, 'supabase/seed/seed_v8.sql'), 'utf8'));
  console.log('Готово.');
} finally {
  await client.end();
}
