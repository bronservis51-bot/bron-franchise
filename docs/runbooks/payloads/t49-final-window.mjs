// One explicitly authorized successor window. The consumed T45 guard is immutable.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {networkInterfaces} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const ROOT='/root/bron-secrets',OLD=ROOT+'/t45-release',DIR=ROOT+'/t49-release',RUNTIME=ROOT+'/t45-runtime';
const SELF=ROOT+'/t49-final-window.mjs',ACK=ROOT+'/coordinator-fence-ack-t49.mjs',MANIFEST=DIR+'/manifest.json';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',PG='/opt/bron/rehearsal-audit.exfSfv9a/node_modules/pg';
const LOCK='/opt/bron/rehearsal-audit.exfSfv9a/package-lock.json',LOCK_SHA='a100d1e53b1923fa350912eac4cb82a330e7390f79949f3346295fefab0b8b69';
const ACTION='T49.final_https_window',PROJECT='vkkqffvmztpzgygzfxhq',BARRIER_ACTION='T40.http_source_admission';
const AUTH_BEFORE=ROOT+'/t49-auth-before-c49a2026.json',REL='docs/runbooks/payloads/t49-final-window.mjs',ACK_REL='docs/runbooks/payloads/coordinator-fence-ack-t49.mjs';
export const targetIdentitySql=`SELECT current_database() AS database,current_user AS role,session_user AS session_role,
 current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
 current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,
 current_setting('idle_in_transaction_session_timeout') AS idle_timeout,current_setting('TimeZone') AS timezone,
 current_setting('search_path') AS search_path,host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,
 current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net`;
