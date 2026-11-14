// VPS-only technical challenge custody. No Source connection, SQL execution,
// Auth-budget use, key/row access or automatic Root ACK generation.
// Caller has already read/verified the immutable durable barrier receipt on root.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';

const DIRECTORY='/root/bron-secrets/t41-release',PROJECT='vkkqffvmztpzgygzfxhq';
export const coordinatorFenceStages=Object.freeze(['start','before-target-write','before-final-audit','end']);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>JSON.stringify(Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])))+'\n';
const ownError=Symbol('coordinator-fence-error');
const fail=code=>{throw Object.assign(new Error(code),{code,[ownError]:true});};
const exact=(x,keys)=>{
 if(!x||typeof x!=='object'||Array.isArray(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x))||
  Reflect.ownKeys(x).length!==keys.length||Reflect.ownKeys(x).some(k=>!keys.includes(k)||
   !Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value')||!Object.getOwnPropertyDescriptor(x,k).enumerable))
  fail('COORDINATOR_FENCE_SHAPE');
};
const safeError=(error,stage)=>Object.assign(new Error(error?.[ownError]?error.code:'COORDINATOR_FENCE_IO_UNCERTAIN'),{
 code:error?.[ownError]?error.code:'COORDINATOR_FENCE_IO_UNCERTAIN',stage,holdSourceClosed:true,retryAllowed:false,
});
const activationKeys=['reviewed','actionId','manifestSha256','sourceProject','sourceBarrierActionId','sourceBarrierReceiptSha256','verifyFencedSqlSha256'];
const barrierKeys=['sourceBarrierActionId','sourceBarrierReceiptSha256','normalConnectDenied','existingClientsDrained',
 'freshOwnerReconnect','providerBoundaryReviewed','durableOnVps','sourcePaused'];
const ackKeys=['format','protocol','actionId','manifestSha256','sourceProject','sourceBarrierActionId','sourceBarrierReceiptSha256',
 'verifyFencedSqlSha256','stage','nonceSha256','sourceCheckedMicros','expiresEpochMs','normalConnectDenied','existingClientsDrained','providerBoundaryReviewed'];

// testOnly permits actual temporary filesystem ownership, never fake root evidence.
export function createCoordinatorFenceAck({activation,barrierProof,signal,timeoutMs=60000,onChallenge},testOnly){
 let fd,closed=false,failed=false,running=false,next=0;
 try{
  exact(activation,activationKeys);exact(barrierProof,barrierKeys);
  const a=Object.freeze({...activation}),barrier=Object.freeze({...barrierProof});
  if(a.reviewed!==true||a.actionId!=='T41.final_https_window'||a.sourceProject!==PROJECT||
   a.sourceBarrierActionId!=='T40.http_source_admission'||!digest(a.manifestSha256)||
   !digest(a.sourceBarrierReceiptSha256)||!digest(a.verifyFencedSqlSha256)||
   barrier.sourceBarrierActionId!==a.sourceBarrierActionId||barrier.sourceBarrierReceiptSha256!==a.sourceBarrierReceiptSha256||
   ['normalConnectDenied','existingClientsDrained','freshOwnerReconnect','providerBoundaryReviewed','durableOnVps'].some(k=>barrier[k]!==true)||
   barrier.sourcePaused!==false||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||
   (onChallenge!==undefined&&typeof onChallenge!=='function'))fail('COORDINATOR_FENCE_ACTIVATION_INVALID');
  let directory=DIRECTORY,uid=0,gid=0;
  if(testOnly){
   if(!process.env.NODE_TEST_CONTEXT)fail('COORDINATOR_FENCE_TEST_POLICY_FORBIDDEN');
   exact(testOnly,['directory','uid','gid']);({directory,uid,gid}=testOnly);
   if(typeof directory!=='string'||path.resolve(directory)!==directory||!directory.startsWith('/tmp/')||
    !Number.isInteger(uid)||!Number.isInteger(gid))fail('COORDINATOR_FENCE_TEST_POLICY_FORBIDDEN');
  }else if(process.platform!=='linux'||process.getuid?.()!==0||process.getgid?.()!==0)fail('COORDINATOR_FENCE_VPS_ROOT_REQUIRED');
  const privateDirectory=d=>{const s=fs.lstatSync(d);
   if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==gid||(s.mode&0o7777)!==0o700)
    fail('COORDINATOR_FENCE_DIRECTORY_UNSAFE');return s;};
  const parents=()=>{if(!testOnly){privateDirectory('/root');privateDirectory('/root/bron-secrets');}};
  parents();const initial=privateDirectory(directory);
  fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_DIRECTORY);
  const checkDirectory=()=>{
   if(closed)fail('COORDINATOR_FENCE_CLOSED');parents();const named=privateDirectory(directory),held=fs.fstatSync(fd);
   if(named.dev!==initial.dev||named.ino!==initial.ino||held.dev!==initial.dev||held.ino!==initial.ino||
    held.uid!==uid||held.gid!==gid||(held.mode&0o7777)!==0o700)fail('COORDINATOR_FENCE_DIRECTORY_CHANGED');
  };
  const physical=name=>{checkDirectory();return '/proc/self/fd/'+fd+'/'+name;};
  const exists=name=>{try{fs.lstatSync(physical(name));return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
  const checkFile=(s,max)=>{if(!s.isFile()||s.uid!==uid||s.gid!==gid||s.nlink!==1||(s.mode&0o7777)!==0o600||s.size<1||s.size>max)
   fail('COORDINATOR_FENCE_FILE_UNSAFE');};
  const read=(name,max,durable=false)=>{
   let file;try{
    const filename=physical(name);file=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const before=fs.fstatSync(file);checkFile(before,max);const buffer=Buffer.alloc(max+1);let size=0;
    for(;;){const count=fs.readSync(file,buffer,size,buffer.length-size,size);size+=count;
     if(size>max)fail('COORDINATOR_FENCE_FILE_BOUND');if(count===0)break;}
    const after=fs.fstatSync(file),named=fs.lstatSync(filename);checkFile(after,max);checkFile(named,max);checkDirectory();
    if(before.dev!==after.dev||before.ino!==after.ino||before.dev!==named.dev||before.ino!==named.ino||
     size!==before.size||size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)
     fail('COORDINATOR_FENCE_FILE_CHANGED');
    if(durable){fs.fsyncSync(file);fs.fsyncSync(fd);}
    return {bytes:buffer.subarray(0,size),uid:after.uid,gid:after.gid,mode:after.mode&0o7777};
   }finally{if(file!==undefined)fs.closeSync(file);}
  };
  const writeRequest=(name,bytes)=>{
   let file;try{file=fs.openSync(physical(name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(file,bytes);checkFile(fs.fstatSync(file),8192);fs.fsyncSync(file);
   }finally{if(file!==undefined)fs.closeSync(file);}
   checkDirectory();fs.fsyncSync(fd);const saved=read(name,8192);
   if(!saved.bytes.equals(bytes))fail('COORDINATOR_FENCE_REQUEST_READBACK');return saved;
  };
  const context=Object.fromEntries(['actionId','manifestSha256','sourceProject','sourceBarrierActionId','sourceBarrierReceiptSha256','verifyFencedSqlSha256'].map(k=>[k,a[k]]));
  const parseAck=(bytes,request)=>{
   let envelope,ack;try{envelope=JSON.parse(bytes.toString('utf8'));}catch{fail('COORDINATOR_FENCE_ACK_JSON');}
   exact(envelope,['ackJson','rootAckSha256']);
   if(typeof envelope.ackJson!=='string'||Buffer.byteLength(envelope.ackJson)>16384||!digest(envelope.rootAckSha256)||
    sha(envelope.ackJson)!==envelope.rootAckSha256)fail('COORDINATOR_FENCE_ACK_SHA');
   try{ack=JSON.parse(envelope.ackJson);}catch{fail('COORDINATOR_FENCE_ACK_JSON');}exact(ack,ackKeys);
   if(ack.format!==1||ack.protocol!=='BRON_COORDINATOR_FENCE_ACK_V1'||
    Object.entries(context).some(([k,v])=>ack[k]!==v)||ack.stage!==request.stage||ack.nonceSha256!==request.nonceSha256||
    ack.expiresEpochMs!==request.expiresEpochMs||
    ['normalConnectDenied','existingClientsDrained','providerBoundaryReviewed'].some(k=>ack[k]!==true)||
    typeof ack.sourceCheckedMicros!=='string'||!/^\d{12,20}$/.test(ack.sourceCheckedMicros))
    fail('COORDINATOR_FENCE_ACK_BINDING');
   if(canonical(ack)!==envelope.ackJson)fail('COORDINATOR_FENCE_ACK_NONCANONICAL');
   // Freshness means an actual Root check for THIS nonce/stage within the unique
   // <=60s challenge, with +/-5s Source/VPS clock skew (maximum age <65s).
   // It is deliberately not a 5s delivery deadline: executor handoff must fit
   // the challenge expiry without burning Auth attempts on artificial latency.
   const now=Date.now(),checked=BigInt(ack.sourceCheckedMicros);
   if(now>=request.expiresEpochMs||checked<BigInt(request.createdEpochMs-5000)*1000n||checked>BigInt(now+5000)*1000n)
    fail('COORDINATOR_FENCE_ACK_STALE');
   return {stage:ack.stage,nonceSha256:ack.nonceSha256,rootAckSha256:envelope.rootAckSha256,
    sourceCheckedMicros:ack.sourceCheckedMicros,expiresEpochMs:ack.expiresEpochMs};
  };
  const emit=onChallenge??(value=>console.log('COORDINATOR_FENCE_CHALLENGE',JSON.stringify(value)));
  const close=()=>{if(!closed){closed=true;fs.closeSync(fd);fd=undefined;}};
  const assertFence=async stage=>{
   let timer,abort;
   try{
    if(closed||failed||running||signal?.aborted)fail('COORDINATOR_FENCE_NOT_ACTIVE');
    if(stage!==coordinatorFenceStages[next])fail('COORDINATOR_FENCE_STAGE_ORDER');running=true;
    const requestName='fence-check-'+stage+'.request.json',ackName='fence-check-'+stage+'.ack.json';
    if(exists(requestName)||exists(ackName))fail('COORDINATOR_FENCE_STAGE_ALREADY_CONSUMED');
    const now=Date.now(),raw=randomBytes(32),nonce=raw.toString('hex');raw.fill(0);
    const request={format:1,protocol:'BRON_COORDINATOR_FENCE_REQUEST_V1',...context,stage,nonce,nonceSha256:sha(nonce),
     createdEpochMs:now,expiresEpochMs:now+timeoutMs};
    const bytes=Buffer.from(canonical(request)),saved=writeRequest(requestName,bytes);
    const {nonce:omitted,...publicRequest}=request;
    const challenge=Object.freeze({...publicRequest,requestPath:DIRECTORY+'/'+requestName,ackPath:DIRECTORY+'/'+ackName,
     requestSha256:sha(bytes),storageUid:saved.uid,storageGid:saved.gid,storageMode:saved.mode});
    const active=()=>{if(closed||failed||signal?.aborted)fail('COORDINATOR_FENCE_ABORTED');
     if(Date.now()>=request.expiresEpochMs)fail('COORDINATOR_FENCE_ACK_TIMEOUT');};
    const wait=async()=>{
     await emit(challenge);active();
     for(;;){
      active();
      if(exists(ackName)){const savedAck=read(ackName,32768,true);active();return parseAck(savedAck.bytes,request);}
      await new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(100,request.expiresEpochMs-Date.now()))));
     }
    };
    const deadline=new Promise((_,reject)=>{
     timer=setTimeout(()=>{try{fail('COORDINATOR_FENCE_ACK_TIMEOUT');}catch(e){reject(e);}},Math.max(1,request.expiresEpochMs-Date.now()));
     abort=()=>{try{fail('COORDINATOR_FENCE_ABORTED');}catch(e){reject(e);}};
     signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    });
    const currentAck=await Promise.race([wait(),deadline]);next++;
    return Object.freeze({...barrier,currentAck:Object.freeze(currentAck)});
   }catch(error){failed=true;throw safeError(error,stage);}
   finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);running=false;}
  };
  return Object.freeze({assertFence,close});
 }catch(error){if(fd!==undefined)fs.closeSync(fd);throw safeError(error,'activation');}
}
