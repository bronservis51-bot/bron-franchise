// Ежедневная выручка и процент сотрудника: кто вносит, кто дозаполняет, расчёт заработка, закрытие месяца отчётом.
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
let alpha1: string, north: string, gamma: string, today: string;
const OWNER = 'alpha.owner@demo.example.com';
const STAFF = 'alpha.staff@demo.example.com';
const save = `select * from public.sale_save($1, $2::date, $3, $4, $5, $6, $7, $8)`;

beforeAll(async () => {
  t = await createTestDb();
  const q = async (code: string) => (await t.admin<{ id: string }>(`select id from public.location where code = $1`, [code]))[0].id;
  [alpha1, north, gamma] = [await q('ALPHA-1'), await q('OWN-NORTH'), await q('GAMMA-1')];
  today = (await t.admin<{ d: string }>(`select ((now() at time zone timezone)::date)::text as d from public.location where id = $1`, [alpha1]))[0].d;
}, 180_000);

const shift = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('ежедневная выручка', () => {
  it('сотрудник вносит свою смену и видит заработок по своей ставке', async () => {
    const [s] = await t.as<{ source: string; revenue_minor: string }>(STAFF, save, [alpha1, today, null, 2000000, 100000, 9, 'Смена', null]);
    expect(s.source).toBe('self');
    const [e] = await t.as<{ v: { days: { day: string; earnings_minor: number; rate_bp: number }[]; locations: { rate_bp: number }[] } }>(
      STAFF, `select public.my_earnings($1::date) as v`, [today]);
    const day = e.v.days.find((d) => d.day === today)!;
    expect(day.rate_bp).toBe(2500); // франчайзи поднял Дине процент до 25 % (демо-данные)
    expect(Number(day.earnings_minor)).toBe(475000); // 25% от (20 000 − 1 000) ₽
    expect(e.v.locations.find((l) => l.rate_bp === 2500)).toBeTruthy();
  });

  it('базовый процент менеджера продаж — 20%', async () => {
    await t.as('staff.north@demo.example.com', save, [north, today, null, 1000000, 0, 5, null, null]);
    const [e] = await t.as<{ v: { days: { earnings_minor: number; day: string }[] } }>('staff.north@demo.example.com', `select public.my_earnings($1::date) as v`, [today]);
    expect(Number(e.v.days.find((d) => d.day === today)!.earnings_minor)).toBe(200000);
  });

  it('сотрудник не вносит за других, за будущее и за давние дни; владелец дозаполняет', async () => {
    const staffId = await t.userId(STAFF);
    const ownerId = await t.userId(OWNER);
    await t.expectError(STAFF, save, 'forbidden', [alpha1, today, ownerId, 1000, 0, 1, null, null]);
    await t.expectError(STAFF, save, 'validation', [alpha1, shift(1), null, 1000, 0, 1, null, null]);
    await t.expectError(STAFF, save, 'validation', [alpha1, shift(-5), null, 1000, 0, 1, null, null]);
    await t.expectError(STAFF, save, 'validation', [alpha1, today, null, 1000, 2000, 1, null, null]);
    // Франчайзи сам работает на точке и дозаполняет пропущенный день сотрудника
    await t.admin(`delete from public.daily_sale_event where sale_id in (select id from public.daily_sale where location_id = $1 and employee_id = $2 and day = $3::date)`, [alpha1, staffId, shift(-5)]);
    await t.admin(`delete from public.daily_sale where location_id = $1 and employee_id = $2 and day = $3::date`, [alpha1, staffId, shift(-5)]);
    const [m] = await t.as<{ source: string; entered_by: string }>(OWNER, save, [alpha1, shift(-5), staffId, 1500000, 0, 7, 'Забыл внести', null]);
    expect(m.source).toBe('manager');
    expect(m.entered_by).toBe(ownerId);
    const [own] = await t.as<{ employee_id: string }>(OWNER, save, [alpha1, today, null, 500000, 0, 2, null, null]);
    expect(own.employee_id).toBe(ownerId);
  });

  it('чужая точка не видна; финансы и менеджер франшизы только читают', async () => {
    await t.expectError(OWNER, save, 'not-found', [gamma, today, null, 1000, 0, 1, null, null]);
    await t.expectError(OWNER, `select public.sales_month($1, $2::date)`, 'not-found', [gamma, today]);
    const [r] = await t.as<{ v: { can_manage: boolean; entries: unknown[] } }>('fm@demo.example.com', `select public.sales_month($1, $2::date) as v`, [alpha1, today]);
    expect(r.v.can_manage).toBe(false);
    expect(r.v.entries.length).toBeGreaterThan(0);
    await t.expectError('fm@demo.example.com', save, 'forbidden', [alpha1, today, null, 1000, 0, 1, null, null]);
    await t.expectError('staff.north@demo.example.com', `select public.sales_month($1, $2::date)`, 'forbidden', [north, today]);
  });

  it('отчёт точки за месяц: пропущенные дни и итоги', async () => {
    const [r] = await t.as<{ v: { can_manage: boolean; missing_days: string[]; totals: { revenue_minor: number }; employees: { id: string }[] } }>(
      OWNER, `select public.sales_month($1, $2::date) as v`, [alpha1, today]);
    expect(r.v.can_manage).toBe(true);
    expect(r.v.missing_days).not.toContain(today);
    expect(r.v.employees.map((e) => e.id)).toEqual(expect.arrayContaining([await t.userId(STAFF), await t.userId(OWNER)]));
    expect(Number(r.v.totals.revenue_minor)).toBeGreaterThan(0);
  });

  it('конфликт версий при одновременной правке', async () => {
    const [s] = await t.as<{ revision: number }>(STAFF, save, [alpha1, today, null, 2100000, 0, 9, null, null]);
    await t.expectError(STAFF, save, 'version-conflict', [alpha1, today, null, 2200000, 0, 9, null, s.revision - 1]);
  });

  it('данные для месячного отчёта и закрытие месяца после отправки', async () => {
    const [c] = await t.admin<{ id: string; partner_id: string }>(
      `select c.id, c.partner_id from public.contract c join public.contract_location cl on cl.contract_id = c.id where cl.location_id = $1 limit 1`, [alpha1]);
    const [f] = await t.as<{ v: { locations: { location_id: string; gross_minor: number; days_with_data: number }[] } }>(
      OWNER, `select public.sales_for_report($1, $2::date) as v`, [c.id, today]);
    const loc = f.v.locations.find((l) => l.location_id === alpha1)!;
    expect(Number(loc.gross_minor)).toBeGreaterThan(0);
    await t.expectError('gamma.owner@demo.example.com', `select public.sales_for_report($1, $2::date)`, 'not-found', [c.id, today]);
    await t.admin(`insert into public.revenue_report(number, contract_id, partner_id, period, status) values ('T-LOCK', $1, $2, date_trunc('month', $3::date)::date, 'submitted')
      on conflict (contract_id, period) do update set status = 'submitted'`, [c.id, c.partner_id, today]);
    await t.expectError(OWNER, save, 'transition-not-allowed', [alpha1, today, null, 1000, 0, 1, null, null]);
    const [m] = await t.as<{ v: { locked: boolean } }>(OWNER, `select public.sales_month($1, $2::date) as v`, [alpha1, today]);
    expect(m.v.locked).toBe(true);
    // Вернуть месяц открытым для следующих проверок
    await t.admin(`delete from public.report_sales_check where report_id in (select id from public.revenue_report where number = 'T-LOCK')`);
    await t.admin(`delete from public.revenue_report where number = 'T-LOCK'`);
  });

  it('«Сегодня»: заработок у продавца, пропуски у управляющего', async () => {
    const [s] = await t.as<{ v: { sales: { my: { days: unknown[] } | null } } }>(STAFF, `select public.today() as v`);
    expect(s.v.sales.my?.days.length).toBeGreaterThan(0);
    const [f] = await t.as<{ v: { sales: { my: unknown } } }>('finance1@demo.example.com', `select public.today() as v`);
    expect(f.v.sales.my).toBeNull();
  });
});

