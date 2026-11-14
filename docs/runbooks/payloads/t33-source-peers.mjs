// Bounded synthetic probe of at most two currently resolved ALTERNATIVE peers.
// No old-peer replay, Auth/business query, route change, tunnel or Mac transit.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {resolve4} from 'node:dns/promises';
import {execFileSync} from 'node:child_process';
import {SOURCE_HOST,validatedSourcePeerConfig,runDummyProbe,dummyStages,parseTcpInfo,safeCode as oldSafeCode} from './t31-source-network.mjs';

const PRIVATE='/root/bron-secrets',RUNTIME='/opt/bron/audit-runtime-c128f9b';
export const FAILED_PEER='34.215.156.231';
export const T32_RESULT_SHA='6265d628f08feb0707b10f31f2575cbdf9822e7da1c217b4f00249ad0a617971';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeCode=e=>/^T33_[A-Z0-9_]+$/.test(e?.code??'')||['ENOTFOUND','ENODATA','ESERVFAIL','ETIMEOUT','EAI_AGAIN'].includes(e?.code)?e.code:oldSafeCode(e);
export function validateT32Evidence(value){
 if(value?.task!=='T32'||value.status!=='BLOCKED'||value.retainedRoute!==false||
  value.routeStatus!=='RESTORED_NO_HOST_ROUTE'||value.selectedPeerIPv4!==FAILED_PEER||value.canonicalHost!==SOURCE_HOST)
  fail('T33_T32_RECOVERY_NOT_PROVED');
 return true;
}
function publicV4(address){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a!==0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127);
}
export function selectAlternativePeers(addresses){
 if(!Array.isArray(addresses)||!addresses.length||addresses.length>8||!addresses.every(publicV4))fail('T33_CANONICAL_DNS_INVALID');
 return [...new Set(addresses)].filter(address=>address!==FAILED_PEER).slice(0,2);
}
const complete=probe=>probe?.status==='PASS'&&probe.bulkBytes===1048576&&Array.isArray(probe.steps)&&
 [...dummyStages.map(s=>s.name),'rollback'].every(name=>probe.steps.some(s=>s.step===name&&s.status==='PASS'))&&
 !probe.steps.some(s=>s.status==='FAIL');
