// T36: VPS-only capability preparation and one fixed, read-only HTTPS dummy probe.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {networkInterfaces} from 'node:os';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
const PRIVATE='/root/bron-secrets',SELF=PRIVATE+'/t36-https-probe.mjs',MANIFEST=PRIVATE+'/t36-https.json',NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node';
const HOST='vkkqffvmztpzgygzfxhq.supabase.co',ORIGIN='https://'+HOST,REF='vkkqffvmztpzgygzfxhq',PROTOCOL='BRON_HTTPS_PROBE_V1',MAX_BODY=1048576;
const PRIOR_SHA='e69b851567e0ba3b674ef1eb81940e6f075ca382fe71a61651316755f25fc7bb',FILE_KEY='docs/runbooks/payloads/t36-https-probe.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),fail=code=>{throw Object.assign(new Error(code),{code});},object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function validateManifest(raw,digest,selfSha){
 if(!/^[a-f0-9]{64}$/.test(digest??'')||sha(raw)!==digest)fail('T36_MANIFEST_SHA');let m;try{m=JSON.parse(raw);}catch{fail('T36_MANIFEST_JSON');}
 if(m?.task!=='T36'||!/^[a-f0-9]{64}$/.test(selfSha??'')||m.files?.[FILE_KEY]!==selfSha)fail('T36_SELF_SHA');return m;
}
export function validatePrior(raw){
 if(sha(raw)!==PRIOR_SHA)fail('T36_PRIOR_SHA');let p;try{p=JSON.parse(raw);}catch{fail('T36_PRIOR_EVIDENCE');}validatePriorShape(p);return p;
}
export function validatePriorShape(p){
 const settings=p?.replies?.filter(r=>r.endpoint==='settings'),openapi=p?.replies?.filter(r=>r.endpoint==='openapi'),s=settings?.[0],o=openapi?.[0];
 if(p?.status!=='BLOCKED'||p.code!=='T35_METADATA_BLOCKED'||p.task!=='T35'||settings?.length!==1||openapi?.length!==1||p.replies.length!==2||s.status!=='PASS'||s.statusCode!==200||!Number.isSafeInteger(s.bytes)||s.bytes<512||s.jsonShape?.type!=='object'||s.jsonShape.external!=='object'||s.jsonShape.email!=='boolean'||s.jsonShape.disable_signup!=='boolean'||o.status!=='BLOCKED'||o.statusCode!==401||p.capability!==undefined)fail('T36_PRIOR_EVIDENCE');
}
function syncParent(filename){const fd=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function exclusiveWrite(filename,bytes){const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncParent(filename);}
export function createCapability(filename,now=Date.now(),random=randomBytes){
 const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let token;
 try{const b=random(32);if(!Buffer.isBuffer(b)||b.length!==32)fail('T36_RANDOM');token=b.toString('hex');fs.writeFileSync(fd,token,'ascii');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncParent(filename);
 const capabilitySha256=sha(Buffer.from(token,'ascii'));return {task:'T36',capabilitySha256,expiresUtc:new Date(now+7200000).toISOString(),functionName:'bron-https-probe-'+capabilitySha256.slice(0,12),origin:ORIGIN,protocol:PROTOCOL};
}
export function validatePrepared(p,token,now=Date.now()){
 if(p?.task!=='T36'||p.origin!==ORIGIN||p.protocol!==PROTOCOL||!/^[a-f0-9]{64}$/.test(token??'')||p.capabilitySha256!==sha(Buffer.from(token,'ascii'))||p.functionName!=='bron-https-probe-'+p.capabilitySha256.slice(0,12)||!Number.isSafeInteger(Date.parse(p.expiresUtc))||new Date(Date.parse(p.expiresUtc)).toISOString()!==p.expiresUtc||Date.parse(p.expiresUtc)<=now||Date.parse(p.expiresUtc)>now+7200000)fail('T36_PREPARED_INVALID');return p;
}
function privateRead(filename,max=MAX_BODY){const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>max)fail('T36_PRIVATE_FILE');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}}
export function requestJson(functionName,method,body,{request=https.request,signal,timeoutMs=5000,maxBody=MAX_BODY}={}){
 if(!/^bron-https-probe-[a-f0-9]{12}$/.test(functionName)||!['GET','POST'].includes(method)||(method==='GET'?body!==undefined:!/^[a-f0-9]{64}$/.test(body??''))||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>35000||!Number.isSafeInteger(maxBody)||maxBody<1||maxBody>MAX_BODY)fail('T36_REQUEST_SCOPE');
 return new Promise(resolve=>{let req,res,timer,done=false,bytes=0,statusCode=null;const chunks=[],started=performance.now();
  const finish=(code,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);req?.destroy();res?.destroy();resolve({statusCode,bytes,elapsedMs:Math.ceil(performance.now()-started),...(code?{code}:{}),...(value!==undefined?{value}:{})});};
  const abort=()=>finish('T36_WALL_DEADLINE');if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>finish('T36_HTTPS_TIMEOUT'),timeoutMs);
  try{req=request({protocol:'https:',hostname:HOST,port:443,servername:HOST,rejectUnauthorized:true,agent:false,method,path:'/functions/v1/'+functionName,headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'text/plain','Content-Length':'64'}:{})}},response=>{
   res=response;statusCode=Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599?res.statusCode:null;res.on('error',()=>finish('T36_HTTPS_FAILURE'));res.on('aborted',()=>finish('T36_HTTPS_FAILURE'));
   if(statusCode>=300&&statusCode<400){finish('T36_REDIRECT_REJECTED');return;}res.on('data',chunk=>{if(done)return;const b=Buffer.from(chunk);bytes+=b.length;if(bytes>maxBody){finish('T36_BODY_LIMIT');return;}chunks.push(b);});
   res.on('end',()=>{if(done)return;let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish('T36_JSON_INVALID');return;}finish(undefined,value);});
  });req.on('error',()=>finish('T36_HTTPS_FAILURE'));req.end(body,'ascii');}catch{finish('T36_HTTPS_FAILURE');}
 });
}
export const readyReply=r=>!r.code&&r.statusCode===403&&object(r.value)&&Object.keys(r.value).length===2&&r.value.ok===false&&r.value.probe_protocol===PROTOCOL;
const safeFailure=r=>({httpStatus:r.statusCode,bytes:r.bytes,elapsedMs:r.elapsedMs,...(r.code?{code:r.code}:{}),...(['authorization','configuration','dns','tls-negative','connect','read-only','dummy','rollback','deadline'].includes(r.value?.stage)?{remoteStage:r.value.stage}:{}),...(['PROBE_DENIED','PROBE_FAILED','PROBE_DEADLINE','PROBE_BLOCKED'].includes(r.value?.code)?{remoteCode:r.value.code}:{})});
export function validateSuccess(r,p,callStarted,now=Date.now()){
 const v=r.value,i=v?.identity,expiry=Date.parse(p.expiresUtc);
 if(r.code||r.statusCode!==200||v?.ok!==true||v.probe_protocol!==PROTOCOL||v.projectRef!==REF||v.tls_negative_rejected!==true||v.tls_verification!=='native-ca-and-hostname'||v.expires_epoch_ms!==expiry||!Number.isSafeInteger(v.started_epoch_ms)||!Number.isSafeInteger(v.finished_epoch_ms)||v.started_epoch_ms<callStarted-5000||v.started_epoch_ms>now+5000||v.finished_epoch_ms<v.started_epoch_ms||v.finished_epoch_ms>now+5000||v.finished_epoch_ms-v.started_epoch_ms>24000||v.finished_epoch_ms>=expiry||!object(i)||['database','role','session_role','owner'].some(k=>i[k]!=='postgres')||i.read_only!=='on'||i.isolation!=='repeatable read'||i.statement_timeout!=='5s'||i.idle_timeout!=='10s'||i.dummy!=='x'.repeat(524288)||!Number.isSafeInteger(i.pid)||i.pid<=0||!isIP(i.server_address)||typeof i.database_time!=='string'||!Number.isFinite(Date.parse(i.database_time)))fail('T36_RESPONSE_INVARIANT');
 return {httpStatus:200,bytes:r.bytes,elapsedMs:r.elapsedMs,probeProtocol:PROTOCOL,projectRef:REF,tlsNegativeRejected:true,startedEpochMs:v.started_epoch_ms,finishedEpochMs:v.finished_epoch_ms,expiresEpochMs:expiry,dummyBytes:524288,identity:{...Object.fromEntries(['database','role','session_role','owner','read_only','isolation','statement_timeout','idle_timeout','pid','server_address'].map(k=>[k,i[k]])),database_time:new Date(Date.parse(i.database_time)).toISOString()}};
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function runProbe(p,token,{send=requestJson,wait=delay,now=Date.now,guard=()=>{},signal}={}){
 validatePrepared(p,token,now());let ready=false,attempts=0;const pollingStarted=now();
 for(;attempts<24&&!signal?.aborted&&now()-pollingStarted<120000;attempts++){const started=now(),r=await send(p.functionName,'GET',undefined,{timeoutMs:Math.max(1,Math.min(5000,120000-(now()-pollingStarted))),signal});if(readyReply(r)){ready=true;attempts++;break;}if(attempts<23)await wait(Math.max(0,5000-(now()-started)));}
 if(!ready)return {task:'T36',status:'WAIT_COORDINATOR',code:'T36_FUNCTION_NOT_READY',readinessAttempts:attempts};
 validatePrepared(p,token,now());const started=now(),controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,35000);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 try{const remaining=()=>{if(controller.signal.aborted||now()-started>=35000)fail('T36_WALL_DEADLINE');return Math.max(1,35000-(now()-started));};
  const wrong=sha(Buffer.from('0'.repeat(64),'ascii'))===p.capabilitySha256?'1'.repeat(64):'0'.repeat(64),denied=await send(p.functionName,'POST',wrong,{timeoutMs:remaining(),signal:controller.signal});
  if(!readyReply(denied))return {task:'T36',status:'BLOCKED',phase:'wrong-capability',code:'T36_NEGATIVE_PROBE_FAILED',reply:safeFailure(denied),readinessAttempts:attempts};
  remaining();validatePrepared(p,token,now());guard();const callStarted=now(),r=await send(p.functionName,'POST',token,{timeoutMs:remaining(),signal:controller.signal});remaining();
  if(r.code||r.statusCode!==200)return {task:'T36',status:'BLOCKED',phase:'valid-probe',code:'T36_VALID_PROBE_FAILED',reply:safeFailure(r),readinessAttempts:attempts};
  return {task:'T36',status:'PASS',readinessAttempts:attempts,wrongCapabilityRejected:true,...validateSuccess(r,p,callStarted,now())};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}
async function main(){let probeInvoked=false,mode,phase='preflight',result={task:'T36',status:'BLOCKED',sourceDataRead:false,sourceAuthUserRead:false,macDataTransit:false};const controller=new AbortController(),interrupt=()=>controller.abort();
 try{
  if(process.argv.length!==7||!['--prepare','--probe'].includes(process.argv[2])||process.argv[3]!=='--manifest'||process.argv[4]!==MANIFEST||process.argv[5]!=='--sha256'||!/^[a-f0-9]{64}$/.test(process.argv[6]))fail('T36_EXPLICIT_REVIEW_REQUIRED');mode=process.argv[2];
  if(process.platform!=='linux'||process.getuid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||fileURLToPath(import.meta.url)!==SELF||!Object.values(networkInterfaces()).flat().some(i=>i?.address==='152.228.115.115')||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('T36_PINNED_VPS_RUNTIME');
  const d=fs.lstatSync(PRIVATE);if(!d.isDirectory()||d.uid!==0||(d.mode&0o777)!==0o700)fail('T36_PRIVATE_DIRECTORY');validateManifest(privateRead(MANIFEST),process.argv[6],sha(privateRead(SELF)));validatePrior(privateRead(PRIVATE+'/t35-https-result.json'));
  if(mode==='--prepare'){
   for(const name of ['t35-https-capability','t36-https-capability','t36-https-prepared.json','t36-https-probe.guard','t36-https-probe-result.json'])try{fs.lstatSync(PRIVATE+'/'+name);fail('T36_PRIOR_STATE');}catch(e){if(e.code!=='ENOENT')throw e;}
   exclusiveWrite(PRIVATE+'/t36-https-prepare.guard',JSON.stringify({task:'T36',manifestSha256:process.argv[6],startedUtc:new Date().toISOString()})+'\n');phase='prepare';const prepared=createCapability(PRIVATE+'/t36-https-capability');exclusiveWrite(PRIVATE+'/t36-https-prepared.json',JSON.stringify(prepared)+'\n');result={...prepared,status:'READY'};
  }else{phase='probe';const prepared=JSON.parse(privateRead(PRIVATE+'/t36-https-prepared.json')),token=privateRead(PRIVATE+'/t36-https-capability',64).toString('utf8');
   for(const name of ['t36-https-probe.guard','t36-https-probe-result.json'])try{fs.lstatSync(PRIVATE+'/'+name);fail('T36_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}
   process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt);probeInvoked=true;result={...result,...await runProbe(prepared,token,{signal:controller.signal,guard:()=>exclusiveWrite(PRIVATE+'/t36-https-probe.guard',JSON.stringify({task:'T36',manifestSha256:process.argv[6],startedUtc:new Date().toISOString()})+'\n')})};
  }
 }catch(e){result={...result,status:'BLOCKED',phase,code:/^T36_[A-Z0-9_]+$/.test(e?.code??'')?e.code:e?.code==='EEXIST'?'T36_ALREADY_STARTED':'T36_PREFLIGHT_FAILED'};}
 finally{process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);if(probeInvoked&&result.status!=='WAIT_COORDINATOR')try{exclusiveWrite(PRIVATE+'/t36-https-probe-result.json',JSON.stringify(result)+'\n');}catch{result.status='BLOCKED';result.code='T36_RESULT_WRITE';}}
 console.log(result.status==='READY'?'T36_READY':'T36_HTTPS_RESULT',JSON.stringify(result));if(!['PASS','READY'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
