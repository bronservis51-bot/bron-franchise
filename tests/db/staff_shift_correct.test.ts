import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const OTHER = 'beta.owner@demo.example.com';
const CORRECT = 'select public.staff_shift_correct($1,$2,$3,$4,$5,$6) result';
type Stored = { id: string; day: string; revision: number; earned_minor: number; pay_policy: unknown; closed_at: string };
let db: TestDb, owner: string, partner: string, location: string, today: string, user: string, email: string, shift: Stored;

beforeAll(async () => {
  db = await createTestDb();
  owner = await db.userId(OWNER);
  const [point] = await db.admin<{ id: string; partner_id: string; today: string }>(`
    select id, partner_id, app_private.local_today(id)::text today from location where code='ALPHA-1'
  `);
  ({ id: location, partner_id: partner, today } = point);
}, 180_000);
afterAll(async () => db?.db.close());

beforeEach(async () => {
  const login = 'edit.' + crypto.randomUUID().slice(0, 8);
  user = (await db.as<{ id: string }>(OWNER,
    "select staff_account_create($1,'Тест исправления',$2,'test-only-password',array[$3::uuid],false) id",
    [partner, login, location]))[0].id;
  email = login + '@access.bron.local';
  await db.admin('update staff_member set use_partner_motivation=false,rate_bp=1000,shift_fee_minor=20000 where user_id=$1', [user]);
  const [receipt] = await db.as<{ data: { shift: Stored } }>(email,
    "select shift_submit($1,$2,10000,20000,$3,'Запись сотрудника') data", [location, today, crypto.randomUUID()]);
  shift = (await db.admin<Stored>(`
    update work_shift set closed_at=now()-interval '10 minutes' where id=$1
    returning id,day::text,revision,earned_minor,pay_policy,closed_at::text
  `, [receipt.data.shift.id]))[0];
});

function correction(operation = crypto.randomUUID()) {
  return [shift.id, 100000, 50000, shift.revision, 'Сверили с чеком', operation];
}
async function payroll() {
  return (await db.as<{ list: { user_id: string; shifts: Record<string, unknown>[] }[] }>(OWNER,
    'select public.staff_list($1,$2) list', [partner, today]))[0].list.find(s => s.user_id === user)!.shifts[0];
}

it('allows the responsible franchisee to correct expired employee totals while preserving the snapshot, close time and employee comment', async () => {
  expect(await payroll()).toMatchObject({ id: shift.id, cash_minor: 10000, card_minor: 20000, revision: shift.revision, can_correct: true, submitted_without_open: true });
  await db.expectError(email, 'select shift_close_versioned($1,100000,50000,$2,$3,null)', 'period-locked', [shift.id, shift.revision, crypto.randomUUID()]);
  await db.admin('update staff_member set rate_bp=5000,shift_fee_minor=60000 where user_id=$1', [user]);
  const [declared] = await db.admin<{ total: number; version: string }>(`
    select sum(total_minor) + 150000 total, app_private.revenue_day_version($1,$2) version
    from daily_revenue where location_id=$1 and day=$2 and employee_id is not null
  `, [location, today]);
  await db.as(OWNER, 'select revenue_total_set($1,$2,$3,$4,$5)', [location, today, declared.total, declared.version, crypto.randomUUID()]);
  const params = correction();
  const accepted = await db.as(OWNER, CORRECT, params);
  expect(await db.as(OWNER, CORRECT, params)).toEqual(accepted);
  expect(await payroll()).toMatchObject({ id: shift.id, total_minor: 150000, earned_minor: 35000 });
  expect(await db.admin('select sum(total_minor) total from daily_revenue where location_id=$1 and day=$2', [location, today]))
    .toEqual([{ total: declared.total }]);
  expect(await db.admin('select revision,earned_minor,pay_policy,closed_at::text,comment from work_shift where id=$1', [shift.id]))
    .toEqual([{ revision: Number(shift.revision) + 1, earned_minor: 35000, pay_policy: shift.pay_policy, closed_at: shift.closed_at, comment: 'Запись сотрудника' }]);
  expect(await db.admin('select entered_by,employee_id,cash_minor,card_minor from daily_revenue where employee_id=$1', [user]))
    .toEqual([{ entered_by: owner, employee_id: user, cash_minor: 100000, card_minor: 50000 }]);
  expect(await db.admin("select actor_id,reason,diff from audit_event where action='shift.supervisor_correct' and entity_id=$1", [shift.id]))
    .toMatchObject([{ actor_id: owner, reason: 'Сверили с чеком', diff: { before: { cash_minor: 10000, earned_minor: 23000 },
      after: { cash_minor: 100000, earned_minor: 35000 } } }]);
  await db.expectError(OWNER, CORRECT, 'idempotency-conflict', [...params.slice(0, 4), 'Другой повод', params[5]]);
  await db.expectError(OWNER, CORRECT, 'version-conflict', correction());
});

it('enforces worker, tenant and financial authority and refuses anonymous, incomplete or locked-period corrections', async () => {
  for (const actor of [email, OTHER]) await db.expectError(actor, CORRECT, 'forbidden', correction());
  await expect(db.as(null, CORRECT, correction())).rejects.toThrow(/permission denied/);
  for (const [cash, card, reason] of [[null, 0, 'Сверили'], [-1, 0, 'Сверили'], [0, 0, ' '], ['9223372036854775807', 5, 'Сверили']]) {
    await db.expectError(OWNER, CORRECT, 'validation', [shift.id, cash, card, shift.revision, reason, crypto.randomUUID()]);
  }
  const manager = (await db.as<{ id: string }>(OWNER,
    "select staff_account_create($1,'Управляющий без записи','correct.manager','test-only-password',array[$2::uuid],true) id", [partner, location]))[0];
  expect(manager.id).toBeTruthy();
  await db.expectError('correct.manager@access.bron.local', CORRECT, 'forbidden', correction());
  const [old] = await db.admin<{ id: string; revision: number }>(`
    insert into work_shift(partner_id,location_id,employee_id,day,status,closed_at) values(
      $1,$2,$3,(date_trunc('month',current_date)-interval '2 months')::date,'closed',now()) returning id,revision
  `, [partner, location, user]);
  await db.expectError(OWNER, CORRECT, 'period-locked', [old.id, 1, 1, old.revision, 'Сверили архив', crypto.randomUUID()]);
  const [opened] = await db.admin<{ id: string; revision: number }>(`
    insert into work_shift(partner_id,location_id,employee_id,day) values($1,$2,$3,$4::date-1) returning id,revision
  `, [partner, location, user, today]);
  await db.expectError(OWNER, CORRECT, 'version-conflict', [opened.id, 1, 1, opened.revision, 'Сверили смену', crypto.randomUUID()]);
});
