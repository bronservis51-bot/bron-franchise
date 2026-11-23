import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { calculatePay, type PayPolicy } from '../../src/modules/staff/Motivation';

const OWNER='alpha.owner@demo.example.com', OTHER='beta.owner@demo.example.com', STAFF='daily.pay@access.bron.local';
let t: TestDb, partner: string, location: string, user: string;
const result=async(email:string,sql:string,args:unknown[]=[]) => (await t.as<{j:any}>(email,`${sql} j`,args))[0].j;
beforeAll(async()=>{
 t=await createTestDb();
 partner=(await t.admin<{id:string}>("select id from partner where code='ALPHA'"))[0].id;
 location=(await t.admin<{id:string}>('select id from location where partner_id=$1 and status=\'active\' order by id limit 1',[partner]))[0].id;
 user=(await t.as<{id:string}>(OWNER,"select staff_account_create($1,'Дневной расчёт','daily.pay','test-only-password',array[$2::uuid],false) id",[partner,location]))[0].id;
},180_000);
afterAll(async()=>t?.db.close());

it('uses owner photo tiers per daily revenue, including every exact boundary and each bonus',async()=>{
 const p=(await t.admin<{p:PayPolicy}>("select app_private.motivation_default('RUB') p"))[0].p;
 expect((await t.admin<{same:boolean}>("select app_private.motivation_default('TRY')=app_private.motivation_default() and app_private.motivation_default('KZT')=app_private.motivation_default() same"))[0].same).toBe(true);
 // Monetary values in minor units. The 1000 RUB existing minimum is retained.
 const cases=[[0,100000],[100000,100000],[799999,128000],[800000,136000],[999999,170000],
  [1000000,180000],[1299999,234000],[1300000,247000],[1599999,304000],
  [1600000,324000],[1899999,381000],[1900000,400000],[2299999,480000],[2300000,513000]];
 for(const [revenue,pay] of cases){
  const actual=(await t.admin<{pay:number}>('select app_private.motivation_pay($1,$2) pay',[revenue,JSON.stringify(p)]))[0].pay;
  expect(Number(actual),`cash ${revenue}`).toBe(pay);
  expect(calculatePay(BigInt(revenue),0,0,p),`UI cash ${revenue}`).toBe(BigInt(pay));
 }
 expect(calculatePay(1000000n,1000,50000,null)).toBe(150000n); // Fixed + percent remains additive.
 expect(calculatePay(1000000n,0,0,{mode:'legacy',rate_bp:1000,fee_minor:50000})).toBe(150000n);
});

it('trainee receives 500 RUB minimum and the same daily tier percentages; history never reprices',async()=>{
 await t.as(OWNER,"select staff_onboarding_set($1,jsonb_build_object('employee_kind','trainee','learning_enabled',false))",[user]);
 const opened=await result(STAFF,'select to_jsonb(shift_open($1))',[location]);
 expect(opened.pay_policy.floor_minor).toBe(50000);
 expect(opened.pay_policy.tiers.map((tier:any)=>tier.rate_bp)).toEqual([1600,1700,1800,1900,1900,2000,2100]);
 const custom={...opened.pay_policy,floor_minor:75000,tiers:[{from_minor:0,rate_bp:1000,bonus_minor:0}]};
 await t.as(OWNER,'select motivation_set($1,$2,0)',[partner,JSON.stringify(custom)]);
 const closed=await result(STAFF,'select shift_close_versioned($1,100000,0,$2,$3,null)',[opened.id,opened.revision,crypto.randomUUID()]);
 expect(closed.shift.pay_policy).toEqual(opened.pay_policy);
 expect(Number(closed.shift.earned_minor)).toBe(50000);
 const history=await result(STAFF,'select staff_home(null)');
 expect(history.shifts.find((row:any)=>row.id===opened.id).earned_minor).toBe(50000);
 expect((await result(OWNER,'select motivation_get($1)',[partner])).policy).toEqual(custom);
});

