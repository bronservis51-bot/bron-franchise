import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {createHash,createCipheriv,hkdfSync} from 'node:crypto';
import {PROTOCOL,validateManifest,activationFromManifest,validatePriorResult,validateBudget,createPrepared,
 validatePrepared,requestMetadata,decryptMetadata,validateMetadataFrame,runMetadataCapture} from '../../docs/runbooks/payloads/t40-metadata-custody.mjs';
import {metadataQuerySha256} from '../../docs/runbooks/payloads/admission-metadata-custody.mjs';
import {createAdmissionCustodyFs} from '../../docs/runbooks/payloads/admission-custody-fs.mjs';
import {SOURCE_TRANSFER_SCOPE_SHA256 as scope} from '../../docs/runbooks/payloads/source-transfer-budget.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),now=Date.parse('2026-11-14T10:00:00Z');
const manifestSha='a'.repeat(64),claimSha='b'.repeat(64),token='01'.repeat(32),capSha=sha(token),project='vkkqffvmztpzgygzfxhq';
const root='/root/bron-secrets',runtime=root+'/t40-runtime/docs/runbooks/payloads',action='T40.http_source_admission';
const role=(name,extra={})=>({name,super:false,login:false,createRole:false,createDb:false,replication:false,bypass:false,connect:true,ownerPath:false,...extra});
const state=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',signal:true,pid:100,readOnly:'on',
 capturedMicros:String(BigInt(now)*1000n),acl:['PUBLIC','postgres'].map(grantee=>({grantee,grantor:'postgres',privilege:'CONNECT',grantable:false})),
 roles:[role('postgres',{login:true,ownerPath:true}),role('authenticator',{login:true})],
 backends:[{pid:100,role:'postgres',type:'client backend',state:'active',openTransaction:true,super:false,providerAppKnown:false}],
 lookupCriticalWrites:0,lookupSequenceWrites:0,lookupCriticalDefiners:0,lookupOtherSetRoles:0,prepared:0,netQueued:0,unexpectedActiveCron:0,runJobsExists:false});
const prepared=()=>({task:'T40',actionId:action,manifestSha256:manifestSha,origin:'https://'+project+'.supabase.co',projectRef:project,
 destinationVps:'152.228.115.115',protocol:PROTOCOL,metadataQuerySha256,createdUtc:new Date(now-10000).toISOString(),
 expiresUtc:new Date(now-10000+7200000).toISOString(),capabilitySha256:capSha,functionName:'bron-admission-metadata-'+capSha.slice(0,12)});
const frame=()=>({ok:true,protocol:PROTOCOL,projectRef:project,destinationVps:'152.228.115.115',actionId:action,manifestSha256:manifestSha,
 metadataQuerySha256,started_epoch_ms:now,finished_epoch_ms:now+5,expires_epoch_ms:Date.parse(prepared().expiresUtc),
 tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',rollback_completed:true,
 identity:{database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',isolation:'repeatable read',
  statement_timeout:'5s',idle_timeout:'10s',pid:100,database_time:'2026-11-14 10:00:00.000001+00'},state:state()});
const ledger=()=>({used:1,remaining:2,maxAttempts:3,uncertain:false,claims:[{attempt:1,status:'VALID',actionId:'T37.live',claimSha256:claimSha}]});
const manifest=()=>({task:'T40',execution_authorized:true,actionId:action,
 files:{'docs/runbooks/payloads/t40-metadata-custody.mjs':'c'.repeat(64)},
 runtime_files:Object.fromEntries(['t40-metadata-custody.mjs','admission-metadata-custody.mjs','admission-custody-fs.mjs','http-source-admission.mjs','t26-source-admission.mjs','source-transfer-budget.mjs'].map(x=>[runtime+'/'+x,'d'.repeat(64)])),
 source:{origin:prepared().origin,projectRef:project,protocol:PROTOCOL,capability_binding:'pinned_VPS_prepare_readback',template_name_prefix:'bron-admission-metadata-',
  Auth_or_business_row_reads:false,database_writes:false,max_actual_POST:1,metadataQuerySha256,max_plaintext_bytes:1048576,max_wire_bytes:1572864,ttl_seconds:7200,wall_seconds:40},
 custody:Object.fromEntries(Object.entries(activationFromManifest(manifestSha)).filter(([k])=>k.endsWith('Path'))),
 transfer_budget:{directory:root+'/source-transfer-budget',scope_sha256:scope,max_attempts:3,source_project:project,destination_vps:'152.228.115.115',required_used:1,consume_or_reset_authorized:false},
 input_evidence:{T37_result_sha256:'e'.repeat(64),T37_receipt_sha256:'f'.repeat(64),T37_claim_sha256:claimSha}});