describe('смена, процент и прозрачность', () => {
  it('«Начать смену» → «Закрыть смену»: выручка с оплатой картой, повторно открыть нельзя', async () => {
    const STAFF_N = 'staff.north@demo.example.com';
    await t.admin(`delete from public.daily_sale_event where sale_id in (select id from public.daily_sale where location_id = $1 and day = $2::date and employee_id = (select id from public.app_user where email = $3))`, [north, today, STAFF_N]);
    await t.admin(`delete from public.daily_sale where location_id = $1 and day = $2::date and employee_id = (select id from public.app_user where email = $3)`, [north, today, STAFF_N]);
    const [w] = await t.as<{ id: string; status: string }>(STAFF_N, `select * from public.shift_open($1)`, [north]);
    expect(w.status).toBe('open');
    const [again] = await t.as<{ id: string }>(STAFF_N, `select * from public.shift_open($1)`, [north]);
    expect(again.id).toBe(w.id);
    const [e] = await t.as<{ v: { open_shift: { id: string } | null } }>(STAFF_N, `select public.my_earnings($1::date) as v`, [today]);
    expect(e.v.open_shift?.id).toBe(w.id);
    await t.expectError(STAFF_N, `select * from public.shift_close($1, 1000000, 2000000, 0, 5, null)`, 'validation', [w.id]);
    const [s] = await t.as<{ revenue_minor: string; card_minor: string; source: string }>(STAFF_N, `select * from public.shift_close($1, 1500000, 900000, 0, 7, 'Хорошая смена')`, [w.id]);
    expect(Number(s.card_minor)).toBe(900000);
    expect(s.source).toBe('self');
    await t.expectError(STAFF_N, `select * from public.shift_close($1, 1, 0, 0, 0, null)`, 'transition-not-allowed', [w.id]);
    await t.expectError(STAFF_N, `select * from public.shift_open($1)`, 'transition-not-allowed', [north]);
    const [m] = await t.as<{ v: { employees: { name: string; on_shift_since: string | null }[] } }>('manager.north@demo.example.com', `select public.sales_month($1, $2::date) as v`, [north, today]);
    expect(m.v.employees.length).toBeGreaterThan(0);
  });

  it('франчайзи задаёт процент менеджеру продаж; сотрудник получает уведомление; чужой не может', async () => {
    const staffId = await t.userId(STAFF);
    await t.expectError(STAFF, `select * from public.commission_set($1, $2, 3000, null, null)`, 'forbidden', [alpha1, staffId]);
    await t.expectError(OWNER, `select * from public.commission_set($1, $2, 12000, null, null)`, 'validation', [alpha1, staffId]);
    await t.expectError('gamma.owner@demo.example.com', `select * from public.commission_set($1, $2, 3000, null, null)`, 'not-found', [alpha1, staffId]);
    await t.as(OWNER, `select * from public.commission_set($1, $2, 3000, $3::date, 'Перевыполнила план')`, [alpha1, staffId, today]);
    const [e] = await t.as<{ v: { locations: { id: string; rate_bp: number }[] } }>(STAFF, `select public.my_earnings($1::date) as v`, [today]);
    expect(e.v.locations.find((l) => l.id === alpha1)!.rate_bp).toBe(3000);
    const n = await t.admin(`select 1 from public.notification where user_id = $1 and kind = 'sales.commission'`, [staffId]);
    expect(n.length).toBeGreaterThan(0);
    // Ставка для всей точки не перекрывает персональную
    await t.as(OWNER, `select * from public.commission_set($1, null, 1800, $2::date, null)`, [alpha1, today]);
    const [m] = await t.as<{ v: { employees: { id: string; rate_bp: number }[]; rate_bp: number } }>(OWNER, `select public.sales_month($1, $2::date) as v`, [alpha1, today]);
    expect(m.v.employees.find((x) => x.id === staffId)!.rate_bp).toBe(3000);
    expect(m.v.rate_bp).toBe(1800);
  });

  it('уменьшить смену, которую сотрудник внёс сам, можно только с причиной; сотрудник узнаёт об этом', async () => {
    const staffId = await t.userId(STAFF);
    const day = shift(-1);
    const [s] = await t.as<{ revision: number }>(STAFF, save, [alpha1, day, null, 2000000, 0, 9, null, null]);
    await t.expectError(OWNER, save, 'validation', [alpha1, day, staffId, 1000000, 0, 9, null, s.revision]);
    const [r] = await t.as<{ reduced_by_manager: boolean; source: string }>(OWNER, save, [alpha1, day, staffId, 1000000, 0, 9, 'Возврат клиенту, ошибка кассы', s.revision]);
    expect(r.reduced_by_manager).toBe(true);
    expect(r.source).toBe('self');
    const n = await t.admin(`select 1 from public.notification where user_id = $1 and kind = 'sales.reduced'`, [staffId]);
    expect(n.length).toBeGreaterThan(0);
  });

  it('отправленный отчёт меньше ежедневной выручки — сверка и сигнал финансам', async () => {
    const [c] = await t.admin<{ diff_minor: string; daily_gross_minor: string }>(
      `select c.* from public.report_sales_check c join public.partner p on p.id = c.partner_id where p.code = 'BETA' order by c.period desc limit 1`);
    expect(Number(c.diff_minor)).toBeLessThan(0);
    const f = await t.as<{ kind: string }>('finance1@demo.example.com', `select kind from public.notification where kind = 'sales.mismatch'`);
    expect(f.length).toBeGreaterThan(0);
    const mine = await t.as('beta.owner@demo.example.com', `select * from public.report_sales_check`);
    expect(mine.length).toBeGreaterThan(0);
    expect((await t.as(OWNER, `select * from public.report_sales_check c join public.partner p on p.id = c.partner_id where p.code = 'BETA'`)).length).toBe(0);
  });

  it('контроль выручки: Бета в зоне риска (мало услуг на купленную плёнку, отчёт меньше смен); франчайзи не видит', async () => {
    const [r] = await t.as<{ v: { locations: { location_name: string; risk: number; film_phones_60d: number; report_diff_minor: number }[] } }>(
      'fm@demo.example.com', `select public.sales_control($1::date) as v`, [today]);
    const beta = r.v.locations.find((l) => l.location_name.startsWith('Караганда'))!;
    expect(beta.film_phones_60d).toBeGreaterThan(0);
    expect(beta.risk).toBeGreaterThanOrEqual(3);
    expect(r.v.locations[0].risk).toBeGreaterThanOrEqual(beta.risk);
    await t.expectError(OWNER, `select public.sales_control($1::date)`, 'forbidden', [today]);
  });
});

