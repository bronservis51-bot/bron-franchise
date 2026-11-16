import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createCipheriv,hkdfSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {createFinalHttpsTransportFixture} from '../../docs/runbooks/payloads/final-https-transport.mjs';
import {requestSource,PROTOCOL} from '../../docs/runbooks/payloads/t37-https-inventory.mjs';
import {SOURCE_TRANSFER_SCOPE_SHA256 as scope} from '../../docs/runbooks/payloads/source-transfer-budget.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex'),token='a'.repeat(64),capSha=sha(token),liveSha=sha('b'.repeat(64));
const now=Date.parse('2026-11-14T10:00:00.000Z'),project='vkkqffvmztpzgygzfxhq';
const directory='/root/bron-secrets/source-transfer-budget';
const privateUuid='00000000-0000-4000-8000-000000000001',privateStamp='2026-11-14 03:00:00.000001+00';
function context(){return {sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:'2'.repeat(64),
 before:{backends:[{pid:100}]},boundary:{capturedMicros:String(BigInt(now)*1000n-1000000n),ownerPids:[101]}};}
function config(){const c=context(),contextSha=sha(JSON.stringify(c)),manifestSha='3'.repeat(64);return {
 token,fenceContext:c,fenceContextSha256:contextSha,
 activation:{actionId:'T40.final_https_window',reviewed:true,manifestSha256:manifestSha,
  sourceBarrierActionId:c.sourceBarrierActionId,sourceBarrierReceiptSha256:c.sourceBarrierReceiptSha256,
  fenceContextSha256:contextSha,targetAdmitted:false,sourceRoute:'fixed-source-edge-https',targetRoute:'verified-loopback-15433',
  expectedAuthRows:16,sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,applyTimestampOnly:true,
  maxTimestampUpdates:16,beforeImagePath:'/root/bron-secrets/t40-auth-before-12345678.json',ownerDataGrantEvidenceSha256:scope},
 taskManifest:{task:'T40',execution_authorized:true,approval:{status:'APPROVED',document_sha256:scope},
  source:{origin:'https://'+project+'.supabase.co',projectRef:project,protocol:PROTOCOL,
   capability_binding:'pinned_VPS_prepare_readback',template_name_prefix:'bron-source-reader-'},
  transfer_budget:{directory,scope_sha256:scope,max_attempts:3,source_project:project,destination_vps:'152.228.115.115'}},
 prepared:{task:'T40',manifestSha256:manifestSha,ownerGrantSha256:scope,fenceContextSha256:contextSha,
  createdUtc:new Date(now-10000).toISOString(),expiresUtc:new Date(now-10000+7200000).toISOString(),
  capabilitySha256:capSha,functionName:'bron-source-reader-'+capSha.slice(0,12),origin:'https://'+project+'.supabase.co',protocol:PROTOCOL}};}
function snapshot(){return Object.fromEntries([
 ...['columns','relations','policies','storage_policies','storage_grants','triggers','extensions','constraints','indexes','routines','enums','schemas','default_grants','client_roles','role_memberships'].map(x=>['schema:'+x,{count:2,hash:'d'.repeat(64)}]),
 ...['auth.users','auth.identities','public.partner','public.location','public.role_assignment','public.daily_revenue','public.franchise_lead','public.article_revision','storage.buckets','storage.objects'].map(x=>['data:'+x,{count:x==='auth.users'?16:0,hash:'e'.repeat(64)}]),
 ['sequence:app_private.fixture_seq',{last_value:'9007199254740993',is_called:false}]]);}
function frame(f){const c=f.config.fenceContext,p=f.config.prepared;return {ok:true,protocol:PROTOCOL,projectRef:project,
 started_epoch_ms:f.clock-10,finished_epoch_ms:f.clock,expires_epoch_ms:Date.parse(p.expiresUtc),
 tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',identity:{database:'postgres',role:'postgres',session_role:'postgres',
  owner:'postgres',read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:200,
  server_address:'192.0.2.1',database_time:'2026-11-14 10:00:00+00'},snapshot:snapshot(),
 authRows:Array.from({length:16},(_,i)=>({private_id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
  private_stamp:privateStamp,private_micros:'1794625200000001',private_other:'f'.repeat(64)})),
 fenceWitness:{db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',
  pid:200,backendStartMicros:String(BigInt(c.boundary.capturedMicros)+10000n),preDataValidated:true,
  sourceBarrierActionId:c.sourceBarrierActionId,sourceBarrierReceiptSha256:c.sourceBarrierReceiptSha256}};}
