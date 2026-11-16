import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {T44_OWNER_METHOD as method,T44_OWNER_STATE_ROOT,T44_OWNER_RESULT_PATH,T44_OWNER_ATTESTATION_PATH,
 T44_PARENT_MANIFEST_SHA256 as parent,T44_FAILED_GUARD_SHA256 as failedGuard,T44_FAILED_RESULT_SHA256 as failedResult,
 T44_BACKUP_MANIFEST_SHA256 as backupSha,validateT44RecoveryRecords,resolveT44EscrowOwnerProof}
 from '../../docs/runbooks/payloads/t44-owner-proof-binding.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const encode=x=>Buffer.from(JSON.stringify(x)+'\n');
const now=Date.parse('2026-11-15T00:00:00Z'),ownSha='1'.repeat(64),roleSha='2'.repeat(64),escrowSha='3'.repeat(64);
const objectKey='migration/owner-key-escrow-'+'4'.repeat(32)+'/identity.age';
const lineage={parentT41ManifestSha256:parent,failedT41GuardSha256:failedGuard,failedT41ResultSha256:failedResult,attemptNumber:2,oldT41Unchanged:true};
function records(edit={}){
 const backupArtifact={file:'roles.sql.zst.age',bytes:512,sha256:roleSha};edit.backup?.(backupArtifact);
 const result={format:1,task:'T44',actionId:'T44.owner-key-recovery',method,manifestSha256:ownSha,objectKey,
  startedUtc:'2026-11-14T23:00:00.000001Z',oneAttempt:true,oneFinalInvocation:true,status:'PASS',completedUtc:'2026-11-14T23:05:00.000001Z',
  guardAction:'T44.owner-key-recovery',endpoint:'https://s3.twcstorage.ru',bucket:'bron-franchise-backups',
  cipherSha256:escrowSha,cipherBytes:1024,backupManifestSha256:backupSha,backupCipherSha256:roleSha,backupCipherBytes:512,
  conditionalPut:true,putAttempts:1,getAttempts:1,putResponseUncertain:false,downloadShaVerified:true,cipherShaVerified:true,decryptionVerified:true,
  encryptedIdentity:{objectKey,ciphertextSha256:escrowSha,bytes:1024,scrypt:true},
  backupProbe:{manifestSha256:backupSha,artifact:'roles.sql.zst.age',cipherSha256:roleSha,cipherBytes:512,decryptionVerified:true,zstdVerified:true},
  downloadedCipherShaVerified:true,originalIdentityReadForVerification:false,plaintextStored:false,plaintextRecoveredIdentityStored:false,
  identityStored:false,macDataTransit:false,externalCustody:'OWNER_CONFIRMATION_REQUIRED',putOutcome:'CONFIRMED_BY_READBACK',originalIdentityOpened:true,...lineage};
 edit.result?.(result);const resultSha256=sha(encode(result));
 const attestation={format:1,task:'T44',method,status:'CONFIRMED',actionId:'T44.owner-key-recovery-attestation',
  observedUtc:'2026-11-14T23:10:00.000001Z',resultSha256,manifestSha256:ownSha,
  independentPassphraseCopy:true,adminVpsPhoneAccess:true,timewebPhoneAccess:true,macRequired:false,confirmedUtc:'2026-11-14T23:10:01.000001Z',...lineage};
 edit.attestation?.(attestation);
 return {manifestSha256:ownSha,result,resultSha256,attestation,backupArtifact,now};
}
function outer(edit={}){
 const ownManifest={task:'T44',actionId:'T44.owner-key-recovery',execution_authorized:true,parentT41ManifestSha256:parent,
  failedT41GuardSha256:failedGuard,failedT41ResultSha256:failedResult,ownerFinalAttemptAuthorized:true,maxAdditionalOwnerRecoverAttempts:1,
  attemptNumber:2,stateRoot:T44_OWNER_STATE_ROOT,shared_auth_budget_unchanged:{used:1,remaining:2}};
 edit.manifest?.(ownManifest);const ownManifestBytes=encode(ownManifest),r=records();
 return {ownManifestBytes,expectedManifestSha256:sha(ownManifestBytes),resultBytes:encode(r.result),attestationBytes:encode(r.attestation),
  oldGuardBytes:encode({task:'T41'}),oldResultBytes:encode({task:'T41',status:'BLOCKED'}),
  backupManifestBytes:encode({artifacts:[r.backupArtifact]}),now};
}
const rejects=(fn,code)=>assert.throws(fn,error=>{
 assert.equal(error.status,'BLOCKED_T44_OWNER_PROOF');assert.match(error.code,/^T44_OWNER_PROOF_[A-Z_]+$/);assert.equal(error.message,error.code);
 if(code)assert.equal(error.code,code);
 assert.doesNotMatch(JSON.stringify(error),/PRIVATE|age-secret|password|objectKey|identity\.age/);return true;
});

