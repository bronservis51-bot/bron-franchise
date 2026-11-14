// T41 VPS final phase only. Imports are inert. Source data uses two fixed HTTPS frames;
// Source SQL, inverse/reopen, key/backup reads and publication do not exist here.
import fs from 'node:fs';
import path from 'node:path';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {validateManifest as validateControlManifest} from './t41-control-ready.mjs';
import {runFinalHttpsWindow} from './final-https-window.mjs';
import {createFinalHttpsTransport} from './final-https-transport.mjs';
import {targetConfig,verifyTargetIdentity,PROTOCOL} from './t37-https-inventory.mjs';
import {SOURCE_TRANSFER_SCOPE_SHA256,readBudgetStatus} from './source-transfer-budget.mjs';
import {validateFreshOwnerWitness} from './http-source-admission.mjs';
import {databaseConfig} from '../../../scripts/database-config.mjs';

const ROOT='/root/bron-secrets',DIR=ROOT+'/t41-release',RUNTIME=ROOT+'/t41-runtime';
const SELF=RUNTIME+'/docs/runbooks/payloads/t41-final-window.mjs',MANIFEST=DIR+'/manifest.json';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',PG='/opt/bron/rehearsal-audit.exfSfv9a/node_modules/pg';
const LOCK='/opt/bron/rehearsal-audit.exfSfv9a/package-lock.json',LOCK_SHA='a100d1e53b1923fa350912eac4cb82a330e7390f79949f3346295fefab0b8b69';
const PROJECT='vkkqffvmztpzgygzfxhq',VPS='152.228.115.115',ORIGIN='https://'+PROJECT+'.supabase.co',PREFIX='bron-source-reader-';
const ACTION='T41.final_https_window',PARENT='T41.release_window',BARRIER_ACTION='T40.http_source_admission';
const CONTROL=ROOT+'/t40-admission-control-c40a2026.json',KEY_PROOF=ROOT+'/t40-admission-key-proof-c40a2026.json';
const BEFORE=ROOT+'/t40-admission-before-c40a2026.json',METADATA=ROOT+'/t40-admission-metadata-c40a2026.json';
const AUTH_BEFORE=ROOT+'/t41-auth-before-c41a2026.json',MAX=4194304;
const sha=x=>createHash('sha256').update(x).digest('hex'),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(o,keys)=>o!==null&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join(',')===[...keys].sort().join(',');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>canonical(a)===canonical(b);
const binding=()=>({directory:ROOT+'/source-transfer-budget',scopeSha256:SOURCE_TRANSFER_SCOPE_SHA256,sourceProject:PROJECT,destinationVps:VPS,maxAttempts:3});
export const requiredCode=Object.freeze(['docs/runbooks/payloads/t41-final-window.mjs','docs/runbooks/payloads/t41-control-ready.mjs',
 'docs/runbooks/payloads/admission-metadata-custody.mjs','docs/runbooks/payloads/admission-custody-fs.mjs',
 'docs/runbooks/payloads/final-https-window.mjs','docs/runbooks/payloads/final-https-transport.mjs',
 'docs/runbooks/payloads/final-auth-window.mjs','docs/runbooks/payloads/t37-https-inventory.mjs',
 'docs/runbooks/payloads/source-transfer-budget.mjs','docs/runbooks/payloads/http-source-admission.mjs',
 'docs/runbooks/payloads/t26-source-admission.mjs','docs/runbooks/payloads/exact-query-fingerprint.mjs',
 'docs/runbooks/payloads/t30-auth-compact.mjs','docs/runbooks/payloads/source-final-https-reader/fence-witness.mjs',
 'docs/runbooks/payloads/coordinator-fence-ack.mjs','scripts/migration-audit.mjs','scripts/database-config.mjs']);
