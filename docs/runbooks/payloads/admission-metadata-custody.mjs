// OFFLINE CORE ONLY. No filesystem, HTTP, credentials, SQL execution or Source effects.
// Callbacks run on the VPS: decrypted metadata and inverse SQL must never transit Mac.
// A reviewed adapter must check actual root files/fsync/readback; callback claims alone
// are not an OS proof. Lost acknowledgements fail closed and are never retried here.
import {createHash} from 'node:crypto';
import {beforeImageSql,makeHttpAdmissionPlan} from './http-source-admission.mjs';

const PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115',MAX=1048576;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const isSha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const ownError=Symbol('safe-custody-error');
const fail=code=>{throw Object.assign(new Error(code),{code,[ownError]:true});};
const exact=(x,keys)=>{
 if(x===null||typeof x!=='object'||Array.isArray(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x)))
  fail('ADMISSION_CUSTODY_SHAPE');
 const own=Reflect.ownKeys(x);
 if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)||
  !Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value')||!Object.getOwnPropertyDescriptor(x,k).enumerable))
  fail('ADMISSION_CUSTODY_SHAPE');
};
const integer=(x,max=2147483647)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
const text=x=>typeof x==='string'&&Buffer.byteLength(x)>0&&Buffer.byteLength(x)<=63&&!/[\x00-\x1f\x7f]/.test(x);
const array=(x,max)=>{
 if(!Array.isArray(x)||x.length>max||Reflect.ownKeys(x).length!==x.length+1)fail('ADMISSION_CUSTODY_METADATA_BOUND');
 for(let i=0;i<x.length;i++)if(!Object.hasOwn(x,i)||!Object.hasOwn(Object.getOwnPropertyDescriptor(x,i),'value')||
  !Object.getOwnPropertyDescriptor(x,i).enumerable)
  fail('ADMISSION_CUSTODY_METADATA_BOUND');
};
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>{
 const result=Buffer.from(canonical(x)+'\n');
 if(result.length>MAX)fail('ADMISSION_CUSTODY_METADATA_BOUND');
 return result;
};
const frozen=x=>{for(const v of Object.values(x))if(v&&typeof v==='object')frozen(v);return Object.freeze(x);};
export const metadataQuerySha256=sha(beforeImageSql);
const sqlKeys=['applySql','drainSql','verifyFencedSql','inverseSql','verifyOriginalSql'];
const roleKeys=['name','super','login','createRole','createDb','replication','bypass','connect','ownerPath'];
const backendKeys=['pid','role','type','state','openTransaction','super','providerAppKnown'];
const stateKeys=['db','actor','session','pid','readOnly','owner','signal','prepared','netQueued','runJobsExists',
 'unexpectedActiveCron','acl','roles','lookupOtherSetRoles','lookupCriticalWrites','lookupSequenceWrites',
 'lookupCriticalDefiners','backends','capturedMicros'];
// PostgreSQL extensions supply their own technical backend_type labels (cron/net
// included). Bound this existing field without pretending a closed enum fences workers.
const backendType=value=>typeof value==='string'&&/^[A-Za-z0-9_. -]{1,63}$/.test(value);
const backendStates=new Set(['active','idle','idle in transaction','idle in transaction (aborted)',
 'fastpath function call','disabled']);

