// One explicitly authorized per-peer MTU/MSS experiment after pinned T31 evidence.
// No baseline retry, DNS rotation, Auth/business query, backup or Mac data transit.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SOURCE_HOST,validatedSourcePeerConfig,runDummyProbe,dummyStages,planPeerRoute,routeMatches,parseTcpInfo,safeCode as oldSafeCode} from './t31-source-network.mjs';

const PRIVATE='/root/bron-secrets',RUNTIME='/opt/bron/audit-runtime-c128f9b';
export const T31_RESULT_SHA='a4fa63fc4c269781c3c7062b9ba32cc67ef6174e09b4571ef104f32fcab7be99';
const PEER='34.215.156.231';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeCode=error=>/^T32_[A-Z0-9_]+$/.test(error?.code??'')?error.code:oldSafeCode(error);
export function validateT31Evidence(result){
 if(result?.task!=='T31'||result.status!=='BLOCKED'||result.routeStatus!=='UNCHANGED'||result.retainedRoute!==false||
  result.canonicalHost!==SOURCE_HOST||result.selectedPeerIPv4!==PEER||!Array.isArray(result.resolvedAddresses)||
  !result.resolvedAddresses.includes(PEER)||result.baseline?.status!=='FAIL'||result.baseline.phase!=='single512'||
  result.baseline.code!=='PG_QUERY_READ_TIMEOUT'||!Array.isArray(result.baseline.steps)||
  !result.baseline.steps.some(s=>s.step==='single128'&&s.status==='PASS')||
  !result.baseline.steps.some(s=>s.step==='single512'&&s.status==='FAIL'&&s.code==='PG_QUERY_READ_TIMEOUT')||
  result.mitigated!==undefined||result.transport!==undefined||result.routePlan!==undefined)
  fail('T32_T31_EVIDENCE_NOT_EXACT');
 return {canonicalHost:SOURCE_HOST,address:PEER,resolvedAddresses:[...result.resolvedAddresses]};
}
export function tcpComparison(before,after){
 const names=['mss','rcvmss','advmss','rto','bytes_received','bytes_sent','bytes_acked','unacked'];
 return Object.fromEntries(names.map(name=>{
  const a=before?.metrics?.[name],b=after?.metrics?.[name];
  const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  return[name,{before:valid(a)?a:null,after:valid(b)?b:null,change:valid(a)&&valid(b)?(a===b?'UNCHANGED':'CHANGED'):'UNAVAILABLE'}];
 }));
}
// Injected boundaries make add/ambiguous-add/inverse behavior testable without
// changing any test host route. persist must be durable before returning.
export async function runPeerRouteExperiment({plan,observe,add,remove,persist,probe,onMayExist=()=>{}}){
 let mayExist=false,retained=false;
 const cleanup=async()=>{
  if(!mayExist)return;
  const current=await observe();
  if(current.length){
   if(!routeMatches(plan,current))fail('T32_ROUTE_CHANGED_CLEANUP_REQUIRED');
   await remove();
   if((await observe()).length)fail('T32_ROUTE_REMOVE_NOT_CONFIRMED');
  }
  mayExist=false;onMayExist(false);await persist('restored');
 };
 try{
  await persist('before-image');await persist('add-intent');
  mayExist=true;onMayExist(true);await add();
  if(!routeMatches(plan,await observe()))fail('T32_ROUTE_ADDED_STATE_MISMATCH');
  await persist('added');
  const result=await probe();
  const complete=result?.status==='PASS'&&result.bulkBytes===1048576&&Array.isArray(result.steps)&&
   [...dummyStages.map(s=>s.name),'rollback'].every(name=>result.steps.some(s=>s.step===name&&s.status==='PASS'))&&
   !result.steps.some(s=>s.status==='FAIL');
  if(!complete)return{status:'BLOCKED',code:'T32_NO_VERIFIED_IMPROVEMENT',probe:result,retainedRoute:false};
  if(!routeMatches(plan,await observe()))fail('T32_ROUTE_CHANGED_CLEANUP_REQUIRED');
  await persist('verified-improvement');retained=true;
  return{status:'PASS',probe:result,retainedRoute:true};
 }finally{if(!retained)await cleanup();}
}
function privateRead(filename,maximum){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>maximum)fail('T32_PRIVATE_FILE_UNSAFE');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function privateWrite(filename,value,{exclusive=false}={}){
 const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(exclusive?fs.constants.O_EXCL:0),0o600);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||(s.mode&0o777)!==0o600||s.nlink!==1)fail('T32_PRIVATE_FILE_UNSAFE');fs.ftruncateSync(fd,0);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const dir=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function binary(name){
 for(const candidate of ['/usr/sbin/','/usr/bin/','/sbin/','/bin/'].map(p=>p+name)){
  try{const real=fs.realpathSync(candidate),s=fs.statSync(real);if(s.isFile()&&s.uid===0&&!(s.mode&0o022)&&(s.mode&0o111))return real;}catch{}
 }fail('T32_TOOLS_UNAVAILABLE');
}
const commandEnv={PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'};
function runJson(executable,args){return JSON.parse(execFileSync(executable,args,{encoding:'utf8',timeout:2500,maxBuffer:65536,env:commandEnv,stdio:['ignore','pipe','ignore']}));}
async function main(){
 let phase='preflight',ip,ss,plan=null,ownGuard=false,routeMayExist=false,stopping=false;
 const clients=new Set(),resultPath=PRIVATE+'/t32-source-network-result.json';
 const beforePath=PRIVATE+'/t32-network-route-before.json';
 const receipt={task:'T32',status:'RUNNING',startedUtc:new Date().toISOString(),sourceDataRead:false,macDataTransit:false,retainedRoute:false};
 const save=()=>{if(ownGuard)privateWrite(resultPath,{...receipt,finishedUtc:new Date().toISOString()});};
 const exact=()=>runJson(ip,['-4','-j','route','show','exact',plan.destination]);
 const remove=()=>execFileSync(ip,plan.remove,{timeout:2500,env:commandEnv,stdio:'ignore'});
 const cleanup=()=>{
  if(!routeMayExist)return;
  const current=exact();
  if(current.length){if(!routeMatches(plan,current))fail('T32_ROUTE_CHANGED_CLEANUP_REQUIRED');remove();if(exact().length)fail('T32_ROUTE_REMOVE_NOT_CONFIRMED');}
  routeMayExist=false;receipt.retainedRoute=false;receipt.routeStatus='RESTORED_NO_HOST_ROUTE';
 };
 const stop=code=>{
  if(stopping)return;stopping=true;
  for(const client of clients)client.connection?.stream?.destroy();
  try{cleanup();}catch{receipt.routeStatus='CLEANUP_REQUIRED';}
  receipt.status='BLOCKED';receipt.code=code;try{save();}catch{}
  console.error('T32_NETWORK_BLOCKED',JSON.stringify({phase,code,routeStatus:receipt.routeStatus??'NONE'}));process.exit(2);
 };
 const onTerm=()=>stop('T32_SIGNAL_TERMINATED'),onInt=()=>stop('T32_SIGNAL_INTERRUPTED');
 process.on('SIGTERM',onTerm);process.on('SIGINT',onInt);
 const timer=setTimeout(()=>stop('T32_WALL_DEADLINE'),100000);
 try{
  if(process.argv.length!==2||process.platform!=='linux'||process.getuid?.()!==0||process.version!=='v22.23.5'||
   fs.realpathSync(process.execPath)!=='/opt/bron/node-v22.23.5-linux-x64/bin/node')fail('T32_VPS_PINNED_ROOT_RUNTIME_REQUIRED');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  const dir=fs.lstatSync(PRIVATE);if(!dir.isDirectory()||dir.uid!==0||(dir.mode&0o777)!==0o700)fail('T32_PRIVATE_DIRECTORY_UNSAFE');
  if(fs.existsSync(resultPath)||fs.existsSync(beforePath))fail('T32_PRIOR_STATE_RECONCILIATION_REQUIRED');
  const pins={
   [RUNTIME+'/scripts/migration-source.mjs']:'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
   [PRIVATE+'/t30-auth-compact.mjs']:'0e34802b3308df318a210a55bc2f379c517554fa9d73775453738adb371ae661',
   [PRIVATE+'/t31-source-network.mjs']:'9ef0c3e8c32626b7760e307efc57f26c033affddeef43f4841e70ebb5a2f8472'};
  for(const [filename,sha]of Object.entries(pins))if(createHash('sha256').update(fs.readFileSync(filename)).digest('hex')!==sha)fail('T32_RUNTIME_SHA');
  if(JSON.parse(fs.readFileSync(RUNTIME+'/node_modules/pg/package.json','utf8')).version!=='8.23.1')fail('T32_DRIVER_VERSION');
  const bytes=privateRead(PRIVATE+'/t31-source-network-result.json',65536);
  if(createHash('sha256').update(bytes).digest('hex')!==T31_RESULT_SHA)fail('T32_T31_RESULT_SHA');
  const evidence=JSON.parse(bytes),peer=validateT31Evidence(evidence);
  const {sourceServiceConfig}=await import(RUNTIME+'/scripts/migration-source.mjs');
  const {default:pg}=await import(RUNTIME+'/node_modules/pg/lib/index.js');
  const config=validatedSourcePeerConfig(sourceServiceConfig(),peer);
  ip=binary('ip');try{ss=binary('ss');}catch{}
  privateWrite(PRIVATE+'/t32-network-helper.guard',{task:'T32',startedUtc:receipt.startedUtc,attempt:1,t31ResultSha256:T31_RESULT_SHA},{exclusive:true});ownGuard=true;
  Object.assign(receipt,{selectedPeerIPv4:peer.address,canonicalHost:peer.canonicalHost,resolvedAddresses:peer.resolvedAddresses,t31ResultSha256:T31_RESULT_SHA});save();
  phase='route-preflight';
  const exactRoutes=runJson(ip,['-4','-j','route','show','exact',peer.address+'/32']);
  const routeGet=runJson(ip,['-4','-j','route','get',peer.address]);
  plan=planPeerRoute({peer:peer.address,exactRoutes,routeGet});receipt.routePlan=plan;
  const tcpInfo=client=>{
   const port=client.connection?.stream?.localPort;if(!ss||!Number.isInteger(port))return{status:'UNAVAILABLE'};
   try{return parseTcpInfo(execFileSync(ss,['-tinH','dst',peer.address,'dport','=',':6543','sport','=',':'+port],{encoding:'utf8',timeout:1000,maxBuffer:65536,env:commandEnv,stdio:['ignore','pipe','ignore']}));}catch{return{status:'UNAVAILABLE'};}
  };
  const outcome=await runPeerRouteExperiment({plan,observe:exact,
   add:()=>{phase='route-add';execFileSync(ip,plan.add,{timeout:2500,env:commandEnv,stdio:'ignore'});},remove,
   onMayExist:value=>{routeMayExist=value;},
   persist:async action=>{
    if(action==='before-image')privateWrite(beforePath,{task:'T32',recordedUtc:new Date().toISOString(),t31ResultSha256:T31_RESULT_SHA,peer,exactRoutes,routeGet,plan},{exclusive:true});
    receipt.routeStatus={"before-image":'BEFORE_IMAGE_DURABLE',"add-intent":'ADD_INTENT',added:'TEMPORARY_ADDED',restored:'RESTORED_NO_HOST_ROUTE',"verified-improvement":'TEMPORARY_RETAINED_MIGRATION_ONLY'}[action];save();
   },probe:async()=>{
    phase='mitigated-dummy';
    return runDummyProbe({openClient:()=>new pg.Client(config),tcpInfo,onClient:client=>clients.add(client),
     onStep:step=>console.log('T32_DUMMY_STEP',JSON.stringify(step))});
   }});
  Object.assign(receipt,outcome,{tcpComparison:tcpComparison(evidence.baseline.tcpInfo,outcome.probe.tcpInfo)});
  if(outcome.status==='PASS')receipt.transport='temporary-mtu1280-advmss1200';
  save();
  console.log('T32_NETWORK_RESULT',JSON.stringify({status:receipt.status,bulkPass:receipt.status==='PASS',routeStatus:receipt.routeStatus,
   retainedRoute:receipt.retainedRoute,tcpComparison:receipt.tcpComparison,sourceDataRead:false,macDataTransit:false,resultPath}));
  if(receipt.status!=='PASS')process.exitCode=2;
 }catch(error){
  try{cleanup();}catch{receipt.routeStatus='CLEANUP_REQUIRED';}
  receipt.status='BLOCKED';receipt.phase=phase;receipt.code=safeCode(error);try{save();}catch{}
  console.error('T32_NETWORK_BLOCKED',JSON.stringify({phase,code:receipt.code,routeStatus:receipt.routeStatus??'NONE'}));process.exitCode=2;
 }finally{clearTimeout(timer);process.off('SIGTERM',onTerm);process.off('SIGINT',onInt);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
