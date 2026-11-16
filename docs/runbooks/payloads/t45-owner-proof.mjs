// Pure Root approval of actual T44 custody metadata for the fresh T45 window.
// No I/O, key, encrypted identity, backup-artifact or Source access.
import {createHash} from 'node:crypto';
import {T44_OWNER_METHOD,T44_OWNER_STATE_ROOT,T44_OWNER_RESULT_PATH,T44_OWNER_ATTESTATION_PATH,
 T44_PARENT_MANIFEST_SHA256,T44_FAILED_GUARD_SHA256,T44_FAILED_RESULT_SHA256,T44_BACKUP_MANIFEST_SHA256,
 resolveT44EscrowOwnerProof} from './t44-owner-proof-binding.mjs';

export const OWNER_PROOF_METHOD=T44_OWNER_METHOD;
export const OWNER_APPROVED_PATH='/root/bron-secrets/t45-release/owner-proof-approved.json';
export const OWNER_RESULT_PATH=T44_OWNER_RESULT_PATH;
export const OWNER_ATTESTATION_PATH=T44_OWNER_ATTESTATION_PATH;
export const OWN_MANIFEST_PATH=T44_OWNER_STATE_ROOT+'/manifest.json';
export const OWN_MANIFEST_SHA256='ac658c21a5d36d5888dc5e7534f22a3172964ca30336722b69f66c1a9f85a986';
export const OLD_GUARD_PATH='/root/bron-secrets/t41-owner-recovery/guard.json';
export const OLD_RESULT_PATH='/root/bron-secrets/t41-owner-recovery/result.json';
export const BACKUP_MANIFEST_PATH='/var/backups/bron-franchise/target-20261113T133022Z-c4d9bbfd/manifest.json';
export const PROPOSAL_SHA256='dc714a9f88a5c2b453a73ce1474d13a39be13872f7251fa06f99223d90e962d8';
const METHOD=OWNER_PROOF_METHOD,ARTIFACT='roles.sql.zst.age';
const own=Symbol('safe-t45-owner-error'),sha=x=>createHash('sha256').update(x).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,status:'BLOCKED_OWNER_PROOF',[own]:true});};
const safe=fn=>{try{return fn();}catch(e){if(e?.[own])throw e;fail('OWNER_PROOF_T44_INPUT_INVALID');}};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function json(raw,max){
 if(!Buffer.isBuffer(raw)||raw.length<1||raw.length>max)fail('OWNER_PROOF_T44_BYTES_INVALID');
 try{return JSON.parse(raw.toString('utf8'));}catch{fail('OWNER_PROOF_T44_JSON_INVALID');}
}
export function validateEscrowOwnerScope(scope){return safe(()=>{
 if(!object(scope)||scope.method!==METHOD||scope.recoveryTask!=='T44'||scope.root_approved_input_required!==true||
  scope.proposalSha256!==PROPOSAL_SHA256||scope.recoveryManifestSha256!==OWN_MANIFEST_SHA256||
  scope.parentT41ManifestSha256!==T44_PARENT_MANIFEST_SHA256||scope.failedT41GuardSha256!==T44_FAILED_GUARD_SHA256||
  scope.failedT41ResultSha256!==T44_FAILED_RESULT_SHA256||
  !exact(scope.recoveryCipherBinding,['manifestSha256','artifact','from_pinned_backup_manifest'])||
  scope.recoveryCipherBinding.manifestSha256!==T44_BACKUP_MANIFEST_SHA256||scope.recoveryCipherBinding.artifact!==ARTIFACT||
  scope.recoveryCipherBinding.from_pinned_backup_manifest!==true)fail('OWNER_PROOF_T44_SCOPE_INVALID');
 return {method:METHOD,recoveryTask:'T44',root_approved_input_required:true,proposalSha256:PROPOSAL_SHA256,
  recoveryManifestSha256:OWN_MANIFEST_SHA256,parentT41ManifestSha256:T44_PARENT_MANIFEST_SHA256,
  failedT41GuardSha256:T44_FAILED_GUARD_SHA256,failedT41ResultSha256:T44_FAILED_RESULT_SHA256,
  recoveryCipherBinding:{manifestSha256:T44_BACKUP_MANIFEST_SHA256,artifact:ARTIFACT,from_pinned_backup_manifest:true}};
});}
const APPROVAL_KEYS=['format','task','method','manifestSha256','recoveryTask','recoveryManifestSha256','resultSha256','attestationSha256',
 'backupManifestSha256','backupCipherSha256','escrowCipherSha256','independentProofSha256','parentT41ManifestSha256','failedT41GuardSha256','failedT41ResultSha256'];

