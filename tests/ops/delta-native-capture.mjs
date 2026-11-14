// Synthetic native preflight for the read-only T23 planner.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';

async function main() {
  const repository=new URL('../../',import.meta.url);
  const {snapshotDatabase,fingerprintRows}=await import(new URL('scripts/migration-audit.mjs',repository));
  const {captureInventory,diffRows,inventoryReport}=await import(new URL('docs/runbooks/payloads/t23-delta-readonly.mjs',repository));
  const audit=await import(new URL('scripts/migration-audit.mjs',repository));
  const cid=process.argv[2];
  assert.match(cid,/^[0-9a-f]{64}$/);
  const environment={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:process.argv[3]};
  const docker=process.argv[4];
  assert.ok(['/usr/local/bin/docker','/usr/bin/docker','/bin/docker'].includes(docker));
  const [container]=JSON.parse(execFileSync(docker,['--host','unix:///var/run/docker.sock','inspect',cid],{
    env:environment,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024,
  }));
  const marker=container.Config?.Labels?.['bron.test.native-pg17'];
  assert.match(marker??'',/^[0-9a-f]{32}$/);
  assert.equal(container.Name,'/bron-native-pg17-'+marker);
  assert.equal(container.HostConfig.NetworkMode,'none');
  assert.equal(Object.keys(container.HostConfig.PortBindings??{}).length,0);
  assert.ok(container.Mounts.every(m=>m.Type==='tmpfs'));
  const child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,
    'psql','-U','supabase_admin','-d','postgres','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{
    env:environment,stdio:['pipe','pipe','pipe'],
  });
  const lines=readline.createInterface({input:child.stdout});
  let pending=null;
  const abort=()=>{if(pending){pending.reject(new Error('NATIVE_CAPTURE_CONNECTION_FAILED'));pending=null;}};
  child.stderr.resume();
  child.stdin.on('error',abort);
  child.once('error',abort);
  const closed=new Promise(resolve=>child.once('close',()=>{abort();resolve();}));
  lines.on('line',line=>{
    if(!pending)return;
    if(line===pending.marker){
      const request=pending;pending=null;
      try{request.resolve({rows:request.isSelect?JSON.parse(request.lines.join('\n')):[]});}
      catch{request.reject(new Error('NATIVE_CAPTURE_RESPONSE_INVALID'));}
    }else if(line.trim())pending.lines.push(line);
  });
  // Keep a real, single native backend for the auditor's read-only transaction.
  const db={query:sql=>new Promise((resolve,reject)=>{
    assert.equal(pending,null);
    const isSelect=/^\s*select\b/i.test(sql),marker='DONE_'+randomUUID().replaceAll('-','');
    pending={resolve,reject,marker,isSelect,lines:[]};
    const statement=isSelect?`SELECT coalesce(json_agg(q),'[]'::json) FROM (${sql.replace(/;\s*$/,'')}) q`:sql;
    child.stdin.write(statement+';\n\\echo '+marker+'\n');
  })};
  try {
    let verified=0;
    const verify=async db=>{const result=await db.query("SELECT current_setting('transaction_read_only') AS mode,current_setting('transaction_isolation') AS isolation");assert.deepEqual(result.rows,[{mode:'on',isolation:'repeatable read'}]);verified++;};
    const before=await captureInventory(db,audit,verify);
    const directBefore=await snapshotDatabase(db);
    assert.deepEqual(before.snapshot,directBefore);
    for(const [object,table] of before.tables){assert.equal(table.rows.length,directBefore['data:'+object].count);assert.equal(fingerprintRows(table.rows.map(r=>r.value)),directBefore['data:'+object].hash);}
    const first=before.tables.get('public.daily_revenue').rows.find(r=>r.fields.period==='1');
    assert.equal(first.fields.huge,'9007199254740993');
    assert.equal(first.fields.amount,'1.00000000000000000001');
    assert.ok(first.fields.observed_at.includes('.000001'));
    assert.deepEqual(before.tables.get('public.daily_revenue').keys,['id','period']);
    await db.query("UPDATE public.daily_revenue SET huge=9007199254740992 WHERE period=1");
    await db.query("UPDATE public.daily_revenue SET amount=1.00000000000000000002 WHERE period=2");
    await db.query("UPDATE public.daily_revenue SET observed_at='2026-11-13T12:00:00.000002Z' WHERE period=3");
    await db.query("UPDATE public.daily_revenue SET period=5 WHERE period=4");
    await db.query("DELETE FROM public.unkeyed WHERE ctid=(SELECT ctid FROM public.unkeyed LIMIT 1)");
    const after=await captureInventory(db,audit,verify);
    const directAfter=await snapshotDatabase(db);
    assert.deepEqual(after.snapshot,directAfter);
    for(const [object,table] of after.tables){assert.equal(table.rows.length,directAfter['data:'+object].count);assert.equal(fingerprintRows(table.rows.map(r=>r.value)),directAfter['data:'+object].hash);}
    assert.equal(verified,2);
    const expected={sourceRows:4,targetRows:4,primaryKeyMatch:true,comparison:'primary-key',sourceOnlyRows:1,targetOnlyRows:1,changedMatchedRows:3,columns:[{name:'amount',rows:1},{name:'huge',rows:1},{name:'observed_at',rows:1}]};
    assert.deepEqual(diffRows(before.tables.get('public.daily_revenue'),after.tables.get('public.daily_revenue')),expected);
    const multiset=diffRows(before.tables.get('public.unkeyed'),after.tables.get('public.unkeyed'));
    assert.equal(multiset.comparison,'row-multiset');assert.equal(multiset.sourceOnlyRows,1);assert.equal(multiset.targetOnlyRows,0);
    const report=inventoryReport(before,after,audit),text=JSON.stringify(report);
    assert.equal(report.finalFreezeAudit,false);assert.equal(report.inventoryComplete,true);assert.equal(report.strictMatch,false);
    for(const value of ['9007199254740993','9007199254740992','1.00000000000000000001','1.00000000000000000002','00000000-0000-4000-8000-000000000001','PRIVATE_FIXTURE_VALUE','.000001','.000002',before.snapshot['data:public.daily_revenue'].hash])assert.ok(!text.includes(value));
    console.log(JSON.stringify({status:'PASS',scope:'NATIVE_PG17_T23_CAPTURE_AND_DIFF_SYNTHETIC_ONLY',serverVersion:(await db.query("SELECT current_setting('server_version') AS version")).rows[0].version,tables:before.tables.size,captureHashesAndCountsMatchUnchangedAuditor:true,actualReadOnlyRepeatableReadVerified:true,uuidCompositePrimaryKeyVerified:true,bigintDecimalMicrosecondDiffsVerified:true,duplicateAwareMultisetVerified:true,noRowValuesOrFingerprintsPrinted:true,finalFreezeAudit:false,difference:expected}));
  } finally {
    child.stdin.end('\\q\n');
    await closed;
  }
}
try{await main();}catch{console.error(JSON.stringify({status:'FAIL',code:'NATIVE_T23_ASSERTION_OR_CONNECTION_FAILED'}));process.exitCode=1;}
