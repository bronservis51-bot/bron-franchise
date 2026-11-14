// Real PostgreSQL wire protocol against a strictly owned synthetic fixture.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import pg from '../../node_modules/pg/lib/index.js';
import {makeHttpAdmissionPlan,beforeImageSql,afterDrainBoundarySql,freshOwnerWitnessSql,
  validateFreshOwnerWitness} from '../../docs/runbooks/payloads/http-source-admission.mjs';

async function main(){
  assert.equal(process.argv.length,5);
  assert.equal(JSON.parse(readFileSync(new URL('../../node_modules/pg/package.json',import.meta.url),'utf8')).version,'8.23.1');
  const [cid,configuration,docker]=process.argv.slice(2);
  assert.match(cid,/^[0-9a-f]{64}$/);
  assert.ok(['/usr/local/bin/docker','/usr/bin/docker','/bin/docker'].includes(docker));
  const environment={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:configuration};
  const [container]=JSON.parse(execFileSync(docker,['--host','unix:///var/run/docker.sock','inspect',cid],{
    env:environment,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024}));
  const marker=container.Config?.Labels?.['bron.test.native-pg17'];
  assert.match(marker??'',/^[0-9a-f]{32}$/);assert.equal(container.Name,'/bron-native-pg17-'+marker);
  assert.equal(container.HostConfig.NetworkMode,'none');assert.equal(Object.keys(container.HostConfig.PortBindings??{}).length,0);
  assert.ok(container.Mounts.every(m=>m.Type==='tmpfs'));
  class PgPipe extends Duplex{
    constructor(){
      super();this.child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,'nc','127.0.0.1','5432'],{env:environment,stdio:['pipe','pipe','pipe']});
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
  const clients=[];
  const open=async(user='postgres',app='bron-http-test')=>{
    const client=new pg.Client({stream:()=>new PgPipe(),user,database:'postgres',ssl:false,
      application_name:user==='supabase_admin'?'postgres_exporter':app,query_timeout:6000,
      options:'-c statement_timeout=5000'});
    client.on('error',()=>{});clients.push(client);await client.connect();return client;
  };
  const request=async(sql,app='bron-http-request')=>{
    const client=await open('postgres',app);
    try{return await client.query(sql);}finally{await client.end();}
  };
  const code=async(promise,expected)=>{
    await assert.rejects(promise,error=>error.code==='P0001'&&error.message===expected);
  };
  const activation={reviewed:true,actionId:'T99.http_source_admission',manifestSha256:'a'.repeat(64),
    beforeImageSha256:'b'.repeat(64),beforeImageDurableOnVps:true,providerBoundaryReviewed:true,
    independentKeyProved:true,rollbackBeforeTargetWrites:true,targetWritesStarted:false};
  try{
    const admin=await open('supabase_admin');
    const version=(await admin.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    assert.match(version,/^17\./);assert.equal(pg.defaults.parseInt8,undefined);
    const before=(await request(beforeImageSql)).rows[0].state;
    assert.equal(before.runJobsExists,false);assert.equal(before.unexpectedActiveCron,0);
    assert.equal(before.lookupOtherSetRoles,0);
    const plan=makeHttpAdmissionPlan({activation,before});
    // Only the historical no-argument command and the observed literal are
    // covered when the function is absent; close SQL neighbors stay refused.
    const actualCron="select app_private.run_jobs('cron');";
    await admin.query('UPDATE cron.job SET command=$1',['SELECT app_private.run_jobs();']);
    const historical=(await request(beforeImageSql)).rows[0].state;
    assert.equal(historical.unexpectedActiveCron,0);makeHttpAdmissionPlan({activation,before:historical});
    const cronMutations=[
      ["select app_private.run_jobs('manual');",'bron-jobs','postgres'],
      ["select app_private.run_jobs('CRON');",'bron-jobs','postgres'],
      ["select app_private.run_jobs('Cron');",'bron-jobs','postgres'],
      [actualCron+' SELECT 1;','bron-jobs','postgres'],
      [actualCron,'other-jobs','postgres'],
      [actualCron,'bron-jobs','authenticator']
    ];
    for(const mutation of cronMutations){
      await admin.query('UPDATE cron.job SET command=$1,jobname=$2,username=$3',mutation);
      const unsafeCron=(await request(beforeImageSql)).rows[0].state;
      assert.equal(unsafeCron.unexpectedActiveCron,1);
      assert.throws(()=>makeHttpAdmissionPlan({activation,before:unsafeCron}),{code:'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND'});
      await code(request(plan.applySql),'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND');
    }
    await admin.query('UPDATE cron.job SET command=$1,jobname=$2,username=$3',[actualCron,'bron-jobs','postgres']);
    await admin.query("CREATE FUNCTION app_private.run_jobs(text) RETURNS void LANGUAGE plpgsql AS 'BEGIN RETURN; END'");
    const callableCron=(await request(beforeImageSql)).rows[0].state;
    assert.equal(callableCron.runJobsExists,true);assert.equal(callableCron.unexpectedActiveCron,0);
    assert.throws(()=>makeHttpAdmissionPlan({activation,before:callableCron}),{code:'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND'});
    await code(request(plan.applySql),'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND');
    await admin.query('DROP FUNCTION app_private.run_jobs(text)');
    // NOINHERIT hides effective table privileges while SET ROLE still reaches
    // a product writer. Admission must refuse this separate role capability.
    const grantLookupSetRole='GRANT service_role TO pgbouncer WITH INHERIT FALSE, SET TRUE';
    await admin.query(grantLookupSetRole);
    const escape=(await admin.query("SELECT pg_has_role('pgbouncer','service_role','USAGE') AS inherited, pg_has_role('pgbouncer','service_role','SET') AS settable, has_table_privilege('pgbouncer','app_private.admission_probe','INSERT') AS direct_write")).rows[0];
    assert.deepEqual(escape,{inherited:false,settable:true,direct_write:false});
    const escapedLookup=await open('pgbouncer');await escapedLookup.query('SET ROLE service_role');
    assert.equal((await escapedLookup.query('SELECT current_user AS role')).rows[0].role,'service_role');
    await escapedLookup.end();
    const unsafeBefore=(await request(beforeImageSql)).rows[0].state;
    assert.equal(unsafeBefore.lookupOtherSetRoles,1);assert.equal(unsafeBefore.lookupCriticalWrites,0);
    assert.throws(()=>makeHttpAdmissionPlan({activation,before:unsafeBefore}),{code:'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND'});
    await code(request(plan.applySql),'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND');
    await request(plan.verifyOriginalSql);
    await admin.query('REVOKE service_role FROM pgbouncer');
    const oldOwner=await open(),heldApi=await open('authenticator');
    const oldWitness=(await oldOwner.query('BEGIN READ ONLY').then(()=>oldOwner.query(freshOwnerWitnessSql))).rows[0].witness;
    await oldOwner.query('ROLLBACK');
    await request(plan.applySql);
    await admin.query(grantLookupSetRole);
    await code(request(plan.verifyFencedSql),'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND');
    await code(request(plan.drainSql),'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND');
    await admin.query('REVOKE service_role FROM pgbouncer');
    await request(plan.drainSql); // also terminates all pre-existing owner backends
    // Simulate a legitimate pool refill between drain completion and the
    // coordinator's later timestamp observation. Keep its readonly transaction
    // pinned; a single second client must obtain another physical backend.
    const early=await open();await early.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const earlyWitness=(await early.query(freshOwnerWitnessSql)).rows[0].witness;
    const boundary=(await request(afterDrainBoundarySql)).rows[0].boundary;
    assert.throws(()=>validateFreshOwnerWitness({before,boundary,witness:earlyWitness}),{code:'HTTP_ADMISSION_FRESH_PHYSICAL_BACKEND_NOT_PROVED'});
    assert.throws(()=>validateFreshOwnerWitness({before,boundary,witness:oldWitness}),{code:'HTTP_ADMISSION_FRESH_PHYSICAL_BACKEND_NOT_PROVED'});
    const fresh=await open();await fresh.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const witness=(await fresh.query(freshOwnerWitnessSql)).rows[0].witness;
    assert.equal(validateFreshOwnerWitness({before,boundary,witness}).newPhysicalBackendAfterDrain,true);
    await request(plan.verifyFencedSql);
    const pinned=(await fresh.query(freshOwnerWitnessSql)).rows[0].witness;
    assert.equal(pinned.pid,witness.pid);assert.equal(pinned.backendStartMicros,witness.backendStartMicros);
    assert.equal(pinned.readOnly,'on');assert.equal(pinned.isolation,'repeatable read');
    await fresh.query('ROLLBACK');await fresh.end();await early.query('ROLLBACK');await early.end();
    await request(plan.verifyFencedSql); // proof survives closing both candidates
    const lookup=await open('pgbouncer');
    assert.equal((await lookup.query('SELECT current_user AS role')).rows[0].role,'pgbouncer');await lookup.end();
    let denied=false;try{await open('authenticator');}catch(error){denied=error.code==='42501';}assert.equal(denied,true);
    await request(plan.inverseSql);await request(plan.verifyOriginalSql);

    // Real commit succeeded but HTTP response was lost to the coordinator.
    let lost=false;try{await request(plan.applySql);throw new Error('SYNTHETIC_RESPONSE_LOST');}catch(error){assert.equal(error.message,'SYNTHETIC_RESPONSE_LOST');lost=true;}
    // Separate request, independent physical owner backend; no prior PID assumption.
    await request(plan.inverseSql);await request(plan.verifyOriginalSql);

    // Deliberately hold the actual exported DO's effect and transaction lock
    // inside an uncommitted owner transaction. This models the HTTP service's
    // unknown in-flight transaction, while normal cases above use implicit DO.
    // A concurrent inverse must NOT interpret the still-original visible ACL
    // as recovery: it must refuse until this transaction commits or aborts.
    const applyClient=await open('postgres','bron-http-racing-apply');
    await applyClient.query('BEGIN');await applyClient.query(plan.applySql);
    await code(request(plan.inverseSql),'HTTP_ADMISSION_OPERATION_IN_FLIGHT');
    await code(request(plan.verifyOriginalSql),'HTTP_ADMISSION_OPERATION_IN_FLIGHT');
    await applyClient.query('COMMIT');await applyClient.end();
    await request(plan.inverseSql);await request(plan.verifyOriginalSql);

    // Unreviewed ACL drift is refused, never overwritten by the exact inverse.
    await request('GRANT CONNECT ON DATABASE postgres TO anon');
    await code(request(plan.inverseSql),'HTTP_ADMISSION_FENCED_ACL_MISMATCH');
    await request('REVOKE CONNECT ON DATABASE postgres FROM anon');await request(plan.verifyOriginalSql);
    // A transaction snapshot older than lock acquisition is not accepted.
    const stale=await open();await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await code(stale.query(plan.verifyOriginalSql),'HTTP_ADMISSION_ISOLATION');await stale.query('ROLLBACK');await stale.end();
    console.log(JSON.stringify({status:'PASS',serverVersion:version,driver:'pg8.23.1',
      normalFenceDrainFreshPhysicalBackend:true,oldBackendWitnessRejected:true,ordinaryNewConnectDenied:true,
      actualCronLiteralAcceptedWithFunctionAbsent:true,noinheritLookupSetRoleBeforeRejected:true,
      historicalNoargCronAccepted:true,otherCronLiteralRejected:true,extraCronStatementRejected:true,
      wrongCronJobOrUserRejected:true,presentRunJobsFunctionRejected:true,
      noinheritLookupCanSetWriterWithoutInheritedPrivileges:true,
      noinheritLookupSetRoleApplyRejected:true,noinheritLookupSetRoleAfterFenceRejected:true,
      boundedSecondCandidate:true,pinnedReadonlyBackend:true,
      lookupConnectPreserved:true,lostCommittedResponseInverse:lost,inFlightInverseRefused:true,
      independentRequestReconciliation:true,exactOriginalAclRestored:true,aclDriftRefused:true,
      repeatableReadRejected:true,actualSupavisorRecovery:'NOT_TESTED',sourceOrVpsChanges:false}));
  }finally{
    await Promise.allSettled(clients.map(async client=>{client.connection?.stream?.destroy();try{await client.end();}catch{}}));
  }
}
try{await main();}catch{console.error(JSON.stringify({status:'FAIL',code:'HTTP_ADMISSION_NATIVE_FAILED'}));process.exitCode=1;}
