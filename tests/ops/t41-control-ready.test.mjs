import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateManifest,activationFromManifest,validateT40Result,validateOwnerProof,runControlReady} from '../../docs/runbooks/payloads/t41-control-ready.mjs';
import {captureMetadataCustody,metadataQuerySha256} from '../../docs/runbooks/payloads/admission-metadata-custody.mjs';

const root='/root/bron-secrets',project='vkkqffvmztpzgygzfxhq',vps='152.228.115.115';
const adoptedManifest='a8f777d95d53b365959530a0bbce4a42b21840dc92bf1180c65eaa7dd74136f8',authorizationSha='1'.repeat(64);
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=o=>JSON.stringify(o,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=o=>Buffer.from(canonical(o)+'\n');
const role=(name,extra={})=>({name,super:false,login:false,createRole:false,createDb:false,replication:false,bypass:false,connect:true,ownerPath:false,...extra});
const state=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',signal:true,pid:100,readOnly:'on',capturedMicros:'1794612345123456',
 acl:['PUBLIC','dashboard_user','postgres'].map(grantee=>({grantee,grantor:'postgres',privilege:'CONNECT',grantable:false})),
 roles:[role('postgres',{login:true,ownerPath:true}),role('dashboard_user',{ownerPath:true}),role('pgbouncer',{login:true}),role('authenticator',{login:true})],
 backends:[{pid:100,role:'postgres',type:'client backend',state:'active',openTransaction:true,super:false,providerAppKnown:false}],
 lookupCriticalWrites:0,lookupSequenceWrites:0,lookupCriticalDefiners:0,lookupOtherSetRoles:0,prepared:0,netQueued:0,unexpectedActiveCron:0,runJobsExists:false});
const paths=()=>({beforeImagePath:root+'/t40-admission-before-c40a2026.json',metadataReceiptPath:root+'/t40-admission-metadata-c40a2026.json',
 inversePath:root+'/t40-admission-inverse-c40a2026.sql',controlReceiptPath:root+'/t40-admission-control-c40a2026.json'});
function owner(){
 const now=Date.now(),crypto={status:'PASS',cipherShaVerified:true,decryptionVerified:true,plaintextStored:false,identityStored:false,externalCustody:'OWNER_CONFIRMATION_REQUIRED'};
 const cryptoBytes=Buffer.from(JSON.stringify(crypto)+'\n'),receiptBytes=Buffer.from('{"task":"T30","status":"COMPLETE"}\n');
 const attestation={task:'T30',action:'owner_key_proof',cryptoResultSha256:sha(cryptoBytes),sourceReceiptPath:root+'/t30-release-receipt.json',
  sourceReceiptSha256:sha(receiptBytes),independentCopy:true,personalSecondDeviceLogin:true,witnessedBy:'owner',deviceClass:'phone',observedUtc:new Date(now).toISOString()};
 const attestationBytes=Buffer.from(JSON.stringify(attestation)+'\n'),cipherSha='c'.repeat(64);
 const proof={format:1,sourceProject:project,destinationVps:vps,crypto:{status:'PASS',cipherSha256:cipherSha,cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
  attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:sha(attestationBytes)}};
 const inputs={crypto:{path:root+'/t30-owner-key-proof-result.json',sha256:sha(cryptoBytes)},attestation:{path:root+'/t30-owner-key-attestation.json',sha256:sha(attestationBytes)},
  receipt:{path:root+'/t30-release-receipt.json',sha256:sha(receiptBytes)},reviewedT30CipherBinding:{reviewed:true,task:'T30',cryptoResultSha256:sha(cryptoBytes),sourceReceiptSha256:sha(receiptBytes),cipherSha256:cipherSha}};
 return {now,crypto,attestation,proof,cryptoBytes,attestationBytes,receiptBytes,cryptoMtimeMs:now-10000,
  config:{independentProofSha256:sha(encode(proof)),recoveryCipherSha256:cipherSha,inputs}};
}
function manifest(o=owner()){
 const runtime=root+'/t41-runtime/docs/runbooks/payloads/';return {task:'T41',execution_authorized:true,actionId:'T41.release_window',
  phase_authorizations:{prepare_control_ready:{actionId:'T41.prepare_control_ready',control_ready_only:true,source_sql_authorized:false,provider_boundary_reviewed:true,rollback_before_target_writes:true},
   final_window:{execution_authorized:false}},adopts:{actionId:'T40.http_source_admission',manifestSha256:adoptedManifest,custody:paths()},
  input_evidence:{T40_result_sha256:'2'.repeat(64),T40_receipt_sha256:'3'.repeat(64),T40_before_image_sha256:'4'.repeat(64),T40_metadata_receipt_sha256:'5'.repeat(64)},
  owner_proof:structuredClone(o.config),files:{'docs/runbooks/payloads/t41-control-ready.mjs':'6'.repeat(64)},
  runtime_files:Object.fromEntries(['t41-control-ready.mjs','admission-metadata-custody.mjs','admission-custody-fs.mjs','http-source-admission.mjs','t26-source-admission.mjs'].map(p=>[runtime+p,'7'.repeat(64)]))};
}
function artifact(path,bytes,durable=false){return {path,sha256:sha(bytes),bytes:bytes.length,uid:0,gid:0,mode:0o600,regularFile:true,symlink:false,nlink:1,readbackSha256:sha(bytes),
 ...(durable?{exclusive:true,fileFsynced:true,directoryFsynced:true}:{})};}
