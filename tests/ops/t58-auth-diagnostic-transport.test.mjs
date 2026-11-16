import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {canonical,PROTOCOL,validateManifest,validateOwnerProof,validateSourceGate,validatePrepared,
 sourceFiles,decryptDiagnostic,validateSourceFrame,requestDiagnostic} from '../../docs/runbooks/payloads/t58-auth-diagnostic.mjs';
import {encryptDiagnostic} from '../../docs/runbooks/payloads/t58-encrypt-diagnostic.mjs';
import {AUTH_DIAGNOSTIC_COLUMNS,summarizeAuthDiagnostic} from '../../docs/runbooks/payloads/t58-auth-diagnostic-core.mjs';
import {authRowsPlan} from '../../docs/runbooks/payloads/t30-auth-compact.mjs';
import {validateFenceWitness} from '../../docs/runbooks/payloads/source-final-https-reader/fence-witness.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),encode=x=>Buffer.from(canonical(x)+'\n');
const now=Date.parse('2026-11-15T12:00:00.000Z'),mSha='a'.repeat(64),grant='b'.repeat(64),token='1'.repeat(64),capSha=sha(token);
const context={before:{backends:[5960,5961,5968,349125,1414968,1658737,1661141,1661142,1661169,1661170,1661175].map(pid=>({pid}))},
 boundary:{capturedMicros:'1794709552349448',ownerPids:[1747293]},sourceBarrierActionId:'T40.http_source_admission',
 sourceBarrierReceiptSha256:'0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6'};
const contextSha='564c015f97aea285659304a78437840562bf701e3ed5df55b94f04c9008c5f3b';
function manifest(){return {task:'T58',actionId:'T58.auth_diagnostic',execution_authorized:true,
 approval:{status:'APPROVED',document_sha256:grant,maxTotal:3,priorUsed:2,diagnosticSnapshots:1,repurposeUnusedOriginalSlot:true,
  credentialDerivedColumnDigests:true,encryptedToVpsRamOnly:true,rawAuthValues:false,targetWrites:false,futureFinalsAuthorized:false},
 source:{projectRef:'vkkqffvmztpzgygzfxhq',origin:'https://vkkqffvmztpzgygzfxhq.supabase.co',protocol:PROTOCOL,template_name_prefix:'bron-auth-diag-'},
 files:Object.fromEntries(['t58-auth-diagnostic.mjs','t58-auth-diagnostic-core.mjs','t58-encrypt-diagnostic.mjs','source-auth-diagnostic/index.ts']
  .map(p=>['docs/runbooks/payloads/'+p,'c'.repeat(64)]))};}
function prepared(){return {task:'T58',actionId:'T58.auth_diagnostic',manifestSha256:mSha,ownerGrantSha256:grant,
 origin:'https://vkkqffvmztpzgygzfxhq.supabase.co',projectRef:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',protocol:PROTOCOL,
 createdUtc:new Date(now).toISOString(),expiresUtc:new Date(now+7200000).toISOString(),capabilitySha256:capSha,functionName:'bron-auth-diag-'+capSha.slice(0,12),fenceContextSha256:contextSha};}
function owner(){return {format:1,task:'T58',actionId:'T58.auth_diagnostic',manifestSha256:mSha,ownerGrantSha256:grant,status:'APPROVED',
 scope:'AUTH_ONLY_COLUMN_DIAGNOSIS_ATTEMPT_3',maxTotal:3,priorUsed:2,sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',
 encryptedToVpsRamOnly:true,rawAuthValues:false,targetWrites:false,futureFinalsAuthorized:false};}
function gate(){return {format:1,task:'T58',actionId:'T58.auth_diagnostic',manifestSha256:mSha,ownerGrantSha256:grant,
 sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',sourceFenceVerified:true,sourceCheckedMicros:String(BigInt(now)*1000n),
 sourceBarrierReceiptSha256:context.sourceBarrierReceiptSha256,fenceContextSha256:contextSha,globalAttempt:3};}
function data(){return {authRows:[{private_id:'00000000-0000-4000-8000-000000000001',private_stamp:'2026-11-13 12:00:00.000001+00',private_micros:'1794571200000001',private_other:'d'.repeat(64)}],
 columnFingerprints:AUTH_DIAGNOSTIC_COLUMNS.map(name=>({name,row_count:1,hash:'e'.repeat(64)}))};}
function frame(){return {ok:true,protocol:PROTOCOL,projectRef:'vkkqffvmztpzgygzfxhq',started_epoch_ms:now,finished_epoch_ms:now+10,expires_epoch_ms:now+7200000,
 tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',identity:{database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',
  read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:2000000},
 fenceWitness:{db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',pid:2000000,
  backendStartMicros:'1794709552349449',preDataValidated:true,sourceBarrierActionId:context.sourceBarrierActionId,sourceBarrierReceiptSha256:context.sourceBarrierReceiptSha256},data:data()};}

