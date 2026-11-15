import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {expectedPins,targetIdentitySql,validateManifest,validatePriorFailure,validateCoordinatorReady,projectSuccessor} from '../../docs/runbooks/payloads/t49-final-window.mjs';
import {targetIdentitySql as originalTargetIdentitySql} from '../../docs/runbooks/payloads/t45-final-window.mjs';
import {createCoordinatorFenceAck} from '../../docs/runbooks/payloads/coordinator-fence-ack-t49.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),encode=x=>Buffer.from(JSON.stringify(x)+'\n');
const now=Date.parse('2026-11-15T03:00:00.000Z'),manifestSha='a'.repeat(64),selfSha='b'.repeat(64),ackSha='c'.repeat(64);
test('successor target identity query is a real SELECT exactly matching the reviewed original',()=>{
 assert.equal(typeof targetIdentitySql,'string');assert.match(targetIdentitySql,/^SELECT current_database\(\)/);
 assert.equal(targetIdentitySql,originalTargetIdentitySql);
});
function ready(){return {format:1,task:'T49',actionId:'T49.coordinator_ready',status:'COORDINATOR_READY',manifestSha256:manifestSha,
 sourceProject:'vkkqffvmztpzgygzfxhq',sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256,
 verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256,connector:'Supabase MCP',workerId:'root/t49-worker',mcpWorkerReady:true,
 sourceVerifyPassed:true,nonceSha256:'d'.repeat(64),createdEpochMs:now-12000,completedEpochMs:now-2000,roundTripMs:10000,
 sourceCheckedMicros:String(BigInt(now-5000)*1000n),observedUtc:new Date(now-2000).toISOString()};}
function projection(){return {activation:{reviewed:true,actionId:'T45.final_https_window',manifestSha256:expectedPins.parentManifestSha256,
 sourceBarrierReceiptSha256:expectedPins.barrierSha256,fenceContextSha256:expectedPins.contextSha256,beforeImagePath:'/root/bron-secrets/t45-auth-before-c45a2026.json'},
 prepared:{task:'T45',actionId:'T45.final_https_window',manifestSha256:expectedPins.parentManifestSha256,
 capabilitySha256:expectedPins.capabilitySha256,expiresUtc:expectedPins.expiresUtc},fenceContext:{technical:'unchanged'},ownerDataGrant:{maxAuthSnapshots:3},barrierProof:{durableOnVps:true}};}

