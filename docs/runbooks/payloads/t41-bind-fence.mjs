// T41 witness/binding phase. Fixed technical Source witness only; no Auth snapshot,
// source SQL, target writes, key/backup reads, budget reset or automatic reopening.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,createDecipheriv,hkdfSync} from 'node:crypto';
import {activationFromManifest as controlActivation,validateManifest as validateControlManifest,loadOwnerManifest} from './t41-control-ready.mjs';
import {OWNER_PROOF_METHOD} from './owner-proof-binding.mjs';
import {createAdmissionCustodyFs} from './admission-custody-fs.mjs';
import {validateAdmissionMetadata,matchIndependentControlHashes} from './admission-metadata-custody.mjs';
import {SOURCE_TRANSFER_SCOPE_SHA256,readBudgetStatus} from './source-transfer-budget.mjs';
import {validateFenceContext,validateFenceWitness} from './source-fence-witness/fence-witness.mjs';

const ROOT='/root/bron-secrets',DIR=ROOT+'/t41-release',RUNTIME=ROOT+'/t41-runtime';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',SELF=RUNTIME+'/docs/runbooks/payloads/t41-bind-fence.mjs',MANIFEST=DIR+'/manifest.json';
const PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115',ORIGIN='https://'+PROJECT+'.supabase.co',HOST=PROJECT+'.supabase.co';
const PARENT='T41.release_window',ACTION='T41.final_https_window',ADOPTED='T40.http_source_admission';
const DATA='BRON_PRIVATE_SNAPSHOT_V1';export const PROTOCOL='BRON_SOURCE_FENCE_WITNESS_V1';
const MAX_PLAIN=65536,MAX_WIRE=131072,FILE_KEY='docs/runbooks/payloads/t41-bind-fence.mjs';
const SOURCE_INPUT=DIR+'/source-fence-approved.json',CONTEXT=DIR+'/source-witness-context.json',BARRIER=DIR+'/source-barrier.json';
const BASE=DIR+'/final-base-prepared.json',FINAL=DIR+'/final-prepared.json',INPUT=DIR+'/fence-input.json',CAP=DIR+'/final-capability';
const SUMMARY=DIR+'/control-ready-result.json',CONTROL=ROOT+'/t40-admission-control-c40a2026.json',BEFORE=ROOT+'/t40-admission-before-c40a2026.json';
const RUNTIME_NAMES=['t41-bind-fence.mjs','t41-control-ready.mjs','admission-custody-fs.mjs','admission-metadata-custody.mjs',
 'http-source-admission.mjs','t26-source-admission.mjs','source-transfer-budget.mjs','source-fence-witness/fence-witness.mjs','owner-proof-binding.mjs'];
