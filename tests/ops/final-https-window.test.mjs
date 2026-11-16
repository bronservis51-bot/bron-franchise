import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {runFinalHttpsWindow} from '../../docs/runbooks/payloads/final-https-window.mjs';
import {targetMetadataSql} from '../../docs/runbooks/payloads/final-auth-window.mjs';
import {authRowsSql} from '../../docs/runbooks/payloads/t30-auth-compact.mjs';

const clone=structuredClone,sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const names=['columns','relations','policies','storage_policies','storage_grants','triggers','extensions',
 'constraints','indexes','routines','enums','schemas','default_grants','client_roles','role_memberships'];
const tables=['auth.users','auth.identities','public.partner','public.location','public.role_assignment',
 'public.daily_revenue','public.franchise_lead','public.article_revision','storage.buckets','storage.objects'];
const stamp='2026-11-13 12:00:00.000001+00',older='2026-11-13 12:00:00.000000+00';
const micros=s=>s===null?null:String(BigInt(Date.parse(s))*1000n+BigInt((s.match(/\.(\d+)/)?.[1]??'').padEnd(6,'0').slice(3,6)||'0'));
const rows=()=>Array.from({length:16},(_,n)=>({private_id:'00000000-0000-4000-8000-'+String(n+1).padStart(12,'0'),
 private_stamp:stamp,private_micros:micros(stamp),private_other:'d'.repeat(64)}));
