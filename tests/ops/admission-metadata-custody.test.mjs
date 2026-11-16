import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {captureMetadataCustody,makeControlReady,hashAdmissionPlan,matchIndependentControlHashes,
 metadataQuerySha256,validateAdmissionMetadata} from '../../docs/runbooks/payloads/admission-metadata-custody.mjs';
import {beforeImageSql,makeHttpAdmissionPlan,advisoryKey} from '../../docs/runbooks/payloads/http-source-admission.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encoded=x=>Buffer.from(canonical(x)+'\n');
const role=(name,extra={})=>({name,super:false,login:false,createRole:false,createDb:false,replication:false,
 bypass:false,connect:true,ownerPath:false,...extra});
const baseline=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',signal:true,pid:100,readOnly:'on',
 capturedMicros:'1794612345123456',acl:['PUBLIC','dashboard_user','postgres'].map(grantee=>
  ({grantee,grantor:'postgres',privilege:'CONNECT',grantable:false})),
 roles:[role('postgres',{login:true,ownerPath:true}),role('dashboard_user',{ownerPath:true}),
  role('pgbouncer',{login:true}),role('authenticator',{login:true})],
 backends:[{pid:100,role:'postgres',type:'client backend',state:'active',openTransaction:true,super:false,providerAppKnown:false},
  {pid:101,role:null,type:'autovacuum worker',state:null,openTransaction:false,super:false,providerAppKnown:true}],
 lookupCriticalWrites:0,lookupSequenceWrites:0,lookupCriticalDefiners:0,lookupOtherSetRoles:0,
 prepared:0,netQueued:0,unexpectedActiveCron:0,runJobsExists:false});
const baseActivation=()=>({reviewed:true,actionId:'T99.http_source_admission',manifestSha256:'a'.repeat(64),
 sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',metadataReadAuthorized:true,
 metadataOnly:true,sourceRoute:'fixed-source-edge-https',macDataTransit:false,targetWritesStarted:false,
 beforeImagePath:'/root/bron-secrets/t99-admission-before-12345678.json',
 metadataReceiptPath:'/root/bron-secrets/t99-admission-metadata-12345678.json',
 inversePath:'/root/bron-secrets/t99-admission-inverse-12345678.sql',
 controlReceiptPath:'/root/bron-secrets/t99-admission-control-12345678.json'});
const keyProof=()=>({format:1,sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',
 crypto:{status:'PASS',cipherSha256:'c'.repeat(64),cipherShaVerified:true,decryptionVerified:true,identityStored:false,plaintextStored:false},
 attestation:{independentCopy:true,personalSecondDeviceLogin:true,evidenceSha256:'d'.repeat(64)}});
function evidence(path,content,durable=false){
 return {path,sha256:hash(content),bytes:content.length,uid:0,gid:0,mode:0o600,regularFile:true,symlink:false,nlink:1,
  readbackSha256:hash(content),...(durable?{exclusive:true,fileFsynced:true,directoryFsynced:true}:{})};
}
function rig(){
 const state=baseline(),a=baseActivation(),proof=keyProof(),store=new Map(),calls=[];
 Object.assign(a,{controlTaskAuthorized:true,providerBoundaryReviewed:true,rollbackBeforeTargetWrites:true,
  independentKeyProofPath:'/root/bron-secrets/t99-admission-key-proof-12345678.json',
  independentKeyProofSha256:hash(encoded(proof)),recoveryCipherSha256:'c'.repeat(64)});
 store.set(a.independentKeyProofPath,encoded(proof));
 const write=async request=>{
  calls.push(['write',request.path]);assert.equal(request.sha256,hash(request.bytes));
  assert.equal(store.has(request.path),false,'no overwrite/retry');store.set(request.path,Buffer.from(request.bytes));
  return evidence(request.path,store.get(request.path),true);
 };
 const read=path=>{assert.ok(store.has(path));return evidence(path,store.get(path));};
 const capture={activation:a,readEncryptedMetadata:async request=>{
  calls.push(['source-read',request]);assert.equal(request.metadataQuerySha256,hash(beforeImageSql));return structuredClone(state);
 },persistBeforeImage:write,persistReceipt:write};
 const ready=receipt=>({activation:a,before:state,stateReceipt:receipt,confirmPreparedCustody:async request=>{
  calls.push(['confirm']);return {beforeImage:read(request.beforeImagePath),metadataReceipt:read(request.metadataReceiptPath)};
 },readIndependentKeyProof:async request=>{calls.push(['key-proof']);return {
  proof:JSON.parse(store.get(request.path)),artifact:read(request.path)};},persistInverse:write,persistReceipt:write});
 return {a,state,proof,store,calls,write,read,capture,ready};
}
const rejection=(code,phase)=>error=>{
 assert.equal(error.code,code);if(phase)assert.equal(error.phase,phase);
 assert.equal(error.sourceEffects,false);assert.equal(error.retryAllowed,false);assert.equal(error.custody,'UNKNOWN');return true;
};

