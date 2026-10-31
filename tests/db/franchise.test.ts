// Кабинет франчайзи: доступ по ролям, выручка за день, план, роялти, база знаний.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM = 'fm@demo.example.com';
const VIKTOR = 'alpha.owner@demo.example.com';
const MARSEL = 'beta.owner@demo.example.com';

let t: TestDb;
const loc = async (code: string) => (await t.admin<{ id: string }>(`select id from public.location where code = $1`, [code]))[0].id;
const partner = async (code: string) => (await t.admin<{ id: string }>(`select id from public.partner where code = $1`, [code]))[0].id;
const today = async (l: string, shift = 0) =>
  (await t.admin<{ d: string }>(`select to_char(app_private.local_today($1) + $2::int, 'YYYY-MM-DD') d`, [l, shift]))[0].d;
const one = async <T>(email: string, sql: string, params: unknown[] = []) => (await t.as<{ j: T }>(email, sql, params))[0].j;

beforeAll(async () => {
  t = await createTestDb();
}, 180_000);

describe('доступ', () => {
  it('у демо-пользователей ровно по одной роли: менеджер на всю сеть, франчайзи и сотрудник — на франчайзи', async () => {
    const rows = await t.admin<{ email: string; role: string; scope_type: string }>(
      `select u.email, a.role, a.scope_type from public.role_assignment a join public.app_user u on u.id = a.user_id order by u.email`);
    expect(rows).toEqual([
      { email: '79000000011@staff.bron.local', role: 'franchisee_staff', scope_type: 'partner' },
      { email: VIKTOR, role: 'franchisee', scope_type: 'partner' },
      { email: MARSEL, role: 'franchisee', scope_type: 'partner' },
      { email: FM, role: 'franchise_manager', scope_type: 'company' },
      { email: 'gamma.owner@demo.example.com', role: 'franchisee', scope_type: 'partner' },
    ]);
  });

  it('франчайзи видит только своих франчайзи, точки и выручку', async () => {
    expect((await t.as<{ code: string }>(VIKTOR, `select code from public.partner`)).map((r) => r.code)).toEqual(['ALPHA']);
    const locs = await t.as<{ code: string }>(VIKTOR, `select code from public.location order by code`);
    expect(locs.map((r) => r.code)).toEqual(['ALPHA-1', 'ALPHA-2', 'ALPHA-3']);
    const foreign = await t.as(VIKTOR, `select 1 from public.daily_revenue r join public.location l on l.id = r.location_id where l.partner_id <> (select id from public.partner where code = 'ALPHA')`);
    expect(foreign).toHaveLength(0);
    await t.expectError(VIKTOR, `select public.revenue_month($1, current_date)`, 'not-found', [await loc('BETA-1')]);
  });

  it('франчайзи не видит роялти и не может ими управлять', async () => {
    for (const tbl of ['royalty_payment', 'royalty_manual', 'royalty_rate']) {
      expect(await t.as(VIKTOR, `select * from public.${tbl}`)).toHaveLength(0);
    }
    await t.expectError(VIKTOR, `select public.royalty_summary(null)`, 'forbidden');
    await t.expectError(VIKTOR, `select public.royalty_payment_add($1, current_date, 100, current_date, null)`, 'forbidden', [await partner('ALPHA')]);
  });

  it('менеджер видит всю сеть', async () => {
    expect(await t.as(FM, `select 1 from public.location`)).toHaveLength(5);
    const o = await one<{ rows: unknown[] }>(FM, `select public.revenue_overview(current_date) j`);
    expect(o.rows).toHaveLength(5);
  });

  it('доступ по email: приглашение срабатывает при первом создании пользователя', async () => {
    const p = await partner('BETA');
    expect(await one(FM, `select public.access_grant($1, 'New.Owner@Example.com') j`, [p])).toEqual({ status: 'pending' });
    await t.expectError(VIKTOR, `select public.access_grant($1, 'x@example.com')`, 'forbidden', [p]);
    await t.admin(`insert into auth.users(email, raw_user_meta_data) values ('new.owner@example.com', '{"full_name":"Новый Франчайзи"}')`);
    const a = await t.admin<{ role: string; scope_id: string }>(
      `select a.role, a.scope_id from public.role_assignment a join public.app_user u on u.id = a.user_id where u.email = 'new.owner@example.com'`);
    expect(a).toEqual([{ role: 'franchisee', scope_id: p }]);
    const access = await one<{ users: { email: string }[]; invites: unknown[] }>(FM, `select public.partner_access($1) j`, [p]);
    expect(access.users.map((u) => u.email).sort()).toEqual(['beta.owner@demo.example.com', 'new.owner@example.com']);
    expect(access.invites).toHaveLength(0);
  });
});

