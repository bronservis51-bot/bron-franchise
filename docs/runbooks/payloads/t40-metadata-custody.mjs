// T40 technical metadata custody only. No Auth/business rows, control SQL, key reads or freeze.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,hkdfSync,createDecipheriv} from 'node:crypto';
import {captureMetadataCustody,validateAdmissionMetadata,metadataQuerySha256} from './admission-metadata-custody.mjs';
import {createAdmissionCustodyFs} from './admission-custody-fs.mjs';
import {SOURCE_TRANSFER_SCOPE_SHA256,readBudgetStatus} from './source-transfer-budget.mjs';

const PRIVATE='/root/bron-secrets',DIRECTORY=PRIVATE+'/t40-metadata-custody',RUNTIME=PRIVATE+'/t40-runtime';
const SELF=RUNTIME+'/docs/runbooks/payloads/t40-metadata-custody.mjs',MANIFEST=DIRECTORY+'/manifest.json';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115';
const HOST=PROJECT+'.supabase.co',ORIGIN='https://'+HOST,PREFIX='bron-admission-metadata-';
export const PROTOCOL='BRON_ADMISSION_METADATA_V1';
const ACTION='T40.http_source_admission',MAX_PLAIN=1048576,MAX_WIRE=1572864,FILE_KEY='docs/runbooks/payloads/t40-metadata-custody.mjs';
const RUNTIME_FILES=['t40-metadata-custody.mjs','admission-metadata-custody.mjs','admission-custody-fs.mjs',
 'http-source-admission.mjs','t26-source-admission.mjs','source-transfer-budget.mjs'].map(p=>RUNTIME+'/docs/runbooks/payloads/'+p);
const CUSTODY={beforeImagePath:PRIVATE+'/t40-admission-before-c40a2026.json',
 metadataReceiptPath:PRIVATE+'/t40-admission-metadata-c40a2026.json',inversePath:PRIVATE+'/t40-admission-inverse-c40a2026.sql',
 controlReceiptPath:PRIVATE+'/t40-admission-control-c40a2026.json'};
const sha=b=>createHash('sha256').update(b).digest('hex'),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const safeCode=error=>/^T40_[A-Z0-9_]+$/.test(error?.code??'')?error.code:error?.code==='EEXIST'?'T40_ALREADY_STARTED':'T40_METADATA_FAILED';
const safeUpstream=error=>/^(?:SOURCE_TRANSFER_|ADMISSION_FS_)[A-Z0-9_]{1,60}$/.test(error?.code??'')?error.code:null;
const custodyPhases=new Set(['activation','read-metadata','persist-before-image','persist-metadata-receipt']);
const binding=()=>({directory:PRIVATE+'/source-transfer-budget',scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,
 sourceProject:PROJECT,destinationVps:VPS,maxAttempts:3});
