import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {expectedPins,validateManifest,renewWitnessObservation} from '../../docs/runbooks/payloads/t48-witness-continuation.mjs';
import * as validators from '../../docs/runbooks/payloads/t45-bind-fence.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>Buffer.from(canonical(x)+'\n');
const now=Date.parse('2026-11-15T03:00:00.000Z'),parent=expectedPins.parentManifestSha256;
// Synthetic technical metadata only. The pure test pins below do not establish
// production byte custody; main requires the exact immutable expectedPins.
function fixture(){
 const control={sqlHashes:{verifyFencedSql:'5'.repeat(64)}};
 const base={task:'T45',actionId:'T45.final_https_window',manifestSha256:parent,
  ownerGrantSha256:'cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69',
  origin:'https://vkkqffvmztpzgygzfxhq.supabase.co',projectRef:'vkkqffvmztpzgygzfxhq',destinationVps:'152.228.115.115',protocol:'BRON_PRIVATE_SNAPSHOT_V1',
  createdUtc:'2026-11-15T02:14:51.589Z',expiresUtc:expectedPins.expiresUtc,
  capabilitySha256:expectedPins.capabilitySha256,functionName:'bron-source-reader-'+expectedPins.capabilitySha256.slice(0,12),
  controlSummarySha256:'3'.repeat(64),controlReceiptSha256:'2'.repeat(64),independentKeyProofSha256:'4'.repeat(64)};
 const baseBytes=Buffer.from(JSON.stringify(base)+'\n'),baseSha=sha(baseBytes);
 const oldApproval={format:1,task:'T45',actionId:'T45.source_fence_approved',manifestSha256:parent,basePreparedSha256:baseSha,
  controlSummarySha256:base.controlSummarySha256,controlReceiptSha256:base.controlReceiptSha256,
  verifyFencedSqlSha256:control.sqlHashes.verifyFencedSql,status:'SOURCE_FENCED_BY_COORDINATOR',normalConnectDenied:true,
  existingClientsDrained:true,providerBoundaryReviewed:true,sourcePaused:false,targetWritesStarted:false,
  boundary:{capturedMicros:'1794709552349448',ownerPids:[22]},observedUtc:'2026-11-15T02:27:15.490Z'};
 const context={before:{backends:[{pid:21}]},boundary:structuredClone(oldApproval.boundary),sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:base.controlReceiptSha256};
 const contextSha=sha(JSON.stringify(context));
 const prepared={format:1,task:'T45',actionId:'T45.prepare_witness',manifestSha256:parent,basePreparedSha256:baseSha,
  controlSummarySha256:base.controlSummarySha256,controlReceiptSha256:base.controlReceiptSha256,
  sourceFenceApprovedSha256:sha(bytes(oldApproval)),contextSha256:contextSha,context};
 const oldApprovalBytes=bytes(oldApproval),preparedBytes=bytes(prepared);
 const current={...structuredClone(oldApproval),observedUtc:new Date(now-1000).toISOString()};
 return {pins:{...expectedPins,oldFenceInputSha256:sha(oldApprovalBytes),oldPreparedContextSha256:sha(preparedBytes),basePreparedSha256:baseSha,contextSha256:contextSha},
  oldApprovalBytes,preparedBytes,baseBytes,control,now,current};
}
function input(f){const {current,...rest}=f,currentApprovalBytes=bytes(current);return {...rest,currentApprovalBytes,currentApprovalSha256:sha(currentApprovalBytes)};}

test('manifest locks the genuine historical pins, scope, self and unchanged expiry',()=>{
 const h='a'.repeat(64),m={task:'T48',actionId:'T48.continue_T45_witness',execution_authorized:true,maxWitnessRequests:1,
  maxReadinessRequests:1,sourceDataFrames:0,expiryUnchanged:true,pins:expectedPins,files:{'docs/runbooks/payloads/t48-witness-continuation.mjs':h}};
 const check=x=>{const raw=bytes(x);return validateManifest(raw,sha(raw),h);};assert.equal(check(m).task,'T48');
 for(const patch of [{task:'T45'},{maxWitnessRequests:2},{sourceDataFrames:1},{expiryUnchanged:false},{pins:{...expectedPins,oldFenceInputSha256:h}},
  {pins:{...expectedPins,expiresUtc:'2026-11-16T04:14:51.589Z'}}])assert.throws(()=>check({...m,...patch}),{code:'T48_SCOPE_INVALID'});
 assert.throws(()=>validateManifest(bytes(m),'0'.repeat(64),h),{code:'T48_MANIFEST_SHA'});
});

