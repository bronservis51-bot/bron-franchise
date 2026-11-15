import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDb,type TestDb} from './harness';
let t:TestDb,partner:string,other:string,a:string,b:string,day:string,manager:string,one:string,two:string,rotating:string;
const OWNER='alpha.owner@demo.example.com',OTHER='beta.owner@demo.example.com',FM='fm@demo.example.com';
const M='scope.manager@access.bron.local',ONE='scope.one@access.bron.local';
const create=async(login:string,locations:string[],isManager=false)=>(await t.as<{id:string}>(OWNER,'select staff_account_create($1,$2,$3,$4,$5,$6) id',[partner,login,login,'test-only-password',locations,isManager]))[0].id;
beforeAll(async()=>{
 t=await createTestDb();
 partner=(await t.admin<{id:string}>("select id from partner where code='ALPHA'"))[0].id;
 other=(await t.admin<{id:string}>("select id from partner where code='BETA'"))[0].id;
 a=(await t.admin<{id:string}>('select id from location where partner_id=$1 order by id limit 1',[partner]))[0].id;
 b=(await t.admin<{id:string}>("insert into location(partner_id,code,name,city,currency,timezone,status,opened_on) values($1,'SCOPE-ROTATION','Вторая точка для ротации','Москва','RUB','Europe/Moscow','active',current_date-30) returning id",[partner]))[0].id;
 day=(await t.admin<{day:string}>('select app_private.local_today($1)::text as day',[a]))[0].day;
 manager=await create('scope.manager',[a],true);one=await create('scope.one',[a]);two=await create('scope.two',[b]);rotating=await create('scope.rotation',[a,b]);
 await t.as(FM,'select revenue_save($1,$2,100000,0,null,$3)',[a,day,rotating]);
 await t.as(FM,'select revenue_save($1,$2,300000,0,null,$3)',[b,day,rotating]);
},180000);
afterAll(async()=>t?.db.close());

