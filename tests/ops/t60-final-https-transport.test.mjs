import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createCipheriv,hkdfSync} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {createFinalHttpsTransportFixture} from '../../docs/runbooks/payloads/t60-final-https-transport.mjs';
import {requestSource,PROTOCOL} from '../../docs/runbooks/payloads/t37-https-inventory.mjs';
const scope='c'.repeat(64);

const sha=x=>createHash('sha256').update(x).digest('hex'),token='a'.repeat(64),capSha=sha(token),liveSha=sha('b'.repeat(64));
const now=Date.parse('2026-11-14T10:00:00.000Z'),project='vkkqffvmztpzgygzfxhq';
const directory='/root/bron-secrets/source-auth-final-e60a2026';
const privateUuid='00000000-0000-4000-8000-000000000001',privateStamp='2026-11-14 03:00:00.000001+00';
function context(){return {sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:'2'.repeat(64),
 before:{backends:[{pid:100}]},boundary:{capturedMicros:String(BigInt(now)*1000n-1000000n),ownerPids:[101]}};}
function config(){const c=context(),contextSha=sha(JSON.stringify(c)),manifestSha='3'.repeat(64);return {
 token,fenceContext:c,fenceContextSha256:contextSha,
 activation:{actionId:'T60.final_https_window',reviewed:true,manifestSha256:manifestSha,
  sourceBarrierActionId:c.sourceBarrierActionId,sourceBarrierReceiptSha256:c.sourceBarrierReceiptSha256,
  fenceContextSha256:contextSha,targetAdmitted:false,sourceRoute:'fixed-source-edge-https',targetRoute:'verified-loopback-15433',
  expectedAuthRows:16,sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:4,applyAuthTimestampsOnly:true,sourceAuthoritativeAuthTimestamps:true,authTimestampColumns:['last_sign_in_at','updated_at'],
  maxAuthTimestampRows:2,beforeImagePath:'/root/bron-secrets/t40-auth-before-12345678.json',ownerDataGrantEvidenceSha256:scope},
 taskManifest:{task:'T60',execution_authorized:true,approval:{status:'APPROVED',document_sha256:scope,maxAuthSnapshots:6,priorUsed:4,lastSignInAtValue:true,updatedAtValue:true,targetTimestampReconciliation:true},
  source:{origin:'https://'+project+'.supabase.co',projectRef:project,protocol:PROTOCOL,
   capability_binding:'pinned_VPS_prepare_readback',template_name_prefix:'bron-source-reader-'},
  transfer_budget:{directory,scope_sha256:scope,max_attempts:6,prior_used:4,source_project:project,destination_vps:'152.228.115.115'}},
 prepared:{task:'T60',manifestSha256:manifestSha,ownerGrantSha256:scope,fenceContextSha256:contextSha,
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
  private_stamp:privateStamp,private_micros:'1794625200000001',private_sign_in_stamp:privateStamp,private_sign_in_micros:'1794625200000001',private_other:'f'.repeat(64)})),
 fenceWitness:{db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',
  pid:200,backendStartMicros:String(BigInt(c.boundary.capturedMicros)+10000n),preDataValidated:true,
  sourceBarrierActionId:c.sourceBarrierActionId,sourceBarrierReceiptSha256:c.sourceBarrierReceiptSha256}};}
function encrypted(value,secret=token){
 const hash=sha(secret),key=Buffer.from(hkdfSync('sha256',Buffer.from(secret,'ascii'),Buffer.from(hash,'utf8'),Buffer.from(PROTOCOL,'utf8'),32));
 const nonce=Buffer.alloc(12,17),cipher=createCipheriv('aes-256-gcm',key,nonce);
 return {protocol:PROTOCOL,nonce:nonce.toString('base64'),ciphertext:Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final(),cipher.getAuthTag()]).toString('base64')};
}
function fixture(options={}){
 const f={config:config(),clock:now,events:[],posts:0,claimCalls:0,receipts:[],ledger:[{attempt:1,status:'VALID',actionId:'T37.live',capabilitySha256:liveSha},{attempt:2,status:'VALID',actionId:'T56.final_before',capabilitySha256:sha('oldT56')},{attempt:3,status:'VALID',actionId:'T58.auth_diagnostic',capabilitySha256:sha('oldT58')},{attempt:4,status:'VALID',actionId:'T59.final_before',capabilitySha256:'6c6021ba66444f384593c98792a945b804afaadb156006b7269300e57f559b77'}]};
 f.config.onBudgetClaim=receipt=>{f.events.push('receipt');f.receipts.push(receipt);if(options.receipt)return options.receipt(receipt,f);};
 options.configure?.(f.config,f);
 f.status=()=>({used:f.ledger.length,remaining:6-f.ledger.length,maxAttempts:6,priorUsed:4,uncertain:false,claims:structuredClone(f.ledger)});
 f.runtime={now:()=>f.clock,status:async()=>{f.events.push('status');return options.status?options.status(f):f.status();},
  claim:async binding=>{f.events.push('claim');f.claimCalls++;if(options.claim)return options.claim(binding,f);
   const attempt=f.ledger.length+1;f.ledger.push({attempt,status:'VALID',actionId:binding.actionId,capabilitySha256:binding.capabilitySha256});
   return {attempt,remaining:6-attempt,claimPath:directory+'/attempt-'+attempt+'.json',claimSha256:'4'.repeat(64)};},
  send:async(t,p,o)=>{f.events.push('post');f.posts++;f.clock+=100;if(options.send)return options.send(t,p,o,f);
   const value=frame(f);options.frame?.(value,f);return {statusCode:200,bytes:1500,elapsedMs:10,value:encrypted(value)};}};
 f.create=()=>createFinalHttpsTransportFixture(f.config,f.runtime);return f;
}
const code=async(p,expected)=>assert.rejects(p,{code:expected});
const safe=error=>{assert.doesNotMatch(error.message+' '+JSON.stringify(error),new RegExp([privateUuid,privateStamp,'1794625200000001','PRIVATE_ERROR',token,'f'.repeat(64)].join('|')));return true;};

