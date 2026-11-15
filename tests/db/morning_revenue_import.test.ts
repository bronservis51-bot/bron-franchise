import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
// @ts-expect-error — dependency-free reviewed operator module.
import { applyMissingRevenueTotals, inspectRevenueImport } from '../../docs/runbooks/payloads/morning-revenue-import.mjs';

let t: TestDb;
let locationId: string;
let actorId: string;
const batchId = '44444444-4444-4444-8444-444444444444';
const DAYS = ['2026-11-02', '2026-11-05'];
const input = () => ({ format: 1, batchId, locationId, currency: 'RUB', year: 2026, month: 11,
  entries: [{ day: DAYS[0], totalMinor: '310000' }, { day: DAYS[1], totalMinor: '0' }] });

beforeAll(async () => {
  t = await createTestDb();
  actorId = await t.userId('fm@demo.example.com');
  locationId = (await t.admin<{ id: string }>("select id from public.location where partner_id=(select id from public.partner where code='ALPHA') order by id limit 1"))[0].id;
  // Isolated seeded fixture only. Never use this clearing step against a working database.
  await t.admin('delete from public.daily_revenue where location_id=$1 and day=any($2::date[])', [locationId, DAYS]);
  await t.admin("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: actorId, role: 'authenticated' })]);
}, 240000);
afterAll(async () => { await t?.db.close(); });

describe('atomic missing-day import through existing revenue_total_set', () => {
  it('rolls back the first real RPC write, audit and receipt when the second command fails', async () => {
    const before = await t.admin<{ count: number }>('select count(*)::int as count from public.work_shift');
    const initial = await inspectRevenueImport(t.admin, input());
    let saves = 0;
    const failingConnection = async (sql: string, params: unknown[] = []) => {
      if (sql.includes('select public.revenue_total_set(') && ++saves === 2) throw new Error('simulated client transport loss');
      return t.admin(sql, params);
    };
    await expect(applyMissingRevenueTotals(failingConnection, input(), initial.sha256)).rejects.toThrow('simulated client transport loss');
    expect(await t.admin('select id from public.daily_revenue where location_id=$1 and day=any($2::date[])', [locationId, DAYS])).toHaveLength(0);
    expect(await t.admin('select operation_id from app_private.operation_receipt where operation_id=$1', [initial.plan.rows[0].operationId])).toHaveLength(0);
    expect(await t.admin<{ count: number }>('select count(*)::int as count from public.work_shift')).toEqual(before);
  });

  it('stores the exact total without cash/card attribution or changing any shift payroll', async () => {
    const shiftsBefore = await t.admin('select id,employee_id,earned_minor,pay_policy from public.work_shift order by id');
    const unprovidedDayBefore = await t.admin('select * from public.daily_revenue where location_id=$1 and day=$2', [locationId, '2026-11-03']);
    const initial = await inspectRevenueImport(t.admin, input());
    const result = await applyMissingRevenueTotals(t.admin, input(), initial.sha256);
    expect(result).toMatchObject({ status: 'PASS', insertedDays: 2, staffShiftsWritten: 0, payrollRecalculated: false, targetWriteOutcome: 'COMMITTED' });
    const rows = await t.admin<{ cash_minor: number; card_minor: number; unallocated_minor: number; reported_total_minor: number; employee_id: string | null }>(
      'select cash_minor,card_minor,unallocated_minor,reported_total_minor,employee_id from public.daily_revenue where location_id=$1 and day=any($2::date[]) order by day', [locationId, DAYS]);
    expect(rows.map(r => [Number(r.cash_minor), Number(r.card_minor), Number(r.unallocated_minor), Number(r.reported_total_minor), r.employee_id]))
      .toEqual([[0, 0, 310000, 310000, null], [0, 0, 0, 0, null]]);
    expect(await t.admin('select id,employee_id,earned_minor,pay_policy from public.work_shift order by id')).toEqual(shiftsBefore);
    expect(await t.admin('select * from public.daily_revenue where location_id=$1 and day=$2', [locationId, '2026-11-03'])).toEqual(unprovidedDayBefore);
  });

  it('a repeat private preview is a no-write no-op, while stale approval cannot be applied again', async () => {
    const now = await inspectRevenueImport(t.admin, input());
    const before = await t.admin('select id,revision,updated_at,comment from public.daily_revenue where location_id=$1 and day=any($2::date[]) order by id', [locationId, DAYS]);
    expect(await applyMissingRevenueTotals(t.admin, input(), now.sha256)).toMatchObject({ status: 'PASS', insertedDays: 0, unchangedDays: 2, targetWriteOutcome: 'UNCHANGED' });
    expect(await t.admin('select id,revision,updated_at,comment from public.daily_revenue where location_id=$1 and day=any($2::date[]) order by id', [locationId, DAYS])).toEqual(before);
    await expect(applyMissingRevenueTotals(t.admin, input(), 'a'.repeat(64))).rejects.toThrow('IMPORT_PLAN_CHANGED_OR_CONFLICT');
    expect(await t.admin('select id,revision,updated_at,comment from public.daily_revenue where location_id=$1 and day=any($2::date[]) order by id', [locationId, DAYS])).toEqual(before);
  });
});
