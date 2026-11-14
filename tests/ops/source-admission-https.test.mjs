import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {createHash,createDecipheriv,hkdfSync,webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {beforeImageSql as reviewedSql} from '../../docs/runbooks/payloads/http-source-admission.mjs';
import {validateAdmissionMetadata as reviewedValidator} from '../../docs/runbooks/payloads/admission-metadata-custody.mjs';
import {beforeImageSql,beforeImageSqlSha256} from '../../docs/runbooks/payloads/source-admission-https/metadata-sql.mjs';
import {validateAdmissionMetadata,validatorSourceSha256} from '../../docs/runbooks/payloads/source-admission-https/metadata-state.mjs';
import {encryptMetadata} from '../../docs/runbooks/payloads/source-admission-https/encrypt-metadata.mjs';

const base=new URL('../../docs/runbooks/payloads/',import.meta.url),hash=x=>createHash('sha256').update(x).digest('hex');
const template=await readFile(new URL('source-admission-https/index.ts',base),'utf8');
const protocol='BRON_ADMISSION_METADATA_V1',capability='a'.repeat(64),capabilityHash=hash(capability);
const now=Date.parse('2026-11-14T10:00:00Z'),actionId='T99.http_source_admission',manifestSha256='b'.repeat(64);
const role=(name,extra={})=>({name,super:false,login:false,createRole:false,createDb:false,replication:false,
 bypass:false,connect:true,ownerPath:false,...extra});
const state=()=>({db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',signal:true,pid:100,readOnly:'on',
 capturedMicros:String(BigInt(now)*1000n),acl:['PUBLIC','dashboard_user','postgres'].map(grantee=>
  ({grantee,grantor:'postgres',privilege:'CONNECT',grantable:false})),
 roles:[role('postgres',{login:true,ownerPath:true}),role('dashboard_user',{ownerPath:true}),role('pgbouncer',{login:true})],
 backends:[{pid:100,role:'postgres',type:'client backend',state:'active',openTransaction:true,super:false,providerAppKnown:false},
  {pid:101,role:null,type:'autovacuum worker',state:null,openTransaction:false,super:false,providerAppKnown:null}],
 lookupCriticalWrites:0,lookupSequenceWrites:0,lookupCriticalDefiners:0,lookupOtherSetRoles:0,
 prepared:0,netQueued:0,unexpectedActiveCron:0,runJobsExists:false});

function fixture(options={}){
 const calls={environment:0,dns:[],queries:[],clients:[],events:[],timerLimits:[]};
 const clock={now},identity={database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',
  isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:100,database_time:'2026-11-14 10:00:00.000001+00',...options.identity};
 const metadata=options.state??state();
 class Client{
  constructor(config){this.config=config;this.ends=0;this.destroys=0;this.connection={stream:{destroy:()=>{this.destroys++;}}};calls.clients.push(this);}
  on(){}
  async connect(){
   if(options.connect)return options.connect(this);
   if(this.config.ssl.servername==='bron-tls-negative.invalid'&&!options.acceptBadHostname)throw Error(options.negativeError??'certificate hostname mismatch');
  }
  async query(sql){
   calls.queries.push(sql);
   if(options.queryError&&options.queryError(sql))throw Error('PRIVATE_DATABASE_ERROR_WITH_PASSWORD');
   if(sql===beforeImageSql){calls.events.push('metadata');return {rows:options.metadataRows??[{state:metadata}]};}
   if(sql.startsWith('SELECT current_database()')){calls.events.push('identity');return {rows:options.identityRows??[identity]};}
   if(sql==='ROLLBACK'){calls.events.push('rollback');if(options.rollbackError)throw Error('PRIVATE_ROLLBACK_ERROR');}
   return {rows:[]};
  }
  async end(){this.ends++;}
 }
 const payload=template.replace('{{CAPABILITY_SHA256}}',options.capHash??capabilityHash)
  .replace('{{EXPIRES_EPOCH_MS}}',String(options.expires??now+3600000))
  .replace('{{ACTION_ID}}',options.actionId??actionId).replace('{{MANIFEST_SHA256}}',options.manifestSha256??manifestSha256);
 const compiled=stripTypeScriptTypes(payload.replace(/^import .*;$/gm,''),{disableExperimentalWarning:true});let handler;
 vm.runInNewContext(compiled,{pg:{Client},lookup:async host=>{calls.dns.push(host);if(options.lookup)return options.lookup(clock);return {address:'192.0.2.123'};},
  beforeImageSql:options.sql??beforeImageSql,beforeImageSqlSha256:options.sqlHash??beforeImageSqlSha256,
  validateAdmissionMetadata,encryptMetadata,crypto:webcrypto,Response,URL,Uint8Array,Error,TextEncoder,TextDecoder,btoa,atob,
  Date:class extends Date{static now(){return clock.now;}},setTimeout:(fn,ms)=>{calls.timerLimits.push(ms);return setTimeout(fn,options.forceDeadline??ms);},clearTimeout,
  Deno:{serve:fn=>{handler=fn;},env:{get:key=>{calls.environment++;assert.equal(key,'SUPABASE_DB_URL');
   return options.url??'postgresql://postgres:SYNTHETIC_PASSWORD@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/postgres?sslmode=no-verify';}}}});
 const request=(body=capability,init={})=>new Request('https://example.test/functions/v1/admission-reader',{method:'POST',body,...init});
 return {calls,clock,identity,metadata,handler,request};
}
function decrypt(envelope,token=capability,info=protocol){
 const nonce=Buffer.from(envelope.nonce,'base64'),ciphertext=Buffer.from(envelope.ciphertext,'base64');
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(token,'ascii'),Buffer.from(capabilityHash),Buffer.from(info),32));
 const d=createDecipheriv('aes-256-gcm',key,nonce);d.setAuthTag(ciphertext.subarray(-16));
 return JSON.parse(Buffer.concat([d.update(ciphertext.subarray(0,-16)),d.final()]).toString());
}

