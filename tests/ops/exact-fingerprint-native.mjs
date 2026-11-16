// Synthetic native PG17 + real pg driver. Never reads an external database.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import pg from '../../node_modules/pg/lib/index.js';
import { snapshotDatabase, fingerprintRows, compareSnapshots } from '../../scripts/migration-audit.mjs';
import { exactQueryFingerprint } from '../../docs/runbooks/payloads/exact-query-fingerprint.mjs';
let phase = 'setup';
async function main() {
  assert.equal(process.argv.length, 5);
  const [cid, configuration, docker] = process.argv.slice(2);
  assert.match(cid, /^[0-9a-f]{64}$/);
  assert.ok(['/usr/local/bin/docker', '/usr/bin/docker', '/bin/docker'].includes(docker));
  const environment = {PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:configuration};
  const [container] = JSON.parse(execFileSync(docker,
    ['--host','unix:///var/run/docker.sock','inspect',cid],
    {env:environment,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024}));
  const marker = container.Config?.Labels?.['bron.test.native-pg17'];
  assert.match(marker ?? '', /^[0-9a-f]{32}$/);
  assert.equal(container.Name, '/bron-native-pg17-' + marker);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0);
  assert.ok(container.Mounts.every(m => m.Type === 'tmpfs'));
  assert.equal(JSON.parse(readFileSync(new URL('../../node_modules/pg/package.json',import.meta.url),'utf8')).version,'8.23.1');
  class PgPipe extends Duplex {
    constructor() {
      super();this.child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,'nc','127.0.0.1','5432'],
        {env:environment,stdio:['pipe','pipe','pipe']});
      this.child.stdout.on('data',bytes=>{if(!this.push(bytes))this.child.stdout.pause();});
      this.child.stdout.on('end',()=>this.push(null));this.child.stderr.resume();
      this.child.on('error',error=>this.destroy(error));this.child.stdin.on('error',error=>this.destroy(error));
    }
    connect(){queueMicrotask(()=>this.emit('connect'));return this;}
    setNoDelay(){} setKeepAlive(){} ref(){} unref(){}
    _read(){this.child.stdout.resume();}
    _write(bytes,encoding,callback){this.child.stdin.write(bytes,encoding,callback);}
    _final(callback){this.child.stdin.end(callback);}
    _destroy(error,callback){this.child.kill();callback(error);}
  }
  const client=(user,readOnly)=>new pg.Client({stream:()=>new PgPipe(),user,database:'postgres',ssl:false,
    query_timeout:15000,options:`-c default_transaction_read_only=${readOnly?'on':'off'} -c statement_timeout=12000`});
  const reader=client('postgres',true),writer=client('supabase_admin',false);
  reader.on('error',()=>{});writer.on('error',()=>{});
  let fastGroups=0,actualReadOnlyChecks=0;
  const fast=async(db,sql)=>{
    const value=await exactQueryFingerprint(db,sql);fastGroups++;
    const context=(await db.query("select current_setting('transaction_read_only') as mode,current_setting('transaction_isolation') as isolation")).rows[0];
    assert.deepEqual(context,{mode:'on',isolation:'repeatable read'});actualReadOnlyChecks++;return value;
  };
  const sameSnapshotFingerprint=async(sql,limits)=>{
    await reader.query('begin isolation level repeatable read read only');
    try {
      await reader.query("set local timezone='UTC'");await reader.query('set local search_path=pg_catalog');
      const expected=(await reader.query(sql)).rows.map(r=>r.value);
      const actual=await exactQueryFingerprint(reader,sql,limits);
      assert.deepEqual(actual,{count:expected.length,hash:fingerprintRows(expected)});
      return {actual,expected};
    } finally {await reader.query('rollback');}
  };
  const sql='select to_jsonb(t)::text as value from public.hash_fixture t order by to_jsonb(t)::text collate "C"';
  try {
    await reader.connect();await writer.connect();
    const version=(await reader.query("select current_setting('server_version') as version")).rows[0].version;
    assert.match(version,/^17\./);
    phase='all-snapshot-groups';
    const ordinary=await snapshotDatabase(reader),compact=await snapshotDatabase(reader,{fingerprintQuery:fast});
    assert.deepEqual(compact,ordinary);assert.deepEqual(compareSnapshots(ordinary,compact),[]);
    const groups=Object.keys(ordinary),schemaGroups=groups.filter(k=>k.startsWith('schema:'));
    assert.equal(schemaGroups.length,15);assert.equal(groups.filter(k=>k.startsWith('sequence:')).length,2);
    for (const key of ['schema:relations','schema:columns','schema:policies','schema:storage_policies','schema:storage_grants',
      'schema:triggers','schema:constraints','schema:indexes','schema:routines','schema:enums','schema:default_grants',
      'schema:role_memberships','schema:extensions']) assert.ok(ordinary[key].count>0);
    assert.equal(ordinary['data:public.hash_empty'].count,0);assert.equal(ordinary['data:public.hash_fixture'].count,3002);
    assert.equal(fastGroups,groups.length-2);
    phase='before-commit-same-snapshot-auth';
    const authCaptureSql=`SELECT id::text AS private_id,updated_at::text AS private_stamp,
      (extract(epoch FROM updated_at)*1000000)::numeric(30,0)::text AS private_micros,
      encode(pg_catalog.sha256(convert_to((to_jsonb(u)-'updated_at')::text,'UTF8')),'hex') AS private_other
      FROM auth.users u ORDER BY id LIMIT 17`;
    const beforeAuth=(await reader.query(authCaptureSql)).rows;
    let hookCalls=0;
    const sameAuthSnapshot=await snapshotDatabase(reader,{fingerprintQuery:fast,beforeCommit:async db=>{
      hookCalls++;assert.equal(db,reader);
      const context=(await db.query("select current_setting('transaction_read_only') as mode,current_setting('transaction_isolation') as isolation")).rows[0];
      assert.deepEqual(context,{mode:'on',isolation:'repeatable read'});
      await writer.query("update auth.users set updated_at=updated_at+interval '0.000001 second'");
      const captured=(await db.query(authCaptureSql)).rows;
      const concurrent=(await writer.query(authCaptureSql)).rows;
      assert.deepEqual(captured,beforeAuth);
      assert.equal(concurrent.length,1);
      assert.equal(BigInt(concurrent[0].private_micros),BigInt(beforeAuth[0].private_micros)+1n);
      assert.equal(concurrent[0].private_other,beforeAuth[0].private_other);
    }});
    assert.equal(hookCalls,1);assert.deepEqual(sameAuthSnapshot,ordinary);
    assert.equal(BigInt((await reader.query(authCaptureSql)).rows[0].private_micros),BigInt(beforeAuth[0].private_micros)+1n);
    await writer.query('update auth.users set updated_at=$1::timestamptz',[beforeAuth[0].private_stamp]);
    assert.deepEqual(compareSnapshots(ordinary,await snapshotDatabase(reader,{fingerprintQuery:fast})),[]);
    phase='before-commit-failure-rolls-back';
    const hookFailure=Object.assign(new Error('SYNTHETIC_HOOK_FAILURE'),{code:'SYNTHETIC_HOOK_FAILURE'});
    await assert.rejects(snapshotDatabase(reader,{fingerprintQuery:fast,beforeCommit:async()=>{throw hookFailure;}}),error=>error===hookFailure);
    const outside=(await reader.query("select current_setting('transaction_isolation') as isolation")).rows[0];
    assert.equal(outside.isolation,'read committed');
    assert.deepEqual(compareSnapshots(ordinary,await snapshotDatabase(reader,{fingerprintQuery:fast})),[]);
    phase='same-transaction-rich-canonical';
    const base=await sameSnapshotFingerprint(sql);
    assert.ok(base.expected.some(row=>row.includes('9007199254740993')));
    assert.ok(base.expected.some(row=>row.includes('9007199254740994')));
    assert.ok(base.expected.some(row=>row.includes('1.00000000000000000001')));
    assert.ok(base.expected.some(row=>row.includes('1.00000000000000000002')));
    assert.ok(base.expected.some(row=>row.includes('.000001')));
    assert.ok(base.expected.some(row=>row.includes('\\n')&&row.includes('\\r')&&row.includes('\\t')));
    assert.ok(base.expected.some(row=>Buffer.byteLength(row)!==row.length));
    assert.ok(base.expected.length>new Set(base.expected).size);
    const empty=await sameSnapshotFingerprint('select to_jsonb(t)::text as value from public.hash_empty t order by to_jsonb(t)::text collate "C"');
    assert.equal(empty.actual.count,0);
    phase='data-mutation-red-green';
    await writer.query("update public.hash_fixture set amount=1.00000000000000000003 where id='00000000-0000-4000-8000-000000000001'");
    const dataChanged=await snapshotDatabase(reader,{fingerprintQuery:fast});
    assert.deepEqual(compareSnapshots(ordinary,dataChanged),['data:public.hash_fixture']);
    await writer.query("update public.hash_fixture set amount=1.00000000000000000002 where id='00000000-0000-4000-8000-000000000001'");
    assert.deepEqual((await sameSnapshotFingerprint(sql)).actual,base.actual);
    phase='acl-mutation-red-green';
    await writer.query('revoke usage on sequence app_private.procurement_event_id_seq from anon');
    const aclChanged=await snapshotDatabase(reader,{fingerprintQuery:fast});
    assert.deepEqual(compareSnapshots(ordinary,aclChanged),['schema:relations']);
    await writer.query('grant usage on sequence app_private.procurement_event_id_seq to anon');
    assert.deepEqual(compareSnapshots(ordinary,await snapshotDatabase(reader,{fingerprintQuery:fast})),[]);
    phase='duplicates-red-green';
    await writer.query("delete from public.hash_fixture where ctid=(select ctid from public.hash_fixture where id='00000000-0000-4000-8000-000000000001' limit 1)");
    const dedup=await sameSnapshotFingerprint(sql);assert.equal(dedup.actual.count,3001);assert.notEqual(dedup.actual.hash,base.actual.hash);
    await writer.query("insert into public.hash_fixture select * from public.hash_fixture where id='00000000-0000-4000-8000-000000000001' limit 1");
    assert.deepEqual((await sameSnapshotFingerprint(sql)).actual,base.actual);
    phase='native-limits-before-aggregate';
    await reader.query('begin isolation level repeatable read read only');
    try {
      await reader.query("set local timezone='UTC'");await reader.query('set local search_path=pg_catalog');
      let aggregateCalls=0;
      const observed={query:text=>{if(text.includes('pg_catalog.sha256('))aggregateCalls++;return reader.query(text);}};
      await assert.rejects(exactQueryFingerprint(observed,sql,{maxRows:3001}),{code:'EXACT_FINGERPRINT_ROW_LIMIT'});
      await assert.rejects(exactQueryFingerprint(observed,sql,{maxFramedBytes:1024}),{code:'EXACT_FINGERPRINT_BYTE_LIMIT'});
      await assert.rejects(exactQueryFingerprint(observed,'select null::text as value'),{code:'EXACT_FINGERPRINT_NULL_VALUE'});
      assert.equal(aggregateCalls,0);
    } finally {await reader.query('rollback');}
    console.log(JSON.stringify({status:'PASS',scope:'SYNTHETIC_NATIVE_FULL_EXACT_AUDIT',serverVersion:version,driver:'pg 8.23.1',
      groups:groups.length,schemaGroups:schemaGroups.length,dataGroups:groups.length-schemaGroups.length-2,sequenceGroups:2,
      richRows:base.actual.count,allSnapshotGroupsExact:true,sameTransactionRichFingerprint:true,actualReadOnlyRepeatableReadChecks:actualReadOnlyChecks,
      dataMutationRedGreen:true,sequenceAclMutationRedGreen:true,duplicateMutationRedGreen:true,
      beforeCommitAuthSameSnapshotUnderConcurrentUpdate:true,beforeCommitFailureRollback:true,
      emptyUnicodeUuidBigintDecimalMicrosecondsControlsNull:true,boundsBeforeAggregate:true,noRowsOrHashesPrinted:true}));
  } finally {await Promise.allSettled([reader.end(),writer.end()]);}
}
try {await main();} catch {console.error(JSON.stringify({status:'FAIL',code:'EXACT_NATIVE_FAILED',phase}));process.exitCode=1;}
