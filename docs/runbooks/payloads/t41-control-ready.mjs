// T41 local custody preparation only: adopts T40 metadata; never executes SQL or reads a key/backup.
import fs from 'node:fs';
import path from 'node:path';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {makeControlReady,metadataQuerySha256} from './admission-metadata-custody.mjs';
import {createAdmissionCustodyFs} from './admission-custody-fs.mjs';

const ROOT='/root/bron-secrets',DIRECTORY=ROOT+'/t41-release',RUNTIME=ROOT+'/t41-runtime';
const SELF=RUNTIME+'/docs/runbooks/payloads/t41-control-ready.mjs',MANIFEST=DIRECTORY+'/manifest.json';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115';
const ACTION='T41.prepare_control_ready',PARENT_ACTION='T41.release_window',ADOPTED_ACTION='T40.http_source_admission';
const ADOPTED_MANIFEST='a8f777d95d53b365959530a0bbce4a42b21840dc92bf1180c65eaa7dd74136f8';
const PATHS={beforeImagePath:ROOT+'/t40-admission-before-c40a2026.json',metadataReceiptPath:ROOT+'/t40-admission-metadata-c40a2026.json',
 inversePath:ROOT+'/t40-admission-inverse-c40a2026.sql',controlReceiptPath:ROOT+'/t40-admission-control-c40a2026.json'};
const KEY_PROOF=ROOT+'/t40-admission-key-proof-c40a2026.json';
const OWNER_PATHS={crypto:ROOT+'/t30-owner-key-proof-result.json',attestation:ROOT+'/t30-owner-key-attestation.json',receipt:ROOT+'/t30-release-receipt.json'};
const FILE_KEY='docs/runbooks/payloads/t41-control-ready.mjs',MAX=1048576;
const RUNTIME_FILES=['t41-control-ready.mjs','admission-metadata-custody.mjs','admission-custody-fs.mjs','http-source-admission.mjs','t26-source-admission.mjs']
 .map(p=>RUNTIME+'/docs/runbooks/payloads/'+p);
