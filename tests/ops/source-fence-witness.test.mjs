import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createHash,createDecipheriv,hkdfSync,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {freshOwnerWitnessSql,validateFenceContext,validateFenceWitness} from '../../docs/runbooks/payloads/source-fence-witness/fence-witness.mjs';
import {freshOwnerWitnessSql as reviewedSql,validateFreshOwnerWitness} from '../../docs/runbooks/payloads/http-source-admission.mjs';
import {encryptWitness} from '../../docs/runbooks/payloads/source-fence-witness/encrypt-witness.mjs';

const base=new URL('../../docs/runbooks/payloads/',import.meta.url),hash=x=>createHash('sha256').update(x).digest('hex');
const template=await readFile(new URL('source-fence-witness/index.ts',base),'utf8');
const protocol='BRON_SOURCE_FENCE_WITNESS_V1',capability='a'.repeat(64),capabilityHash=hash(capability);
const now=Date.parse('2026-11-14T12:00:00Z');
const context=()=>({sourceBarrierActionId:'T40.http_source_admission',sourceBarrierReceiptSha256:'b'.repeat(64),
 before:{backends:[{pid:100}]},boundary:{capturedMicros:String(BigInt(now)*1000n),ownerPids:[101]}});
const witness=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',isolation:'repeatable read',pid:102,
 backendStartMicros:String(BigInt(context().boundary.capturedMicros)+1n)});
function fixture(options={}){
 const calls={environment:0,dns:[],queries:[],clients:[],events:[],timerLimits:[]},clock={now};
 const identity={database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',isolation:'repeatable read',
  statement_timeout:'5s',idle_timeout:'10s',pid:102,database_time:'2026-11-14 12:00:00.000001+00',...options.identity};
 const actualWitness={...witness(),...options.witness};
 class Client{
  constructor(config){this.config=config;this.ends=0;this.destroys=0;this.connection={stream:{destroy:()=>{this.destroys++;}}};calls.clients.push(this);}
  on(){}
  async connect(){if(options.connect)return options.connect(this);
   if(this.config.ssl.servername==='bron-tls-negative.invalid'&&!options.acceptBadHostname)throw Error(options.negativeError??'certificate hostname mismatch');}
  async query(sql){
   calls.queries.push(sql);
   if(options.queryError&&options.queryError(sql))throw Error('PRIVATE_QUERY_ERROR_WITH_PASSWORD');
   if(sql===freshOwnerWitnessSql){calls.events.push('witness');return {rows:options.witnessRows??[{witness:actualWitness}]};}
   if(sql.startsWith('SELECT current_database()')){calls.events.push('identity');return {rows:options.identityRows??[identity]};}
   if(sql==='ROLLBACK'){calls.events.push('rollback');if(options.rollbackError)throw Error('PRIVATE_ROLLBACK_ERROR');}
   return {rows:[]};
  }
  async end(){this.ends++;}
 }
 const c=options.context??context(),contextSha=options.contextSha??hash(JSON.stringify(c));
 const payload=template.replace('{{CAPABILITY_SHA256}}',options.capHash??capabilityHash)
  .replace('{{EXPIRES_EPOCH_MS}}',String(options.expires??now+3600000))
  .replace('{{FENCE_CONTEXT_JSON}}',JSON.stringify(c)).replace('{{FENCE_CONTEXT_SHA256}}',contextSha);
 const compiled=stripTypeScriptTypes(payload.replace(/^import .*;$/gm,''),{disableExperimentalWarning:true});let handler;
 vm.runInNewContext(compiled,{pg:{Client},freshOwnerWitnessSql,validateFenceContext,validateFenceWitness,encryptWitness,
  crypto:webcrypto,Response,URL,Uint8Array,Error,TextEncoder,TextDecoder,btoa,atob,
  Date:class extends Date{static now(){return clock.now;}},setTimeout:(fn,ms)=>{calls.timerLimits.push(ms);return setTimeout(fn,options.forceDeadline??ms);},clearTimeout,
  lookup:async host=>{calls.dns.push(host);return options.lookup?options.lookup(clock):{address:'192.0.2.123'};},
  Deno:{serve:fn=>{handler=fn;},env:{get:key=>{calls.environment++;assert.equal(key,'SUPABASE_DB_URL');
   return options.url??'postgresql://postgres:SYNTHETIC_PASSWORD@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/postgres?sslmode=no-verify';}}}});
 const request=(body=capability,init={})=>new Request('https://example.test/functions/v1/same-function-slug',{method:'POST',body,...init});
 return {calls,clock,identity,actualWitness,context:c,contextSha,handler,request};
}
function decrypt(envelope,token=capability,info=protocol){
 const nonce=Buffer.from(envelope.nonce,'base64'),ciphertext=Buffer.from(envelope.ciphertext,'base64');
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(token,'ascii'),Buffer.from(capabilityHash),Buffer.from(info),32));
 const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(ciphertext.subarray(-16));
 return JSON.parse(Buffer.concat([d.update(ciphertext.subarray(0,-16)),d.final()]).toString());
}

