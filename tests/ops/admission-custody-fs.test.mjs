import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createAdmissionCustodyFs} from '../../docs/runbooks/payloads/admission-custody-fs.mjs';
import {captureMetadataCustody,metadataQuerySha256} from '../../docs/runbooks/payloads/admission-metadata-custody.mjs';
import {OWNER_PROOF_METHOD,OWNER_APPROVED_PATH,OWNER_RESULT_PATH,OWNER_ATTESTATION_PATH,resolveEscrowOwnerProof} from '../../docs/runbooks/payloads/owner-proof-binding.mjs';

const ROOT='/root/bron-secrets',sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=o=>JSON.stringify(o,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=o=>Buffer.from(canonical(o)+'\n');
const role=(name,extra={})=>({name,super:false,login:false,createRole:false,createDb:false,replication:false,
 bypass:false,connect:true,ownerPath:false,...extra});
const state=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',signal:true,pid:100,readOnly:'on',
 capturedMicros:'1794612345123456',acl:['PUBLIC','dashboard_user','postgres'].map(grantee=>
  ({grantee,grantor:'postgres',privilege:'CONNECT',grantable:false})),
 roles:[role('postgres',{login:true,ownerPath:true}),role('dashboard_user',{ownerPath:true}),role('pgbouncer',{login:true})],
 backends:[{pid:100,role:'postgres',type:'client backend',state:'active',openTransaction:true,super:false,providerAppKnown:false}],
 lookupCriticalWrites:0,lookupSequenceWrites:0,lookupCriticalDefiners:0,lookupOtherSetRoles:0,
 prepared:0,netQueued:0,unexpectedActiveCron:0,runJobsExists:false});
function fixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bron-admission-fs-'));fs.chmodSync(directory,0o700);
 const a={reviewed:true,actionId:'T99.http_source_admission',manifestSha256:'a'.repeat(64),
  sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',metadataReadAuthorized:true,
  metadataOnly:true,sourceRoute:'fixed-source-edge-https',macDataTransit:false,targetWritesStarted:false,
  beforeImagePath:ROOT+'/t99-admission-before-12345678.json',metadataReceiptPath:ROOT+'/t99-admission-metadata-12345678.json',
  inversePath:ROOT+'/t99-admission-inverse-12345678.sql',controlReceiptPath:ROOT+'/t99-admission-control-12345678.json',
  independentKeyProofPath:ROOT+'/t99-admission-key-proof-12345678.json',recoveryCipherSha256:'c'.repeat(64),
  controlTaskAuthorized:true,providerBoundaryReviewed:true,rollbackBeforeTargetWrites:true};
 const context=Object.fromEntries(['actionId','manifestSha256','sourceProject','destinationVps'].map(k=>[k,a[k]]));
 const crypto={status:'PASS',cipherShaVerified:true,decryptionVerified:true,plaintextStored:false,identityStored:false,
  externalCustody:'OWNER_CONFIRMATION_REQUIRED'};
 const rawCrypto=Buffer.from(JSON.stringify(crypto)+'\n'),rawReceipt=Buffer.from('{"task":"T30","status":"PASS"}\n');
 const attestation={task:'T30',action:'owner_key_proof',cryptoResultSha256:sha(rawCrypto),sourceReceiptPath:ROOT+'/t30-release-receipt.json',
  sourceReceiptSha256:sha(rawReceipt),independentCopy:true,personalSecondDeviceLogin:true,witnessedBy:'owner',deviceClass:'phone',
  observedUtc:new Date().toISOString()};
 const rawAttestation=Buffer.from(JSON.stringify(attestation)+'\n');
 const proof={format:1,sourceProject:a.sourceProject,destinationVps:a.destinationVps,
  crypto:{status:'PASS',cipherSha256:a.recoveryCipherSha256,cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
  attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:sha(rawAttestation)}};
 a.independentKeyProofSha256=sha(encode(proof));
 const proofInputs={crypto:{path:ROOT+'/t30-owner-key-proof-result.json',sha256:sha(rawCrypto)},
  attestation:{path:ROOT+'/t30-owner-key-attestation.json',sha256:sha(rawAttestation)},receipt:{path:ROOT+'/t30-release-receipt.json',sha256:sha(rawReceipt)},
  reviewedT30CipherBinding:{reviewed:true,task:'T30',cryptoResultSha256:sha(rawCrypto),sourceReceiptSha256:sha(rawReceipt),cipherSha256:a.recoveryCipherSha256}};
 const real=logical=>path.join(directory,path.basename(logical));
 const raw=(logical,content)=>{fs.writeFileSync(real(logical),content,{mode:0o600});fs.chmodSync(real(logical),0o600);};
 raw(proofInputs.crypto.path,rawCrypto);raw(proofInputs.attestation.path,rawAttestation);raw(proofInputs.receipt.path,rawReceipt);
 const keyTime=new Date(Date.now()-30000);fs.utimesSync(real(proofInputs.crypto.path),keyTime,keyTime);
 const testOnly={directory,uid:process.getuid(),gid:process.getgid()};
 let adapter;
 const open=(options={})=>adapter=createAdmissionCustodyFs({activation:a,proofInputs,...options},testOnly);
 const close=()=>{adapter?.close();fs.rmSync(directory,{recursive:true,force:true});};
 const request=(logical,content)=>({path:logical,bytes:content,sha256:sha(content),context});
 const before=()=>encode({format:1,kind:'source-admission-metadata-only',...context,metadataQuerySha256,state:state()});
 const receipt=()=>({format:1,status:'METADATA_PREPARED',...context,metadataQuerySha256,capturedMicros:state().capturedMicros,
  beforeImagePath:a.beforeImagePath,metadataReceiptPath:a.metadataReceiptPath,beforeImageSha256:sha(before()),beforeImageDurableOnVps:true,
  counts:{roles:3,acl:3,backends:1},ownerPids:[100],sourceEffects:false,sourceBarrierPass:false,rootComparisonRequired:true});
 return {directory,a,context,crypto,attestation,proof,proofInputs,testOnly,real,raw,request,before,receipt,open,close};
}