// Exact stateSql fields only. In particular no Auth rows, hashes, role passwords,
// queries, cron command text, application names, client addresses or arbitrary data.
export function validateAdmissionMetadata(state){
 exact(state,stateKeys);
 if(['db','actor','session','owner'].some(k=>state[k]!=='postgres')||state.readOnly!=='on'||
  state.signal!==true||!integer(state.pid)||state.pid===0||typeof state.runJobsExists!=='boolean'||
  typeof state.capturedMicros!=='string'||!/^\d{12,20}$/.test(state.capturedMicros))fail('ADMISSION_CUSTODY_METADATA_IDENTITY');
 for(const k of ['prepared','netQueued','unexpectedActiveCron','lookupOtherSetRoles','lookupCriticalWrites',
  'lookupSequenceWrites','lookupCriticalDefiners'])if(!integer(state[k]))fail('ADMISSION_CUSTODY_METADATA_BOUND');
 array(state.roles,1024);array(state.acl,4096);array(state.backends,2048);
 for(const r of state.roles){exact(r,roleKeys);if(!text(r.name)||roleKeys.slice(1).some(k=>typeof r[k]!=='boolean'))
  fail('ADMISSION_CUSTODY_METADATA_SHAPE');}
 for(const e of state.acl){exact(e,['grantee','grantor','privilege','grantable']);
  if(!text(e.grantee)||!text(e.grantor)||!['CONNECT','CREATE','TEMPORARY'].includes(e.privilege)||typeof e.grantable!=='boolean')
   fail('ADMISSION_CUSTODY_METADATA_SHAPE');}
 for(const b of state.backends){exact(b,backendKeys);
  if(!integer(b.pid)||b.pid===0||(b.role!==null&&!text(b.role))||!backendType(b.type)||
   (b.state!==null&&!backendStates.has(b.state))||['openTransaction','super'].some(k=>typeof b[k]!=='boolean')||
   (b.providerAppKnown!==null&&typeof b.providerAppKnown!=='boolean'))
   fail('ADMISSION_CUSTODY_METADATA_SHAPE');}
 if(new Set(state.roles.map(r=>r.name)).size!==state.roles.length||
  new Set(state.backends.map(b=>b.pid)).size!==state.backends.length||
  new Set(state.acl.map(canonical)).size!==state.acl.length)fail('ADMISSION_CUSTODY_METADATA_DUPLICATE');
 // Canonical file readback and JSONB/MCP can have different object key order.
 // Common plan embeds JSON text: normalize identically on VPS AND Root first.
 bytes(state);return JSON.parse(canonical(state));
}

const activationKeys=['reviewed','actionId','manifestSha256','sourceProject','destinationVps','metadataReadAuthorized',
 'metadataOnly','sourceRoute','macDataTransit','targetWritesStarted','beforeImagePath','metadataReceiptPath',
 'inversePath','controlReceiptPath'];
const controlKeys=['controlTaskAuthorized','providerBoundaryReviewed','rollbackBeforeTargetWrites',
 'independentKeyProofPath','independentKeyProofSha256','recoveryCipherSha256'];
function activation(a,control=false){
 if(!a||typeof a!=='object')fail('ADMISSION_CUSTODY_TASK_NOT_REVIEWED');
 exact(a,[...activationKeys,...controlKeys.filter(k=>Object.hasOwn(a,k))]);
 const task=typeof a.actionId==='string'?/^(T[1-9][0-9]{1,3})\.http_source_admission$/.exec(a.actionId)?.[1]:null;
 if(!task||a.reviewed!==true||!isSha(a.manifestSha256)||a.sourceProject!==PROJECT||a.destinationVps!==VPS||
  a.metadataReadAuthorized!==true||a.metadataOnly!==true||a.sourceRoute!=='fixed-source-edge-https'||
  a.macDataTransit!==false||a.targetWritesStarted!==false)fail('ADMISSION_CUSTODY_TASK_NOT_REVIEWED');
 let suffix;
 for(const [k,kind,ext] of [['beforeImagePath','before','json'],['metadataReceiptPath','metadata','json'],
  ['inversePath','inverse','sql'],['controlReceiptPath','control','json']]){
  const match=typeof a[k]==='string'?new RegExp('^/root/bron-secrets/'+task.toLowerCase()+'-admission-'+kind+'-([a-f0-9]{8,64})\\.'+ext+'$').exec(a[k]):null;
  if(!match||(suffix&&suffix!==match[1]))fail('ADMISSION_CUSTODY_PATH');suffix=match[1];
 }
 if(control&&(a.controlTaskAuthorized!==true||a.providerBoundaryReviewed!==true||a.rollbackBeforeTargetWrites!==true||
  !isSha(a.independentKeyProofSha256)||!isSha(a.recoveryCipherSha256)||
  typeof a.independentKeyProofPath!=='string'||
  !new RegExp('^/root/bron-secrets/'+task.toLowerCase()+'-admission-key-proof-'+suffix+'\\.json$').test(a.independentKeyProofPath)))
  fail('ADMISSION_CUSTODY_CONTROL_NOT_AUTHORIZED');
 return Object.freeze(Object.fromEntries(['actionId','manifestSha256','sourceProject','destinationVps'].map(k=>[k,a[k]])));
}

