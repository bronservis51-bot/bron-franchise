// One genuine T45 witness verification after a fresh Root fence observation.
// Original input/context, capability expiry, shared budget and core stay unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {networkInterfaces} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const ROOT='/root/bron-secrets',DIR=ROOT+'/t45-release',RUNTIME=ROOT+'/t45-runtime';
const STATE=ROOT+'/t48-witness-continuation',SELF=ROOT+'/t48-witness-continuation.mjs',MANIFEST=STATE+'/manifest.json';
const CURRENT=STATE+'/source-fence-current-approved.json',NODE='/opt/bron/node-v22.23.5-linux-x64/bin/node';
const CONTROL=ROOT+'/t40-admission-control-c40a2026.json',KEY=ROOT+'/t40-admission-key-proof-c40a2026.json';
const ACTION='T48.continue_T45_witness',REL='docs/runbooks/payloads/t48-witness-continuation.mjs';
export const expectedPins=Object.freeze({
 parentManifestSha256:'67b2bb6c7b72ef39bd66dbb2e008f177fb5b38ae9713e052ad8aee0aa5182ad8',
 oldFenceInputSha256:'09d2ceafa5ab4adb2017439e0c7df8a052ef7265f104c7e5d5708cc32c6fc811',
 oldPreparedContextSha256:'4141a28376644e42938c2b397149df51ba1335da55996c3275b98a7fa77368ce',
 basePreparedSha256:'ed0871f06237339c60218e84185b7d278e0881c5443ffddbbc2a8152e793220f',
 contextSha256:'6c012cc0c0682209fee35aa8b5efffa667a8db0ccc9ea6f9a8b9a2076f1fc53b',
 capabilitySha256:'920938e064729dca455bc902f98674775c70e52c5cfc265f5f537550410ebb98',
 expiresUtc:'2026-11-15T04:14:51.589Z',
 ownerApprovedInputSha256:'68b9789f062a5e3ad0d301afb251a5fb936f75712d6ffafddbd3fe6bda83a2a8',
});
const sha=x=>createHash('sha256').update(x).digest('hex'),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>Buffer.from(canonical(x)+'\n'),same=(a,b)=>canonical(a)===canonical(b);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const parse=b=>{try{return JSON.parse(b);}catch{fail('T48_JSON_INVALID');}};
export function validateManifest(raw,pin,selfSha){
 if(!digest(pin)||sha(raw)!==pin)fail('T48_MANIFEST_SHA');const m=parse(raw);
 if(m.task!=='T48'||m.actionId!==ACTION||m.execution_authorized!==true||
  m.maxWitnessRequests!==1||m.maxReadinessRequests!==1||m.sourceDataFrames!==0||m.expiryUnchanged!==true||
  !same(m.pins,expectedPins)||!digest(selfSha)||m.files?.[REL]!==selfSha)fail('T48_SCOPE_INVALID');
 return m;
}

// Pure binding only: production first validates the fixed task manifest above.
// The old sealed approval is historical evidence, never asserted fresh now.
export async function renewWitnessObservation({pins,oldApprovalBytes,currentApprovalBytes,currentApprovalSha256,
 preparedBytes,baseBytes,control,now=Date.now()},validators){
 if(!digest(currentApprovalSha256)||sha(currentApprovalBytes)!==currentApprovalSha256||
  sha(oldApprovalBytes)!==pins.oldFenceInputSha256||sha(preparedBytes)!==pins.oldPreparedContextSha256||
  sha(baseBytes)!==pins.basePreparedSha256)fail('T48_INPUT_SHA');
 const oldApproval=parse(oldApprovalBytes),currentApproval=parse(currentApprovalBytes),prepared=parse(preparedBytes),base=parse(baseBytes);
 if(!bytes(oldApproval).equals(oldApprovalBytes)||!bytes(currentApproval).equals(currentApprovalBytes)||
  !bytes(prepared).equals(preparedBytes))fail('T48_CANONICAL_INPUT');
 const withoutTime=x=>{const result={...x};delete result.observedUtc;return result;};
 if(!same(withoutTime(oldApproval),withoutTime(currentApproval))||
  !(Date.parse(currentApproval.observedUtc)>Date.parse(oldApproval.observedUtc))||
  base.capabilitySha256!==pins.capabilitySha256||base.expiresUtc!==pins.expiresUtc||
  prepared.contextSha256!==pins.contextSha256||sha(JSON.stringify(prepared.context))!==pins.contextSha256)
  fail('T48_RENEWAL_BINDING');
 const cfg={manifestSha:pins.parentManifestSha256,baseSha:pins.basePreparedSha256,base,control};
 validators.validateBase(base,pins.parentManifestSha256,now);
 await validators.validatePreparedContext(prepared,{manifestSha:pins.parentManifestSha256,basePrepared:base,
  basePreparedSha:pins.basePreparedSha256,rootApproved:oldApproval});
 validators.validateRootInput(currentApproval,{...cfg,now}); // Real present clock; unchanged <=600s requirement.
 const renewed={...prepared,sourceFenceApprovedSha256:currentApprovalSha256};
 await validators.validatePreparedContext(renewed,{manifestSha:pins.parentManifestSha256,basePrepared:base,
  basePreparedSha:pins.basePreparedSha256,rootApproved:currentApproval});
 return {approved:currentApproval,base,preparedContext:renewed,renewedContextSha256:sha(bytes(renewed))};
}

