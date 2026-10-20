// Сотрудники и смены, рейтинг, план на месяц, роялти франчайзи, вопросы в базу знаний.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM = 'fm@demo.example.com';
const VIKTOR = 'alpha.owner@demo.example.com';
const MARSEL = 'beta.owner@demo.example.com';
const DINA = '79000000011@staff.bron.local';

let t: TestDb;
const id = async (table: string, code: string) => (await t.admin<{ id: string }>(`select id from public.${table} where code = $1`, [code]))[0].id;
const one = async <T>(email: string, sql: string, params: unknown[] = []) => (await t.as<{ j: T }>(email, sql, params))[0].j;

beforeAll(async () => {
  t = await createTestDb();
}, 180_000);

describe('сотрудники: франчайзи управляет сам', () => {
  let petr: string;
  const PETR = '79001112233@staff.bron.local';

  it('франчайзи создаёт сотрудника: вход по телефону, пароль хранится только хешем', async () => {
    petr = await one<string>(VIKTOR, `select public.staff_create($1, 'Пётр', '8 (900) 111-22-33', 'secret1', array[$2::uuid], 1000, 50000) j`,
      [await id('partner', 'ALPHA'), await id('location', 'ALPHA-3')]);
    const u = await t.admin<{ email: string; ok: boolean; plain: boolean }>(
      `select email, encrypted_password = extensions.crypt('secret1', encrypted_password) ok, encrypted_password = 'secret1' plain from auth.users where id = $1`, [petr]);
    expect(u).toEqual([{ email: PETR, ok: true, plain: false }]);
    expect((await one<{ assignments: { role: string }[] }>(PETR, `select public.me() j`)).assignments.map((a) => a.role)).toEqual(['franchisee_staff']);
  });

  it('тот же телефон второй раз нельзя; чужой франчайзи и сотрудник не управляют сотрудниками', async () => {
    await t.expectError(VIKTOR, `select public.staff_create($1, 'Пётр 2', '+79001112233', 'secret1', array[$2::uuid], 0, 0)`, 'validation',
      [await id('partner', 'ALPHA'), await id('location', 'ALPHA-3')]);
    await t.expectError(MARSEL, `select public.staff_update($1, 'Взлом', array[]::uuid[], 0, 0)`, 'not-found', [petr]);
    await t.expectError(MARSEL, `select public.user_set_password($1, 'hacked1')`, 'forbidden', [petr]);
    await t.expectError(DINA, `select public.staff_list($1, current_date)`, 'forbidden', [await id('partner', 'ALPHA')]);
    await t.expectError(VIKTOR, `select public.staff_create($1, 'Чужой', '+79005556677', 'secret1', array[$2::uuid], 0, 0)`, 'validation',
      [await id('partner', 'ALPHA'), await id('location', 'BETA-1')]);
  });

  it('смена: открыть → закрыть с выручкой → сразу видно заработок (за выход + %)', async () => {
    const shift = (await t.as<{ id: string }>(PETR, `select (public.shift_open($1)).id`, [await id('location', 'ALPHA-3')]))[0].id;
    const r = await one<{ shift: { earned_minor: string; total_minor: string }; month_earned_minor: string }>(PETR,
      `select public.shift_close($1, 400000, 600000, null) j`, [shift]);
    expect(Number(r.shift.total_minor)).toBe(1000000);
    expect(Number(r.shift.earned_minor)).toBe(50000 + 100000); // 500 ₽ за выход + 10 % от 10 000 ₽
    expect(Number(r.month_earned_minor)).toBeGreaterThanOrEqual(150000);
    // выручка смены попала в выручку точки за день
    const day = (await one<{ days: { entries: { employee_id: string; total_minor: number }[] }[] }>(VIKTOR,
      `select public.revenue_month($1, current_date) j`, [await id('location', 'ALPHA-3')])).days[0];
    expect(day.entries.find((e) => e.employee_id === petr)?.total_minor).toBe(1000000);
    // сегодняшнюю смену сотрудник может поправить, новая смена на ту же точку в тот же день — нет
    await one(PETR, `select public.shift_close($1, 500000, 600000, null) j`, [shift]);
    await t.expectError(PETR, `select public.shift_open($1)`, 'validation', [await id('location', 'ALPHA-3')]);
  });

  it('франчайзи исправляет смену сотрудника — заработок пересчитывается по ставке смены', async () => {
    const l = await id('location', 'ALPHA-3');
    const d = (await t.admin<{ d: string }>(`select to_char(app_private.local_today($1), 'YYYY-MM-DD') d`, [l]))[0].d;
    await t.as(VIKTOR, `select public.revenue_save($1, $2::date, 0, 2000000, 'исправил', $3)`, [l, d, petr]);
    const w = await t.admin<{ earned_minor: string }>(`select earned_minor from public.work_shift where employee_id = $1 and day = $2::date`, [petr, d]);
    expect(Number(w[0].earned_minor)).toBe(50000 + 200000);
  });

  it('сотрудник не видит выручку точки, роялти и рейтинг; точки не из своего списка не открывает', async () => {
    expect(await t.as(DINA, `select 1 from public.daily_revenue`)).toHaveLength(0);
    await t.expectError(DINA, `select public.revenue_month($1, current_date)`, 'forbidden', [await id('location', 'ALPHA-1')]);
    await t.expectError(DINA, `select public.royalty_my()`, 'forbidden');
    await t.expectError(DINA, `select public.rating()`, 'forbidden');
    await t.expectError(DINA, `select public.shift_open($1)`, 'not-found', [await id('location', 'ALPHA-3')]);
  });

  it('удалённый сотрудник сразу теряет доступ; франчайзи может вернуть его и сменить пароль', async () => {
    await t.as(VIKTOR, `select public.staff_set_active($1, false)`, [petr]);
    await t.expectError(PETR, `select public.staff_home()`, 'forbidden');
    expect((await t.admin<{ b: boolean }>(`select banned_until > now() b from auth.users where id = $1`, [petr]))[0].b).toBe(true);
    await t.as(VIKTOR, `select public.staff_set_active($1, true)`, [petr]);
    await t.as(VIKTOR, `select public.user_set_password($1, 'newpass9')`, [petr]);
    expect((await t.admin<{ ok: boolean }>(`select encrypted_password = extensions.crypt('newpass9', encrypted_password) ok from auth.users where id = $1`, [petr]))[0].ok).toBe(true);
    expect((await one<{ month_shifts: number }>(PETR, `select public.staff_home() j`)).month_shifts).toBeGreaterThanOrEqual(1);
  });

  it('менеджер сразу создаёт учётную запись франчайзи; франчайзи менеджеру пароль не меняет', async () => {
    const u = await one<string>(FM, `select public.account_create($1, 'Новый Партнёр', 'New@Example.com', 'pass123') j`, [await id('partner', 'GAMMA')]);
    expect((await one<{ assignments: { role: string }[] }>('new@example.com', `select public.me() j`)).assignments[0].role).toBe('franchisee');
    await t.expectError(VIKTOR, `select public.account_create($1, 'X', 'x@example.com', 'pass123')`, 'forbidden', [await id('partner', 'ALPHA')]);
    await t.expectError(VIKTOR, `select public.user_set_password($1, 'pass123')`, 'forbidden', [await t.userId(FM)]);
    await t.as(FM, `select public.user_set_password($1, 'pass456')`, [u]);
  });
});