test('default production factory requires real Linux root; import itself has no I/O or output',()=>{
 if(process.getuid()!==0)assert.throws(()=>createAdmissionCustodyFs({activation:{}}),{code:'ADMISSION_FS_VPS_ROOT_REQUIRED'});
 const run=spawnSync(process.execPath,['--input-type=module','-e',
  "import './docs/runbooks/payloads/admission-custody-fs.mjs'"],{encoding:'utf8'});
 assert.equal(run.status,0);assert.equal(run.stdout,'');assert.equal(run.stderr,'');
});

// Synthetic escrow bytes use actual files and UID/GID evidence; no native crypto,
// network, key, encrypted identity or encrypted backup artifact is accessed.
function escrowFixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bron-escrow-fs-'));fs.chmodSync(directory,0o700);
 for(const name of ['t41-release','t41-owner-recovery'])fs.mkdirSync(path.join(directory,name),{mode:0o700});
 const parentManifestSha256='1'.repeat(64),cipherSha='2'.repeat(64),escrowSha='3'.repeat(64),now=Date.now(),stamp=offset=>new Date(now+offset).toISOString();
 const backupBytes=encode({artifacts:[{file:'roles.sql.zst.age',bytes:512,sha256:cipherSha}]}),backupSha=sha(backupBytes);
 const objectKey='migration/owner-key-escrow-'+'4'.repeat(32)+'/identity.age';
 const result={format:1,task:'T41',actionId:'T41.owner-key-recovery',method:OWNER_PROOF_METHOD,manifestSha256:parentManifestSha256,
  objectKey,startedUtc:stamp(-4000),oneAttempt:true,status:'PASS',completedUtc:stamp(-3000),parentManifestSha256,guardAction:'T41.owner-key-recovery',
  endpoint:'https://s3.twcstorage.ru',bucket:'bron-franchise-backups',cipherSha256:escrowSha,cipherBytes:1024,backupManifestSha256:backupSha,
  backupCipherSha256:cipherSha,backupCipherBytes:512,conditionalPut:true,putAttempts:1,getAttempts:1,putResponseUncertain:false,
  downloadShaVerified:true,cipherShaVerified:true,decryptionVerified:true,encryptedIdentity:{objectKey,ciphertextSha256:escrowSha,bytes:1024,scrypt:true},
  backupProbe:{manifestSha256:backupSha,artifact:'roles.sql.zst.age',cipherSha256:cipherSha,cipherBytes:512,decryptionVerified:true,zstdVerified:true},
  downloadedCipherShaVerified:true,originalIdentityReadForVerification:false,plaintextStored:false,plaintextRecoveredIdentityStored:false,
  identityStored:false,macDataTransit:false,externalCustody:'OWNER_CONFIRMATION_REQUIRED'};
 const resultBytes=encode(result),attestationBytes=encode({format:1,task:'T41',method:OWNER_PROOF_METHOD,status:'CONFIRMED',
  actionId:'T41.owner-key-recovery-attestation',observedUtc:stamp(-2000),confirmedUtc:stamp(-1000),resultSha256:sha(resultBytes),
  manifestSha256:parentManifestSha256,independentPassphraseCopy:true,adminVpsPhoneAccess:true,timewebPhoneAccess:true,macRequired:false});
 const proof={format:1,sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',
  crypto:{status:'PASS',cipherSha256:cipherSha,cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
  attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:sha(attestationBytes)}};
 const ownerScope={method:OWNER_PROOF_METHOD,root_approved_input_required:true,proposalSha256:'5'.repeat(64),
  recoveryCipherBinding:{manifestSha256:backupSha,artifact:'roles.sql.zst.age',from_pinned_backup_manifest:true}};
 const approvedInputBytes=encode({format:1,task:'T41',method:OWNER_PROOF_METHOD,manifestSha256:parentManifestSha256,
  resultSha256:sha(resultBytes),attestationSha256:sha(attestationBytes),backupManifestSha256:backupSha,
  backupCipherSha256:cipherSha,escrowCipherSha256:escrowSha,independentProofSha256:sha(encode(proof))});
 const resolved=resolveEscrowOwnerProof({manifest:{task:'T41',actionId:'T41.release_window',execution_authorized:true,owner_proof:ownerScope},
  parentManifestSha256,approvedInputBytes,approvedInputSha256:sha(approvedInputBytes),resultBytes,attestationBytes,backupManifestBytes:backupBytes,now});
 const a={reviewed:true,actionId:'T40.http_source_admission',manifestSha256:'a'.repeat(64),sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',
  metadataReadAuthorized:true,metadataOnly:true,sourceRoute:'fixed-source-edge-https',macDataTransit:false,targetWritesStarted:false,
  beforeImagePath:ROOT+'/t40-admission-before-c40a2026.json',metadataReceiptPath:ROOT+'/t40-admission-metadata-c40a2026.json',
  inversePath:ROOT+'/t40-admission-inverse-c40a2026.sql',controlReceiptPath:ROOT+'/t40-admission-control-c40a2026.json',
  independentKeyProofPath:ROOT+'/t40-admission-key-proof-c40a2026.json',independentKeyProofSha256:resolved.independentProofSha256,recoveryCipherSha256:resolved.recoveryCipherSha256};
 const real=logical=>path.join(directory,path.relative(ROOT,logical));
 for(const [logical,content]of [[OWNER_APPROVED_PATH,approvedInputBytes],[OWNER_RESULT_PATH,resultBytes],[OWNER_ATTESTATION_PATH,attestationBytes]])
  fs.writeFileSync(real(logical),content,{mode:0o600});
 fs.writeFileSync(path.join(directory,'t12-backup-manifest.json'),backupBytes,{mode:0o600});
 let adapter;
 return {directory,a,real,proof,resolved,open:()=>adapter=createAdmissionCustodyFs({activation:a,proofInputs:resolved.proofInputs},
  {directory,uid:process.getuid(),gid:process.getgid()}),close:()=>{adapter?.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

test('escrow filesystem branch validates Root-approved metadata and durably creates exact canonical proof with true ownership',()=>{
 const f=escrowFixture();try{const adapter=f.open(),r=adapter.prepareIndependentKeyProof();assert.equal(r.status,'KEY_PROOF_DURABLE');
  assert.equal(r.sha256,f.resolved.independentProofSha256);assert.equal(r.path,f.a.independentKeyProofPath);
  const saved=fs.readFileSync(f.real(r.path));assert.deepEqual(JSON.parse(saved),f.proof);assert.equal(sha(saved),r.sha256);
  const s=fs.statSync(f.real(r.path));assert.equal(s.uid,process.getuid());assert.equal(s.gid,process.getgid());assert.equal(s.mode&0o7777,0o600);
  const loaded=adapter.readIndependentKeyProof({path:r.path,sha256:r.sha256});assert.deepEqual(loaded.proof,f.proof);assert.equal(loaded.artifact.uid,process.getuid());
  assert.throws(()=>adapter.prepareIndependentKeyProof(),{code:'ADMISSION_FS_IO_UNCERTAIN'});
 }finally{f.close();}
});

test('escrow proof is not created on stale approval, changed result or missing attestation; plaintext/key artifacts are unnecessary',()=>{
 for(const mutate of [f=>fs.appendFileSync(f.real(OWNER_RESULT_PATH),' '),f=>fs.unlinkSync(f.real(OWNER_ATTESTATION_PATH)),
  f=>fs.writeFileSync(f.real(OWNER_APPROVED_PATH),'{}',{mode:0o600})]){
  const f=escrowFixture();try{mutate(f);const adapter=f.open();assert.throws(()=>adapter.prepareIndependentKeyProof(),{code:'ADMISSION_FS_OWNER_PROOF_PENDING'});
   assert.equal(fs.existsSync(f.real(f.a.independentKeyProofPath)),false);
  }finally{f.close();}
 }
});

test('escrow nested custody directories and metadata files enforce private modes, no links and fresh readback after proof creation',()=>{
 for(const mutate of [f=>fs.chmodSync(path.join(f.directory,'t41-owner-recovery'),0o755),
  f=>{const p=f.real(OWNER_RESULT_PATH);fs.renameSync(p,p+'.real');fs.symlinkSync(p+'.real',p);},
  f=>fs.linkSync(f.real(OWNER_ATTESTATION_PATH),path.join(f.directory,'alias'))]){
  const f=escrowFixture();try{mutate(f);const adapter=f.open();assert.throws(()=>adapter.prepareIndependentKeyProof(),{code:'ADMISSION_FS_OWNER_PROOF_PENDING'});
   assert.equal(fs.existsSync(f.real(f.a.independentKeyProofPath)),false);
  }finally{f.close();}
 }
 const f=escrowFixture();try{const adapter=f.open();adapter.prepareIndependentKeyProof();fs.appendFileSync(f.real(OWNER_ATTESTATION_PATH),' ');
  assert.throws(()=>adapter.readIndependentKeyProof({path:f.a.independentKeyProofPath,sha256:f.a.independentKeyProofSha256}),{code:'ADMISSION_FS_OWNER_PROOF_PENDING'});
 }finally{f.close();}
});

test('actual exclusive files are private, fsynced, read back and usable by the existing callback contract',()=>{
 const f=fixture();try{
  const adapter=f.open(),b=adapter.persistBeforeImage(f.request(f.a.beforeImagePath,f.before()));
  const m=adapter.persistReceipt(f.request(f.a.metadataReceiptPath,encode(f.receipt())));
  assert.equal(b.uid,process.getuid());assert.equal(b.gid,process.getgid());assert.equal(b.mode,0o600);
  assert.equal(b.fileFsynced,true);assert.equal(b.directoryFsynced,true);assert.equal(b.exclusive,true);
  assert.equal(b.sha256,sha(fs.readFileSync(f.real(f.a.beforeImagePath))));assert.equal(b.readbackSha256,b.sha256);
  const observed=adapter.confirmPreparedCustody({beforeImagePath:f.a.beforeImagePath,beforeImageSha256:b.sha256,
   metadataReceiptPath:f.a.metadataReceiptPath,metadataReceiptSha256:m.sha256});
  assert.equal(observed.beforeImage.sha256,b.sha256);assert.equal(Object.hasOwn(observed.beforeImage,'fileFsynced'),false);
  const loaded=adapter.loadPrepared();assert.deepEqual(loaded.before,JSON.parse(canonical(state())));
  assert.equal(loaded.stateReceipt.receiptSha256,m.sha256);
  assert.throws(()=>adapter.persistBeforeImage(f.request(f.a.beforeImagePath,f.before())),{code:'ADMISSION_FS_IO_UNCERTAIN'});
 }finally{f.close();}
});

test('production ownership evidence is never forged by fixture policy',async()=>{
 const f=fixture();try{
  const adapter=f.open();
  if(process.getuid()!==0){
   await assert.rejects(captureMetadataCustody({activation:f.a,readEncryptedMetadata:async()=>state(),...adapter}),
    {code:'ADMISSION_CUSTODY_DURABILITY_NOT_PROVED'});
   assert.equal(fs.existsSync(f.real(f.a.beforeImagePath)),true);assert.equal(fs.existsSync(f.real(f.a.metadataReceiptPath)),false);
  }
 }finally{f.close();}
});

test('private directory ownership, mode and symlinks are enforced before opening custody',()=>{
 for(const mutate of [f=>{fs.chmodSync(f.directory,0o755);},f=>{fs.chmodSync(f.directory,0o1700);},f=>{f.testOnly.uid++;},f=>{f.testOnly.gid++;}]){
  const f=fixture();try{mutate(f);assert.throws(()=>f.open(),{code:'ADMISSION_FS_DIRECTORY_UNSAFE'});}finally{f.close();}
 }
 const f=fixture(),link=f.directory+'-link';try{
  fs.symlinkSync(f.directory,link);f.testOnly.directory=link;
  assert.throws(()=>f.open(),{code:'ADMISSION_FS_DIRECTORY_UNSAFE'});
 }finally{fs.unlinkSync(link);f.close();}
});

test('regular root-policy file checks reject weak permissions, ownership mismatch, symlink, FIFO and hardlink',()=>{
 for(const type of ['mode','specialmode','hardlink','symlink','fifo']){
  const f=fixture();try{
   const adapter=f.open();adapter.persistBeforeImage(f.request(f.a.beforeImagePath,f.before()));
   adapter.persistReceipt(f.request(f.a.metadataReceiptPath,encode(f.receipt())));
   const target=f.real(f.a.beforeImagePath);
   if(type==='mode')fs.chmodSync(target,0o644);
   if(type==='specialmode')fs.chmodSync(target,0o4600);
   if(type==='hardlink')fs.linkSync(target,f.directory+'/alias');
   if(type==='symlink'){fs.renameSync(target,target+'.saved');fs.symlinkSync(target+'.saved',target);}
   if(type==='fifo'){fs.unlinkSync(target);const child=spawnSync('mkfifo',[target]);assert.equal(child.status,0);fs.chmodSync(target,0o600);}
   assert.throws(()=>adapter.loadPrepared(),error=>{
    assert.ok(['ADMISSION_FS_FILE_UNSAFE','ADMISSION_FS_IO_UNCERTAIN'].includes(error.code));return true;
   });
  }finally{f.close();}
 }
});

test('filename and SHA bounds cannot target backup, identity, traversal, wrong task or extra artifacts',()=>{
 const f=fixture();try{
  const adapter=f.open();
  for(const bad of [ROOT+'/source-backup.agekey','/var/backups/roles.sql.zst.age',ROOT+'/../outside',
   ROOT+'/t98-admission-before-12345678.json',ROOT+'/unexpected.json'])
   assert.throws(()=>adapter.persistBeforeImage(f.request(bad,f.before())),{code:'ADMISSION_FS_PATH'});
  for(const content of [Buffer.alloc(1048577),Buffer.alloc(0)])
   assert.throws(()=>adapter.persistInverse(f.request(f.a.inversePath,content)),{code:'ADMISSION_FS_WRITE_INVALID'});
  assert.throws(()=>adapter.persistInverse({...f.request(f.a.inversePath,Buffer.from('synthetic')),sha256:'0'.repeat(64)}),{code:'ADMISSION_FS_WRITE_INVALID'});
  assert.equal(fs.existsSync(f.real(f.a.beforeImagePath)),false);
 }finally{f.close();}
});

test('metadata and receipts reject private extra fields and noncanonical JSON before file creation',()=>{
 const f=fixture();try{
  const adapter=f.open(),before=JSON.parse(f.before());before.state.authUsers=[];
  assert.throws(()=>adapter.persistBeforeImage(f.request(f.a.beforeImagePath,encode(before))),{code:'ADMISSION_FS_METADATA_INVALID'});
  assert.throws(()=>adapter.persistBeforeImage(f.request(f.a.beforeImagePath,Buffer.from(JSON.stringify(JSON.parse(f.before()))))),{code:'ADMISSION_FS_NONCANONICAL_JSON'});
  assert.throws(()=>adapter.persistReceipt(f.request(f.a.metadataReceiptPath,encode({...f.receipt(),privateRows:[]}))),{code:'ADMISSION_FS_SHAPE'});
  assert.equal(fs.existsSync(f.real(f.a.beforeImagePath)),false);
 }finally{f.close();}
});

test('fsync failure at file or parent leaves private uncertainty and no automatic overwrite/retry',t=>{
 for(const failAt of [1,2]){
  const f=fixture();try{
   const adapter=f.open(),original=fs.fsyncSync;let syncs=0;
   const mocked=t.mock.method(fs,'fsyncSync',fd=>{syncs++;if(syncs===failAt)throw new Error('PRIVATE_IO_DETAIL');return original(fd);});
   assert.throws(()=>adapter.persistBeforeImage(f.request(f.a.beforeImagePath,f.before())),error=>{
    assert.equal(error.code,'ADMISSION_FS_IO_UNCERTAIN');assert.equal(error.retryAllowed,false);
    assert.equal(error.message.includes('PRIVATE'),false);return true;
   });mocked.mock.restore();
   assert.equal(syncs,failAt);assert.equal(fs.existsSync(f.real(f.a.beforeImagePath)),true);
   assert.equal(fs.statSync(f.real(f.a.beforeImagePath)).mode&0o777,0o600);
   assert.throws(()=>adapter.persistBeforeImage(f.request(f.a.beforeImagePath,f.before())),{code:'ADMISSION_FS_IO_UNCERTAIN'});
  }finally{t.mock.restoreAll();f.close();}
 }
});

test('exact inverse is immutable, and safe CONTROL_READY receipt follows the existing schema',()=>{
 const f=fixture();try{
  const adapter=f.open();adapter.persistBeforeImage(f.request(f.a.beforeImagePath,f.before()));
  adapter.persistReceipt(f.request(f.a.metadataReceiptPath,encode(f.receipt())));
  const inverse=Buffer.from('DO $bron_http_admission$ BEGIN NULL; END $bron_http_admission$;');
  const saved=adapter.persistInverse(f.request(f.a.inversePath,inverse));assert.equal(saved.sha256,sha(inverse));
  assert.equal(fs.readFileSync(f.real(f.a.inversePath)).equals(inverse),true);
  const r={...f.receipt(),status:'CONTROL_READY',metadataReceiptSha256:sha(encode(f.receipt())),inversePath:f.a.inversePath,
   controlReceiptPath:f.a.controlReceiptPath,inverseDurableOnVps:true,
   sqlHashes:Object.fromEntries(['applySql','drainSql','verifyFencedSql','inverseSql','verifyOriginalSql'].map(k=>[k,k==='inverseSql'?sha(inverse):'e'.repeat(64)])),
   independentKeyProofSha256:f.a.independentKeyProofSha256,recoveryCipherSha256:f.a.recoveryCipherSha256,
   providerSuperusersFenced:false,actualSupavisorRecovery:'NOT_TESTED'};
  assert.equal(adapter.persistReceipt(f.request(f.a.controlReceiptPath,encode(r))).sha256,sha(encode(r)));
  assert.throws(()=>adapter.persistInverse(f.request(f.a.inversePath,inverse)),{code:'ADMISSION_FS_IO_UNCERTAIN'});
 }finally{f.close();}
});

test('actual T30 crypto metadata plus separate pinned owner attestation materialize the exact core proof envelope',()=>{
 const f=fixture();try{
  const adapter=f.open(),prepared=adapter.prepareIndependentKeyProof();assert.equal(prepared.status,'KEY_PROOF_DURABLE');
  assert.equal(prepared.sha256,f.a.independentKeyProofSha256);
  assert.equal(fs.readFileSync(f.real(f.a.independentKeyProofPath)).equals(encode(f.proof)),true);
  const read=adapter.readIndependentKeyProof({path:f.a.independentKeyProofPath,sha256:prepared.sha256});
  assert.deepEqual(read.proof,f.proof);assert.equal(read.artifact.uid,process.getuid());
  assert.equal(JSON.stringify(prepared).includes('independentCopy'),false);
  assert.throws(()=>adapter.prepareIndependentKeyProof(),{code:'ADMISSION_FS_IO_UNCERTAIN'});
 }finally{f.close();}
});

test('missing actual owner evidence remains pending, without reading key/backup or fabricating crypto PASS',()=>{
 for(const missing of ['crypto','attestation','receipt']){
  const f=fixture();try{
   fs.unlinkSync(f.real(f.proofInputs[missing].path));const adapter=f.open();
   assert.throws(()=>adapter.prepareIndependentKeyProof(),{code:'ADMISSION_FS_OWNER_PROOF_PENDING'});
   assert.equal(fs.existsSync(f.real(f.a.independentKeyProofPath)),false);
  }finally{f.close();}
 }
 const f=fixture();try{
  const adapter=f.open({proofInputs:undefined});assert.throws(()=>adapter.prepareIndependentKeyProof(),{code:'ADMISSION_FS_OWNER_PROOF_PENDING'});
 }finally{f.close();}
});

test('READY check-only status, failed decryption, stored identities and missing custody cannot become proof',()=>{
 for(const mutate of [f=>{f.crypto.status='READY';},f=>{f.crypto.decryptionVerified=false;},f=>{f.crypto.identityStored=true;},
  f=>{f.crypto.plaintextStored=true;},f=>{f.attestation.independentCopy=false;},f=>{f.attestation.personalSecondDeviceLogin=false;},
  f=>{f.attestation.witnessedBy='executor';},f=>{f.attestation.deviceClass='Mac';}]){
  const f=fixture();try{
   mutate(f);const rawCrypto=Buffer.from(JSON.stringify(f.crypto)+'\n');f.raw(f.proofInputs.crypto.path,rawCrypto);
   f.proofInputs.crypto.sha256=sha(rawCrypto);f.proofInputs.reviewedT30CipherBinding.cryptoResultSha256=sha(rawCrypto);
   f.attestation.cryptoResultSha256=sha(rawCrypto);const raw=Buffer.from(JSON.stringify(f.attestation)+'\n');f.raw(f.proofInputs.attestation.path,raw);
   f.proofInputs.attestation.sha256=sha(raw);const adapter=f.open();
   assert.throws(()=>adapter.prepareIndependentKeyProof(),error=>{
    assert.ok(['ADMISSION_FS_OWNER_CRYPTO_REQUIRED','ADMISSION_FS_OWNER_ATTESTATION_REQUIRED'].includes(error.code));return true;
   });assert.equal(fs.existsSync(f.real(f.a.independentKeyProofPath)),false);
  }finally{f.close();}
 }
});

test('cipher association and every evidence SHA must be reviewed/pinned; raw crypto booleans do not supply cipher SHA',()=>{
 for(const mutate of [f=>{f.proofInputs.reviewedT30CipherBinding.reviewed=false;},
  f=>{f.proofInputs.reviewedT30CipherBinding.cipherSha256='f'.repeat(64);},
  f=>{f.proofInputs.crypto.sha256='f'.repeat(64);},f=>{f.proofInputs.receipt.sha256='f'.repeat(64);},
  f=>{f.a.independentKeyProofSha256='f'.repeat(64);},
  f=>{f.proofInputs.crypto.path=ROOT+'/source-backup.agekey';}]){
  const f=fixture();try{mutate(f);const adapter=f.open();assert.throws(()=>adapter.prepareIndependentKeyProof());
   assert.equal(fs.existsSync(f.real(f.a.independentKeyProofPath)),false);
  }finally{f.close();}
 }
});

test('proof readback revalidates current actual crypto and attestation, not just a pre-existing envelope',()=>{
 const f=fixture();try{
  const adapter=f.open();adapter.prepareIndependentKeyProof();f.raw(f.proofInputs.crypto.path,Buffer.from('{}'));
  assert.throws(()=>adapter.readIndependentKeyProof({path:f.a.independentKeyProofPath,sha256:f.a.independentKeyProofSha256}),{code:'ADMISSION_FS_SHA_MISMATCH'});
 }finally{f.close();}
});

test('changed directory identity and closed adapter block subsequent operations',()=>{
 const f=fixture(),moved=f.directory+'-moved';try{
  const adapter=f.open();fs.renameSync(f.directory,moved);fs.mkdirSync(f.directory,{mode:0o700});
  assert.throws(()=>adapter.persistInverse(f.request(f.a.inversePath,Buffer.from('synthetic'))),{code:'ADMISSION_FS_DIRECTORY_CHANGED'});
  adapter.close();assert.throws(()=>adapter.loadPrepared(),{code:'ADMISSION_FS_CLOSED'});
 }finally{fs.rmSync(moved,{recursive:true,force:true});f.close();}
});
