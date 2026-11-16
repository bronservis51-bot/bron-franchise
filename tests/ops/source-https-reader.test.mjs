import assert from 'node:assert/strict';
import {createHash,createDecipheriv,hkdfSync,webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {encryptSnapshot} from '../../docs/runbooks/payloads/source-https-reader/encrypt-snapshot.mjs';

const template=await readFile(new URL('../../docs/runbooks/payloads/source-https-reader/index.ts',import.meta.url),'utf8');
const protocol='BRON_PRIVATE_SNAPSHOT_V1',capability='a'.repeat(64),capabilityHash=createHash('sha256').update(capability).digest('hex');
const now=Date.parse('2026-11-14T03:30:00Z'),sourceUrl='postgresql://postgres:SYNTHETIC_PASSWORD@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/postgres?sslmode=no-verify';
const authRowsSql='SYNTHETIC_FIXED_AUTH_ROWS_SQL';
const rows=()=>Array.from({length:16},(_,i)=>({private_id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,private_stamp:'2026-11-14 03:00:00.000001+00',private_micros:'1794625200000001',private_other:'b'.repeat(64)}));
function fixture(options={}){
 const calls={environment:0,dns:[],clients:[],queries:[],events:[],timers:[],snapshots:0,authCaptures:0};
 const clock={now};
 const identity={database:'postgres',role:'postgres',session_role:'postgres',owner:'postgres',read_only:'on',isolation:'repeatable read',statement_timeout:'5s',idle_timeout:'10s',pid:123,server_address:'192.0.2.1',database_time:'2026-11-14 03:30:00+00',...options.identity};
 const snapshot={'data:auth.users':{count:16,hash:'c'.repeat(64)},'data:public.partner':{count:1,hash:'d'.repeat(64)},'schema:relations':{count:63,hash:'e'.repeat(64)}};
 class Client{
  constructor(config){this.config=config;this.ends=0;this.destroys=0;this.connection={stream:{destroy:()=>{this.destroys++;}}};calls.clients.push(this);}
  on(){}
  async connect(){if(options.connect)return options.connect(this);if(this.config.ssl.servername==='bron-tls-negative.invalid'&&!options.acceptBadHostname)throw new Error(options.negativeError??'certificate hostname mismatch');}
  async query(sql){calls.queries.push(sql);if(options.query)return options.query(sql,this,identity);if(sql===authRowsSql){calls.authCaptures++;calls.events.push('auth-captured');return {rows:options.authRows??rows()};}return {rows:/select[\s\S]*current_database\(/i.test(sql)?[identity]:[]};}
  async end(){this.ends++;}
 }
 const exactQueryFingerprint=async()=>{throw Error('fixture fingerprint callback should be forwarded, not called directly');};
 const snapshotDatabase=async(db,settings)=>{
  calls.snapshots++;assert.equal(settings.fingerprintQuery,exactQueryFingerprint);assert.equal(typeof settings.beforeCommit,'function');
  calls.events.push('snapshot-begin');await db.query('begin isolation level repeatable read read only');
  await db.query("set local timezone='UTC'");await db.query('set local search_path=pg_catalog');
  if(options.snapshotError)throw Error('SYNTHETIC_PRIVATE_SNAPSHOT_ERROR');
  await settings.beforeCommit(db);calls.events.push('snapshot-before-commit');await db.query('commit');calls.events.push('snapshot-committed');return options.snapshot??snapshot;
 };
 const payload=options.unsubstituted?template:template.replace('{{CAPABILITY_SHA256}}',capabilityHash).replace('{{EXPIRES_EPOCH_MS}}',String(options.expires??now+3600000));
 const compiled=stripTypeScriptTypes(payload.replace(/^import .*;$/gm,''),{disableExperimentalWarning:true});let handler;
 vm.runInNewContext(compiled,{pg:{Client},snapshotDatabase,exactQueryFingerprint,authRowsSql,encryptSnapshot,crypto:webcrypto,Response,URL,Uint8Array,Error,TextEncoder,TextDecoder,btoa,atob,
  Date:class extends Date{static now(){return clock.now;}},lookup:async host=>{calls.dns.push(host);return options.lookup?options.lookup(clock):{address:'192.0.2.123'};},
  setTimeout:(fn,ms)=>{calls.timers.push(ms);return setTimeout(fn,options.forceDeadline??ms);},clearTimeout,
  Deno:{serve:fn=>{handler=fn;},env:{get:key=>{calls.environment++;assert.equal(key,'SUPABASE_DB_URL');return options.url??sourceUrl;}}}});
 const request=(body=capability,init={})=>new Request('https://example.test/functions/v1/private-reader',{method:'POST',body,...init});
 return {handler,request,calls,clock,snapshot,identity};
}
function decrypt(envelope,token=capability){
 assert.equal(envelope.protocol,protocol);const nonce=Buffer.from(envelope.nonce,'base64'),ciphertext=Buffer.from(envelope.ciphertext,'base64');
 assert.equal(nonce.length,12);assert.equal(nonce.toString('base64'),envelope.nonce);assert.equal(ciphertext.toString('base64'),envelope.ciphertext);
 const key=Buffer.from(hkdfSync('sha256',Buffer.from(token,'ascii'),Buffer.from(capabilityHash,'utf8'),Buffer.from(protocol,'utf8'),32));
 const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAuthTag(ciphertext.subarray(-16));
 return JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]).toString('utf8'));
}
for(const [name,options,body,init]of[
 ['missing capability',{},undefined,{body:undefined}],['wrong capability',{},'b'.repeat(64)],['short capability',{},'a'.repeat(63)],
 ['oversized capability',{},'a'.repeat(100000)],['non-ASCII capability',{},'é'.repeat(64)],['expired',{expires:now-1},capability],
 ['future TTL too long',{expires:now+7200001},capability],['unrendered template',{unsubstituted:true},capability],['GET',{},undefined,{method:'GET',body:undefined}],
])test(`denies ${name} before environment, DNS or database`,async()=>{
 const f=fixture(options),response=await f.handler(f.request(body,init));assert.equal(response.status,403);assert.equal(f.calls.environment,0);assert.equal(f.calls.dns.length,0);assert.equal(f.calls.clients.length,0);
});