test('new current approval renews only observation; old stale sealed bytes stay identical',async()=>{
 const f=fixture(),old=Buffer.from(f.oldApprovalBytes),prepared=Buffer.from(f.preparedBytes),i=input(f);
 assert.throws(()=>validators.validateRootInput(JSON.parse(old),{manifestSha:parent,baseSha:f.pins.basePreparedSha256,
  base:JSON.parse(f.baseBytes),control:f.control,now}),{code:'T45_BIND_ROOT_APPROVAL_INVALID'});
 const r=await renewWitnessObservation(i,validators);assert.deepEqual(f.oldApprovalBytes,old);assert.deepEqual(f.preparedBytes,prepared);
 assert.equal(r.preparedContext.sourceFenceApprovedSha256,i.currentApprovalSha256);
 assert.deepEqual(r.preparedContext.context,JSON.parse(prepared).context);
 assert.equal(r.base.expiresUtc,expectedPins.expiresUtc);assert.equal(r.base.capabilitySha256,expectedPins.capabilitySha256);
 assert.notEqual(r.renewedContextSha256,f.pins.oldPreparedContextSha256);
});

test('stale, future or unchanged current observations are rejected by the real clock',async()=>{
 for(const timestamp of [now-600001,now+5001,Date.parse('2026-11-15T02:27:15.490Z')]){
  const f=fixture();f.current.observedUtc=new Date(timestamp).toISOString();await assert.rejects(renewWitnessObservation(input(f),validators));
 }
});

test('fresh proof cannot change the drain boundary, control, manifest or flags',async()=>{
 for(const change of [x=>x.boundary.ownerPids=[99],x=>x.boundary.capturedMicros='1794709552349449',x=>x.controlReceiptSha256='f'.repeat(64),
  x=>x.manifestSha256='f'.repeat(64),x=>x.targetWritesStarted=true,x=>x.sourcePaused=true,x=>x.extra=true]){
  const f=fixture();change(f.current);await assert.rejects(renewWitnessObservation(input(f),validators),{code:'T48_RENEWAL_BINDING'});
 }
});

test('all byte pins and canonical original/current inputs are mandatory',async()=>{
 for(const key of ['oldApprovalBytes','preparedBytes','baseBytes']){
  const f=fixture(),i=input(f);i[key]=Buffer.concat([i[key],Buffer.from(' ')]);await assert.rejects(renewWitnessObservation(i,validators),{code:'T48_INPUT_SHA'});
 }
 const f=fixture(),i=input(f);i.currentApprovalBytes=Buffer.from(JSON.stringify(f.current,null,2)+'\n');i.currentApprovalSha256=sha(i.currentApprovalBytes);
 await assert.rejects(renewWitnessObservation(i,validators),{code:'T48_CANONICAL_INPUT'});
});

test('base context/capability/expiry changes cannot be authorized by a fresh observation',async()=>{
 for(const change of [x=>x.capabilitySha256='f'.repeat(64),x=>x.expiresUtc='2026-11-16T04:14:51.589Z']){
  const f=fixture(),base=JSON.parse(f.baseBytes);change(base);f.baseBytes=Buffer.from(JSON.stringify(base)+'\n');f.pins.basePreparedSha256=sha(f.baseBytes);
  await assert.rejects(renewWitnessObservation(input(f),validators),{code:'T48_RENEWAL_BINDING'});
 }
 const f=fixture(),p=JSON.parse(f.preparedBytes);p.context.before.backends=[{pid:999}];f.preparedBytes=bytes(p);f.pins.oldPreparedContextSha256=sha(f.preparedBytes);
 await assert.rejects(renewWitnessObservation(input(f),validators),{code:'T48_RENEWAL_BINDING'});
});

test('new observation retains the existing capability deadline and control SQL check',async()=>{
 const f=fixture();f.now=Date.parse(expectedPins.expiresUtc)-44000;
 f.current.observedUtc=new Date(f.now-1000).toISOString();await assert.rejects(renewWitnessObservation(input(f),validators),{code:'T45_BIND_BASE_INVALID'});
 const g=fixture();g.control.sqlHashes.verifyFencedSql='f'.repeat(64);await assert.rejects(renewWitnessObservation(input(g),validators),{code:'T45_BIND_ROOT_APPROVAL_INVALID'});
});