export async function probeAlternativePeers({sourceConfig,resolvedAddresses,openClient,onStep=()=>{},onClient=()=>{},onAttempt=()=>{},tcpInfo=()=>({status:'UNAVAILABLE'})}){
 const selected=selectAlternativePeers(resolvedAddresses),attempts=[];
 if(!selected.length)return{status:'BLOCKED',code:'T33_NO_UNTESTED_CURRENT_PEER',attempts};
 for(const [index,address]of selected.entries()){
  const peer={canonicalHost:SOURCE_HOST,address,resolvedAddresses:[...resolvedAddresses]};
  const config=validatedSourcePeerConfig(sourceConfig,peer);
  await onAttempt({attempt:index+1,peerIPv4:address,status:'STARTED'});
  const probe=await runDummyProbe({openClient:()=>openClient(config,peer),onClient,
   tcpInfo:client=>tcpInfo(client,peer),onStep:step=>onStep({attempt:index+1,peerIPv4:address,...step})});
  attempts.push({peerIPv4:address,...probe});
  await onAttempt({attempt:index+1,peerIPv4:address,...probe});
  if(complete(probe))return{status:'PASS',selectedPeerIPv4:address,attempts};
 }
 return{status:'BLOCKED',code:'T33_NO_VERIFIED_ALTERNATIVE_PEER',attempts};
}
function privateRead(filename,maximum){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>maximum)fail('T33_PRIVATE_FILE_UNSAFE');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function privateWrite(filename,value,{exclusive=false}={}){
 const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(exclusive?fs.constants.O_EXCL:0),0o600);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||(s.mode&0o777)!==0o600||s.nlink!==1)fail('T33_PRIVATE_FILE_UNSAFE');fs.ftruncateSync(fd,0);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const dir=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function optionalSs(){
 for(const candidate of ['/usr/sbin/ss','/usr/bin/ss','/sbin/ss','/bin/ss']){
  try{const real=fs.realpathSync(candidate),s=fs.statSync(real);if(s.isFile()&&s.uid===0&&!(s.mode&0o022)&&(s.mode&0o111))return real;}catch{}
 }return null;
}
async function main(){
 let phase='preflight',ownGuard=false,stopping=false;
 const clients=new Set(),resultPath=PRIVATE+'/t33-source-network-result.json';
 const receipt={task:'T33',status:'RUNNING',startedUtc:new Date().toISOString(),sourceDataRead:false,macDataTransit:false,retainedRoute:false,transport:'baseline'};
 const save=()=>{if(ownGuard)privateWrite(resultPath,{...receipt,finishedUtc:new Date().toISOString()});};
 const stop=code=>{
  if(stopping)return;stopping=true;
  for(const client of clients)client.connection?.stream?.destroy();
  receipt.status='BLOCKED';receipt.code=code;try{save();}catch{}
  console.error('T33_NETWORK_BLOCKED',JSON.stringify({phase,code}));process.exit(2);
 };
 const onTerm=()=>stop('T33_SIGNAL_TERMINATED'),onInt=()=>stop('T33_SIGNAL_INTERRUPTED');
 process.on('SIGTERM',onTerm);process.on('SIGINT',onInt);
 const timer=setTimeout(()=>stop('T33_WALL_DEADLINE'),110000);
 try{
  if(process.argv.length!==2||process.platform!=='linux'||process.getuid?.()!==0||process.version!=='v22.23.5'||
   fs.realpathSync(process.execPath)!=='/opt/bron/node-v22.23.5-linux-x64/bin/node')fail('T33_VPS_PINNED_ROOT_RUNTIME_REQUIRED');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  const dir=fs.lstatSync(PRIVATE);if(!dir.isDirectory()||dir.uid!==0||(dir.mode&0o777)!==0o700)fail('T33_PRIVATE_DIRECTORY_UNSAFE');
  if(fs.existsSync(resultPath))fail('T33_PRIOR_STATE_RECONCILIATION_REQUIRED');
  const pins={
   [RUNTIME+'/scripts/migration-source.mjs']:'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
   [PRIVATE+'/t30-auth-compact.mjs']:'0e34802b3308df318a210a55bc2f379c517554fa9d73775453738adb371ae661',
   [PRIVATE+'/t31-source-network.mjs']:'9ef0c3e8c32626b7760e307efc57f26c033affddeef43f4841e70ebb5a2f8472'};
  for(const [filename,sha]of Object.entries(pins))if(createHash('sha256').update(fs.readFileSync(filename)).digest('hex')!==sha)fail('T33_RUNTIME_SHA');
  if(JSON.parse(fs.readFileSync(RUNTIME+'/node_modules/pg/package.json','utf8')).version!=='8.23.1')fail('T33_DRIVER_VERSION');
  const prior=privateRead(PRIVATE+'/t32-source-network-result.json',65536);
  if(createHash('sha256').update(prior).digest('hex')!==T32_RESULT_SHA)fail('T33_T32_RESULT_SHA');
  validateT32Evidence(JSON.parse(prior));
  const {sourceServiceConfig}=await import(RUNTIME+'/scripts/migration-source.mjs');
  const {default:pg}=await import(RUNTIME+'/node_modules/pg/lib/index.js');
  const sourceConfig=sourceServiceConfig(),ss=optionalSs();
  privateWrite(PRIVATE+'/t33-network-helper.guard',{task:'T33',attemptsPerNewPeer:1,maxNewPeers:2,startedUtc:receipt.startedUtc,t32ResultSha256:T32_RESULT_SHA},{exclusive:true});ownGuard=true;
  phase='canonical-dns';
  const addresses=[...new Set(await resolve4(SOURCE_HOST))];
  selectAlternativePeers(addresses);
  Object.assign(receipt,{canonicalHost:SOURCE_HOST,resolvedAddresses:addresses,t32ResultSha256:T32_RESULT_SHA});save();
  phase='alternative-peer-probes';
  const result=await probeAlternativePeers({sourceConfig,resolvedAddresses:addresses,openClient:config=>new pg.Client(config),onClient:client=>clients.add(client),
   onAttempt:async attempt=>{receipt.attempts??=[];receipt.attempts[attempt.attempt-1]=attempt;save();},
   onStep:step=>{console.log('T33_DUMMY_STEP',JSON.stringify(step));},
   tcpInfo:(client,peer)=>{
    const port=client.connection?.stream?.localPort;if(!ss||!Number.isInteger(port))return{status:'UNAVAILABLE'};
    try{return parseTcpInfo(execFileSync(ss,['-tinH','dst',peer.address,'dport','=',':6543','sport','=',':'+port],{encoding:'utf8',timeout:1000,maxBuffer:65536,
     env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C',LC_ALL:'C'},stdio:['ignore','pipe','ignore']}));}catch{return{status:'UNAVAILABLE'};}
   }});
  Object.assign(receipt,result);save();
  console.log('T33_NETWORK_RESULT',JSON.stringify({status:receipt.status,selectedPeerIPv4:receipt.selectedPeerIPv4??null,
   attemptedPeers:receipt.attempts.length,bulkPass:receipt.status==='PASS',retainedRoute:false,transport:'baseline',sourceDataRead:false,macDataTransit:false,resultPath}));
  if(receipt.status!=='PASS')process.exitCode=2;
 }catch(error){
  receipt.status='BLOCKED';receipt.phase=phase;receipt.code=safeCode(error);try{save();}catch{}
  console.error('T33_NETWORK_BLOCKED',JSON.stringify({phase,code:receipt.code}));process.exitCode=2;
 }finally{clearTimeout(timer);process.off('SIGTERM',onTerm);process.off('SIGINT',onInt);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