test('bundle reuses the exact reviewed pure context/witness helper and exact fixed SQL',async()=>{
 assert.equal(await readFile(new URL('source-fence-witness/fence-witness.mjs',base),'utf8'),
  await readFile(new URL('source-final-https-reader/fence-witness.mjs',base),'utf8'));
 assert.equal(freshOwnerWitnessSql,reviewedSql);
 assert.equal(validateFreshOwnerWitness({before:context().before,boundary:context().boundary,witness:witness()}).newPhysicalBackendAfterDrain,true);
 assert.equal(validateFenceWitness(context(),witness()).preDataValidated,true);
 for(const forbidden of ['auth.users','pg_authid','rolpassword','SELECT *'])assert.equal(freshOwnerWitnessSql.includes(forbidden),false);
 for(const forbidden of ['snapshotDatabase','authRowsSql','source-transfer-budget','bron-source-reader-','console.','node:fs'])
  assert.equal(template.includes(forbidden),false);
});

for(const [name,options,body,init]of[
 ['missing',{},undefined,{body:undefined}],['wrong',{},'f'.repeat(64)],['short',{},'a'.repeat(63)],
 ['long',{},'a'.repeat(65)],['non-ASCII',{},'é'.repeat(64)],['GET',{},undefined,{method:'GET',body:undefined}],
 ['expired',{expires:now-1},capability],['long TTL',{expires:now+7200001},capability],
 ['unrendered',{capHash:'{{CAPABILITY_SHA256}}'},capability],
])test(`capability denial ${name} precedes context/env/DNS/database`,async()=>{
 const f=fixture(options),r=await f.handler(f.request(body,init));assert.equal(r.status,403);
 assert.equal(f.calls.environment,0);assert.equal(f.calls.dns.length,0);assert.equal(f.calls.clients.length,0);
});