describe('рейтинг', () => {
  it('только франчайзи в России, по прогнозу выполнения; выручка открыта всем участникам', async () => {
    // второй российский франчайзи, чтобы было с кем сравнивать
    await t.admin(`insert into public.partner(code, name, country, currency) values ('RU2', 'Пётр (Самара)', 'RU', 'RUB')`);
    await t.admin(`insert into public.location(code, name, partner_id, city, timezone, currency, opened_on)
      select 'RU2-1', 'Самара', id, 'Самара', 'Europe/Samara', 'RUB', date_trunc('month', current_date)::date - 60 from public.partner where code = 'RU2'`);
    await t.admin(`insert into public.daily_revenue(location_id, partner_id, day, currency, cash_minor)
      select l.id, l.partner_id, d::date, 'RUB', 1500000 from public.location l,
        generate_series(date_trunc('month', current_date)::date, current_date - 1, interval '1 day') d where l.code = 'RU2-1'`);
    const r = await one<{ rows: Record<string, unknown>[] }>(VIKTOR, `select public.rating() j`);
    expect(r.rows.map((x) => x.partner_name).sort()).toEqual(['Виктор (Волгоград)', 'Пётр (Самара)']);
    expect(r.rows.every((x) => x.currency === 'RUB')).toBe(true);
    const pcts = r.rows.map((x) => x.forecast_pct as number | null).filter((x) => x !== null) as number[];
    expect([...pcts].sort((a, b) => b - a)).toEqual(pcts);
    expect(r.rows.filter((x) => x.is_me).map((x) => x.partner_name)).toEqual(['Виктор (Волгоград)']);
    if (new Date().getDate() > 1) expect(Number(r.rows.find((x) => x.partner_name === 'Пётр (Самара)')!.fact_minor)).toBeGreaterThan(0);
    // менеджер видит тот же рейтинг
    expect((await one<{ rows: unknown[] }>(FM, `select public.rating() j`)).rows).toHaveLength(2);
  });

  it('иностранный франчайзи рейтинг не видит: команда закрыта, пункта меню нет', async () => {
    await t.expectError(MARSEL, `select public.rating()`, 'forbidden');
    const me = await one<{ assignments: { permissions: string[] }[] }>(MARSEL, `select public.me() j`);
    expect(me.assignments[0].permissions).not.toContain('rating.read');
    const vik = await one<{ assignments: { permissions: string[] }[] }>(VIKTOR, `select public.me() j`);
    expect(vik.assignments[0].permissions).toContain('rating.read');
  });
});

