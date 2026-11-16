// Fixed append-only T59 extension. Old ledgers remain immutable; no reset/refund.
// Import and CLI are inert. The reviewed caller owns actual owner consent/network.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const ROOT='/root/bron-secrets',DIR=ROOT+'/source-auth-final-e59a2026';
const PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115';
const ORIGINAL_GRANT='cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69';
const T58_MANIFEST='e234e56c63bf30d3510b7d10def4e1ec523d8cc0cbdd5f3689b43cc8f8afe2df';
const T58_GRANT='2d3dd423b2dced4b7f768d62c0b00e7f46675f8c7b27c53322a5e9c7142a5558';
const T58_CAP='10d499abd7c1402dc6741403b641057cd0f90018b46d26bb5bcfb7974ccd5474';
const T56_CAP='03629ff992411e281ea58eed42b6ca5590b70b2850475594a5c957a0e2391ad5';
export const PRIOR_PINS=Object.freeze({
 diagnosticScopeSha256:'b1851e8654c739357fe2dd89bd40892b4c57cbe79f57c1b0bc545d1c9ba12a17',
 diagnosticAttempt3Sha256:'6f9700af4cd91d643bc133602cbcdb72da40ceee60eed69025917d6ca953c972',
 diagnosticResultSha256:'385e9c2f6e5005b10fb06bb49d78b889ee452ecaa119e89f445b2b04eccee94b',
 diagnosticGuardSha256:'0a4c6e1d07e43e84c36f02d3f5ac73d6b2f6cbb0ce4603dc4e9a1563690adaab',
});
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encoded=x=>Buffer.from(canonical(x)+'\n'),same=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exists=p=>{try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const parsed=raw=>{try{return JSON.parse(raw);}catch{fail('T59_BUDGET_PRIOR_UNSAFE');}};
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;

function binding(input){
 const uid=input?.uid??0;
 if(!Number.isInteger(uid)||uid<0||typeof input?.directory!=='string'||path.resolve(input.directory)!==input.directory||
  !digest(input.ownerGrantSha256)||!digest(input.manifestSha256)||input.sourceProject!==PROJECT||input.destinationVps!==VPS||
  input.maxAttempts!==5||input.priorUsed!==3)fail('T59_BUDGET_BINDING_INVALID');
 let paths={legacyDirectory:ROOT+'/source-transfer-budget',diagnosticDirectory:ROOT+'/source-auth-extension-e58a2026',
  diagnosticResultPath:ROOT+'/t58-release/result.json',diagnosticGuardPath:ROOT+'/t58-release/run.guard'},pins=PRIOR_PINS;
 if(uid===0){
  if(process.platform!=='linux'||process.getuid?.()!==0||input.directory!==DIR||input.fixture!==undefined)fail('T59_BUDGET_ROOT_REQUIRED');
 }else{
  if(process.getuid?.()===0||process.getuid?.()!==uid||!exact(input.fixture,[...Object.keys(paths),'priorPins']))fail('T59_BUDGET_TEST_OWNER');
  paths=Object.fromEntries(Object.keys(paths).map(k=>[k,input.fixture[k]]));pins=input.fixture.priorPins;
  if(Object.values(paths).some(p=>typeof p!=='string'||!path.isAbsolute(p)||path.resolve(p)!==p)||
   !exact(pins,Object.keys(PRIOR_PINS))||Object.values(pins).some(x=>!digest(x)))fail('T59_BUDGET_TEST_INPUT');
 }
 return {directory:input.directory,uid,gid:uid===0?0:process.getgid(),ownerGrantSha256:input.ownerGrantSha256,
  manifestSha256:input.manifestSha256,paths,pins};
}
function directory(p,b){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==b.uid||s.gid!==b.gid||
 (s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T59_BUDGET_DIRECTORY_UNSAFE');}
function parent(b){if(b.uid===0)directory('/root',b);directory(path.dirname(b.directory),b);}
function privateBytes(p,b){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{
 const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==b.uid||s.gid!==b.gid||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>65536)fail('T59_BUDGET_FILE_UNSAFE');
 const raw=fs.readFileSync(fd),a=fs.fstatSync(fd),n=fs.lstatSync(p);if(raw.length!==s.size||s.size!==a.size||s.mtimeMs!==a.mtimeMs||s.ctimeMs!==a.ctimeMs||s.ino!==n.ino||s.dev!==n.dev)fail('T59_BUDGET_FILE_CHANGED');return raw;
 }finally{fs.closeSync(fd);}}
function sync(p){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function writeNew(p,raw,b){directory(b.directory,b);const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync(b.directory);if(!privateBytes(p,b).equals(raw))fail('T59_BUDGET_READBACK');}

function readPrior(b){
 try{
  const p=b.paths;directory(p.legacyDirectory,b);directory(p.diagnosticDirectory,b);directory(path.dirname(p.diagnosticResultPath),b);
  if(path.dirname(p.diagnosticGuardPath)!==path.dirname(p.diagnosticResultPath)||
   !same(fs.readdirSync(p.legacyDirectory).sort(),['attempt-1.json','attempt-2.json','scope.json']))fail('T59_BUDGET_PRIOR_CHANGED');
  const raw={legacyScope:privateBytes(p.legacyDirectory+'/scope.json',b),legacy1:privateBytes(p.legacyDirectory+'/attempt-1.json',b),
   legacy2:privateBytes(p.legacyDirectory+'/attempt-2.json',b),scope:privateBytes(p.diagnosticDirectory+'/scope.json',b),
   claim:privateBytes(p.diagnosticDirectory+'/attempt-3.json',b),result:privateBytes(p.diagnosticResultPath,b),guard:privateBytes(p.diagnosticGuardPath,b)};
  if(!same(fs.readdirSync(p.diagnosticDirectory).sort(),['attempt-3.json','scope.json']))fail('T59_BUDGET_PRIOR_CHANGED');
  for(const [key,name]of [['scope','diagnosticScopeSha256'],['claim','diagnosticAttempt3Sha256'],['result','diagnosticResultSha256'],['guard','diagnosticGuardSha256']])
   if(sha(raw[key])!==b.pins[name])fail('T59_BUDGET_PRIOR_CHANGED');
  const old=parsed(raw.legacyScope),a=parsed(raw.legacy1),c=parsed(raw.legacy2),d=parsed(raw.scope),claim=parsed(raw.claim),r=parsed(raw.result),g=parsed(raw.guard);
  if(!same(old,{format:1,directory:p.legacyDirectory,scopeSha256:ORIGINAL_GRANT,sourceProject:PROJECT,destinationVps:VPS,maxAttempts:3})||
   [a,c].some((v,i)=>!exact(v,['format','scopeSha256','sourceProject','destinationVps','maxAttempts','attempt','actionId','capabilitySha256','claimedUtc'])||
    v.format!==1||v.scopeSha256!==ORIGINAL_GRANT||v.sourceProject!==PROJECT||v.destinationVps!==VPS||v.maxAttempts!==3||v.attempt!==i+1||
    v.actionId!==['T37.live','T56.final_before'][i]||!digest(v.capabilitySha256)||!iso(v.claimedUtc))||c.capabilitySha256!==T56_CAP||
   d.format!==1||d.task!=='T58'||d.ownerGrantSha256!==T58_GRANT||d.initializedByManifestSha256!==T58_MANIFEST||d.sourceProject!==PROJECT||d.destinationVps!==VPS||
   d.maxTotal!==3||d.priorUsed!==2||d.diagnosticAttempts!==1||d.repurposesUnusedLegacySlot!==true||d.futureFinalsAuthorized!==false||
   !same(d.legacy,{scopeSha256:sha(raw.legacyScope),attempt1Sha256:sha(raw.legacy1),attempt2Sha256:sha(raw.legacy2)})||
   claim.task!=='T58'||claim.actionId!=='T58.auth_diagnostic'||claim.globalAttempt!==3||claim.priorUsed!==2||claim.maxTotal!==3||
   claim.manifestSha256!==T58_MANIFEST||claim.ownerGrantSha256!==T58_GRANT||claim.capabilitySha256!==T58_CAP||claim.futureFinalsAuthorized!==false||!iso(claim.claimedUtc)||
   r.task!=='T58'||r.status!=='DIAGNOSTICS_COMPLETE'||r.globalAttemptsUsed!==3||r.sourceSnapshotAttempts!==1||r.targetWrites!==0||r.targetWriteOutcome!=='UNCHANGED'||
   r.oldLedgerUnchanged!==true||r.oldT56Unchanged!==true||r.budgetUncertain!==false||r.summary?.cohortMembershipEqual!==true||
   !same(r.summary?.mismatchedColumns,['last_sign_in_at','updated_at'])||r.summary?.sourceRows!==16||r.summary?.targetRows!==16||
   r.summary?.changedMatchedRows!==2||r.summary?.otherChangedRows!==1||
   g.task!=='T58'||g.actionId!=='T58.auth_diagnostic'||g.manifestSha256!==T58_MANIFEST)fail('T59_BUDGET_PRIOR_CHANGED');
  const prior={legacyScopeSha256:sha(raw.legacyScope),legacyAttempt1Sha256:sha(raw.legacy1),legacyAttempt2Sha256:sha(raw.legacy2),...b.pins};
  const claims=[a,c,{attempt:3,actionId:claim.actionId,capabilitySha256:claim.capabilitySha256,claimedUtc:claim.claimedUtc}]
   .map((v,i)=>({attempt:i+1,status:'VALID',actionId:v.actionId,capabilitySha256:v.capabilitySha256,claimedUtc:v.claimedUtc,
    claimPath:i<2?p.legacyDirectory+`/attempt-${i+1}.json`:p.diagnosticDirectory+'/attempt-3.json',claimSha256:[prior.legacyAttempt1Sha256,prior.legacyAttempt2Sha256,prior.diagnosticAttempt3Sha256][i]}));
  return {prior,claims};
 }catch(e){if(/^T59_BUDGET_/.test(e?.code??''))throw e;fail('T59_BUDGET_PRIOR_UNSAFE');}
}
function scopeValue(b,prior){return {format:1,task:'T59',directory:b.directory,ownerGrantSha256:b.ownerGrantSha256,manifestSha256:b.manifestSha256,
 sourceProject:PROJECT,destinationVps:VPS,maxAttempts:5,priorUsed:3,prior};}
function readScope(b){parent(b);directory(b.directory,b);const prior=readPrior(b),raw=privateBytes(b.directory+'/scope.json',b);
 if(!raw.equals(encoded(scopeValue(b,prior.prior))))fail('T59_BUDGET_SCOPE_CHANGED');return prior;}
function validClaim(v,n,b){return exact(v,['format','task','actionId','attempt','priorUsed','maxAttempts','ownerGrantSha256','manifestSha256','sourceProject','destinationVps','capabilitySha256','claimedUtc'])&&
 v.format===1&&v.task==='T59'&&v.actionId===`T59.final_${n===4?'before':'after'}`&&v.attempt===n&&v.priorUsed===3&&v.maxAttempts===5&&
 v.ownerGrantSha256===b.ownerGrantSha256&&v.manifestSha256===b.manifestSha256&&v.sourceProject===PROJECT&&v.destinationVps===VPS&&digest(v.capabilitySha256)&&iso(v.claimedUtc);}

export function readBudgetStatus(input){
 const b=binding(input),prior=readScope(b),entries=fs.readdirSync(b.directory),claims=[...prior.claims];
 let uncertain=entries.some(n=>!['scope.json','attempt-4.json','attempt-5.json'].includes(n));
 for(const n of [4,5])if(entries.includes(`attempt-${n}.json`)){
  const claimPath=b.directory+`/attempt-${n}.json`;try{const raw=privateBytes(claimPath,b),v=parsed(raw);
   if(!validClaim(v,n,b)||!raw.equals(encoded(v)))throw Error();
   claims.push({attempt:n,status:'VALID',actionId:v.actionId,capabilitySha256:v.capabilitySha256,claimedUtc:v.claimedUtc,claimPath,claimSha256:sha(raw)});
  }catch{uncertain=true;claims.push({attempt:n,status:'UNCERTAIN',claimPath});}
 }
 for(let i=0;i<claims.length;i++)if(claims[i].attempt!==i+1)uncertain=true;
 if(claims.length===5&&claims[3].status==='VALID'&&claims[4].status==='VALID'&&claims[3].capabilitySha256!==claims[4].capabilitySha256)uncertain=true;
 return {used:uncertain?null:claims.length,remaining:uncertain?null:5-claims.length,maxAttempts:5,priorUsed:3,claims,uncertain};
}
export function prepareBudget(input){
 const b=binding(input);parent(b);const prior=readPrior(b);
 try{fs.mkdirSync(b.directory,{mode:0o700});sync(path.dirname(b.directory));}catch(e){if(e.code!=='EEXIST')fail('T59_BUDGET_PREPARE_FAILED');}
 directory(b.directory,b);const file=b.directory+'/scope.json';if(!exists(file)){
  if(fs.readdirSync(b.directory).length)fail('T59_BUDGET_SCOPE_MISSING');
  try{writeNew(file,encoded(scopeValue(b,prior.prior)),b);}catch(e){if(e.code!=='EEXIST')fail('T59_BUDGET_SCOPE_WRITE_FAILED');}
 }
 const status=readBudgetStatus(input);if(status.uncertain)fail('T59_BUDGET_UNCERTAIN');return status;
}
export function consumeBudget(input){
 const b=binding(input),status=readBudgetStatus(input);if(status.uncertain)fail('T59_BUDGET_UNCERTAIN');
 if(status.used>=5)fail('T59_BUDGET_EXHAUSTED');if(!digest(input.capabilitySha256))fail('T59_BUDGET_CAPABILITY_SHA');
 const n=status.used+1;if(input.actionId!==`T59.final_${n===4?'before':'after'}`||
  (n===5&&input.capabilitySha256!==status.claims[3].capabilitySha256))fail('T59_BUDGET_ACTION_SEQUENCE');
 if(status.claims.slice(0,3).some(c=>c.capabilitySha256===input.capabilitySha256))fail('T59_BUDGET_FRESH_CAPABILITY_REQUIRED');
 const claim={format:1,task:'T59',actionId:input.actionId,attempt:n,priorUsed:3,maxAttempts:5,ownerGrantSha256:b.ownerGrantSha256,
  manifestSha256:b.manifestSha256,sourceProject:PROJECT,destinationVps:VPS,capabilitySha256:input.capabilitySha256,claimedUtc:new Date().toISOString()};
 const raw=encoded(claim),claimPath=b.directory+`/attempt-${n}.json`;
 try{writeNew(claimPath,raw,b);}catch(e){throw Object.assign(new Error(e.code==='EEXIST'?'T59_BUDGET_CLAIM_CONFLICT':'T59_BUDGET_CLAIM_WRITE_FAILED'),
  {code:e.code==='EEXIST'?'T59_BUDGET_CLAIM_CONFLICT':'T59_BUDGET_CLAIM_WRITE_FAILED',claimMayBeConsumed:true});}
 return {attempt:n,remaining:5-n,claimPath,claimSha256:sha(raw)};
}
