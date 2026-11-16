// DRAFT ONLY. T26 is the network-repair task; this admission module is not authorized by it.
// This module does not load credentials or contact a database when imported or executed.
// It models a reversible admission fence; it never claims provider SUPERUSER is fenced.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const protectedRoles=new Set(['postgres','supabase_admin','dashboard_user']);
const apiRoles=new Set(['anon','authenticated','service_role']);
const expectedConnect=['PUBLIC','dashboard_user','postgres'];
const edgeKey=e=>[e.grantee,e.grantor,e.privilege,e.grantable];
export const canonicalAcl=acl=>acl.map(edgeKey).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fencedAcl=before=>[...before.acl.filter(e=>!(e.privilege==='CONNECT'&&e.grantee==='PUBLIC')),
  {grantee:'pgbouncer',grantor:'postgres',privilege:'CONNECT',grantable:false}];

export const stateSql=`SELECT jsonb_build_object(
 'db',current_database(),'actor',current_user,'session',session_user,'pid',pg_backend_pid(),
 'readOnly',current_setting('transaction_read_only'),'owner',pg_get_userbyid(d.datdba),
 'signal',pg_has_role(current_user,'pg_signal_backend','USAGE'),
 'prepared',(SELECT count(*) FROM pg_prepared_xacts),
 'netQueued',(SELECT count(*) FROM net.http_request_queue),
 'runJobsExists',EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app_private' AND p.proname='run_jobs'),
 'unexpectedActiveCron',(SELECT count(*) FROM cron.job WHERE active AND (jobname<>'bron-jobs'
   OR username<>'postgres' OR command !~* '^[[:space:]]*select[[:space:]]+app_private\\.run_jobs\\([[:space:]]*(''cron''[[:space:]]*)?\\)[[:space:]]*;?[[:space:]]*$'
   OR (command ~ '''' AND command !~ '''cron'''))),
 'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
   'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable)
   ORDER BY x.grantee,x.grantor,x.privilege_type,x.is_grantable)
   FROM aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) x),
 'roles',(SELECT jsonb_agg(jsonb_build_object('name',r.rolname,'super',r.rolsuper,'login',r.rolcanlogin,
   'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'replication',r.rolreplication,'bypass',r.rolbypassrls,
   'connect',has_database_privilege(r.oid,d.oid,'CONNECT'),
   'ownerPath',pg_has_role(r.oid,'postgres','MEMBER') OR pg_has_role(r.oid,'dashboard_user','MEMBER')
      OR pg_has_role(r.oid,'supabase_admin','MEMBER')) ORDER BY r.rolname) FROM pg_roles r),
 'lookupOtherSetRoles',(SELECT count(*) FROM pg_roles r
   WHERE r.rolname<>'pgbouncer' AND pg_has_role('pgbouncer',r.oid,'SET')),
 'lookupCriticalWrites',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','app_private','auth','storage','vault') AND c.relkind IN('r','p')
   AND CASE WHEN c.relkind IN('r','p') THEN has_table_privilege('pgbouncer',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') ELSE false END),
 'lookupSequenceWrites',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN('public','app_private') AND c.relkind='S'
   AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('pgbouncer',c.oid,'USAGE,UPDATE') ELSE false END),
 'lookupCriticalDefiners',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN('public','app_private','auth','storage','vault') AND p.prosecdef
   AND has_function_privilege('pgbouncer',p.oid,'EXECUTE')),
 'backends',(SELECT coalesce(jsonb_agg(jsonb_build_object('pid',a.pid,'role',a.usename,
   'type',a.backend_type,'state',a.state,'openTransaction',a.xact_start IS NOT NULL,
   'super',coalesce(r.rolsuper,false),'providerAppKnown',a.application_name IN('postgres_exporter',''))
   ORDER BY a.pid),'[]'::jsonb) FROM pg_stat_activity a LEFT JOIN pg_roles r ON r.rolname=a.usename
   WHERE a.datname=current_database())
) AS state FROM pg_database d WHERE d.datname=current_database()`;

