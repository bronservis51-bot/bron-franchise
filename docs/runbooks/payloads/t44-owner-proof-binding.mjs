// Pure metadata binding for the actual, isolated T44 recovery attempt.
// No filesystem, network, key, encrypted-identity or backup-artifact access.
import {createHash} from 'node:crypto';

export const T44_OWNER_METHOD='BRON_OWNER_KEY_ESCROW_V1';
export const T44_OWNER_STATE_ROOT='/root/bron-secrets/t44-owner-recovery';
export const T44_OWNER_RESULT_PATH=T44_OWNER_STATE_ROOT+'/result.json';
export const T44_OWNER_ATTESTATION_PATH=T44_OWNER_STATE_ROOT+'/attestation.json';
export const T44_PARENT_MANIFEST_SHA256='54c34e5abdf553fb36194aeca7f81251f1859af832b8406a48fe1520c4ae0321';
export const T44_FAILED_GUARD_SHA256='b0dbe110d4fb66d87af93002d1fdcf91ae31e836a38fee9e51b234426d74889f';
export const T44_FAILED_RESULT_SHA256='7f201d9c8fd7293998e2285e90664b0afa5850a784d4f79870bf458e6849db11';
export const T44_BACKUP_MANIFEST_SHA256='a1f6a1c9f187bd586aeec5d0189adc4f6648df29acb8c68490bf4fc77541d6b9';
const METHOD=T44_OWNER_METHOD,ACTION='T44.owner-key-recovery',ARTIFACT='roles.sql.zst.age';
const own=Symbol('safe-t44-owner-proof-error');
const fail=code=>{throw Object.assign(new Error(code),{code,status:'BLOCKED_T44_OWNER_PROOF',[own]:true});};
const safe=fn=>{try{return fn();}catch(e){if(e?.[own])throw e;fail('T44_OWNER_PROOF_INVALID_INPUT');}};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encoded=x=>Buffer.from(canonical(x)+'\n');
const bounded=(x,max)=>Number.isSafeInteger(x)&&x>0&&x<=max;
function json(raw,max){
 if(!Buffer.isBuffer(raw)||raw.length<1||raw.length>max)fail('T44_OWNER_PROOF_BYTES_INVALID');
 try{return JSON.parse(raw.toString('utf8'));}catch{fail('T44_OWNER_PROOF_JSON_INVALID');}
}
function time(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value)||!Number.isFinite(Date.parse(value)))
  fail('T44_OWNER_PROOF_TIME_INVALID');
 return Date.parse(value);
}
const lineageKeys=['parentT41ManifestSha256','failedT41GuardSha256','failedT41ResultSha256','attemptNumber','oldT41Unchanged'];
function lineage(value){
 return value?.parentT41ManifestSha256===T44_PARENT_MANIFEST_SHA256&&value.failedT41GuardSha256===T44_FAILED_GUARD_SHA256&&
  value.failedT41ResultSha256===T44_FAILED_RESULT_SHA256&&value.attemptNumber===2&&value.oldT41Unchanged===true;
}
const resultKeys=['format','task','actionId','method','manifestSha256','objectKey','startedUtc','oneAttempt','oneFinalInvocation','status','completedUtc',
 'guardAction','endpoint','bucket','cipherSha256','cipherBytes','backupManifestSha256','backupCipherSha256','backupCipherBytes',
 'conditionalPut','putAttempts','getAttempts','putResponseUncertain','downloadShaVerified','cipherShaVerified','decryptionVerified',
 'encryptedIdentity','backupProbe','downloadedCipherShaVerified','originalIdentityReadForVerification','plaintextStored','plaintextRecoveredIdentityStored',
 'identityStored','macDataTransit','externalCustody','putOutcome','originalIdentityOpened',...lineageKeys];
const attestationKeys=['format','task','method','status','actionId','observedUtc','resultSha256','manifestSha256',
 'independentPassphraseCopy','adminVpsPhoneAccess','timewebPhoneAccess','macRequired','confirmedUtc',...lineageKeys];