const sha=b=>createHash('sha256').update(b).digest('hex'),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const canonical=o=>JSON.stringify(o,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=o=>Buffer.from(canonical(o)+'\n');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const ownerFail=code=>{throw Object.assign(new Error(code),{code,status:'BLOCKED_OWNER_PROOF'});};
const upstream=error=>/^(?:ADMISSION_FS_|ADMISSION_CUSTODY_|HTTP_ADMISSION_)[A-Z0-9_]{1,60}$/.test(error?.code??'')?error.code:null;
const phases=new Set(['activation','confirm-prepared-custody','independent-key-proof','make-control-plan','persist-exact-inverse','persist-control-receipt']);
const pending=error=>error?.status==='BLOCKED_OWNER_PROOF'||['ADMISSION_FS_OWNER_PROOF_PENDING','ADMISSION_FS_OWNER_CRYPTO_REQUIRED',
 'ADMISSION_FS_OWNER_ATTESTATION_REQUIRED','ADMISSION_FS_CIPHER_BINDING_REQUIRED','ADMISSION_FS_OWNER_ENVELOPE_PIN'].includes(error?.code);

function policy(m){
 if(m?.task!=='T41'||m.execution_authorized!==true||m.actionId!==PARENT_ACTION||
  m.adopts?.actionId!==ADOPTED_ACTION||m.adopts.manifestSha256!==ADOPTED_MANIFEST||
  !exact(m.adopts.custody,Object.keys(PATHS))||Object.entries(PATHS).some(([k,p])=>m.adopts.custody[k]!==p)||
  m.phase_authorizations?.prepare_control_ready?.actionId!==ACTION||
  m.phase_authorizations.prepare_control_ready.control_ready_only!==true||m.phase_authorizations.prepare_control_ready.source_sql_authorized!==false||
  m.phase_authorizations.prepare_control_ready.provider_boundary_reviewed!==true||m.phase_authorizations.prepare_control_ready.rollback_before_target_writes!==true)
  fail('T41_TASK_SCOPE');
 const e=m.input_evidence;
 if(!['T40_result_sha256','T40_receipt_sha256','T40_before_image_sha256','T40_metadata_receipt_sha256'].every(k=>digest(e?.[k])))
  fail('T41_T40_PINS_REQUIRED');
 const p=m.owner_proof,i=p?.inputs,b=i?.reviewedT30CipherBinding;
 if(!digest(p?.independentProofSha256)||!digest(p.recoveryCipherSha256)||
  !exact(i,['crypto','attestation','receipt','reviewedT30CipherBinding'])||
  Object.entries(OWNER_PATHS).some(([k,path])=>!exact(i[k],['path','sha256'])||i[k].path!==path||!digest(i[k].sha256))||
  !exact(b,['reviewed','task','cryptoResultSha256','sourceReceiptSha256','cipherSha256'])||b.reviewed!==true||b.task!=='T30'||
  b.cryptoResultSha256!==i.crypto.sha256||b.sourceReceiptSha256!==i.receipt.sha256||b.cipherSha256!==p.recoveryCipherSha256)
  ownerFail('T41_OWNER_PROOF_PINS_REQUIRED');
 return m;
}
export function validateManifest(raw,manifestSha256,selfSha256){
 if(!digest(manifestSha256)||sha(raw)!==manifestSha256)fail('T41_MANIFEST_SHA');let m;
 try{m=JSON.parse(raw);}catch{fail('T41_MANIFEST_JSON');}policy(m);
 if(!digest(selfSha256)||m.files?.[FILE_KEY]!==selfSha256)fail('T41_SELF_SHA');
 if(!m.runtime_files||RUNTIME_FILES.some(p=>!digest(m.runtime_files[p])))fail('T41_RUNTIME_PINS');
 return m;
}
export function activationFromManifest(m){
 policy(m);
 return {reviewed:true,actionId:ADOPTED_ACTION,manifestSha256:ADOPTED_MANIFEST,sourceProject:PROJECT,destinationVps:VPS,
  metadataReadAuthorized:true,metadataOnly:true,sourceRoute:'fixed-source-edge-https',macDataTransit:false,targetWritesStarted:false,
  ...PATHS,controlTaskAuthorized:true,providerBoundaryReviewed:m.phase_authorizations.prepare_control_ready.provider_boundary_reviewed,
  rollbackBeforeTargetWrites:m.phase_authorizations.prepare_control_ready.rollback_before_target_writes,independentKeyProofPath:KEY_PROOF,
  independentKeyProofSha256:m.owner_proof.independentProofSha256,recoveryCipherSha256:m.owner_proof.recoveryCipherSha256};
}
export function validateT40Result(raw,pin,evidence){
 if(!digest(pin)||sha(raw)!==pin)fail('T41_T40_RESULT_SHA');let r;
 try{r=JSON.parse(raw);}catch{fail('T41_T40_RESULT_INVALID');}const s=r?.metadataReceipt;
 if(r?.task!=='T40'||r.status!=='METADATA_PREPARED'||r.sourceMetadataReadAttempted!==true||r.sourceMetadataRead!==true||
  r.sourceAuthUserRead!==false||r.sourceBusinessDataRead!==false||r.sourceEffects!==false||r.sourceBarrierPass!==false||
  r.controlReady!==false||r.macDataTransit!==false||r.authBudgetBefore!==1||r.authBudgetAfter!==1||
  s?.status!=='METADATA_PREPARED'||s.actionId!==ADOPTED_ACTION||s.manifestSha256!==ADOPTED_MANIFEST||
  s.sourceProject!==PROJECT||s.destinationVps!==VPS||s.metadataQuerySha256!==metadataQuerySha256||
  s.beforeImagePath!==PATHS.beforeImagePath||s.metadataReceiptPath!==PATHS.metadataReceiptPath||
  s.beforeImageSha256!==evidence?.T40_before_image_sha256||s.receiptSha256!==evidence?.T40_metadata_receipt_sha256)
  fail('T41_T40_RESULT_INVALID');return true;
}
export function validateOwnerProof({cryptoBytes,attestationBytes,receiptBytes,cryptoMtimeMs},ownerProof,now=Date.now()){
 const i=ownerProof?.inputs;
 if(!i||sha(cryptoBytes)!==i.crypto?.sha256||sha(attestationBytes)!==i.attestation?.sha256||sha(receiptBytes)!==i.receipt?.sha256)
  ownerFail('T41_OWNER_PROOF_SHA');let c,a;
 try{c=JSON.parse(cryptoBytes);a=JSON.parse(attestationBytes);}catch{ownerFail('T41_OWNER_PROOF_JSON');}
 if(!exact(c,['status','cipherShaVerified','decryptionVerified','plaintextStored','identityStored','externalCustody'])||
  c.status!=='PASS'||c.cipherShaVerified!==true||c.decryptionVerified!==true||c.plaintextStored!==false||c.identityStored!==false||
  c.externalCustody!=='OWNER_CONFIRMATION_REQUIRED')ownerFail('T41_OWNER_CRYPTO_REQUIRED');
 if(!exact(a,['task','action','cryptoResultSha256','sourceReceiptPath','sourceReceiptSha256','independentCopy','personalSecondDeviceLogin',
  'witnessedBy','deviceClass','observedUtc']))ownerFail('T41_OWNER_ATTESTATION_REQUIRED');
 const observed=Date.parse(a.observedUtc);
 if(a.task!=='T30'||a.action!=='owner_key_proof'||a.cryptoResultSha256!==i.crypto.sha256||a.sourceReceiptPath!==OWNER_PATHS.receipt||
  a.sourceReceiptSha256!==i.receipt.sha256||a.independentCopy!==true||a.personalSecondDeviceLogin!==true||a.witnessedBy!=='owner'||
  !['phone','second-device'].includes(a.deviceClass)||typeof a.observedUtc!=='string'||!/(?:Z|\+00:00)$/.test(a.observedUtc)||
  !Number.isFinite(observed)||observed>now+5000||!Number.isFinite(cryptoMtimeMs)||cryptoMtimeMs>observed+60000)
  ownerFail('T41_OWNER_ATTESTATION_REQUIRED');
 const proof={format:1,sourceProject:PROJECT,destinationVps:VPS,
  crypto:{status:'PASS',cipherSha256:ownerProof.recoveryCipherSha256,cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
  attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:i.attestation.sha256}};
 if(sha(encode(proof))!==ownerProof.independentProofSha256)ownerFail('T41_OWNER_ENVELOPE_SHA');return true;
}

// Adapter is the reviewed createAdmissionCustodyFs instance in production; synthetic
// fixture adapters may exercise the core, but cannot establish real root-file custody.
export async function runControlReady({manifest,authorizationManifestSha256,adapter,guard,assertPinnedInputs}){
 const m=structuredClone(manifest),a=activationFromManifest(m);
 if(!digest(authorizationManifestSha256)||typeof guard!=='function'||typeof assertPinnedInputs!=='function'||
  ['prepareIndependentKeyProof','loadPrepared','confirmPreparedCustody','readIndependentKeyProof','persistInverse','persistReceipt'].some(k=>typeof adapter?.[k]!=='function'))
  fail('T41_ADAPTER_REQUIRED');
 let phase='preflight',upstreamCode=null;
 const checked=fn=>async request=>{try{return await fn(request);}catch(error){upstreamCode=upstream(error);throw error;}};
 try{
  await assertPinnedInputs();phase='guard';await guard();phase='prepare-owner-proof';
  const key=await adapter.prepareIndependentKeyProof();
  if(key?.status!=='KEY_PROOF_DURABLE'||key.path!==KEY_PROOF||key.sha256!==a.independentKeyProofSha256)fail('T41_OWNER_PROOF_NOT_DURABLE');
  phase='load-t40-metadata';const prepared=await adapter.loadPrepared();
  if(prepared?.stateReceipt?.actionId!==ADOPTED_ACTION||prepared.stateReceipt.manifestSha256!==ADOPTED_MANIFEST||
   prepared.stateReceipt.beforeImageSha256!==m.input_evidence.T40_before_image_sha256||
   prepared.stateReceipt.receiptSha256!==m.input_evidence.T40_metadata_receipt_sha256)fail('T41_ADOPTED_ARTIFACTS_CHANGED');
  phase='make-control-ready';
  const ready=await makeControlReady({activation:a,before:prepared.before,stateReceipt:prepared.stateReceipt,confirmPreparedCustody:checked(adapter.confirmPreparedCustody),
   readIndependentKeyProof:checked(adapter.readIndependentKeyProof),persistInverse:checked(adapter.persistInverse),persistReceipt:checked(adapter.persistReceipt)});
  phase='confirm-inputs-unchanged';await assertPinnedInputs();
  return {task:'T41',status:'CONTROL_READY',actionId:ACTION,parentActionId:PARENT_ACTION,authorizationManifestSha256,
   adoptedActionId:ADOPTED_ACTION,adoptedManifestSha256:ADOPTED_MANIFEST,
   beforeImagePath:PATHS.beforeImagePath,beforeImageSha256:ready.beforeImageSha256,
   metadataReceiptPath:PATHS.metadataReceiptPath,metadataReceiptSha256:ready.metadataReceiptSha256,
   independentKeyProofPath:KEY_PROOF,independentKeyProofSha256:ready.independentKeyProofSha256,
   inversePath:PATHS.inversePath,inverseSha256:ready.sqlHashes.inverseSql,
   controlReceiptPath:PATHS.controlReceiptPath,controlReceiptSha256:ready.receiptSha256,sqlHashes:structuredClone(ready.sqlHashes),
   t40ArtifactsUnchanged:true,rootComparisonRequired:true,sourceEffects:false,sourceBarrierPass:false,targetWritesStarted:false,
   providerSuperusersFenced:false,actualSupavisorRecovery:'NOT_TESTED',macDataTransit:false};
 }catch(error){
  const owner=pending(error)||pending({code:upstreamCode}),code=owner?'T41_OWNER_PROOF_REQUIRED':/^T41_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'T41_CONTROL_PREPARATION_FAILED';
  throw Object.assign(new Error(code),{code,status:owner?'BLOCKED_OWNER_PROOF':'BLOCKED',phase,
   ...(phases.has(error?.phase)?{custodyPhase:error.phase}:{}),...((upstreamCode??upstream(error))?{upstreamCode:upstreamCode??upstream(error)}:{}),
   sourceEffects:false,sourceBarrierPass:false,retryAllowed:false});
 }
}
function directory(p){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||(s.mode&0o7777)!==0o700)fail('T41_PRIVATE_DIRECTORY');}
function privateFile(p,max=MAX){const f=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(f);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>max)fail('T41_PRIVATE_FILE');
  const bytes=fs.readFileSync(f),after=fs.fstatSync(f);if(bytes.length!==s.size||s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.ctimeMs!==after.ctimeMs)fail('T41_PRIVATE_FILE_CHANGED');
  return {bytes,mtimeMs:s.mtimeMs};}finally{fs.closeSync(f);}}
