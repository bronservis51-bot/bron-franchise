// Финансы франчайзи, приватность сотрудника, корректировки роялти с отменой, структура и статистика базы знаний.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM = 'fm@demo.example.com';
const VIKTOR = 'alpha.owner@demo.example.com';
const MARSEL = 'beta.owner@demo.example.com';
const DINA = '79000000011@staff.bron.local';

let t: TestDb;
const id = async (table: string, where: string, v: string) => (await t.admin<{ id: string }>(`select id from public.${table} where ${where} = $1`, [v]))[0].id;
const one = async <T>(email: string, sql: string, params: unknown[] = []) => (await t.as<{ j: T }>(email, sql, params))[0].j;

beforeAll(async () => {
  t = await createTestDb();
}, 180_000);

describe('сотрудник не видит выручку точки', () => {
  it('на экране смены нет выручки, плана и процента точки', async () => {
    const h = await one<{ locations: Record<string, unknown>[] }>(DINA, `select public.staff_home() j`);
    expect(h.locations.length).toBeGreaterThan(0);
    for (const l of h.locations) {
      expect(Object.keys(l).sort()).toEqual(['currency', 'location_id', 'location_name', 'my_today', 'today']);
    }
    await t.expectError(DINA, `select public.finance_my(current_date, null)`, 'forbidden');
  });
});

describe('финансы франчайзи', () => {
  interface Fin { revenue_minor: number; payroll_minor: number; royalty_minor: number; net_minor: number; rate_bp: number }
  it('«все точки» = сумма по точкам; роялти — по ставке; остаток = выручка − зарплата − роялти', async () => {
    const f = await one<{ current: Fin; by_location: (Fin & { location_name: string })[]; months: Fin[]; royalty: unknown }>(VIKTOR,
      `select public.finance_my(current_date, null) j`);
    expect(f.months).toHaveLength(6);
    expect(f.by_location).toHaveLength(3);
    expect(f.current.revenue_minor).toBe(f.by_location.reduce((a, x) => a + Number(x.revenue_minor), 0));
    expect(f.current.payroll_minor).toBe(f.by_location.reduce((a, x) => a + Number(x.payroll_minor), 0));
    expect(f.current.payroll_minor).toBeGreaterThan(0); // смены Дины
    expect(Math.abs(f.current.royalty_minor - Math.round(f.current.revenue_minor * f.current.rate_bp / 10000))).toBeLessThanOrEqual(1);
    expect(f.current.net_minor).toBe(f.current.revenue_minor - f.current.payroll_minor - f.current.royalty_minor);
    expect(f.royalty).not.toBeNull();
  });

  it('фильтр по точке показывает только её; чужая точка — нет; менеджеру этот экран не нужен', async () => {
    const l = await id('location', 'code', 'ALPHA-1');
    const f = await one<{ current: Fin; by_location: unknown; royalty: unknown }>(VIKTOR, `select public.finance_my(current_date, $1) j`, [l]);
    const all = await one<{ by_location: (Fin & { location_id: string })[] }>(VIKTOR, `select public.finance_my(current_date, null) j`);
    expect(f.current.revenue_minor).toBe(all.by_location.find((x) => x.location_id === l)!.revenue_minor);
    expect(f.by_location).toBeNull();
    expect(f.royalty).toBeNull();
    await t.expectError(VIKTOR, `select public.finance_my(current_date, $1)`, 'not-found', [await id('location', 'code', 'BETA-1')]);
    await t.expectError(FM, `select public.finance_my(current_date, null)`, 'forbidden');
  });
});

