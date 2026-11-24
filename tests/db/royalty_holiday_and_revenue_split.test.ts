import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const owner = 'alpha.owner@demo.example.com';
const other = 'beta.owner@demo.example.com';
const manager = 'fm@demo.example.com';
let db: TestDb;
let location: string;
let partner: string;
let day: string;

beforeAll(async () => {
  db = await createTestDb();
  [{ id: location, partner_id: partner, day }] = await db.admin<{ id: string; partner_id: string; day: string }>(
    "select id, partner_id, app_private.local_today(id)::text as day from public.location where partner_id = (select id from public.partner where code = 'ALPHA') order by name limit 1");
  await db.admin('delete from public.daily_revenue where location_id = $1 and day = $2', [location, day]);
}, 180_000);
afterAll(async () => db?.db.close());

it('stores a declared split without counting shift payments twice and preserves the total after correction', async () => {
  const employee = await db.userId('79000000011@staff.bron.local');
  await db.as(manager, 'select public.revenue_save($1,$2,30000,30000,null,$3)', [location, day, employee]);
  const currentVersion = async () => (await db.admin<{ version: string }>(
    'select app_private.revenue_day_version($1,$2) as version', [location, day]))[0].version;
  const version = await currentVersion();
  const save = (cash: number, card: number, expected: string, op: string, who = owner) =>
    db.as(who, 'select public.revenue_split_set($1,$2,$3,$4,$5,$6,null)', [location, day, cash, card, expected, op]);
  await expect(save(29000, 71000, version, crypto.randomUUID())).rejects.toThrow('validation');
  await expect(save(45000, 55000, version, crypto.randomUUID(), other)).rejects.toThrow('not-found');
  const operation = crypto.randomUUID();
  await save(45000, 55000, version, operation);
  await save(45000, 55000, version, operation);
  await expect(save(45000, 55000, version, crypto.randomUUID())).rejects.toThrow('version-conflict');

  const detail = async () => (await db.as<{ value: { days: Record<string, unknown>[] } }>(owner,
    'select public.revenue_month($1,$2) as value', [location, day]))[0].value.days.find(row => row.day === day);
  expect(await detail()).toMatchObject({
    cash_minor: 45000, card_minor: 55000, total_minor: 100000, unallocated_minor: 0,
    reported_cash_minor: 45000, reported_card_minor: 55000,
  });
  await db.as(manager, 'select public.revenue_save($1,$2,60000,30000,null,$3)', [location, day, employee]);
  expect(await detail()).toMatchObject({
    cash_minor: 60000, card_minor: 30000, total_minor: 100000, unallocated_minor: 10000,
    reported_cash_minor: 45000, reported_card_minor: 55000,
  });
  await db.as(manager, 'select public.revenue_save($1,$2,40000,40000,null,$3)', [location, day, employee]);
  expect(await detail()).toMatchObject({ cash_minor: 45000, card_minor: 55000, total_minor: 100000, unallocated_minor: 0 });
  await db.expectError(owner, 'select public.revenue_total_set($1,$2,100000,$3,gen_random_uuid(),null)', 'version-conflict', [location, day, await currentVersion()]);
});

it('waives two calendar months by day in the ledger, finance and workbook export', async () => {
  await db.admin("update public.partner set royalty_from = '2025-06-01', is_demo = false where id = $1", [partner]);
  await db.admin(`insert into public.daily_revenue(location_id,partner_id,day,currency,cash_minor,card_minor)
    select l.id,l.partner_id,d.day,l.currency,100000,0 from public.location l
    cross join (values (date '2025-07-10'),(date '2025-08-14'),(date '2025-08-15')) d(day) where l.id = $1`, [location]);
  await db.admin("insert into public.partner_profile(partner_id,started_on) values ($1,'2025-06-15') on conflict (partner_id) do update set started_on = excluded.started_on", [partner]);
  const ledger = () => db.admin(`select month::text, accrued_minor::int from app_private.royalty_ledger($1)
    where month between '2025-07-01' and '2025-08-01' order by month`, [partner]);
  expect(await ledger()).toEqual([{ month: '2025-07-01', accrued_minor: 7000 }, { month: '2025-08-01', accrued_minor: 14000 }]);
  const setOpening = 'select public.royalty_holiday_start_set($1,$2,$3)';
  await db.expectError(owner, setOpening, 'forbidden', [partner, '2025-06-15', null]);
  await db.as(manager, setOpening, [partner, '2025-06-15', null]);
  await db.expectError(manager, setOpening, 'version-conflict', [partner, '2025-06-16', null]);
  expect(await ledger()).toEqual([{ month: '2025-07-01', accrued_minor: 0 }, { month: '2025-08-01', accrued_minor: 7000 }]);
  const [july] = await db.as<{ value: { current: unknown } }>(owner, "select public.finance_my('2025-07-01',$1) as value", [location]);
  expect(july.value.current).toMatchObject({ royalty_minor: 0, waived_royalty_minor: 7000, royalty_holiday_until: '2025-08-15' });
  const [august] = await db.as<{ value: { current: unknown } }>(owner, "select public.finance_my('2025-08-01',$1) as value", [location]);
  expect(august.value.current).toMatchObject({ royalty_minor: 7000, waived_royalty_minor: 7000, royalty_holiday_until: '2025-08-15' });
  const report = await db.admin(`select month,amount from app_private.google_finance_rows('2025-07-01','2025-08-31')
    where kind = 'royalty' and partner_id = $1 order by month`, [partner]);
  expect(report.map(row => [row.month, Number(row.amount)])).toEqual([['2025-07-01', 0], ['2025-08-01', 7000]]);
});

it('keeps the confirmed holiday independent of later changes to point dates', async () => {
  await db.admin("update public.location set opened_on = '2026-04-05' where id = $1", [location]);
  const [result] = await db.as<{ value: { royalty_holiday_from: string } }>(
    manager, 'select public.royalty_partner($1) as value', [partner]);
  expect(result.value.royalty_holiday_from).toBe('2025-06-15');
});

it('replaces an imported amount when a legacy edit supplies a verified breakdown', async () => {
  const [{ prior }] = await db.admin<{ prior: string }>('select ($1::date - 1)::text as prior', [day]);
  await db.admin('delete from public.daily_revenue where location_id = $1 and day = $2', [location, prior]);
  await db.admin(`insert into public.daily_revenue(location_id,partner_id,day,currency,cash_minor,card_minor,unallocated_minor)
    select id,partner_id,$2,currency,0,0,100000 from public.location where id = $1`, [location, prior]);
  const [result] = await db.as<{ total: number }>(manager,
    'select (public.revenue_save($1,$2,40000,60000,null,null)).total_minor::int as total', [location, prior]);
  expect(result.total).toBe(100000);
});