test('pending owner scope cannot activate; approved scope is exactly one repurposed third read',()=>{
 const check=m=>{const raw=encode(m);return validateManifest(raw,sha(raw));};assert.equal(check(manifest()).task,'T58');
 for(const change of [m=>m.execution_authorized=false,m=>m.approval.status='PENDING_OWNER',m=>m.approval.document_sha256=null,
  m=>m.approval.maxTotal=5,m=>m.approval.priorUsed=0,m=>m.approval.diagnosticSnapshots=2,m=>m.approval.rawAuthValues=true,
  m=>m.approval.targetWrites=true,m=>m.approval.futureFinalsAuthorized=true,m=>m.approval.encryptedToVpsRamOnly=false,
  m=>m.source.origin='https://elsewhere.invalid',m=>m.source.protocol='BRON_PRIVATE_SNAPSHOT_V1']){
  const m=manifest();change(m);assert.throws(()=>check(m),/T58_(OWNER_SCOPE_NOT_APPROVED|OWNER_SCOPE_INVALID)/);
 }
});
test('Root owner proof is SHA-bound and cannot authorize DML, future reads or another manifest',()=>{
 const check=p=>{const raw=encode(p);return validateOwnerProof(raw,sha(raw),manifest(),mSha);};assert.equal(check(owner()).status,'APPROVED');
 for(const change of [p=>p.manifestSha256='0'.repeat(64),p=>p.ownerGrantSha256='0'.repeat(64),p=>p.maxTotal=5,p=>p.rawAuthValues=true,
  p=>p.targetWrites=true,p=>p.futureFinalsAuthorized=true,p=>p.scope='FINAL_WINDOW',p=>p.extra=true]){
  const p=owner();change(p);assert.throws(()=>check(p),{code:'T58_OWNER_PROOF_SCOPE'});
 }
});
test('actual Source fence clock is required, no older-than-ten-minute approval or fake future clock',()=>{
 const check=g=>{const raw=encode(g);return validateSourceGate(raw,sha(raw),mSha,grant,now);};assert.equal(check(gate()).globalAttempt,3);
 for(const change of [g=>g.sourceCheckedMicros=String(BigInt(now-600001)*1000n),g=>g.sourceCheckedMicros=String(BigInt(now+5001)*1000n),
  g=>g.sourceFenceVerified=false,g=>g.globalAttempt=4,g=>g.fenceContextSha256='0'.repeat(64),g=>g.ownerGrantSha256='0'.repeat(64)]){
  const g=gate();change(g);assert.throws(()=>check(g),{code:'T58_SOURCE_GATE_NOT_CURRENT'});
 }
});
test('prepared scope binds fresh two-hour capability, task, grant and Source-only origin',()=>{
 const check=p=>{const raw=encode(p);return validatePrepared(raw,sha(raw),mSha,grant,now);};assert.equal(check(prepared()).protocol,PROTOCOL);
 for(const change of [p=>p.task='T56',p=>p.functionName='bron-source-reader-old',p=>p.protocol='BRON_PRIVATE_SNAPSHOT_V1',
  p=>p.ownerGrantSha256='0'.repeat(64),p=>p.destinationVps='elsewhere',p=>p.expiresUtc=new Date(now+10800000).toISOString()]){
  const p=prepared();change(p);assert.throws(()=>check(p),{code:'T58_PREPARED_INVALID'});
 }
 const p=prepared(),raw=encode(p);assert.throws(()=>validatePrepared(raw,sha(raw),mSha,grant,now+7200000-140000),{code:'T58_PREPARED_INVALID'});
});
test('WebCrypto Source and Node VPS agree on HKDF/AES-GCM; old protocol and tamper are rejected',async()=>{
 const f=frame(),encrypted=await encryptDiagnostic(f,new TextEncoder().encode(token),capSha);
 assert.deepEqual(decryptDiagnostic(encrypted,token,capSha),f);
 assert.throws(()=>decryptDiagnostic({...encrypted,protocol:'BRON_PRIVATE_SNAPSHOT_V1'},token,capSha),{code:'T58_ENVELOPE_SCOPE'});
 const tampered=Buffer.from(encrypted.ciphertext,'base64');tampered[0]^=1;
 assert.throws(()=>decryptDiagnostic({...encrypted,ciphertext:tampered.toString('base64')},token,capSha),{code:'T58_DECRYPT_FAILED'});
 assert.throws(()=>decryptDiagnostic(encrypted,'2'.repeat(64),capSha),{code:'T58_ENVELOPE_SCOPE'});
});
test('private Source data is accepted only after exact protocol, current RO identity and fresh physical witness',()=>{
 assert.deepEqual(validateSourceFrame(frame(),prepared(),context,validateFenceWitness,now,now+20),data());
 for(const change of [f=>f.protocol='BRON_PRIVATE_SNAPSHOT_V1',f=>f.expires_epoch_ms++,f=>f.tls_negative_rejected=false,
  f=>f.started_epoch_ms=now-5001,f=>f.identity.read_only='off',f=>f.fenceWitness.preDataValidated=false,
  f=>f.fenceWitness.pid=5960,f=>f.fenceWitness.backendStartMicros=context.boundary.capturedMicros,
  f=>f.data.columnFingerprints[0].row_count=2,f=>f.data.authRows[0].private_extra='FORBIDDEN']){
  const f=frame();change(f);assert.throws(()=>validateSourceFrame(f,prepared(),context,validateFenceWitness,now,now+20));
 }
});
test('whole-column mismatch summary contains only counts and field names, no row/digest/timestamp values',()=>{
 const a=data(),b=data();b.columnFingerprints.find(c=>c.name==='encrypted_password').hash='f'.repeat(64);b.authRows[0].private_other='f'.repeat(64);
 const result=summarizeAuthDiagnostic(a,b,{planAuthRows:authRowsPlan}),raw=JSON.stringify(result);
 assert.match(raw,/encrypted_password/);assert.doesNotMatch(raw,/00000000-0000|1794571200000001|2026-11-13|dddddddd|eeeeeeee|ffffffff|private_other|private_stamp/);
});
test('render replaces four fixed placeholders exactly and binds unchanged reviewed fence context',()=>{
 const template=fs.readFileSync(new URL('../../docs/runbooks/payloads/source-auth-diagnostic/index.ts',import.meta.url));
 const files=sourceFiles(template,prepared(),context,{'core.mjs':'f'.repeat(64)});assert.equal(Object.keys(files).length,2);assert.match(files['index.ts'],/^[a-f0-9]{64}$/);
 const changed=structuredClone(context);changed.boundary.ownerPids=[];assert.throws(()=>sourceFiles(template,prepared(),changed,{}),{code:'T58_CONTEXT_SHA'});
 assert.throws(()=>sourceFiles(Buffer.from(template.toString().replace('{{CAPABILITY_SHA256}}','missing')),prepared(),context,{}),{code:'T58_TEMPLATE_PLACEHOLDER'});
 assert.doesNotMatch(template.toString(),/console\.|snapshotDatabase|UPDATE\s|INSERT\s|DELETE\s|COPY\s/);
});
function fakeRequest(status,body,onOptions=()=>{}){return (options,callback)=>{onOptions(options);const req=new EventEmitter();req.destroy=()=>{};
 req.end=sent=>{assert.equal(sent,token);queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.destroy=()=>{};callback(res);
  queueMicrotask(()=>{res.emit('data',Buffer.from(body));res.emit('end');});});};return req;};}