test('metadata preparation is fixed-query, durable and safe while independent owner proof is pending',async()=>{
 const r=rig();r.capture.activation=baseActivation();
 const prepared=await captureMetadataCustody(r.capture);
 assert.equal(prepared.status,'METADATA_PREPARED');assert.equal(prepared.sourceBarrierPass,false);
 assert.deepEqual(prepared.counts,{roles:4,acl:3,backends:2});assert.deepEqual(prepared.ownerPids,[100]);
 assert.equal(metadataQuerySha256,hash(beforeImageSql));assert.equal(r.calls.filter(c=>c[0]==='source-read').length,1);
 const before=JSON.parse(r.store.get(r.a.beforeImagePath));assert.deepEqual(before.state,r.state);
 assert.equal(prepared.beforeImageSha256,hash(r.store.get(r.a.beforeImagePath)));
 assert.equal(prepared.receiptSha256,hash(r.store.get(r.a.metadataReceiptPath)));
 assert.equal(r.calls.some(c=>c[0]==='key-proof'),false);
 assert.equal(r.store.has(r.a.inversePath),false);
 assert.equal(Object.isFrozen(prepared.counts),true);
 const output=JSON.stringify(prepared);
 for(const forbidden of ['authenticator','ownerPath','openTransaction','GRANT CONNECT','REVOKE CONNECT','DO $','state":'])
  assert.equal(output.includes(forbidden),false,forbidden);
});

test('CONTROL_READY follows checked real key, custody readback, fsynced inverse and final durable receipt',async()=>{
 const r=rig(),prepared=await captureMetadataCustody(r.capture),ready=await makeControlReady(r.ready(prepared));
 assert.equal(ready.status,'CONTROL_READY');assert.equal(ready.sourceEffects,false);assert.equal(ready.sourceBarrierPass,false);
 assert.equal(ready.actualSupavisorRecovery,'NOT_TESTED');assert.equal(ready.providerSuperusersFenced,false);
 assert.equal(ready.sqlHashes.inverseSql,hash(r.store.get(r.a.inversePath)));
 assert.equal(ready.receiptSha256,hash(r.store.get(r.a.controlReceiptPath)));
 const ordered=r.calls.slice(3).map(c=>c[0]==='write'?c[1]:c[0]);
 assert.deepEqual(ordered,['confirm','key-proof',r.a.inversePath,r.a.controlReceiptPath]);
 const inverse=r.store.get(r.a.inversePath).toString();assert.ok(inverse.includes('pg_try_advisory_xact_lock('+advisoryKey));
 assert.ok(inverse.includes('GRANT CONNECT ON DATABASE postgres TO PUBLIC'));
 assert.ok(inverse.includes('REVOKE CONNECT ON DATABASE postgres FROM pgbouncer'));
 assert.equal(JSON.stringify(ready).includes(inverse),false);
 assert.equal(JSON.stringify(ready).includes('cipherShaVerified'),false);
});

