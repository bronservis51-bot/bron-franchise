import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepareBudget as prepareT59,consumeBudget as consumeT59} from '../../docs/runbooks/payloads/t59-source-transfer-budget.mjs';
import {prepareBudget,readBudgetStatus,consumeBudget} from '../../docs/runbooks/payloads/t60-source-transfer-budget.mjs';

const sha=raw=>createHash('sha256').update(raw).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=x=>Buffer.from(canonical(x)+'\n');
const source='vkkqffvmztpzgygzfxhq',vps='152.228.115.115';
const original='cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69';
const m58='e234e56c63bf30d3510b7d10def4e1ec523d8cc0cbdd5f3689b43cc8f8afe2df';
const grant58='2d3dd423b2dced4b7f768d62c0b00e7f46675f8c7b27c53322a5e9c7142a5558';
const cap56='03629ff992411e281ea58eed42b6ca5590b70b2850475594a5c957a0e2391ad5';
const cap58='10d499abd7c1402dc6741403b641057cd0f90018b46d26bb5bcfb7974ccd5474';
const put=(p,v)=>{fs.writeFileSync(p,Buffer.isBuffer(v)?v:encode(v),{mode:0o600});fs.chmodSync(p,0o600);};
function oldFixture(){
 const uid=process.getuid();assert.notEqual(uid,0,'fixtures require documented non-root UID injection');
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bron-t59-budget-')));fs.chmodSync(parent,0o700);
 const legacy=parent+'/old',diag=parent+'/diag',state=parent+'/t58';for(const p of [legacy,diag,state])fs.mkdirSync(p,{mode:0o700});
 put(legacy+'/scope.json',{format:1,directory:legacy,scopeSha256:original,sourceProject:source,destinationVps:vps,maxAttempts:3});
 for(const [n,action,cap]of [[1,'T37.live','a'.repeat(64)],[2,'T56.final_before',cap56]])put(legacy+`/attempt-${n}.json`,{
  format:1,scopeSha256:original,sourceProject:source,destinationVps:vps,maxAttempts:3,attempt:n,actionId:action,capabilitySha256:cap,claimedUtc:'2026-11-15T10:00:00.000Z'});
 const legacyHashes={scopeSha256:sha(fs.readFileSync(legacy+'/scope.json')),attempt1Sha256:sha(fs.readFileSync(legacy+'/attempt-1.json')),attempt2Sha256:sha(fs.readFileSync(legacy+'/attempt-2.json'))};
 put(diag+'/scope.json',{format:1,task:'T58',ownerGrantSha256:grant58,initializedByManifestSha256:m58,sourceProject:source,destinationVps:vps,
  maxTotal:3,priorUsed:2,diagnosticAttempts:1,repurposesUnusedLegacySlot:true,futureFinalsAuthorized:false,legacy:legacyHashes});
 put(diag+'/attempt-3.json',{format:1,task:'T58',actionId:'T58.auth_diagnostic',manifestSha256:m58,ownerGrantSha256:grant58,
  globalAttempt:3,priorUsed:2,maxTotal:3,capabilitySha256:cap58,claimedUtc:'2026-11-15T10:01:00.000Z',futureFinalsAuthorized:false});
 put(state+'/result.json',{task:'T58',status:'DIAGNOSTICS_COMPLETE',globalAttemptsUsed:3,sourceSnapshotAttempts:1,targetWrites:0,targetWriteOutcome:'UNCHANGED',
  oldLedgerUnchanged:true,oldT56Unchanged:true,budgetUncertain:false,summary:{cohortMembershipEqual:true,mismatchedColumns:['last_sign_in_at','updated_at'],sourceRows:16,targetRows:16,changedMatchedRows:2,otherChangedRows:1}});
 put(state+'/run.guard',{task:'T58',actionId:'T58.auth_diagnostic',manifestSha256:m58});
 const pins={diagnosticScopeSha256:sha(fs.readFileSync(diag+'/scope.json')),diagnosticAttempt3Sha256:sha(fs.readFileSync(diag+'/attempt-3.json')),
  diagnosticResultSha256:sha(fs.readFileSync(state+'/result.json')),diagnosticGuardSha256:sha(fs.readFileSync(state+'/run.guard'))};
 const binding={directory:parent+'/final',ownerGrantSha256:'97e8dcdc47a5fd33866b0c84f8276594f577923618c382d202add554dd6895d2',manifestSha256:'c8646bd0307ff722851fc413d206c81d4b6b7aa0c2fa2d0a65f483678000413a',sourceProject:source,destinationVps:vps,maxAttempts:5,priorUsed:3,uid,
  fixture:{legacyDirectory:legacy,diagnosticDirectory:diag,diagnosticResultPath:state+'/result.json',diagnosticGuardPath:state+'/run.guard',priorPins:pins}};
 const originals=()=>Object.fromEntries([legacy+'/scope.json',legacy+'/attempt-1.json',legacy+'/attempt-2.json',diag+'/scope.json',diag+'/attempt-3.json',state+'/result.json',state+'/run.guard'].map(p=>[p,sha(fs.readFileSync(p))]));
 return {parent,legacy,diag,state,binding,file:n=>binding.directory+'/'+n,originals,close:()=>fs.rmSync(parent,{recursive:true,force:true})};
}


