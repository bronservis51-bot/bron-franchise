import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {expectedPins,sourceRuntimeHashes,targetIdentitySql,validateManifest,validatePriorFailure,validateT55Evidence,
 createPrepared,validatePrepared,expectedSourceFiles,validateDeployment,validateReadyResponse,validateCoordinatorReady,
 activationFromPrepared,parseArguments,validateExpiredT53,priorT53ManifestSha256,createPriorT53Custody,validatePriorT53Custody} from '../../docs/runbooks/payloads/t56-final-window.mjs';
import {targetIdentitySql as originalTargetIdentitySql} from '../../docs/runbooks/payloads/t45-final-window.mjs';
import {createCoordinatorFenceAck} from '../../docs/runbooks/payloads/coordinator-fence-ack-t56.mjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const encode=x=>Buffer.from(canonical(x)+'\n');
const now=Date.parse('2026-11-15T08:00:00.000Z'),manifestSha='a'.repeat(64),selfSha='b'.repeat(64),ackSha='c'.repeat(64);
const control={controlSummarySha256:'d'.repeat(64),controlReceiptSha256:'e'.repeat(64),independentKeyProofSha256:'f'.repeat(64)};
const beforePath='/root/bron-secrets/t56-auth-before-c56a2026.json';
function manifest(){return {task:'T56',actionId:'T56.release_window',execution_authorized:true,maxSuccessorWindows:1,pins:expectedPins,
 priorT53:{manifestSha256:priorT53ManifestSha256,custody:'verify-expired-public-metadata-and-seal-on-vps'},
 t55ReceiptSha256:'1'.repeat(64),t55ResultSha256:'2'.repeat(64),approval:{status:'APPROVED',document_sha256:expectedPins.ownerGrantSha256},
 files:{'docs/runbooks/payloads/t56-final-window.mjs':selfSha,'docs/runbooks/payloads/coordinator-fence-ack-t56.mjs':ackSha,
  'docs/runbooks/payloads/source-final-https-reader/index.ts':expectedPins.sourceTemplateSha256},
 phase_authorizations:{prepare_final:{actionId:'T56.prepare_final',capability_ttl_seconds:7200,source_data_reads:0,target_metadata_probe:1},
  run_final:{actionId:'T56.final_https_window',applyTimestampOnly:true,maxTimestampUpdates:1,sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,beforeImagePath:beforePath,wall_seconds:480,targetAdmitted:false}}};}
function prepared(at=now){
 return createPrepared({manifestSha256:manifestSha,controlEvidence:control,now:at,random:()=>Buffer.alloc(32,15),writeSecret:()=>{}});
}
function context(){return {before:{backends:[5960,5961,5968,349125,1414968,1658737,1661141,1661142,1661169,1661170,1661175].map(pid=>({pid}))},
 boundary:{capturedMicros:'1794709552349448',ownerPids:[1747293]},sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256};}
