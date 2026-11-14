import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {SyntheticOutputParser,stages,syntheticSql,pgpassField,credentialFiles,validateManifest,clientArgs,ownedContainer,runSyntheticClient,privateWrite,unsetPgEnvironment} from '../../docs/runbooks/payloads/source-libpq-probe.mjs';
const HOST='aws-1-us-west-2.pooler.supabase.com',peer={canonicalHost:HOST,address:'35.163.12.34',resolvedAddresses:['35.163.12.34']};
const source={host:HOST,port:5432,database:'postgres',user:'postgres.vkkqffvmztpzgygzfxhq',password:async()=>'',
 ssl:{ca:'SYNTHETIC_CA',rejectUnauthorized:true,servername:HOST,checkServerIdentity:()=>{}}};
const output=({ssl=true}={})=>Buffer.from('You are connected to database "postgres" as user "postgres".\n'+
 (ssl?'SSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off, ALPN: none)\n':'')+
 'LP:identity\nidentity|t|t|t|t|t|t\n'+stages.map(s=>'LP:'+s.name+'\n'+('x'.repeat(s.bytes)+'\n').repeat(s.rows)).join('')+'LP:complete\n');
const parse=b=>{const p=new SyntheticOutputParser();p.push(b);return p.finish();};
const nonce='1'.repeat(32),name='bron-libpq-'+nonce,image='sha256:'+'2'.repeat(64),directory='/root/bron-secrets/libpq-Ab12Cd';
test('import and no-argument CLI cannot activate source factory, shell, or filesystem effects',()=>{
 const imported=spawnSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';for(const k of ['writeFileSync','mkdtempSync','rmSync','chmodSync'])fs[k]=()=>{throw Error('EFFECT')};for(const k of ['spawn','execFileSync'])cp[k]=()=>{throw Error('EFFECT')};syncBuiltinESMExports();await import('./docs/runbooks/payloads/source-libpq-probe.mjs')`],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout,'');
 const noargs=spawnSync(process.execPath,['docs/runbooks/payloads/source-libpq-probe.mjs'],{encoding:'utf8'});
 assert.equal(noargs.status,2);assert.match(noargs.stdout,/LIBPQ_EXPLICIT_REVIEW_REQUIRED/);assert.equal(noargs.stderr,'');
});
test('only exact reviewed manifest bytes, helper SHA, expiry and schema activate',()=>{
 const self='3'.repeat(64),m={task:'SOURCE_LIBPQ_SYNTHETIC_V1',...peer,helperSha256:self,targetImage:image,expiresUtc:new Date(Date.now()+3600000).toISOString()};
 const validate=(value,expected,selfHash=self)=>{const b=Buffer.from(JSON.stringify(value));return validateManifest(b,expected??createHash('sha256').update(b).digest('hex'),selfHash);};
 assert.deepEqual(validate(m),m);assert.throws(()=>validate(m,'0'.repeat(64)),{code:'LIBPQ_MANIFEST_SHA'});
 for(const patch of [{task:'other'},{helperSha256:'4'.repeat(64)},{canonicalHost:'evil.invalid'},{targetImage:'postgres:17'},
  {expiresUtc:'never'},{expiresUtc:new Date(Date.now()-1).toISOString()},{expiresUtc:new Date(Date.now()+172800000).toISOString()},
  {resolvedAddresses:[]},{resolvedAddresses:'35.163.12.34'},{extra:true}])assert.throws(()=>validate({...m,...patch}),{code:'LIBPQ_MANIFEST_INVALID'});
 assert.throws(()=>validate(m,undefined,'5'.repeat(64)));
});
test('pgpass safely escapes colon/backslash, rejects line injection; service pins host verification',()=>{
 assert.equal(pgpassField('a:b\\c'),'a\\:b\\\\c');for(const value of ['',null,'a\nb','a\rb','a\0b'])assert.throws(()=>pgpassField(value));
 const c=credentialFiles(source,peer,'a:b\\c');assert.equal(c.pgpass,HOST+':6543:postgres:postgres.vkkqffvmztpzgygzfxhq:a\\:b\\\\c\n');
 assert.match(c.service,new RegExp('host='+HOST+'\nhostaddr='+peer.address+'\nport=6543\n'));assert.match(c.service,/sslmode=verify-full\nsslrootcert=\/bron-probe\/ca.crt\n/);
 assert.doesNotMatch(c.service,/a:b|password|options|require\n/);assert.equal(c.ca,'SYNTHETIC_CA');
 for(const p of [{...peer,address:'127.0.0.1'},{...peer,address:'1.1.1.1'},{...peer,canonicalHost:'evil.invalid'}])assert.throws(()=>credentialFiles(source,p,'x'));
 assert.throws(()=>credentialFiles({...source,user:'postgres'},peer,'x'));
});
test('exact synthetic sequence validates chunk boundaries and returns only safe counts',()=>{
 const b=output();for(const chunkSize of [1,7,4096,65536,b.length]){const p=new SyntheticOutputParser();for(let i=0;i<b.length;i+=chunkSize)p.push(b.subarray(i,i+chunkSize));
  const r=p.finish();assert.equal(r.frontendTls,true);assert.equal(r.bulkBytes,1048576);assert.deepEqual(r.rows.map(s=>s.rows),[1,1,10,1]);assert.doesNotMatch(JSON.stringify(r),/x{128}|SYNTHETIC_CA|postgres|SELECT/);}
 assert.ok(syntheticSql.indexOf("repeat('x',512)")<syntheticSql.indexOf("repeat('x',128)"));assert.match(syntheticSql,/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);assert.match(syntheticSql,/ROLLBACK;\n\\echo LP:complete/);
 assert.doesNotMatch(syntheticSql,/auth\.|public\.|pg_stat_ssl|COPY|INSERT|UPDATE|DELETE/i);
});
test('missing frontend TLS, changed identity, corrupt/truncated/extra/oversize synthetic rows fail closed',()=>{
 assert.throws(()=>parse(output({ssl:false})),{code:'LIBPQ_PHASE_INVALID'});
 const b=output(),text=b.toString();for(const corrupt of [text.replace('identity|t|','identity|f|'),text.replace('LP:first512','LP:single128'),
  text.replace('x'.repeat(512),'x'.repeat(511)),text.replace('LP:single128','x\nLP:single128'),text.replace('LP:complete\n',''),text+'x\n',text.slice(0,-1)])assert.throws(()=>parse(Buffer.from(corrupt)));
 const highbit=Buffer.from(b);highbit[highbit.indexOf(Buffer.from('x'.repeat(512)))]=0xf8;assert.throws(()=>parse(highbit),{code:'LIBPQ_SYNTHETIC_INVALID'});
 assert.throws(()=>parse(Buffer.alloc(2097153)),{code:'LIBPQ_STDOUT_LIMIT'});assert.throws(()=>parse(Buffer.from('z'.repeat(4097)+'\n')),{code:'LIBPQ_PREAMBLE_LIMIT'});
});
test('client runs only cached psql with isolated credentials and own nonce cleanup identity',()=>{
 const args=clientArgs({image,name,nonce,directory});assert.equal(args[0],'run');for(const key of unsetPgEnvironment){const index=args.indexOf(key);assert.ok(index>0);assert.equal(args[index-1],'-e');assert.equal(args.filter(x=>x===key).length,1);}assert.ok(unsetPgEnvironment.includes('PGPASSWORD'));assert.ok(unsetPgEnvironment.includes('PGOPTIONS'));for(const option of ['--interactive','--rm','--pull=never','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges'])assert.ok(args.includes(option));
 assert.equal(args[args.indexOf('--entrypoint')+1],'psql');assert.equal(args[args.indexOf('--network')+1],'host');assert.ok(args.includes('PGPASSFILE=/bron-probe/pgpass'));
 assert.doesNotMatch(args.join(' '),/PGPASSWORD=|PGOPTIONS=|PGSSL[A-Z_]*=|publish|--volume|docker.sock/);assert.equal(args.includes('-t'),true);assert.equal(args.indexOf('-t')>args.indexOf(image),true);
 const record={Id:'a'.repeat(64),Name:'/'+name,Config:{Labels:{'bron.source-libpq-probe':nonce}}};assert.equal(ownedContainer(record,name,nonce),true);
 for(const changed of [{...record,Name:'/supabase-db'},{...record,Id:'x'},{...record,Config:{Labels:{'bron.source-libpq-probe':'wrong'}}}])assert.equal(ownedContainer(changed,name,nonce),false);
 assert.throws(()=>clientArgs({image:'postgres:17',name,nonce,directory}));assert.throws(()=>clientArgs({image,name,nonce,directory:'/tmp/unsafe'}));
});
function fakeChild(run){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true;};queueMicrotask(()=>run(child));return child;}
test('client accepts exact script completion, rejects psql exit and does not surface raw stderr',async()=>{
 let received='';const result=await runSyntheticClient({docker:'/synthetic/docker',args:[],env:{},spawnClient:()=>fakeChild(c=>{c.stdin.on('data',b=>received+=b);received=c.stdin.read()?.toString()??received;c.stdout.write(output());c.emit('close',0);})});
 assert.equal(result.bulkBytes,1048576);assert.equal(received,syntheticSql);
 await assert.rejects(runSyntheticClient({docker:'x',args:[],env:{},spawnClient:()=>fakeChild(c=>{c.stderr.write('DO_NOT_DISCLOSE_PASSWORD');c.emit('close',2);})}),e=>e.code==='LIBPQ_PSQL_EXIT'&&!e.message.includes('PASSWORD'));
});
test('phase timeout, total deadline, stderr bound and signal kill only spawned client process',async()=>{
 for(const [options,code]of [[{phaseMs:10,deadlineMs:1000},'LIBPQ_PHASE_TIMEOUT'],[{phaseMs:1000,deadlineMs:10},'LIBPQ_WALL_DEADLINE']]){
  let child;await assert.rejects(runSyntheticClient({docker:'x',args:[],env:{},...options,spawnClient:()=>child=fakeChild(()=>{})}),{code});assert.equal(child.killed,true);}
 let child;await assert.rejects(runSyntheticClient({docker:'x',args:[],env:{},spawnClient:()=>child=fakeChild(c=>c.stderr.write(Buffer.alloc(65537)))}),{code:'LIBPQ_STDERR_LIMIT'});assert.equal(child.killed,true);
 const c=new AbortController();await assert.rejects(runSyntheticClient({docker:'x',args:[],env:{},signal:c.signal,spawnClient:()=>child=fakeChild(()=>c.abort())}),{code:'LIBPQ_INTERRUPTED'});assert.equal(child.killed,true);
});

