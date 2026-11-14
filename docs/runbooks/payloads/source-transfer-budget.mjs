// Import-only custody for the release's fixed three Source-data attempts.
// No credentials, network, mutable counter, reset or deletion operation exists here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const SOURCE_TRANSFER_SCOPE_SHA256='cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69';
const DIRECTORY='/root/bron-secrets/source-transfer-budget';
const PROJECT='vkkqffvmztpzgygzfxhq',DESTINATION='152.228.115.115',MAX=3;
const SLOT=n=>`attempt-${n}.json`,SCOPE='scope.json';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const encoded=value=>Buffer.from(JSON.stringify(value)+'\n');
const isDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exists=p=>{try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};

function binding(input){
 const uid=input?.uid??0;
 if(!Number.isInteger(uid)||uid<0||typeof input?.directory!=='string'||
  path.resolve(input.directory)!==input.directory||input.scopeSha256!==SOURCE_TRANSFER_SCOPE_SHA256||
  input.sourceProject!==PROJECT||input.destinationVps!==DESTINATION||input.maxAttempts!==MAX)
  fail('SOURCE_TRANSFER_BINDING_INVALID');
 // Non-root ownership injection is solely for local filesystem fixtures.
 if(uid===0){
  if(process.platform!=='linux'||process.getuid?.()!==0||input.directory!==DIRECTORY)
   fail('SOURCE_TRANSFER_ROOT_CUSTODY_REQUIRED');
 }else if(process.getuid?.()===0||process.getuid?.()!==uid)
  fail('SOURCE_TRANSFER_TEST_OWNER_INVALID');
 return {directory:input.directory,uid,gid:uid===0?0:process.getgid(),scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,
  sourceProject:PROJECT,destinationVps:DESTINATION,maxAttempts:MAX};
}
function directory(p,b){
 const s=fs.lstatSync(p);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==b.uid||s.gid!==b.gid||(s.mode&0o777)!==0o700||fs.realpathSync(p)!==p)
  fail('SOURCE_TRANSFER_DIRECTORY_UNSAFE');
}
function parent(b){
 if(b.uid===0)directory('/root',b);
 directory(path.dirname(b.directory),b);
}
function scopeValue(b){
 return {format:1,directory:b.directory,scopeSha256:b.scopeSha256,sourceProject:PROJECT,
  destinationVps:DESTINATION,maxAttempts:MAX};
}
function privateBytes(filename,b){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const s=fs.fstatSync(fd);
  if(!s.isFile()||s.uid!==b.uid||s.gid!==b.gid||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>16384)
   fail('SOURCE_TRANSFER_FILE_UNSAFE');
  const bytes=fs.readFileSync(fd);if(bytes.length!==s.size)fail('SOURCE_TRANSFER_FILE_CHANGED');return bytes;
 }finally{fs.closeSync(fd);}
}
function syncDirectory(p){
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function writeNew(filename,bytes,b){
 directory(b.directory,b);let fd;
 try{
  fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);
 }finally{if(fd!==undefined)fs.closeSync(fd);}
 syncDirectory(b.directory);
 if(!privateBytes(filename,b).equals(bytes))fail('SOURCE_TRANSFER_WRITE_NOT_VERIFIED');
}
function readScope(b){
 parent(b);directory(b.directory,b);
 const f=path.join(b.directory,SCOPE);
 if(!exists(f))fail('SOURCE_TRANSFER_SCOPE_NOT_PREPARED');
 try{if(!privateBytes(f,b).equals(encoded(scopeValue(b))))fail('SOURCE_TRANSFER_SCOPE_MISMATCH');}
 catch(e){if(e?.code==='SOURCE_TRANSFER_SCOPE_MISMATCH')throw e;fail('SOURCE_TRANSFER_SCOPE_UNSAFE');}
}
function claimValid(value,slot,b){
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).sort().join(',')!=='actionId,attempt,capabilitySha256,claimedUtc,destinationVps,format,maxAttempts,scopeSha256,sourceProject'||
  value.format!==1||value.attempt!==slot||value.scopeSha256!==b.scopeSha256||value.sourceProject!==PROJECT||
  value.destinationVps!==DESTINATION||value.maxAttempts!==MAX||!isDigest(value.capabilitySha256)||
  typeof value.claimedUtc!=='string'||!Number.isFinite(Date.parse(value.claimedUtc))||
  new Date(value.claimedUtc).toISOString()!==value.claimedUtc)return false;
 return slot===1?value.actionId==='T37.live':typeof value.actionId==='string'&&
  new RegExp(`^T[1-9][0-9]{1,3}\\.final_${slot===2?'before':'after'}$`).test(value.actionId);
}

