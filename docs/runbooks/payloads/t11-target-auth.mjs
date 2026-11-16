// Temporary target-only Auth trial. Generates real GoTrue OTP sessions without mail/password changes.
// Pinned contract: supabase/auth v2.197.0 internal/api/{mail,verify}.go and internal/tokens/service.go.
// Auth audit entries are retained. Every generated session is revoked; only whitelisted metadata is restored.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash,randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const RUNTIME='/opt/bron/audit-runtime-c128f9b';
const MUTABLE=['recovery_token','recovery_sent_at','last_sign_in_at','raw_app_meta_data','updated_at'];
const IDENTITY_MUTABLE=['last_sign_in_at','updated_at'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
// Preserve PostgreSQL JSONB text. JavaScript JSON.parse would round arbitrary JSON numbers.
const projection=(alias,fields)=>`(to_jsonb(${alias})-ARRAY[${fields.map(x=>`'${x}'`).join(',')}]::text[])::text AS rest,
  jsonb_build_object(${fields.map(x=>`'${x}',${alias}."${x}"`).join(',')})::text AS metadata`;
const userSql=`SELECT u.id::text AS id,to_jsonb(u)::text AS record,${projection('u',MUTABLE)}
  FROM auth.users u WHERE u.id=ANY($1::uuid[]) ORDER BY u.id`;
const identitySql=`SELECT i.id::text AS id,i.user_id::text AS user_id,to_jsonb(i)::text AS record,
  ${projection('i',IDENTITY_MUTABLE)} FROM auth.identities i
  WHERE i.user_id=ANY($1::uuid[]) ORDER BY i.id`;

export async function runTargetAuthTrial({db,audit,runAccessChecks,request,persist,verifyTarget}) {
  const one=async(sql,params=[])=>(await db.query(sql,params)).rows[0];
  const baseline=await audit.snapshotDatabase(db);
  if(baseline['data:auth.users']?.count!==16) fail('T11_AUTH_ROW_COUNT');
  const actors=[];
  let beforeUsers,beforeIdentities,ids,owned=[],tokens=[],journal,operationError,result;
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL timezone='UTC'");
    await verifyTarget(db,'on');
    for(const role of ['franchise_manager','franchisee','franchisee_manager','franchisee_staff']) {
      const actor=await one(`SELECT u.id::text AS id,au.email,a.scope_id::text AS partner_id,
        (SELECT l.id::text FROM public.location l WHERE l.partner_id=a.scope_id AND l.status='active' ORDER BY l.id LIMIT 1) AS location_id
        FROM public.app_user u JOIN auth.users au ON au.id=u.id
        JOIN public.role_assignment a ON a.user_id=u.id AND a.revoked_at IS NULL
        WHERE a.role=$1 AND u.status='active' AND au.aud='authenticated' AND au.role='authenticated'
          AND au.email_confirmed_at IS NOT NULL AND au.deleted_at IS NULL AND NOT au.is_anonymous
          AND (au.banned_until IS NULL OR au.banned_until<=now()) AND au.email IS NOT NULL
          AND EXISTS(SELECT 1 FROM auth.identities i WHERE i.user_id=u.id AND i.provider='email')
          AND NOT EXISTS(SELECT 1 FROM auth.mfa_factors f WHERE f.user_id=u.id AND f.status='verified')
          AND NOT(u.id=ANY($2::uuid[]))
          AND ($1='franchise_manager' OR NOT EXISTS(SELECT 1 FROM public.role_assignment z WHERE z.user_id=u.id AND z.revoked_at IS NULL AND z.scope_type='company'))
          AND ($1<>'franchisee_manager' OR NOT EXISTS(SELECT 1 FROM public.role_assignment z WHERE z.user_id=u.id AND z.revoked_at IS NULL AND z.role='franchisee'))
          AND ($1<>'franchisee_staff' OR (EXISTS(SELECT 1 FROM public.staff_member sm WHERE sm.user_id=u.id AND sm.active)
            AND NOT EXISTS(SELECT 1 FROM public.role_assignment z JOIN public.role_permission rp ON rp.role=z.role
              WHERE z.user_id=u.id AND z.revoked_at IS NULL AND rp.permission IN('revenue.read','staff.manage','org.manage'))))
        ORDER BY u.id LIMIT 1`,[role,actors.map(x=>x.id)]);
      if(!actor || !uuid(actor.id) || !actor.email || (role!=='franchise_manager' && !uuid(actor.location_id)))
        fail('T11_EXISTING_AUTH_COHORT_MISSING');
      actors.push({...actor,role});
    }
    ids=actors.map(x=>x.id);
    const transient=await one(`SELECT (SELECT count(*)::int FROM auth.sessions) AS sessions,
      (SELECT count(*)::int FROM auth.refresh_tokens) AS refresh_tokens,
      (SELECT count(*)::int FROM auth.mfa_amr_claims) AS amr_claims,
      (SELECT count(*)::int FROM auth.one_time_tokens WHERE user_id=ANY($1::uuid[])) AS one_time_tokens`,[ids]);
    if(Object.values(transient).some(x=>x!==0))
      fail('T11_EXISTING_TARGET_AUTH_STATE');
    const trigger=await one(`SELECT count(*)::int AS count FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'D'
      AND ((tgrelid IN('auth.users'::regclass,'auth.identities'::regclass) AND (tgtype::int & 16)<>0)
        OR (tgrelid IN('auth.sessions'::regclass,'auth.refresh_tokens'::regclass,'auth.one_time_tokens'::regclass,
          'auth.mfa_amr_claims'::regclass) AND (tgtype::int & 28)<>0))`);
    if(trigger.count!==0) fail('T11_AUTH_MUTATION_TRIGGER_PRESENT');
    beforeUsers=(await db.query(userSql,[ids])).rows;
    beforeIdentities=(await db.query(identitySql,[ids])).rows;
    if(beforeUsers.length!==4 || beforeIdentities.length<4) fail('T11_BEFOREIMAGE_IDENTITY_MISSING');
  } finally {await db.query('ROLLBACK');}

  journal={task:'T11_TARGET_AUTH',phase:'before_http',users:beforeUsers.map(x=>({id:x.id,
    metadata:x.metadata})),identities:beforeIdentities.map(x=>({id:x.id,user_id:x.user_id,
    metadata:x.metadata})),sessions:[],one_time_tokens:[]};
  await persist(journal);
  const save=async phase=>{journal={...journal,phase,sessions:owned.map(x=>({id:x.sid,user_id:x.id})),
    one_time_tokens:tokens};try{await persist(journal);}catch{fail('T11_JOURNAL_UPDATE_FAILED');}};

  async function cleanup() {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
    let committed=false;
    try {
      await db.query("SET LOCAL timezone='UTC'");
      await db.query("SET LOCAL statement_timeout='30s'");
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query('LOCK TABLE auth.users,auth.identities,auth.sessions,auth.refresh_tokens,auth.one_time_tokens IN SHARE ROW EXCLUSIVE MODE');
      await verifyTarget(db,'off');
      const currentUsers=(await db.query(userSql+' FOR UPDATE OF u',[ids])).rows;
      const currentIdentities=(await db.query(identitySql+' FOR UPDATE OF i',[ids])).rows;
      if(currentUsers.length!==beforeUsers.length || currentIdentities.length!==beforeIdentities.length)
        fail('T11_AUTH_ROW_SET_CHANGED');
      for(const [before,current] of [[beforeUsers,currentUsers],[beforeIdentities,currentIdentities]]) {
        for(let n=0;n<before.length;n++) if(before[n].id!==current[n].id || before[n].rest!==current[n].rest)
          fail('T11_UNEXPECTED_AUTH_FIELD_CHANGE');
      }
      const sessions=(await db.query('SELECT id::text AS id,user_id::text AS user_id FROM auth.sessions')).rows;
      if(sessions.some(x=>!owned.some(y=>y.sid===x.id && y.id===x.user_id))) fail('T11_UNOWNED_SESSION_PRESENT');
      const refresh=(await db.query('SELECT session_id::text AS session_id,user_id::text AS user_id FROM auth.refresh_tokens')).rows;
      if(refresh.some(x=>!owned.some(y=>y.sid===x.session_id && y.id===x.user_id))) fail('T11_UNOWNED_REFRESH_PRESENT');
      const ott=(await db.query('SELECT user_id::text AS user_id,token_hash,token_type::text AS token_type FROM auth.one_time_tokens WHERE user_id=ANY($1::uuid[])',[ids])).rows;
      if(ott.some(x=>x.token_type!=='recovery_token' || !tokens.some(y=>y.user_id===x.user_id && y.token_hash===x.token_hash)))
        fail('T11_UNOWNED_OTP_PRESENT');
      for(const session of owned) await db.query('DELETE FROM auth.sessions WHERE id=$1::uuid AND user_id=$2::uuid',[session.sid,session.id]);
      for(const token of tokens) await db.query(`DELETE FROM auth.one_time_tokens WHERE user_id=$1::uuid
        AND token_type='recovery_token' AND token_hash=$2`,[token.user_id,token.token_hash]);
      for(const [before,current,fields,table] of [[beforeUsers,currentUsers,MUTABLE,'users'],[beforeIdentities,currentIdentities,IDENTITY_MUTABLE,'identities']]) {
        const assignments=fields.map(key=>`"${key}"=saved."${key}"`).join(',');
        for(let n=0;n<before.length;n++) {
          if(before[n].record===current[n].record) continue;
          const restored=await db.query(`UPDATE auth.${table} AS actual SET ${assignments}
            FROM jsonb_populate_record(NULL::auth.${table},$1::jsonb) AS saved
            WHERE actual.id=$2::uuid AND to_jsonb(actual)=$3::jsonb RETURNING actual.id::text AS id`,
          [before[n].metadata,before[n].id,current[n].record]);
          if(restored.rows.length!==1 || restored.rows[0].id!==before[n].id) fail('T11_AUTH_RESTORE_ROW_GUARD');
        }
      }
      const users=(await db.query(userSql,[ids])).rows, identities=(await db.query(identitySql,[ids])).rows;
      if(JSON.stringify(users)!==JSON.stringify(beforeUsers) || JSON.stringify(identities)!==JSON.stringify(beforeIdentities))
        fail('T11_AUTH_BEFOREIMAGE_NOT_RESTORED');
      const leftovers=await one(`SELECT (SELECT count(*)::int FROM auth.sessions) AS sessions,
        (SELECT count(*)::int FROM auth.refresh_tokens) AS refresh_tokens,
        (SELECT count(*)::int FROM auth.mfa_amr_claims) AS amr_claims,
        (SELECT count(*)::int FROM auth.one_time_tokens WHERE user_id=ANY($1::uuid[])) AS tokens`,[ids]);
      if(Object.values(leftovers).some(x=>x!==0)) fail('T11_TRIAL_AUTH_RESIDUE');
      await db.query('COMMIT');committed=true;
    } finally {if(!committed) await db.query('ROLLBACK').catch(()=>{});}
  }

  try {
    for(const actor of actors) {
      // Recovery returns 404 for an unknown address; it cannot fall back to account creation.
      const generated=await request('/auth/v1/admin/generate_link','POST',{type:'recovery',email:actor.email},'admin');
      if(generated.status!==200 || generated.json?.id!==actor.id || generated.json?.verification_type!=='recovery'
        || typeof generated.json?.hashed_token!=='string' || !generated.json.hashed_token)
        fail('T11_GENERATE_LINK_FAILED');
      tokens.push({user_id:actor.id,token_hash:generated.json.hashed_token});
      await save('otp_generated');
      const verified=await request('/auth/v1/verify','POST',{type:'recovery',token_hash:generated.json.hashed_token});
      if(verified.status!==200 || verified.json?.user?.id!==actor.id || typeof verified.json.access_token!=='string'
        || typeof verified.json.refresh_token!=='string') fail('T11_VERIFY_FAILED');
      const jwtParts=verified.json.access_token.split('.');
      let claims;try{claims=JSON.parse(Buffer.from(jwtParts[1]??'','base64url').toString('utf8'));}catch{fail('T11_JWT_INVALID');}
      if(jwtParts.length!==3 || claims.sub!==actor.id || claims.role!=='authenticated' || !uuid(claims.session_id)
        || !Number.isFinite(claims.exp) || claims.exp<=Date.now()/1000+30) fail('T11_JWT_IDENTITY_INVALID');
      owned.push({...actor,sid:claims.session_id,access:verified.json.access_token,refresh:verified.json.refresh_token});
      await save('session_created');
      const session=await one('SELECT user_id::text AS user_id FROM auth.sessions WHERE id=$1::uuid',[claims.session_id]);
      if(session?.user_id!==actor.id) fail('T11_SERVER_SESSION_MISSING');
      const actual=await request('/auth/v1/user','GET',undefined,verified.json.access_token);
      if(actual.status!==200 || actual.json?.id!==actor.id) fail('T11_AUTH_USER_FAILED');
    }
    const access=await runAccessChecks(db);
    if(access.status!=='PASS') fail('T11_DB_ACCESS_NOT_PASS');
    const http={};
    for(const actor of owned) {
      const me=await request('/rest/v1/rpc/me','POST',{},actor.access);
      if(me.status!==200 || me.json?.user?.id!==actor.id || !me.json.assignments?.some(x=>x.role===actor.role))
        fail('T11_HTTP_ME_FAILED');
      if(actor.role==='franchisee' || actor.role==='franchisee_manager') {
        const foreign=await one(`SELECT p.id::text AS id FROM public.partner p WHERE NOT EXISTS(SELECT 1 FROM public.role_assignment a
          WHERE a.user_id=$1 AND a.revoked_at IS NULL AND (a.scope_type='company' OR a.scope_id=p.id)) ORDER BY p.id LIMIT 1`,[actor.id]);
        if(!foreign) fail('T11_FOREIGN_SCOPE_MISSING');
        const own=await request(`/rest/v1/partner?select=id&id=eq.${actor.partner_id}`,'GET',undefined,actor.access);
        const other=await request(`/rest/v1/partner?select=id&id=eq.${foreign.id}`,'GET',undefined,actor.access);
        const denied=await request('/rest/v1/rpc/staff_list','POST',{p_partner:foreign.id,p_month:new Date().toISOString().slice(0,10)},actor.access);
        if(own.status!==200 || own.json?.length!==1 || own.json[0].id!==actor.partner_id
          || other.status!==200 || !Array.isArray(other.json) || other.json.length!==0
          || denied.status!==400 || denied.json?.message!=='forbidden') fail('T11_HTTP_SCOPE_FAILED');
      }
      http[actor.role]={authUser:true,me:true,scope:actor.role==='franchisee'||actor.role==='franchisee_manager'?'own_and_foreign':'db_checks'};
    }
    const revoked=owned.find(x=>x.role==='franchisee');
    const removed=await db.query('DELETE FROM auth.sessions WHERE id=$1::uuid AND user_id=$2::uuid RETURNING id',[revoked.sid,revoked.id]);
    if(removed.rows.length!==1) fail('T11_REVOCATION_GUARD');
    const rejected=await request('/rest/v1/rpc/me','POST',{},revoked.access);
    const rejectedRpc=await request('/rest/v1/rpc/revenue_overview','POST',{p_month:new Date().toISOString().slice(0,10)},revoked.access);
    const rejectedRefresh=await request('/auth/v1/token?grant_type=refresh_token','POST',{refresh_token:revoked.refresh});
    if(rejected.status!==200 || rejected.json?.user!==null || rejectedRpc.status!==400
      || rejectedRpc.json?.message!=='unauthenticated' || ![400,401].includes(rejectedRefresh.status))
      fail('T11_REVOKED_JWT_OR_REFRESH_ACCEPTED');
    result={status:'PASS',scope:'REAL_GOTRUE_AND_INTERNAL_HTTP',generatedSessions:owned.length,
      databaseAccess:access,http,revokedJwtDenied:true,revokedRefreshDenied:true,
      passwordLoginTested:false,emailSent:false};
  } catch(error) {operationError=error;}
  finally {
    // A failed journal update must not prevent revocation of already-known sessions.
    try {await save('cleanup_started');} catch {operationError??=Object.assign(new Error('T11_JOURNAL_UPDATE_FAILED'),{code:'T11_JOURNAL_UPDATE_FAILED'});}
    await cleanup();
    const after=await audit.snapshotDatabase(db);
    if(audit.compareSnapshots(baseline,after).length!==0) fail('T11_TARGET_SNAPSHOT_CHANGED');
    try {await save('cleanup_verified');} catch {operationError??=Object.assign(new Error('T11_JOURNAL_UPDATE_FAILED'),{code:'T11_JOURNAL_UPDATE_FAILED'});}
  }
  if(operationError) throw operationError;
  return {...result,trialSessionsRemoved:true,authBeforeimagesRestored:true,targetSnapshotUnchanged:true};
}

