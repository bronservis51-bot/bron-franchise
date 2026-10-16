// AT-15: восстановление из резервной копии — согласованные данные и связи доступны в новой установке.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { createDb, demoUsers } from '../../scripts/db-lib.mjs';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { exportData, restoreData } from '../../scripts/backup-lib.mjs';

describe('AT-15: резервная копия и восстановление', () => {
  it('экспорт → новая установка с другими id пользователей → те же данные, сальдо и права', async () => {
    const src = await createDb();
    const dump = await exportData(src);
    expect(dump.tables.accrual.length).toBeGreaterThan(0);

    // Новая установка: только миграции, пользователи созданы заново (новые id)
    const dst = await createDb({ seed: false });
    for (const u of demoUsers) {
      await dst.query(`insert into auth.users(email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, '{}')`, [u.email, JSON.stringify({ full_name: u.name })]);
    }
    await expect(restoreData(dst, dump)).rejects.toThrow(/confirm-wipe/);
    await restoreData(dst, dump, { wipe: true });

    const count = async (db: typeof src, t: string) => Number((await db.query(`select count(*) as n from public.${t}`)).rows[0].n);
    for (const t of ['task', 'ticket', 'sales_order', 'order_line', 'revenue_report', 'report_line', 'accrual', 'payment', 'allocation',
      'article', 'article_revision', 'role_assignment', 'opening_project', 'audit_event']) {
      expect(await count(dst, t), t).toBe(await count(src, t));
    }
    const bal = async (db: typeof src) => (await db.query(`select number, outstanding_minor from public.v_accrual_balance order by number`)).rows;
    expect(await bal(dst)).toEqual(await bal(src));
    // связи: опубликованные редакции и текущие редакции отчётов восстановлены вторым проходом
    expect(Number((await dst.query(`select count(*) as n from public.article where published_revision_id is null and status = 'published'`)).rows[0].n)).toBe(0);
    // права: партнёр в новой установке видит только своё
    const partner = (await dst.query(`select id from public.app_user where email = 'alpha.owner@demo.example.com'`)).rows[0].id;
    await dst.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: partner })]);
    await dst.exec('set role authenticated');
    const reports = (await dst.query(`select distinct partner_id from public.revenue_report`)).rows;
    expect(reports).toHaveLength(1);
    await dst.exec('reset role');
  }, 240_000);
});