function encrypted(value,secret=token){
 const hash=sha(secret),key=Buffer.from(hkdfSync('sha256',Buffer.from(secret,'ascii'),Buffer.from(hash,'utf8'),Buffer.from(PROTOCOL,'utf8'),32));
 const nonce=Buffer.alloc(12,17),cipher=createCipheriv('aes-256-gcm',key,nonce);
 return {protocol:PROTOCOL,nonce:nonce.toString('base64'),ciphertext:Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString('base64')};
}
function fixture(options={}){
 const f={config:config(),clock:now,events:[],posts:0,claimCalls:0,receipts:[],ledger:[{attempt:1,status:'VALID',actionId:'T37.live',capabilitySha256:liveSha}]};
 f.config.onBudgetClaim=receipt=>{f.events.push('receipt');f.receipts.push(receipt);if(options.receipt)return options.receipt(receipt,f);};
 options.configure?.(f.config,f);
 f.status=()=>({used:f.ledger.length,remaining:3-f.ledger.length,maxAttempts:3,uncertain:false,claims:structuredClone(f.ledger)});
 f.runtime={now:()=>f.clock,status:async()=>{f.events.push('status');return options.status?options.status(f):f.status();},
  claim:async binding=>{f.events.push('claim');f.claimCalls++;if(options.claim)return options.claim(binding,f);
   const attempt=f.ledger.length+1;f.ledger.push({attempt,status:'VALID',actionId:binding.actionId,capabilitySha256:binding.capabilitySha256});
   return {attempt,remaining:3-attempt,claimPath:directory+'/attempt-'+attempt+'.json',claimSha256:'4'.repeat(64)};},
  send:async(t,p,o)=>{f.events.push('post');f.posts++;f.clock+=100;if(options.send)return options.send(t,p,o,f);
   const value=frame(f);options.frame?.(value,f);return {statusCode:200,bytes:1500,elapsedMs:10,value:encrypted(value)};}};
 f.create=()=>createFinalHttpsTransportFixture(f.config,f.runtime);return f;
}
const code=async(p,expected)=>assert.rejects(p,{code:expected});
const safe=error=>{assert.doesNotMatch(error.message+' '+JSON.stringify(error),new RegExp([privateUuid,privateStamp,'1794625200000001','PRIVATE_ERROR',token,'f'.repeat(64)].join('|')));return true;};

