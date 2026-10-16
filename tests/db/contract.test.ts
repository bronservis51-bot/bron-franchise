// Контракт API (ARCH-09): клиент вызывает только существующие команды с существующими аргументами.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { createDb, readContract, root } from '../../scripts/db-lib.mjs';
import { CONTRACT } from '../../src/platform/contract.generated';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('контракт клиента и SQL', () => {
  it('contract.generated.ts соответствует миграциям (npm run gen:contract)', async () => {
    const db = await createDb({ seed: false });
    const actual = await readContract(db);
    const generated = Object.entries(CONTRACT).map(([name, c]) => ({ name, args: [...c.args], returns: c.returns }));
    expect(generated).toEqual(actual.map((c: { name: string; args: string[]; returns: string }) => ({ name: c.name, args: c.args.map((a) => a.replace(/^p_/, '')), returns: c.returns })));
    await db.close();
  }, 120_000);

  it('экраны передают командам только известные аргументы', () => {
    const problems: string[] = [];
    for (const f of files(join(root, 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/command(?:<[^>(]*(?:<[^>]*>)?[^>(]*>)?\('(\w+)'(?:,\s*\{([^}]*)\})?/g)) {
        const name = m[1] as keyof typeof CONTRACT;
        const spec = CONTRACT[name];
        if (!spec) { problems.push(`${f}: нет команды ${name}`); continue; }
        const keys = [...(m[2] ?? '').matchAll(/(?:^|,)\s*(\w+)\s*(?=[:,]|$)/g)].map((k) => k[1]);
        for (const k of keys) if (!(spec.args as readonly string[]).includes(k)) problems.push(`${f.replace(root, '')}: ${name}(${k})`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('модули интерфейса обращаются к backend только через адаптер (ARCH-03)', () => {
    const offenders = files(join(root, 'src/modules')).concat(files(join(root, 'src/ui')))
      .filter((f) => /from '@supabase\/supabase-js'|platform\/supabase'/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('границы модулей в SQL (ARCH-02)', () => {
  it('команды модуля пишут только в таблицы своего модуля', () => {
    const owner: Record<string, string> = {};
    const dir = join(root, 'supabase/migrations');
    const migs = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migs) for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/create table public\.(\w+)/g)) owner[m[1]] = f;
    // Контракт модуля может быть объявлен в более поздней миграции: функция с префиксом модуля-владельца
    const modulePrefixes: Record<string, string[]> = {
      '0003_files.sql': ['file_'], '0004_tasks.sql': ['task_', 'workflow_'], '0005_franchise.sql': ['opening_', 'location_'],
      '0006_support.sql': ['ticket_'], '0007_procurement.sql': ['order_', 'cart_', 'stock_', 'catalog_'], '0008_royalties.sql': ['report_', 'royalty_', 'payment_', 'accrual_'],
      '0009_knowledge.sql': ['article_', 'kb_'], '0016_daily_sales.sql': ['sale_', 'sales_', 'commission_', 'shift_', 'daily_sale'], '0018_shifts_commission_roles.sql': ['sales_'],
    };
    const allowed = new Set(['0001_foundation.sql']);
    const problems: string[] = [];
    for (const f of migs) {
      const sql = readFileSync(join(dir, f), 'utf8');
      for (const m of sql.matchAll(/(?:insert into|update|delete from)\s+public\.(\w+)/g)) {
        const o = owner[m[1]];
        if (!o || o === f || allowed.has(o)) continue;
        const before = sql.slice(0, m.index);
        const fn = [...before.matchAll(/create (?:or replace )?function (?:app_private|public)\.(\w+)/g)].pop()?.[1] ?? '';
        if ((modulePrefixes[o] ?? []).some((p) => fn.startsWith(p))) continue;
        problems.push(`${f} → ${m[1]} (${o}) в ${fn || 'вне функции'}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
