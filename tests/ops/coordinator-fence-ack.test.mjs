import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createCoordinatorFenceAck,coordinatorFenceStages} from '../../docs/runbooks/payloads/coordinator-fence-ack.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])))+'\n';
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bron-coordinator-fence-'));fs.chmodSync(directory,0o700);
 const activation={reviewed:true,actionId:'T41.final_https_window',manifestSha256:'a'.repeat(64),sourceProject:'vkkqffvmztpzgygzfxhq',
  sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:'b'.repeat(64),verifyFencedSqlSha256:'c'.repeat(64)};
 const barrierProof={sourceBarrierActionId:activation.sourceBarrierActionId,sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,
  normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
 const testOnly={directory,uid:process.getuid(),gid:process.getgid()},challenges=[];let adapter;
 const ack=challenge=>({format:1,protocol:'BRON_COORDINATOR_FENCE_ACK_V1',actionId:activation.actionId,
  manifestSha256:activation.manifestSha256,sourceProject:activation.sourceProject,sourceBarrierActionId:activation.sourceBarrierActionId,
  sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,verifyFencedSqlSha256:activation.verifyFencedSqlSha256,
  stage:challenge.stage,nonceSha256:challenge.nonceSha256,sourceCheckedMicros:String(BigInt(Date.now())*1000n),
  expiresEpochMs:challenge.expiresEpochMs,normalConnectDenied:true,existingClientsDrained:true,providerBoundaryReviewed:true});
 // Simulated trusted Root message in fixtures only. Production adapter never makes ACKs.
 const deliver=(challenge,value=ack(challenge),changeEnvelope=x=>x)=>{
  const ackJson=canonical(value),envelope=changeEnvelope({ackJson,rootAckSha256:sha(ackJson)});
  const target=path.join(directory,path.basename(challenge.ackPath)),temporary=target+'.tmp';
  assert.equal(fs.existsSync(target),false);const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
  try{fs.writeFileSync(fd,JSON.stringify(envelope)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,target);const parent=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}return target;
 };
 const open=(options={})=>adapter=createCoordinatorFenceAck({activation,barrierProof,timeoutMs:1000,onChallenge:c=>{
  challenges.push(c);deliver(c);
 },...options},testOnly);
 const close=()=>{adapter?.close();fs.rmSync(directory,{recursive:true,force:true});};
 return {directory,activation,barrierProof,testOnly,challenges,ack,deliver,open,close};
}
const closed=code=>error=>{assert.equal(error.code,code);assert.equal(error.holdSourceClosed,true);assert.equal(error.retryAllowed,false);return true;};

test('production requires actual root; importing does not read files, create proof or print',()=>{
 const f=fixture();try{
  if(process.getuid()!==0)assert.throws(()=>createCoordinatorFenceAck({activation:f.activation,barrierProof:f.barrierProof}),closed('COORDINATOR_FENCE_VPS_ROOT_REQUIRED'));
  const r=spawnSync(process.execPath,['--input-type=module','-e',"import './docs/runbooks/payloads/coordinator-fence-ack.mjs'"],{encoding:'utf8'});
  assert.equal(r.status,0);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
 }finally{f.close();}
});

test('four exact ordered stages persist unique private nonce challenges and accept current Root ACKs',async()=>{
 const f=fixture();try{
  const adapter=f.open(),hashes=[];
  for(const stage of coordinatorFenceStages){
   const proof=await adapter.assertFence(stage),challenge=f.challenges.at(-1);hashes.push(challenge.nonceSha256);
   assert.deepEqual(Object.fromEntries(Object.keys(f.barrierProof).map(k=>[k,proof[k]])),f.barrierProof);
   assert.equal(proof.currentAck.stage,stage);assert.equal(proof.currentAck.nonceSha256,challenge.nonceSha256);
   assert.equal(Object.isFrozen(proof),true);assert.equal(Object.isFrozen(proof.currentAck),true);
   assert.equal(challenge.storageUid,process.getuid());assert.equal(challenge.storageGid,process.getgid());assert.equal(challenge.storageMode,0o600);
   const filename=path.join(f.directory,path.basename(challenge.requestPath)),raw=fs.readFileSync(filename),request=JSON.parse(raw);
   assert.equal(request.nonce.length,64);assert.equal(sha(request.nonce),challenge.nonceSha256);assert.equal(sha(raw),challenge.requestSha256);
   assert.equal(fs.statSync(filename).mode&0o7777,0o600);assert.equal(Object.hasOwn(challenge,'nonce'),false);
   assert.equal(JSON.stringify(challenge).includes(request.nonce),false);assert.equal(JSON.stringify(proof).includes(request.nonce),false);
  }
  assert.equal(new Set(hashes).size,4);assert.equal(f.challenges.length,4);
 }finally{f.close();}
});