export async function readState(client){
  await client.query('BEGIN READ ONLY');
  try{
    await client.query("SET LOCAL statement_timeout='5000'");
    return (await client.query(stateSql)).rows[0]?.state;
  }finally{await client.query('ROLLBACK');}
}

export function assessState(state,{before=null,ownedPids=[]}={}){
  if(state?.db!=='postgres'||state.actor!=='postgres'||state.session!=='postgres'||state.owner!=='postgres'||
    state.readOnly!=='on'||state.signal!==true||!Number.isInteger(state.pid))fail('ADMISSION_SOURCE_IDENTITY');
  if(!ownedPids.includes(state.pid))fail('ADMISSION_CONTROL_PID_UNKNOWN');
  if(!Array.isArray(state.roles)||!Array.isArray(state.acl)||!Array.isArray(state.backends))fail('ADMISSION_METADATA_INVALID');
  if(Number(state.prepared)!==0||Number(state.netQueued)!==0||state.runJobsExists!==false||Number(state.unexpectedActiveCron)!==0)
    fail('ADMISSION_BACKGROUND_WRITER_UNCOVERED');
  const lookup=state.roles.find(r=>r.name==='pgbouncer');
  if(!lookup?.login||lookup.super||lookup.createRole||lookup.createDb||lookup.replication||lookup.bypass||lookup.ownerPath||
    state.lookupOtherSetRoles!==0||Number(state.lookupCriticalWrites)!==0||Number(state.lookupSequenceWrites)!==0||Number(state.lookupCriticalDefiners)!==0)
    fail('ADMISSION_POOLER_LOOKUP_CAPABILITY_UNSAFE');
  for(const r of state.roles){
    if(!protectedRoles.has(r.name)&&(r.login||apiRoles.has(r.name))&&(r.super||r.ownerPath))fail('ADMISSION_ROLE_ESCAPE');
    if(before&&(r.login||apiRoles.has(r.name))&&!protectedRoles.has(r.name)&&r.name!=='pgbouncer'&&r.connect)
      fail('ADMISSION_ORDINARY_CONNECT_REMAINS');
  }
  const owner=state.roles.find(r=>r.name==='postgres');
  if(!owner?.connect||owner.super)fail('ADMISSION_OWNER_RECOVERY_UNAVAILABLE');
  if(state.roles.find(r=>r.name==='dashboard_user')?.login!==false)fail('ADMISSION_DASHBOARD_LOGIN_UNEXPECTED');
  const connected=state.acl.filter(e=>e.privilege==='CONNECT');
  if(!before){
    if(!equal(connected.map(e=>e.grantee).sort(),expectedConnect)||connected.some(e=>e.grantor!=='postgres'||e.grantable))
      fail('ADMISSION_UNEXPECTED_CONNECT_ACL');
  }else{
    if(!equal(canonicalAcl(state.acl),canonicalAcl(fencedAcl(before))))fail('ADMISSION_ACL_EFFECT_MISMATCH');
  }
  for(const b of state.backends){
    if(b.super&&b.type==='client backend'&&(!b.providerAppKnown||b.openTransaction||b.state!=='idle'))
      fail('ADMISSION_PROVIDER_TRANSACTION_UNCOVERED');
    if(b.role==='postgres'&&b.type==='client backend'&&!ownedPids.includes(b.pid))fail('ADMISSION_UNKNOWN_OWNER_CLIENT');
  }
  return {normalClients:state.backends.filter(b=>b.type==='client backend'&&!b.super&&!ownedPids.includes(b.pid)),
    providerSuperBoundary:state.backends.filter(b=>b.super&&b.type==='client backend').length};
}