function directory(p){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||s.gid!==0||
 (s.mode&0o7777)!==0o700||fs.realpathSync(p)!==p)fail('T48_PRIVATE_DIRECTORY');}
function read(p,max=4194304){const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.gid!==0||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>max)fail('T48_PRIVATE_FILE');
  const raw=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(p);
  if(raw.length!==s.size||s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.ctimeMs!==after.ctimeMs||
   s.dev!==named.dev||s.ino!==named.ino)fail('T48_FILE_CHANGED');return raw;
 }finally{fs.closeSync(fd);}}
function absent(paths){for(const p of paths)try{fs.lstatSync(p);fail('T48_ALREADY_STARTED');}catch(e){if(e.code!=='ENOENT')throw e;}}
function write(p,raw,onClaim){if(path.dirname(p)!==STATE)fail('T48_WRITE_PATH');directory(STATE);
 const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{onClaim?.();fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const d=fs.openSync(STATE,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 try{fs.fsyncSync(d);}finally{fs.closeSync(d);}if(!read(p).equals(raw))fail('T48_WRITE_READBACK');}
const safeCode=e=>/^(?:T48_|T45_|OWNER_PROOF_|ADMISSION_FS_|ADMISSION_CUSTODY_|SOURCE_TRANSFER_)[A-Z0-9_]+$/.test(e?.code??'')?e.code:'T48_FAILED';

async function main(){let phase='preflight',guarded=false,stageGuarded=false,timer,token,witnessResult;
 const abort=new AbortController(),interrupt=()=>abort.abort();
 let result={task:'T48',actionId:ACTION,logicalWindowTask:'T45',status:'BLOCKED',sourceWitnessReadAttempted:false,
  sourceWitnessValidated:false,sourceAuthUserRead:false,sourceBusinessDataRead:false,targetWritesStarted:false,
  sourceEffects:false,macDataTransit:false,retryAllowed:false};
 try{
  if(process.argv.length!==8||process.argv[2]!=='--manifest'||process.argv[3]!==MANIFEST||process.argv[4]!=='--sha256'||
   !digest(process.argv[5])||process.argv[6]!=='--current-fence-input-sha256'||!digest(process.argv[7]))fail('T48_EXPLICIT_INPUT_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0||process.execPath!==NODE||
   process.versions.node!=='22.23.5'||fileURLToPath(import.meta.url)!==SELF||process.env.NODE_TEST_CONTEXT||
   process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0'||!Object.values(networkInterfaces()).flat().some(i=>i?.address==='152.228.115.115'))fail('T48_PINNED_VPS_RUNTIME');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const p of ['/root',ROOT,STATE,DIR,RUNTIME])directory(p);
  const m=validateManifest(read(MANIFEST),process.argv[5],sha(read(SELF))),pins=m.pins;
  const parentRaw=read(DIR+'/manifest.json');if(sha(parentRaw)!==pins.parentManifestSha256)fail('T48_PARENT_SHA');
  const initial=parse(parentRaw);
  for(const [p,h]of Object.entries(initial.runtime_files??{})){
   if(!p.startsWith(RUNTIME+'/')||!digest(h))fail('T48_RUNTIME_PATH');directory(path.dirname(p));
   if(sha(read(p))!==h)fail('T48_RUNTIME_SHA');
  }
  const core=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-bind-fence.mjs');
  const owner=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-control-ready.mjs');
  const final=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-final-window.mjs');
  core.validateManifest(parentRaw,pins.parentManifestSha256,sha(read(RUNTIME+'/docs/runbooks/payloads/t45-bind-fence.mjs')));
  const parent=owner.loadOwnerManifest(initial,pins.parentManifestSha256,pins.ownerApprovedInputSha256);
  const summary=read(DIR+'/control-ready-result.json'),controlBytes=read(CONTROL),keyBytes=read(KEY);
  const evidence=final.validateControlEvidence({summaryBytes:summary,controlBytes,keyProofBytes:keyBytes},parent,pins.parentManifestSha256);
  for(const [p,h]of [[ROOT+'/t40-admission-before-c40a2026.json',parent.input_evidence.T40_before_image_sha256],
   [ROOT+'/t40-admission-metadata-c40a2026.json',parent.input_evidence.T40_metadata_receipt_sha256],
   [evidence.inversePath,evidence.inverseSha256]])if(sha(read(p))!==h)fail('T48_ADOPTED_INPUT_CHANGED');
  const oldApprovalBytes=read(DIR+'/source-fence-approved.json'),preparedBytes=read(DIR+'/source-witness-context.json');
  const renewed=await renewWitnessObservation({pins,oldApprovalBytes,currentApprovalBytes:read(CURRENT),
   currentApprovalSha256:process.argv[7],preparedBytes,baseBytes:read(DIR+'/final-base-prepared.json'),control:parse(summary)},core);
  if(evidence.controlSummarySha256!==renewed.base.controlSummarySha256||
   evidence.controlReceiptSha256!==renewed.base.controlReceiptSha256||
   evidence.independentKeyProofSha256!==renewed.base.independentKeyProofSha256)fail('T48_CONTROL_BINDING');
  const store=core.createPrivateFiles();
  store.absent(['witness-verify.guard','witness-result.json','source-barrier.json','final-prepared.json','fence-input.json'].map(p=>DIR+'/'+p));
  absent(['guard.json','result.json','renewed-witness-context.json'].map(p=>STATE+'/'+p));
  token=store.read(DIR+'/final-capability',64).toString('utf8');if(!/^[a-f0-9]{64}$/.test(token)||sha(token)!==pins.capabilitySha256)fail('T48_CAPABILITY_SHA');
  phase='verify-witness';timer=setTimeout(interrupt,40000);process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  witnessResult=await core.runWitnessVerification({manifestSha:pins.parentManifestSha256,base:renewed.base,
   baseSha:pins.basePreparedSha256,approved:renewed.approved,preparedContext:renewed.preparedContext,control:parse(summary),token,
   signal:abort.signal,persist:store.write,onSourceAttempt:()=>{result.sourceWitnessReadAttempted=true;},
   onWitnessValidated:()=>{result.sourceWitnessValidated=true;},guard:()=>{
    const record={task:'T48',actionId:ACTION,logicalWindowTask:'T45',manifestSha256:process.argv[5],
     parentManifestSha256:pins.parentManifestSha256,oldFenceInputSha256:pins.oldFenceInputSha256,
     oldPreparedContextSha256:pins.oldPreparedContextSha256,currentFenceInputSha256:process.argv[7],
     renewedContextSha256:renewed.renewedContextSha256,capabilitySha256:pins.capabilitySha256,expiresUtc:pins.expiresUtc};
    write(STATE+'/guard.json',bytes(record),()=>{guarded=true;});
    write(STATE+'/renewed-witness-context.json',bytes(renewed.preparedContext));
    const raw=bytes(record);store.write({path:DIR+'/witness-verify.guard',bytes:raw,sha256:sha(raw)});stageGuarded=true;
   }});
  result.witnessResult=witnessResult;
  if(sha(read(DIR+'/source-fence-approved.json'))!==pins.oldFenceInputSha256||
   sha(read(DIR+'/source-witness-context.json'))!==pins.oldPreparedContextSha256)fail('T48_OLD_INPUT_CHANGED');
  result={...result,status:'PASS',oldInputsPreserved:true,currentFenceInputSha256:process.argv[7],
   renewedContextSha256:renewed.renewedContextSha256,authBudgetUsed:1,authBudgetRemaining:2,witnessResult};
 }catch(e){result={...result,status:'BLOCKED',phase,code:safeCode(e),sourceMustRemainClosed:true,
  ...(Number.isInteger(e?.readinessStatus)?{readinessStatus:e.readinessStatus}:{}),
  ...(/^[A-Z0-9_]+$/.test(e?.upstreamCode??'')?{upstreamCode:e.upstreamCode}:{})};}
 finally{clearTimeout(timer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);abort.abort();token=undefined;
  if(stageGuarded)try{const raw=bytes(witnessResult??{task:'T45',producerTask:'T48',status:'BLOCKED',...result});
   const core=await import('file://'+RUNTIME+'/docs/runbooks/payloads/t45-bind-fence.mjs');core.createPrivateFiles().write({path:DIR+'/witness-result.json',bytes:raw,sha256:sha(raw)});
  }catch{result={...result,status:'BLOCKED',phase:'result-durability',code:'T48_T45_RESULT_WRITE_FAILED'};}
  if(guarded)try{write(STATE+'/result.json',bytes(result));}catch{result={...result,status:'BLOCKED',phase:'result-durability',code:'T48_RESULT_WRITE_FAILED'};}}
 console.log('T48_RESULT',JSON.stringify(result));if(result.status!=='PASS')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
