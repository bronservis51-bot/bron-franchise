// Internal synthetic native preflight: real node-pg protocol/OIDs, no psql JSON bridge.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import pg from '../../node_modules/pg/lib/index.js';
import {readFileSync} from 'node:fs';
import {captureInventory,inventoryReport,observeQueries,safeFailure} from '../../docs/runbooks/payloads/t23-delta-readonly.mjs';
import * as audit from '../../scripts/migration-audit.mjs';

async function main(){
  assert.equal(process.argv.length,5);
  const [cid,configuration,docker]=process.argv.slice(2);
  assert.match(cid,/^[0-9a-f]{64}$/);
  assert.ok(['/usr/local/bin/docker','/usr/bin/docker','/bin/docker'].includes(docker));
  const environment={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:configuration};
  const [container]=JSON.parse(execFileSync(docker,['--host','unix:///var/run/docker.sock','inspect',cid],{
    env:environment,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024}));
  const marker=container.Config?.Labels?.['bron.test.native-pg17'];
  assert.match(marker??'',/^[0-9a-f]{32}$/);
  assert.equal(container.Name,'/bron-native-pg17-'+marker);
  assert.equal(container.HostConfig.NetworkMode,'none');
  assert.equal(Object.keys(container.HostConfig.PortBindings??{}).length,0);
  assert.ok(container.Mounts.every(m=>m.Type==='tmpfs'));
  assert.equal(JSON.parse(readFileSync(new URL('../../node_modules/pg/package.json',import.meta.url),'utf8')).version,'8.23.1');

  // Only bytes travel through Docker stdio. pg itself parses actual PostgreSQL OIDs.
  // nc connects to the owned container's loopback; no host binding/network is created.
  class PgPipe extends Duplex{
    constructor(){
      super();this.child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,'nc','127.0.0.1','5432'],{
        env:environment,stdio:['pipe','pipe','pipe']});
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
  const client=(user,readOnly=true,queryTimeout=5000)=>new pg.Client({stream:()=>new PgPipe(),
    user,database:'postgres',ssl:false,query_timeout:queryTimeout,
    options:`-c default_transaction_read_only=${readOnly?'on':'off'} -c statement_timeout=3000`});
  const reader=client('postgres'),writer=client('supabase_admin',false),timeoutReader=client('postgres',true,40);
  reader.on('error',()=>{});writer.on('error',()=>{});timeoutReader.on('error',()=>{});
  try{
    await reader.connect();await writer.connect();await timeoutReader.connect();
    const version=(await reader.query("select current_setting('server_version') as version")).rows[0].version;
    assert.match(version,/^17\./);
    const probe=(await reader.query(`select array_agg(a.attname order by a.attnum) as names,
      array_agg(a.attname::text order by a.attnum) as texts from pg_attribute a
      where a.attrelid='public.daily_revenue'::regclass and a.attnum>0 and not a.attisdropped`)).rows[0];
    assert.equal(typeof probe.names,'string');assert.ok(Array.isArray(probe.texts));
    let identityChecks=0;
    const verify=async db=>{
      const actual=(await db.query(`SELECT current_database() AS db,current_user AS role,
        current_setting('transaction_read_only') AS mode,current_setting('transaction_isolation') AS isolation,
        host(inet_server_addr()) AS address,inet_server_port() AS port`)).rows[0];
      assert.deepEqual(actual,{db:'postgres',role:'postgres',mode:'on',isolation:'repeatable read',address:'127.0.0.1',port:5432});
      identityChecks++;
    };
    const sourceContext={},targetContext={};
    const source=await captureInventory(observeQueries(reader,'source',sourceContext),audit,verify);
    assert.deepEqual(source.snapshot,await audit.snapshotDatabase(reader));
    assert.deepEqual(source.tables.get('public.daily_revenue').keys,['id','period']);
    const first=source.tables.get('public.daily_revenue').rows.find(row=>row.fields.period==='1');
    assert.equal(first.fields.huge,'9007199254740993');
    assert.equal(first.fields.amount,'1.00000000000000000001');
    assert.ok(first.fields.observed_at.includes('.000001'));
    for(const [object,table] of source.tables){
      assert.equal(table.rows.length,source.snapshot['data:'+object].count);
      assert.equal(audit.fingerprintRows(table.rows.map(row=>row.value)),source.snapshot['data:'+object].hash);
    }
    await writer.query('UPDATE public.daily_revenue SET huge=9007199254740992 WHERE period=1');
    await writer.query('UPDATE public.daily_revenue SET amount=1.00000000000000000002 WHERE period=2');
    await writer.query("UPDATE public.daily_revenue SET observed_at='2026-11-13T12:00:00.000002Z' WHERE period=3");
    await writer.query('UPDATE public.daily_revenue SET period=5 WHERE period=4');
    await writer.query('DELETE FROM public.unkeyed WHERE ctid=(SELECT ctid FROM public.unkeyed LIMIT 1)');
    const target=await captureInventory(observeQueries(reader,'target',targetContext),audit,verify);
    assert.deepEqual(target.snapshot,await audit.snapshotDatabase(reader));
    const report=inventoryReport(source,target,audit);
    assert.equal(report.inventoryComplete,true);assert.equal(report.finalFreezeAudit,false);assert.equal(report.strictMatch,false);
    const difference=report.tables.find(row=>row.object==='public.daily_revenue');
    assert.deepEqual(difference,{object:'public.daily_revenue',strictMatch:false,sourceRows:4,targetRows:4,
      primaryKeyMatch:true,comparison:'primary-key',sourceOnlyRows:1,targetOnlyRows:1,changedMatchedRows:3,
      columns:[{name:'amount',rows:1},{name:'huge',rows:1},{name:'observed_at',rows:1}]});
    const unkeyed=report.tables.find(row=>row.object==='public.unkeyed');
    assert.equal(unkeyed.comparison,'row-multiset');assert.equal(unkeyed.sourceOnlyRows,1);assert.equal(unkeyed.targetOnlyRows,0);
    assert.equal(identityChecks,2);assert.equal(sourceContext.last.operation,'commit');assert.equal(targetContext.last.operation,'commit');
    assert.equal(sourceContext.failure,undefined);assert.equal(targetContext.failure,undefined);
    const printed=JSON.stringify(report);
    for(const value of ['PRIVATE_FIXTURE_VALUE','9007199254740993','9007199254740992','1.00000000000000000001',
      '1.00000000000000000002','00000000-0000-4000-8000-000000000001','.000001','.000002',source.snapshot['data:public.daily_revenue'].hash])
      assert.ok(!printed.includes(value));

    // Exercise a real driver's code-less read timeout, then ensure rollback cannot erase its context.
    const failureContext={},observedTimeout=observeQueries(timeoutReader,'source',failureContext);
    await assert.rejects(observedTimeout.query('SELECT pg_sleep(0.15)'),error=>{
      assert.equal(error.code,undefined);assert.deepEqual(safeFailure(error),{code:'PG_QUERY_READ_TIMEOUT'});return true;
    });
    const failedOrdinal=failureContext.failure.ordinal;
    await new Promise(resolve=>setTimeout(resolve,200));
    await observedTimeout.query('ROLLBACK');
    assert.equal(failureContext.last.operation,'rollback');
    assert.equal(failureContext.failure.ordinal,failedOrdinal);
    assert.equal(failureContext.failure.operation,'metadata');
    assert.equal(failureContext.failure.code,'PG_QUERY_READ_TIMEOUT');
    assert.equal(Object.hasOwn(failureContext.failure,'message'),false);
    console.log(JSON.stringify({status:'PASS',scope:'REAL_PG_DRIVER_T24_SYNTHETIC_ONLY',serverVersion:version,driver:'pg 8.23.1',
      tables:source.tables.size,rawNameArrayIsString:true,fixedTextArrayIsArray:true,unchangedAuditorCaptureExact:true,
      actualReadOnlyRepeatableReadIdentityVerified:true,losslessDifferenceVerified:true,duplicateAwareMultisetVerified:true,
      realDriverCodelessTimeoutClassified:true,rollbackPreservesFailureContext:true,noRowValuesOrFingerprintsPrinted:true,
      inventoryComplete:true,finalFreezeAudit:false}));
  }finally{await Promise.allSettled([reader.end(),writer.end(),timeoutReader.end()]);}
}
try{await main();}catch{console.error(JSON.stringify({status:'FAIL',code:'NATIVE_DRIVER_PREFLIGHT_FAILED'}));process.exitCode=1;}
