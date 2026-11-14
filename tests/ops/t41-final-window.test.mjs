import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateManifest,requiredCode,validateControlEvidence,validateBudget,createBasePrepared,validateBasePrepared,
 validateRunInputs,targetIdentitySql,verifyFinalTargetIdentity,targetFromInspect,writeBeforeImage,probeTargetMetadata} from '../../docs/runbooks/payloads/t41-final-window.mjs';
import {SOURCE_TRANSFER_SCOPE_SHA256 as scope} from '../../docs/runbooks/payloads/source-transfer-budget.mjs';

const root='/root/bron-secrets',dir=root+'/t41-release',runtime=root+'/t41-runtime',project='vkkqffvmztpzgygzfxhq',vps='152.228.115.115';
const adopted='a8f777d95d53b365959530a0bbce4a42b21840dc92bf1180c65eaa7dd74136f8',manifestSha='1'.repeat(64),now=Date.parse('2026-11-14T12:00:00Z');
const sha=x=>createHash('sha256').update(x).digest('hex'),bytes=x=>Buffer.from(JSON.stringify(x)+'\n');
const paths={beforeImagePath:root+'/t40-admission-before-c40a2026.json',metadataReceiptPath:root+'/t40-admission-metadata-c40a2026.json',
 inversePath:root+'/t40-admission-inverse-c40a2026.sql',controlReceiptPath:root+'/t40-admission-control-c40a2026.json'};
