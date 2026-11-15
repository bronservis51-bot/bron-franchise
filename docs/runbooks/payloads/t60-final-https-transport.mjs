// Fixed final-window Source transport. Caller owns reviewed VPS custody, fence and activation.
// Import is inert; this module does not load secrets, deploy, change Source or touch target data.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {PROTOCOL,requestSource,decryptEnvelope,validateSnapshot} from './t37-https-inventory.mjs';
import {validateAuthRows} from './t59-auth-timestamps.mjs';
import {readBudgetStatus,consumeBudget} from './t60-source-transfer-budget.mjs';
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
 const upstreamCode=safeUpstream.has(error?.code)||/^T60_BUDGET_[A-Z_]+$/.test(error?.code??'')?error.code:safeUpstream.has(error?.upstreamCode)||/^T60_BUDGET_[A-Z_]+$/.test(error?.upstreamCode??'')?error.upstreamCode:null;
 const budgetUncertain=error?.budgetUncertain===true||error?.claimMayBeConsumed===true||/^T60_BUDGET_(?:PRIOR_|UNSAFE|UNCERTAIN|SCOPE_CHANGED|CLAIM_WRITE_FAILED)/.test(upstreamCode??'');
 return Object.assign(new Error(code),{code,...(upstreamCode?{upstreamCode}:{}),...(budgetUncertain?{budgetUncertain:true}:{}),...(error?.claimMayBeConsumed===true?{claimMayBeConsumed:true}:{})});
}
export function budgetBinding(m,manifestSha256){
 const b=m?.transfer_budget;
 if(b?.directory!=='/root/bron-secrets/source-auth-final-e60a2026'||b.scope_sha256!==m?.approval?.document_sha256||
  !digest(b.scope_sha256)||b.max_attempts!==6||b.prior_used!==4||b.source_project!==PROJECT||b.destination_vps!=='152.228.115.115'||!digest(manifestSha256))
  fail('T60_HTTPS_TRANSPORT_BUDGET_BINDING_INVALID');
 return {directory:b.directory,ownerGrantSha256:b.scope_sha256,manifestSha256,sourceProject:PROJECT,destinationVps:b.destination_vps,maxAttempts:6,priorUsed:4};
}
function scope(config){
 const a=config?.activation,m=config?.taskManifest,task=a?.actionId==='T60.final_https_window'?'T60':undefined;
 if(!task||a.reviewed!==true||!digest(a.manifestSha256)||a.targetAdmitted!==false||
  a.sourceRoute!=='fixed-source-edge-https'||a.sourceFrameBudget!==2||a.priorSourceAuthSnapshotAttempts!==4||
  !digest(a.ownerDataGrantEvidenceSha256)||a.applyAuthTimestampsOnly!==true||a.maxAuthTimestampRows!==2||
  a.sourceAuthoritativeAuthTimestamps!==true||JSON.stringify(a.authTimestampColumns)!==JSON.stringify(['last_sign_in_at','updated_at'])||
  m?.task!==task||m.execution_authorized!==true||m.approval?.status!=='APPROVED'||
  m.approval.document_sha256!==a.ownerDataGrantEvidenceSha256||m.approval.maxAuthSnapshots!==6||m.approval.priorUsed!==4||
  m.approval.lastSignInAtValue!==true||m.approval.updatedAtValue!==true||m.approval.targetTimestampReconciliation!==true||
  m.source?.origin!==ORIGIN||m.source.projectRef!==PROJECT||m.source.protocol!==PROTOCOL||
  m.source.capability_binding!=='pinned_VPS_prepare_readback'||m.source.template_name_prefix!==PREFIX)
  fail('T60_HTTPS_TRANSPORT_ACTIVATION_INVALID');
 const binding=budgetBinding(m,a.manifestSha256);
 if(config.ledgerBinding&&Object.keys({...binding,...config.ledgerBinding}).some(k=>config.ledgerBinding[k]!==binding[k]))
  fail('T60_HTTPS_TRANSPORT_BUDGET_BINDING_INVALID');
 if(config.fenceContextSha256!==a.fenceContextSha256||!digest(a.fenceContextSha256))fail('T60_HTTPS_TRANSPORT_FENCE_CONTEXT_INVALID');
 return {task,activation:structuredClone(a),binding};
}
function preparedContext(token,p,a,task,now){
 const created=Date.parse(p?.createdUtc),expires=Date.parse(p?.expiresUtc);
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||p?.task!==task||p.manifestSha256!==a.manifestSha256||
  p.ownerGrantSha256!==a.ownerDataGrantEvidenceSha256||p.fenceContextSha256!==a.fenceContextSha256||
  p.capabilitySha256!==sha(Buffer.from(token,'ascii'))||p.functionName!==PREFIX+p.capabilitySha256.slice(0,12)||
  p.origin!==ORIGIN||p.protocol!==PROTOCOL||!Number.isSafeInteger(now)||!Number.isSafeInteger(created)||!Number.isSafeInteger(expires)||
  new Date(created).toISOString()!==p.createdUtc||new Date(expires).toISOString()!==p.expiresUtc||created>now+5000||expires-created!==7200000||now+140000>=expires)
  fail('T60_HTTPS_TRANSPORT_CAPABILITY_INVALID');
}
function ledgerStatus(status,used,task,capabilitySha256){
 if(status?.uncertain!==false||status.used!==used||status.remaining!==6-used||status.maxAttempts!==6||status.priorUsed!==4||
  !Array.isArray(status.claims)||status.claims.length!==used||status.claims.some((c,i)=>c?.attempt!==i+1||c.status!=='VALID')||
  status.claims[0]?.actionId!=='T37.live'||status.claims[1]?.actionId!=='T56.final_before'||status.claims[2]?.actionId!=='T58.auth_diagnostic'||
  status.claims[3]?.actionId!=='T59.final_before'||status.claims[3]?.capabilitySha256!=='6c6021ba66444f384593c98792a945b804afaadb156006b7269300e57f559b77'||
  status.claims.slice(0,4).some(c=>!digest(c.capabilitySha256)||c.capabilitySha256===capabilitySha256)||
  (used>=5&&(status.claims[4].actionId!==task+'.final_before'||status.claims[4].capabilitySha256!==capabilitySha256))||
  (used===6&&(status.claims[5].actionId!==task+'.final_after'||status.claims[5].capabilitySha256!==capabilitySha256)))
  throw Object.assign(new Error('T60_HTTPS_TRANSPORT_LEDGER_NOT_READY'),{code:'T60_HTTPS_TRANSPORT_LEDGER_NOT_READY',budgetUncertain:true});
}
export function validateSource(v,prepared,callStarted,now=Date.now()){
 const i=v?.identity,expiry=Date.parse(prepared?.expiresUtc);
 if(v?.ok!==true||v.protocol!==PROTOCOL||v.projectRef!==PROJECT||v.expires_epoch_ms!==expiry||
  v.tls_negative_rejected!==true||v.tls_verification!=='native-ca-and-hostname'||!Number.isSafeInteger(v.started_epoch_ms)||
  !Number.isSafeInteger(v.finished_epoch_ms)||v.started_epoch_ms<callStarted-5000||v.started_epoch_ms>now+5000||
  v.finished_epoch_ms<v.started_epoch_ms||v.finished_epoch_ms>now+5000||v.finished_epoch_ms-v.started_epoch_ms>90000||
  v.finished_epoch_ms>=expiry||!i||['database','role','session_role','owner'].some(k=>i[k]!=='postgres')||
  i.read_only!=='on'||i.isolation!=='repeatable read'||i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||
  !Number.isSafeInteger(i.pid)||i.pid<1||!isIP(i.server_address)||typeof i.database_time!=='string'||!Number.isFinite(Date.parse(i.database_time)))
  fail('T60_HTTPS_TRANSPORT_SOURCE_INVARIANT');
 validateSnapshot(v.snapshot);validateAuthRows(v.authRows);if(v.snapshot['data:auth.users'].count!==v.authRows.length)fail('T60_HTTPS_TRANSPORT_AUTH_COUNT_MISMATCH');return v;
}
function actualWitness(frame,context){
 const witness=frame?.fenceWitness;
 if(Object.keys(frame).sort().join(',')!=='authRows,expires_epoch_ms,fenceWitness,finished_epoch_ms,identity,ok,projectRef,protocol,snapshot,started_epoch_ms,tls_negative_rejected,tls_verification'||
  Object.keys(frame.identity).sort().join(',')!=='database,database_time,idle_timeout,isolation,owner,pid,read_only,role,server_address,session_role,statement_timeout'||
  !witness||Object.keys(witness).sort().join(',')!=='actor,backendStartMicros,db,isolation,owner,pid,preDataValidated,readOnly,session,sourceBarrierActionId,sourceBarrierReceiptSha256')
  fail('T60_HTTPS_TRANSPORT_FENCE_WITNESS_INVALID');
 if(witness?.preDataValidated!==true||witness.sourceBarrierActionId!==context.sourceBarrierActionId||
  witness.sourceBarrierReceiptSha256!==context.sourceBarrierReceiptSha256||witness.pid!==frame.identity?.pid)
  fail('T60_HTTPS_TRANSPORT_FENCE_WITNESS_INVALID');
 try{validateFenceWitness(context,witness);}catch{fail('T60_HTTPS_TRANSPORT_FENCE_WITNESS_INVALID');}
}