describe('выручка за день', () => {
  it('итог = наличные + карта; повторный ввод того же дня исправляет запись', async () => {
    const l = await loc('ALPHA-1');
    const d = await today(l);
    const r = await t.as<{ total_minor: string; revision: number }>(VIKTOR,
      `select * from public.revenue_save($1, $2::date, 500000, 1200000, 'тест')`, [l, d]);
    expect(Number(r[0].total_minor)).toBe(1700000);
    const r2 = await t.as<{ total_minor: string; revision: number }>(VIKTOR,
      `select * from public.revenue_save($1, $2::date, 600000, 1200000, null)`, [l, d]);
    expect(Number(r2[0].total_minor)).toBe(1800000);
    expect(r2[0].revision).toBe(2);
  });

  it('нельзя внести будущий день, отрицательную сумму и выручку чужой точки', async () => {
    const l = await loc('ALPHA-1');
    await t.expectError(VIKTOR, `select public.revenue_save($1, $2::date, 100, 0, null)`, 'validation', [l, await today(l, 1)]);
    await t.expectError(VIKTOR, `select public.revenue_save($1, $2::date, -1, 0, null)`, 'validation', [l, await today(l)]);
    await t.expectError(MARSEL, `select public.revenue_save($1, $2::date, 100, 0, null)`, 'not-found', [l, await today(l)]);
  });

  it('франчайзи не правит закрытые месяцы, менеджер — может', async () => {
    const l = await loc('ALPHA-2');
    const old = (await t.admin<{ d: string }>(`select to_char((date_trunc('month', app_private.local_today($1)) - interval '2 months')::date + 3, 'YYYY-MM-DD') d`, [l]))[0].d;
    await t.expectError(VIKTOR, `select public.revenue_save($1, $2::date, 100, 0, null)`, 'period-locked', [l, old]);
    const r = await t.as<{ total_minor: string }>(FM, `select * from public.revenue_save($1, $2::date, 100, 0, 'исправил менеджер')`, [l, old]);
    expect(Number(r[0].total_minor)).toBe(100);
  });

  it('сводка месяца показывает пропущенные дни и сколько нужно в день до плана', async () => {
    const m = await one<{ missing_days: string[]; plan_minor: number; fact_minor: number; need_per_day_minor: number | null; days: unknown[] }>(
      VIKTOR, `select public.revenue_month($1, current_date) j`, [await loc('ALPHA-1')]);
    expect(m.plan_minor).toBeGreaterThan(0);
    // В первые два дня месяца пропуски seed находятся в прошлом месяце.
    const l = await loc('ALPHA-1');
    const withGaps = await one<{ missing_days: string[] }>(VIKTOR,
      `select public.revenue_month($1, $2::date) j`, [l, await today(l, -2)]);
    expect(withGaps.missing_days.length).toBeGreaterThanOrEqual(1);
    expect(m.days.length).toBeGreaterThan(0);
    if (m.fact_minor < m.plan_minor) expect(m.need_per_day_minor).toBeGreaterThan(0);
  });
});

