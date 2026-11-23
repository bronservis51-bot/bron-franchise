import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const OTHER_OWNER = 'beta.owner@demo.example.com';
const WORKER = 'return-test@access.bron.local';
const RPC = 'select public.shift_record_with_return($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
let t: TestDb;
let location: string;
let partner: string;
let day: string;
let month: string;

beforeAll(async () => {
  t = await createTestDb();
  const [point] = await t.admin<{ id: string; day: string; month: string; partner: string }>(`
    select id, app_private.local_today(id)::text as day,
      date_trunc('month', app_private.local_today(id))::date::text as month, partner_id as partner
    from location where code='ALPHA-1'
  `);
  ({ id: location, day, month, partner } = point);
  await t.as(OWNER, "select staff_account_create($1, 'Проверка возврата', 'return-test', 'test-only-password', array[$2::uuid], false)",
    [point.partner, location]);
}, 180_000);
afterAll(async () => t?.db.close());

interface Shift {
  id: string;
  revision: number;
  return_minor: number;
  earned_minor: number;
}

async function record(args: unknown[]) {
  return (await t.as<{ result: { shift: Shift } }>(WORKER, RPC, args))[0].result;
}

async function finance() {
  const [{ data }] = await t.as<{ data: { current: { revenue_minor: number; return_minor: number; royalty_minor: number; net_minor: number; payroll_minor: number; expenses_minor: number } } }>(
    OWNER, 'select public.finance_my($1,$2) data', [month, location]);
  return data.current;
}

it('records a return greater than sales together with the shift and counts it only in actual balance', async () => {
  const args = [200_000, 100_000, 400_000, crypto.randomUUID(), null, location, day, null, null, null];
  await t.expectError(WORKER, RPC, 'validation', args.with(2, -1));
  const receipt = await record(args);
  expect(receipt.shift).toMatchObject({ return_minor: 400_000, earned_minor: 100_000 });
  expect(await record(args)).toEqual(receipt);
  await t.expectError(WORKER, RPC, 'idempotency-conflict', args.with(2, 410_000));
  const statement = await finance();
  expect(statement.return_minor).toBe(400_000);
  expect(statement.net_minor).toBe(statement.revenue_minor - 400_000 - statement.payroll_minor - statement.royalty_minor - statement.expenses_minor);
  const [{ data }] = await t.as<{ data: { return_minor: number; days: { day: string; return_minor: number }[] } }>(
    OWNER, 'select public.revenue_month($1,$2) data', [location, month]);
  expect(data.return_minor).toBe(400_000);
  expect(data.days).toContainEqual(expect.objectContaining({ day, return_minor: 400_000 }));
  const [{ report }] = await t.as<{ report: { location_id: string; days: unknown[] }[] }>(
    OWNER, 'select public.team_revenue_month($1,$2) report', [partner, month]);
  expect(report.find(point => point.location_id === location)?.days)
    .toContainEqual(expect.objectContaining({ day, total_minor: 300_000, return_minor: 400_000 }));
  const change = [200_000, 100_000, 10_000, crypto.randomUUID(), null, null, null, receipt.shift.id, receipt.shift.revision, null];
  const edited = await record(change);
  expect(edited.shift).toMatchObject({ return_minor: 10_000, earned_minor: receipt.shift.earned_minor });
  expect(edited.shift.revision).toBeGreaterThan(receipt.shift.revision);
  const revised = await finance();
  expect(revised).toMatchObject({ return_minor: 10_000, net_minor: statement.net_minor + 390_000, royalty_minor: statement.royalty_minor });
  expect(await record(args)).toEqual(receipt);
  expect((await finance()).return_minor).toBe(10_000);
  await t.expectError(WORKER, RPC, 'version-conflict', change.with(3, crypto.randomUUID()));
  const supervisor = change.with(3, crypto.randomUUID()).with(8, edited.shift.revision).with(9, 'Касса сверена');
  await t.expectError(OTHER_OWNER, RPC, 'forbidden', supervisor);
  const [corrected] = await t.as<{ result: { shift: Shift } }>(OWNER, RPC, supervisor.with(2, 0));
  expect(corrected.result.shift).toMatchObject({ return_minor: 0, earned_minor: edited.shift.earned_minor });
});

it('keeps the new write restricted to the shift owner and never announces uncommitted returns', async () => {
  const args = [0, 0, 100, crypto.randomUUID(), null, location, day, null, null, null];
  await expect(t.as(null, RPC, args)).rejects.toThrow(/permission denied/);
  await t.expectError(OTHER_OWNER, RPC, 'forbidden', args);
  await t.expectError(OTHER_OWNER, 'select public.revenue_month($1,$2)', 'not-found', [location, month]);
  await t.expectError(WORKER, RPC, 'validation', args.with(2, 100_000_000_001));
});