const sha=x=>createHash('sha256').update(x).digest('hex'),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const canonical=x=>JSON.stringify(x,(_,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const normalized=x=>JSON.parse(canonical(x)),bytes=x=>Buffer.from(canonical(x)+'\n');
const same=(a,b)=>canonical(a)===canonical(b);
const pid=x=>Number.isInteger(x)&&x>0&&x<=2147483647;
const micros=x=>typeof x==='string'&&/^\d{12,20}$/.test(x);
const binding=()=>({directory:ROOT+'/source-transfer-budget',scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,sourceProject:PROJECT,destinationVps:VPS,maxAttempts:3});
const failCode=e=>/^(?:T41_(?:BIND_|OWNER_|ESCROW_)|ADMISSION_FS_|ADMISSION_CUSTODY_|SOURCE_TRANSFER_|OWNER_PROOF_)[A-Z0-9_]+$/.test(e?.code??'')?e.code:'T41_BIND_FAILED';

export function validateManifest(raw,pin,selfSha){
 if(!digest(pin)||sha(raw)!==pin)fail('T41_BIND_MANIFEST_SHA');let m;try{m=JSON.parse(raw);}catch{fail('T41_BIND_MANIFEST_JSON');}
 if(m?.task!=='T41'||m.actionId!==PARENT||m.execution_authorized!==true||!digest(selfSha)||m.files?.[FILE_KEY]!==selfSha)
  fail('T41_BIND_TASK_SCOPE');
 validateControlManifest(raw,pin,m.files?.['docs/runbooks/payloads/t41-control-ready.mjs']);
 for(const [key,posts]of [['prepare_witness',0],['verify_witness',1]]){
  const p=m.phase_authorizations?.[key];
  if(p?.actionId!=='T41.'+key||p.metadata_only!==true||p.source_sql_authorized!==false||p.max_source_POST!==posts)
   fail('T41_BIND_PHASE_SCOPE');
 }
 if(RUNTIME_NAMES.some(n=>!digest(m.runtime_files?.[RUNTIME+'/docs/runbooks/payloads/'+n])))fail('T41_BIND_RUNTIME_PINS');
 return m;
}
const BASE_KEYS=['task','actionId','manifestSha256','ownerGrantSha256','origin','projectRef','destinationVps','protocol',
 'createdUtc','expiresUtc','capabilitySha256','functionName','controlSummarySha256','controlReceiptSha256','independentKeyProofSha256'];
export function validateBase(p,manifestSha,now=Date.now()){
 const created=Date.parse(p?.createdUtc),expires=Date.parse(p?.expiresUtc);
 if(!exact(p,BASE_KEYS)||p.task!=='T41'||p.actionId!==ACTION||p.manifestSha256!==manifestSha||!digest(manifestSha)||
  p.ownerGrantSha256!==SOURCE_TRANSFER_SCOPE_SHA256||p.origin!==ORIGIN||p.projectRef!==PROJECT||p.destinationVps!==VPS||p.protocol!==DATA||
  !digest(p.capabilitySha256)||p.functionName!=='bron-source-reader-'+p.capabilitySha256.slice(0,12)||
  !digest(p.controlSummarySha256)||!digest(p.controlReceiptSha256)||!digest(p.independentKeyProofSha256)||
  !Number.isSafeInteger(now)||!Number.isSafeInteger(created)||!Number.isSafeInteger(expires)||created>now+5000||
  new Date(created).toISOString()!==p.createdUtc||new Date(expires).toISOString()!==p.expiresUtc||
  expires-created!==7200000||now+45000>=expires)fail('T41_BIND_BASE_INVALID');
 return p;
}
export function validateRootInput(a,{manifestSha,baseSha,base,control,now=Date.now()}){
 const keys=['format','task','actionId','manifestSha256','basePreparedSha256','controlSummarySha256','controlReceiptSha256',
  'verifyFencedSqlSha256','status','normalConnectDenied','existingClientsDrained','providerBoundaryReviewed','sourcePaused','targetWritesStarted','boundary','observedUtc'];
 const observed=Date.parse(a?.observedUtc),b=a?.boundary;
 if(!exact(a,keys)||a.format!==1||a.task!=='T41'||a.actionId!=='T41.source_fence_approved'||a.manifestSha256!==manifestSha||
  !digest(baseSha)||a.basePreparedSha256!==baseSha||a.controlSummarySha256!==base.controlSummarySha256||
  a.controlReceiptSha256!==base.controlReceiptSha256||a.verifyFencedSqlSha256!==control?.sqlHashes?.verifyFencedSql||
  a.status!=='SOURCE_FENCED_BY_COORDINATOR'||a.normalConnectDenied!==true||a.existingClientsDrained!==true||
  a.providerBoundaryReviewed!==true||a.sourcePaused!==false||a.targetWritesStarted!==false||
  !exact(b,['capturedMicros','ownerPids'])||!micros(b.capturedMicros)||!Array.isArray(b.ownerPids)||b.ownerPids.length>1000||
  !b.ownerPids.every(pid)||new Set(b.ownerPids).size!==b.ownerPids.length||typeof a.observedUtc!=='string'||
  !/(?:Z|\+00:00)$/.test(a.observedUtc)||!Number.isFinite(observed)||observed>now+5000||observed<now-600000)
  fail('T41_BIND_ROOT_APPROVAL_INVALID');
 return a;
}
export function validateLedger(status,base){
 if(status?.uncertain!==false||status.used!==1||status.remaining!==2||status.maxAttempts!==3||
  !Array.isArray(status.claims)||status.claims.length!==1||status.claims[0]?.attempt!==1||status.claims[0].status!=='VALID'||
  status.claims[0].actionId!=='T37.live'||!digest(status.claims[0].capabilitySha256)||
  status.claims[0].capabilitySha256===base.capabilitySha256)fail('T41_BIND_AUTH_BUDGET_NOT_READY');
 return {used:1,remaining:2};
}
export async function buildWitnessContext({manifestSha,basePrepared,basePreparedSha,rootApproved,control,beforeState,now=Date.now()}){
 validateBase(basePrepared,manifestSha,now);validateRootInput(rootApproved,{manifestSha,baseSha:basePreparedSha,base:basePrepared,control,now});
 const state=validateAdmissionMetadata(beforeState);
 if(state.backends.length>1000)fail('T41_BIND_BEFORE_PID_BOUND');
 const context=normalized({sourceBarrierActionId:ADOPTED,sourceBarrierReceiptSha256:basePrepared.controlReceiptSha256,
  before:{backends:state.backends.map(b=>({pid:b.pid}))},boundary:structuredClone(rootApproved.boundary)});
 const contextSha256=sha(JSON.stringify(context));await validateFenceContext(context,contextSha256);
 return {format:1,task:'T41',actionId:'T41.prepare_witness',manifestSha256:manifestSha,basePreparedSha256:basePreparedSha,
  controlSummarySha256:basePrepared.controlSummarySha256,controlReceiptSha256:basePrepared.controlReceiptSha256,
  sourceFenceApprovedSha256:sha(bytes(rootApproved)),contextSha256,context};
}
export async function validatePreparedContext(p,{manifestSha,basePrepared,basePreparedSha,rootApproved,beforeState}){
 const keys=['format','task','actionId','manifestSha256','basePreparedSha256','controlSummarySha256','controlReceiptSha256','sourceFenceApprovedSha256','contextSha256','context'];
 if(!exact(p,keys)||p.format!==1||p.task!=='T41'||p.actionId!=='T41.prepare_witness'||p.manifestSha256!==manifestSha||
  p.basePreparedSha256!==basePreparedSha||p.controlSummarySha256!==basePrepared.controlSummarySha256||
  p.controlReceiptSha256!==basePrepared.controlReceiptSha256||p.sourceFenceApprovedSha256!==sha(bytes(rootApproved))||
  !digest(p.contextSha256)||p.context?.sourceBarrierActionId!==ADOPTED||p.context.sourceBarrierReceiptSha256!==basePrepared.controlReceiptSha256||
  !same(p.context.boundary,rootApproved.boundary))fail('T41_BIND_PREPARED_CONTEXT_INVALID');
 if(beforeState!==undefined){const state=validateAdmissionMetadata(beforeState);if(!same(p.context.before,{backends:state.backends.map(b=>({pid:b.pid}))}))fail('T41_BIND_PREPARED_CONTEXT_INVALID');}
 try{await validateFenceContext(p.context,p.contextSha256);}catch{fail('T41_BIND_PREPARED_CONTEXT_INVALID');}return p;
}
const remoteSafe=v=>v?.protocol===PROTOCOL?{
 ...(['authorization','fence-context','configuration','dns','tls-negative','connect','begin','identity','fresh-witness','rollback','encryption','deadline'].includes(v.stage)?{remoteStage:v.stage}:{}),
 ...(['FENCE_WITNESS_FAILED','FENCE_WITNESS_DEADLINE'].includes(v.code)?{remoteCode:v.code}:{})}:{};
function fixedRequest(prepared,method,body,{request=https.request,signal,timeoutMs,maxBody}){
 return new Promise(resolve=>{let req,res,timer,done=false,size=0,statusCode=null;const chunks=[],started=performance.now();
  const finish=(code,value,remote={})=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);req?.destroy();res?.destroy();
   resolve({statusCode,bytes:size,elapsedMs:Math.ceil(performance.now()-started),...(code?{code}:{}),...(value!==undefined?{value}:{}),...remote});};
  const abort=()=>finish('T41_BIND_ABORTED');if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>finish('T41_BIND_HTTPS_TIMEOUT'),timeoutMs);
  try{req=request({protocol:'https:',hostname:HOST,port:443,servername:HOST,rejectUnauthorized:true,agent:false,method,
   path:'/functions/v1/'+prepared.functionName,headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'text/plain','Content-Length':'64'}:{})}},response=>{
    res=response;statusCode=Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599?res.statusCode:null;
    res.on('error',()=>finish('T41_BIND_HTTPS_FAILURE'));res.on('aborted',()=>finish('T41_BIND_HTTPS_FAILURE'));
    if(statusCode>=300&&statusCode<400){finish('T41_BIND_REDIRECT_REJECTED');return;}
    res.on('data',chunk=>{if(done)return;const b=Buffer.from(chunk);size+=b.length;if(size>(statusCode===200?maxBody:4096)){finish('T41_BIND_BODY_LIMIT');return;}chunks.push(b);});
    res.on('end',()=>{if(done)return;let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish(statusCode===200?'T41_BIND_JSON_INVALID':'T41_BIND_HTTP_STATUS');return;}
     if(method==='POST'&&statusCode!==200){finish('T41_BIND_HTTP_STATUS',undefined,remoteSafe(value));return;}finish(undefined,value);});
   });req.on('error',()=>finish('T41_BIND_HTTPS_FAILURE'));req.end(body,'ascii');}catch{finish('T41_BIND_HTTPS_FAILURE');}
 });
}
function endpoint(prepared){return prepared?.origin===ORIGIN&&digest(prepared.capabilitySha256)&&prepared.functionName==='bron-source-reader-'+prepared.capabilitySha256.slice(0,12);}
export function requestWitness(token,prepared,{request=https.request,signal,timeoutMs=35000}={}){
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||!endpoint(prepared)||
  prepared.capabilitySha256!==sha(Buffer.from(token,'ascii'))||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>35000)fail('T41_BIND_REQUEST_SCOPE');
 return fixedRequest(prepared,'POST',token,{request,signal,timeoutMs,maxBody:MAX_WIRE});
}
// Exactly one secretless purpose check prevents an unbudgeted witness request
// from reaching a mistakenly deployed Auth-data version on the same fixed slug.
export function requestReadiness(prepared,{request=https.request,signal,timeoutMs=5000}={}){
 if(!endpoint(prepared)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)fail('T41_BIND_REQUEST_SCOPE');
 return fixedRequest(prepared,'GET',undefined,{request,signal,timeoutMs,maxBody:4096});
}
const ready=r=>object(r)&&!r.code&&r.statusCode===403&&exact(r.value,['protocol','ok'])&&r.value.protocol===PROTOCOL&&r.value.ok===false;
export function safeBindFailure(e,phase){return {status:e?.status==='BLOCKED_OWNER_PROOF'?'BLOCKED_OWNER_PROOF':'BLOCKED',phase,code:failCode(e),
 ...remoteSafe({protocol:PROTOCOL,stage:e?.remoteStage,code:e?.remoteCode}),
 ...(/^T41_BIND_[A-Z0-9_]+$/.test(e?.upstreamCode??'')?{upstreamCode:e.upstreamCode}:{}),
 ...(Number.isInteger(e?.readinessStatus)&&e.readinessStatus>=100&&e.readinessStatus<=599?{readinessStatus:e.readinessStatus}:{}),sourceMustRemainClosed:true,retryAllowed:false};}