function snapshotOf(auth,overrides={}){
 return {...Object.fromEntries([
  ...names.map(n=>['schema:'+n,{count:2,hash:'f'.repeat(64)}]),
  ...tables.map(n=>['data:'+n,{count:n.startsWith('auth.')?16:0,hash:n==='auth.users'?sha(auth):'e'.repeat(64)}]),
  ['data:app_private.marker',{count:1,hash:'a'.repeat(64)}],
  ['sequence:app_private.fixture_seq',{last_value:'9007199254740993',is_called:false}],
 ]),...clone(overrides)};
}
function fixture({different=true,...options}={}){
 const context={sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:'b'.repeat(64),
  before:{backends:[{pid:11}]},boundary:{capturedMicros:'1794570000000000',ownerPids:[12]}};
 const activation={actionId:'T40.final_https_window',reviewed:true,manifestSha256:'a'.repeat(64),
  sourceBarrierActionId:context.sourceBarrierActionId,sourceBarrierReceiptSha256:context.sourceBarrierReceiptSha256,
  fenceContextSha256:sha(context),ownerDataGrantEvidenceSha256:'c'.repeat(64),targetAdmitted:false,
  sourceRoute:'fixed-source-edge-https',targetRoute:'verified-loopback-15433',expectedAuthRows:16,
  sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,applyTimestampOnly:true,maxTimestampUpdates:1,
  beforeImagePath:'/root/bron-secrets/t40-auth-before-01234567.json'};
 const grant={reviewed:true,evidenceSha256:'c'.repeat(64),scope:'source-auth-fixed-snapshot-to-vps',
  sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',maxAuthSnapshots:3,
  credentialDerivedAuthDigests:true,readonlySource:true,encryptedToVpsRam:true,macDataTransit:false};
 const state={sourceRows:rows(),targetRows:rows(),sourceOverrides:{},targetOverrides:{},metadata:'SYNTHETIC_METADATA',
  calls:[],captures:[],snapshots:[],custody:[],events:[],updates:0,rwBegins:0,verifications:0,tx:null};
 if(different){state.targetRows[0].private_stamp=older;state.targetRows[0].private_micros=micros(older);}
 const proof=()=>({sourceBarrierActionId:activation.sourceBarrierActionId,
  sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,normalConnectDenied:true,
  existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false});
 const frame=stage=>({protocol:'BRON_PRIVATE_SNAPSHOT_V1',projectRef:'vkkqffvmztpzgygzfxhq',
  tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',snapshot:snapshotOf(state.sourceRows,state.sourceOverrides),
  authRows:clone(state.sourceRows),identity:{database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',
   read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:stage==='before'?101:102},
  fenceWitness:{db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',
   pid:stage==='before'?101:102,backendStartMicros:'1794570000000001',preDataValidated:true,
   sourceBarrierActionId:activation.sourceBarrierActionId,sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256}});
 const target={query:async(sql,params)=>{
  state.calls.push(sql);state.events.push(sql);
  if(/^\s*begin\b/i.test(sql)){
   assert.equal(state.tx,null);const rw=/read write/i.test(sql);if(rw)state.rwBegins++;
   state.tx={rw,rows:clone(state.targetRows),metadata:state.metadata};return {rows:[]};
  }
  if(sql==='COMMIT'||sql==='commit'){
   assert.ok(state.tx);const rw=state.tx.rw;if(rw)state.targetRows=clone(state.tx.rows);state.tx=null;
   if(rw&&options.lostCommit)throw new Error('PRIVATE_COMMIT_RESPONSE');return {rows:[]};
  }
  if(sql==='ROLLBACK'||sql==='rollback'){state.tx=null;return {rows:[]};}
  if(sql===authRowsSql||sql===authRowsSql+' FOR UPDATE')return {rows:clone(state.tx?.rows??state.targetRows)};
  if(sql===targetMetadataSql)return {rows:[{private_metadata:state.tx?.metadata??state.metadata}]};
  if(/^UPDATE auth\.users AS u/.test(sql)){
   assert.equal(state.tx?.rw,true);assert.ok(state.events.includes('DURABLE_BEFORE_IMAGE'));
   state.updates++;if(options.skipUpdate)return {rowCount:0,rows:[]};
   const [source,id,before,other]=params,r=state.tx.rows.find(x=>x.private_id===id);
   if(!r||r.private_stamp!==before||r.private_other!==other)return {rowCount:0,rows:[]};
   r.private_stamp=source;r.private_micros=micros(source);return {rowCount:1,rows:[{changed:1}]};
  }
  if(/^SET LOCAL /i.test(sql))return {rows:[]};
  assert.fail('unexpected target query');
 }};
 const snapshot=async(db,{beforeCommit})=>{
  assert.equal(typeof beforeCommit,'function');await db.query('begin isolation level repeatable read read only');
  try{
   const view=snapshotOf(state.tx.rows,state.targetOverrides);state.snapshots.push(clone(view));
   await beforeCommit(db);await db.query('commit');return view;
  }catch(e){await db.query('rollback');throw e;}
 };
 const args={activation,ownerDataGrant:grant,fenceContext:context,target,snapshot,
  fingerprintQuery:async()=>assert.fail('snapshot stub owns fingerprints'),
  captureSourceFrame:async stage=>{state.captures.push(stage);return options.capture?options.capture(stage,frame(stage),state):frame(stage);},
  verifyTarget:async()=>{assert.ok(state.tx);state.verifications++;},
  assertFence:async stage=>{if(options.onFence)await options.onFence(stage,state);return options.proof?options.proof(stage,proof()):proof();},
  persistBeforeImage:async image=>{
   assert.equal(state.updates,0);state.custody.push(clone(image));
   if(options.beforeImage)return options.beforeImage(image,state);
   state.events.push('DURABLE_BEFORE_IMAGE');
   return {path:activation.beforeImagePath,sha256:'9'.repeat(64),durable:true,fsynced:true,rootOwned:true,mode:'0600'};
  }};
 return {args,state,context,frame};
}
const run=f=>runFinalHttpsWindow(f.args);

test('imports and CLI remain inert; CLI cannot activate a draft',()=>{
 const file=path.resolve('docs/runbooks/payloads/final-https-window.mjs');
 const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:2000});
 assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
 const cli=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:2000});assert.equal(cli.status,2);
 assert.equal(cli.stdout,'');assert.match(cli.stderr,/^FINAL_HTTPS_WINDOW_DRAFT_NOT_ACTIVATED\n$/);
});

