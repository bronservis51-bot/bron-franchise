import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {runFinalHttpsWindow} from '../../docs/runbooks/payloads/t59-final-window-core.mjs';
import {targetMetadataSql} from '../../docs/runbooks/payloads/final-auth-window.mjs';
import {authRowsSql,guardedUpdateSql} from '../../docs/runbooks/payloads/t59-auth-timestamps.mjs';

const clone=structuredClone,sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const names=['columns','relations','policies','storage_policies','storage_grants','triggers','extensions',
 'constraints','indexes','routines','enums','schemas','default_grants','client_roles','role_memberships'];
const tables=['auth.users','auth.identities','public.partner','public.location','public.role_assignment',
 'public.daily_revenue','public.franchise_lead','public.article_revision','storage.buckets','storage.objects'];
const stamp='2026-11-13 12:00:00.000001+00',older='2026-11-13 12:00:00.000000+00';
const micros=s=>s===null?null:String(BigInt(Date.parse(s))*1000n+BigInt((s.match(/\.(\d+)/)?.[1]??'').padEnd(6,'0').slice(3,6)||'0'));
const rows=()=>Array.from({length:16},(_,n)=>({private_id:'00000000-0000-4000-8000-'+String(n+1).padStart(12,'0'),
 private_stamp:stamp,private_micros:micros(stamp),private_sign_in_stamp:stamp,private_sign_in_micros:micros(stamp),private_other:'d'.repeat(64)}));
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
  sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:3,applyAuthTimestampsOnly:true,maxAuthTimestampRows:2,
  sourceAuthoritativeAuthTimestamps:true,authTimestampColumns:['last_sign_in_at','updated_at'],
  beforeImagePath:'/root/bron-secrets/t40-auth-before-01234567.json'};
 const grant={reviewed:true,evidenceSha256:'c'.repeat(64),scope:'source-auth-two-timestamps-fixed-snapshot-to-vps',
  sourceProject:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',maxAuthSnapshots:5,targetTimestampReconciliation:true,sourceAuthoritativeAuthTimestamps:true,
  lastSignInAtValue:true,updatedAtValue:true,maxAuthTimestampRows:2,authTimestampColumns:['last_sign_in_at','updated_at'],
  credentialDerivedAuthDigests:true,readonlySource:true,encryptedToVpsRam:true,macDataTransit:false};
 const state={sourceRows:rows(),targetRows:rows(),sourceOverrides:{},targetOverrides:{},metadata:'SYNTHETIC_METADATA',
  calls:[],captures:[],snapshots:[],custody:[],events:[],updates:0,rwBegins:0,verifications:0,tx:null};
 if(different){for(const n of [0,1]){state.targetRows[n].private_stamp=older;state.targetRows[n].private_micros=micros(older);}
  state.targetRows[1].private_sign_in_stamp=older;state.targetRows[1].private_sign_in_micros=micros(older);}
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
  if(sql===guardedUpdateSql){
   assert.equal(state.tx?.rw,true);assert.ok(state.events.includes('DURABLE_BEFORE_IMAGE'));
   state.updates++;if(options.skipUpdate)return {rowCount:0,rows:[]};
   const [source,sourceSignIn,id,before,beforeSignIn,other]=params,r=state.tx.rows.find(x=>x.private_id===id);
   if(!r||r.private_stamp!==before||r.private_sign_in_stamp!==beforeSignIn||r.private_other!==other)return {rowCount:0,rows:[]};
   r.private_stamp=source;r.private_micros=micros(source);r.private_sign_in_stamp=sourceSignIn;r.private_sign_in_micros=micros(sourceSignIn);return {rowCount:1,rows:[{changed:1}]};
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

test('imports and CLI cannot activate a proposed core',()=>{
 const file=path.resolve('docs/runbooks/payloads/t59-final-window-core.mjs');
 const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(file)})`],{encoding:'utf8',timeout:2000});
 assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
 const cli=spawnSync(process.execPath,[file],{encoding:'utf8',timeout:2000});
 assert.equal(cli.status,2);assert.equal(cli.stdout,'');assert.match(cli.stderr,/^T59_FINAL_CORE_DRAFT_NOT_ACTIVATED/);
});

test('new explicit two-column permission, source authority and actual prior3/max5 are required before any work',async()=>{
 for(const patch of [{reviewed:false},{maxAuthSnapshots:3},{scope:'source-auth-fixed-snapshot-to-vps'},
  {lastSignInAtValue:false},{updatedAtValue:false},{targetTimestampReconciliation:false},{sourceAuthoritativeAuthTimestamps:false},
  {authTimestampColumns:['updated_at']},{maxAuthTimestampRows:16},{readonlySource:false},{encryptedToVpsRam:false},{macDataTransit:true}]){
  const f=fixture();Object.assign(f.args.ownerDataGrant,patch);
  await assert.rejects(run(f),{code:'FINAL_HTTPS_SOURCE_DATA_GRANT_REQUIRED'});
  assert.equal(f.state.captures.length,0);assert.equal(f.state.calls.length,0);
 }
 for(const patch of [{priorSourceAuthSnapshotAttempts:1},{applyAuthTimestampsOnly:false},{sourceAuthoritativeAuthTimestamps:false},
  {authTimestampColumns:['updated_at']},{maxAuthTimestampRows:17},{sourceFrameBudget:1},{targetAdmitted:true}]){
  const f=fixture();Object.assign(f.args.activation,patch);await assert.rejects(run(f),{code:'FINAL_HTTPS_TASK_NOT_REVIEWED'});
  assert.equal(f.state.captures.length,0);assert.equal(f.state.calls.length,0);
 }
});

test('one two-row guarded reconciliation persists only old two timestamps and UUID, then full fresh final audit passes',async()=>{
 const f=fixture(),out=await run(f);
 assert.equal(out.status,'PASS');assert.equal(out.targetWriteOutcome,'COMMITTED');assert.equal(out.changedAuthTimestampRows,2);
 assert.equal(out.sourceFrameAttempts,2);assert.deepEqual(f.state.captures,['before','after']);
 assert.equal(f.state.updates,2);assert.equal(f.state.snapshots.length,2);assert.equal(f.state.custody.length,1);
 assert.deepEqual(f.state.targetRows,f.state.sourceRows);
 const image=f.state.custody[0];assert.deepEqual(image.authTimestampColumns,['last_sign_in_at','updated_at']);
 assert.equal(image.rows.length,2);for(const r of image.rows)assert.deepEqual(Object.keys(r).sort(),['id','last_sign_in_at','updated_at']);
 assert.equal(image.rows[0].updated_at,older);assert.equal(image.rows[0].last_sign_in_at,stamp);
 assert.equal(image.rows[1].last_sign_in_at,older);assert.equal('targetMetadataBefore'in image,false);
 assert.match(image.targetMetadataBeforeSha256,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(out),/private_|00000000-0000|2026-11-13|dddddddd|SYNTHETIC_METADATA/);
 assert.equal(out.authPlanSummary.updatedAtChangedRows,2);assert.equal(out.authPlanSummary.lastSignInChangedRows,1);
});

test('source-authoritative older and NULL values are handled only under the new scope',async()=>{
 const f=fixture({different:false});
 f.state.sourceRows[0].private_stamp=older;f.state.sourceRows[0].private_micros=micros(older);
 f.state.sourceRows[0].private_sign_in_stamp=null;f.state.sourceRows[0].private_sign_in_micros=null;
 const out=await run(f);assert.equal(out.status,'PASS');assert.equal(out.changedAuthTimestampRows,1);
 assert.equal(out.authPlanSummary.updatedAtTargetNewerRows,1);assert.equal(out.authPlanSummary.lastSignInNullChangedRows,1);
 assert.equal(f.state.targetRows[0].private_stamp,older);assert.equal(f.state.targetRows[0].private_sign_in_stamp,null);
});

test('already equal full state still gets two snapshots and all four fence assertions without writing',async()=>{
 const stages=[],f=fixture({different:false,onFence:stage=>stages.push(stage)}),out=await run(f);
 assert.equal(out.status,'PASS');assert.equal(out.targetWriteOutcome,'UNCHANGED');assert.equal(out.changedAuthTimestampRows,0);
 assert.equal(f.state.updates,0);assert.equal(f.state.custody.length,0);
 assert.deepEqual(stages,['start','before-target-write','before-final-audit','end']);
 assert.deepEqual(f.state.captures,['before','after']);
});

test('outside-column changes, membership differences and row budget violations stop with safe counters before writes',async()=>{
 const other=fixture();other.state.targetRows[0].private_other='1'.repeat(64);
 await assert.rejects(run(other),e=>{assert.equal(e.code,'FINAL_HTTPS_OUTSIDE_TWO_TIMESTAMPS_DIFF');
  assert.equal(e.authPlanSummary.otherChangedRows,1);assert.equal(e.recovery.targetWriteOutcome,'UNCHANGED');
  assert.doesNotMatch(JSON.stringify(e),/private_|00000000-0000|2026-11-13|dddddddd/);return true;});
 assert.equal(other.state.updates,0);
 const ids=fixture();ids.state.targetRows[15].private_id='00000000-0000-4000-8000-000000000099';
 await assert.rejects(run(ids),e=>e.code==='FINAL_HTTPS_OUTSIDE_TWO_TIMESTAMPS_DIFF'&&e.authPlanSummary.sourceOnlyRows===1&&e.authPlanSummary.targetOnlyRows===1);
 assert.equal(ids.state.updates,0);
 const bound=fixture();bound.args.activation.maxAuthTimestampRows=1;bound.args.ownerDataGrant.maxAuthTimestampRows=1;
 await assert.rejects(run(bound),e=>e.code==='FINAL_HTTPS_UPDATE_BUDGET'&&e.authPlanSummary.changedTimestampRows===2);
 assert.equal(bound.state.updates,0);assert.equal(bound.state.custody.length,0);
});

test('schema/data/sequence differences stay strict; stale source identity fails before target snapshot',async()=>{
 for(const[key,value]of [['schema:policies',{count:2,hash:'2'.repeat(64)}],['data:app_private.marker',{count:1,hash:'2'.repeat(64)}],
  ['sequence:app_private.fixture_seq',{last_value:'9007199254740994',is_called:false}]]){
  const f=fixture({different:false});f.state.targetOverrides[key]=value;
  await assert.rejects(run(f),e=>e.code==='FINAL_HTTPS_NON_AUTH_STRICT_MISMATCH'&&e.mismatchGroups[0]===key);
  assert.equal(f.state.updates,0);
 }
 const stale=fixture({capture:(_s,v)=>{v.fenceWitness.backendStartMicros='1794570000000000';return v;}});
 await assert.rejects(run(stale),{code:'FINAL_HTTPS_SOURCE_FRAME_NOT_PROVED'});assert.equal(stale.state.snapshots.length,0);
 const missing=fixture({proof:(_s,p)=>({...p,normalConnectDenied:false})});
 await assert.rejects(run(missing),{code:'FINAL_HTTPS_DURABLE_SOURCE_FENCE_NOT_PROVED'});assert.equal(missing.state.captures.length,0);
});

test('failed durable before-image or concurrent locked target change rolls back without overwriting data',async()=>{
 const bad=fixture({beforeImage:async()=>({path:'PRIVATE_UUID',mode:'0644',sha256:'PRIVATE_HASH'})});
 await assert.rejects(run(bad),e=>e.code==='FINAL_HTTPS_BEFORE_IMAGE_NOT_DURABLE'&&e.recovery.targetWriteOutcome==='ROLLED_BACK');
 assert.equal(bad.state.updates,0);
 const changed=fixture({onFence:(stage,s)=>{if(stage==='before-target-write'){
  s.targetRows[0].private_sign_in_stamp=older;s.targetRows[0].private_sign_in_micros=micros(older);
 }}});
 await assert.rejects(run(changed),{code:'FINAL_HTTPS_TARGET_CAPTURE_DRIFT'});assert.equal(changed.state.updates,0);
 const skipped=fixture({skipUpdate:true});await assert.rejects(run(skipped),e=>e.code==='FINAL_HTTPS_GUARDED_UPDATE_NOT_EXACTLY_ONE'&&e.recovery.targetWriteOutcome==='ROLLED_BACK');
});

test('lost COMMIT acknowledgement remains UNKNOWN and never triggers rollback, source retry or reopening',async()=>{
 const f=fixture({lostCommit:true});
 await assert.rejects(run(f),e=>e.code==='FINAL_HTTPS_TARGET_COMMIT_UNKNOWN'&&e.recovery.targetWriteOutcome==='UNKNOWN'&&
  e.recovery.sourceMustRemainClosed===true&&e.recovery.sourceFrameAttempts===1);
 assert.deepEqual(f.state.targetRows,f.state.sourceRows);assert.deepEqual(f.state.captures,['before']);
 const begin=f.state.calls.findIndex(s=>/SERIALIZABLE READ WRITE/.test(s));
 assert.equal(f.state.calls.slice(begin).some(s=>/^rollback$/i.test(s)),false);
});

test('Source before/after drift and target metadata drift remain blocking after commit',async()=>{
 const source=fixture({onFence:(stage,s)=>{if(stage==='before-final-audit'){
  s.sourceOverrides['data:app_private.marker']={count:1,hash:'2'.repeat(64)};
  s.targetOverrides['data:app_private.marker']={count:1,hash:'2'.repeat(64)};
 }}});
 await assert.rejects(run(source),e=>e.code==='FINAL_HTTPS_SOURCE_CHANGED_UNDER_FENCE'&&e.recovery.targetWriteOutcome==='COMMITTED');
 const meta=fixture({onFence:(stage,s)=>{if(stage==='before-final-audit')s.metadata='CHANGED_PRIVATE_METADATA';}});
 await assert.rejects(run(meta),e=>e.code==='FINAL_HTTPS_TARGET_METADATA_DRIFT'&&e.recovery.targetWriteOutcome==='COMMITTED');
});

test('Source failure is one attempt per stage and private exception details never enter safe recovery',async()=>{
 for(const failedStage of ['before','after']){
  const f=fixture({capture:(stage,v)=>{if(stage===failedStage)throw Object.assign(new Error('PRIVATE_PASSWORD_UUID'),{code:'42501'});return v;}});
  await assert.rejects(run(f),e=>{assert.equal(e.code,'FINAL_HTTPS_WINDOW_FAILED');assert.equal(e.upstreamCode,'42501');
   assert.doesNotMatch(JSON.stringify(e),/PRIVATE_|00000000-0000|2026-11-13|dddddddd/);return true;});
  assert.deepEqual(f.state.captures,failedStage==='before'?['before']:['before','after']);
 }
});

test('new finite timestamp validation codes survive recovery without private encodings',async()=>{
 const f=fixture({different:false});f.state.sourceRows[0].private_stamp='2026-11-13T12:00:00.000001Z';
 await assert.rejects(run(f),e=>{
  assert.equal(e.code,'FINAL_HTTPS_WINDOW_FAILED');assert.equal(e.upstreamCode,'T59_AUTH_TIMESTAMP_ENCODING_MISMATCH');
  assert.equal(e.recovery.targetWriteOutcome,'UNCHANGED');assert.doesNotMatch(JSON.stringify(e),/private_|00000000-0000|2026-11-13/);
  return true;
 });assert.equal(f.state.updates,0);
});

test('unknown Source claim outcome preserves only safe boolean uncertainty flags',async()=>{
 const f=fixture({capture:()=>{throw Object.assign(new Error('PRIVATE_CLAIM_DETAIL'),{
  code:'T59_BUDGET_CLAIM_UNCERTAIN',budgetUncertain:true,claimMayBeConsumed:true,privateDetail:'PRIVATE_VALUE'});
 }});
 await assert.rejects(run(f),e=>{
  assert.equal(e.budgetUncertain,true);assert.equal(e.claimMayBeConsumed,true);
  assert.equal(e.upstreamCode,'T59_BUDGET_CLAIM_UNCERTAIN');
  assert.equal(e.recovery.targetWriteOutcome,'UNCHANGED');assert.equal(e.recovery.sourceFrameAttempts,1);
  assert.doesNotMatch(JSON.stringify(e),/PRIVATE_|privateDetail|00000000-0000|2026-11-13/);return true;
 });assert.equal(f.state.updates,0);assert.deepEqual(f.state.captures,['before']);
});
