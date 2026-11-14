// Fixed final-window Source transport. Caller owns reviewed VPS custody, fence and activation.
// Import is inert; this module does not load secrets, deploy, change Source or touch target data.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PROTOCOL,budgetBinding,requestSource,decryptEnvelope,validateSource} from './t37-https-inventory.mjs';
import {SOURCE_TRANSFER_SCOPE_SHA256,readBudgetStatus,consumeBudget} from './source-transfer-budget.mjs';
import {validateFenceContext,validateFenceWitness} from './source-final-https-reader/fence-witness.mjs';

const PROJECT='vkkqffvmztpzgygzfxhq',ORIGIN='https://'+PROJECT+'.supabase.co',PREFIX='bron-source-reader-';
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeUpstream=new Set(['T37_REQUEST_SCOPE','T37_WALL_DEADLINE','T37_HTTPS_TIMEOUT','T37_HTTPS_FAILURE',
 'T37_REDIRECT_REJECTED','T37_BODY_LIMIT','T37_JSON_INVALID','T37_HTTP_STATUS','T37_ENVELOPE_INVALID',
 'T37_CIPHERTEXT_INVALID','T37_DECRYPT_FAILED','T37_SOURCE_INVARIANT','T37_SNAPSHOT_INVALID',
 'T37_SNAPSHOT_GROUPS_MISSING','T37_SEQUENCE_INVALID','T37_FINGERPRINT_INVALID','T37_SNAPSHOT_KEY_INVALID',
 'T37_AUTH_COHORT_LIMIT','T37_AUTH_INVALID','T37_AUTH_COUNT_MISMATCH',
 'SOURCE_TRANSFER_LEDGER_UNCERTAIN','SOURCE_TRANSFER_BUDGET_EXHAUSTED','SOURCE_TRANSFER_ACTION_SEQUENCE',
 'SOURCE_TRANSFER_CAPABILITY_SHA_REQUIRED','SOURCE_TRANSFER_CLAIM_CONFLICT','SOURCE_TRANSFER_CLAIM_WRITE_FAILED']);
