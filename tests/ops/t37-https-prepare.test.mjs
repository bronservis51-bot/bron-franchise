import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPrepared,validatePrepareManifest} from '../../docs/runbooks/payloads/t37-https-prepare.mjs';
import {prepareBudget,consumeBudget,readBudgetStatus,SOURCE_TRANSFER_SCOPE_SHA256} from '../../docs/runbooks/payloads/source-transfer-budget.mjs';
import {validateCapability} from '../../docs/runbooks/payloads/t37-https-inventory.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const h='a'.repeat(64),scope='b'.repeat(64),nodefile='docs/runbooks/payloads/t37-https-prepare.mjs';
function fixture(){return {task:'T37',execution_authorized:true,approval:{status:'APPROVED',document_sha256:scope},files:{[nodefile]:h},runtime_files:{'/root/bron-secrets/t37-runtime/payloads/source-transfer-budget.mjs':h},transfer_budget:{directory:'/root/bron-secrets/source-transfer-budget',scope_sha256:scope,source_project:'vkkqffvmztpzgygzfxhq',destination_vps:'152.228.115.115',max_attempts:3},source:{capability_binding:'pinned_VPS_prepare_readback',template_name_prefix:'bron-source-reader-'}};}
test('fresh metadata binds current manifest/grant, two hour expiry, and hash-only endpoint',()=>{
 let copy;const now=Date.parse('2026-11-14T07:00:00.000Z');
 const p=createPrepared({manifestSha256:h,scopeSha256:scope,now,random:()=>Buffer.alloc(32,7),writeSecret:b=>{copy=Buffer.from(b);}});
 assert.equal(copy.length,64);assert.equal(p.capabilitySha256,sha(copy));assert.equal(p.functionName,'bron-source-reader-'+sha(copy).slice(0,12));
 assert.equal(p.manifestSha256,h);assert.equal(p.ownerGrantSha256,scope);assert.equal(Date.parse(p.expiresUtc)-now,7200000);
 assert.equal(JSON.stringify(p).includes(copy.toString('ascii')),false);assert.equal(p.protocol,'BRON_PRIVATE_SNAPSHOT_V1');
});
test('secret callback buffer is cleared after success and failed durability callback',()=>{
 let held;createPrepared({manifestSha256:h,scopeSha256:scope,random:()=>Buffer.alloc(32,8),writeSecret:b=>{held=b;}});assert(held.every(x=>x===0));
 assert.throws(()=>createPrepared({manifestSha256:h,scopeSha256:scope,writeSecret:b=>{held=b;throw Error('write');}}));assert(held.every(x=>x===0));
});
test('invalid entropy and input never produce a prepared context',()=>{
 assert.throws(()=>createPrepared({manifestSha256:h,scopeSha256:scope,random:()=>Buffer.alloc(31),writeSecret:()=>{throw Error('must not reach');}}),{code:'T37_RANDOM'});
 assert.throws(()=>createPrepared({manifestSha256:'x',scopeSha256:scope,writeSecret:()=>{}}),{code:'T37_PREPARE_ARGUMENTS'});
});
test('authorized manifest is exact byte/SHA and VPS/grant/budget bound',()=>{
 const m=fixture(),raw=Buffer.from(JSON.stringify(m));assert.equal(validatePrepareManifest(raw,sha(raw),h).task,'T37');
 assert.throws(()=>validatePrepareManifest(Buffer.concat([raw,Buffer.from(' ')]),sha(raw),h),{code:'T37_MANIFEST_SHA'});
 for(const change of [m=>m.execution_authorized=false,m=>m.approval.status='PENDING',m=>m.transfer_budget.max_attempts=4,m=>m.transfer_budget.destination_vps='127.0.0.1',m=>m.approval.document_sha256=h,m=>m.source.capability_binding='staleT36']){
  const next=fixture();change(next);const b=Buffer.from(JSON.stringify(next));assert.throws(()=>validatePrepareManifest(b,sha(b),h),{code:'T37_PREPARE_SCOPE'});
 }
});
test('actual filesystem budget API composes with fresh prepared context and never resets on another capability',{skip:process.getuid?.()===0},()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'t37-prepare-budget-'));fs.chmodSync(parent,0o700);
 const binding={directory:path.join(parent,'ledger'),uid:process.getuid(),scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',maxAttempts:3};
 try{
  assert.equal(prepareBudget(binding).used,0);let secret;
  const now=Date.parse('2026-11-14T07:00:00.000Z'),p=createPrepared({manifestSha256:h,scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,now,writeSecret:b=>{secret=Buffer.from(b);}});
  validateCapability(secret.toString('ascii'),p,now,h);
  assert.equal(consumeBudget({...binding,actionId:'T37.live',capabilitySha256:p.capabilitySha256}).attempt,1);
  assert.equal(readBudgetStatus(binding).used,1);assert.equal(prepareBudget(binding).used,1);
  assert.throws(()=>consumeBudget({...binding,actionId:'T37.live',capabilitySha256:'c'.repeat(64)}),{code:'SOURCE_TRANSFER_ACTION_SEQUENCE'});
  assert.equal(readBudgetStatus(binding).remaining,2);secret.fill(0);
 }finally{fs.rmSync(parent,{recursive:true,force:true});}
});
