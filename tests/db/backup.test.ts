// Восстановление из резервной копии: те же данные, долги по роялти и права в новой установке.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { createDb, demoUsers } from '../../scripts/db-lib.mjs';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { exportData, restoreData } from '../../scripts/backup-lib.mjs';

describe('резервная копия и восстановление', () => {
  it('экспорт → новая установка с другими id пользователей → те же данные, долги и права', async () => {
    const src = await createDb();
    const dump = await exportData(src);
    expect(dump.tables.daily_revenue.length).toBeGreaterThan(0);

    // Новая установка: только миграции, пользователи созданы заново (новые id)
    const dst = await createDb({ seed: false });
    for (const u of demoUsers) {
      await dst.query(`insert into auth.users(email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}')`, [u.email, JSON.stringify({ full_name: u.name })]);
    }
    await expect(restoreData(dst, dump)).rejects.toThrow(/confirm-wipe/);
    await restoreData(dst, dump, { wipe: true });

    const count = async (db: typeof src, t: string) => Number((await db.query(`select count(*) as n from public.${t}`)).rows[0].n);
    for (const t of ['partner', 'location', 'daily_revenue', 'revenue_plan', 'royalty_payment', 'royalty_manual',
      'article', 'article_revision', 'acknowledgement', 'role_assignment', 'audit_event']) {
      expect(await count(dst, t), t).toBe(await count(src, t));
    }
    const debt = async (db: typeof src) => (await db.query(
      `select p.code, sum(g.debt_minor) as d from public.partner p cross join lateral app_private.royalty_ledger(p.id) g group by 1 order by 1`)).rows;
    expect(await debt(dst)).toEqual(await debt(src));
    expect(Number((await dst.query(`select count(*) as n from public.article where published_revision_id is null and status = 'published'`)).rows[0].n)).toBe(0);
    // права: франчайзи в новой установке видит только своё
    const owner = (await dst.query(`select id from public.app_user where email = 'alpha.owner@demo.example.com'`)).rows[0].id;
    await dst.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: owner })]);
    await dst.exec('set role authenticated');
    expect((await dst.query(`select distinct partner_id from public.daily_revenue`)).rows).toHaveLength(1);
    await dst.exec('reset role');
  }, 240_000);
});
