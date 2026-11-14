// Synthetic native fixture only. Actual production fence/route/writer are not used.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import {createHash} from 'node:crypto';
import {openSync,writeFileSync,fsyncSync,closeSync,statSync,unlinkSync} from 'node:fs';
import pg from '../../node_modules/pg/lib/index.js';
import {runFinalAuthWindow} from '../../docs/runbooks/payloads/final-auth-window.mjs';
let phase='setup';
async function main(){
 assert.equal(process.argv.length,5);const [cid,conf,docker]=process.argv.slice(2);
 assert.match(cid,/^[a-f0-9]{64}$/);assert.ok(['/usr/local/bin/docker','/usr/bin/docker','/bin/docker'].includes(docker));
 const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:conf};
 const [container]=JSON.parse(execFileSync(docker,['--host','unix:///var/run/docker.sock','inspect',cid],{env,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}));
 const marker=container.Config?.Labels?.['bron.test.native-pg17'];assert.match(marker??'',/^[a-f0-9]{32}$/);
 assert.equal(container.Name,'/bron-native-pg17-'+marker);assert.equal(container.HostConfig.NetworkMode,'none');
 assert.equal(Object.keys(container.HostConfig.PortBindings??{}).length,0);assert.ok(container.Mounts.every(m=>m.Type==='tmpfs'));
 class PgPipe extends Duplex{
  constructor(){super();this.child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,'nc','127.0.0.1','5432'],{env,stdio:['pipe','pipe','pipe']});
   this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));this.child.stderr.resume();
   this.child.on('error',e=>this.destroy(e));this.child.stdin.on('error',e=>this.destroy(e));}
  connect(){queueMicrotask(()=>this.emit('connect'));return this;}setNoDelay(){}setKeepAlive(){}ref(){}unref(){}
  _read(){this.child.stdout.resume();}_write(b,e,cb){this.child.stdin.write(b,e,cb);}_final(cb){this.child.stdin.end(cb);}_destroy(e,cb){this.child.kill();cb(e);}
 }
 const clients=[];
 const open=async(user,database)=>{const c=new pg.Client({stream:()=>new PgPipe(),user,database,ssl:false,query_timeout:12000,
  options:'-c default_transaction_read_only=on -c cron.launch_active_jobs=off -c pg_net.batch_size=0'});c.on('error',()=>{});clients.push(c);await c.connect();return c;};
 const source=await open('postgres','source_window'),target=await open('supabase_admin','target_window');
 const adminSource=await open('supabase_admin','source_window'),adminTarget=await open('supabase_admin','target_window');
 const write=async(db,sql)=>{await db.query('BEGIN READ WRITE');try{await db.query(sql);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}};
 const activation={actionId:'T31.final_auth_window',reviewed:true,manifestSha256:'a'.repeat(64),sourceBarrierActionId:'T31.http_source_admission',
  sourceBarrierReceiptSha256:'b'.repeat(64),targetAdmitted:false,sourceRoute:'canonical-transaction-direct',targetRoute:'verified-loopback-15433',
  expectedAuthRows:16,maxTimestampUpdates:1,beforeImagePath:'/root/bron-secrets/t31-auth-before-01234567.json'};
 const proof={sourceBarrierActionId:activation.sourceBarrierActionId,sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,
  normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
 let actualContextChecks=0,updatesObserved=0,beforeImages=0;
 const verify=user=>async db=>{const r=(await db.query("SELECT current_user AS role,current_setting('transaction_read_only') AS mode,current_setting('transaction_isolation') AS isolation,current_setting('timezone') AS zone,current_setting('statement_timeout') AS deadline,current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net")).rows[0];
  assert.equal(r.role,user);assert.ok(['on','off'].includes(r.mode));assert.ok(['repeatable read','serializable'].includes(r.isolation));
  assert.equal(r.zone,'UTC');assert.equal(r.deadline,'5s');assert.equal(r.cron,'off');assert.equal(r.net,'0');actualContextChecks++;};
 const journal=conf+'/before-image.json';
 const persistBeforeImage=async image=>{beforeImages++;const bytes=JSON.stringify(image);const fd=openSync(journal,'wx',0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(conf,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  assert.equal(statSync(journal).mode&0o777,0o600);assert.equal(image.rows.length,1);
  // Native callback maps a synthetic temp journal to the production path contract.
  // Actual /root path safety/fsync implementation remains the future runner's job.
  return {path:activation.beforeImagePath,sha256:createHash('sha256').update(bytes).digest('hex'),durable:true,fsynced:true,rootOwned:true,mode:'0600'};};
 const watched={query:(sql,args)=>{if(/^UPDATE auth\.users AS u/.test(sql))updatesObserved++;return target.query(sql,args);}};
 const args=()=>({activation,source,target:watched,verifySource:verify('postgres'),verifyTarget:verify('supabase_admin'),
  assertFence:async()=>proof,persistBeforeImage});
 const older="UPDATE auth.users SET updated_at='2026-11-13T12:00:00.000000Z' WHERE id='00000000-0000-4000-8000-000000000001'";
 const countOlder=async()=>(await target.query("SELECT count(*)::integer AS n FROM auth.users WHERE updated_at='2026-11-13T12:00:00.000000Z'")).rows[0].n;
 const removeJournal=()=>{try{unlinkSync(journal);}catch(e){if(e.code!=='ENOENT')throw e;}};
 try{
  const version=(await target.query("SELECT current_setting('server_version') AS v")).rows[0].v;
  phase='exact-timestamp-commit';await write(adminTarget,older);
  const result=await runFinalAuthWindow(args());assert.equal(result.status,'PASS');assert.equal(result.finalFreezeAudit,true);
  assert.equal(result.changedAuthTimestampRows,1);assert.equal(result.targetWriteOutcome,'COMMITTED');assert.deepEqual(result.strictMismatchGroups,[]);
  assert.equal(result.targetRolesAndDatabaseUnchanged,true);assert.equal(await countOlder(),0);assert.equal(updatesObserved,1);assert.equal(beforeImages,1);removeJournal();
  for(const value of ['SYNTHETIC_PRIVATE_PASSWORD','00000000-0000-4000-8000-000000000001','2026-11-13T12','9007199254740993'])assert.ok(!JSON.stringify(result).includes(value));
  phase='no-diff-no-write';const unchanged=await runFinalAuthWindow(args());assert.equal(unchanged.changedAuthTimestampRows,0);assert.equal(unchanged.targetWriteOutcome,'UNCHANGED');assert.equal(beforeImages,1);
  phase='non-auth-change-blocks';await write(adminTarget,"UPDATE app_private.marker SET value='TARGET_DIFF'");
  await assert.rejects(runFinalAuthWindow(args()),e=>e.code==='FINAL_AUTH_NON_AUTH_STRICT_MISMATCH'&&e.recovery.targetWriteOutcome==='UNCHANGED'&&
   JSON.stringify(e.mismatchGroups)==='["data:app_private.marker"]');
  await write(adminTarget,"UPDATE app_private.marker SET value='SYNTHETIC_MARKER'");
  phase='before-image-failure-rolls-back';await write(adminTarget,older);
  await assert.rejects(runFinalAuthWindow({...args(),persistBeforeImage:async()=>{throw new Error('PRIVATE_WRITER_ERROR');}}),
   e=>e.code==='FINAL_AUTH_WINDOW_FAILED'&&e.recovery.targetWriteOutcome==='ROLLED_BACK'&&!e.message.includes('PRIVATE_WRITER_ERROR'));
  assert.equal(await countOlder(),1);
  phase='guarded-update-failure-rolls-back';await write(adminTarget,"CREATE FUNCTION auth.skip_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL;END$$; CREATE TRIGGER skip_timestamp BEFORE UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION auth.skip_timestamp()");
  await assert.rejects(runFinalAuthWindow(args()),e=>e.code==='FINAL_AUTH_GUARDED_UPDATE_NOT_EXACTLY_ONE'&&e.recovery.targetWriteOutcome==='ROLLED_BACK');
  assert.equal(await countOlder(),1);removeJournal();await write(adminTarget,'DROP TRIGGER skip_timestamp ON auth.users; DROP FUNCTION auth.skip_timestamp()');
  phase='lost-commit-response';const lost={query:async(sql,params)=>{const result=await watched.query(sql,params);if(sql==='COMMIT')throw new Error('Query read timeout');return result;}};
  await assert.rejects(runFinalAuthWindow({...args(),target:lost}),e=>e.code==='FINAL_AUTH_TARGET_COMMIT_UNKNOWN'&&e.recovery.targetWriteOutcome==='UNKNOWN'&&e.recovery.sourceMustRemainClosed);
  assert.equal(await countOlder(),0);removeJournal();
  phase='source-drift-even-if-final-match';await write(adminTarget,older);
  await assert.rejects(runFinalAuthWindow({...args(),assertFence:async stage=>{if(stage==='before-final-audit'){
   await write(adminSource,"UPDATE app_private.marker SET value='BOTH_DRIFT'");await write(adminTarget,"UPDATE app_private.marker SET value='BOTH_DRIFT'");}return proof;}}),
   e=>e.code==='FINAL_AUTH_SOURCE_CHANGED_UNDER_FENCE'&&e.recovery.targetWriteOutcome==='COMMITTED');removeJournal();
  await write(adminSource,"UPDATE app_private.marker SET value='SYNTHETIC_MARKER'");await write(adminTarget,"UPDATE app_private.marker SET value='SYNTHETIC_MARKER'");
  phase='database-metadata-drift';await write(adminTarget,older);
  await assert.rejects(runFinalAuthWindow({...args(),assertFence:async stage=>{if(stage==='before-final-audit')await write(adminTarget,'ALTER DATABASE target_window CONNECTION LIMIT 7');return proof;}}),
   e=>e.code==='FINAL_AUTH_TARGET_METADATA_DRIFT'&&e.recovery.targetWriteOutcome==='COMMITTED');removeJournal();
  await write(adminTarget,'ALTER DATABASE target_window CONNECTION LIMIT -1');
  phase='role-metadata-drift';await write(adminTarget,older);
  await assert.rejects(runFinalAuthWindow({...args(),assertFence:async stage=>{if(stage==='before-final-audit')await write(adminTarget,'ALTER ROLE authenticator CONNECTION LIMIT 2');return proof;}}),
   e=>e.code==='FINAL_AUTH_TARGET_METADATA_DRIFT'&&e.recovery.targetWriteOutcome==='COMMITTED');removeJournal();
  await write(adminTarget,'ALTER ROLE authenticator CONNECTION LIMIT -1');
  phase='fence-missing-no-write';const prior=updatesObserved;
  await assert.rejects(runFinalAuthWindow({...args(),assertFence:async()=>({...proof,existingClientsDrained:false})}),
   e=>e.code==='FINAL_AUTH_DURABLE_SOURCE_FENCE_NOT_PROVED'&&e.recovery.targetWriteOutcome==='UNCHANGED');assert.equal(updatesObserved,prior);
  console.log(JSON.stringify({status:'PASS',scope:'SYNTHETIC_FINAL_AUTH_WINDOW',serverVersion:version,driver:'pg8.23.1',
   exactFullAuditBeforeAndAfter:true,sourceNewerMicrosecondPreserved:true,noDiffNoWrite:true,nonAuthMismatchBlocked:true,
   beforeImageFailureRollback:true,guardedUpdateFailureRollback:true,commitResponseLossUnknown:true,sourceDriftEvenMatchingFinalBlocked:true,
   databaseMetadataDriftBlocked:true,roleMetadataDriftBlocked:true,missingFenceBlocked:true,safeMismatchGroupsPreserved:true,actualContextChecks,noRowsHashesOrTimestampValuesPrinted:true,
   productionFenceAndPrivateWriter:'NOT_TESTED'}));
 }finally{removeJournal();await Promise.allSettled(clients.map(c=>c.end()));}
}
try{await main();}catch{console.error(JSON.stringify({status:'FAIL',code:'FINAL_WINDOW_NATIVE_FAILED',phase}));process.exitCode=1;}