test('independent Root SQL hash matching tolerates a new observation PID and clock but never ACL/role drift',async()=>{
 const r=rig(),prepared=await captureMetadataCustody(r.capture),ready=await makeControlReady(r.ready(prepared));
 const independent=baseline();independent.pid=500;independent.capturedMicros='1794612345123999';
 independent.backends=[];
 // Test fixture has already passed the proof gate above; this is not a pending-key bypass.
 const rootPlan=before=>makeHttpAdmissionPlan({activation:{reviewed:true,actionId:r.a.actionId,
  manifestSha256:r.a.manifestSha256,beforeImageSha256:ready.beforeImageSha256,beforeImageDurableOnVps:true,
  providerBoundaryReviewed:true,independentKeyProved:true,rollbackBeforeTargetWrites:true,targetWritesStarted:false},
  before:validateAdmissionMetadata(before)});
 const rootHashes=hashAdmissionPlan(rootPlan(independent));
 const matched=matchIndependentControlHashes({activation:r.a,controlReceipt:ready,independentHashes:rootHashes});
 assert.equal(matched.status,'CONTROL_HASHES_MATCH');assert.equal(matched.sourceBarrierPass,false);
 independent.acl.push({grantee:'PUBLIC',grantor:'postgres',privilege:'TEMPORARY',grantable:false});
 assert.throws(()=>matchIndependentControlHashes({activation:r.a,controlReceipt:ready,
  independentHashes:hashAdmissionPlan(rootPlan(independent))}),{code:'ADMISSION_CUSTODY_INDEPENDENT_HASH_MISMATCH'});
});

test('durable JSON readback and independently ordered MCP object keys produce identical exact SQL hashes',async()=>{
 const r=rig(),prepared=await captureMetadataCustody(r.capture),options=r.ready(prepared);
 options.before=JSON.parse(r.store.get(r.a.beforeImagePath)).state;
 const ready=await makeControlReady(options);
 const reordered=Object.fromEntries(Object.entries(baseline()).reverse());
 reordered.roles=reordered.roles.map(r=>Object.fromEntries(Object.entries(r).reverse()));
 reordered.acl=reordered.acl.map(e=>Object.fromEntries(Object.entries(e).reverse()));
 const plan=makeHttpAdmissionPlan({activation:{reviewed:true,actionId:r.a.actionId,manifestSha256:r.a.manifestSha256,
  beforeImageSha256:ready.beforeImageSha256,beforeImageDurableOnVps:true,providerBoundaryReviewed:true,
  independentKeyProved:true,rollbackBeforeTargetWrites:true,targetWritesStarted:false},
  before:validateAdmissionMetadata(reordered)});
 assert.equal(matchIndependentControlHashes({activation:r.a,controlReceipt:ready,
  independentHashes:hashAdmissionPlan(plan)}).status,'CONTROL_HASHES_MATCH');
});

test('missing task control authorization or a fabricated independentKeyProved flag never generates inverse',async()=>{
 const r=rig(),prepared=await captureMetadataCustody(r.capture);
 for(const changed of [{...baseActivation()},{...r.a,controlTaskAuthorized:false},{...r.a,independentKeyProved:true}]){
  await assert.rejects(makeControlReady({...r.ready(prepared),activation:changed}),error=>{
   assert.ok(['ADMISSION_CUSTODY_CONTROL_NOT_AUTHORIZED','ADMISSION_CUSTODY_SHAPE'].includes(error.code));return true;
  });
 }
 assert.equal(r.calls.some(c=>c[0]==='key-proof'),false);assert.equal(r.store.has(r.a.inversePath),false);
});

test('crypto PASS alone does not replace independent-copy and second-device attestation',async()=>{
 for(const mutation of [p=>{p.crypto.decryptionVerified=false;},p=>{p.attestation.independentCopy=false;},
  p=>{p.attestation.personalSecondDeviceLogin=false;},p=>{p.crypto.identityStored=true;},p=>{p.crypto.plaintextStored=true;}]){
  const r=rig();mutation(r.proof);r.store.set(r.a.independentKeyProofPath,encoded(r.proof));
  r.a.independentKeyProofSha256=hash(encoded(r.proof));const prepared=await captureMetadataCustody(r.capture);
  await assert.rejects(makeControlReady(r.ready(prepared)),rejection('ADMISSION_CUSTODY_INDEPENDENT_KEY_NOT_PROVED','independent-key-proof'));
  assert.equal(r.store.has(r.a.inversePath),false);
 }
});