function policy(m){
 const p=m?.phase_authorizations?.prepare_final,r=m?.phase_authorizations?.run_final,b=m?.transfer_budget;
 if(m?.task!=='T41'||m.actionId!==PARENT||m.execution_authorized!==true||m.approval?.status!=='APPROVED'||
  m.approval.document_sha256!==SOURCE_TRANSFER_SCOPE_SHA256||p?.actionId!=='T41.prepare_final'||
  p.capability_ttl_seconds!==7200||p.source_data_reads!==0||p.target_metadata_probe!==1||r?.actionId!==ACTION||r.sourceFrameBudget!==2||
  r.priorSourceAuthSnapshotAttempts!==1||r.applyTimestampOnly!==true||r.beforeImagePath!==AUTH_BEFORE||
  r.targetAdmitted!==false||!Number.isInteger(r.maxTimestampUpdates)||r.maxTimestampUpdates<0||r.maxTimestampUpdates>16||r.wall_seconds!==480||
  m.source?.origin!==ORIGIN||m.source.projectRef!==PROJECT||m.source.protocol!==PROTOCOL||
  m.source.capability_binding!=='pinned_VPS_prepare_readback'||m.source.template_name_prefix!==PREFIX||
  b?.directory!==binding().directory||b.scope_sha256!==SOURCE_TRANSFER_SCOPE_SHA256||b.source_project!==PROJECT||
  b.destination_vps!==VPS||b.max_attempts!==3||!digest(m.target?.container_id)||!/^sha256:[a-f0-9]{64}$/.test(m.target?.image_id??''))
  fail('T41_FINAL_SCOPE');
 return m;
}
export function validateManifest(raw,manifestSha256,selfSha256){
 let candidate;try{candidate=JSON.parse(raw);}catch{fail('T41_FINAL_MANIFEST_JSON');}
 validateControlManifest(raw,manifestSha256,candidate.files?.['docs/runbooks/payloads/t41-control-ready.mjs']);policy(candidate);
 if(!digest(selfSha256)||candidate.files?.['docs/runbooks/payloads/t41-final-window.mjs']!==selfSha256||
  requiredCode.some(p=>!digest(candidate.runtime_files?.[RUNTIME+'/'+p])))fail('T41_FINAL_CODE_PINS');return candidate;
}
export function validateControlEvidence({summaryBytes,controlBytes,keyProofBytes},m,manifestSha256){
 policy(m);let s,c;
 try{s=JSON.parse(summaryBytes);c=JSON.parse(controlBytes);}catch{fail('T41_FINAL_CONTROL_JSON');}
 if(s?.task!=='T41'||s.status!=='CONTROL_READY'||s.actionId!=='T41.prepare_control_ready'||s.parentActionId!==PARENT||
  s.authorizationManifestSha256!==manifestSha256||s.adoptedActionId!==BARRIER_ACTION||s.adoptedManifestSha256!==m.adopts.manifestSha256||
  s.sourceEffects!==false||s.sourceBarrierPass!==false||s.targetWritesStarted!==false||s.macDataTransit!==false||s.t40ArtifactsUnchanged!==true||
  s.controlReceiptPath!==CONTROL||s.controlReceiptSha256!==sha(controlBytes)||s.independentKeyProofPath!==KEY_PROOF||
  s.independentKeyProofSha256!==m.owner_proof.independentProofSha256||sha(keyProofBytes)!==s.independentKeyProofSha256||
  s.beforeImagePath!==BEFORE||s.beforeImageSha256!==m.input_evidence.T40_before_image_sha256||
  s.metadataReceiptPath!==METADATA||s.metadataReceiptSha256!==m.input_evidence.T40_metadata_receipt_sha256||
  c?.status!=='CONTROL_READY'||c.actionId!==BARRIER_ACTION||c.manifestSha256!==m.adopts.manifestSha256||
  c.sourceProject!==PROJECT||c.destinationVps!==VPS||c.sourceEffects!==false||c.sourceBarrierPass!==false||
  c.independentKeyProofSha256!==s.independentKeyProofSha256||c.recoveryCipherSha256!==m.owner_proof.recoveryCipherSha256||
  c.beforeImageSha256!==s.beforeImageSha256||c.metadataReceiptSha256!==s.metadataReceiptSha256||
  !exact(c.sqlHashes,['applySql','drainSql','verifyFencedSql','inverseSql','verifyOriginalSql'])||
  Object.values(c.sqlHashes).some(x=>!digest(x))||!same(s.sqlHashes,c.sqlHashes)||c.inversePath!==s.inversePath||
  s.inverseSha256!==c.sqlHashes.inverseSql||s.inversePath!==ROOT+'/t40-admission-inverse-c40a2026.sql'||
  c.controlReceiptPath!==CONTROL||c.beforeImagePath!==BEFORE||c.metadataReceiptPath!==METADATA)fail('T41_FINAL_CONTROL_NOT_PROVED');
 return {controlSummarySha256:sha(summaryBytes),controlReceiptSha256:sha(controlBytes),
  independentKeyProofSha256:s.independentKeyProofSha256,verifyFencedSqlSha256:c.sqlHashes.verifyFencedSql,
  inversePath:s.inversePath,inverseSha256:s.inverseSha256};
}
export function validateBudget(status){
 if(status?.used!==1||status.remaining!==2||status.maxAttempts!==3||status.uncertain!==false||
  !Array.isArray(status.claims)||status.claims.length!==1||status.claims[0]?.attempt!==1||status.claims[0].status!=='VALID'||
  status.claims[0].actionId!=='T37.live'||!digest(status.claims[0].capabilitySha256))fail('T41_FINAL_AUTH_BUDGET');
 return {used:1,remaining:2};
}
export function createBasePrepared({manifestSha256,controlEvidence,now=Date.now(),random=randomBytes,writeSecret}){
 if(!digest(manifestSha256)||!['controlSummarySha256','controlReceiptSha256','independentKeyProofSha256'].every(k=>digest(controlEvidence?.[k]))||
  !Number.isSafeInteger(now)||now<0||now>8640000000000000-7200000||typeof writeSecret!=='function')fail('T41_FINAL_PREPARE_ARGUMENTS');
 const entropy=random(32);if(!Buffer.isBuffer(entropy)||entropy.length!==32)fail('T41_FINAL_ENTROPY');
 const secret=Buffer.from(entropy.toString('hex'),'ascii');entropy.fill(0);
 try{writeSecret(secret);const capabilitySha256=sha(secret);return {task:'T41',actionId:ACTION,manifestSha256,
  ownerGrantSha256:SOURCE_TRANSFER_SCOPE_SHA256,origin:ORIGIN,projectRef:PROJECT,destinationVps:VPS,protocol:PROTOCOL,
  createdUtc:new Date(now).toISOString(),expiresUtc:new Date(now+7200000).toISOString(),capabilitySha256,
  functionName:PREFIX+capabilitySha256.slice(0,12),controlSummarySha256:controlEvidence.controlSummarySha256,
  controlReceiptSha256:controlEvidence.controlReceiptSha256,independentKeyProofSha256:controlEvidence.independentKeyProofSha256};}
 finally{secret.fill(0);}
}
const baseKeys=['task','actionId','manifestSha256','ownerGrantSha256','origin','projectRef','destinationVps','protocol','createdUtc','expiresUtc',
 'capabilitySha256','functionName','controlSummarySha256','controlReceiptSha256','independentKeyProofSha256'];
