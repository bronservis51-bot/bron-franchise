import {afterAll,beforeAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
// @ts-expect-error shared SQL loader has no declaration file
import {migrationFiles,demoUsers} from '../../scripts/db-lib.mjs';

const repair=readFileSync('supabase/migrations/20261116040000_staff_helper_execute.sql','utf8');
const helpers=['app_private.staff_owner(uuid)','app_private.staff_location_scope(uuid)',
 'app_private.staff_member_scope(uuid)','app_private.motivation_default(text)'];
const callers=['public.staff_list(uuid,date)','public.staff_home(date)','app_private.can_manage_user(uuid)',
 'app_private.staff_pay_policy(uuid,date)','public.motivation_get(uuid)'];
const OWNER='alpha.owner@demo.example.com',OTHER='beta.owner@demo.example.com',STAFF='79000000011@staff.bron.local';
let db:PGlite,partner:string;

/** Native bootstrap layout: installation superuser differs from NOSUPERUSER app owner. */
async function fixture(splitOwners=true){
 const d=new PGlite({username:'supabase_admin',initDbStartParams:['--username=supabase_admin'],extensions:{pg_trgm,pgcrypto}});
 await d.exec(readFileSync('supabase/tests-shim/00_supabase_shim.sql','utf8'));
 await d.exec(`create role postgres nologin nosuperuser createrole bypassrls;
 grant create on database postgres to postgres;
 grant usage,create on schema public,auth,storage,extensions to postgres;
 grant all on all tables in schema auth,storage to postgres;
 grant execute on all functions in schema auth,storage,extensions to postgres;
 alter table storage.objects owner to postgres;alter table storage.buckets owner to postgres;
 set role postgres;`);
 for(const f of migrationFiles().filter((x:string)=>x.split('/').pop()!<'20261116010000_daily_payroll.sql')) await d.exec(readFileSync(f,'utf8'));
 await d.exec(readFileSync('supabase/seed/seed.sql','utf8'));
 for(const u of demoUsers) await d.query('insert into auth.users(email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3)',
  [u.email,JSON.stringify({full_name:u.name}),JSON.stringify({demo_seed:true})]);
 await d.exec(readFileSync('supabase/seed/seed_after_users.sql','utf8'));
 await d.exec(readFileSync('supabase/seed/seed_staff.sql','utf8'));
 if(splitOwners)await d.exec('reset role');
 for(const name of ['20261116010000_daily_payroll.sql','20261116020000_staff_scopes.sql','20261116030000_partner_preparation.sql'])
  await d.exec(readFileSync('supabase/migrations/'+name,'utf8'));
 await d.exec('reset role');
 return d;
}
async function userId(email:string){return(await db.query<{id:string}>('select id from public.app_user where email=$1',[email])).rows[0].id;}
async function as(email:string|null,sql:string,params:unknown[]=[],session?:string){
 const sub=email?await userId(email):null;
 return db.transaction(async tx=>{
  await tx.query("select set_config('request.jwt.claims',$1,true)",[sub?JSON.stringify({sub,role:'authenticated',...(session?{session_id:session}:{})}):'']);
  await tx.exec(sub?'set local role authenticated':'set local role anon');
  return(await tx.query(sql,params)).rows;
 });
}
const clientAcl=()=>db.query(`select p.oid::text,has_function_privilege('anon',p.oid,'execute') a,
 has_function_privilege('authenticated',p.oid,'execute') u,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where x.grantee=0 and x.privilege_type='EXECUTE') p
 from pg_proc p where p.oid=any($1::regprocedure[]) order by p.oid`,[helpers]);
async function apply(d=db){
 const r=await d.exec(repair);
 return r.flatMap(x=>x.rows).find(x=>(x as any).jsonb_build_object)?.jsonb_build_object as any;
}

beforeAll(async()=>{db=await fixture();partner=(await db.query<{id:string}>("select id from partner where code='ALPHA'")).rows[0].id;},180000);
afterAll(async()=>db?.close());

it('reproduces native 42501 with a real NOSUPERUSER legacy definer, not a superuser-only fixture',async()=>{
 const owners=(await db.query<{rolname:string;rolsuper:boolean}>("select rolname,rolsuper from pg_roles where rolname in('postgres','supabase_admin') order by rolname")).rows;
 expect(owners).toEqual([{rolname:'postgres',rolsuper:false},{rolname:'supabase_admin',rolsuper:true}]);
 expect((await db.query<{ok:boolean}>("select has_function_privilege('postgres','app_private.staff_member_scope(uuid)','execute') ok")).rows[0].ok).toBe(false);
 await expect(as(OWNER,'select public.staff_list($1,current_date)',[partner])).rejects.toMatchObject({code:'42501'});
 await expect(as(STAFF,'select public.staff_home(null)')).rejects.toMatchObject({code:'42501'});
});

it('repairs exactly four trusted EXECUTE edges and restores actual staff RPCs without client privilege expansion',async()=>{
 const before=(await clientAcl()).rows;
 const status=await apply();
 expect(status).toMatchObject({status:'KNOWN_EXECUTE_GAP_REPAIRED',grantsApplied:4,businessRolesChanged:false,clientPrivilegesChanged:false,passwordsReset:0});
 expect((await clientAcl()).rows).toEqual(before);
 const list=await as(OWNER,'select public.staff_list($1,current_date) j',[partner]);
 expect((list[0] as any).j.some((s:any)=>s.phone==='79000000011')).toBe(true);
 const home=await as(STAFF,'select public.staff_home(null) j');
 expect((home[0] as any).j.partner_name).toBeTruthy();
 await expect(as(OTHER,'select public.staff_list($1,current_date)',[partner])).rejects.toThrow('forbidden');
 await expect(as(null,'select public.staff_list($1,current_date)',[partner])).rejects.toMatchObject({code:'42501'});
});

it('does not refund or bypass revoked sessions after the repair',async()=>{
 const uid=await userId(OWNER),sid=crypto.randomUUID();
 await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[sid,uid]);
 expect(await as(OWNER,'select public.staff_list($1,current_date)',[partner],sid)).toHaveLength(1);
 await db.query('delete from auth.sessions where id=$1',[sid]);
 await expect(as(OWNER,'select public.staff_list($1,current_date)',[partner],sid)).rejects.toThrow('unauthenticated');
});

