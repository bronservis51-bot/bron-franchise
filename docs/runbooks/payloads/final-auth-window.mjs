// Import-only preparation. No credentials, connections or activation on import/CLI.
// The future reviewed runner owns route pins, durable guard/receipts and cleanup.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotDatabase,compareSnapshots} from '../../../scripts/migration-audit.mjs';
import {exactQueryFingerprint} from './exact-query-fingerprint.mjs';
import {captureAuthRows,authRowsPlan,authRowsSql} from './t30-auth-compact.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const failGroups=(code,groups)=>{throw Object.assign(new Error(code),{code,mismatchGroups:groups});};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const action=value=>/^T[1-9][0-9]{1,3}\.final_auth_window$/.test(value??'');
const barrierAction=value=>/^T[1-9][0-9]{1,3}\.http_source_admission$/.test(value??'');
const emptyDiff=(a,b)=>compareSnapshots(a,b).length===0;

// Stable, technical metadata only: deliberately excludes passwords, XIDs, stats.
export const targetMetadataSql=`SELECT jsonb_build_object(
 'database',(SELECT jsonb_build_object('name',d.datname,'owner',pg_get_userbyid(d.datdba),
   'encoding',d.encoding,'localeProvider',d.datlocprovider,'template',d.datistemplate,
   'allowConnections',d.datallowconn,'connectionLimit',d.datconnlimit,'collate',d.datcollate,
   'ctype',d.datctype,'locale',d.datlocale,'icuRules',d.daticurules,'collationVersion',d.datcollversion,
   'acl',d.datacl::text) FROM pg_database d WHERE d.datname=current_database()),
 'roles',(SELECT jsonb_agg(jsonb_build_object('name',r.rolname,'super',r.rolsuper,
   'inherit',r.rolinherit,'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'login',r.rolcanlogin,
   'replication',r.rolreplication,'bypass',r.rolbypassrls,'connectionLimit',r.rolconnlimit,
   'validUntil',r.rolvaliduntil::text,'config',r.rolconfig) ORDER BY r.rolname) FROM pg_roles r),
 'memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),
   'member',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),
   'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
   ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m),
 'settings',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',s.setrole,'database',s.setdatabase,
   'config',s.setconfig) ORDER BY s.setdatabase,s.setrole),'[]'::jsonb)
   FROM pg_db_role_setting s WHERE s.setdatabase IN(0,(SELECT oid FROM pg_database WHERE datname=current_database()))),
 'labels',(SELECT coalesce(jsonb_agg(jsonb_build_object('provider',l.provider,'label',l.label)
   ORDER BY l.provider,l.label),'[]'::jsonb) FROM pg_shseclabel l
   WHERE l.classoid='pg_database'::regclass AND l.objoid=(SELECT oid FROM pg_database WHERE datname=current_database()))
 )::text AS private_metadata`;

const setup=async(db,readOnly=true)=>{
 await db.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
 await db.query("SET LOCAL timezone='UTC'");
 await db.query("SET LOCAL search_path=pg_catalog");
 await db.query("SET LOCAL statement_timeout='5000'");
 await db.query("SET LOCAL lock_timeout='5000'");
};
async function metadata(db,verify){
 let primary,result;
 try{await setup(db);await verify(db);result=(await db.query(targetMetadataSql)).rows[0]?.private_metadata;
  if(typeof result!=='string'||result.length>1048576)fail('FINAL_AUTH_TARGET_METADATA_INVALID');}
 catch(error){primary=error;}
 finally{try{await db.query('ROLLBACK');}catch(error){primary??=error;}}
 if(primary)throw primary;return result;
}
function checkedPlan(sourceRows,targetRows,expectedRows){
 const plan=authRowsPlan(sourceRows,targetRows);
 if(plan.sourceRows!==expectedRows||plan.targetRows!==expectedRows)fail('FINAL_AUTH_COHORT_CHANGED');
 if(!plan.canReconcileTimestampOnly)fail('FINAL_AUTH_NON_TIMESTAMP_OR_DIRECTION_DIFF');
 if(plan.changedMatchedRows!==plan.changedUpdatedOnlyRows||plan.sourceNewerRows!==plan.changedUpdatedOnlyRows)
  fail('FINAL_AUTH_PLAN_INCONSISTENT');
 return plan;
}
function validateActivation(a){
 if(!action(a?.actionId)||a.reviewed!==true||!digest(a.manifestSha256)||
   !barrierAction(a.sourceBarrierActionId)||!digest(a.sourceBarrierReceiptSha256)||
   a.targetAdmitted!==false||a.sourceRoute!=='canonical-transaction-direct'||
   a.targetRoute!=='verified-loopback-15433'||a.expectedAuthRows!==16||!Number.isInteger(a.maxTimestampUpdates)||a.maxTimestampUpdates<0||a.maxTimestampUpdates>16||
   typeof a.beforeImagePath!=='string'||!/^\/root\/bron-secrets\/t[1-9][0-9]{1,3}-auth-before-[a-f0-9]{8,64}\.json$/.test(a.beforeImagePath))
  fail('FINAL_AUTH_DRAFT_NOT_REVIEWED');
}
function validateFence(proof,a){
 if(proof?.sourceBarrierActionId!==a.sourceBarrierActionId||proof.sourceBarrierReceiptSha256!==a.sourceBarrierReceiptSha256||
   ['normalConnectDenied','existingClientsDrained','freshOwnerReconnect','providerBoundaryReviewed','durableOnVps'].some(k=>proof[k]!==true)||
   proof.sourcePaused!==false)fail('FINAL_AUTH_DURABLE_SOURCE_FENCE_NOT_PROVED');
}
function validateBeforeImage(receipt,a){
 if(receipt?.path!==a.beforeImagePath||receipt.durable!==true||receipt.fsynced!==true||receipt.rootOwned!==true||
   receipt.mode!=='0600'||!digest(receipt.sha256))fail('FINAL_AUTH_BEFORE_IMAGE_NOT_DURABLE');
}