describe('план', () => {
  it('план ставит только менеджер; 0 снимает план', async () => {
    const l = await loc('ALPHA-3');
    await t.expectError(VIKTOR, `select public.revenue_plan_set($1, current_date, 100000)`, 'forbidden', [l]);
    await t.as(FM, `select public.revenue_plan_set($1, (current_date + interval '1 month')::date, 33300000)`, [l]);
    const m = await one<{ plan_minor: number }>(VIKTOR, `select public.revenue_month($1, (current_date + interval '1 month')::date) j`, [l]);
    expect(m.plan_minor).toBe(33300000);
    await t.as(FM, `select public.revenue_plan_set($1, (current_date + interval '1 month')::date, 0)`, [l]);
    const m2 = await one<{ plan_minor: number | null; pct: number | null }>(VIKTOR, `select public.revenue_month($1, (current_date + interval '1 month')::date) j`, [l]);
    expect(m2.plan_minor).toBeNull();
    expect(m2.pct).toBeNull();
  });
});

describe('роялти', () => {
  interface Row { partner_name: string; currency: string; revenue_minor: number; accrued_minor: number; manual_minor: number; paid_minor: number; debt_minor: number; rate_bp: number }
  const summary = async (month: string | null) =>
    one<{ rows: Row[] }>(FM, month ? `select public.royalty_summary($1::date) j` : `select public.royalty_summary(null) j`, month ? [month] : []);

  it('в сводке все франчайзи; начислено = 7 % выручки закрытых месяцев', async () => {
    const s = await summary(null);
    expect(s.rows.map((r) => r.partner_name).sort()).toEqual(['Виктор (Волгоград)', 'Марсель (Караганда)', 'Махмут (Стамбул)']);
    for (const r of s.rows) {
      expect(r.rate_bp).toBe(700);
      expect(Math.abs(r.accrued_minor - Math.round(r.revenue_minor * 0.07))).toBeLessThanOrEqual(3);
      expect(r.debt_minor).toBe(r.accrued_minor + r.manual_minor - r.paid_minor);
    }
  });

  it('франчайзи без выручки тоже в сводке с нулевым долгом', async () => {
    const p = await one<string>(FM, `select public.partner_save(null, 'Тест без выручки', 'RU', null, null, null) j`);
    const s = await summary(null);
    const row = s.rows.find((r) => r.partner_name === 'Тест без выручки')!;
    expect(row.debt_minor).toBe(0);
    await t.admin(`delete from public.audit_event where partner_id = $1`, [p]);
    await t.admin(`delete from public.partner where id = $1`, [p]);
  });

  it('прошлый долг и оплата меняют долг; фильтр по месяцу показывает только этот месяц', async () => {
    const p = await partner('ALPHA');
    const before = (await summary(null)).rows.find((r) => r.partner_name.startsWith('Виктор'))!;
    const oldMonth = (await t.admin<{ m: string }>(`select to_char(date_trunc('month', current_date) - interval '8 months', 'YYYY-MM-DD') m`))[0].m;
    const manual = await one<string>(FM, `select public.royalty_manual_add($1, $2::date, 500000, 'старый долг') j`, [p, oldMonth]);
    const after = (await summary(null)).rows.find((r) => r.partner_name.startsWith('Виктор'))!;
    expect(after.debt_minor).toBe(before.debt_minor + 500000);

    const month = (await summary(oldMonth)).rows.find((r) => r.partner_name.startsWith('Виктор'))!;
    expect(month).toMatchObject({ manual_minor: 500000, paid_minor: 0, debt_minor: 500000, accrued_minor: 0 });

    const pay = await one<string>(FM, `select public.royalty_payment_add($1, $2::date, 200000, current_date, 'частично') j`, [p, oldMonth]);
    expect((await summary(oldMonth)).rows.find((r) => r.partner_name.startsWith('Виктор'))!.debt_minor).toBe(300000);

    await t.as(FM, `select public.royalty_payment_delete($1)`, [pay]);
    await t.as(FM, `select public.royalty_manual_delete($1)`, [manual]);
    expect((await summary(null)).rows.find((r) => r.partner_name.startsWith('Виктор'))!.debt_minor).toBe(before.debt_minor);
  });

  it('текущий месяц ещё начисляется и в долг не входит', async () => {
    const cur = await one<{ rows: (Row & { is_open: boolean })[]; current_month: string }>(FM, `select public.royalty_summary(date_trunc('month', current_date)::date) j`);
    const v = cur.rows.find((r) => r.partner_name.startsWith('Виктор'))!;
    expect(v.is_open).toBe(true);
    const all = (await summary(null)).rows.find((r) => r.partner_name.startsWith('Виктор'))! as Row & { current_accrual_minor: number };
    expect(all.current_accrual_minor).toBe(v.accrued_minor);
  });

  it('новая ставка действует с указанного месяца', async () => {
    const p = await partner('BETA');
    const m = (await t.admin<{ m: string }>(`select to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM-DD') m`))[0].m;
    await t.as(FM, `select public.royalty_rate_set($1, 1000, $2::date)`, [p, m]);
    const r = (await summary(m)).rows.find((x) => x.partner_name.startsWith('Марсель'))!;
    expect(r.rate_bp).toBe(1000);
    expect(Math.abs(r.accrued_minor - Math.round(r.revenue_minor * 0.1))).toBeLessThanOrEqual(1);
    await t.admin(`delete from public.royalty_rate where partner_id = $1`, [p]);
  });
});

