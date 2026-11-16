import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {SOURCE_TRANSFER_SCOPE_SHA256,prepareBudget,readBudgetStatus,consumeBudget} from '../../docs/runbooks/payloads/source-transfer-budget.mjs';

const uid=process.getuid();
const fixture=()=>{
 assert.notEqual(uid,0,'local filesystem tests require the documented non-root ownership injection');
 const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bron-transfer-budget-')));fs.chmodSync(parent,0o700);
 const binding={directory:path.join(parent,'ledger'),scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,
  sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',maxAttempts:3,uid};
 return {parent,binding,file:n=>path.join(binding.directory,n),close:()=>fs.rmSync(parent,{recursive:true,force:true})};
};
const claim=(b,actionId,capabilitySha256='a'.repeat(64))=>consumeBudget({...b,actionId,capabilitySha256});
const edit=(filename,value)=>{fs.writeFileSync(filename,typeof value==='string'?value:JSON.stringify(value)+'\n');fs.chmodSync(filename,0o600);};

test('module import and CLI remain inert with no filesystem, credential or network action',()=>{
 const module=path.resolve('docs/runbooks/payloads/source-transfer-budget.mjs');
 for(const args of [[module],['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(module).href)})`]]){
  const child=spawnSync(process.execPath,args,{encoding:'utf8',timeout:2000});assert.equal(child.status,0);assert.equal(child.stdout+child.stderr,'');
 }
});

test('fixed scope preparation is private, immutable and reusable without resetting spent attempts',()=>{
 const f=fixture();try{
  const first=prepareBudget(f.binding);assert.deepEqual(first,{used:0,remaining:3,maxAttempts:3,claims:[],uncertain:false});
  const p=f.file('scope.json'),before=fs.readFileSync(p),inode=fs.statSync(p).ino;
  assert.equal(fs.statSync(f.binding.directory).mode&0o777,0o700);assert.equal(fs.statSync(p).mode&0o777,0o600);
  assert.equal(JSON.parse(before).scopeSha256,SOURCE_TRANSFER_SCOPE_SHA256);
  claim(f.binding,'T37.live');const again=prepareBudget({...f.binding,capabilitySha256:'b'.repeat(64)});
  assert.equal(again.used,1);assert.equal(again.remaining,2);assert.equal(fs.statSync(p).ino,inode);assert.deepEqual(fs.readFileSync(p),before);
 }finally{f.close();}
});

test('three append-only claims bind ordered phases and rotated capability digests; fourth attempt is refused',()=>{
 const f=fixture();try{
  prepareBudget(f.binding);const before=fs.readFileSync(f.file('scope.json'));
  for(const [i,actionId]of ['T37.live','T40.final_before','T40.final_after'].entries()){
   const r=claim(f.binding,actionId,String(i+1).repeat(64));assert.equal(r.attempt,i+1);assert.equal(r.remaining,2-i);
   assert.equal(r.claimPath,f.file(`attempt-${i+1}.json`));assert.match(r.claimSha256,/^[a-f0-9]{64}$/);
   const p=JSON.parse(fs.readFileSync(r.claimPath));assert.equal(p.actionId,actionId);assert.equal(p.attempt,i+1);
   assert.equal(p.capabilitySha256,String(i+1).repeat(64));assert.equal(p.scopeSha256,SOURCE_TRANSFER_SCOPE_SHA256);
   assert.equal(fs.statSync(r.claimPath).mode&0o777,0o600);assert.equal(fs.statSync(r.claimPath).nlink,1);
  }
  const status=readBudgetStatus(f.binding);assert.equal(status.used,3);assert.equal(status.remaining,0);assert.equal(status.uncertain,false);
  assert.equal(prepareBudget(f.binding).used,3);assert.deepEqual(fs.readFileSync(f.file('scope.json')),before);
  assert.throws(()=>claim(f.binding,'T37.live','e'.repeat(64)),{code:'SOURCE_TRANSFER_BUDGET_EXHAUSTED'});
 }finally{f.close();}
});

test('duplicate live and wrong phase cannot advance the ledger, even with a new capability',()=>{
 const f=fixture();try{
  prepareBudget(f.binding);
  for(const action of ['T38.live','T40.final_before','T40.final_after'])assert.throws(()=>claim(f.binding,action),{code:'SOURCE_TRANSFER_ACTION_SEQUENCE'});
  assert.equal(readBudgetStatus(f.binding).used,0);claim(f.binding,'T37.live');
  for(const action of ['T37.live','T40.final_after'])assert.throws(()=>claim(f.binding,action,'b'.repeat(64)),{code:'SOURCE_TRANSFER_ACTION_SEQUENCE'});
  assert.equal(readBudgetStatus(f.binding).used,1);claim(f.binding,'T41.final_before','b'.repeat(64));
  for(const action of ['T40.final_after','T41.final_before','T37.live'])assert.throws(()=>claim(f.binding,action,'c'.repeat(64)),{code:'SOURCE_TRANSFER_ACTION_SEQUENCE'});
  assert.equal(readBudgetStatus(f.binding).used,2);claim(f.binding,'T41.final_after','c'.repeat(64));
 }finally{f.close();}
});

test('wrong release scope, project, destination, budget or owner cannot prepare a fresh ledger',()=>{
 const f=fixture();try{
  for(const patch of [{scopeSha256:'1'.repeat(64)},{maxAttempts:4},{maxAttempts:2},
   {sourceProject:'other'},{destinationVps:'127.0.0.1'},{directory:'relative/ledger'},{uid:uid+1}]){
   assert.throws(()=>prepareBudget({...f.binding,...patch}));assert.equal(fs.existsSync(f.binding.directory),false);
  }
  prepareBudget(f.binding);assert.throws(()=>claim(f.binding,'T37.live','RAW_SECRET'),{code:'SOURCE_TRANSFER_CAPABILITY_SHA_REQUIRED'});
  assert.equal(readBudgetStatus(f.binding).used,0);
 }finally{f.close();}
});

test('zero-byte or malformed claim is spent and uncertain; prepare/consume never reset or delete it',()=>{
 for(const bytes of ['', '{', 'PRIVATE_GARBAGE']){
  const f=fixture();try{
   prepareBudget(f.binding);edit(f.file('attempt-1.json'),bytes);
   const status=readBudgetStatus(f.binding);assert.equal(status.used,1);assert.equal(status.remaining,2);assert.equal(status.uncertain,true);
   assert.equal(status.claims[0].status,'UNCERTAIN');assert.doesNotMatch(JSON.stringify(status),/PRIVATE_GARBAGE/);
   assert.throws(()=>prepareBudget(f.binding),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
   assert.throws(()=>claim(f.binding,'T40.final_before'),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
   assert.equal(fs.readFileSync(f.file('attempt-1.json'),'utf8'),bytes);assert.equal(fs.existsSync(f.file('attempt-2.json')),false);
  }finally{f.close();}
 }
});

test('claim symlink, hardlink or unsafe mode is counted as a spent uncertain slot',()=>{
 for(const mode of ['symlink','hardlink','mode']){
  const f=fixture();try{
   prepareBudget(f.binding);claim(f.binding,'T37.live');const slot=f.file('attempt-1.json'),outside=path.join(f.parent,'outside');
   if(mode==='mode')fs.chmodSync(slot,0o644);
   else if(mode==='hardlink')fs.linkSync(slot,outside);
   else{fs.renameSync(slot,outside);fs.symlinkSync(outside,slot);}
   const status=readBudgetStatus(f.binding);assert.equal(status.used,1);assert.equal(status.uncertain,true);
   assert.throws(()=>claim(f.binding,'T40.final_before'),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
   assert.ok(fs.lstatSync(slot));
  }finally{f.close();}
 }
});

test('unknown ledger files and holes fail closed; existing valid slots still count',()=>{
 const unknown=fixture();try{
  prepareBudget(unknown.binding);edit(unknown.file('unknown.json'),'PRIVATE_UNKNOWN');
  assert.equal(readBudgetStatus(unknown.binding).uncertain,true);
  assert.throws(()=>claim(unknown.binding,'T37.live'),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
  assert.equal(fs.existsSync(unknown.file('attempt-1.json')),false);
 }finally{unknown.close();}
 const hole=fixture();try{
  prepareBudget(hole.binding);claim(hole.binding,'T37.live');claim(hole.binding,'T40.final_before');
  fs.unlinkSync(hole.file('attempt-1.json'));const status=readBudgetStatus(hole.binding);
  assert.equal(status.used,1);assert.equal(status.claims[0].attempt,2);assert.equal(status.uncertain,true);
  assert.throws(()=>prepareBudget(hole.binding),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
 }finally{hole.close();}
});

test('mismatching final task and corrupted scope cannot be repaired or silently rebound',()=>{
 const f=fixture();try{
  prepareBudget(f.binding);claim(f.binding,'T37.live');claim(f.binding,'T40.final_before');claim(f.binding,'T40.final_after');
  const slot=f.file('attempt-3.json'),value=JSON.parse(fs.readFileSync(slot));value.actionId='T41.final_after';edit(slot,value);
  const status=readBudgetStatus(f.binding);assert.equal(status.used,3);assert.equal(status.uncertain,true);
  assert.throws(()=>claim(f.binding,'T40.final_after'),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
 }finally{f.close();}
 const scope=fixture();try{
  prepareBudget(scope.binding);const filename=scope.file('scope.json'),value=JSON.parse(fs.readFileSync(filename));value.maxAttempts=4;edit(filename,value);
  assert.throws(()=>prepareBudget(scope.binding),{code:'SOURCE_TRANSFER_SCOPE_MISMATCH'});
  assert.throws(()=>claim(scope.binding,'T37.live'),{code:'SOURCE_TRANSFER_SCOPE_MISMATCH'});
  assert.equal(JSON.parse(fs.readFileSync(filename)).maxAttempts,4);
 }finally{scope.close();}
});

test('unsafe scope files/directories and content without scope are never overwritten',()=>{
 for(const mode of ['file-mode','scope-link','scope-hardlink','directory-mode']){
  const f=fixture();try{
   prepareBudget(f.binding);const file=f.file('scope.json');
   if(mode==='file-mode')fs.chmodSync(file,0o640);
   if(mode==='directory-mode')fs.chmodSync(f.binding.directory,0o755);
   if(mode==='scope-link'){const outside=path.join(f.parent,'scope-outside');fs.renameSync(file,outside);fs.symlinkSync(outside,file);}
   if(mode==='scope-hardlink')fs.linkSync(file,path.join(f.parent,'scope-outside'));
   assert.throws(()=>prepareBudget(f.binding));assert.throws(()=>claim(f.binding,'T37.live'));assert.ok(fs.lstatSync(file));
  }finally{f.close();}
 }
 const missing=fixture();try{
  fs.mkdirSync(missing.binding.directory,0o700);edit(missing.file('attempt-1.json'),'');
  assert.throws(()=>prepareBudget(missing.binding),{code:'SOURCE_TRANSFER_SCOPE_MISSING_WITH_CONTENT'});
  assert.equal(fs.existsSync(missing.file('scope.json')),false);
 }finally{missing.close();}
});

test('partial write failure leaves its slot spent, redacts errors and blocks subsequent use',()=>{
 const f=fixture(),original=fs.writeFileSync;try{
  prepareBudget(f.binding);const slot=f.file('attempt-1.json');
  fs.writeFileSync=(fd,...args)=>{
   if(typeof fd==='number'&&fs.existsSync(slot)&&fs.fstatSync(fd).ino===fs.lstatSync(slot).ino){
    original(fd,'{');throw Object.assign(new Error('PRIVATE_IO_FAILURE'),{code:'EIO'});
   }
   return original(fd,...args);
  };
  assert.throws(()=>claim(f.binding,'T37.live'),e=>e.code==='SOURCE_TRANSFER_CLAIM_WRITE_FAILED'&&!e.message.includes('PRIVATE_IO_FAILURE'));
  fs.writeFileSync=original;const status=readBudgetStatus(f.binding);assert.equal(status.used,1);assert.equal(status.uncertain,true);
  assert.throws(()=>claim(f.binding,'T40.final_before'),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
 }finally{fs.writeFileSync=original;f.close();}
});

test('two concurrent claimers cannot spend the same live phase or advance a second slot',async()=>{
 const f=fixture();try{
  prepareBudget(f.binding);const module=pathToFileURL(path.resolve('docs/runbooks/payloads/source-transfer-budget.mjs')).href;
  const worker=path.join(f.parent,'race.mjs');fs.writeFileSync(worker,`import fs from 'node:fs';
import {consumeBudget} from ${JSON.stringify(module)};
const b=JSON.parse(process.argv[2]),id=process.argv[3],other=id==='0'?'1':'0',open=fs.openSync;
fs.openSync=function(file,flags,...args){
 if(String(file).endsWith('/attempt-1.json')&&(flags&fs.constants.O_CREAT)){
  fs.writeFileSync(b.directory+'/../ready-'+id,'x');const end=Date.now()+3000;
  while(!fs.existsSync(b.directory+'/../ready-'+other)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
 }
 return open.call(fs,file,flags,...args);
};
try{const r=consumeBudget({...b,actionId:'T37.live',capabilitySha256:'a'.repeat(64)});console.log(JSON.stringify({ok:true,attempt:r.attempt}));}
catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}
`);
  const run=id=>new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[worker,JSON.stringify(f.binding),id],{stdio:['ignore','pipe','pipe']});let out='',err='';
   child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);
   child.on('close',code=>{try{assert.equal(code,0);assert.equal(err,'');resolve(JSON.parse(out));}catch(e){reject(e);}});
  });
  const results=await Promise.all([run('0'),run('1')]);assert.equal(results.filter(r=>r.ok).length,1);
  assert.ok(results.some(r=>r.code==='SOURCE_TRANSFER_CLAIM_CONFLICT'));
  const status=readBudgetStatus(f.binding);assert.equal(status.used,1);assert.equal(status.uncertain,false);
  assert.equal(fs.existsSync(f.file('attempt-2.json')),false);
 }finally{f.close();}
});
