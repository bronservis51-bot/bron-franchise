// Резервная копия демо-стенда (COST-13): бизнес-данные (JSON) + файлы закрытого bucket.
// Supabase Free не делает автоматических бэкапов — запускайте перед демонстрациями и после важных изменений.
// Нужны DATABASE_URL и SUPABASE_SECRET_KEY в .env.local (локально, не в репозитории). Результат: backups/<время>/
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { root } from './db-lib.mjs';
import { exportData } from './backup-lib.mjs';
import { loadEnv, need } from './env.mjs';

loadEnv();
const url = need('DATABASE_URL');
const dir = join(root, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true });
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const dump = await exportData(client);
  writeFileSync(join(dir, 'data.json'), JSON.stringify(dump));
  const files = dump.tables.file_asset?.filter((f) => f.status === 'ready') ?? [];
  console.log(`Данные: ${Object.values(dump.tables).reduce((n, r) => n + r.length, 0)} строк; файлов к выгрузке: ${files.length}`);
  if (files.length && process.env.SUPABASE_SECRET_KEY) {
    const admin = createClient(need('VITE_SUPABASE_URL'), process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
    for (const f of files) {
      const { data, error } = await admin.storage.from(f.bucket).download(f.path);
      if (error) { console.warn(`  ! ${f.path}: ${error.message}`); continue; }
      const out = join(dir, 'files', f.path);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(await data.arrayBuffer()));
    }
  } else if (files.length) {
    console.warn('SUPABASE_SECRET_KEY не задан — файлы не выгружены, только метаданные.');
  }
  console.log(`Готово: ${dir}`);
} finally {
  await client.end();
}
