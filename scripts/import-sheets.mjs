// Перенос реальной выручки франчайзи из Google-таблиц в базу.
// Данные и настройки — только на компьютере администратора (папка local/import, в git не попадает):
//   local/import/partners.json — список: { file, code, name, country, currency, city, timezone, location }
//   local/import/<file>.csv     — лист «ВЫРУЧКА» таблицы франчайзи, выгруженный в CSV
//   npm run import:sheets            — в проект Supabase (DATABASE_URL из .env.local), одной транзакцией
//   npm run import:sheets -- --local — в локальную БД разработки (local/pgdata; локальный бэкенд должен быть остановлен)
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './db-lib.mjs';
import { loadEnv, need } from './env.mjs';
import { importPartner } from './sheets-import-lib.mjs';

const dir = join(root, 'local/import');
const config = JSON.parse(readFileSync(join(dir, 'partners.json'), 'utf8'));
const year = config.year;
const local = process.argv.includes('--local');

let q; let done;
if (local) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = new PGlite(join(root, 'local/pgdata'), { extensions: { pg_trgm, pgcrypto } });
  q = async (sql, params) => (await db.query(sql, params)).rows;
  await db.exec('begin');
  done = async (ok) => { await db.exec(ok ? 'commit' : 'rollback'); await db.close(); };
} else {
  loadEnv();
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: need('DATABASE_URL'), ssl: { rejectUnauthorized: false } });
  await client.connect();
  q = async (sql, params) => (await client.query(sql, params)).rows;
  await client.query('begin');
  done = async (ok) => { await client.query(ok ? 'commit' : 'rollback'); await client.end(); };
}

console.log(`Перенос из таблиц (${local ? 'локальная БД' : 'Supabase'}), год ${year}:`);
try {
  const missing = [];
  for (const cfg of config.partners) {
    const file = join(dir, `${cfg.file}.csv`);
    if (!existsSync(file)) { missing.push(cfg.name); continue; }
    await importPartner(q, cfg, readFileSync(file, 'utf8'), year);
  }
  await done(true);
  if (missing.length) console.log(`Нет выгрузки таблицы (нет доступа): ${missing.join(', ')}`);
  console.log('Готово.');
} catch (e) {
  await done(false);
  console.error(`Ошибка, ничего не изменено: ${e.message}`);
  process.exit(1);
}
