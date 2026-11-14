import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';

const template = await readFile(new URL('../../docs/runbooks/payloads/source-https-probe/index.ts', import.meta.url), 'utf8');
const capability = 'a'.repeat(64), capabilityHash = createHash('sha256').update(capability).digest('hex');
const sourceUrl = 'postgresql://postgres:SYNTHETIC_PASSWORD@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/postgres?sslmode=no-verify';
const now = 1794650000000;
function fixture(options = {}) {
  const calls = {environment:0, dns:[], clients:[], queries:[], timers:[]};
  const clock = {now};
  const identity = {database:'postgres', role:'postgres', session_role:'postgres', owner:'postgres',
    read_only:'on', isolation:'repeatable read', statement_timeout:'5s', idle_timeout:'10s',
    pid:123, server_address:'192.0.2.1', database_time:'synthetic', dummy:'x'.repeat(524288), ...options.identity};
  class Client {
    constructor(config) {
      this.config = config; this.ends = 0; this.destroys = 0;
      this.connection = {stream:{destroy:() => {this.destroys++;}}}; calls.clients.push(this);
    }
    on() {}
    async connect() {
      if (options.connect) return options.connect(this);
      if (this.config.ssl.servername === 'bron-tls-negative.invalid' && !options.acceptBadHostname)
        throw new Error(options.negativeError ?? 'certificate hostname mismatch');
    }
    async query(sql) {
      calls.queries.push(sql);
      if (options.query) return options.query(sql, this, identity);
      return {rows:sql.startsWith('SELECT') ? [identity] : []};
    }
    async end() {this.ends++;}
  }
  const payload = options.unsubstituted ? template : template.replace('{{CAPABILITY_SHA256}}', capabilityHash)
    .replace('{{EXPIRES_EPOCH_MS}}', String(options.expires ?? now + 3600000));
  const compiled = stripTypeScriptTypes(payload.replace(/^import .*;$/gm, ''), {disableExperimentalWarning:true});
  let handler;
  vm.runInNewContext(compiled, {pg:{Client}, crypto:webcrypto, Response, URL, Uint8Array, Error,
    Date:class extends Date {static now() {return clock.now;}},
    lookup:async host => {calls.dns.push(host); return options.lookup ? options.lookup(clock) : {address:'192.0.2.123'};},
    setTimeout:(fn, ms) => {calls.timers.push(ms); return setTimeout(fn, options.forceDeadline ?? ms);}, clearTimeout,
    Deno:{serve:fn => {handler=fn;}, env:{get:key => {calls.environment++; assert.equal(key,'SUPABASE_DB_URL'); return options.url ?? sourceUrl;}}},
  });
  const request = (body = capability, init = {}) => new Request('https://example.test/functions/v1/probe',
    {method:'POST', body, ...init});
  return {handler, request, calls, clock};
}

for (const [name, options, body, init] of [
  ['missing capability', {}, undefined, {body:undefined}],
  ['wrong capability', {}, 'b'.repeat(64)],
  ['short capability', {}, 'a'.repeat(63)],
  ['non-ASCII capability', {}, 'é'.repeat(64)],
  ['oversize capability', {}, 'a'.repeat(100000)],
  ['expired', {expires:now-1}, capability],
  ['invalid future window', {expires:now+7200001}, capability],
  ['unsubstituted template', {unsubstituted:true}, capability],
  ['GET', {}, undefined, {method:'GET', body:undefined}],
]) test(`rejects ${name} before environment/DNS/database access`, async () => {
  const f=fixture(options); const response=await f.handler(f.request(body,init));
  assert.equal(response.status,403); assert.equal((await response.json()).probe_protocol,'BRON_HTTPS_PROBE_V1'); assert.equal(f.calls.environment,0);
  assert.equal(f.calls.dns.length,0); assert.equal(f.calls.clients.length,0);
});

test('rejects query parameters and declared oversized body before database', async () => {
  for (const req of [new Request('https://example.test/probe?cap=hidden',{method:'POST',body:capability}),
    new Request('https://example.test/probe',{method:'POST',body:capability,headers:{'content-length':'65'}})]) {
    const f=fixture(); assert.equal((await f.handler(req)).status,403); assert.equal(f.calls.environment,0);
  }
});

