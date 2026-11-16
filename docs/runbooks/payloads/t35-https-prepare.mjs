// T35: one fixed public-metadata HTTPS comparison; capability remains on the VPS.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes} from 'node:crypto';
const PRIVATE='/root/bron-secrets',SELF=PRIVATE+'/t35-https-prepare.mjs',MANIFEST=PRIVATE+'/t35-https.json';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',HOST='vkkqffvmztpzgygzfxhq.supabase.co',ORIGIN='https://'+HOST,REF='vkkqffvmztpzgygzfxhq';
const PRIOR_SHA='e71ff0679c268ce00d1f0575423676d5a469760b29044b02b36f2a165596d867',MAX_BODY=4*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex'),fail=code=>{throw Object.assign(new Error(code),{code});};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),kind=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
export function validateManifest(raw,digest,selfSha){
 if(!/^[a-f0-9]{64}$/.test(digest??'')||sha(raw)!==digest)fail('T35_MANIFEST_SHA');
 let m;try{m=JSON.parse(raw);}catch{fail('T35_MANIFEST_JSON');}
 if(m?.task!=='T35'||!/^([a-f0-9]{64})$/.test(selfSha??'')||m.files?.['docs/runbooks/payloads/t35-https-prepare.mjs']!==selfSha)fail('T35_SELF_SHA');
 const s=m.source;if(s?.origin!==ORIGIN||s.projectRef!==REF||typeof s.publicAnonKey!=='string'||!/^[-_a-zA-Z0-9]+\.[-_a-zA-Z0-9]+\.[-_a-zA-Z0-9]+$/.test(s.publicAnonKey))fail('T35_PUBLIC_SOURCE');
 try{const [h,p]=s.publicAnonKey.split('.').slice(0,2).map(x=>JSON.parse(Buffer.from(x,'base64url')));
  if(h.alg!=='HS256'||h.typ!=='JWT'||p.role!=='anon'||p.ref!==REF||/service_role/i.test(JSON.stringify([h,p])))fail('T35_PUBLIC_JWT');
 }catch{fail('T35_PUBLIC_JWT');}return m;
}
export function validatePrior(p){if(p?.status!=='BLOCKED'||p.phase!=='first512'||p.code!=='LIBPQ_PHASE_TIMEOUT'||p.clientRemoved!==true||p.credentialsRemoved!==true)fail('T35_PRIOR_EVIDENCE');}
export function metadataShape(value,endpoint){
 const shape={type:kind(value)};if(endpoint==='settings')Object.assign(shape,{external:kind(value?.external),email:kind(value?.external?.email),disable_signup:kind(value?.disable_signup)});
 else Object.assign(shape,{swagger:kind(value?.swagger),openapi:kind(value?.openapi),paths:kind(value?.paths)});
 const valid=object(value)&&(endpoint==='settings'?object(value.external)&&typeof value.external.email==='boolean'&&typeof value.disable_signup==='boolean':
  ((typeof value.swagger==='string'&&value.swagger==='2.0')||(typeof value.openapi==='string'&&/^3\.[0-9]+\.[0-9]+$/.test(value.openapi)))&&object(value.paths));
 return {shape,valid};
}
export function requestMetadata(endpoint,key,{request=https.request,signal,timeoutMs=15000,maxBody=MAX_BODY}={}){
 if(!['settings','openapi'].includes(endpoint)||timeoutMs>15000||timeoutMs<1||maxBody>MAX_BODY||maxBody<1)fail('T35_REQUEST_SCOPE');
 return new Promise(resolve=>{let req,res,timer,done=false,bytes=0,statusCode=null;const chunks=[];
  const finish=(code,jsonShape)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',aborted);req?.destroy();res?.destroy();
   resolve({endpoint,status:code?'BLOCKED':'PASS',statusCode,bytes,...(jsonShape?{jsonShape}:{}),...(code?{code}:{})});};
  const aborted=()=>finish('T35_WALL_DEADLINE');if(signal?.aborted){aborted();return;}signal?.addEventListener('abort',aborted,{once:true});
  timer=setTimeout(()=>finish('T35_HTTPS_TIMEOUT'),timeoutMs);
  try{req=request({protocol:'https:',hostname:HOST,port:443,servername:HOST,rejectUnauthorized:true,agent:false,method:'GET',
   path:endpoint==='settings'?'/auth/v1/settings':'/rest/v1/',headers:{Accept:endpoint==='settings'?'application/json':'application/openapi+json',apikey:key,Authorization:'Bearer '+key}},response=>{
    res=response;statusCode=Number.isInteger(res.statusCode)&&res.statusCode>=100&&res.statusCode<=599?res.statusCode:null;
    res.on('error',()=>finish('T35_HTTPS_FAILURE'));res.on('aborted',()=>finish('T35_HTTPS_FAILURE'));
    if(statusCode!==200){finish('T35_HTTP_STATUS');return;}
    res.on('data',chunk=>{if(done)return;const b=Buffer.from(chunk);bytes+=b.length;if(bytes>maxBody){finish('T35_BODY_LIMIT');return;}chunks.push(b);});
    res.on('end',()=>{if(done)return;let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{finish('T35_JSON_INVALID');return;}
     const {shape,valid}=metadataShape(value,endpoint);finish(valid?undefined:'T35_JSON_SHAPE',shape);});
   });req.on('error',()=>finish('T35_HTTPS_FAILURE'));req.end();
  }catch{finish('T35_HTTPS_FAILURE');}
 });
}
function privateRead(filename,max=MAX_BODY){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>max)fail('T35_PRIVATE_FILE');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function syncParent(filename){const fd=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function exclusiveWrite(filename,bytes){const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncParent(filename);}
export function createCapability(filename,now=Date.now(),random=randomBytes){
 const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let token;
 try{const bytes=random(32);if(!Buffer.isBuffer(bytes)||bytes.length!==32)fail('T35_RANDOM');token=bytes.toString('hex');fs.writeFileSync(fd,token+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncParent(filename);
 return {sha256:sha(Buffer.from(token,'ascii')),expiresUtc:new Date(now+2*60*60*1000).toISOString()};
}
export function caMetadata(raw){if(raw.length>MAX_BODY||/PRIVATE KEY/.test(raw.toString('ascii')))fail('T35_CA_UNSAFE');
 const certificateCount=(raw.toString('ascii').match(/-----BEGIN CERTIFICATE-----/g)??[]).length;if(!certificateCount)fail('T35_CA_UNSAFE');return {sha256:sha(raw),certificateCount};}
async function main(){let guard=false,phase='preflight',result={task:'T35',status:'BLOCKED',sourceDataRead:false,sourceAuthUserRead:false,macDataTransit:false};
 const started=performance.now(),controller=new AbortController(),interrupt=()=>controller.abort();let timer;
 try{
  if(process.argv.length!==6||process.argv[2]!=='--manifest'||process.argv[3]!==MANIFEST||process.argv[4]!=='--sha256'||!/^[a-f0-9]{64}$/.test(process.argv[5]))fail('T35_EXPLICIT_REVIEW_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||fileURLToPath(import.meta.url)!==SELF||
   !Object.values(networkInterfaces()).flat().some(i=>i?.address==='152.228.115.115')||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')fail('T35_PINNED_VPS_RUNTIME');
  const d=fs.lstatSync(PRIVATE);if(!d.isDirectory()||d.uid!==0||(d.mode&0o777)!==0o700)fail('T35_PRIVATE_DIRECTORY');
  const m=validateManifest(privateRead(MANIFEST),process.argv[5],sha(privateRead(SELF))),prior=privateRead(PRIVATE+'/source-libpq-probe-result.json');
  if(sha(prior)!==PRIOR_SHA)fail('T35_PRIOR_SHA');validatePrior(JSON.parse(prior));
  for(const p of ['t35-https-result.json','t35-https-capability'])try{fs.lstatSync(PRIVATE+'/'+p);fail('T35_PRIOR_STATE');}catch(e){if(e.code!=='ENOENT')throw e;}
  try{const s=fs.lstatSync('/opt/bron/source-ca-bundle.pem');if(!s.isFile()||s.isSymbolicLink()||s.size>MAX_BODY)fail('T35_CA_UNSAFE');result.publicCA=caMetadata(fs.readFileSync('/opt/bron/source-ca-bundle.pem'));}catch(e){if(e.code!=='ENOENT')throw e;}
  exclusiveWrite(PRIVATE+'/t35-https.guard',JSON.stringify({task:'T35',manifestSha256:process.argv[5],startedUtc:new Date().toISOString()})+'\n');guard=true;
  if(performance.now()-started>=35000)fail('T35_WALL_DEADLINE');timer=setTimeout(interrupt,35000-(performance.now()-started));process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt);
  phase='https';result.replies=[];for(const endpoint of ['settings','openapi'])result.replies.push(await requestMetadata(endpoint,m.source.publicAnonKey,{signal:controller.signal}));
  if(controller.signal.aborted||performance.now()-started>=35000)fail('T35_WALL_DEADLINE');
  if(result.replies.some(r=>r.status!=='PASS'))fail('T35_METADATA_BLOCKED');if(!result.replies.some(r=>r.bytes>=512))fail('T35_NO_512_BYTE_REPLY');
  phase='capability';result.capability=createCapability(PRIVATE+'/t35-https-capability');result.status='PASS';result.httpsAboveBlockedTcp=true;
 }catch(e){result={...result,status:'BLOCKED',phase,code:/^T35_[A-Z0-9_]+$/.test(e?.code??'')?e.code:e?.code==='EEXIST'?'T35_ALREADY_STARTED':'T35_PREFLIGHT_FAILED'};}
 finally{clearTimeout(timer);process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);result.elapsedMs=Math.ceil(performance.now()-started);
  if(guard)try{exclusiveWrite(PRIVATE+'/t35-https-result.json',JSON.stringify(result)+'\n');}catch{result.status='BLOCKED';result.code='T35_RESULT_WRITE';}}
 console.log('T35_HTTPS_RESULT',JSON.stringify(result));if(result.status!=='PASS')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
