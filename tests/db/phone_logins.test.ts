import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const FM='fm@demo.example.com',OWNER='alpha.owner@demo.example.com',OTHER='beta.owner@demo.example.com';
let t:TestDb;let partner:string;let location:string;let user:string;let ownerUser:string;
const oldLogin='phone.legacy@access.bron.local';const newLogin='79995550101@staff.bron.local';
const one=async<T>(who:string|null,sql:string,args:unknown[]=[]) => (await t.as<{j:T}>(who,sql,args))[0].j;
beforeAll(async()=>{
 t=await createTestDb();
 const p=(await t.admin<{id:string;partner_id:string}>("select id,partner_id from location where code='ALPHA-3'"))[0];
 location=p.id;partner=p.partner_id;
 user=await one<string>(OWNER,"select staff_account_create($1,'Phone legacy','phone.legacy','retained-password',array[$2::uuid],false) j",[partner,location]);
 ownerUser=await t.userId(OWNER);
},180000);
afterAll(async()=>t?.db.close());

it('does not bulk rename existing accounts or infer their phone numbers',async()=>{
 const u=(await t.admin<{email:string;phone:string|null}>('select email,phone from app_user where id=$1',[ownerUser]))[0];
 expect(u).toEqual({email:OWNER,phone:null});
 expect((await one<{user:{email:string}}>(OWNER,'select me() j')).user.email).toBe(OWNER);
});

it('keeps the staff contact synchronization private and invoker-only',async()=>{
 const grants=(await t.admin<{authenticated:boolean;anon:boolean;definer:boolean;registered:boolean}>(`select
 has_function_privilege('authenticated','app_private.staff_phone_sync(uuid,text)','execute') authenticated,
 has_function_privilege('anon','app_private.staff_phone_sync(uuid,text)','execute') anon,
 (select prosecdef from pg_proc where oid='app_private.staff_phone_sync(uuid,text)'::regprocedure) definer,
 exists(select 1 from app_private.client_command where fn='app_private.staff_phone_sync(uuid,text)'::regprocedure) registered`))[0];
 expect(grants).toEqual({authenticated:false,anon:false,definer:false,registered:false});
 await expect(t.as(OWNER,'select app_private.staff_phone_sync($1,$2)',[user,'79995550190'])).rejects.toThrow(/permission denied/);
});

it('network manager creates a franchisee whose login and contact are the same canonical phone',async()=>{
 const id=await one<string>(FM,"select account_create_phone($1,'Phone owner','8 (999) 555-01-00','new-owner-password') j",[partner]);
 const row=(await t.admin<{id:string;email:string;phone:string;valid:boolean;identity_email:string}>(`select a.id,a.email,a.phone,
  u.encrypted_password=extensions.crypt('new-owner-password',u.encrypted_password) as valid,
  i.identity_data->>'email' identity_email from app_user a join auth.users u on u.id=a.id
  join auth.identities i on i.user_id=u.id and i.provider='email' where a.id=$1`,[id]))[0];
 expect(row).toEqual({id,email:'79995550100@staff.bron.local',phone:'79995550100',valid:true,identity_email:'79995550100@staff.bron.local'});
 expect((await one<{assignments:{role:string}[]}>('79995550100@staff.bron.local','select me() j')).assignments.map(a=>a.role)).toEqual(['franchisee']);
 const access=await one<{users:{user_id:string;phone:string|null}[]}>(FM,'select partner_access($1) j',[partner]);
 expect(access.users.find(u=>u.user_id===id)?.phone).toBe('79995550100');
 await t.expectError(OWNER,"select account_create_phone($1,'Denied','+79995550199','test-password')",'forbidden',[partner]);
});

it('phone-only manager creation preserves scoped employee access and denies peer promotion',async()=>{
 const id=await one<string>(OWNER,"select staff_account_create_phone($1,'Phone manager','+7 999 555 01 10','new-manager-password',array[$2::uuid],true) j",[partner,location]);
 const staff=(await t.admin<{phone:string;manager_enabled:boolean}>('select phone,manager_enabled from staff_member where user_id=$1',[id]))[0];
 expect(staff).toEqual({phone:'79995550110',manager_enabled:true});
 const who='79995550110@staff.bron.local';
 const me=await one<{assignments:{role:string}[]}>(who,'select me() j');
 expect(me.assignments.map(a=>a.role).sort()).toEqual(['franchisee_manager','franchisee_staff']);
 expect(await one(who,'select team_revenue_month($1,current_date) j',[partner])).toBeTruthy();
 await t.expectError(who,"select staff_account_create_phone($1,'Peer','+79995550111','test-password',array[$2::uuid],true)",'forbidden',[partner,location]);
 const other=(await t.admin<{id:string}>("select id from location where code='BETA-1'"))[0].id;
 await t.expectError(OWNER,"select staff_account_create_phone($1,'Foreign','+79995550112','test-password',array[$2::uuid],false)",'validation',[partner,other]);
});

