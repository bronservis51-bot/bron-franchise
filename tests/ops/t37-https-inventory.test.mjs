import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash,createCipheriv,hkdfSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PROTOCOL,validateManifest,validatePrior,validateCapability,exclusiveWrite,requestSource,decryptEnvelope,validateSnapshot,validateAuthRows,validateSource,verifyTargetIdentity,targetConfig,compareInventory,runInventory} from '../../docs/runbooks/payloads/t37-https-inventory.mjs';
import {compareSnapshots} from '../../scripts/migration-audit.mjs';
import {authRowsPlan} from '../../docs/runbooks/payloads/t30-auth-compact.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),token='a'.repeat(64),ref='vkkqffvmztpzgygzfxhq',scope='cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69',manifestSha='7'.repeat(64),expiry=Date.parse('2026-11-14T08:10:00.000Z'),now=Date.parse('2026-11-14T06:30:00.000Z');
const root='/root/bron-secrets/t37-runtime',runtimeFiles=()=>Object.fromEntries(['scripts/migration-audit.mjs','payloads/exact-query-fingerprint.mjs','payloads/t30-auth-compact.mjs','payloads/source-transfer-budget.mjs'].map(p=>[root+'/'+p,'1'.repeat(64)]));
const pins={
 '/opt/bron/audit-runtime-c128f9b/scripts/migration-audit.mjs':'a5306390fa06db03665caaaa988cadf472f17c349538712f03fa31f794d6bdea',
 '/opt/bron/audit-runtime-c128f9b/scripts/migration-source.mjs':'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
 '/opt/bron/audit-runtime-c128f9b/scripts/database-config.mjs':'1064d54299d354ec7951f40b719ce6886b78ddd00b2f2ac234c0024a8fbd55e6',
};
const manifest=()=>({task:'T37',execution_authorized:true,approval:{status:'APPROVED',document_sha256:scope},source:{origin:'https://'+ref+'.supabase.co',projectRef:ref,protocol:PROTOCOL,capability_binding:'pinned_VPS_prepare_readback',template_name_prefix:'bron-source-reader-'},transfer_budget:{directory:'/root/bron-secrets/source-transfer-budget',scope_sha256:scope,max_attempts:3,source_project:ref,destination_vps:'152.228.115.115'},files:{'docs/runbooks/payloads/t37-https-inventory.mjs':'b'.repeat(64)},runtime_files:runtimeFiles(),verify_only:{...pins},input_evidence:{T36_result_sha256:'c'.repeat(64)}});
const prior=()=>({task:'T36',status:'PASS',httpStatus:200,wrongCapabilityRejected:true,tlsNegativeRejected:true,dummyBytes:524288,sourceDataRead:false,sourceAuthUserRead:false,macDataTransit:false});
const prepared=()=>({task:'T37',manifestSha256:manifestSha,ownerGrantSha256:scope,createdUtc:'2026-11-14T06:10:00.000Z',capabilitySha256:sha(token),expiresUtc:new Date(expiry).toISOString(),functionName:'bron-source-reader-'+sha(token).slice(0,12),origin:'https://'+ref+'.supabase.co',protocol:PROTOCOL});
const authRows=()=>Array.from({length:16},(_,i)=>({private_id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),private_stamp:'2026-11-13 12:00:00.000001+00',private_micros:'1794571200000001',private_other:'d'.repeat(64)}));
const snapshot=()=>Object.fromEntries([
 ...['columns','relations','policies','storage_policies','storage_grants','triggers','extensions','constraints','indexes','routines','enums','schemas','default_grants','client_roles','role_memberships'].map(n=>['schema:'+n,{count:2,hash:'f'.repeat(64)}]),
 ...['auth.users','auth.identities','public.partner','public.location','public.role_assignment','public.daily_revenue','public.franchise_lead','public.article_revision','storage.buckets','storage.objects'].map(n=>['data:'+n,{count:n.startsWith('auth.')?16:0,hash:'e'.repeat(64)}]),
 ['sequence:app_private.fixture_seq',{last_value:'9007199254740993',is_called:false}],
]);
const source=()=>({ok:true,protocol:PROTOCOL,projectRef:ref,expires_epoch_ms:expiry,started_epoch_ms:now,finished_epoch_ms:now+2,tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',identity:{database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:123,server_address:'192.0.2.1',database_time:'2026-11-14 03:30:00+00'},snapshot:snapshot(),authRows:authRows()});
const target=()=>({snapshot:snapshot(),authRows:authRows(),window:{startedUtc:'2026-11-14T03:30:00.003Z',finishedUtc:'2026-11-14T03:30:00.004Z'}});
function encrypted(value=source(),secret=token){
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(secret,'ascii'),Buffer.from(sha(secret),'utf8'),Buffer.from(PROTOCOL,'utf8'),32)),nonce=Buffer.alloc(12,17),c=createCipheriv('aes-256-gcm',key,nonce);
 const cipher=Buffer.concat([c.update(Buffer.from(JSON.stringify(value))),c.final(),c.getAuthTag()]);return {protocol:PROTOCOL,nonce:nonce.toString('base64'),ciphertext:cipher.toString('base64')};
}
function client({status=200,body=encrypted(),raw,stall=false,error=false}={}){
 const calls=[],resources=[];const request=(options,callback)=>{const req=new EventEmitter(),res=new EventEmitter();calls.push({options});req.destroyed=res.destroyed=false;req.destroy=()=>{req.destroyed=true;};res.destroy=()=>{res.destroyed=true;};res.statusCode=status;resources.push({req,res});
  req.end=(value,encoding)=>{calls.at(-1).body=value;calls.at(-1).encoding=encoding;queueMicrotask(()=>{if(error){req.emit('error',new Error('SECRET_ERROR'));return;}if(stall)return;callback(res);if(res.destroyed)return;res.emit('data',Buffer.from(raw??JSON.stringify(body)));if(!res.destroyed)res.emit('end');});};return req;};return {request,calls,resources};
}
test('manifest pins self, four private modules, installed verified modules and exact prior digest',()=>{
 const m=manifest(),raw=Buffer.from(JSON.stringify(m));assert.equal(validateManifest(raw,sha(raw),'b'.repeat(64)).task,'T37');
 assert.throws(()=>validateManifest(raw,'a'.repeat(64),'b'.repeat(64)),{code:'T37_MANIFEST_SHA'});
 for(const patch of [{task:'T36'},{execution_authorized:false},{approval:{status:'PENDING',document_sha256:scope}},{approval:{status:'APPROVED',document_sha256:'0'.repeat(64)}},{source:{}},{transfer_budget:{}},{files:{}},{runtime_files:{}},{verify_only:{}},{input_evidence:{}}]){const r=Buffer.from(JSON.stringify({...m,...patch}));assert.throws(()=>validateManifest(r,sha(r),'b'.repeat(64)));}
 const p=Buffer.from(JSON.stringify(prior()));validatePrior(p,sha(p));assert.throws(()=>validatePrior(p,'b'.repeat(64)),{code:'T37_PRIOR_SHA'});
 for(const patch of [{status:'BLOCKED'},{sourceDataRead:true},{macDataTransit:true},{wrongCapabilityRejected:false}]){const r=Buffer.from(JSON.stringify({...prior(),...patch}));assert.throws(()=>validatePrior(r,sha(r)),{code:'T37_PRIOR_EVIDENCE'});}
});
test('fresh T37 capability binds approved scope, current manifest, derived function and exact2h expiry',()=>{
 validateCapability(token,prepared(),now,manifestSha);for(const p of [{...prepared(),expiresUtc:'2026-11-14T05:19:57.052Z'},{...prepared(),task:'T36'},{...prepared(),manifestSha256:'0'.repeat(64)},{...prepared(),ownerGrantSha256:'0'.repeat(64)},{...prepared(),createdUtc:'2026-11-14T06:11:00.000Z'},{...prepared(),functionName:'other'},{...prepared(),origin:'https://example.com'},{...prepared(),protocol:'other'}])assert.throws(()=>validateCapability(token,p,now,manifestSha),{code:'T37_CAPABILITY_OR_EXPIRY'});
 assert.throws(()=>validateCapability(token,prepared(),expiry-139999,manifestSha));assert.throws(()=>validateCapability(token+'\n',prepared(),now,manifestSha));
});
test('private guard writes are exclusive0600 and refuse replacements or symlinks',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t37-guard-'));try{const file=path.join(dir,'guard');exclusiveWrite(file,'fixed');assert.equal(fs.statSync(file).mode&0o777,0o600);assert.throws(()=>exclusiveWrite(file,'other'),{code:'EEXIST'});assert.equal(fs.readFileSync(file,'utf8'),'fixed');fs.symlinkSync(file,path.join(dir,'link'));assert.throws(()=>exclusiveWrite(path.join(dir,'link'),'other'),{code:'EEXIST'});}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('one fixed POST uses canonical HTTPS/SNI, raw64body and no key headers or redirects',async()=>{
 const f=client(),r=await requestSource(token,prepared(),f);assert.equal(r.statusCode,200);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].options,{protocol:'https:',hostname:ref+'.supabase.co',port:443,servername:ref+'.supabase.co',rejectUnauthorized:true,agent:false,method:'POST',path:'/functions/v1/'+prepared().functionName,headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}});assert.equal(f.calls[0].body,token);assert.equal(f.calls[0].encoding,'ascii');assert.ok(f.resources.every(x=>x.req.destroyed&&x.res.destroyed));
 const g=client({status:302,raw:'SECRET_BODY'}),q=await requestSource(token,prepared(),g);assert.equal(q.code,'T37_REDIRECT_REJECTED');assert.equal(q.bytes,0);assert.equal(g.calls.length,1);assert.doesNotMatch(JSON.stringify(q),/SECRET/);
});
test('HTTPS bounds/error/abort expose no bodies or exception messages and never retry',async()=>{
 for(const [f,options,code]of [[client({status:401,raw:'SECRET'}),{},'T37_HTTP_STATUS'],[client({raw:'SECRET'}),{},'T37_JSON_INVALID'],[client({raw:'x'.repeat(2097153)}),{},'T37_BODY_LIMIT'],[client({stall:true}),{timeoutMs:5},'T37_HTTPS_TIMEOUT'],[client({error:true}),{},'T37_HTTPS_FAILURE']]){const r=await requestSource(token,prepared(),{...f,...options});assert.equal(r.code,code);assert.equal(f.calls.length,1);assert.doesNotMatch(JSON.stringify(r),/SECRET/);assert.ok(f.resources.every(x=>x.req.destroyed));}
 const f=client({stall:true}),controller=new AbortController(),p=requestSource(token,prepared(),{...f,signal:controller.signal});controller.abort();assert.equal((await p).code,'T37_WALL_DEADLINE');assert.equal(f.calls.length,1);
 for(const options of [{maxBody:2097153},{timeoutMs:100001},{timeoutMs:NaN}])assert.throws(()=>requestSource(token,prepared(),options),{code:'T37_REQUEST_SCOPE'});
});
test('HKDF-GCM decrypts only matching secret/protocol, canonical base64, nonce12 and valid tag',()=>{
 assert.deepEqual(decryptEnvelope(encrypted(),token,sha(token)),source());
 const bad=encrypted(),bytes=Buffer.from(bad.ciphertext,'base64');bytes[0]^=1;bad.ciphertext=bytes.toString('base64');assert.throws(()=>decryptEnvelope(bad,token,sha(token)),{code:'T37_DECRYPT_FAILED'});
 for(const v of [{...encrypted(),protocol:'other'},{...encrypted(),extra:'SECRET'},{...encrypted(),nonce:Buffer.alloc(13).toString('base64')},{...encrypted(),ciphertext:'!!!!'},{...encrypted(),ciphertext:Buffer.alloc(1048593).toString('base64')}])assert.throws(()=>decryptEnvelope(v,token,sha(token)));
 assert.throws(()=>decryptEnvelope(encrypted(),'b'.repeat(64),sha('b'.repeat(64))),{code:'T37_DECRYPT_FAILED'});
});
test('source requires all15schema groups and all requireddata plus strict timing/TLS/RO/auth cohort',()=>{
 validateSource(source(),prepared(),now,now+3);const s=snapshot();delete s['schema:relations'];assert.throws(()=>validateSnapshot(s),{code:'T37_SNAPSHOT_GROUPS_MISSING'});
 for(const patch of [{projectRef:'other'},{expires_epoch_ms:expiry+1},{finished_epoch_ms:now+90001},{tls_negative_rejected:false},{tls_verification:'insecure'}])assert.throws(()=>validateSource({...source(),...patch},prepared(),now,now+3),{code:'T37_SOURCE_INVARIANT'});
 for(const patch of [{role:'anon'},{owner:'other'},{session_role:'anon'},{isolation:'read committed'},{read_only:'off'},{statement_timeout:'0'},{server_address:'192.0.2.1/32'}])assert.throws(()=>validateSource({...source(),identity:{...source().identity,...patch}},prepared(),now,now+3),{code:'T37_SOURCE_INVARIANT'});
 for(const rows of [authRows().slice(1),[...authRows(),authRows()[0]],authRows().map(r=>({...r,private_other:'SECRET'}))])assert.throws(()=>validateAuthRows(rows));
 for(const patch of [{hash:'SECRET'},{count:25001}]){const s=snapshot();Object.assign(s['data:public.partner'],patch);assert.throws(()=>validateSnapshot(s),{code:'T37_FINGERPRINT_INVALID'});}
 const seq=snapshot();seq['sequence:app_private.fixture_seq'].last_value=9007199254740993;assert.throws(()=>validateSnapshot(seq),{code:'T37_SEQUENCE_INVALID'});
});
test('target identity requires realreadonly/session/loopbackdestination isolation cronoff/net0',()=>{
 const i={database:'postgres',role:'supabase_admin',session_role:'supabase_admin',read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',server_port:5432,server_address:'172.18.0.3',cron:'off',net:'0'};verifyTargetIdentity(i,['172.18.0.3']);
 for(const patch of [{role:'postgres'},{session_role:'other'},{read_only:'off'},{isolation:'read committed'},{server_address:'172.18.0.4'},{server_port:15433},{cron:'on'},{net:'1'},{statement_timeout:'0'},{idle_timeout:'0'}])assert.throws(()=>verifyTargetIdentity({...i,...patch},['172.18.0.3']),{code:'T37_TARGET_IDENTITY'});
});
test('fullcompare reports true strictmatch, timestamp-only eligibility, and arbitraryothergroup mismatch without privatevalues',()=>{
 const dependencies={compareSnapshots,authRowsPlan};let r=compareInventory(source(),target(),dependencies);assert.equal(r.status,'STRICT_MATCH');assert.equal(r.source.schemaGroups,15);assert.equal(r.source.tables,10);assert.equal(r.source.rows,32);
 const a=source();a.snapshot['data:auth.users'].hash='c'.repeat(64);a.authRows[0].private_micros='1794571200000002';a.authRows[0].private_stamp='2026-11-13 12:00:00.000002+00';r=compareInventory(a,target(),dependencies);assert.equal(r.status,'LIVE_AUTH_TIMESTAMP_ONLY');assert.equal(r.authPlan.sourceNewerRows,1);assert.deepEqual(r.authPlan.columns,[{name:'updated_at',rows:1}]);assert.equal(r.finalFreezeAudit,false);assert.equal(r.applyAuthorized,false);assert.equal(r.macDataTransit,false);assert.doesNotMatch(JSON.stringify(r),/private_|00000000-0000|cccccccc|dddddddd|12:00:00/);
 a.snapshot['schema:policies'].hash='b'.repeat(64);assert.equal(compareInventory(a,target(),dependencies).status,'LIVE_MISMATCH');
 const t=target();t.snapshot['sequence:app_private.fixture_seq'].is_called=true;assert.equal(compareInventory(source(),t,dependencies).status,'LIVE_MISMATCH');
 const drift=source();drift.authRows[0].private_micros='1794571200000002';drift.authRows[0].private_stamp='2026-11-13 12:00:00.000002+00';assert.throws(()=>compareInventory(drift,target(),dependencies),{code:'T37_SNAPSHOT_AUTH_DRIFT'});
});
test('guard precedes exactlyoneactualrequest; blockedsource never reads target, valid source marksread before targetfailure',async()=>{
 let guards=0,calls=0,targets=0,reads=0;const dependencies={token,prepared:prepared(),manifestSha256:manifestSha,consumeTransferBudget:()=>({attempt:1,remaining:2}),guard:()=>guards++,now:()=>now+3,compareSnapshots,authRowsPlan,captureTarget:async()=>{targets++;return target();},decrypt:v=>v,onSourceRead:()=>reads++};
 const r=await runInventory({...dependencies,send:async()=>{calls++;return {statusCode:200,bytes:1234,elapsedMs:3,value:source()};}});assert.equal(r.status,'STRICT_MATCH');assert.equal(r.sourceReadAttempted,true);assert.equal(guards,1);assert.equal(calls,1);assert.equal(targets,1);assert.equal(reads,1);
 targets=0;await assert.rejects(runInventory({...dependencies,send:async()=>{calls++;return {statusCode:502,code:'T37_HTTP_STATUS'};}}),{code:'T37_HTTP_STATUS'});assert.equal(targets,0);
 reads=0;await assert.rejects(runInventory({...dependencies,captureTarget:async()=>{assert.equal(reads,1);throw Object.assign(new Error('SECRET'),{code:'T37_TARGET_IDENTITY'});},send:async()=>({statusCode:200,value:source()})}),{code:'T37_TARGET_IDENTITY'});assert.equal(reads,1);
});
test('import and noargsCLI do not read private files/network, and CLI failure contains no exceptionmessage',()=>{
 const helper=path.resolve('docs/runbooks/payloads/t37-https-inventory.mjs'),run=spawnSync(process.execPath,[helper],{encoding:'utf8',timeout:1000});assert.equal(run.status,2);assert.match(run.stdout,/T37_EXPLICIT_REVIEW_REQUIRED/);assert.equal(run.stderr,'');const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(helper)})`],{encoding:'utf8',timeout:1000});assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
});

test('error diagnostics preserve only finite protocolmatchedstage/code with4KiB limit',async()=>{
 const f=client({status:502,body:{protocol:PROTOCOL,stage:'snapshot',code:'READER_FAILED',message:'SECRET',authRows:[authRows()[0]]}}),r=await requestSource(token,prepared(),f);assert.equal(r.code,'T37_HTTP_STATUS');assert.equal(r.remoteStage,'snapshot');assert.equal(r.remoteCode,'READER_FAILED');assert.equal('value' in r,false);assert.doesNotMatch(JSON.stringify(r),/SECRET|private_|00000000/);
 for(const body of [{protocol:'other',stage:'snapshot',code:'READER_FAILED'},{protocol:PROTOCOL,stage:'SECRET',code:'SECRET'}]){const r=await requestSource(token,prepared(),client({status:502,body}));assert.equal('remoteStage' in r,false);assert.equal('remoteCode' in r,false);}
 const large=await requestSource(token,prepared(),client({status:502,raw:'x'.repeat(4097)}));assert.equal(large.code,'T37_BODY_LIMIT');
 await assert.rejects(runInventory({token,prepared:prepared(),manifestSha256:manifestSha,consumeTransferBudget:()=>({attempt:1,remaining:2}),now:()=>now+3,guard:()=>{},send:async()=>r,captureTarget:async()=>assert.fail('target'),compareSnapshots,authRowsPlan}),e=>e.code==='T37_HTTP_STATUS'&&e.safeReply.remoteStage==='snapshot'&&!/SECRET/.test(JSON.stringify(e.safeReply)));
});
test('target password URL roundtrip preserves percent escapes and allspecialcharacters',()=>{
 for(const password of ['abc%41','abc%','a:b/@? #é']){const r=targetConfig({Name:'/supabase-db',State:{Running:true},Config:{Env:['POSTGRES_USER=supabase_admin','POSTGRES_DB=postgres','POSTGRES_PASSWORD='+password,'PGPASSWORD='+password]},NetworkSettings:{Networks:{test:{IPAddress:'172.18.0.3'}}}});assert.equal(decodeURIComponent(new URL(r.url).password),password);assert.equal(new URL(r.url).hostname,'127.0.0.1');assert.equal(new URL(r.url).port,'15433');}
});

test('alreadyaborted totalbudget never consumes guard or starts later targetcapture',async()=>{
 const controller=new AbortController();controller.abort();let guards=0,calls=0,targets=0;
 await assert.rejects(runInventory({token,prepared:prepared(),manifestSha256:manifestSha,consumeTransferBudget:()=>({attempt:1,remaining:2}),signal:controller.signal,guard:()=>guards++,send:async()=>{calls++;},captureTarget:async()=>targets++}),{code:'T37_WALL_DEADLINE'});assert.equal(guards,0);assert.equal(calls,0);
 const c=new AbortController();let reads=0;await assert.rejects(runInventory({token,prepared:prepared(),manifestSha256:manifestSha,consumeTransferBudget:()=>({attempt:1,remaining:2}),signal:c.signal,now:()=>now+3,guard:()=>{},send:async()=>({statusCode:200,value:source()}),decrypt:v=>v,onSourceRead:()=>{reads++;c.abort();},captureTarget:async()=>targets++}),{code:'T37_WALL_DEADLINE'});assert.equal(reads,1);assert.equal(targets,0);
});

test('immutable budget claim precedes actual Source POST and uncertainty is never retried',async()=>{
 const order=[];let claims=0,posts=0,targets=0;
 const base={token,prepared:prepared(),manifestSha256:manifestSha,now:()=>now+3,compareSnapshots,authRowsPlan,decrypt:v=>v,
  guard:()=>order.push('guard'),consumeTransferBudget:()=>{claims++;order.push('claim');return {attempt:1,remaining:2};},
  onBudgetConsumed:()=>order.push('claim-receipt'),onSourceAttempt:()=>order.push('attempt'),
  captureTarget:async()=>{targets++;order.push('target');return target();}};
 const result=await runInventory({...base,send:async(t,p)=>{assert.equal(t,token);assert.deepEqual(p,prepared());posts++;order.push('post');return {statusCode:200,value:source()};}});
 assert.deepEqual(order,['guard','claim','claim-receipt','attempt','post','target']);assert.equal(result.transferBudget.attempt,1);assert.equal(claims,1);assert.equal(posts,1);
 order.length=0;await assert.rejects(runInventory({...base,send:async()=>{posts++;throw new Error('SECRET_UNCERTAIN_NETWORK');}}),/SECRET_UNCERTAIN_NETWORK/);
 assert.equal(claims,2);assert.equal(posts,2);assert.equal(targets,1);assert.deepEqual(order,['guard','claim','claim-receipt','attempt']);
 order.length=0;await assert.rejects(runInventory({...base,consumeTransferBudget:()=>{order.push('claim-blocked');throw Object.assign(new Error('SOURCE_TRANSFER_LEDGER_UNCERTAIN'),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});},send:async()=>assert.fail('no POST after rejected claim')}),{code:'SOURCE_TRANSFER_LEDGER_UNCERTAIN'});
 assert.deepEqual(order,['guard','claim-blocked']);assert.equal(posts,2);
 const abort=new AbortController();await assert.rejects(runInventory({...base,signal:abort.signal,consumeTransferBudget:()=>{claims++;abort.abort();return {attempt:1,remaining:2};},send:async()=>assert.fail('aborted before POST')}),{code:'T37_WALL_DEADLINE'});assert.equal(claims,3);assert.equal(posts,2);
 await assert.rejects(runInventory({...base,consumeTransferBudget:undefined,send:async()=>assert.fail('claim callback required')}),{code:'T37_TRANSFER_BUDGET_REQUIRED'});
});

test('fresh prepared context drives both endpoint and envelope; stale T36 bindings fail closed',async()=>{
 const secret='b'.repeat(64),fresh={...prepared(),capabilitySha256:sha(secret),functionName:'bron-source-reader-'+sha(secret).slice(0,12)};
 validateCapability(secret,fresh,now,manifestSha);const f=client({body:encrypted(source(),secret)}),reply=await requestSource(secret,fresh,f);
 assert.equal(f.calls[0].options.path,'/functions/v1/'+fresh.functionName);assert.deepEqual(decryptEnvelope(reply.value,secret,fresh.capabilitySha256),source());
 assert.throws(()=>decryptEnvelope(reply.value,secret,prepared().capabilitySha256),{code:'T37_ENVELOPE_INVALID'});
 assert.throws(()=>requestSource(secret,prepared(),{}),{code:'T37_REQUEST_SCOPE'});
 assert.throws(()=>validateCapability(secret,{...fresh,expiresUtc:'2026-11-14T05:19:57.052Z'},now,manifestSha),{code:'T37_CAPABILITY_OR_EXPIRY'});
 const raw=Buffer.from(JSON.stringify({...manifest(),approval:{status:'APPROVED',document_sha256:'0'.repeat(64)}}));assert.throws(()=>validateManifest(raw,sha(raw),'b'.repeat(64)),{code:'T37_OWNER_APPROVAL'});
});