export function validateBasePrepared(base,manifestSha256,evidence,now=Date.now()){
 const created=Date.parse(base?.createdUtc),expires=Date.parse(base?.expiresUtc);
 if(!exact(base,baseKeys)||base.task!=='T41'||base.actionId!==ACTION||base.manifestSha256!==manifestSha256||
  base.ownerGrantSha256!==SOURCE_TRANSFER_SCOPE_SHA256||base.origin!==ORIGIN||base.projectRef!==PROJECT||base.destinationVps!==VPS||base.protocol!==PROTOCOL||
  !digest(base.capabilitySha256)||base.functionName!==PREFIX+base.capabilitySha256.slice(0,12)||
  !['controlSummarySha256','controlReceiptSha256','independentKeyProofSha256'].every(k=>base[k]===evidence?.[k])||
  !Number.isSafeInteger(created)||!Number.isSafeInteger(expires)||new Date(created).toISOString()!==base.createdUtc||
  new Date(expires).toISOString()!==base.expiresUtc||expires-created!==7200000||created>now+5000||now+140000>=expires)
  fail('T41_FINAL_BASE_PREPARED');return base;
}
export function validateRunInputs({inputBytes,inputSha256,basePreparedBytes,finalPreparedBytes,barrierBytes,manifest:m,manifestSha256,controlEvidence,now=Date.now()}){
 policy(m);if(!digest(inputSha256)||sha(inputBytes)!==inputSha256)fail('T41_FINAL_ROOT_INPUT_SHA');let input,base,prepared,barrier;
 try{input=JSON.parse(inputBytes);base=JSON.parse(basePreparedBytes);prepared=JSON.parse(finalPreparedBytes);barrier=JSON.parse(barrierBytes);}
 catch{fail('T41_FINAL_INPUT_JSON');}validateBasePrepared(base,manifestSha256,controlEvidence,now);
 if(!exact(input,['format','task','actionId','manifestSha256','basePreparedSha256','finalPreparedSha256','controlSummarySha256',
  'controlReceiptSha256','barrierReceiptPath','barrierReceiptSha256','fenceContextSha256','fenceContext'])||
  input.format!==1||input.task!=='T41'||input.actionId!==ACTION||input.manifestSha256!==manifestSha256||
  input.basePreparedSha256!==sha(basePreparedBytes)||input.finalPreparedSha256!==sha(finalPreparedBytes)||
  input.controlSummarySha256!==controlEvidence.controlSummarySha256||input.controlReceiptSha256!==controlEvidence.controlReceiptSha256||
  input.barrierReceiptPath!==DIR+'/source-barrier.json'||input.barrierReceiptSha256!==sha(barrierBytes)||
  !digest(input.fenceContextSha256)||sha(JSON.stringify(input.fenceContext))!==input.fenceContextSha256||
  !exact(prepared,[...baseKeys,'fenceContextSha256'])||baseKeys.some(k=>!same(base[k],prepared[k]))||
  prepared.fenceContextSha256!==input.fenceContextSha256)fail('T41_FINAL_INPUT_BINDING');
 const context=input.fenceContext;
 if(!exact(context,['sourceBarrierActionId','sourceBarrierReceiptSha256','before','boundary'])||context.sourceBarrierActionId!==BARRIER_ACTION||
  context.sourceBarrierReceiptSha256!==input.barrierReceiptSha256||!exact(context.before,['backends'])||!Array.isArray(context.before.backends)||
  context.before.backends.length>1000||context.before.backends.some(b=>!exact(b,['pid'])||!Number.isInteger(b.pid)||b.pid<1||b.pid>2147483647)||
  !exact(context.boundary,['capturedMicros','ownerPids'])||!/^\d{12,20}$/.test(context.boundary.capturedMicros??'')||
  !Array.isArray(context.boundary.ownerPids)||context.boundary.ownerPids.length>1000||context.boundary.ownerPids.some(p=>!Number.isInteger(p)||p<1||p>2147483647))fail('T41_FINAL_FENCE_CONTEXT');
 if(!exact(barrier,['format','task','actionId','manifestSha256','controlReceiptSha256','sourceProject','destinationVps','status',
  'normalConnectDenied','existingClientsDrained','freshOwnerReconnect','providerBoundaryReviewed','durableOnVps','sourcePaused','before','boundary','witness'])||
  barrier.format!==1||barrier.task!=='T41'||barrier.actionId!==BARRIER_ACTION||barrier.manifestSha256!==manifestSha256||
  barrier.controlReceiptSha256!==input.controlReceiptSha256||barrier.sourceProject!==PROJECT||barrier.destinationVps!==VPS||barrier.status!=='SOURCE_ADMISSION_CLOSED'||
  ['normalConnectDenied','existingClientsDrained','freshOwnerReconnect','providerBoundaryReviewed','durableOnVps'].some(k=>barrier[k]!==true)||
  barrier.sourcePaused!==false||!same(barrier.before,context.before)||!same(barrier.boundary,context.boundary)||
  !exact(barrier.witness,['db','actor','session','owner','readOnly','isolation','pid','backendStartMicros'])||barrier.witness.isolation!=='repeatable read'||
  !Number.isInteger(barrier.witness.pid)||barrier.witness.pid<1||barrier.witness.pid>2147483647)
  fail('T41_FINAL_BARRIER_NOT_PROVED');
 try{validateFreshOwnerWitness({before:context.before,boundary:context.boundary,witness:barrier.witness});}
 catch{fail('T41_FINAL_BARRIER_NOT_PROVED');}
 const activation={reviewed:true,actionId:ACTION,manifestSha256,sourceBarrierActionId:BARRIER_ACTION,
  sourceBarrierReceiptSha256:input.barrierReceiptSha256,fenceContextSha256:input.fenceContextSha256,
  ownerDataGrantEvidenceSha256:SOURCE_TRANSFER_SCOPE_SHA256,targetAdmitted:false,sourceRoute:'fixed-source-edge-https',
  targetRoute:'verified-loopback-15433',expectedAuthRows:16,sourceFrameBudget:2,priorSourceAuthSnapshotAttempts:1,
  applyTimestampOnly:true,maxTimestampUpdates:m.phase_authorizations.run_final.maxTimestampUpdates,beforeImagePath:AUTH_BEFORE};
 const ownerDataGrant={reviewed:true,evidenceSha256:SOURCE_TRANSFER_SCOPE_SHA256,scope:'source-auth-fixed-snapshot-to-vps',sourceProject:PROJECT,
  destinationVps:VPS,credentialDerivedAuthDigests:true,readonlySource:true,encryptedToVpsRam:true,macDataTransit:false,maxAuthSnapshots:3};
 const barrierProof={sourceBarrierActionId:BARRIER_ACTION,sourceBarrierReceiptSha256:input.barrierReceiptSha256,
  normalConnectDenied:true,existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
 return structuredClone({activation,ownerDataGrant,fenceContext:context,prepared,barrierProof,inputSha256});
}
export const targetIdentitySql=`SELECT current_database() AS database,current_user AS role,session_user AS session_role,
 current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
 current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,
 current_setting('idle_in_transaction_session_timeout') AS idle_timeout,current_setting('TimeZone') AS timezone,
 current_setting('search_path') AS search_path,host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,
 current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net`;
export function verifyFinalTargetIdentity(i,addresses){
 if(i?.timezone!=='UTC'||i.search_path!=='pg_catalog'||i.lock_timeout!=='5s'||
  !((i.read_only==='on'&&i.isolation==='repeatable read')||(i.read_only==='off'&&i.isolation==='serializable')))
  fail('T41_FINAL_TARGET_TRANSACTION');
 // Reuse reviewed base identity/isolation settings after the actual valid pair check.
 try{verifyTargetIdentity({...i,read_only:'on',isolation:'repeatable read'},addresses);}
 catch{fail('T41_FINAL_TARGET_IDENTITY');}
}
export async function probeTargetMetadata(target,addresses){
 let began=false;
 try{
  await target.connect();await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
  for(const sql of ["SET LOCAL statement_timeout='5000'","SET LOCAL lock_timeout='5000'",
   "SET LOCAL idle_in_transaction_session_timeout='10000'","SET LOCAL timezone='UTC'",'SET LOCAL search_path=pg_catalog'])await target.query(sql);
  const result=await target.query(targetIdentitySql);if(result.rows.length!==1||result.rows[0].read_only!=='on'||
   result.rows[0].isolation!=='repeatable read')fail('T41_FINAL_TARGET_IDENTITY');
  verifyFinalTargetIdentity(result.rows[0],addresses);
  await target.query('ROLLBACK');began=false;
  return {status:'PASS',readonly:true,rollbackCompleted:true,authOrBusinessRowsRead:false};
 }catch(error){if(began)try{await target.query('ROLLBACK');}catch{}throw Object.assign(new Error('T41_FINAL_TARGET_PREFLIGHT_FAILED'),{code:'T41_FINAL_TARGET_PREFLIGHT_FAILED'});}
}
export function targetFromInspect(records,m){
 if(!Array.isArray(records)||records.length!==1||records[0]?.Id!==m.target.container_id||records[0]?.Image!==m.target.image_id)
  fail('T41_FINAL_TARGET_CONTAINER');let config;
 try{config=targetConfig(records[0]);}catch{fail('T41_FINAL_TARGET_CONFIG');}
 const u=new URL(config.url);if(u.hostname!=='127.0.0.1'||u.port!=='15433'||u.pathname!=='/postgres'||u.username!=='supabase_admin')fail('T41_FINAL_TARGET_ROUTE');
 return config;
}
function directory(p,uid=0){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==(uid===0?0:process.getgid())||(s.mode&0o7777)!==0o700)fail('T41_FINAL_PRIVATE_DIRECTORY');}
function read(p,max=MAX,uid=0){const f=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(f);if(!s.isFile()||s.uid!==uid||s.gid!==(uid===0?0:process.getgid())||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>max)fail('T41_FINAL_PRIVATE_FILE');
  const bytes=fs.readFileSync(f),after=fs.fstatSync(f);if(bytes.length!==s.size||s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.ctimeMs!==after.ctimeMs)fail('T41_FINAL_PRIVATE_FILE_CHANGED');return bytes;
 }finally{fs.closeSync(f);}}