it('self-correction is audited, revises once, retains first close and is blocked after 5 minutes',async()=>{
 const w=(await t.admin<{id:string;revision:number}>('select id,revision from work_shift where employee_id=$1 and status=\'closed\'',[user]))[0];
 // Place first close 4m59s ago, well inside the server-clock window.
 await t.admin("update work_shift set closed_at=clock_timestamp()-interval '4 minutes 59 seconds' where id=$1",[w.id]);
 const before=(await t.admin<{revision:number;closed_at:string}>('select revision,closed_at from work_shift where id=$1',[w.id]))[0];
 const op=crypto.randomUUID();
 const edited=await result(STAFF,'select shift_close_versioned($1,200000,100000,$2,$3,\'Исправил выручку\')',[w.id,before.revision,op]);
 expect(Number(edited.shift.total_minor)).toBe(300000);
 expect(edited.shift.revision).toBe(Number(before.revision)+1);
 expect(new Date(edited.shift.closed_at).getTime()).toBe(new Date(before.closed_at).getTime());
 const audit=(await t.admin<{diff:any}>("select diff from audit_event where action='shift.correct' and entity_id=$1",[w.id]))[0];
 expect(audit.diff.before.cash).toBe(100000);expect(audit.diff.after.cash).toBe(200000);
 expect(audit.diff.before.revision).toBe(before.revision);
 expect(Number((await t.admin<{n:number}>('select sum(total_minor) n from daily_revenue where employee_id=$1',[user]))[0].n)).toBe(300000);
 await t.expectError(STAFF,"select shift_close_versioned($1,1,0,$2,$3,null)",'version-conflict',[w.id,before.revision,crypto.randomUUID()]);
 await t.admin("update work_shift set closed_at=clock_timestamp()-interval '5 minutes' where id=$1",[w.id]);
 const expired=(await t.admin<{revision:number}>('select revision from work_shift where id=$1',[w.id]))[0].revision;
 await t.expectError(STAFF,'select shift_close_versioned($1,400000,0,$2,$3,null)','period-locked',[w.id,expired,crypto.randomUUID()]);
 await t.expectError(STAFF,'select shift_close($1,400000,0,null)','period-locked',[w.id]);
 // A queued network retry returns its original confirmed result even after expiry.
 expect(await result(STAFF,'select shift_close_versioned($1,200000,100000,$2,$3,\'Исправил выручку\')',[w.id,before.revision,op])).toEqual(edited);
 expect((await t.admin("select id from audit_event where action='shift.correct' and entity_id=$1",[w.id]))).toHaveLength(1);
 await t.expectError(OTHER,'select shift_close($1,500000,0,null)','forbidden',[w.id]);
 await expect(t.as(null,'select shift_close($1,500000,0,null)',[w.id])).rejects.toThrow();
 // Supervisor corrections keep their existing authority, rather than reopening the employee window.
 const day=(await t.admin<{d:string}>('select day::text as d from work_shift where id=$1',[w.id]))[0].d;
 await t.as(OWNER,"select revenue_save($1,$2::date,400000,0,'Сверено руководителем',$3)",[location,day,user]);
 expect(Number((await t.admin<{n:number}>('select total_minor n from work_shift where id=$1',[w.id]))[0].n)).toBe(400000);
});

it('missing report stays absent, explicit zero is recorded, and previous months remain available separately',async()=>{
 const yesterday=(await t.admin<{d:string}>("select (app_private.local_today($1)-1)::text as d",[location]))[0].d;
 const open=(await t.admin<{id:string}>('insert into work_shift(partner_id,location_id,employee_id,day) values($1,$2,$3,$4) returning id',[partner,location,user,yesterday]))[0];
 expect((await t.admin('select id from daily_revenue where employee_id=$1 and day=$2',[user,yesterday]))).toHaveLength(0);
 await t.expectError(STAFF,'select shift_close($1,null,0,null)','validation',[open.id]);
 const zero=await result(STAFF,'select shift_close($1,0,0,null)',[open.id]);
 expect(Number(zero.shift.total_minor)).toBe(0);expect(Number(zero.shift.earned_minor)).toBe(100000); // Yesterday precedes both the internship and the dated team policy change.
 const previousMonth=(await t.admin<{m:string}>("select (date_trunc('month',app_private.local_today($1))-interval '1 month')::date::text as m",[location]))[0].m;
 await t.as(OWNER,"select staff_terms_set($1,'Дневной расчёт',array[$2::uuid],1000,50000,false)",[user,location]);
 const historical=(await t.admin<{id:string}>(`insert into work_shift(partner_id,location_id,employee_id,day,status,closed_at,cash_minor,card_minor,pay_policy)
  values($1,$2,$3,$4,'closed',now()-interval '1 month',500000,0,'{"mode":"legacy","rate_bp":1000,"fee_minor":50000}') returning id`,[partner,location,user,previousMonth]))[0];
 const history=await result(STAFF,'select staff_home($1::date)',[previousMonth]);
 expect(history.month_shifts).toBe(1);expect(Number(history.month_earned_minor)).toBe(100000);
 expect(history.shifts.map((row:any)=>row.id)).toEqual([historical.id]);
 expect((await result(STAFF,'select staff_home(null)')).shifts.map((row:any)=>row.id)).not.toContain(historical.id);
});