test('bad immutable context or SHA is rejected after capability but before environment',async()=>{
 for(const options of [{contextSha:'f'.repeat(64)},{context:{...context(),sourceBarrierReceiptSha256:'bad'}},
  {context:{...context(),sourceBarrierActionId:'T41.other'}},{context:{...context(),extra:'PRIVATE'}},
  {context:{...context(),before:{backends:[{pid:0}]}}},{context:{...context(),before:{backends:[{pid:2147483648}]}}},
  {context:{...context(),boundary:{capturedMicros:'bad',ownerPids:[]}}}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(body.stage,'fence-context');
  assert.equal(f.calls.environment,0);assert.equal(f.calls.clients.length,0);assert.equal(JSON.stringify(body).includes('PRIVATE'),false);
 }
});

test('request cannot supply arbitrary SQL/operation/context or choose another source',async()=>{
 for(const request of [new Request('https://example.test/f?sql=SELECT+1',{method:'POST',body:capability}),
  new Request('https://example.test/f',{method:'POST',body:JSON.stringify({capability,sql:'SELECT * FROM auth.users',context:context()})}),
  new Request('https://example.test/f',{method:'POST',body:capability,headers:{'content-length':'65'}})]){
  const f=fixture();assert.equal((await f.handler(request)).status,403);assert.equal(f.calls.environment,0);
 }
});

test('fresh physical owner witness is encrypted only after same-RR identity and confirmed rollback; no barrier PASS claim',async()=>{
 const f=fixture(),r=await f.handler(f.request()),envelope=await r.json();assert.equal(r.status,200);
 assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),null);
 assert.deepEqual(Object.keys(envelope).sort(),['ciphertext','nonce','protocol']);const plain=decrypt(envelope);
 assert.equal(plain.protocol,protocol);assert.equal(plain.projectRef,'vkkqffvmztpzgygzfxhq');assert.equal(plain.destinationVps,'152.228.115.115');
 assert.equal(plain.sourceBarrierActionId,'T40.http_source_admission');assert.equal(plain.contextSha256,f.contextSha);
 assert.equal(plain.sourceControlReceiptSha256,context().sourceBarrierReceiptSha256);
 assert.equal(plain.bindingKind,'PRE_ADMISSION_CONTROL_RECEIPT');assert.equal(plain.barrierPass,false);
 assert.deepEqual(plain.identity,f.identity);assert.equal(plain.witness.pid,f.identity.pid);
 assert.equal(plain.witness.backendStartMicros,witness().backendStartMicros);assert.equal(plain.witness.preDataValidated,true);
 assert.equal(plain.witness.sourceBarrierReceiptSha256,plain.sourceControlReceiptSha256);
 assert.equal(plain.started_epoch_ms,now);assert.equal(plain.finished_epoch_ms,now);assert.equal(plain.expires_epoch_ms,now+3600000);
 assert.equal(plain.tls_negative_rejected,true);assert.equal(plain.tls_verification,'native-ca-and-hostname');assert.equal(plain.rollback_completed,true);
 assert.deepEqual(f.calls.events,['identity','witness','rollback']);assert.equal(f.calls.queries.filter(sql=>sql===freshOwnerWitnessSql).length,1);
 assert.equal(f.calls.queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(f.calls.queries.at(-1),'ROLLBACK');
 assert.match(f.calls.queries[1],/statement_timeout = '5s'.*idle_in_transaction_session_timeout = '10s'.*timezone = 'UTC'.*search_path = pg_catalog/);
 assert.equal(f.calls.queries.length,5);assert.equal(f.calls.queries.some(sql=>/^\s*(COMMIT|GRANT|REVOKE|CREATE|INSERT|UPDATE|DELETE|DO)\b/i.test(sql)),false);
 assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));assert.ok(f.calls.timerLimits.every(ms=>ms<=30000));
 const wire=JSON.stringify(envelope);for(const value of [capability,'SYNTHETIC_PASSWORD','backendStartMicros','sourceControlReceiptSha256',f.contextSha])assert.equal(wire.includes(value),false);
 assert.equal(Object.hasOwn(plain,'snapshot'),false);assert.equal(Object.hasOwn(plain,'authRows'),false);
});

