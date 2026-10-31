// Резервная копия демо-стенда (COST-13): бизнес-данные (JSON) + файлы закрытого bucket.
// Supabase Free не делает автоматических бэкапов — запускайте перед демонстрациями и после важных изменений.
// Нужны DATABASE_URL и SUPABASE_SECRET_KEY в .env.local (локально, не в репозитории). Результат: backups/<время>/
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { root } from './db-lib.mjs';
import { exportData } from './backup-lib.mjs';
import { loadEnv, need } from './env.mjs';

loadEnv();
const url = need('DATABASE_URL');
const dir = join(root, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const client = new pg.Client({ connectionString: url,  });
await client.connect();
try {
  const dump = await exportData(client);
  writeFileSync(join(dir, 'data.json'), JSON.stringify(dump), { mode: 0o600 });
  const files = dump.tables.partner_document ?? [];
  console.log(`Данные: ${Object.values(dump.tables).reduce((n, r) => n + r.length, 0)} строк; файлов к выгрузке: ${files.length}`);
  if (files.length && process.env.SUPABASE_SECRET_KEY) {
    const admin = createClient(need('VITE_SUPABASE_URL'), process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
    for (const f of files) {
      const { data, error } = await admin.storage.from('private-files').download(f.path);
      if (error) throw new Error(`Не удалось выгрузить вложение ${f.path}: ${error.message}`);
      const out = resolve(dir, 'files', f.path);
      if (!out.startsWith(resolve(dir, 'files') + sep)) throw new Error('Неверный путь вложения');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(await data.arrayBuffer()), { mode: 0o600 });
    }
  } else if (files.length) {
    throw new Error('SUPABASE_SECRET_KEY не задан: резервная копия вложений не завершена.');
  }
  console.log(`Готово: ${dir}`);
} finally {
  await client.end();
}
