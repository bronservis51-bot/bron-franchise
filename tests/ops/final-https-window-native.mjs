// Synthetic native core proof. The injected source frame uses real PG, not production HTTPS.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import {createHash} from 'node:crypto';
import {openSync,writeFileSync,fsyncSync,closeSync,statSync,unlinkSync} from 'node:fs';
import pg from '../../node_modules/pg/lib/index.js';
import {runFinalHttpsWindow} from '../../docs/runbooks/payloads/final-https-window.mjs';
import {snapshotDatabase} from '../../scripts/migration-audit.mjs';
import {exactQueryFingerprint} from '../../docs/runbooks/payloads/exact-query-fingerprint.mjs';
import {authRowsSql} from '../../docs/runbooks/payloads/t30-auth-compact.mjs';
import {freshOwnerWitnessSql,validateFreshOwnerWitness} from '../../docs/runbooks/payloads/http-source-admission.mjs';

let phase='setup';
async function main(){
 assert.equal(process.argv.length,6);
 const [sourceCid,targetCid,conf,docker]=process.argv.slice(2);
 for(const id of [sourceCid,targetCid])assert.match(id,/^[a-f0-9]{64}$/);
 assert.notEqual(sourceCid,targetCid);
 assert.ok(['/usr/local/bin/docker','/usr/bin/docker','/bin/docker'].includes(docker));
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:conf};
 for(const cid of [sourceCid,targetCid]){
  const [c]=JSON.parse(execFileSync(docker,['--host','unix:///var/run/docker.sock','inspect',cid],
   {env,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}));
  const marker=c.Config?.Labels?.['bron.test.native-pg17'];assert.match(marker??'',/^[a-f0-9]{32}$/);
  assert.equal(c.Name,'/bron-native-pg17-'+marker);assert.equal(c.HostConfig.NetworkMode,'none');
  assert.equal(Object.keys(c.HostConfig.PortBindings??{}).length,0);
  assert.ok(c.Mounts.every(m=>m.Type==='tmpfs'));
 }
 class PgPipe extends Duplex{
  constructor(cid){super();this.child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,'nc','127.0.0.1','5432'],{env,stdio:['pipe','pipe','pipe']});
   this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});
   this.child.stdout.on('end',()=>this.push(null));this.child.stderr.resume();
   this.child.on('error',e=>this.destroy(e));this.child.stdin.on('error',e=>this.destroy(e));}
  connect(){queueMicrotask(()=>this.emit('connect'));return this;}setNoDelay(){}setKeepAlive(){}ref(){}unref(){}
  _read(){this.child.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}_final(cb){this.child.stdin.end(cb);}_destroy(e,cb){this.child.kill();cb(e);}
 }
 const clients=[];
 const open=async(cid,user)=>{
  const c=new pg.Client({stream:()=>new PgPipe(cid),user,database:'postgres',ssl:false,query_timeout:12000,
   options:'-c default_transaction_read_only=on -c cron.launch_active_jobs=off -c pg_net.batch_size=0'});
  c.on('error',()=>{});clients.push(c);await c.connect();return c;
 };
 const target=await open(targetCid,'supabase_admin'),adminTarget=await open(targetCid,'supabase_admin'),adminSource=await open(sourceCid,'supabase_admin');
 const write=async(db,sql)=>{await db.query('BEGIN READ WRITE');try{await db.query(sql);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}};
 const beforePid=(await adminSource.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const boundary=(await adminSource.query("SELECT jsonb_build_object('capturedMicros',floor(extract(epoch FROM clock_timestamp())*1000000)::numeric::text,'ownerPids','[]'::jsonb) AS boundary")).rows[0].boundary;
 const context={sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:'b'.repeat(64),before:{backends:[{pid:beforePid}]},boundary};
 const activation={actionId:'T40.final_https_window',reviewed:true,manifestSha256:'a'.repeat(64),
  sourceBarrierActionId:context.sourceBarrierActionId,sourceBarrierReceiptSha256:context.sourceBarrierReceiptSha256,
  targetAdmitted:false,sourceRoute:'fixed-source-edge-https',targetRoute:'verified-loopback-15433',
  expectedAuthRows:16,maxTimestampUpdates:1,beforeImagePath:'/root/bron-secrets/t40-auth-before-01234567.json',
  ownerDataGrantEvidenceSha256:'c'.repeat(64),fenceContextSha256:createHash('sha256').update(JSON.stringify(context)).digest('hex'),
  sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,applyTimestampOnly:true};
 const ownerDataGrant={reviewed:true,evidenceSha256:'c'.repeat(64),scope:'source-auth-fixed-snapshot-to-vps',
  sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',maxAuthSnapshots:3,
  credentialDerivedAuthDigests:true,readonlySource:true,encryptedToVpsRam:true,macDataTransit:false};
 const proof={sourceBarrierActionId:activation.sourceBarrierActionId,sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,
  normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
 let contextChecks=0,sourceFrames=0,sourceWorkingQueries=0,sourceClientsClosed=0,updatesObserved=0,beforeImages=0;
 const verifyTarget=async db=>{
  const r=(await db.query("SELECT current_database() AS db,current_user AS role,session_user AS session_role,current_setting('transaction_read_only') AS mode,current_setting('transaction_isolation') AS isolation,current_setting('timezone') AS zone,current_setting('statement_timeout') AS deadline,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net")).rows[0];
  assert.equal(r.db,'postgres');assert.equal(r.role,'supabase_admin');assert.equal(r.session_role,'supabase_admin');
  assert.ok(r.mode==='on'&&r.isolation==='repeatable read'||r.mode==='off'&&r.isolation==='serializable');
  assert.equal(r.zone,'UTC');assert.equal(r.deadline,'5s');assert.equal(r.idle,'10s');assert.equal(r.cron,'off');assert.equal(r.net,'0');contextChecks++;
 };
 const capture=ctx=>async()=>{
  sourceFrames++;const client=await open(sourceCid,'postgres');let witness,identity,authRows;
  const db={query:async(sql,values)=>{
   const r=await client.query(sql,values);
   if(/^\s*begin\b/i.test(sql)){
    await client.query("SET LOCAL timezone='UTC';SET LOCAL search_path=pg_catalog;SET LOCAL statement_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='10s'");
    witness=(await client.query(freshOwnerWitnessSql)).rows[0].witness;
    assert.equal(witness.isolation,'repeatable read');validateFreshOwnerWitness({before:ctx.before,boundary:ctx.boundary,witness});
    identity=(await client.query("SELECT current_database() AS database,current_user AS role,session_user AS session_role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS statement_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout,pg_backend_pid() AS pid,host(inet_server_addr()) AS server_address,clock_timestamp()::text AS database_time")).rows[0];
    assert.equal(identity.database,'postgres');assert.equal(identity.role,'postgres');assert.equal(identity.session_role,'postgres');assert.equal(identity.owner,'postgres');
    assert.equal(identity.read_only,'on');assert.equal(identity.isolation,'repeatable read');contextChecks++;
   }
   if(/\bfrom\s+(?:"?(?:public|app_private|auth|storage)"?)\./i.test(sql))sourceWorkingQueries++;
   return r;
  }};
  try{
   const snapshot=await snapshotDatabase(db,{fingerprintQuery:exactQueryFingerprint,beforeCommit:async transaction=>{
    authRows=(await transaction.query(authRowsSql)).rows;
    assert.equal((await transaction.query(freshOwnerWitnessSql)).rows[0].witness.pid,witness.pid);
   }});
   return {ok:true,protocol:'BRON_PRIVATE_SNAPSHOT_V1',projectRef:'vkkqffvmztpzgygzfxhq',
    tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',identity,snapshot,authRows,
    fenceWitness:{...witness,preDataValidated:true,sourceBarrierActionId:ctx.sourceBarrierActionId,sourceBarrierReceiptSha256:ctx.sourceBarrierReceiptSha256}};
  }finally{
   await client.query('ROLLBACK').catch(()=>{});await client.end();sourceClientsClosed++;
  }
 };
 const journal=conf+'/before-image.json';
 const removeJournal=()=>{try{unlinkSync(journal);}catch(e){if(e.code!=='ENOENT')throw e;}};
 const persistBeforeImage=async image=>{
  beforeImages++;const bytes=JSON.stringify(image),fd=openSync(journal,'wx',0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  const parent=openSync(conf,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  assert.equal(statSync(journal).mode&0o777,0o600);assert.equal(image.rows.length,1);
  return {path:activation.beforeImagePath,sha256:createHash('sha256').update(bytes).digest('hex'),durable:true,fsynced:true,rootOwned:true,mode:'0600'};
 };
 const watched={query:(sql,values)=>{if(/^UPDATE auth\.users AS u/.test(sql))updatesObserved++;return target.query(sql,values);}};
 const args=()=>({activation,ownerDataGrant,fenceContext:context,captureSourceFrame:capture(context),target:watched,verifyTarget,assertFence:async()=>proof,persistBeforeImage});
 const older="UPDATE auth.users SET updated_at='2026-11-13T12:00:00.000000Z' WHERE id='00000000-0000-4000-8000-000000000001'";
 const countOlder=async()=>(await target.query("SELECT count(*)::integer AS n FROM auth.users WHERE updated_at='2026-11-13T12:00:00.000000Z'")).rows[0].n;
 try{
  const version=(await target.query("SELECT current_setting('server_version') AS v")).rows[0].v;
  phase='exact-timestamp-commit';await write(adminTarget,older);const startFrames=sourceFrames;
  const result=await runFinalHttpsWindow(args());assert.equal(result.status,'PASS');assert.equal(result.finalFreezeAudit,true);
  assert.equal(result.changedAuthTimestampRows,1);assert.equal(result.targetWriteOutcome,'COMMITTED');assert.deepEqual(result.strictMismatchGroups,[]);
  assert.equal(result.sourceFrameAttempts,2);assert.equal(sourceFrames-startFrames,2);assert.equal(result.targetRolesAndDatabaseUnchanged,true);
  assert.equal(await countOlder(),0);assert.equal(updatesObserved,1);assert.equal(beforeImages,1);removeJournal();
  for(const value of ['SYNTHETIC_PRIVATE_PASSWORD','00000000-0000-4000-8000-000000000001','2026-11-13T12','9007199254740993'])assert.ok(!JSON.stringify(result).includes(value));
  phase='no-diff-no-write';const priorUpdates=updatesObserved;
  const unchanged=await runFinalHttpsWindow(args());assert.equal(unchanged.changedAuthTimestampRows,0);assert.equal(unchanged.targetWriteOutcome,'UNCHANGED');assert.equal(beforeImages,1);assert.equal(updatesObserved,priorUpdates);
  phase='non-auth-change-blocks';await write(adminTarget,"UPDATE app_private.marker SET value='TARGET_DIFF'");
  await assert.rejects(runFinalHttpsWindow(args()),e=>e.code==='FINAL_HTTPS_NON_AUTH_STRICT_MISMATCH'&&e.recovery.targetWriteOutcome==='UNCHANGED'&&JSON.stringify(e.mismatchGroups)==='["data:app_private.marker"]');
  await write(adminTarget,"UPDATE app_private.marker SET value='SYNTHETIC_MARKER'");
  phase='other-auth-field-blocks';await write(adminTarget,"UPDATE auth.users SET encrypted_password='OTHER_SYNTHETIC' WHERE id='00000000-0000-4000-8000-000000000001'");
  await assert.rejects(runFinalHttpsWindow(args()),e=>e.code==='FINAL_HTTPS_NON_TIMESTAMP_OR_DIRECTION_DIFF'&&e.recovery.targetWriteOutcome==='UNCHANGED');
  await write(adminTarget,"UPDATE auth.users SET encrypted_password='SYNTHETIC_PRIVATE_PASSWORD'");
  phase='before-image-failure-rolls-back';await write(adminTarget,older);
  await assert.rejects(runFinalHttpsWindow({...args(),persistBeforeImage:async()=>{throw new Error('PRIVATE_WRITER_ERROR');}}),e=>e.code==='FINAL_HTTPS_WINDOW_FAILED'&&e.recovery.targetWriteOutcome==='ROLLED_BACK'&&!e.message.includes('PRIVATE_WRITER_ERROR'));
  assert.equal(await countOlder(),1);
  phase='guarded-update-failure-rolls-back';await write(adminTarget,"CREATE FUNCTION auth.skip_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$; CREATE TRIGGER skip_timestamp BEFORE UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION auth.skip_timestamp()");
  await assert.rejects(runFinalHttpsWindow(args()),e=>e.code==='FINAL_HTTPS_GUARDED_UPDATE_NOT_EXACTLY_ONE'&&e.recovery.targetWriteOutcome==='ROLLED_BACK');
  assert.equal(await countOlder(),1);removeJournal();await write(adminTarget,'DROP TRIGGER skip_timestamp ON auth.users; DROP FUNCTION auth.skip_timestamp()');
  phase='lost-commit-response';const lost={query:async(sql,values)=>{const r=await watched.query(sql,values);if(sql==='COMMIT')throw new Error('Query read timeout');return r;}};
  await assert.rejects(runFinalHttpsWindow({...args(),target:lost}),e=>e.code==='FINAL_HTTPS_TARGET_COMMIT_UNKNOWN'&&e.recovery.targetWriteOutcome==='UNKNOWN'&&e.recovery.sourceMustRemainClosed);
  assert.equal(await countOlder(),0);removeJournal();
  phase='source-drift-even-if-final-match';await write(adminTarget,older);
  await assert.rejects(runFinalHttpsWindow({...args(),assertFence:async stage=>{if(stage==='before-final-audit'){
   await write(adminSource,"UPDATE app_private.marker SET value='BOTH_DRIFT'");await write(adminTarget,"UPDATE app_private.marker SET value='BOTH_DRIFT'");}return proof;}}),e=>e.code==='FINAL_HTTPS_SOURCE_CHANGED_UNDER_FENCE'&&e.recovery.targetWriteOutcome==='COMMITTED');
  removeJournal();await write(adminSource,"UPDATE app_private.marker SET value='SYNTHETIC_MARKER'");await write(adminTarget,"UPDATE app_private.marker SET value='SYNTHETIC_MARKER'");
  phase='database-metadata-drift';await write(adminTarget,older);
  await assert.rejects(runFinalHttpsWindow({...args(),assertFence:async stage=>{if(stage==='before-final-audit')await write(adminTarget,'ALTER DATABASE postgres CONNECTION LIMIT 7');return proof;}}),e=>e.code==='FINAL_HTTPS_TARGET_METADATA_DRIFT'&&e.recovery.targetWriteOutcome==='COMMITTED');
  removeJournal();await write(adminTarget,'ALTER DATABASE postgres CONNECTION LIMIT -1');
  phase='role-metadata-drift';await write(adminTarget,older);
  await assert.rejects(runFinalHttpsWindow({...args(),assertFence:async stage=>{if(stage==='before-final-audit')await write(adminTarget,'ALTER ROLE authenticator CONNECTION LIMIT 2');return proof;}}),e=>e.code==='FINAL_HTTPS_TARGET_METADATA_DRIFT'&&e.recovery.targetWriteOutcome==='COMMITTED');
  removeJournal();await write(adminTarget,'ALTER ROLE authenticator CONNECTION LIMIT -1');
  phase='stale-witness-before-working-rows';const staleContext=structuredClone(context);staleContext.boundary.capturedMicros=String(BigInt((await adminSource.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000000)::numeric::text AS micros")).rows[0].micros)+60000000n);
  const staleActivation={...activation,fenceContextSha256:createHash('sha256').update(JSON.stringify(staleContext)).digest('hex')};
  const priorWorking=sourceWorkingQueries,priorStaleUpdates=updatesObserved;
  await assert.rejects(runFinalHttpsWindow({...args(),activation:staleActivation,fenceContext:staleContext,captureSourceFrame:capture(staleContext)}),e=>e.recovery.targetWriteOutcome==='UNCHANGED'&&e.recovery.sourceMustRemainClosed);
  assert.equal(sourceWorkingQueries,priorWorking);assert.equal(updatesObserved,priorStaleUpdates);
  phase='missing-fence-no-read-or-write';const priorFrames=sourceFrames,priorMissingUpdates=updatesObserved;
  await assert.rejects(runFinalHttpsWindow({...args(),assertFence:async()=>({...proof,existingClientsDrained:false})}),e=>e.code==='FINAL_HTTPS_DURABLE_SOURCE_FENCE_NOT_PROVED'&&e.recovery.targetWriteOutcome==='UNCHANGED');
  assert.equal(sourceFrames,priorFrames);assert.equal(updatesObserved,priorMissingUpdates);
  assert.equal(sourceClientsClosed,sourceFrames);
  console.log(JSON.stringify({status:'PASS',scope:'SYNTHETIC_FINAL_HTTPS_CORE',serverVersion:version,node:process.versions.node,driver:'pg8.23.1',
   independentSourceAndTargetClusters:true,actualDatabaseAndOwnerPostgres:true,sameReadonlySnapshotAuthAndFullAudit:true,
   actualFreshBackendBeforeWorkingRows:true,sourceBeforeAndAfterCompared:true,sourceNewerMicrosecondPreserved:true,
   noDiffNoWrite:true,nonAuthMismatchBlocked:true,otherCredentialDerivedFieldMismatchBlocked:true,
   beforeImageFailureRollback:true,guardedUpdateFailureRollback:true,commitResponseLossUnknown:true,
   sourceDriftEvenMatchingFinalBlocked:true,databaseMetadataDriftBlocked:true,roleMetadataDriftBlocked:true,
   staleWitnessBeforeWorkingRowsBlocked:true,missingFenceBlocked:true,actualContextChecks:contextChecks,
   noRowsHashesOrTimestampValuesPrinted:true,productionSourceHttpTlsEncryptionAndFence:'NOT_TESTED_BY_THIS_FIXTURE',
   productionRootCustodyAndOneShotRunner:'NOT_TESTED_BY_THIS_FIXTURE'}));
 }finally{removeJournal();await Promise.allSettled(clients.map(c=>c.end()));}
}
try{await main();}catch{console.error(JSON.stringify({status:'FAIL',code:'FINAL_HTTPS_NATIVE_FAILED',phase}));process.exitCode=1;}