export function validateManifest(raw,manifestSha256,selfSha256){
 if(!digest(manifestSha256)||sha(raw)!==manifestSha256)fail('T40_MANIFEST_SHA');let m;
 try{m=JSON.parse(raw);}catch{fail('T40_MANIFEST_JSON');}
 if(m?.task!=='T40'||m.execution_authorized!==true||m.actionId!==ACTION||!digest(selfSha256)||m.files?.[FILE_KEY]!==selfSha256)
  fail('T40_TASK_SCOPE');
 if(!object(m.runtime_files)||Object.keys(m.runtime_files).length!==RUNTIME_FILES.length||
  RUNTIME_FILES.some(p=>!digest(m.runtime_files[p])))fail('T40_RUNTIME_PINS');
 if(m.source?.origin!==ORIGIN||m.source.projectRef!==PROJECT||m.source.protocol!==PROTOCOL||
  m.source.capability_binding!=='pinned_VPS_prepare_readback'||m.source.template_name_prefix!==PREFIX||
  m.source.Auth_or_business_row_reads!==false||m.source.database_writes!==false||m.source.max_actual_POST!==1||
  m.source.metadataQuerySha256!==metadataQuerySha256||m.source.max_plaintext_bytes!==MAX_PLAIN||
  m.source.max_wire_bytes!==MAX_WIRE||m.source.ttl_seconds!==7200||m.source.wall_seconds!==40||
  !object(m.custody)||Object.keys(m.custody).length!==4||Object.entries(CUSTODY).some(([k,p])=>m.custody[k]!==p))
  fail('T40_SOURCE_SCOPE');
 const b=m.transfer_budget;
 if(b?.directory!==binding().directory||b.scope_sha256!==SOURCE_TRANSFER_SCOPE_SHA256||b.source_project!==PROJECT||
  b.destination_vps!==VPS||b.max_attempts!==3||b.required_used!==1||b.consume_or_reset_authorized!==false||!digest(m.input_evidence?.T37_result_sha256)||
  !digest(m.input_evidence?.T37_receipt_sha256)||!digest(m.input_evidence?.T37_claim_sha256))fail('T40_PRIOR_PINS');
 return m;
}
export function activationFromManifest(manifestSha256){
 if(!digest(manifestSha256))fail('T40_MANIFEST_SHA');
 return {reviewed:true,actionId:ACTION,manifestSha256,sourceProject:PROJECT,destinationVps:VPS,
  metadataReadAuthorized:true,metadataOnly:true,sourceRoute:'fixed-source-edge-https',macDataTransit:false,
  targetWritesStarted:false,...CUSTODY};
}
export function validatePriorResult(raw,pin){
 if(!digest(pin)||sha(raw)!==pin)fail('T40_T37_RESULT_SHA');let r;
 try{r=JSON.parse(raw);}catch{fail('T40_T37_RESULT_INVALID');}
 if(r?.task!=='T37'||!['STRICT_MATCH','LIVE_AUTH_TIMESTAMP_ONLY'].includes(r.status)||r.inventoryComplete!==true||
  r.sourceReadAttempted!==true||r.sourceDataRead!==true||r.sourceAuthUserRead!==true||r.macDataTransit!==false||
  r.applyAuthorized!==false||r.finalFreezeAudit!==false||!Array.isArray(r.strictMismatchGroups)||
  (r.status==='STRICT_MATCH'?r.strictMismatchGroups.length!==0:r.strictMismatchGroups.length!==1||r.strictMismatchGroups[0]!=='data:auth.users'))
  fail('T40_T37_RESULT_INVALID');return true;
}
export function validateBudget(status,claimSha256){
 if(!digest(claimSha256)||status?.used!==1||status.remaining!==2||status.maxAttempts!==3||status.uncertain!==false||
  !Array.isArray(status.claims)||status.claims.length!==1||status.claims[0]?.attempt!==1||
  status.claims[0].status!=='VALID'||status.claims[0].actionId!=='T37.live'||status.claims[0].claimSha256!==claimSha256)
  fail('T40_AUTH_BUDGET_NOT_STABLE');
 return {used:1,remaining:2,claimSha256};
}
export function createPrepared({manifestSha256,now=Date.now(),random=randomBytes,writeSecret}){
 if(!digest(manifestSha256)||!Number.isSafeInteger(now)||now<0||now>8640000000000000-7200000||
  typeof random!=='function'||typeof writeSecret!=='function')fail('T40_PREPARE_ARGUMENTS');
 const entropy=random(32);if(!Buffer.isBuffer(entropy)||entropy.length!==32)fail('T40_ENTROPY_INVALID');
 const token=Buffer.from(entropy.toString('hex'),'ascii');entropy.fill(0);
 try{writeSecret(token);const capabilitySha256=sha(token);return {task:'T40',actionId:ACTION,manifestSha256,
  origin:ORIGIN,projectRef:PROJECT,destinationVps:VPS,protocol:PROTOCOL,metadataQuerySha256,
  createdUtc:new Date(now).toISOString(),expiresUtc:new Date(now+7200000).toISOString(),
  capabilitySha256,functionName:PREFIX+capabilitySha256.slice(0,12)};}finally{token.fill(0);}
}
export function validatePrepared(token,p,manifestSha256,now=Date.now()){
 const created=Date.parse(p?.createdUtc),expires=Date.parse(p?.expiresUtc);
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||p?.task!=='T40'||p.actionId!==ACTION||
  !digest(manifestSha256)||p.manifestSha256!==manifestSha256||p.origin!==ORIGIN||p.projectRef!==PROJECT||
  p.destinationVps!==VPS||p.protocol!==PROTOCOL||p.metadataQuerySha256!==metadataQuerySha256||
  p.capabilitySha256!==sha(Buffer.from(token,'ascii'))||p.functionName!==PREFIX+p.capabilitySha256.slice(0,12)||
  !Number.isSafeInteger(now)||!Number.isSafeInteger(created)||!Number.isSafeInteger(expires)||
  new Date(created).toISOString()!==p.createdUtc||new Date(expires).toISOString()!==p.expiresUtc||
  created>now+5000||expires-created!==7200000||now+45000>=expires)fail('T40_PREPARED_INVALID');
 return p;
}
const remoteSafe=v=>v?.protocol===PROTOCOL?{
 ...(['authorization','binding','configuration','dns','tls-negative','connect','begin','identity','metadata','rollback','encryption','deadline'].includes(v.stage)?{remoteStage:v.stage}:{}),
 ...(['METADATA_READER_FAILED','METADATA_READER_DEADLINE'].includes(v.code)?{remoteCode:v.code}:{})}:{};