async function create(config,runtime){
 const {task,activation,binding}=scope(config),prepared=structuredClone(config.prepared),token=config.token;
 preparedContext(token,prepared,activation,task,runtime.now());
 let context;try{context=await validateFenceContext(structuredClone(config.fenceContext),config.fenceContextSha256);}
 catch{fail('T60_HTTPS_TRANSPORT_FENCE_CONTEXT_INVALID');}
 if(context.sourceBarrierActionId!==activation.sourceBarrierActionId||
  context.sourceBarrierReceiptSha256!==activation.sourceBarrierReceiptSha256)
  fail('T60_HTTPS_TRANSPORT_FENCE_CONTEXT_INVALID');
 let initial;try{initial=await runtime.status(binding);}catch(error){throw redacted('T60_HTTPS_TRANSPORT_LEDGER_NOT_READY',error);}
 ledgerStatus(initial,4,task,prepared.capabilitySha256);
 const signal=config.signal,onBudgetClaim=config.onBudgetClaim??(()=>{});
 if(typeof onBudgetClaim!=='function')fail('T60_HTTPS_TRANSPORT_RECEIPT_CALLBACK_INVALID');
 let next='before',inFlight=false,failed=false,lastStarted=null;
 return Object.freeze({captureSourceFrame:async stage=>{
  if(failed||inFlight||stage!==next)fail('T60_HTTPS_TRANSPORT_STAGE_INVALID');
  inFlight=true;
  try{
   if(signal?.aborted)fail('T60_HTTPS_TRANSPORT_ABORTED');
   preparedContext(token,prepared,activation,task,runtime.now());
   let status;try{status=await runtime.status(binding);}catch(error){throw redacted('T60_HTTPS_TRANSPORT_LEDGER_NOT_READY',error);}
   const attempt=stage==='before'?5:6;ledgerStatus(status,attempt-1,task,prepared.capabilitySha256);
   if(signal?.aborted)fail('T60_HTTPS_TRANSPORT_ABORTED');
   let claim;try{claim=await runtime.claim({...binding,actionId:task+'.final_'+stage,capabilitySha256:prepared.capabilitySha256});}
   catch(error){throw redacted('T60_HTTPS_TRANSPORT_BUDGET_CLAIM_FAILED',error);}
   if(claim?.attempt!==attempt||claim.remaining!==6-attempt||
    claim.claimPath!==binding.directory+'/attempt-'+attempt+'.json'||!digest(claim.claimSha256))
    fail('T60_HTTPS_TRANSPORT_CLAIM_NOT_PROVED');
   // The claim is already durable. Receipt or transport failure never refunds it.
   try{await onBudgetClaim({stage,actionId:task+'.final_'+stage,attempt:claim.attempt,remaining:claim.remaining,claimPath:claim.claimPath,claimSha256:claim.claimSha256});}
   catch{fail('T60_HTTPS_TRANSPORT_RECEIPT_CALLBACK_FAILED');}
   if(signal?.aborted)fail('T60_HTTPS_TRANSPORT_ABORTED');
   const callStarted=runtime.now();preparedContext(token,prepared,activation,task,callStarted);let response;
   try{response=await runtime.send(token,prepared,{signal});}
   catch(error){throw redacted('T60_HTTPS_TRANSPORT_REQUEST_FAILED',error);}
   if(response?.code||response?.statusCode!==200)
    throw redacted('T60_HTTPS_TRANSPORT_SOURCE_RESPONSE_INVALID',response);
   let frame;try{frame=decryptEnvelope(response.value,token,prepared.capabilitySha256);}
   catch(error){throw redacted('T60_HTTPS_TRANSPORT_DECRYPT_FAILED',error);}
   try{validateSource(frame,prepared,callStarted,runtime.now());}
   catch(error){throw redacted('T60_HTTPS_TRANSPORT_SOURCE_FRAME_INVALID',error);}
   actualWitness(frame,context);
   if(lastStarted!==null&&frame.started_epoch_ms<=lastStarted)fail('T60_HTTPS_TRANSPORT_FRAME_REPLAYED');
   if(signal?.aborted)fail('T60_HTTPS_TRANSPORT_ABORTED');
   lastStarted=frame.started_epoch_ms;next=stage==='before'?'after':'complete';
   return structuredClone(frame);
  }catch(error){
   failed=true;
   if(/^T60_HTTPS_TRANSPORT_[A-Z_]+$/.test(error?.code??''))throw redacted(error.code,error);
   throw redacted('T60_HTTPS_TRANSPORT_FAILED',error);
  }finally{inFlight=false;}
 }});
}

// Production uses only the reviewed HTTPS and durable budget implementations.
// Caller must first verify manifest bytes/pins and load token/prepared metadata on VPS.
export const createFinalHttpsTransport=config=>create(config,{send:requestSource,status:readBudgetStatus,
 claim:consumeBudget,now:Date.now});

// Synthetic local tests only. No caller-supplied hooks exist on the production factory.
export function createFinalHttpsTransportFixture(config,{send,status,claim,now=Date.now}={}){
 if([send,status,claim,now].some(f=>typeof f!=='function'))fail('T60_HTTPS_TRANSPORT_FIXTURE_INVALID');
 return create(config,{send,status,claim,now});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 console.error('T60_HTTPS_TRANSPORT_DRAFT_NOT_ACTIVATED');process.exitCode=2;
}
