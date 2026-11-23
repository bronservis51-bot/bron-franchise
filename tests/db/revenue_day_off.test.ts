import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const OTHER_OWNER = 'beta.owner@demo.example.com';
const MANAGER = 'fm@demo.example.com';
const STAFF = '79000000011@staff.bron.local';
const SET_DAY_OFF = 'select public.revenue_day_off_set($1, $2, $3)';

interface Point {
  id: string;
  partner_id: string;
  other_id: string;
  today: string;
  yesterday: string;
  tomorrow: string;
}

interface Month {
  location_id: string;
  days_off: string[];
  missing_days: string[];
  fact_minor: number;
  days: { day: string; total_minor: number }[];
}

let testDb: TestDb;
let point: Point;

beforeAll(async () => {
  testDb = await createTestDb();
  point = (await testDb.admin<Point>(`
    select s.location_ids[1] as id, s.partner_id, s.location_ids[2] as other_id, app_private.local_today(s.location_ids[1])::text as today,
      (app_private.local_today(s.location_ids[1]) - 1)::text as yesterday,
      (app_private.local_today(s.location_ids[1]) + 1)::text as tomorrow
    from public.staff_member s join public.app_user u on u.id = s.user_id where u.email = $1
  `, [STAFF]))[0];
  await testDb.admin('delete from public.daily_revenue where location_id = $1 and day in ($2, $3)', [point.id, point.today, point.yesterday]);
  await testDb.admin('delete from public.work_shift where location_id = $1 and day in ($2, $3)', [point.id, point.today, point.yesterday]);
  await testDb.admin("delete from public.work_shift where employee_id = $1 and status = 'open'", [await testDb.userId(STAFF)]);
}, 120_000);

afterAll(async () => testDb?.db.close());

async function month(day: string): Promise<Month> {
  return (await testDb.as<{ result: Month }>(OWNER, 'select public.revenue_month($1, $2) as result', [point.id, day]))[0].result;
}

async function overview(day: string, location = point.id): Promise<Month> {
  const result = (await testDb.as<{ result: { rows: Month[] } }>(MANAGER, 'select public.revenue_overview($1) as result', [day]))[0].result;
  return result.rows.find(row => row.location_id === location)!;
}

interface Rating { partner_id: string; rank: number; forecast_minor: number; fill_pct: number }

async function rating(day: string): Promise<Rating> {
  const result = (await testDb.as<{ result: { rows: Rating[] } }>(MANAGER, 'select public.rating($1) as result', [day]))[0].result;
  return result.rows.find(row => row.partner_id === point.partner_id)!;
}

describe('point day off', () => {
  it('removes only the marked date from missing days and restores it on undo without recording revenue', async () => {
    const date = point.yesterday;
    const before = await month(date);
    const other = await overview(date, point.other_id);
    expect(before.missing_days).toContain(date);

    await testDb.as(MANAGER, SET_DAY_OFF, [point.id, date, true]);
    await testDb.as(MANAGER, SET_DAY_OFF, [point.id, date, true]);
    const marked = await month(date);
    expect(marked.days_off).toEqual([date]);
    expect(marked.missing_days).toEqual(before.missing_days.filter(day => day !== date));
    expect(marked.fact_minor).toEqual(before.fact_minor);
    expect(marked.days).toEqual(before.days);
    expect((await overview(date)).missing_days).toEqual(marked.missing_days);
    expect((await overview(date)).days_off).toEqual([date]);
    expect(await overview(date, point.other_id)).toEqual(other);

    await testDb.as(MANAGER, SET_DAY_OFF, [point.id, date, false]);
    await testDb.as(MANAGER, SET_DAY_OFF, [point.id, date, false]);
    const restored = await month(date);
    expect(restored.days_off).toEqual([]);
    expect(restored.missing_days).toEqual(before.missing_days);
  });

  it('excludes the day off from report completion but preserves the network revenue forecast and ranking', async () => {
    const date = point.yesterday;
    const before = await rating(date);
    const { filled, elapsed } = (await testDb.admin<{ filled: number; elapsed: number }>(`
      select sum(x.filled_days)::int as filled, sum(x.elapsed_days)::int as elapsed from public.location l
      cross join lateral app_private.loc_progress(l, date_trunc('month', $2::date)::date) x
      where l.partner_id = $1 and l.status = 'active' and x.active_days > 0
    `, [point.partner_id, date]))[0];
    await testDb.as(MANAGER, SET_DAY_OFF, [point.id, date, true]);
    try {
      const after = await rating(date);
      expect(after.forecast_minor).toEqual(before.forecast_minor);
      expect(after.rank).toEqual(before.rank);
      expect(after.fill_pct).toEqual(Math.round(filled * 100 / (elapsed - 1)));
    } finally {
      await testDb.as(MANAGER, SET_DAY_OFF, [point.id, date, false]);
    }
  });

  it('requires point entry permission and an editable date in the point timezone', async () => {
    await testDb.expectError(OTHER_OWNER, SET_DAY_OFF, 'not-found', [point.id, point.today, true]);
    await testDb.expectError(STAFF, SET_DAY_OFF, 'forbidden', [point.id, point.today, true]);
    await testDb.expectError(OWNER, SET_DAY_OFF, 'validation', [point.id, point.tomorrow, true]);
    await testDb.expectError(OWNER, SET_DAY_OFF, 'validation', [point.id, '2020-01-01', true]);
    await expect(testDb.as(null, SET_DAY_OFF, [point.id, point.today, true])).rejects.toThrow(/permission denied/);
    await expect(testDb.as(OWNER, 'select * from app_private.revenue_day_off')).rejects.toThrow(/permission denied/);
  });

  it('allows undo for a subsequently closed point within the permitted date range', async () => {
    const args = [point.id, point.today];
    await testDb.as(OWNER, SET_DAY_OFF, [...args, true]);
    await testDb.admin("update public.location set status = 'closed' where id = $1", [point.id]);
    try {
      await testDb.as(OWNER, SET_DAY_OFF, [...args, false]);
      expect((await month(point.today)).days_off).toEqual([]);
      await testDb.expectError(OWNER, SET_DAY_OFF, 'validation', [...args, true]);
    } finally {
      await testDb.admin("update public.location set status = 'active' where id = $1", [point.id]);
    }
  });

  it('preserves real shifts and sales, and allows normal writes after undo', async () => {
    const args = [point.id, point.today];
    const save = 'select public.revenue_total_set($1, $2, 15000, \'empty\', gen_random_uuid(), null)';
    const shift = (await testDb.as<{ id: string }>(STAFF, 'select (public.shift_open($1)).id', [point.id]))[0];
    await testDb.expectError(OWNER, SET_DAY_OFF, 'validation', [...args, true]);
    await testDb.as(STAFF, 'select public.shift_cancel($1)', [shift.id]);

    await testDb.as(OWNER, SET_DAY_OFF, [...args, true]);
    await testDb.expectError(STAFF, 'select public.shift_open($1)', 'validation', [point.id]);
    await testDb.expectError(OWNER, save, 'validation', args);

    await testDb.as(OWNER, SET_DAY_OFF, [...args, false]);
    await testDb.as(OWNER, save, args);
    await testDb.expectError(OWNER, SET_DAY_OFF, 'validation', [...args, true]);
    expect((await month(point.today)).days.find(day => day.day === point.today)?.total_minor).toEqual(15000);
  });
});