// Schema/semantic validation only. This helper does not establish byte custody or
// Root approval; consumers must use resolveT44EscrowOwnerProof for that binding.
export function validateT44RecoveryRecords(input){return safe(()=>{
 const {manifestSha256,result,resultSha256,attestation,backupArtifact,now=Date.now()}=input??{};
 if(!digest(manifestSha256)||!digest(resultSha256)||!Number.isSafeInteger(now)||now<0||
  !exact(backupArtifact,['file','bytes','sha256'])||backupArtifact.file!==ARTIFACT||
  !bounded(backupArtifact.bytes,10*1024*1024)||!digest(backupArtifact.sha256))fail('T44_OWNER_PROOF_RECORD_INPUT_INVALID');
 const identity=result?.encryptedIdentity,probe=result?.backupProbe;
 if(!exact(result,resultKeys)||!lineage(result)||result.format!==1||result.task!=='T44'||result.actionId!==ACTION||
  result.guardAction!==ACTION||result.method!==METHOD||result.status!=='PASS'||result.manifestSha256!==manifestSha256||
  result.oneAttempt!==true||result.oneFinalInvocation!==true||result.endpoint!=='https://s3.twcstorage.ru'||
  result.bucket!=='bron-franchise-backups'||typeof result.objectKey!=='string'||!/^migration\/owner-key-escrow-[a-f0-9]{32}\/identity\.age$/.test(result.objectKey)||
  !digest(result.cipherSha256)||!bounded(result.cipherBytes,65536)||result.backupManifestSha256!==T44_BACKUP_MANIFEST_SHA256||
  result.backupCipherSha256!==backupArtifact.sha256||result.backupCipherBytes!==backupArtifact.bytes||
  result.conditionalPut!==true||result.putAttempts!==1||result.getAttempts!==1||typeof result.putResponseUncertain!=='boolean'||
  result.putOutcome!=='CONFIRMED_BY_READBACK'||result.originalIdentityOpened!==true||
  ['downloadShaVerified','cipherShaVerified','decryptionVerified','downloadedCipherShaVerified'].some(k=>result[k]!==true)||
  ['originalIdentityReadForVerification','plaintextStored','plaintextRecoveredIdentityStored','identityStored','macDataTransit'].some(k=>result[k]!==false)||
  result.externalCustody!=='OWNER_CONFIRMATION_REQUIRED'||!exact(identity,['objectKey','ciphertextSha256','bytes','scrypt'])||
  identity.objectKey!==result.objectKey||identity.ciphertextSha256!==result.cipherSha256||identity.bytes!==result.cipherBytes||identity.scrypt!==true||
  !exact(probe,['manifestSha256','artifact','cipherSha256','cipherBytes','decryptionVerified','zstdVerified'])||
  probe.manifestSha256!==T44_BACKUP_MANIFEST_SHA256||probe.artifact!==ARTIFACT||probe.cipherSha256!==backupArtifact.sha256||
  probe.cipherBytes!==backupArtifact.bytes||probe.decryptionVerified!==true||probe.zstdVerified!==true)fail('T44_OWNER_PROOF_CRYPTO_RESULT_INVALID');
 const started=time(result.startedUtc),completed=time(result.completedUtc);
 if(completed<started||completed>now+5000)fail('T44_OWNER_PROOF_TIME_INVALID');
 if(!exact(attestation,attestationKeys)||!lineage(attestation)||attestation.format!==1||attestation.task!=='T44'||attestation.method!==METHOD||
  attestation.status!=='CONFIRMED'||attestation.actionId!=='T44.owner-key-recovery-attestation'||attestation.resultSha256!==resultSha256||
  attestation.manifestSha256!==manifestSha256||attestation.independentPassphraseCopy!==true||attestation.adminVpsPhoneAccess!==true||
  attestation.timewebPhoneAccess!==true||attestation.macRequired!==false)fail('T44_OWNER_PROOF_ATTESTATION_INVALID');
 const observed=time(attestation.observedUtc),confirmed=time(attestation.confirmedUtc);
 if(observed<completed||confirmed<observed||confirmed>now+5000)fail('T44_OWNER_PROOF_TIME_INVALID');
 return {status:'VALID_RECORDS_ONLY',rootApprovalRequired:true};
});}