const barrier={normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
const template=fs.readFileSync(new URL('../../docs/runbooks/payloads/source-final-https-reader/index.ts',import.meta.url));

test('target identity query remains byte-exact and a real SELECT',()=>{
 assert.equal(targetIdentitySql,originalTargetIdentitySql);
 assert.match(targetIdentitySql,/^SELECT current_database\(\)/);
});
test('T56 manifest pins one new two-frame max1 window and both real T55 hashes',()=>{
 const check=m=>{const raw=encode(m);return validateManifest(raw,hash(raw),selfSha,ackSha);};
 assert.equal(check(manifest()).task,'T56');
 for(const change of [m=>m.task='T45',m=>m.actionId='T49.final_https_window',m=>m.maxSuccessorWindows=2,
  m=>delete m.priorT53,m=>m.priorT53.manifestSha256='0'.repeat(64),m=>m.priorT53.custody='skip',
  m=>m.t55ReceiptSha256='<pending>',m=>m.t55ResultSha256=null,m=>m.pins={...expectedPins,contextSha256:'0'.repeat(64)},
  m=>m.phase_authorizations.prepare_final.capability_ttl_seconds=10800,m=>m.phase_authorizations.prepare_final.source_data_reads=1,
  m=>m.phase_authorizations.run_final.applyTimestampOnly=false,m=>m.phase_authorizations.run_final.maxTimestampUpdates=2,m=>m.phase_authorizations.run_final.sourceFrameBudget=3,
  m=>m.phase_authorizations.run_final.beforeImagePath='/root/bron-secrets/t45-auth-before-c45a2026.json',
  m=>m.phase_authorizations.run_final.targetAdmitted=true,m=>m.approval.document_sha256='0'.repeat(64)]){
  const m=manifest();change(m);assert.throws(()=>check(m),{code:'T56_SCOPE_INVALID'});
 }
});
test('the known old T45 zero-effect result is archived evidence, not a fresh run',()=>{
 const old={task:'T45',status:'BLOCKED',actionId:'T45.final_https_window',targetWriteOutcome:'UNCHANGED',sourceMustRemainClosed:true,
  macDataTransit:false,phase:'source-fence-start',code:'FINAL_HTTPS_WINDOW_FAILED',
  recovery:{targetWriteOutcome:'UNCHANGED',sourceFrameAttempts:0,sourceMustRemainClosed:true,beforeImage:null}};
 const raw=Buffer.from(JSON.stringify(old)+'\n');
 assert.equal(hash(raw),expectedPins.priorResultSha256);
 assert.equal(validatePriorFailure(raw).recovery.sourceFrameAttempts,0);
 assert.throws(()=>validatePriorFailure(Buffer.from(JSON.stringify({...old,status:'PASS'})+'\n')),{code:'T56_PRIOR_RESULT_SHA'});
 assert.throws(()=>validatePriorFailure(raw,'0'.repeat(64)),{code:'T56_PRIOR_RESULT_SHA'});
});
function expiredT53Fixture(change=()=>{}){
 const mraw=fs.readFileSync(new URL('../../docs/runbooks/payloads/t53-final-window.json',import.meta.url));
 assert.equal(hash(mraw),priorT53ManifestSha256);
 const p={...prepared(now-10800000),task:'T53',actionId:'T53.final_https_window',manifestSha256:priorT53ManifestSha256};
 const g={task:'T53',actionId:'T53.prepare_final',manifestSha256:priorT53ManifestSha256,
  t55ReceiptSha256:JSON.parse(mraw).t55ReceiptSha256,startedUtc:p.createdUtc};
 const r={...p,status:'FINAL_READY',preparedSha256:hash(encode(p)),targetWriteOutcome:'UNCHANGED',sourceMustRemainClosed:true,macDataTransit:false,
  authBudgetUsed:1,authBudgetRemaining:2,adoptedParentTask:'T45',adoptedPriorResultSha256:expectedPins.priorResultSha256,adoptedBarrierSha256:expectedPins.barrierSha256,
  expectedExecutableFileHashes:expectedSourceFiles(template,p,context())};
 change({p,r,g});r.preparedSha256=hash(encode(p));
 const archive={manifestRaw:mraw,preparedRaw:encode(p),resultRaw:encode(r),guardRaw:encode(g)};
 const pins={manifestSha256:priorT53ManifestSha256,preparedSha256:hash(archive.preparedRaw),prepareResultSha256:hash(archive.resultRaw),prepareGuardSha256:hash(archive.guardRaw)};
 return {archive,pins};
}
test('T56 adopts only the immutable expired, FINAL_READY T53 prepare with zero write outcome',()=>{
 const {archive,pins}=expiredT53Fixture();
 assert.equal(validateExpiredT53(archive,pins,control,now).result.status,'FINAL_READY');
 for(const change of [({p})=>p.task='T56',({r})=>r.status='PASS',({r})=>r.targetWriteOutcome='COMMITTED',
  ({r})=>r.authBudgetUsed=2,({r})=>r.authBudgetRemaining=1,({r})=>r.macDataTransit=true,({r})=>r.sourceMustRemainClosed=false,
  ({r})=>r.adoptedBarrierSha256='0'.repeat(64),({r})=>r.expectedExecutableFileHashes['migration-audit.mjs']='0'.repeat(64),
  ({g})=>g.actionId='T53.final_https_window',({g})=>g.t55ReceiptSha256='0'.repeat(64)]){
  const bad=expiredT53Fixture(change);assert.throws(()=>validateExpiredT53(bad.archive,bad.pins,control,now),{code:'T56_PRIOR_T53_NOT_EXPIRED_ZERO_EFFECT'});
 }
 assert.throws(()=>validateExpiredT53(archive,pins,control,now-7200000),{code:'T56_PRIOR_T53_NOT_EXPIRED_ZERO_EFFECT'});
 assert.throws(()=>validateExpiredT53(archive,{...pins,prepareResultSha256:'0'.repeat(64)},control,now),{code:'T56_PRIOR_T53_SHA'});
});
test('T56 seals observed public archive hashes on VPS and binds every later phase to exact bytes',()=>{
 const {archive}=expiredT53Fixture(),proof=createPriorT53Custody(archive,manifestSha,control,now),raw=encode(proof);
 assert.equal(proof.priorT53.preparedSha256,hash(archive.preparedRaw));
 assert.equal(proof.priorT53.prepareResultSha256,hash(archive.resultRaw));
 assert.equal(proof.priorT53.prepareGuardSha256,hash(archive.guardRaw));
 assert.deepEqual(validatePriorT53Custody(raw,archive,manifestSha,control,now),proof);
 assert.throws(()=>validatePriorT53Custody(raw,archive,'0'.repeat(64),control,now),{code:'T56_PRIOR_T53_CUSTODY_BINDING'});
 for(const change of [p=>p.task='T53',p=>p.priorT53.prepareResultSha256='0'.repeat(64),p=>p.extra=true]){
  const changed=structuredClone(proof);change(changed);
  assert.throws(()=>validatePriorT53Custody(encode(changed),archive,manifestSha,control,now),{code:'T56_PRIOR_T53_CUSTODY_BINDING'});
 }
 const changed={...archive,resultRaw:Buffer.concat([archive.resultRaw,Buffer.from(' ')] )};
 assert.throws(()=>validatePriorT53Custody(raw,changed,manifestSha,control,now),{code:'T56_PRIOR_T53_CUSTODY_BINDING'});
 for(const field of ['preparedRaw','resultRaw','guardRaw']){
  const changed={...archive,[field]:Buffer.concat([archive[field],Buffer.from(' ')])};
  assert.throws(()=>validatePriorT53Custody(raw,changed,manifestSha,control,now));
 }
 assert.throws(()=>validatePriorT53Custody(Buffer.from(JSON.stringify(proof)),archive,manifestSha,control,now),{code:'T56_PRIOR_T53_CUSTODY_BINDING'});
});
test('T55 actual helper PASS, counters and both wall/monotonic proof are required',()=>{
 const receipt=encode({task:'T55',status:'PASS',safeReceipt:true});
 const pass={task:'T55',actionId:'T55.mcp_readiness',status:'PASS',code:'T55_AUTOMATIC_MCP_RELAY_PROVEN',sourceVerifyPassed:true,
  roundTripMs:1234,monotonicRoundTripMs:1234,createdEpochMs:now-1234,completedEpochMs:now,targetWrites:0,
  snapshotAttemptsUsed:0,T49Started:false,macDataTransit:false,requestSha256:'1'.repeat(64),responseSha256:'2'.repeat(64)};
 const check=r=>{const raw=encode(r),m={t55ReceiptSha256:hash(receipt),t55ResultSha256:hash(raw)};return validateT55Evidence(receipt,raw,m,m.t55ReceiptSha256);};
 assert.equal(check(pass).status,'PASS');
 for(const change of [r=>r.task='T51',r=>r.task='T54',r=>r.status='BLOCKED',r=>r.code='T54_AUTOMATIC_MCP_RELAY_PROVEN',r=>r.code='T55_SAME_WORKER_MCP_PROVEN',r=>r.roundTripMs=30001,r=>r.monotonicRoundTripMs=30001,
  r=>r.targetWrites=1,r=>r.snapshotAttemptsUsed=1,r=>r.T49Started=true,r=>r.sourceVerifyPassed=false,r=>r.completedEpochMs++,
  r=>r.responseSha256=null]){
  const r=structuredClone(pass);change(r);assert.throws(()=>check(r),{code:'T56_T55_NOT_PASS'});
 }
 const raw=encode(pass),m={t55ReceiptSha256:hash(receipt),t55ResultSha256:hash(raw)};
 assert.throws(()=>validateT55Evidence(receipt,raw,m,'0'.repeat(64)),{code:'T56_T55_EVIDENCE_SHA'});
 for(const wrong of [{task:'T55',status:'PROVISIONAL_HELPER_PASS'},{task:'T55',status:'BLOCKED'},{task:'T52',status:'PASS'}]){
  const receiptRaw=encode(wrong),pins={t55ReceiptSha256:hash(receiptRaw),t55ResultSha256:hash(raw)};
  assert.throws(()=>validateT55Evidence(receiptRaw,raw,pins,pins.t55ReceiptSha256),{code:'T56_T55_NOT_PASS'});
 }
});
test('new entropy is zeroed and the first persisted prepared object honestly belongs to T56',()=>{
 const entropy=Buffer.alloc(32,17);let stored,held;
 const p=createPrepared({manifestSha256:manifestSha,controlEvidence:control,now,random:()=>entropy,
  writeSecret:raw=>{held=raw;stored=Buffer.from(raw);}});
 assert.equal(stored.length,64);assert.equal(hash(stored),p.capabilitySha256);
 assert(entropy.every(x=>x===0));assert(held.every(x=>x===0));
 assert.equal(p.task,'T56');assert.equal(p.actionId,'T56.final_https_window');assert.equal(p.manifestSha256,manifestSha);
 assert.equal(Date.parse(p.expiresUtc)-Date.parse(p.createdUtc),7200000);
 assert.equal(p.functionName,'bron-source-reader-'+p.capabilitySha256.slice(0,12));
 assert.equal(p.fenceContextSha256,expectedPins.contextSha256);
 const raw=encode(p);assert.equal(validatePrepared(raw,hash(raw),manifestSha,control,now).task,'T56');
});
test('fresh prepared validation never accepts expired or relabeled T45/T49 evidence',()=>{
 const p=prepared(),check=(value,at=now,headroom=140000)=>{const raw=encode(value);return validatePrepared(raw,hash(raw),manifestSha,control,at,headroom);};
 assert.equal(check(p).task,'T56');
 for(const change of [x=>x.task='T45',x=>x.task='T49',x=>x.actionId='T45.final_https_window',
  x=>x.manifestSha256='0'.repeat(64),x=>x.expiresUtc=new Date(now+10800000).toISOString(),x=>x.controlReceiptSha256='0'.repeat(64),
  x=>x.functionName='bron-source-reader-old',x=>x.extra=true]){
  const copy=structuredClone(p);change(copy);assert.throws(()=>check(copy),{code:'T56_PREPARED_INVALID'});
 }
 assert.throws(()=>check(p,now+7200000),{code:'T56_PREPARED_INVALID'});
 assert.throws(()=>check(p,now+7200000-620000,620000),{code:'T56_PREPARED_INVALID'});
 assert.throws(()=>check(p,now,139999),{code:'T56_PREPARED_INVALID'});
});
test('Source render is independently verified against historical known code and unchanged context',()=>{
 assert.equal(hash(JSON.stringify(context())),expectedPins.contextSha256);
 const historical={capabilitySha256:'920938e064729dca455bc902f98674775c70e52c5cfc265f5f537550410ebb98',expiresUtc:'2026-11-15T04:14:51.589Z'};
 const files=expectedSourceFiles(template,historical,context());
 assert.equal(files['index.ts'],'2a907c354343741d1b4ab0616b1ab1cbe3bf5668fda4db03331c4bccc3a2c28b');
 assert.equal(Object.keys(files).length,6);for(const [name,pin]of Object.entries(sourceRuntimeHashes))assert.equal(files[name],pin);
 assert.throws(()=>expectedSourceFiles(Buffer.concat([template,Buffer.from('\n')]),historical,context()),{code:'T56_SOURCE_TEMPLATE_OR_CONTEXT'});
 const changed=context();changed.boundary.capturedMicros='1794709552349449';
 assert.throws(()=>expectedSourceFiles(template,historical,changed),{code:'T56_SOURCE_TEMPLATE_OR_CONTEXT'});
});
function deployment(p,raw,files){return {format:1,task:'T56',actionId:'T56.data_deployment',manifestSha256:manifestSha,preparedSha256:hash(raw),
 sourceProject:'vkkqffvmztpzgygzfxhq',functionName:p.functionName,capabilitySha256:p.capabilitySha256,expiresUtc:p.expiresUtc,
 fenceContextSha256:expectedPins.contextSha256,sourceBarrierReceiptSha256:expectedPins.barrierSha256,status:'ACTIVE',version:1,verifyJwt:false,
 entrypointPath:'index.ts',executableFileHashes:files,exactRuntimeReadback:true,
 preflightGet:{status:403,purpose:'BRON_PRIVATE_SNAPSHOT_V1',tlsVerified:true},observedUtc:new Date(now+1000).toISOString()};}
test('deployment proof binds real code, capability, prepared metadata and provider readback',()=>{
 const p=prepared(),preparedRaw=encode(p),files=expectedSourceFiles(template,p,context());
 const check=d=>{const raw=encode(d);return validateDeployment(raw,hash(raw),manifestSha,preparedRaw,p,files,now+2000);};
 assert.equal(check(deployment(p,preparedRaw,files)).status,'ACTIVE');
 for(const change of [d=>d.task='T45',d=>d.preparedSha256='0'.repeat(64),d=>d.capabilitySha256='0'.repeat(64),d=>d.verifyJwt=true,
  d=>d.exactRuntimeReadback=false,d=>d.preflightGet.status=200,d=>d.preflightGet.tlsVerified=false,
  d=>d.preflightGet.purpose='BRON_SOURCE_FENCE_WITNESS_V1',d=>d.executableFileHashes={...files,'index.ts':'0'.repeat(64)},
  d=>d.executableFileHashes={...files,'extra.mjs':'0'.repeat(64)},d=>d.observedUtc=new Date(now-6000).toISOString(),d=>d.version=0]){
  const d=deployment(p,preparedRaw,files);change(d);assert.throws(()=>check(d),{code:'T56_DEPLOYMENT_NOT_VERIFIED'});
 }
});
function request(){return {format:1,protocol:'T56.preflight_nonce',actionId:'T56.coordinator_ready',manifestSha256:manifestSha,
 sourceProject:'vkkqffvmztpzgygzfxhq',sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256,
 verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256,stage:'ready',nonceSha256:'3'.repeat(64),createdEpochMs:now-12000,expiresEpochMs:now+48000};}
function response(req,raw){const publicContext={...req,requestPath:'/root/bron-secrets/t56-release/coordinator-ready.request.json',
 ackPath:'/root/bron-secrets/t56-release/coordinator-ready.json',requestSha256:hash(raw),storageUid:0,storageGid:0,storageMode:384};
 return {format:1,protocol:'BRON_T56_READY_RESPONSE_V1',task:'T56',actionId:'T56.coordinator_ready',manifestSha256:manifestSha,
  sourceProject:req.sourceProject,sourceBarrierActionId:req.sourceBarrierActionId,sourceBarrierReceiptSha256:req.sourceBarrierReceiptSha256,
  verifyFencedSqlSha256:req.verifyFencedSqlSha256,requestSha256:hash(raw),contextSha256:hash(encode(publicContext)),nonceSha256:req.nonceSha256,
  sourceCheckedMicros:String(BigInt(now-3000)*1000n),workerId:'local-codex-supabase-mcp',connector:'Supabase MCP'};}
test('fresh READY accepts only the nonce-bound real Source clock with <=30s wall and monotonic delivery',()=>{
 const req=request(),raw=encode(req),r=response(req,raw);
 const check=(value,completed=now,mono=12000)=>validateReadyResponse(encode(value),raw,manifestSha,completed,mono);
 const ready=check(r);assert.equal(ready.task,'T56');assert.equal(ready.roundTripMs,12000);
 const readyRaw=encode(ready);assert.equal(validateCoordinatorReady(readyRaw,hash(readyRaw),manifestSha,now).sourceCheckedMicros,r.sourceCheckedMicros);
 for(const change of [x=>x.task='T55',x=>x.protocol='BRON_COORDINATOR_FENCE_ACK_V1',x=>x.requestSha256='0'.repeat(64),
  x=>x.contextSha256='0'.repeat(64),x=>x.nonceSha256='0'.repeat(64),x=>x.connector='browser',x=>x.sourceCheckedMicros=String(BigInt(now+6000)*1000n),
  x=>x.sourceCheckedMicros='١٧٩٤٧١٦٠٠٠١٢٣٤٥٦',x=>x.extra=true]){
  const copy=structuredClone(r);change(copy);assert.throws(()=>check(copy),{code:'T56_READY_RESPONSE_INVALID'});
 }
 assert.throws(()=>check(r,now+18001,30001),{code:'T56_READY_RESPONSE_INVALID'});
 assert.throws(()=>check(r,now,9000),{code:'T56_READY_RESPONSE_INVALID'});
 assert.throws(()=>validateCoordinatorReady(readyRaw,hash(readyRaw),manifestSha,now+30001),{code:'T56_COORDINATOR_NOT_READY'});
 const wrongRequest={...req,manifestSha256:'0'.repeat(64)};
 assert.throws(()=>validateReadyResponse(encode(r),encode(wrongRequest),manifestSha,now,12000),{code:'T56_READY_RESPONSE_INVALID'});
});
test('fresh activation retains archived barrier lineage, owner scope, max1 and new T56 before-image',()=>{
 const p=prepared(),copy=structuredClone(p),ctx=context(),out=activationFromPrepared(p,manifestSha,ctx,barrier);
 assert.deepEqual(p,copy);assert.equal(out.activation.actionId,'T56.final_https_window');assert.equal(out.activation.maxTimestampUpdates,1);
 assert.equal(out.activation.beforeImagePath,beforePath);assert.equal(out.ownerDataGrant.maxAuthSnapshots,3);
 assert.equal(out.activation.sourceFrameBudget,2);assert.equal(out.activation.priorSourceAuthSnapshotAttempts,1);
 assert.equal(out.activation.sourceBarrierReceiptSha256,expectedPins.barrierSha256);
 assert.equal(out.prepared.task,'T56');assert.equal(out.barrierProof.sourcePaused,false);
});
test('CLI requires pinned T55 evidence and exact mode-specific input hashes',()=>{
 const common=['--manifest','/root/bron-secrets/t56-release/manifest.json','--sha256',manifestSha,'--t55-receipt-sha256','1'.repeat(64)];
 assert.equal(parseArguments(['--prepare-final',...common]).mode,'--prepare-final');
 const more=['--prepared-sha256','2'.repeat(64),'--deployment-proof-sha256','3'.repeat(64)];
 for(const mode of ['--prepare-ready','--accept-ready'])assert.equal(parseArguments([mode,...common,...more]).mode,mode);
 assert.equal(parseArguments(['--run-final',...common,...more,'--ready-input-sha256','4'.repeat(64)]).mode,'--run-final');
 for(const argv of [['--run-final',...common],['--prepare-final',...common,'--sha256',manifestSha],
  ['--prepare-final',...common,'--retry','1'],['--prepare-final',...common.slice(0,-2)]]){
  assert.throws(()=>parseArguments(argv),{code:'T56_EXPLICIT_INPUT_REQUIRED'});
 }
});
test('T56 ACK module is the exact namespace-only clone, preserving all original deadline/security logic',()=>{
 const prior=fs.readFileSync(new URL('../../docs/runbooks/payloads/coordinator-fence-ack-t49.mjs',import.meta.url),'utf8');
 const current=fs.readFileSync(new URL('../../docs/runbooks/payloads/coordinator-fence-ack-t56.mjs',import.meta.url),'utf8');
 assert.equal(current,prior.replaceAll('T49','T56').replaceAll('t49-release','t56-release'));
});
test('all four synthetic T56 ACK stages use the T56 namespace and unchanged 60-second validation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t56-ack-fixture-'));fs.chmodSync(dir,0o700);const stages=[];
 const a={reviewed:true,actionId:'T56.final_https_window',manifestSha256:manifestSha,sourceProject:'vkkqffvmztpzgygzfxhq',
  sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:expectedPins.barrierSha256,verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256};
 const b={sourceBarrierActionId:a.sourceBarrierActionId,sourceBarrierReceiptSha256:a.sourceBarrierReceiptSha256,...barrier};
 const ack=createCoordinatorFenceAck({activation:a,barrierProof:b,onChallenge:r=>{
  stages.push(r.stage);assert(r.ackPath.startsWith('/root/bron-secrets/t56-release/'));assert.equal(r.expiresEpochMs-r.createdEpochMs,60000);
  const payload={format:1,protocol:'BRON_COORDINATOR_FENCE_ACK_V1',actionId:a.actionId,manifestSha256:manifestSha,sourceProject:a.sourceProject,
   sourceBarrierActionId:a.sourceBarrierActionId,sourceBarrierReceiptSha256:a.sourceBarrierReceiptSha256,verifyFencedSqlSha256:a.verifyFencedSqlSha256,
   stage:r.stage,nonceSha256:r.nonceSha256,sourceCheckedMicros:String(BigInt(r.createdEpochMs)*1000n),expiresEpochMs:r.expiresEpochMs,
   normalConnectDenied:true,existingClientsDrained:true,providerBoundaryReviewed:true};
  const ackJson=JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k=>[k,payload[k]])))+'\n';
  fs.writeFileSync(path.join(dir,path.basename(r.ackPath)),JSON.stringify({ackJson,rootAckSha256:hash(ackJson)}),{mode:0o600,flag:'wx'});
 }},{directory:dir,uid:process.getuid(),gid:process.getgid()});
 try{for(const stage of ['start','before-target-write','before-final-audit','end'])assert.equal((await ack.assertFence(stage)).currentAck.stage,stage);
  assert.deepEqual(stages,['start','before-target-write','before-final-audit','end']);}finally{ack.close();fs.rmSync(dir,{recursive:true,force:true});}
});