test('proof must match pinned artifact bytes, destination, and known recovery ciphertext',async()=>{
 for(const mutation of [p=>{p.destinationVps='198.51.100.7';},p=>{p.crypto.cipherSha256='f'.repeat(64);}]){
  const r=rig();mutation(r.proof);r.store.set(r.a.independentKeyProofPath,encoded(r.proof));
  const prepared=await captureMetadataCustody(r.capture);
  await assert.rejects(makeControlReady(r.ready(prepared)),rejection('ADMISSION_CUSTODY_INDEPENDENT_KEY_NOT_PROVED'));
  assert.equal(r.store.has(r.a.inversePath),false);
 }
 const r=rig(),prepared=await captureMetadataCustody(r.capture);r.a.independentKeyProofSha256='0'.repeat(64);
 await assert.rejects(makeControlReady(r.ready(prepared)),rejection('ADMISSION_CUSTODY_INDEPENDENT_KEY_NOT_PROVED'));
});

test('all persisted artifacts need root0600, exclusive create, file+directory fsync and exact readback',async()=>{
 for(const change of [{uid:1000},{gid:1000},{mode:0o644},{regularFile:false},{symlink:true},{nlink:2},
  {exclusive:false},{fileFsynced:false},{directoryFsynced:false},{readbackSha256:'0'.repeat(64)},
  {sha256:'0'.repeat(64)},{bytes:0},{path:'/tmp/wrong.json'}]){
  const r=rig();r.capture.persistBeforeImage=async request=>({...await r.write(request),...change});
  await assert.rejects(captureMetadataCustody(r.capture),rejection('ADMISSION_CUSTODY_DURABILITY_NOT_PROVED','persist-before-image'));
  assert.equal(r.store.has(r.a.metadataReceiptPath),false);
 }
});

test('capture receipt failure or lost ACK has no emitted success and no automatic replay',async()=>{
 for(const stage of ['before','receipt']){
  const r=rig(),name=stage==='before'?'persistBeforeImage':'persistReceipt';let calls=0;
  r.capture[name]=async request=>{calls++;await r.write(request);throw new Error('private DSN password raw stderr');};
  await assert.rejects(captureMetadataCustody(r.capture),error=>{
   rejection('ADMISSION_CUSTODY_CALLBACK_UNCERTAIN')(error);
   assert.equal(JSON.stringify(error).includes('password'),false);assert.equal(error.message.includes('private'),false);return true;
  });
  assert.equal(calls,1);assert.equal(r.calls.filter(c=>c[0]==='source-read').length,1);assert.equal(r.store.has(r.a.inversePath),false);
 }
});

test('read timeout is safe uncertainty, never retried and does not persist a fabricated empty state',async()=>{
 const r=rig();let attempts=0;r.capture.readEncryptedMetadata=async()=>{attempts++;throw {code:'secret',message:'postgres://private'};};
 await assert.rejects(captureMetadataCustody(r.capture),rejection('ADMISSION_CUSTODY_CALLBACK_UNCERTAIN','read-metadata'));
 assert.equal(attempts,1);assert.equal(r.store.has(r.a.beforeImagePath),false);
});

test('inverse lost ACK and final ready-receipt failures never yield CONTROL_READY or execute Source',async()=>{
 for(const name of ['persistInverse','persistReceipt']){
  const r=rig(),prepared=await captureMetadataCustody(r.capture),options=r.ready(prepared);let calls=0;
  options[name]=async request=>{calls++;await r.write(request);throw new Error('lost ACK');};
  await assert.rejects(makeControlReady(options),rejection('ADMISSION_CUSTODY_CALLBACK_UNCERTAIN'));
  assert.equal(calls,1);assert.equal(r.store.has(r.a.inversePath),true);
  assert.equal(r.calls.filter(c=>c[0]==='source-read').length,1);
 }
});