describe('роялти: исправление начисления и отмена', () => {
  it('«должно быть X» записывает разницу; отмена возвращает расчёт как был', async () => {
    const p = await id('partner', 'code', 'BETA');
    const m = (await t.admin<{ m: string }>(`select to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM-DD') m`))[0].m;
    const month = async () => (await one<{ rows: { partner_name: string; accrued_minor: number; manual_minor: number }[] }>(FM,
      `select public.royalty_summary($1::date) j`, [m])).rows.find((r) => r.partner_name.startsWith('Марсель'))!;
    const before = await month();
    await t.expectError(FM, `select public.royalty_set_accrual($1, $2::date, 100, '')`, 'validation', [p, m]);
    await t.expectError(MARSEL, `select public.royalty_set_accrual($1, $2::date, 100, 'хочу меньше')`, 'forbidden', [p, m]);
    const r = await one<{ id: string; delta_minor: number }>(FM, `select public.royalty_set_accrual($1, $2::date, 5000000, 'пересчитали по акту') j`, [p, m]);
    const after = await month();
    expect(Number(after.accrued_minor) + Number(after.manual_minor)).toBe(5000000);
    expect(r.delta_minor).toBeLessThan(0); // система насчитала больше — корректировка в минус
    const ops = await one<{ id: string; op: string }[]>(FM, `select public.royalty_ops($1, 10) j`, [p]);
    expect(ops.find((o) => o.id === r.id)?.op).toBe('correction');
    await t.as(FM, `select public.royalty_manual_delete($1)`, [r.id]);
    expect(await month()).toEqual(before);
  });
});

describe('база знаний под рост', () => {
  it('разделы в два уровня: третий уровень нельзя; раздел со статьями не удаляется', async () => {
    const top = await one<string>(FM, `select public.kb_section_save(null, null, 'Маркетинг', 'Реклама и соцсети', 60, 'megaphone') j`);
    const sub = await one<string>(FM, `select public.kb_section_save(null, $1, 'Соцсети', null, 10, 'megaphone') j`, [top]);
    await t.expectError(FM, `select public.kb_section_save(null, $1, 'Слишком глубоко', null, 10, 'book')`, 'validation', [sub]);
    await t.expectError(VIKTOR, `select public.kb_section_save(null, null, 'Мой раздел', null, 1, 'book')`, 'forbidden');
    const page = await one<{ children: { title: string }[] }>(VIKTOR, `select public.kb_section_page($1) j`, [top]);
    expect(page.children.map((c) => c.title)).toEqual(['Соцсети']);
    await t.expectError(FM, `select public.kb_section_delete($1)`, 'validation', [await id('kb_section', 'slug', 'okleyka-ekran')]);
    await t.as(FM, `select public.kb_section_delete($1)`, [sub]);
    await t.as(FM, `select public.kb_section_delete($1)`, [top]);
  });

  it('открытие статьи считает просмотр раз в день; оценку видит менеджер', async () => {
    const a = await id('article', 'slug', 'garantiya');
    await t.admin(`delete from public.kb_view where article_id = $1`, [a]);
    await one(MARSEL, `select public.kb_article_open($1) j`, [a]);
    await one(MARSEL, `select public.kb_article_open($1) j`, [a]);
    await one(FM, `select public.kb_article_open($1) j`, [a]); // просмотры менеджера не считаются
    expect(Number((await t.admin<{ n: string }>(`select count(*) n from public.kb_view where article_id = $1`, [a]))[0].n)).toBe(1);
    await t.as(MARSEL, `select public.kb_rate($1, false, 'Не хватает примера с фото')`, [a]);
    const open = await one<{ my_rating: boolean | null; stats: unknown }>(MARSEL, `select public.kb_article_open($1) j`, [a]);
    expect(open.my_rating).toBe(false);
    expect(open.stats).toBeNull();
    const fm = await one<{ stats: { views_30: number; not_helpful: number; comments: { comment: string }[] } }>(FM, `select public.kb_article_open($1) j`, [a]);
    expect(fm.stats.views_30).toBe(1);
    expect(fm.stats.not_helpful).toBe(1);
    expect(fm.stats.comments[0].comment).toMatch(/фото/);
  });

  it('главная базы знаний: разделы с числом статей, новое и популярное; черновики только менеджеру', async () => {
    const h = await one<{ sections: { title: string; count: number; parent_id: string | null }[]; recent: unknown[]; popular: unknown[]; drafts: number | null; total: number }>(
      VIKTOR, `select public.kb_home() j`);
    const okleyka = h.sections.find((s) => s.title === 'Оклейка')!;
    expect(okleyka.count).toBeGreaterThanOrEqual(2); // статьи подразделов входят в счётчик
    expect(h.recent.length).toBeGreaterThan(0);
    expect(h.drafts).toBeNull();
    expect((await one<{ drafts: number }>(FM, `select public.kb_home() j`)).drafts).toBeGreaterThanOrEqual(1);
    const manage = await one<{ title: string; status: string }[]>(FM, `select public.kb_manage() j`);
    expect(manage.some((x) => x.status === 'draft')).toBe(true);
    await t.expectError(VIKTOR, `select public.kb_manage()`, 'forbidden');
  });
});

