// Fresh T37: generate a machine capability on the VPS, without reading Source rows.
import fs from 'node:fs';
import path from 'node:path';
import {networkInterfaces} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
const PRIVATE='/root/bron-secrets',SELF=PRIVATE+'/t37-https-prepare.mjs',MANIFEST=PRIVATE+'/t37-https.json';
const NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node',BUDGET=PRIVATE+'/t37-runtime/payloads/source-transfer-budget.mjs';
const KEY='docs/runbooks/payloads/t37-https-prepare.mjs',REF='vkkqffvmztpzgygzfxhq',ORIGIN='https://'+REF+'.supabase.co';
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function validatePrepareManifest(raw,digest,selfSha){
 if(!/^[a-f0-9]{64}$/.test(digest??'')||sha(raw)!==digest)fail('T37_MANIFEST_SHA');
 let m;try{m=JSON.parse(raw);}catch{fail('T37_MANIFEST_JSON');}
 const b=m.transfer_budget;
 if(m.task!=='T37'||m.execution_authorized!==true||m.approval?.status!=='APPROVED'||m.files?.[KEY]!==selfSha||!/^[a-f0-9]{64}$/.test(selfSha??'')||
 b?.directory!==PRIVATE+'/source-transfer-budget'||b.source_project!==REF||b.destination_vps!=='152.228.115.115'||b.max_attempts!==3||
 !/^[a-f0-9]{64}$/.test(b.scope_sha256??'')||m.approval.document_sha256!==b.scope_sha256||
 m.source?.capability_binding!=='pinned_VPS_prepare_readback'||m.source.template_name_prefix!=='bron-source-reader-'||
 !/^[a-f0-9]{64}$/.test(m.runtime_files?.[BUDGET]??''))fail('T37_PREPARE_SCOPE');
 return m;
}
function syncParent(p){const f=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(f);}finally{fs.closeSync(f);}}
function write(p,b){const f=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(f,b);fs.fsyncSync(f);}finally{fs.closeSync(f);}syncParent(p);}
function read(p,max=1048576){const f=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const s=fs.fstatSync(f);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>max)fail('T37_PRIVATE_FILE');return fs.readFileSync(f);}finally{fs.closeSync(f);}}
export function createPrepared({manifestSha256,scopeSha256,now=Date.now(),random=randomBytes,writeSecret}){
 if(!/^[a-f0-9]{64}$/.test(manifestSha256??'')||!/^[a-f0-9]{64}$/.test(scopeSha256??'')||!Number.isSafeInteger(now)||typeof writeSecret!=='function')fail('T37_PREPARE_ARGUMENTS');
 const raw=random(32);if(!Buffer.isBuffer(raw)||raw.length!==32)fail('T37_RANDOM');
 const token=Buffer.from(raw.toString('hex'),'ascii');raw.fill(0);
 try{const capabilitySha256=sha(token);writeSecret(token);return {task:'T37',manifestSha256,ownerGrantSha256:scopeSha256,origin:ORIGIN,protocol:'BRON_PRIVATE_SNAPSHOT_V1',createdUtc:new Date(now).toISOString(),expiresUtc:new Date(now+7200000).toISOString(),capabilitySha256,functionName:'bron-source-reader-'+capabilitySha256.slice(0,12)};}
 finally{token.fill(0);}
}
async function main(){let phase='preflight',result={task:'T37',status:'BLOCKED',sourceDataRead:false,sourceAuthUserRead:false,macDataTransit:false};
 try{
  if(process.argv.length!==7||process.argv[2]!=='--prepare'||process.argv[3]!=='--manifest'||process.argv[4]!==MANIFEST||process.argv[5]!=='--sha256')fail('T37_EXPLICIT_REVIEW_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||process.execPath!==NODE||process.versions.node!=='22.23.5'||fileURLToPath(import.meta.url)!==SELF||!Object.values(networkInterfaces()).flat().some(x=>x?.address==='152.228.115.115'))fail('T37_PINNED_VPS_RUNTIME');
  const d=fs.lstatSync(PRIVATE);if(!d.isDirectory()||d.uid!==0||d.gid!==0||(d.mode&0o777)!==0o700)fail('T37_PRIVATE_DIRECTORY');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  const m=validatePrepareManifest(read(MANIFEST),process.argv[6],sha(read(SELF)));
  if(sha(read(BUDGET))!==m.runtime_files[BUDGET])fail('T37_BUDGET_MODULE_SHA');
  for(const n of ['t37-https-prepare.guard','t37-https-capability','t37-https-prepared.json','t37-https-inventory.guard','t37-https-inventory-result.json']){try{fs.lstatSync(PRIVATE+'/'+n);fail('T37_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}
  const b=m.transfer_budget,{prepareBudget,readBudgetStatus}=await import('file://'+BUDGET);
  const binding={directory:b.directory,scopeSha256:b.scope_sha256,sourceProject:b.source_project,destinationVps:b.destination_vps,maxAttempts:b.max_attempts};
  write(PRIVATE+'/t37-https-prepare.guard',JSON.stringify({task:'T37',manifestSha256:process.argv[6],startedUtc:new Date().toISOString()})+'\n');
  phase='budget';prepareBudget(binding);const budget=readBudgetStatus(binding);if(budget.used!==0)fail('T37_PRIOR_AUTH_ATTEMPTS');
  phase='prepare';const prepared=createPrepared({manifestSha256:process.argv[6],scopeSha256:b.scope_sha256,writeSecret:bytes=>{const p=PRIVATE+'/t37-https-capability';write(p,bytes);if(sha(read(p,64))!==sha(bytes))fail('T37_CAPABILITY_READBACK');}});
  write(PRIVATE+'/t37-https-prepared.json',JSON.stringify(prepared)+'\n');result={...result,...prepared,status:'READY',budgetUsed:0,budgetRemaining:3};
 }catch(e){result={...result,status:'BLOCKED',phase,code:/^(?:T37_|SOURCE_TRANSFER_)[A-Z0-9_]+$/.test(e?.code??'')?e.code:e?.code==='EEXIST'?'T37_ALREADY_STARTED':'T37_PREPARE_FAILED'};}
 console.log(result.status==='READY'?'T37_READY':'T37_PREPARE_RESULT',JSON.stringify(result));if(result.status!=='READY')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
