import assert from 'node:assert/strict';
import {createHash,createDecipheriv,hkdfSync,webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {encryptSnapshot} from '../../docs/runbooks/payloads/source-https-reader/encrypt-snapshot.mjs';
import {freshOwnerWitnessSql,validateFenceContext,validateFenceWitness} from '../../docs/runbooks/payloads/source-final-https-reader/fence-witness.mjs';
import {freshOwnerWitnessSql as reviewedSql,validateFreshOwnerWitness} from '../../docs/runbooks/payloads/http-source-admission.mjs';

const template=await readFile(new URL('../../docs/runbooks/payloads/source-final-https-reader/index.ts',import.meta.url),'utf8');
const protocol='BRON_PRIVATE_SNAPSHOT_V1',capability='a'.repeat(64),hash=x=>createHash('sha256').update(x).digest('hex');
const capabilityHash=hash(capability),now=Date.parse('2026-11-14T05:00:00Z');
const context=()=>({sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:'b'.repeat(64),
 before:{backends:[{pid:100}]},boundary:{capturedMicros:String(BigInt(now)*1000n-10000n),ownerPids:[101]}});
const witness=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',pid:123,
 backendStartMicros:String(BigInt(context().boundary.capturedMicros)+1000n)});
const authRowsSql='SYNTHETIC_FIXED_AUTH_ROWS_SQL';
const rows=()=>Array.from({length:16},(_,i)=>({private_id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
 private_stamp:'2026-11-14 03:00:00.000001+00',private_micros:'1794625200000001',private_other:'c'.repeat(64)}));
function fixture(options={}){
 const calls={environment:0,dns:[],clients:[],queries:[],events:[],snapshots:0,workingReads:0,authCaptures:0};
 const identity={database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',isolation:'repeatable read',
  statement_timeout:'5s',idle_timeout:'10s',pid:123,server_address:'192.0.2.1',database_time:'2026-11-14 05:00:00+00',...options.identity};
 const snapshot={'data:auth.users':{count:16,hash:'c'.repeat(64)},'data:public.partner':{count:1,hash:'d'.repeat(64)},'schema:relations':{count:63,hash:'e'.repeat(64)}};
 class Client{
  constructor(config){this.config=config;this.ends=0;this.destroys=0;this.connection={stream:{destroy:()=>{this.destroys++;}}};calls.clients.push(this);}
  on(){}
  async connect(){if(options.connect)return options.connect(this);if(this.config.ssl.servername==='bron-tls-negative.invalid'&&!options.acceptBadHostname)throw Error(options.negativeError??'certificate hostname mismatch');}
  async query(sql){calls.queries.push(sql);
   if(sql===freshOwnerWitnessSql){calls.events.push('fresh-witness');return {rows:[{witness:{...witness(),...options.witness}}]};}
   if(sql===authRowsSql){calls.authCaptures++;calls.events.push('auth-captured');return {rows:options.authRows??rows()};}
   if(sql==='SELECT SYNTHETIC_FIXED_WORKING_ROWS'){calls.workingReads++;calls.events.push('working-read');return {rows:[]};}
   if(/select[\s\S]*current_database\(/i.test(sql)){calls.events.push('identity');return {rows:[identity]};}
   return {rows:[]};
  }
  async end(){this.ends++;}
 }
 const exactQueryFingerprint=async()=>{throw Error('forward exact callback to audited snapshot');};
 const snapshotDatabase=async(db,settings)=>{
  calls.snapshots++;assert.equal(settings.fingerprintQuery,exactQueryFingerprint);assert.equal(typeof settings.beforeCommit,'function');
  calls.events.push('snapshot-begin');
  try{await db.query('begin isolation level repeatable read read only');await db.query("set local timezone='UTC'");await db.query('set local search_path=pg_catalog');
   await db.query('SELECT SYNTHETIC_FIXED_WORKING_ROWS');
   if(options.snapshotError)throw Error('PRIVATE_SNAPSHOT_ERROR');
   await settings.beforeCommit(db);calls.events.push('before-commit');await db.query('commit');calls.events.push('committed');return options.snapshot??snapshot;
  }catch(e){await db.query('rollback');throw e;}
 };
 const ctx=options.context??context(),ctxHash=options.contextHash??hash(JSON.stringify(ctx));
 const payload=template.replace('{{CAPABILITY_SHA256}}',options.capHash??capabilityHash)
  .replace('{{EXPIRES_EPOCH_MS}}',String(options.expires??now+3600000))
  .replace('{{FENCE_CONTEXT_JSON}}',JSON.stringify(ctx)).replace('{{FENCE_CONTEXT_SHA256}}',ctxHash);
 const compiled=stripTypeScriptTypes(payload.replace(/^import .*;$/gm,''),{disableExperimentalWarning:true});let handler;
 vm.runInNewContext(compiled,{pg:{Client},snapshotDatabase,exactQueryFingerprint,authRowsSql,encryptSnapshot,
  freshOwnerWitnessSql,validateFenceContext,validateFenceWitness,crypto:webcrypto,Response,URL,Uint8Array,Error,TextEncoder,TextDecoder,btoa,atob,
  Date:class extends Date{static now(){return now;}},lookup:async host=>{calls.dns.push(host);return {address:'192.0.2.123'};},
  setTimeout:(fn,ms)=>setTimeout(fn,options.forceDeadline??ms),clearTimeout,
  Deno:{serve:fn=>{handler=fn;},env:{get:()=>{calls.environment++;return options.url??'postgresql://postgres:SYNTHETIC_PASSWORD@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/postgres?sslmode=no-verify';}}}});
 const request=(body=capability,init={})=>new Request('https://example.test/functions/v1/final-reader',{method:'POST',body,...init});
 return {handler,request,calls,identity,snapshot};
}
function decrypt(envelope){
 const nonce=Buffer.from(envelope.nonce,'base64'),cipher=Buffer.from(envelope.ciphertext,'base64');
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(capability,'ascii'),Buffer.from(capabilityHash),Buffer.from(protocol),32));
 const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(cipher.subarray(-16));return JSON.parse(Buffer.concat([d.update(cipher.subarray(0,-16)),d.final()]).toString());
}