describe('поставки: поступления, подписка, новинки', () => {
  it('снабженец планирует поступление, партнёр видит дату и получает уведомление о приходе', async () => {
    const SUPPLY = 'supply@demo.example.com';
    const [{ id: item }] = await t.admin<{ id: string }>(`select id from public.catalog_item where sku = 'SH-CM-02'`);
    await t.admin(`update public.stock_projection set available_qty = 0 where item_id = $1`, [item]);
    await t.as(OWNER, `select public.stock_subscribe($1, true)`, [item]);
    await t.expectError(OWNER, `select * from public.stock_incoming_plan($1, 10, current_date + 3, null)`, 'forbidden', [item]);
    const [inc] = await t.as<{ id: string }>(SUPPLY, `select * from public.stock_incoming_plan($1, 50, current_date + 3, 'Партия')`, [item]);
    const [c] = await t.as<{ incoming_on: string; subscribed: boolean; available_qty: string }>(OWNER, `select * from public.catalog_for_location($1) where item_id = $2`, [alpha1, item]);
    expect(c.incoming_on).toBeTruthy();
    expect(c.subscribed).toBe(true);
    await t.as(SUPPLY, `select * from public.stock_incoming_arrive($1, null)`, [inc.id]);
    const [c2] = await t.as<{ available_qty: string; arrived_at: string | null }>(OWNER, `select * from public.catalog_for_location($1) where item_id = $2`, [alpha1, item]);
    expect(Number(c2.available_qty)).toBe(50);
    expect(c2.arrived_at).toBeTruthy();
    const n = await t.as(OWNER, `select 1 from public.notification where kind = 'stock.arrived' and entity_id = $1`, [item]);
    expect(n.length).toBe(1);
    const [b] = await t.as<{ v: { sku: string; waiting: number }[] }>(SUPPLY, `select public.stock_board() as v`);
    expect(b.v.find((x) => x.sku === 'SH-CM-02')!.waiting).toBe(1);
  });

  it('новинка: отметка в магазине и уведомление всем, кто заказывает', async () => {
    const [{ id: item }] = await t.admin<{ id: string }>(`select id from public.catalog_item where sku = 'SH-NT-01'`);
    await t.as('supply@demo.example.com', `select public.catalog_item_announce($1, 'Восточный орнамент — уже на складе')`, [item]);
    const [c] = await t.as<{ is_new: boolean }>('beta.owner@demo.example.com', `select * from public.catalog_for_location((select id from public.location where code = 'BETA-1')) where item_id = $1`, [item]);
    expect(c.is_new).toBe(true);
    const n = await t.as('gamma.owner@demo.example.com', `select 1 from public.notification where kind = 'catalog.new' and entity_id = $1`, [item]);
    expect(n.length).toBe(1);
    const [today2] = await t.as<{ v: { supply: { new_items: unknown[] } } }>('beta.owner@demo.example.com', `select public.today() as v`);
    expect(today2.v.supply.new_items.length).toBeGreaterThan(0);
  });
});