async function rig(options={}){
 const o=owner(),m=manifest(o),a=activationFromManifest(m),store=new Map(),events=[];
 // This Map supplies synthetic root artifact evidence for the real custody core.
 const write=async request=>{assert.equal(request.sha256,sha(request.bytes));assert.equal(store.has(request.path),false,'exclusive create');
  store.set(request.path,Buffer.from(request.bytes));return artifact(request.path,request.bytes,true);};
 const prepared=await captureMetadataCustody({activation:a,readEncryptedMetadata:async()=>options.state?options.state():state(),persistBeforeImage:write,persistReceipt:write});
 Object.assign(m.input_evidence,{T40_before_image_sha256:prepared.beforeImageSha256,T40_metadata_receipt_sha256:prepared.receiptSha256});
 const f={o,m,a,store,events,guarded:false,checks:0,prepared};
 const evidence=p=>artifact(p,store.get(p));
 f.adapter={prepareIndependentKeyProof:async()=>{events.push('proof');if(options.missingProof)throw Object.assign(Error('PRIVATE_OWNER_STATE'),{code:'ADMISSION_FS_OWNER_PROOF_PENDING'});
   const bytes=encode(o.proof);assert.equal(store.has(a.independentKeyProofPath),false);store.set(a.independentKeyProofPath,bytes);
   return {status:'KEY_PROOF_DURABLE',path:a.independentKeyProofPath,sha256:sha(bytes),bytes:bytes.length};},
  loadPrepared:async()=>{events.push('load');const body=JSON.parse(store.get(a.beforeImagePath)),receipt=JSON.parse(store.get(a.metadataReceiptPath));
   return {before:body.state,stateReceipt:{...receipt,receiptSha256:sha(store.get(a.metadataReceiptPath))}};},
  confirmPreparedCustody:async request=>{events.push('confirm');return {beforeImage:evidence(request.beforeImagePath),metadataReceipt:evidence(request.metadataReceiptPath)};},
  readIndependentKeyProof:async()=>{events.push('read-proof');return {proof:JSON.parse(store.get(a.independentKeyProofPath)),artifact:evidence(a.independentKeyProofPath)};},
  persistInverse:async request=>{events.push('inverse');return write(request);},persistReceipt:async request=>{events.push('control-receipt');return write(request);}};
 f.args={manifest:m,authorizationManifestSha256:authorizationSha,adapter:f.adapter,
  guard:async()=>{events.push('guard');assert.equal(f.guarded,false,'guard is exclusive');f.guarded=true;},
  assertPinnedInputs:async()=>{events.push('pins');f.checks++;assert.equal(sha(store.get(a.beforeImagePath)),m.input_evidence.T40_before_image_sha256);
   assert.equal(sha(store.get(a.metadataReceiptPath)),m.input_evidence.T40_metadata_receipt_sha256);validateOwnerProof(o,m.owner_proof,o.now);}};
 f.run=()=>runControlReady(f.args);return f;
}
const safe=e=>{assert.doesNotMatch(e.message+' '+JSON.stringify(e),/PRIVATE_|postgres:\/\/|password|authenticator|1794612345123456/);return true;};

