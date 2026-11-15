// One proposed Auth-only read. Import is inert; pending-owner manifests cannot prepare/run.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {networkInterfaces} from 'node:os';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,hkdfSync,createDecipheriv} from 'node:crypto';
import {captureAuthDiagnostic,validateAuthDiagnosticFrame,summarizeAuthDiagnostic} from './t58-auth-diagnostic-core.mjs';

const ROOT='/root/bron-secrets',DIR=ROOT+'/t58-release',EXT=ROOT+'/source-auth-extension-e58a2026';
const LEGACY=ROOT+'/source-transfer-budget',RUNTIME=ROOT+'/t45-runtime/docs/runbooks/payloads';
const SELF=ROOT+'/t58-auth-diagnostic.mjs',MANIFEST=DIR+'/manifest.json',CORE=ROOT+'/t58-auth-diagnostic-core.mjs';
const TEMPLATE=DIR+'/source-index.ts.template',ENCRYPT=ROOT+'/t58-encrypt-diagnostic.mjs';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',PG='/opt/bron/rehearsal-audit.exfSfv9a/node_modules/pg';
const LOCK='/opt/bron/rehearsal-audit.exfSfv9a/package-lock.json',LOCK_SHA='a100d1e53b1923fa350912eac4cb82a330e7390f79949f3346295fefab0b8b69';
const PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115',HOST=PROJECT+'.supabase.co',ORIGIN='https://'+HOST;
export const PROTOCOL='BRON_AUTH_DIAGNOSTIC_V1';
const PREFIX='bron-auth-diag-',ACTION='T58.auth_diagnostic';
const OLD_SCOPE='cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69';
const PARENT_MANIFEST='4db248c8620541a840b19b8fb2ea94bbd74f2763ffd2691fd108c9df8d811593';
const PARENT_GUARD='ddd83ceb039df9616a0cc1f6dae3057ef044a616505c5769f44a849189ba04e7';
const PARENT_CAP='03629ff992411e281ea58eed42b6ca5590b70b2850475594a5c957a0e2391ad5';
const CONTEXT_SHA='564c015f97aea285659304a78437840562bf701e3ed5df55b94f04c9008c5f3b';
const BARRIER_SHA='0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6';
const LEGACY_MODULE_SHA='244b9e080978e76c941a7df4757c4ccc08163f6ca6a1a3f40a37b8153c7188d7';
const PLAN_SHA='0e34802b3308df318a210a55bc2f379c517554fa9d73775453738adb371ae661';
const WITNESS_SHA='9b35397cb46736b3ff422de04fede26b26a10b488a237fc661d908e5cdca460d';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,k)=>object(x)&&Object.keys(x).sort().join(',')===[...k].sort().join(',');
const sha=x=>createHash('sha256').update(x).digest('hex');
export const canonical=x=>JSON.stringify(x,(_,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>Buffer.from(canonical(x)+'\n'),same=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Object.assign(new Error(code),{code});};
function parse(raw){try{return JSON.parse(raw);}catch{fail('T58_JSON_INVALID');}}
export function validateManifest(raw,pin){
 if(!digest(pin)||sha(raw)!==pin)fail('T58_MANIFEST_SHA');const m=parse(raw),a=m.approval;
 if(m.task!=='T58'||m.actionId!==ACTION||m.execution_authorized!==true||a?.status!=='APPROVED'||!digest(a.document_sha256))
  fail('T58_OWNER_SCOPE_NOT_APPROVED');
 if(a.maxTotal!==3||a.priorUsed!==2||a.diagnosticSnapshots!==1||a.repurposeUnusedOriginalSlot!==true||
  a.credentialDerivedColumnDigests!==true||a.encryptedToVpsRamOnly!==true||a.rawAuthValues!==false||
  a.targetWrites!==false||a.futureFinalsAuthorized!==false||m.source?.projectRef!==PROJECT||m.source.origin!==ORIGIN||
  m.source.protocol!==PROTOCOL||m.source.template_name_prefix!==PREFIX||!object(m.files)||
  !['docs/runbooks/payloads/t58-auth-diagnostic.mjs','docs/runbooks/payloads/t58-auth-diagnostic-core.mjs',
   'docs/runbooks/payloads/t58-encrypt-diagnostic.mjs','docs/runbooks/payloads/source-auth-diagnostic/index.ts'].every(k=>digest(m.files[k])))
  fail('T58_OWNER_SCOPE_INVALID');return m;
}
export function validateOwnerProof(raw,pin,m,mSha){
 if(!digest(pin)||sha(raw)!==pin)fail('T58_OWNER_PROOF_SHA');const p=parse(raw);
 if(!exact(p,['format','task','actionId','manifestSha256','ownerGrantSha256','status','scope','maxTotal','priorUsed','sourceProject','destinationVps',
  'encryptedToVpsRamOnly','rawAuthValues','targetWrites','futureFinalsAuthorized'])||p.format!==1||p.task!=='T58'||p.actionId!==ACTION||
  p.manifestSha256!==mSha||p.ownerGrantSha256!==m.approval.document_sha256||p.status!=='APPROVED'||
  p.scope!=='AUTH_ONLY_COLUMN_DIAGNOSIS_ATTEMPT_3'||p.maxTotal!==3||p.priorUsed!==2||p.sourceProject!==PROJECT||p.destinationVps!==VPS||
  p.encryptedToVpsRamOnly!==true||p.rawAuthValues!==false||p.targetWrites!==false||p.futureFinalsAuthorized!==false)fail('T58_OWNER_PROOF_SCOPE');return p;
}
export function validateSourceGate(raw,pin,mSha,grantSha,now=Date.now()){
 if(!digest(pin)||sha(raw)!==pin)fail('T58_SOURCE_GATE_SHA');const g=parse(raw);
 if(!exact(g,['format','task','actionId','manifestSha256','ownerGrantSha256','sourceProject','destinationVps','sourceFenceVerified',
  'sourceCheckedMicros','sourceBarrierReceiptSha256','fenceContextSha256','globalAttempt'])||g.format!==1||g.task!=='T58'||g.actionId!==ACTION||
  g.manifestSha256!==mSha||g.ownerGrantSha256!==grantSha||g.sourceProject!==PROJECT||g.destinationVps!==VPS||g.sourceFenceVerified!==true||
  g.sourceBarrierReceiptSha256!==BARRIER_SHA||g.fenceContextSha256!==CONTEXT_SHA||g.globalAttempt!==3||
  typeof g.sourceCheckedMicros!=='string'||!/^\d{12,20}$/.test(g.sourceCheckedMicros)||!Number.isSafeInteger(now)||
  BigInt(g.sourceCheckedMicros)>BigInt(now+5000)*1000n||BigInt(g.sourceCheckedMicros)<BigInt(now-600000)*1000n)fail('T58_SOURCE_GATE_NOT_CURRENT');return g;
}
export function validatePrepared(raw,pin,mSha,grantSha,now=Date.now()){
 if(!digest(pin)||sha(raw)!==pin)fail('T58_PREPARED_SHA');const p=parse(raw),created=Date.parse(p.createdUtc),expires=Date.parse(p.expiresUtc);
 if(!exact(p,['task','actionId','manifestSha256','ownerGrantSha256','origin','projectRef','destinationVps','protocol','createdUtc','expiresUtc',
  'capabilitySha256','functionName','fenceContextSha256'])||p.task!=='T58'||p.actionId!==ACTION||p.manifestSha256!==mSha||p.ownerGrantSha256!==grantSha||
  p.origin!==ORIGIN||p.projectRef!==PROJECT||p.destinationVps!==VPS||p.protocol!==PROTOCOL||!digest(p.capabilitySha256)||
  p.functionName!==PREFIX+p.capabilitySha256.slice(0,12)||p.fenceContextSha256!==CONTEXT_SHA||!Number.isSafeInteger(created)||
  !Number.isSafeInteger(expires)||new Date(created).toISOString()!==p.createdUtc||new Date(expires).toISOString()!==p.expiresUtc||
  expires-created!==7200000||created>now+5000||now+140000>=expires)fail('T58_PREPARED_INVALID');return p;
}
export function sourceFiles(template,p,context,staticFiles){
 if(sha(JSON.stringify(context))!==CONTEXT_SHA)fail('T58_CONTEXT_SHA');let index=template.toString('utf8');
 const values={'{{CAPABILITY_SHA256}}':p.capabilitySha256,'{{EXPIRES_EPOCH_MS}}':String(Date.parse(p.expiresUtc)),
  '{{FENCE_CONTEXT_JSON}}':JSON.stringify(context),'{{FENCE_CONTEXT_SHA256}}':CONTEXT_SHA};
 for(const [from,to]of Object.entries(values)){if(index.split(from).length!==2)fail('T58_TEMPLATE_PLACEHOLDER');index=index.replace(from,to);}
 if(/\{\{[A-Z_]+\}\}/.test(index))fail('T58_TEMPLATE_PLACEHOLDER');
 return {'index.ts':sha(index),...staticFiles};
}
export function decryptDiagnostic(v,token,capSha){
 if(!exact(v,['protocol','nonce','ciphertext'])||v.protocol!==PROTOCOL||!/^[a-f0-9]{64}$/.test(token??'')||sha(token)!==capSha)fail('T58_ENVELOPE_SCOPE');
 const b64=(s,max)=>{if(typeof s!=='string'||s.length>Math.ceil(max/3)*4||s.length%4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail('T58_CIPHERTEXT_INVALID');
  const b=Buffer.from(s,'base64');if(b.length>max||b.toString('base64')!==s)fail('T58_CIPHERTEXT_INVALID');return b;};
 const nonce=b64(v.nonce,12),cipher=b64(v.ciphertext,65552);if(nonce.length!==12||cipher.length<17)fail('T58_CIPHERTEXT_INVALID');let key,plain;
 try{key=Buffer.from(hkdfSync('sha256',Buffer.from(token,'ascii'),Buffer.from(capSha,'utf8'),Buffer.from(PROTOCOL,'utf8'),32));
  const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(cipher.subarray(-16));plain=Buffer.concat([d.update(cipher.subarray(0,-16)),d.final()]);
  if(plain.length>65536)fail('T58_PLAINTEXT_BOUND');return parse(plain);
 }catch{fail('T58_DECRYPT_FAILED');}finally{key?.fill(0);plain?.fill(0);}
}
export function validateSourceFrame(v,p,context,validateWitness,started,now=Date.now()){
 if(!exact(v,['ok','protocol','projectRef','started_epoch_ms','finished_epoch_ms','expires_epoch_ms','tls_negative_rejected','tls_verification','identity','fenceWitness','data'])||
  v.ok!==true||v.protocol!==PROTOCOL||v.projectRef!==PROJECT||v.expires_epoch_ms!==Date.parse(p.expiresUtc)||
  v.tls_negative_rejected!==true||v.tls_verification!=='native-ca-and-hostname'||!Number.isSafeInteger(v.started_epoch_ms)||
  !Number.isSafeInteger(v.finished_epoch_ms)||v.started_epoch_ms<started-5000||v.started_epoch_ms>now+5000||
  v.finished_epoch_ms<v.started_epoch_ms||v.finished_epoch_ms>now+5000||v.finished_epoch_ms-v.started_epoch_ms>90000||
  v.finished_epoch_ms>=Date.parse(p.expiresUtc))fail('T58_SOURCE_FRAME_INVALID');
 const i=v.identity;if(!object(i)||['database','role','session_role','owner'].some(k=>i[k]!=='postgres')||i.read_only!=='on'||
  i.isolation!=='repeatable read'||i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||i.pid!==v.fenceWitness?.pid||v.fenceWitness?.preDataValidated!==true||
  v.fenceWitness.sourceBarrierReceiptSha256!==BARRIER_SHA)fail('T58_SOURCE_IDENTITY');
 try{validateWitness(context,v.fenceWitness);validateAuthDiagnosticFrame(v.data);}catch{fail('T58_SOURCE_DIAGNOSTIC_INVALID');}return v.data;
}
export function requestDiagnostic(token,p,{request=https.request,signal,timeoutMs=100000}={}){
 if(!/^[a-f0-9]{64}$/.test(token??'')||sha(token)!==p?.capabilitySha256||p.functionName!==PREFIX+p.capabilitySha256.slice(0,12)||
  p.origin!==ORIGIN||p.protocol!==PROTOCOL||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>100000)fail('T58_REQUEST_SCOPE');
 return new Promise(resolve=>{let req,res,timer,done=false,size=0;const chunks=[];
  const finish=(code,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);req?.destroy();res?.destroy();resolve({...(code?{code}:{}),...(value?{value}:{}),statusCode:res?.statusCode??null,bytes:size});};
  const abort=()=>finish('T58_REQUEST_ABORTED');if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>finish('T58_HTTPS_TIMEOUT'),timeoutMs);
  try{req=request({protocol:'https:',hostname:HOST,port:443,servername:HOST,rejectUnauthorized:true,agent:false,method:'POST',path:'/functions/v1/'+p.functionName,
   headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}},response=>{res=response;
    res.on('error',()=>finish('T58_HTTPS_FAILURE'));res.on('aborted',()=>finish('T58_HTTPS_FAILURE'));
    if(res.statusCode!==200){finish(res.statusCode>=300&&res.statusCode<400?'T58_REDIRECT_REJECTED':'T58_HTTP_STATUS');return;}
    res.on('data',part=>{if(done)return;const b=Buffer.from(part);size+=b.length;if(size>131072){finish('T58_BODY_LIMIT');return;}chunks.push(b);});
    res.on('end',()=>{if(done)return;let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish('T58_JSON_INVALID');return;}finish(undefined,value);});
   });req.on('error',()=>finish('T58_HTTPS_FAILURE'));req.end(token,'ascii');}catch{finish('T58_HTTPS_FAILURE');}
 });
}
function directory(p){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T58_DIRECTORY');}
function read(p,max=1048576,lock=false){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{
 const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||s.size<1||s.size>max||(lock?(s.mode&0o022)!==0:(s.mode&0o7777)!==0o600))fail('T58_PRIVATE_FILE');
 const b=fs.readFileSync(fd),a=fs.fstatSync(fd),n=fs.lstatSync(p);if(b.length!==s.size||s.size!==a.size||s.mtimeMs!==a.mtimeMs||s.ctimeMs!==a.ctimeMs||s.ino!==n.ino||s.dev!==n.dev)fail('T58_FILE_CHANGED');return b;
 }finally{fs.closeSync(fd);}}
