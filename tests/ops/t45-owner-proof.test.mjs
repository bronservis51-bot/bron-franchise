import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {OWNER_PROOF_METHOD as method,OWNER_APPROVED_PATH,OWNER_RESULT_PATH,OWNER_ATTESTATION_PATH,
 OWN_MANIFEST_PATH,OWN_MANIFEST_SHA256,OLD_GUARD_PATH,OLD_RESULT_PATH,PROPOSAL_SHA256,
 validateEscrowOwnerScope,validateRootApprovedInput,resolveEscrowOwnerProof}
 from '../../docs/runbooks/payloads/t45-owner-proof.mjs';
import {T44_PARENT_MANIFEST_SHA256 as parent,T44_FAILED_GUARD_SHA256 as failedGuard,
 T44_FAILED_RESULT_SHA256 as failedResult,T44_BACKUP_MANIFEST_SHA256 as backupSha}
 from '../../docs/runbooks/payloads/t44-owner-proof-binding.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),encode=x=>Buffer.from(JSON.stringify(x)+'\n');
function fixture(){
 const owner_proof={method,recoveryTask:'T44',root_approved_input_required:true,proposalSha256:PROPOSAL_SHA256,
  recoveryManifestSha256:OWN_MANIFEST_SHA256,parentT41ManifestSha256:parent,failedT41GuardSha256:failedGuard,
  failedT41ResultSha256:failedResult,recoveryCipherBinding:{manifestSha256:backupSha,artifact:'roles.sql.zst.age',from_pinned_backup_manifest:true}};
 const manifest={task:'T45',actionId:'T45.release_window',execution_authorized:true,owner_proof};
 const parentManifestSha256='1'.repeat(64),approval={format:1,task:'T45',method,manifestSha256:parentManifestSha256,
  recoveryTask:'T44',recoveryManifestSha256:OWN_MANIFEST_SHA256,resultSha256:'2'.repeat(64),attestationSha256:'3'.repeat(64),
  backupManifestSha256:backupSha,backupCipherSha256:'4'.repeat(64),escrowCipherSha256:'5'.repeat(64),independentProofSha256:'6'.repeat(64),
  parentT41ManifestSha256:parent,failedT41GuardSha256:failedGuard,failedT41ResultSha256:failedResult};
 const input=()=>{const approvedInputBytes=encode(approval);return {manifest,parentManifestSha256,approvedInputBytes,approvedInputSha256:sha(approvedInputBytes)};};
 return {manifest,owner_proof,approval,input};
}
const rejects=(fn,code)=>assert.throws(fn,error=>{
 assert.equal(error.status,'BLOCKED_OWNER_PROOF');assert.match(error.code,/^OWNER_PROOF_T44_[A-Z_]+$/);
 assert.equal(error.message,error.code);if(code)assert.equal(error.code,code);
 assert.doesNotMatch(JSON.stringify(error),/PRIVATE|age-secret|password|identity\.age/);return true;
});