const sqlHashes=()=>Object.fromEntries(['applySql','drainSql','verifyFencedSql','inverseSql','verifyOriginalSql'].map((k,i)=>[k,String(i+2).repeat(64)]));
function fixture(options={}){
 const keyProofBytes=bytes({format:1,kind:'SYNTHETIC_PROOF'}),keySha=sha(keyProofBytes),cipherSha='c'.repeat(64);
 const ownerInputs={crypto:{path:root+'/t30-owner-key-proof-result.json',sha256:'d'.repeat(64)},
  attestation:{path:root+'/t30-owner-key-attestation.json',sha256:'e'.repeat(64)},receipt:{path:root+'/t30-release-receipt.json',sha256:'f'.repeat(64)},
  reviewedT30CipherBinding:{reviewed:true,task:'T30',cryptoResultSha256:'d'.repeat(64),sourceReceiptSha256:'f'.repeat(64),cipherSha256:cipherSha}};
 const m={task:'T41',execution_authorized:true,actionId:'T41.release_window',approval:{status:'APPROVED',document_sha256:scope},
  adopts:{actionId:'T40.http_source_admission',manifestSha256:adopted,custody:{...paths}},
  phase_authorizations:{prepare_control_ready:{actionId:'T41.prepare_control_ready',control_ready_only:true,source_sql_authorized:false,
   provider_boundary_reviewed:true,rollback_before_target_writes:true},prepare_final:{actionId:'T41.prepare_final',capability_ttl_seconds:7200,source_data_reads:0,target_metadata_probe:1},
   run_final:{actionId:'T41.final_https_window',sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,applyTimestampOnly:true,
    beforeImagePath:root+'/t41-auth-before-c41a2026.json',targetAdmitted:false,maxTimestampUpdates:16,wall_seconds:480}},
  source:{origin:'https://'+project+'.supabase.co',projectRef:project,protocol:'BRON_PRIVATE_SNAPSHOT_V1',capability_binding:'pinned_VPS_prepare_readback',template_name_prefix:'bron-source-reader-'},
  transfer_budget:{directory:root+'/source-transfer-budget',scope_sha256:scope,source_project:project,destination_vps:vps,max_attempts:3},
  target:{container_id:'a'.repeat(64),image_id:'sha256:'+'b'.repeat(64)},
  owner_proof:{independentProofSha256:keySha,recoveryCipherSha256:cipherSha,inputs:ownerInputs},
  input_evidence:{T40_result_sha256:'2'.repeat(64),T40_receipt_sha256:'3'.repeat(64),T40_before_image_sha256:'4'.repeat(64),T40_metadata_receipt_sha256:'5'.repeat(64)},
  files:Object.fromEntries(requiredCode.map(p=>[p,'6'.repeat(64)])),runtime_files:Object.fromEntries(requiredCode.map(p=>[runtime+'/'+p,'7'.repeat(64)]))};
 const control={format:1,status:'CONTROL_READY',actionId:'T40.http_source_admission',manifestSha256:adopted,sourceProject:project,destinationVps:vps,
  ...paths,beforeImageSha256:m.input_evidence.T40_before_image_sha256,metadataReceiptSha256:m.input_evidence.T40_metadata_receipt_sha256,
  independentKeyProofSha256:keySha,recoveryCipherSha256:cipherSha,sqlHashes:sqlHashes(),sourceEffects:false,sourceBarrierPass:false};
 const controlBytes=bytes(control),summary={task:'T41',status:'CONTROL_READY',actionId:'T41.prepare_control_ready',parentActionId:'T41.release_window',
  authorizationManifestSha256:manifestSha,adoptedActionId:'T40.http_source_admission',adoptedManifestSha256:adopted,...paths,
  beforeImageSha256:control.beforeImageSha256,metadataReceiptSha256:control.metadataReceiptSha256,controlReceiptSha256:sha(controlBytes),
  independentKeyProofPath:root+'/t40-admission-key-proof-c40a2026.json',independentKeyProofSha256:keySha,inverseSha256:control.sqlHashes.inverseSql,
  sqlHashes:control.sqlHashes,sourceEffects:false,sourceBarrierPass:false,targetWritesStarted:false,macDataTransit:false,t40ArtifactsUnchanged:true};
 const evidenceArgs={summaryBytes:bytes(summary),controlBytes,keyProofBytes};
 const evidence=validateControlEvidence(evidenceArgs,m,manifestSha);
 let held,secret;const base=createBasePrepared({manifestSha256:manifestSha,controlEvidence:evidence,now,
  random:()=>Buffer.alloc(32,1),writeSecret:b=>{held=b;secret=Buffer.from(b);}});
 const barrier={format:1,task:'T41',actionId:'T40.http_source_admission',manifestSha256:manifestSha,controlReceiptSha256:evidence.controlReceiptSha256,
  sourceProject:project,destinationVps:vps,status:'SOURCE_ADMISSION_CLOSED',normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,
  providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false,before:{backends:[{pid:100}]},
  boundary:{capturedMicros:'1794657600000000',ownerPids:[101]},
  witness:{db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',pid:200,backendStartMicros:'1794657600000001'}};
 options.barrier?.(barrier);const barrierBytes=bytes(barrier),barrierSha=sha(barrierBytes);
 const context={sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:barrierSha,before:structuredClone(barrier.before),boundary:structuredClone(barrier.boundary)};
 options.context?.(context);const contextSha=sha(JSON.stringify(context));
 const finalPrepared={...base,fenceContextSha256:contextSha},basePreparedBytes=bytes(base),finalPreparedBytes=bytes(finalPrepared);
 const input={format:1,task:'T41',actionId:'T41.final_https_window',manifestSha256:manifestSha,basePreparedSha256:sha(basePreparedBytes),
  finalPreparedSha256:sha(finalPreparedBytes),controlSummarySha256:evidence.controlSummarySha256,controlReceiptSha256:evidence.controlReceiptSha256,
  barrierReceiptPath:dir+'/source-barrier.json',barrierReceiptSha256:barrierSha,fenceContextSha256:contextSha,fenceContext:context};
 options.input?.(input);const inputBytes=bytes(input);
 return {m,control,summary,evidenceArgs,evidence,base,held,secret,barrier,context,input,finalPrepared,
  args:{inputBytes,inputSha256:sha(inputBytes),basePreparedBytes,finalPreparedBytes,barrierBytes,manifest:m,manifestSha256:manifestSha,controlEvidence:evidence,now}};
}
const identity=()=>({database:'postgres',role:'supabase_admin',session_role:'supabase_admin',read_only:'on',isolation:'repeatable read',
 statement_timeout:'5s',lock_timeout:'5s',idle_timeout:'10s',timezone:'UTC',search_path:'pg_catalog',server_address:'172.18.0.3',server_port:5432,cron:'off',net:'0'});
const inspected=()=>({Id:'a'.repeat(64),Image:'sha256:'+'b'.repeat(64),Name:'/supabase-db',State:{Running:true},
 Config:{Env:['POSTGRES_USER=supabase_admin','POSTGRES_DB=postgres','POSTGRES_PASSWORD=SYNTHETIC_%41:@/é','PGPASSWORD=SYNTHETIC_%41:@/é']},
 NetworkSettings:{Networks:{supabase_default:{IPAddress:'172.18.0.3'}}}});

test('import/noargs CLI and unsupported activation remain inert',()=>{
 const file=path.resolve('docs/runbooks/payloads/t41-final-window.mjs');
 const i=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:1500});assert.equal(i.status,0);assert.equal(i.stdout+i.stderr,'');
 for(const args of [[],['--prepare-final'],['--run-final']]){const c=spawnSync(process.execPath,[file,...args],{encoding:'utf8',timeout:1500});
  assert.equal(c.status,2);assert.equal(c.stderr,'');assert.match(c.stdout,/T41_FINAL_EXPLICIT_REVIEW_REQUIRED/);assert.doesNotMatch(c.stdout,/SYNTHETIC_|private_id|updated_at/);}
});
test('manifest binds separate prepare/read-only and run/timestamp-only phases with all runtime pins',()=>{
 const f=fixture(),raw=bytes(f.m);assert.equal(validateManifest(raw,sha(raw),'6'.repeat(64)).task,'T41');
 for(const edit of [m=>m.approval.document_sha256='0'.repeat(64),m=>m.phase_authorizations.prepare_final.source_data_reads=1,
  m=>m.phase_authorizations.run_final.sourceFrameBudget=3,m=>m.phase_authorizations.run_final.applyTimestampOnly=false,
  m=>m.phase_authorizations.run_final.targetAdmitted=true,m=>m.phase_authorizations.run_final.maxTimestampUpdates=17,
  m=>m.source.origin='https://other.invalid',m=>m.transfer_budget.max_attempts=4,m=>m.target.container_id='wrong',
  m=>delete m.runtime_files[runtime+'/scripts/migration-audit.mjs']]){
  const m=structuredClone(f.m);edit(m);const r=bytes(m);assert.throws(()=>validateManifest(r,sha(r),'6'.repeat(64)));
 }
});
test('CONTROL_READY must bind summary, canonical control bytes, key-proof bytes and exact five SQL hashes',()=>{
 const f=fixture();assert.equal(f.evidence.controlReceiptSha256,sha(f.evidenceArgs.controlBytes));
 for(const edit of [s=>s.authorizationManifestSha256='0'.repeat(64),s=>s.sourceBarrierPass=true,s=>s.targetWritesStarted=true,
  s=>s.independentKeyProofSha256='0'.repeat(64),s=>s.controlReceiptSha256='0'.repeat(64),s=>s.sqlHashes={...s.sqlHashes,otherSql:'8'.repeat(64)}]){
  const s=structuredClone(f.summary);edit(s);assert.throws(()=>validateControlEvidence({...f.evidenceArgs,summaryBytes:bytes(s)},f.m,manifestSha),{code:'T41_FINAL_CONTROL_NOT_PROVED'});
 }
 const c=structuredClone(f.control);c.sqlHashes.verifyFencedSql='0'.repeat(64);const controlBytes=bytes(c),s={...f.summary,controlReceiptSha256:sha(controlBytes)};
 assert.throws(()=>validateControlEvidence({...f.evidenceArgs,controlBytes,summaryBytes:bytes(s)},f.m,manifestSha));
 assert.throws(()=>validateControlEvidence({...f.evidenceArgs,keyProofBytes:bytes({different:true})},f.m,manifestSha));
});
test('prepare generates only fresh two-hour capability metadata and wipes temporary entropy/secret',()=>{
 const f=fixture();assert.ok(f.held.every(x=>x===0));assert.equal(f.secret.toString(),'01'.repeat(32));assert.equal(f.base.capabilitySha256,sha(f.secret));
 assert.equal(Date.parse(f.base.expiresUtc)-Date.parse(f.base.createdUtc),7200000);assert.equal(f.base.functionName,'bron-source-reader-'+sha(f.secret).slice(0,12));
 validateBasePrepared(f.base,manifestSha,f.evidence,now);
 assert.throws(()=>createBasePrepared({manifestSha256:manifestSha,controlEvidence:f.evidence,now,random:()=>Buffer.alloc(31),writeSecret:()=>assert.fail()}),{code:'T41_FINAL_ENTROPY'});
 for(const patch of [{expiresUtc:new Date(now+10000).toISOString()},{ownerGrantSha256:'0'.repeat(64)},
  {controlSummarySha256:'0'.repeat(64)},{functionName:'other'},{extra:'PRIVATE'}])assert.throws(()=>validateBasePrepared({...f.base,...patch},manifestSha,f.evidence,now));
});
test('Auth transfer budget must remain one spent live attempt before final preparation/activation',()=>{
 const s={used:1,remaining:2,maxAttempts:3,uncertain:false,claims:[{attempt:1,status:'VALID',actionId:'T37.live',capabilitySha256:'9'.repeat(64)}]};validateBudget(s);
 for(const edit of [s=>s.used=0,s=>s.used=2,s=>s.uncertain=true,s=>s.claims[0].actionId='T40.final_before',s=>s.claims[0].status='UNCERTAIN',s=>s.claims[0].capabilitySha256='bad']){
  const r=structuredClone(s);edit(r);assert.throws(()=>validateBudget(r),{code:'T41_FINAL_AUTH_BUDGET'});
 }
});
test('Root input binds immutable base, final capability, current barrier and exact context to reviewed task',()=>{
 const f=fixture(),v=validateRunInputs(f.args);assert.equal(v.activation.actionId,'T41.final_https_window');assert.equal(v.activation.sourceFrameBudget,2);
 assert.equal(v.ownerDataGrant.maxAuthSnapshots,3);assert.equal(v.ownerDataGrant.macDataTransit,false);assert.equal(v.activation.applyTimestampOnly,true);
 assert.equal(v.barrierProof.sourcePaused,false);f.input.fenceContext.before.backends[0].pid=999;assert.equal(v.fenceContext.before.backends[0].pid,100);
 for(const edit of [x=>x.manifestSha256='0'.repeat(64),x=>x.basePreparedSha256='0'.repeat(64),x=>x.finalPreparedSha256='0'.repeat(64),
  x=>x.controlReceiptSha256='0'.repeat(64),x=>x.barrierReceiptPath='/tmp/barrier',x=>x.extra='PRIVATE'])assert.throws(()=>validateRunInputs(fixture({input:edit}).args));
 assert.throws(()=>validateRunInputs({...f.args,inputSha256:'0'.repeat(64)}),{code:'T41_FINAL_ROOT_INPUT_SHA'});
});
test('barrier must prove all closed-source predicates and genuinely fresh positive physical backend',()=>{
 for(const edit of [b=>b.normalConnectDenied=false,b=>b.sourcePaused=true,b=>b.controlReceiptSha256='0'.repeat(64),
  b=>b.witness.pid=100,b=>b.witness.pid=-1,b=>b.witness.pid=2147483648,b=>b.witness.backendStartMicros=b.boundary.capturedMicros,
  b=>b.witness.readOnly='off',b=>b.witness.isolation='read committed',b=>b.status='OPEN']){
  assert.throws(()=>validateRunInputs(fixture({barrier:edit}).args),{code:'T41_FINAL_BARRIER_NOT_PROVED'});
 }
 for(const edit of [c=>c.boundary.capturedMicros='bad',c=>c.before.backends[0].pid=-1,c=>c.before.backends[0].extra='PRIVATE',
  c=>c.before.backends=Array.from({length:1001},(_,i)=>({pid:i+1}))])
  assert.throws(()=>validateRunInputs(fixture({context:edit}).args),{code:'T41_FINAL_FENCE_CONTEXT'});
});
test('target identity admits only RR/readonly or SERIALIZABLE/readwrite with all actual target settings',()=>{
 verifyFinalTargetIdentity(identity(),['172.18.0.3']);verifyFinalTargetIdentity({...identity(),read_only:'off',isolation:'serializable'},['172.18.0.3']);
 assert.match(targetIdentitySql,/statement_timeout/);assert.match(targetIdentitySql,/lock_timeout/);assert.match(targetIdentitySql,/cron.launch_active_jobs/);
 for(const patch of [{read_only:'off'},{isolation:'serializable'},{timezone:'localtime'},{search_path:'public'},{lock_timeout:'0'},
  {role:'postgres'},{session_role:'postgres'},{server_address:'192.0.2.1'},{server_port:15433},{cron:'on'},{net:'1'},{statement_timeout:'0'},{idle_timeout:'0'}])
  assert.throws(()=>verifyFinalTargetIdentity({...identity(),...patch},['172.18.0.3']));
});
test('target Docker identity/image and credentials cannot redirect connection or leak percent-escaped password',()=>{
 const f=fixture(),c=targetFromInspect([inspected()],f.m),u=new URL(c.url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'15433');
 assert.equal(u.username,'supabase_admin');assert.equal(decodeURIComponent(u.password),'SYNTHETIC_%41:@/é');assert.deepEqual(c.addresses,['172.18.0.3']);
 for(const edit of [c=>c.Id='0'.repeat(64),c=>c.Image='sha256:'+'0'.repeat(64),c=>c.State.Running=false,
  c=>c.Config.Env.push('POSTGRES_USER=postgres'),c=>c.NetworkSettings.Networks.supabase_default.IPAddress='not-ip']){
  const c=inspected();edit(c);assert.throws(()=>targetFromInspect([c],f.m));
 }
});
test('actual before-image is exclusive0600 with exact microseconds, readback and honest nonroot ownership',{skip:process.getuid?.()===0},()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bron-t41-before-'));fs.chmodSync(directory,0o700);const filename=directory+'/before.json';
 try{const value={rows:[{private_id:'00000000-0000-4000-8000-000000000001',private_source:'2026-11-14 12:00:00.000001+00',private_before:'2026-11-14 12:00:00.000000+00'}]};
  const r=writeBeforeImage(filename,value,{uid:process.getuid()});assert.equal(r.rootOwned,process.getuid()===0);assert.equal(r.mode,'0600');assert.equal(r.durable,true);assert.equal(r.fsynced,true);
  const s=fs.statSync(filename),b=fs.readFileSync(filename);assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o7777,0o600);assert.equal(r.sha256,sha(b));assert.deepEqual(JSON.parse(b),value);
  assert.throws(()=>writeBeforeImage(filename,value,{uid:process.getuid()}),{code:'EEXIST'});
  const link=directory+'/link.json';fs.symlinkSync(filename,link);assert.throws(()=>writeBeforeImage(link,value,{uid:process.getuid()}),{code:'EEXIST'});
  assert.throws(()=>writeBeforeImage(directory+'/giant', 'x'.repeat(4194304),{uid:process.getuid()}),{code:'T41_FINAL_BEFORE_IMAGE_BOUND'});
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('before-image fsync failure leaves spent private artifact and never silently rewrites or claims success',{skip:process.getuid?.()===0},t=>{
 for(const failAt of [1,2]){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bron-t41-sync-'));fs.chmodSync(directory,0o700);const filename=directory+'/before.json';
  try{let calls=0;const original=fs.fsyncSync,m=t.mock.method(fs,'fsyncSync',fd=>{if(++calls===failAt)throw Error('SYNTHETIC_FSYNC_FAILURE');return original(fd);});
   assert.throws(()=>writeBeforeImage(filename,{private_stamp:'2026-11-14 12:00:00.000001+00'},{uid:process.getuid()}),/SYNTHETIC_FSYNC_FAILURE/);m.mock.restore();
   assert.equal(fs.existsSync(filename),true);assert.equal(fs.statSync(filename).mode&0o7777,0o600);
   assert.throws(()=>writeBeforeImage(filename,{},{uid:process.getuid()}),{code:'EEXIST'});
  }finally{t.mock.restoreAll();fs.rmSync(directory,{recursive:true,force:true});}
 }
});
test('before-image rejects unreviewed path/owner and weak or special directory permissions',{skip:process.getuid?.()===0},()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bron-t41-path-'));try{
  assert.throws(()=>writeBeforeImage('/tmp/elsewhere/before.json',{}, {uid:process.getuid()+1}),{code:'T41_FINAL_BEFORE_IMAGE_PATH'});
  for(const mode of [0o755,0o1700]){fs.chmodSync(directory,mode);assert.throws(()=>writeBeforeImage(directory+'/before.json',{}, {uid:process.getuid()}),{code:'T41_FINAL_PRIVATE_DIRECTORY'});}
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});