function redacted(code,error){
 const upstreamCode=safeUpstream.has(error?.code)?error.code:safeUpstream.has(error?.upstreamCode)?error.upstreamCode:null;
 return Object.assign(new Error(code),{code,...(upstreamCode?{upstreamCode}:{})});
}
function scope(config){
 const a=config?.activation,m=config?.taskManifest,task=typeof a?.actionId==='string'?a.actionId.match(/^(T[1-9][0-9]{1,3})\.final_https_window$/)?.[1]:undefined;
 if(!task||a.reviewed!==true||!digest(a.manifestSha256)||a.targetAdmitted!==false||
  a.sourceRoute!=='fixed-source-edge-https'||a.sourceFrameBudget!==2||a.priorSourceAuthSnapshotAttempts!==1||
  a.ownerDataGrantEvidenceSha256!==SOURCE_TRANSFER_SCOPE_SHA256||a.applyTimestampOnly!==true||
  m?.task!==task||m.execution_authorized!==true||m.approval?.status!=='APPROVED'||
  m.approval.document_sha256!==SOURCE_TRANSFER_SCOPE_SHA256||m.source?.origin!==ORIGIN||
  m.source.projectRef!==PROJECT||m.source.protocol!==PROTOCOL||
  m.source.capability_binding!=='pinned_VPS_prepare_readback'||m.source.template_name_prefix!==PREFIX)
  fail('FINAL_HTTPS_TRANSPORT_ACTIVATION_INVALID');
 let binding;try{binding=budgetBinding(m);}catch{fail('FINAL_HTTPS_TRANSPORT_BUDGET_BINDING_INVALID');}
 if(config.ledgerBinding&&Object.keys({...binding,...config.ledgerBinding}).some(k=>config.ledgerBinding[k]!==binding[k]))
  fail('FINAL_HTTPS_TRANSPORT_BUDGET_BINDING_INVALID');
 if(config.fenceContextSha256!==a.fenceContextSha256||!digest(a.fenceContextSha256))
  fail('FINAL_HTTPS_TRANSPORT_FENCE_CONTEXT_INVALID');
 return {task,activation:structuredClone(a),binding};
}
function preparedContext(token,p,a,task,now){
 const created=Date.parse(p?.createdUtc),expires=Date.parse(p?.expiresUtc);
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||p?.task!==task||p.manifestSha256!==a.manifestSha256||
  p.ownerGrantSha256!==SOURCE_TRANSFER_SCOPE_SHA256||p.fenceContextSha256!==a.fenceContextSha256||
  p.capabilitySha256!==sha(Buffer.from(token,'ascii'))||p.functionName!==PREFIX+p.capabilitySha256.slice(0,12)||
  p.origin!==ORIGIN||p.protocol!==PROTOCOL||!Number.isSafeInteger(now)||
  !Number.isSafeInteger(created)||!Number.isSafeInteger(expires)||
  new Date(created).toISOString()!==p.createdUtc||new Date(expires).toISOString()!==p.expiresUtc||
  created>now+5000||expires-created!==7200000||now+140000>=expires)
  fail('FINAL_HTTPS_TRANSPORT_CAPABILITY_INVALID');
}
function ledgerStatus(status,used,task,capabilitySha256){
 if(status?.uncertain!==false||status.used!==used||status.remaining!==3-used||status.maxAttempts!==3||
  !Array.isArray(status.claims)||status.claims.length!==used||status.claims.some((c,i)=>c?.attempt!==i+1||c.status!=='VALID')||
  status.claims[0]?.actionId!=='T37.live'||!digest(status.claims[0]?.capabilitySha256)||
  status.claims[0].capabilitySha256===capabilitySha256||
  (used===2&&(status.claims[1].actionId!==task+'.final_before'||status.claims[1].capabilitySha256!==capabilitySha256)))
  fail('FINAL_HTTPS_TRANSPORT_LEDGER_NOT_READY');
}
function actualWitness(frame,context){
 const witness=frame?.fenceWitness;
 if(Object.keys(frame).sort().join(',')!=='authRows,expires_epoch_ms,fenceWitness,finished_epoch_ms,identity,ok,projectRef,protocol,snapshot,started_epoch_ms,tls_negative_rejected,tls_verification'||
  Object.keys(frame.identity).sort().join(',')!=='database,database_time,idle_timeout,isolation,owner,pid,read_only,role,server_address,session_role,statement_timeout'||
  !witness||Object.keys(witness).sort().join(',')!=='actor,backendStartMicros,db,isolation,owner,pid,preDataValidated,readOnly,session,sourceBarrierActionId,sourceBarrierReceiptSha256')
  fail('FINAL_HTTPS_TRANSPORT_FENCE_WITNESS_INVALID');
 if(witness?.preDataValidated!==true||witness.sourceBarrierActionId!==context.sourceBarrierActionId||
  witness.sourceBarrierReceiptSha256!==context.sourceBarrierReceiptSha256||witness.pid!==frame.identity?.pid)
  fail('FINAL_HTTPS_TRANSPORT_FENCE_WITNESS_INVALID');
 try{validateFenceWitness(context,witness);}catch{fail('FINAL_HTTPS_TRANSPORT_FENCE_WITNESS_INVALID');}
}