function decoded(s,max){if(typeof s!=='string'||s.length%4||s.length>Math.ceil(max/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail('T41_BIND_CIPHERTEXT_INVALID');
 const b=Buffer.from(s,'base64');if(b.length>max||b.toString('base64')!==s)fail('T41_BIND_CIPHERTEXT_INVALID');return b;}
export function decryptWitness(envelope,token,expectedSha){
 if(!exact(envelope,['protocol','nonce','ciphertext'])||envelope.protocol!==PROTOCOL||typeof token!=='string'||
  !/^[a-f0-9]{64}$/.test(token)||sha(Buffer.from(token,'ascii'))!==expectedSha)fail('T41_BIND_ENVELOPE_INVALID');
 const nonce=decoded(envelope.nonce,12),cipher=decoded(envelope.ciphertext,MAX_PLAIN+16);
 if(nonce.length!==12||cipher.length<17)fail('T41_BIND_CIPHERTEXT_INVALID');let key,plain;
 try{key=Buffer.from(hkdfSync('sha256',Buffer.from(token,'ascii'),Buffer.from(expectedSha,'utf8'),Buffer.from(PROTOCOL,'utf8'),32));
  const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(cipher.subarray(-16));plain=Buffer.concat([d.update(cipher.subarray(0,-16)),d.final()]);
  if(plain.length>MAX_PLAIN)fail('T41_BIND_PLAINTEXT_LIMIT');return JSON.parse(plain.toString('utf8'));
 }catch{fail('T41_BIND_DECRYPT_FAILED');}finally{key?.fill(0);plain?.fill(0);}
}
export function validateWitnessFrame(f,{base,preparedContext,callStarted,now=Date.now()}){
 const keys=['ok','protocol','projectRef','destinationVps','sourceBarrierActionId','contextSha256','sourceControlReceiptSha256','bindingKind','barrierPass',
  'started_epoch_ms','finished_epoch_ms','expires_epoch_ms','tls_negative_rejected','tls_verification','rollback_completed','identity','witness'];
 const identityKeys=['database','database_time','idle_timeout','isolation','owner','pid','read_only','role','session_role','statement_timeout'];
 const rawKeys=['db','actor','session','owner','readOnly','isolation','pid','backendStartMicros'];
 const witnessKeys=[...rawKeys,'preDataValidated','sourceBarrierActionId','sourceBarrierReceiptSha256'];
 const i=f?.identity,w=f?.witness;
 if(!exact(f,keys)||f.ok!==true||f.protocol!==PROTOCOL||f.projectRef!==PROJECT||f.destinationVps!==VPS||f.sourceBarrierActionId!==ADOPTED||
  f.contextSha256!==preparedContext.contextSha256||f.sourceControlReceiptSha256!==base.controlReceiptSha256||
  f.bindingKind!=='PRE_ADMISSION_CONTROL_RECEIPT'||f.barrierPass!==false||f.expires_epoch_ms!==Date.parse(base.expiresUtc)||
  f.tls_negative_rejected!==true||f.tls_verification!=='native-ca-and-hostname'||f.rollback_completed!==true||
  !Number.isSafeInteger(f.started_epoch_ms)||!Number.isSafeInteger(f.finished_epoch_ms)||f.started_epoch_ms<callStarted-5000||
  f.started_epoch_ms>now+5000||f.finished_epoch_ms<f.started_epoch_ms||f.finished_epoch_ms>now+5000||
  f.finished_epoch_ms-f.started_epoch_ms>30000||f.finished_epoch_ms>=f.expires_epoch_ms||
  !exact(i,identityKeys)||['database','role','session_role','owner'].some(k=>i[k]!=='postgres')||i.read_only!=='on'||i.isolation!=='repeatable read'||
  i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||!pid(i.pid)||typeof i.database_time!=='string'||
  !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(i.database_time)||!Number.isFinite(Date.parse(i.database_time))||
  !exact(w,witnessKeys)||w.preDataValidated!==true||w.sourceBarrierActionId!==ADOPTED||
  w.sourceBarrierReceiptSha256!==base.controlReceiptSha256||w.pid!==i.pid)fail('T41_BIND_WITNESS_FRAME_INVALID');
 const raw=Object.fromEntries(rawKeys.map(k=>[k,w[k]]));
 try{const validated=validateFenceWitness(preparedContext.context,raw);if(!same(validated,w))fail('T41_BIND_WITNESS_FRAME_INVALID');}
 catch{fail('T41_BIND_WITNESS_FRAME_INVALID');}return raw;
}
// Artifact plans are not durability proofs. Only persistRootArtifacts can publish
// their success, after checking actual root-owned fsynced readback evidence.
export function buildBindingArtifacts({manifestSha,base,baseSha,approved,preparedContext,witness}){
 const barrier={format:1,task:'T41',actionId:ADOPTED,manifestSha256:manifestSha,controlReceiptSha256:base.controlReceiptSha256,
  sourceProject:PROJECT,destinationVps:VPS,status:'SOURCE_ADMISSION_CLOSED',normalConnectDenied:approved.normalConnectDenied,
  existingClientsDrained:approved.existingClientsDrained,freshOwnerReconnect:true,providerBoundaryReviewed:approved.providerBoundaryReviewed,
  durableOnVps:true,sourcePaused:false,before:structuredClone(preparedContext.context.before),boundary:structuredClone(approved.boundary),witness:structuredClone(witness)};
 const barrierBytes=bytes(barrier),barrierReceiptSha256=sha(barrierBytes);
 const context=normalized({sourceBarrierActionId:ADOPTED,sourceBarrierReceiptSha256:barrierReceiptSha256,
  before:structuredClone(barrier.before),boundary:structuredClone(barrier.boundary)}),fenceContextSha256=sha(JSON.stringify(context));
 const final={...structuredClone(base),fenceContextSha256},finalBytes=bytes(final);
 const input={format:1,task:'T41',actionId:ACTION,manifestSha256:manifestSha,basePreparedSha256:baseSha,finalPreparedSha256:sha(finalBytes),
  controlSummarySha256:base.controlSummarySha256,controlReceiptSha256:base.controlReceiptSha256,barrierReceiptPath:BARRIER,
  barrierReceiptSha256,fenceContextSha256,fenceContext:context};
 return {barrier,context,final,input,artifacts:[{path:BARRIER,bytes:barrierBytes,sha256:barrierReceiptSha256},
  {path:FINAL,bytes:finalBytes,sha256:sha(finalBytes)},{path:INPUT,bytes:bytes(input),sha256:sha(bytes(input))}]};
}
export async function persistRootArtifacts(planned,persist){
 if(typeof persist!=='function')fail('T41_BIND_PERSIST_REQUIRED');
 for(const a of planned.artifacts){const p=await persist(a);
  if(p?.path!==a.path||p.sha256!==a.sha256||p.readbackSha256!==a.sha256||p.uid!==0||p.gid!==0||p.mode!==0o600||
   p.nlink!==1||p.regularFile!==true||p.symlink!==false||p.exclusive!==true||p.fileFsynced!==true||p.directoryFsynced!==true)
   fail('T41_BIND_DURABLE_ROOT_REQUIRED');
 }
 return {task:'T41',status:'SOURCE_ADMISSION_CLOSED',sourceBarrierPass:true,authBudgetUsed:1,authBudgetRemaining:2,
  sourceAuthUserRead:false,sourceBusinessDataRead:false,sourceEffects:false,targetWritesStarted:false,macDataTransit:false,
  barrierReceiptPath:BARRIER,barrierReceiptSha256:planned.artifacts[0].sha256,finalPreparedSha256:planned.artifacts[1].sha256,
  fenceInputPath:INPUT,fenceInputSha256:planned.artifacts[2].sha256,fenceContextSha256:planned.final.fenceContextSha256,
  fenceContext:structuredClone(planned.context)};
}
export async function runWitnessVerification({manifestSha,base,baseSha,approved,preparedContext,control,token,guard,persist,signal,onSourceAttempt=()=>{},onWitnessValidated=()=>{}},fixture){
 if(fixture&&!process.env.NODE_TEST_CONTEXT)fail('T41_BIND_FIXTURE_FORBIDDEN');
 const {send=requestWitness,readiness=requestReadiness,status=readBudgetStatus,now=Date.now}=fixture??{};
 validateBase(base,manifestSha,now());validateRootInput(approved,{manifestSha,baseSha,base,control,now:now()});if(sha(Buffer.from(token??'','ascii'))!==base.capabilitySha256)fail('T41_BIND_CAPABILITY_SHA');
 await validatePreparedContext(preparedContext,{manifestSha,basePrepared:base,basePreparedSha:baseSha,rootApproved:approved});
 validateLedger(await status(binding()),base);if(signal?.aborted)fail('T41_BIND_ABORTED');
 if(typeof guard!=='function')fail('T41_BIND_GUARD_REQUIRED');await guard();
 if(signal?.aborted)fail('T41_BIND_ABORTED');
 const purpose=await readiness(base,{signal});if(!ready(purpose))throw Object.assign(new Error('T41_BIND_PURPOSE_NOT_VERIFIED'),{code:'T41_BIND_PURPOSE_NOT_VERIFIED',readinessStatus:Number.isInteger(purpose?.statusCode)?purpose.statusCode:null});
 if(signal?.aborted)fail('T41_BIND_ABORTED');validateBase(base,manifestSha,now());const started=now();
 if(typeof onSourceAttempt!=='function'||typeof onWitnessValidated!=='function')fail('T41_BIND_CALLBACK_REQUIRED');onSourceAttempt();const response=await send(token,base,{signal});
 if(response?.code||response?.statusCode!==200)throw Object.assign(new Error('T41_BIND_SOURCE_FAILED'),{code:'T41_BIND_SOURCE_FAILED',...remoteSafe({protocol:PROTOCOL,stage:response?.remoteStage,code:response?.remoteCode}),upstreamCode:/^T41_BIND_[A-Z0-9_]+$/.test(response?.code??'')?response.code:null});
 const frame=decryptWitness(response.value,token,base.capabilitySha256),raw=validateWitnessFrame(frame,{base,preparedContext,callStarted:started,now:now()});onWitnessValidated();
 if(signal?.aborted)fail('T41_BIND_ABORTED');validateLedger(await status(binding()),base);
 const planned=buildBindingArtifacts({manifestSha,base,baseSha,approved,preparedContext,witness:raw});
 const result=await persistRootArtifacts(planned,persist);
 return {...result,https:{status:200,bytes:response.bytes,elapsedMs:response.elapsedMs},readiness:{method:'GET',status:403,purposeVerified:true},sourceWitnessValidated:true};
}

// Production filesystem. It reports actual ownership and durability, not a task boolean.
export function createPrivateFiles(testOnly){
 let root=DIR,uid=0,gid=0;
 if(testOnly){if(!process.env.NODE_TEST_CONTEXT||!exact(testOnly,['directory','uid','gid'])||!testOnly.directory.startsWith('/tmp/')||
  path.resolve(testOnly.directory)!==testOnly.directory||testOnly.uid!==process.getuid()||testOnly.gid!==process.getgid())fail('T41_BIND_FIXTURE_FORBIDDEN');
  root=testOnly.directory;uid=testOnly.uid;gid=testOnly.gid;}
 const directory=p=>{const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T41_BIND_PRIVATE_DIRECTORY');};
 const mapped=p=>{if(!p.startsWith(DIR+'/')||path.dirname(p)!==DIR)fail('T41_BIND_PRIVATE_PATH');directory(root);return path.join(root,path.basename(p));};
 const read=(p,max=1048576)=>{const f=fs.openSync(mapped(p),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const s=fs.fstatSync(f);if(!s.isFile()||s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==0o600||s.nlink!==1||s.size<1||s.size>max)fail('T41_BIND_PRIVATE_FILE');
   const b=fs.readFileSync(f),after=fs.fstatSync(f);if(b.length!==s.size||s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.ctimeMs!==after.ctimeMs)fail('T41_BIND_PRIVATE_FILE_CHANGED');return b;
  }finally{fs.closeSync(f);}};
 const write=a=>{const p=mapped(a.path);if(!Buffer.isBuffer(a.bytes)||a.bytes.length<1||a.bytes.length>1048576||sha(a.bytes)!==a.sha256)fail('T41_BIND_WRITE_INVALID');
  const f=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(f,a.bytes);fs.fsyncSync(f);}finally{fs.closeSync(f);}const d=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{fs.fsyncSync(d);}finally{fs.closeSync(d);}const b=read(a.path);if(!b.equals(a.bytes))fail('T41_BIND_WRITE_READBACK');
  const s=fs.lstatSync(p);return {path:a.path,sha256:a.sha256,readbackSha256:sha(b),uid:s.uid,gid:s.gid,mode:s.mode&0o7777,nlink:s.nlink,
   regularFile:s.isFile(),symlink:s.isSymbolicLink(),exclusive:true,fileFsynced:true,directoryFsynced:true};};
 directory(root);return {read,write,absent:paths=>{for(const p of paths)try{fs.lstatSync(mapped(p));fail('T41_BIND_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}};
}
function privateRead(p,max=1048576){const f=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(f);if(!s.isFile()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o600||s.nlink!==1||s.size<1||s.size>max)fail('T41_BIND_PRIVATE_FILE');
  const b=fs.readFileSync(f),after=fs.fstatSync(f);if(b.length!==s.size||s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.ctimeMs!==after.ctimeMs)fail('T41_BIND_PRIVATE_FILE_CHANGED');return b;
 }finally{fs.closeSync(f);}}
const parse=b=>{try{return JSON.parse(b);}catch{fail('T41_BIND_JSON_INVALID');}};
function assertGate(m,pin,base,baseSha,approved){
 const sBytes=privateRead(SUMMARY),cBytes=privateRead(CONTROL),s=parse(sBytes),c=parse(cBytes),a=controlActivation(m);
 if(sha(sBytes)!==base.controlSummarySha256||sha(cBytes)!==base.controlReceiptSha256||s.task!=='T41'||s.status!=='CONTROL_READY'||
  s.actionId!=='T41.prepare_control_ready'||s.parentActionId!==PARENT||s.authorizationManifestSha256!==pin||
  s.ownerProofMethod!==OWNER_PROOF_METHOD||s.ownerProofApprovedInputSha256!==m.owner_proof.approvedInputSha256||s.adoptedActionId!==ADOPTED||
  s.adoptedManifestSha256!==a.manifestSha256||s.controlReceiptSha256!==base.controlReceiptSha256||s.independentKeyProofSha256!==base.independentKeyProofSha256||
  s.independentKeyProofSha256!==m.owner_proof.independentProofSha256||s.sourceEffects!==false||s.sourceBarrierPass!==false||s.targetWritesStarted!==false||
  s.rootComparisonRequired!==true||!same(s.sqlHashes,c.sqlHashes))fail('T41_BIND_CONTROL_GATE_INVALID');
 matchIndependentControlHashes({activation:a,controlReceipt:{...c,receiptSha256:sha(cBytes)},independentHashes:s.sqlHashes});
 const adapter=createAdmissionCustodyFs({activation:a,proofInputs:m.owner_proof.inputs});
 try{adapter.readIndependentKeyProof({path:a.independentKeyProofPath,sha256:a.independentKeyProofSha256});
  const prepared=adapter.loadPrepared();if(prepared.stateReceipt.beforeImageSha256!==m.input_evidence.T40_before_image_sha256||
   prepared.stateReceipt.receiptSha256!==m.input_evidence.T40_metadata_receipt_sha256)fail('T41_BIND_ADOPTED_STATE_CHANGED');
  validateRootInput(approved,{manifestSha:pin,baseSha,base,control:s});return {control:s,beforeState:prepared.before};
 }finally{adapter.close();}
}
async function main(){let phase='preflight',mode,store,timer,started=false;const controller=new AbortController();
 let result={task:'T41',status:'BLOCKED',sourceAuthUserRead:false,sourceBusinessDataRead:false,sourceEffects:false,sourceBarrierPass:false,macDataTransit:false,sourceWitnessReadAttempted:false,sourceWitnessValidated:false};
 try{
  if(process.argv.length!==11||!['--prepare-witness','--verify-witness'].includes(process.argv[2])||process.argv[3]!=='--manifest'||
   process.argv[4]!==MANIFEST||process.argv[5]!=='--sha256'||!digest(process.argv[6])||process.argv[7]!=='--input-sha256'||!digest(process.argv[8])||
   process.argv[9]!=='--owner-proof-input-sha256'||!digest(process.argv[10]))fail('T41_BIND_EXPLICIT_REVIEW_REQUIRED');
  mode=process.argv[2];
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||
   fileURLToPath(import.meta.url)!==SELF||!Object.values(networkInterfaces()).flat().some(i=>i?.address===VPS)||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('T41_BIND_PINNED_VPS_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const p of ['/root',ROOT,RUNTIME,RUNTIME+'/docs',RUNTIME+'/docs/runbooks',RUNTIME+'/docs/runbooks/payloads',RUNTIME+'/docs/runbooks/payloads/source-fence-witness']){
   const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T41_BIND_PRIVATE_DIRECTORY');}
  store=createPrivateFiles();const initial=validateManifest(store.read(MANIFEST),process.argv[6],sha(privateRead(SELF)));
  for(const n of RUNTIME_NAMES){const p=RUNTIME+'/docs/runbooks/payloads/'+n;if(sha(privateRead(p))!==initial.runtime_files[p])fail('T41_BIND_RUNTIME_SHA');}
  const m=loadOwnerManifest(initial,process.argv[6],process.argv[10]);
  const approvedBytes=store.read(SOURCE_INPUT,65536);if(sha(approvedBytes)!==process.argv[8])fail('T41_BIND_ROOT_INPUT_SHA');
  const approved=parse(approvedBytes);if(!bytes(approved).equals(approvedBytes))fail('T41_BIND_NONCANONICAL_INPUT');
  const baseBytes=store.read(BASE,16384),base=parse(baseBytes);validateBase(base,process.argv[6]);const baseSha=sha(baseBytes);
  const gate=assertGate(m,process.argv[6],base,baseSha,approved);validateLedger(readBudgetStatus(binding()),base);
  if(mode==='--prepare-witness'){
   store.absent([CONTEXT,DIR+'/witness-prepare.guard',DIR+'/witness-verify.guard',BARRIER,FINAL,INPUT]);
   store.write({path:DIR+'/witness-prepare.guard',bytes:bytes({task:'T41',actionId:'T41.prepare_witness',manifestSha256:process.argv[6],sourceFenceApprovedSha256:process.argv[8]}),sha256:sha(bytes({task:'T41',actionId:'T41.prepare_witness',manifestSha256:process.argv[6],sourceFenceApprovedSha256:process.argv[8]}))});
   phase='prepare-witness';const prepared=await buildWitnessContext({manifestSha:process.argv[6],basePrepared:base,basePreparedSha:baseSha,rootApproved:approved,...gate});
   const content=bytes(prepared),receipt=store.write({path:CONTEXT,bytes:content,sha256:sha(content)});
   result={...result,status:'WITNESS_CONTEXT_PREPARED',context:prepared.context,contextSha256:prepared.contextSha256,preparedContextSha256:receipt.sha256,
    capabilitySha256:base.capabilitySha256,functionName:base.functionName,expiresUtc:base.expiresUtc,authBudgetUsed:1};
  }else{
   store.absent([DIR+'/witness-verify.guard',DIR+'/witness-result.json',BARRIER,FINAL,INPUT]);
   const prepared=parse(store.read(CONTEXT,65536));await validatePreparedContext(prepared,{manifestSha:process.argv[6],basePrepared:base,basePreparedSha:baseSha,rootApproved:approved,beforeState:gate.beforeState});
   const token=store.read(CAP,64).toString('utf8');timer=setTimeout(()=>controller.abort(),40000);phase='verify-witness';
   result={...result,...await runWitnessVerification({manifestSha:process.argv[6],base,baseSha,approved,preparedContext:prepared,control:gate.control,token,signal:controller.signal,persist:store.write,
    onSourceAttempt:()=>{result.sourceWitnessReadAttempted=true;},onWitnessValidated:()=>{result.sourceWitnessValidated=true;},
    guard:()=>{const b=bytes({task:'T41',actionId:'T41.verify_witness',manifestSha256:process.argv[6],contextSha256:prepared.contextSha256,sourceFenceApprovedSha256:process.argv[8]});store.write({path:DIR+'/witness-verify.guard',bytes:b,sha256:sha(b)});started=true;}})};
  }
 }catch(e){result={...result,...safeBindFailure(e,phase)};}
 finally{clearTimeout(timer);controller.abort();if(started)try{const b=bytes(result);store.write({path:DIR+'/witness-result.json',bytes:b,sha256:sha(b)});}catch{result={...result,status:'BLOCKED',code:'T41_BIND_RESULT_WRITE_FAILED'};}}
 console.log('T41_WITNESS_RESULT',JSON.stringify(result));if(!['WITNESS_CONTEXT_PREPARED','SOURCE_ADMISSION_CLOSED'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
