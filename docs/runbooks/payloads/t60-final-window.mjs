// T60 final reconciliation: two explicit Auth timestamp columns, no other Auth DML.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {networkInterfaces} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';

const ROOT='/root/bron-secrets',OLD=ROOT+'/t45-release',DIR=ROOT+'/t60-release',RUNTIME=ROOT+'/t45-runtime',NEW_RUNTIME=ROOT+'/t60-runtime';
const SELF=ROOT+'/t60-final-window.mjs',ACK=ROOT+'/coordinator-fence-ack-t60.mjs',MANIFEST=DIR+'/manifest.json';
const TEMPLATE=DIR+'/source-reader-index.ts.template',NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node';
const PG='/opt/bron/rehearsal-audit.exfSfv9a/node_modules/pg',LOCK='/opt/bron/rehearsal-audit.exfSfv9a/package-lock.json';
const LOCK_SHA='a100d1e53b1923fa350912eac4cb82a330e7390f79949f3346295fefab0b8b69';
const ACTION='T60.final_https_window',PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115';
const ORIGIN='https://'+PROJECT+'.supabase.co',PROTOCOL='BRON_PRIVATE_SNAPSHOT_V1',PREFIX='bron-source-reader-';
const BARRIER_ACTION='T40.http_source_admission',AUTH_BEFORE=ROOT+'/t60-auth-before-c60a2026.json';
const REL='docs/runbooks/payloads/t60-final-window.mjs',ACK_REL='docs/runbooks/payloads/coordinator-fence-ack-t60.mjs';
const TEMPLATE_REL='docs/runbooks/payloads/source-final-auth-timestamps/index.ts';
export const expectedPins=Object.freeze({
 parentManifestSha256:'67b2bb6c7b72ef39bd66dbb2e008f177fb5b38ae9713e052ad8aee0aa5182ad8',
 inputSha256:'c9e0b5fa1fd207e70f63292ad3a3c69d79218ec6b9185fafd5db0ac44ff6a4d6',
 barrierSha256:'0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6',
 basePreparedSha256:'ed0871f06237339c60218e84185b7d278e0881c5443ffddbbc2a8152e793220f',
 finalPreparedSha256:'a226cfa9eb96fbe9ca2276e20bffc637d04cbd2670417f18dc45f03df63f25a8',
 contextSha256:'564c015f97aea285659304a78437840562bf701e3ed5df55b94f04c9008c5f3b',
 ownerApprovedInputSha256:'68b9789f062a5e3ad0d301afb251a5fb936f75712d6ffafddbd3fe6bda83a2a8',
 verifyFencedSqlSha256:'fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782',
 priorResultSha256:'7987d55b1323c1b4a64aeeac7e8b7050f500f9fc6cf778d973c1b9d0e3cd9aca',
 ownerGrantSha256:'cdc3698799331799d141cee89fe0e0f994477cfc70b8ce90d8f01ac1ec5ede69',
 sourceTemplateSha256:'96176f31b9ccb0ca665b58ef6d0356e73586c5bb6f12c1981b28c7a9d91a27c0',
});
export const sourceRuntimePaths=Object.freeze({
 'migration-audit.mjs':'scripts/migration-audit.mjs',
 'exact-query-fingerprint.mjs':'docs/runbooks/payloads/exact-query-fingerprint.mjs',
 'auth-rows.mjs':'docs/runbooks/payloads/t59-auth-timestamps.mjs',
 'encrypt-snapshot.mjs':'docs/runbooks/payloads/source-https-reader/encrypt-snapshot.mjs',
 'fence-witness.mjs':'docs/runbooks/payloads/source-final-https-reader/fence-witness.mjs',
});
export const runtimeRelativePaths=Object.freeze([
 'scripts/migration-audit.mjs','docs/runbooks/payloads/exact-query-fingerprint.mjs',
 'docs/runbooks/payloads/final-auth-window.mjs','docs/runbooks/payloads/t30-auth-compact.mjs',
 'docs/runbooks/payloads/http-source-admission.mjs','docs/runbooks/payloads/t26-source-admission.mjs',
 'docs/runbooks/payloads/t37-https-inventory.mjs','docs/runbooks/payloads/source-final-https-reader/fence-witness.mjs',
 'docs/runbooks/payloads/t59-auth-timestamps.mjs','docs/runbooks/payloads/t60-final-window-core.mjs',
 'docs/runbooks/payloads/t60-final-https-transport.mjs','docs/runbooks/payloads/t60-source-transfer-budget.mjs',
 'docs/runbooks/payloads/t59-source-transfer-budget.mjs',
]);
const T56_MANIFEST='4db248c8620541a840b19b8fb2ea94bbd74f2763ffd2691fd108c9df8d811593';
const T56_LOADER_SHA='4717f5cf23c8598e7113b824d505df8e1b29e7beb2ceaeddca17b69e30b879bf';
const T56_GUARD_SHA='ddd83ceb039df9616a0cc1f6dae3057ef044a616505c5769f44a849189ba04e7';
const T58_SCOPE_SHA='b1851e8654c739357fe2dd89bd40892b4c57cbe79f57c1b0bc545d1c9ba12a17';
const T58_RESULT_SHA='385e9c2f6e5005b10fb06bb49d78b889ee452ecaa119e89f445b2b04eccee94b';
const T58_GUARD_SHA='0a4c6e1d07e43e84c36f02d3f5ac73d6b2f6cbb0ce4603dc4e9a1563690adaab';
const T58_CLAIM_SHA='6f9700af4cd91d643bc133602cbcdb72da40ceee60eed69025917d6ca953c972';
const COLUMNS=['last_sign_in_at','updated_at'];
export const targetIdentitySql="SELECT current_database() AS database,current_user AS role,session_user AS session_role,\n"+
 " current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,\n"+
 " current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,\n"+
 " current_setting('idle_in_transaction_session_timeout') AS idle_timeout,current_setting('TimeZone') AS timezone,\n"+
 " current_setting('search_path') AS search_path,host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,\n"+
 " current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net";
const sha=value=>createHash('sha256').update(value).digest('hex'),digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=value=>Buffer.from(canonical(value)+'\n'),same=(a,b)=>canonical(a)===canonical(b);
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const parse=raw=>{try{return JSON.parse(raw);}catch{fail('T60_JSON_INVALID');}};

