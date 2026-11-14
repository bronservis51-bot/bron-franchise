// T37: one private HTTPS source snapshot and one local target snapshot; no writes.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,createDecipheriv,hkdfSync} from 'node:crypto';

const PRIVATE='/root/bron-secrets',SELF=PRIVATE+'/t37-https-inventory.mjs',MANIFEST=PRIVATE+'/t37-https.json';
const RUNTIME=PRIVATE+'/t37-runtime',INSTALLED='/opt/bron/audit-runtime-c128f9b';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',REF='vkkqffvmztpzgygzfxhq';
const HOST=REF+'.supabase.co',FUNCTION='bron-source-reader-fba3e5a8714f';
const CAP_SHA='fba3e5a8714f7fb82725c6d69e6424caaec9b761fbe76005198740660f1f208c';
const EXPIRY=Date.parse('2026-11-14T05:19:57.052Z');
export const PROTOCOL='BRON_PRIVATE_SNAPSHOT_V1';
const MAX_WIRE=2*1024*1024,MAX_PLAIN=1024*1024,FILE_KEY='docs/runbooks/payloads/t37-https-inventory.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const SCHEMAS=['columns','relations','policies','storage_policies','storage_grants','triggers','extensions','constraints','indexes','routines','enums','schemas','default_grants','client_roles','role_memberships'];
const REQUIRED_DATA=['auth.users','auth.identities','public.partner','public.location','public.role_assignment','public.daily_revenue','public.franchise_lead','public.article_revision','storage.buckets','storage.objects'];
const REQUIRED_RUNTIME=[RUNTIME+'/scripts/migration-audit.mjs',RUNTIME+'/payloads/exact-query-fingerprint.mjs',RUNTIME+'/payloads/t30-auth-compact.mjs'];
const VERIFY_PINS={
 [INSTALLED+'/scripts/migration-audit.mjs']:'a5306390fa06db03665caaaa988cadf472f17c349538712f03fa31f794d6bdea',
 [INSTALLED+'/scripts/migration-source.mjs']:'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
 [INSTALLED+'/scripts/database-config.mjs']:'1064d54299d354ec7951f40b719ce6886b78ddd00b2f2ac234c0024a8fbd55e6',
};
export function validateManifest(raw,digest,selfSha){
 if(!/^[a-f0-9]{64}$/.test(digest??'')||sha(raw)!==digest)fail('T37_MANIFEST_SHA');
 let m;try{m=JSON.parse(raw);}catch{fail('T37_MANIFEST_JSON');}
 if(m?.task!=='T37'||m.files?.[FILE_KEY]!==selfSha||!/^[a-f0-9]{64}$/.test(selfSha??''))fail('T37_SELF_SHA');
 if(!object(m.runtime_files)||Object.keys(m.runtime_files).length!==REQUIRED_RUNTIME.length||REQUIRED_RUNTIME.some(p=>!/^[a-f0-9]{64}$/.test(m.runtime_files[p]??'')))fail('T37_RUNTIME_PINS');
 if(!object(m.verify_only)||Object.entries(VERIFY_PINS).some(([p,h])=>m.verify_only[p]!==h))fail('T37_VERIFY_PINS');
 if(!/^[a-f0-9]{64}$/.test(m.input_evidence?.T36_result_sha256??''))fail('T37_PRIOR_PIN');
 return m;
}
export function validatePrior(raw,pin){
 if(!/^[a-f0-9]{64}$/.test(pin??'')||sha(raw)!==pin)fail('T37_PRIOR_SHA');let p;
 try{p=JSON.parse(raw);}catch{fail('T37_PRIOR_EVIDENCE');}
 if(p?.task!=='T36'||p.status!=='PASS'||p.httpStatus!==200||p.wrongCapabilityRejected!==true||p.tlsNegativeRejected!==true||p.dummyBytes!==524288||p.sourceDataRead!==false||p.sourceAuthUserRead!==false||p.macDataTransit!==false)fail('T37_PRIOR_EVIDENCE');
 return p;
}
export function validateCapability(token,prepared,now=Date.now(),expectedHash=CAP_SHA){
 if(!/^[a-f0-9]{64}$/.test(token??'')||sha(Buffer.from(token,'ascii'))!==expectedHash||prepared?.task!=='T36'||prepared.capabilitySha256!==expectedHash||prepared.expiresUtc!=='2026-11-14T05:19:57.052Z'||prepared.functionName!=='bron-https-probe-'+expectedHash.slice(0,12)||prepared.origin!=='https://'+HOST||prepared.protocol!=='BRON_HTTPS_PROBE_V1'||now+140000>=EXPIRY)fail('T37_CAPABILITY_OR_EXPIRY');
}
function privateRead(filename,max=MAX_WIRE){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>max)fail('T37_PRIVATE_FILE');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function directory(p){const s=fs.lstatSync(p);if(!s.isDirectory()||s.uid!==0||(s.mode&0o777)!==0o700)fail('T37_PRIVATE_DIRECTORY');}
export function exclusiveWrite(filename,bytes){
 const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
const remoteFailure=v=>v?.protocol===PROTOCOL?{...(['authorization','configuration','dns','tls-negative','connect','snapshot','identity','auth-rows','encryption','deadline'].includes(v.stage)?{remoteStage:v.stage}:{}),...(['READER_FAILED','READER_DEADLINE'].includes(v.code)?{remoteCode:v.code}:{})}:{};
export function requestSource(token,{request=https.request,signal,timeoutMs=100000,maxBody=MAX_WIRE}={}){
 if(!/^[a-f0-9]{64}$/.test(token??'')||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>100000||!Number.isSafeInteger(maxBody)||maxBody<1||maxBody>MAX_WIRE)fail('T37_REQUEST_SCOPE');
 return new Promise(resolve=>{let req,res,timer,done=false,bytes=0,statusCode=null;const chunks=[],started=performance.now();
  const finish=(code,value,safe={})=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);req?.destroy();res?.destroy();resolve({statusCode,bytes,elapsedMs:Math.ceil(performance.now()-started),...(code?{code}:{}),...(value!==undefined?{value}:{}),...safe});};
  const abort=()=>finish('T37_WALL_DEADLINE');if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>finish('T37_HTTPS_TIMEOUT'),timeoutMs);
  try{req=request({protocol:'https:',hostname:HOST,port:443,servername:HOST,rejectUnauthorized:true,agent:false,method:'POST',path:'/functions/v1/'+FUNCTION,headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}},response=>{
   res=response;statusCode=Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599?res.statusCode:null;res.on('error',()=>finish('T37_HTTPS_FAILURE'));res.on('aborted',()=>finish('T37_HTTPS_FAILURE'));
   if(statusCode>=300&&statusCode<400){finish('T37_REDIRECT_REJECTED');return;}
   res.on('data',chunk=>{if(done)return;const b=Buffer.from(chunk);bytes+=b.length;if(bytes>(statusCode===200?maxBody:4096)){finish('T37_BODY_LIMIT');return;}chunks.push(b);});
   res.on('end',()=>{if(done)return;let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish(statusCode===200?'T37_JSON_INVALID':'T37_HTTP_STATUS');return;}if(statusCode!==200){finish('T37_HTTP_STATUS',undefined,remoteFailure(value));return;}finish(undefined,value);});
  });req.on('error',()=>finish('T37_HTTPS_FAILURE'));req.end(token,'ascii');}catch{finish('T37_HTTPS_FAILURE');}
 });
}
function base64(v,max){if(typeof v!=='string'||v.length>Math.ceil(max/3)*4||v.length%4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))fail('T37_CIPHERTEXT_INVALID');const b=Buffer.from(v,'base64');if(b.length>max||b.toString('base64')!==v)fail('T37_CIPHERTEXT_INVALID');return b;}
export function decryptEnvelope(v,token,expectedHash=CAP_SHA){
 if(!object(v)||Object.keys(v).sort().join(',')!=='ciphertext,nonce,protocol'||v.protocol!==PROTOCOL||!/^[a-f0-9]{64}$/.test(token??'')||sha(Buffer.from(token,'ascii'))!==expectedHash)fail('T37_ENVELOPE_INVALID');
 const nonce=base64(v.nonce,12),cipher=base64(v.ciphertext,MAX_PLAIN+16);if(nonce.length!==12||cipher.length<17)fail('T37_CIPHERTEXT_INVALID');
 let plain,key;
 try{key=Buffer.from(hkdfSync('sha256',Buffer.from(token,'ascii'),Buffer.from(expectedHash,'utf8'),Buffer.from(PROTOCOL,'utf8'),32));const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(cipher.subarray(-16));plain=Buffer.concat([d.update(cipher.subarray(0,-16)),d.final()]);if(plain.length>MAX_PLAIN)fail('T37_PLAINTEXT_LIMIT');return JSON.parse(plain.toString('utf8'));}
 catch{fail('T37_DECRYPT_FAILED');}finally{plain?.fill(0);key?.fill(0);}
}
export function validateSnapshot(v){
 if(!object(v)||Object.keys(v).length>2048)fail('T37_SNAPSHOT_INVALID');
 const keys=Object.keys(v);if(SCHEMAS.some(n=>!Object.hasOwn(v,'schema:'+n))||REQUIRED_DATA.some(n=>!Object.hasOwn(v,'data:'+n)))fail('T37_SNAPSHOT_GROUPS_MISSING');
 for(const k of keys){const row=v[k];if(/^sequence:(?:public|app_private)\.[a-z_][a-z0-9_]*$/.test(k)){
   if(!object(row)||Object.keys(row).sort().join(',')!=='is_called,last_value'||typeof row.is_called!=='boolean'||typeof row.last_value!=='string'||! /^-?[0-9]+$/.test(row.last_value))fail('T37_SEQUENCE_INVALID');
  }else if(/^data:(?:public|app_private|auth|storage)\.[a-z_][a-z0-9_]*$/.test(k)||SCHEMAS.some(n=>k==='schema:'+n)){
   if(!object(row)||Object.keys(row).sort().join(',')!=='count,hash'||!Number.isSafeInteger(row.count)||row.count<0||row.count>25000||! /^[a-f0-9]{64}$/.test(row.hash??''))fail('T37_FINGERPRINT_INVALID');
  }else fail('T37_SNAPSHOT_KEY_INVALID');
 }
 return v;
}
export function validateAuthRows(rows){
 if(!Array.isArray(rows)||rows.length!==16)fail('T37_AUTH_COHORT_LIMIT');const seen=new Set();
 for(const r of rows){if(!object(r)||Object.keys(r).sort().join(',')!=='private_id,private_micros,private_other,private_stamp'||! /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(r.private_id??'')||seen.has(r.private_id)||! /^[a-f0-9]{64}$/.test(r.private_other??'')||!((r.private_stamp===null&&r.private_micros===null)||(typeof r.private_stamp==='string'&&r.private_stamp.length<128&&Number.isFinite(Date.parse(r.private_stamp))&&typeof r.private_micros==='string'&&/^-?[0-9]{1,30}$/.test(r.private_micros))))fail('T37_AUTH_INVALID');seen.add(r.private_id);}
 return rows;
}
export function validateSource(v,callStarted,now=Date.now()){
 const i=v?.identity;if(v?.ok!==true||v.protocol!==PROTOCOL||v.projectRef!==REF||v.expires_epoch_ms!==EXPIRY||v.tls_negative_rejected!==true||v.tls_verification!=='native-ca-and-hostname'||!Number.isSafeInteger(v.started_epoch_ms)||!Number.isSafeInteger(v.finished_epoch_ms)||v.started_epoch_ms<callStarted-5000||v.started_epoch_ms>now+5000||v.finished_epoch_ms<v.started_epoch_ms||v.finished_epoch_ms>now+5000||v.finished_epoch_ms-v.started_epoch_ms>90000||v.finished_epoch_ms>=EXPIRY||!object(i)||['database','role','session_role','owner'].some(k=>i[k]!=='postgres')||i.read_only!=='on'||i.isolation!=='repeatable read'||i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||!Number.isSafeInteger(i.pid)||i.pid<1||!isIP(i.server_address)||typeof i.database_time!=='string'||!Number.isFinite(Date.parse(i.database_time)))fail('T37_SOURCE_INVARIANT');
 validateSnapshot(v.snapshot);validateAuthRows(v.authRows);if(v.snapshot['data:auth.users'].count!==v.authRows.length)fail('T37_AUTH_COUNT_MISMATCH');
 return v;
}
export function verifyTargetIdentity(i,addresses){
 if(i?.database!=='postgres'||i.role!=='supabase_admin'||i.session_role!=='supabase_admin'||i.read_only!=='on'||i.isolation!=='repeatable read'||i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||i.server_port!==5432||!Array.isArray(addresses)||!addresses.includes(i.server_address)||i.cron!=='off'||i.net!=='0')fail('T37_TARGET_IDENTITY');
}
const stats=s=>({tables:Object.keys(s).filter(k=>k.startsWith('data:')).length,rows:Object.entries(s).filter(([k])=>k.startsWith('data:')).reduce((sum,[,r])=>sum+r.count,0),schemaGroups:Object.keys(s).filter(k=>k.startsWith('schema:')).length,sequences:Object.keys(s).filter(k=>k.startsWith('sequence:')).length});
export function compareInventory(source,target,{compareSnapshots,authRowsPlan}){
 validateSnapshot(source.snapshot);validateSnapshot(target.snapshot);validateAuthRows(source.authRows);validateAuthRows(target.authRows);
 if(source.snapshot['data:auth.users'].count!==16||target.snapshot['data:auth.users'].count!==16)fail('T37_AUTH_COUNT_MISMATCH');
 const strictMismatchGroups=compareSnapshots(source.snapshot,target.snapshot),authPlan=authRowsPlan(source.authRows,target.authRows);
 if(!Array.isArray(strictMismatchGroups)||strictMismatchGroups.some(k=>!Object.hasOwn(source.snapshot,k)&&!Object.hasOwn(target.snapshot,k)))fail('T37_COMPARE_INVALID');
 if(strictMismatchGroups.includes('data:auth.users')!==(authPlan.changedMatchedRows>0||authPlan.sourceOnlyRows>0||authPlan.targetOnlyRows>0))fail('T37_SNAPSHOT_AUTH_DRIFT');
 const timestampOnly=strictMismatchGroups.length===1&&strictMismatchGroups[0]==='data:auth.users'&&authPlan.canReconcileTimestampOnly===true&&authPlan.changedUpdatedOnlyRows>0&&authPlan.sourceOnlyRows===0&&authPlan.targetOnlyRows===0;
 return {task:'T37',status:strictMismatchGroups.length===0?'STRICT_MATCH':timestampOnly?'LIVE_AUTH_TIMESTAMP_ONLY':'LIVE_MISMATCH',inventoryComplete:true,strictMatch:strictMismatchGroups.length===0,strictMismatchGroups,source:stats(source.snapshot),target:stats(target.snapshot),authPlan,sourceWindow:{startedUtc:new Date(source.started_epoch_ms).toISOString(),finishedUtc:new Date(source.finished_epoch_ms).toISOString()},targetWindow:target.window,applyAuthorized:false,finalFreezeAudit:false,sourceDataRead:true,sourceAuthUserRead:true,macDataTransit:false};
}
export async function runInventory({token,send=requestSource,decrypt=decryptEnvelope,captureTarget,compareSnapshots,authRowsPlan,guard=()=>{},onSourceRead=()=>{},now=Date.now,signal}){
 if(signal?.aborted)fail('T37_WALL_DEADLINE');guard();const callStarted=now(),r=await send(token,{signal});
 if(r.code||r.statusCode!==200)throw Object.assign(new Error(r.code??'T37_HTTP_STATUS'),{code:r.code??'T37_HTTP_STATUS',safeReply:{httpStatus:r.statusCode,bytes:r.bytes,elapsedMs:r.elapsedMs,...remoteFailure({protocol:PROTOCOL,stage:r.remoteStage,code:r.remoteCode})}});
 const source=validateSource(decrypt(r.value,token),callStarted,now());onSourceRead();
 if(signal?.aborted)fail('T37_WALL_DEADLINE');const target=await captureTarget();return {...compareInventory(source,target,{compareSnapshots,authRowsPlan}),sourceReadAttempted:true,https:{status:200,bytes:r.bytes,elapsedMs:r.elapsedMs}};
}
export function targetConfig(record){
 if(record?.Name!=='/supabase-db'||record.State?.Running!==true)fail('T37_TARGET_CONTAINER');const values={};
 for(const entry of record.Config?.Env??[]){const i=entry.indexOf('='),name=entry.slice(0,i);if(!['POSTGRES_PASSWORD','PGPASSWORD','POSTGRES_USER','POSTGRES_DB'].includes(name))continue;if(Object.hasOwn(values,name))fail('T37_TARGET_DUPLICATE_CONFIG');values[name]=entry.slice(i+1);}
 if(!values.POSTGRES_PASSWORD||values.PGPASSWORD!==values.POSTGRES_PASSWORD||values.POSTGRES_USER!=='supabase_admin'||values.POSTGRES_DB!=='postgres')fail('T37_TARGET_CONFIG');
 const addresses=Object.values(record.NetworkSettings?.Networks??{}).map(n=>n.IPAddress).filter(Boolean);if(!addresses.length||addresses.some(a=>!isIP(a)))fail('T37_TARGET_ADDRESS');
 const url=new URL('postgresql://supabase_admin@127.0.0.1:15433/postgres?sslmode=disable');url.password=encodeURIComponent(values.POSTGRES_PASSWORD);return {url:url.href,addresses};
}
const identitySql=`SELECT current_database() AS database,current_user AS role,session_user AS session_role,
 current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
 current_setting('statement_timeout') AS statement_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
 host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,
 current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net`;