test('source privacy consent is separate from reviewed task DML scope and total read budget',async()=>{
 for(const patch of [{maxAuthSnapshots:1},{reviewed:false},{evidenceSha256:'4'.repeat(64)},
  {readonlySource:false},{encryptedToVpsRam:false},{credentialDerivedAuthDigests:false},{macDataTransit:true},
  {destinationVps:'127.0.0.1'},{scope:'T37_ONE_READONLY_COMPARISON'}]){
  const f=fixture();Object.assign(f.args.ownerDataGrant,patch);
  await assert.rejects(run(f),{code:'FINAL_HTTPS_SOURCE_DATA_GRANT_REQUIRED'});
  assert.equal(f.state.captures.length,0);assert.equal(f.state.calls.length,0);
 }
 for(const patch of [{applyTimestampOnly:false},{reviewed:false},{targetAdmitted:true},{sourceFrameBudget:3},
  {sourceRoute:'canonical-transaction-direct'},{maxTimestampUpdates:17}]){
  const f=fixture();Object.assign(f.args.activation,patch);await assert.rejects(run(f),{code:'FINAL_HTTPS_TASK_NOT_REVIEWED'});
  assert.equal(f.state.captures.length,0);assert.equal(f.state.updates,0);
 }
 const smaller=fixture({different:false});smaller.args.ownerDataGrant.maxAuthSnapshots=2;
 await assert.rejects(run(smaller),{code:'FINAL_HTTPS_SOURCE_DATA_GRANT_REQUIRED'});
 smaller.args.activation.priorSourceAuthSnapshotAttempts=0;assert.equal((await run(smaller)).status,'PASS');
});

test('fence context is hash-bound, validated before any capture, and cloned against caller mutation',async()=>{
 const changed=fixture();changed.context.boundary.capturedMicros='1794570000000001';
 await assert.rejects(run(changed),{code:'FINAL_HTTPS_FENCE_CONTEXT_INVALID'});assert.equal(changed.state.captures.length,0);
 for(const patch of [{before:{backends:null}},{boundary:{capturedMicros:'bad',ownerPids:[]}},
  {boundary:{capturedMicros:'1794570000000000',ownerPids:[-1]}}]){
  const f=fixture();Object.assign(f.context,patch);f.args.activation.fenceContextSha256=sha(f.context);
  await assert.rejects(run(f),{code:'FINAL_HTTPS_FENCE_CONTEXT_INVALID'});assert.equal(f.state.captures.length,0);
 }
 const f=fixture({capture:(_stage,value)=>{f.context.before.backends=[];value.fenceWitness.pid=11;value.identity.pid=11;return value;}});
 await assert.rejects(run(f),{code:'FINAL_HTTPS_SOURCE_FRAME_NOT_PROVED'});assert.equal(f.state.snapshots.length,0);
});

test('missing current fence, stale backend and pre-data/role/RO evidence fail before target work',async()=>{
 const missing=fixture({proof:(_stage,p)=>({...p,existingClientsDrained:false})});
 await assert.rejects(run(missing),{code:'FINAL_HTTPS_DURABLE_SOURCE_FENCE_NOT_PROVED'});
 assert.equal(missing.state.captures.length,0);
 for(const edit of [v=>{v.fenceWitness.preDataValidated=false;},v=>{v.fenceWitness.backendStartMicros='1794570000000000';},
  v=>{v.identity.pid=12;v.fenceWitness.pid=12;},v=>{v.identity.read_only='off';},
  v=>{v.identity.role='anon';},v=>{v.fenceWitness.sourceBarrierReceiptSha256='1'.repeat(64);},
  v=>{v.projectRef='other';},v=>{v.tls_negative_rejected=false;},v=>{v.tls_verification='insecure';},
  v=>{delete v.snapshot['schema:relations'];},v=>{v.authRows.pop();}]){
  const f=fixture({capture:(_s,v)=>{edit(v);return v;}});await assert.rejects(run(f),{code:'FINAL_HTTPS_SOURCE_FRAME_NOT_PROVED'});
  assert.equal(f.state.captures.length,1);assert.equal(f.state.snapshots.length,0);assert.equal(f.state.updates,0);
 }
});

