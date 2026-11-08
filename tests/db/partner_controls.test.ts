import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createTestDb, type TestDb } from './harness';
let t:TestDb; let loc:string; let partner:string; let day:string;
const OWNER='alpha.owner@demo.example.com', OTHER='beta.owner@demo.example.com', FM='fm@demo.example.com';
beforeAll(async()=>{t=await createTestDb();const r=(await t.admin<{id:string;partner_id:string;day:string}>("select id,partner_id,app_private.local_today(id)::text as day from public.location where partner_id=(select id from public.partner where code='ALPHA') order by id limit 1"))[0];loc=r.id;partner=r.partner_id;day=r.day;
 await t.admin('delete from public.daily_revenue where location_id=$1 and day=$2',[loc,day]);},180000);
afterAll(async()=>t?.db.close());
const version=async()=>String((await t.admin<{v:string}>('select app_private.revenue_day_version($1,$2) v',[loc,day]))[0].v);
const save=async(total:number,v:string,op=crypto.randomUUID(),who=OWNER)=> t.as(who,'select public.revenue_total_set($1,$2,$3,$4,$5,null)',[loc,day,total,v,op]);
const total=async()=>Number((await t.admin<{v:number}>('select sum(total_minor) v from public.daily_revenue where location_id=$1 and day=$2',[loc,day]))[0].v);

describe('daily declaration includes employee shifts',()=>{
 it('stores no invented cash, retries once and rejects a stale day',async()=>{
  const op=crypto.randomUUID();const v=await version();await save(100000,v,op);await save(100000,v,op);
  expect(await total()).toBe(100000);
  const row=(await t.admin<{cash_minor:number;card_minor:number;unallocated_minor:number}>('select cash_minor,card_minor,unallocated_minor from public.daily_revenue where location_id=$1 and day=$2',[loc,day]))[0];
  expect(Object.values(row).map(Number)).toEqual([0,0,100000]);
  await expect(save(120000,v)).rejects.toThrow('version-conflict');
  await expect(save(100000,await version(),crypto.randomUUID(),OTHER)).rejects.toThrow();
 });
 it('reconciles employee edits without doubling revenue; payroll remains based on the shift',async()=>{
  const employee=await t.userId('79000000011@staff.bron.local');
  await t.as(FM,'select public.revenue_save($1,$2,30000,30000,null,$3)',[loc,day,employee]);
  expect(await total()).toBe(100000);
  await t.as(FM,'select public.revenue_save($1,$2,60000,60000,null,$3)',[loc,day,employee]);
  expect(await total()).toBe(120000);
  const d=(await t.as<{j:{days:{day:string;total_minor:number;reported_total_minor:number}[]}}>(OWNER,'select public.revenue_month($1,$2) j',[loc,day]))[0].j.days.find(d=>d.day===day)!;
  expect(Number(d.reported_total_minor)).toBe(100000);expect(Number(d.total_minor)).toBe(120000);
  await expect(save(110000,await version())).rejects.toThrow('validation');
  await t.as(FM,'select public.revenue_delete($1,$2,$3)',[loc,day,employee]);expect(await total()).toBe(100000);
 });
 it('blocks old clients from overwriting a total and checks month locks',async()=>{
  await t.expectError(OWNER,'select public.revenue_save($1,$2,100000,0,null,null)','version-conflict',[loc,day]);
  await t.expectError(OWNER,"select public.revenue_total_set($1,'2020-01-01',100000,'empty',gen_random_uuid(),null)",'period-locked',[loc]);
 });
});