describe('нерабочие дни', () => {
  it('франчайзи отмечает «точка не работала» с причиной — день не считается пропуском; выручка снимает отметку', async () => {
    const [m0] = await t.as<{ v: { missing_days: string[] } }>(OWNER, `select public.sales_month($1, $2::date) as v`, [alpha1, today]);
    const day = m0.v.missing_days.find((d) => d < today)!;
    expect(day).toBeTruthy();
    await t.expectError(OWNER, `select public.sales_day_off_set($1, $2::date, true, '')`, 'validation', [alpha1, day]);
    await t.expectError(STAFF, `select public.sales_day_off_set($1, $2::date, true, 'выходной')`, 'forbidden', [alpha1, day]);
    await t.as(OWNER, `select public.sales_day_off_set($1, $2::date, true, 'Санитарный день ТЦ')`, [alpha1, day]);
    const [m1] = await t.as<{ v: { missing_days: string[]; days_off: { day: string }[] } }>(OWNER, `select public.sales_month($1, $2::date) as v`, [alpha1, today]);
    expect(m1.v.missing_days).not.toContain(day);
    expect(m1.v.days_off.map((x) => x.day)).toContain(day);
    await t.as(OWNER, save, [alpha1, day, null, 500000, 0, 2, null, null]);
    const left = await t.admin(`select 1 from public.sales_day_off where location_id = $1 and day = $2::date`, [alpha1, day]);
    expect(left.length).toBe(0);
  });

  it('«Сегодня» франчайзи: сводка по своим точкам; у компании и менеджера продаж — нет', async () => {
    const [o] = await t.as<{ v: { points: { id: string; missing: number }[] } }>(OWNER, `select public.today() as v`);
    expect(o.v.points.length).toBeGreaterThanOrEqual(2);
    const [f] = await t.as<{ v: { points: unknown[] } }>('founder@demo.example.com', `select public.today() as v`);
    expect(f.v.points).toEqual([]);
    const [s] = await t.as<{ v: { points: unknown[] } }>(STAFF, `select public.today() as v`);
    expect(s.v.points).toEqual([]);
  });
});

