import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDb,type TestDb} from './harness';
let t:TestDb,p:string,l:string,u:string;
const OWNER='alpha.owner@demo.example.com',OTHER='beta.owner@demo.example.com',STAFF='shift.qa@access.bron.local';
const run=async(sql:string,args:unknown[]=[]) => (await t.as<{j:any}>(STAFF,sql+' j',args))[0].j;
beforeAll(async()=>{t=await createTestDb();p=(await t.admin<{id:string}>("select id from partner where code='ALPHA'"))[0].id;l=(await t.admin<{id:string}>('select id from location where partner_id=$1 limit 1',[p]))[0].id;u=(await t.as<{id:string}>(OWNER,"select staff_account_create($1,'Тест смен','shift.qa','test-only-password',array[$2::uuid],false) id",[p,l]))[0].id;},180000);
afterAll(async()=>t?.db.close());
it('repeat opening returns the same shift; cancel is audited and never creates revenue',async()=>{
 const a=await run('select to_jsonb(shift_open($1))',[l]);const b=await run('select to_jsonb(shift_open($1))',[l]);expect(b.id).toBe(a.id);
 await t.as(STAFF,'select shift_cancel($1)',[a.id]);
 expect((await t.admin('select id from work_shift where id=$1',[a.id]))).toEqual([]);
 expect((await t.admin("select id from audit_event where action='shift.cancel' and entity_id=$1",[a.id]))).toHaveLength(1);
 expect((await t.admin('select id from daily_revenue where employee_id=$1',[u]))).toEqual([]);
});
it('each correction advances revision, preserves real closing time and rejects stale edits/retries',async()=>{
 const a=await run('select to_jsonb(shift_open($1))',[l]);const op=crypto.randomUUID();
 await t.expectError(STAFF,'select shift_close_versioned($1,null,0,0,$2,null)','validation',[a.id,crypto.randomUUID()]);
 const close=await run('select shift_close_versioned($1,200000,100000,$2,$3,null)',[a.id,a.revision,op]);
 expect(close.shift.revision).toBe(1);
 expect(await run('select shift_close_versioned($1,200000,100000,$2,$3,null)',[a.id,a.revision,op])).toEqual(close);
 await t.expectError(STAFF,'select shift_close_versioned($1,300000,0,$2,$3,null)','version-conflict',[a.id,0,crypto.randomUUID()]);
 const edit=await run('select shift_close_versioned($1,400000,0,1,$2,null)',[a.id,crypto.randomUUID()]);
 expect(edit.shift.revision).toBe(2);expect(edit.shift.closed_at).toBe(close.shift.closed_at);
 await t.expectError(STAFF,'select shift_close_versioned($1,500000,0,1,$2,null)','version-conflict',[a.id,crypto.randomUUID()]);
 expect(Number((await t.admin<{n:number}>('select sum(total_minor) n from daily_revenue where employee_id=$1',[u]))[0].n)).toBe(400000);
 await t.expectError(STAFF,'select shift_cancel($1)','not-found',[a.id]);
});
it('an owner can resolve an old open shift explicitly; foreign tenant, self and stale state are rejected',async()=>{
 const id=crypto.randomUUID();await t.admin("insert into work_shift(id,partner_id,location_id,employee_id,day,opened_at) values($1,$2,$3,$4,current_date-1,now()-interval '1 day')",[id,p,l,u]);
 await t.expectError(OTHER,"select staff_shift_resolve($1,'close',100000,0,0,'Забыли закрыть',$2)",'forbidden',[id,crypto.randomUUID()]);
 await t.expectError(STAFF,"select staff_shift_resolve($1,'close',100000,0,0,'Забыли закрыть',$2)",'forbidden',[id,crypto.randomUUID()]);
 await t.expectError(OWNER,"select staff_shift_resolve($1,'close',100000,0,0,'',$2)",'validation',[id,crypto.randomUUID()]);
 const op=crypto.randomUUID();await t.as(OWNER,"select staff_shift_resolve($1,'close',100000,0,0,'Сверили итог с сотрудником',$2)",[id,op]);
 await t.as(OWNER,"select staff_shift_resolve($1,'close',100000,0,0,'Сверили итог с сотрудником',$2)",[id,op]);
 expect((await t.admin<{status:string}>('select status from work_shift where id=$1',[id]))[0].status).toBe('closed');
 expect((await t.admin('select id from daily_revenue where employee_id=$1 and day=current_date-1',[u]))).toHaveLength(1);
});
it('training belongs to staff only while owners retain team management',async()=>{
 const overview=(await t.as<{j:any}>(OWNER,'select learning_overview() j'))[0].j;expect(overview.items).toEqual([]);expect(overview.audience).toBe('none');
 expect((await t.as<{j:any}>(OWNER,'select learning_notice() j'))[0].j.new_day).toBe(false);
 await t.as(OWNER,'select learning_catalog($1)',[p]);
 await t.expectError(STAFF,'select learning_catalog($1)','forbidden',[p]);
});
it('an open shift cannot bypass a closed financial month; public role/session boundaries stay closed',async()=>{
 const id=crypto.randomUUID();await t.admin("insert into work_shift(id,partner_id,location_id,employee_id,day) values($1,$2,$3,$4,(date_trunc('month',current_date)-interval '2 months')::date)",[id,p,l,u]);
 await t.expectError(STAFF,'select shift_close($1,100000,0,null)','period-locked',[id]);
 await expect(t.as(null,'select staff_open_shifts($1)',[p])).rejects.toThrow();
 await t.expectError(OTHER,'select staff_open_shifts($1)','forbidden',[p]);
 await t.as(OWNER,'select staff_set_active($1,false)',[u]);
 await t.expectError(STAFF,'select shift_cancel($1)','forbidden',[id]);
});
