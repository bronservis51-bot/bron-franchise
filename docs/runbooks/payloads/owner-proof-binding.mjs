// Pure binding of the owner's escrow exception to pinned, already-created proof metadata.
// No filesystem, network, key, encrypted identity or backup-artifact access occurs here.
import {createHash} from 'node:crypto';

export const OWNER_PROOF_METHOD='BRON_OWNER_KEY_ESCROW_V1';
export const OWNER_APPROVED_PATH='/root/bron-secrets/t41-release/owner-proof-approved.json';
export const OWNER_RESULT_PATH='/root/bron-secrets/t41-owner-recovery/result.json';
export const OWNER_ATTESTATION_PATH='/root/bron-secrets/t41-owner-recovery/attestation.json';
export const BACKUP_MANIFEST_PATH='/var/backups/bron-franchise/target-20261113T133022Z-c4d9bbfd/manifest.json';
const PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115',ARTIFACT='roles.sql.zst.age';
const own=Symbol('safe-owner-proof-error');
const fail=code=>{throw Object.assign(new Error(code),{code,status:'BLOCKED_OWNER_PROOF',[own]:true});};
const safe=fn=>{try{return fn();}catch(e){if(e?.[own])throw e;fail('OWNER_PROOF_INVALID_INPUT');}};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encoded=x=>Buffer.from(canonical(x)+'\n');
const number=(x,max)=>Number.isSafeInteger(x)&&x>0&&x<=max;
function json(raw,max){
 if(!Buffer.isBuffer(raw)||raw.length<1||raw.length>max)fail('OWNER_PROOF_BYTES_INVALID');
 try{return JSON.parse(raw.toString('utf8'));}catch{fail('OWNER_PROOF_JSON_INVALID');}
}
function time(value){
 if(typeof value!=='string'||!/(?:Z|\+00:00)$/.test(value)||value.length>40||!Number.isFinite(Date.parse(value)))fail('OWNER_PROOF_TIME_INVALID');
 return Date.parse(value);
}
export function validateEscrowOwnerScope(scope){return safe(()=>{
 if(!object(scope)||scope.method!==OWNER_PROOF_METHOD||scope.root_approved_input_required!==true||!digest(scope.proposalSha256)||
  !exact(scope.recoveryCipherBinding,['manifestSha256','artifact','from_pinned_backup_manifest'])||
  !digest(scope.recoveryCipherBinding.manifestSha256)||scope.recoveryCipherBinding.artifact!==ARTIFACT||
  scope.recoveryCipherBinding.from_pinned_backup_manifest!==true)fail('OWNER_PROOF_SCOPE_INVALID');
 return {method:OWNER_PROOF_METHOD,root_approved_input_required:true,proposalSha256:scope.proposalSha256,
  recoveryCipherBinding:{manifestSha256:scope.recoveryCipherBinding.manifestSha256,artifact:ARTIFACT,from_pinned_backup_manifest:true}};
});}

const resultKeys=['format','task','actionId','method','manifestSha256','objectKey','startedUtc','oneAttempt','status','completedUtc',
 'parentManifestSha256','guardAction','endpoint','bucket','cipherSha256','cipherBytes','backupManifestSha256','backupCipherSha256','backupCipherBytes',
 'conditionalPut','putAttempts','getAttempts','putResponseUncertain','downloadShaVerified','cipherShaVerified','decryptionVerified',
 'encryptedIdentity','backupProbe','downloadedCipherShaVerified','originalIdentityReadForVerification','plaintextStored','plaintextRecoveredIdentityStored',
 'identityStored','macDataTransit','externalCustody'];
const approvalKeys=['format','task','method','manifestSha256','resultSha256','attestationSha256','backupManifestSha256',
 'backupCipherSha256','escrowCipherSha256','independentProofSha256'];
const attestationKeys=['format','task','method','status','actionId','observedUtc','resultSha256','manifestSha256',
 'independentPassphraseCopy','adminVpsPhoneAccess','timewebPhoneAccess','macRequired','confirmedUtc'];