// Dependencies are injected intentionally: the future package must provide root-only,
// fsynced before-image/state/receipt writers and a reviewed SESSION-route factory.
// persist(action) MUST complete durably before returning. No raw state is printed here.
export async function applyAdmission({activation,openOwner,persist}){
  if(!/^T[1-9][0-9]{1,3}\.source_admission$/.test(activation?.actionId??'')||activation.reviewed!==true||
    !/^[a-f0-9]{64}$/.test(activation.manifestSha256??'')||
    !['canonical-session','existing-reverse'].includes(activation.route)||
    activation.providerLookupExceptionReviewed!==true||activation.rollbackBeforeTargetWrites!==true||activation.targetWritesStarted!==false||
    !activation.inputDigests||!Object.keys(activation.inputDigests).length||
    Object.values(activation.inputDigests).some(d=>typeof d!=='string'||!/^[a-f0-9]{64}$/.test(d))||
    typeof openOwner!=='function'||typeof persist!=='function')
    fail('ADMISSION_DRAFT_NOT_REVIEWED');
  let control,recovery,before,effects='NONE',completed=false;const ownedPids=[];
  const inputs={actionId:activation.actionId,manifestSha256:activation.manifestSha256,inputDigests:activation.inputDigests};
  let persistenceFailures=0;
  // The before-image and original commit intent MUST already be durable before
  // an ACL effect. A subsequent logging failure cannot prevent the pre-authorized
  // exact inverse while the target is still untouched.
  const recoveryPersist=async record=>{try{await persist({...inputs,...record});}catch{persistenceFailures++;}};
  try{
    control=await openOwner();
    before=await readState(control);ownedPids.push(before.pid);
    assessState(before,{ownedPids});
    const stable=await readState(control);
    if(stable.pid!==before.pid)fail('ADMISSION_TRANSACTION_POOLER_FORBIDDEN');
    assessState(stable,{ownedPids});
    await persist({...inputs,action:'before-image',effects,before});
    await persist({...inputs,action:'commit-intent',effects:'UNKNOWN'});
    effects='UNKNOWN';
    await control.query('BEGIN READ WRITE');
    await control.query("SET LOCAL statement_timeout='5000'");
    // Preserve the provider's existing authentication-lookup path while removing
    // application admission. This adds no business-table/function privilege.
    await control.query('GRANT CONNECT ON DATABASE postgres TO pgbouncer');
    await control.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC');
    await control.query('COMMIT');effects='ACL_COMMITTED';
    await persist({...inputs,action:'acl-committed',effects});
    let state=await readState(control),assessment=assessState(state,{before,ownedPids});
    for(const b of assessment.normalClients){
      const result=await control.query('SELECT pg_terminate_backend($1,5000) AS terminated',[b.pid]);
      if(result.rows[0]?.terminated!==true)fail('ADMISSION_DRAIN_NOT_CONFIRMED');
      await persist({...inputs,action:'backend-drained',effects,pid:b.pid,role:b.role});
    }
    // Must be a genuinely new canonical service connection AFTER the effect and drain.
    // Direct-native PostgreSQL proof alone does not establish Supavisor auth_query recovery.
    recovery=await openOwner();const restoredAccess=await readState(recovery);
    if(ownedPids.includes(restoredAccess.pid))fail('ADMISSION_RECOVERY_NOT_INDEPENDENT');
    ownedPids.push(restoredAccess.pid);assessState(restoredAccess,{before,ownedPids});
    const stableRecovery=await readState(recovery);
    if(stableRecovery.pid!==restoredAccess.pid)fail('ADMISSION_TRANSACTION_POOLER_FORBIDDEN');
    state=await readState(control);assessment=assessState(state,{before,ownedPids});
    // The lookup connection is provider-only and is allowed to reopen for credential
    // checks. All normal product-service backends must be gone, not only denied later.
    if(assessment.normalClients.some(b=>b.role!=='pgbouncer'))fail('ADMISSION_CLIENTS_REMAIN');
    effects='ADMISSION_CLOSED';
    const evidence={effects,normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,
      providerLookupConnectPreserved:true,providerSuperBoundary:assessment.providerSuperBoundary,
      sourcePaused:false,finalAuditPassed:false};
    await persist({...inputs,action:'admission-pass',...evidence});completed=true;return evidence;
  }catch(error){
    let recoveryEvidence={effects,originalAclRestored:effects==='NONE'};
    if(!completed&&before&&effects!=='NONE'){
      try{
        // A failed statement can leave an aborted RW transaction. ROLLBACK also
        // makes unknown COMMIT effects observable without repeating GRANT/REVOKE.
        let inverseClient=control;
        try{await inverseClient.query('ROLLBACK');await readState(inverseClient);}
        catch{
          // One independent owner session is permitted to reconcile a lost control
          // connection; it is not a retry of the ACL mutation or the freeze task.
          if(!recovery)recovery=await openOwner();
          inverseClient=recovery;
        }
        recoveryEvidence=await rollbackAdmission({client:inverseClient,before,persist:recoveryPersist});
        effects=recoveryEvidence.effects;
      }catch(inverseError){
        recoveryEvidence={effects:'UNKNOWN',originalAclRestored:false,
          code:/^ADMISSION_[A-Z_]+$/.test(inverseError?.code??'')?inverseError.code:'ADMISSION_RECOVERY_REQUIRED'};
        effects='UNKNOWN';
      }
    }
    error.recovery=recoveryEvidence;
    if(!/^ADMISSION_[A-Z_]+$/.test(error?.code??''))error.code='ADMISSION_OPERATION_FAILED';
    await recoveryPersist({action:'admission-failed',effects,code:error.code,recovery:recoveryEvidence,
      sourceMayRemainClosed:!recoveryEvidence.originalAclRestored,rollbackRequired:!recoveryEvidence.originalAclRestored});
    if(persistenceFailures)error.recovery.persistenceWriteFailures=persistenceFailures;
    throw error;
  }finally{await Promise.allSettled([control?.end(),recovery?.end()]);}
}