test('new pure fixed witness SQL and predicates agree with reviewed HTTP admission helper',()=>{
 assert.equal(freshOwnerWitnessSql,reviewedSql);
 const c=context(),w=witness();assert.equal(validateFreshOwnerWitness({before:c.before,boundary:c.boundary,witness:w}).newPhysicalBackendAfterDrain,true);
 const proof=validateFenceWitness(c,w);assert.equal(proof.preDataValidated,true);assert.equal(proof.sourceBarrierReceiptSha256,c.sourceBarrierReceiptSha256);
 for(const edit of[{pid:100},{pid:101},{backendStartMicros:c.boundary.capturedMicros},{backendStartMicros:String(BigInt(c.boundary.capturedMicros)-1n)},
  {readOnly:'off'},{db:'other'},{actor:'anon'},{session:'other'},{owner:'other'}]){
  assert.throws(()=>validateFreshOwnerWitness({before:c.before,boundary:c.boundary,witness:{...w,...edit}}));assert.throws(()=>validateFenceWitness(c,{...w,...edit}));
 }
 assert.throws(()=>validateFenceWitness(c,{...w,isolation:'read committed'}));
});

test('fixed context hash uses exact JSON serialization and returns a detached context',async()=>{
 const c=context(),p=await validateFenceContext(c,hash(JSON.stringify(c)));c.before.backends[0].pid=999;assert.equal(p.before.backends[0].pid,100);
 for(const edit of[{boundary:{capturedMicros:'bad',ownerPids:[]}},{before:{backends:[{pid:-1}]}},{extra:'PRIVATE'},
  {sourceBarrierActionId:'T37_ONE_READ'},{sourceBarrierReceiptSha256:'bad'}]){
  const value={...context(),...edit};await assert.rejects(validateFenceContext(value,hash(JSON.stringify(value))));
 }
 await assert.rejects(validateFenceContext(context(),'f'.repeat(64)),{code:'FINAL_READER_FENCE_CONTEXT_SHA'});
});

for(const [name,body,init,options]of[
 ['missing',undefined,{body:undefined},{}],['wrong','f'.repeat(64),{},{}],['short','a'.repeat(63),{},{}],
 ['GET',undefined,{method:'GET',body:undefined},{}],['expired',capability,{}, {expires:now-1}],
 ['future TTL',capability,{}, {expires:now+7200001}],['template capability',capability,{}, {capHash:'{{CAPABILITY_SHA256}}'}],
])test(`denies ${name} before context/env/DNS/database`,async()=>{
 const f=fixture(options),r=await f.handler(f.request(body,init));assert.equal(r.status,403);assert.equal(f.calls.environment,0);assert.equal(f.calls.dns.length,0);assert.equal(f.calls.clients.length,0);
});