export function validateManifest(raw,pin,selfSha,ackSha){
 if(!digest(pin)||sha(raw)!==pin)fail('T60_MANIFEST_SHA');const m=parse(raw),p=m.phase_authorizations?.prepare_final,r=m.phase_authorizations?.run_final,a=m.approval;
 if(m.task!=='T60'||m.actionId!=='T60.release_window'||m.execution_authorized!==true||m.maxSuccessorWindows!==1||
  !same(m.pins,expectedPins)||!digest(m.t55ReceiptSha256)||!digest(m.t55ResultSha256)||
  m.files?.[REL]!==selfSha||!digest(selfSha)||m.files?.[ACK_REL]!==ackSha||!digest(ackSha)||!digest(m.files?.[TEMPLATE_REL])||
  p?.actionId!=='T60.prepare_final'||p.capability_ttl_seconds!==7200||p.source_data_reads!==0||p.target_metadata_probe!==1||
  r?.actionId!==ACTION||r.applyAuthTimestampsOnly!==true||r.maxAuthTimestampRows!==2||r.sourceFrameBudget!==2||r.priorSourceAuthSnapshotAttempts!==4||
  !same(r.authTimestampColumns,COLUMNS)||r.sourceAuthoritativeAuthTimestamps!==true||r.beforeImagePath!==AUTH_BEFORE||r.wall_seconds!==480||r.targetAdmitted!==false||
  !['APPROVED','OWNER_PROOF_REQUIRED'].includes(a?.status)||!digest(a.document_sha256)||a.maxAuthSnapshots!==6||a.priorUsed!==4||a.sourceFrames!==2||a.maxAuthTimestampRows!==2||
  !same(a.authTimestampColumns,COLUMNS)||a.sourceAuthoritativeAuthTimestamps!==true||a.lastSignInAtValue!==true||a.updatedAtValue!==true||
  a.targetTimestampReconciliation!==true||a.rawCredentials!==false||a.macDataTransit!==false||a.encryptedToVpsRam!==true||
  m.source?.origin!==ORIGIN||m.source.projectRef!==PROJECT||m.source.protocol!==PROTOCOL||m.source.capability_binding!=='pinned_VPS_prepare_readback'||m.source.template_name_prefix!==PREFIX||
  !exact(m.runtime_files,runtimeRelativePaths.map(p=>NEW_RUNTIME+'/'+p))||
  runtimeRelativePaths.some(p=>!digest(m.runtime_files[NEW_RUNTIME+'/'+p])||m.runtime_files[NEW_RUNTIME+'/'+p]!==m.files[p])||
  m.transfer_budget?.directory!==ROOT+'/source-auth-final-e60a2026'||m.transfer_budget.scope_sha256!==a.document_sha256||
  m.transfer_budget.max_attempts!==6||m.transfer_budget.prior_used!==4||m.transfer_budget.source_project!==PROJECT||m.transfer_budget.destination_vps!==VPS)
  fail('T60_SCOPE_INVALID');return m;
}
export function validateOwnerProof(raw,pin,m,mSha){
 if(!digest(pin)||sha(raw)!==pin)fail('T60_OWNER_PROOF_SHA');const p=parse(raw);
 const keys=['format','task','actionId','manifestSha256','ownerGrantSha256','status','scope','maxAuthSnapshots','priorUsed','sourceFrames',
  'sourceProject','destinationVps','encryptedToVpsRam','macDataTransit','rawCredentials','lastSignInAtValue','updatedAtValue',
  'targetTimestampReconciliation','authTimestampColumns','maxAuthTimestampRows','sourceAuthoritativeAuthTimestamps'];
 if(!exact(p,keys)||p.format!==1||p.task!=='T60'||p.actionId!==ACTION||p.manifestSha256!==mSha||p.ownerGrantSha256!==m.approval.document_sha256||
  p.status!=='APPROVED'||p.scope!=='SOURCE_AUTH_TWO_TIMESTAMPS_FINAL_5_6'||p.maxAuthSnapshots!==6||p.priorUsed!==4||p.sourceFrames!==2||
  p.sourceProject!==PROJECT||p.destinationVps!==VPS||p.encryptedToVpsRam!==true||p.macDataTransit!==false||p.rawCredentials!==false||
  p.lastSignInAtValue!==true||p.updatedAtValue!==true||p.targetTimestampReconciliation!==true||!same(p.authTimestampColumns,COLUMNS)||
  p.maxAuthTimestampRows!==2||p.sourceAuthoritativeAuthTimestamps!==true)fail('T60_OWNER_PROOF_SCOPE');return p;
}
// Conditional route metadata is not consent. Only this separately pinned actual
// Root proof can produce an in-memory approved view; the manifest stays immutable.
export function manifestAfterOwnerProof(m,raw,pin,manifestSha){
 validateOwnerProof(raw,pin,m,manifestSha);
 return {...m,approval:{...m.approval,status:'APPROVED'}};
}
export function validatePriorFailure(raw,pin=expectedPins.priorResultSha256){
 if(pin!==expectedPins.priorResultSha256||sha(raw)!==pin)fail('T60_PRIOR_RESULT_SHA');const r=parse(raw);
 if(r.task!=='T45'||r.status!=='BLOCKED'||r.phase!=='source-fence-start'||r.targetWriteOutcome!=='UNCHANGED'||
  r.recovery?.targetWriteOutcome!=='UNCHANGED'||r.recovery?.sourceFrameAttempts!==0||r.recovery?.sourceMustRemainClosed!==true)
  fail('T60_PRIOR_WINDOW_NOT_ZERO_EFFECT');return r;
}
export function validateT55Evidence(receiptRaw,resultRaw,m,cliPin){
 if(!digest(cliPin)||cliPin!==m.t55ReceiptSha256||sha(receiptRaw)!==cliPin||sha(resultRaw)!==m.t55ResultSha256)
  fail('T60_T55_EVIDENCE_SHA');
 const receipt=parse(receiptRaw),r=parse(resultRaw);
 if(receipt.task!=='T55'||receipt.status!=='PASS'||r.task!=='T55'||r.actionId!=='T55.mcp_readiness'||r.status!=='PASS'||r.code!=='T55_AUTOMATIC_MCP_RELAY_PROVEN'||
  r.sourceVerifyPassed!==true||![r.roundTripMs,r.monotonicRoundTripMs].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=30000)||
  r.targetWrites!==0||r.snapshotAttemptsUsed!==0||r.T49Started!==false||r.macDataTransit!==false||
  !Number.isSafeInteger(r.createdEpochMs)||!Number.isSafeInteger(r.completedEpochMs)||r.completedEpochMs-r.createdEpochMs!==r.roundTripMs||
  !digest(r.requestSha256)||!digest(r.responseSha256))fail('T60_T55_NOT_PASS');
 return r;
}
const preparedKeys=['task','actionId','manifestSha256','ownerGrantSha256','origin','projectRef','destinationVps','protocol',
 'ownerApprovalSha256','createdUtc','expiresUtc','capabilitySha256','functionName','controlSummarySha256','controlReceiptSha256','independentKeyProofSha256','fenceContextSha256'];
