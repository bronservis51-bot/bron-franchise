import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const OWNER = 'alpha.owner@demo.example.com';
const MANAGER = 'fm@demo.example.com';
const EMPLOYEE = 'permissions.reconnect@access.bron.local';
const SUBMIT = 'select public.shift_submit($1,$2,10000,0,$3,null)';
let db: TestDb;
let partner: string;
let firstPoint: string;
let secondPoint: string;
let employee: string;
let day: string;

beforeAll(async () => {
  db = await createTestDb();
  const [first, second] = await db.admin<{ id: string; partner_id: string; shift_day: string }>(
    "select id, partner_id, app_private.local_today(id)::text as shift_day from public.location where code in ('ALPHA-1','ALPHA-2') order by code");
  ({ id: firstPoint, partner_id: partner, shift_day: day } = first);
  secondPoint = second.id;
  const [created] = await db.as<{ id: string }>(OWNER,
    "select public.staff_account_create($1,'Сотрудник для переподключения','permissions.reconnect','test-only-password',array[$2::uuid],true) id",
    [partner, firstPoint]);
  employee = created.id;
}, 180_000);
afterAll(async () => db?.db.close());

async function session() {
  const id = crypto.randomUUID();
  await db.admin('insert into auth.sessions(id,user_id) values ($1,$2)', [id, employee]);
  return id;
}

function requestAs<T>(sessionId: string, sql: string, args: unknown[] = []) {
  return db.db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ sub: employee, role: 'authenticated', session_id: sessionId })]);
    await tx.exec('set local role authenticated');
    return (await tx.query<T>(sql, args)).rows;
  });
}

it('2.3 and 2.4 recheck a queued shift and procurement against the active session and assignment', async () => {
  const original = await session();
  const op = crypto.randomUUID();
  const args = [firstPoint, day, op];
  await db.as(MANAGER, 'select public.partner_order_url_set($1,$2)',
    [partner, 'https://b2b.moysklad.ru/SyntheticPermissionCheck']);
  const [before] = await requestAs<{ result: { url: string } }>(original, 'select public.order_link() result');
  expect(before.result.url).toBe('https://b2b.moysklad.ru/SyntheticPermissionCheck');

  await db.as(OWNER, 'select public.staff_access_set($1,$2,true,array[$3::uuid])', [partner, employee, secondPoint]);
  await expect(requestAs(original, SUBMIT, args)).rejects.toThrow('unauthenticated');
  await expect(requestAs(original, 'select public.order_link()')).rejects.toThrow('unauthenticated');
  expect((await requestAs<{ result: { user: unknown } }>(original, 'select public.me() result'))[0].result.user).toBeNull();

  const current = await session();
  await expect(requestAs(current, SUBMIT, args)).rejects.toThrow('not-found');
  await db.as(OWNER, 'select public.team_set_active($1,$2,false)', [partner, employee]);
  await expect(requestAs(current, SUBMIT, [secondPoint, day, op])).rejects.toThrow('unauthenticated');
  await db.expectError(EMPLOYEE, 'select public.order_link()', 'forbidden');
  expect(await db.admin('select id from public.work_shift where employee_id=$1', [employee])).toEqual([]);
  expect(await db.admin('select id from public.daily_revenue where employee_id=$1', [employee])).toEqual([]);
  expect(await db.admin('select operation_id from app_private.operation_receipt where user_id=$1', [employee])).toEqual([]);
});