// persistBeforeImage MUST exclusively create+fsync a regular root:root0600 file in
// /root/bron-secrets0700 AND fsync its parent before returning this exact receipt.
// assertFence MUST perform a current production barrier assertion, not read only
// an old receipt or rely on this module's activation booleans.
export async function runFinalAuthWindow({activation:a,source,target,verifySource,verifyTarget,
 assertFence,persistBeforeImage,snapshot=snapshotDatabase,fingerprintQuery=exactQueryFingerprint}){
 validateActivation(a);
 if([verifySource,verifyTarget,assertFence,persistBeforeImage,snapshot,fingerprintQuery].some(f=>typeof f!=='function')||
   typeof source?.query!=='function'||typeof target?.query!=='function')fail('FINAL_AUTH_DEPENDENCIES_REQUIRED');
 let targetWriteOutcome='UNCHANGED',beforeImage=null,transaction=false,commitAttempted=false,changedRows=0,phase='source-fence-start';
 const fence=async stage=>validateFence(await assertFence(stage),a);
 const strict=async db=>snapshot({query:async(sql,values)=>{
  const result=await db.query(sql,values);
  if(/^\s*begin\b/i.test(sql)){
   await db.query("SET LOCAL statement_timeout='5000'");await db.query("SET LOCAL lock_timeout='5000'");
  }
  return result;
 }},{fingerprintQuery});
 try{
  await fence('start');
  phase='target-metadata-before';
  const metadataBefore=await metadata(target,verifyTarget);
  phase='source-strict-before';const sourceBefore=await strict(source);
  phase='target-strict-before';const targetBefore=await strict(target);
  const initialMismatchGroups=compareSnapshots(sourceBefore,targetBefore);
  if(initialMismatchGroups.some(k=>k!=='data:auth.users'))failGroups('FINAL_AUTH_NON_AUTH_STRICT_MISMATCH',initialMismatchGroups);
  phase='source-auth-capture';const sourceAuth=await captureAuthRows(source,verifySource);
  phase='target-auth-capture';const targetAuth=await captureAuthRows(target,verifyTarget);
  const plan=checkedPlan(sourceAuth.rows,targetAuth.rows,a.expectedAuthRows);
  changedRows=plan.changedUpdatedOnlyRows;
  if(changedRows>a.maxTimestampUpdates)fail('FINAL_AUTH_UPDATE_BUDGET');
  if((initialMismatchGroups.length===0)!==(changedRows===0))fail('FINAL_AUTH_SNAPSHOT_CAPTURE_DRIFT');
  phase='source-fence-before-target-write';await fence('before-target-write');
  if(changedRows){
   phase='target-guarded-transaction';
   transaction=true;await setup(target,false);
   await verifyTarget(target);
   if((await target.query(targetMetadataSql)).rows[0]?.private_metadata!==metadataBefore)fail('FINAL_AUTH_TARGET_METADATA_DRIFT');
   const locked=(await target.query(authRowsSql+' FOR UPDATE')).rows;
   const stable=authRowsPlan(targetAuth.rows,locked);
   if(stable.sourceRows!==a.expectedAuthRows||stable.targetRows!==a.expectedAuthRows||stable.changedMatchedRows||
     stable.sourceOnlyRows||stable.targetOnlyRows)fail('FINAL_AUTH_TARGET_CAPTURE_DRIFT');
   checkedPlan(sourceAuth.rows,locked,a.expectedAuthRows);
   const byId=new Map(sourceAuth.rows.map(row=>[row.private_id,row]));
   const updates=locked.filter(row=>row.private_micros!==byId.get(row.private_id).private_micros)
    .map(row=>({private_id:row.private_id,private_before:row.private_stamp,
     private_source:byId.get(row.private_id).private_stamp,private_other:row.private_other}));
   phase='target-before-image';
   const durable=await persistBeforeImage({format:1,actionId:a.actionId,manifestSha256:a.manifestSha256,
    sourceBarrierActionId:a.sourceBarrierActionId,sourceBarrierReceiptSha256:a.sourceBarrierReceiptSha256,
    targetMetadataBefore:metadataBefore,rows:updates});
   validateBeforeImage(durable,a);beforeImage=durable;
   phase='target-timestamp-updates';
   for(const row of updates){
    const result=await target.query(`UPDATE auth.users AS u SET updated_at=$1::timestamptz
     WHERE u.id=$2::uuid AND u.updated_at IS NOT DISTINCT FROM $3::timestamptz
     AND encode(pg_catalog.sha256(convert_to((to_jsonb(u)-'updated_at')::text,'UTF8')),'hex')=$4
     RETURNING 1 AS changed`,[row.private_source,row.private_id,row.private_before,row.private_other]);
    if(result.rowCount!==1)fail('FINAL_AUTH_GUARDED_UPDATE_NOT_EXACTLY_ONE');
   }
   const after=(await target.query(authRowsSql)).rows;
   if(checkedPlan(sourceAuth.rows,after,a.expectedAuthRows).changedMatchedRows)fail('FINAL_AUTH_PRECOMMIT_AUTH_MISMATCH');
   if((await target.query(targetMetadataSql)).rows[0]?.private_metadata!==metadataBefore)fail('FINAL_AUTH_TARGET_METADATA_DRIFT');
   phase='target-commit';commitAttempted=true;targetWriteOutcome='UNKNOWN';
   await target.query('COMMIT');transaction=false;targetWriteOutcome='COMMITTED';
  }
  phase='source-fence-before-final-audit';await fence('before-final-audit');
  phase='source-strict-after';const sourceAfter=await strict(source);
  phase='target-strict-after';const targetAfter=await strict(target);
  if(!emptyDiff(sourceBefore,sourceAfter))failGroups('FINAL_AUTH_SOURCE_CHANGED_UNDER_FENCE',compareSnapshots(sourceBefore,sourceAfter));
  const strictMismatchGroups=compareSnapshots(sourceAfter,targetAfter);
  if(strictMismatchGroups.length)failGroups('FINAL_AUTH_FINAL_STRICT_MISMATCH',strictMismatchGroups);
  phase='target-metadata-after';if(await metadata(target,verifyTarget)!==metadataBefore)fail('FINAL_AUTH_TARGET_METADATA_DRIFT');
  phase='source-fence-end';await fence('end');
  return {status:'PASS',finalFreezeAudit:true,strictMismatchGroups:[],changedAuthTimestampRows:changedRows,
   targetWriteOutcome,sourceUnchangedUnderFence:true,targetRolesAndDatabaseUnchanged:true,
   sourceMustRemainClosed:true,beforeImage:beforeImage?{path:beforeImage.path,sha256:beforeImage.sha256}:null};
 }catch(error){
  if(transaction&&!commitAttempted){
   try{await target.query('ROLLBACK');transaction=false;targetWriteOutcome='ROLLED_BACK';}
   catch{targetWriteOutcome='UNKNOWN';}
  }
  const safeCode=commitAttempted&&targetWriteOutcome==='UNKNOWN'?'FINAL_AUTH_TARGET_COMMIT_UNKNOWN':
   /^FINAL_AUTH_[A-Z_]+$/.test(error?.code??'')?error.code:'FINAL_AUTH_WINDOW_FAILED';
  const upstreamCode=/^(?:AUTH_PLAN_|EXACT_FINGERPRINT_|MIGRATION_)[A-Z0-9_]+$/.test(error?.code??'')||/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:
   error?.message==='Query read timeout'?'PG_QUERY_READ_TIMEOUT':null;
  const mismatchGroups=Array.isArray(error?.mismatchGroups)?error.mismatchGroups.filter(k=>typeof k==='string'&&
   /^(?:data:(?:public|app_private|auth|storage)\.[a-z_][a-z0-9_]*|schema:[a-z_][a-z0-9_]*|sequence:(?:public|app_private)\.[a-z_][a-z0-9_]*)$/.test(k)).slice(0,200):[];
  const safe=Object.assign(new Error(safeCode),{code:safeCode,phase,upstreamCode,mismatchGroups,recovery:{targetWriteOutcome,
   sourceMustRemainClosed:true,beforeImage:beforeImage?{path:beforeImage.path,sha256:beforeImage.sha256}:null}});
  throw safe;
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 console.error('FINAL_AUTH_WINDOW_DRAFT_NOT_ACTIVATED');process.exitCode=2;
}