describe('расходы франчайзи', () => {
  interface Fin { revenue_minor: number; payroll_minor: number; royalty_minor: number; expenses_minor: number; net_minor: number }
  const cur = `date_trunc('month', current_date)::date`;
  it('расход точки и общий расход; общий виден только в «все точки»; остаток учитывает расходы', async () => {
    const l1 = await id('location', 'code', 'ALPHA-1');
    await one(VIKTOR, `select public.expense_save(null, ${cur}, $1, 'Аренда', 3000000, 'ТЦ Европа') j`, [l1]);
    await one(VIKTOR, `select public.expense_save(null, ${cur}, null, 'Интернет', 150000) j`);
    const all = await one<{ current: Fin; expenses: { category: string }[] }>(VIKTOR, `select public.finance_my(current_date, null) j`);
    expect(all.current.expenses_minor).toBe(3150000);
    expect(all.current.net_minor).toBe(all.current.revenue_minor - all.current.payroll_minor - all.current.royalty_minor - 3150000);
    expect(all.expenses.map((x) => x.category).sort()).toEqual(['Аренда', 'Интернет']);
    const one1 = await one<{ current: Fin; expenses: unknown[] }>(VIKTOR, `select public.finance_my(current_date, $1) j`, [l1]);
    expect(one1.current.expenses_minor).toBe(3000000);
    const l2 = await id('location', 'code', 'ALPHA-2');
    expect((await one<{ current: Fin }>(VIKTOR, `select public.finance_my(current_date, $1) j`, [l2])).current.expenses_minor).toBe(0);
  });

  it('повтор прошлого месяца без дублей; чужие расходы и будущий месяц — нельзя; сотрудник не ведёт расходы', async () => {
    const prev = `(date_trunc('month', current_date) - interval '1 month')::date`;
    await one(VIKTOR, `select public.expense_save(null, ${prev}, null, 'Интернет', 150000) j`);
    await one(VIKTOR, `select public.expense_save(null, ${prev}, null, 'Реклама', 500000) j`);
    expect(await one<number>(VIKTOR, `select public.expense_repeat(current_date) j`)).toBe(1); // интернет уже есть
    expect(await one<number>(VIKTOR, `select public.expense_repeat(current_date) j`)).toBe(0);
    const eid = (await t.admin<{ id: string }>(`select id from public.expense where category = 'Реклама' and month = ${cur}`))[0].id;
    await t.expectError(MARSEL, `select public.expense_delete($1)`, 'not-found', [eid]);
    await t.expectError(VIKTOR, `select public.expense_save(null, (${cur} + interval '1 month')::date, null, 'Аренда', 100)`, 'validation');
    await t.expectError(VIKTOR, `select public.expense_save(null, ${cur}, $1, 'Аренда', 100)`, 'not-found', [await id('location', 'code', 'BETA-1')]);
    await t.expectError(DINA, `select public.expense_save(null, ${cur}, null, 'Аренда', 100)`, 'forbidden');
    await t.as(VIKTOR, `select public.expense_delete($1)`, [eid]);
    const f = await one<{ expense_categories: string[]; expenses: { category: string }[] }>(VIKTOR, `select public.finance_my(current_date, null) j`);
    expect(f.expenses.map((x) => x.category)).not.toContain('Реклама');
    expect(f.expense_categories).toContain('Аренда');
  });
});

describe('начало учёта роялти', () => {
  it('выручка до начала учёта не попадает в начисление и долг', async () => {
    const p = await id('partner', 'code', 'GAMMA');
    const debt = async () => (await one<{ rows: { partner_id: string; debt_minor: number; accrued_minor: number }[] }>(FM,
      `select public.royalty_summary(null) j`)).rows.find((r) => r.partner_id === p)!;
    const before = await debt();
    expect(Number(before.accrued_minor)).toBeGreaterThan(0);
    await t.admin(`update public.partner set royalty_from = date_trunc('month', current_date)::date where id = $1`, [p]);
    const after = await debt();
    expect(Number(after.accrued_minor)).toBe(0);
    expect(Number(after.debt_minor)).toBeLessThan(Number(before.debt_minor));
    await t.admin(`update public.partner set royalty_from = null where id = $1`, [p]);
  });
});