describe('рубли по курсу дня смены', () => {
  it('смена в тенге получает рублёвую сумму по курсу своего дня; курс потом не меняется', async () => {
    const [{ id: beta }] = await t.admin<{ id: string }>(`select id from public.location where code = 'BETA-1'`);
    const [s] = await t.as<{ id: string; fx_rate: string; rub_minor: string; revenue_minor: string }>('beta.owner@demo.example.com', save, [beta, today, null, 10_000_000, 0, 3, null, null]);
    const [r] = await t.admin<{ rate: string }>(`select rate from public.fx_rate where currency = 'KZT' and day = $1::date`, [today]);
    expect(Number(s.fx_rate)).toBeCloseTo(Number(r.rate), 6);
    expect(Number(s.rub_minor)).toBe(Math.round(10_000_000 * Number(r.rate)));
    await t.as('finance1@demo.example.com', `select public.fx_rate_set('KZT', $1::date, 9.99)`, [today]);
    const [again] = await t.admin<{ fx_rate: string }>(`select fx_rate from public.daily_sale where id = $1`, [s.id]);
    expect(Number(again.fx_rate)).toBeCloseTo(Number(r.rate), 6);
    await t.expectError('beta.owner@demo.example.com', `select public.fx_rate_set('KZT', current_date, 1)`, 'forbidden');
    const [n] = await t.as<{ v: { locations: { code: string; revenue_rub_minor: number; revenue_minor: number; currency: string }[] } }>('founder@demo.example.com', `select public.network_sales(current_date) as v`);
    const own = n.v.locations.find((l) => l.currency === 'RUB')!;
    expect(Number(own.revenue_rub_minor)).toBe(Number(own.revenue_minor));
    expect(Number(n.v.locations.find((l) => l.code === 'BETA-1')!.revenue_rub_minor)).toBeGreaterThan(0);
  });
});