// This proves only Root's exact metadata approval. Full recovery-byte custody is
// checked separately below and cannot be replaced by this validation result.
export function validateRootApprovedInput({manifest,parentManifestSha256,approvedInputBytes,approvedInputSha256}={}){return safe(()=>{
 const ownerScope=validateEscrowOwnerScope(manifest?.owner_proof);
 if(manifest?.task!=='T45'||manifest.actionId!=='T45.release_window'||manifest.execution_authorized!==true||
  !digest(parentManifestSha256)||!digest(approvedInputSha256))fail('OWNER_PROOF_T44_PARENT_BINDING_INVALID');
 const approval=json(approvedInputBytes,16384);
 if(sha(approvedInputBytes)!==approvedInputSha256||!exact(approval,APPROVAL_KEYS)||approval.format!==1||approval.task!=='T45'||
  approval.method!==METHOD||approval.manifestSha256!==parentManifestSha256||approval.recoveryTask!=='T44'||
  approval.recoveryManifestSha256!==OWN_MANIFEST_SHA256||approval.backupManifestSha256!==T44_BACKUP_MANIFEST_SHA256||
  approval.parentT41ManifestSha256!==T44_PARENT_MANIFEST_SHA256||approval.failedT41GuardSha256!==T44_FAILED_GUARD_SHA256||
  approval.failedT41ResultSha256!==T44_FAILED_RESULT_SHA256||
  !['resultSha256','attestationSha256','backupCipherSha256','escrowCipherSha256','independentProofSha256'].every(k=>digest(approval[k])))
  fail('OWNER_PROOF_T44_ROOT_APPROVAL_INVALID');
 return {approval,ownerScope,rootApprovalOnly:true};
});}

export function resolveEscrowOwnerProof(input){return safe(()=>{
 const {manifest,parentManifestSha256,approvedInputBytes,approvedInputSha256,ownManifestBytes,resultBytes,attestationBytes,
  oldGuardBytes,oldResultBytes,backupManifestBytes,now=Date.now()}=input??{};
 const {approval,ownerScope}=validateRootApprovedInput({manifest,parentManifestSha256,approvedInputBytes,approvedInputSha256});
 if(sha(resultBytes)!==approval.resultSha256||sha(attestationBytes)!==approval.attestationSha256||
  sha(ownManifestBytes)!==OWN_MANIFEST_SHA256||sha(backupManifestBytes)!==approval.backupManifestSha256)
  fail('OWNER_PROOF_T44_ARTIFACT_SHA_MISMATCH');
 let resolved;
 try{resolved=resolveT44EscrowOwnerProof({ownManifestBytes,expectedManifestSha256:OWN_MANIFEST_SHA256,resultBytes,attestationBytes,
  oldGuardBytes,oldResultBytes,backupManifestBytes,now});}catch{fail('OWNER_PROOF_T44_RECOVERY_BYTES_INVALID');}
 const result=json(resultBytes,65536);
 if(resolved.independentProofSha256!==approval.independentProofSha256||resolved.recoveryCipherSha256!==approval.backupCipherSha256||
  result.cipherSha256!==approval.escrowCipherSha256)fail('OWNER_PROOF_T44_NORMALIZED_SHA_MISMATCH');
 return {...resolved,rootApprovalRequired:false,approvedInputSha256,
  proofInputs:{task:'T44',method:METHOD,parentManifestSha256,ownerScope,
   approvedInput:{path:OWNER_APPROVED_PATH,sha256:approvedInputSha256},manifest:{path:OWN_MANIFEST_PATH,sha256:OWN_MANIFEST_SHA256},
   result:{path:OWNER_RESULT_PATH,sha256:approval.resultSha256},attestation:{path:OWNER_ATTESTATION_PATH,sha256:approval.attestationSha256},
   oldGuard:{path:OLD_GUARD_PATH,sha256:T44_FAILED_GUARD_SHA256},oldResult:{path:OLD_RESULT_PATH,sha256:T44_FAILED_RESULT_SHA256}}};
});}
