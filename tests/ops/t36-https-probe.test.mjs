import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateManifest,validatePrior,validatePriorShape,exclusiveWrite,createCapability,validatePrepared,requestJson,readyReply,validateSuccess,runProbe} from '../../docs/runbooks/payloads/t36-https-probe.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),protocol='BRON_HTTPS_PROBE_V1',ref='vkkqffvmztpzgygzfxhq',token='a'.repeat(64),now=Date.parse('2026-11-14T00:00:00Z');
const prepared=()=>({task:'T36',capabilitySha256:sha(token),expiresUtc:new Date(now+7200000).toISOString(),functionName:'bron-https-probe-'+sha(token).slice(0,12),origin:'https://'+ref+'.supabase.co',protocol});
const denied=()=>({statusCode:403,bytes:55,elapsedMs:1,value:{ok:false,probe_protocol:protocol}});
const success=()=>({statusCode:200,bytes:525000,elapsedMs:2,value:{ok:true,probe_protocol:protocol,projectRef:ref,tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',started_epoch_ms:now,finished_epoch_ms:now+1,expires_epoch_ms:now+7200000,identity:{database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:12,server_address:'10.0.0.2',database_time:'2026-11-14 00:00:00+00',dummy:'x'.repeat(524288)}}});
const prior=()=>({task:'T35',status:'BLOCKED',code:'T35_METADATA_BLOCKED',replies:[{endpoint:'settings',status:'PASS',statusCode:200,bytes:610,jsonShape:{type:'object',external:'object',email:'boolean',disable_signup:'boolean'}},{endpoint:'openapi',status:'BLOCKED',statusCode:401}]});
function client({status=200,body=success().value,raw,stall=false,error=false}={}){
 const calls=[],resources=[];const request=(options,callback)=>{const req=new EventEmitter(),res=new EventEmitter();calls.push({options});req.destroyed=res.destroyed=false;req.destroy=()=>{req.destroyed=true;};res.destroy=()=>{res.destroyed=true;};res.statusCode=status;resources.push({req,res});
  req.end=(value,encoding)=>{calls.at(-1).body=value;calls.at(-1).encoding=encoding;queueMicrotask(()=>{if(error){req.emit('error',new Error('private-SECRET-message'));return;}if(stall)return;callback(res);if(res.destroyed)return;res.emit('data',Buffer.from(raw??JSON.stringify(body)));if(!res.destroyed)res.emit('end');});};return req;};return {request,calls,resources};
}
test('manifest pins exact reviewed bytes and repo-relative self hash while allowing unrelated files',()=>{
 const m={task:'T36',files:{'docs/runbooks/payloads/t36-https-probe.mjs':'a'.repeat(64),'other.txt':'b'.repeat(64)},extra:true},raw=Buffer.from(JSON.stringify(m));assert.equal(validateManifest(raw,sha(raw),'a'.repeat(64)).extra,true);
 assert.throws(()=>validateManifest(raw,'b'.repeat(64),'a'.repeat(64)),{code:'T36_MANIFEST_SHA'});assert.throws(()=>validateManifest(raw,sha(raw),'b'.repeat(64)),{code:'T36_SELF_SHA'});
});
test('prior is the closed partial metadata proof, never a falsely promoted overall PASS; exact historical hash mandatory',()=>{
 validatePriorShape(prior());for(const patch of [{task:'T34'},{status:'PASS'},{code:'OTHER'},{capability:{}},{replies:prior().replies.slice(0,1)}])assert.throws(()=>validatePriorShape({...prior(),...patch}),{code:'T36_PRIOR_EVIDENCE'});
 for(const [index,patch] of [[0,{status:'BLOCKED'}],[0,{statusCode:201}],[0,{bytes:511}],[0,{jsonShape:{type:'object'}}],[1,{statusCode:200}],[1,{status:'PASS'}]]){const p=prior();Object.assign(p.replies[index],patch);assert.throws(()=>validatePriorShape(p),{code:'T36_PRIOR_EVIDENCE'});}
 assert.throws(()=>validatePrior(Buffer.from(JSON.stringify(prior()))),{code:'T36_PRIOR_SHA'});
});
test('capability is exclusive root0600 exact ASCII64, fsynced, digest-only metadata with a fixed two-hour expiry',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t36-'));try{const file=path.join(dir,'cap');let calls=0;const p=createCapability(file,now,n=>{calls++;assert.equal(n,32);return Buffer.alloc(32,17);}),raw=fs.readFileSync(file);assert.equal(raw.length,64);assert.match(raw.toString(),/^[a-f0-9]{64}$/);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(p.capabilitySha256,sha(raw));assert.equal(p.expiresUtc,'2026-11-14T02:00:00.000Z');assert.doesNotMatch(JSON.stringify(p),new RegExp(raw.toString()));
  assert.throws(()=>createCapability(file,now,()=>{calls++;return Buffer.alloc(32);}),{code:'EEXIST'});assert.equal(calls,1);assert.deepEqual(fs.readFileSync(file),raw);fs.symlinkSync(file,path.join(dir,'link'));assert.throws(()=>createCapability(path.join(dir,'link')),{code:'EEXIST'});
  const guard=path.join(dir,'guard');exclusiveWrite(guard,'{}');assert.equal(fs.statSync(guard).mode&0o777,0o600);assert.throws(()=>exclusiveWrite(guard,'replace'),{code:'EEXIST'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('prepared identity rejects expiry, changed token, function, origin and protocol',()=>{
 validatePrepared(prepared(),token,now);for(const p of [{...prepared(),expiresUtc:new Date(now).toISOString()},{...prepared(),expiresUtc:new Date(now+7200001).toISOString()},{...prepared(),functionName:'other'},{...prepared(),origin:'https://example.com'},{...prepared(),protocol:'other'}])assert.throws(()=>validatePrepared(p,token,now),{code:'T36_PREPARED_INVALID'});assert.throws(()=>validatePrepared(prepared(),token+'\n',now),{code:'T36_PREPARED_INVALID'});
});
test('HTTP uses strict canonical HTTPS/SNI with no keys, headers or redirects; raw body stays in RAM',async()=>{
 const f=client(),r=await requestJson(prepared().functionName,'POST',token,f);assert.equal(r.statusCode,200);assert.deepEqual(f.calls[0].options,{protocol:'https:',hostname:ref+'.supabase.co',port:443,servername:ref+'.supabase.co',rejectUnauthorized:true,agent:false,method:'POST',path:'/functions/v1/'+prepared().functionName,headers:{Accept:'application/json','Content-Type':'text/plain','Content-Length':'64'}});assert.equal(f.calls[0].body,token);assert.equal(f.calls[0].encoding,'ascii');assert.ok(f.resources.every(x=>x.req.destroyed&&x.res.destroyed));
 const g=client({status:403,body:denied().value});await requestJson(prepared().functionName,'GET',undefined,g);assert.deepEqual(g.calls[0].options.headers,{Accept:'application/json'});assert.equal(g.calls[0].body,undefined);
 const redir=client({status:302,raw:'SECRET'}),out=await requestJson(prepared().functionName,'GET',undefined,redir);assert.equal(out.code,'T36_REDIRECT_REJECTED');assert.equal(out.bytes,0);assert.equal(redir.calls.length,1);
});
test('HTTP hard bounds invalid/oversized/stalled/error replies and aborts destroy resources without leaking messages',async()=>{
 for(const [f,options,code]of [[client({raw:'SECRET'}),{},'T36_JSON_INVALID'],[client({raw:'x'.repeat(1048577)}),{},'T36_BODY_LIMIT'],[client({stall:true}),{timeoutMs:5},'T36_HTTPS_TIMEOUT'],[client({error:true}),{},'T36_HTTPS_FAILURE']]){const r=await requestJson(prepared().functionName,'GET',undefined,{...f,...options});assert.equal(r.code,code);assert.doesNotMatch(JSON.stringify(r),/SECRET/);assert.ok(f.resources.every(x=>x.req.destroyed));if(r.statusCode!==null)assert.ok(f.resources[0].res.destroyed);}
 const f=client({stall:true}),controller=new AbortController(),p=requestJson(prepared().functionName,'GET',undefined,{...f,signal:controller.signal});controller.abort();assert.equal((await p).code,'T36_WALL_DEADLINE');assert.ok(f.resources[0].req.destroyed);
 for(const options of [{timeoutMs:35001},{timeoutMs:NaN},{maxBody:1048577}])assert.throws(()=>requestJson(prepared().functionName,'GET',undefined,options),{code:'T36_REQUEST_SCOPE'});
});
test('readiness is exact protocol403 and max24 polls at5sec; unavailable function never consumes final guard',async()=>{
 assert.equal(readyReply(denied()),true);for(const r of [{...denied(),statusCode:401},{...denied(),value:{ok:false}},{...denied(),value:{...denied().value,code:'gateway'}},{...denied(),value:{ok:false,probe_protocol:'other'}}])assert.equal(readyReply(r),false);
 let clock=now,count=0,guards=0;const r=await runProbe(prepared(),token,{now:()=>clock,wait:async n=>{assert.equal(n,5000);clock+=n;},send:async(name,method,body,options)=>{count++;assert.equal(method,'GET');assert.equal(body,undefined);assert.equal(options.timeoutMs,5000);return {statusCode:404,bytes:0};},guard:()=>guards++});assert.equal(r.status,'WAIT_COORDINATOR');assert.equal(count,24);assert.equal(guards,0);assert.equal(clock-now,115000);
});
test('wrong capability is denied before one guarded valid call; output selects safe invariant fields only',async()=>{
 const calls=[];let guards=0;const r=await runProbe(prepared(),token,{now:()=>now+2,guard:()=>guards++,send:async(name,method,body,options)=>{calls.push({method,body});assert.ok(options.timeoutMs<=35000);return method==='GET'||body!==token?denied():success();}});assert.equal(r.status,'PASS');assert.equal(guards,1);assert.deepEqual(calls.map(x=>x.method),['GET','POST','POST']);assert.equal(calls[1].body,'0'.repeat(64));assert.equal(calls[2].body,token);assert.equal(r.dummyBytes,524288);assert.doesNotMatch(JSON.stringify(r),new RegExp(token+'|dummy"|x{100}|value"'));
 const ztoken='0'.repeat(64),p={...prepared(),capabilitySha256:sha(ztoken),functionName:'bron-https-probe-'+sha(ztoken).slice(0,12)};const seen=[];await runProbe(p,ztoken,{now:()=>now+2,send:async(n,m,b)=>{seen.push(b);return m==='GET'||b!==ztoken?denied():success();}});assert.equal(seen[1],'1'.repeat(64));
});
test('wrongcap failure never invokes actual guard; valid error and invalid identities cannot leak response fields',async()=>{
 let calls=0,guards=0;let r=await runProbe(prepared(),token,{now:()=>now,guard:()=>guards++,send:async()=>++calls===1?denied():{statusCode:502,bytes:3,elapsedMs:1,value:{stage:'SECRET',code:'SECRET',message:token}}});assert.equal(r.code,'T36_NEGATIVE_PROBE_FAILED');assert.equal(calls,2);assert.equal(guards,0);assert.doesNotMatch(JSON.stringify(r),/SECRET|aaaa/);
 calls=0;r=await runProbe(prepared(),token,{now:()=>now,guard:()=>guards++,send:async()=>++calls<3?denied():{statusCode:502,bytes:3,elapsedMs:1,value:{stage:'dns',code:'PROBE_FAILED',message:token}}});assert.equal(r.code,'T36_VALID_PROBE_FAILED');assert.equal(calls,3);assert.equal(guards,1);assert.equal(r.reply.remoteStage,'dns');assert.doesNotMatch(JSON.stringify(r),/aaaa/);
 for(const patch of [{projectRef:'other'},{probe_protocol:'other'},{tls_negative_rejected:false},{tls_verification:'insecure'},{expires_epoch_ms:now+1},{started_epoch_ms:now-6000},{finished_epoch_ms:now+30000}])assert.throws(()=>validateSuccess({...success(),value:{...success().value,...patch}},prepared(),now,now+2),{code:'T36_RESPONSE_INVARIANT'});
 for(const patch of [{database:'other'},{role:'anon'},{session_role:'other'},{owner:'other'},{read_only:'off'},{isolation:'read committed'},{statement_timeout:'0'},{idle_timeout:'0'},{dummy:'x'.repeat(524287)},{server_address:'SECRET'},{pid:0},{database_time:'SECRET'}])assert.throws(()=>validateSuccess({...success(),value:{...success().value,identity:{...success().value.identity,...patch}}},prepared(),now,now+2),{code:'T36_RESPONSE_INVARIANT'});
});
test('valid probe is never retried on transport failure and total actual HTTP budget is35seconds',async()=>{
 let calls=0,clock=now,guards=0;const r=await runProbe(prepared(),token,{now:()=>clock,guard:()=>guards++,send:async(n,m,b,o)=>{calls++;if(calls===1)return denied();assert.equal(o.timeoutMs,calls===2?35000:34000);clock+=1000;return calls===2?denied():{statusCode:null,bytes:0,elapsedMs:1,code:'T36_HTTPS_TIMEOUT'};}});assert.equal(r.status,'BLOCKED');assert.equal(calls,3);assert.equal(guards,1);
 calls=0;clock=now;await assert.rejects(runProbe(prepared(),token,{now:()=>clock,send:async()=>{calls++;if(calls===2)clock+=35000;return denied();}}),{code:'T36_WALL_DEADLINE'});assert.equal(calls,2);
});
test('import and no-argument CLI stay inert before private reads or network',()=>{
 const helper=path.resolve('docs/runbooks/payloads/t36-https-probe.mjs'),run=spawnSync(process.execPath,[helper],{encoding:'utf8',timeout:1000});assert.equal(run.status,2);assert.match(run.stdout,/T36_EXPLICIT_REVIEW_REQUIRED/);assert.equal(run.stderr,'');const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(helper)})`],{encoding:'utf8',timeout:1000});assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
});
