import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const NETWORK = 'fm@demo.example.com';
const PLAY = 'lifecycle.owner@example.invalid';
const GET = 'select public.partner_launch_get($1) launch';
const CHECK = 'select public.partner_launch_task_set($1,$2,$3) launch';
const REVENUE = 'select public.revenue_total_set($1,current_date,$2,$3,$4,null)';
const EXPENSE = 'select public.expense_save(null,date_trunc(\'month\',current_date)::date,null,\'Проверка\',1000,null)';
let db: TestDb;
let partner: string;
let owner: string;

beforeAll(async () => {
  db = await createTestDb();
  [{ id: partner }] = await db.as<{ id: string }>(NETWORK,
    "select public.partner_save_preparation(null,'Жизненный цикл','RU',null,null,null,'active','opening_preparation') id");
  [{ id: owner }] = await db.as<{ id: string }>(NETWORK,
    "select public.account_create($1,'Франчайзи для проверки',$2,'synthetic-only-password') id", [partner, PLAY]);
}, 180_000);
afterAll(async () => db?.db.close());

async function point(id: string | null, name: string, status: string, dayOffset: number) {
  return (await db.as<{ id: string }>(NETWORK,
    "select public.location_save($1,$2,$3,'Город',null,$4,current_date+$5::int) id",
    [id, partner, name, status, dayOffset]))[0].id;
}

async function launch() {
  return (await db.as<{ launch: { stage: string; cycle?: number; completed_task_ids: string[] } | null }>(PLAY, GET, [partner]))[0].launch;
}

async function setCommercialStatus(status: string) {
  await db.as(NETWORK,
    "select public.partner_save($1,'Жизненный цикл','RU',null,null,null,$2)", [partner,status]);
}

it('starts a new opening checklist after the last operating point closes, keeping reports and previous progress', async () => {
  expect(await launch()).toEqual({ stage: 'opening_preparation', completed_task_ids: [] });
  await db.as(PLAY, CHECK, [partner,'purchase_list',true]);
  const first = await point(null,'Первая точка','active',-3);
  expect(await launch()).toBeNull();
  await db.as(PLAY, REVENUE, [first,12000,'empty',crypto.randomUUID()]);
  await point(first,'Первая точка','closed',-3);
  expect(await launch()).toBeNull();
  await db.expectError(PLAY,CHECK,'validation',[partner,'purchase_list',false]);
  expect(await db.as(PLAY, 'select total_minor from public.daily_revenue where location_id=$1', [first])).toEqual([{ total_minor: 12000 }]);

  const added = await point(null,'Новая точка','active',3);
  expect(await launch()).toMatchObject({ stage: 'opening_preparation', cycle: 1, completed_task_ids: [] });
  await db.expectError(PLAY, 'select public.partner_launch_task_set_checked($1,$2,$3,$4)',
    'version-conflict', [partner,'purchase_list',true,0]);
  await db.as(PLAY, 'select public.partner_launch_task_set_checked($1,$2,$3,$4)', [partner,'purchase_list',true,1]);
  expect(await db.admin('select cycle,task from app_private.partner_launch_task where partner_id=$1 order by cycle', [partner]))
    .toEqual([{cycle:0,task:'purchase_list'},{cycle:1,task:'purchase_list'}]);
  await point(added,'Новая точка','active',0);
  expect(await launch()).toBeNull();
  await point(added,'Новая точка','closed',0);
  expect(await launch()).toBeNull();
  await setCommercialStatus('terminated');
  await setCommercialStatus('active');
  expect(await launch()).toMatchObject({stage:'opening_preparation',cycle:2,completed_task_ids:[]});
});

it('keeps the session and reads on pause or termination while restricting operational writes', async () => {
  const other = await point(null,'Рабочая точка','active',-2);
  const staffLogin = 'lifecycle.staff@access.bron.local';
  await db.as(PLAY, "select public.staff_account_create($1,'Проверка сотрудника','lifecycle.staff','synthetic-staff-password',array[$2::uuid],false)",[partner, other]);
  const sessionId = crypto.randomUUID();
  await db.admin('insert into auth.sessions(id,user_id) values($1,$2)',[sessionId,owner]);
  await db.as(NETWORK,'select public.partner_order_url_set($1,$2)',[partner,'https://b2b.moysklad.ru/LifecycleTest']);
  const [{id: request}] = await db.admin<{id:string}>("insert into app_private.procurement_request(partner_id,created_by,shipment_mode,items) values($1,$2,'partial','[]') returning id",[partner,owner]);
  for (const status of ['suspended','terminated']) {
    await setCommercialStatus(status);
    const me = await db.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:owner,role:'authenticated',session_id:sessionId})]);
      await tx.exec('set local role authenticated');
      return (await tx.query<{ result:{user:{id:string};assignments:{role:string}[]} }>('select public.me() result')).rows[0].result;
    });
    expect(me).toMatchObject({user:{id:owner},assignments:[{role:'franchisee'}]});
    expect((await db.as<{ id: string }>(PLAY,'select id from public.location where partner_id=$1',[partner])).map(r=>r.id)).toContain(other);
    expect(await db.as(PLAY, 'select public.finance_my(current_date,null)')).toHaveLength(1);
    expect(await db.as(PLAY, 'select public.royalty_my()')).toHaveLength(1);
    expect(await launch()).toBeNull();
    await db.expectError(PLAY, REVENUE, 'forbidden', [other,15000,'empty',crypto.randomUUID()]);
    await db.expectError(PLAY,'select public.revenue_day_off_set($1,current_date-1,true)','forbidden',[other]);
    await db.expectError(PLAY, EXPENSE, 'forbidden');
    expect(await db.as(staffLogin,'select public.staff_home()')).toHaveLength(1);
    await db.expectError(staffLogin,'select public.shift_submit($1,current_date,1000,2000,$2,null)','forbidden',[other,crypto.randomUUID()]);
    expect(await db.as(PLAY,"select public.procurement_list()->'requests'->0->>'id' id")).toEqual([{id:request}]);
    await db.expectError(PLAY,"select public.procurement_action($1,1,'cancel','{\"note\":\"Проверка остановки\"}',$2)",'forbidden',[request,crypto.randomUUID()]);
    await db.expectError(PLAY, 'select public.order_link()', 'forbidden');
  }
  expect(await db.admin('select id from auth.sessions where id=$1',[sessionId])).toEqual([{id:sessionId}]);
  await setCommercialStatus('active');
  await db.as(PLAY,REVENUE,[other,15000,'empty',crypto.randomUUID()]);
  await db.as(PLAY,EXPENSE);
  expect(await db.as(PLAY,'select public.order_link()')).toHaveLength(1);
});