test('import and noargs CLI are inert; production factory has no injectable runtime',()=>{
 const file=path.resolve('docs/runbooks/payloads/final-https-transport.mjs');
 const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:1500});
 assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
 const cli=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:1500});assert.equal(cli.status,2);assert.equal(cli.stdout,'');
 assert.equal(cli.stderr.trim(),'FINAL_HTTPS_TRANSPORT_DRAFT_NOT_ACTIVATED');
});
test('two fresh encrypted frames consume durable slots2/3 in order and return detached private payloads',async()=>{
 const f=fixture(),t=await f.create();f.events=[];const before=await t.captureSourceFrame('before');
 assert.deepEqual(f.events,['status','claim','receipt','post']);assert.equal(f.receipts[0].attempt,2);assert.equal(f.receipts[0].actionId,'T40.final_before');
 before.identity.role='changed';before.authRows[0].private_other='changed';const after=await t.captureSourceFrame('after');
 assert.equal(after.identity.role,'postgres');assert.equal(after.authRows[0].private_other,'f'.repeat(64));assert.equal(after.fenceWitness.preDataValidated,true);
 assert.equal(f.posts,2);assert.equal(f.claimCalls,2);assert.equal(f.ledger.length,3);assert.equal(f.receipts[1].actionId,'T40.final_after');
 await code(t.captureSourceFrame('after'),'FINAL_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(f.posts,2);
 assert.equal(Object.keys(f.receipts[0]).sort().join(','),'actionId,attempt,claimPath,claimSha256,remaining,stage');
});
test('activation, immutable context, final prepared and scope mismatches fail before status/claim/POST',async()=>{
 const edits=[c=>c.activation.reviewed=false,c=>c.activation.applyTimestampOnly=false,c=>c.activation.priorSourceAuthSnapshotAttempts=0,
  c=>c.activation.sourceFrameBudget=3,c=>c.activation.ownerDataGrantEvidenceSha256='0'.repeat(64),c=>c.taskManifest.execution_authorized=false,
  c=>c.taskManifest.task='T41',c=>c.taskManifest.approval.document_sha256='0'.repeat(64),c=>c.taskManifest.source.origin='https://other.invalid',
  c=>c.taskManifest.transfer_budget.max_attempts=4,c=>c.ledgerBinding={directory:'/tmp/reset'},c=>c.fenceContext.boundary.capturedMicros='bad',
  c=>c.fenceContext.before.backends[0].pid=102,c=>c.prepared.task='T37',c=>c.prepared.manifestSha256='0'.repeat(64),
  c=>c.prepared.ownerGrantSha256='0'.repeat(64),c=>c.prepared.fenceContextSha256='0'.repeat(64),c=>c.prepared.functionName='other',
  c=>c.prepared.expiresUtc=new Date(now+10000).toISOString(),c=>c.token+='\n'];
 for(const edit of edits){const f=fixture({configure:edit});await assert.rejects(f.create(),safe);assert.deepEqual(f.events,[]);assert.equal(f.posts,0);}
});
test('spent, uncertain, incorrect phase or same-capability live ledger cannot create/reset final transport',async()=>{
 for(const edit of [s=>s.uncertain=true,s=>{s.used=0;s.remaining=3;s.claims=[];},s=>{s.used=3;s.remaining=0;},
  s=>s.claims[0].status='UNCERTAIN',s=>s.claims[0].actionId='T39.live',s=>s.claims[0].capabilitySha256=capSha]){
  const f=fixture({status:f=>{const s=f.status();edit(s);return s;}});await code(f.create(),'FINAL_HTTPS_TRANSPORT_LEDGER_NOT_READY');assert.equal(f.posts+f.claimCalls,0);
 }
 const f=fixture(),t=await f.create();await t.captureSourceFrame('before');f.ledger[1].actionId='T41.final_before';
 await code(t.captureSourceFrame('after'),'FINAL_HTTPS_TRANSPORT_LEDGER_NOT_READY');assert.equal(f.posts,1);assert.equal(f.claimCalls,1);
});
test('out-of-order, concurrent and repeated phase never starts an additional Source request',async()=>{
 const f=fixture(),t=await f.create();await code(t.captureSourceFrame('after'),'FINAL_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(f.claimCalls,0);
 const pending=t.captureSourceFrame('before');await code(t.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_STAGE_INVALID');await pending;
 await code(t.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(f.posts,1);assert.equal(f.claimCalls,1);
});
test('aborted before claim spends nothing; abort after durable claim spends slot and permanently blocks retry',async()=>{
 const initial=new AbortController();initial.abort();const f=fixture({configure:c=>c.signal=initial.signal}),t=await f.create();
 await code(t.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_ABORTED');assert.equal(f.claimCalls+f.posts,0);
 const c=new AbortController(),g=fixture({configure:x=>x.signal=c.signal,receipt:()=>c.abort()}),u=await g.create();
 await code(u.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_ABORTED');assert.equal(g.ledger.length,2);assert.equal(g.posts,0);
 await code(u.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(g.claimCalls,1);
});
test('claim failure or invalid durable receipt blocks POST without refund; receipt callback failure also burns slot',async()=>{
 const f=fixture({claim:()=>{throw Object.assign(new Error('PRIVATE_ERROR '+privateUuid),{code:'SOURCE_TRANSFER_CLAIM_CONFLICT'});}}),t=await f.create();
 await assert.rejects(t.captureSourceFrame('before'),e=>{safe(e);assert.equal(e.code,'FINAL_HTTPS_TRANSPORT_BUDGET_CLAIM_FAILED');assert.equal(e.upstreamCode,'SOURCE_TRANSFER_CLAIM_CONFLICT');return true;});assert.equal(f.posts,0);
 for(const receipt of [{attempt:1,remaining:1,claimPath:directory+'/attempt-2.json',claimSha256:'4'.repeat(64)},
  {attempt:2,remaining:1,claimPath:'/tmp/'+privateUuid,claimSha256:'4'.repeat(64)},
  {attempt:2,remaining:1,claimPath:directory+'/attempt-2.json',claimSha256:'PRIVATE_ERROR'}]){
  const g=fixture({claim:()=>receipt}),u=await g.create();await code(u.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_CLAIM_NOT_PROVED');assert.equal(g.posts,0);
 }
 const g=fixture({receipt:()=>{throw new Error('PRIVATE_ERROR');}}),u=await g.create();await code(u.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_RECEIPT_CALLBACK_FAILED');assert.equal(g.ledger.length,2);assert.equal(g.posts,0);
 const h=fixture({receipt:(_r,f)=>{f.clock=Date.parse(f.config.prepared.expiresUtc)-139999;}}),v=await h.create();
 await code(v.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_CAPABILITY_INVALID');assert.equal(h.ledger.length,2);assert.equal(h.posts,0);
});
test('HTTP and unexpected request failures are redacted, spend one slot and cannot be retried',async()=>{
 for(const response of [{statusCode:302,code:'T37_REDIRECT_REJECTED',value:{privateUuid}},
  {statusCode:502,code:'T37_HTTP_STATUS',message:'PRIVATE_ERROR'},null]){
  const f=fixture({send:()=>response}),t=await f.create();await assert.rejects(t.captureSourceFrame('before'),e=>{safe(e);assert.equal(e.code,'FINAL_HTTPS_TRANSPORT_SOURCE_RESPONSE_INVALID');if(response?.code)assert.equal(e.upstreamCode,response.code);return true;});
  await code(t.captureSourceFrame('before'),'FINAL_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(f.posts,1);assert.equal(f.ledger.length,2);
 }
 const f=fixture({send:()=>{throw new Error('PRIVATE_ERROR '+privateStamp);}}),t=await f.create();await assert.rejects(t.captureSourceFrame('before'),e=>{safe(e);return e.code==='FINAL_HTTPS_TRANSPORT_REQUEST_FAILED';});assert.equal(f.posts,1);
});
test('actual GCM authentication rejects tampering/wrong token/protocol before witness acceptance',async()=>{
 for(const alter of [v=>({...v,protocol:'other'}),v=>({...v,nonce:'!!!!'}),v=>{const b=Buffer.from(v.ciphertext,'base64');b[0]^=1;return {...v,ciphertext:b.toString('base64')};},
  (_v,f)=>encrypted(frame(f),'b'.repeat(64))]){
  const f=fixture({send:(_t,_p,_o,g)=>({statusCode:200,value:alter(encrypted(frame(g)),g)})}),t=await f.create();
  await assert.rejects(t.captureSourceFrame('before'),e=>{safe(e);return e.code==='FINAL_HTTPS_TRANSPORT_DECRYPT_FAILED';});assert.equal(f.posts,1);
 }
});
test('source metadata, TLS, timing, schema, sequence and Auth-cohort violations fail closed',async()=>{
 for(const edit of [v=>v.projectRef='other',v=>v.expires_epoch_ms++,v=>v.tls_negative_rejected=false,
  v=>v.identity.read_only='off',v=>v.identity.role='anon',v=>v.identity.isolation='read committed',
  v=>v.started_epoch_ms-=6000,v=>v.finished_epoch_ms=v.started_epoch_ms+90001,
  v=>delete v.snapshot['schema:relations'],v=>v.snapshot['sequence:app_private.fixture_seq'].last_value=9007199254740993,
  v=>v.authRows.pop(),v=>v.authRows[1].private_id=v.authRows[0].private_id,v=>v.snapshot['data:auth.users'].count=15]){
  const f=fixture({frame:edit}),t=await f.create();await assert.rejects(t.captureSourceFrame('before'),e=>{safe(e);return e.code==='FINAL_HTTPS_TRANSPORT_SOURCE_FRAME_INVALID';});assert.equal(f.posts,1);
 }
});
test('actual incoming pre-data attestation and fresh matching physical backend are mandatory',async()=>{
 for(const edit of [v=>delete v.fenceWitness,v=>delete v.fenceWitness.preDataValidated,v=>v.fenceWitness.preDataValidated=false,
  v=>v.fenceWitness.sourceBarrierActionId='T41.http_source_admission',v=>v.fenceWitness.sourceBarrierReceiptSha256='0'.repeat(64),
  v=>v.fenceWitness.pid=100,v=>v.fenceWitness.pid=201,v=>v.fenceWitness.backendStartMicros=context().boundary.capturedMicros,
  v=>v.fenceWitness.readOnly='off',v=>v.fenceWitness.isolation='read committed',
  v=>v.extra='PRIVATE_ERROR',v=>v.identity.extra='PRIVATE_ERROR',v=>v.fenceWitness.extra='PRIVATE_ERROR']){
  const f=fixture({frame:edit}),t=await f.create();await assert.rejects(t.captureSourceFrame('before'),e=>{safe(e);return e.code==='FINAL_HTTPS_TRANSPORT_FENCE_WITNESS_INVALID';});assert.equal(f.posts,1);
 }
});
test('replayed response and mutated caller config cannot change pinned execution binding',async()=>{
 let original;const f=fixture({send:(_t,_p,_o,g)=>{original??=frame(g);return {statusCode:200,value:encrypted(original)};}}),t=await f.create();
 await t.captureSourceFrame('before');await code(t.captureSourceFrame('after'),'FINAL_HTTPS_TRANSPORT_FRAME_REPLAYED');assert.equal(f.ledger.length,3);
 const g=fixture(),u=await g.create();g.config.prepared.functionName='PRIVATE_ERROR';g.config.activation.actionId='T41.final_https_window';
 g.config.fenceContext.before.backends[0].pid=200;await u.captureSourceFrame('before');assert.equal(g.receipts[0].actionId,'T40.final_before');
 const h=fixture(),pending=h.create();h.config.fenceContext.before.backends[0].pid=200;
 const v=await pending;await v.captureSourceFrame('before');assert.equal(h.posts,1);
});
test('actual requestSource uses canonical HTTPS/SNI POST and rejects redirect, oversize and invalid JSON without retry',async()=>{
 for(const mode of ['ok','redirect','oversize','invalid']){
  const requests=[];const f=fixture({send:async(t,p,o,g)=>requestSource(t,p,{...o,request:(options,callback)=>{
   const req=new EventEmitter(),res=new EventEmitter();requests.push({options});req.destroy=()=>{};res.destroy=()=>{res.destroyed=true;};
   req.end=(body,encoding)=>{requests.at(-1).body=body;requests.at(-1).encoding=encoding;queueMicrotask(()=>{
    res.statusCode=mode==='redirect'?302:200;callback(res);if(res.destroyed)return;
    res.emit('data',Buffer.from(mode==='oversize'?'x'.repeat(2097153):mode==='invalid'?'PRIVATE_ERROR':JSON.stringify(encrypted(frame(g)))));
    if(!res.destroyed)res.emit('end');});};return req;}})}),t=await f.create();
  if(mode==='ok')await t.captureSourceFrame('before');else await assert.rejects(t.captureSourceFrame('before'),safe);
  assert.equal(requests.length,1);assert.deepEqual(requests[0],{options:{protocol:'https:',hostname:project+'.supabase.co',port:443,
   servername:project+'.supabase.co',rejectUnauthorized:true,agent:false,method:'POST',path:'/functions/v1/'+f.config.prepared.functionName,
   headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}},body:token,encoding:'ascii'});
  assert.equal(f.ledger.length,2);assert.equal(f.posts,1);
 }
});
