import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const SUBMIT = 'select public.shift_submit($1, $2, $3, $4, $5, $6) as receipt';
type Receipt = {
  shift: { id: string; employee_id: string; day: string; status: string; revision: number; earned_minor: number; pay_policy: unknown };
  month_earned_minor: number; month_shifts: number; currency: string;
};
let db: TestDb, partner: string, point: string, worker: string, email: string;
let days: { today: string; yesterday: string; earlier: string; future: string; locked: string };

beforeAll(async () => {
  db = await createTestDb();
  partner = (await db.admin<{ id: string }>("select id from public.partner where code = 'ALPHA'"))[0].id;
}, 180_000);
afterAll(async () => db?.db.close());

beforeEach(async () => {
  const code = crypto.randomUUID().slice(0, 8);
  email = `submit.${code}@access.bron.local`;
  point = (await db.admin<{ id: string }>(`
    insert into public.location(code, name, partner_id, city, timezone, currency)
    values ($1, 'Тест', $2, 'Тест', 'Pacific/Kiritimati', 'RUB') returning id
  `, [code, partner]))[0].id;
  worker = (await db.as<{ id: string }>(OWNER,
    "select staff_account_create($1, 'Проверка смены', $2, 'test-only-password', array[$3::uuid], false) id",
    [partner, `submit.${code}`, point]))[0].id;
  days = (await db.admin<typeof days>(`
    select d::text today, (d - 1)::text yesterday, (d - 2)::text earlier, (d + 1)::text future,
      (date_trunc('month', d) - interval '2 months')::date::text locked
    from (select (now() at time zone 'Pacific/Kiritimati')::date d) local
  `))[0];
});

function args(day = days.today, cash: number | null = 200_000, card = 100_000, operation = crypto.randomUUID()) {
  return [point, day, cash, card, operation, 'Касса сверена'];
}

async function submit(params: unknown[]) {
  return (await db.as<{ receipt: Receipt }>(email, SUBMIT, params))[0].receipt;
}

it('posts revenue and payroll together; exact replay returns the receipt and a second submission cannot edit it', async () => {
  const params = args();
  const receipt = await submit(params);
  expect(receipt).toMatchObject({
    shift: { employee_id: worker, day: days.today, status: 'closed', earned_minor: 100_000, revision: 1 },
    month_shifts: 1, month_earned_minor: 100_000, currency: 'RUB',
  });
  expect(await submit(params)).toEqual(receipt);
  await db.expectError(email, SUBMIT, 'idempotency-conflict', [...params.slice(0, 5), 'Другая сумма']);
  await db.expectError(email, SUBMIT, 'version-conflict', args(days.today, 1, 2));
  expect(await db.admin('select cash_minor, card_minor from daily_revenue where employee_id=$1', [worker]))
    .toEqual([{ cash_minor: 200_000, card_minor: 100_000 }]);
  expect(await db.admin('select action from audit_event where entity_id=$1', [receipt.shift.id])).toEqual([{ action: 'shift.close' }]);
  await db.expectError(email, 'select shift_open($1)', 'validation', [point]);
});

it('accepts yesterday in the point timezone, rejects future/older new days and rolls back an invalid close', async () => {
  for (const day of [days.earlier, days.future]) await db.expectError(email, SUBMIT, 'validation', args(day));
  await db.expectError(email, SUBMIT, 'validation', args(days.today, -1));
  await db.expectError(email, SUBMIT, 'validation', args(days.today, null));
  expect(await db.admin('select id from work_shift where employee_id=$1', [worker])).toEqual([]);
  expect(await db.admin('select id from daily_revenue where employee_id=$1', [worker])).toEqual([]);
  const receipt = await submit(args(days.yesterday, 0, 0));
  expect(receipt.shift).toMatchObject({ day: days.yesterday, earned_minor: 100_000 });
});

it('requires resolving an outstanding shift and retains the original historical pay snapshot on close', async () => {
  const [old] = await db.admin<{ id: string; pay_policy: unknown }>(`
    insert into work_shift(partner_id, location_id, employee_id, day) values ($1,$2,$3,$4)
    returning id, pay_policy
  `, [partner, point, worker, days.earlier]);
  await db.admin('update staff_member set use_partner_motivation=false, shift_fee_minor=70000 where user_id=$1', [worker]);
  await db.expectError(email, SUBMIT, 'version-conflict', args());
  const receipt = await submit(args(days.earlier, 0, 0));
  expect(receipt.shift).toMatchObject({ id: old.id, day: days.earlier, status: 'closed', pay_policy: old.pay_policy, earned_minor: 100_000 });
  expect((await submit(args(days.today, 0, 0))).shift.earned_minor).toBe(70000);
});