export function writeBeforeImage(filename,value,{uid=0}={}){
 if(uid===0&&filename!==AUTH_BEFORE||uid!==0&&(!process.env.NODE_TEST_CONTEXT||process.getuid?.()!==uid||!filename.startsWith('/tmp/')))
  fail('T41_FINAL_BEFORE_IMAGE_PATH');directory(path.dirname(filename),uid);const bytes=Buffer.from(JSON.stringify(value)+'\n');
 if(bytes.length>MAX)fail('T41_FINAL_BEFORE_IMAGE_BOUND');let f;
 try{f=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(f,bytes);fs.fsyncSync(f);}
 finally{if(f!==undefined)fs.closeSync(f);}const d=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(d);}finally{fs.closeSync(d);}if(!read(filename,MAX,uid).equals(bytes))fail('T41_FINAL_BEFORE_IMAGE_READBACK');
 return {path:filename,sha256:sha(bytes),durable:true,fsynced:true,rootOwned:uid===0,mode:'0600'};
}
function lockBytes(){const f=fs.openSync(LOCK,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(f);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o022)!==0||s.size<1||s.size>MAX)fail('T41_FINAL_DRIVER_PIN');return fs.readFileSync(f);}
 finally{fs.closeSync(f);}}
function writeNew(p,value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n');const f=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(f,bytes);fs.fsyncSync(f);}finally{fs.closeSync(f);}const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(d);}finally{fs.closeSync(d);}if(!read(p).equals(bytes))fail('T41_FINAL_WRITE_READBACK');return sha(bytes);}
function absent(names){for(const p of names)try{fs.lstatSync(p);fail('T41_FINAL_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}
const safeCode=e=>/^(?:T41_|FINAL_HTTPS_|COORDINATOR_FENCE_|SOURCE_TRANSFER_)[A-Z0-9_]+$/.test(e?.code??'')?e.code:
 /^[0-9A-Z]{5}$/.test(e?.code??'')?e.code:e?.code==='EEXIST'?'T41_FINAL_ALREADY_STARTED':e?.message==='Query read timeout'?'PG_QUERY_READ_TIMEOUT':'T41_FINAL_FAILED';
async function openTarget(m){
 if(sha(lockBytes())!==LOCK_SHA||JSON.parse(fs.readFileSync(PG+'/package.json','utf8')).version!=='8.23.1')fail('T41_FINAL_DRIVER_PIN');
 const {default:pg}=await import('file://'+PG+'/lib/index.js');
 const records=JSON.parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],
  {encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
 const config=targetFromInspect(records,m),client=new pg.Client({...databaseConfig(config.url,{BRON_DB_ALLOW_LOCAL_PLAIN:'1'}),
  options:'-c default_transaction_read_only=on',query_timeout:6000,application_name:'bron-t41-final-target'});
 client.on('error',()=>{});return {client,addresses:config.addresses};
}
async function closeTarget(target){target?.connection?.stream?.destroy();let timer;try{await Promise.race([target?.end(),new Promise(resolve=>{timer=setTimeout(resolve,250);})]);}catch{}finally{clearTimeout(timer);}}
async function main(){let phase='preflight',target,ack,guard=false,timer;const abort=new AbortController();
 const interrupt=()=>{abort.abort();target?.connection?.stream?.destroy();};
 let result={task:'T41',status:'BLOCKED',actionId:ACTION,targetWriteOutcome:'UNCHANGED',sourceMustRemainClosed:true,macDataTransit:false};
 try{
  const prepare=process.argv[2]==='--prepare-final',run=process.argv[2]==='--run-final';
  if((prepare?process.argv.length!==7:run?process.argv.length!==9:true)||process.argv[3]!=='--manifest'||process.argv[4]!==MANIFEST||
   process.argv[5]!=='--sha256'||!digest(process.argv[6])||run&&(process.argv[7]!=='--fence-input-sha256'||!digest(process.argv[8])))fail('T41_FINAL_EXPLICIT_REVIEW_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||
   fileURLToPath(import.meta.url)!==SELF||!Object.values(networkInterfaces()).flat().some(i=>i?.address===VPS)||
   process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||process.env.NODE_PG_FORCE_NATIVE)fail('T41_FINAL_PINNED_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const d of ['/root',ROOT,DIR,RUNTIME,RUNTIME+'/docs',RUNTIME+'/docs/runbooks',RUNTIME+'/docs/runbooks/payloads',
   RUNTIME+'/docs/runbooks/payloads/source-final-https-reader',RUNTIME+'/scripts'])directory(d);
  const m=validateManifest(read(MANIFEST),process.argv[6],sha(read(SELF)));
  for(const p of requiredCode)if(sha(read(RUNTIME+'/'+p))!==m.runtime_files[RUNTIME+'/'+p])fail('T41_FINAL_RUNTIME_SHA');
  const control=validateControlEvidence({summaryBytes:read(DIR+'/control-ready-result.json'),controlBytes:read(CONTROL),keyProofBytes:read(KEY_PROOF)},m,process.argv[6]);
  if(sha(read(BEFORE))!==m.input_evidence.T40_before_image_sha256||sha(read(METADATA))!==m.input_evidence.T40_metadata_receipt_sha256||
   sha(read(control.inversePath))!==control.inverseSha256)fail('T41_FINAL_ADOPTED_ARTIFACTS_CHANGED');
  const budget=validateBudget(readBudgetStatus(binding()));
  if(prepare){
   absent(['final-prepare.guard','final-capability','final-base-prepared.json','final-run.guard','final-result.json'].map(p=>DIR+'/'+p));
   phase='target-preflight';const checkedTarget=await openTarget(m);target=checkedTarget.client;
   const targetMetadataProbe=await probeTargetMetadata(target,checkedTarget.addresses);
   phase='prepare-final';writeNew(DIR+'/final-prepare.guard',{task:'T41',actionId:'T41.prepare_final',manifestSha256:process.argv[6],controlSummarySha256:control.controlSummarySha256});
   const base=createBasePrepared({manifestSha256:process.argv[6],controlEvidence:control,writeSecret:bytes=>writeNew(DIR+'/final-capability',bytes)});
   const basePreparedSha256=writeNew(DIR+'/final-base-prepared.json',base);
   result={...result,...base,status:'FINAL_READY',basePreparedSha256,targetMetadataProbe,authBudgetUsed:budget.used,authBudgetRemaining:budget.remaining};
  }else{
   absent([DIR+'/final-run.guard',DIR+'/final-result.json',AUTH_BEFORE]);
   const validated=validateRunInputs({inputBytes:read(DIR+'/fence-input.json'),inputSha256:process.argv[8],basePreparedBytes:read(DIR+'/final-base-prepared.json'),
    finalPreparedBytes:read(DIR+'/final-prepared.json'),barrierBytes:read(DIR+'/source-barrier.json'),manifest:m,manifestSha256:process.argv[6],controlEvidence:control});
   const token=read(DIR+'/final-capability',64).toString('utf8');if(!/^[a-f0-9]{64}$/.test(token)||sha(Buffer.from(token,'ascii'))!==validated.prepared.capabilitySha256)fail('T41_FINAL_CAPABILITY_SHA');
   const [{createCoordinatorFenceAck},checkedTarget]=await Promise.all([import('./coordinator-fence-ack.mjs'),openTarget(m)]);
   target=checkedTarget.client;
   timer=setTimeout(interrupt,480000);process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
   phase='final-activation';writeNew(DIR+'/final-run.guard',{task:'T41',actionId:ACTION,manifestSha256:process.argv[6],inputSha256:process.argv[8],startedUtc:new Date().toISOString()});guard=true;
   const transport=await createFinalHttpsTransport({activation:validated.activation,taskManifest:m,prepared:validated.prepared,token,
    fenceContext:validated.fenceContext,fenceContextSha256:validated.activation.fenceContextSha256,signal:abort.signal,
    onBudgetClaim:claim=>{writeNew(DIR+'/final-source-'+claim.stage+'-claim.json',claim);}});
   ack=createCoordinatorFenceAck({activation:{reviewed:true,actionId:ACTION,manifestSha256:process.argv[6],sourceProject:PROJECT,
    sourceBarrierActionId:BARRIER_ACTION,sourceBarrierReceiptSha256:validated.activation.sourceBarrierReceiptSha256,
    verifyFencedSqlSha256:control.verifyFencedSqlSha256},barrierProof:validated.barrierProof,signal:abort.signal,timeoutMs:60000});
   phase='target-connect';await target.connect();phase='final-window';
   const final=await runFinalHttpsWindow({activation:validated.activation,ownerDataGrant:validated.ownerDataGrant,
    fenceContext:validated.fenceContext,captureSourceFrame:transport.captureSourceFrame,target,
    verifyTarget:async client=>{if(abort.signal.aborted)fail('T41_FINAL_ABORTED');const rows=(await client.query(targetIdentitySql)).rows;
     if(rows.length!==1)fail('T41_FINAL_TARGET_IDENTITY');verifyFinalTargetIdentity(rows[0],checkedTarget.addresses);},
    assertFence:ack.assertFence,persistBeforeImage:image=>writeBeforeImage(AUTH_BEFORE,image)});
   // Record known COMMIT outcome before any later local receipt/budget operation can fail.
   result={...result,...final,rootApprovedInputSha256:process.argv[8],macDataTransit:false};
   const afterBudget=readBudgetStatus(binding());if(afterBudget.used!==3||afterBudget.remaining!==0||afterBudget.uncertain!==false)fail('T41_FINAL_AUTH_BUDGET_AFTER');
   result.authBudgetUsed=afterBudget.used;
  }
 }catch(error){result={...result,status:'BLOCKED',phase:error?.phase??phase,code:safeCode(error),
  ...(error?.recovery?{recovery:error.recovery,targetWriteOutcome:error.recovery.targetWriteOutcome}:{})};}
 finally{clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);abort.abort();try{ack?.close();}catch{}
  await closeTarget(target);if(guard)try{writeNew(DIR+'/final-result.json',result);}catch{result={...result,status:'BLOCKED',code:'T41_FINAL_RESULT_WRITE'};}}
 console.log(result.status==='FINAL_READY'?'T41_FINAL_READY':'T41_FINAL_RESULT',JSON.stringify(result));if(!['FINAL_READY','PASS'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
