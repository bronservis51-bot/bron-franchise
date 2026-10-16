// Восстановление из backups/<время>/ в ПУСТОЙ проект с применёнными миграциями и созданными пользователями.
//   npm run db:restore -- backups/<время> --confirm-wipe
// Бизнес-данные целевого проекта заменяются копией (поэтому флаг подтверждения обязателен).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { restoreData } from './backup-lib.mjs';
import { loadEnv, need } from './env.mjs';

loadEnv();
const [src] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!src || !existsSync(join(src, 'data.json'))) { console.error('Укажите каталог резервной копии: npm run db:restore -- backups/<время> --confirm-wipe'); process.exit(1); }
const url = need('DATABASE_URL');
console.log(`Цель: ${new URL(url).host}`);
if (!process.argv.includes('--confirm-wipe')) { console.error('Добавьте --confirm-wipe: бизнес-данные целевого проекта будут заменены.'); process.exit(1); }
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('begin');
  await restoreData(client, JSON.parse(readFileSync(join(src, 'data.json'), 'utf8')), { wipe: true, log: console.log });
  await client.query('commit');
} catch (e) {
  await client.query('rollback');
  throw e;
} finally {
  await client.end();
}
const filesDir = join(src, 'files');
if (existsSync(filesDir) && process.env.SUPABASE_SECRET_KEY) {
  const admin = createClient(need('VITE_SUPABASE_URL'), process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(filesDir)) {
    const path = relative(filesDir, f);
    const { error } = await admin.storage.from('private-files').upload(path, readFileSync(f), { upsert: true });
    console.log(error ? `  ! ${path}: ${error.message}` : `  + ${path}`);
  }
}
console.log('Восстановление завершено. Проверьте: вход демо-пользователей, «Сегодня», сальдо роялти, открытие файла.');