test('one guarded timestamp update follows durable before-image; both target frames use same-RR hooks',async()=>{
 const f=fixture(),out=await run(f);assert.equal(out.status,'PASS');assert.equal(out.finalFreezeAudit,true);
 assert.equal(out.targetWriteOutcome,'COMMITTED');assert.equal(out.changedAuthTimestampRows,1);
 assert.deepEqual(f.state.captures,['before','after']);assert.equal(out.sourceFrameAttempts,2);
 assert.equal(f.state.snapshots.length,2);assert.equal(f.state.custody.length,1);assert.equal(f.state.updates,1);
 assert.equal(f.state.targetRows[0].private_stamp,stamp);assert.equal(f.state.targetRows[0].private_micros,micros(stamp));
 assert.equal(f.state.custody[0].rows.length,1);assert.equal(out.sourceMustRemainClosed,true);
 assert.ok(f.state.events.indexOf('DURABLE_BEFORE_IMAGE')<f.state.events.findIndex(s=>/^UPDATE auth/.test(s)));
 assert.doesNotMatch(JSON.stringify(out),/private_|00000000-0000|2026-11-13|dddddddd|SYNTHETIC_METADATA/);
});

test('already-equal full state still receives two source frames with no target writes or before-image',async()=>{
 const f=fixture({different:false}),out=await run(f);assert.equal(out.targetWriteOutcome,'UNCHANGED');
 assert.equal(out.changedAuthTimestampRows,0);assert.equal(f.state.updates,0);assert.equal(f.state.rwBegins,0);
 assert.equal(f.state.custody.length,0);assert.deepEqual(f.state.captures,['before','after']);
});

test('any schema, other data or sequence mismatch blocks before writes; Auth directions/other fields are checked',async()=>{
 for(const [key,value]of [['schema:policies',{count:2,hash:'2'.repeat(64)}],
  ['data:app_private.marker',{count:1,hash:'2'.repeat(64)}],
  ['sequence:app_private.fixture_seq',{last_value:'9007199254740994',is_called:false}]]){
  const f=fixture({different:false});f.state.targetOverrides[key]=value;
  await assert.rejects(run(f),e=>e.code==='FINAL_HTTPS_NON_AUTH_STRICT_MISMATCH'&&JSON.stringify(e.mismatchGroups)===JSON.stringify([key]));
  assert.equal(f.state.updates,0);assert.equal(f.state.custody.length,0);assert.deepEqual(f.state.captures,['before']);
 }
 for(const edit of [f=>{f.state.targetRows[0].private_other='1'.repeat(64);},
  f=>{f.state.targetRows[0].private_stamp='2026-11-13 12:00:00.000002+00';f.state.targetRows[0].private_micros=micros(f.state.targetRows[0].private_stamp);}]){
  const f=fixture();edit(f);await assert.rejects(run(f),{code:'FINAL_HTTPS_NON_TIMESTAMP_OR_DIRECTION_DIFF'});assert.equal(f.state.updates,0);
 }
});

test('before-image failure or invalid receipt rolls back before UPDATE and never leaks receipt fields',async()=>{
 for(const beforeImage of [async()=>{throw new Error('PRIVATE_WRITER_ERROR');},async()=>({path:'PRIVATE_UUID_PATH',sha256:'PRIVATE_HASH',mode:'0644'})]){
  const f=fixture({beforeImage});await assert.rejects(run(f),e=>{
   assert.equal(e.recovery.targetWriteOutcome,'ROLLED_BACK');assert.equal(e.recovery.beforeImage,null);
   assert.doesNotMatch(JSON.stringify(e),/PRIVATE_|00000000|2026-11-13/);return true;
  });assert.equal(f.state.updates,0);assert.equal(f.state.targetRows[0].private_stamp,older);
 }
});

