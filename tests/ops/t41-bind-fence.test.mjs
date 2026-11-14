import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash,createCipheriv,hkdfSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PROTOCOL,validateManifest,validateBase,validateRootInput,validateLedger,buildWitnessContext,validatePreparedContext,requestWitness,requestReadiness,
 decryptWitness,validateWitnessFrame,buildBindingArtifacts,persistRootArtifacts,runWitnessVerification,createPrivateFiles} from '../../docs/runbooks/payloads/t41-bind-fence.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),canon=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v),bytes=x=>Buffer.from(canon(x)+'\n');
const manifestSha='1'.repeat(64),controlSha='2'.repeat(64),summarySha='3'.repeat(64),proofSha='4'.repeat(64),verifySha='5'.repeat(64),token='a'.repeat(64);
const now=Date.parse('2026-11-14T08:30:00.000Z'),dir='/root/bron-secrets/t41-release';
const base=()=>({task:'T41',actionId:'T41.final_https_window',manifestSha256:manifestSha,ownerGrantSha256:'cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69',origin:'https://vkkqffvmztpzgygzfxhq.supabase.co',projectRef:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',protocol:'BRON_PRIVATE_SNAPSHOT_V1',createdUtc:new Date(now).toISOString(),expiresUtc:new Date(now+7200000).toISOString(),capabilitySha256:sha(token),functionName:'bron-source-reader-'+sha(token).slice(0,12),controlSummarySha256:summarySha,controlReceiptSha256:controlSha,independentKeyProofSha256:proofSha});
const control=()=>({sqlHashes:{verifyFencedSql:verifySha}});
const approved=()=>({format:1,task:'T41',actionId:'T41.source_fence_approved',manifestSha256:manifestSha,basePreparedSha256:sha(bytes(base())),controlSummarySha256:summarySha,controlReceiptSha256:controlSha,verifyFencedSqlSha256:verifySha,status:'SOURCE_FENCED_BY_COORDINATOR',normalConnectDenied:true,existingClientsDrained:true,providerBoundaryReviewed:true,sourcePaused:false,targetWritesStarted:false,boundary:{capturedMicros:'1794644900000000',ownerPids:[22]},observedUtc:new Date(now-1000).toISOString()});
const before=()=>({db:'postgres',actor:'postgres',session:'postgres',pid:21,readOnly:'on',owner:'postgres',signal:true,prepared:0,netQueued:0,runJobsExists:false,unexpectedActiveCron:0,acl:[],roles:[],lookupOtherSetRoles:0,lookupCriticalWrites:0,lookupSequenceWrites:0,lookupCriticalDefiners:0,backends:[{pid:21,role:'postgres',type:'client backend',state:'idle',openTransaction:false,super:false,providerAppKnown:null}],capturedMicros:'1794644800000000'});
const ledger=()=>({used:1,remaining:2,maxAttempts:3,uncertain:false,claims:[{attempt:1,status:'VALID',actionId:'T37.live',capabilitySha256:'b'.repeat(64)}]});
const context=()=>buildWitnessContext({manifestSha,basePrepared:base(),basePreparedSha:sha(bytes(base())),rootApproved:approved(),control:control(),beforeState:before(),now});
const rawWitness=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',pid:30,backendStartMicros:'1794644900000001'});
function frame(p){return {ok:true,protocol:PROTOCOL,projectRef:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',sourceBarrierActionId:'T40.http_source_admission',contextSha256:p.contextSha256,sourceControlReceiptSha256:controlSha,bindingKind:'PRE_ADMISSION_CONTROL_RECEIPT',barrierPass:false,started_epoch_ms:now+1,finished_epoch_ms:now+3,expires_epoch_ms:now+7200000,tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',rollback_completed:true,identity:{database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:30,database_time:'2026-11-14 08:30:00.002+00'},witness:{...rawWitness(),preDataValidated:true,sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:controlSha}};}
function encrypted(value,secret=token){const key=Buffer.from(hkdfSync('sha256',Buffer.from(secret,'ascii'),Buffer.from(sha(secret),'utf8'),Buffer.from(PROTOCOL,'utf8'),32)),nonce=Buffer.alloc(12,7),c=createCipheriv('aes-256-gcm',key,nonce);const b=Buffer.concat([c.update(JSON.stringify(value)),c.final(),c.getAuthTag()]);return {protocol:PROTOCOL,nonce:nonce.toString('base64'),ciphertext:b.toString('base64')};}
function client({status=200,body,raw,stall=false,error=false}={}){const calls=[],resources=[];return {calls,resources,request:(options,callback)=>{const req=new EventEmitter(),res=new EventEmitter();calls.push({options});resources.push({req,res});req.destroyed=res.destroyed=false;req.destroy=()=>{req.destroyed=true;};res.destroy=()=>{res.destroyed=true;};res.statusCode=status;req.end=(value,encoding)=>{calls.at(-1).body=value;calls.at(-1).encoding=encoding;queueMicrotask(()=>{if(error){req.emit('error',Error('SECRET_ERROR'));return;}if(stall)return;callback(res);if(res.destroyed)return;res.emit('data',Buffer.from(raw??JSON.stringify(body)));if(!res.destroyed)res.emit('end');});};return req;}};}

test('manifest authorizes only these metadata phases and requires all imported runtime pins',()=>{
 const h='d'.repeat(64),root='/root/bron-secrets',runtime=root+'/t41-runtime/docs/runbooks/payloads/';
 const custody={beforeImagePath:root+'/t40-admission-before-c40a2026.json',metadataReceiptPath:root+'/t40-admission-metadata-c40a2026.json',inversePath:root+'/t40-admission-inverse-c40a2026.sql',controlReceiptPath:root+'/t40-admission-control-c40a2026.json'};
 const inputs={crypto:{path:root+'/t30-owner-key-proof-result.json',sha256:h},attestation:{path:root+'/t30-owner-key-attestation.json',sha256:h},receipt:{path:root+'/t30-release-receipt.json',sha256:h},reviewedT30CipherBinding:{reviewed:true,task:'T30',cryptoResultSha256:h,sourceReceiptSha256:h,cipherSha256:h}};
 const m={task:'T41',actionId:'T41.release_window',execution_authorized:true,adopts:{actionId:'T40.http_source_admission',manifestSha256:'a8f777d95d53b365959530a0bbce4a42b21840dc92bf1180c65eaa7dd74136f8',custody},owner_proof:{independentProofSha256:h,recoveryCipherSha256:h,inputs},input_evidence:Object.fromEntries(['T40_result_sha256','T40_receipt_sha256','T40_before_image_sha256','T40_metadata_receipt_sha256'].map(k=>[k,h])),files:{'docs/runbooks/payloads/t41-bind-fence.mjs':h},runtime_files:Object.fromEntries(['t41-bind-fence.mjs','t41-control-ready.mjs','admission-custody-fs.mjs','admission-metadata-custody.mjs','http-source-admission.mjs','t26-source-admission.mjs','source-transfer-budget.mjs','source-fence-witness/fence-witness.mjs'].map(n=>[runtime+n,h])),phase_authorizations:{prepare_control_ready:{actionId:'T41.prepare_control_ready',control_ready_only:true,source_sql_authorized:false,provider_boundary_reviewed:true,rollback_before_target_writes:true},prepare_witness:{actionId:'T41.prepare_witness',metadata_only:true,source_sql_authorized:false,max_source_POST:0},verify_witness:{actionId:'T41.verify_witness',metadata_only:true,source_sql_authorized:false,max_source_POST:1},run_final:{ownedByOtherHelper:true}}};
 const check=x=>{const b=Buffer.from(JSON.stringify(x));return validateManifest(b,sha(b),h);};assert.equal(check(m).task,'T41');
 for(const mutate of [x=>x.execution_authorized=false,x=>x.phase_authorizations.verify_witness.max_source_POST=2,x=>x.phase_authorizations.prepare_witness.source_sql_authorized=true,x=>x.runtime_files={}]){const copy=structuredClone(m);mutate(copy);assert.throws(()=>check(copy));}
 const b=Buffer.from(JSON.stringify(m));assert.throws(()=>validateManifest(b,'f'.repeat(64),h),{code:'T41_BIND_MANIFEST_SHA'});
});
test('fresh base requires exact manifest/control/grant scope and two-hour capability binding',()=>{
 validateBase(base(),manifestSha,now);
 for(const patch of [{task:'T40'},{manifestSha256:'6'.repeat(64)},{ownerGrantSha256:'7'.repeat(64)},{protocol:PROTOCOL},{functionName:'arbitrary'},{expiresUtc:new Date(now+7200001).toISOString()},{extra:'SECRET'}])assert.throws(()=>validateBase({...base(),...patch},manifestSha,now),{code:'T41_BIND_BASE_INVALID'});
 assert.throws(()=>validateBase(base(),manifestSha,now+7200000-44999),{code:'T41_BIND_BASE_INVALID'});
});
test('Root phase input binds actual control verify hash, source flags, fresh clock and boundary',()=>{
 const cfg={manifestSha,baseSha:sha(bytes(base())),base:base(),control:control(),now};validateRootInput(approved(),cfg);
 for(const patch of [{normalConnectDenied:false},{existingClientsDrained:false},{providerBoundaryReviewed:false},{sourcePaused:true},{targetWritesStarted:true},{verifyFencedSqlSha256:'0'.repeat(64)},{observedUtc:new Date(now-600001).toISOString()},{boundary:{capturedMicros:'1',ownerPids:[22]}},{extra:'SECRET'}])assert.throws(()=>validateRootInput({...approved(),...patch},cfg),{code:'T41_BIND_ROOT_APPROVAL_INVALID'});
});
test('metadata phase only verifies existing shared ledger and never consumes Auth attempts',()=>{
 validateLedger(ledger(),base());for(const patch of [{used:0},{used:2},{remaining:1},{uncertain:true},{claims:[]},{claims:[{...ledger().claims[0],capabilitySha256:sha(token)}]}])assert.throws(()=>validateLedger({...ledger(),...patch},base()),{code:'T41_BIND_AUTH_BUDGET_NOT_READY'});
});
test('pre-context projects only private before PIDs and canonical write/read preserves JSON.stringify SHA',async()=>{
 const p=await context();assert.deepEqual(p.context.before,{backends:[{pid:21}]});assert.equal(p.context.sourceBarrierReceiptSha256,controlSha);assert.equal(p.contextSha256,sha(JSON.stringify(p.context)));
 assert.doesNotMatch(JSON.stringify(p),/lookupCritical|ACL|client backend|private_/);const stored=JSON.parse(bytes(p));assert.equal(sha(JSON.stringify(stored.context)),p.contextSha256);
 await validatePreparedContext(stored,{manifestSha,basePrepared:base(),basePreparedSha:sha(bytes(base())),rootApproved:approved(),beforeState:before()});
 await assert.rejects(validatePreparedContext(stored,{manifestSha,basePrepared:base(),basePreparedSha:sha(bytes(base())),rootApproved:approved(),beforeState:{...before(),backends:[{...before().backends[0],pid:99}]}}),{code:'T41_BIND_PREPARED_CONTEXT_INVALID'});
 await assert.rejects(validatePreparedContext({...stored,contextSha256:'f'.repeat(64)},{manifestSha,basePrepared:base(),basePreparedSha:sha(bytes(base())),rootApproved:approved()}),{code:'T41_BIND_PREPARED_CONTEXT_INVALID'});
});
test('single HTTPS witness POST is canonical TLS/SNI and contains only raw capability',async()=>{
 const p=await context(),f=client({body:encrypted(frame(p))}),r=await requestWitness(token,base(),f);assert.equal(r.statusCode,200);assert.equal(f.calls.length,1);assert.equal(f.calls[0].body,token);assert.equal(f.calls[0].encoding,'ascii');
 assert.deepEqual(f.calls[0].options,{protocol:'https:',hostname:'vkkqffvmztpzgygzfxhq.supabase.co',port:443,servername:'vkkqffvmztpzgygzfxhq.supabase.co',rejectUnauthorized:true,agent:false,method:'POST',path:'/functions/v1/'+base().functionName,headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}});
 assert(f.resources.every(x=>x.req.destroyed&&x.res.destroyed));
});
test('secretless purpose GET is fixed, and DATA/unknown protocol blocks before unbudgeted POST',async()=>{
 const f=client({status:403,body:{protocol:PROTOCOL,ok:false}}),reply=await requestReadiness(base(),f);
 assert.equal(reply.statusCode,403);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'GET');assert.deepEqual(f.calls[0].options.headers,{Accept:'application/json'});assert.equal(f.calls[0].body,undefined);
 const p=await context();let guards=0,calls=0,readiness=0;
 for(const value of [{protocol:'BRON_PRIVATE_SNAPSHOT_V1',ok:false},{protocol:PROTOCOL,ok:true},{protocol:PROTOCOL,ok:false,extra:'SECRET'}]){
  await assert.rejects(runWitnessVerification({manifestSha,base:base(),baseSha:sha(bytes(base())),approved:approved(),preparedContext:p,control:control(),token,guard:()=>guards++,persist:()=>assert.fail('persist')},{now:()=>now+5,status:()=>ledger(),readiness:async()=>{readiness++;return {statusCode:403,value};},send:async()=>{calls++;}}),{code:'T41_BIND_PURPOSE_NOT_VERIFIED'});
 }
 assert.equal(guards,3);assert.equal(readiness,3);assert.equal(calls,0);
});
test('HTTPS redirects, bounds, timeout and error paths never retry or return sensitive bodies',async()=>{
 for(const [f,options,code]of [[client({status:302,raw:'SECRET'}),{},'T41_BIND_REDIRECT_REJECTED'],[client({status:500,raw:'SECRET'}),{},'T41_BIND_HTTP_STATUS'],[client({raw:'x'.repeat(131073)}),{},'T41_BIND_BODY_LIMIT'],[client({stall:true}),{timeoutMs:1},'T41_BIND_HTTPS_TIMEOUT'],[client({error:true}),{},'T41_BIND_HTTPS_FAILURE']]){const r=await requestWitness(token,base(),{...f,...options});assert.equal(r.code,code);assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(r),/SECRET/);}
 assert.throws(()=>requestWitness(token,{...base(),origin:'https://other.test'}),{code:'T41_BIND_REQUEST_SCOPE'});
 const f=client({stall:true}),c=new AbortController(),q=requestWitness(token,base(),{...f,signal:c.signal});c.abort();assert.equal((await q).code,'T41_BIND_ABORTED');assert.equal(f.calls.length,1);
});
test('AEAD is bound to secret/protocol/canonical base64/nonce/tag with no plaintext errors',async()=>{
 const p=await context(),e=encrypted(frame(p));assert.deepEqual(decryptWitness(e,token,sha(token)),frame(p));
 assert.throws(()=>decryptWitness({...e,protocol:'BRON_PRIVATE_SNAPSHOT_V1'},token,sha(token)),{code:'T41_BIND_ENVELOPE_INVALID'});
 const b=Buffer.from(e.ciphertext,'base64');b[0]^=1;assert.throws(()=>decryptWitness({...e,ciphertext:b.toString('base64')},token,sha(token)),{code:'T41_BIND_DECRYPT_FAILED'});
 assert.throws(()=>decryptWitness(e,'b'.repeat(64),sha('b'.repeat(64))),{code:'T41_BIND_DECRYPT_FAILED'});
 for(const patch of [{nonce:Buffer.alloc(13).toString('base64')},{ciphertext:'!!!!'},{extra:'SECRET'}])assert.throws(()=>decryptWitness({...e,...patch},token,sha(token)));
});
test('Source frame requires genuine pre-data witness, same physical RR backend, rollback and control binding',async()=>{
 const p=await context(),cfg={base:base(),preparedContext:p,callStarted:now,now:now+5},f=frame(p);assert.deepEqual(validateWitnessFrame(f,cfg),rawWitness());
 for(const patch of [{barrierPass:true},{bindingKind:'FINAL_BARRIER'},{sourceControlReceiptSha256:'0'.repeat(64)},{rollback_completed:false},{tls_negative_rejected:false},{finished_epoch_ms:now+30002},{extra:'SECRET'}])assert.throws(()=>validateWitnessFrame({...f,...patch},cfg),{code:'T41_BIND_WITNESS_FRAME_INVALID'});
 for(const patch of [{pid:21},{backendStartMicros:approved().boundary.capturedMicros},{preDataValidated:false},{readOnly:'off'},{isolation:'read committed'}])assert.throws(()=>validateWitnessFrame({...f,witness:{...f.witness,...patch}},cfg),{code:'T41_BIND_WITNESS_FRAME_INVALID'});
 assert.throws(()=>validateWitnessFrame({...f,identity:{...f.identity,pid:31}},cfg),{code:'T41_BIND_WITNESS_FRAME_INVALID'});
});
test('planned artifacts use distinct pre-control and durable barrier hashes without self-reference cycles',async()=>{
 const p=await context(),raw=validateWitnessFrame(frame(p),{base:base(),preparedContext:p,callStarted:now,now:now+5});
 const planned=buildBindingArtifacts({manifestSha,base:base(),baseSha:sha(bytes(base())),approved:approved(),preparedContext:p,witness:raw});
 assert.equal(planned.barrier.controlReceiptSha256,controlSha);assert.equal('barrierReceiptSha256'in planned.barrier,false);assert.equal('fenceContextSha256'in planned.barrier,false);
 assert.equal(planned.context.sourceBarrierReceiptSha256,sha(planned.artifacts[0].bytes));assert.notEqual(planned.context.sourceBarrierReceiptSha256,controlSha);
 assert.equal(planned.final.fenceContextSha256,sha(JSON.stringify(planned.context)));assert.deepEqual(Object.keys(planned.final).sort(),[...Object.keys(base()),'fenceContextSha256'].sort());
 assert.equal(planned.input.finalPreparedSha256,sha(planned.artifacts[1].bytes));assert.equal(planned.input.barrierReceiptSha256,sha(planned.artifacts[0].bytes));
 for(const a of planned.artifacts){assert.equal(a.sha256,sha(a.bytes));assert.deepEqual(JSON.parse(a.bytes),a.path.endsWith('source-barrier.json')?planned.barrier:a.path.endsWith('final-prepared.json')?planned.final:planned.input);}
 assert.equal(sha(JSON.stringify(JSON.parse(planned.artifacts[2].bytes).fenceContext)),planned.final.fenceContextSha256);
});
test('actual fixture filesystem reports real uid, exclusive/fsync/readback, and cannot establish root durability',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'t41-bind-'));fs.chmodSync(tmp,0o700);
 try{const store=createPrivateFiles({directory:tmp,uid:process.getuid(),gid:process.getgid()}),p=await context(),planned=buildBindingArtifacts({manifestSha,base:base(),baseSha:sha(bytes(base())),approved:approved(),preparedContext:p,witness:rawWitness()});
  const logical=dir+'/fixture.json',body=Buffer.from('fixture'),proof=store.write({path:logical,bytes:body,sha256:sha(body)});assert.equal(proof.uid,process.getuid());assert.equal(proof.gid,process.getgid());assert.equal(proof.mode,0o600);assert.equal(proof.fileFsynced,true);assert.equal(proof.directoryFsynced,true);assert.equal(proof.readbackSha256,sha(body));assert.deepEqual(store.read(logical),body);
  assert.throws(()=>store.write({path:logical,bytes:body,sha256:sha(body)}),{code:'EEXIST'});
  if(process.getuid()!==0){await assert.rejects(persistRootArtifacts(planned,store.write),{code:'T41_BIND_DURABLE_ROOT_REQUIRED'});assert(fs.existsSync(path.join(tmp,'source-barrier.json')));assert(!fs.existsSync(path.join(tmp,'fence-input.json')));}
  fs.symlinkSync(path.join(tmp,'fixture.json'),path.join(tmp,'link.json'));assert.throws(()=>store.read(dir+'/link.json'));
  fs.linkSync(path.join(tmp,'fixture.json'),path.join(tmp,'hard.json'));assert.throws(()=>store.read(logical),{code:'T41_BIND_PRIVATE_FILE'});
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('invalid Root approval or budget prevents guard and Source POST',async()=>{
 const p=await context();let guards=0,calls=0;const c={manifestSha,base:base(),baseSha:sha(bytes(base())),approved:{...approved(),normalConnectDenied:false},preparedContext:p,control:control(),token,guard:()=>guards++,persist:()=>assert.fail('persist')};
 await assert.rejects(runWitnessVerification(c,{readiness:async()=>({statusCode:403,value:{protocol:PROTOCOL,ok:false}}),now:()=>now+5,status:()=>ledger(),send:async()=>{calls++;}}),{code:'T41_BIND_ROOT_APPROVAL_INVALID'});assert.equal(guards,0);assert.equal(calls,0);
 await assert.rejects(runWitnessVerification({...c,approved:approved()},{readiness:async()=>({statusCode:403,value:{protocol:PROTOCOL,ok:false}}),now:()=>now+5,status:()=>({...ledger(),used:2}),send:async()=>{calls++;}}),{code:'T41_BIND_AUTH_BUDGET_NOT_READY'});assert.equal(guards,0);assert.equal(calls,0);
});
test('uncertain witness request is guarded once, never retried, with no barrier persistence',async()=>{
 const p=await context();let guards=0,calls=0,attempts=0;
 await assert.rejects(runWitnessVerification({manifestSha,base:base(),baseSha:sha(bytes(base())),approved:approved(),preparedContext:p,control:control(),token,guard:()=>guards++,persist:()=>assert.fail('persist'),onSourceAttempt:()=>attempts++},{readiness:async()=>({statusCode:403,value:{protocol:PROTOCOL,ok:false}}),now:()=>now+5,status:()=>ledger(),send:async()=>{calls++;return {statusCode:null,code:'T41_BIND_HTTPS_TIMEOUT'};}}),e=>e.code==='T41_BIND_SOURCE_FAILED'&&e.upstreamCode==='T41_BIND_HTTPS_TIMEOUT');
 assert.equal(guards,1);assert.equal(calls,1);assert.equal(attempts,1);
});
test('verified Source witness plus actual non-root FS fails durability instead of fabricating barrier PASS',async()=>{
 const p=await context(),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'t41-bind-flow-'));fs.chmodSync(tmp,0o700);let guards=0,calls=0,checks=0,validated=0;
 try{const store=createPrivateFiles({directory:tmp,uid:process.getuid(),gid:process.getgid()});
  if(process.getuid()!==0)await assert.rejects(runWitnessVerification({manifestSha,base:base(),baseSha:sha(bytes(base())),approved:approved(),preparedContext:p,control:control(),token,guard:()=>guards++,persist:store.write,onWitnessValidated:()=>validated++},{readiness:async()=>({statusCode:403,value:{protocol:PROTOCOL,ok:false}}),now:()=>now+5,status:()=>{checks++;return ledger();},send:async()=>{calls++;return {statusCode:200,bytes:1024,elapsedMs:3,value:encrypted(frame(p))};}}),{code:'T41_BIND_DURABLE_ROOT_REQUIRED'});
  if(process.getuid()!==0){assert.equal(guards,1);assert.equal(calls,1);assert.equal(checks,2);assert.equal(validated,1);assert(!fs.existsSync(path.join(tmp,'fence-input.json')));}
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('import/noargsCLI are inert and failure never exposes private paths or error messages',()=>{
 const p=path.resolve('docs/runbooks/payloads/t41-bind-fence.mjs'),imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(p)})`],{encoding:'utf8',timeout:2000});assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
 const called=spawnSync(process.execPath,[p],{encoding:'utf8',timeout:2000});assert.equal(called.status,2);assert.match(called.stdout,/T41_BIND_EXPLICIT_REVIEW_REQUIRED/);assert.equal(called.stderr,'');assert.doesNotMatch(called.stdout,/ENOENT|stack|AGE-SECRET|postgresql:/);
});

test('non-ASCII capability bytes are rejected rather than high-bit masked into a valid secret',async()=>{
 const p=await context(),bad=Buffer.alloc(64,0xe1).toString('utf8');assert.throws(()=>requestWitness(bad,base()),{code:'T41_BIND_REQUEST_SCOPE'});
 await assert.rejects(runWitnessVerification({manifestSha,base:base(),baseSha:sha(bytes(base())),approved:approved(),preparedContext:p,control:control(),token:bad,guard:()=>assert.fail('guard'),persist:()=>assert.fail('persist')},{now:()=>now+5,status:()=>ledger(),readiness:async()=>assert.fail('GET'),send:async()=>assert.fail('POST')}),{code:'T41_BIND_CAPABILITY_SHA'});
});