test('one IP, explicit correct/wrong SNI, fixed RRRO, 512 KiB dummy and cleanup', async () => {
  const f=fixture(); const response=await f.handler(f.request()); const result=await response.json();
  assert.equal(response.status,200); assert.equal(result.probe_protocol,'BRON_HTTPS_PROBE_V1'); assert.equal(result.projectRef,'vkkqffvmztpzgygzfxhq'); assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal(result.identity.dummy,'x'.repeat(524288)); assert.equal(result.tls_negative_rejected,true);
  assert.equal(result.identity.read_only,'on'); assert.equal(result.identity.isolation,'repeatable read');
  assert.equal(result.expires_epoch_ms,now+3600000); assert.deepEqual(f.calls.dns,['db.vkkqffvmztpzgygzfxhq.supabase.co']);
  assert.deepEqual(f.calls.clients.map(c=>c.config.host),['192.0.2.123','192.0.2.123']);
  assert.deepEqual(f.calls.clients.map(c=>c.config.ssl.servername),['bron-tls-negative.invalid','db.vkkqffvmztpzgygzfxhq.supabase.co']);
  for (const client of f.calls.clients) {
    assert.equal(client.config.ssl.rejectUnauthorized,true); assert.equal('connectionString' in client.config,false);
    assert.ok(client.ends>=1); assert.ok(client.destroys>=1);
  }
  assert.equal(f.calls.queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(f.calls.queries[1],/statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '10s'/);
  assert.match(f.calls.queries[2],/repeat\('x', 524288\)/); assert.equal(f.calls.queries[3],'ROLLBACK');
  assert.match(f.calls.queries[2],/host\(inet_server_addr\(\)\) AS server_address/);
  assert.equal(f.calls.queries.length,4); assert.ok(f.calls.timers.every(ms=>ms<=24000));
  assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PASSWORD|postgresql:\/\//);
});

test('canonical pooler requires the source project user', async () => {
  const f=fixture({url:'postgres://postgres.vkkqffvmztpzgygzfxhq:FAKE@aws-1-us-west-2.pooler.supabase.com:6543/postgres'});
  assert.equal((await f.handler(f.request())).status,200);
  assert.equal(f.calls.clients[1].config.user,'postgres.vkkqffvmztpzgygzfxhq');
});

for (const url of [
  'postgres://postgres:FAKE@db.other.supabase.co:5432/postgres',
  'postgres://postgres.other:FAKE@aws-1-us-west-2.pooler.supabase.com:6543/postgres',
  'postgres://postgres:FAKE@127.0.0.1:5432/postgres',
  'postgres://postgres:FAKE@db.vkkqffvmztpzgygzfxhq.supabase.co:6543/postgres',
  'postgres://postgres:FAKE@db.vkkqffvmztpzgygzfxhq.supabase.co:5432/other',
]) test(`refuses unapproved database URL ${new URL(url).host}${new URL(url).pathname}`, async () => {
  const f=fixture({url}); const response=await f.handler(f.request());
  assert.equal(response.status,502); assert.deepEqual(await response.json(),{probe_protocol:'BRON_HTTPS_PROBE_V1',ok:false,stage:'configuration'});
  assert.equal(f.calls.dns.length,0); assert.equal(f.calls.clients.length,0);
});

test('wrong hostname accepted by TLS fails closed without real probe or SQL', async () => {
  const f=fixture({acceptBadHostname:true}); const response=await f.handler(f.request());
  assert.equal(response.status,502); assert.deepEqual(await response.json(),{probe_protocol:'BRON_HTTPS_PROBE_V1',ok:false,stage:'tls-negative'});
  assert.equal(f.calls.clients.length,1); assert.equal(f.calls.queries.length,0);
});

test('network failure is not reported as a successful TLS negative proof', async () => {
  for (const negativeError of ['connection timeout','TLS connection reset']) {
    const f=fixture({negativeError}); const response=await f.handler(f.request());
    assert.equal(response.status,502); assert.equal(f.calls.clients.length,1); assert.equal(f.calls.queries.length,0);
  }
});

test('actual read-only and repeatable-read invariants fail closed with cleanup', async () => {
  for (const identity of [{read_only:'off'},{isolation:'read committed'},{role:'anon'},{owner:'other'},
    {statement_timeout:'0'},{idle_timeout:'0'},{dummy:'x'}]) {
    const f=fixture({identity}); const response=await f.handler(f.request());
    assert.equal(response.status,502); assert.deepEqual(await response.json(),{probe_protocol:'BRON_HTTPS_PROBE_V1',ok:false,stage:'dummy'});
    assert.ok(f.calls.clients.every(c=>c.destroys>0&&c.ends>0));
  }
});

test('expiry after DNS never opens a database connection', async () => {
  const f=fixture({lookup:clock=>{clock.now=now+3600001; return {address:'192.0.2.123'};}});
  assert.equal((await f.handler(f.request())).status,502); assert.equal(f.calls.clients.length,0);
});

test('overall deadline aborts open streams; errors reveal only the fixed stage', async () => {
  const f=fixture({forceDeadline:10,connect:()=>new Promise(()=>{})});
  const response=await f.handler(f.request()); assert.equal(response.status,504);
  assert.deepEqual(await response.json(),{probe_protocol:'BRON_HTTPS_PROBE_V1',ok:false,stage:'deadline'});
  assert.ok(f.calls.clients.every(c=>c.destroys>0&&c.ends>0));
});

test('an aborted request cannot proceed from DNS to a database connection', async () => {
  const controller=new AbortController();
  const f=fixture({lookup:()=>{controller.abort(); return {address:'192.0.2.123'};}});
  const response=await f.handler(f.request(capability,{signal:controller.signal}));
  assert.equal(response.status,502); assert.equal(f.calls.clients.length,0);
});