export const expectedPins=Object.freeze({
 parentManifestSha256:'67b2bb6c7b72ef39bd66dbb2e008f177fb5b38ae9713e052ad8aee0aa5182ad8',
 inputSha256:'c9e0b5fa1fd207e70f63292ad3a3c69d79218ec6b9185fafd5db0ac44ff6a4d6',
 barrierSha256:'0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6',
 basePreparedSha256:'ed0871f06237339c60218e84185b7d278e0881c5443ffddbbc2a8152e793220f',
 finalPreparedSha256:'a226cfa9eb96fbe9ca2276e20bffc637d04cbd2670417f18dc45f03df63f25a8',
 contextSha256:'564c015f97aea285659304a78437840562bf701e3ed5df55b94f04c9008c5f3b',
 capabilitySha256:'920938e064729dca455bc902f98674775c70e52c5cfc265f5f537550410ebb98',
 expiresUtc:'2026-11-15T04:14:51.589Z',
 ownerApprovedInputSha256:'68b9789f062a5e3ad0d301afb251a5fb936f75712d6ffafddbd3fe6bda83a2a8',
 verifyFencedSqlSha256:'fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782',
});
const sha=x=>createHash('sha256').update(x).digest('hex'),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>Buffer.from(canonical(x)+'\n'),same=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const parse=raw=>{try{return JSON.parse(raw);}catch{fail('T49_JSON_INVALID');}};
export function validateManifest(raw,pin,selfSha,ackSha){
 if(!digest(pin)||sha(raw)!==pin)fail('T49_MANIFEST_SHA');const m=parse(raw);
 if(m.task!=='T49'||m.actionId!==ACTION||m.execution_authorized!==true||m.maxSuccessorWindows!==1||
  !same(m.pins,expectedPins)||!digest(m.priorResultSha256)||!digest(selfSha)||!digest(ackSha)||
  m.files?.[REL]!==selfSha||m.files?.[ACK_REL]!==ackSha||m.phase_authorizations?.run_final?.maxTimestampUpdates!==1||
  m.phase_authorizations.run_final.sourceFrameBudget!==2||m.phase_authorizations.run_final.priorSourceAuthSnapshotAttempts!==1||
  m.phase_authorizations.run_final.beforeImagePath!==AUTH_BEFORE||m.phase_authorizations.run_final.wall_seconds!==480)
  fail('T49_SCOPE_INVALID');return m;
}
export function validatePriorFailure(raw,pin){
 if(!digest(pin)||sha(raw)!==pin)fail('T49_PRIOR_RESULT_SHA');const r=parse(raw);
 if(r.task!=='T45'||r.status!=='BLOCKED'||r.phase!=='source-fence-start'||r.targetWriteOutcome!=='UNCHANGED'||
  r.recovery?.targetWriteOutcome!=='UNCHANGED'||r.recovery?.sourceFrameAttempts!==0||r.recovery?.sourceMustRemainClosed!==true)
  fail('T49_PRIOR_WINDOW_NOT_ZERO_EFFECT');return r;
}
export function validateCoordinatorReady(raw,pin,manifestSha,pins=expectedPins,now=Date.now()){
 if(!digest(pin)||sha(raw)!==pin)fail('T49_READY_SHA');const r=parse(raw);
 const required=['format','task','actionId','status','manifestSha256','sourceProject','sourceBarrierActionId',
  'sourceBarrierReceiptSha256','verifyFencedSqlSha256','connector','workerId','mcpWorkerReady','sourceVerifyPassed',
  'nonceSha256','createdEpochMs','completedEpochMs','roundTripMs','sourceCheckedMicros','observedUtc'];
 if(Object.keys(r).sort().join(',')!==required.sort().join(',')||r.format!==1||r.task!=='T49'||
  r.actionId!=='T49.coordinator_ready'||r.status!=='COORDINATOR_READY'||r.manifestSha256!==manifestSha||
  r.sourceProject!==PROJECT||r.sourceBarrierActionId!==BARRIER_ACTION||r.sourceBarrierReceiptSha256!==pins.barrierSha256||
  r.verifyFencedSqlSha256!==pins.verifyFencedSqlSha256||r.connector!=='Supabase MCP'||
  typeof r.workerId!=='string'||!/^[A-Za-z0-9_./-]{1,128}$/.test(r.workerId)||r.mcpWorkerReady!==true||
  r.sourceVerifyPassed!==true||!digest(r.nonceSha256)||![r.createdEpochMs,r.completedEpochMs,r.roundTripMs,now].every(Number.isSafeInteger)||
  r.createdEpochMs>r.completedEpochMs||r.roundTripMs!==r.completedEpochMs-r.createdEpochMs||r.roundTripMs<0||r.roundTripMs>30000||
  r.completedEpochMs>now+5000||now-r.completedEpochMs>30000||r.observedUtc!==new Date(r.completedEpochMs).toISOString()||
  typeof r.sourceCheckedMicros!=='string'||!/^\d{12,20}$/.test(r.sourceCheckedMicros)||
  BigInt(r.sourceCheckedMicros)<BigInt(r.createdEpochMs-5000)*1000n||BigInt(r.sourceCheckedMicros)>BigInt(r.completedEpochMs+5000)*1000n)
  fail('T49_COORDINATOR_NOT_READY');return r;
}
export function projectSuccessor(validated,newManifestSha,pins=expectedPins,now=Date.now()){
 if(!digest(newManifestSha)||validated?.activation?.actionId!=='T45.final_https_window'||
  validated.activation.manifestSha256!==pins.parentManifestSha256||validated.activation.fenceContextSha256!==pins.contextSha256||
  validated.activation.sourceBarrierReceiptSha256!==pins.barrierSha256||validated.prepared.task!=='T45'||
  validated.prepared.capabilitySha256!==pins.capabilitySha256||validated.prepared.expiresUtc!==pins.expiresUtc||
  !Number.isSafeInteger(now)||now+620000>=Date.parse(pins.expiresUtc))fail('T49_PARENT_PROJECTION_INVALID');
 return {...structuredClone(validated),activation:{...structuredClone(validated.activation),actionId:ACTION,
  manifestSha256:newManifestSha,beforeImagePath:AUTH_BEFORE},prepared:{...structuredClone(validated.prepared),
  task:'T49',actionId:ACTION,manifestSha256:newManifestSha}};
}