test('prepare target preflight reads only one tiny RR identity and rolls back before Source freeze',async()=>{
 const calls=[];const target={connect:async()=>calls.push('connect'),query:async sql=>{calls.push(sql);return sql===targetIdentitySql?{rows:[identity()]}:{rows:[]};}};
 const proof=await probeTargetMetadata(target,['172.18.0.3']);assert.deepEqual(proof,{status:'PASS',readonly:true,rollbackCompleted:true,authOrBusinessRowsRead:false});
 assert.equal(calls.filter(x=>x===targetIdentitySql).length,1);assert.equal(calls[0],'connect');assert.match(calls[1],/^BEGIN.*REPEATABLE READ READ ONLY$/);assert.equal(calls.at(-1),'ROLLBACK');
 assert.equal(calls.some(sql=>/auth\.users|UPDATE|INSERT|CREATE|COMMIT/.test(sql)),false);
 for(const patch of [{read_only:'off',isolation:'serializable'},{server_address:'192.0.2.1'},{cron:'on'},{lock_timeout:'0'}]){
  const failed=[];const bad={connect:async()=>{},query:async sql=>{failed.push(sql);return {rows:sql===targetIdentitySql?[{...identity(),...patch}]:[]};}};
  await assert.rejects(probeTargetMetadata(bad,['172.18.0.3']),{code:'T41_FINAL_TARGET_PREFLIGHT_FAILED'});assert.equal(failed.at(-1),'ROLLBACK');
 }
});
