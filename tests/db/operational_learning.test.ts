import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTestDb, type TestDb } from './harness';
let t: TestDb, partner: string, other: string, loc: string, article: string, tech: string;
const FM='fm@demo.example.com', OWNER='alpha.owner@demo.example.com', OTHER='beta.owner@demo.example.com';
beforeAll(async()=>{
 t=await createTestDb();
 partner=(await t.admin<{id:string}>("select id from partner where code='ALPHA'"))[0].id;
 other=(await t.admin<{id:string}>("select id from partner where code='BETA'"))[0].id;
 loc=(await t.admin<{id:string}>('select id from location where partner_id=$1 limit 1',[partner]))[0].id;
 article=(await t.admin<{id:string}>("select id from article where status='published' limit 1"))[0].id;
 tech=(await t.as<{id:string}>(FM,"select support_account_create('Техник','qa.tech','test-only-password') id"))[0].id;
},180000);
afterAll(async()=>t?.db.close());

it('technical specialist edits knowledge but cannot read partner, staff, financial or lead data',async()=>{
 const email='qa.tech@access.bron.local';
 expect((await t.as<{j:{user:unknown}}>(email,'select me() j'))[0].j.user).toBeTruthy();
 await t.as(email,'select kb_manage()');
 for(const sql of ['select partner_card($1)','select staff_list($1,current_date)','select finance_partner($1,current_date,null)']) {
  await expect(t.as(email,sql,[partner])).rejects.toThrow();
 }
 expect(await t.as(email,'select id from partner')).toEqual([]);
 expect(await t.as(email,'select id from daily_revenue')).toEqual([]);
 expect((await t.as<{lead_inbox:number}>(email,'select lead_inbox()'))[0].lead_inbox).toBe(0);
 await expect(t.as(email,'select lead_list()')).rejects.toThrow();
 await expect(t.as(email,"select support_account_create('X','other.tech','test-only-password')")).rejects.toThrow('forbidden');
});

it('routes by explicit category, isolates queues, allows controlled transfer, rejects concurrent answers',async()=>{
 const ask=async(category:string)=>(await t.as<{id:string}>(OWNER,"select kb_ask_categorized('Проверочный вопрос',$1,null) id",[category]))[0].id;
 const technical=await ask('equipment'), business=await ask('finance');
 await expect(ask('unknown')).rejects.toThrow('validation');
 const q=(await t.as<{j:{id:string;category:string;route:string}[]}>('qa.tech@access.bron.local','select kb_questions() j'))[0].j;
 expect(q.map(x=>x.id)).toContain(technical); expect(q.map(x=>x.id)).not.toContain(business);
 await expect(t.as('qa.tech@access.bron.local','select id from kb_question where id=$1',[business])).rejects.toThrow();
 await t.expectError('qa.tech@access.bron.local',"select kb_answer_checked($1,'Ответ',null,null)",'not-found',[business]);
 await t.as('qa.tech@access.bron.local',"select kb_answer_checked($1,'Ответ специалиста',null,null)",[technical]);
 await t.expectError(FM,"select kb_answer_checked($1,'Второй ответ',null,null)",'version-conflict',[technical]);
 await t.as(FM,"select kb_question_route($1,'technical')",[business]);
 expect((await t.as<{j:{id:string}[]}>('qa.tech@access.bron.local','select kb_questions() j'))[0].j.map(x=>x.id)).toContain(business);
});

it('uses supplied seven tiers at exact boundaries, preserves old shifts and snapshots new terms',async()=>{
 const cases=[[0,100000],[499999,100000],[500000,100000],[600000,114000],[800000,160000],[1000000,240000],[1300000,319000],[1800000,480000]];
 for(const [cash,earned] of cases) expect(Number((await t.admin<{v:number}>('select app_private.motivation_pay($1,app_private.motivation_default()) v',[cash]))[0].v)).toBe(earned);
 const uid=(await t.as<{id:string}>(OWNER,"select staff_account_create($1,'Новый продавец','qa.seller','test-only-password',array[$2::uuid],false) id",[partner,loc]))[0].id;
 await t.as('qa.seller@access.bron.local','select shift_open($1)',[loc]);
 const s=(await t.admin<{id:string;pay_policy:unknown}>('select id,pay_policy from work_shift where employee_id=$1',[uid]))[0];
 const oldPolicy=s.pay_policy;
 const policy=(await t.admin<{p:any}>('select app_private.motivation_default() p'))[0].p;
 await t.as(OWNER,'select motivation_set($1,$2,0)',[partner,JSON.stringify({...policy,floor_minor:150000})]);
 await t.as('qa.seller@access.bron.local','select shift_close($1,1000000,0,null)',[s.id]);
 const saved=(await t.admin<{earned_minor:number;pay_policy:unknown}>('select earned_minor,pay_policy from work_shift where id=$1',[s.id]))[0];
 expect(saved.pay_policy).toEqual(oldPolicy);expect(Number(saved.earned_minor)).toBe(240000);
 await t.expectError(OTHER,'select motivation_get($1)','forbidden',[partner]);
 await t.expectError(OWNER,'select motivation_set($1,$2,0)','version-conflict',[partner,JSON.stringify(policy)]);
 await t.expectError(OWNER,"select motivation_set($1,'{\"floor_minor\":1000,\"tiers\":[]}',1)",'validation',[partner]);
});