async function create(config,runtime){
 const {task,activation,binding}=scope(config),prepared=structuredClone(config.prepared),token=config.token;
 preparedContext(token,prepared,activation,task,runtime.now());
 let context;try{context=await validateFenceContext(structuredClone(config.fenceContext),config.fenceContextSha256);}
 catch{fail('FINAL_HTTPS_TRANSPORT_FENCE_CONTEXT_INVALID');}
 if(context.sourceBarrierActionId!==activation.sourceBarrierActionId||
  context.sourceBarrierReceiptSha256!==activation.sourceBarrierReceiptSha256)
  fail('FINAL_HTTPS_TRANSPORT_FENCE_CONTEXT_INVALID');
 let initial;try{initial=await runtime.status(binding);}catch(error){throw redacted('FINAL_HTTPS_TRANSPORT_LEDGER_NOT_READY',error);}
 ledgerStatus(initial,1,task,prepared.capabilitySha256);
 const signal=config.signal,onBudgetClaim=config.onBudgetClaim??(()=>{});
 if(typeof onBudgetClaim!=='function')fail('FINAL_HTTPS_TRANSPORT_RECEIPT_CALLBACK_INVALID');
 let next='before',inFlight=false,failed=false,lastStarted=null;
 return Object.freeze({captureSourceFrame:async stage=>{
  if(failed||inFlight||stage!==next)fail('FINAL_HTTPS_TRANSPORT_STAGE_INVALID');
  inFlight=true;
  try{
   if(signal?.aborted)fail('FINAL_HTTPS_TRANSPORT_ABORTED');
   preparedContext(token,prepared,activation,task,runtime.now());
   let status;try{status=await runtime.status(binding);}catch(error){throw redacted('FINAL_HTTPS_TRANSPORT_LEDGER_NOT_READY',error);}
   const attempt=stage==='before'?2:3;ledgerStatus(status,attempt-1,task,prepared.capabilitySha256);
   if(signal?.aborted)fail('FINAL_HTTPS_TRANSPORT_ABORTED');
   let claim;try{claim=await runtime.claim({...binding,actionId:task+'.final_'+stage,capabilitySha256:prepared.capabilitySha256});}
   catch(error){throw redacted('FINAL_HTTPS_TRANSPORT_BUDGET_CLAIM_FAILED',error);}
   if(claim?.attempt!==attempt||claim.remaining!==3-attempt||
    claim.claimPath!==binding.directory+'/attempt-'+attempt+'.json'||!digest(claim.claimSha256))
    fail('FINAL_HTTPS_TRANSPORT_CLAIM_NOT_PROVED');
   // The claim is already durable. Receipt or transport failure never refunds it.
   try{await onBudgetClaim({stage,actionId:task+'.final_'+stage,attempt:claim.attempt,remaining:claim.remaining,claimPath:claim.claimPath,claimSha256:claim.claimSha256});}
   catch{fail('FINAL_HTTPS_TRANSPORT_RECEIPT_CALLBACK_FAILED');}
   if(signal?.aborted)fail('FINAL_HTTPS_TRANSPORT_ABORTED');
   const callStarted=runtime.now();preparedContext(token,prepared,activation,task,callStarted);let response;
   try{response=await runtime.send(token,prepared,{signal});}
   catch(error){throw redacted('FINAL_HTTPS_TRANSPORT_REQUEST_FAILED',error);}
   if(response?.code||response?.statusCode!==200)
    throw redacted('FINAL_HTTPS_TRANSPORT_SOURCE_RESPONSE_INVALID',response);
   let frame;try{frame=decryptEnvelope(response.value,token,prepared.capabilitySha256);}
   catch(error){throw redacted('FINAL_HTTPS_TRANSPORT_DECRYPT_FAILED',error);}
   try{validateSource(frame,prepared,callStarted,runtime.now());}
   catch(error){throw redacted('FINAL_HTTPS_TRANSPORT_SOURCE_FRAME_INVALID',error);}
   actualWitness(frame,context);
   if(lastStarted!==null&&frame.started_epoch_ms<=lastStarted)fail('FINAL_HTTPS_TRANSPORT_FRAME_REPLAYED');
   if(signal?.aborted)fail('FINAL_HTTPS_TRANSPORT_ABORTED');
   lastStarted=frame.started_epoch_ms;next=stage==='before'?'after':'complete';
   return structuredClone(frame);
  }catch(error){
   failed=true;
   if(/^FINAL_HTTPS_TRANSPORT_[A-Z_]+$/.test(error?.code??''))throw redacted(error.code,error);
   throw redacted('FINAL_HTTPS_TRANSPORT_FAILED',error);
  }finally{inFlight=false;}
 }});
}

// Production uses only the reviewed HTTPS and durable budget implementations.
// Caller must first verify manifest bytes/pins and load token/prepared metadata on VPS.
export const createFinalHttpsTransport=config=>create(config,{send:requestSource,status:readBudgetStatus,
 claim:consumeBudget,now:Date.now});

// Synthetic local tests only. No caller-supplied hooks exist on the production factory.
export function createFinalHttpsTransportFixture(config,{send,status,claim,now=Date.now}={}){
 if([send,status,claim,now].some(f=>typeof f!=='function'))fail('FINAL_HTTPS_TRANSPORT_FIXTURE_INVALID');
 return create(config,{send,status,claim,now});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 console.error('FINAL_HTTPS_TRANSPORT_DRAFT_NOT_ACTIVATED');process.exitCode=2;
}
