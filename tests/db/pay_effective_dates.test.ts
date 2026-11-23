import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const owner = 'alpha.owner@demo.example.com';
let db: TestDb, partner: string, point: string, employee: string, today: string, tomorrow: string, yesterday: string;
beforeAll(async () => {
  db = await createTestDb();
  [ { id: partner } ] = await db.admin<{ id: string }>("select id from partner where code='ALPHA'");
  [ { id: point } ] = await db.admin<{ id: string }>("select id from location where partner_id=$1 and status='active' order by id limit 1", [partner]);
  [ { today, tomorrow, yesterday } ] = await db.admin<{ today: string; tomorrow: string; yesterday: string }>(
    'select d::text today,(d+1)::text tomorrow,(d-1)::text yesterday from app_private.local_today($1) d', [point]);
  [ { id: employee } ] = await db.as<{ id: string }>(owner,
    "select staff_account_create($1,'Смена ставки','dated.pay','test-password',array[$2::uuid],false) id", [partner, point]);
});
afterAll(async () => db?.db.close());

async function pay(date: string) {
  return (await db.admin<{ policy: { floor_minor?: number; mode?: string; fee_minor?: number } }>(
    'select app_private.staff_pay_policy($1,$2) policy', [employee, date]))[0].policy;
}

it('uses the team terms in force on the work date, including delayed submissions', async () => {
  const prior = await pay(yesterday);
  const updated = { floor_minor: 40000, tiers: [{ from_minor: 0, rate_bp: 725, bonus_minor: 0 }] };
  await db.as(owner, 'select motivation_set($1,$2,0)', [partner, { ...updated, effective_from: tomorrow }]);
  expect(await pay(today)).toEqual(prior);
  expect(await pay(tomorrow)).toEqual(updated);
  expect(await pay(yesterday)).toEqual(prior);
  const [row] = await db.as<{ result: { policy: unknown; scheduled: { effective_from: string }[] } }>(owner,
    'select motivation_get($1) result', [partner]);
  expect(row.result.policy).toEqual(prior);
  expect(row.result.scheduled.map(s => s.effective_from)).toContain(tomorrow);
});

it('versions individual terms and blocks stale profile edits without changing an accepted snapshot', async () => {
  const old = await pay(today);
  const save = (revision: number, fee: number) => db.as(owner,
    "select staff_profile_save_phone($1,$2,'Смена ставки','','',array[$3::uuid],725,$4,false,$5)", [employee, partner, point, fee,
      { employee_kind: 'employee', learning_enabled: true, pay_effective_from: tomorrow, expected_pay_revision: revision }]);
  const revision = async () => (await db.admin<{ rev: number }>('select pay_revision rev from staff_member where user_id=$1', [employee]))[0].rev;
  const originalRevision = await revision();
  const [opened] = await db.as<{ id: string }>('dated.pay@access.bron.local', 'select (shift_open($1)).id', [point]);
  await save(originalRevision, 23456);
  expect(await pay(today)).toEqual(old);
  expect(await pay(tomorrow)).toEqual({ mode: 'legacy', rate_bp: 725, fee_minor: 23456 });
  expect(await revision()).toBeGreaterThan(originalRevision);
  await expect(save(originalRevision, 90000)).rejects.toThrow('version-conflict');
  expect((await db.as<{ result: { shift: { pay_policy: unknown } } }>('dated.pay@access.bron.local',
    'select shift_close($1,0,0,null) result', [opened.id]))[0].result.shift.pay_policy).toEqual(old);
});

it('uses a dated individual tier for a late first posting and keeps that posted policy when yesterday is changed again', async () => {
  const terms = { name: 'Вчерашняя схема', floor_minor: 65432, tiers: [{ from_minor: 0, rate_bp: 725, bonus_minor: 111 }] };
  const setCustom = (floor: number) => db.as(owner,
    "select staff_profile_save_phone($1,$2,'Смена ставки','','',array[$3::uuid],725,23456,false,$4)", [employee, partner, point,
      { employee_kind: 'employee', learning_enabled: true, custom_pay: { ...terms, floor_minor: floor }, pay_effective_from: yesterday }]);
  await setCustom(65432);
  const [saved] = await db.as<{ s: { shift: { id: string; revision: number; earned_minor: number; pay_policy: unknown } } }>(
    'dated.pay@access.bron.local', 'select shift_submit($1,$2,0,0,$3) s', [point, yesterday, crypto.randomUUID()]);
  expect(saved.s.shift).toMatchObject({ earned_minor: 65543, pay_policy: terms });
  await setCustom(98765);
  const [fixed] = await db.as<{ s: { shift: { earned_minor: number; pay_policy: unknown } } }>('dated.pay@access.bron.local',
    'select shift_close_versioned($1,1000,0,$2,$3,null) s', [saved.s.shift.id, saved.s.shift.revision, crypto.randomUUID()]);
  expect(fixed.s.shift).toMatchObject({ earned_minor: 65543, pay_policy: terms });
  expect(await pay(tomorrow)).toEqual({ mode: 'legacy', rate_bp: 725, fee_minor: 23456 });
});

it('honors a legacy internship start but dates later edits to the same internship from today', async () => {
  const [row] = await db.as<{ id: string }>(owner,
    "select staff_account_create($1,'Стажировка','dated.trainee','test-password',array[$2::uuid],false) id", [partner, point]);
  const setFloor = (floor: number) => db.as(owner, 'select staff_onboarding_set($1,$2)', [row.id,
    { employee_kind: 'trainee', internship_from: yesterday, internship_until: tomorrow, learning_enabled: true, internship_floor_minor: floor }]);
  const floorOn = async (date: string) => (await db.admin<{ floor: number }>(
    "select (app_private.staff_pay_policy($1,$2)->>'floor_minor')::int floor", [row.id, date]))[0].floor;
  await setFloor(12345);
  expect(await floorOn(yesterday)).toBe(12345);
  await setFloor(23456);
  expect(await floorOn(yesterday)).toBe(12345);
  expect(await floorOn(today)).toBe(23456);
  expect((await db.admin('select 1 from staff_member where pending_pay_effective_from is not null'))).toHaveLength(0);
});

it('saves a modern undated employee card as one change effective today when also converting to trainee', async () => {
  const [row] = await db.as<{id: string}>(owner,"select staff_account_create($1,'Стажёр','dated.form','test-password',array[$2::uuid],false) id",[partner,point]);
  const floorOn = async (date: string) => (await db.admin<{ j: { floor_minor?: number } }>(
    'select app_private.staff_pay_policy($1,$2) j',[row.id,date]))[0].j.floor_minor;
  const previous = await floorOn(yesterday);
  await db.as(owner,
    "select staff_profile_save_phone($1,$2,'Стажёр','','',array[$3::uuid],725,23456,false,$4)",
    [row.id,partner,point,{employee_kind:'trainee',internship_from:yesterday,internship_until:tomorrow,internship_floor_minor:54321,learning_enabled:true,expected_pay_revision:0}]);
  expect(await floorOn(yesterday)).toBe(previous);
  expect(await floorOn(today)).toBe(54321);
});