it('owner creates a working manager, manager cannot elevate peers or touch other partners',async()=>{
 const uid=(await t.as<{id:string}>(OWNER,"select staff_account_create($1,'Управляющий','qa.manager','test-only-password',array[$2::uuid],true) id",[partner,loc]))[0].id;
 await t.as('qa.manager@access.bron.local','select staff_home(null)');
 await t.as('qa.manager@access.bron.local','select order_link()');
 await t.expectError('qa.manager@access.bron.local',"select staff_account_create($1,'Чужой','qa.foreign','test-only-password',array[$2::uuid],false)",'forbidden',[other,loc]);
 await t.expectError('qa.manager@access.bron.local',"select staff_account_create($1,'Начальник','qa.boss','test-only-password',array[$2::uuid],true)",'forbidden',[partner,loc]);
 await t.as(OWNER,'select team_set_active($1,$2,false)',[partner,uid]);
 await t.expectError('qa.manager@access.bron.local','select staff_home(null)','forbidden');
 await t.as(OWNER,'select team_set_active($1,$2,true)',[partner,uid]);
 await t.as('qa.manager@access.bron.local','select staff_home(null)');
});

it('daily quiz hides answer keys, keeps stable assignments, grades server-side and reports real dates',async()=>{
 const revision=(await t.admin<{id:string}>('select published_revision_id id from article where id=$1',[article]))[0].id;
 const questions=[{prompt:'Выберите проверенный ответ',choices:['Верный','Неверный'],correct:0}];
 await t.as(FM,'select learning_config_set($1,true,true,$2,$3,0)',[article,JSON.stringify(questions),revision]);
 const email='qa.seller@access.bron.local';
 const one=(await t.as<{j:any}>(email,'select learning_today() j'))[0].j;
 expect(one.items).toHaveLength(1); expect(one.items[0].questions[0]).not.toHaveProperty('correct');
 const task=one.items[0];expect((await t.as<{j:any}>(email,'select learning_today() j'))[0].j.items[0].id).toBe(task.id);
 await t.expectError(OTHER,'select learning_report($1,current_date)','forbidden',[partner]);
 await t.expectError(email,'select learning_submit($1,\'[0]\')','validation',[task.id]);
 await t.as(email,'select learning_read($1)',[task.id]);
 const result=(await t.as<{j:any}>(email,"select learning_submit($1,'[0]') j",[task.id]))[0].j;
 expect(result.score).toBe(1); expect(result.total).toBe(1);
 await t.as(email,"select learning_submit($1,'[0]')",[task.id]);
 await t.expectError(email,"select learning_submit($1,'[1]')",'idempotency-conflict',[task.id]);
 const report=(await t.as<{j:any[]}>(OWNER,'select learning_report($1,current_date) j',[partner]))[0].j;
 expect(report.some(x=>x.user_name==='Новый продавец'&&x.article_title&&x.completed_at&&x.day)).toBe(true);
 await expect(t.as(email,'select article_id from app_private.learning_config')).rejects.toThrow();
});

it('all new commands reject anonymous callers and revoked sessions',async()=>{
 for(const sql of ['select learning_today()','select motivation_get(null)','select support_accounts()','select kb_questions()']) await expect(t.as(null,sql)).rejects.toThrow();
 const sid=crypto.randomUUID(); await t.admin('insert into auth.sessions(id,user_id) values($1,$2)',[sid,tech]);
 await t.as(FM,'select support_set_active($1,false)',[tech]);
 expect(await t.admin('select id from auth.sessions where id=$1',[sid])).toEqual([]);
 await t.expectError('qa.tech@access.bron.local','select kb_manage()','forbidden');
});
