// Internal child of restore-native-capture.py; all fixture values stay inside the test.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';

async function main() {
  const repository=new URL('../../',import.meta.url);
  const {snapshotDatabase,fingerprintRows}=await import(new URL('scripts/migration-audit.mjs',repository));
  const {snapshotWithRelationCapture,safeRelationDiff}=await import(new URL('docs/runbooks/payloads/t11-restore-target.mjs',repository));
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
    const before=await snapshotWithRelationCapture(db,snapshotDatabase,fingerprintRows);
    await db.query('GRANT SELECT ON public.partner TO anon');
    await db.query('ALTER TABLE public.location ENABLE ROW LEVEL SECURITY');
    await db.query('ALTER TABLE public.location FORCE ROW LEVEL SECURITY');
    await db.query("CREATE OR REPLACE VIEW public.capture_view AS SELECT id,'fixture-secret-after'::text AS memo FROM public.partner");
    const after=await snapshotWithRelationCapture(db,snapshotDatabase,fingerprintRows);
    assert.notEqual(before.snapshot['schema:relations'].hash,after.snapshot['schema:relations'].hash);
    assert.equal(before.relations.length,before.snapshot['schema:relations'].count);
    assert.equal(after.relations.length,after.snapshot['schema:relations'].count);
    const diagnostic=safeRelationDiff(before.relations,after.relations);
    const partner=diagnostic.changed.find(x=>x.object==='public.partner');
    const location=diagnostic.changed.find(x=>x.object==='public.location');
    assert.ok(partner?.fields.includes('relacl'));
    assert.ok(partner.acl.addedEdges>0);
    assert.ok(partner.acl.restoredEntries>partner.acl.sourceEntries);
    assert.deepEqual([...location.fields].sort(),['relforcerowsecurity','relrowsecurity']);
    assert.ok(diagnostic.changed.some(x=>x.fields.includes('view_definition')));
    assert.equal(diagnostic.sourceOnlyObjects.length,0);
    assert.equal(diagnostic.restoredOnlyObjects.length,0);
    const output=JSON.stringify(diagnostic);
    for(const forbidden of ['fixture-secret-before','fixture-secret-after','SELECT id','"grantor"','"grantee"','"privilege"','"anon"'])
      assert.ok(!output.includes(forbidden));
    console.log(JSON.stringify({status:'PASS',scope:'NATIVE_PG17_AUDITOR_CAPTURE_ONLY',relations:before.relations.length,
      captureHashesMatchActualAuditor:true,aclChangeDetected:true,rlsFlagsDetected:true,viewChangeDetected:true,
      noSqlAclOrSecretValuesPrinted:true,diagnostic}));
  } finally {
    child.stdin.end('\\q\n');
    await closed;
  }
}

try{await main();}
catch{console.error(JSON.stringify({status:'FAIL',code:'NATIVE_CAPTURE_ASSERTION_OR_CONNECTION_FAILED'}));process.exitCode=1;}