export function readBudgetStatus(input){
 const b=binding(input);readScope(b);
 const entries=fs.readdirSync(b.directory),known=new Set([SCOPE,SLOT(1),SLOT(2),SLOT(3)]);
 let uncertain=entries.some(n=>!known.has(n));const claims=[];
 for(let slot=1;slot<=MAX;slot++){
  const name=SLOT(slot);if(!entries.includes(name))continue;
  const claimPath=path.join(b.directory,name);let value,bytes;
  try{
   bytes=privateBytes(claimPath,b);value=JSON.parse(bytes);
   if(!claimValid(value,slot,b)||!bytes.equals(encoded(value)))throw Error();
   claims.push({attempt:slot,status:'VALID',actionId:value.actionId,capabilitySha256:value.capabilitySha256,
    claimedUtc:value.claimedUtc,claimPath,claimSha256:sha(bytes)});
  }catch{uncertain=true;claims.push({attempt:slot,status:'UNCERTAIN',claimPath});}
 }
 // Every existing claim slot is spent, including malformed or zero-byte files.
 for(let i=0;i<claims.length;i++)if(claims[i].attempt!==i+1)uncertain=true;
 if(claims.length===3&&claims[1].status==='VALID'&&claims[2].status==='VALID'&&
  claims[2].actionId!==claims[1].actionId.replace(/\.final_before$/,'.final_after'))uncertain=true;
 const used=claims.length;return {used,remaining:MAX-used,maxAttempts:MAX,claims,uncertain};
}

export function prepareBudget(input){
 const b=binding(input);parent(b);
 try{
  fs.mkdirSync(b.directory,{mode:0o700});fs.chmodSync(b.directory,0o700);syncDirectory(path.dirname(b.directory));
 }catch(e){if(e.code!=='EEXIST')fail('SOURCE_TRANSFER_PREPARE_FAILED');}
 directory(b.directory,b);
 const scopePath=path.join(b.directory,SCOPE);
 if(!exists(scopePath)){
  if(fs.readdirSync(b.directory).length)fail('SOURCE_TRANSFER_SCOPE_MISSING_WITH_CONTENT');
  try{writeNew(scopePath,encoded(scopeValue(b)),b);}
  catch(e){if(e.code!=='EEXIST')fail('SOURCE_TRANSFER_SCOPE_WRITE_FAILED');}
 }
 const status=readBudgetStatus(b);
 if(status.uncertain)fail('SOURCE_TRANSFER_LEDGER_UNCERTAIN');
 return status;
}

export function consumeBudget(input){
 const b=binding(input),status=readBudgetStatus(b);
 if(status.uncertain)fail('SOURCE_TRANSFER_LEDGER_UNCERTAIN');
 if(status.used>=MAX)fail('SOURCE_TRANSFER_BUDGET_EXHAUSTED');
 if(!isDigest(input.capabilitySha256))fail('SOURCE_TRANSFER_CAPABILITY_SHA_REQUIRED');
 const attempt=status.used+1;
 const validAction=attempt===1?input.actionId==='T37.live':attempt===2?
  /^T[1-9][0-9]{1,3}\.final_before$/.test(input.actionId??''):
  input.actionId===status.claims[1].actionId.replace(/\.final_before$/,'.final_after');
 if(!validAction)fail('SOURCE_TRANSFER_ACTION_SEQUENCE');
 const claim={format:1,scopeSha256:b.scopeSha256,sourceProject:PROJECT,destinationVps:DESTINATION,
  maxAttempts:MAX,attempt,actionId:input.actionId,capabilitySha256:input.capabilitySha256,
  claimedUtc:new Date().toISOString()};
 const bytes=encoded(claim),claimPath=path.join(b.directory,SLOT(attempt));
 try{writeNew(claimPath,bytes,b);}
 catch(e){fail(e?.code==='EEXIST'?'SOURCE_TRANSFER_CLAIM_CONFLICT':'SOURCE_TRANSFER_CLAIM_WRITE_FAILED');}
 return {attempt,remaining:MAX-attempt,claimPath,claimSha256:sha(bytes)};
}