test('generated fixed SQL is byte-for-byte reviewed beforeImageSql, with explicit SHA',async()=>{
 assert.equal(beforeImageSql,reviewedSql);assert.equal(beforeImageSqlSha256,hash(reviewedSql));
 const expected='// GENERATED fixed metadata SQL. Parity is tested against http-source-admission.mjs.\n'+
  'export const beforeImageSql='+JSON.stringify(reviewedSql)+';\n'+
  'export const beforeImageSqlSha256='+JSON.stringify(hash(reviewedSql))+';\n';
 assert.equal(await readFile(new URL('source-admission-https/metadata-sql.mjs',base),'utf8'),expected);
 for(const forbidden of ['auth.users','rolpassword','SELECT *','INSERT INTO','UPDATE auth','DELETE FROM'])assert.equal(beforeImageSql.includes(forbidden),false);
});

test('pure Edge allowlist is an exact generated port of the VPS validator with no runtime Node imports',async()=>{
 const source=await readFile(new URL('admission-metadata-custody.mjs',base),'utf8');
 const selected=source.slice(source.indexOf("const ownError=Symbol('safe-custody-error');"),source.indexOf('const frozen='))+'\n'+
  source.slice(source.indexOf('const roleKeys='),source.indexOf('\nconst activationKeys='));
 const rendered=selected.replaceAll('Buffer.byteLength(x)','encoder.encode(x).length')
  .replace("Buffer.from(canonical(x)+'\\n')","encoder.encode(canonical(x)+'\\n')");
 const expected='// GENERATED pure validator from admission-metadata-custody.mjs. No runtime Node imports.\n'+
  '// Regenerate only with its parity test; shared normalization is required for exact SQL SHA.\n'+
  'const MAX=1048576,encoder=new TextEncoder();\n'+
  'export const validatorSourceSha256='+JSON.stringify(hash(selected))+';\n'+rendered+'\n';
 assert.equal(validatorSourceSha256,hash(selected));
 assert.equal(await readFile(new URL('source-admission-https/metadata-state.mjs',base),'utf8'),expected);
 assert.deepEqual(validateAdmissionMetadata(state()),reviewedValidator(state()));
 for(const type of ['pg_cron launcher','pg_net worker','pg_net 0.20.4 worker','logical replication tablesync worker']){
  const sample=state();sample.backends[1].type=type;
  assert.deepEqual(validateAdmissionMetadata(sample),reviewedValidator(sample));
 }
 const reordered=Object.fromEntries(Object.entries(state()).reverse());
 assert.deepEqual(validateAdmissionMetadata(reordered),reviewedValidator(reordered));
 for(const mutate of [s=>{s.authRows=[];},s=>{s.roles[0].password='private';},s=>{s.backends[0].query='private';},
  s=>{s.acl.push({...s.acl[0]});},s=>{s.readOnly='off';},s=>{s.backends[0].state='private';},s=>{s.pid=-1;}]){
  const sample=state();mutate(sample);assert.throws(()=>validateAdmissionMetadata(sample));assert.throws(()=>reviewedValidator(sample));
 }
});

