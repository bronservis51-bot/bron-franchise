// Собирает SQL для ручного применения в SQL Editor Supabase (если нет прямого подключения к БД).
// supabase/bundle.sql — миграции + seed; supabase/bundle_after_users.sql — данные после создания пользователей.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationFiles, root } from './db-lib.mjs';

const parts = migrationFiles().map((f) => `-- ===== ${f.split('/').pop()} =====\n${readFileSync(f, 'utf8')}`);
parts.push(`-- ===== seed.sql (синтетические данные) =====\n${readFileSync(join(root, 'supabase/seed/seed.sql'), 'utf8')}`);
writeFileSync(join(root, 'supabase/bundle.sql'), `-- СГЕНЕРИРОВАНО npm run sql:bundle. Применять к ПУСТОМУ проекту Supabase один раз.\n\n${parts.join('\n\n')}`);
writeFileSync(join(root, 'supabase/bundle_after_users.sql'), `-- СГЕНЕРИРОВАНО npm run sql:bundle. Выполнять после npm run seed:users.\n\n${readFileSync(join(root, 'supabase/seed/seed_after_users.sql'), 'utf8')}`);
console.log('Готово: supabase/bundle.sql, supabase/bundle_after_users.sql');