const artifactKeys=['path','sha256','bytes','uid','gid','mode','regularFile','symlink','nlink','readbackSha256'];
function artifact(e,path,content,durable=false){
 exact(e,[...artifactKeys,...(durable?['exclusive','fileFsynced','directoryFsynced']:[])]);
 if(e.path!==path||e.sha256!==sha(content)||e.readbackSha256!==sha(content)||e.bytes!==content.length||
  e.uid!==0||e.gid!==0||e.mode!==0o600||e.regularFile!==true||e.symlink!==false||e.nlink!==1||
  (durable&&[e.exclusive,e.fileFsynced,e.directoryFsynced].some(x=>x!==true)))fail('ADMISSION_CUSTODY_DURABILITY_NOT_PROVED');
}
const beforeBody=(context,state)=>({format:1,kind:'source-admission-metadata-only',...context,metadataQuerySha256,state});
function metadataReceipt(a,context,state){
 return {format:1,status:'METADATA_PREPARED',...context,metadataQuerySha256,
  capturedMicros:state.capturedMicros,beforeImagePath:a.beforeImagePath,metadataReceiptPath:a.metadataReceiptPath,
  beforeImageSha256:sha(bytes(beforeBody(context,state))),beforeImageDurableOnVps:true,
  counts:{roles:state.roles.length,acl:state.acl.length,backends:state.backends.length},
  ownerPids:state.backends.filter(b=>b.role==='postgres').map(b=>b.pid).sort((x,y)=>x-y),
  sourceEffects:false,sourceBarrierPass:false,rootComparisonRequired:true};
}
const receiptResult=body=>frozen({...body,receiptSha256:sha(bytes(body))});
function matchReceipt(actual,expected){
 exact(actual,[...Object.keys(expected),'receiptSha256']);
 safeSummary(actual);
 if(Object.keys(expected).some(k=>canonical(actual[k])!==canonical(expected[k]))||actual.receiptSha256!==sha(bytes(expected)))
  fail('ADMISSION_CUSTODY_RECEIPT_MISMATCH');
}
function safeSummary(receipt){
 exact(receipt.counts,['roles','acl','backends']);
 if(!integer(receipt.counts.roles,1024)||!integer(receipt.counts.acl,4096)||!integer(receipt.counts.backends,2048))
  fail('ADMISSION_CUSTODY_RECEIPT_MISMATCH');
 array(receipt.ownerPids,2048);
 if(!receipt.ownerPids.every(pid=>integer(pid)&&pid>0)||
  Object.entries(receipt).some(([k,v])=>!['counts','ownerPids','sqlHashes'].includes(k)&&
   !['string','number','boolean'].includes(typeof v)))fail('ADMISSION_CUSTODY_RECEIPT_MISMATCH');
 for(const value of Object.values(receipt))if(typeof value==='string'&&Buffer.byteLength(value)>512)
  fail('ADMISSION_CUSTODY_RECEIPT_MISMATCH');
}
function safeFailure(error,phase){
 const code=error?.[ownError]===true?error.code:'ADMISSION_CUSTODY_CALLBACK_UNCERTAIN';
 return Object.assign(new Error(code),{code,phase,custody:'UNKNOWN',sourceEffects:false,retryAllowed:false});
}
const callback=fn=>{if(typeof fn!=='function')fail('ADMISSION_CUSTODY_CALLBACK_REQUIRED');};

// persist callbacks receive private bytes only inside the VPS process. They must
// exclusive-create, fsync file AND parent, read back, and return exact evidence.
// Persisted METADATA_PREPARED is safe to emit even while the owner key is pending.
export async function captureMetadataCustody({activation:a,readEncryptedMetadata,persistBeforeImage,persistReceipt}){
 let phase='activation';
 try{
  const context=activation(a);a=Object.freeze({...a});[readEncryptedMetadata,persistBeforeImage,persistReceipt].forEach(callback);
  phase='read-metadata';const state=validateAdmissionMetadata(await readEncryptedMetadata({...context,metadataQuerySha256}));
  const content=bytes(beforeBody(context,state));
  phase='persist-before-image';artifact(await persistBeforeImage({path:a.beforeImagePath,bytes:Buffer.from(content),
   sha256:sha(content),context}),a.beforeImagePath,content,true);
  const receipt=metadataReceipt(a,context,state),encoded=bytes(receipt);
  phase='persist-metadata-receipt';artifact(await persistReceipt({path:a.metadataReceiptPath,bytes:Buffer.from(encoded),
   sha256:sha(encoded),context}),a.metadataReceiptPath,encoded,true);
  return receiptResult(receipt);
 }catch(error){throw safeFailure(error,phase);}
}