export function requestMetadata(token,prepared,{request=https.request,signal,timeoutMs=35000,maxBody=MAX_WIRE}={}){
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||prepared?.origin!==ORIGIN||prepared.protocol!==PROTOCOL||
  prepared.capabilitySha256!==sha(Buffer.from(token,'ascii'))||prepared.functionName!==PREFIX+prepared.capabilitySha256.slice(0,12)||
  !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>35000||!Number.isInteger(maxBody)||maxBody<1||maxBody>MAX_WIRE)
  fail('T40_REQUEST_SCOPE');
 return new Promise(resolve=>{let req,res,timer,done=false,bytes=0,statusCode=null;const chunks=[],started=performance.now();
  const finish=(code,value,safe={})=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
   req?.destroy();res?.destroy();resolve({statusCode,bytes,elapsedMs:Math.ceil(performance.now()-started),...(code?{code}:{}),...(value!==undefined?{value}:{}),...safe});};
  const abort=()=>finish('T40_ABORTED');if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>finish('T40_HTTPS_TIMEOUT'),timeoutMs);
  try{req=request({protocol:'https:',hostname:HOST,port:443,servername:HOST,rejectUnauthorized:true,agent:false,
   method:'POST',path:'/functions/v1/'+prepared.functionName,headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}},response=>{
    res=response;statusCode=Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599?res.statusCode:null;
    res.on('error',()=>finish('T40_HTTPS_FAILURE'));res.on('aborted',()=>finish('T40_HTTPS_FAILURE'));
    if(statusCode>=300&&statusCode<400){finish('T40_REDIRECT_REJECTED');return;}
    res.on('data',chunk=>{if(done)return;const b=Buffer.from(chunk);bytes+=b.length;if(bytes>(statusCode===200?maxBody:4096)){finish('T40_BODY_LIMIT');return;}chunks.push(b);});
    res.on('end',()=>{if(done)return;let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
     catch{finish(statusCode===200?'T40_JSON_INVALID':'T40_HTTP_STATUS');return;}
     if(statusCode!==200){finish('T40_HTTP_STATUS',undefined,remoteSafe(value));return;}finish(undefined,value);});
   });req.on('error',()=>finish('T40_HTTPS_FAILURE'));req.end(token,'ascii');}catch{finish('T40_HTTPS_FAILURE');}
 });
}
function base64(value,max){
 if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||value.length%4||
  !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('T40_CIPHERTEXT_INVALID');
 const b=Buffer.from(value,'base64');if(b.length>max||b.toString('base64')!==value)fail('T40_CIPHERTEXT_INVALID');return b;
}
export function decryptMetadata(envelope,token,capabilitySha256){
 if(!object(envelope)||Object.keys(envelope).sort().join(',')!=='ciphertext,nonce,protocol'||envelope.protocol!==PROTOCOL||
  typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||sha(Buffer.from(token,'ascii'))!==capabilitySha256)
  fail('T40_ENVELOPE_INVALID');
 const nonce=base64(envelope.nonce,12),cipher=base64(envelope.ciphertext,MAX_PLAIN+16);
 if(nonce.length!==12||cipher.length<17)fail('T40_CIPHERTEXT_INVALID');let key,plain;
 try{key=Buffer.from(hkdfSync('sha256',Buffer.from(token,'ascii'),Buffer.from(capabilitySha256,'utf8'),Buffer.from(PROTOCOL,'utf8'),32));
  const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(cipher.subarray(-16));plain=Buffer.concat([d.update(cipher.subarray(0,-16)),d.final()]);
  if(plain.length>MAX_PLAIN)fail('T40_PLAINTEXT_LIMIT');return JSON.parse(plain.toString('utf8'));
 }catch{fail('T40_DECRYPT_FAILED');}finally{key?.fill(0);plain?.fill(0);}
}
export function validateMetadataFrame(frame,prepared,callStarted,now=Date.now()){
 const i=frame?.identity;
 if(!object(frame)||Object.keys(frame).sort().join(',')!=='actionId,destinationVps,expires_epoch_ms,finished_epoch_ms,identity,manifestSha256,metadataQuerySha256,ok,projectRef,protocol,rollback_completed,started_epoch_ms,state,tls_negative_rejected,tls_verification'||
  frame.ok!==true||frame.protocol!==PROTOCOL||frame.projectRef!==PROJECT||frame.destinationVps!==VPS||frame.actionId!==ACTION||
  frame.manifestSha256!==prepared.manifestSha256||frame.metadataQuerySha256!==metadataQuerySha256||
  frame.expires_epoch_ms!==Date.parse(prepared.expiresUtc)||frame.tls_negative_rejected!==true||frame.tls_verification!=='native-ca-and-hostname'||
  frame.rollback_completed!==true||!Number.isSafeInteger(frame.started_epoch_ms)||!Number.isSafeInteger(frame.finished_epoch_ms)||
  frame.started_epoch_ms<callStarted-5000||frame.started_epoch_ms>now+5000||frame.finished_epoch_ms<frame.started_epoch_ms||
  frame.finished_epoch_ms>now+5000||frame.finished_epoch_ms-frame.started_epoch_ms>30000||frame.finished_epoch_ms>=frame.expires_epoch_ms||
  !object(i)||Object.keys(i).sort().join(',')!=='database,database_time,idle_timeout,isolation,owner,pid,read_only,role,session_role,statement_timeout'||
  ['database','role','session_role','owner'].some(k=>i[k]!=='postgres')||i.read_only!=='on'||i.isolation!=='repeatable read'||
  i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||!Number.isInteger(i.pid)||i.pid<1||i.pid>2147483647||
  typeof i.database_time!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(i.database_time)||
  !Number.isFinite(Date.parse(i.database_time)))fail('T40_METADATA_FRAME_INVALID');
 let state;try{state=validateAdmissionMetadata(frame.state);}catch{fail('T40_METADATA_STATE_INVALID');}
 if(state.pid!==i.pid)fail('T40_METADATA_FRAME_INVALID');return state;
}

