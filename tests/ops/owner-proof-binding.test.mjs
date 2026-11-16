import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {OWNER_PROOF_METHOD as method,OWNER_APPROVED_PATH,OWNER_RESULT_PATH,OWNER_ATTESTATION_PATH,BACKUP_MANIFEST_PATH,
 validateEscrowOwnerScope,resolveEscrowOwnerProof} from '../../docs/runbooks/payloads/owner-proof-binding.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=x=>Buffer.from(canonical(x)+'\n'),parentSha='1'.repeat(64),now=Date.parse('2026-11-14T16:00:00Z');
const roleSha='2'.repeat(64),escrowSha='3'.repeat(64),objectKey='migration/owner-key-escrow-'+'4'.repeat(32)+'/identity.age';
function fixture(options={}){
 const backup={artifacts:[{file:'roles.sql.zst.age',sha256:roleSha,bytes:512},{file:'database.dump.zst.age',sha256:'a'.repeat(64),bytes:4096}]};
 options.backup?.(backup);const backupManifestBytes=encode(backup),backupSha=sha(backupManifestBytes);
 const result={format:1,task:'T41',actionId:'T41.owner-key-recovery',method,manifestSha256:parentSha,objectKey,
  startedUtc:'2026-11-14T15:00:00.000001Z',oneAttempt:true,status:'PASS',completedUtc:'2026-11-14T15:05:00.000001Z',
  parentManifestSha256:parentSha,guardAction:'T41.owner-key-recovery',endpoint:'https://s3.twcstorage.ru',bucket:'bron-franchise-backups',
  cipherSha256:escrowSha,cipherBytes:1024,backupManifestSha256:backupSha,backupCipherSha256:roleSha,backupCipherBytes:512,
  conditionalPut:true,putAttempts:1,getAttempts:1,putResponseUncertain:false,downloadShaVerified:true,cipherShaVerified:true,decryptionVerified:true,
  encryptedIdentity:{objectKey,ciphertextSha256:escrowSha,bytes:1024,scrypt:true},
  backupProbe:{manifestSha256:backupSha,artifact:'roles.sql.zst.age',cipherSha256:roleSha,cipherBytes:512,decryptionVerified:true,zstdVerified:true},
  downloadedCipherShaVerified:true,originalIdentityReadForVerification:false,plaintextStored:false,plaintextRecoveredIdentityStored:false,
  identityStored:false,macDataTransit:false,externalCustody:'OWNER_CONFIRMATION_REQUIRED'};
 options.result?.(result);const resultBytes=encode(result),resultSha=sha(resultBytes);
 const attestation={format:1,task:'T41',method,status:'CONFIRMED',actionId:'T41.owner-key-recovery-attestation',
  observedUtc:'2026-11-14T15:10:00.000001Z',resultSha256:resultSha,manifestSha256:parentSha,
  independentPassphraseCopy:true,adminVpsPhoneAccess:true,timewebPhoneAccess:true,macRequired:false,confirmedUtc:'2026-11-14T15:10:01.000001Z'};
 options.attestation?.(attestation);const attestationBytes=encode(attestation),attestationSha=sha(attestationBytes);
 const proof={format:1,sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',
  crypto:{status:'PASS',cipherSha256:roleSha,cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
  attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:attestationSha}};
 const ownerScope={method,root_approved_input_required:true,proposalSha256:'5'.repeat(64),
  recoveryCipherBinding:{manifestSha256:backupSha,artifact:'roles.sql.zst.age',from_pinned_backup_manifest:true}};
 options.scope?.(ownerScope);
 const manifest={task:'T41',actionId:'T41.release_window',execution_authorized:true,owner_proof:ownerScope};options.manifest?.(manifest);
 const approval={format:1,task:'T41',method,manifestSha256:parentSha,resultSha256:resultSha,attestationSha256:attestationSha,
  backupManifestSha256:backupSha,backupCipherSha256:roleSha,escrowCipherSha256:escrowSha,independentProofSha256:sha(encode(proof))};
 options.approval?.(approval);const approvedInputBytes=encode(approval);
 return {manifest,result,attestation,backup,proof,ownerScope,approval,args:{manifest,parentManifestSha256:parentSha,
  approvedInputBytes,approvedInputSha256:sha(approvedInputBytes),resultBytes,attestationBytes,backupManifestBytes,now}};
}
const rejected=(f,code)=>{assert.throws(()=>resolveEscrowOwnerProof(f.args),e=>{
 assert.equal(e.status,'BLOCKED_OWNER_PROOF');assert.match(e.code,/^OWNER_PROOF_[A-Z_]+$/);assert.equal(e.message,e.code);
 if(code)assert.equal(e.code,code);assert.doesNotMatch(JSON.stringify(e),/PRIVATE_|age-secret|password|objectKey|identity\.age|cipherBytes/);return true;
});};