// No key or identity is accepted. The runner reads a pinned root-only proof
// envelope, compiled from actual T30 crypto PASS plus separate owner attestation.
// A task boolean such as independentKeyProved is deliberately not accepted.
async function checkedKeyProof(a,readIndependentKeyProof){
 callback(readIndependentKeyProof);
 const loaded=await readIndependentKeyProof({path:a.independentKeyProofPath,sha256:a.independentKeyProofSha256});
 exact(loaded,['proof','artifact']);const p=loaded.proof;
 exact(p,['format','sourceProject','destinationVps','crypto','attestation']);
 exact(p.crypto,['status','cipherSha256','cipherShaVerified','decryptionVerified','identityStored','plaintextStored']);
 exact(p.attestation,['independentCopy','personalSecondDeviceLogin','evidenceSha256']);
 if(p.format!==1||p.sourceProject!==PROJECT||p.destinationVps!==VPS||
  p.crypto.status!=='PASS'||p.crypto.cipherSha256!==a.recoveryCipherSha256||p.crypto.cipherShaVerified!==true||
  p.crypto.decryptionVerified!==true||p.crypto.identityStored!==false||p.crypto.plaintextStored!==false||
  p.attestation.independentCopy!==true||p.attestation.personalSecondDeviceLogin!==true||!isSha(p.attestation.evidenceSha256))
  fail('ADMISSION_CUSTODY_INDEPENDENT_KEY_NOT_PROVED');
 const encoded=bytes(p);
 artifact(loaded.artifact,a.independentKeyProofPath,encoded);
 if(sha(encoded)!==a.independentKeyProofSha256)fail('ADMISSION_CUSTODY_INDEPENDENT_KEY_NOT_PROVED');
 return true;
}

export function hashAdmissionPlan(plan){
 if(!plan||sqlKeys.some(k=>typeof plan[k]!=='string'||!plan[k].length||Buffer.byteLength(plan[k])>MAX))
  fail('ADMISSION_CUSTODY_PLAN_INVALID');
 return Object.fromEntries(sqlKeys.map(k=>[k,sha(plan[k])]));
}

// before and file bytes stay on VPS. confirmPreparedCustody must independently
// reread/stat both existing artifacts; it must not recreate a missing/lost ACK file.
export async function makeControlReady({activation:a,before,stateReceipt,confirmPreparedCustody,
 readIndependentKeyProof,persistInverse,persistReceipt}){
 let phase='activation';
 try{
  const context=activation(a,true);a=Object.freeze({...a});[confirmPreparedCustody,persistInverse,persistReceipt].forEach(callback);
  const state=validateAdmissionMetadata(before),prepared=metadataReceipt(a,context,state);
  matchReceipt(stateReceipt,prepared);
  phase='confirm-prepared-custody';
  const confirmed=await confirmPreparedCustody({beforeImagePath:a.beforeImagePath,beforeImageSha256:prepared.beforeImageSha256,
   metadataReceiptPath:a.metadataReceiptPath,metadataReceiptSha256:stateReceipt.receiptSha256});
  exact(confirmed,['beforeImage','metadataReceipt']);
  artifact(confirmed.beforeImage,a.beforeImagePath,bytes(beforeBody(context,state)));
  artifact(confirmed.metadataReceipt,a.metadataReceiptPath,bytes(prepared));
  phase='independent-key-proof';const independentKeyProved=await checkedKeyProof(a,readIndependentKeyProof);
  phase='make-control-plan';
  let plan;
  try{plan=makeHttpAdmissionPlan({activation:{reviewed:a.reviewed,actionId:a.actionId,manifestSha256:a.manifestSha256,
   beforeImageSha256:prepared.beforeImageSha256,beforeImageDurableOnVps:true,providerBoundaryReviewed:a.providerBoundaryReviewed,
   independentKeyProved,rollbackBeforeTargetWrites:a.rollbackBeforeTargetWrites,targetWritesStarted:a.targetWritesStarted},before:state});}
  catch{fail('ADMISSION_CUSTODY_SOURCE_PLAN_REJECTED');}
  const sqlHashes=hashAdmissionPlan(plan),inverse=Buffer.from(plan.inverseSql);
  phase='persist-exact-inverse';artifact(await persistInverse({path:a.inversePath,bytes:Buffer.from(inverse),
   sha256:sqlHashes.inverseSql,context}),a.inversePath,inverse,true);
  const receipt={...prepared,status:'CONTROL_READY',metadataReceiptSha256:stateReceipt.receiptSha256,
   inversePath:a.inversePath,controlReceiptPath:a.controlReceiptPath,inverseDurableOnVps:true,sqlHashes,
   independentKeyProofSha256:a.independentKeyProofSha256,recoveryCipherSha256:a.recoveryCipherSha256,
   providerSuperusersFenced:false,actualSupavisorRecovery:'NOT_TESTED'};
  const encoded=bytes(receipt);
  phase='persist-control-receipt';artifact(await persistReceipt({path:a.controlReceiptPath,bytes:Buffer.from(encoded),
   sha256:sha(encoded),context}),a.controlReceiptPath,encoded,true);
  return receiptResult(receipt);
 }catch(error){throw safeFailure(error,phase);}
}