// Production defaults are fixed. Fixture hooks are explicit and never supplied by CLI.
export async function runMetadataCapture({activation,token,prepared,claimSha256,guard,persistBeforeImage,persistReceipt,signal,onSourceAttempt=()=>{}},
 fixture){
 const {send=requestMetadata,status=readBudgetStatus,now=Date.now}=fixture??{};
 const a=structuredClone(activation),p=structuredClone(prepared);
 validatePrepared(token,p,a?.manifestSha256,now());
 if(a?.actionId!==ACTION||typeof guard!=='function'||typeof onSourceAttempt!=='function'||
  typeof persistBeforeImage!=='function'||typeof persistReceipt!=='function')fail('T40_CAPTURE_ARGUMENTS');
 let before;try{before=validateBudget(await status(binding()),claimSha256);}catch(error){
  throw Object.assign(new Error('T40_AUTH_BUDGET_NOT_STABLE'),{code:'T40_AUTH_BUDGET_NOT_STABLE',...(safeUpstream(error)?{upstreamCode:safeUpstream(error)}:{})});}
 let sourceCode=null,readAttempted=false,readComplete=false,httpsSummary,upstreamCode=null,remote={};
 const persist=fn=>async request=>{try{return await fn(request);}catch(error){upstreamCode=safeUpstream(error);throw error;}};
 try{
  const receipt=await captureMetadataCustody({activation:a,persistBeforeImage:persist(persistBeforeImage),persistReceipt:persist(persistReceipt),
   readEncryptedMetadata:async context=>{
    try{
     if(context.actionId!==ACTION||context.manifestSha256!==p.manifestSha256||context.metadataQuerySha256!==metadataQuerySha256||
      context.sourceProject!==PROJECT||context.destinationVps!==VPS)fail('T40_CUSTODY_CONTEXT_INVALID');
     if(signal?.aborted)fail('T40_ABORTED');validatePrepared(token,p,a.manifestSha256,now());
     await guard();if(signal?.aborted)fail('T40_ABORTED');
     const callStarted=now();validatePrepared(token,p,a.manifestSha256,callStarted);readAttempted=true;onSourceAttempt();
     let response;try{response=await send(token,p,{signal});}catch{fail('T40_HTTPS_FAILURE');}
     if(response?.code||response?.statusCode!==200){remote=remoteSafe({protocol:PROTOCOL,stage:response?.remoteStage,code:response?.remoteCode});fail(/^T40_[A-Z_]+$/.test(response?.code??'')?response.code:'T40_HTTP_STATUS');}
     const frame=decryptMetadata(response.value,token,p.capabilitySha256),state=validateMetadataFrame(frame,p,callStarted,now());
     if(signal?.aborted)fail('T40_ABORTED');readComplete=true;
     httpsSummary={status:200,bytes:response.bytes,elapsedMs:response.elapsedMs};return state;
    }catch(error){sourceCode=safeCode(error);throw Object.assign(new Error(sourceCode),{code:sourceCode});}
   }});
  let after;try{after=validateBudget(await status(binding()),claimSha256);}catch(error){upstreamCode=safeUpstream(error);fail('T40_AUTH_BUDGET_NOT_STABLE');}
  // Full receipt (including technical PID lists) stays on VPS; stdout gets fixed safe fields.
  const safeReceipt=Object.fromEntries(['status','actionId','manifestSha256','sourceProject','destinationVps',
   'metadataQuerySha256','capturedMicros','beforeImagePath','metadataReceiptPath','beforeImageSha256',
   'receiptSha256','counts','beforeImageDurableOnVps','sourceEffects','sourceBarrierPass','rootComparisonRequired']
   .map(k=>[k,receipt[k]]));
  return {task:'T40',status:'METADATA_PREPARED',metadataReceipt:safeReceipt,https:httpsSummary,
   authBudgetBefore:before.used,authBudgetAfter:after.used,sourceMetadataReadAttempted:readAttempted,
   sourceMetadataRead:readComplete,sourceAuthUserRead:false,sourceBusinessDataRead:false,sourceEffects:false,
   sourceBarrierPass:false,controlReady:false,macDataTransit:false};
 }catch(error){throw Object.assign(new Error(sourceCode??(/^T40_/.test(error?.code??'')?safeCode(error):'T40_CUSTODY_FAILED')),
  {code:sourceCode??(/^T40_/.test(error?.code??'')?safeCode(error):'T40_CUSTODY_FAILED'),
   sourceMetadataReadAttempted:readAttempted,sourceMetadataRead:readComplete?true:readAttempted?null:false,
   sourceAuthUserRead:false,sourceBusinessDataRead:false,sourceEffects:false,sourceBarrierPass:false,controlReady:false,retryAllowed:false,
   ...remote,...(upstreamCode?{upstreamCode}:{}),...(custodyPhases.has(error?.phase)?{custodyPhase:error.phase}:{})});}
}
function privateDirectory(p){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o700)fail('T40_PRIVATE_DIRECTORY');}
function privateRead(p,max=MAX_WIRE){
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>max)fail('T40_PRIVATE_FILE');
  const b=fs.readFileSync(fd),after=fs.fstatSync(fd);if(b.length!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs)fail('T40_PRIVATE_FILE_CHANGED');return b;
 }finally{fs.closeSync(fd);}
}
function writeNew(p,bytes){const f=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(f,bytes);fs.fsyncSync(f);}finally{fs.closeSync(f);}const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(d);}finally{fs.closeSync(d);}if(!privateRead(p).equals(Buffer.from(bytes)))fail('T40_WRITE_READBACK');}
function absent(paths){for(const p of paths)try{fs.lstatSync(p);fail('T40_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}
async function main(){let mode,phase='preflight',fsAdapter,timer,guard=false;const controller=new AbortController();
 let result={task:'T40',status:'BLOCKED',sourceMetadataReadAttempted:false,sourceMetadataRead:false,
  sourceAuthUserRead:false,sourceBusinessDataRead:false,sourceEffects:false,sourceBarrierPass:false,controlReady:false,macDataTransit:false};
 try{
  if(process.argv.length!==7||!['--prepare','--capture'].includes(process.argv[2])||process.argv[3]!=='--manifest'||
   process.argv[4]!==MANIFEST||process.argv[5]!=='--sha256'||!digest(process.argv[6]))fail('T40_EXPLICIT_REVIEW_REQUIRED');
  mode=process.argv[2];
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||
   fileURLToPath(import.meta.url)!==SELF||!Object.values(networkInterfaces()).flat().some(i=>i?.address===VPS)||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('T40_PINNED_VPS_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const d of ['/root',PRIVATE,DIRECTORY,RUNTIME,RUNTIME+'/docs',RUNTIME+'/docs/runbooks',RUNTIME+'/docs/runbooks/payloads'])privateDirectory(d);
  const m=validateManifest(privateRead(MANIFEST),process.argv[6],sha(privateRead(SELF)));
  for(const [p,h] of Object.entries(m.runtime_files))if(sha(privateRead(p))!==h)fail('T40_RUNTIME_SHA');
  validatePriorResult(privateRead(PRIVATE+'/t37-https-inventory-result.json'),m.input_evidence.T37_result_sha256);
  if(sha(privateRead(PRIVATE+'/t37-release-receipt.json'))!==m.input_evidence.T37_receipt_sha256)fail('T40_T37_RECEIPT_SHA');
  const budget=validateBudget(readBudgetStatus(binding()),m.input_evidence.T37_claim_sha256);
  if(mode==='--prepare'){
   absent(['prepare.guard','capability','prepared.json','capture.guard','capture-result.json'].map(p=>DIRECTORY+'/'+p));
   absent(Object.values(CUSTODY));
   writeNew(DIRECTORY+'/prepare.guard',JSON.stringify({task:'T40',actionId:ACTION,manifestSha256:process.argv[6],createdUtc:new Date().toISOString()})+'\n');
   phase='prepare';const prepared=createPrepared({manifestSha256:process.argv[6],writeSecret:bytes=>writeNew(DIRECTORY+'/capability',bytes)});
   const preparedBytes=Buffer.from(JSON.stringify(prepared)+'\n');writeNew(DIRECTORY+'/prepared.json',preparedBytes);
   result={...result,...prepared,status:'READY',preparedSha256:sha(preparedBytes),authBudgetUsed:budget.used,authBudgetRemaining:budget.remaining};
  }else{
   absent([DIRECTORY+'/capture.guard',DIRECTORY+'/capture-result.json',...Object.values(CUSTODY)]);
   const token=privateRead(DIRECTORY+'/capability',64).toString('utf8'),prepared=JSON.parse(privateRead(DIRECTORY+'/prepared.json'));
   validatePrepared(token,prepared,process.argv[6]);const activation=activationFromManifest(process.argv[6]);
   fsAdapter=createAdmissionCustodyFs({activation});timer=setTimeout(()=>controller.abort(),40000);phase='capture';
   result={...result,...await runMetadataCapture({activation,token,prepared,claimSha256:m.input_evidence.T37_claim_sha256,
    signal:controller.signal,persistBeforeImage:fsAdapter.persistBeforeImage,persistReceipt:fsAdapter.persistReceipt,
    guard:()=>{writeNew(DIRECTORY+'/capture.guard',JSON.stringify({task:'T40',actionId:ACTION,manifestSha256:process.argv[6],
     capabilitySha256:prepared.capabilitySha256,startedUtc:new Date().toISOString()})+'\n');guard=true;},
    onSourceAttempt:()=>{result.sourceMetadataReadAttempted=true;result.sourceMetadataRead=null;}})};
  }
 }catch(error){result={...result,status:'BLOCKED',phase,code:safeCode(error),
  ...(['sourceMetadataReadAttempted','sourceMetadataRead'].every(k=>Object.hasOwn(error??{},k))?
   {sourceMetadataReadAttempted:error.sourceMetadataReadAttempted,sourceMetadataRead:error.sourceMetadataRead}:{}),
  ...remoteSafe({protocol:PROTOCOL,stage:error?.remoteStage,code:error?.remoteCode}),
  ...(custodyPhases.has(error?.custodyPhase)?{custodyPhase:error.custodyPhase}:{}),
  ...(safeUpstream(error)||safeUpstream({code:error?.upstreamCode})?
   {upstreamCode:safeUpstream(error)??error.upstreamCode}:{})};}
 finally{clearTimeout(timer);controller.abort();try{fsAdapter?.close();}catch{result={...result,status:'BLOCKED',code:'T40_CUSTODY_CLOSE_FAILED'};}
  if(guard)try{writeNew(DIRECTORY+'/capture-result.json',JSON.stringify(result)+'\n');}catch{result={...result,status:'BLOCKED',code:'T40_RESULT_WRITE_FAILED'};}}
 console.log(result.status==='READY'?'T40_READY':'T40_METADATA_RESULT',JSON.stringify(result));
 if(!['READY','METADATA_PREPARED'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
