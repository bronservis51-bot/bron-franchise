// Чтение .env.local без внешних зависимостей (секреты остаются на компьютере администратора).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './db-lib.mjs';

export function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return process.env;
}

export function need(name, hint) {
  const v = process.env[name];
  if (!v) {
    console.error(`Нужна переменная ${name}. ${hint ?? ''}`);
    process.exit(1);
  }
  return v;
}