test('import/noargs CLI are inert and do not expose owner or custody state',()=>{
 const file=path.resolve('docs/runbooks/payloads/t41-control-ready.mjs');
 const i=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:1500});assert.equal(i.status,0);assert.equal(i.stdout+i.stderr,'');
 const c=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:1500});assert.equal(c.status,2);assert.equal(c.stderr,'');assert.match(c.stdout,/T41_EXPLICIT_REVIEW_REQUIRED/);
 assert.doesNotMatch(c.stdout,/state|ownerPids|cryptoBytes|password/);
});
test('combined T41 manifest adopts exact T40 custody and authorizes only control preparation phase',()=>{
 const m=manifest(),raw=Buffer.from(JSON.stringify(m));assert.equal(validateManifest(raw,sha(raw),'6'.repeat(64)).task,'T41');
 const a=activationFromManifest(m);assert.equal(a.actionId,'T40.http_source_admission');assert.equal(a.manifestSha256,adoptedManifest);
 assert.deepEqual(Object.fromEntries(Object.keys(paths()).map(k=>[k,a[k]])),paths());assert.equal(a.targetWritesStarted,false);
 const parent=structuredClone(m);parent.runtime_files[root+'/t41-runtime/other-phase.mjs']='8'.repeat(64);const b=Buffer.from(JSON.stringify(parent));validateManifest(b,sha(b),'6'.repeat(64));
 for(const edit of [m=>m.actionId='T41.prepare_control_ready',m=>m.execution_authorized=false,m=>m.adopts.manifestSha256='0'.repeat(64),
  m=>m.adopts.custody.inversePath=root+'/t41-admission-inverse-c40a2026.sql',m=>m.phase_authorizations.prepare_control_ready.source_sql_authorized=true,
  m=>m.phase_authorizations.prepare_control_ready.control_ready_only=false,m=>delete m.input_evidence.T40_before_image_sha256]){
  const v=manifest();edit(v);const r=Buffer.from(JSON.stringify(v));assert.throws(()=>validateManifest(r,sha(r),'6'.repeat(64)));
 }
});
test('owner proof pins cannot be placeholder, mismatched cipher binding or substituted paths',()=>{
 for(const edit of [m=>m.owner_proof.independentProofSha256='PENDING',m=>m.owner_proof.inputs.crypto.path=root+'/key.age',
  m=>m.owner_proof.inputs.reviewedT30CipherBinding.reviewed=false,m=>m.owner_proof.inputs.reviewedT30CipherBinding.cipherSha256='0'.repeat(64),
  m=>m.owner_proof.inputs.reviewedT30CipherBinding.cryptoResultSha256='0'.repeat(64)]){
  const m=manifest();edit(m);assert.throws(()=>activationFromManifest(m),e=>{safe(e);return e.status==='BLOCKED_OWNER_PROOF';});
 }
});
test('T40 result must prove metadata-only capture and exact adopted before/receipt hashes',async()=>{
 const f=await rig(),r={task:'T40',status:'METADATA_PREPARED',sourceMetadataReadAttempted:true,sourceMetadataRead:true,sourceAuthUserRead:false,sourceBusinessDataRead:false,
  sourceEffects:false,sourceBarrierPass:false,controlReady:false,macDataTransit:false,authBudgetBefore:1,authBudgetAfter:1,metadataReceipt:f.prepared};
 const raw=Buffer.from(JSON.stringify(r));assert.equal(validateT40Result(raw,sha(raw),f.m.input_evidence),true);
 for(const edit of [x=>x.sourceAuthUserRead=true,x=>x.sourceEffects=true,x=>x.authBudgetAfter=2,x=>x.controlReady=true,
  x=>x.metadataReceipt.manifestSha256=authorizationSha,x=>x.metadataReceipt.receiptSha256='0'.repeat(64)]){
  const v=structuredClone(r);edit(v);const b=Buffer.from(JSON.stringify(v));assert.throws(()=>validateT40Result(b,sha(b),f.m.input_evidence),{code:'T41_T40_RESULT_INVALID'});
 }
});
test('owner crypto PASS and separate owner second-device attestation jointly bind canonical proof',()=>{
 const o=owner();assert.equal(validateOwnerProof(o,o.config,o.now),true);
 for(const change of [{cryptoMtimeMs:o.now+60001},{cryptoBytes:Buffer.from('PRIVATE')},{attestationBytes:Buffer.from('PRIVATE')}])
  assert.throws(()=>validateOwnerProof({...o,...change},o.config,o.now),e=>{safe(e);return e.status==='BLOCKED_OWNER_PROOF';});
 for(const edit of [x=>x.independentCopy=false,x=>x.personalSecondDeviceLogin=false,x=>x.witnessedBy='executor',
  x=>x.deviceClass='mac',x=>x.observedUtc=new Date(o.now+5001).toISOString(),x=>x.sourceReceiptPath=root+'/other.json']){
  const a={...o.attestation};edit(a);const bytes=Buffer.from(JSON.stringify(a)+'\n'),p=structuredClone(o.config);p.inputs.attestation.sha256=sha(bytes);
  assert.throws(()=>validateOwnerProof({...o,attestationBytes:bytes},p,o.now),e=>e.status==='BLOCKED_OWNER_PROOF');
 }
 const p=structuredClone(o.config);p.independentProofSha256='0'.repeat(64);assert.throws(()=>validateOwnerProof(o,p,o.now),{code:'T41_OWNER_ENVELOPE_SHA'});
});
test('actual custody core follows pinned inputs→guard→proof→load→readback→inverse→receipt without SQL execution',async()=>{
 const f=await rig(),r=await f.run();assert.deepEqual(f.events,['pins','guard','proof','load','confirm','read-proof','inverse','control-receipt','pins']);
 assert.equal(r.status,'CONTROL_READY');assert.equal(r.parentActionId,'T41.release_window');assert.equal(r.adoptedManifestSha256,adoptedManifest);
 assert.equal(r.authorizationManifestSha256,authorizationSha);assert.equal(r.sourceEffects,false);assert.equal(r.sourceBarrierPass,false);assert.equal(r.targetWritesStarted,false);
 assert.equal(r.providerSuperusersFenced,false);assert.equal(r.actualSupavisorRecovery,'NOT_TESTED');assert.equal(r.rootComparisonRequired,true);
 assert.equal(Object.keys(r.sqlHashes).length,5);assert.equal(r.inverseSha256,sha(f.store.get(f.a.inversePath)));
 assert.equal(r.controlReceiptSha256,sha(f.store.get(f.a.controlReceiptPath)));
 assert.equal(sha(f.store.get(f.a.beforeImagePath)),f.m.input_evidence.T40_before_image_sha256);assert.equal(f.checks,2);
 assert.doesNotMatch(JSON.stringify(r),/DO \$|REVOKE|GRANT|authenticator|ownerPids|capturedMicros|state":|independentCopy|cipherShaVerified/);
});
test('bad pins fail before guard/proof; duplicate guard never repeats custody operations',async()=>{
 const f=await rig();f.store.set(f.a.beforeImagePath,Buffer.from('PRIVATE_CHANGED'));await assert.rejects(f.run(),safe);assert.deepEqual(f.events,['pins']);
 const g=await rig();await g.run();g.events.length=0;await assert.rejects(g.run(),safe);assert.deepEqual(g.events,['pins','guard']);
});
test('missing proof before preparation and lost proof during read both block owner-proof gate',async()=>{
 const f=await rig({missingProof:true});await assert.rejects(f.run(),e=>{safe(e);assert.equal(e.status,'BLOCKED_OWNER_PROOF');assert.equal(e.code,'T41_OWNER_PROOF_REQUIRED');return true;});
 assert.equal(f.store.has(f.a.inversePath),false);
 const g=await rig();g.adapter.readIndependentKeyProof=async()=>{throw Object.assign(Error('PRIVATE_OWNER_INPUT_GONE'),{code:'ADMISSION_FS_OWNER_PROOF_PENDING'});};
 await assert.rejects(g.run(),e=>{safe(e);assert.equal(e.status,'BLOCKED_OWNER_PROOF');assert.equal(e.upstreamCode,'ADMISSION_FS_OWNER_PROOF_PENDING');return true;});assert.equal(g.store.has(g.a.inversePath),false);
});
test('changed adopted receipt, state or readback evidence blocks inverse creation',async()=>{
 for(const modify of [f=>{f.adapter.loadPrepared=async()=>({before:state(),stateReceipt:{...f.prepared,manifestSha256:authorizationSha}});},
  f=>{f.adapter.loadPrepared=async()=>{const s=state();s.roles[0].connect=false;return {before:s,stateReceipt:f.prepared};};},
  f=>{const original=f.adapter.confirmPreparedCustody;f.adapter.confirmPreparedCustody=async r=>{const e=await original(r);e.beforeImage.mode=0o644;return e;};}]){
  const f=await rig();modify(f);await assert.rejects(f.run(),safe);assert.equal(f.store.has(f.a.inversePath),false);
 }
});
test('metadata may be valid yet unsafe to fence; common plan rejects writer/worker boundary before inverse',async()=>{
 const f=await rig({state:()=>{const s=state();s.lookupCriticalWrites=1;return s;}});
 await assert.rejects(f.run(),e=>{safe(e);assert.equal(e.custodyPhase,'make-control-plan');assert.equal(e.upstreamCode,'ADMISSION_CUSTODY_SOURCE_PLAN_REJECTED');return true;});
 assert.equal(f.store.has(f.a.inversePath),false);
});
test('inverse and final receipt failures preserve partial files without success/retry and redact private errors',async()=>{
 for(const name of ['persistInverse','persistReceipt']){
  const f=await rig(),write=f.adapter[name];f.adapter[name]=async r=>{await write(r);throw Error('PRIVATE_IO_WITH_PASSWORD');};
  await assert.rejects(f.run(),e=>{safe(e);assert.equal(e.retryAllowed,false);assert.equal(e.sourceEffects,false);return true;});
  assert.equal(f.store.has(f.a.inversePath),true);assert.equal(f.guarded,true);
  const count=f.store.size;await assert.rejects(f.run(),safe);assert.equal(f.store.size,count);
 }
});
test('post-preparation pin change blocks success even when control files were durably produced',async()=>{
 const f=await rig(),check=f.args.assertPinnedInputs;f.args.assertPinnedInputs=async()=>{if(f.checks===1)throw Error('PRIVATE_PIN_CHANGED');return check();};
 await assert.rejects(f.run(),e=>{safe(e);assert.equal(e.phase,'confirm-inputs-unchanged');return true;});assert.equal(f.store.has(f.a.controlReceiptPath),true);
});