function directory(p){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||
 (s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T49_PRIVATE_DIRECTORY');}
function read(p,max=4194304,lock=false){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||s.size<1||s.size>max||
  (lock?(s.mode&0o022)!==0:(s.mode&0o7777)!==0o600))fail('T49_PRIVATE_FILE');
  const raw=fs.readFileSync(fd),a=fs.fstatSync(fd),n=fs.lstatSync(p);if(raw.length!==s.size||s.size!==a.size||
   s.mtimeMs!==a.mtimeMs||s.ctimeMs!==a.ctimeMs||s.dev!==n.dev||s.ino!==n.ino)fail('T49_FILE_CHANGED');return raw;
 }finally{fs.closeSync(fd);}}
function absent(names){for(const p of names)try{fs.lstatSync(p);fail('T49_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}
function write(p,value,onClaim){if(path.dirname(p)!==DIR&&p!==AUTH_BEFORE)fail('T49_WRITE_PATH');directory(path.dirname(p));const raw=Buffer.isBuffer(value)?value:bytes(value);
 const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{onClaim?.();fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(d);}finally{fs.closeSync(d);}if(!read(p).equals(raw))fail('T49_WRITE_READBACK');return sha(raw);}
const safeCode=e=>/^(?:T49_|T45_|FINAL_HTTPS_|COORDINATOR_FENCE_|SOURCE_TRANSFER_|OWNER_PROOF_)[A-Z0-9_]+$/.test(e?.code??'')?e.code:/^[A-Z0-9]{5}$/.test(e?.code??'')?e.code:'T49_FAILED';

async function main(){let phase='preflight',target,ack,timer,guarded=false,lastFenceFailure;
 const abort=new AbortController(),interrupt=()=>{abort.abort();target?.connection?.stream?.destroy();};
 let result={task:'T49',actionId:ACTION,status:'BLOCKED',targetWriteOutcome:'UNCHANGED',sourceMustRemainClosed:true,macDataTransit:false};
 try{
  if(process.argv.length!==8||process.argv[2]!=='--manifest'||process.argv[3]!==MANIFEST||process.argv[4]!=='--sha256'||
   !digest(process.argv[5])||process.argv[6]!=='--ready-input-sha256'||!digest(process.argv[7]))fail('T49_EXPLICIT_INPUT_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||
   fileURLToPath(import.meta.url)!==SELF||process.env.NODE_TEST_CONTEXT||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||process.env.NODE_PG_FORCE_NATIVE||
   !Object.values(networkInterfaces()).flat().some(i=>i?.address==='152.228.115.115'))fail('T49_PINNED_VPS_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const p of ['/root',ROOT,OLD,DIR,RUNTIME])directory(p);
  const m=validateManifest(read(MANIFEST),process.argv[5],sha(read(SELF)),sha(read(ACK))),pins=m.pins;
  const parentRaw=read(OLD+'/manifest.json');if(sha(parentRaw)!==pins.parentManifestSha256)fail('T49_PARENT_SHA');const initial=parse(parentRaw);
  for(const [p,h]of Object.entries(initial.runtime_files??{})){if(!p.startsWith(RUNTIME+'/')||sha(read(p))!==h)fail('T49_RUNTIME_SHA');directory(path.dirname(p));}
  for(const k of ['approval','source','transfer_budget','target'])if(!same(m[k],initial[k]))fail('T49_PARENT_SCOPE_CHANGED');
  const old=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-final-window.mjs');
  const owner=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-control-ready.mjs');
  old.validateManifest(parentRaw,pins.parentManifestSha256,sha(read(RUNTIME+'/docs/runbooks/payloads/t45-final-window.mjs')));
  const parent=owner.loadOwnerManifest(initial,pins.parentManifestSha256,pins.ownerApprovedInputSha256);
  const control=old.validateControlEvidence({summaryBytes:read(OLD+'/control-ready-result.json'),controlBytes:read(ROOT+'/t40-admission-control-c40a2026.json'),
   keyProofBytes:read(ROOT+'/t40-admission-key-proof-c40a2026.json')},parent,pins.parentManifestSha256);
  for(const [p,h]of [[ROOT+'/t40-admission-before-c40a2026.json',parent.input_evidence.T40_before_image_sha256],
   [ROOT+'/t40-admission-metadata-c40a2026.json',parent.input_evidence.T40_metadata_receipt_sha256],[control.inversePath,control.inverseSha256]])
   if(sha(read(p))!==h)fail('T49_ADOPTED_INPUT_CHANGED');
  const oldResult=read(OLD+'/final-result.json');validatePriorFailure(oldResult,m.priorResultSha256);
  const oldGuard=read(OLD+'/final-run.guard'),oldGuardSha=sha(oldGuard),g=parse(oldGuard);
  if(g.task!=='T45'||g.actionId!=='T45.final_https_window'||g.manifestSha256!==pins.parentManifestSha256||g.inputSha256!==pins.inputSha256)fail('T49_PRIOR_GUARD');
  absent([ROOT+'/t45-auth-before-c45a2026.json',AUTH_BEFORE,DIR+'/final-run.guard',DIR+'/final-result.json',DIR+'/projection.json']);
  const inputs={inputBytes:read(OLD+'/fence-input.json'),inputSha256:pins.inputSha256,basePreparedBytes:read(OLD+'/final-base-prepared.json'),
   finalPreparedBytes:read(OLD+'/final-prepared.json'),barrierBytes:read(OLD+'/source-barrier.json'),manifest:parent,manifestSha256:pins.parentManifestSha256,controlEvidence:control};
  if(sha(inputs.basePreparedBytes)!==pins.basePreparedSha256||sha(inputs.finalPreparedBytes)!==pins.finalPreparedSha256||sha(inputs.barrierBytes)!==pins.barrierSha256)fail('T49_PARENT_ARTIFACT_SHA');
  const validated=old.validateRunInputs(inputs),projected=projectSuccessor(validated,process.argv[5]);
  const budget=await import('file://'+RUNTIME+'/docs/runbooks/payloads/source-transfer-budget.mjs');
  const binding={directory:ROOT+'/source-transfer-budget',scopeSha256:budget.SOURCE_TRANSFER_SCOPE_SHA256,sourceProject:PROJECT,destinationVps:'152.228.115.115',maxAttempts:3};
  old.validateBudget(budget.readBudgetStatus(binding));
  if(sha(read(LOCK,4194304,true))!==LOCK_SHA||parse(fs.readFileSync(PG+'/package.json')).version!=='8.23.1')fail('T49_DRIVER_PIN');
  const {default:pg}=await import('file://'+PG+'/lib/index.js');
  const records=parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],{encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
  const config=old.targetFromInspect(records,parent),{databaseConfig}=await import('file://'+RUNTIME+'/scripts/database-config.mjs');
  target=new pg.Client({...databaseConfig(config.url,{BRON_DB_ALLOW_LOCAL_PLAIN:'1'}),options:'-c default_transaction_read_only=on',query_timeout:6000,application_name:'bron-t49-final-target'});target.on('error',()=>{});
  const token=read(OLD+'/final-capability',64).toString('utf8');if(!/^[a-f0-9]{64}$/.test(token)||sha(token)!==pins.capabilitySha256)fail('T49_CAPABILITY_SHA');
  const transportModule=await import('file://'+RUNTIME+'/docs/runbooks/payloads/final-https-transport.mjs');
  const core=await import('file://'+RUNTIME+'/docs/runbooks/payloads/final-https-window.mjs');
  const {createCoordinatorFenceAck}=await import('file://'+ACK);
  validateCoordinatorReady(read(DIR+'/coordinator-ready.json'),process.argv[7],process.argv[5]);
  projectSuccessor(validated,process.argv[5]); // Actual start headroom, after all preflight work.
  phase='activation';write(DIR+'/final-run.guard',{task:'T49',actionId:ACTION,manifestSha256:process.argv[5],
   parentTask:'T45',priorResultSha256:m.priorResultSha256,priorGuardSha256:oldGuardSha,readyInputSha256:process.argv[7],startedUtc:new Date().toISOString()},()=>{guarded=true;});
  write(DIR+'/projection.json',{task:'T49',parentTask:'T45',parentInputSha256:pins.inputSha256,
   projectedActivation:projected.activation,projectedPrepared:projected.prepared});
  timer=setTimeout(interrupt,480000);process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  const transport=await transportModule.createFinalHttpsTransport({activation:projected.activation,taskManifest:m,prepared:projected.prepared,token,
   fenceContext:projected.fenceContext,fenceContextSha256:pins.contextSha256,signal:abort.signal,onBudgetClaim:claim=>write(DIR+'/final-source-'+claim.stage+'-claim.json',claim)});
  ack=createCoordinatorFenceAck({activation:{reviewed:true,actionId:ACTION,manifestSha256:process.argv[5],sourceProject:PROJECT,
   sourceBarrierActionId:BARRIER_ACTION,sourceBarrierReceiptSha256:pins.barrierSha256,verifyFencedSqlSha256:pins.verifyFencedSqlSha256},barrierProof:projected.barrierProof,signal:abort.signal,timeoutMs:60000});
  phase='target-connect';await target.connect();phase='final-window';
  const final=await core.runFinalHttpsWindow({activation:projected.activation,ownerDataGrant:projected.ownerDataGrant,fenceContext:projected.fenceContext,
   captureSourceFrame:transport.captureSourceFrame,target,verifyTarget:async client=>{if(abort.signal.aborted)fail('T49_ABORTED');const rows=(await client.query(targetIdentitySql)).rows;
    if(rows.length!==1)fail('T49_TARGET_IDENTITY');old.verifyFinalTargetIdentity(rows[0],config.addresses);},
   assertFence:async stage=>{try{return await ack.assertFence(stage);}catch(e){lastFenceFailure={task:'T49',stage,code:safeCode(e),observedUtc:new Date().toISOString(),sourceMustRemainClosed:true};
     try{write(DIR+'/fence-failure-'+stage+'.json',lastFenceFailure);}catch{lastFenceFailure.diagnosticWriteFailed=true;}throw e;}},
   persistBeforeImage:value=>({path:AUTH_BEFORE,sha256:write(AUTH_BEFORE,value),durable:true,fsynced:true,rootOwned:true,mode:'0600'})});
  result={...result,...final}; // Preserve a known COMMIT before any later local operation.
  const after=budget.readBudgetStatus(binding);if(after.used!==3||after.remaining!==0||after.uncertain!==false)fail('T49_FINAL_BUDGET');
  if(sha(read(OLD+'/final-result.json'))!==m.priorResultSha256||sha(read(OLD+'/final-run.guard'))!==oldGuardSha)fail('T49_OLD_STATE_CHANGED');
  result={...result,authBudgetUsed:after.used,oldT45Unchanged:true};
 }catch(e){result={...result,status:'BLOCKED',phase:e?.phase??phase,code:safeCode(e),...(lastFenceFailure?{fenceFailure:lastFenceFailure}:{}),
  ...(/^[A-Z0-9_]{1,128}$/.test(e?.upstreamCode??'')?{upstreamCode:e.upstreamCode}:{}),
  ...(Array.isArray(e?.mismatchGroups)&&e.mismatchGroups.length<=100&&e.mismatchGroups.every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:]{1,160}$/.test(x))?{mismatchGroups:e.mismatchGroups}:{}),
  ...(e?.recovery?{recovery:e.recovery,targetWriteOutcome:e.recovery.targetWriteOutcome}:{})};}
 finally{clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);abort.abort();try{ack?.close();}catch{}
  target?.connection?.stream?.destroy();let closeTimer;try{await Promise.race([target?.end(),new Promise(resolve=>{closeTimer=setTimeout(resolve,250);})]);}catch{}finally{clearTimeout(closeTimer);}
  if(guarded)try{write(DIR+'/final-result.json',result);}catch{result={...result,status:'BLOCKED',code:'T49_RESULT_WRITE_FAILED'};}}
 console.log('T49_FINAL_RESULT',JSON.stringify(result));if(result.status!=='PASS')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