it('retains point scope and protects shared staff global access under the repaired native owners',async()=>{
 const points=(await db.query<{id:string}>('select unnest(location_ids) id from staff_member where user_id=$1',[await userId(STAFF)])).rows;
 expect(points.length).toBeGreaterThanOrEqual(2);
 await as(OWNER,"select staff_account_create($1,'Scoped manager','acl.point.manager','test-only-password',array[$2::uuid],true)",[partner,points[0].id]);
 const manager='acl.point.manager@access.bron.local';
 const report=await as(manager,'select team_revenue_month($1,current_date) j',[partner]);
 expect((report[0] as any).j.map((r:any)=>r.location_id)).toEqual([points[0].id]);
 const list=await as(manager,'select staff_list($1,current_date) j',[partner]);
 const rotating=(list[0] as any).j.find((s:any)=>s.phone==='79000000011');
 expect(rotating.location_ids).toEqual([points[0].id]);
 expect(rotating.can_manage).toBe(false);
 await expect(as(manager,'select staff_set_active($1,false)',[await userId(STAFF)])).rejects.toThrow('not-found');
});

it('is idempotent and subsequent apply_grants preserves the trusted definer grants',async()=>{
 await db.exec('select app_private.apply_grants()');
 expect(await apply()).toMatchObject({status:'NO_CHANGE',grantsApplied:0});
 expect(await as(STAFF,'select public.staff_home(null)')).toHaveLength(1);
});

it('fails closed on unexpected ownership before granting anything',async()=>{
 await db.exec(`revoke execute on function app_private.staff_owner(uuid) from postgres;
 alter function public.staff_list(uuid,date) owner to authenticated;`);
 const before=(await clientAcl()).rows;
 await expect(apply()).rejects.toThrow('STAFF_HELPER_UNEXPECTED_CALLER');
 expect((await clientAcl()).rows).toEqual(before);
 expect((await db.query<{ok:boolean}>("select has_function_privilege('postgres','app_private.staff_owner(uuid)','execute') ok")).rows[0].ok).toBe(false);
 await db.exec('alter function public.staff_list(uuid,date) owner to postgres');
 expect(await apply()).toMatchObject({status:'KNOWN_EXECUTE_GAP_REPAIRED',grantsApplied:1});
});

