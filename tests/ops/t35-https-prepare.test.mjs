import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {validateManifest,validatePrior,metadataShape,requestMetadata,createCapability,exclusiveWrite,caMetadata} from '../../docs/runbooks/payloads/t35-https-prepare.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex'),ref='vkkqffvmztpzgygzfxhq';
const jwt=(role='anon',projectRef=ref)=>[Buffer.from(JSON.stringify({typ:'JWT',alg:'HS256'})).toString('base64url'),Buffer.from(JSON.stringify({role,ref:projectRef})).toString('base64url'),'cHVibGlj'].join('.');
const manifest=()=>({task:'T35',files:{'docs/runbooks/payloads/t35-https-prepare.mjs':'a'.repeat(64)},source:{origin:'https://'+ref+'.supabase.co',projectRef:ref,publicAnonKey:jwt()},actions:{allowed:true}});
const check=m=>{const raw=Buffer.from(JSON.stringify(m));return validateManifest(raw,sha(raw),'a'.repeat(64));};
const settings={external:{email:true},disable_signup:true,padding:'x'.repeat(600)},openapi={swagger:'2.0',paths:{},padding:'x'.repeat(600)};
function fakeClient({status=200,body=settings,raw,stall=false,error=false}={}){
 const calls=[],resources=[];const request=(options,callback)=>{calls.push(options);const req=new EventEmitter(),res=new EventEmitter();req.destroyed=false;res.destroyed=false;
  req.destroy=()=>{req.destroyed=true;};res.destroy=()=>{res.destroyed=true;};res.statusCode=status;resources.push({req,res});
  req.end=()=>queueMicrotask(()=>{if(error){req.emit('error',new Error('sensitive-body-and-key'));return;}if(stall)return;callback(res);if(res.destroyed)return;
   res.emit('data',Buffer.from(raw??JSON.stringify(body)));if(!res.destroyed)res.emit('end');});return req;};return {request,calls,resources};
}
test('static manifest binds hashes, exact public origin/project and legacy anon JWT; service roles rejected',()=>{
 assert.equal(check(manifest()).source.publicAnonKey,jwt());
 for(const patch of [{origin:'http://'+ref+'.supabase.co'},{origin:'https://attacker.example'},{projectRef:'other'},{publicAnonKey:jwt('service_role')},{publicAnonKey:jwt('authenticated')},{publicAnonKey:jwt('anon','other')},{publicAnonKey:'sb_secret_test'},{publicAnonKey:jwt()+'\r\n'}])assert.throws(()=>check({...manifest(),source:{...manifest().source,...patch}}));
 const raw=Buffer.from(JSON.stringify(manifest()));assert.throws(()=>validateManifest(raw,'b'.repeat(64),'a'.repeat(64)),{code:'T35_MANIFEST_SHA'});
 assert.throws(()=>validateManifest(raw,sha(raw),'b'.repeat(64)),{code:'T35_SELF_SHA'});
});
test('prior evidence requires exact closed failed phase and cleanup',()=>{
 const prior={status:'BLOCKED',phase:'first512',code:'LIBPQ_PHASE_TIMEOUT',clientRemoved:true,credentialsRemoved:true};validatePrior(prior);
 for(const patch of [{status:'PASS'},{phase:'single512'},{code:'timeout'},{clientRemoved:false},{credentialsRemoved:false}])assert.throws(()=>validatePrior({...prior,...patch}),{code:'T35_PRIOR_EVIDENCE'});
});
test('requests are fixed metadata GETs with verified canonical TLS and public bearer, never redirects',async()=>{
 for(const [endpoint,body,url,accept]of [['settings',settings,'/auth/v1/settings','application/json'],['openapi',openapi,'/rest/v1/','application/openapi+json']]){
  const f=fakeClient({body}),result=await requestMetadata(endpoint,jwt(),f);assert.equal(result.status,'PASS');assert.ok(result.bytes>=512);
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{protocol:'https:',hostname:ref+'.supabase.co',port:443,servername:ref+'.supabase.co',rejectUnauthorized:true,agent:false,method:'GET',path:url,headers:{Accept:accept,apikey:jwt(),Authorization:'Bearer '+jwt()}});
  assert.ok(f.resources.every(({req,res})=>req.destroyed&&res.destroyed));assert.doesNotMatch(JSON.stringify(result),/padding|Bearer|cHVibGlj|external.*true/);
 }
 const redirect=fakeClient({status:302,raw:'do-not-follow'}),result=await requestMetadata('settings',jwt(),redirect);assert.equal(result.code,'T35_HTTP_STATUS');assert.equal(redirect.calls.length,1);assert.equal(result.bytes,0);
});
test('actual JSON shape is safe and rejects arrays, missing metadata, invalid JSON and excessive bodies',async()=>{
 assert.equal(metadataShape(settings,'settings').valid,true);assert.equal(metadataShape({openapi:'3.1.0',paths:{}},'openapi').valid,true);
 for(const [endpoint,body]of [['settings',[]],['settings',{external:{email:'SECRET'},disable_signup:true}],['openapi',{swagger:'2.0',paths:[]}],['openapi',{paths:{}}]]){
  const f=fakeClient({body}),result=await requestMetadata(endpoint,jwt(),f);assert.equal(result.code,'T35_JSON_SHAPE');assert.doesNotMatch(JSON.stringify(result),/SECRET/);
 }
 for(const [raw,options,code]of [['not-json',{},'T35_JSON_INVALID'],['x'.repeat(33),{maxBody:32},'T35_BODY_LIMIT'],['x'.repeat(4*1024*1024+1),{},'T35_BODY_LIMIT']]){
  const f=fakeClient({raw}),result=await requestMetadata('settings',jwt(),{...f,...options});assert.equal(result.code,code);assert.ok(f.resources[0].req.destroyed&&f.resources[0].res.destroyed);
 }
});
test('hard request and wall budgets destroy sockets and sanitize failures',async()=>{
 const stalled=fakeClient({stall:true}),start=performance.now(),timeout=await requestMetadata('settings',jwt(),{...stalled,timeoutMs:8});assert.equal(timeout.code,'T35_HTTPS_TIMEOUT');assert.ok(performance.now()-start<500);assert.equal(stalled.resources[0].req.destroyed,true);
 const aborted=fakeClient({stall:true}),controller=new AbortController(),pending=requestMetadata('settings',jwt(),{...aborted,signal:controller.signal});controller.abort();assert.equal((await pending).code,'T35_WALL_DEADLINE');assert.equal(aborted.resources[0].req.destroyed,true);
 const f=fakeClient({error:true});assert.equal((await requestMetadata('settings',jwt(),f)).code,'T35_HTTPS_FAILURE');
 for(const options of [{timeoutMs:15001},{maxBody:4*1024*1024+1}])assert.throws(()=>requestMetadata('settings',jwt(),options),{code:'T35_REQUEST_SCOPE'});
 assert.throws(()=>requestMetadata('working-tables',jwt()),{code:'T35_REQUEST_SCOPE'});
});
test('exclusive capability generates once, is private ASCII hex, returns only ASCII-token digest and two-hour expiry',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'t35-test-'));try{
  const file=path.join(dir,'capability'),now=Date.parse('2026-11-14T00:00:00Z');let calls=0;
  const result=createCapability(file,now,n=>{calls++;assert.equal(n,32);return Buffer.alloc(32,17);}),bytes=fs.readFileSync(file);
  assert.match(bytes.toString(),/^[a-f0-9]{64}\n$/);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(result.sha256,sha(bytes.subarray(0,64)));assert.equal(result.expiresUtc,'2026-11-14T02:00:00.000Z');assert.deepEqual(Object.keys(result),['sha256','expiresUtc']);
  assert.throws(()=>createCapability(file,now,()=>{calls++;return Buffer.alloc(32);}),{code:'EEXIST'});assert.equal(calls,1);assert.deepEqual(fs.readFileSync(file),bytes);
  const guard=path.join(dir,'guard');exclusiveWrite(guard,'{}\n');assert.equal(fs.statSync(guard).mode&0o777,0o600);assert.throws(()=>exclusiveWrite(guard,'replace'),{code:'EEXIST'});
  fs.symlinkSync(file,path.join(dir,'symlink'));assert.throws(()=>createCapability(path.join(dir,'symlink')), {code:'EEXIST'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('CA metadata is digest/count only; private keys fail closed',()=>{
 const ca=Buffer.from('-----BEGIN CERTIFICATE-----\nPUBLIC\n-----END CERTIFICATE-----\n');assert.deepEqual(caMetadata(ca),{sha256:sha(ca),certificateCount:1});
 for(const raw of [Buffer.from('-----BEGIN PRIVATE KEY-----'),Buffer.from('-----BEGIN RSA PRIVATE KEY-----'),Buffer.from('not a cert')])assert.throws(()=>caMetadata(raw),{code:'T35_CA_UNSAFE'});
});
test('import and no-argument execution are inert before private paths or network',()=>{
 const helper=path.resolve('docs/runbooks/payloads/t35-https-prepare.mjs'),run=spawnSync(process.execPath,[helper],{encoding:'utf8',timeout:1000});assert.equal(run.status,2);assert.match(run.stdout,/T35_EXPLICIT_REVIEW_REQUIRED/);assert.equal(run.stderr,'');
 const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(helper)})`],{encoding:'utf8',timeout:1000});assert.equal(imported.status,0);assert.equal(imported.stdout+imported.stderr,'');
});
