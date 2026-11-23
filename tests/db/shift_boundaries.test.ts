import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const SUBMIT = 'select shift_submit($1,$2,$3,$4,$5,null) result';
const EDIT = 'select shift_close_versioned($1,$2,$3,$4,$5,null) result';
type Shift = { id: string; day: string; revision: number; earned_minor: number; pay_policy: unknown; closed_at: string };
type Receipt = { shift: Shift; month_shifts: number; month_earned_minor: number };
let db: TestDb, partner: string, point: string, west: string, user: string, email: string;

// PGlite's PostgreSQL clock reads Date.now. Move the instant, so the real
// local_today, clock_timestamp, monthly cutoff and snapshot triggers all run.
function at(iso: string) { vi.spyOn(Date, 'now').mockReturnValue(Date.parse(iso)); }
beforeAll(async () => {
  db = await createTestDb();
  partner = (await db.admin<{ id: string }>("select id from partner where code='ALPHA'"))[0].id;
}, 180_000);
afterAll(async () => db?.db.close());
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  at('2027-01-31T09:59:50Z');
  const [eastPoint, westPoint] = await db.admin<{ id: string }>(`
    insert into location(code, name, partner_id, city, timezone, currency, opened_on)
    values (gen_random_uuid()::text,'Восток',$1,'QA','Pacific/Kiritimati','RUB','2027-01-01'),
           (gen_random_uuid()::text,'Запад',$1,'QA','Pacific/Pago_Pago','RUB','2027-01-01') returning id
  `, [partner]);
  point = eastPoint.id; west = westPoint.id;
  const login = 'dates.' + crypto.randomUUID().slice(0, 8);
  user = (await db.as<{ id: string }>(OWNER,
    "select staff_account_create($1,'Проверка дат',$2,'test-only-password',array[$3::uuid,$4::uuid],false) id",
    [partner, login, point, west]))[0].id;
  email = login + '@access.bron.local';
});

async function call(sql: string, args: unknown[]) {
  return (await db.as<{ result: Receipt }>(email, sql, args))[0].result;
}
function submission(day: string, cash: number, card: number) { return [point, day, cash, card, crypto.randomUUID()]; }

it('uses the point day at midnight, posts yesterday into January, accepts a late sale as one revised total and stops edits at exactly five minutes', async () => {
  const params = submission('2027-01-31', 10000, 20000);
  at('2027-01-31T10:00:20Z'); // 1 February 00:00:20 at the east point; 30 January 23:00:20 at the west point.
  const [home] = await db.as<{ data: { locations: { location_id: string; today: string }[] } }>(email, 'select staff_home() data');
  expect(home.data.locations).toEqual(expect.arrayContaining([
    expect.objectContaining({ location_id: point, today: '2027-02-01' }), expect.objectContaining({ location_id: west, today: '2027-01-30' }),
  ]));
  const receipt = await call(SUBMIT, params);
  expect(receipt).toMatchObject({ shift: { day: '2027-01-31' }, month_shifts: 1 });
  expect((await db.as<{ data: { month_shifts: number } }>(email, 'select staff_home() data'))[0].data.month_shifts).toBe(0);
  at('2027-01-31T10:05:19Z');
  await db.expectError(email, SUBMIT, 'version-conflict', submission('2027-01-31', 10000, 30000));
  const edit = [receipt.shift.id, 10000, 30000, receipt.shift.revision, crypto.randomUUID()];
  const changed = await call(EDIT, edit);
  expect(changed.shift).toMatchObject({ revision: 2, closed_at: receipt.shift.closed_at });
  at('2027-01-31T10:05:20Z');
  await db.expectError(email, EDIT, 'period-locked', [receipt.shift.id, 10000, 45000, 2, crypto.randomUUID()]);
  at('2027-02-06T10:00:01Z');
  expect(await call(SUBMIT, params)).toEqual(receipt);
  expect(await call(EDIT, edit)).toEqual(changed);
  expect(await db.admin('select total_minor from daily_revenue where employee_id=$1', [user])).toEqual([{ total_minor: 40000 }]);
});