test('activation and already-verified immutable barrier proof cannot be substituted or weakened',()=>{
 for(const patch of [{reviewed:false},{actionId:'T41.other'},{sourceProject:'other'},{sourceBarrierActionId:'T41.http_source_admission'},
  {manifestSha256:'bad'},{sourceBarrierReceiptSha256:'bad'},{verifyFencedSqlSha256:'bad'}]){
  const f=fixture();try{Object.assign(f.activation,patch);assert.throws(()=>f.open(),closed('COORDINATOR_FENCE_ACTIVATION_INVALID'));}finally{f.close();}
 }
 for(const patch of [{normalConnectDenied:false},{existingClientsDrained:false},{freshOwnerReconnect:false},{providerBoundaryReviewed:false},
  {durableOnVps:false},{sourcePaused:true},{sourceBarrierReceiptSha256:'d'.repeat(64)}]){
  const f=fixture();try{Object.assign(f.barrierProof,patch);assert.throws(()=>f.open(),closed('COORDINATOR_FENCE_ACTIVATION_INVALID'));}finally{f.close();}
 }
});

test('caller mutation after creation cannot manufacture new barrier bindings or deny mandatory flags',async()=>{
 const f=fixture();try{
  const original={...f.barrierProof},a={...f.activation};
  const adapter=f.open({onChallenge:c=>{f.challenges.push(c);const value=f.ack(c);Object.assign(value,
   {manifestSha256:a.manifestSha256,sourceBarrierReceiptSha256:a.sourceBarrierReceiptSha256});f.deliver(c,value);}});
  f.activation.manifestSha256='d'.repeat(64);f.barrierProof.freshOwnerReconnect=false;
  const result=await adapter.assertFence('start');assert.equal(result.freshOwnerReconnect,true);assert.equal(result.sourceBarrierReceiptSha256,original.sourceBarrierReceiptSha256);
 }finally{f.close();}
});

test('invalid timeout, unknown/out-of-order stage or reuse fails closed without a replacement challenge',async()=>{
 for(const timeoutMs of [0,60001,1.5]){const f=fixture();try{assert.throws(()=>f.open({timeoutMs}),closed('COORDINATOR_FENCE_ACTIVATION_INVALID'));}finally{f.close();}}
 const f=fixture();try{
  const adapter=f.open();await assert.rejects(adapter.assertFence('before-target-write'),closed('COORDINATOR_FENCE_STAGE_ORDER'));
  await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_NOT_ACTIVE'));assert.equal(f.challenges.length,0);
 }finally{f.close();}
 const g=fixture();try{
  const adapter=g.open();await adapter.assertFence('start');await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_STAGE_ORDER'));
  assert.equal(g.challenges.length,1);
 }finally{g.close();}
});

test('past request/ack files consume the stage, even after process restart; no ack replay or overwrite',async()=>{
 const f=fixture();try{
  const first=f.open();await first.assertFence('start');first.close();
  const second=f.open();await assert.rejects(second.assertFence('start'),closed('COORDINATOR_FENCE_STAGE_ALREADY_CONSUMED'));
  assert.equal(f.challenges.length,1);
 }finally{f.close();}
 const g=fixture();try{
  fs.writeFileSync(path.join(g.directory,'fence-check-start.ack.json'),'{}',{mode:0o600});const adapter=g.open();
  await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_STAGE_ALREADY_CONSUMED'));assert.equal(g.challenges.length,0);
 }finally{g.close();}
});