const oldCap='6c6021ba66444f384593c98792a945b804afaadb156006b7269300e57f559b77';
function fixture(){
 const f=oldFixture();prepareT59(f.binding);consumeT59({...f.binding,actionId:'T59.final_before',capabilitySha256:oldCap});
 const priorBinding=f.binding,priorResultPath=f.state+'/t59-final-result.json';
 const result={task:'T59',actionId:'T59.final_https_window',status:'BLOCKED',phase:'source-fence-before-target-write',code:'FINAL_HTTPS_WINDOW_FAILED',targetWriteOutcome:'UNCHANGED',
  recovery:{targetWriteOutcome:'UNCHANGED',sourceFrameAttempts:1,beforeImage:null,sourceMustRemainClosed:true},fenceFailure:{stage:'before-target-write',code:'COORDINATOR_FENCE_ACK_TIMEOUT'}};
 put(priorResultPath,result);
 const oldFiles=[priorBinding.directory+'/scope.json',priorBinding.directory+'/attempt-4.json',priorResultPath];
 const originals=()=>({...f.originals(),...Object.fromEntries(oldFiles.map(p=>[p,sha(fs.readFileSync(p))]))});
 const binding={directory:f.parent+'/t60',ownerGrantSha256:'d'.repeat(64),manifestSha256:'e'.repeat(64),sourceProject:source,destinationVps:vps,maxAttempts:6,priorUsed:4,uid:process.getuid(),fixture:{priorBinding,priorResultPath}};
 return {...f,priorBinding,priorResultPath,result,binding,originals,file:n=>binding.directory+'/'+n};
}
const claim=(b,actionId,capabilitySha256='f'.repeat(64))=>consumeBudget({...b,actionId,capabilitySha256});
test('T60 seals all four consumed claims and zero-write blocked result; repeatedprepare does not reset',()=>{
 const f=fixture();try{const old=f.originals();const s=prepareBudget(f.binding);assert.equal(s.used,4);assert.equal(s.remaining,2);assert.equal(s.uncertain,false);assert.deepEqual(s.claims.map(x=>x.attempt),[1,2,3,4]);
 const raw=fs.readFileSync(f.file('scope.json'));claim(f.binding,'T60.final_before');assert.equal(prepareBudget(f.binding).used,5);assert.deepEqual(fs.readFileSync(f.file('scope.json')),raw);assert.deepEqual(f.originals(),old);
 }finally{f.close();}
});
test('only fresh samecap claims5/6 accepted; seventh refused',()=>{
 const f=fixture();try{prepareBudget(f.binding);for(const [n,action]of [[5,'T60.final_before'],[6,'T60.final_after']]){
 const r=claim(f.binding,action);assert.equal(r.attempt,n);assert.equal(r.remaining,6-n);assert.equal(r.claimPath,f.file(`attempt-${n}.json`));assert.equal(readBudgetStatus(f.binding).used,n);assert.equal(fs.statSync(r.claimPath).mode&0o777,0o600);}
 assert.throws(()=>claim(f.binding,'T60.final_after'),{code:'T60_BUDGET_EXHAUSTED'});
 }finally{f.close();}
});
test('oldscope5/prior3, oldcap, wrongorder or caprotation do not consume',()=>{
 const f=fixture();try{for(const patch of [{maxAttempts:5},{priorUsed:3}])assert.throws(()=>prepareBudget({...f.binding,...patch}),{code:'T60_BUDGET_BINDING_INVALID'});prepareBudget(f.binding);
 assert.throws(()=>claim(f.binding,'T60.final_after'),{code:'T60_BUDGET_ACTION_SEQUENCE'});assert.throws(()=>claim(f.binding,'T60.final_before',oldCap),{code:'T60_BUDGET_FRESH_CAPABILITY_REQUIRED'});
 claim(f.binding,'T60.final_before');assert.throws(()=>claim(f.binding,'T60.final_after','b'.repeat(64)),{code:'T60_BUDGET_ACTION_SEQUENCE'});assert.equal(readBudgetStatus(f.binding).used,5);
 }finally{f.close();}
});
test('changed result or spent T59slot5 blocks before a new claim',()=>{
 for(const mode of ['changed-result','oldclaim5','wrongphase','beforeimage','uncertain']){const f=fixture();try{prepareBudget(f.binding);
 if(mode==='oldclaim5')consumeT59({...f.priorBinding,actionId:'T59.final_after',capabilitySha256:oldCap});
 else{const v={...f.result,recovery:{...f.result.recovery}};if(mode==='changed-result')v.extra=true;if(mode==='wrongphase')v.phase='other';if(mode==='beforeimage')v.recovery.beforeImage={path:'/private'};if(mode==='uncertain')v.budgetUncertain=true;put(f.priorResultPath,v);}
 assert.throws(()=>claim(f.binding,'T60.final_before'));assert.equal(fs.existsSync(f.file('attempt-5.json')),false);
 }finally{f.close();}}
});
test('malformed final claim stays consumeduncertain; no reset/refund',()=>{
 const f=fixture();try{prepareBudget(f.binding);put(f.file('attempt-5.json'),Buffer.from('{'));const raw=fs.readFileSync(f.file('attempt-5.json'));const s=readBudgetStatus(f.binding);assert.equal(s.uncertain,true);assert.equal(s.used,null);assert.equal(s.remaining,null);
 assert.throws(()=>prepareBudget(f.binding),{code:'T60_BUDGET_UNCERTAIN'});assert.throws(()=>claim(f.binding,'T60.final_before'),{code:'T60_BUDGET_UNCERTAIN'});assert.deepEqual(fs.readFileSync(f.file('attempt-5.json')),raw);
 }finally{f.close();}
});
test('changed scope, unknown entries, unsafe prior permissions and links fail closed',()=>{
 for(const mode of ['scope','unknown','mode','link']){const f=fixture();try{prepareBudget(f.binding);
 if(mode==='scope')fs.appendFileSync(f.file('scope.json'),' ');if(mode==='unknown')put(f.file('attempt-7.json'),{});if(mode==='mode')fs.chmodSync(f.priorResultPath,0o640);if(mode==='link')fs.linkSync(f.priorResultPath,f.parent+'/linked');
 assert.throws(()=>claim(f.binding,'T60.final_before'));assert.equal(fs.existsSync(f.file('attempt-5.json')),false);
 }finally{f.close();}}
});
test('import and CLI are inert',()=>{
 const file=path.resolve('docs/runbooks/payloads/t60-source-transfer-budget.mjs');for(const args of [[file],['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(file).href)})`]]){const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:2000});assert.equal(r.status,0);assert.equal(r.stdout+r.stderr,'');}
});