it('a point manager orders for own company and cannot grant roles, read owner finances or cross partners',async()=>{
 await t.as(M,'select order_link()');
 await t.expectError(M,'select staff_list($1,current_date)','forbidden',[other]);
 await t.expectError(M,'select team_revenue_month($1,current_date)','forbidden',[other]);
 await t.expectError(M,'select staff_access_set($1,$2,true,array[$3::uuid])','forbidden',[partner,one,a]);
 await t.expectError(M,'select finance_my(current_date,$1)','forbidden',[a]);
 await t.expectError(M,'select revenue_month($1,current_date)','forbidden',[a]);
 await t.expectError(M,"select motivation_set($1,'{\"floor_minor\":100000,\"tiers\":[{\"from_minor\":0,\"rate_bp\":1600,\"bonus_minor\":0}]}',0)",'forbidden',[partner]);
});
it('direct point/staff reads and monthly payroll expose only assigned points, including rotating staff',async()=>{
 const locations=await t.as<{id:string}>(M,'select id from location where partner_id=$1',[partner]);
 expect(locations.map(x=>x.id)).toEqual([a]);
 const list=(await t.as<{j:any[]}>(M,'select staff_list($1,current_date) j',[partner]))[0].j;
 expect(list.map(x=>x.user_id)).toContain(one);expect(list.map(x=>x.user_id)).toContain(rotating);expect(list.map(x=>x.user_id)).not.toContain(two);
 const rotation=list.find(x=>x.user_id===rotating);
 expect(rotation.location_ids).toEqual([a]);expect(Number(rotation.month_revenue_minor)).toBe(100000);expect(rotation.shifts).toHaveLength(1);expect(rotation.can_manage).toBe(false);
 expect(await t.as(M,'select user_id from staff_member where user_id=$1',[two])).toEqual([]);
 expect(await t.as(M,'select location_ids from staff_member where user_id=$1',[rotating])).toEqual([]);
 expect(await t.as(M,'select id from work_shift where location_id=$1',[b])).toEqual([]);
 const revenue=(await t.as<{j:any[]}>(M,'select team_revenue_month($1,current_date) j',[partner]))[0].j;
 expect(revenue).toHaveLength(1);expect(revenue[0].location_id).toBe(a);
 expect(revenue[0].days.some((d:any)=>d.day===day&&Number(d.total_minor)>=100000)).toBe(true);
});
it('managers may create/manage staff at own points but cannot move staff outside scope or alter rotating staff global access',async()=>{
 await t.as(M,"select staff_account_create($1,'Новый сотрудник','scope.new','test-only-password',array[$2::uuid],false)",[partner,a]);
 await t.expectError(M,"select staff_account_create($1,'Чужая точка','scope.wrong','test-only-password',array[$2::uuid],false)",'forbidden',[partner,b]);
 await t.as(M,"select staff_update($1,'Имя сотрудника',array[$2::uuid],1700,50000)",[one,a]);
 await t.expectError(M,"select staff_update($1,'Попытка переноса',array[$2::uuid],1700,50000)",'forbidden',[one,b]);
 await t.expectError(M,"select staff_update($1,'Сотрудник двух точек',array[$2::uuid],1700,50000)",'not-found',[rotating,a]);
 await t.expectError(M,"select user_set_password($1,'another-test-password')",'forbidden',[rotating]);
 await t.expectError(M,'select staff_set_active($1,false)','not-found',[two]);
 await t.expectError(M,"select user_set_password($1,'another-test-password')",'forbidden',[manager]);
 const ownerId=await t.userId(OWNER);await t.expectError(M,"select user_set_password($1,'another-test-password')",'forbidden',[ownerId]);
});
it('franchisee promotes an existing employee; demotion/rotation preserve history and revoke old sessions',async()=>{
 const sid=crypto.randomUUID();await t.admin('insert into auth.sessions(id,user_id) values($1,$2)',[sid,one]);
 await t.as(OWNER,'select staff_access_set($1,$2,true,array[$3::uuid,$4::uuid])',[partner,one,a,b]);
 expect(await t.admin('select id from auth.sessions where id=$1',[sid])).toEqual([]);
 expect((await t.as<{j:any[]}>(ONE,'select team_revenue_month($1,current_date) j',[partner]))[0].j.map(x=>x.location_id).sort()).toEqual([a,b].sort());
 const shiftsBefore=await t.admin('select id,location_id,total_minor,earned_minor from work_shift where employee_id=$1 order by id',[rotating]);
 await t.as(OWNER,'select staff_access_set($1,$2,false,array[$3::uuid])',[partner,one,b]);
 await t.expectError(ONE,'select team_revenue_month($1,current_date)','forbidden',[partner]);
 await t.as(ONE,'select staff_home(current_date)');
 await t.as(OWNER,'select staff_set_active($1,false)',[one]);
 await t.as(OWNER,'select staff_set_active($1,true)',[one]);
 await t.expectError(ONE,'select team_revenue_month($1,current_date)','forbidden',[partner]);
 expect((await t.as<{j:any[]}>(OWNER,'select team_list($1) j',[partner]))[0].j.some(x=>x.user_id===one)).toBe(false);
 await t.expectError(OWNER,'select team_set_active($1,$2,true)','forbidden',[partner,one]);
 await t.as(OWNER,"select staff_update($1,'Сотрудник двух точек',array[$2::uuid],1700,50000)",[rotating,b]);
 expect(await t.admin('select id,location_id,total_minor,earned_minor from work_shift where employee_id=$1 order by id',[rotating])).toEqual(shiftsBefore);
});
it('foreign owners, anonymous callers and revoked JWTs cannot use scoped commands',async()=>{
 await t.expectError(OTHER,'select staff_access_set($1,$2,true,array[$3::uuid])','forbidden',[partner,two,b]);
 for(const sql of ['select team_revenue_month(null,current_date)','select staff_access_history(null)','select staff_access_set(null,null,true,array[]::uuid[])']) await expect(t.as(null,sql)).rejects.toThrow();
 const sid=crypto.randomUUID();
 const denied=await t.db.transaction(async tx=>{
  await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:manager,role:'authenticated',session_id:sid})]);
  await tx.exec('set local role authenticated');
  return tx.query('select team_revenue_month($1,current_date)',[partner]);
 }).then(()=>false,()=>true);expect(denied).toBe(true);
});
it('owner access history excludes passwords and other partners; manager cannot inspect it',async()=>{
 const history=(await t.as<{j:any[]}>(OWNER,'select staff_access_history($1) j',[partner]))[0].j;
 expect(history.some(x=>x.action==='staff.access')).toBe(true);
 for(const entry of history){expect(entry).not.toHaveProperty('diff');expect(entry).not.toHaveProperty('password');}
 await t.expectError(M,'select staff_access_history($1)','forbidden',[partner]);
 await t.expectError(OTHER,'select staff_access_history($1)','forbidden',[partner]);
});