export function createPrepared({manifestSha256,controlEvidence,now=Date.now(),random=randomBytes,writeSecret}){
 if(!digest(manifestSha256)||!['controlSummarySha256','controlReceiptSha256','independentKeyProofSha256','ownerGrantSha256','ownerApprovalSha256'].every(k=>digest(controlEvidence?.[k]))||
  !Number.isSafeInteger(now)||now<0||now>8640000000000000-7200000||typeof writeSecret!=='function')fail('T60_PREPARE_ARGUMENTS');
 const entropy=random(32);if(!Buffer.isBuffer(entropy)||entropy.length!==32)fail('T60_ENTROPY');
 const secret=Buffer.from(entropy.toString('hex'),'ascii');entropy.fill(0);
 try{writeSecret(secret);const capabilitySha256=sha(secret);return {
  task:'T60',actionId:ACTION,manifestSha256,ownerGrantSha256:controlEvidence.ownerGrantSha256,ownerApprovalSha256:controlEvidence.ownerApprovalSha256,origin:ORIGIN,projectRef:PROJECT,destinationVps:VPS,protocol:PROTOCOL,
  createdUtc:new Date(now).toISOString(),expiresUtc:new Date(now+7200000).toISOString(),capabilitySha256,functionName:PREFIX+capabilitySha256.slice(0,12),
  controlSummarySha256:controlEvidence.controlSummarySha256,controlReceiptSha256:controlEvidence.controlReceiptSha256,
  independentKeyProofSha256:controlEvidence.independentKeyProofSha256,fenceContextSha256:expectedPins.contextSha256,
 };}finally{secret.fill(0);}
}
export function validatePrepared(raw,pin,manifestSha,control,now=Date.now(),headroomMs=140000){
 if(!digest(pin)||sha(raw)!==pin)fail('T60_PREPARED_SHA');const p=parse(raw),created=Date.parse(p.createdUtc),expires=Date.parse(p.expiresUtc);
 if(!exact(p,preparedKeys)||p.task!=='T60'||p.actionId!==ACTION||p.manifestSha256!==manifestSha||
  p.ownerGrantSha256!==control.ownerGrantSha256||p.ownerApprovalSha256!==control.ownerApprovalSha256||p.origin!==ORIGIN||p.projectRef!==PROJECT||p.destinationVps!==VPS||p.protocol!==PROTOCOL||
  !digest(p.capabilitySha256)||p.functionName!==PREFIX+p.capabilitySha256.slice(0,12)||p.fenceContextSha256!==expectedPins.contextSha256||
  !['controlSummarySha256','controlReceiptSha256','independentKeyProofSha256'].every(k=>p[k]===control[k])||
  !Number.isSafeInteger(now)||!Number.isSafeInteger(headroomMs)||headroomMs<140000||
  !Number.isSafeInteger(created)||!Number.isSafeInteger(expires)||new Date(created).toISOString()!==p.createdUtc||
  new Date(expires).toISOString()!==p.expiresUtc||expires-created!==7200000||created>now+5000||now+headroomMs>=expires)
  fail('T60_PREPARED_INVALID');return p;
}
export function expectedSourceFiles(templateRaw,p,context,m){
 if(!digest(m.files?.[TEMPLATE_REL])||sha(templateRaw)!==m.files[TEMPLATE_REL]||sha(JSON.stringify(context))!==expectedPins.contextSha256)fail('T60_SOURCE_TEMPLATE_OR_CONTEXT');
 let text=templateRaw.toString('utf8');for(const [from,to]of Object.entries({'{{CAPABILITY_SHA256}}':p.capabilitySha256,'{{EXPIRES_EPOCH_MS}}':String(Date.parse(p.expiresUtc)),
  '{{FENCE_CONTEXT_JSON}}':JSON.stringify(context),'{{FENCE_CONTEXT_SHA256}}':expectedPins.contextSha256})){
  if(text.split(from).length!==2)fail('T60_TEMPLATE_PLACEHOLDER');text=text.replace(from,to);
 }
 if(/\{\{[A-Z_]+\}\}/.test(text))fail('T60_TEMPLATE_PLACEHOLDER');
 const hashes=Object.fromEntries(Object.entries(sourceRuntimePaths).map(([name,p])=>{if(!digest(m.files?.[p]))fail('T60_SOURCE_FILE_PIN');return [name,m.files[p]];}));
 return {'index.ts':sha(text),...hashes};
}
export function validateDeployment(raw,pin,mSha,preparedRaw,p,files,now=Date.now()){
 if(!digest(pin)||sha(raw)!==pin)fail('T60_DEPLOYMENT_SHA');const d=parse(raw),observed=Date.parse(d.observedUtc);
 if(!exact(d,['format','task','actionId','manifestSha256','preparedSha256','sourceProject','functionName','capabilitySha256','expiresUtc',
  'fenceContextSha256','sourceBarrierReceiptSha256','status','version','verifyJwt','entrypointPath','executableFileHashes','exactRuntimeReadback','preflightGet','observedUtc'])||
  d.format!==1||d.task!=='T60'||d.actionId!=='T60.data_deployment'||d.manifestSha256!==mSha||d.preparedSha256!==sha(preparedRaw)||
  d.sourceProject!==PROJECT||d.functionName!==p.functionName||d.capabilitySha256!==p.capabilitySha256||d.expiresUtc!==p.expiresUtc||
  d.fenceContextSha256!==expectedPins.contextSha256||d.sourceBarrierReceiptSha256!==expectedPins.barrierSha256||
  d.status!=='ACTIVE'||!Number.isSafeInteger(d.version)||d.version<1||d.verifyJwt!==false||d.entrypointPath!=='index.ts'||
  !same(d.executableFileHashes,files)||d.exactRuntimeReadback!==true||
  !exact(d.preflightGet,['status','purpose','tlsVerified'])||d.preflightGet.status!==403||d.preflightGet.purpose!==PROTOCOL||d.preflightGet.tlsVerified!==true||
  !Number.isSafeInteger(observed)||new Date(observed).toISOString()!==d.observedUtc||observed<Date.parse(p.createdUtc)-5000||observed>now+5000)
  fail('T60_DEPLOYMENT_NOT_VERIFIED');return d;
}
export function validateCoordinatorReady(raw,pin,manifestSha,now=Date.now()){
 if(!digest(pin)||sha(raw)!==pin)fail('T60_READY_SHA');const r=parse(raw);
 const fields=['format','task','actionId','status','manifestSha256','sourceProject','sourceBarrierActionId','sourceBarrierReceiptSha256',
  'verifyFencedSqlSha256','connector','workerId','mcpWorkerReady','sourceVerifyPassed','nonceSha256','createdEpochMs','completedEpochMs','roundTripMs','sourceCheckedMicros','observedUtc'];
 if(!exact(r,fields)||r.format!==1||r.task!=='T60'||r.actionId!=='T60.coordinator_ready'||r.status!=='COORDINATOR_READY'||
  r.manifestSha256!==manifestSha||r.sourceProject!==PROJECT||r.sourceBarrierActionId!==BARRIER_ACTION||
  r.sourceBarrierReceiptSha256!==expectedPins.barrierSha256||r.verifyFencedSqlSha256!==expectedPins.verifyFencedSqlSha256||
  r.connector!=='Supabase MCP'||typeof r.workerId!=='string'||!/^[A-Za-z0-9_./-]{1,128}$/.test(r.workerId)||
  r.mcpWorkerReady!==true||r.sourceVerifyPassed!==true||!digest(r.nonceSha256)||
  ![r.createdEpochMs,r.completedEpochMs,r.roundTripMs,now].every(Number.isSafeInteger)||r.createdEpochMs>r.completedEpochMs||
  r.roundTripMs!==r.completedEpochMs-r.createdEpochMs||r.roundTripMs<0||r.roundTripMs>30000||r.completedEpochMs>now+5000||
  now-r.completedEpochMs>30000||r.observedUtc!==new Date(r.completedEpochMs).toISOString()||
  typeof r.sourceCheckedMicros!=='string'||!/^[0-9]{12,20}$/.test(r.sourceCheckedMicros)||
  BigInt(r.sourceCheckedMicros)<BigInt(r.createdEpochMs-5000)*1000n||BigInt(r.sourceCheckedMicros)>BigInt(r.completedEpochMs+5000)*1000n)
  fail('T60_COORDINATOR_NOT_READY');return r;
}
export function activationFromPrepared(p,manifestSha,context,barrier,m){
 if(p.task!=='T60'||p.manifestSha256!==manifestSha||p.ownerGrantSha256!==m.approval.document_sha256||p.fenceContextSha256!==expectedPins.contextSha256||
  sha(JSON.stringify(context))!==expectedPins.contextSha256)fail('T60_ACTIVATION_BINDING');
 const shared={authTimestampColumns:[...COLUMNS],maxAuthTimestampRows:2,sourceAuthoritativeAuthTimestamps:true};
 const activation={reviewed:true,actionId:ACTION,manifestSha256:manifestSha,sourceBarrierActionId:BARRIER_ACTION,
  sourceBarrierReceiptSha256:expectedPins.barrierSha256,fenceContextSha256:expectedPins.contextSha256,
  ownerDataGrantEvidenceSha256:m.approval.document_sha256,targetAdmitted:false,sourceRoute:'fixed-source-edge-https',
  targetRoute:'verified-loopback-15433',expectedAuthRows:16,sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:4,
  applyAuthTimestampsOnly:true,...shared,beforeImagePath:AUTH_BEFORE};
 const ownerDataGrant={reviewed:true,evidenceSha256:m.approval.document_sha256,scope:'source-auth-two-timestamps-fixed-snapshot-to-vps',
  sourceProject:PROJECT,destinationVps:VPS,credentialDerivedAuthDigests:true,readonlySource:true,encryptedToVpsRam:true,macDataTransit:false,
  maxAuthSnapshots:6,lastSignInAtValue:true,updatedAtValue:true,targetTimestampReconciliation:true,...shared};
 const barrierProof={sourceBarrierActionId:BARRIER_ACTION,sourceBarrierReceiptSha256:expectedPins.barrierSha256,
  normalConnectDenied:barrier.normalConnectDenied,existingClientsDrained:barrier.existingClientsDrained,freshOwnerReconnect:barrier.freshOwnerReconnect,
  providerBoundaryReviewed:barrier.providerBoundaryReviewed,durableOnVps:barrier.durableOnVps,sourcePaused:barrier.sourcePaused};
 return {activation,ownerDataGrant,fenceContext:structuredClone(context),prepared:structuredClone(p),barrierProof};
}
function directory(p){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||
 (s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T60_PRIVATE_DIRECTORY');}
function read(p,max=4194304,lock=false){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||s.size<1||s.size>max||
  (lock?(s.mode&0o022)!==0:(s.mode&0o7777)!==0o600))fail('T60_PRIVATE_FILE');
  const raw=fs.readFileSync(fd),a=fs.fstatSync(fd),n=fs.lstatSync(p);if(raw.length!==s.size||s.size!==a.size||
   s.mtimeMs!==a.mtimeMs||s.ctimeMs!==a.ctimeMs||s.dev!==n.dev||s.ino!==n.ino)fail('T60_FILE_CHANGED');return raw;
 }finally{fs.closeSync(fd);}}