it('changes only the login identity, retains password/UUID/roles and revokes previous sessions',async()=>{
 const before=(await t.admin<{password:string;roles:string}>(`select u.encrypted_password as password,
  (select string_agg(id::text||role,',' order by id) from role_assignment where user_id=u.id) roles from auth.users u where id=$1`,[user]))[0];
 const sid=crypto.randomUUID();await t.admin('insert into auth.sessions(id,user_id) values($1,$2)',[sid,user]);
 await t.admin("update auth.users set recovery_token='synthetic-recovery',email_change='synthetic@example.invalid',email_change_token_new='synthetic-token' where id=$1",[user]);
 const answer=await one<{phone:string;login:string;changed:boolean}>(OWNER,'select user_set_phone_login($1,$2) j',[user,'8 (999) 555-01-01']);
 expect(answer).toEqual({phone:'79995550101',login:'79995550101',changed:true});
 const after=(await t.admin<{password:string;roles:string;email:string;recovery_token:string;email_change:string}>(`select u.encrypted_password as password,
 (select string_agg(id::text||role,',' order by id) from role_assignment where user_id=u.id) roles,
 email,recovery_token,email_change from auth.users u where id=$1`,[user]))[0];
 expect(after.password).toBe(before.password);expect(after.roles).toBe(before.roles);
 expect(after.email).toBe(newLogin);expect(after.recovery_token).toBe('');expect(after.email_change).toBe('');
 expect(await t.admin('select id from auth.sessions where id=$1',[sid])).toHaveLength(0);
 expect((await t.admin<{phone:string}>('select phone from staff_member where user_id=$1',[user]))[0].phone).toBe('79995550101');
 expect((await t.admin<{email:string}>("select identity_data->>'email' email from auth.identities where user_id=$1 and provider='email'",[user]))[0].email).toBe(newLogin);
 const identity=(await t.admin<{provider_id:string;sub:string}>("select provider_id,identity_data->>'sub' sub from auth.identities where user_id=$1 and provider='email'",[user]))[0];
 expect(identity).toEqual({provider_id:user,sub:user});
 expect(await t.admin('select id from auth.users where email=$1',[oldLogin])).toHaveLength(0);
 expect(await one(newLogin,'select staff_home(null) j')).toBeTruthy();
 await expect(t.db.transaction(async tx=>{
  await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role:'authenticated',session_id:sid})]);
  await tx.exec('set local role authenticated');await tx.query('select staff_home(null)');
 })).rejects.toThrow('unauthenticated');
 const audit=(await t.admin<{diff:Record<string,unknown>}>("select diff from audit_event where action='user.login' and entity_id=$1 order by id desc limit 1",[user]))[0].diff;
 expect(audit).toEqual({login_type:'phone',changed:true,phone_last4:'0101'});
 const history=await one<{action:string;diff?:unknown}[]>(OWNER,'select staff_access_history($1) j',[partner]);
 expect(history.some(a=>a.action==='user.login')).toBe(true);
 for(const entry of history)expect(entry).not.toHaveProperty('diff');
});

it('same canonical phone is an idempotent no-op that keeps a new valid session',async()=>{
 const sid=crypto.randomUUID();await t.admin('insert into auth.sessions(id,user_id) values($1,$2)',[sid,user]);
 const before=await t.admin("select id from audit_event where action='user.login' and entity_id=$1",[user]);
 expect(await one(OWNER,'select user_set_phone_login($1,$2) j',[user,'+7 (999) 555-01-01'])).toEqual({phone:'79995550101',login:'79995550101',changed:false});
 expect(await t.admin('select id from auth.sessions where id=$1',[sid])).toHaveLength(1);
 expect(await t.admin("select id from audit_event where action='user.login' and entity_id=$1",[user])).toHaveLength(before.length);
});