test('metadata with private/additional fields, inherited/accessor values, deep content or giant arrays is rejected before persistence',async()=>{
 let getterCalls=0;
 for(const mutate of [s=>{s.authUsers=[];},s=>{s.dsn='postgres://private';},s=>{s.roles[0].password='private';},
  s=>{s.backends[0].query='SELECT secret';},s=>{s.roles[0].name={deep:{password:'private'}};},
  s=>{s.backends=Array.from({length:2049},()=>s.backends[0]);},s=>{s.capturedMicros='1'.repeat(10000);},
  s=>{Object.defineProperty(s,'signal',{get(){getterCalls++;return true;}});},
  s=>{Object.defineProperty(s.backends[0],'pid',{value:100,enumerable:false});},
  s=>{Object.setPrototypeOf(s,{secret:'private'});}]){
  const r=rig();mutate(r.state);r.capture.readEncryptedMetadata=async()=>r.state;
  await assert.rejects(captureMetadataCustody(r.capture));assert.equal(r.store.has(r.a.beforeImagePath),false);
 }
 assert.equal(getterCalls,0);
});

test('sparse arrays, duplicate role/PID/ACL and unexpected metadata identity are rejected',()=>{
 for(const mutate of [s=>{s.roles.push(s.roles[0]);},s=>{s.acl.push(s.acl[0]);},s=>{s.backends.push(s.backends[0]);},
  s=>{delete s.roles[0];s.roles.secret='private';},s=>{s.readOnly='off';},s=>{s.pid=0;},
  s=>{s.lookupOtherSetRoles='0';},s=>{s.backends[0].state='private unknown text';}]){
  const state=baseline();mutate(state);assert.throws(()=>validateAdmissionMetadata(state));
 }
});

test('nullable technical fields from pg_stat_activity preserve exact stateSql shape',()=>{
 const state=baseline();state.backends[1].providerAppKnown=null;
 assert.equal(validateAdmissionMetadata(state).backends[1].providerAppKnown,null);
 // The unchanged common DO rejects unknown/null providerAppKnown for super clients.
});

test('extension backend labels remain bounded technical fields without adding data or changing fence predicates',()=>{
 for(const type of ['pg_cron launcher','pg_net worker','pg_net 0.20.4 worker','logical replication tablesync worker','extension_worker-2']){
  const state=baseline();state.backends[1].type=type;
  assert.equal(validateAdmissionMetadata(state).backends[1].type,type);
 }
 for(const type of ['',null,'x'.repeat(64),'worker\nprivate','worker; SELECT password','worker/secret']){
  const state=baseline();state.backends[1].type=type;assert.throws(()=>validateAdmissionMetadata(state));
 }
 const extra=baseline();extra.backends[1].query='SELECT private';assert.throws(()=>validateAdmissionMetadata(extra));
});

test('metadata output is bounded to 1MiB including the durable envelope',async()=>{
 const r=rig(),long='x'.repeat(63);r.state.roles=Array.from({length:1024},(_,i)=>role(String(i)+long.slice(String(i).length)));
 r.state.acl=Array.from({length:4096},(_,i)=>({grantee:String(i)+long.slice(String(i).length),grantor:long,privilege:'CONNECT',grantable:false}));
 r.state.backends=Array.from({length:2048},(_,i)=>({...baseline().backends[0],pid:i+1,role:long}));
 await assert.rejects(captureMetadataCustody(r.capture),rejection('ADMISSION_CUSTODY_METADATA_BOUND'));
 assert.equal(r.store.has(r.a.beforeImagePath),false);
});

