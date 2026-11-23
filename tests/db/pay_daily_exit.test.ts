import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const owner='alpha.owner@demo.example.com';
const email='daily.exit@access.bron.local';
let db: TestDb, partner: string, left: string, right: string, user: string, today: string;
beforeAll(async () => {
  db=await createTestDb();
  [{ id:partner }]=await db.admin<{id:string}>("select id from partner where code='ALPHA'");
  [{id:left},{id:right}]=await db.admin<{id:string}>(`insert into location(code,name,city,partner_id,currency,opened_on,timezone)
    values ('qa-exit-left','Левая','Город',$1,'RUB','2020-01-01','UTC'),('qa-exit-right','Правая','Город',$1,'RUB','2020-01-01','UTC') returning id`,[partner]);
  [{id:user}]=await db.as<{id:string}>(owner,"select staff_account_create($1,'Выход в двух точках','daily.exit','test-password',array[$2::uuid,$3::uuid],false) id",[partner,left,right]);
  [{today}]=await db.admin<{today:string}>('select app_private.local_today($1)::text today',[left]);
});
afterAll(async()=>db?.db.close());

it('counts one exit, keeps both locations revenue and prevents a second fixed fee on correction or replay',async()=>{
  await db.as(owner,"select staff_terms_set($1,'Выход в двух точках',array[$2::uuid,$3::uuid],1000,50000,false)",[user,left,right]);
  type Receipt={shift:{id:string;earned_minor:number;counts_as_exit:boolean;revision:number};month_shifts:number};
  const submit=async(point:string,operation:string)=>(await db.as<{s:Receipt}>(email,'select shift_submit($1,$2,10000,0,$3) s',[point,today,operation]))[0].s;
  const one=await submit(left,crypto.randomUUID());
  const home=(await db.as<{r:{locations:{location_id:string;pay_today:{fee_minor:number}}[]}}>(email,'select staff_home(null) r'))[0].r;
  expect(home.locations.find(p=>p.location_id===right)?.pay_today.fee_minor).toBe(0);
  const op=crypto.randomUUID(),two=await submit(right,op);
  expect(one.shift.earned_minor).toBe(51000);
  expect(two.shift).toMatchObject({earned_minor:1000,counts_as_exit:false});
  expect(two.month_shifts).toBe(1);
  expect(await submit(right,op)).toEqual(two);
  await db.as(owner,'select staff_shift_correct($1,20000,0,$2,$3,$4)',[two.shift.id,two.shift.revision,'Изменена сумма',crypto.randomUUID()]);
  expect((await db.admin<{n:number}>('select earned_minor n from work_shift where id=$1',[two.shift.id]))[0].n).toBe(2000);
  expect((await db.admin<{n:number}>('select sum(total_minor)::int n from daily_revenue where employee_id=$1 and day=$2',[user,today]))[0].n).toBe(30000);
  await db.as(owner,'select revenue_delete($1,$2,$3)',[left,today,user]);
  const [withReturn]=await db.admin<{earned_minor:number;counts_as_exit:boolean;pay_policy:{fee_minor:number}}>(
    'update work_shift set return_minor=10000 where id=$1 returning earned_minor,counts_as_exit,pay_policy',[two.shift.id]);
  expect(withReturn).toMatchObject({earned_minor:2000,counts_as_exit:false,pay_policy:{fee_minor:0}});
});

it('pays the second point its own tier percentage and bonus, without another trainee minimum', async () => {
  const yesterday = (await db.admin<{ d: string }>('select ($1::date-1)::text d',[today]))[0].d;
  await db.as(owner,'select motivation_set($1,$2,0)',[partner,{effective_from:yesterday,floor_minor:100000,
    tiers:[{from_minor:0,rate_bp:1100,bonus_minor:0},{from_minor:20000,rate_bp:1250,bonus_minor:1333}]}]);
  await db.as(owner,"select staff_profile_save_phone($1,$2,'Выход в двух точках','','',array[$3::uuid,$4::uuid],1000,50000,false,$5)",
    [user,partner,left,right,{employee_kind:'trainee',internship_from:yesterday,internship_until:yesterday,internship_floor_minor:30000,
      pay_effective_from:yesterday,learning_enabled:true}]);
  const submit = async (point:string,sales:number)=>(await db.as<{s:{shift:{earned_minor:number;counts_as_exit:boolean}}}>(email,
    'select shift_submit($1,$2,$3,0,$4) s',[point,yesterday,sales,crypto.randomUUID()]))[0].s.shift;
  expect(await submit(right,0)).toMatchObject({earned_minor:30000,counts_as_exit:true});
  expect(await submit(left,20000)).toMatchObject({earned_minor:3833,counts_as_exit:false});
});