test('import is inert; production module has no filesystem, process or network imports',()=>{
 const file=path.resolve('docs/runbooks/payloads/t44-owner-proof-binding.mjs');
 const run=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:1500});
 assert.equal(run.status,0);assert.equal(run.stdout+run.stderr,'');
 const source=readFileSync(file,'utf8');assert.deepEqual([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(x=>x[1]),['node:crypto']);
 assert.equal(T44_OWNER_RESULT_PATH,'/root/bron-secrets/t44-owner-recovery/result.json');
 assert.equal(T44_OWNER_ATTESTATION_PATH,'/root/bron-secrets/t44-owner-recovery/attestation.json');
});
test('valid semantic T44 records require separate byte binding and Root approval',()=>{
 assert.deepEqual(validateT44RecoveryRecords(records()),{status:'VALID_RECORDS_ONLY',rootApprovalRequired:true});
 const uncertain=records({result:r=>r.putResponseUncertain=true});
 assert.equal(validateT44RecoveryRecords(uncertain).status,'VALID_RECORDS_ONLY');
});
test('actual T44 task, fresh action and exact own manifest lineage cannot alias failed T41',()=>{
 for(const patch of [r=>r.task='T41',r=>r.actionId='T41.owner-key-recovery',r=>r.guardAction='T41.owner-key-recovery',
  r=>r.manifestSha256=parent,r=>r.parentManifestSha256=parent,r=>r.parentT41ManifestSha256=ownSha,r=>r.failedT41GuardSha256='0'.repeat(64),
  r=>r.failedT41ResultSha256='0'.repeat(64),r=>r.attemptNumber=1,r=>r.attemptNumber=3,r=>r.oldT41Unchanged=false])
  rejects(()=>validateT44RecoveryRecords(records({result:patch})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('READY, blocked, unguarded and malformed records cannot become proof',()=>{
 for(const patch of [r=>r.status='READY',r=>r.status='BLOCKED',r=>r.oneAttempt=false,r=>r.oneFinalInvocation=false,r=>r.format=2,r=>r.method='LEGACY',r=>delete r.guardAction])
  rejects(()=>validateT44RecoveryRecords(records({result:patch})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('encrypted identity metadata must alias the same bounded scrypt ciphertext',()=>{
 for(const patch of [r=>r.encryptedIdentity.objectKey+='x',r=>r.encryptedIdentity.ciphertextSha256=roleSha,r=>r.encryptedIdentity.bytes++,
  r=>r.encryptedIdentity.scrypt=false,r=>r.cipherBytes=65537,r=>r.cipherBytes=0,r=>r.cipherSha256='PENDING'])
  rejects(()=>validateT44RecoveryRecords(records({result:patch})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
 assert.equal(validateT44RecoveryRecords(records({result:r=>{r.cipherBytes=65536;r.encryptedIdentity.bytes=65536;}})).status,'VALID_RECORDS_ONLY');
});
test('verified downloaded ciphertext must decrypt the pinned roles backup, not a different artifact',()=>{
 for(const patch of [r=>r.backupManifestSha256=ownSha,r=>r.backupCipherSha256=escrowSha,r=>r.backupCipherBytes++,
  r=>r.backupProbe.artifact='database.dump.zst.age',r=>r.backupProbe.manifestSha256=ownSha,r=>r.backupProbe.cipherSha256=escrowSha,
  r=>r.backupProbe.cipherBytes++,r=>r.backupProbe.zstdVerified=false,r=>r.backupProbe.decryptionVerified=false])
  rejects(()=>validateT44RecoveryRecords(records({result:patch})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
 for(const patch of [b=>b.file='database.dump.zst.age',b=>b.bytes=0,b=>b.bytes=10485761,b=>b.sha256='PENDING',b=>b.extra='PRIVATE'])
  rejects(()=>validateT44RecoveryRecords(records({backup:patch})),'T44_OWNER_PROOF_RECORD_INPUT_INVALID');
});
test('one conditional PUT and one bounded GET are the only accepted transport history',()=>{
 for(const patch of [r=>r.putAttempts=0,r=>r.putAttempts=2,r=>r.getAttempts=2,r=>r.conditionalPut=false,r=>r.putResponseUncertain='yes',
  r=>r.putOutcome='ACKNOWLEDGED',r=>r.originalIdentityOpened=false,
  r=>r.endpoint='https://elsewhere.invalid',r=>r.bucket='different',r=>r.objectKey='../identity.age'])
  rejects(()=>validateT44RecoveryRecords(records({result:patch})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('no plaintext or Mac exception can be smuggled into otherwise passing crypto evidence',()=>{
 for(const key of ['originalIdentityReadForVerification','plaintextStored','plaintextRecoveredIdentityStored','identityStored','macDataTransit'])
  rejects(()=>validateT44RecoveryRecords(records({result:r=>r[key]=true})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
 for(const key of ['downloadShaVerified','cipherShaVerified','decryptionVerified','downloadedCipherShaVerified'])
  rejects(()=>validateT44RecoveryRecords(records({result:r=>r[key]=false})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('exact schemas reject extra secrets at every result and attestation level',()=>{
 for(const patch of [r=>r.password='PRIVATE',r=>r.encryptedIdentity.secret='PRIVATE',r=>r.backupProbe.rawKey='PRIVATE'])
  rejects(()=>validateT44RecoveryRecords(records({result:patch})),'T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
 rejects(()=>validateT44RecoveryRecords(records({attestation:a=>a.phrase='PRIVATE'})),'T44_OWNER_PROOF_ATTESTATION_INVALID');
});
test('independent paper copy and personal AdminVPS/Timeweb phone access are all required',()=>{
 for(const key of ['independentPassphraseCopy','adminVpsPhoneAccess','timewebPhoneAccess'])
  rejects(()=>validateT44RecoveryRecords(records({attestation:a=>a[key]=false})),'T44_OWNER_PROOF_ATTESTATION_INVALID');
 for(const patch of [a=>a.macRequired=true,a=>a.status='READY',a=>a.task='T41',a=>a.actionId='T41.owner-key-recovery-attestation',
  a=>a.resultSha256=failedResult,a=>a.manifestSha256=parent,a=>a.attemptNumber=1,a=>a.oldT41Unchanged=false])
  rejects(()=>validateT44RecoveryRecords(records({attestation:patch})),'T44_OWNER_PROOF_ATTESTATION_INVALID');
});
test('result and attestation UTC timestamps are ordered and cannot assert future completion',()=>{
 for(const patch of [r=>r.startedUtc='PRIVATE',r=>r.completedUtc='2026-11-14T22:00:00Z',r=>r.completedUtc='2026-11-15T00:00:05.001Z'])
  rejects(()=>validateT44RecoveryRecords(records({result:patch})),'T44_OWNER_PROOF_TIME_INVALID');
 for(const patch of [a=>a.observedUtc='2026-11-14T23:01:00Z',a=>a.confirmedUtc='2026-11-14T23:00:00Z',a=>a.confirmedUtc='2026-11-15T00:00:05.001Z'])
  rejects(()=>validateT44RecoveryRecords(records({attestation:patch})),'T44_OWNER_PROOF_TIME_INVALID');
 const r=records();r.now+=30*86400000;assert.equal(validateT44RecoveryRecords(r).status,'VALID_RECORDS_ONLY');
});
test('outer binder rejects unpinned manifests and wrong authorization before historical data',()=>{
 for(const patch of [m=>m.task='T41',m=>m.actionId='T41.release_window',m=>m.execution_authorized=false,m=>m.parentT41ManifestSha256=ownSha,
  m=>m.failedT41GuardSha256=ownSha,m=>m.failedT41ResultSha256=ownSha,m=>m.ownerFinalAttemptAuthorized=false,
  m=>m.maxAdditionalOwnerRecoverAttempts=2,m=>m.attemptNumber=1,m=>m.stateRoot='/root/bron-secrets/t41-owner-recovery',
  m=>m.shared_auth_budget_unchanged.used=2])
  rejects(()=>resolveT44EscrowOwnerProof(outer({manifest:patch})),'T44_OWNER_PROOF_MANIFEST_BINDING_INVALID');
 const r=outer();r.expectedManifestSha256='0'.repeat(64);
 rejects(()=>resolveT44EscrowOwnerProof(r),'T44_OWNER_PROOF_MANIFEST_BINDING_INVALID');
});
test('fabricated historical guard/result or backup bytes never satisfy fixed production SHA pins',()=>{
 // No real private VPS receipt/backup manifest bytes are committed as test fixtures.
 // Positive full byte binding remains an operational acceptance check on real T44 PASS.
 rejects(()=>resolveT44EscrowOwnerProof(outer()),'T44_OWNER_PROOF_PINNED_BYTES_MISMATCH');
 const r=outer();r.oldGuardBytes=r.resultBytes;r.oldResultBytes=r.resultBytes;
 rejects(()=>resolveT44EscrowOwnerProof(r),'T44_OWNER_PROOF_PINNED_BYTES_MISMATCH');
});
test('malformed/oversized bytes and unexpected getters fail with finite redacted errors',()=>{
 for(const [key,value] of [['ownManifestBytes',Buffer.alloc(1048577)],['ownManifestBytes',Buffer.from('PRIVATE_INVALID')],
  ['oldGuardBytes',Buffer.alloc(16385)],['backupManifestBytes',Buffer.alloc(1048577)]]){
  const r=outer();r[key]=value;rejects(()=>resolveT44EscrowOwnerProof(r));
 }
 const r=records();Object.defineProperty(r.result,'status',{get(){throw Error('PRIVATE_password_age-secret');}});
 rejects(()=>validateT44RecoveryRecords(r),'T44_OWNER_PROOF_INVALID_INPUT');
});
