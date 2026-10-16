// Создаёт синтетических демо-пользователей через Admin API Supabase (COST-18: административная операция
// в доверенной среде). Нужен секретный ключ проекта — только в .env.local на компьютере администратора.
// Пароли генерируются и сохраняются в local/demo-users.local.md (не коммитится).
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { demoUsers, root } from './db-lib.mjs';
import { loadEnv, need } from './env.mjs';

loadEnv();
const url = need('VITE_SUPABASE_URL');
const secret = need('SUPABASE_SECRET_KEY', 'Supabase → Project Settings → API Keys → Secret key. Никогда не в VITE_* переменных.');
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

const existing = new Set();
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw error;
  data.users.forEach((u) => existing.add(u.email));
  if (data.users.length < 200) break;
}

// Быстрый вход по ролям (демо): общий пароль из VITE_DEMO_QUICK_PASSWORD применяется ко всем демо-пользователям.
const quick = process.env.VITE_DEMO_QUICK_PASSWORD?.trim();
const existingById = new Map();
for (let page = 1; ; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) throw error;
  data.users.forEach((u) => existingById.set(u.email, u.id));
  if (data.users.length < 200) break;
}

const rows = [];
for (const u of demoUsers) {
  if (existing.has(u.email)) {
    if (quick) {
      const { error } = await admin.auth.admin.updateUserById(existingById.get(u.email), { password: quick });
      if (error) throw new Error(`${u.email}: ${error.message}`);
      console.log(`  ~ ${u.email} (общий демо-пароль)`);
      rows.push({ ...u, password: quick });
    } else {
      console.log(`  = ${u.email} (уже есть; пароль не меняется)`);
      rows.push({ ...u, password: '(без изменений)' });
    }
    continue;
  }
  const password = quick || `Demo-${randomBytes(4).toString('hex')}-${randomBytes(4).toString('hex')}`;
  const { error } = await admin.auth.admin.createUser({
    email: u.email, password, email_confirm: true,
    user_metadata: { full_name: u.name, locale: u.locale ?? 'ru' },
    app_metadata: { demo_seed: true }, // только администратор может выставить app_metadata
  });
  if (error) throw new Error(`${u.email}: ${error.message}`);
  console.log(`  + ${u.email}`);
  rows.push({ ...u, password });
}
mkdirSync(join(root, 'local'), { recursive: true });
writeFileSync(join(root, 'local/demo-users.local.md'), ['# Демо-пользователи стенда (не коммитить, передавать участникам лично)', '',
  `Стенд: ${url}`, '', '| Роль | Email | Пароль |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.name} | ${r.email} | ${r.password} |`)].join('\n') + '\n');
console.log('Пароли: local/demo-users.local.md. Дальше: npm run db:apply -- --after-users (или bundle_after_users.sql в SQL Editor).');