test('bad immutable context/hash fails after private auth but before environment or DB access',async()=>{
 for(const options of[{contextHash:'f'.repeat(64)},{context:{...context(),before:{backends:[{pid:0}]}}}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(body.stage,'fence-context');assert.equal(f.calls.environment,0);assert.equal(f.calls.clients.length,0);assert.equal(f.calls.workingReads,0);
 }
});

test('client cannot supply SQL/context/URL through body or query parameters',async()=>{
 for(const req of[new Request('https://example.test/final?context=changed',{method:'POST',body:capability}),
  new Request('https://example.test/final',{method:'POST',body:JSON.stringify({capability,context:context(),sql:'SELECT 1'})})]){
  const f=fixture(),r=await f.handler(req);assert.equal(r.status,403);assert.equal(f.calls.environment,0);
 }
});

test('fresh witness and identity precede first working read on same RR client; response is entirely encrypted',async()=>{
 const f=fixture(),r=await f.handler(f.request()),envelope=await r.json();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),null);
 assert.deepEqual(Object.keys(envelope).sort(),['ciphertext','nonce','protocol']);const plain=decrypt(envelope);
 assert.deepEqual(plain.snapshot,f.snapshot);assert.deepEqual(plain.authRows,rows());assert.equal(plain.projectRef,'vkkqffvmztpzgygzfxhq');
 assert.equal(plain.fenceWitness.preDataValidated,true);assert.equal(plain.fenceWitness.pid,plain.identity.pid);assert.equal(plain.fenceWitness.sourceBarrierActionId,context().sourceBarrierActionId);assert.equal(plain.tls_negative_rejected,true);
 assert.deepEqual(f.calls.events,['snapshot-begin','fresh-witness','identity','working-read','identity','auth-captured','before-commit','committed']);
 assert.match(f.calls.queries[1],/statement_timeout = '5s'.*idle_in_transaction_session_timeout = '10s'.*timezone = 'UTC'.*search_path = pg_catalog/);
 const wire=JSON.stringify(envelope);for(const privateValue of[capability,'SYNTHETIC_PASSWORD','private_id','1794625200000001','authRows','fenceWitness',context().sourceBarrierReceiptSha256])assert.ok(!wire.includes(privateValue));
 assert.equal(f.calls.workingReads,1);assert.equal(f.calls.authCaptures,1);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
});

test('old PID, too-early start, wrong role/readonly/RR or identity mismatch stops BEFORE working rows',async()=>{
 for(const options of[{witness:{pid:100}},{witness:{pid:101}},{witness:{backendStartMicros:context().boundary.capturedMicros}},
  {witness:{readOnly:'off'}},{witness:{isolation:'read committed'}},{witness:{actor:'anon'}},
  {identity:{role:'anon'}},{identity:{pid:124}},{identity:{read_only:'off'}},{identity:{statement_timeout:'0'}}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(f.calls.workingReads,0);assert.equal(f.calls.authCaptures,0);assert.equal(body.ciphertext,undefined);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('snapshot failure, too many Auth rows and timeout never return private/partial data',async()=>{
 const tooMany=rows();tooMany.push({...rows()[0],private_id:'00000000-0000-4000-8000-000000000017'});
 for(const options of[{snapshotError:true},{authRows:tooMany},{forceDeadline:5,connect:()=>new Promise(()=>{})}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.ok([502,504].includes(r.status));assert.equal(body.ciphertext,undefined);assert.equal(body.nonce,undefined);assert.ok(!JSON.stringify(body).includes('PRIVATE_SNAPSHOT_ERROR'));assert.ok(!JSON.stringify(body).includes('private_id'));assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('TLS negative/good-host scope retains T36/T37 policy without new connection flags',async()=>{
 for(const options of[{acceptBadHostname:true},{negativeError:'TLS connection reset'},{url:'postgres://postgres:SYNTHETIC_PASSWORD@other.invalid:5432/postgres'}]){
  const f=fixture(options),r=await f.handler(f.request());assert.equal(r.status,502);assert.equal(f.calls.workingReads,0);assert.equal(f.calls.authCaptures,0);
 }
 const f=fixture();await f.handler(f.request());assert.deepEqual(f.calls.clients.map(c=>c.config.ssl.servername),['bron-tls-negative.invalid','db.vkkqffvmztpzgygzfxhq.supabase.co']);assert.ok(f.calls.clients.every(c=>c.config.ssl.rejectUnauthorized===true&&c.config.host==='192.0.2.123'&&!('connectionString'in c.config)));
});