test('fresh encrypted frames consume only new slots5/6 and keep oldfour',async()=>{
 const f=fixture(),t=await f.create();const old=structuredClone(f.ledger);await t.captureSourceFrame('before');await t.captureSourceFrame('after');assert.equal(f.posts,2);assert.equal(f.claimCalls,2);assert.equal(f.ledger.length,6);assert.deepEqual(f.ledger.slice(0,4),old);assert.deepEqual(f.receipts.map(r=>[r.attempt,r.actionId]),[[5,'T60.final_before'],[6,'T60.final_after']]);await code(t.captureSourceFrame('after'),'T60_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(f.posts,2);
});
test('old max5/prior3 and incorrect T59 lineage rejected before a new Source POST',async()=>{
 for(const edit of [c=>c.activation.priorSourceAuthSnapshotAttempts=3,c=>c.taskManifest.approval.maxAuthSnapshots=5,c=>c.taskManifest.approval.priorUsed=3,c=>c.taskManifest.transfer_budget.max_attempts=5]){const f=fixture({configure:edit});await assert.rejects(f.create());assert.equal(f.posts+f.claimCalls,0);}
 for(const edit of [s=>s.claims[3].actionId='T60.final_before',s=>s.claims[3].capabilitySha256='b'.repeat(64),s=>s.uncertain=true]){const f=fixture({status:f=>{const s=f.status();edit(s);return s;}});await code(f.create(),'T60_HTTPS_TRANSPORT_LEDGER_NOT_READY');assert.equal(f.posts+f.claimCalls,0);}
});
test('claim failure preserves uncertainty and does not send; Source failures never retry',async()=>{
 const f=fixture({claim:()=>{throw Object.assign(new Error('PRIVATE_ERROR'),{code:'T60_BUDGET_CLAIM_WRITE_FAILED',claimMayBeConsumed:true});}}),t=await f.create();await assert.rejects(t.captureSourceFrame('before'),e=>{safe(e);assert.equal(e.budgetUncertain,true);assert.equal(e.claimMayBeConsumed,true);return true;});assert.equal(f.posts,0);await code(t.captureSourceFrame('before'),'T60_HTTPS_TRANSPORT_STAGE_INVALID');
 const g=fixture({send:()=>{throw new Error('PRIVATE_ERROR');}}),u=await g.create();await assert.rejects(u.captureSourceFrame('before'),safe);assert.equal(g.ledger.length,5);assert.equal(g.posts,1);await code(u.captureSourceFrame('before'),'T60_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(g.posts,1);
});
test('real encryption authentication and six-field Auth shape remain mandatory',async()=>{
 for(const edit of [v=>{delete v.authRows[0].private_sign_in_micros;},v=>v.identity.read_only='off',v=>v.fenceWitness.preDataValidated=false]){const f=fixture({frame:edit}),t=await f.create();await assert.rejects(t.captureSourceFrame('before'),safe);assert.equal(f.posts,1);}
 const f=fixture({send:(_t,_p,_o,g)=>({statusCode:200,value:encrypted(frame(g),'b'.repeat(64))})}),t=await f.create();await code(t.captureSourceFrame('before'),'T60_HTTPS_TRANSPORT_DECRYPT_FAILED');assert.equal(f.posts,1);
});
test('replay/outoforder/oldcap cannot silently reuse a consumed frame',async()=>{
 const f=fixture(),t=await f.create();await code(t.captureSourceFrame('after'),'T60_HTTPS_TRANSPORT_STAGE_INVALID');assert.equal(f.posts,0);const p=t.captureSourceFrame('before');await code(t.captureSourceFrame('before'),'T60_HTTPS_TRANSPORT_STAGE_INVALID');await p;
 const g=fixture({status:f=>({...f.status(),claims:f.status().claims.map((c,i)=>i===0?{...c,capabilitySha256:capSha}:c)})});await code(g.create(),'T60_HTTPS_TRANSPORT_LEDGER_NOT_READY');assert.equal(g.posts+g.claimCalls,0);
});