it('legacy owner creation scopes only the new manager to current active partner points',async()=>{
 const created=(await t.as<{id:string}>(OWNER,"select team_create($1,'Совместимый управляющий','79998887766','test-only-password') id",[partner]))[0].id;
 const membership=(await t.admin<{location_ids:string[]}>('select location_ids from staff_member where user_id=$1',[created]))[0];
 const active=(await t.admin<{id:string}>("select id from location where partner_id=$1 and status='active' order by id",[partner])).map(x=>x.id);
 expect(membership.location_ids.sort()).toEqual(active.sort());
 expect((await t.admin<{location_ids:string[]}>('select location_ids from staff_member where user_id=$1',[manager]))[0].location_ids).toEqual([a]);
});
it('owner blocks and restores access without deleting an open shift',async()=>{
 const sid=crypto.randomUUID();await t.admin('insert into auth.sessions(id,user_id) values($1,$2)',[sid,two]);
 const shift=(await t.as<{id:string}>('scope.two@access.bron.local','select (shift_open($1)).id',[b]))[0].id;
 await t.as(OWNER,'select staff_set_active($1,false)',[two]);
 expect(await t.admin('select id from auth.sessions where id=$1',[sid])).toEqual([]);
 expect((await t.admin('select id from work_shift where id=$1',[shift]))).toHaveLength(1);
 await t.expectError('scope.two@access.bron.local','select staff_home(current_date)','forbidden');
 await t.as(OWNER,'select staff_set_active($1,true)',[two]);
 expect((await t.as<{j:any}>('scope.two@access.bron.local','select staff_home(current_date) j'))[0].j.open_shift.id).toBe(shift);
});
it('suspending a manager preserves the intended role and exact assigned points on restore',async()=>{
 await t.as(OWNER,'select staff_set_active($1,false)',[manager]);
 await t.expectError(M,'select team_revenue_month($1,current_date)','forbidden',[partner]);
 await t.as(OWNER,'select staff_set_active($1,true)',[manager]);
 expect((await t.as<{j:any[]}>(M,'select team_revenue_month($1,current_date) j',[partner]))[0].j.map(x=>x.location_id)).toEqual([a]);
});
it('explicit owner repair of an old role-only manager does not change anyone else or create new credentials',async()=>{
 const uid=(await t.admin<{id:string}>("select app_private.create_login('scope.legacy@access.bron.local','test-only-password','Прежний управляющий') id"))[0].id;
 await t.admin("insert into role_assignment(user_id,role,scope_type,scope_id) values($1,'franchisee_manager','partner',$2)",[uid,partner]);
 expect((await t.as<{j:any[]}>('scope.legacy@access.bron.local','select team_revenue_month($1,current_date) j',[partner]))[0].j).toEqual([]);
 await t.as(OWNER,'select staff_access_set($1,$2,true,array[$3::uuid])',[partner,uid,b]);
 expect((await t.as<{j:any[]}>('scope.legacy@access.bron.local','select team_revenue_month($1,current_date) j',[partner]))[0].j.map(x=>x.location_id)).toEqual([b]);
});
it('changing one partner role never revokes a different partner assignment',async()=>{
 const uid=await create('scope.multi',[a],true);
 await t.admin("insert into role_assignment(user_id,role,scope_type,scope_id) values($1,'franchisee_manager','partner',$2)",[uid,other]);
 await t.as(FM,'select staff_access_set($1,$2,false,array[$3::uuid])',[partner,uid,a]);
 expect((await t.admin("select id from role_assignment where user_id=$1 and role='franchisee_manager' and scope_id=$2 and revoked_at is null",[uid,other]))).toHaveLength(1);
 expect((await t.admin("select id from role_assignment where user_id=$1 and role='franchisee_manager' and scope_id=$2 and revoked_at is null",[uid,partner]))).toHaveLength(0);
});