it('duplicate and malformed phone cannot partially change an account',async()=>{
 await t.expectError(OWNER,'select user_set_phone_login($1,$2)','validation',[user,'+79995550100']);
 for(const phone of ['12345','++79995550102','letters79995550102','00000000000',null])
  await t.expectError(OWNER,'select user_set_phone_login($1,$2)','validation',[user,phone]);
 expect((await t.admin<{email:string}>('select email from auth.users where id=$1',[user]))[0].email).toBe(newLogin);
});

it('does not expose a cross-partner, self, privileged peer or anonymous login mutation',async()=>{
 await t.expectError(OTHER,'select user_set_phone_login($1,$2)','forbidden',[user,'+79995550120']);
 await t.expectError(newLogin,'select user_set_phone_login($1,$2)','forbidden',[user,'+79995550120']);
 await t.expectError(FM,'select user_set_phone_login($1,$2)','forbidden',[await t.userId(FM),'+79995550120']);
 await expect(t.as(null,'select user_set_phone_login($1,$2)',[user,'+79995550120'])).rejects.toThrow();
});

it('does not unlink external identities or silently invent a missing email identity',async()=>{
 const uid=await one<string>(OWNER,"select staff_account_create($1,'Identity guard','phone.external','test-password',array[$2::uuid],false) j",[partner,location]);
 await t.admin("insert into auth.identities(provider_id,user_id,identity_data,provider) values($1,$2,'{}','google')",[uid,uid]);
 await t.expectError(OWNER,'select user_set_phone_login($1,$2)','validation',[uid,'+79995550130']);
 expect(await t.admin('select id from auth.identities where user_id=$1',[uid])).toHaveLength(2);
 await t.admin('delete from auth.identities where user_id=$1',[uid]);
 await t.expectError(OWNER,'select user_set_phone_login($1,$2)','validation',[uid,'+79995550130']);
 expect((await t.admin<{email:string}>('select email from auth.users where id=$1',[uid]))[0].email).toBe('phone.external@access.bron.local');
});

it('inactive account stays inactive and its login edit still leaves an owner-scoped audit',async()=>{
 await t.as(OWNER,'select staff_set_active($1,false)',[user]);
 await one(OWNER,'select user_set_phone_login($1,$2) j',[user,'+79995550140']);
 const state=(await t.admin<{status:string;active:boolean}>('select u.status,s.active from app_user u join staff_member s on s.user_id=u.id where u.id=$1',[user]))[0];
 expect(state).toEqual({status:'suspended',active:false});
 expect((await t.admin<{partner_id:string}>("select partner_id from audit_event where action='user.login' and entity_id=$1 order by id desc limit 1",[user]))[0].partner_id).toBe(partner);
});

it('rejects contact collisions even for legacy short logins or native Auth phones',async()=>{
 const uid=await one<string>(OWNER,"select staff_account_create($1,'Legacy contact','phone.contact','test-password',array[$2::uuid],false) j",[partner,location]);
 await t.admin("update staff_member set phone='79995550150' where user_id=$1",[uid]);
 await t.expectError(FM,"select account_create_phone($1,'Duplicate','+79995550150','test-password')",'validation',[partner]);
 await t.admin("update auth.users set phone='+79995550151' where id=$1",[uid]);
 await t.expectError(FM,"select account_create_phone($1,'Duplicate','+79995550151','test-password')",'validation',[partner]);
});

it('does not silently modify a native phone sign-in or a historical company identity',async()=>{
 const uid=await one<string>(OWNER,"select staff_account_create($1,'Native phone','phone.native','test-password',array[$2::uuid],false) j",[partner,location]);
 await t.admin("update auth.users set phone='+79995550152' where id=$1",[uid]);
 await t.expectError(OWNER,'select user_set_phone_login($1,$2)','validation',[uid,'+79995550153']);
 expect((await t.admin<{phone:string}>('select phone from auth.users where id=$1',[uid]))[0].phone).toBe('+79995550152');
 const tech=await one<string>(FM,"select support_account_create('Historical company','phone.tech','test-password') j");
 await t.admin('update role_assignment set revoked_at=now() where user_id=$1',[tech]);
 await t.expectError(FM,'select user_set_phone_login($1,$2)','forbidden',[tech,'+79995550154']);
});

