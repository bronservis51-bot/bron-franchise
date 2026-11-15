import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {expectedPins,sourceRuntimeHashes,targetIdentitySql,validateManifest,validatePriorFailure,validateT55Evidence,
 createPrepared,validatePrepared,expectedSourceFiles,validateDeployment,validateReadyResponse,validateCoordinatorReady,
 activationFromPrepared,parseArguments} from '../../docs/runbooks/payloads/t53-final-window.mjs';
import {targetIdentitySql as originalTargetIdentitySql} from '../../docs/runbooks/payloads/t45-final-window.mjs';
import {createCoordinatorFenceAck} from '../../docs/runbooks/payloads/coordinator-fence-ack-t53.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=x=>Buffer.from(canonical(x)+'\n');
const now=Date.parse('2026-11-15T08:00:00.000Z'),manifestSha='a'.repeat(64),selfSha='b'.repeat(64),ackSha='c'.repeat(64);
const control={controlSummarySha256:'d'.repeat(64),controlReceiptSha256:'e'.repeat(64),independentKeyProofSha256:'f'.repeat(64)};
const beforePath='/root/bron-secrets/t53-auth-before-c53a2026.json';
function manifest(){return {task:'T53',actionId:'T53.release_window',execution_authorized:true,maxSuccessorWindows:1,pins:expectedPins,
 t55ReceiptSha256:'1'.repeat(64),t55ResultSha256:'2'.repeat(64),approval:{status:'APPROVED',document_sha256:expectedPins.ownerGrantSha256},
 files:{'docs/runbooks/payloads/t53-final-window.mjs':selfSha,'docs/runbooks/payloads/coordinator-fence-ack-t53.mjs':ackSha,
  'docs/runbooks/payloads/source-final-https-reader/index.ts':expectedPins.sourceTemplateSha256},
 phase_authorizations:{prepare_final:{actionId:'T53.prepare_final',capability_ttl_seconds:7200,source_data_reads:0,target_metadata_probe:1},
  run_final:{actionId:'T53.final_https_window',applyTimestampOnly:true,maxTimestampUpdates:1,sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,beforeImagePath:beforePath,wall_seconds:480,targetAdmitted:false}}};}
function prepared(at=now){
 return createPrepared({manifestSha256:manifestSha,controlEvidence:control,now:at,random:()=>Buffer.alloc(32,15),writeSecret:()=>{}});
}
function context(){return {before:{backends:[5960,5961,5968,349125,1414968,1658737,1661141,1661142,1661169,1661170,1661175].map(pid=>({pid}))},
 boundary:{capturedMicros:'1794709552349448',ownerPids:[1747293]},sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256};}
