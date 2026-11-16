// Bounded synthetic-response diagnosis. No business/Auth queries or backup bytes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {lookup} from 'node:dns/promises';
import {execFileSync} from 'node:child_process';
import {directSourceConfig} from './t30-auth-compact.mjs';

export const SOURCE_HOST='aws-1-us-west-2.pooler.supabase.com';
const PRIVATE='/root/bron-secrets',RUNTIME='/opt/bron/audit-runtime-c128f9b';
const fail=code=>{throw Object.assign(new Error(code),{code});};
function publicV4(address){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a!==0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127);
}
export function validatedSourcePeerConfig(sourceConfig,peer){
 const base=directSourceConfig(sourceConfig);
 if(peer?.canonicalHost!==SOURCE_HOST||!publicV4(peer.address)||!Array.isArray(peer.resolvedAddresses)||
  !peer.resolvedAddresses.length||peer.resolvedAddresses.length>8||!peer.resolvedAddresses.every(publicV4)||
  !peer.resolvedAddresses.includes(peer.address))fail('T31_CANONICAL_PEER_INVALID');
 // pg8.23.1 preserves explicit canonical servername for an IP connection host.
 // Keep the exact CA, identity callback and password callback; no insecure mode.
 return {...base,host:peer.address,connectionTimeoutMillis:8000,query_timeout:8000};
}
export const dummyStages=Object.freeze([
 {name:'single128',rows:1,bytes:128},{name:'single512',rows:1,bytes:512},
 {name:'multi8x64',rows:8,bytes:64},{name:'single1024',rows:1,bytes:1024},
 {name:'single4096',rows:1,bytes:4096},{name:'single1MiB',rows:1,bytes:1048576},
]);
export const dummySql=stage=>{
 if(!dummyStages.includes(stage))fail('T31_DUMMY_STAGE_INVALID');
 return stage.rows===1?`SELECT repeat('x',${stage.bytes}) AS payload`:
  `SELECT repeat('x',${stage.bytes}) AS payload FROM generate_series(1,${stage.rows}) AS ordinal ORDER BY ordinal`;
};
export function safeCode(error){
 if(/^T31_[A-Z0-9_]+$/.test(error?.code??''))return error.code;
 if(/^[0-9A-Z]{5}$/.test(error?.code??''))return error.code;
 if(error?.message==='Query read timeout')return 'PG_QUERY_READ_TIMEOUT';
 if(error?.message==='Connection terminated due to connection timeout')return 'PG_CONNECT_TIMEOUT';
 if(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN','EPIPE'].includes(error?.code))return error.code;
 return 'T31_PROBE_FAILED';
}
const timedOut=error=>error?.message==='Query read timeout'||['ETIMEDOUT','ECONNRESET','EPIPE'].includes(error?.code);
export async function runDummyProbe({openClient,onStep=()=>{},tcpInfo=()=>({status:'UNAVAILABLE'}),onClient=()=>{}}){
 const client=openClient();client.on?.('error',()=>{});
 onClient(client);
 const steps=[];let phase='connect',began=false,disconnected=false;
 const step=async(name,fn)=>{
  phase=name;const start=performance.now();
  try{const out=await fn();const record={step:name,status:'PASS',elapsedMs:Math.round(performance.now()-start)};steps.push(record);onStep(record);return out;}
  catch(error){const record={step:name,status:'FAIL',code:safeCode(error),elapsedMs:Math.round(performance.now()-start)};steps.push(record);onStep(record);throw error;}
 };
 let outcome;
 try{
  await step('connect',()=>client.connect());
  await step('begin',()=>client.query('BEGIN READ ONLY'));began=true;
  await step('serverDeadline',()=>client.query("SET LOCAL statement_timeout='4000'"));
  await step('idleDeadline',()=>client.query("SET LOCAL idle_in_transaction_session_timeout='10000'"));
  await step('identity',async()=>{
   const row=(await client.query("SELECT current_database() AS db,current_user AS role,current_setting('transaction_read_only') AS mode")).rows[0];
   if(row?.db!=='postgres'||row.role!=='postgres'||row.mode!=='on')fail('T31_SOURCE_IDENTITY');
  });
  for(const stage of dummyStages)await step(stage.name,async()=>{
   const rows=(await client.query(dummySql(stage))).rows;
   if(rows.length!==stage.rows||rows.some(r=>typeof r.payload!=='string'||Buffer.byteLength(r.payload)!==stage.bytes||!/^x+$/.test(r.payload)))fail('T31_DUMMY_RESPONSE_INVALID');
  });
  outcome={status:'PASS',phase:'complete',steps,bulkBytes:1048576};
 }catch(error){
  disconnected=timedOut(error)||['Connection terminated unexpectedly','Client has encountered a connection error and is not queryable'].includes(error?.message);
  outcome={status:'FAIL',phase,code:safeCode(error),steps,bulkBytes:0};
 }finally{
  try{outcome.tcpInfo=tcpInfo(client);}catch{outcome.tcpInfo={status:'UNAVAILABLE'};}
  if(began&&!disconnected){try{await step('rollback',()=>client.query('ROLLBACK'));}catch(error){outcome.status='FAIL';outcome.phase='rollback';outcome.code=safeCode(error);}}
  client.connection?.stream?.destroy();
  try{await Promise.race([Promise.resolve(client.end()),new Promise(resolve=>{const t=setTimeout(resolve,250);t.unref?.();})]);}catch{}
 }
 return outcome;
}
export const eligibleForMss=result=>result?.status==='FAIL'&&result.code==='PG_QUERY_READ_TIMEOUT'&&
 ['multi8x64','single1024','single4096','single1MiB'].includes(result.phase)&&
 ['single128','single512'].every(name=>result.steps?.some(s=>s.step===name&&s.status==='PASS'));

export function planPeerRoute({peer,exactRoutes,routeGet}){
 if(!publicV4(peer)||!Array.isArray(exactRoutes)||exactRoutes.length!==0||!Array.isArray(routeGet)||routeGet.length!==1)
  fail('T31_ROUTE_NOT_SIMPLE_OR_EXISTING');
 const r=routeGet[0];
 if(r.dst!==peer||isIP(r.gateway)!==4||isIP(r.prefsrc)!==4||typeof r.dev!=='string'||!/^[a-zA-Z0-9_.:-]{1,32}$/.test(r.dev)||
   r.table&&r.table!=='main'||r.type&&r.type!=='unicast'||r.nexthops||r.nhid||r.via||r.encap||r.multipath)
  fail('T31_ROUTE_NOT_SIMPLE_OR_EXISTING');
 const destination=peer+'/32',metric=42731;
 const common=[destination,'via',r.gateway,'dev',r.dev,'src',r.prefsrc,'metric',String(metric)];
 return {peer,destination,gateway:r.gateway,dev:r.dev,source:r.prefsrc,metric,mtu:1280,advmss:1200,
  add:['-4','route','add',...common,'mtu','1280','advmss','1200'],
  remove:['-4','route','del',...common]};
}
export function routeMatches(plan,routes){
 if(!Array.isArray(routes)||routes.length!==1)return false;
 const r=routes[0],metrics=Array.isArray(r.metrics)?(r.metrics.length===1?r.metrics[0]:{}):(r.metrics??{});
 return (r.dst===plan.destination||r.dst===plan.peer)&&r.gateway===plan.gateway&&r.dev===plan.dev&&r.prefsrc===plan.source&&
  r.metric===plan.metric&&metrics.mtu===1280&&metrics.advmss===1200&&(!r.table||r.table==='main')&&
  !r.nexthops&&!r.nhid&&!r.via&&!r.encap&&!r.multipath;
}
export function parseTcpInfo(output){
 const metrics={};
 for(const key of ['mss','rcvmss','advmss','rto','bytes_received','bytes_sent','bytes_acked','segs_out','segs_in','unacked']){
  const found=String(output).match(new RegExp('(?:^|\\s)'+key+':([0-9]+(?:\\.[0-9]+)?)\\b'));
  if(found){const n=Number(found[1]);if(Number.isFinite(n)&&n>=0)metrics[key]=n;}
 }
 return {status:Object.keys(metrics).length?'AVAILABLE':'UNAVAILABLE',metrics};
}
function privateFile(filename,value,{exclusive=false}={}){
 const bytes=JSON.stringify(value,null,2)+'\n',flags=fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|
  (exclusive?fs.constants.O_EXCL:0);
 const fd=fs.openSync(filename,flags,0o600);
 try{const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==0||(info.mode&0o777)!==0o600||info.nlink!==1)fail('T31_PRIVATE_FILE_UNSAFE');fs.ftruncateSync(fd,0);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const dir=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function binary(name){
 for(const candidate of ['/usr/sbin/','/usr/bin/','/sbin/','/bin/'].map(p=>p+name)){
  try{const real=fs.realpathSync(candidate),s=fs.statSync(real);if(s.isFile()&&s.uid===0&&!(s.mode&0o022)&&s.mode&0o111)return real;}catch{}
 }
 fail('T31_TOOLS_UNAVAILABLE');
}
function runJson(binary,args){
 return JSON.parse(execFileSync(binary,args,{encoding:'utf8',timeout:2500,maxBuffer:65536,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','ignore']}));
}
async function main(){
 let phase='preflight',plan=null,routeMayExist=false,ip,ownGuard=false,stopping=false;
 const clients=new Set();
 let receipt={task:'T31',startedUtc:new Date().toISOString(),status:'RUNNING',sourceDataRead:false,macDataTransit:false,retainedRoute:false};
 const resultPath=PRIVATE+'/t31-source-network-result.json';
 const save=()=>{if(ownGuard)privateFile(resultPath,{...receipt,finishedUtc:new Date().toISOString()});};
 const exact=()=>runJson(ip,['-4','-j','route','show','exact',plan.destination]);
 const removeRoute=()=>{
  if(!routeMayExist)return;
  const current=exact();
  if(current.length===0){routeMayExist=false;receipt.retainedRoute=false;receipt.routeStatus='RESTORED_NO_HOST_ROUTE';return;}
  if(!routeMatches(plan,current))fail('T31_ROUTE_CHANGED_CLEANUP_REQUIRED');
  execFileSync(ip,plan.remove,{timeout:2500,stdio:'ignore'});
  if(exact().length!==0)fail('T31_ROUTE_REMOVE_NOT_CONFIRMED');
  routeMayExist=false;receipt.retainedRoute=false;receipt.routeStatus='RESTORED_NO_HOST_ROUTE';
 };
 const stop=code=>{
  if(stopping)return;stopping=true;
  for(const client of clients)client.connection?.stream?.destroy();
  try{removeRoute();}catch{receipt.routeStatus='CLEANUP_REQUIRED';}
  receipt.status='BLOCKED';receipt.code=code;try{save();}catch{}
  console.error('T31_NETWORK_BLOCKED',JSON.stringify({phase,code,routeStatus:receipt.routeStatus??'NONE'}));process.exit(2);
 };
 const onTerm=()=>stop('T31_SIGNAL_TERMINATED'),onInt=()=>stop('T31_SIGNAL_INTERRUPTED');
 process.on('SIGTERM',onTerm);process.on('SIGINT',onInt);
 const timer=setTimeout(()=>stop('T31_WALL_DEADLINE'),100000);
 try{
  if(process.argv.length!==2||process.platform!=='linux'||process.getuid?.()!==0)fail('T31_VPS_ROOT_NO_ARGUMENTS');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  const dir=fs.lstatSync(PRIVATE);if(!dir.isDirectory()||dir.uid!==0||(dir.mode&0o777)!==0o700)fail('T31_PRIVATE_DIRECTORY_UNSAFE');
  const pins={
   [RUNTIME+'/scripts/migration-source.mjs']:'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
   [PRIVATE+'/t30-auth-compact.mjs']:'0e34802b3308df318a210a55bc2f379c517554fa9d73775453738adb371ae661'};
  for(const [filename,sha]of Object.entries(pins))if(createHash('sha256').update(fs.readFileSync(filename)).digest('hex')!==sha)fail('T31_RUNTIME_SHA');
  if(JSON.parse(fs.readFileSync(RUNTIME+'/node_modules/pg/package.json','utf8')).version!=='8.23.1')fail('T31_DRIVER_VERSION');
  ip=binary('ip');let ss;try{ss=binary('ss');}catch{}
  const {sourceServiceConfig}=await import(RUNTIME+'/scripts/migration-source.mjs');
  const {default:pg}=await import(RUNTIME+'/node_modules/pg/lib/index.js');
  const source=sourceServiceConfig();
  if(fs.existsSync(resultPath)||fs.existsSync(PRIVATE+'/t31-network-route-before.json'))fail('T31_PRIOR_STATE_RECONCILIATION_REQUIRED');
  phase='canonical-dns';const answers=await lookup(SOURCE_HOST,{all:true,family:4,verbatim:true});
  const addresses=[...new Set(answers.map(x=>x.address))];
  const peer={canonicalHost:SOURCE_HOST,address:addresses[0],resolvedAddresses:addresses};
  const config=validatedSourcePeerConfig(source,peer);receipt.peer=peer;
  privateFile(PRIVATE+'/t31-network-helper.guard',{task:'T31',startedUtc:receipt.startedUtc,attempt:1}, {exclusive:true});
  ownGuard=true;
  receipt.selectedPeerIPv4=peer.address;receipt.canonicalHost=peer.canonicalHost;receipt.resolvedAddresses=peer.resolvedAddresses;
  save();
  const tcpInfo=client=>{
   const port=client.connection?.stream?.localPort;
   if(!ss||!Number.isInteger(port))return {status:'UNAVAILABLE'};
   try{return parseTcpInfo(execFileSync(ss,['-tinH','dst',peer.address,'dport','=',':6543','sport','=',':'+port],{encoding:'utf8',timeout:1000,maxBuffer:65536,stdio:['ignore','pipe','ignore']}));}catch{return {status:'UNAVAILABLE'};}
  };
  const probe=label=>runDummyProbe({openClient:()=>new pg.Client(config),tcpInfo,onClient:client=>clients.add(client),
   onStep:step=>console.log('T31_DUMMY_STEP',JSON.stringify({attempt:label,...step}))});
  phase='baseline';receipt.baseline=await probe('baseline');save();
  if(receipt.baseline.status==='PASS'){receipt.status='PASS';receipt.routeStatus='UNCHANGED';receipt.transport='baseline';}
  else if(eligibleForMss(receipt.baseline)){
   phase='route-preflight';
   const exactRoutes=runJson(ip,['-4','-j','route','show','exact',peer.address+'/32']);
   const routeGet=runJson(ip,['-4','-j','route','get',peer.address]);
   plan=planPeerRoute({peer:peer.address,exactRoutes,routeGet});receipt.routePlan=plan;
   privateFile(PRIVATE+'/t31-network-route-before.json',{task:'T31',peer,exactRoutes,routeGet,plan,recordedUtc:new Date().toISOString()},{exclusive:true});
   phase='route-add';receipt.routeStatus='ADD_INTENT';save();
   routeMayExist=true;
   execFileSync(ip,plan.add,{timeout:2500,stdio:'ignore'});
   if(!routeMatches(plan,exact()))fail('T31_ROUTE_ADDED_STATE_MISMATCH');
   receipt.routeStatus='TEMPORARY_ADDED';save();
   phase='mitigated';receipt.mitigated=await probe('mitigated');
   if(receipt.mitigated.status==='PASS'){receipt.status='PASS';receipt.routeStatus='TEMPORARY_RETAINED_MIGRATION_ONLY';receipt.transport='temporary-mtu1280-advmss1200';receipt.retainedRoute=true;save();}
   else{removeRoute();receipt.status='BLOCKED';receipt.code='T31_NO_VERIFIED_IMPROVEMENT';}
  }else{receipt.status='BLOCKED';receipt.code='T31_MSS_EXPERIMENT_NOT_JUSTIFIED';receipt.routeStatus='UNCHANGED';}
  save();
  console.log('T31_NETWORK_RESULT',JSON.stringify({status:receipt.status,routeStatus:receipt.routeStatus,baseline:receipt.baseline.status,
   mitigated:receipt.mitigated?.status??'NOT_RUN',bulkPass:receipt.status==='PASS',sourceDataRead:false,macDataTransit:false,resultPath}));
  if(receipt.status!=='PASS')process.exitCode=2;
 }catch(error){
  try{removeRoute();}catch{receipt.routeStatus='CLEANUP_REQUIRED';}
  receipt.status='BLOCKED';receipt.phase=phase;receipt.code=safeCode(error);try{save();}catch{}
  console.error('T31_NETWORK_BLOCKED',JSON.stringify({phase,code:receipt.code,routeStatus:receipt.routeStatus??'NONE'}));process.exitCode=2;
 }finally{clearTimeout(timer);process.off('SIGTERM',onTerm);process.off('SIGINT',onInt);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