test('every Root ACK binding and actual source-check declaration is mandatory',async()=>{
 for(const patch of [{manifestSha256:'d'.repeat(64)},{actionId:'T41.other'},{sourceProject:'other'},
  {sourceBarrierActionId:'T42.http_source_admission'},{sourceBarrierReceiptSha256:'d'.repeat(64)},
  {verifyFencedSqlSha256:'d'.repeat(64)},{stage:'end'},{nonceSha256:'d'.repeat(64)},{expiresEpochMs:0},
  {normalConnectDenied:false},{existingClientsDrained:false},{providerBoundaryReviewed:false},{sourceCheckedMicros:'bad'}]){
  const f=fixture();try{
   const adapter=f.open({onChallenge:c=>{f.challenges.push(c);f.deliver(c,{...f.ack(c),...patch});}});
   await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_ACK_BINDING'));assert.equal(f.challenges.length,1);
  }finally{f.close();}
 }
});

test('Source clock must be fresh against this challenge and its bounded expiry',async()=>{
 for(const clock of [c=>String(BigInt(c.createdEpochMs-6000)*1000n),()=>String(BigInt(Date.now()+6000)*1000n)]){
  const f=fixture();try{
   const adapter=f.open({onChallenge:c=>f.deliver(c,{...f.ack(c),sourceCheckedMicros:clock(c)})});
   await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_ACK_STALE'));
  }finally{f.close();}
 }
});

test('Root check stays valid within its unique 60s challenge, while exact expiry rejects it',async t=>{
 const f=fixture();try{
  const adapter=f.open({timeoutMs:60000,onChallenge:c=>{
   const sourceCheckedMicros=String(BigInt(c.createdEpochMs)*1000n);
   t.mock.method(Date,'now',()=>c.createdEpochMs+59000);
   f.deliver(c,{...f.ack(c),sourceCheckedMicros});
  }});
  const result=await adapter.assertFence('start');assert.equal(result.currentAck.stage,'start');
 }finally{t.mock.restoreAll();f.close();}
 const g=fixture();try{
  const adapter=g.open({timeoutMs:60000,onChallenge:c=>{
   t.mock.method(Date,'now',()=>c.expiresEpochMs);g.deliver(c);
  }});
  await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_ACK_TIMEOUT'));
 }finally{t.mock.restoreAll();g.close();}
});

test('ACK bytes must be exact canonical Root JSON with its SHA; extra/private fields never pass',async()=>{
 for(const variant of ['wrong-sha','malformed','noncanonical','extra']){
  const f=fixture();try{
   const adapter=f.open({onChallenge:c=>{
    if(variant==='wrong-sha')f.deliver(c,f.ack(c),e=>({...e,rootAckSha256:'0'.repeat(64)}));
    if(variant==='malformed')f.deliver(c,f.ack(c),()=>({ackJson:'PRIVATE:bad',rootAckSha256:sha('PRIVATE:bad')}));
    if(variant==='noncanonical')f.deliver(c,f.ack(c),e=>{const ackJson=JSON.stringify(JSON.parse(e.ackJson));return {ackJson,rootAckSha256:sha(ackJson)};});
    if(variant==='extra')f.deliver(c,{...f.ack(c),privateRows:[{password:'PRIVATE_VALUE'}]});
   }});
   await assert.rejects(adapter.assertFence('start'),error=>{assert.equal(error.holdSourceClosed,true);assert.equal(error.retryAllowed,false);
    assert.equal(JSON.stringify(error).includes('PRIVATE'),false);assert.equal(error.message.includes('PRIVATE'),false);return true;});
  }finally{f.close();}
 }
});