test('exclusive private guard is mode600, fsynced and never overwrites existing file or symlink',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bron-libpq-guard-'));try{const guard=path.join(dir,'guard');privateWrite(guard,'first');assert.equal(fs.statSync(guard).mode&0o777,0o600);assert.equal(fs.readFileSync(guard,'utf8'),'first');
  assert.throws(()=>privateWrite(guard,'second'),{code:'EEXIST'});assert.equal(fs.readFileSync(guard,'utf8'),'first');const link=path.join(dir,'symlink');fs.symlinkSync(guard,link);assert.throws(()=>privateWrite(link,'third'));assert.equal(fs.readFileSync(guard,'utf8'),'first');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('1MiB phase failure retains verified smaller rows and safe timings without stdout/stderr',async()=>{
 const text=output().toString(),prefix=text.slice(0,text.indexOf('LP:single1MiB\n')+'LP:single1MiB\n'.length);let child;
 await assert.rejects(runSyntheticClient({docker:'x',args:[],env:{},phaseMs:10,deadlineMs:1000,spawnClient:()=>child=fakeChild(c=>{c.stdout.write(prefix);c.stderr.write('DO_NOT_DISCLOSE_PASSWORD CA_PRIVATE_DATA');})}),error=>{
  assert.equal(error.code,'LIBPQ_PHASE_TIMEOUT');assert.equal(error.phase,'single1MiB');assert.equal(error.progress.frontendTls,true);assert.equal(error.progress.identityVerified,true);
  assert.deepEqual(error.progress.rowsCompleted.map(s=>s.rows),[1,1,10,0]);assert.ok(error.progress.elapsedMs>=0);assert.ok(error.progress.phaseTimings.some(s=>s.phase==='first512'));
  assert.doesNotMatch(JSON.stringify(error.progress),/DO_NOT_DISCLOSE|PASSWORD|PRIVATE|x{128}|SELECT|postgres/);return true;
 });assert.equal(child.killed,true);
});