function absent(names){for(const p of names)try{fs.lstatSync(p);fail('T60_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}
function write(p,value,onClaim){if(path.dirname(p)!==DIR&&p!==AUTH_BEFORE)fail('T60_WRITE_PATH');directory(path.dirname(p));const raw=Buffer.isBuffer(value)?value:bytes(value);
 const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{onClaim?.();fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(d);}finally{fs.closeSync(d);}if(!read(p).equals(raw))fail('T60_WRITE_READBACK');return sha(raw);}
function stdin(max=32768){const out=Buffer.alloc(max+1);let used=0;for(;;){const n=fs.readSync(0,out,used,out.length-used,null);
 if(!n)break;used+=n;if(used>max)fail('T60_STDIN_BOUND');}return out.subarray(0,used);}
const safeCode=e=>/^(?:T60_|T45_|FINAL_HTTPS_|COORDINATOR_FENCE_|SOURCE_TRANSFER_|OWNER_PROOF_)[A-Z0-9_]+$/.test(e?.code??'')?e.code:/^[A-Z0-9]{5}$/.test(e?.code??'')?e.code:'T60_FAILED';
export function parseArguments(argv){
 const modes=['--prepare-final','--prepare-ready','--accept-ready','--run-final'],mode=argv[0],opts={};
 if(!modes.includes(mode)||(argv.length-1)%2!==0)fail('T60_EXPLICIT_INPUT_REQUIRED');
 for(let i=1;i<argv.length;i+=2){if(Object.hasOwn(opts,argv[i]))fail('T60_EXPLICIT_INPUT_REQUIRED');opts[argv[i]]=argv[i+1];}
 const keys=['--manifest','--sha256','--t55-receipt-sha256'];
 if(mode==='--prepare-final')keys.push('--owner-approval-sha256');
 if(mode!=='--prepare-final')keys.push('--prepared-sha256','--deployment-proof-sha256');
 if(mode==='--run-final')keys.push('--ready-input-sha256');
 if(!exact(opts,keys)||opts['--manifest']!==MANIFEST||keys.filter(k=>k!=='--manifest').some(k=>!digest(opts[k])))
  fail('T60_EXPLICIT_INPUT_REQUIRED');return {mode,opts};
}
function loadArchive(parent,control,validateWitness){
 const rawInput=read(OLD+'/fence-input.json'),base=read(OLD+'/final-base-prepared.json'),final=read(OLD+'/final-prepared.json'),barrierRaw=read(OLD+'/source-barrier.json');
 for(const [raw,h]of [[rawInput,expectedPins.inputSha256],[base,expectedPins.basePreparedSha256],[final,expectedPins.finalPreparedSha256],[barrierRaw,expectedPins.barrierSha256]])
  if(sha(raw)!==h)fail('T60_ARCHIVE_SHA');
 const input=parse(rawInput),barrier=parse(barrierRaw),context=input.fenceContext;
 if(input.task!=='T45'||input.actionId!=='T45.final_https_window'||input.manifestSha256!==expectedPins.parentManifestSha256||
  input.basePreparedSha256!==sha(base)||input.finalPreparedSha256!==sha(final)||input.barrierReceiptSha256!==sha(barrierRaw)||
  input.controlSummarySha256!==control.controlSummarySha256||input.controlReceiptSha256!==control.controlReceiptSha256||
  input.fenceContextSha256!==expectedPins.contextSha256||sha(JSON.stringify(context))!==expectedPins.contextSha256||
  barrier.task!=='T45'||barrier.actionId!==BARRIER_ACTION||barrier.manifestSha256!==expectedPins.parentManifestSha256||
  barrier.controlReceiptSha256!==control.controlReceiptSha256||barrier.status!=='SOURCE_ADMISSION_CLOSED'||
  barrier.sourceProject!==PROJECT||barrier.destinationVps!==VPS||barrier.sourcePaused!==false||
  ['normalConnectDenied','existingClientsDrained','freshOwnerReconnect','providerBoundaryReviewed','durableOnVps'].some(k=>barrier[k]!==true)||
  !same(context.before,barrier.before)||!same(context.boundary,barrier.boundary)||context.sourceBarrierActionId!==BARRIER_ACTION||
  context.sourceBarrierReceiptSha256!==expectedPins.barrierSha256)fail('T60_ARCHIVE_BINDING');
 try{validateWitness({before:context.before,boundary:context.boundary,witness:barrier.witness});}catch{fail('T60_ARCHIVE_WITNESS');}
 validatePriorFailure(read(OLD+'/final-result.json'));const guardRaw=read(OLD+'/final-run.guard'),g=parse(guardRaw);
 if(g.task!=='T45'||g.actionId!=='T45.final_https_window'||g.manifestSha256!==expectedPins.parentManifestSha256||g.inputSha256!==expectedPins.inputSha256)
  fail('T60_ARCHIVE_GUARD');
 absent([ROOT+'/t45-auth-before-c45a2026.json',ROOT+'/t49-auth-before-c49a2026.json',ROOT+'/t49-release/final-run.guard',ROOT+'/t49-release/final-result.json']);
 return {context,barrier,oldGuardSha256:sha(guardRaw)};
}
async function readPriorState(control){
 for(const p of [ROOT+'/t53-release',ROOT+'/t56-release',ROOT+'/t58-release',ROOT+'/source-auth-extension-e58a2026'])directory(p);
 const oldHelper=read(ROOT+'/t56-final-window.mjs');if(sha(oldHelper)!==T56_LOADER_SHA)fail('T60_T56_LOADER_SHA');
 const {validatePriorT53Custody}=await import('file://'+ROOT+'/t56-final-window.mjs');
 const t53={manifestRaw:read(ROOT+'/t53-release/manifest.json'),preparedRaw:read(ROOT+'/t53-release/final-prepared.json'),resultRaw:read(ROOT+'/t53-release/prepare-result.json'),guardRaw:read(ROOT+'/t53-release/prepare.guard')};
 const custody=read(ROOT+'/t56-release/prior-t53-archive.json');validatePriorT53Custody(custody,t53,T56_MANIFEST,control);
 const t58Scope=read(ROOT+'/source-auth-extension-e58a2026/scope.json');if(sha(t58Scope)!==T58_SCOPE_SHA)fail('T60_T58_SCOPE_SHA');
 const scope=parse(t58Scope),t56=read(ROOT+'/t56-release/final-result.json'),r56=parse(t56),g56=read(ROOT+'/t56-release/final-run.guard');
 if(sha(g56)!==T56_GUARD_SHA||sha(t56)!==scope.parentResultSha256||sha(read(ROOT+'/t56-release/manifest.json'))!==T56_MANIFEST||r56.status!=='BLOCKED'||
  r56.code!=='FINAL_HTTPS_NON_TIMESTAMP_OR_DIRECTION_DIFF'||r56.targetWriteOutcome!=='UNCHANGED'||r56.recovery?.sourceFrameAttempts!==1||r56.recovery?.beforeImage!==null)
  fail('T60_T56_NOT_ZERO_WRITE');
 for(const [p,h]of [[ROOT+'/t58-release/result.json',T58_RESULT_SHA],[ROOT+'/t58-release/run.guard',T58_GUARD_SHA],[ROOT+'/source-auth-extension-e58a2026/attempt-3.json',T58_CLAIM_SHA]])
  if(sha(read(p))!==h)fail('T60_T58_CHANGED');
 absent([ROOT+'/t56-auth-before-c56a2026.json']);
 return {t56ResultSha256:sha(t56),t56GuardSha256:sha(g56),t53CustodySha256:sha(custody),t53:Object.fromEntries(Object.entries(t53).map(([k,v])=>[k,sha(v)])),t58ScopeSha256:sha(t58Scope)};
}
function readyChallenge(request,raw){return {...request,requestPath:DIR+'/coordinator-ready.request.json',ackPath:DIR+'/coordinator-ready.json',
 requestSha256:sha(raw),storageUid:0,storageGid:0,storageMode:384};}
export function validateReadyResponse(raw,requestRaw,manifestSha,completed,monotonicElapsed){
 const request=parse(requestRaw),challenge=readyChallenge(request,requestRaw),r=parse(raw),fields=['format','protocol','task','actionId','manifestSha256','sourceProject',
  'sourceBarrierActionId','sourceBarrierReceiptSha256','verifyFencedSqlSha256','requestSha256','contextSha256','nonceSha256','sourceCheckedMicros','workerId','connector'];
 if(!exact(request,['format','protocol','actionId','manifestSha256','sourceProject','sourceBarrierActionId','sourceBarrierReceiptSha256',
  'verifyFencedSqlSha256','stage','nonceSha256','createdEpochMs','expiresEpochMs'])||!bytes(request).equals(requestRaw)||request.format!==1||
  request.protocol!=='T60.preflight_nonce'||request.actionId!=='T60.coordinator_ready'||request.manifestSha256!==manifestSha||request.sourceProject!==PROJECT||
  request.sourceBarrierActionId!==BARRIER_ACTION||request.sourceBarrierReceiptSha256!==expectedPins.barrierSha256||
  request.verifyFencedSqlSha256!==expectedPins.verifyFencedSqlSha256||request.stage!=='ready'||!digest(request.nonceSha256)||
  ![request.createdEpochMs,request.expiresEpochMs].every(Number.isSafeInteger)||request.expiresEpochMs-request.createdEpochMs!==60000||
  !exact(r,fields)||r.format!==1||r.protocol!=='BRON_T60_READY_RESPONSE_V1'||r.task!=='T60'||r.actionId!=='T60.coordinator_ready'||
  r.manifestSha256!==manifestSha||r.sourceProject!==PROJECT||r.sourceBarrierActionId!==BARRIER_ACTION||r.sourceBarrierReceiptSha256!==expectedPins.barrierSha256||
  r.verifyFencedSqlSha256!==expectedPins.verifyFencedSqlSha256||r.requestSha256!==sha(requestRaw)||r.contextSha256!==sha(bytes(challenge))||
  r.nonceSha256!==request.nonceSha256||r.connector!=='Supabase MCP'||typeof r.workerId!=='string'||!/^[A-Za-z0-9_./-]{1,128}$/.test(r.workerId)||
  !Number.isSafeInteger(completed)||!Number.isSafeInteger(monotonicElapsed)||completed<request.createdEpochMs||completed>=request.expiresEpochMs||
  completed-request.createdEpochMs>30000||monotonicElapsed<0||monotonicElapsed>30000||Math.abs(monotonicElapsed-(completed-request.createdEpochMs))>1000||
  typeof r.sourceCheckedMicros!=='string'||!/^[0-9]{12,20}$/.test(r.sourceCheckedMicros)||
  BigInt(r.sourceCheckedMicros)<BigInt(request.createdEpochMs-5000)*1000n||BigInt(r.sourceCheckedMicros)>BigInt(completed+5000)*1000n)
  fail('T60_READY_RESPONSE_INVALID');
 const ready={format:1,task:'T60',actionId:'T60.coordinator_ready',status:'COORDINATOR_READY',manifestSha256:manifestSha,
  sourceProject:PROJECT,sourceBarrierActionId:BARRIER_ACTION,sourceBarrierReceiptSha256:expectedPins.barrierSha256,
  verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256,connector:'Supabase MCP',workerId:r.workerId,mcpWorkerReady:true,
  sourceVerifyPassed:true,nonceSha256:r.nonceSha256,createdEpochMs:request.createdEpochMs,completedEpochMs:completed,
  roundTripMs:completed-request.createdEpochMs,sourceCheckedMicros:r.sourceCheckedMicros,observedUtc:new Date(completed).toISOString()};
 validateCoordinatorReady(bytes(ready),sha(bytes(ready)),manifestSha,completed);return ready;
}
async function main(){let phase='preflight',target,ack,timer,guarded=false,preparedGuarded=false,readyGuarded=false,lastFenceFailure,result,budgetBinding,budget;
 const abort=new AbortController(),interrupt=()=>{abort.abort();target?.connection?.stream?.destroy();};
 result={task:'T60',status:'BLOCKED',actionId:ACTION,targetWriteOutcome:'UNCHANGED',sourceMustRemainClosed:true,macDataTransit:false};
 try{
  const {mode,opts}=parseArguments(process.argv.slice(2)),manifestSha=opts['--sha256'];
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||
   fileURLToPath(import.meta.url)!==SELF||process.env.NODE_TEST_CONTEXT||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||process.env.NODE_PG_FORCE_NATIVE||
   !Object.values(networkInterfaces()).flat().some(i=>i?.address===VPS))fail('T60_PINNED_VPS_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const p of ['/root',ROOT,OLD,DIR,RUNTIME,NEW_RUNTIME])directory(p);
  const m=validateManifest(read(MANIFEST),manifestSha,sha(read(SELF)),sha(read(ACK))),templateRaw=read(TEMPLATE);
  if(sha(templateRaw)!==m.files[TEMPLATE_REL])fail('T60_TEMPLATE_SHA');
  validateT55Evidence(read(ROOT+'/t55-release-receipt.json'),read(ROOT+'/t55-mcp-readiness/result.json'),m,opts['--t55-receipt-sha256']);
  const parentRaw=read(OLD+'/manifest.json');if(sha(parentRaw)!==expectedPins.parentManifestSha256)fail('T60_PARENT_SHA');const initial=parse(parentRaw);
  for(const [p,h]of Object.entries(initial.runtime_files??{})){if(!p.startsWith(RUNTIME+'/')||sha(read(p))!==h)fail('T60_OLD_RUNTIME_SHA');directory(path.dirname(p));}
  for(const [p,h]of Object.entries(m.runtime_files)){if(sha(read(p))!==h)fail('T60_RUNTIME_SHA');directory(path.dirname(p));}
  const old=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-final-window.mjs'),owner=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-control-ready.mjs');
  old.validateManifest(parentRaw,expectedPins.parentManifestSha256,sha(read(RUNTIME+'/docs/runbooks/payloads/t45-final-window.mjs')));
  const parent=owner.loadOwnerManifest(initial,expectedPins.parentManifestSha256,expectedPins.ownerApprovedInputSha256);
  if(!same(m.target,parent.target))fail('T60_TARGET_SCOPE_CHANGED');
  const ownerProofRaw=read(DIR+'/owner-approval.json'),ownerProofSha=mode==='--prepare-final'?opts['--owner-approval-sha256']:parse(read(DIR+'/final-prepared.json')).ownerApprovalSha256;
  const effectiveManifest=manifestAfterOwnerProof(m,ownerProofRaw,ownerProofSha,manifestSha);
  const oldControl=old.validateControlEvidence({summaryBytes:read(OLD+'/control-ready-result.json'),controlBytes:read(ROOT+'/t40-admission-control-c40a2026.json'),keyProofBytes:read(ROOT+'/t40-admission-key-proof-c40a2026.json')},parent,expectedPins.parentManifestSha256);
  const control={...oldControl,ownerGrantSha256:m.approval.document_sha256,ownerApprovalSha256:ownerProofSha};
  for(const [p,h]of [[ROOT+'/t40-admission-before-c40a2026.json',parent.input_evidence.T40_before_image_sha256],[ROOT+'/t40-admission-metadata-c40a2026.json',parent.input_evidence.T40_metadata_receipt_sha256],[control.inversePath,control.inverseSha256]])
   if(sha(read(p))!==h)fail('T60_ADOPTED_INPUT_CHANGED');
  const witness=await import('file://'+RUNTIME+'/docs/runbooks/payloads/http-source-admission.mjs'),archived=loadArchive(parent,control,witness.validateFreshOwnerWitness),prior=await readPriorState(control);
  budget=await import('file://'+NEW_RUNTIME+'/docs/runbooks/payloads/t60-source-transfer-budget.mjs');
  budgetBinding={directory:ROOT+'/source-auth-final-e60a2026',ownerGrantSha256:m.approval.document_sha256,manifestSha256:manifestSha,sourceProject:PROJECT,destinationVps:VPS,maxAttempts:6,priorUsed:4};
  if(sha(read(LOCK,4194304,true))!==LOCK_SHA||parse(fs.readFileSync(PG+'/package.json')).version!=='8.23.1')fail('T60_DRIVER_PIN');
  const {default:pg}=await import('file://'+PG+'/lib/index.js');
  const records=parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],{encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
  const config=old.targetFromInspect(records,parent),{databaseConfig}=await import('file://'+RUNTIME+'/scripts/database-config.mjs');
  const openTarget=()=>new pg.Client({...databaseConfig(config.url,{BRON_DB_ALLOW_LOCAL_PLAIN:'1'}),options:'-c default_transaction_read_only=on',query_timeout:6000,application_name:'bron-t60-final-target'});
  if(mode==='--prepare-final'){
   absent([AUTH_BEFORE,ROOT+'/source-auth-final-e60a2026',...['prepare.guard','prepare-result.json','final-capability','final-prepared.json','final-run.guard','final-result.json'].map(n=>DIR+'/'+n)]);
   phase='target-preflight';target=openTarget();target.on('error',()=>{});const probe=await old.probeTargetMetadata(target,config.addresses);
   phase='prepare-final';const status=budget.prepareBudget(budgetBinding);if(status.used!==4||status.remaining!==2||status.uncertain!==false)fail('T60_INITIAL_BUDGET');
   write(DIR+'/prepare.guard',{task:'T60',actionId:'T60.prepare_final',manifestSha256:manifestSha,t55ReceiptSha256:m.t55ReceiptSha256,ownerApprovalSha256:ownerProofSha,startedUtc:new Date().toISOString()},()=>{preparedGuarded=true;});
   const prepared=createPrepared({manifestSha256:manifestSha,controlEvidence:control,writeSecret:raw=>write(DIR+'/final-capability',raw)});
   const preparedSha256=write(DIR+'/final-prepared.json',prepared),files=expectedSourceFiles(templateRaw,prepared,archived.context,m);
   result={...result,...prepared,status:'FINAL_READY',preparedSha256,expectedExecutableFileHashes:files,targetMetadataProbe:probe,authBudgetUsed:4,authBudgetRemaining:2,oldT45Unchanged:true,oldT53Unchanged:true,oldT56Unchanged:true,oldT58Unchanged:true,oldT59Unchanged:true};
  }else{
   const preparedRaw=read(DIR+'/final-prepared.json'),prepared=validatePrepared(preparedRaw,opts['--prepared-sha256'],manifestSha,control);
   const files=expectedSourceFiles(templateRaw,prepared,archived.context,m);validateDeployment(read(DIR+'/deployment-proof.json'),opts['--deployment-proof-sha256'],manifestSha,preparedRaw,prepared,files);
   const status=budget.readBudgetStatus(budgetBinding);if(status.used!==4||status.remaining!==2||status.uncertain!==false)fail('T60_INITIAL_BUDGET');
   if(mode==='--prepare-ready'){
    phase='prepare-ready';absent(['coordinator-ready.request.json','coordinator-ready.guard.json','coordinator-ready.accept.guard','coordinator-ready.response.json','coordinator-ready.json','final-run.guard','final-result.json'].map(n=>DIR+'/'+n));
    const startMono=process.hrtime.bigint(),created=Date.now(),entropy=randomBytes(32),nonceSha256=sha(entropy);entropy.fill(0);
    const request={format:1,protocol:'T60.preflight_nonce',actionId:'T60.coordinator_ready',manifestSha256:manifestSha,sourceProject:PROJECT,sourceBarrierActionId:BARRIER_ACTION,
     sourceBarrierReceiptSha256:expectedPins.barrierSha256,verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256,stage:'ready',nonceSha256,createdEpochMs:created,expiresEpochMs:created+60000};
    const raw=bytes(request);write(DIR+'/coordinator-ready.request.json',raw);write(DIR+'/coordinator-ready.guard.json',{task:'T60',actionId:'T60.coordinator_ready',requestSha256:sha(raw),createdMonotonicNs:String(startMono)});
    console.log('COORDINATOR_READY_CHALLENGE',JSON.stringify(readyChallenge(request,raw)));result={...result,status:'READY_CHALLENGE_PREPARED'};
   }else if(mode==='--accept-ready'){
    phase='accept-ready';absent(['coordinator-ready.accept.guard','coordinator-ready.response.json','coordinator-ready.json','final-run.guard','final-result.json'].map(n=>DIR+'/'+n));
    const rawRequest=read(DIR+'/coordinator-ready.request.json',16384),g=parse(read(DIR+'/coordinator-ready.guard.json',16384));
    if(!exact(g,['task','actionId','requestSha256','createdMonotonicNs'])||g.task!=='T60'||g.actionId!=='T60.coordinator_ready'||g.requestSha256!==sha(rawRequest)||!/^\d{1,30}$/.test(g.createdMonotonicNs))fail('T60_READY_GUARD');
    write(DIR+'/coordinator-ready.accept.guard',{task:'T60',actionId:'T60.coordinator_ready',requestSha256:sha(rawRequest),completedAttempts:1},()=>{readyGuarded=true;});
    const raw=stdin(),received=Date.now(),mono=Number((process.hrtime.bigint()-BigInt(g.createdMonotonicNs))/1000000n);validateReadyResponse(raw,rawRequest,manifestSha,received,mono);write(DIR+'/coordinator-ready.response.json',raw);
    const completed=Date.now(),elapsed=Number((process.hrtime.bigint()-BigInt(g.createdMonotonicNs))/1000000n),ready=validateReadyResponse(raw,rawRequest,manifestSha,completed,elapsed),readySha256=write(DIR+'/coordinator-ready.json',ready);
    result={...result,status:'COORDINATOR_READY',readySha256,roundTripMs:ready.roundTripMs};
   }else{
    absent([AUTH_BEFORE,DIR+'/final-run.guard',DIR+'/final-result.json']);validateCoordinatorReady(read(DIR+'/coordinator-ready.json'),opts['--ready-input-sha256'],manifestSha);validatePrepared(preparedRaw,opts['--prepared-sha256'],manifestSha,control,Date.now(),620000);
    const projected=activationFromPrepared(prepared,manifestSha,archived.context,archived.barrier,m),token=read(DIR+'/final-capability',64).toString('utf8');if(!/^[a-f0-9]{64}$/.test(token)||sha(token)!==prepared.capabilitySha256)fail('T60_CAPABILITY_SHA');
    const transportModule=await import('file://'+NEW_RUNTIME+'/docs/runbooks/payloads/t60-final-https-transport.mjs'),core=await import('file://'+NEW_RUNTIME+'/docs/runbooks/payloads/t60-final-window-core.mjs'),{createCoordinatorFenceAck}=await import('file://'+ACK);
    phase='activation';write(DIR+'/final-run.guard',{task:'T60',actionId:ACTION,manifestSha256:manifestSha,preparedSha256:sha(preparedRaw),deploymentProofSha256:opts['--deployment-proof-sha256'],readySha256:opts['--ready-input-sha256'],ownerApprovalSha256:ownerProofSha,startedUtc:new Date().toISOString()},()=>{guarded=true;});
    timer=setTimeout(interrupt,480000);process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
    const transport=await transportModule.createFinalHttpsTransport({activation:projected.activation,taskManifest:effectiveManifest,prepared,token,fenceContext:archived.context,fenceContextSha256:expectedPins.contextSha256,signal:abort.signal,onBudgetClaim:claim=>write(DIR+'/final-source-'+claim.stage+'-claim.json',claim)});
    ack=createCoordinatorFenceAck({activation:{reviewed:true,actionId:ACTION,manifestSha256:manifestSha,sourceProject:PROJECT,sourceBarrierActionId:BARRIER_ACTION,sourceBarrierReceiptSha256:expectedPins.barrierSha256,verifyFencedSqlSha256:expectedPins.verifyFencedSqlSha256},barrierProof:projected.barrierProof,signal:abort.signal,timeoutMs:60000});
    phase='target-connect';target=openTarget();target.on('error',()=>{});await target.connect();phase='final-window';
    const final=await core.runFinalHttpsWindow({activation:projected.activation,ownerDataGrant:projected.ownerDataGrant,fenceContext:archived.context,captureSourceFrame:transport.captureSourceFrame,target,
     verifyTarget:async client=>{if(abort.signal.aborted)fail('T60_ABORTED');const rows=(await client.query(targetIdentitySql)).rows;if(rows.length!==1)fail('T60_TARGET_IDENTITY');old.verifyFinalTargetIdentity(rows[0],config.addresses);},
     assertFence:async stage=>{try{return await ack.assertFence(stage);}catch(e){lastFenceFailure={task:'T60',stage,code:safeCode(e),observedUtc:new Date().toISOString(),sourceMustRemainClosed:true};try{write(DIR+'/fence-failure-'+stage+'.json',lastFenceFailure);}catch{lastFenceFailure.diagnosticWriteFailed=true;}throw e;}},
     persistBeforeImage:value=>({path:AUTH_BEFORE,sha256:write(AUTH_BEFORE,value),durable:true,fsynced:true,rootOwned:true,mode:'0600'})});
    result={...result,...final};const after=budget.readBudgetStatus(budgetBinding);if(after.used!==6||after.remaining!==0||after.uncertain!==false)fail('T60_FINAL_BUDGET');
    if(sha(read(OLD+'/final-result.json'))!==expectedPins.priorResultSha256||sha(read(OLD+'/final-run.guard'))!==archived.oldGuardSha256||!same(await readPriorState(control),prior))fail('T60_PRIOR_STATE_CHANGED');
    result={...result,authBudgetUsed:after.used,oldT45Unchanged:true,oldT53Unchanged:true,oldT56Unchanged:true,oldT58Unchanged:true,oldT59Unchanged:true};
   }
  }
 }catch(e){const uncertain=e?.budgetUncertain===true||e?.claimMayBeConsumed===true||/^T60_BUDGET_|^T60_PRIOR_STATE_CHANGED/.test(e?.code??'')||/^T60_BUDGET_/.test(e?.upstreamCode??'');result={...result,status:'BLOCKED',phase:e?.phase??phase,code:safeCode(e),...(lastFenceFailure?{fenceFailure:lastFenceFailure}:{}),
  ...(/^[A-Z0-9_]{1,128}$/.test(e?.upstreamCode??'')?{upstreamCode:e.upstreamCode}:{}),
  ...(Array.isArray(e?.mismatchGroups)&&e.mismatchGroups.length<=100&&e.mismatchGroups.every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:]{1,160}$/.test(x))?{mismatchGroups:e.mismatchGroups}:{}),
  ...(e?.authPlanSummary?{authPlanSummary:e.authPlanSummary}:{}),...(e?.recovery?{recovery:e.recovery,targetWriteOutcome:e.recovery.targetWriteOutcome}:{}),...(uncertain?{budgetUncertain:true}:{})};}
 finally{clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);abort.abort();try{ack?.close();}catch{}
  target?.connection?.stream?.destroy();let closeTimer;try{await Promise.race([target?.end(),new Promise(resolve=>{closeTimer=setTimeout(resolve,250);})]);}catch{}finally{clearTimeout(closeTimer);}
  if(guarded)try{write(DIR+'/final-result.json',result);}catch{result={...result,status:'BLOCKED',code:'T60_RESULT_WRITE_FAILED'};}
  else if(preparedGuarded)try{write(DIR+'/prepare-result.json',result);}catch{result={...result,status:'BLOCKED',code:'T60_PREPARE_RESULT_WRITE_FAILED'};}
  else if(readyGuarded)try{write(DIR+'/coordinator-ready.result.json',result);}catch{result={...result,status:'BLOCKED',code:'T60_READY_RESULT_WRITE_FAILED'};}}
 console.log('T60_RESULT',JSON.stringify(result));if(!['FINAL_READY','READY_CHALLENGE_PREPARED','COORDINATOR_READY','PASS'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