for(const [name,options,body,init]of[
 ['missing',{},undefined,{body:undefined}],['wrong',{},'f'.repeat(64)],['short',{},'a'.repeat(63)],
 ['long',{},'a'.repeat(65)],['non-ASCII',{},'é'.repeat(64)],['GET',{},undefined,{method:'GET',body:undefined}],
 ['expired',{expires:now-1},capability],['long TTL',{expires:now+7200001},capability],
 ['template capability',{capHash:'{{CAPABILITY_SHA256}}'},capability],
])test(`capability denial ${name} precedes environment, DNS and database`,async()=>{
 const f=fixture(options),r=await f.handler(f.request(body,init));assert.equal(r.status,403);
 assert.equal(f.calls.environment,0);assert.equal(f.calls.dns.length,0);assert.equal(f.calls.clients.length,0);
});

test('caller SQL, operation, URL, binding or context cannot be supplied in body/query',async()=>{
 for(const request of [new Request('https://example.test/f?sql=SELECT+1',{method:'POST',body:capability}),
  new Request('https://example.test/f',{method:'POST',body:JSON.stringify({capability,operation:'auth',sql:'SELECT * FROM auth.users'})}),
  new Request('https://example.test/f',{method:'POST',body:capability,headers:{'content-length':'65'}})]){
  const f=fixture();assert.equal((await f.handler(request)).status,403);assert.equal(f.calls.environment,0);
 }
});

test('immutable action/manifest/query mismatch is rejected after capability but before env or DB',async()=>{
 for(const options of [{actionId:'T99.other'},{manifestSha256:'unreviewed'},{sql:'SELECT 1'},{sqlHash:'f'.repeat(64)}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(body.stage,'binding');
  assert.equal(f.calls.environment,0);assert.equal(f.calls.clients.length,0);
 }
});

test('one fixed metadata read has actual same-backend RR/RO identity, confirmed rollback, and encrypted output only',async()=>{
 const f=fixture(),r=await f.handler(f.request()),envelope=await r.json();assert.equal(r.status,200);
 assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),null);
 assert.deepEqual(Object.keys(envelope).sort(),['ciphertext','nonce','protocol']);const plain=decrypt(envelope);
 assert.equal(plain.protocol,protocol);assert.equal(plain.projectRef,'vkkqffvmztpzgygzfxhq');assert.equal(plain.destinationVps,'152.228.115.115');
 assert.equal(plain.actionId,actionId);assert.equal(plain.manifestSha256,manifestSha256);assert.equal(plain.metadataQuerySha256,beforeImageSqlSha256);
 assert.deepEqual(plain.state,reviewedValidator(state()));assert.deepEqual(plain.identity,f.identity);
 assert.equal(plain.started_epoch_ms,now);assert.equal(plain.finished_epoch_ms,now);assert.equal(plain.expires_epoch_ms,now+3600000);
 assert.equal(plain.tls_negative_rejected,true);assert.equal(plain.tls_verification,'native-ca-and-hostname');assert.equal(plain.rollback_completed,true);
 assert.deepEqual(f.calls.events,['identity','metadata','rollback']);assert.equal(f.calls.queries.filter(sql=>sql===beforeImageSql).length,1);
 assert.equal(f.calls.queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(f.calls.queries.at(-1),'ROLLBACK');
 assert.match(f.calls.queries[1],/statement_timeout = '5s'.*idle_in_transaction_session_timeout = '10s'.*timezone = 'UTC'.*search_path = pg_catalog/);
 assert.equal(f.calls.queries.some(sql=>/^\s*(COMMIT|GRANT|REVOKE|CREATE|INSERT|UPDATE|DELETE|DO)\b/i.test(sql)),false);
 assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));assert.ok(f.calls.timerLimits.every(ms=>ms<=30000));
 const wire=JSON.stringify(envelope);for(const value of [capability,'SYNTHETIC_PASSWORD','capturedMicros','ownerPath','state":',manifestSha256,actionId])assert.equal(wire.includes(value),false);
});

test('AES-GCM nonce is fresh; wrong capability, wrong protocol and tampering cannot decrypt',async()=>{
 const a=fixture(),b=fixture(),ea=await(await a.handler(a.request())).json(),eb=await(await b.handler(b.request())).json();
 assert.notEqual(ea.nonce,eb.nonce);assert.notEqual(ea.ciphertext,eb.ciphertext);assert.deepEqual(decrypt(ea),decrypt(eb));
 assert.throws(()=>decrypt(ea,'f'.repeat(64)));assert.throws(()=>decrypt(ea,capability,'BRON_PRIVATE_SNAPSHOT_V1'));
 const changed=Buffer.from(ea.ciphertext,'base64');changed[0]^=1;assert.throws(()=>decrypt({...ea,ciphertext:changed.toString('base64')}));
});