// Exact inverse of this specific ACL effect; not a general ACL import/rewrite engine.
export async function rollbackAdmission({client,before,persist}){
  if(!Array.isArray(before?.acl))fail('ADMISSION_ROLLBACK_BEFORE_IMAGE_INVALID');
  await client.query('ROLLBACK');
  const current=await readState(client);
  if(current?.db!=='postgres'||current.actor!=='postgres'||current.session!=='postgres'||current.owner!=='postgres')
    fail('ADMISSION_ROLLBACK_IDENTITY');
  const originalMatches=equal(canonicalAcl(current.acl),canonicalAcl(before.acl));
  const fenceMatches=equal(canonicalAcl(current.acl),canonicalAcl(fencedAcl(before)));
  if(!originalMatches&&!fenceMatches)fail('ADMISSION_ROLLBACK_CURRENT_ACL_MISMATCH');
  if(!Number.isInteger(current.pid)||!Array.isArray(current.backends))fail('ADMISSION_ROLLBACK_METADATA_UNAVAILABLE');
  // A lost response is not proof that the old backend has finished COMMIT.
  // A fresh witness must not call the original ACL recovered while that owner
  // backend can still commit a later fence. Same-control ROLLBACK is already settled.
  if(current.pid!==before.pid&&current.backends.some(b=>b.pid===before.pid))fail('ADMISSION_ORIGINAL_CONTROL_STILL_ACTIVE');
  if(originalMatches){
    await persist({action:'rollback-reconciled',effects:'ORIGINAL_ACL_RESTORED',inverseNeeded:false});
    return {effects:'ORIGINAL_ACL_RESTORED',originalAclRestored:true};
  }
  await persist({action:'rollback-intent',effects:'UNKNOWN'});
  await client.query('BEGIN READ WRITE');
  await client.query("SET LOCAL statement_timeout='5000'");
  await client.query('GRANT CONNECT ON DATABASE postgres TO PUBLIC');
  await client.query('REVOKE CONNECT ON DATABASE postgres FROM pgbouncer');
  await client.query('COMMIT');
  const restored=await readState(client);
  if(!equal(canonicalAcl(restored.acl),canonicalAcl(before.acl)))fail('ADMISSION_ROLLBACK_ACL_MISMATCH');
  await persist({action:'rollback-pass',effects:'ORIGINAL_ACL_RESTORED'});
  return {effects:'ORIGINAL_ACL_RESTORED',originalAclRestored:true};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.error('T26_DRAFT_NOT_REVIEWED');process.exitCode=2;
}
