import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const MANAGER = 'fm@demo.example.com';
const OWNER = 'alpha.owner@demo.example.com';
const OTHER_OWNER = 'beta.owner@demo.example.com';
const STAFF = '79000000011@staff.bron.local';
const GET = 'select public.partner_launch_get($1) as result';
const SET = 'select public.partner_launch_task_set($1,$2,$3) as result';

interface Launch {
  stage: 'contract_signed' | 'location_search' | 'opening_preparation';
  completed_task_ids: string[];
}

let db: TestDb;
let partner: string;
let otherPartner: string;

beforeAll(async () => {
  db = await createTestDb();
  const partners = await db.admin<{ id: string; code: string }>("select id, code from public.partner where code in ('ALPHA','BETA')");
  partner = partners.find(row => row.code === 'ALPHA')!.id;
  otherPartner = partners.find(row => row.code === 'BETA')!.id;
  await db.admin("update public.location set status='closed' where partner_id=$1", [partner]);
}, 180_000);

afterAll(async () => db?.db.close());

async function stage(value: Launch['stage'] | null) {
  await db.as(MANAGER, `select public.partner_save_preparation($1,'Синтетический проект','RU',null,null,null,'active',$2)`, [partner,value]);
}

async function get(who = OWNER, id = partner) {
  return (await db.as<{ result: Launch | null }>(who, GET, [id]))[0].result;
}

async function set(task: string, completed: boolean, who = OWNER) {
  return (await db.as<{ result: Launch }>(who, SET, [partner,task,completed]))[0].result;
}

it('keeps existing partners out of the launch checklist until a preparation stage is set', async () => {
  expect(await get()).toBeNull();
  await db.expectError(OWNER, SET, 'validation', [partner,'location_requirements',true]);
  await stage('contract_signed');
  expect(await get()).toEqual({ stage: 'contract_signed', completed_task_ids: [] });
  expect(await get(OTHER_OWNER, otherPartner)).toBeNull();
  for (const actor of [OTHER_OWNER, STAFF]) {
    await db.expectError(actor, GET, 'not-found', [partner]);
    await db.expectError(actor, SET, 'not-found', [partner,'location_requirements',true]);
  }
  await expect(db.as(null, GET, [partner])).rejects.toThrow(/permission denied/);
  await expect(db.as(OWNER, 'select * from app_private.partner_launch_task')).rejects.toThrow(/permission denied/);
  await expect(db.as(OTHER_OWNER, "select app_private.partner_launch_view($1,'contract_signed')", [partner])).rejects.toThrow(/permission denied/);
});

it('lets the owner and network manager complete and reopen tasks without changing stages or locations', async () => {
  await stage('location_search');
  const beforePoints = await db.admin('select id,status,opened_on from public.location where partner_id=$1 order by id', [partner]);
  await db.expectError(OWNER, SET, 'validation', [partner,'island_design',true]);
  await db.expectError(OWNER, SET, 'validation', [partner,'invented_task',true]);
  expect(await set('location_requirements', true)).toEqual({ stage: 'location_search', completed_task_ids: ['location_requirements'] });
  await set('location_requirements', true);
  await set('location_review', true, MANAGER);
  expect(await get(MANAGER)).toEqual({ stage: 'location_search', completed_task_ids: ['location_requirements','location_review'] });
  expect((await set('location_review', false)).completed_task_ids).toEqual(['location_requirements']);
  await set('location_review', false);
  expect(await db.admin(`select id from public.audit_event where action='partner.launch_task' and entity_id=$1`, [partner])).toHaveLength(3);
  expect(await db.admin('select id,status,opened_on from public.location where partner_id=$1 order by id', [partner])).toEqual(beforePoints);
});

it('rejects checklist reads and writes from a revoked session', async () => {
  await stage('location_search');
  const owner = await db.userId(OWNER);
  const session = 'a0000000-0000-0000-0000-000000000003';
  await db.admin('insert into auth.sessions(id,user_id) values ($1,$2)', [session, owner]);
  const withSession = (sql: string, params: unknown[]) => db.db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: owner, role: 'authenticated', session_id: session })]);
    await tx.exec('set local role authenticated');
    return tx.query(sql, params);
  });
  expect((await withSession(GET, [partner])).rows[0]).toMatchObject({ result: { stage: 'location_search' } });
  await db.admin('delete from auth.sessions where id=$1', [session]);
  await expect(withSession(GET, [partner])).rejects.toThrow('unauthenticated');
  await expect(withSession(SET, [partner, 'launch_learning', true])).rejects.toThrow('unauthenticated');
});

it('allows a direct start at island design and preserves earlier progress when changing stages', async () => {
  await stage('opening_preparation');
  await db.expectError(OWNER, SET, 'validation', [partner,'location_options',true]);
  expect((await set('island_design', true)).completed_task_ids).toEqual(['island_design','location_requirements']);
  expect((await set('purchase_list', true, MANAGER)).stage).toBe('opening_preparation');
  await stage(null);
  expect(await get()).toBeNull();
  await stage('opening_preparation');
  expect((await get())?.completed_task_ids).toEqual(['island_design','location_requirements','purchase_list']);
});

it('keeps planned points in the checklist, then returns to working Home when opening is recorded', async () => {
  await stage('opening_preparation');
  const point = (await db.as<{ id: string }>(MANAGER,
    "select public.location_save(null,$1,'Подготовка островка','Тестовый город',null,'active',null) as id", [partner]))[0].id;
  expect((await get())?.stage).toBe('opening_preparation');
  await db.admin('update public.location set opened_on=(now() at time zone timezone)::date+1 where id=$1', [point]);
  expect((await get())?.stage).toBe('opening_preparation');
  await db.admin('update public.location set opened_on=(now() at time zone timezone)::date where id=$1', [point]);
  expect(await get()).toBeNull();
  await db.expectError(OWNER, SET, 'validation', [partner,'purchase_list',false]);
  expect(await db.admin('select preparation_stage from public.partner where id=$1', [partner])).toEqual([{ preparation_stage: 'opening_preparation' }]);

  await db.admin("update public.location set status='closed' where id=$1", [point]);
  await db.admin("update public.location set opened_on=null,status='active' where code='ALPHA-1'");
  expect(await get()).toBeNull();
});

it('uses the scheduled opening date even if an earlier operation exists', async () => {
  await stage('opening_preparation');
  await db.admin(`update location set opened_on=(now() at time zone timezone)::date+1 where code='ALPHA-1'`);
  const [{ count }] = await db.admin<{ count: number }>(`select count(*)::int from daily_revenue
    where location_id=(select id from location where code='ALPHA-1')`);
  expect(count).toBeGreaterThan(0);
  expect(await get()).toMatchObject({ stage: 'opening_preparation' });
});