const prior=()=>({task:'T37',status:'LIVE_AUTH_TIMESTAMP_ONLY',inventoryComplete:true,sourceReadAttempted:true,sourceDataRead:true,
 sourceAuthUserRead:true,macDataTransit:false,applyAuthorized:false,finalFreezeAudit:false,strictMismatchGroups:['data:auth.users']});
function encrypted(value=frame(),secret=token,protocol=PROTOCOL){
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(secret,'ascii'),Buffer.from(sha(secret)),Buffer.from(protocol),32)),nonce=Buffer.alloc(12,17);
 const cipher=createCipheriv('aes-256-gcm',key,nonce);return {protocol,nonce:nonce.toString('base64'),
  ciphertext:Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString('base64')};
}
function client({status=200,body=encrypted(),raw,stall=false,error=false}={}){
 const calls=[],resources=[];return {calls,resources,request:(options,callback)=>{
  const req=new EventEmitter(),res=new EventEmitter();calls.push({options});resources.push({req,res});res.statusCode=status;
  req.destroy=()=>{req.destroyed=true;};res.destroy=()=>{res.destroyed=true;};req.end=(value,encoding)=>{calls.at(-1).body=value;calls.at(-1).encoding=encoding;
   queueMicrotask(()=>{if(error){req.emit('error',new Error('PRIVATE_ERROR'));return;}if(stall)return;callback(res);if(res.destroyed)return;
    res.emit('data',Buffer.from(raw??JSON.stringify(body)));if(!res.destroyed)res.emit('end');});};return req;}};
}
function rig(options={}){
 const f={store:new Map(),events:[],posts:0,guards:0,statusReads:0,attempts:0};
 // Synthetic callback evidence exercises core orchestration, not OS/root proof.
 f.persist=async request=>{f.events.push(request.path.endsWith('before-c40a2026.json')?'before-file':'receipt-file');
  assert.equal(request.sha256,sha(request.bytes));assert.equal(f.store.has(request.path),false);f.store.set(request.path,Buffer.from(request.bytes));
  const e={path:request.path,sha256:sha(request.bytes),readbackSha256:sha(request.bytes),bytes:request.bytes.length,
   uid:0,gid:0,mode:0o600,regularFile:true,symlink:false,nlink:1,exclusive:true,fileFsynced:true,directoryFsynced:true};
  return options.persist?options.persist(request,e,f):e;};
 f.args={activation:activationFromManifest(manifestSha),token,prepared:prepared(),claimSha256:claimSha,
  guard:async()=>{f.events.push('guard');if(f.guards++)throw Error('PRIVATE_ALREADY_STARTED');options.guard?.(f);},
  persistBeforeImage:f.persist,persistReceipt:f.persist,onSourceAttempt:()=>{f.events.push('attempt');f.attempts++;}};
 f.runtime={now:()=>now+10,status:async()=>{f.events.push('budget');f.statusReads++;return options.status?options.status(f):ledger();},
  send:async(t,p,o)=>{f.events.push('post');f.posts++;return options.send?options.send(t,p,o,f):{statusCode:200,bytes:2048,elapsedMs:5,value:encrypted()};}};
 f.run=()=>runMetadataCapture(f.args,f.runtime);return f;
}
const safe=e=>{assert.doesNotMatch(e.message+' '+JSON.stringify(e),/PRIVATE_|postgres:\/\/|password|authenticator|1794693600000000/);return true;};