describe('база знаний', () => {
  it('франчайзи читает опубликованное, черновиков не видит и писать не может', async () => {
    const titles = await t.as<{ status: string }>(VIKTOR, `select status from public.article`);
    expect(titles.every((a) => a.status === 'published')).toBe(true);
    expect(await t.as(FM, `select 1 from public.article where status = 'draft'`)).toHaveLength(1);
    await t.expectError(VIKTOR, `select public.article_create((select id from public.kb_section limit 1), 'article', 'Моя статья')`, 'forbidden');
  });

  it('менеджер публикует сразу; повторное ознакомление требуется заново', async () => {
    const sec = (await t.admin<{ id: string }>(`select id from public.kb_section where slug = 'nachalo'`))[0].id;
    const c = await one<{ article_id: string }>(FM, `select public.article_create($1, 'regulation', 'Правила точки') j`, [sec]);
    const a = c.article_id;
    await t.as(FM, `select public.article_save_draft($1, 'Правила точки', null, 'Открываемся в 10:00, закрываемся в 22:00. Без опозданий.', null)`, [a]);
    await t.as(FM, `select public.article_update_meta($1, null, null, true, null)`, [a]);
    await t.as(FM, `select public.article_publish($1, false, null)`, [a]);
    const toRead = async () => (await t.as<{ article_id: string }>(MARSEL, `select * from public.kb_to_read()`)).map((r) => r.article_id);
    expect(await toRead()).toContain(a);
    await t.as(MARSEL, `select public.article_acknowledge($1)`, [a]);
    expect(await toRead()).not.toContain(a);

    await t.as(FM, `select public.article_save_draft($1, 'Правила точки', null, 'Открываемся в 9:30, закрываемся в 22:00. Без опозданий.', null)`, [a]);
    await t.expectError(VIKTOR, `select public.article_publish($1, true, null)`, 'forbidden', [a]);
    await t.as(FM, `select public.article_publish($1, true, 'Изменилось время открытия')`, [a]);
    expect(await toRead()).toContain(a);
    const status = await one<{ full_name: string; acknowledged_at: string | null }[]>(FM, `select public.kb_ack_status($1) j`, [a]);
    expect(status.every((s) => s.acknowledged_at === null)).toBe(true);
    // менеджер в списке ознакомления не участвует
    expect(status.map((s) => s.full_name)).not.toContain('Менеджер Демо');
  });

  it('поиск находит статью по синониму и не показывает архив франчайзи', async () => {
    const hits = await t.as<{ title: string }>(VIKTOR, `select title from public.kb_search('пузыри', false, 5)`);
    expect(hits.map((h) => h.title)).toContain('Стандарт оклейки смартфона');
    const a = (await t.admin<{ id: string }>(`select id from public.article where slug = 'standart-okleyki'`))[0].id;
    await t.as(FM, `select public.article_archive($1, true)`, [a]);
    expect((await t.as<{ title: string }>(VIKTOR, `select title from public.kb_search('пузыри', false, 5)`)).map((h) => h.title)).not.toContain('Стандарт оклейки смартфона');
    await t.as(FM, `select public.article_archive($1, false)`, [a]);
  });
});