export function authTrialTransport(gateway,anon,admin,fetcher=fetch) {
  return async(pathname,method='GET',body,authorization=anon)=>{
    const credential=authorization==='admin'?admin:authorization;
    const response=await fetcher(`http://${gateway}:8000${pathname}`,{method,redirect:'error',
      signal:AbortSignal.timeout(15000),headers:{apikey:authorization==='admin'?admin:anon,
        Authorization:`Bearer ${credential}`,Host:'api.bronservis.ru','Content-Type':'application/json',
        'User-Agent':'bron-target-auth-rehearsal-T11'},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await response.text();
    if(text.length>1024*1024) fail('T11_HTTP_RESPONSE_TOO_LARGE');
    let json;try{json=JSON.parse(text);}catch{json=null;}
    return{status:response.status,json};
  };
}

async function main() {
  let db;
  let phase='bootstrap';
  try {
    if(process.getuid?.()!==0 || !Object.values(os.networkInterfaces()).flat().some(x=>x?.family==='IPv4'&&x.address==='152.228.115.115')) fail('T11_WRONG_VPS');
    const records=JSON.parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect',
      'supabase-db','supabase-envoy','supabase-auth','supabase-web-1'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe'],maxBuffer:4*1024*1024}));
    const get=name=>records.find(x=>x.Name==='/'+name && x.State?.Running);
    const database=get('supabase-db'),gateway=get('supabase-envoy'),auth=get('supabase-auth'),web=get('supabase-web-1');
    if(!database||!gateway||!auth||!web||!auth.Config.Image.startsWith('supabase/gotrue:v2.197.0')) fail('T11_CONTAINER_GUARD');
    const env=record=>Object.fromEntries(record.Config.Env.map(x=>{const n=x.indexOf('=');return[x.slice(0,n),x.slice(n+1)];}));
    const dbEnv=env(database),apiEnv=env(gateway),authEnv=env(auth);
    if(dbEnv.POSTGRES_USER!=='supabase_admin'||dbEnv.POSTGRES_DB!=='postgres'||!dbEnv.POSTGRES_PASSWORD||dbEnv.PGPASSWORD!==dbEnv.POSTGRES_PASSWORD) fail('T11_DB_CONFIGURATION');
    if(!apiEnv.ANON_KEY||!apiEnv.SERVICE_ROLE_KEY) fail('T11_GATEWAY_CREDENTIALS');
    if(Object.entries(authEnv).some(([key,value])=>key.startsWith('GOTRUE_HOOK_')&&key.endsWith('_ENABLED')&&!['','false','0'].includes(value.toLowerCase()))) fail('T11_AUTH_HOOK_ENABLED');
    const mount=web.Mounts?.find(x=>x.Destination==='/etc/caddy/Caddyfile');
    if(mount?.Source!=='/opt/bron/supabase/docker/bron/Caddyfile.maintenance'||mount.RW!==false) fail('T11_PUBLIC_MAINTENANCE_REQUIRED');
    if(createHash('sha256').update(fs.readFileSync(mount.Source)).digest('hex')!=='9cf90cff8c8165721584f67a1711ae605cef333c93074673a7c38c3899ab1686') fail('T11_MAINTENANCE_SHA_MISMATCH');
    const common=Object.keys(database.NetworkSettings.Networks).filter(x=>gateway.NetworkSettings.Networks[x]?.IPAddress);
    if(common.length!==1) fail('T11_GATEWAY_NETWORK');
    const address=gateway.NetworkSettings.Networks[common[0]].IPAddress;
    if(!/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(address)) fail('T11_GATEWAY_ADDRESS');
    const addresses=Object.values(database.NetworkSettings.Networks).map(x=>x.IPAddress);
    const {databaseConfig}=await import(`${RUNTIME}/scripts/database-config.mjs`);
    const {assertMigrationTarget,sourceServiceConfig}=await import(`${RUNTIME}/scripts/migration-source.mjs`);
    sourceServiceConfig();
    const url=new URL('postgresql://supabase_admin@127.0.0.1:15433/postgres?sslmode=disable');url.password=encodeURIComponent(dbEnv.POSTGRES_PASSWORD);
    assertMigrationTarget(url.href);
    const childEnv={...process.env,BRON_DB_ALLOW_LOCAL_PLAIN:'1',TARGET_DATABASE_URL:url.href};
    const pg=createRequire(`${RUNTIME}/package.json`)('pg');
    db=new pg.Client({...databaseConfig(url.href,childEnv),query_timeout:60000});await db.connect();
    const verifyTarget=async(client,mode)=>{
      const row=(await client.query(`SELECT current_database() AS db,current_user AS role,session_user AS session_role,
        host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('transaction_read_only') AS mode,
        current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net`)).rows[0];
      if(row.db!=='postgres'||row.role!=='supabase_admin'||row.session_role!=='supabase_admin'||!addresses.includes(row.address)||row.port!==5432||row.mode!==mode||row.cron!=='off'||row.net!=='0') fail('T11_TARGET_IDENTITY_OR_ISOLATION');
    };
    const journalPath=`/root/bron-secrets/t11-target-auth-${randomUUID()}.json`;
    let saved=false;
    const persist=async value=>{
      const dir=fs.lstatSync('/root/bron-secrets');if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==0||(dir.mode&0o077)) fail('T11_UNSAFE_JOURNAL_DIRECTORY');
      const temporary=saved?`${journalPath}.${randomUUID()}.part`:journalPath;
      const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      try{fs.fchmodSync(fd,0o600);if(fs.fstatSync(fd).uid!==0)fail('T11_JOURNAL_OWNER');fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      if(saved)fs.renameSync(temporary,journalPath);saved=true;
      const d=fs.openSync('/root/bron-secrets',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
    };
    phase='real-gotrue-trial';
    const audit=await import(`${RUNTIME}/scripts/migration-audit.mjs`);
    const {runTargetAccessChecks}=await import('./t09-access-readonly.mjs');
    const result=await runTargetAuthTrial({db,audit,runAccessChecks:runTargetAccessChecks,
      request:authTrialTransport(address,apiEnv.ANON_KEY,apiEnv.SERVICE_ROLE_KEY),persist,verifyTarget});
    console.log('T11_TARGET_AUTH',JSON.stringify(result));
    phase='post-cleanup-strict-audit';
    const checked=spawnSync(process.execPath,['scripts/migration-check.mjs','--source-service'],{cwd:RUNTIME,env:childEnv,stdio:['ignore','inherit','inherit']});
    if(checked.error||checked.signal||checked.status===null)fail('T11_AUDIT_STATUS_UNKNOWN');
    console.log('T11_AUDIT_EXIT_STATUS',checked.status);process.exitCode=checked.status;
  } catch(error) {
    const code=/^[A-Z0-9_]{3,60}$/.test(error.code??'')?error.code:'T11_AUTH_TRIAL_FAILED';
    console.error('T11_BLOCKED',phase,code);process.exitCode=2;
  } finally {if(db)await db.end().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