test('identity mismatch stops before metadata read, still attempts rollback and returns no partial payload',async()=>{
 for(const identity of [{read_only:'off'},{isolation:'read committed'},{statement_timeout:'0'},{idle_timeout:'0'},
  {database:'another'},{role:'anon'},{session_role:'anon'},{owner:'another'},{pid:0},{database_time:'private string'},{privateRows:[]}]){
  const f=fixture({identity}),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);
  assert.equal(body.stage,'identity');assert.equal(body.ciphertext,undefined);assert.equal(f.calls.events.includes('metadata'),false);
  assert.equal(f.calls.events.filter(x=>x==='rollback').length,1);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('private/extra/oversized state, wrong PID or duplicate result rows fail before encryption',async()=>{
 const extras=state();extras.authUsers=[{password:'PRIVATE_VALUE'}];const wrongPid=state();wrongPid.pid=101;
 const nested=state();nested.roles[0].password='PRIVATE_VALUE';const giant=state();giant.backends=Array.from({length:2049},()=>state().backends[0]);
 for(const options of [{state:extras},{state:wrongPid},{state:nested},{state:giant},{metadataRows:[]},{metadataRows:[{state:state()},{state:state()}]}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);assert.equal(body.ciphertext,undefined);
  assert.equal(body.stage,'metadata');assert.equal(JSON.stringify(body).includes('PRIVATE_VALUE'),false);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('TLS scope keeps T37 native CA/SNI positive and negative controls without no-verify flags',async()=>{
 for(const options of [{acceptBadHostname:true},{negativeError:'TCP connection reset'},
  {url:'postgres://postgres:SYNTHETIC_PASSWORD@other.invalid:5432/postgres'},
  {url:'postgres://anon:SYNTHETIC_PASSWORD@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/postgres'}]){
  const f=fixture(options),r=await f.handler(f.request());assert.equal(r.status,502);assert.equal(f.calls.events.includes('metadata'),false);
 }
 const f=fixture();await f.handler(f.request());
 assert.deepEqual(f.calls.clients.map(c=>c.config.ssl.servername),['bron-tls-negative.invalid','db.vkkqffvmztpzgygzfxhq.supabase.co']);
 assert.ok(f.calls.clients.every(c=>c.config.ssl.rejectUnauthorized===true&&c.config.host==='192.0.2.123'&&!('connectionString'in c.config)));
});

test('read or rollback failure never returns success or raw errors, and metadata is not retried',async()=>{
 for(const options of [{queryError:sql=>sql===beforeImageSql},{rollbackError:true}]){
  const f=fixture(options),r=await f.handler(f.request()),body=await r.json();assert.equal(r.status,502);
  assert.equal(body.ciphertext,undefined);assert.equal(body.nonce,undefined);assert.equal(JSON.stringify(body).includes('PRIVATE'),false);
  assert.equal(f.calls.queries.filter(sql=>sql===beforeImageSql).length,1);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 }
});

test('overall deadline and abort destroy all clients; stalled authorization does not reach environment',async()=>{
 const f=fixture({forceDeadline:5,connect:()=>new Promise(()=>{})}),r=await f.handler(f.request()),body=await r.json();
 assert.equal(r.status,504);assert.equal(body.ciphertext,undefined);assert.ok(f.calls.clients.every(c=>c.ends>0&&c.destroys>0));
 const g=fixture({forceDeadline:5}),stream=new ReadableStream({start(){}});
 const pending=new Request('https://example.test/f',{method:'POST',body:stream,duplex:'half'});
 assert.equal((await g.handler(pending)).status,504);assert.equal(g.calls.environment,0);
 const controller=new AbortController();controller.abort();const h=fixture();
 assert.equal((await h.handler(h.request(capability,{signal:controller.signal}))).status,403);assert.equal(h.calls.environment,0);
});

test('streamed capability is bounded and deadline checks stop late DNS before client construction',async()=>{
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('a'.repeat(32)));c.enqueue(new TextEncoder().encode('a'.repeat(33)));c.close();}});
 const f=fixture();assert.equal((await f.handler(new Request('https://example.test/f',{method:'POST',body:stream,duplex:'half'}))).status,403);
 assert.equal(f.calls.environment,0);
 const g=fixture({lookup:clock=>{clock.now=now+30001;return {address:'192.0.2.123'};}});
 assert.equal((await g.handler(g.request())).status,502);assert.equal(g.calls.clients.length,0);
});

test('encryption bounds the entire technical frame without emitting partial ciphertext',async()=>{
 await assert.rejects(encryptMetadata({oversized:'x'.repeat(1048576)},new TextEncoder().encode(capability),capabilityHash));
 await assert.rejects(encryptMetadata({},new TextEncoder().encode('invalid'),capabilityHash));
});
