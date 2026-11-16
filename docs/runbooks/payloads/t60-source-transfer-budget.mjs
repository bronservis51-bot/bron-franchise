// T60 append-only successor: preserve all four spent attempts and the blocked T59 result.
// Inert on import. No Source connection, reset, refund or target mutation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readBudgetStatus as readT59BudgetStatus} from './t59-source-transfer-budget.mjs';
const ROOT='/root/bron-secrets',DIR=ROOT+'/source-auth-final-e60a2026';
const PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115';
const OLD_CAP='6c6021ba66444f384593c98792a945b804afaadb156006b7269300e57f559b77';
const PRIOR_BINDING=Object.freeze({directory:ROOT+'/source-auth-final-e59a2026',ownerGrantSha256:'97e8dcdc47a5fd33866b0c84f8276594f577923618c382d202add554dd6895d2',manifestSha256:'c8646bd0307ff722851fc413d206c81d4b6b7aa0c2fa2d0a65f483678000413a',sourceProject:PROJECT,destinationVps:VPS,maxAttempts:5,priorUsed:3});
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encoded=x=>Buffer.from(canonical(x)+'\n'),same=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exists=p=>{try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const parsed=raw=>{try{return JSON.parse(raw);}catch{fail('T60_BUDGET_PRIOR_UNSAFE');}};
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;

function directory(p,b){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==b.uid||s.gid!==b.gid||
 (s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T60_BUDGET_DIRECTORY_UNSAFE');}
function parent(b){if(b.uid===0)directory('/root',b);directory(path.dirname(b.directory),b);}
function privateBytes(p,b){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{
 const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==b.uid||s.gid!==b.gid||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>65536)fail('T60_BUDGET_FILE_UNSAFE');
 const raw=fs.readFileSync(fd),a=fs.fstatSync(fd),n=fs.lstatSync(p);if(raw.length!==s.size||s.size!==a.size||s.mtimeMs!==a.mtimeMs||s.ctimeMs!==a.ctimeMs||s.ino!==n.ino||s.dev!==n.dev)fail('T60_BUDGET_FILE_CHANGED');return raw;
 }finally{fs.closeSync(fd);}}
function sync(p){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function writeNew(p,raw,b){directory(b.directory,b);const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync(b.directory);if(!privateBytes(p,b).equals(raw))fail('T60_BUDGET_READBACK');}

function binding(input){
 const uid=input?.uid??0;
 if(!Number.isInteger(uid)||uid<0||typeof input?.directory!=='string'||path.resolve(input.directory)!==input.directory||
  !digest(input.ownerGrantSha256)||!digest(input.manifestSha256)||input.sourceProject!==PROJECT||input.destinationVps!==VPS||
  input.maxAttempts!==6||input.priorUsed!==4)fail('T60_BUDGET_BINDING_INVALID');
 let priorBinding={...PRIOR_BINDING},priorResultPath=ROOT+'/t59-release/final-result.json';
 if(uid===0){
  if(process.platform!=='linux'||process.getuid?.()!==0||input.directory!==DIR||input.fixture!==undefined)fail('T60_BUDGET_ROOT_REQUIRED');
 }else{
  if(process.getuid?.()===0||process.getuid?.()!==uid||!exact(input.fixture,['priorBinding','priorResultPath']))fail('T60_BUDGET_TEST_OWNER');
  ({priorBinding,priorResultPath}=input.fixture);
  if(priorBinding?.uid!==uid||typeof priorResultPath!=='string'||!path.isAbsolute(priorResultPath)||path.resolve(priorResultPath)!==priorResultPath||
   priorBinding.ownerGrantSha256!==PRIOR_BINDING.ownerGrantSha256||priorBinding.manifestSha256!==PRIOR_BINDING.manifestSha256)
   fail('T60_BUDGET_TEST_INPUT');
 }
 return {directory:input.directory,uid,gid:uid===0?0:process.getgid(),ownerGrantSha256:input.ownerGrantSha256,
  manifestSha256:input.manifestSha256,priorBinding,priorResultPath};
}
function readPrior(b){
 try{
  const status=readT59BudgetStatus(b.priorBinding);
  if(status.uncertain!==false||status.used!==4||status.remaining!==1||status.maxAttempts!==5||status.priorUsed!==3||status.claims.length!==4||
   status.claims.some((c,i)=>c.status!=='VALID'||c.attempt!==i+1)||status.claims[3].actionId!=='T59.final_before'||status.claims[3].capabilitySha256!==OLD_CAP)
   fail('T60_BUDGET_PRIOR_CHANGED');
  directory(path.dirname(b.priorResultPath),b);const resultRaw=privateBytes(b.priorResultPath,b),r=parsed(resultRaw);
  if(r.task!=='T59'||r.actionId!=='T59.final_https_window'||r.status!=='BLOCKED'||r.phase!=='source-fence-before-target-write'||
   r.code!=='FINAL_HTTPS_WINDOW_FAILED'||r.targetWriteOutcome!=='UNCHANGED'||r.recovery?.targetWriteOutcome!=='UNCHANGED'||
   r.recovery?.sourceFrameAttempts!==1||r.recovery?.beforeImage!==null||r.recovery?.sourceMustRemainClosed!==true||
   r.fenceFailure?.stage!=='before-target-write'||r.fenceFailure?.code!=='COORDINATOR_FENCE_ACK_TIMEOUT'||r.budgetUncertain===true||r.claimMayBeConsumed===true)
   fail('T60_BUDGET_PRIOR_WINDOW_NOT_ZERO_WRITE');
  const scopeRaw=privateBytes(b.priorBinding.directory+'/scope.json',b);
  const prior={t59ScopeSha256:sha(scopeRaw),t59ResultSha256:sha(resultRaw),claims:status.claims.map(c=>({attempt:c.attempt,actionId:c.actionId,claimSha256:c.claimSha256,capabilitySha256:c.capabilitySha256}))};
  return {prior,claims:status.claims};
 }catch(e){if(/^T60_BUDGET_/.test(e?.code??''))throw e;fail('T60_BUDGET_PRIOR_UNSAFE');}
}
function scopeValue(b,prior){return {format:1,task:'T60',directory:b.directory,ownerGrantSha256:b.ownerGrantSha256,manifestSha256:b.manifestSha256,
 sourceProject:PROJECT,destinationVps:VPS,maxAttempts:6,priorUsed:4,prior};}
function readScope(b){parent(b);directory(b.directory,b);const prior=readPrior(b),raw=privateBytes(b.directory+'/scope.json',b);
 if(!raw.equals(encoded(scopeValue(b,prior.prior))))fail('T60_BUDGET_SCOPE_CHANGED');return prior;}
function validClaim(v,n,b){return exact(v,['format','task','actionId','attempt','priorUsed','maxAttempts','ownerGrantSha256','manifestSha256','sourceProject','destinationVps','capabilitySha256','claimedUtc'])&&
 v.format===1&&v.task==='T60'&&v.actionId===`T60.final_${n===5?'before':'after'}`&&v.attempt===n&&v.priorUsed===4&&v.maxAttempts===6&&
 v.ownerGrantSha256===b.ownerGrantSha256&&v.manifestSha256===b.manifestSha256&&v.sourceProject===PROJECT&&v.destinationVps===VPS&&digest(v.capabilitySha256)&&iso(v.claimedUtc);}
export function readBudgetStatus(input){
 const b=binding(input),prior=readScope(b),entries=fs.readdirSync(b.directory),claims=[...prior.claims];
 let uncertain=entries.some(n=>!['scope.json','attempt-5.json','attempt-6.json'].includes(n));
 for(const n of [5,6])if(entries.includes(`attempt-${n}.json`)){
  const claimPath=b.directory+`/attempt-${n}.json`;try{const raw=privateBytes(claimPath,b),v=parsed(raw);
   if(!validClaim(v,n,b)||!raw.equals(encoded(v)))throw Error();
   claims.push({attempt:n,status:'VALID',actionId:v.actionId,capabilitySha256:v.capabilitySha256,claimedUtc:v.claimedUtc,claimPath,claimSha256:sha(raw)});
  }catch{uncertain=true;claims.push({attempt:n,status:'UNCERTAIN',claimPath});}
 }
 for(let i=0;i<claims.length;i++)if(claims[i].attempt!==i+1)uncertain=true;
 if(claims.length===6&&claims[4].status==='VALID'&&claims[5].status==='VALID'&&claims[4].capabilitySha256!==claims[5].capabilitySha256)uncertain=true;
 return {used:uncertain?null:claims.length,remaining:uncertain?null:6-claims.length,maxAttempts:6,priorUsed:4,claims,uncertain};
}
export function prepareBudget(input){
 const b=binding(input);parent(b);const prior=readPrior(b);
 try{fs.mkdirSync(b.directory,{mode:0o700});sync(path.dirname(b.directory));}catch(e){if(e.code!=='EEXIST')fail('T60_BUDGET_PREPARE_FAILED');}
 directory(b.directory,b);const file=b.directory+'/scope.json';if(!exists(file)){
  if(fs.readdirSync(b.directory).length)fail('T60_BUDGET_SCOPE_MISSING');
  try{writeNew(file,encoded(scopeValue(b,prior.prior)),b);}catch(e){if(e.code!=='EEXIST')fail('T60_BUDGET_SCOPE_WRITE_FAILED');}
 }
 const status=readBudgetStatus(input);if(status.uncertain)fail('T60_BUDGET_UNCERTAIN');return status;
}
export function consumeBudget(input){
 const b=binding(input),status=readBudgetStatus(input);if(status.uncertain)fail('T60_BUDGET_UNCERTAIN');
 if(status.used>=6)fail('T60_BUDGET_EXHAUSTED');if(!digest(input.capabilitySha256))fail('T60_BUDGET_CAPABILITY_SHA');
 const n=status.used+1;if(input.actionId!==`T60.final_${n===5?'before':'after'}`||
  (n===6&&input.capabilitySha256!==status.claims[4].capabilitySha256))fail('T60_BUDGET_ACTION_SEQUENCE');
 if(status.claims.slice(0,4).some(c=>c.capabilitySha256===input.capabilitySha256))fail('T60_BUDGET_FRESH_CAPABILITY_REQUIRED');
 const claim={format:1,task:'T60',actionId:input.actionId,attempt:n,priorUsed:4,maxAttempts:6,ownerGrantSha256:b.ownerGrantSha256,
  manifestSha256:b.manifestSha256,sourceProject:PROJECT,destinationVps:VPS,capabilitySha256:input.capabilitySha256,claimedUtc:new Date().toISOString()};
 const raw=encoded(claim),claimPath=b.directory+`/attempt-${n}.json`;
 try{writeNew(claimPath,raw,b);}catch(e){throw Object.assign(new Error(e.code==='EEXIST'?'T60_BUDGET_CLAIM_CONFLICT':'T60_BUDGET_CLAIM_WRITE_FAILED'),
  {code:e.code==='EEXIST'?'T60_BUDGET_CLAIM_CONFLICT':'T60_BUDGET_CLAIM_WRITE_FAILED',claimMayBeConsumed:true});}
 return {attempt:n,remaining:6-n,claimPath,claimSha256:sha(raw)};
}