test('task paths, action, Source, destination and transport cannot escape the reviewed bound',async()=>{
 for(const change of [{beforeImagePath:'/tmp/t99-admission-before-12345678.json'},
  {beforeImagePath:'/root/bron-secrets/../t99-admission-before-12345678.json'},
  {inversePath:'/root/bron-secrets/t98-admission-inverse-12345678.sql'},
  {inversePath:'/root/bron-secrets/t99-admission-inverse-87654321.sql'},
  {sourceProject:'anotherproject'},{destinationVps:'127.0.0.1'},{actionId:'T99.source_admission'},
  {macDataTransit:true},{sourceRoute:'existing-reverse'},{metadataOnly:false},{targetWritesStarted:true},
  {reviewed:false},{metadataReadAuthorized:false}]){
  const r=rig();Object.assign(r.a,change);await assert.rejects(captureMetadataCustody(r.capture));
  assert.equal(r.calls.length,0);
 }
});

test('custody readback and immutable prepared state must still match before any inverse generation',async()=>{
 for(const mutate of [r=>{r.state.capturedMicros='1794612345123457';},r=>{r.state.roles[0].connect=false;},
  r=>{r.store.set(r.a.beforeImagePath,Buffer.from('changed'));},r=>{r.store.set(r.a.metadataReceiptPath,Buffer.from('changed'));}]){
  const r=rig(),prepared=await captureMetadataCustody(r.capture);mutate(r);
  await assert.rejects(makeControlReady(r.ready(prepared)));assert.equal(r.store.has(r.a.inversePath),false);
 }
});

test('safe metadata capture does not falsely require normal product clients to be drained already',async()=>{
 const r=rig();r.state.backends.push({...r.state.backends[0],pid:110,role:'authenticator'});
 assert.equal((await captureMetadataCustody(r.capture)).status,'METADATA_PREPARED');
 // Real DO control will freshly validate background/role/ACL state before every effect.
 r.state.lookupCriticalWrites=1;
 const s=rig();s.state.lookupCriticalWrites=1;const prepared=await captureMetadataCustody(s.capture);
 await assert.rejects(makeControlReady(s.ready(prepared)),rejection('ADMISSION_CUSTODY_SOURCE_PLAN_REJECTED','make-control-plan'));
 assert.equal(s.store.has(s.a.inversePath),false);
});

test('a callback cannot mutate the immutable control context or replace the acknowledged inverse buffer',async()=>{
 const r=rig(),original=r.capture.persistBeforeImage;
 r.capture.persistBeforeImage=async request=>{assert.throws(()=>{request.context.sourceProject='changed';},TypeError);return original(request);};
 const prepared=await captureMetadataCustody(r.capture),options=r.ready(prepared);
 options.persistInverse=async request=>{request.bytes.fill(0);return r.write({...request,sha256:hash(request.bytes)});};
 await assert.rejects(makeControlReady(options),rejection('ADMISSION_CUSTODY_DURABILITY_NOT_PROVED','persist-exact-inverse'));
 assert.equal(r.store.has(r.a.controlReceiptPath),false);
});

test('Root comparison rejects tampered receipts, action binders, extra raw output and any missing SQL hash',async()=>{
 const r=rig(),prepared=await captureMetadataCustody(r.capture),ready=await makeControlReady(r.ready(prepared));
 for(const mutate of [x=>{x.receiptSha256='0'.repeat(64);},x=>{x.manifestSha256='f'.repeat(64);},
  x=>{x.beforeImagePath='/tmp/unsafe';},x=>{x.sourceBarrierPass=true;},x=>{x.sql='GRANT CONNECT';},
  x=>{delete x.sqlHashes.applySql;},x=>{x.counts={private:{deep:'data'}};}]){
  const copy=structuredClone(ready);mutate(copy);
  assert.throws(()=>matchIndependentControlHashes({activation:r.a,controlReceipt:copy,independentHashes:ready.sqlHashes}));
 }
 assert.throws(()=>matchIndependentControlHashes({activation:r.a,controlReceipt:ready,
  independentHashes:{...ready.sqlHashes,inverseSql:'0'.repeat(64)}}),{code:'ADMISSION_CUSTODY_INDEPENDENT_HASH_MISMATCH'});
});