it('reports NO_CHANGE rather than claiming diagnosis on a clean same-owner deployment',async()=>{
 const clean=await fixture(false);
 try{expect(await apply(clean)).toMatchObject({status:'NO_CHANGE',grantsApplied:0});}finally{await clean.close();}
},180000);

it('allows mixed trusted owners when the actual call edges already have EXECUTE',async()=>{
 await db.exec('alter function public.motivation_get(uuid) owner to supabase_admin');
 const before=(await clientAcl()).rows;
 try{
  expect(await apply()).toMatchObject({status:'NO_CHANGE',grantsApplied:0});
  expect((await clientAcl()).rows).toEqual(before);
 }finally{await db.exec('alter function public.motivation_get(uuid) owner to postgres');}
});

it('allows an all-admin known layout without adding unnecessary grants to postgres',async()=>{
 for(const name of callers)await db.exec(`alter function ${name} owner to supabase_admin`);
 for(const name of helpers)await db.exec(`revoke execute on function ${name} from postgres`);
 const before=(await clientAcl()).rows;
 try{
  expect(await apply()).toMatchObject({status:'NO_CHANGE',grantsApplied:0});
  expect((await clientAcl()).rows).toEqual(before);
  const checks=(await db.query<{ok:boolean}>('select has_function_privilege(\'postgres\',x::regprocedure,\'execute\') ok from unnest($1::text[]) x',[helpers])).rows;
  expect(checks.every(x=>!x.ok)).toBe(true);
 }finally{
  for(const name of callers)await db.exec(`alter function ${name} owner to postgres`);
  await apply();
 }
});

it('preserves the finance, learning and CRM call paths across a native split-owner upgrade', async () => {
 const migrated = await fixture();
 try {
  await migrated.exec('alter default privileges revoke execute on functions from public');
  for (const file of migrationFiles().filter((path: string) => path.split('/').pop()! >= '20261116040000_staff_helper_execute.sql')) {
   await migrated.exec(readFileSync(file, 'utf8'));
  }
  async function call<T>(email: string, sql: string, params: unknown[] = []) {
   const {rows: [user]} = await migrated.query<{id: string}>('select id from public.app_user where email=$1', [email]);
   return migrated.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub: user.id, role: 'authenticated'})]);
    await tx.exec('set local role authenticated');
    return (await tx.query<{result: T}>(sql, params)).rows[0].result;
   });
  }
  const finance = await call<{locations: unknown[]}>(OWNER, 'select public.finance_my(current_date) as result');
  expect(finance.locations.length).toBeGreaterThan(0);
  const learning = await call<{audience: string}>(STAFF, 'select public.learning_overview() as result');
  expect(learning.audience).toBe('sales');
  const operation = crypto.randomUUID();
  const createLead = () => call<{id: string}>('fm@demo.example.com', 'select public.lead_save($1::jsonb,null,$2) as result',
   [JSON.stringify({name: 'Проверка сохранения'}), operation]);
  expect((await createLead()).id).toBe(operation);
  expect((await createLead()).id).toBe(operation);
  for (const fn of ['app_private.fin_month(uuid,uuid[],date,boolean)', 'app_private.expense_rows(uuid,uuid[],date,boolean)']) {
   const allowed = await migrated.query<{actor: string; allowed: boolean}>(`
    select actor, has_function_privilege(actor, $1::regprocedure, 'EXECUTE') as allowed
    from unnest(array['postgres','anon','authenticated']) as actor`, [fn]);
   expect(allowed.rows).toEqual([{actor:'postgres',allowed:true},{actor:'anon',allowed:false},{actor:'authenticated',allowed:false}]);
  }
 } finally {
  await migrated.close();
 }
}, 180_000);