it('closes January for a franchisee at the start of the local sixth while retaining old receipts', async () => {
  const receipt = await call(SUBMIT, submission('2027-01-31', 20000, 0));
  at('2027-02-05T09:59:59Z'); // still the 5th at the east point
  const correction = 'select staff_shift_correct($1,$2,0,$3,$4,$5) result';
  const params = [receipt.shift.id, 30000, 1, 'Касса сверена', crypto.randomUUID()];
  const saved = await db.as(OWNER, correction, params);
  at('2027-02-05T10:00:00Z');
  await db.expectError(OWNER, correction, 'period-locked', [receipt.shift.id, 40000, 2, 'Ещё одна покупка', crypto.randomUUID()]);
  expect(await db.as(OWNER, correction, params)).toEqual(saved);
  expect(await db.admin('select total_minor from work_shift where id=$1', [receipt.shift.id])).toEqual([{ total_minor: 30000 }]);
});

it('prevents an old unversioned tab from overwriting a supervisor correction while preserving old first close and versioned employee edits', async () => {
  const [opened] = await db.as<{ id: string }>(email, 'select (shift_open($1)).id', [point]);
  await expect(db.as(email, 'select app_private.employee_shift_close($1,20000,0,null,0)', [opened.id]))
    .rejects.toThrow(/permission denied/);
  const legacy = 'select shift_close($1,$2,0,null) result';
  const first = await call(legacy, [opened.id, 20000]);
  await db.as(OWNER, "select staff_shift_correct($1,30000,0,$2,'Сверили кассу',$3)", [opened.id, first.shift.revision, crypto.randomUUID()]);
  await db.expectError(email, legacy, 'version-conflict', [opened.id, 10000]);
  await db.expectError(email, EDIT, 'version-conflict', [opened.id, 10000, 0, first.shift.revision, crypto.randomUUID()]);
  const current = await call(EDIT, [opened.id, 35000, 0, 2, crypto.randomUUID()]);
  expect(current.shift.revision).toBe(3);
  expect(await db.admin('select total_minor from daily_revenue where employee_id=$1', [user])).toEqual([{ total_minor: 35000 }]);
});

it('applies internship terms to the reported day on a delayed first submission; zero is recorded and a negative payment never changes it', async () => {
  await db.admin(`update staff_member set employee_kind='trainee',internship_from='2027-01-01',internship_until='2027-01-31',
    internship_floor_minor=50000,use_partner_motivation=false,rate_bp=0,shift_fee_minor=80000 where user_id=$1`, [user]);
  at('2027-01-31T10:01:00Z');
  const last = await call(SUBMIT, submission('2027-01-31', 0, 0));
  const next = await call(SUBMIT, submission('2027-02-01', 0, 0));
  expect(last.shift.earned_minor).toBe(50000);
  expect(next.shift.earned_minor).toBe(80000);
  await db.expectError(email, EDIT, 'validation', [last.shift.id, -1000, 2000, 1, crypto.randomUUID()]);
  await db.admin('update staff_member set internship_floor_minor=30000,shift_fee_minor=45000 where user_id=$1', [user]);
  const edit = await call(EDIT, [last.shift.id, 1000, 0, 1, crypto.randomUUID()]);
  expect(edit.shift).toMatchObject({ pay_policy: last.shift.pay_policy, earned_minor: 50000 });
});

it('rejects a first offline submission after point closure or a later opening date, preserves a posted receipt and finishes a real old open', async () => {
  const savedArgs = submission('2027-01-30', 10000, 0);
  const saved = await call(SUBMIT, savedArgs);
  await db.admin("update location set status='closed' where id=$1", [point]);
  expect(await call(SUBMIT, savedArgs)).toEqual(saved);
  await db.expectError(email, SUBMIT, 'validation', submission('2027-01-31', 4000, 0));
  await db.admin("update location set status='active',opened_on='2027-02-01' where id=$1", [point]);
  await db.expectError(email, SUBMIT, 'validation', submission('2027-01-31', 4000, 0));
  const [old] = await db.as<{ id: string }>(email, 'select (shift_open($1)).id', [west]);
  await db.admin("update location set status='closed' where id=$1", [west]);
  const checked = 'select shift_close_checked($1,9000,0,null,$2,null) result';
  const params = [old.id, crypto.randomUUID()];
  const completed = await call(checked, params);
  expect(completed.shift.id).toBe(old.id);
  expect(await call(checked, params)).toEqual(completed);
  await db.expectError(email, checked, 'version-conflict', [old.id, crypto.randomUUID()]);
});