describe('план на месяц', () => {
  it('прогноз повторяет недельный профиль и уровень точки; франчайзи план не предлагает', async () => {
    // Синтетическая точка: будни 10 000, выходные 20 000 — 12 недель без тренда
    const p = await id('partner', 'BETA');
    const l = (await t.admin<{ id: string }>(`insert into public.location(code, name, partner_id, city, timezone, currency, opened_on)
      values ('TEST-1', 'Тест', $1, 'Тест', 'Europe/Moscow', 'KZT', current_date - 120) returning id`, [p]))[0].id;
    await t.admin(`insert into public.daily_revenue(location_id, partner_id, day, currency, cash_minor)
      select $1, $2, d::date, 'KZT', case when extract(isodow from d) in (6, 7) then 2000000 else 1000000 end
      from generate_series(current_date - 100, current_date - 1, interval '1 day') d`, [l, p]);
    const next = (await t.admin<{ m: string }>(`select to_char(date_trunc('month', current_date) + interval '1 month', 'YYYY-MM-DD') m`))[0].m;
    const rows = await one<{ location_id: string; forecast_minor: number; proposed_minor: number; weekend_days: number; days: number; trend_month_pct: number }[]>(
      FM, `select public.plan_suggest($1::date, 500) j`, [next]);
    const x = rows.find((r) => r.location_id === l)!;
    const expected = (x.days - x.weekend_days) * 1000000 + x.weekend_days * 2000000;
    expect(Math.abs(x.forecast_minor - expected) / expected).toBeLessThan(0.02);
    expect(x.trend_month_pct).toBeCloseTo(0, 0);
    expect(Math.abs(x.proposed_minor - expected * 1.05) / expected).toBeLessThan(0.03);
    await t.expectError(VIKTOR, `select public.plan_suggest($1::date, 500)`, 'forbidden', [next]);
    await t.admin(`delete from public.daily_revenue where location_id = $1`, [l]);
    await t.admin(`delete from public.location where id = $1`, [l]);
  });
});

describe('роялти франчайзи — в реальном времени', () => {
  it('франчайзи видит свой долг, оплаты и начисление текущего месяца: 7 % выручки на сейчас', async () => {
    const r = await one<{ partner_name: string; debt_minor: number; live: { revenue_minor: number; accrued_minor: number }; months: unknown[] }>(
      MARSEL, `select public.royalty_my() j`);
    expect(r.partner_name).toBe('Марсель (Караганда)');
    expect(Math.abs(r.live.accrued_minor - Math.round(r.live.revenue_minor * 0.07))).toBeLessThanOrEqual(1);
    const fm = await one<{ rows: { partner_name: string; debt_minor: number }[] }>(FM, `select public.royalty_summary(null) j`);
    expect(r.debt_minor).toBe(fm.rows.find((x) => x.partner_name === r.partner_name)!.debt_minor);
  });
});

describe('вопросы в базу знаний', () => {
  it('франчайзи спрашивает → менеджер отвечает → франчайзи видит новый ответ', async () => {
    const q = await one<string>(VIKTOR, `select public.kb_ask('Какой нож ставить на плоттер?', null) j`);
    expect((await one<{ unanswered: number }>(FM, `select public.kb_inbox() j`)).unanswered).toBeGreaterThanOrEqual(1);
    await t.expectError(VIKTOR, `select public.kb_answer($1, 'сам себе', null)`, 'forbidden', [q]);
    await t.as(FM, `select public.kb_answer($1, 'Нож 45°, менять раз в месяц', null)`, [q]);
    expect((await one<{ new_answers: number }>(VIKTOR, `select public.kb_inbox() j`)).new_answers).toBeGreaterThanOrEqual(1);
    const mine = await one<{ id: string; answer: string }[]>(VIKTOR, `select public.kb_questions() j`);
    expect(mine.find((x) => x.id === q)?.answer).toMatch(/45°/);
    expect(await one<{ id: string }[]>(MARSEL, `select public.kb_questions() j`).then((x) => x.some((y) => y.id === q))).toBe(false);
    expect((await one<{ new_answers: number }>(VIKTOR, `select public.kb_inbox() j`)).new_answers).toBe(0);
  });

  it('поиск без результата попадает в список «искали и не нашли»', async () => {
    await t.as(MARSEL, `select * from public.kb_search('сертификат соответствия плёнки', false, 5)`);
    const misses = await one<{ query: string }[]>(FM, `select public.kb_search_misses() j`);
    expect(misses.map((m) => m.query)).toContain('сертификат соответствия плёнки');
  });
});