test('guarded update failure rolls back; changed locked target state is not overwritten',async()=>{
 const skipped=fixture({skipUpdate:true});await assert.rejects(run(skipped),e=>e.code==='FINAL_HTTPS_GUARDED_UPDATE_NOT_EXACTLY_ONE'&&e.recovery.targetWriteOutcome==='ROLLED_BACK');
 assert.equal(skipped.state.targetRows[0].private_stamp,older);
 const changed=fixture({onFence:(stage,state)=>{if(stage==='before-target-write')state.targetRows[0].private_other='1'.repeat(64);}});
 await assert.rejects(run(changed),{code:'FINAL_HTTPS_TARGET_CAPTURE_DRIFT'});assert.equal(changed.state.updates,0);
});

test('lost COMMIT acknowledgement remains UNKNOWN; no rollback, source retry or auto-unfreeze follows',async()=>{
 const f=fixture({lostCommit:true});await assert.rejects(run(f),e=>e.code==='FINAL_HTTPS_TARGET_COMMIT_UNKNOWN'&&
  e.recovery.targetWriteOutcome==='UNKNOWN'&&e.recovery.sourceMustRemainClosed===true&&e.recovery.sourceFrameAttempts===1);
 assert.equal(f.state.targetRows[0].private_stamp,stamp);assert.deepEqual(f.state.captures,['before']);
 const rw=f.state.calls.findIndex(s=>/SERIALIZABLE READ WRITE/.test(s));assert.ok(rw>=0);
 assert.equal(f.state.calls.slice(rw).some(s=>/^rollback$/i.test(s)),false);
});

test('source mutation remains blocked even if final target would match; target metadata drift also blocks',async()=>{
 const f=fixture({onFence:(stage,s)=>{if(stage==='before-final-audit'){
  s.sourceOverrides['data:app_private.marker']={count:1,hash:'2'.repeat(64)};
  s.targetOverrides['data:app_private.marker']={count:1,hash:'2'.repeat(64)};
 }}});
 await assert.rejects(run(f),e=>e.code==='FINAL_HTTPS_SOURCE_CHANGED_UNDER_FENCE'&&e.recovery.targetWriteOutcome==='COMMITTED');
 assert.deepEqual(f.state.captures,['before','after']);assert.equal(f.state.snapshots.length,1);
 const meta=fixture({onFence:(stage,s)=>{if(stage==='before-final-audit')s.metadata='CHANGED_PRIVATE_METADATA';}});
 await assert.rejects(run(meta),e=>e.code==='FINAL_HTTPS_TARGET_METADATA_DRIFT'&&e.recovery.targetWriteOutcome==='COMMITTED');
});

test('a reused mutable source frame cannot rewrite the retained before-state',async()=>{
 let shared;
 const f=fixture({capture:(stage,value)=>{if(stage==='before')shared=value;return shared;},onFence:(stage,s)=>{
  if(stage==='before-final-audit'){
   shared.snapshot['data:app_private.marker']={count:1,hash:'2'.repeat(64)};
   s.targetOverrides['data:app_private.marker']={count:1,hash:'2'.repeat(64)};
  }
 }});
 await assert.rejects(run(f),e=>e.code==='FINAL_HTTPS_SOURCE_CHANGED_UNDER_FENCE'&&e.recovery.targetWriteOutcome==='COMMITTED');
 assert.deepEqual(f.state.captures,['before','after']);
});

test('source transport failure is attempted once per stage and errors contain only finite safe recovery data',async()=>{
 for(const failedStage of ['before','after']){
  const f=fixture({capture:(stage,value)=>{if(stage===failedStage)throw Object.assign(new Error('PRIVATE_TRANSPORT_UUID_PASSWORD'),{code:'42501'});return value;}});
  await assert.rejects(run(f),e=>{
   assert.equal(e.code,'FINAL_HTTPS_WINDOW_FAILED');assert.equal(e.upstreamCode,'42501');
   assert.equal(e.recovery.sourceMustRemainClosed,true);assert.doesNotMatch(JSON.stringify(e),/PRIVATE_|00000000|2026-11-13/);return true;
  });assert.deepEqual(f.state.captures,failedStage==='before'?['before']:['before','after']);
  assert.equal(f.state.updates,failedStage==='before'?0:1);
 }
});