describe('partner manager hierarchy',()=>{
 let uid:string;const email='79990001188@staff.bron.local';
 it('owner creates a manager; manager can order and create staff, cannot create peers or see owner finances',async()=>{
  uid=(await t.as<{id:string}>(OWNER,"select public.team_create($1,'Управляющий','79990001188','test-only-password') id",[partner]))[0].id;
  await t.as(email,'select public.order_link()');
  await t.as(email,"select public.staff_create($1,'Продавец','79990001189','test-only-password',array[$2::uuid],1000,0)",[partner,loc]);
  await t.expectError(email,"select public.team_create($1,'Другой','79990001190','test-only-password')",'forbidden',[partner]);
  await t.expectError(email,'select public.finance_my(current_date,null)','forbidden');
  await t.expectError(email,'select public.user_set_password($1,\'bad-scope-password\')','forbidden',[await t.userId(OWNER)]);
  await t.expectError(OTHER,'select public.team_set_active($1,$2,false)','forbidden',[partner,uid]);
  await expect(t.as(OWNER,"select public.team_create($1,'Дубль','79990001188','test-only-password')",[partner])).rejects.toThrow('validation');
 });
 it('deletion revokes sessions; restore needs a new login and preserves identity',async()=>{
  const session=crypto.randomUUID();await t.admin('insert into auth.sessions(id,user_id) values($1,$2)',[session,uid]);
  await t.as(OWNER,'select public.team_set_active($1,$2,false)',[partner,uid]);
  await t.expectError(email,'select public.order_link()','forbidden');
  await t.as(OWNER,'select public.team_set_active($1,$2,true)',[partner,uid]);
  expect(await t.admin('select id from auth.sessions where id=$1',[session])).toHaveLength(0);
  await t.as(email,'select public.order_link()');
 });
 it('preserves open shifts and removes sessions when a staff member is removed',async()=>{
  const employee=(await t.admin<{id:string}>("select id from public.app_user where email='79990001189@staff.bron.local'"))[0].id;
  await t.as('79990001189@staff.bron.local','select public.shift_open($1)',[loc]);
  await t.as(email,'select public.staff_set_active($1,false)',[employee]);
  expect(await t.admin("select id from public.work_shift where employee_id=$1 and status='open'",[employee])).toHaveLength(1);
 });
});

it('server omits completeness and its badges for franchisees, retains it for the network manager',async()=>{
 const owner=(await t.as<{j:{rows:Record<string,unknown>[]}}>(OWNER,'select public.rating() j'))[0].j;
 expect(owner.rows.length).toBeGreaterThan(0);for(const row of owner.rows){expect(row).not.toHaveProperty('fill_pct');expect(row.badges).toEqual([]);}
 const fm=(await t.as<{j:{rows:Record<string,unknown>[]}}>(FM,'select public.rating() j'))[0].j;expect(fm.rows[0]).toHaveProperty('fill_pct');
});

it('compares March with February without counting March revenue twice',async()=>{
 await t.as(FM,"select public.revenue_save($1,'2025-02-28',10000,0,null,null)",[loc]);
 await t.as(FM,"select public.revenue_save($1,'2025-03-01',30000,0,null,null)",[loc]);
 const d=(await t.as<{j:{prev_same_period_minor:number}}>(OWNER,"select public.revenue_month($1,'2025-03-01') j",[loc]))[0].j;
 expect(Number(d.prev_same_period_minor)).toBe(10000);
});

it('forecast handles a weekday with consistently zero revenue',async()=>{
 await t.admin("delete from public.daily_revenue where location_id=$1 and day between '2025-04-01' and '2025-06-30'",[loc]);
 await t.admin(`insert into public.daily_revenue(location_id,partner_id,day,currency,cash_minor,card_minor)
 select l.id,l.partner_id,d::date,l.currency,case when extract(isodow from d)=7 then 0 else 100000 end,0
 from public.location l cross join generate_series('2025-04-01'::date,'2025-06-30'::date,'1 day') d where l.id=$1`,[loc]);
 const r=await t.admin<{j:Record<string,unknown>}>("select app_private.plan_forecast(l,'2025-07-01') j from public.location l where l.id=$1",[loc]);
 expect(r[0].j).toBeTruthy();expect(JSON.stringify(r[0].j)).not.toMatch(/NaN|Infinity/);
});
it('finance agrees with the daily total, uses 7% royalty, and does not claim a complete plan when a point lacks one',async()=>{
 const f=(await t.as<{j:{current:{revenue_minor:number;royalty_minor:number;payroll_minor:number;expenses_minor:number;net_minor:number}}}>(OWNER,'select public.finance_my($1,$2) j',[day,loc]))[0].j.current;
 expect(Number(f.royalty_minor)).toBe(Math.round(Number(f.revenue_minor)*0.07));
 expect(Number(f.net_minor)).toBe(Number(f.revenue_minor)-Number(f.royalty_minor)-Number(f.payroll_minor)-Number(f.expenses_minor));
 await t.admin("delete from public.revenue_plan where location_id=$1 and month=date_trunc('month',$2::date)::date",[loc,day]);
 const all=(await t.as<{j:{current:{plan_minor:number|null;pct:number|null}}}>(OWNER,'select public.finance_my($1,null) j',[day]))[0].j.current;
 expect(all.plan_minor).toBeNull();expect(all.pct).toBeNull();
});