test('no client-provided query, URL or SQL is accepted',async()=>{
 for(const request of[new Request('https://example.test/private?sql=SELECT%201',{method:'POST',body:capability}),new Request('https://example.test/private',{method:'POST',body:JSON.stringify({capability,sql:'SELECT 1'})}),new Request('https://example.test/private',{method:'POST',body:capability,headers:{'content-length':'65'}})]){
  const f=fixture();assert.equal((await f.handler(request)).status,403);assert.equal(f.calls.environment,0);
 }
});

test('one source snapshot captures compact Auth inside its RR transaction and encrypts every private field',async()=>{
 const f=fixture(),response=await f.handler(f.request()),envelope=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('access-control-allow-origin'),null);
 assert.deepEqual(Object.keys(envelope).sort(),['ciphertext','nonce','protocol']);const text=JSON.stringify(envelope);
 for(const forbidden of[capability,'SYNTHETIC_PASSWORD','00000000-0000-4000-8000-000000000001','private_id','private_stamp','authRows','data:auth.users','2026-11-14 03:00','b'.repeat(64)])assert.ok(!text.includes(forbidden));
 const result=decrypt(envelope);assert.equal(result.ok,true);assert.equal(result.protocol,protocol);assert.equal(result.projectRef,'vkkqffvmztpzgygzfxhq');assert.deepEqual(result.snapshot,f.snapshot);assert.deepEqual(result.authRows,rows());
 assert.equal(result.identity.read_only,'on');assert.equal(result.identity.isolation,'repeatable read');assert.equal(result.tls_negative_rejected,true);assert.equal(result.expires_epoch_ms,now+3600000);
 assert.equal(f.calls.snapshots,1);assert.equal(f.calls.authCaptures,1);assert.deepEqual(f.calls.events,['snapshot-begin','auth-captured','snapshot-before-commit','snapshot-committed']);
 assert.deepEqual(f.calls.clients.map(c=>c.config.host),['192.0.2.123','192.0.2.123']);assert.deepEqual(f.calls.clients.map(c=>c.config.ssl.servername),['bron-tls-negative.invalid','db.vkkqffvmztpzgygzfxhq.supabase.co']);
 for(const client of f.calls.clients){assert.equal(client.config.ssl.rejectUnauthorized,true);assert.equal('connectionString'in client.config,false);assert.ok(client.ends>=1&&client.destroys>=1);}
 assert.ok(f.calls.timers.every(ms=>ms<=90000));assert.throws(()=>decrypt(envelope,'f'.repeat(64)));assert.throws(()=>decrypt(envelope,capabilityHash));
});