export function resolveT44EscrowOwnerProof(input){return safe(()=>{
 const {ownManifestBytes,expectedManifestSha256,resultBytes,attestationBytes,oldGuardBytes,oldResultBytes,backupManifestBytes,now=Date.now()}=input??{};
 if(!digest(expectedManifestSha256))fail('T44_OWNER_PROOF_MANIFEST_BINDING_INVALID');
 const manifest=json(ownManifestBytes,1048576);
 if(sha(ownManifestBytes)!==expectedManifestSha256||manifest?.task!=='T44'||manifest.actionId!==ACTION||manifest.execution_authorized!==true||
  manifest.parentT41ManifestSha256!==T44_PARENT_MANIFEST_SHA256||manifest.failedT41GuardSha256!==T44_FAILED_GUARD_SHA256||
  manifest.failedT41ResultSha256!==T44_FAILED_RESULT_SHA256||manifest.ownerFinalAttemptAuthorized!==true||
  manifest.maxAdditionalOwnerRecoverAttempts!==1||manifest.attemptNumber!==2||manifest.stateRoot!==T44_OWNER_STATE_ROOT||
  manifest.shared_auth_budget_unchanged?.used!==1||manifest.shared_auth_budget_unchanged?.remaining!==2)
  fail('T44_OWNER_PROOF_MANIFEST_BINDING_INVALID');
 const oldGuard=json(oldGuardBytes,16384),oldResult=json(oldResultBytes,16384),backup=json(backupManifestBytes,1048576);
 if(sha(oldGuardBytes)!==T44_FAILED_GUARD_SHA256||sha(oldResultBytes)!==T44_FAILED_RESULT_SHA256||
  sha(backupManifestBytes)!==T44_BACKUP_MANIFEST_SHA256)fail('T44_OWNER_PROOF_PINNED_BYTES_MISMATCH');
 if(oldGuard?.task!=='T41'||oldGuard.actionId!=='T41.owner-key-recovery'||oldGuard.method!==METHOD||oldGuard.oneAttempt!==true||
  oldGuard.manifestSha256!==T44_PARENT_MANIFEST_SHA256||oldResult?.task!=='T41'||oldResult.actionId!==oldGuard.actionId||
  oldResult.method!==METHOD||oldResult.manifestSha256!==T44_PARENT_MANIFEST_SHA256||oldResult.status!=='BLOCKED'||
  oldResult.phase!=='seal'||oldResult.code!=='RECOVERY_PHASE_FAILED'||oldResult.retryAuthorized!==false||
  oldResult.oneAttempt!==true||oldResult.objectKey!==oldGuard.objectKey||oldResult.startedUtc!==oldGuard.startedUtc)
  fail('T44_OWNER_PROOF_FAILED_LINEAGE_INVALID');
 if(!Array.isArray(backup?.artifacts)||backup.artifacts.length>1024)fail('T44_OWNER_PROOF_BACKUP_METADATA_INVALID');
 const artifacts=backup.artifacts.filter(e=>object(e)&&e.file===ARTIFACT);
 if(artifacts.length!==1)fail('T44_OWNER_PROOF_BACKUP_METADATA_INVALID');
 const result=json(resultBytes,65536),attestation=json(attestationBytes,16384),resultSha256=sha(resultBytes),attestationSha256=sha(attestationBytes);
 validateT44RecoveryRecords({manifestSha256:expectedManifestSha256,result,resultSha256,attestation,backupArtifact:artifacts[0],now});
 const proof={format:1,sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',
  crypto:{status:'PASS',cipherSha256:artifacts[0].sha256,cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
  attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:attestationSha256}};
 return {independentProofSha256:sha(encoded(proof)),recoveryCipherSha256:artifacts[0].sha256,proof,rootApprovalRequired:true,
  proofInputs:{task:'T44',method:METHOD,stateRoot:T44_OWNER_STATE_ROOT,manifestSha256:expectedManifestSha256,
   parentT41ManifestSha256:T44_PARENT_MANIFEST_SHA256,failedT41GuardSha256:T44_FAILED_GUARD_SHA256,failedT41ResultSha256:T44_FAILED_RESULT_SHA256,
   attemptNumber:2,oldT41Unchanged:true,sourceSnapshotBudgetAtRecovery:{total:3,used:1,remaining:2},
   result:{path:T44_OWNER_RESULT_PATH,sha256:resultSha256},attestation:{path:T44_OWNER_ATTESTATION_PATH,sha256:attestationSha256},
   backupManifestSha256:T44_BACKUP_MANIFEST_SHA256}};
});}
