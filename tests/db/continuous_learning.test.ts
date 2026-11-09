import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDb,type TestDb} from './harness';
let t:TestDb,p:string,loc:string,articles:{id:string;revision:string}[],uid:string;
const FM='fm@demo.example.com',OWNER='alpha.owner@demo.example.com',OTHER='beta.owner@demo.example.com',STAFF='lesson.test@access.bron.local';
const bank=Array.from({length:12},(_,i)=>({prompt:`Понятный вопрос ${i+1}?`,choices:['Верный ответ','Другой ответ'],correct:0}));
beforeAll(async()=>{
 t=await createTestDb();p=(await t.admin<{id:string}>("select id from partner where code='ALPHA'"))[0].id;
 loc=(await t.admin<{id:string}>('select id from location where partner_id=$1 limit 1',[p]))[0].id;
 articles=await t.admin<{id:string;revision:string}>("select id,published_revision_id revision from article where status='published' order by id limit 2");
 uid=(await t.as<{id:string}>(OWNER,"select staff_account_create($1,'Ученик','lesson.test','test-only-password',array[$2::uuid],false) id",[p,loc]))[0].id;
 for(const [i,a] of articles.entries()) await t.as(FM,'select learning_lesson_save($1,null,$2,$3,0)',[a.id,a.revision,JSON.stringify({for_sales:true,for_managers:true,for_trainees:true,for_franchisees:true,stage:'Начало работы',position:i+1,pass_percent:80,quiz_size:0,questions:bank})]);
},180000);
afterAll(async()=>t?.db.close());
it('daily dot is personal and does not cap the number of lessons',async()=>{
 expect((await t.as<{j:any}>(STAFF,'select learning_notice() j'))[0].j.new_day).toBe(true);
 await t.as(STAFF,'select learning_visit()');
 expect((await t.as<{j:any}>(STAFF,'select learning_notice() j'))[0].j.new_day).toBe(false);
 expect((await t.as<{j:any}>('79000000011@staff.bron.local','select learning_notice() j'))[0].j.new_day).toBe(true);
 expect((await t.as<{j:any}>(OWNER,'select learning_notice() j'))[0].j.new_day).toBe(false);
 for(const a of articles){
  const start=(await t.as<{j:any}>(STAFF,'select learning_start($1) j',[a.id]))[0].j;
  expect(start.questions).toHaveLength(12);expect(start.questions[0]).not.toHaveProperty('correct');
  expect((await t.as<{j:any}>(STAFF,'select learning_start($1) j',[a.id]))[0].j.id).toBe(start.id);
  await t.expectError(STAFF,'select learning_attempt_submit($1,$2)','validation',[start.id,JSON.stringify(Array(12).fill(0))]);
  await t.as(STAFF,'select learning_attempt_read($1)',[start.id]);
  const result=(await t.as<{j:any}>(STAFF,'select learning_attempt_submit($1,$2) j',[start.id,JSON.stringify(Array(12).fill(0))]))[0].j;
  expect(result.percent).toBe(100);expect(result.interval_days).toBe(3);
  await t.as(STAFF,'select learning_attempt_submit($1,$2)',[start.id,JSON.stringify(Array(12).fill(0))]);
  await t.expectError(STAFF,'select learning_attempt_submit($1,$2)','idempotency-conflict',[start.id,JSON.stringify(Array(12).fill(1))]);
 }
 const report=(await t.as<{j:any[]}>(OWNER,'select learning_report($1,current_date) j',[p]))[0].j;
 expect(report.filter(x=>x.user_id===uid&&x.completed_at)).toHaveLength(2);
});
it('failed attempt permits immediate reread/retry; partial pass repeats sooner',async()=>{
 const a=articles[0];
 for(const [wrong,days] of [[4,0],[1,1]] as const){
  const task=(await t.as<{j:any}>(STAFF,'select learning_start($1) j',[a.id]))[0].j;
  await t.as(STAFF,'select learning_attempt_read($1)',[task.id]);
  const result=(await t.as<{j:any}>(STAFF,'select learning_attempt_submit($1,$2) j',[task.id,JSON.stringify(bank.map((_,i)=>i<wrong?1:0))]))[0].j;
  expect(result.interval_days).toBe(days);expect(result.passed).toBe(wrong===1);
 }
});
it('local questions are scoped, version checked and corporate content stays intact',async()=>{
 const a=articles[0];
 await t.as(OWNER,'select learning_lesson_save($1,$2,$3,$4,0)',[a.id,p,a.revision,JSON.stringify({enabled:true,questions:bank})]);
 await t.expectError(OTHER,'select learning_lesson_get($1,$2)','forbidden',[a.id,p]);
 await t.expectError(STAFF,'select learning_lesson_get($1,$2)','forbidden',[a.id,p]);
 await t.expectError(OWNER,'select learning_lesson_save($1,$2,$3,$4,0)','version-conflict',[a.id,p,a.revision,JSON.stringify({enabled:true,questions:bank})]);
 const c=(await t.as<{j:any}>(FM,'select learning_lesson_get($1,null) j',[a.id]))[0].j;
 expect(c.questions).toHaveLength(12);
 expect((await t.as<{j:any}>(STAFF,'select learning_start($1) j',[a.id]))[0].j.questions).toHaveLength(24);
 await expect(t.as(STAFF,'select * from app_private.learning_attempt')).rejects.toThrow();
 await expect(t.as(null,'select learning_start($1)',[a.id])).rejects.toThrow();
 await t.expectError(OTHER,'select learning_report($1,current_date)','forbidden',[p]);
});
it('trainees default to one calendar month and 500 floor with same percentages, frozen per shift',async()=>{
 const settings={employee_kind:'trainee',internship_from:'2026-01-31',learning_enabled:true};
 await t.as(OWNER,'select staff_onboarding_set($1,$2)',[uid,JSON.stringify(settings)]);
 const s=(await t.admin<{internship_until:string;internship_floor_minor:number}>('select internship_until::text,internship_floor_minor from staff_member where user_id=$1',[uid]))[0];
 expect(String(s.internship_until).slice(0,10)).toBe('2026-02-27');expect(Number(s.internship_floor_minor)).toBe(50000);
 const policy=(await t.admin<{j:any}>('select app_private.staff_pay_policy($1,\'2026-02-27\') j',[uid]))[0].j;
 expect(policy.floor_minor).toBe(50000);expect(policy.tiers[0].rate_bp).toBe(1700);
 expect(Number((await t.admin<{n:number}>('select app_private.motivation_pay(100000,$1) n',[JSON.stringify(policy)]))[0].n)).toBe(50000);
 expect(Number((await t.admin<{n:number}>('select app_private.motivation_pay(600000,$1) n',[JSON.stringify(policy)]))[0].n)).toBe(114000);
 expect((await t.admin<{j:any}>('select app_private.staff_pay_policy($1,\'2026-02-28\') j',[uid]))[0].j.floor_minor).toBe(100000);
 await t.expectError(OTHER,'select staff_onboarding_set($1,$2)','forbidden',[uid,JSON.stringify(settings)]);
 await t.expectError(STAFF,'select staff_onboarding_set($1,$2)','forbidden',[uid,JSON.stringify(settings)]);
});
it('trainee shift freezes floor when training/pay settings change and disabled learning stays private',async()=>{
 await t.as(OWNER,"select staff_onboarding_set($1,jsonb_build_object('employee_kind','trainee','learning_enabled',true))",[uid]);
 const shift=(await t.as<{j:any}>(STAFF,'select to_jsonb(shift_open($1)) j',[loc]))[0].j;
 expect(shift.pay_policy.floor_minor).toBe(50000);
 await t.as(OWNER,"select staff_onboarding_set($1,jsonb_build_object('employee_kind','trainee','internship_floor_minor',75000,'learning_enabled',false))",[uid]);
 const closed=(await t.as<{j:any}>(STAFF,'select shift_close($1,100000,0,null) j',[shift.id]))[0].j;
 expect(Number(closed.shift.earned_minor)).toBe(50000);
 expect((await t.as<{j:any}>(STAFF,'select learning_overview() j'))[0].j.items).toEqual([]);
 await t.expectError(STAFF,'select learning_start($1)','not-found',[articles[0].id]);
});
it('global and tenant repetition settings use versions and cannot be written by a seller',async()=>{
 const policy={enabled:true,perfect:[2,8,20],passed:[1,2]};
 await t.as(OWNER,'select learning_policy_save($1,$2,0)',[p,JSON.stringify(policy)]);
 expect((await t.as<{j:any}>(OWNER,'select learning_policy_get($1) j',[p]))[0].j.policy.perfect).toEqual([2,8,20]);
 await t.expectError(OWNER,'select learning_policy_save($1,$2,0)','version-conflict',[p,JSON.stringify(policy)]);
 await t.expectError(STAFF,'select learning_policy_save($1,$2,1)','forbidden',[p,JSON.stringify(policy)]);
 await t.expectError(OTHER,'select learning_policy_get($1)','forbidden',[p]);
 await t.expectError(OWNER,'select learning_policy_get(null)','forbidden');
 const owner=(await t.as<{j:any}>(OWNER,'select learning_overview() j'))[0].j;
 // Requirement changed: owners administer staff training and never take lessons.
 expect(owner.audience).toBe('none');expect(owner.items).toEqual([]);
});
it('daily notice follows the assigned location and trainees do not skip into manager training',async()=>{
 await t.admin("update location set timezone='Pacific/Kiritimati' where id=$1",[loc]);
 await t.admin("insert into role_assignment(user_id,role,scope_type,scope_id) values($1,'franchisee_manager','partner',$2)",[uid,p]);
 await t.as(OWNER,"select staff_onboarding_set($1,jsonb_build_object('employee_kind','trainee','learning_enabled',true))",[uid]);
 const day=(await t.admin<{d:string}>('select app_private.local_today($1)::text d',[loc]))[0].d;
 expect((await t.as<{j:any}>(STAFF,'select learning_notice() j'))[0].j.day).toBe(day);
 expect((await t.as<{j:any}>(STAFF,'select learning_overview() j'))[0].j.audience).toBe('trainees');
});
