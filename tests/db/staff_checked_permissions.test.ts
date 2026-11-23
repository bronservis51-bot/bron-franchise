import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const STAFF = '79000000011@staff.bron.local';
const SAVE = 'select public.staff_profile_save_phone($1,$2,$3,$4,$5,$6,0,0,true,$7) as id';
let db: TestDb;
let partner: string;
let assigned: string;
let other: string;
let employee: string;

beforeAll(async () => {
  db = await createTestDb();
  employee = await db.userId(STAFF);
  const row = (await db.admin<{ partner_id: string; location_ids: string[] }>(
    'select partner_id, location_ids from public.staff_member where user_id=$1', [employee]))[0];
  partner = row.partner_id;
  [assigned, other] = row.location_ids;
}, 180_000);

afterAll(async () => db?.db.close());

const access = (view_staff = false, create_staff = false, procurement = false) => ({ view_staff, create_staff, procurement });

function profile(user: string | null, locations: string[], accessFlags: ReturnType<typeof access>, position = 'sales_manager') {
  return [user, partner, 'Сотрудник проверки', '79999901190', 'test-only-password', locations,
    JSON.stringify({ employee_kind: 'employee', learning_enabled: true, position, access: accessFlags })];
}

it('authorizes assigned roster access without exposing payroll, procurement or edits', async () => {
  await db.as(OWNER, SAVE, profile(employee, [assigned], access(true)));
  const roster = (await db.as<{ roster: Record<string, unknown>[] }>(STAFF, 'select public.staff_list($1,current_date) roster', [partner]))[0].roster;
  expect(roster.find(row => row.user_id === employee)).toMatchObject({ position: 'sales_manager', can_manage: false, month_earned_minor: 0, phone: '' });
  await db.expectError(STAFF, 'select public.motivation_get($1)', 'forbidden', [partner]);
  await db.expectError(STAFF, 'select public.procurement_catalog()', 'forbidden');
  await db.expectError(STAFF, SAVE, 'forbidden', profile(null, [assigned], access()));
});

it('allows creation only at assigned points and denies role or access delegation', async () => {
  await db.as(OWNER, SAVE, profile(employee, [assigned], access(false, true)));
  await db.expectError(STAFF, 'select public.staff_list($1,current_date)', 'forbidden', [partner]);
  await db.expectError(STAFF, SAVE, 'forbidden', profile(null, [other], access()));
  await db.expectError(STAFF, SAVE, 'forbidden', profile(null, [assigned], access(true)));
  await db.expectError(STAFF, SAVE, 'forbidden', profile(null, [assigned], access(), 'manager'));
  const newUser = (await db.as<{ id: string }>(STAFF, SAVE, profile(null, [assigned], access())))[0].id;
  const saved = (await db.as<{ roster: Record<string, unknown>[] }>(OWNER, 'select public.staff_list($1,current_date) roster', [partner]))[0].roster;
  expect(saved.find(row => row.user_id === newUser)).toMatchObject({ position: 'sales_manager', access: access(), location_ids: [assigned] });
  await db.expectError(STAFF, SAVE, 'forbidden', profile(newUser, [assigned], access()));
});

it('a configured manager with view-only permission cannot change staff, pay, passwords or roles', async () => {
  const target = (await db.as<{ id: string }>(OWNER,
    "select public.staff_account_create($1,'Проверка доступа','view.only.test','test-only-password',array[$2::uuid],false) as id",
    [partner, assigned]))[0].id;
  await db.as(OWNER, SAVE, profile(employee, [assigned], access(true), 'manager'));
  const result = (await db.as<{ roster: Record<string, unknown>[] }>(STAFF,
    'select public.staff_list($1,current_date) roster', [partner]))[0].roster;
  expect(result.find(row => row.user_id === target)).toMatchObject({ can_manage: false, phone: '', month_earned_minor: 0 });
  await db.expectError(STAFF, SAVE, 'forbidden', profile(null, [assigned], access()));
  await db.expectError(STAFF, SAVE, 'forbidden', profile(target, [assigned], access()));
  await db.expectError(STAFF, 'select public.user_set_password($1,$2)', 'forbidden', [target, 'test-only-updated-password']);
  await db.expectError(STAFF, 'select public.staff_access_set($1,$2,true,array[$3::uuid])', 'forbidden', [partner, target, assigned]);
  await db.expectError(STAFF, 'select public.staff_motivation_set($1,true)', 'forbidden', [target]);
});

it('withdraws procurement independently and retains the manager position', async () => {
  await db.as(OWNER, SAVE, profile(employee, [assigned], access(false, false, true), 'manager'));
  await db.as(STAFF, 'select public.order_link()');
  await db.as(STAFF, 'select public.procurement_catalog()');
  await db.expectError(STAFF, 'select public.staff_list($1,current_date)', 'forbidden', [partner]);
  const session = crypto.randomUUID();
  await db.admin('insert into auth.sessions(id,user_id) values($1,$2)', [session, employee]);
  await db.as(OWNER, SAVE, profile(employee, [assigned], access(), 'manager'));
  expect(await db.admin('select id from auth.sessions where id=$1', [session])).toEqual([]);
  await db.expectError(STAFF, 'select public.procurement_catalog()', 'forbidden');
  await db.expectError(STAFF, 'select public.order_link()', 'forbidden');
  const revenue = (await db.as<{ points: { location_id: string }[] }>(STAFF, 'select public.team_revenue_month($1,current_date) points', [partner]))[0].points;
  expect(revenue.map(point => point.location_id)).toEqual([assigned]);
  expect(await db.as(STAFF, 'select id from public.location where partner_id=$1', [partner])).toEqual([{ id: assigned }]);
  const me = (await db.as<{ session: { assignments: { role: string; permissions: string[] }[] } }>(STAFF, 'select public.me() session'))[0].session;
  expect(me.assignments.map(item => item.role)).toContain('franchisee_manager');
  expect(me.assignments.flatMap(item => item.permissions)).not.toContain('staff.manage');
});

