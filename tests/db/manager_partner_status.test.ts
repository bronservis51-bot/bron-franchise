import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const manager = 'fm@demo.example.com';
const owner = 'alpha.owner@demo.example.com';
const staff = '79000000011@staff.bron.local';
const sql = 'select public.manager_partner_status() as result';
let t: TestDb;
let partner: string;

beforeAll(async () => {
  t = await createTestDb();
  const [{ id }] = await t.as<{ id: string }>(manager, `select public.partner_save_preparation(
    null,'Синтетический проект','RU',null,null,null,'active','opening_preparation') id`);
  partner = id;
}, 180_000);
afterAll(async () => t?.db.close());

async function project() {
  const [row] = await t.as<{ result: { partner_id: string; working: boolean; owner_access: string }[] }>(manager, sql);
  return row.result.find(status => status.partner_id === partner);
}

it('2.1–2.2: reports a partner without operations or owner access and rejects other roles', async () => {
  expect(await project()).toEqual({ partner_id: partner, working: false, owner_access: 'none' });
  for (const actor of [owner, staff]) await t.expectError(actor, sql, 'forbidden');
  await expect(t.as(null, sql)).rejects.toThrow(/permission denied/);
});

it('2.1: distinguishes waiting, granted and revoked owner access independently of commercial status', async () => {
  await t.as(manager, 'select public.access_grant($1,$2)', [partner, 'future.qa@example.invalid']);
  expect(await project()).toMatchObject({ owner_access: 'pending' });
  await t.as(manager, `select public.access_grant($1,$2)`, [partner, owner]);
  await t.as(manager, `select public.partner_save_preparation(
    $1,'Синтетический проект','RU',null,null,null,'terminated','opening_preparation')`, [partner]);
  expect(await project()).toMatchObject({ owner_access: 'granted', working: false });
  const [{ id }] = await t.admin<{ id: string }>(`select id from public.role_assignment where scope_id = $1 and user_id = $2`, [partner, await t.userId(owner)]);
  await t.as(manager, 'select public.access_revoke($1)', [id]);
  expect(await project()).toMatchObject({ owner_access: 'pending' });
});

it('reports actual opening by the point-local day and supports points without a recorded date', async () => {
  const [{ id }] = await t.as<{ id: string }>(manager, `select public.location_save(
    null,$1,'Точка проекта','Тестовый город',null,'active',null) id`, [partner]);
  expect(await project()).toMatchObject({ working: false });
  await t.admin(`update public.location set opened_on=(now() at time zone timezone)::date+1 where id=$1`, [id]);
  expect(await project()).toMatchObject({ working: false });
  await t.admin(`update public.location set opened_on=(now() at time zone timezone)::date where id=$1`, [id]);
  expect(await project()).toMatchObject({ working: true });
  await t.admin(`update public.location set opened_on=null,status='closed' where id=$1`, [id]);
  expect(await project()).toMatchObject({ working: false });
  const [row] = await t.as<{ result: { partner_id: string; working: boolean }[] }>(manager, sql);
  const [{ id: legacy }] = await t.admin<{ id: string }>(`select id from public.partner where code='ALPHA'`);
  expect(row.result.find(item => item.partner_id === legacy)).toMatchObject({ working: true });
});