it('preserves financial period and day-off rules for the employee and franchisee', async () => {
  await db.as(OWNER, 'select revenue_day_off_set($1,$2,true)', [point, days.today]);
  await db.expectError(email, SUBMIT, 'validation', args());
  expect(await db.admin('select id from work_shift where employee_id=$1', [worker])).toEqual([]);
  await db.as(OWNER, 'select revenue_day_off_set($1,$2,false)', [point, days.today]);
  await submit(args());
  await db.expectError(OWNER, 'select revenue_day_off_set($1,$2,true)', 'validation', [point, days.today]);
  await db.admin('insert into work_shift(partner_id,location_id,employee_id,day) values ($1,$2,$3,$4)', [partner, point, worker, days.locked]);
  await db.expectError(email, SUBMIT, 'period-locked', args(days.locked));
  expect(await db.admin("select day::text from work_shift where employee_id=$1 and status='open'", [worker])).toEqual([{ day: days.locked }]);
});

it('requires an active worker and an assigned active point for a new shift', async () => {
  const foreign = (await db.admin<{ id: string }>("select id from location where partner_id<>$1 limit 1", [partner]))[0].id;
  await db.expectError(email, SUBMIT, 'not-found', [foreign, ...args().slice(1)]);
  await db.expectError(OWNER, SUBMIT, 'forbidden', args());
  await expect(db.as(null, SUBMIT, args())).rejects.toThrow(/permission denied/);
  await db.admin("update location set status='closed' where id=$1", [point]);
  await db.expectError(email, SUBMIT, 'validation', args());
});

it('keeps the checked close receipt for old clients and rejects a stale checked close after current submission', async () => {
  const checked = 'select public.shift_close_checked($1,$2,$3,$4,$5,$6) receipt';
  const old = (await db.as<{ id: string }>(email, 'select (shift_open($1)).id', [point]))[0];
  const params = [old.id, 250_000, 0, null, crypto.randomUUID(), null];
  const receipt = (await db.as<{ receipt: Receipt }>(email, checked, params))[0].receipt;
  expect(receipt.shift).toMatchObject({ id: old.id, status: 'closed', revision: 1 });
  expect((await db.as<{ receipt: Receipt }>(email, checked, params))[0].receipt).toEqual(receipt);
  await db.expectError(email, SUBMIT, 'version-conflict', args());

  const yesterday = (await db.admin<{ id: string }>(
    'insert into work_shift(partner_id,location_id,employee_id,day) values($1,$2,$3,$4) returning id',
    [partner, point, worker, days.yesterday]))[0];
  await submit(args(days.yesterday));
  await db.expectError(email, checked, 'version-conflict', [yesterday.id, 900_000, 0, null, crypto.randomUUID(), null]);
});

it('shows the employee’s yesterday shift per point even when the requested history month excludes it', async () => {
  const receipt = await submit(args(days.yesterday));
  const [home] = await db.as<{ data: {
    locations: { location_id: string; my_today: unknown; my_yesterday: Receipt['shift'] }[]; shifts: unknown[];
  } }>(email, 'select public.staff_home($1) data', [days.locked]);
  expect(home.data.shifts).toEqual([]);
  expect(home.data.locations.find(location => location.location_id === point)).toMatchObject({
    my_today: null, my_yesterday: receipt.shift,
  });
});

it('returns the pay policy for each date shown at the assigned point', async () => {
  await db.admin(`update staff_member set employee_kind='trainee', internship_from=$2, internship_until=$2,
    internship_floor_minor=50000 where user_id=$1`, [worker, days.yesterday]);
  const [home] = await db.as<{ data: { locations: {
    location_id: string; pay_today: unknown; pay_yesterday: unknown;
  }[] } }>(email, 'select public.staff_home() data');
  expect(home.data.locations.find(location => location.location_id === point)).toMatchObject({
    pay_today: { floor_minor: 100000 }, pay_yesterday: { floor_minor: 50000 },
  });
  expect((await submit(args(days.yesterday, 0, 0))).shift.earned_minor).toBe(50000);
});