it('2.3 preserves existing staff management when only the ordering permission changes', async () => {
  const login = '79999901191@staff.bron.local';
  const legacy = (await db.as<{ id: string }>(OWNER,
    "select public.staff_account_create_phone($1,'Управляющий с полными правами','79999901191','test-only-password',array[$2::uuid],true) id",
    [partner, assigned]))[0].id;
  const permissions = async () => (await db.as<{ me: { assignments: { permissions: string[] }[] } }>(
    login, 'select public.me() me'))[0].me.assignments.flatMap(row => row.permissions);
  expect(await permissions()).toContain('staff.manage');
  await db.as(OWNER, SAVE, profile(legacy, [assigned], access(true, true), 'manager'));
  expect(await permissions()).toContain('staff.manage');
  await db.expectError(login, 'select public.order_link()', 'forbidden');
  await db.as(OWNER, SAVE, profile(legacy, [assigned], access(true, true, true), 'manager'));
  expect(await permissions()).toContain('staff.manage');
  expect(await permissions()).toContain('procurement.order');
  await db.as(OWNER, SAVE, profile(legacy, [assigned], access(false, true, true), 'manager'));
  expect(await permissions()).not.toContain('staff.manage');
  await db.expectError(login, 'select public.staff_list($1,current_date)', 'forbidden', [partner]);
  await db.as(OWNER, SAVE, profile(legacy, [assigned], access(true, true, true), 'manager'));
  expect(await permissions()).toContain('staff.manage');
});

it('2.3 explicitly promoting a seller leaves management limited to the selected optional rights', async () => {
  const login = '79999901193@staff.bron.local';
  const seller = (await db.as<{ id: string }>(OWNER,
    "select public.staff_account_create_phone($1,'Продавец для назначения','79999901193','test-only-password',array[$2::uuid],false) id",
    [partner, assigned]))[0].id;
  await db.as(OWNER, SAVE, profile(seller, [assigned], access(true, true, true), 'manager'));
  const result = (await db.as<{ me: { assignments: { role: string; permissions: string[] }[] } }>(
    login, 'select public.me() me'))[0].me;
  expect(result.assignments.map(row => row.role)).toContain('franchisee_manager');
  const permissions = result.assignments.flatMap(row => row.permissions);
  expect(permissions).toEqual(expect.arrayContaining(['staff.view','staff.create','procurement.order']));
  expect(permissions).not.toContain('staff.manage');
});

it('2.4 identifies closing and restoring a manager’s access in the history', async () => {
  const manager = (await db.as<{ id: string }>(OWNER,
    "select public.staff_account_create_phone($1,'Управляющий для истории','79999901192','test-only-password',array[$2::uuid],true) id",
    [partner, assigned]))[0].id;
  await db.as(OWNER, 'select public.team_set_active($1,$2,false)', [partner, manager]);
  await db.as(OWNER, 'select public.team_set_active($1,$2,true)', [partner, manager]);
  const history = (await db.as<{ rows: { action: string; user_name: string }[] }>(
    OWNER, 'select public.staff_access_history($1) rows', [partner]))[0].rows;
  expect(history.filter(row => row.user_name === 'Управляющий для истории').map(row => row.action)).toEqual([
    'team.restore', 'team.remove', 'staff.create',
  ]);
});

it('stores a validated custom pay choice atomically and keeps it for older profile callers', async () => {
  const settings = { employee_kind: 'employee', learning_enabled: true };
  const custom = { name: 'Индивидуальная схема', floor_minor: 20000, tiers: [{ from_minor: 0, rate_bp: 1000, bonus_minor: 0 }] };
  const sql = 'select public.staff_profile_save_phone($1,$2,$3,$4,$5,$6,0,0,false,$7) as id';
  const args = [employee, partner, 'Сотрудник проверки', '', '', [assigned]];
  await db.as(OWNER, sql, [...args, JSON.stringify({ ...settings, custom_pay: custom })]);
  await db.as(OWNER, sql, [...args, JSON.stringify(settings)]);
  const fetch = async () => (await db.as<{ roster: Record<string, unknown>[] }>(OWNER,
    'select public.staff_list($1,current_date) roster', [partner]))[0].roster.find(row => row.user_id === employee);
  expect(await fetch()).toMatchObject({ custom_pay: custom, pay_policy: custom });

  await db.expectError(OWNER, sql, 'validation', [...args, JSON.stringify({ ...settings, custom_pay: { ...custom, name: '' } })]);
  expect(await fetch()).toMatchObject({ custom_pay: custom, pay_policy: custom });
  await db.as(OWNER, sql, [...args, JSON.stringify({ ...settings, custom_pay: null })]);
  expect(await fetch()).toMatchObject({ custom_pay: null, pay_policy: { mode: 'legacy', fee_minor: 0 } });
});