// Root reconstructs the common plan using before:validateAdmissionMetadata(rawMcp)
// from an INDEPENDENT harmless MCP observation, only after the checked key gate,
// then calls hashAdmissionPlan and this matcher. This shared normalization is
// required: canonical durable JSON and MCP JSON object key order can differ.
// Matching hashes do not authorize effects, prove a fence, or permit Source reopen.
export function matchIndependentControlHashes({activation:a,controlReceipt,independentHashes}){
 const context=activation(a,true);
 const keys=['format','status',...Object.keys(context),'metadataQuerySha256','capturedMicros','beforeImagePath',
  'metadataReceiptPath','beforeImageSha256','beforeImageDurableOnVps','counts','ownerPids','sourceEffects',
  'sourceBarrierPass','rootComparisonRequired','metadataReceiptSha256','inversePath','controlReceiptPath',
  'inverseDurableOnVps','sqlHashes','independentKeyProofSha256','recoveryCipherSha256','providerSuperusersFenced',
  'actualSupavisorRecovery','receiptSha256'];
 exact(controlReceipt,keys);exact(independentHashes,sqlKeys);exact(controlReceipt.sqlHashes,sqlKeys);
 safeSummary(controlReceipt);
 if(sqlKeys.some(k=>!isSha(controlReceipt.sqlHashes[k])))fail('ADMISSION_CUSTODY_INDEPENDENT_HASH_MISMATCH');
 const {receiptSha256,...body}=controlReceipt;
 if(receiptSha256!==sha(bytes(body))||controlReceipt.format!==1||controlReceipt.status!=='CONTROL_READY'||
  Object.entries(context).some(([k,v])=>controlReceipt[k]!==v)||
  controlReceipt.independentKeyProofSha256!==a.independentKeyProofSha256||
  controlReceipt.recoveryCipherSha256!==a.recoveryCipherSha256||
  controlReceipt.metadataQuerySha256!==metadataQuerySha256||
  controlReceipt.beforeImagePath!==a.beforeImagePath||controlReceipt.metadataReceiptPath!==a.metadataReceiptPath||
  controlReceipt.inversePath!==a.inversePath||controlReceipt.controlReceiptPath!==a.controlReceiptPath||
  controlReceipt.beforeImageDurableOnVps!==true||controlReceipt.inverseDurableOnVps!==true||
  controlReceipt.sourceEffects!==false||controlReceipt.sourceBarrierPass!==false||controlReceipt.rootComparisonRequired!==true||
  controlReceipt.providerSuperusersFenced!==false||controlReceipt.actualSupavisorRecovery!=='NOT_TESTED'||
  !isSha(controlReceipt.beforeImageSha256)||!isSha(controlReceipt.metadataReceiptSha256)||
  !/^\d{12,20}$/.test(controlReceipt.capturedMicros)||
  sqlKeys.some(k=>!isSha(independentHashes[k])||independentHashes[k]!==controlReceipt.sqlHashes[k]))
  fail('ADMISSION_CUSTODY_INDEPENDENT_HASH_MISMATCH');
 return frozen({status:'CONTROL_HASHES_MATCH',...context,controlReceiptSha256:receiptSha256,
  sqlHashes:{...independentHashes},sourceEffects:false,sourceBarrierPass:false});
}