test('import and CLI without exact pinned activation are inert and contain only safe failure',()=>{
 const file=path.resolve('docs/runbooks/payloads/t40-metadata-custody.mjs');
 const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:1500});
 assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
 for(const args of [[],['--run'],['--capture','--manifest','/tmp/manifest.json','--sha256',manifestSha]]){
  const p=spawnSync(process.execPath,[file,...args],{encoding:'utf8',timeout:1500});assert.equal(p.status,2);assert.equal(p.stderr,'');
  assert.match(p.stdout,/T40_EXPLICIT_REVIEW_REQUIRED/);assert.doesNotMatch(p.stdout,/capability|state|password/);
 }
});
test('manifest fixes task, six runtime hashes, source protocol, custody suffix, approved budget and T37 claim pin',()=>{
 const m=manifest(),raw=Buffer.from(JSON.stringify(m));assert.equal(validateManifest(raw,sha(raw),'c'.repeat(64)).task,'T40');
 assert.throws(()=>validateManifest(raw,'0'.repeat(64),'c'.repeat(64)),{code:'T40_MANIFEST_SHA'});
 for(const edit of [m=>m.task='T39',m=>m.execution_authorized=false,m=>m.actionId='T40.control',m=>m.runtime_files={},
  m=>m.source.protocol='BRON_PRIVATE_SNAPSHOT_V1',m=>m.source.origin='https://other.invalid',
  m=>m.custody.beforeImagePath=root+'/t40-admission-before-00000000.json',m=>m.transfer_budget.max_attempts=4,
  m=>delete m.input_evidence.T37_claim_sha256,m=>m.source.Auth_or_business_row_reads=true,m=>m.source.max_actual_POST=2,
  m=>m.transfer_budget.consume_or_reset_authorized=true]){
  const v=manifest();edit(v);const b=Buffer.from(JSON.stringify(v));assert.throws(()=>validateManifest(b,sha(b),'c'.repeat(64)));
 }
 const a=activationFromManifest(manifestSha);assert.equal(a.metadataOnly,true);assert.equal(a.targetWritesStarted,false);
 assert.equal(Object.hasOwn(a,'controlTaskAuthorized'),false);assert.equal(Object.keys(a).some(k=>/key|proof/i.test(k)),false);
});
test('prior live result and immutable used-one Auth budget must agree with pinned evidence',()=>{
 const p=Buffer.from(JSON.stringify(prior()));assert.equal(validatePriorResult(p,sha(p)),true);validateBudget(ledger(),claimSha);
 for(const edit of [x=>x.sourceAuthUserRead=false,x=>x.finalFreezeAudit=true,x=>x.applyAuthorized=true,x=>x.macDataTransit=true,
  x=>x.strictMismatchGroups.push('schema:relations')]){const x=prior();edit(x);const b=Buffer.from(JSON.stringify(x));assert.throws(()=>validatePriorResult(b,sha(b)));}
 for(const edit of [x=>x.used=2,x=>x.remaining=3,x=>x.uncertain=true,x=>x.claims[0].claimSha256='0'.repeat(64),
  x=>x.claims[0].actionId='T40.final_before',x=>x.claims[0].status='UNCERTAIN']){const x=ledger();edit(x);assert.throws(()=>validateBudget(x,claimSha),{code:'T40_AUTH_BUDGET_NOT_STABLE'});}
});
test('prepare writes exactly one machine capability, zeroes entropy/token and binds metadata endpoint for exact2h',()=>{
 const entropy=Buffer.alloc(32,1);let held,copy,writes=0;
 const p=createPrepared({manifestSha256:manifestSha,now,random:n=>{assert.equal(n,32);return entropy;},writeSecret:b=>{writes++;held=b;copy=Buffer.from(b);}});
 assert.equal(writes,1);assert.ok(entropy.every(x=>x===0));assert.ok(held.every(x=>x===0));assert.equal(copy.toString(),token);
 assert.equal(p.capabilitySha256,capSha);assert.equal(p.functionName,'bron-admission-metadata-'+capSha.slice(0,12));
 assert.equal(Date.parse(p.expiresUtc)-Date.parse(p.createdUtc),7200000);validatePrepared(token,p,manifestSha,now);
 assert.throws(()=>createPrepared({manifestSha256:manifestSha,now,random:()=>Buffer.alloc(31),writeSecret:()=>assert.fail()}),{code:'T40_ENTROPY_INVALID'});
});
test('prepared task/action/protocol/query/manifest/capability/expiry bindings cannot be changed',()=>{
 validatePrepared(token,prepared(),manifestSha,now);
 for(const patch of [{task:'T37'},{actionId:'T41.http_source_admission'},{protocol:'BRON_PRIVATE_SNAPSHOT_V1'},
  {metadataQuerySha256:'0'.repeat(64)},{manifestSha256:'0'.repeat(64)},{destinationVps:'127.0.0.1'},
  {functionName:'bron-source-reader-'+capSha.slice(0,12)},{expiresUtc:new Date(now+45000).toISOString()}])
  assert.throws(()=>validatePrepared(token,{...prepared(),...patch},manifestSha,now),{code:'T40_PREPARED_INVALID'});
 assert.throws(()=>validatePrepared(token+'\n',prepared(),manifestSha,now));
});
test('real requestMetadata emits only one canonical HTTPS/SNI/raw64POST with no secret headers',async()=>{
 const c=client(),r=await requestMetadata(token,prepared(),c);assert.equal(r.statusCode,200);assert.equal(c.calls.length,1);
 assert.deepEqual(c.calls[0],{options:{protocol:'https:',hostname:project+'.supabase.co',port:443,servername:project+'.supabase.co',
  rejectUnauthorized:true,agent:false,method:'POST',path:'/functions/v1/'+prepared().functionName,
  headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}},body:token,encoding:'ascii'});
 assert.ok(c.resources.every(x=>x.req.destroyed&&x.res.destroyed));
});
test('HTTPS rejects redirect, body/JSON errors, timeout and abort without replay or private details',async()=>{
 for(const [c,options,code] of [[client({status:302,raw:'PRIVATE_BODY'}),{},'T40_REDIRECT_REJECTED'],
  [client({raw:'PRIVATE_BODY'}),{},'T40_JSON_INVALID'],[client({raw:'x'.repeat(1572865)}),{},'T40_BODY_LIMIT'],
  [client({stall:true}),{timeoutMs:5},'T40_HTTPS_TIMEOUT'],[client({error:true}),{},'T40_HTTPS_FAILURE']]){
  const r=await requestMetadata(token,prepared(),{...c,...options});assert.equal(r.code,code);assert.equal(c.calls.length,1);assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
 }
 const c=new AbortController();c.abort();const f=client();assert.equal((await requestMetadata(token,prepared(),{...f,signal:c.signal})).code,'T40_ABORTED');assert.equal(f.calls.length,0);
 const remote=await requestMetadata(token,prepared(),client({status:502,body:{protocol:PROTOCOL,stage:'metadata',code:'METADATA_READER_FAILED',state:state(),message:'PRIVATE_ERROR'}}));
 assert.equal(remote.remoteStage,'metadata');assert.equal(remote.remoteCode,'METADATA_READER_FAILED');assert.doesNotMatch(JSON.stringify(remote),/authenticator|PRIVATE|state/);
});
test('protocol-separated actual HKDF/GCM decrypt rejects T37 encryption and tampering',()=>{
 assert.deepEqual(decryptMetadata(encrypted(),token,capSha),frame());
 const bad=encrypted(),bytes=Buffer.from(bad.ciphertext,'base64');bytes[0]^=1;bad.ciphertext=bytes.toString('base64');
 for(const envelope of [bad,encrypted(frame(),token,'BRON_PRIVATE_SNAPSHOT_V1'),{...encrypted(),nonce:'!!!!'},
  {...encrypted(),extra:'PRIVATE'},encrypted(frame(),'02'.repeat(32))])assert.throws(()=>decryptMetadata(envelope,token,capSha));
});
test('decrypted frame must prove exact readonly metadata, rollback, query/action, timing and physical PID',()=>{
 assert.deepEqual(validateMetadataFrame(frame(),prepared(),now,now+10),state());
 const observed=frame();observed.state.backends.push({pid:101,role:null,type:'pg_net 0.20.4 worker',state:null,openTransaction:false,super:false,providerAppKnown:null});
 assert.equal(validateMetadataFrame(observed,prepared(),now,now+10).backends[1].type,'pg_net 0.20.4 worker');
 for(const edit of [v=>v.actionId='T41.http_source_admission',v=>v.destinationVps='127.0.0.1',v=>v.metadataQuerySha256='0'.repeat(64),
  v=>v.rollback_completed=false,v=>v.tls_negative_rejected=false,v=>v.started_epoch_ms-=6000,v=>v.finished_epoch_ms=now+30001,
  v=>v.identity.read_only='off',v=>v.identity.isolation='read committed',v=>v.identity.pid=101,v=>v.identity.server_address='192.0.2.1',
  v=>v.state.roles[0].password='PRIVATE',v=>v.state.authRows=[],v=>v.extra='PRIVATE']){
  const v=frame();edit(v);assert.throws(()=>validateMetadataFrame(v,prepared(),now,now+10));
 }
});
test('actual custody core persists before-image then safe receipt; Auth budget stays exactly one without key/control',async()=>{
 const f=rig(),r=await f.run();assert.deepEqual(f.events,['budget','guard','attempt','post','before-file','receipt-file','budget']);
 assert.equal(r.status,'METADATA_PREPARED');assert.equal(r.authBudgetBefore,1);assert.equal(r.authBudgetAfter,1);
 assert.equal(r.sourceMetadataRead,true);assert.equal(r.sourceAuthUserRead,false);assert.equal(r.sourceBusinessDataRead,false);
 assert.equal(r.controlReady,false);assert.equal(r.sourceBarrierPass,false);assert.equal(r.macDataTransit,false);
 assert.equal(f.store.size,2);assert.equal(r.metadataReceipt.receiptSha256,sha(f.store.get(f.args.activation.metadataReceiptPath)));
 const stored=JSON.parse(f.store.get(f.args.activation.beforeImagePath));assert.equal(stored.kind,'source-admission-metadata-only');
 assert.deepEqual(stored.state,state());assert.doesNotMatch(JSON.stringify(r),/authenticator|openTransaction|ownerPath|REVOKE|GRANT|state":/);
 await assert.rejects(f.run(),safe);assert.equal(f.posts,1);assert.equal(f.attempts,1);
});
test('source failure/abort or changed Auth budget yields no fabricated success and no automatic retry',async()=>{
 const f=rig({send:()=>{throw Error('PRIVATE_ERROR postgres://password');}});await assert.rejects(f.run(),e=>{safe(e);assert.equal(e.code,'T40_HTTPS_FAILURE');assert.equal(e.sourceMetadataRead,null);return true;});assert.equal(f.posts,1);assert.equal(f.store.size,0);
 const c=new AbortController();c.abort();const g=rig();g.args.signal=c.signal;await assert.rejects(g.run(),{code:'T40_ABORTED'});assert.equal(g.posts+g.guards,0);
 const h=rig({status:f=>{const s=ledger();if(f.statusReads>1)s.used=2;return s;}});await assert.rejects(h.run(),{code:'T40_AUTH_BUDGET_NOT_STABLE'});assert.equal(h.posts,1);assert.equal(h.store.size,2);
 const i=rig();i.args.activation.metadataOnly=false;await assert.rejects(i.run(),safe);assert.equal(i.posts,0);
});
test('false durability or lost persistence ACK blocks receipt/success while preserving private artifacts and guard',async()=>{
 for(const patch of [{uid:1000},{mode:0o644},{fileFsynced:false},{directoryFsynced:false},{exclusive:false},{readbackSha256:'0'.repeat(64)}]){
  const f=rig({persist:(_r,e)=>({...e,...patch})});await assert.rejects(f.run(),{code:'T40_CUSTODY_FAILED'});assert.equal(f.store.size,1);assert.equal(f.posts,1);
 }
 const f=rig({persist:()=>{throw Error('PRIVATE_IO_ERROR');}});await assert.rejects(f.run(),safe);assert.equal(f.store.size,1);
 await assert.rejects(f.run(),safe);assert.equal(f.posts,1);
});
test('actual filesystem adapter preserves true fixture ownership; nonroot evidence cannot masquerade as root custody',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bron-t40-custody-'));fs.chmodSync(directory,0o700);
 const f=rig(),adapter=createAdmissionCustodyFs({activation:f.args.activation},{directory,uid:process.getuid(),gid:process.getgid()});
 try{
  f.args.persistBeforeImage=adapter.persistBeforeImage;f.args.persistReceipt=adapter.persistReceipt;
  if(process.getuid()!==0){await assert.rejects(f.run(),{code:'T40_CUSTODY_FAILED'});assert.equal(f.posts,1);assert.equal(f.guards,1);
   const files=fs.readdirSync(directory);assert.deepEqual(files,[path.basename(f.args.activation.beforeImagePath)]);
   const s=fs.statSync(path.join(directory,files[0]));assert.equal(s.uid,process.getuid());assert.equal(s.mode&0o7777,0o600);
   assert.equal(fs.existsSync(path.join(directory,path.basename(f.args.activation.metadataReceiptPath))),false);
  }
 }finally{adapter.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('finite Source and custody diagnostics survive wrappers without exposing private state or raw messages',async()=>{
 const f=rig({send:()=>({statusCode:502,code:'T40_HTTP_STATUS',remoteStage:'metadata',remoteCode:'METADATA_READER_FAILED',message:'PRIVATE_ERROR'})});
 await assert.rejects(f.run(),e=>{safe(e);assert.equal(e.code,'T40_HTTP_STATUS');assert.equal(e.remoteStage,'metadata');assert.equal(e.remoteCode,'METADATA_READER_FAILED');assert.equal(e.custodyPhase,'read-metadata');return true;});
 const g=rig({persist:()=>{throw Object.assign(Error('PRIVATE_IO_ERROR'),{code:'ADMISSION_FS_IO_UNCERTAIN'});}});
 await assert.rejects(g.run(),e=>{safe(e);assert.equal(e.code,'T40_CUSTODY_FAILED');assert.equal(e.upstreamCode,'ADMISSION_FS_IO_UNCERTAIN');assert.equal(e.custodyPhase,'persist-before-image');return true;});
 const h=rig({status:()=>{throw Object.assign(Error('PRIVATE_ERROR'),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});}});
 await assert.rejects(h.run(),e=>{safe(e);assert.equal(e.code,'T40_AUTH_BUDGET_NOT_STABLE');assert.equal(e.upstreamCode,'SOURCE_TRANSFER_LEDGER_UNCERTAIN');return true;});assert.equal(h.posts,0);
 const i=rig({send:()=>({statusCode:502,code:'T40_HTTP_STATUS',remoteStage:'PRIVATE_ERROR',remoteCode:'PRIVATE_ERROR'})});
 await assert.rejects(i.run(),e=>{safe(e);assert.equal(Object.hasOwn(e,'remoteStage'),false);assert.equal(Object.hasOwn(e,'remoteCode'),false);return true;});
 const j=rig(),result=await j.run();assert.equal(Object.hasOwn(result.metadataReceipt,'ownerPids'),false);
 assert.equal(Object.hasOwn(JSON.parse(j.store.get(j.args.activation.metadataReceiptPath)),'ownerPids'),true);
});