test('successor manifest locks task, one window, exact custody pins and both executable SHA',()=>{
 const m={task:'T49',actionId:'T49.final_https_window',execution_authorized:true,maxSuccessorWindows:1,pins:expectedPins,
  priorResultSha256:'e'.repeat(64),files:{'docs/runbooks/payloads/t49-final-window.mjs':selfSha,'docs/runbooks/payloads/coordinator-fence-ack-t49.mjs':ackSha},
  phase_authorizations:{run_final:{maxTimestampUpdates:1,sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,beforeImagePath:'/root/bron-secrets/t49-auth-before-c49a2026.json',wall_seconds:480}}};
 const check=x=>{const raw=encode(x);return validateManifest(raw,sha(raw),selfSha,ackSha);};assert.equal(check(m).task,'T49');
 for(const change of [x=>x.task='T45',x=>x.maxSuccessorWindows=2,x=>x.priorResultSha256=null,x=>x.pins={...expectedPins,expiresUtc:'2026-11-16T04:14:51.589Z'},
  x=>x.phase_authorizations.run_final.sourceFrameBudget=3,x=>x.phase_authorizations.run_final.maxTimestampUpdates=2]){
  const copy=structuredClone(m);change(copy);assert.throws(()=>check(copy),{code:'T49_SCOPE_INVALID'});
 }
});
test('old result must cryptographically prove zero Source frames and UNCHANGED target',()=>{
 const r={task:'T45',status:'BLOCKED',phase:'source-fence-start',targetWriteOutcome:'UNCHANGED',recovery:{targetWriteOutcome:'UNCHANGED',sourceFrameAttempts:0,sourceMustRemainClosed:true}};
 const check=x=>{const raw=encode(x);return validatePriorFailure(raw,sha(raw));};assert.equal(check(r).task,'T45');
 for(const change of [x=>x.status='PASS',x=>x.phase='source-before',x=>x.targetWriteOutcome='UNKNOWN',x=>x.recovery.sourceFrameAttempts=1,x=>x.recovery.targetWriteOutcome='COMMITTED']){
  const copy=structuredClone(r);change(copy);assert.throws(()=>check(copy),{code:'T49_PRIOR_WINDOW_NOT_ZERO_EFFECT'});
 }
 assert.throws(()=>validatePriorFailure(encode(r),'0'.repeat(64)),{code:'T49_PRIOR_RESULT_SHA'});
});
test('READY requires actual bounded rehearsal/Source clock, fresh delivery and exact bindings',()=>{
 const check=r=>{const raw=encode(r);return validateCoordinatorReady(raw,sha(raw),manifestSha,expectedPins,now);};assert.equal(check(ready()).roundTripMs,10000);
 for(const change of [x=>x.connector='browser',x=>x.mcpWorkerReady=false,x=>x.sourceVerifyPassed=false,x=>x.manifestSha256='f'.repeat(64),
  x=>x.roundTripMs=30001,x=>{x.createdEpochMs=now-60000;x.completedEpochMs=now-40000;x.roundTripMs=20000;x.observedUtc=new Date(x.completedEpochMs).toISOString();},
  x=>x.sourceCheckedMicros=String(BigInt(now+10000)*1000n),x=>x.extra=true]){
  const copy=ready();change(copy);assert.throws(()=>check(copy),{code:'T49_COORDINATOR_NOT_READY'});
 }
});
test('projection gives fresh T49 identity without changing cap, expiry, fence or old object',()=>{
 const old=projection(),snapshot=structuredClone(old),r=projectSuccessor(old,manifestSha,expectedPins,now);assert.deepEqual(old,snapshot);
 assert.equal(r.activation.actionId,'T49.final_https_window');assert.equal(r.activation.manifestSha256,manifestSha);
 assert.equal(r.prepared.task,'T49');assert.equal(r.prepared.actionId,'T49.final_https_window');assert.equal(r.prepared.manifestSha256,manifestSha);
 assert.equal(r.prepared.capabilitySha256,old.prepared.capabilitySha256);assert.equal(r.prepared.expiresUtc,old.prepared.expiresUtc);
 assert.deepEqual(r.fenceContext,old.fenceContext);assert.deepEqual(r.ownerDataGrant,old.ownerDataGrant);
 for(const change of [x=>x.prepared.capabilitySha256='f'.repeat(64),x=>x.activation.fenceContextSha256='f'.repeat(64),x=>x.prepared.expiresUtc='2026-11-16T04:14:51.589Z']){
  const copy=projection();change(copy);assert.throws(()=>projectSuccessor(copy,manifestSha,expectedPins,now),{code:'T49_PARENT_PROJECTION_INVALID'});
 }
 assert.throws(()=>projectSuccessor(projection(),manifestSha,expectedPins,Date.parse(expectedPins.expiresUtc)-620000),{code:'T49_PARENT_PROJECTION_INVALID'});
});
test('dedicated ACK uses T49-only directory and unchanged real 60s/nonce/clock checks',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'t49-ack-'));fs.chmodSync(tmp,0o700);
 const activation={reviewed:true,actionId:'T49.final_https_window',manifestSha256:manifestSha,sourceProject:'vkkqffvmztpzgygzfxhq',
  sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256,verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256};
 const barrierProof={sourceBarrierActionId:activation.sourceBarrierActionId,sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,
  normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
 const fixture={directory:tmp,uid:process.getuid(),gid:process.getgid()};let ack;
 try{
  assert.throws(()=>createCoordinatorFenceAck({activation:{...activation,actionId:'T45.final_https_window'},barrierProof},fixture),{code:'COORDINATOR_FENCE_ACTIVATION_INVALID'});
  assert.throws(()=>createCoordinatorFenceAck({activation,barrierProof,timeoutMs:60001},fixture),{code:'COORDINATOR_FENCE_ACTIVATION_INVALID'});
  ack=createCoordinatorFenceAck({activation,barrierProof,onChallenge:r=>{
   assert(r.ackPath.startsWith('/root/bron-secrets/t49-release/'));assert.equal(r.expiresEpochMs-r.createdEpochMs,60000);
   const a={format:1,protocol:'BRON_COORDINATOR_FENCE_ACK_V1',...Object.fromEntries(Object.entries(activation).filter(([k])=>k!=='reviewed')),
    stage:r.stage,nonceSha256:r.nonceSha256,sourceCheckedMicros:String(BigInt(r.createdEpochMs)*1000n),expiresEpochMs:r.expiresEpochMs,
    normalConnectDenied:true,existingClientsDrained:true,providerBoundaryReviewed:true};
   const ackJson=JSON.stringify(Object.fromEntries(Object.keys(a).sort().map(k=>[k,a[k]])))+'\n';
   fs.writeFileSync(path.join(tmp,path.basename(r.ackPath)),JSON.stringify({ackJson,rootAckSha256:sha(ackJson)}),{flag:'wx',mode:0o600});
  }},fixture);
  const p=await ack.assertFence('start');assert.equal(p.currentAck.stage,'start');
 }finally{ack?.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
