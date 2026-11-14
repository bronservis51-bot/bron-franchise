// VPS filesystem adapter only: no network, database, subprocess, key or backup read.
// Importing does nothing. The runner owns activation/one-run guards and closes this
// adapter in finally. Never serialize loadPrepared() outside the VPS process.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateAdmissionMetadata,metadataQuerySha256,matchIndependentControlHashes} from './admission-metadata-custody.mjs';
import {OWNER_PROOF_METHOD,OWNER_APPROVED_PATH,OWNER_RESULT_PATH,OWNER_ATTESTATION_PATH,BACKUP_MANIFEST_PATH,resolveEscrowOwnerProof} from './owner-proof-binding.mjs';

const ROOT='/root/bron-secrets',PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115',MAX=1048576;
const T30={crypto:ROOT+'/t30-owner-key-proof-result.json',attestation:ROOT+'/t30-owner-key-attestation.json',receipt:ROOT+'/t30-release-receipt.json'};
const ownError=Symbol('safe-fs-error'),sha=x=>createHash('sha256').update(x).digest('hex');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=code=>{throw Object.assign(new Error(code),{code,[ownError]:true});};
const exact=(o,keys)=>{
 if(!o||typeof o!=='object'||Array.isArray(o)||![Object.prototype,null].includes(Object.getPrototypeOf(o))||
  Reflect.ownKeys(o).length!==keys.length||Reflect.ownKeys(o).some(k=>!keys.includes(k)||
   !Object.hasOwn(Object.getOwnPropertyDescriptor(o,k),'value')||!Object.getOwnPropertyDescriptor(o,k).enumerable))
  fail('ADMISSION_FS_SHAPE');
};
const canonical=o=>JSON.stringify(o,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=o=>Buffer.from(canonical(o)+'\n');
const safe=(operation,fn)=>{
 try{return fn();}catch(error){throw Object.assign(new Error(error?.[ownError]?error.code:'ADMISSION_FS_IO_UNCERTAIN'),
  {code:error?.[ownError]?error.code:'ADMISSION_FS_IO_UNCERTAIN',operation,retryAllowed:false});}
};
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const contextKeys=['actionId','manifestSha256','sourceProject','destinationVps'];

// testOnly remaps logical private paths into a temporary directory, with ACTUAL
// fixture uid/gid evidence (never fake root). It is unavailable outside node --test.
export function createAdmissionCustodyFs({activation,proofInputs},testOnly){
 return safe('open',()=>{
  let root=ROOT,uid=0,gid=0;
  if(testOnly){
   if(!process.env.NODE_TEST_CONTEXT)fail('ADMISSION_FS_TEST_POLICY_FORBIDDEN');
   exact(testOnly,['directory','uid','gid']);root=testOnly.directory;uid=testOnly.uid;gid=testOnly.gid;
   if(typeof root!=='string'||path.resolve(root)!==root||!root.startsWith('/tmp/')||!Number.isInteger(uid)||!Number.isInteger(gid))
    fail('ADMISSION_FS_TEST_POLICY_FORBIDDEN');
  }else if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0)fail('ADMISSION_FS_VPS_ROOT_REQUIRED');
  // Preserve the coordinator-pinned input set if another caller retains the object.
  if(proofInputs!==undefined)proofInputs=structuredClone(proofInputs);
  const a=Object.freeze({...activation});
  const task=typeof a.actionId==='string'?/^(T[1-9][0-9]{1,3})\.http_source_admission$/.exec(a.actionId)?.[1]:null;
  if(!task||a.reviewed!==true||!digest(a.manifestSha256)||a.sourceProject!==PROJECT||a.destinationVps!==VPS||
   a.metadataReadAuthorized!==true||a.metadataOnly!==true||a.sourceRoute!=='fixed-source-edge-https'||
   a.macDataTransit!==false||a.targetWritesStarted!==false)fail('ADMISSION_FS_TASK_NOT_REVIEWED');
  const context=Object.freeze(Object.fromEntries(contextKeys.map(k=>[k,a[k]])));
  let suffix;
  for(const [key,kind,ext] of [['beforeImagePath','before','json'],['metadataReceiptPath','metadata','json'],
   ['inversePath','inverse','sql'],['controlReceiptPath','control','json']]){
   const match=typeof a[key]==='string'?new RegExp('^'+ROOT+'/'+task.toLowerCase()+'-admission-'+kind+'-([a-f0-9]{8,64})\\.'+ext+'$').exec(a[key]):null;
   if(!match||(suffix&&suffix!==match[1]))fail('ADMISSION_FS_PATH');suffix=match[1];
  }
  const keyPath=ROOT+'/'+task.toLowerCase()+'-admission-key-proof-'+suffix+'.json';
  if(a.independentKeyProofPath!==undefined&&a.independentKeyProofPath!==keyPath)fail('ADMISSION_FS_PATH');
  const allowed=new Set([...Object.values(T30),OWNER_APPROVED_PATH,OWNER_RESULT_PATH,OWNER_ATTESTATION_PATH,BACKUP_MANIFEST_PATH,a.beforeImagePath,a.metadataReceiptPath,a.inversePath,a.controlReceiptPath,keyPath]);
  const privateDir=directory=>{
   const s=fs.lstatSync(directory);
   if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==0o700)
    fail('ADMISSION_FS_DIRECTORY_UNSAFE');return s;
  };
  if(!testOnly)privateDir('/root');
  const initial=privateDir(root),dirfd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  let closed=false;
  const directory=()=>{
   if(closed)fail('ADMISSION_FS_CLOSED');
   if(!testOnly)privateDir('/root');
   const current=privateDir(root),held=fs.fstatSync(dirfd);
   if(!sameFile(current,initial)||!sameFile(held,initial)||held.uid!==uid||held.gid!==gid||(held.mode&0o7777)!==0o700)
    fail('ADMISSION_FS_DIRECTORY_CHANGED');
  };
  const physical=logical=>{
   if(!allowed.has(logical))fail('ADMISSION_FS_PATH');directory();
   // Read only this pinned technical manifest; never an encrypted archive or identity.
   if(logical===BACKUP_MANIFEST_PATH){
    if(testOnly)return '/proc/self/fd/'+dirfd+'/t12-backup-manifest.json';
    if(fs.realpathSync(logical)!==logical)fail('ADMISSION_FS_PATH');
    return logical;
   }
   if(!logical.startsWith(ROOT+'/')||path.resolve(logical)!==logical)fail('ADMISSION_FS_PATH');
   const relative=path.relative(ROOT,logical),parts=relative.split('/');
   for(let n=1;n<parts.length;n++)privateDir(path.join(root,...parts.slice(0,n)));
   return '/proc/self/fd/'+dirfd+'/'+relative;
  };
  const checkFile=s=>{
   if(!s.isFile()||s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==0o600||s.nlink!==1||s.size<1||s.size>MAX)
    fail('ADMISSION_FS_FILE_UNSAFE');
  };
  const read=(logical,expected,max=MAX)=>{
   const filename=physical(logical);let fd;
   try{
    fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const first=fs.fstatSync(fd);checkFile(first);if(first.size>max)fail('ADMISSION_FS_READ_BOUND');
    const buffer=Buffer.alloc(max+1);let count=0;
    for(;;){const n=fs.readSync(fd,buffer,count,buffer.length-count,count);count+=n;
     if(count>max)fail('ADMISSION_FS_READ_BOUND');if(n===0)break;}
    const after=fs.fstatSync(fd),named=fs.lstatSync(filename);checkFile(after);checkFile(named);directory();
    if(!sameFile(first,after)||!sameFile(first,named)||first.size!==count||after.size!==count||
     first.mtimeMs!==after.mtimeMs||first.ctimeMs!==after.ctimeMs)fail('ADMISSION_FS_FILE_CHANGED');
    const content=buffer.subarray(0,count),hash=sha(content);
    if(expected!==undefined&&(!digest(expected)||hash!==expected))fail('ADMISSION_FS_SHA_MISMATCH');
    return {bytes:content,mtimeMs:after.mtimeMs,artifact:{path:logical,sha256:hash,bytes:count,uid:after.uid,gid:after.gid,
     mode:after.mode&0o7777,regularFile:true,symlink:false,nlink:after.nlink,readbackSha256:hash}};
   }finally{if(fd!==undefined)fs.closeSync(fd);}
  };
  const write=(logical,content,expected)=>{
   if(!Buffer.isBuffer(content)||content.length<1||content.length>MAX||!digest(expected)||sha(content)!==expected)
    fail('ADMISSION_FS_WRITE_INVALID');
   const filename=physical(logical);let fd;
   try{fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,content);const s=fs.fstatSync(fd);checkFile(s);fs.fsyncSync(fd);
   }finally{if(fd!==undefined)fs.closeSync(fd);}
   directory();fs.fsyncSync(dirfd);const observed=read(logical,expected);
   if(!observed.bytes.equals(content))fail('ADMISSION_FS_READBACK_MISMATCH');
   return {...observed.artifact,exclusive:true,fileFsynced:true,directoryFsynced:true};
  };
  const json=content=>{try{return JSON.parse(content.toString('utf8'));}catch{fail('ADMISSION_FS_JSON_INVALID');}};
  const boundContext=o=>{if(contextKeys.some(k=>o[k]!==context[k]))fail('ADMISSION_FS_CONTEXT_MISMATCH');};
  const beforeObject=content=>{
   const body=json(content);exact(body,['format','kind',...contextKeys,'metadataQuerySha256','state']);boundContext(body);
   if(body.format!==1||body.kind!=='source-admission-metadata-only'||body.metadataQuerySha256!==metadataQuerySha256)
    fail('ADMISSION_FS_METADATA_INVALID');
   try{validateAdmissionMetadata(body.state);}catch{fail('ADMISSION_FS_METADATA_INVALID');}
   if(!encode(body).equals(content))fail('ADMISSION_FS_NONCANONICAL_JSON');return body;
  };
  const metadataObject=content=>{
   const r=json(content);exact(r,['format','status',...contextKeys,'metadataQuerySha256','capturedMicros','beforeImagePath',
    'metadataReceiptPath','beforeImageSha256','beforeImageDurableOnVps','counts','ownerPids','sourceEffects','sourceBarrierPass','rootComparisonRequired']);
   exact(r.counts,['roles','acl','backends']);boundContext(r);
   if(r.format!==1||r.status!=='METADATA_PREPARED'||r.metadataQuerySha256!==metadataQuerySha256||
    typeof r.capturedMicros!=='string'||!/^\d{12,20}$/.test(r.capturedMicros)||
    r.beforeImagePath!==a.beforeImagePath||r.metadataReceiptPath!==a.metadataReceiptPath||!digest(r.beforeImageSha256)||
    r.beforeImageDurableOnVps!==true||r.sourceEffects!==false||r.sourceBarrierPass!==false||r.rootComparisonRequired!==true||
    Object.entries(r.counts).some(([k,v])=>!Number.isInteger(v)||v<0||v>({roles:1024,acl:4096,backends:2048}[k]))||
    !Array.isArray(r.ownerPids)||r.ownerPids.length>2048||r.ownerPids.some(pid=>!Number.isInteger(pid)||pid<1||pid>2147483647))
    fail('ADMISSION_FS_METADATA_INVALID');
   if(!encode(r).equals(content))fail('ADMISSION_FS_NONCANONICAL_JSON');return r;
  };
  const request=(r,expected)=>{
   exact(r,['path','bytes','sha256','context']);exact(r.context,contextKeys);boundContext(r.context);
   if(r.path!==expected)fail('ADMISSION_FS_PATH');
   if(!Buffer.isBuffer(r.bytes)||r.bytes.length<1||r.bytes.length>MAX||!digest(r.sha256)||sha(r.bytes)!==r.sha256)
    fail('ADMISSION_FS_WRITE_INVALID');return r;
  };
  const ownerProof=()=>{
   if(proofInputs?.method===OWNER_PROOF_METHOD){
    exact(proofInputs,['method','parentManifestSha256','ownerScope','approvedInput','result','attestation']);
    if(a.independentKeyProofPath!==keyPath||!digest(a.independentKeyProofSha256)||!digest(a.recoveryCipherSha256)||
     !digest(proofInputs.parentManifestSha256))fail('ADMISSION_FS_OWNER_PROOF_PENDING');
    for(const [name,p]of [['approvedInput',OWNER_APPROVED_PATH],['result',OWNER_RESULT_PATH],['attestation',OWNER_ATTESTATION_PATH]]){
     exact(proofInputs[name],['path','sha256']);if(proofInputs[name].path!==p||!digest(proofInputs[name].sha256))fail('ADMISSION_FS_OWNER_INPUT_PIN');
    }
    let resolved;try{
     resolved=resolveEscrowOwnerProof({manifest:{task:'T41',actionId:'T41.release_window',execution_authorized:true,owner_proof:proofInputs.ownerScope},parentManifestSha256:proofInputs.parentManifestSha256,
      approvedInputBytes:read(OWNER_APPROVED_PATH,proofInputs.approvedInput.sha256,16384).bytes,
      approvedInputSha256:proofInputs.approvedInput.sha256,resultBytes:read(OWNER_RESULT_PATH,proofInputs.result.sha256,65536).bytes,
      attestationBytes:read(OWNER_ATTESTATION_PATH,proofInputs.attestation.sha256,16384).bytes,
      backupManifestBytes:read(BACKUP_MANIFEST_PATH,proofInputs.ownerScope.recoveryCipherBinding.manifestSha256).bytes});
    }catch{fail('ADMISSION_FS_OWNER_PROOF_PENDING');}
    if(resolved.independentProofSha256!==a.independentKeyProofSha256||resolved.recoveryCipherSha256!==a.recoveryCipherSha256)
     fail('ADMISSION_FS_OWNER_ENVELOPE_PIN');return resolved.proof;
   }
   if(!proofInputs||a.independentKeyProofPath!==keyPath||!digest(a.independentKeyProofSha256)||!digest(a.recoveryCipherSha256))
    fail('ADMISSION_FS_OWNER_PROOF_PENDING');
   exact(proofInputs,['crypto','attestation','receipt','reviewedT30CipherBinding']);
   for(const k of ['crypto','attestation','receipt']){
    exact(proofInputs[k],['path','sha256']);
    if(proofInputs[k].path!==T30[k]||!digest(proofInputs[k].sha256))fail('ADMISSION_FS_OWNER_INPUT_PIN');
   }
   const binding=proofInputs.reviewedT30CipherBinding;
   exact(binding,['reviewed','task','cryptoResultSha256','sourceReceiptSha256','cipherSha256']);
   if(binding.reviewed!==true||binding.task!=='T30'||binding.cryptoResultSha256!==proofInputs.crypto.sha256||
    binding.sourceReceiptSha256!==proofInputs.receipt.sha256||binding.cipherSha256!==a.recoveryCipherSha256)
    fail('ADMISSION_FS_CIPHER_BINDING_REQUIRED');
   let c,t;
   try{c=read(T30.crypto,proofInputs.crypto.sha256,4096);t=read(T30.attestation,proofInputs.attestation.sha256,4096);
    read(T30.receipt,proofInputs.receipt.sha256);}catch(error){if(error?.code==='ENOENT')fail('ADMISSION_FS_OWNER_PROOF_PENDING');throw error;}
   const crypto=json(c.bytes),attestation=json(t.bytes);
   exact(crypto,['status','cipherShaVerified','decryptionVerified','plaintextStored','identityStored','externalCustody']);
   if(crypto.status!=='PASS'||crypto.cipherShaVerified!==true||crypto.decryptionVerified!==true||
    crypto.plaintextStored!==false||crypto.identityStored!==false||crypto.externalCustody!=='OWNER_CONFIRMATION_REQUIRED')
    fail('ADMISSION_FS_OWNER_CRYPTO_REQUIRED');
   exact(attestation,['task','action','cryptoResultSha256','sourceReceiptPath','sourceReceiptSha256','independentCopy',
    'personalSecondDeviceLogin','witnessedBy','deviceClass','observedUtc']);
   const observed=Date.parse(attestation.observedUtc);
   if(attestation.task!=='T30'||attestation.action!=='owner_key_proof'||attestation.cryptoResultSha256!==c.artifact.sha256||
    attestation.sourceReceiptPath!==T30.receipt||attestation.sourceReceiptSha256!==proofInputs.receipt.sha256||
    attestation.independentCopy!==true||attestation.personalSecondDeviceLogin!==true||attestation.witnessedBy!=='owner'||
    !['phone','second-device'].includes(attestation.deviceClass)||typeof attestation.observedUtc!=='string'||
    !/(?:Z|\+00:00)$/.test(attestation.observedUtc)||!Number.isFinite(observed)||observed>Date.now()+5000||c.mtimeMs>observed+60000)
    fail('ADMISSION_FS_OWNER_ATTESTATION_REQUIRED');
   const proof={format:1,sourceProject:PROJECT,destinationVps:VPS,crypto:{status:'PASS',cipherSha256:binding.cipherSha256,
    cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
    attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:t.artifact.sha256}};
   if(sha(encode(proof))!==a.independentKeyProofSha256)fail('ADMISSION_FS_OWNER_ENVELOPE_PIN');return proof;
  };
  return Object.freeze({
   persistBeforeImage:r=>safe('persist-before-image',()=>{request(r,a.beforeImagePath);beforeObject(r.bytes);return write(r.path,r.bytes,r.sha256);}),
   persistInverse:r=>safe('persist-inverse',()=>{request(r,a.inversePath);return write(r.path,r.bytes,r.sha256);}),
   persistReceipt:r=>safe('persist-receipt',()=>{
    if(r?.path===a.metadataReceiptPath){request(r,a.metadataReceiptPath);metadataObject(r.bytes);}
    else{request(r,a.controlReceiptPath);const receipt=json(r.bytes);
     try{matchIndependentControlHashes({activation:a,controlReceipt:{...receipt,receiptSha256:sha(r.bytes)},independentHashes:receipt.sqlHashes});}
     catch{fail('ADMISSION_FS_CONTROL_RECEIPT_INVALID');}
     if(!encode(receipt).equals(r.bytes))fail('ADMISSION_FS_NONCANONICAL_JSON');}
    return write(r.path,r.bytes,r.sha256);
   }),
   confirmPreparedCustody:r=>safe('confirm-prepared',()=>{
    exact(r,['beforeImagePath','beforeImageSha256','metadataReceiptPath','metadataReceiptSha256']);
    if(r.beforeImagePath!==a.beforeImagePath||r.metadataReceiptPath!==a.metadataReceiptPath)fail('ADMISSION_FS_PATH');
    const b=read(r.beforeImagePath,r.beforeImageSha256),m=read(r.metadataReceiptPath,r.metadataReceiptSha256);
    beforeObject(b.bytes);metadataObject(m.bytes);return {beforeImage:b.artifact,metadataReceipt:m.artifact};
   }),
   loadPrepared:()=>safe('load-prepared',()=>{
    const m=read(a.metadataReceiptPath),r=metadataObject(m.bytes),b=read(a.beforeImagePath,r.beforeImageSha256),body=beforeObject(b.bytes);
    return {before:validateAdmissionMetadata(body.state),stateReceipt:{...r,receiptSha256:m.artifact.sha256}};
   }),
   prepareIndependentKeyProof:()=>safe('prepare-key-proof',()=>{
    const proof=ownerProof(),content=encode(proof),e=write(keyPath,content,a.independentKeyProofSha256);
    return {status:'KEY_PROOF_DURABLE',path:e.path,sha256:e.sha256,bytes:e.bytes};
   }),
   readIndependentKeyProof:r=>safe('read-key-proof',()=>{
    exact(r,['path','sha256']);if(r.path!==keyPath||r.sha256!==a.independentKeyProofSha256)fail('ADMISSION_FS_OWNER_ENVELOPE_PIN');
    const proof=ownerProof(),saved=read(keyPath,r.sha256,4096);
    if(!saved.bytes.equals(encode(proof)))fail('ADMISSION_FS_OWNER_ENVELOPE_PIN');return {proof,artifact:saved.artifact};
   }),
   close:()=>safe('close',()=>{if(!closed){closed=true;fs.closeSync(dirfd);}}),
  });
 });
}
