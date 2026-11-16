import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepareBudget,readBudgetStatus,consumeBudget} from '../../docs/runbooks/payloads/t59-source-transfer-budget.mjs';

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
function fixture(){
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
 const binding={directory:parent+'/final',ownerGrantSha256:'d'.repeat(64),manifestSha256:'e'.repeat(64),sourceProject:source,destinationVps:vps,maxAttempts:5,priorUsed:3,uid,
  fixture:{legacyDirectory:legacy,diagnosticDirectory:diag,diagnosticResultPath:state+'/result.json',diagnosticGuardPath:state+'/run.guard',priorPins:pins}};
 const originals=()=>Object.fromEntries([legacy+'/scope.json',legacy+'/attempt-1.json',legacy+'/attempt-2.json',diag+'/scope.json',diag+'/attempt-3.json',state+'/result.json',state+'/run.guard'].map(p=>[p,sha(fs.readFileSync(p))]));
 return {parent,legacy,diag,state,binding,file:n=>binding.directory+'/'+n,originals,close:()=>fs.rmSync(parent,{recursive:true,force:true})};
}
const claim=(b,actionId,capabilitySha256='f'.repeat(64))=>consumeBudget({...b,actionId,capabilitySha256});

test('import and direct CLI are inert',()=>{
 const file=path.resolve('docs/runbooks/payloads/t59-source-transfer-budget.mjs');
 for(const args of [[file],['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(file).href)})`]]){
  const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:2000});assert.equal(r.status,0);assert.equal(r.stdout+r.stderr,'');
 }
});
test('three prior attempts are sealed without modifying old files; preparation never resets',()=>{
 const f=fixture();try{const before=f.originals(),s=prepareBudget(f.binding);assert.equal(s.used,3);assert.equal(s.remaining,2);assert.equal(s.maxAttempts,5);assert.equal(s.priorUsed,3);assert.equal(s.uncertain,false);assert.deepEqual(s.claims.map(c=>c.attempt),[1,2,3]);
  const raw=fs.readFileSync(f.file('scope.json')),inode=fs.statSync(f.file('scope.json')).ino;claim(f.binding,'T59.final_before');assert.equal(prepareBudget(f.binding).used,4);assert.deepEqual(fs.readFileSync(f.file('scope.json')),raw);assert.equal(fs.statSync(f.file('scope.json')).ino,inode);assert.deepEqual(f.originals(),before);assert.equal(fs.existsSync(f.legacy+'/attempt-3.json'),false);
 }finally{f.close();}
});
test('only claims4/5 with one fresh capability can advance3→4→5; sixth refused',()=>{
 const f=fixture();try{prepareBudget(f.binding);for(const [n,action]of [[4,'T59.final_before'],[5,'T59.final_after']]){
   const r=claim(f.binding,action);assert.equal(r.attempt,n);assert.equal(r.remaining,5-n);assert.equal(r.claimPath,f.file(`attempt-${n}.json`));assert.match(r.claimSha256,/^[a-f0-9]{64}$/);assert.equal(fs.statSync(r.claimPath).mode&0o777,0o600);assert.equal(fs.statSync(r.claimPath).nlink,1);
   const s=readBudgetStatus(f.binding);assert.equal(s.used,n);assert.equal(s.remaining,5-n);assert.equal(s.uncertain,false);
  }assert.throws(()=>claim(f.binding,'T59.final_after'),{code:'T59_BUDGET_EXHAUSTED'});
 }finally{f.close();}
});
test('wrong purpose/order, old capability and after-capability rotation cannot consume a slot',()=>{
 const f=fixture();try{prepareBudget(f.binding);for(const action of ['T58.auth_diagnostic','T59.final_after','T56.final_before'])assert.throws(()=>claim(f.binding,action),{code:'T59_BUDGET_ACTION_SEQUENCE'});
  for(const cap of ['a'.repeat(64),cap56,cap58])assert.throws(()=>claim(f.binding,'T59.final_before',cap),{code:'T59_BUDGET_FRESH_CAPABILITY_REQUIRED'});
  assert.equal(readBudgetStatus(f.binding).used,3);claim(f.binding,'T59.final_before');assert.throws(()=>claim(f.binding,'T59.final_after','b'.repeat(64)),{code:'T59_BUDGET_ACTION_SEQUENCE'});assert.equal(readBudgetStatus(f.binding).used,4);
 }finally{f.close();}
});
test('incorrect grant/manifest/budget/UID binding cannot create a ledger',()=>{
 const f=fixture();try{for(const patch of [{ownerGrantSha256:'SECRET'},{manifestSha256:null},{maxAttempts:3},{priorUsed:1},{sourceProject:'other'},{destinationVps:'127.0.0.1'},{uid:0},{uid:process.getuid()+1}]){
  assert.throws(()=>prepareBudget({...f.binding,...patch}));assert.equal(fs.existsSync(f.binding.directory),false);
 }}finally{f.close();}
});
test('every old artifact is immutable before prepare and before subsequent claims',()=>{
 for(const key of ['oldScope','old1','old2','scope','claim','result','guard']){const f=fixture();try{
   prepareBudget(f.binding);claim(f.binding,'T59.final_before');const files={oldScope:f.legacy+'/scope.json',old1:f.legacy+'/attempt-1.json',old2:f.legacy+'/attempt-2.json',scope:f.diag+'/scope.json',claim:f.diag+'/attempt-3.json',result:f.state+'/result.json',guard:f.state+'/run.guard'};
   fs.appendFileSync(files[key],' ');assert.throws(()=>readBudgetStatus(f.binding));assert.throws(()=>claim(f.binding,'T59.final_after'));assert.equal(fs.existsSync(f.file('attempt-5.json')),false);
  }finally{f.close();}}
});
test('an old unused-slot claim and prior symlink/hardlink/unsafe permissions stop new reads',()=>{
 for(const mode of ['third','symlink','hardlink','mode']){const f=fixture();try{prepareBudget(f.binding);
   const p=f.diag+'/attempt-3.json',other=f.parent+'/other';if(mode==='third')put(f.legacy+'/attempt-3.json',{invalid:true});
   if(mode==='symlink'){fs.renameSync(p,other);fs.symlinkSync(other,p);}if(mode==='hardlink')fs.linkSync(p,other);if(mode==='mode')fs.chmodSync(p,0o640);
   assert.throws(()=>readBudgetStatus(f.binding));assert.throws(()=>claim(f.binding,'T59.final_before'));assert.equal(fs.existsSync(f.file('attempt-4.json')),false);
  }finally{f.close();}}
});
test('malformed existing final claim is spent/uncertain and never refunded or overwritten',()=>{
 for(const raw of [Buffer.alloc(0),Buffer.from('{'),encode({private:'DO_NOT_PRINT'})]){const f=fixture();try{prepareBudget(f.binding);put(f.file('attempt-4.json'),raw);const s=readBudgetStatus(f.binding);assert.equal(s.uncertain,true);assert.equal(s.used,null);assert.equal(s.remaining,null);assert.doesNotMatch(JSON.stringify(s),/DO_NOT_PRINT/);
   assert.throws(()=>prepareBudget(f.binding),{code:'T59_BUDGET_UNCERTAIN'});assert.throws(()=>claim(f.binding,'T59.final_before'),{code:'T59_BUDGET_UNCERTAIN'});assert.deepEqual(fs.readFileSync(f.file('attempt-4.json')),raw);
  }finally{f.close();}}
});
test('unknown files, holes and corrupted cap binding are uncertain, not ignored',()=>{
 for(const mode of ['unknown','hole','cap']){const f=fixture();try{prepareBudget(f.binding);claim(f.binding,'T59.final_before');claim(f.binding,'T59.final_after');
   if(mode==='unknown')put(f.file('attempt-6.json'),{});if(mode==='hole')fs.unlinkSync(f.file('attempt-4.json'));if(mode==='cap'){const p=f.file('attempt-5.json'),v=JSON.parse(fs.readFileSync(p));v.capabilitySha256='b'.repeat(64);put(p,v);}
   const s=readBudgetStatus(f.binding);assert.equal(s.uncertain,true);assert.equal(s.used,null);assert.equal(s.remaining,null);assert.throws(()=>claim(f.binding,'T59.final_after'),{code:'T59_BUDGET_UNCERTAIN'});
  }finally{f.close();}}
});
test('changed new scope or rebind cannot reset a prepared ledger',()=>{
 const f=fixture();try{prepareBudget(f.binding);const p=f.file('scope.json'),raw=fs.readFileSync(p);assert.throws(()=>prepareBudget({...f.binding,manifestSha256:'c'.repeat(64)}),{code:'T59_BUDGET_SCOPE_CHANGED'});assert.deepEqual(fs.readFileSync(p),raw);
  const v=JSON.parse(raw);v.priorUsed=0;put(p,v);assert.throws(()=>claim(f.binding,'T59.final_before'),{code:'T59_BUDGET_SCOPE_CHANGED'});
 }finally{f.close();}
});
test('concurrent claim4 callers create at most one spent slot',async()=>{
 const f=fixture();try{prepareBudget(f.binding);const module=pathToFileURL(path.resolve('docs/runbooks/payloads/t59-source-transfer-budget.mjs')).href;
  const code=`import {consumeBudget} from ${JSON.stringify(module)};try{const r=consumeBudget(${JSON.stringify({...f.binding,actionId:'T59.final_before',capabilitySha256:'f'.repeat(64)})});process.stdout.write(String(r.attempt));}catch(e){process.stdout.write(e.code);process.exitCode=2;}`;
  const one=()=>new Promise(resolve=>{const p=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.on('close',status=>resolve({status,out}));});
  const r=await Promise.all([one(),one()]);assert.equal(r.filter(x=>x.status===0).length,1);assert.equal(r.find(x=>x.status===0).out,'4');assert.equal(readBudgetStatus(f.binding).used,4);assert.equal(fs.existsSync(f.file('attempt-5.json')),false);
 }finally{f.close();}
});
