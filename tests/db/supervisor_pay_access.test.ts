import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const owner = 'alpha.owner@demo.example.com';
const supervisorLogin = '79990009111@staff.bron.local';
const salespersonLogin = 'scope.pay.sales@access.bron.local';
const save = 'select public.staff_pay_save($1,$2,725,$3,false,null,$4,$5,null)';
const access = (manage_pay: boolean) => ({ view_staff: false, create_staff: false, procurement: false, manage_pay });
let db: TestDb, partner: string, point: string, otherPoint: string, supervisor: string, seller: string;
let rotating: string, peer: string, inactive: string, elsewhere: string, today: string, tomorrow: string;

const saveProfile = (user: string | null, settings: object, name = 'Управляющий оплатой') => db.as<{ id: string }>(owner,
  "select staff_profile_save_phone($1,$2,$3,'79990009111','test-only-manager-password',array[$4::uuid],0,0,true,$5) id",
  [user, partner, name, point, settings]);

async function payroll(login: string) {
  return (await db.as<{ data: { user_id: string; can_edit_pay?: boolean; can_manage: boolean; phone: string; rate_bp: number; pay_revision?: number; month_earned_minor: number }[] }>(login,
    'select public.staff_list($1,current_date) data', [partner]))[0].data;
}

beforeAll(async () => {
  db = await createTestDb();
  [{ id: partner }] = await db.admin<{ id: string }>("select id from partner where code='ALPHA'");
  [{ id: point }, { id: otherPoint }] = await db.admin<{ id: string }>("select id from location where partner_id=$1 order by id limit 2", [partner]);
  [{ today, tomorrow }] = await db.admin<{ today: string; tomorrow: string }>("select d::text today,(d+1)::text tomorrow from app_private.local_today($1) d", [point]);
  const employee = async (login: string, locationIds: string[], manager = false) => (await db.as<{ id: string }>(owner,
    "select staff_account_create($1,$2,$2,'test-only-worker-password',$3,$4) id", [partner, login, locationIds, manager]))[0].id;
  [{ id: supervisor }] = await saveProfile(null, { position: 'manager', learning_enabled: true, access: access(true) });
  seller = await employee('scope.pay.sales', [point]);
  rotating = await employee('scope.pay.rotation', [point, otherPoint]);
  peer = await employee('scope.pay.peer', [point], true);
  inactive = await employee('scope.pay.inactive', [point]);
  elsewhere = await employee('scope.pay.elsewhere', [otherPoint]);
  await db.as(owner, 'select staff_set_active($1,false)', [inactive]);
}, 180_000);
afterAll(async () => db?.db.close());

it('exposes only editable subordinates’ payment settings and keeps separate view/create privileges off', async () => {
  const [{ data: me }] = await db.as<{ data: { assignments: { role: string; permissions: string[] }[] } }>(supervisorLogin, 'select me() data');
  expect(me.assignments.find(a => a.role === 'franchisee_manager')?.permissions).toContain('staff.pay_edit');
  expect(me.assignments.flatMap(a => a.permissions)).not.toContain('staff.manage');
  expect(me.assignments.flatMap(a => a.permissions)).not.toContain('staff.create');
  const rows = await payroll(supervisorLogin);
  expect(rows.find(s => s.user_id === seller)).toMatchObject({ can_edit_pay: true, can_manage: false, phone: '', pay_revision: 0, month_earned_minor: 0 });
  for (const id of [peer, rotating, supervisor, inactive, elsewhere]) {
    expect(rows.find(s => s.user_id === id)).toBeUndefined();
  }
  expect(await db.as(supervisorLogin, 'select public.motivation_get($1)', [partner])).toHaveLength(1);
  await db.expectError(supervisorLogin, 'select public.motivation_set($1,$2,0)', 'forbidden', [partner, {}]);
});

it('permits dated terms for an in-scope employee only, while requiring a fresh pay revision', async () => {
  const oldPolicy = await db.admin('select app_private.staff_pay_policy($1,$2) as policy', [seller, today]);
  await db.as(supervisorLogin, save, [partner, seller, 34500, tomorrow, 0]);
  expect(await db.admin('select app_private.staff_pay_policy($1,$2) as policy', [seller, tomorrow]))
    .toEqual([{policy:{mode:'legacy',rate_bp:725,fee_minor:34500}}]);
  expect(await db.admin('select app_private.staff_pay_policy($1,$2) as policy', [seller, today])).toEqual(oldPolicy);
  await db.expectError(supervisorLogin, save, 'version-conflict', [partner,seller,90000,tomorrow,0]);
  for (const id of [rotating, peer, supervisor, inactive, elsewhere]) {
    await db.expectError(supervisorLogin, save, 'forbidden', [partner,id,34500,tomorrow,0]);
  }
  await db.expectError(salespersonLogin, save, 'forbidden', [partner,peer,34500,tomorrow,0]);
  await db.expectError(supervisorLogin, 'select public.staff_access_set($1,$2,true,array[$3::uuid])','forbidden',[partner,seller,point]);
  await db.expectError(supervisorLogin, "select public.staff_update($1,'Смена имени',array[$2::uuid],725,34500)", 'not-found', [seller,point]);
});

it('keeps an omitted grant on older forms, allows an adjacent view grant, and revokes payment edits explicitly', async () => {
  const oldForm = { view_staff:true,create_staff:false,procurement:false };
  await saveProfile(supervisor, { position:'manager', learning_enabled:true, access:oldForm });
  const list = await payroll(supervisorLogin);
  expect(list.find(s => s.user_id === seller)).toMatchObject({can_edit_pay:true});
  expect(list.find(s => s.user_id === peer)).toMatchObject({can_edit_pay:false,phone:''});
  expect(list.find(s => s.user_id === peer)).not.toHaveProperty('pay_revision');
  await saveProfile(supervisor, { position:'manager', learning_enabled:true, access:{...oldForm,manage_pay:false} });
  const reduced = await payroll(supervisorLogin);
  expect(reduced.find(s => s.user_id === seller)).toMatchObject({can_edit_pay:false,can_manage:false});
  await db.expectError(supervisorLogin,save,'forbidden',[partner,seller,40000,tomorrow,1]);
  await saveProfile(supervisor, { position:'manager', learning_enabled:true, access:access(true) });
});

it('promotes a seller on the same login, keeps immutable shift history, and applies only granted optional rights', async () => {
  const [{ id }] = await db.as<{ id:string }>(salespersonLogin, 'select (shift_submit($1,$2,0,0,$3)->\'shift\'->>\'id\') id', [point,today,crypto.randomUUID()]);
  const original = await db.admin('select id,employee_id,earned_minor,pay_policy from work_shift where id=$1', [id]);
  const session = crypto.randomUUID();
  await db.admin('insert into auth.sessions(id,user_id) values($1,$2)',[session,seller]);
  const promotion = await saveProfile(seller, {position:'manager',learning_enabled:true,access:access(false)}, 'Продавец повышен');
  expect(promotion[0].id).toBe(seller);
  expect(await db.userId(salespersonLogin)).toBe(seller);
  expect(await db.admin('select id from auth.sessions where id=$1',[session])).toEqual([]);
  expect(await db.admin('select id,employee_id,earned_minor,pay_policy from work_shift where id=$1',[id])).toEqual(original);
  await db.expectError(salespersonLogin, save, 'forbidden', [partner,rotating,34500,tomorrow,0]);
  await db.expectError(supervisorLogin, save, 'forbidden', [partner,seller,34500,tomorrow,0]);
});