const read=p=>privateFile(p).bytes;
function writeNew(p,bytes){const f=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(f,bytes);fs.fsyncSync(f);}finally{fs.closeSync(f);}const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(d);}finally{fs.closeSync(d);}if(!read(p).equals(Buffer.from(bytes)))fail('T41_WRITE_READBACK');}
function absent(paths){for(const p of paths)try{fs.lstatSync(p);fail('T41_ALREADY_STARTED');}catch(error){if(error.code!=='ENOENT')throw error;}}
async function main(){let phase='preflight',adapter,guard=false;
 let result={task:'T41',status:'BLOCKED',sourceEffects:false,sourceBarrierPass:false,targetWritesStarted:false,macDataTransit:false};
 try{
  if(process.argv.length!==7||process.argv[2]!=='--prepare-control'||process.argv[3]!=='--manifest'||process.argv[4]!==MANIFEST||
   process.argv[5]!=='--sha256'||!digest(process.argv[6]))fail('T41_EXPLICIT_REVIEW_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||
   fileURLToPath(import.meta.url)!==SELF||!Object.values(networkInterfaces()).flat().some(i=>i?.address===VPS))fail('T41_PINNED_VPS_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const d of ['/root',ROOT,DIRECTORY,RUNTIME,RUNTIME+'/docs',RUNTIME+'/docs/runbooks',RUNTIME+'/docs/runbooks/payloads'])directory(d);
  const m=validateManifest(read(MANIFEST),process.argv[6],sha(read(SELF)));
  for(const p of RUNTIME_FILES)if(sha(read(p))!==m.runtime_files[p])fail('T41_RUNTIME_SHA');
  const verify=()=>{
   validateT40Result(read(ROOT+'/t40-metadata-custody/capture-result.json'),m.input_evidence.T40_result_sha256,m.input_evidence);
   for(const [p,h]of [[ROOT+'/t40-release-receipt.json',m.input_evidence.T40_receipt_sha256],
    [PATHS.beforeImagePath,m.input_evidence.T40_before_image_sha256],[PATHS.metadataReceiptPath,m.input_evidence.T40_metadata_receipt_sha256]])
    if(sha(read(p))!==h)fail('T41_ADOPTED_ARTIFACTS_CHANGED');
   try{const c=privateFile(OWNER_PATHS.crypto,4096),attestation=privateFile(OWNER_PATHS.attestation,4096),receipt=privateFile(OWNER_PATHS.receipt);
    validateOwnerProof({cryptoBytes:c.bytes,attestationBytes:attestation.bytes,receiptBytes:receipt.bytes,cryptoMtimeMs:c.mtimeMs},m.owner_proof);
   }catch(error){if(error.status==='BLOCKED_OWNER_PROOF')throw error;ownerFail('T41_OWNER_PROOF_REQUIRED');}
  };
  phase='verify-inputs';verify();absent([DIRECTORY+'/control-ready.guard',DIRECTORY+'/control-ready-result.json',KEY_PROOF,PATHS.inversePath,PATHS.controlReceiptPath]);
  adapter=createAdmissionCustodyFs({activation:activationFromManifest(m),proofInputs:m.owner_proof.inputs});phase='prepare-control';
  result={...result,...await runControlReady({manifest:m,authorizationManifestSha256:process.argv[6],adapter,assertPinnedInputs:verify,
   guard:()=>{writeNew(DIRECTORY+'/control-ready.guard',JSON.stringify({task:'T41',actionId:ACTION,parentActionId:PARENT_ACTION,authorizationManifestSha256:process.argv[6],
    adoptedActionId:ADOPTED_ACTION,adoptedManifestSha256:ADOPTED_MANIFEST,startedUtc:new Date().toISOString()})+'\n');guard=true;}})};
 }catch(error){result={...result,status:pending(error)?'BLOCKED_OWNER_PROOF':'BLOCKED',phase:error?.phase??phase,
  code:/^T41_[A-Z0-9_]+$/.test(error?.code??'')?error.code:error?.code==='EEXIST'?'T41_ALREADY_STARTED':'T41_PREPARATION_FAILED',
  ...(phases.has(error?.custodyPhase)?{custodyPhase:error.custodyPhase}:{}),
  ...((upstream(error)??upstream({code:error?.upstreamCode}))?{upstreamCode:upstream(error)??error.upstreamCode}:{})};}
 finally{try{adapter?.close();}catch{result={...result,status:'BLOCKED',code:'T41_CUSTODY_CLOSE_FAILED'};}
  if(guard)try{writeNew(DIRECTORY+'/control-ready-result.json',JSON.stringify(result)+'\n');}catch{result={...result,status:'BLOCKED',code:'T41_RESULT_WRITE_FAILED'};}}
 console.log('T41_CONTROL_RESULT',JSON.stringify(result));if(result.status!=='CONTROL_READY')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
