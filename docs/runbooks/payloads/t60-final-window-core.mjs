// Proposed T60 only; requires fresh explicit two-timestamp/6-total owner scope. The reviewed VPS runner owns HTTP, source-fence control and custody.
// This core never opens a connection, changes Source, pauses a project or opens preview.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {snapshotDatabase,compareSnapshots} from '../../../scripts/migration-audit.mjs';
import {exactQueryFingerprint} from './exact-query-fingerprint.mjs';
import {targetMetadataSql} from './final-auth-window.mjs';
import {authRowsPlan,authRowsSql,validateAuthRows,guardedUpdateSql,AUTH_TIMESTAMP_COLUMNS} from './t59-auth-timestamps.mjs';
import {validateFreshOwnerWitness} from './http-source-admission.mjs';
import {validateSnapshot} from './t37-https-inventory.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const mismatch=(code,groups)=>{throw Object.assign(new Error(code),{code,mismatchGroups:groups});};
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const protocol='BRON_PRIVATE_SNAPSHOT_V1';

function activation(a,grant,context){
 if(!/^T[1-9][0-9]{1,3}\.final_https_window$/.test(a?.actionId??'')||a.reviewed!==true||
  !digest(a.manifestSha256)||!/^T[1-9][0-9]{1,3}\.http_source_admission$/.test(a.sourceBarrierActionId??'')||
  !digest(a.sourceBarrierReceiptSha256)||!digest(a.fenceContextSha256)||
  a.targetAdmitted!==false||a.sourceRoute!=='fixed-source-edge-https'||a.targetRoute!=='verified-loopback-15433'||
  a.expectedAuthRows!==16||a.sourceFrameBudget!==2||!Number.isInteger(a.priorSourceAuthSnapshotAttempts)||
  a.priorSourceAuthSnapshotAttempts!==4||a.applyAuthTimestampsOnly!==true||a.sourceAuthoritativeAuthTimestamps!==true||
  JSON.stringify(a.authTimestampColumns)!==JSON.stringify(AUTH_TIMESTAMP_COLUMNS)||
  !Number.isInteger(a.maxAuthTimestampRows)||a.maxAuthTimestampRows<0||a.maxAuthTimestampRows>16||
  typeof a.beforeImagePath!=='string'||!/^\/root\/bron-secrets\/t[1-9][0-9]{1,3}-auth-before-[a-f0-9]{8,64}\.json$/.test(a.beforeImagePath))
  fail('FINAL_HTTPS_TASK_NOT_REVIEWED');
 // Source-data consent is separate from the new task's guarded target-write scope.
 // A one-read T37 grant cannot be reinterpreted as this two-frame final window.
 if(!digest(a.ownerDataGrantEvidenceSha256)||grant?.reviewed!==true||
  grant.evidenceSha256!==a.ownerDataGrantEvidenceSha256||grant.scope!=='source-auth-two-timestamps-fixed-snapshot-to-vps'||
  grant.sourceProject!=='vkkqffvmztpzgygzfxhq'||grant.destinationVps!=='152.228.115.115'||
  grant.credentialDerivedAuthDigests!==true||grant.readonlySource!==true||
  grant.encryptedToVpsRam!==true||grant.macDataTransit!==false||
  grant.maxAuthSnapshots!==6||grant.targetTimestampReconciliation!==true||grant.sourceAuthoritativeAuthTimestamps!==true||
  grant.lastSignInAtValue!==true||grant.updatedAtValue!==true||grant.maxAuthTimestampRows!==a.maxAuthTimestampRows||
  JSON.stringify(grant.authTimestampColumns)!==JSON.stringify(AUTH_TIMESTAMP_COLUMNS)||
  a.priorSourceAuthSnapshotAttempts+a.sourceFrameBudget!==grant.maxAuthSnapshots)
  fail('FINAL_HTTPS_SOURCE_DATA_GRANT_REQUIRED');
 try{
  if(context?.sourceBarrierActionId!==a.sourceBarrierActionId||
   context.sourceBarrierReceiptSha256!==a.sourceBarrierReceiptSha256||hash(context)!==a.fenceContextSha256||
   !Array.isArray(context.before?.backends)||!context.before.backends.every(b=>Number.isInteger(b?.pid)&&b.pid>0)||
   !/^\d{12,20}$/.test(context.boundary?.capturedMicros??'')||!Array.isArray(context.boundary.ownerPids)||
   !context.boundary.ownerPids.every(pid=>Number.isInteger(pid)&&pid>0))
   fail('FINAL_HTTPS_FENCE_CONTEXT_INVALID');
  return structuredClone(context);
 }catch{fail('FINAL_HTTPS_FENCE_CONTEXT_INVALID');}
}
function fence(proof,a){
 if(proof?.sourceBarrierActionId!==a.sourceBarrierActionId||proof.sourceBarrierReceiptSha256!==a.sourceBarrierReceiptSha256||
  ['normalConnectDenied','existingClientsDrained','freshOwnerReconnect','providerBoundaryReviewed','durableOnVps'].some(k=>proof[k]!==true)||
  proof.sourcePaused!==false)fail('FINAL_HTTPS_DURABLE_SOURCE_FENCE_NOT_PROVED');
}
function sourceFrame(frame,a,context){
 const i=frame?.identity,w=frame?.fenceWitness;
 if(frame?.protocol!==protocol||frame.projectRef!=='vkkqffvmztpzgygzfxhq'||
  frame.tls_negative_rejected!==true||frame.tls_verification!=='native-ca-and-hostname'||!object(i)||!object(w)||
  ['database','role','session_role','owner'].some(k=>i[k]!=='postgres')||i.read_only!=='on'||
  i.isolation!=='repeatable read'||i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||
  w.preDataValidated!==true||w.sourceBarrierActionId!==a.sourceBarrierActionId||
  w.sourceBarrierReceiptSha256!==a.sourceBarrierReceiptSha256||w.isolation!=='repeatable read'||w.pid!==i.pid)
  fail('FINAL_HTTPS_SOURCE_FRAME_NOT_PROVED');
 try{
  validateFreshOwnerWitness({before:context.before,boundary:context.boundary,witness:w});
  validateSnapshot(frame.snapshot);validateAuthRows(frame.authRows);
 }catch{fail('FINAL_HTTPS_SOURCE_FRAME_NOT_PROVED');}
 if(frame.snapshot['data:auth.users'].count!==frame.authRows.length)
  fail('FINAL_HTTPS_SOURCE_FRAME_AUTH_DRIFT');
 return frame;
}
function checkedPlan(source,target,expectedRows){
 const p=authRowsPlan(source,target);
 const reject=code=>{throw Object.assign(new Error(code),{code,authPlanSummary:p});};
 if(p.sourceRows!==expectedRows||p.targetRows!==expectedRows)reject('FINAL_HTTPS_COHORT_CHANGED');
 if(!p.canReconcileTwoTimestamps)reject('FINAL_HTTPS_OUTSIDE_TWO_TIMESTAMPS_DIFF');
 if(p.changedMatchedRows!==p.changedTimestampRows)reject('FINAL_HTTPS_PLAN_INCONSISTENT');
 return p;
}
const setup=async(db,readOnly=true)=>{
 await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
 await db.query("SET LOCAL timezone='UTC'");await db.query('SET LOCAL search_path=pg_catalog');
 await db.query("SET LOCAL statement_timeout='5000'");await db.query("SET LOCAL lock_timeout='5000'");
 await db.query("SET LOCAL idle_in_transaction_session_timeout='10000'");
};
const metadataValue=row=>{
 const value=row?.private_metadata;if(typeof value!=='string'||Buffer.byteLength(value)>1048576)
  fail('FINAL_HTTPS_TARGET_METADATA_INVALID');return value;
};
function beforeImage(receipt,a){
 if(receipt?.path!==a.beforeImagePath||receipt.durable!==true||receipt.fsynced!==true||receipt.rootOwned!==true||
  receipt.mode!=='0600'||!digest(receipt.sha256))fail('FINAL_HTTPS_BEFORE_IMAGE_NOT_DURABLE');
}

