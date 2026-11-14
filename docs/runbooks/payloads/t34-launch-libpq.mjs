// Fixed T34 delivery/activation recipe. Synthetic-only helper; no source data.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const PRIVATE='/root/bron-secrets',NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node';
const HELPER_SHA='79ccda1c8565a9c0274b31ac2bab1a295f9275443b0b16eab37f40d68ad8eb02';
const T33_SHA='42f1d653fc8938af78377c501c91ee9b6668b0e04cfb280e0f2713c3fc13c492';
const DB_ID='51071996d381fbfa6a1b6c530045881a5cee6a8c82ee482d83bbf8b47ccf8117';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function activationFromEvidence(prior,target,now=Date.now()){
 if(prior?.task!=='T33'||prior.status!=='BLOCKED'||prior.transport!=='baseline'||prior.retainedRoute!==false||
   prior.selectedPeerIPv4!==undefined||prior.canonicalHost!=='aws-1-us-west-2.pooler.supabase.com'||
   !Array.isArray(prior.resolvedAddresses)||!prior.resolvedAddresses.includes('34.215.156.231')||
   !Array.isArray(prior.attempts)||prior.attempts.length!==2||
   new Set(prior.attempts.map(a=>a.peerIPv4)).size!==2||prior.attempts.some(a=>a.peerIPv4==='34.215.156.231'||
    a.status!=='FAIL'||a.phase!=='single512'||a.code!=='PG_QUERY_READ_TIMEOUT'||
    !a.steps?.some(s=>s.step==='single128'&&s.status==='PASS')))
   fail('T34_PRIOR_EVIDENCE_MISMATCH');
 if(target?.id!==DB_ID||target.running!==true||!/^sha256:[0-9a-f]{64}$/.test(target.image??''))
   fail('T34_TARGET_IMAGE_IDENTITY');
 return {task:'SOURCE_LIBPQ_SYNTHETIC_V1',canonicalHost:prior.canonicalHost,address:'34.215.156.231',
  resolvedAddresses:[...prior.resolvedAddresses],helperSha256:HELPER_SHA,targetImage:target.image,
  expiresUtc:new Date(now+3600000).toISOString()};
}
function readPrivate(filename){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>262144)fail('T34_PRIVATE_INPUT_UNSAFE');return fs.readFileSync(fd);}
 finally{fs.closeSync(fd);}
}
function exclusive(filename,bytes){
 const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const parent=fs.openSync(PRIVATE,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}
async function main(){let phase='preflight';
 try{
  if(process.argv.length!==2||process.platform!=='linux'||process.getuid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5')fail('T34_PINNED_VPS_RUNTIME');
  const d=fs.lstatSync(PRIVATE);if(!d.isDirectory()||d.uid!==0||(d.mode&0o777)!==0o700)fail('T34_PRIVATE_DIRECTORY');
  const helper=PRIVATE+'/source-libpq-probe.mjs';if(sha(readPrivate(helper))!==HELPER_SHA)fail('T34_HELPER_SHA');
  const raw=readPrivate(PRIVATE+'/t33-source-network-result.json');if(sha(raw)!==T33_SHA)fail('T34_PRIOR_SHA');
  const target=JSON.parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','--format',
   '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}}}','supabase-db'],
   {encoding:'utf8',timeout:3000,maxBuffer:4096,stdio:['ignore','pipe','ignore']}));
  const value=activationFromEvidence(JSON.parse(raw),target);
  const filename=PRIVATE+'/source-libpq-reviewed.json',bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');
  exclusive(PRIVATE+'/t34-libpq-launcher.guard',Buffer.from(JSON.stringify({task:'T34',action:'source_libpq_synthetic',t33Sha256:T33_SHA,createdUtc:new Date().toISOString()})+'\n'));
  exclusive(filename,bytes);const digest=sha(readPrivate(filename));if(digest!==sha(bytes))fail('T34_ACTIVATION_READBACK');
  console.log('T34_ACTIVATION',JSON.stringify({path:filename,sha256:digest,targetImage:target.image,sourceDataRead:false}));
  phase='synthetic-client';
  try{process.stdout.write(execFileSync(NODE,[helper,'--manifest',filename,'--manifest-sha256',digest],
   {encoding:'utf8',timeout:60000,maxBuffer:262144,stdio:['ignore','pipe','pipe']}));}
  catch(error){if(error.stdout)process.stdout.write(error.stdout);console.error('T34_CLIENT_EXIT',JSON.stringify({exit:Number.isInteger(error.status)?error.status:null,signal:error.signal??null}));process.exitCode=2;}
 }catch(error){console.error('T34_BLOCKED',JSON.stringify({phase,code:/^T34_[A-Z0-9_]+$/.test(error?.code??'')?error.code:error?.code==='EEXIST'?'T34_ALREADY_STARTED':'T34_PREFLIGHT_FAILED'}));process.exitCode=2;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