test('import is inert and public constants name only approved metadata paths',()=>{
 const file=path.resolve('docs/runbooks/payloads/owner-proof-binding.mjs'),p=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:1500});
 assert.equal(p.status,0);assert.equal(p.stdout+p.stderr,'');assert.equal(method,'BRON_OWNER_KEY_ESCROW_V1');
 assert.equal(OWNER_APPROVED_PATH,'/root/bron-secrets/t41-release/owner-proof-approved.json');assert.equal(OWNER_RESULT_PATH,'/root/bron-secrets/t41-owner-recovery/result.json');
 assert.equal(OWNER_ATTESTATION_PATH,'/root/bron-secrets/t41-owner-recovery/attestation.json');assert.equal(BACKUP_MANIFEST_PATH,'/var/backups/bron-franchise/target-20261113T133022Z-c4d9bbfd/manifest.json');
});
test('scope requires explicit escrow exception and pinned-backup policy; runtime projection extras are not propagated',()=>{
 const f=fixture();f.ownerScope.independentProofSha256='PRIVATE_FUTURE';f.ownerScope.inputs={key:'PRIVATE_NOT_COPIED'};
 const s=validateEscrowOwnerScope(f.ownerScope);assert.deepEqual(Object.keys(s).sort(),['method','proposalSha256','recoveryCipherBinding','root_approved_input_required']);
 assert.doesNotMatch(JSON.stringify(s),/PRIVATE/);f.ownerScope.recoveryCipherBinding.artifact='changed';assert.equal(s.recoveryCipherBinding.artifact,'roles.sql.zst.age');
 for(const patch of [{method:'LEGACY'},{root_approved_input_required:false},{proposalSha256:'PENDING'},{recoveryCipherBinding:{}}]){
  assert.throws(()=>validateEscrowOwnerScope({...fixture().ownerScope,...patch}),{code:'OWNER_PROOF_SCOPE_INVALID',status:'BLOCKED_OWNER_PROOF'});
 }
});
test('actual approved escrow result normalizes into existing custody proof with backup cipher and attestation evidence',()=>{
 const f=fixture(),r=resolveEscrowOwnerProof(f.args);assert.deepEqual(r.proof,f.proof);assert.equal(r.independentProofSha256,sha(encode(f.proof)));
 assert.equal(r.recoveryCipherSha256,roleSha);assert.notEqual(r.recoveryCipherSha256,escrowSha);assert.equal(r.approvedInputSha256,f.args.approvedInputSha256);
 assert.deepEqual(r.proofInputs,{method,parentManifestSha256:parentSha,ownerScope:f.ownerScope,
  approvedInput:{path:OWNER_APPROVED_PATH,sha256:f.args.approvedInputSha256},result:{path:OWNER_RESULT_PATH,sha256:sha(f.args.resultBytes)},
  attestation:{path:OWNER_ATTESTATION_PATH,sha256:sha(f.args.attestationBytes)}});
 assert.doesNotMatch(JSON.stringify(r),/objectKey|owner-key-escrow-|s3.twcstorage|cipherBytes|observedUtc|startedUtc|encryptedIdentity/);
});
test('Root approval is exact, explicit-SHA-bound and must name current parent and all result digests',()=>{
 const f=fixture();rejected({...f,args:{...f.args,approvedInputSha256:'0'.repeat(64)}},'OWNER_PROOF_ROOT_APPROVAL_INVALID');
 for(const edit of [a=>a.format=2,a=>a.task='T40',a=>a.method='LEGACY',a=>a.manifestSha256='0'.repeat(64),
  a=>a.resultSha256='PENDING',a=>a.extra='PRIVATE',a=>delete a.escrowCipherSha256])rejected(fixture({approval:edit}),'OWNER_PROOF_ROOT_APPROVAL_INVALID');
 for(const edit of [m=>m.execution_authorized=false,m=>m.actionId='T41.prepare_control_ready',m=>m.task='T40'])rejected(fixture({manifest:edit}),'OWNER_PROOF_PARENT_BINDING_INVALID');
});
test('changed result, attestation or backup metadata bytes cannot pass an old approval',()=>{
 for(const key of ['resultBytes','attestationBytes','backupManifestBytes']){const f=fixture();f.args[key]=Buffer.from('{}');rejected(f,'OWNER_PROOF_ARTIFACT_SHA_MISMATCH');}
 rejected(fixture({scope:s=>s.recoveryCipherBinding.manifestSha256='0'.repeat(64)}),'OWNER_PROOF_ARTIFACT_SHA_MISMATCH');
});
test('pinned backup metadata contains exactly one bounded roles artifact matching approval and probe',()=>{
 for(const edit of [b=>b.artifacts.push(b.artifacts[0]),b=>b.artifacts.shift(),b=>b.artifacts[0].bytes=0,
  b=>b.artifacts[0].bytes=10485761,b=>b.artifacts[0].sha256='PENDING',b=>b.artifacts[0].sha256='0'.repeat(64),b=>b.artifacts[0].extra='PRIVATE'])
  rejected(fixture({backup:edit}),'OWNER_PROOF_BACKUP_METADATA_INVALID');
});
test('actual result must preserve task/parent/action aliases and one guarded PASS attempt',()=>{
 for(const edit of [r=>r.status='BLOCKED',r=>r.task='T40',r=>r.method='LEGACY',r=>r.manifestSha256='0'.repeat(64),
  r=>r.parentManifestSha256='0'.repeat(64),r=>r.guardAction='T41.other',r=>r.oneAttempt=false,r=>r.extra='PRIVATE'])
  rejected(fixture({result:edit}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('encrypted identity aliases agree and enforce scrypt plus64KiB bound',()=>{
 for(const edit of [r=>r.encryptedIdentity.objectKey+='x',r=>r.encryptedIdentity.ciphertextSha256='0'.repeat(64),
  r=>r.encryptedIdentity.bytes++,r=>r.encryptedIdentity.scrypt=false,r=>{r.cipherBytes=65537;r.encryptedIdentity.bytes=65537;},
  r=>r.encryptedIdentity.extra='PRIVATE',r=>r.cipherSha256='0'.repeat(64)])rejected(fixture({result:edit}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
 const f=fixture({result:r=>{r.cipherBytes=65536;r.encryptedIdentity.bytes=65536;}});assert.equal(resolveEscrowOwnerProof(f.args).proof.crypto.decryptionVerified,true);
});
test('backupProbe must agree with every flat alias and pin actual roles ciphertext integrity',()=>{
 for(const edit of [r=>r.backupProbe.artifact='database.dump.zst.age',r=>r.backupProbe.manifestSha256='0'.repeat(64),
  r=>r.backupProbe.cipherSha256=escrowSha,r=>r.backupProbe.cipherBytes++,r=>r.backupProbe.zstdVerified=false,
  r=>r.backupProbe.decryptionVerified=false,r=>r.backupCipherSha256='0'.repeat(64),r=>r.backupCipherBytes++])
  rejected(fixture({result:edit}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('no-new-plaintext and noMac guarantees cannot be weakened by successful cryptographic flags',()=>{
 for(const key of ['originalIdentityReadForVerification','plaintextStored','plaintextRecoveredIdentityStored','identityStored','macDataTransit'])
  rejected(fixture({result:r=>r[key]=true}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
 for(const key of ['downloadShaVerified','cipherShaVerified','decryptionVerified','downloadedCipherShaVerified'])
  rejected(fixture({result:r=>r[key]=false}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
 rejected(fixture({result:r=>r.externalCustody='COMPLETE'}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('only one conditional PUT/GET of exact Timeweb endpoint/bucket/object scope is accepted',()=>{
 for(const edit of [r=>r.putAttempts=2,r=>r.getAttempts=2,r=>r.conditionalPut=false,r=>r.putResponseUncertain='yes',
  r=>r.endpoint='https://other.invalid',r=>r.bucket='other',r=>r.objectKey='migration/../identity.age'])
  rejected(fixture({result:edit}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
 assert.equal(resolveEscrowOwnerProof(fixture({result:r=>r.putResponseUncertain=true}).args).proof.crypto.status,'PASS');
});
test('separate explicit phrase/AdminVPS-phone/Timeweb-phone attestation is SHA-bound to successful result',()=>{
 for(const key of ['independentPassphraseCopy','adminVpsPhoneAccess','timewebPhoneAccess'])rejected(fixture({attestation:a=>a[key]=false}),'OWNER_PROOF_ATTESTATION_INVALID');
 for(const edit of [a=>a.macRequired=true,a=>a.status='PENDING',a=>a.actionId='T41.owner-recover',a=>a.resultSha256='0'.repeat(64),
  a=>a.manifestSha256='0'.repeat(64),a=>a.extra='PRIVATE'])rejected(fixture({attestation:edit}),'OWNER_PROOF_ATTESTATION_INVALID');
});
test('actual UTC timestamps must be ordered and nonfuture; existing proof has no capabilityTTL expiry',()=>{
 for(const edit of [a=>a.observedUtc='PRIVATE',a=>a.confirmedUtc='2026-11-14T15:00:00Z',
  a=>a.observedUtc='2026-11-14T15:01:00Z',a=>a.confirmedUtc='2026-11-14T16:00:05.001Z'])rejected(fixture({attestation:edit}),'OWNER_PROOF_TIME_INVALID');
 for(const edit of [r=>r.startedUtc='PRIVATE',r=>r.completedUtc='2026-11-14T14:00:00Z',r=>r.completedUtc='2026-11-14T17:00:00Z'])
  rejected(fixture({result:edit}),'OWNER_PROOF_TIME_INVALID');
 const f=fixture();f.args.now+=30*86400000;assert.equal(resolveEscrowOwnerProof(f.args).proof.crypto.status,'PASS');
});
test('normalized canonical proof must match explicit Root-approved digest independently of escrow ciphertext hash',()=>{
 rejected(fixture({approval:a=>a.independentProofSha256='0'.repeat(64)}),'OWNER_PROOF_NORMALIZED_SHA_MISMATCH');
 rejected(fixture({approval:a=>a.backupCipherSha256=escrowSha}),'OWNER_PROOF_BACKUP_METADATA_INVALID');
 rejected(fixture({approval:a=>a.escrowCipherSha256=roleSha}),'OWNER_PROOF_CRYPTO_RESULT_INVALID');
});
test('malformed/oversized input and unexpected exceptions fail with finite redacted owner-proof errors',()=>{
 const f=fixture();for(const [key,value]of [['resultBytes',Buffer.alloc(65537)],['attestationBytes',Buffer.alloc(16385)],
  ['backupManifestBytes',Buffer.alloc(1048577)],['approvedInputBytes',Buffer.from('PRIVATE_NON_JSON')]])rejected({...f,args:{...f.args,[key]:value}});
 const bad=fixture();Object.defineProperty(bad.args.manifest,'owner_proof',{get(){throw Error('PRIVATE_age-secret_password');}});rejected(bad,'OWNER_PROOF_INVALID_INPUT');
});