// captureSourceFrame MUST perform one fresh bounded HTTPS request per invocation;
// authenticate/decrypt/validate the pinned server response, and never cache a frame.
// Its pinned server must validate fenceWitness BEFORE the first working row and
// capture snapshot+Auth on that SAME RR READ ONLY client. No arbitrary client SQL.
// assertFence MUST assert CURRENT production state; a historical receipt is insufficient.
export async function runFinalHttpsWindow({activation:reviewedActivation,ownerDataGrant,fenceContext,
 captureSourceFrame,target,verifyTarget,assertFence,persistBeforeImage,
 snapshot=snapshotDatabase,fingerprintQuery=exactQueryFingerprint}){
 const a=Object.freeze({...reviewedActivation}),context=activation(a,ownerDataGrant,fenceContext);
 if([captureSourceFrame,verifyTarget,assertFence,persistBeforeImage,snapshot,fingerprintQuery].some(f=>typeof f!=='function')||
  typeof target?.query!=='function')fail('FINAL_HTTPS_DEPENDENCIES_REQUIRED');
 let targetWriteOutcome='UNCHANGED',durableBefore=null,transaction=false,commitAttempted=false;
 let phase='source-fence-start',sourceFrameAttempts=0,changedRows=0,initialAuthPlanSummary;
 const planned=(sourceRows,targetRows)=>checkedPlan(sourceRows,targetRows,a.expectedAuthRows);
 const assert=async stage=>fence(await assertFence(stage),a);
 const source=async stage=>{
  if(sourceFrameAttempts>=2)fail('FINAL_HTTPS_SOURCE_FRAME_BUDGET');
  sourceFrameAttempts++;return structuredClone(sourceFrame(await captureSourceFrame(stage),a,context));
 };
 const captureTarget=async()=>{
  let authRows,metadata;
  const db={query:async(sql,values)=>{
   const result=await target.query(sql,values);
   if(/^\s*begin\b/i.test(sql)){
    await target.query("SET LOCAL statement_timeout='5000'");await target.query("SET LOCAL lock_timeout='5000'");
    await target.query("SET LOCAL idle_in_transaction_session_timeout='10000'");
    await target.query("SET LOCAL timezone='UTC'");await target.query('SET LOCAL search_path=pg_catalog');
    await verifyTarget(target);
   }
   return result;
  }};
  const value=await snapshot(db,{fingerprintQuery,beforeCommit:async client=>{
   await verifyTarget(client);authRows=validateAuthRows((await client.query(authRowsSql)).rows);
   metadata=metadataValue((await client.query(targetMetadataSql)).rows[0]);
  }});
  validateSnapshot(value);if(!authRows||value['data:auth.users'].count!==authRows.length||metadata===undefined)
   fail('FINAL_HTTPS_TARGET_FRAME_NOT_PROVED');
  return structuredClone({snapshot:value,authRows,metadata});
 };
 try{
  await assert('start');phase='source-frame-before';const sourceBefore=await source('before');
  phase='target-frame-before';const targetBefore=await captureTarget();
  const groups=compareSnapshots(sourceBefore.snapshot,targetBefore.snapshot);
  if(groups.some(k=>k!=='data:auth.users'))mismatch('FINAL_HTTPS_NON_AUTH_STRICT_MISMATCH',groups);
  const plan=planned(sourceBefore.authRows,targetBefore.authRows);initialAuthPlanSummary=plan;
  changedRows=plan.changedTimestampRows;
  if(changedRows>a.maxAuthTimestampRows)throw Object.assign(new Error('FINAL_HTTPS_UPDATE_BUDGET'),{code:'FINAL_HTTPS_UPDATE_BUDGET',authPlanSummary:plan});
  if((groups.length===0)!==(changedRows===0))fail('FINAL_HTTPS_SNAPSHOT_CAPTURE_DRIFT');
  phase='source-fence-before-target-write';await assert('before-target-write');
  if(changedRows){
   phase='target-guarded-transaction';transaction=true;await setup(target,false);await verifyTarget(target);
   if(metadataValue((await target.query(targetMetadataSql)).rows[0])!==targetBefore.metadata)
    fail('FINAL_HTTPS_TARGET_METADATA_DRIFT');
   const locked=(await target.query(authRowsSql+' FOR UPDATE')).rows;
   const stable=authRowsPlan(targetBefore.authRows,locked);
   if(stable.sourceRows!==a.expectedAuthRows||stable.targetRows!==a.expectedAuthRows||stable.changedMatchedRows||
    stable.sourceOnlyRows||stable.targetOnlyRows)fail('FINAL_HTTPS_TARGET_CAPTURE_DRIFT');
   planned(sourceBefore.authRows,locked);
   const byId=new Map(sourceBefore.authRows.map(r=>[r.private_id,r]));
   const updates=locked.filter(r=>r.private_micros!==byId.get(r.private_id).private_micros||
     r.private_sign_in_micros!==byId.get(r.private_id).private_sign_in_micros)
    .map(r=>({target:r,source:byId.get(r.private_id)}));
   phase='target-before-image';
   const durable=await persistBeforeImage({format:1,actionId:a.actionId,manifestSha256:a.manifestSha256,
    sourceBarrierActionId:a.sourceBarrierActionId,sourceBarrierReceiptSha256:a.sourceBarrierReceiptSha256,
    ownerDataGrantEvidenceSha256:a.ownerDataGrantEvidenceSha256,fenceContextSha256:a.fenceContextSha256,
    targetMetadataBeforeSha256:hash(targetBefore.metadata),authTimestampColumns:AUTH_TIMESTAMP_COLUMNS,
    rows:updates.map(({target:r})=>({id:r.private_id,updated_at:r.private_stamp,last_sign_in_at:r.private_sign_in_stamp}))});
   beforeImage(durable,a);durableBefore=durable;
   phase='target-timestamp-updates';
   for(const {target:r,source:s} of updates){
    const result=await target.query(guardedUpdateSql,[s.private_stamp,s.private_sign_in_stamp,r.private_id,
     r.private_stamp,r.private_sign_in_stamp,r.private_other]);
    if(result.rowCount!==1)fail('FINAL_HTTPS_GUARDED_UPDATE_NOT_EXACTLY_ONE');
   }
   if(planned(sourceBefore.authRows,(await target.query(authRowsSql)).rows).changedMatchedRows)
    fail('FINAL_HTTPS_PRECOMMIT_AUTH_MISMATCH');
   if(metadataValue((await target.query(targetMetadataSql)).rows[0])!==targetBefore.metadata)
    fail('FINAL_HTTPS_TARGET_METADATA_DRIFT');
   phase='target-commit';commitAttempted=true;targetWriteOutcome='UNKNOWN';
   await target.query('COMMIT');transaction=false;targetWriteOutcome='COMMITTED';
  }
  phase='source-fence-before-final-audit';await assert('before-final-audit');
  phase='source-frame-after';const sourceAfter=await source('after');
  const sourceDiff=compareSnapshots(sourceBefore.snapshot,sourceAfter.snapshot);
  if(sourceDiff.length)mismatch('FINAL_HTTPS_SOURCE_CHANGED_UNDER_FENCE',sourceDiff);
  if(authRowsPlan(sourceBefore.authRows,sourceAfter.authRows).changedMatchedRows)
   fail('FINAL_HTTPS_SOURCE_CAPTURE_CHANGED_UNDER_FENCE');
  phase='target-frame-after';const targetAfter=await captureTarget();
  const strictMismatchGroups=compareSnapshots(sourceAfter.snapshot,targetAfter.snapshot);
  if(strictMismatchGroups.length)mismatch('FINAL_HTTPS_FINAL_STRICT_MISMATCH',strictMismatchGroups);
  if(planned(sourceAfter.authRows,targetAfter.authRows).changedMatchedRows)
   fail('FINAL_HTTPS_FINAL_AUTH_MISMATCH');
  if(targetAfter.metadata!==targetBefore.metadata)fail('FINAL_HTTPS_TARGET_METADATA_DRIFT');
  phase='source-fence-end';await assert('end');
  return {status:'PASS',finalFreezeAudit:true,strictMismatchGroups:[],changedAuthTimestampRows:changedRows,
   authTimestampColumns:AUTH_TIMESTAMP_COLUMNS,authPlanSummary:initialAuthPlanSummary,
   targetWriteOutcome,sourceFrameAttempts,sourceUnchangedUnderFence:true,targetRolesAndDatabaseUnchanged:true,
   sourceMustRemainClosed:true,beforeImage:durableBefore?{path:durableBefore.path,sha256:durableBefore.sha256}:null};
 }catch(error){
  if(transaction&&!commitAttempted){try{await target.query('ROLLBACK');transaction=false;targetWriteOutcome='ROLLED_BACK';}
   catch{targetWriteOutcome='UNKNOWN';}}
  const code=commitAttempted&&targetWriteOutcome==='UNKNOWN'?'FINAL_HTTPS_TARGET_COMMIT_UNKNOWN':
   /^FINAL_HTTPS_[A-Z_]+$/.test(error?.code??'')?error.code:'FINAL_HTTPS_WINDOW_FAILED';
  const upstreamCode=/^(?:T60_|T59_|AUTH_PLAN_|EXACT_FINGERPRINT_|MIGRATION_|T37_|HTTP_ADMISSION_)[A-Z0-9_]+$/.test(error?.code??'')||
   /^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:error?.message==='Query read timeout'?'PG_QUERY_READ_TIMEOUT':null;
  const mismatchGroups=Array.isArray(error?.mismatchGroups)?error.mismatchGroups.filter(k=>typeof k==='string'&&
   /^(?:data:(?:public|app_private|auth|storage)\.[a-z_][a-z0-9_]*|schema:[a-z_][a-z0-9_]*|sequence:(?:public|app_private)\.[a-z_][a-z0-9_]*)$/.test(k)).slice(0,200):[];
  throw Object.assign(new Error(code),{code,phase,upstreamCode,mismatchGroups,
   ...(typeof error?.budgetUncertain==='boolean'?{budgetUncertain:error.budgetUncertain}:{}),
   ...(typeof error?.claimMayBeConsumed==='boolean'?{claimMayBeConsumed:error.claimMayBeConsumed}:{}),
   authPlanSummary:error?.authPlanSummary??initialAuthPlanSummary,recovery:{targetWriteOutcome,
   sourceFrameAttempts,sourceMustRemainClosed:true,beforeImage:durableBefore?{path:durableBefore.path,sha256:durableBefore.sha256}:null}});
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 console.error('T60_FINAL_CORE_DRAFT_NOT_ACTIVATED');process.exitCode=2;
}
