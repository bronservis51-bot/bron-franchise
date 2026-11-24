import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const owner = 'alpha.owner@demo.example.com';
const fixed = { name: 'Старшая смена', mode: 'legacy', fee_minor: 12000, rate_bp: 550 };
const tiers = { name: 'Команда', floor_minor: 45000, tiers: [{ from_minor: 0, rate_bp: 750, bonus_minor: 1000 }] };
const save = 'select public.pay_scheme_save($1,$2,$3,$4,$5) as id';
const pick = 'select public.pay_scheme_apply($1,$2,$3,$4,$5,$6,$7)';
let db: TestDb, partner: string, other: string, point: string, seller: string, supervisor: string, today: string, tomorrow: string;
let f: string, t: string;
beforeAll(async () => {
  db = await createTestDb();
  [{ id: partner }, { id: other }] = await db.admin<{id:string}>("select id from partner where code in ('ALPHA','BETA') order by code");
  [{ id: point }] = await db.admin<{id:string}>('select id from location where partner_id=$1 order by id limit 1', [partner]);
  [{ today, tomorrow }] = await db.admin<{today:string;tomorrow:string}>('select d::text today,(d+1)::text tomorrow from app_private.partner_pay_today($1) d',[partner]);
  [{ id: seller }] = await db.as<{id:string}>(owner,"select staff_account_create($1,'Продавец','named.pay.seller','test-password',array[$2::uuid],false) id",[partner,point]);
  [{ id: supervisor }] = await db.as<{id:string}>(owner,"select staff_account_create($1,'Управляющий','named.pay.manager','test-password',array[$2::uuid],true) id",[partner,point]);
  await db.admin(`update staff_member set checked_access='{"view_staff":false,"create_staff":false,"procurement":false,"manage_pay":true}' where user_id=$1`,[supervisor]);
},180000);
afterAll(() => db?.db.close());
const manager = 'named.pay.manager@access.bron.local';
async function policy(user:string,date:string) { return (await db.admin<{p:unknown}>('select app_private.staff_pay_policy($1,$2) p',[user,date]))[0].p; }

it('creates partner-local fixed and tier schemes; stale and unauthorized catalogue writes do not alter them',async()=>{
  [{ id:f }] = await db.as<{id:string}>(owner,save,[partner,null,0,fixed,true]);
  [{ id:t }] = await db.as<{id:string}>(owner,save,[partner,null,0,tiers,true]);
  await db.expectError(owner,save,'version-conflict',[partner,f,0,fixed,true]);
  await db.expectError(owner,save,'validation',[partner,null,0,{...fixed,name:tiers.name},true]);
  await db.expectError(manager,save,'forbidden',[partner,f,1,fixed,false]);
  await db.expectError(owner,'select pay_scheme_list($1)','forbidden',[other]);
  const [{ v }] = await db.as<{v:{id:string}[]}>(manager,'select pay_scheme_list($1) v',[partner]);
  expect(v.map(r=>r.id)).toEqual(expect.arrayContaining([f,t]));
});

it('dates a named common scheme, snapshots a distinct personal formula, and does not propagate later template edits',async()=>{
  const before = await policy(seller,today);
  await db.as(owner,pick,[partner,f,1,null,tomorrow,0,null]);
  expect(await policy(seller,today)).toEqual(before);
  expect(await policy(seller,tomorrow)).toEqual(fixed);
  await db.expectError(manager,pick,'forbidden',[partner,t,1,null,today,1,null]);
  const [{ rev }] = await db.admin<{rev:number}>('select pay_revision rev from staff_member where user_id=$1',[seller]);
  await db.as(manager,pick,[partner,t,1,seller,today,rev,null]);
  expect(await policy(seller,tomorrow)).toEqual(tiers);
  await db.as(owner,save,[partner,t,1,{...tiers,name:'Обновлённая',floor_minor:99000},false]);
  expect(await policy(seller,tomorrow)).toEqual(tiers);
  await db.expectError(manager,pick,'version-conflict',[partner,t,1,seller,today,rev+1,null]);
  await db.expectError(manager,pick,'validation',[partner,t,2,seller,today,rev+1,null]);
  await db.expectError(manager,pick,'forbidden',[partner,f,1,supervisor,today,0,null]);
});

it('keeps accepted earnings when personal terms change and honours later manual fixed edits',async()=>{
  const email='named.pay.seller@access.bron.local';
  const [{ id }] = await db.as<{id:string}>(email,'select (public.shift_open($1)).id',[point]);
  await db.as(email,'select public.shift_close($1,100000,0,null)',[id]);
  const [{ rev }] = await db.admin<{rev:number}>('select pay_revision rev from staff_member where user_id=$1',[seller]);
  await db.as(owner,pick,[partner,f,1,seller,today,rev,null]);
  expect(await policy(seller,today)).toEqual(fixed);
  const [closed]=await db.admin('select pay_policy,earned_minor::int from work_shift where id=$1',[id]);
  expect(closed).toEqual({pay_policy:tiers,earned_minor:46000});
  await db.admin('update staff_member set rate_bp=625 where user_id=$1',[seller]);
  expect(await policy(seller,today)).toEqual({mode:'legacy',fee_minor:12000,rate_bp:625});
});

it('creates a profile with the selected fixed scheme and uses the temporary personal guarantee on a common fixed plan',async()=>{
  const [{ id }]=await db.as<{id:string}>(owner,
    "select public.staff_profile_save_scheme($1,null,'Новая смена','79032222101','test-password',array[$2::uuid],$3,1,jsonb_build_object('employee_kind','employee','learning_enabled',true)) id",
    [partner,point,f]);
  expect(await policy(id,today)).toEqual(fixed);
  await db.expectError(owner,
    "select public.staff_profile_save_scheme($1,$2,'Новая смена','','',array[$3::uuid],$4,1,'{}')",
    'version-conflict',[partner,id,point,f]);
  await db.as(owner,"select public.staff_onboarding_set($1,jsonb_build_object('employee_kind','trainee','learning_enabled',false,'internship_from',$2::date,'internship_floor_minor',60000))",[id,today]);
  expect(await policy(id,tomorrow)).toEqual({...fixed,fee_minor:60000});
});

it('distinguishes effective individual terms from a future named common scheme in the roster',async()=>{
  const [{rev}]=await db.admin<{rev:number}>('select pay_revision rev from staff_member where user_id=$1',[seller]);
  await db.as(owner,pick,[partner,f,1,seller,today,rev,null]);
  await db.as(owner,'select staff_pay_save($1,$2,550,12000,true,null,$3,$4,null)',[partner,seller,tomorrow,rev+1]);
  const [{v}]=await db.as<{v:{pay_current_common:boolean; pay_policy:unknown;pay_scheduled:{name:string;common:boolean}[]}}>(owner,
    'select row v from jsonb_array_elements(public.staff_list($1,$2)) row where row->>\'user_id\'=$3',[partner,today,seller]);
  expect(v.pay_current_common).toBe(false);
  expect(v.pay_policy).toEqual(fixed);
  expect(v.pay_scheduled).toContainEqual(expect.objectContaining({common:true,name:fixed.name}));
});