it('actual staff form creates phone, pay and onboarding atomically; profile edits do not rename or reset',async()=>{
 const settings={employee_kind:'employee',learning_enabled:true};
 const uid=await one<string>(OWNER,'select staff_profile_save_phone(null,$1,$2,$3,$4,array[$5::uuid],1250,25000,false,$6) j',
  [partner,'Phone form','8 (999) 555-02-00','profile-password',location,JSON.stringify(settings)]);
 const before=(await t.admin<{phone:string;email:string;password:string;rate_bp:number;fee:number;learning_enabled:boolean}>(`select
  a.phone,a.email,u.encrypted_password as password,s.rate_bp,s.shift_fee_minor::int fee,s.learning_enabled
  from app_user a join auth.users u on u.id=a.id join staff_member s on s.user_id=a.id where a.id=$1`,[uid]))[0];
 expect({...before,password:undefined}).toEqual({phone:'79995550200',email:'79995550200@staff.bron.local',password:undefined,rate_bp:1250,fee:25000,learning_enabled:true});
 await one(OWNER,'select staff_profile_save_phone($1,$2,$3,$4,$5,array[$6::uuid],1500,40000,false,$7) j',
  [uid,partner,'Updated phone form','+79995550100','must-not-set-password',location,JSON.stringify(settings)]);
 const after=(await t.admin<{phone:string;email:string;password:string;rate_bp:number;fee:number}>(`select a.phone,a.email,
  u.encrypted_password as password,s.rate_bp,s.shift_fee_minor::int fee from app_user a join auth.users u on u.id=a.id
  join staff_member s on s.user_id=a.id where a.id=$1`,[uid]))[0];
 expect(after).toEqual({phone:before.phone,email:before.email,password:before.password,rate_bp:1500,fee:40000});
});

it('actual staff form rejects native phone collision and foreign scope before creating Auth rows',async()=>{
 const native=await one<string>(OWNER,"select staff_account_create($1,'Wrapper native','phone.wrapper.native','test-password',array[$2::uuid],false) j",[partner,location]);
 await t.admin("update auth.users set phone='+79995550201' where id=$1",[native]);
 const count=(await t.admin<{n:number}>('select count(*)::int n from auth.users'))[0].n;
 const sql='select staff_profile_save_phone(null,$1,$2,$3,$4,array[$5::uuid],1000,0,true,$6)';
 const settings=JSON.stringify({employee_kind:'employee',learning_enabled:true});
 await t.expectError(OWNER,sql,'validation',[partner,'Duplicate phone','+79995550201','test-password',location,settings]);
 await t.expectError(OTHER,sql,'forbidden',[partner,'Foreign phone','+79995550202','test-password',location,settings]);
 expect((await t.admin<{n:number}>('select count(*)::int n from auth.users'))[0].n).toBe(count);
});

it('late onboarding error rolls back actual form Auth/profile/roles and does not restore a blocked account',async()=>{
 const phone='79995550203';
 const sql='select staff_profile_save_phone(null,$1,$2,$3,$4,array[$5::uuid],1000,0,true,$6)';
 const settings=JSON.stringify({employee_kind:'trainee',learning_enabled:true,internship_from:'2026-11-20',internship_until:'2026-11-19',internship_floor_minor:50000});
 const counts=await t.admin('select (select count(*) from auth.users)::int users,(select count(*) from app_user)::int profiles,(select count(*) from staff_member)::int staff,(select count(*) from role_assignment)::int roles');
 await t.expectError(OWNER,sql,'validation',[partner,'Rollback phone',phone,'test-password',location,settings]);
 expect(await t.admin('select (select count(*) from auth.users)::int users,(select count(*) from app_user)::int profiles,(select count(*) from staff_member)::int staff,(select count(*) from role_assignment)::int roles')).toEqual(counts);
 expect(await t.admin('select id from auth.users where email=$1',[phone+'@staff.bron.local'])).toHaveLength(0);
 await t.expectError(OWNER,sql,'validation',[partner,'No restore','79995550140','must-not-reset',location,JSON.stringify({employee_kind:'employee',learning_enabled:true})]);
 expect((await t.admin<{status:string}>('select status from app_user where id=$1',[user]))[0].status).toBe('suspended');
});