test('T45 approval module import is inert and fixed paths retain actual T44 lineage',()=>{
 const file=path.resolve('docs/runbooks/payloads/t45-owner-proof.mjs');
 const run=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:1500});
 assert.equal(run.status,0);assert.equal(run.stdout+run.stderr,'');
 const imports=[...readFileSync(file,'utf8').matchAll(/from ['"]([^'"]+)['"]/g)].map(x=>x[1]);
 assert.deepEqual(imports,['node:crypto','./t44-owner-proof-binding.mjs']);
 assert.equal(OWNER_APPROVED_PATH,'/root/bron-secrets/t45-release/owner-proof-approved.json');
 assert.equal(OWNER_RESULT_PATH,'/root/bron-secrets/t44-owner-recovery/result.json');
 assert.equal(OWNER_ATTESTATION_PATH,'/root/bron-secrets/t44-owner-recovery/attestation.json');
 assert.equal(OWN_MANIFEST_PATH,'/root/bron-secrets/t44-owner-recovery/manifest.json');
 assert.equal(OLD_GUARD_PATH,'/root/bron-secrets/t41-owner-recovery/guard.json');
 assert.equal(OLD_RESULT_PATH,'/root/bron-secrets/t41-owner-recovery/result.json');
 assert.equal(sha(readFileSync('docs/runbooks/payloads/t44-owner-key-recovery.json')),OWN_MANIFEST_SHA256);
});
test('Root-approved input proves metadata approval only, never recovery PASS or Source admission',()=>{
 const f=fixture(),r=validateRootApprovedInput(f.input());
 assert.equal(r.rootApprovalOnly,true);assert.deepEqual(r.ownerScope,f.owner_proof);assert.deepEqual(r.approval,f.approval);
 assert.equal(Object.hasOwn(r,'proof'),false);assert.equal(Object.hasOwn(r,'independentProofSha256'),false);
});
test('owner scope pins original grant, fresh T44 package and unchanged consumed T41 lineage',()=>{
 for(const patch of [s=>s.method='other',s=>s.recoveryTask='T41',s=>s.root_approved_input_required=false,
  s=>s.proposalSha256='0'.repeat(64),s=>s.recoveryManifestSha256=parent,s=>s.parentT41ManifestSha256=OWN_MANIFEST_SHA256,
  s=>s.failedT41GuardSha256='0'.repeat(64),s=>s.failedT41ResultSha256='0'.repeat(64),s=>s.recoveryCipherBinding.manifestSha256='0'.repeat(64),
  s=>s.recoveryCipherBinding.artifact='database.dump.zst.age',s=>s.recoveryCipherBinding.from_pinned_backup_manifest=false,
  s=>s.recoveryCipherBinding.extra='PRIVATE']){
  const f=fixture();patch(f.owner_proof);rejects(()=>validateEscrowOwnerScope(f.owner_proof),'OWNER_PROOF_T44_SCOPE_INVALID');
 }
});
test('Root approval cannot be reused under the old T41 window or a different manifest hash',()=>{
 for(const patch of [f=>f.manifest.task='T41',f=>f.manifest.actionId='T41.release_window',f=>f.manifest.execution_authorized=false,
  f=>f.approval.manifestSha256='7'.repeat(64),f=>f.approval.task='T44']){
  const f=fixture();patch(f);rejects(()=>validateRootApprovedInput(f.input()));
 }
 const f=fixture(),i=f.input();i.approvedInputSha256='0'.repeat(64);
 rejects(()=>validateRootApprovedInput(i),'OWNER_PROOF_T44_ROOT_APPROVAL_INVALID');
});
test('Root approval exact schema binds actual result/attestation/cipher hashes and rejects extra fields',()=>{
 for(const patch of [a=>a.format=2,a=>a.method='other',a=>a.recoveryTask='T41',a=>a.recoveryManifestSha256=parent,
  a=>a.backupManifestSha256='0'.repeat(64),a=>a.parentT41ManifestSha256=OWN_MANIFEST_SHA256,a=>a.failedT41GuardSha256='0'.repeat(64),
  a=>a.failedT41ResultSha256='0'.repeat(64),a=>a.resultSha256='PENDING',a=>a.attestationSha256='PENDING',
  a=>a.backupCipherSha256='PENDING',a=>a.escrowCipherSha256='PENDING',a=>a.independentProofSha256='PENDING',
  a=>a.secret='PRIVATE',a=>delete a.attestationSha256]){
  const f=fixture();patch(f.approval);rejects(()=>validateRootApprovedInput(f.input()),'OWNER_PROOF_T44_ROOT_APPROVAL_INVALID');
 }
});
test('metadata approval alone cannot promote fabricated private recovery/backup bytes into a proof',()=>{
 const f=fixture(),resultBytes=encode({task:'T44',status:'PASS'}),attestationBytes=encode({task:'T44',status:'CONFIRMED'});
 f.approval.resultSha256=sha(resultBytes);f.approval.attestationSha256=sha(attestationBytes);
 const i={...f.input(),ownManifestBytes:readFileSync('docs/runbooks/payloads/t44-owner-key-recovery.json'),
  resultBytes,attestationBytes,oldGuardBytes:encode({task:'T41'}),oldResultBytes:encode({status:'BLOCKED'}),backupManifestBytes:encode({artifacts:[]})};
 assert.equal(validateRootApprovedInput(i).rootApprovalOnly,true);
 rejects(()=>resolveEscrowOwnerProof(i),'OWNER_PROOF_T44_ARTIFACT_SHA_MISMATCH');
 // Real historical private bytes are intentionally absent from Cloud fixtures.
 // A full positive byte-custody acceptance must run privately on the VPS after T44 PASS.
});
test('invalid byte sizes and unexpected getters produce finite redacted errors',()=>{
 const f=fixture();for(const bytes of [Buffer.alloc(0),Buffer.alloc(16385),Buffer.from('PRIVATE_bad_json')]){
  const i={...f.input(),approvedInputBytes:bytes,approvedInputSha256:sha(bytes)};rejects(()=>validateRootApprovedInput(i));
 }
 const i=f.input();Object.defineProperty(i.manifest.owner_proof,'method',{get(){throw Error('PRIVATE_password_age-secret');}});
 rejects(()=>validateRootApprovedInput(i),'OWNER_PROOF_T44_INPUT_INVALID');
});