async function main(){let guard=false,target,phase='preflight',result={task:'T37',status:'BLOCKED',inventoryComplete:false,applyAuthorized:false,finalFreezeAudit:false,sourceDataRead:false,sourceAuthUserRead:false,macDataTransit:false};const controller=new AbortController(),interrupt=()=>{controller.abort();target?.connection?.stream?.destroy();};let timer;
 try{
  if(process.argv.length!==6||process.argv[2]!=='--manifest'||process.argv[3]!==MANIFEST||process.argv[4]!=='--sha256'||! /^[a-f0-9]{64}$/.test(process.argv[5]))fail('T37_EXPLICIT_REVIEW_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||fileURLToPath(import.meta.url)!==SELF||!Object.values(networkInterfaces()).flat().some(i=>i?.address==='152.228.115.115')||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('T37_PINNED_VPS_RUNTIME');
  for(const d of [PRIVATE,RUNTIME,RUNTIME+'/scripts',RUNTIME+'/payloads'])directory(d);
  const m=validateManifest(privateRead(MANIFEST),process.argv[5],sha(privateRead(SELF)));
  for(const [p,h] of Object.entries({...m.runtime_files,...VERIFY_PINS}))if(sha(privateRead(p))!==h)fail('T37_RUNTIME_SHA');
  validatePrior(privateRead(PRIVATE+'/t36-https-probe-result.json'),m.input_evidence.T36_result_sha256);
  const token=privateRead(PRIVATE+'/t36-https-capability',64).toString('utf8'),prepared=JSON.parse(privateRead(PRIVATE+'/t36-https-prepared.json'));validateCapability(token,prepared);
  for(const name of ['t37-https-inventory.guard','t37-https-inventory-result.json'])try{fs.lstatSync(PRIVATE+'/'+name);fail('T37_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  const [{snapshotDatabase,compareSnapshots},{exactQueryFingerprint},{authRowsSql,authRowsPlan},{databaseConfig},{assertMigrationTarget},{default:pg}]=await Promise.all([
   import(RUNTIME+'/scripts/migration-audit.mjs'),import(RUNTIME+'/payloads/exact-query-fingerprint.mjs'),import(RUNTIME+'/payloads/t30-auth-compact.mjs'),import(INSTALLED+'/scripts/database-config.mjs'),import(INSTALLED+'/scripts/migration-source.mjs'),import(INSTALLED+'/node_modules/pg/lib/index.js')]);
  const pkg=JSON.parse(fs.readFileSync(INSTALLED+'/node_modules/pg/package.json','utf8'));if(pkg.version!=='8.23.1')fail('T37_DRIVER_VERSION');
  const records=JSON.parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],{encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));if(records.length!==1)fail('T37_TARGET_CONTAINER');const config=targetConfig(records[0]);assertMigrationTarget(config.url);
  target=new pg.Client({...databaseConfig(config.url,{BRON_DB_ALLOW_LOCAL_PLAIN:'1'}),options:'-c default_transaction_read_only=on',query_timeout:6000,application_name:'bron-t37-target-inventory'});target.on('error',()=>{});
  timer=setTimeout(interrupt,140000);process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt);
  const captureTarget=async()=>{phase='target-snapshot';if(controller.signal.aborted)fail('T37_WALL_DEADLINE');await target.connect();const startedUtc=new Date().toISOString();let authRows;
   const db={query:async(sql,values)=>{if(controller.signal.aborted)fail('T37_WALL_DEADLINE');const r=await target.query(sql,values);if(/^\s*begin\b/i.test(sql)){await target.query("SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='10s'");verifyTargetIdentity((await target.query(identitySql)).rows[0],config.addresses);}return r;}};
   const snapshot=await snapshotDatabase(db,{fingerprintQuery:exactQueryFingerprint,beforeCommit:async client=>{verifyTargetIdentity((await client.query(identitySql)).rows[0],config.addresses);authRows=validateAuthRows((await client.query(authRowsSql)).rows);}});
   return {snapshot,authRows,window:{startedUtc,finishedUtc:new Date().toISOString()}};
  };
  phase='source-https';validateCapability(token,prepared);result={...result,...await runInventory({token,captureTarget,compareSnapshots,authRowsPlan,signal:controller.signal,onSourceRead:()=>{result.sourceDataRead=true;result.sourceAuthUserRead=true;},guard:()=>{exclusiveWrite(PRIVATE+'/t37-https-inventory.guard',JSON.stringify({task:'T37',manifestSha256:process.argv[5],startedUtc:new Date().toISOString()})+'\n');guard=true;result.sourceReadAttempted=true;result.sourceDataRead=null;result.sourceAuthUserRead=null;}})};
 }catch(e){result={...result,status:'BLOCKED',phase,...(e?.safeReply?{reply:e.safeReply}:{}),code:/^(?:T37_|EXACT_FINGERPRINT_|AUTH_PLAN_|MIGRATION_)[A-Z0-9_]+$/.test(e?.code??'')?e.code:/^[0-9A-Z]{5}$/.test(e?.code??'')?e.code:e?.message==='Query read timeout'?'PG_QUERY_READ_TIMEOUT':'T37_FAILED'};}
 finally{clearTimeout(timer);process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);controller.abort();target?.connection?.stream?.destroy();await target?.end().catch(()=>{});result.cleanup={targetClientClosed:true,sourceHttpsClosed:true};if(guard)try{exclusiveWrite(PRIVATE+'/t37-https-inventory-result.json',JSON.stringify(result)+'\n');}catch{result.status='BLOCKED';result.code='T37_RESULT_WRITE';}}
 console.log('T37_INVENTORY_RESULT',JSON.stringify(result));if(['BLOCKED','LIVE_MISMATCH'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