it('reserved phone cannot inherit another partner pending role or consume that reservation',async()=>{
 const beta=(await t.admin<{id:string}>("select id from partner where code='BETA'"))[0].id;
 const phone='79995550210',email=phone+'@staff.bron.local';
 await t.as(FM,'select access_grant($1,$2)',[beta,email]);
 const before=await t.admin('select id,email,partner_id,role from pending_assignment where lower(email)=$1',[email]);
 const users=(await t.admin<{n:number}>('select count(*)::int n from auth.users'))[0].n;
 await t.expectError(OWNER,"select staff_account_create_phone($1,'Reserved staff',$2,'test-password',array[$3::uuid],false)",'validation',[partner,phone,location]);
 await t.expectError(OWNER,"select staff_profile_save_phone(null,$1,'Reserved form',$2,'test-password',array[$3::uuid],1000,0,true,$4)",'validation',
  [partner,phone,location,JSON.stringify({employee_kind:'employee',learning_enabled:true})]);
 await t.expectError(FM,"select account_create_phone($1,'Reserved owner',$2,'test-password')",'validation',[partner,phone]);
 await t.expectError(OWNER,"select staff_create($1,'Legacy reserved',$2,'test-password',array[$3::uuid],1000,0)",'validation',[partner,phone,location]);
 await t.expectError(OWNER,"select staff_profile_save(null,$1,'Legacy reserved',$2,'test-password',array[$3::uuid],1000,0,true,$4)",'validation',
  [partner,phone,location,JSON.stringify({employee_kind:'employee',learning_enabled:true})]);
 await t.expectError(FM,"select account_create($1,'Legacy reserved',$2,'test-password')",'validation',[partner,email]);
 await t.expectError(OWNER,'select user_set_phone_login($1,$2)','validation',[user,phone]);
 expect((await t.admin<{n:number}>('select count(*)::int n from auth.users'))[0].n).toBe(users);
 expect(await t.admin('select id from auth.users where email=$1',[email])).toHaveLength(0);
 expect(await t.admin('select id,email,partner_id,role from pending_assignment where lower(email)=$1',[email])).toEqual(before);
 expect(await t.admin('select a.user_id from role_assignment a join auth.users u on u.id=a.user_id where u.email=$1',[email])).toHaveLength(0);
});

it('common factory postcondition catches a reservation becoming visible after precheck and restores it',async()=>{
 const beta=(await t.admin<{id:string}>("select id from partner where code='BETA'"))[0].id;
 const holder='race-holder@access.bron.local',phone='79995550220',email=phone+'@staff.bron.local';
 await t.as(FM,'select access_grant($1,$2)',[beta,holder]);
 const pending=await t.admin('select id,email,partner_id,role from pending_assignment where lower(email)=$1',[holder]);
 const counts=await t.admin('select (select count(*) from auth.users)::int users,(select count(*) from app_user)::int profiles,(select count(*) from role_assignment)::int roles');
 // Expose a previously committed reservation only after the factory precheck.
 // The real existing AFTER trigger adopts it; the common postcondition must
 // roll back Auth/profile/roles and restore that original reservation.
 await t.db.exec(`create function public.test_pending_visibility() returns trigger language plpgsql as $$
 begin if new.email='79995550220@staff.bron.local' then
  update public.pending_assignment set email=new.email where email='race-holder@access.bron.local';
 end if;return new;end $$;
 create trigger test_pending_visibility before insert on auth.users for each row execute function public.test_pending_visibility()`);
 try{
  await t.expectError(OWNER,"select staff_account_create_phone($1,'Raced claim',$2,'test-password',array[$3::uuid],false)",'validation',[partner,phone,location]);
  await t.expectError(OWNER,"select staff_create($1,'Legacy raced claim',$2,'test-password',array[$3::uuid],1000,0)",'validation',[partner,phone,location]);
  expect(await t.admin('select (select count(*) from auth.users)::int users,(select count(*) from app_user)::int profiles,(select count(*) from role_assignment)::int roles')).toEqual(counts);
  expect(await t.admin('select id,email,partner_id,role from pending_assignment where lower(email)=$1',[holder])).toEqual(pending);
  expect(await t.admin('select id from auth.users where email=$1',[email])).toHaveLength(0);
  expect(await t.admin('select id from pending_assignment where email=$1',[email])).toHaveLength(0);
 }finally{await t.db.exec('drop trigger test_pending_visibility on auth.users;drop function public.test_pending_visibility()');}
});