export function resolveEscrowOwnerProof(input){return safe(()=>{
 const {manifest,parentManifestSha256,approvedInputBytes,approvedInputSha256,resultBytes,attestationBytes,backupManifestBytes,now=Date.now()}=input??{};
 const ownerScope=validateEscrowOwnerScope(manifest?.owner_proof);
 if(manifest?.task!=='T41'||manifest.actionId!=='T41.release_window'||manifest.execution_authorized!==true||
  !digest(parentManifestSha256)||!digest(approvedInputSha256)||!Number.isSafeInteger(now)||now<0)
  fail('OWNER_PROOF_PARENT_BINDING_INVALID');
 const approval=json(approvedInputBytes,16384);
 if(sha(approvedInputBytes)!==approvedInputSha256||!exact(approval,approvalKeys)||approval.format!==1||approval.task!=='T41'||
  approval.method!==OWNER_PROOF_METHOD||approval.manifestSha256!==parentManifestSha256||
  !['resultSha256','attestationSha256','backupManifestSha256','backupCipherSha256','escrowCipherSha256','independentProofSha256'].every(k=>digest(approval[k])))
  fail('OWNER_PROOF_ROOT_APPROVAL_INVALID');
 const result=json(resultBytes,65536),attestation=json(attestationBytes,16384),backup=json(backupManifestBytes,1048576);
 if(sha(resultBytes)!==approval.resultSha256||sha(attestationBytes)!==approval.attestationSha256||
  sha(backupManifestBytes)!==approval.backupManifestSha256||approval.backupManifestSha256!==ownerScope.recoveryCipherBinding.manifestSha256)
  fail('OWNER_PROOF_ARTIFACT_SHA_MISMATCH');
 if(!Array.isArray(backup?.artifacts)||backup.artifacts.length>1024)fail('OWNER_PROOF_BACKUP_METADATA_INVALID');
 const artifacts=backup.artifacts.filter(e=>object(e)&&e.file===ARTIFACT);
 if(artifacts.length!==1||!exact(artifacts[0],['file','bytes','sha256'])||!digest(artifacts[0].sha256)||
  !number(artifacts[0].bytes,10*1024*1024)||artifacts[0].sha256!==approval.backupCipherSha256)
  fail('OWNER_PROOF_BACKUP_METADATA_INVALID');
 const backupArtifact=artifacts[0],identity=result?.encryptedIdentity,probe=result?.backupProbe;
 if(!exact(result,resultKeys)||result.format!==1||result.task!=='T41'||result.method!==OWNER_PROOF_METHOD||result.status!=='PASS'||
  result.actionId!=='T41.owner-key-recovery'||result.guardAction!==result.actionId||result.manifestSha256!==parentManifestSha256||
  result.parentManifestSha256!==parentManifestSha256||result.oneAttempt!==true||result.endpoint!=='https://s3.twcstorage.ru'||
  result.bucket!=='bron-franchise-backups'||typeof result.objectKey!=='string'||!/^migration\/owner-key-escrow-[a-f0-9]{32}\/identity\.age$/.test(result.objectKey)||
  !digest(result.cipherSha256)||result.cipherSha256!==approval.escrowCipherSha256||!number(result.cipherBytes,65536)||
  result.backupManifestSha256!==approval.backupManifestSha256||result.backupCipherSha256!==backupArtifact.sha256||result.backupCipherBytes!==backupArtifact.bytes||
  result.conditionalPut!==true||result.putAttempts!==1||result.getAttempts!==1||typeof result.putResponseUncertain!=='boolean'||
  ['downloadShaVerified','cipherShaVerified','decryptionVerified','downloadedCipherShaVerified'].some(k=>result[k]!==true)||
  ['originalIdentityReadForVerification','plaintextStored','plaintextRecoveredIdentityStored','identityStored','macDataTransit'].some(k=>result[k]!==false)||
  result.externalCustody!=='OWNER_CONFIRMATION_REQUIRED'||!exact(identity,['objectKey','ciphertextSha256','bytes','scrypt'])||
  identity.objectKey!==result.objectKey||identity.ciphertextSha256!==result.cipherSha256||identity.bytes!==result.cipherBytes||identity.scrypt!==true||
  !exact(probe,['manifestSha256','artifact','cipherSha256','cipherBytes','decryptionVerified','zstdVerified'])||
  probe.manifestSha256!==result.backupManifestSha256||probe.artifact!==ARTIFACT||probe.cipherSha256!==result.backupCipherSha256||
  probe.cipherBytes!==result.backupCipherBytes||probe.decryptionVerified!==true||probe.zstdVerified!==true)
  fail('OWNER_PROOF_CRYPTO_RESULT_INVALID');
 const started=time(result.startedUtc),completed=time(result.completedUtc);
 if(completed<started||completed>now+5000)fail('OWNER_PROOF_TIME_INVALID');
 if(!exact(attestation,attestationKeys)||attestation.format!==1||attestation.task!=='T41'||attestation.method!==OWNER_PROOF_METHOD||
  attestation.status!=='CONFIRMED'||attestation.actionId!=='T41.owner-key-recovery-attestation'||attestation.resultSha256!==approval.resultSha256||
  attestation.manifestSha256!==parentManifestSha256||attestation.independentPassphraseCopy!==true||attestation.adminVpsPhoneAccess!==true||
  attestation.timewebPhoneAccess!==true||attestation.macRequired!==false)fail('OWNER_PROOF_ATTESTATION_INVALID');
 const observed=time(attestation.observedUtc),confirmed=time(attestation.confirmedUtc);
 if(observed<completed||confirmed<observed||confirmed>now+5000)fail('OWNER_PROOF_TIME_INVALID');
 const proof={format:1,sourceProject:PROJECT,destinationVps:VPS,
  crypto:{status:'PASS',cipherSha256:backupArtifact.sha256,cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
  attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:approval.attestationSha256}};
 const independentProofSha256=sha(encoded(proof));
 if(independentProofSha256!==approval.independentProofSha256)fail('OWNER_PROOF_NORMALIZED_SHA_MISMATCH');
 return {independentProofSha256,recoveryCipherSha256:backupArtifact.sha256,proof,
  proofInputs:{method:OWNER_PROOF_METHOD,parentManifestSha256,ownerScope,
   approvedInput:{path:OWNER_APPROVED_PATH,sha256:approvedInputSha256},result:{path:OWNER_RESULT_PATH,sha256:approval.resultSha256},
   attestation:{path:OWNER_ATTESTATION_PATH,sha256:approval.attestationSha256}},approvedInputSha256};
});}