test('one microsecond after boundary passes, old PID/start or invalid identity never returns encrypted witness',async()=>{
 for(const edit of [{pid:100},{pid:101},{backendStartMicros:context().boundary.capturedMicros},
  {backendStartMicros:String(BigInt(context().boundary.capturedMicros)-1n)},{isolation:'read committed'},{readOnly:'off'},
  {db:'other'},{actor:'anon'},{session:'anon'},{owner:'other'},{pid:103}]){
  const f=fixture({witness:edit}),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(body.stage,'fresh-witness');
  assert.equal(body.ciphertext,undefined);assert.equal(f.calls.events.filter(x=>x==='rollback').length,1);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('basic identity must be exact bounded owner/RR/RO/deadlines before the witness query',async()=>{
 for(const identity of [{role:'anon'},{session_role:'anon'},{read_only:'off'},{isolation:'read committed'},
  {statement_timeout:'0'},{idle_timeout:'0'},{pid:0},{pid:2147483648},{privateRows:[]},{database_time:'PRIVATE'}]){
  const f=fixture({identity}),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);
  assert.equal(f.calls.events.includes('witness'),false);assert.equal(body.ciphertext,undefined);assert.equal(body.stage,'identity');
 }
});

test('extra/private witness fields and zero/duplicate result rows are not encrypted',async()=>{
 for(const options of [{witness:{privateRows:[{password:'PRIVATE'}]}},{witness:{backendStartMicros:'1'.repeat(10000)}},
  {witnessRows:[]},{witnessRows:[{witness:witness()},{witness:witness()}]},
  {identityRows:[]},{identityRows:[{database:'postgres'},{database:'postgres'}]}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(body.ciphertext,undefined);
  assert.equal(body.nonce,undefined);assert.equal(JSON.stringify(body).includes('PRIVATE'),false);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('TLS/environment policy retains native CA, bad-host rejection and exact project/role scope',async()=>{
 for(const options of [{acceptBadHostname:true},{negativeError:'TCP reset'},
  {url:'postgres://postgres:SYNTHETIC_PASSWORD@other.invalid:5432/postgres'},
  {url:'postgres://anon:SYNTHETIC_PASSWORD@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/postgres'}]){
  const f=fixture(options),r=await f.handler(f.request());assert.equal(r.status,502);assert.equal(f.calls.events.includes('witness'),false);
 }
 const f=fixture();await f.handler(f.request());
 assert.deepEqual(f.calls.clients.map(c=>c.config.ssl.servername),['bron-tls-negative.invalid','db.vkkqffvmztpzgygzfxhq.supabase.co']);
 assert.ok(f.calls.clients.every(c=>c.config.ssl.rejectUnauthorized===true&&c.config.host==='192.0.2.123'&&!('connectionString'in c.config)));
});

test('read or rollback failure is never retried into success and returns no raw details',async()=>{
 for(const options of [{queryError:sql=>sql===freshOwnerWitnessSql},{rollbackError:true}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(body.ciphertext,undefined);
  assert.equal(JSON.stringify(body).includes('PRIVATE'),false);assert.equal(f.calls.queries.filter(sql=>sql===freshOwnerWitnessSql).length,1);
  assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('deadline/abort/stalled capability close resources and do not return partial witness',async()=>{
 const f=fixture({forceDeadline:5,connect:()=>new Promise(()=>{})}),r=await f.handler(f.request()),body=await r.json();
 assert.equal(r.status,504);assert.equal(body.ciphertext,undefined);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 const g=fixture({forceDeadline:5}),stream=new ReadableStream({start(){}});
 assert.equal((await g.handler(new Request('https://example.test/f',{method:'POST',body:stream,duplex:'half'}))).status,504);
 assert.equal(g.calls.environment,0);
 const controller=new AbortController();controller.abort();const h=fixture();
 assert.equal((await h.handler(h.request(capability,{signal:controller.signal}))).status,403);assert.equal(h.calls.environment,0);
 const late=fixture({lookup:clock=>{clock.now=now+30001;return {address:'192.0.2.123'};}});
 assert.equal((await late.handler(late.request())).status,502);assert.equal(late.calls.clients.length,0);
});

test('the same capability remains protocol-separated from final Auth reader; nonce/tamper/bounds are enforced',async()=>{
 const a=fixture(),b=fixture(),ea=await(await a.handler(a.request())).json(),eb=await(await b.handler(b.request())).json();
 assert.notEqual(ea.nonce,eb.nonce);assert.notEqual(ea.ciphertext,eb.ciphertext);assert.deepEqual(decrypt(ea),decrypt(eb));
 assert.throws(()=>decrypt(ea,'f'.repeat(64)));assert.throws(()=>decrypt(ea,capability,'BRON_PRIVATE_SNAPSHOT_V1'));
 assert.throws(()=>decrypt(ea,capability,'BRON_ADMISSION_METADATA_V1'));
 const bytes=Buffer.from(ea.ciphertext,'base64');bytes[0]^=1;assert.throws(()=>decrypt({...ea,ciphertext:bytes.toString('base64')}));
 await assert.rejects(encryptWitness({oversized:'x'.repeat(65536)},new TextEncoder().encode(capability),capabilityHash));
});