const barrier={normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
const template=fs.readFileSync(new URL('../../docs/runbooks/payloads/source-final-https-reader/index.ts',import.meta.url));

test('target identity query remains byte-exact and a real SELECT',()=>{
 assert.equal(targetIdentitySql,originalTargetIdentitySql);
 assert.match(targetIdentitySql,/^SELECT current_database\(\)/);
});
test('T53 manifest pins one new two-frame max1 window and both real T55 hashes',()=>{
 const check=m=>{const raw=encode(m);return validateManifest(raw,hash(raw),selfSha,ackSha);};
 assert.equal(check(manifest()).task,'T53');
 for(const change of [m=>m.task='T45',m=>m.actionId='T49.final_https_window',m=>m.maxSuccessorWindows=2,
  m=>m.t55ReceiptSha256='<pending>',m=>m.t55ResultSha256=null,m=>m.pins={...expectedPins,contextSha256:'0'.repeat(64)},
  m=>m.phase_authorizations.prepare_final.capability_ttl_seconds=10800,m=>m.phase_authorizations.prepare_final.source_data_reads=1,
  m=>m.phase_authorizations.run_final.applyTimestampOnly=false,m=>m.phase_authorizations.run_final.maxTimestampUpdates=2,m=>m.phase_authorizations.run_final.sourceFrameBudget=3,
  m=>m.phase_authorizations.run_final.beforeImagePath='/root/bron-secrets/t45-auth-before-c45a2026.json',
  m=>m.phase_authorizations.run_final.targetAdmitted=true,m=>m.approval.document_sha256='0'.repeat(64)]){
  const m=manifest();change(m);assert.throws(()=>check(m),{code:'T53_SCOPE_INVALID'});
 }
});
test('the known old T45 zero-effect result is archived evidence, not a fresh run',()=>{
 const old={task:'T45',status:'BLOCKED',actionId:'T45.final_https_window',targetWriteOutcome:'UNCHANGED',sourceMustRemainClosed:true,
  macDataTransit:false,phase:'source-fence-start',code:'FINAL_HTTPS_WINDOW_FAILED',
  recovery:{targetWriteOutcome:'UNCHANGED',sourceFrameAttempts:0,sourceMustRemainClosed:true,beforeImage:null}};
 const raw=Buffer.from(JSON.stringify(old)+'\n');
 assert.equal(hash(raw),expectedPins.priorResultSha256);
 assert.equal(validatePriorFailure(raw).recovery.sourceFrameAttempts,0);
 assert.throws(()=>validatePriorFailure(Buffer.from(JSON.stringify({...old,status:'PASS'})+'\n')),{code:'T53_PRIOR_RESULT_SHA'});
 assert.throws(()=>validatePriorFailure(raw,'0'.repeat(64)),{code:'T53_PRIOR_RESULT_SHA'});
});
test('T55 actual helper PASS, counters and both wall/monotonic proof are required',()=>{
 const receipt=encode({task:'T55',status:'PASS',safeReceipt:true});
 const pass={task:'T55',actionId:'T55.mcp_readiness',status:'PASS',code:'T55_AUTOMATIC_MCP_RELAY_PROVEN',sourceVerifyPassed:true,
  roundTripMs:1234,monotonicRoundTripMs:1234,createdEpochMs:now-1234,completedEpochMs:now,targetWrites:0,
  snapshotAttemptsUsed:0,T49Started:false,macDataTransit:false,requestSha256:'1'.repeat(64),responseSha256:'2'.repeat(64)};
 const check=r=>{const raw=encode(r),m={t55ReceiptSha256:hash(receipt),t55ResultSha256:hash(raw)};return validateT55Evidence(receipt,raw,m,m.t55ReceiptSha256);};
 assert.equal(check(pass).status,'PASS');
 for(const change of [r=>r.task='T51',r=>r.task='T54',r=>r.status='BLOCKED',r=>r.code='T54_AUTOMATIC_MCP_RELAY_PROVEN',r=>r.code='T55_SAME_WORKER_MCP_PROVEN',r=>r.roundTripMs=30001,r=>r.monotonicRoundTripMs=30001,
  r=>r.targetWrites=1,r=>r.snapshotAttemptsUsed=1,r=>r.T49Started=true,r=>r.sourceVerifyPassed=false,r=>r.completedEpochMs++,
  r=>r.responseSha256=null]){
  const r=structuredClone(pass);change(r);assert.throws(()=>check(r),{code:'T53_T55_NOT_PASS'});
 }
 const raw=encode(pass),m={t55ReceiptSha256:hash(receipt),t55ResultSha256:hash(raw)};
 assert.throws(()=>validateT55Evidence(receipt,raw,m,'0'.repeat(64)),{code:'T53_T55_EVIDENCE_SHA'});
 for(const wrong of [{task:'T55',status:'PROVISIONAL_HELPER_PASS'},{task:'T55',status:'BLOCKED'},{task:'T52',status:'PASS'}]){
  const receiptRaw=encode(wrong),pins={t55ReceiptSha256:hash(receiptRaw),t55ResultSha256:hash(raw)};
  assert.throws(()=>validateT55Evidence(receiptRaw,raw,pins,pins.t55ReceiptSha256),{code:'T53_T55_NOT_PASS'});
 }
});
test('new entropy is zeroed and the first persisted prepared object honestly belongs to T53',()=>{
 const entropy=Buffer.alloc(32,17);let stored,held;
 const p=createPrepared({manifestSha256:manifestSha,controlEvidence:control,now,random:()=>entropy,
  writeSecret:raw=>{held=raw;stored=Buffer.from(raw);}});
 assert.equal(stored.length,64);assert.equal(hash(stored),p.capabilitySha256);
 assert(entropy.every(x=>x===0));assert(held.every(x=>x===0));
 assert.equal(p.task,'T53');assert.equal(p.actionId,'T53.final_https_window');assert.equal(p.manifestSha256,manifestSha);
 assert.equal(Date.parse(p.expiresUtc)-Date.parse(p.createdUtc),7200000);
 assert.equal(p.functionName,'bron-source-reader-'+p.capabilitySha256.slice(0,12));
 assert.equal(p.fenceContextSha256,expectedPins.contextSha256);
 const raw=encode(p);assert.equal(validatePrepared(raw,hash(raw),manifestSha,control,now).task,'T53');
});
test('fresh prepared validation never accepts expired or relabeled T45/T49 evidence',()=>{
 const p=prepared(),check=(value,at=now,headroom=140000)=>{const raw=encode(value);return validatePrepared(raw,hash(raw),manifestSha,control,at,headroom);};
 assert.equal(check(p).task,'T53');
 for(const change of [x=>x.task='T45',x=>x.task='T49',x=>x.actionId='T45.final_https_window',
  x=>x.manifestSha256='0'.repeat(64),x=>x.expiresUtc=new Date(now+10800000).toISOString(),x=>x.controlReceiptSha256='0'.repeat(64),
  x=>x.functionName='bron-source-reader-old',x=>x.extra=true]){
  const copy=structuredClone(p);change(copy);assert.throws(()=>check(copy),{code:'T53_PREPARED_INVALID'});
 }
 assert.throws(()=>check(p,now+7200000),{code:'T53_PREPARED_INVALID'});
 assert.throws(()=>check(p,now+7200000-620000,620000),{code:'T53_PREPARED_INVALID'});
 assert.throws(()=>check(p,now,139999),{code:'T53_PREPARED_INVALID'});
});
test('Source render is independently verified against historical known code and unchanged context',()=>{
 assert.equal(hash(JSON.stringify(context())),expectedPins.contextSha256);
 const historical={capabilitySha256:'920938e064729dca455bc902f98674775c70e52c5cfc265f5f537550410ebb98',expiresUtc:'2026-11-15T04:14:51.589Z'};
 const files=expectedSourceFiles(template,historical,context());
 assert.equal(files['index.ts'],'2a907c354343741d1b4ab0616b1ab1cbe3bf5668fda4db03331c4bccc3a2c28b');
 assert.equal(Object.keys(files).length,6);for(const [name,pin]of Object.entries(sourceRuntimeHashes))assert.equal(files[name],pin);
 assert.throws(()=>expectedSourceFiles(Buffer.concat([template,Buffer.from('\n')]),historical,context()),{code:'T53_SOURCE_TEMPLATE_OR_CONTEXT'});
 const changed=context();changed.boundary.capturedMicros='1794709552349449';
 assert.throws(()=>expectedSourceFiles(template,historical,changed),{code:'T53_SOURCE_TEMPLATE_OR_CONTEXT'});
});
function deployment(p,raw,files){return {format:1,task:'T53',actionId:'T53.data_deployment',manifestSha256:manifestSha,preparedSha256:hash(raw),
 sourceProject:'vkkqffvmztpzgygzfxhq',functionName:p.functionName,capabilitySha256:p.capabilitySha256,expiresUtc:p.expiresUtc,
 fenceContextSha256:expectedPins.contextSha256,sourceBarrierReceiptSha256:expectedPins.barrierSha256,status:'ACTIVE',version:1,verifyJwt:false,
 entrypointPath:'index.ts',executableFileHashes:files,exactRuntimeReadback:true,
 preflightGet:{status:403,purpose:'BRON_PRIVATE_SNAPSHOT_V1',tlsVerified:true},observedUtc:new Date(now+1000).toISOString()};}
test('deployment proof binds real code, capability, prepared metadata and provider readback',()=>{
 const p=prepared(),preparedRaw=encode(p),files=expectedSourceFiles(template,p,context());
 const check=d=>{const raw=encode(d);return validateDeployment(raw,hash(raw),manifestSha,preparedRaw,p,files,now+2000);};
 assert.equal(check(deployment(p,preparedRaw,files)).status,'ACTIVE');
 for(const change of [d=>d.task='T45',d=>d.preparedSha256='0'.repeat(64),d=>d.capabilitySha256='0'.repeat(64),d=>d.verifyJwt=true,
  d=>d.exactRuntimeReadback=false,d=>d.preflightGet.status=200,d=>d.preflightGet.tlsVerified=false,
  d=>d.preflightGet.purpose='BRON_SOURCE_FENCE_WITNESS_V1',d=>d.executableFileHashes={...files,'index.ts':'0'.repeat(64)},
  d=>d.executableFileHashes={...files,'extra.mjs':'0'.repeat(64)},d=>d.observedUtc=new Date(now-6000).toISOString(),d=>d.version=0]){
  const d=deployment(p,preparedRaw,files);change(d);assert.throws(()=>check(d),{code:'T53_DEPLOYMENT_NOT_VERIFIED'});
 }
});
function request(){return {format:1,protocol:'T53.preflight_nonce',actionId:'T53.coordinator_ready',manifestSha256:manifestSha,
 sourceProject:'vkkqffvmztpzgygzfxhq',sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256,
 verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256,stage:'ready',nonceSha256:'3'.repeat(64),createdEpochMs:now-12000,expiresEpochMs:now+48000};}
function response(req,raw){const publicContext={...req,requestPath:'/root/bron-secrets/t53-release/coordinator-ready.request.json',
 ackPath:'/root/bron-secrets/t53-release/coordinator-ready.json',requestSha256:hash(raw),storageUid:0,storageGid:0,storageMode:384};
 return {format:1,protocol:'BRON_T53_READY_RESPONSE_V1',task:'T53',actionId:'T53.coordinator_ready',manifestSha256:manifestSha,
  sourceProject:req.sourceProject,sourceBarrierActionId:req.sourceBarrierActionId,sourceBarrierReceiptSha256:req.sourceBarrierReceiptSha256,
  verifyFencedSqlSha256:req.verifyFencedSqlSha256,requestSha256:hash(raw),contextSha256:hash(encode(publicContext)),nonceSha256:req.nonceSha256,
  sourceCheckedMicros:String(BigInt(now-3000)*1000n),workerId:'local-codex-supabase-mcp',connector:'Supabase MCP'};}
test('fresh READY accepts only the nonce-bound real Source clock with <=30s wall and monotonic delivery',()=>{
 const req=request(),raw=encode(req),r=response(req,raw);
 const check=(value,completed=now,mono=12000)=>validateReadyResponse(encode(value),raw,manifestSha,completed,mono);
 const ready=check(r);assert.equal(ready.task,'T53');assert.equal(ready.roundTripMs,12000);
 const readyRaw=encode(ready);assert.equal(validateCoordinatorReady(readyRaw,hash(readyRaw),manifestSha,now).sourceCheckedMicros,r.sourceCheckedMicros);
 for(const change of [x=>x.task='T55',x=>x.protocol='BRON_COORDINATOR_FENCE_ACK_V1',x=>x.requestSha256='0'.repeat(64),
  x=>x.contextSha256='0'.repeat(64),x=>x.nonceSha256='0'.repeat(64),x=>x.connector='browser',x=>x.sourceCheckedMicros=String(BigInt(now+6000)*1000n),
  x=>x.sourceCheckedMicros='١٧٩٤٧١٦٠٠٠١٢٣٤٥٦',x=>x.extra=true]){
  const copy=structuredClone(r);change(copy);assert.throws(()=>check(copy),{code:'T53_READY_RESPONSE_INVALID'});
 }
 assert.throws(()=>check(r,now+18001,30001),{code:'T53_READY_RESPONSE_INVALID'});
 assert.throws(()=>check(r,now,9000),{code:'T53_READY_RESPONSE_INVALID'});
 assert.throws(()=>validateCoordinatorReady(readyRaw,hash(readyRaw),manifestSha,now+30001),{code:'T53_COORDINATOR_NOT_READY'});
 const wrongRequest={...req,manifestSha256:'0'.repeat(64)};
 assert.throws(()=>validateReadyResponse(encode(r),encode(wrongRequest),manifestSha,now,12000),{code:'T53_READY_RESPONSE_INVALID'});
});
test('fresh activation retains archived barrier lineage, owner scope, max1 and new T53 before-image',()=>{
 const p=prepared(),copy=structuredClone(p),ctx=context(),out=activationFromPrepared(p,manifestSha,ctx,barrier);
 assert.deepEqual(p,copy);assert.equal(out.activation.actionId,'T53.final_https_window');assert.equal(out.activation.maxTimestampUpdates,1);
 assert.equal(out.activation.beforeImagePath,beforePath);assert.equal(out.ownerDataGrant.maxAuthSnapshots,3);
 assert.equal(out.activation.sourceFrameBudget,2);assert.equal(out.activation.priorSourceAuthSnapshotAttempts,1);
 assert.equal(out.activation.sourceBarrierReceiptSha256,expectedPins.barrierSha256);
 assert.equal(out.prepared.task,'T53');assert.equal(out.barrierProof.sourcePaused,false);
});
test('CLI requires pinned T55 evidence and exact mode-specific input hashes',()=>{
 const common=['--manifest','/root/bron-secrets/t53-release/manifest.json','--sha256',manifestSha,'--t55-receipt-sha256','1'.repeat(64)];
 assert.equal(parseArguments(['--prepare-final',...common]).mode,'--prepare-final');
 const more=['--prepared-sha256','2'.repeat(64),'--deployment-proof-sha256','3'.repeat(64)];
 for(const mode of ['--prepare-ready','--accept-ready'])assert.equal(parseArguments([mode,...common,...more]).mode,mode);
 assert.equal(parseArguments(['--run-final',...common,...more,'--ready-input-sha256','4'.repeat(64)]).mode,'--run-final');
 for(const argv of [['--run-final',...common],['--prepare-final',...common,'--sha256',manifestSha],
  ['--prepare-final',...common,'--retry','1'],['--prepare-final',...common.slice(0,-2)]]){
  assert.throws(()=>parseArguments(argv),{code:'T53_EXPLICIT_INPUT_REQUIRED'});
 }
});
test('T53 ACK module is the exact namespace-only clone, preserving all original deadline/security logic',()=>{
 const prior=fs.readFileSync(new URL('../../docs/runbooks/payloads/coordinator-fence-ack-t49.mjs',import.meta.url),'utf8');
 const current=fs.readFileSync(new URL('../../docs/runbooks/payloads/coordinator-fence-ack-t53.mjs',import.meta.url),'utf8');
 assert.equal(current,prior.replaceAll('T49','T53').replaceAll('t49-release','t53-release'));
});
test('all four synthetic T53 ACK stages use the T53 namespace and unchanged 60-second validation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t53-ack-fixture-'));fs.chmodSync(dir,0o700);const stages=[];
 const a={reviewed:true,actionId:'T53.final_https_window',manifestSha256:manifestSha,sourceProject:'vkkqffvmztpzgygzfxhq',
  sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256,verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256};
 const b={sourceBarrierActionId:a.sourceBarrierActionId,sourceBarrierReceiptSha256:a.sourceBarrierReceiptSha256,...barrier};
 const ack=createCoordinatorFenceAck({activation:a,barrierProof:b,onChallenge:r=>{
  stages.push(r.stage);assert(r.ackPath.startsWith('/root/bron-secrets/t53-release/'));assert.equal(r.expiresEpochMs-r.createdEpochMs,60000);
  const payload={format:1,protocol:'BRON_COORDINATOR_FENCE_ACK_V1',actionId:a.actionId,manifestSha256:manifestSha,sourceProject:a.sourceProject,
   sourceBarrierActionId:a.sourceBarrierActionId,sourceBarrierReceiptSha256:a.sourceBarrierReceiptSha256,verifyFencedSqlSha256:a.verifyFencedSqlSha256,
   stage:r.stage,nonceSha256:r.nonceSha256,sourceCheckedMicros:String(BigInt(r.createdEpochMs)*1000n),expiresEpochMs:r.expiresEpochMs,
   normalConnectDenied:true,existingClientsDrained:true,providerBoundaryReviewed:true};
  const ackJson=JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k=>[k,payload[k]])))+'\n';
  fs.writeFileSync(path.join(dir,path.basename(r.ackPath)),JSON.stringify({ackJson,rootAckSha256:hash(ackJson)}),{mode:0o600,flag:'wx'});
 }},{directory:dir,uid:process.getuid(),gid:process.getgid()});
 try{for(const stage of ['start','before-target-write','before-final-audit','end'])assert.equal((await ack.assertFence(stage)).currentAck.stage,stage);
  assert.deepEqual(stages,['start','before-target-write','before-final-audit','end']);}finally{ack.close();fs.rmSync(dir,{recursive:true,force:true});}
});