test('fresh AES-GCM nonce changes ciphertext for identical plaintext; tampering fails',async()=>{
 const a=fixture(),b=fixture(),ea=await(await a.handler(a.request())).json(),eb=await(await b.handler(b.request())).json();assert.notEqual(ea.nonce,eb.nonce);assert.notEqual(ea.ciphertext,eb.ciphertext);assert.deepEqual(decrypt(ea),decrypt(eb));
 const bytes=Buffer.from(ea.ciphertext,'base64');bytes[0]^=1;assert.throws(()=>decrypt({...ea,ciphertext:bytes.toString('base64')}));
});

test('17th Auth row fails closed without plaintext or encrypted partial success',async()=>{
 const tooMany=rows();tooMany.push({...tooMany[0],private_id:'00000000-0000-4000-8000-000000000017'});const f=fixture({authRows:tooMany}),response=await f.handler(f.request()),body=await response.json();assert.equal(response.status,502);assert.equal(body.ciphertext,undefined);assert.equal(body.nonce,undefined);assert.ok(!JSON.stringify(body).includes('private_id'));assert.ok(f.calls.clients.every(c=>c.destroys>0&&c.ends>0));
});

test('actual role/read-only/isolation/deadline mismatch fails before returning any data',async()=>{
 for(const identity of[{read_only:'off'},{isolation:'read committed'},{role:'anon'},{session_role:'other'},{owner:'other'},{statement_timeout:'0'},{idle_timeout:'0'}]){
  const f=fixture({identity}),response=await f.handler(f.request()),body=await response.json();assert.equal(response.status,502);assert.equal(body.ciphertext,undefined);assert.ok(!JSON.stringify(body).includes('private_id'));assert.ok(f.calls.clients.every(c=>c.destroys>0&&c.ends>0));
 }
});

test('TLS identity negatives and environment scope still fail closed',async()=>{
 for(const options of[{acceptBadHostname:true},{negativeError:'TLS connection reset'},{url:'postgres://postgres:SYNTHETIC_PASSWORD@db.other.supabase.co:5432/postgres'}]){
  const f=fixture(options),response=await f.handler(f.request()),body=await response.json();assert.equal(response.status,502);assert.equal(f.calls.snapshots,0);assert.ok(!JSON.stringify(body).includes('SYNTHETIC_PASSWORD'));
 }
});

test('source snapshot failure only returns fixed diagnostics and cleans clients',async()=>{
 const f=fixture({snapshotError:true}),response=await f.handler(f.request()),body=await response.json();assert.equal(response.status,502);assert.ok(!JSON.stringify(body).includes('SYNTHETIC_PRIVATE'));assert.equal(body.ciphertext,undefined);assert.ok(f.calls.clients.every(c=>c.destroys>0&&c.ends>0));
});

test('overall timeout destroys every client and returns no private or partial payload',async()=>{
 const f=fixture({forceDeadline:5,connect:()=>new Promise(()=>{})}),response=await f.handler(f.request()),body=await response.json();assert.equal(response.status,504);assert.equal(body.ciphertext,undefined);assert.ok(!JSON.stringify(body).includes('SYNTHETIC_PASSWORD'));assert.ok(f.calls.clients.every(c=>c.destroys>0&&c.ends>0));
});

test('oversized response fails closed rather than returning encrypted partial data',async()=>{
 const f=fixture({snapshot:{oversized:'x'.repeat(1048576)}}),response=await f.handler(f.request()),body=await response.json();assert.equal(response.status,502);assert.equal(body.ciphertext,undefined);assert.equal(body.nonce,undefined);assert.ok(f.calls.clients.every(c=>c.destroys>0&&c.ends>0));
});