test('missing ACK or stalled challenge callback times out without fallback proof, retry or waiting over the bound',async()=>{
 for(const stalled of [false,true]){
  const f=fixture();try{
   const adapter=f.open({timeoutMs:20,onChallenge:c=>{f.challenges.push(c);if(stalled)return new Promise(()=>{});}}),started=Date.now();
   await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_ACK_TIMEOUT'));assert.ok(Date.now()-started<500);
   await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_NOT_ACTIVE'));assert.equal(f.challenges.length,1);
  }finally{f.close();}
 }
});

test('abort and close stop waiting, and concurrent stage calls cannot obtain independent live challenges',async()=>{
 const f=fixture();try{
  const controller=new AbortController(),adapter=f.open({signal:controller.signal,onChallenge:()=>controller.abort()});
  await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_ABORTED'));
 }finally{f.close();}
 const g=fixture();try{
  let adapter;adapter=g.open({onChallenge:()=>adapter.close()});
  await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_ABORTED'));
 }finally{g.close();}
 const h=fixture();try{
  let release;const adapter=h.open({onChallenge:c=>{h.challenges.push(c);return new Promise(resolve=>{release=resolve;});}});
  const running=adapter.assertFence('start');await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_NOT_ACTIVE'));
  release();await assert.rejects(running,closed('COORDINATOR_FENCE_ABORTED'));assert.equal(h.challenges.length,1);
 }finally{h.close();}
});

test('stage ACK from another valid nonce cannot be reused for the next checkpoint',async()=>{
 const f=fixture();try{
  let previous;const adapter=f.open({onChallenge:c=>{f.challenges.push(c);const value=previous??f.ack(c);f.deliver(c,value);previous=value;}});
  await adapter.assertFence('start');await assert.rejects(adapter.assertFence('before-target-write'),closed('COORDINATOR_FENCE_ACK_BINDING'));
  assert.equal(f.challenges.length,2);
 }finally{f.close();}
});

test('private storage rejects directory modes/ownership and ACK symlink, hardlink, weak mode, FIFO or oversized file',async()=>{
 for(const mutate of [f=>fs.chmodSync(f.directory,0o755),f=>{f.testOnly.uid++;},f=>{f.testOnly.gid++;}]){
  const f=fixture();try{mutate(f);assert.throws(()=>f.open(),closed('COORDINATOR_FENCE_DIRECTORY_UNSAFE'));}finally{f.close();}
 }
 for(const kind of ['symlink','hardlink','mode','fifo','oversize']){
  const f=fixture();try{
   const adapter=f.open({onChallenge:c=>{const filename=f.deliver(c);
    if(kind==='symlink'){fs.renameSync(filename,filename+'.saved');fs.symlinkSync(filename+'.saved',filename);}
    if(kind==='hardlink')fs.linkSync(filename,filename+'.alias');
    if(kind==='mode')fs.chmodSync(filename,0o644);
    if(kind==='fifo'){fs.unlinkSync(filename);assert.equal(spawnSync('mkfifo',[filename]).status,0);fs.chmodSync(filename,0o600);}
    if(kind==='oversize')fs.appendFileSync(filename,'x'.repeat(32769));
   }});
   await assert.rejects(adapter.assertFence('start'),error=>{assert.equal(error.holdSourceClosed,true);assert.equal(error.retryAllowed,false);return true;});
  }finally{f.close();}
 }
});

test('request fsync or notification failure consumes its guard and emits no fake current proof',async t=>{
 const f=fixture();try{
  const adapter=f.open(),mocked=t.mock.method(fs,'fsyncSync',()=>{throw Error('PRIVATE_DISK_FAILURE');});
  await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_IO_UNCERTAIN'));mocked.mock.restore();
  assert.equal(f.challenges.length,0);assert.equal(fs.existsSync(path.join(f.directory,'fence-check-start.request.json')),true);
 }finally{t.mock.restoreAll();f.close();}
 const g=fixture();try{
  const adapter=g.open({onChallenge:()=>{throw Error('PRIVATE_STDOUT_FAILURE');}});
  await assert.rejects(adapter.assertFence('start'),closed('COORDINATOR_FENCE_IO_UNCERTAIN'));
  assert.equal(fs.existsSync(path.join(g.directory,'fence-check-start.request.json')),true);
 }finally{g.close();}
});