test('HTTPS production options force exact endpoint, CA/SNI and one 64-byte POST',async()=>{
 let calls=0;const result=await requestDiagnostic(token,prepared(),{request:fakeRequest(200,'{"ok":true}',o=>{calls++;
  assert.equal(o.hostname,'vkkqffvmztpzgygzfxhq.supabase.co');assert.equal(o.servername,o.hostname);assert.equal(o.rejectUnauthorized,true);
  assert.equal(o.method,'POST');assert.equal(o.agent,false);assert.equal(o.headers['Content-Length'],'64');assert.equal(o.path,'/functions/v1/'+prepared().functionName);})});
 assert.equal(result.code,undefined);assert.equal(result.statusCode,200);assert.deepEqual(result.value,{ok:true});assert.equal(calls,1);
});
test('HTTPS refuses redirects, oversized bodies, invalid JSON and pre-aborted execution',async()=>{
 assert.equal((await requestDiagnostic(token,prepared(),{request:fakeRequest(302,'{}')})).code,'T58_REDIRECT_REJECTED');
 assert.equal((await requestDiagnostic(token,prepared(),{request:fakeRequest(200,'x'.repeat(131073))})).code,'T58_BODY_LIMIT');
 assert.equal((await requestDiagnostic(token,prepared(),{request:fakeRequest(200,'not-json')})).code,'T58_JSON_INVALID');
 const c=new AbortController();c.abort();let called=false;
 assert.equal((await requestDiagnostic(token,prepared(),{signal:c.signal,request:()=>{called=true;throw Error('must-not-call');}})).code,'T58_REQUEST_ABORTED');assert.equal(called,false);
});