function absent(names){for(const p of names)try{fs.lstatSync(p);fail('T58_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}
function write(p,value,onCreate){directory(path.dirname(p));const raw=Buffer.isBuffer(value)?value:bytes(value);
 const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{onCreate?.();fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
 if(!read(p).equals(raw))fail('T58_WRITE_READBACK');return sha(raw);}
const safe=e=>/^T58_[A-Z0-9_]+$/.test(e?.code??'')?e.code:/^[A-Z0-9]{5}$/.test(e?.code??'')?e.code:'T58_FAILED';
function argumentsFor(argv){const mode=argv[0],opts={};if(!['--prepare','--run'].includes(mode)||(argv.length-1)%2)fail('T58_EXPLICIT_INPUT');
 for(let i=1;i<argv.length;i+=2){if(Object.hasOwn(opts,argv[i]))fail('T58_EXPLICIT_INPUT');opts[argv[i]]=argv[i+1];}
 const names=['--manifest','--sha256','--owner-approval-sha256'];if(mode==='--run')names.push('--prepared-sha256','--deployment-proof-sha256','--source-read-gate-sha256');
 if(!exact(opts,names)||opts['--manifest']!==MANIFEST||names.filter(n=>n!=='--manifest').some(n=>!digest(opts[n])))fail('T58_EXPLICIT_INPUT');return {mode,opts};}
async function main(){let phase='preflight',target,claimed=false,runGuarded=false,preparedGuarded=false,timer;const abort=new AbortController();
 let result={task:'T58',actionId:ACTION,status:'BLOCKED',targetWrites:0,targetWriteOutcome:'UNCHANGED',sourceSnapshotAttempts:0,globalAttemptsUsed:null,budgetVerified:false,budgetUncertain:true,
  sourceMustRemainClosed:true,maintenanceRequired:true,macDataTransit:false,applyAuthorized:false,finalFreezeAudit:false,retryAuthorized:false};
 try{
  const {mode,opts}=argumentsFor(process.argv.slice(2)),mSha=opts['--sha256'];
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||
   fileURLToPath(import.meta.url)!==SELF||process.env.NODE_TEST_CONTEXT||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||
   !Object.values(networkInterfaces()).flat().some(i=>i?.address===VPS))fail('T58_PINNED_VPS_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});for(const p of ['/root',ROOT,DIR])directory(p);
  const m=validateManifest(read(MANIFEST),mSha);validateOwnerProof(read(DIR+'/owner-approval.json'),opts['--owner-approval-sha256'],m,mSha);
  const required={[SELF]:m.files['docs/runbooks/payloads/t58-auth-diagnostic.mjs'],[CORE]:m.files['docs/runbooks/payloads/t58-auth-diagnostic-core.mjs'],
   [ENCRYPT]:m.files['docs/runbooks/payloads/t58-encrypt-diagnostic.mjs'],[TEMPLATE]:m.files['docs/runbooks/payloads/source-auth-diagnostic/index.ts'],
   [RUNTIME+'/source-transfer-budget.mjs']:LEGACY_MODULE_SHA,[RUNTIME+'/t30-auth-compact.mjs']:PLAN_SHA,
   [RUNTIME+'/source-final-https-reader/fence-witness.mjs']:WITNESS_SHA};
  for(const [p,h]of Object.entries(required))if(!digest(h)||sha(read(p))!==h)fail('T58_RUNTIME_SHA');
  if(sha(read(LOCK,4194304,true))!==LOCK_SHA||parse(fs.readFileSync(PG+'/package.json')).version!=='8.23.1')fail('T58_DRIVER_PIN');
  const {readBudgetStatus}=await import('file://'+RUNTIME+'/source-transfer-budget.mjs');
  const legacyBinding={directory:LEGACY,scopeSha256:OLD_SCOPE,sourceProject:PROJECT,destinationVps:VPS,maxAttempts:3};
  const readLegacy=()=>{let s;try{s=readBudgetStatus(legacyBinding);}catch{fail('T58_LEGACY_BUDGET');}if(s.used!==2||s.remaining!==1||s.uncertain!==false||s.claims[0]?.actionId!=='T37.live'||
   s.claims[1]?.actionId!=='T56.final_before'||s.claims[1]?.capabilitySha256!==PARENT_CAP)fail('T58_LEGACY_BUDGET');
   absent([LEGACY+'/attempt-3.json']);return {scopeSha256:sha(read(LEGACY+'/scope.json')),attempt1Sha256:sha(read(LEGACY+'/attempt-1.json')),attempt2Sha256:sha(read(LEGACY+'/attempt-2.json'))};};
  const old=readLegacy();result={...result,globalAttemptsUsed:2,budgetVerified:true,budgetUncertain:false};
  const parentRaw=read(ROOT+'/t56-release/final-result.json'),parent=parse(parentRaw);
  if(sha(read(ROOT+'/t56-release/final-run.guard'))!==PARENT_GUARD||sha(read(ROOT+'/t56-release/manifest.json'))!==PARENT_MANIFEST||
   parent.task!=='T56'||parent.status!=='BLOCKED'||parent.phase!=='target-frame-before'||parent.code!=='FINAL_HTTPS_NON_TIMESTAMP_OR_DIRECTION_DIFF'||
   parent.targetWriteOutcome!=='UNCHANGED'||parent.recovery?.targetWriteOutcome!=='UNCHANGED'||parent.recovery?.sourceFrameAttempts!==1||parent.recovery?.beforeImage!==null)
   fail('T58_PARENT_NOT_ZERO_WRITE');
  const context=parse(read(ROOT+'/t45-release/fence-input.json')).fenceContext;if(sha(JSON.stringify(context))!==CONTEXT_SHA)fail('T58_CONTEXT_SHA');
  const scope={format:1,task:'T58',ownerGrantSha256:m.approval.document_sha256,initializedByManifestSha256:mSha,sourceProject:PROJECT,destinationVps:VPS,
   maxTotal:3,priorUsed:2,diagnosticAttempts:1,repurposesUnusedLegacySlot:true,futureFinalsAuthorized:false,legacy:old,parentResultSha256:sha(parentRaw),parentGuardSha256:PARENT_GUARD};
  const records=parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],{encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
  if(records.length!==1||records[0].Id!==m.target?.container_id||records[0].Image!==m.target?.image_id||records[0].Name!=='/supabase-db'||
   records[0].State?.Running!==true||records[0].State?.Health?.Status!=='healthy')fail('T58_TARGET_CONTAINER');
  if(mode==='--prepare'){
   absent([EXT,DIR+'/prepare.guard',DIR+'/prepare-result.json',DIR+'/capability',DIR+'/prepared.json',DIR+'/run.guard',DIR+'/result.json']);
   fs.mkdirSync(EXT,{mode:0o700});directory(EXT);const rootFd=fs.openSync(ROOT,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
   try{fs.fsyncSync(rootFd);}finally{fs.closeSync(rootFd);}write(EXT+'/scope.json',scope);
   write(DIR+'/prepare.guard',{task:'T58',manifestSha256:mSha,startedUtc:new Date().toISOString()},()=>{preparedGuarded=true;});
   const entropy=randomBytes(32),secret=Buffer.from(entropy.toString('hex'),'ascii');entropy.fill(0);let p;
   try{write(DIR+'/capability',secret);const now=Date.now(),capabilitySha256=sha(secret);p={task:'T58',actionId:ACTION,manifestSha256:mSha,
    ownerGrantSha256:m.approval.document_sha256,origin:ORIGIN,projectRef:PROJECT,destinationVps:VPS,protocol:PROTOCOL,
    createdUtc:new Date(now).toISOString(),expiresUtc:new Date(now+7200000).toISOString(),capabilitySha256,functionName:PREFIX+capabilitySha256.slice(0,12),fenceContextSha256:CONTEXT_SHA};
   }finally{secret.fill(0);}
   const preparedSha256=write(DIR+'/prepared.json',p),expectedExecutableFileHashes=sourceFiles(read(TEMPLATE),p,context,{
    't58-auth-diagnostic-core.mjs':required[CORE],'t58-encrypt-diagnostic.mjs':required[ENCRYPT],'fence-witness.mjs':WITNESS_SHA});
   result={...result,...p,status:'PREPARED',preparedSha256,expectedExecutableFileHashes,extensionScopeSha256:sha(read(EXT+'/scope.json')),sourcePrivateRowReads:0};
  }else{
   directory(EXT);if(!read(EXT+'/scope.json').equals(bytes(scope)))fail('T58_EXTENSION_SCOPE_CHANGED');absent([EXT+'/attempt-3.json',DIR+'/run.guard',DIR+'/result.json']);
   const p=validatePrepared(read(DIR+'/prepared.json'),opts['--prepared-sha256'],mSha,m.approval.document_sha256),cap=read(DIR+'/capability',64).toString('ascii');
   if(!/^[a-f0-9]{64}$/.test(cap)||sha(cap)!==p.capabilitySha256)fail('T58_CAPABILITY_SHA');
   const expected=sourceFiles(read(TEMPLATE),p,context,{'t58-auth-diagnostic-core.mjs':required[CORE],'t58-encrypt-diagnostic.mjs':required[ENCRYPT],'fence-witness.mjs':WITNESS_SHA});
   const proofRaw=read(DIR+'/deployment-proof.json'),proof=parse(proofRaw);if(sha(proofRaw)!==opts['--deployment-proof-sha256']||proof.task!=='T58'||proof.manifestSha256!==mSha||
    proof.preparedSha256!==opts['--prepared-sha256']||proof.sourceProject!==PROJECT||proof.functionName!==p.functionName||proof.capabilitySha256!==p.capabilitySha256||
    proof.expiresUtc!==p.expiresUtc||proof.status!=='ACTIVE'||!Number.isSafeInteger(proof.version)||proof.version<1||proof.verifyJwt!==false||proof.exactRuntimeReadback!==true||
    !same(proof.executableFileHashes,expected)||!same(proof.preflightGet,{status:403,purpose:PROTOCOL,tlsVerified:true}))fail('T58_DEPLOYMENT_PROOF');
   const gateRaw=read(DIR+'/source-read-gate.json');validateSourceGate(gateRaw,opts['--source-read-gate-sha256'],mSha,m.approval.document_sha256);
   write(DIR+'/run.guard',{task:'T58',actionId:ACTION,manifestSha256:mSha,preparedSha256:opts['--prepared-sha256'],startedUtc:new Date().toISOString()},()=>{runGuarded=true;});
   timer=setTimeout(()=>{abort.abort();target?.connection?.stream?.destroy();},140000);
   const values={};for(const entry of records[0].Config?.Env??[]){const at=entry.indexOf('='),name=entry.slice(0,at);if(!['POSTGRES_PASSWORD','PGPASSWORD','POSTGRES_USER','POSTGRES_DB'].includes(name))continue;
    if(Object.hasOwn(values,name))fail('T58_TARGET_CONFIG');values[name]=entry.slice(at+1);}
   if(!values.POSTGRES_PASSWORD||values.POSTGRES_PASSWORD!==values.PGPASSWORD||values.POSTGRES_USER!=='supabase_admin'||values.POSTGRES_DB!=='postgres')fail('T58_TARGET_CONFIG');
   const addresses=Object.values(records[0].NetworkSettings?.Networks??{}).map(n=>n.IPAddress).filter(Boolean),{default:pg}=await import('file://'+PG+'/lib/index.js');
   target=new pg.Client({host:'127.0.0.1',port:15433,database:'postgres',user:'supabase_admin',password:values.POSTGRES_PASSWORD,ssl:false,
    connectionTimeoutMillis:6000,query_timeout:6000,options:'-c default_transaction_read_only=on',application_name:'bron-t58-auth-diagnostic'});target.on('error',()=>{});
   phase='target-readonly';await target.connect();await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await target.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='10s';SET LOCAL timezone='UTC';SET LOCAL search_path=pg_catalog");
   const id=(await target.query("SELECT current_database() AS db,current_user AS role,session_user AS session_role,current_setting('transaction_read_only') AS ro,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net")).rows[0];
   if(!id||id.db!=='postgres'||id.role!=='supabase_admin'||id.session_role!=='supabase_admin'||id.ro!=='on'||id.port!==5432||!addresses.includes(id.address)||id.cron!=='off'||id.net!=='0')fail('T58_TARGET_IDENTITY');
   const targetData=await captureAuthDiagnostic(target);await target.query('ROLLBACK');await target.end();target=null;
   if(!same(readLegacy(),old)||!read(EXT+'/scope.json').equals(bytes(scope)))fail('T58_LEGACY_CHANGED');
   validatePrepared(read(DIR+'/prepared.json'),opts['--prepared-sha256'],mSha,m.approval.document_sha256);
   validateSourceGate(gateRaw,opts['--source-read-gate-sha256'],mSha,m.approval.document_sha256);
   phase='source-claim';write(EXT+'/attempt-3.json',{format:1,task:'T58',actionId:ACTION,manifestSha256:mSha,ownerGrantSha256:m.approval.document_sha256,
    globalAttempt:3,priorUsed:2,maxTotal:3,capabilitySha256:p.capabilitySha256,claimedUtc:new Date().toISOString(),futureFinalsAuthorized:false},()=>{claimed=true;});
   result={...result,globalAttemptsUsed:3,sourceSnapshotAttempts:1};phase='source-https';const started=Date.now();
   const response=await requestDiagnostic(cap,p,{signal:abort.signal});if(response.code||response.statusCode!==200)fail(response.code??'T58_HTTP_STATUS');
   const {validateFenceWitness}=await import('file://'+RUNTIME+'/source-final-https-reader/fence-witness.mjs');
   const sourceData=validateSourceFrame(decryptDiagnostic(response.value,cap,p.capabilitySha256),p,context,validateFenceWitness,started);
   phase='safe-summary';const {authRowsPlan}=await import('file://'+RUNTIME+'/t30-auth-compact.mjs');
   const summary=summarizeAuthDiagnostic(sourceData,targetData,{planAuthRows:authRowsPlan});
   result={...result,summary,diagnosticComplete:true,sourcePrivateRowRead:true,targetPrivateRowRead:true};
   if(!same(readLegacy(),old)||sha(read(ROOT+'/t56-release/final-result.json'))!==scope.parentResultSha256||sha(read(ROOT+'/t56-release/final-run.guard'))!==PARENT_GUARD)
    fail('T58_PRIOR_STATE_CHANGED');
   result={...result,status:'DIAGNOSTICS_COMPLETE',summary,sourcePrivateRowRead:true,targetPrivateRowRead:true,oldLedgerUnchanged:true,oldT56Unchanged:true,
    extensionClaimSha256:sha(read(EXT+'/attempt-3.json')),globalAttemptsRemaining:0,https:{status:200,bytes:response.bytes}};
  }
 }catch(e){const uncertain=['T58_LEGACY_BUDGET','T58_LEGACY_CHANGED','T58_PRIOR_STATE_CHANGED','T58_EXTENSION_SCOPE_CHANGED'].includes(e?.code);
  result={...result,status:'BLOCKED',phase,code:safe(e),globalAttemptsUsed:uncertain?null:claimed?3:result.globalAttemptsUsed,
   budgetUncertain:uncertain||result.budgetUncertain,sourceClaimConsumed:claimed,sourceSnapshotAttempts:claimed?1:0};}
 finally{clearTimeout(timer);abort.abort();target?.connection?.stream?.destroy();try{await target?.end();}catch{}
  if(runGuarded)try{write(DIR+'/result.json',result);}catch{result={...result,status:'BLOCKED',code:'T58_RESULT_WRITE_FAILED'};}
  else if(preparedGuarded)try{write(DIR+'/prepare-result.json',result);}catch{result={...result,status:'BLOCKED',code:'T58_PREPARE_RESULT_WRITE_FAILED'};}}
 console.log('T58_RESULT',JSON.stringify(result));if(!['PREPARED','DIAGNOSTICS_COMPLETE'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
