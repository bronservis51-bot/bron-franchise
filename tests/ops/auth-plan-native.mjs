// Synthetic only; never a real source connection.
import pg from '../../node_modules/pg/lib/index.js';
import {spawn,execFileSync} from 'node:child_process';
import {Duplex} from 'node:stream';
import assert from 'node:assert/strict';
const cid=process.argv[2];const conf=process.argv[3];const docker=process.argv[4];
const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:conf};
assert.equal(process.argv.length,5);assert.match(cid,/^[0-9a-f]{64}$/);
assert.ok(['/usr/local/bin/docker','/usr/bin/docker','/bin/docker'].includes(docker));
const [container]=JSON.parse(execFileSync(docker,['--host','unix:///var/run/docker.sock','inspect',cid],{env,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}));
const marker=container.Config?.Labels?.['bron.test.native-pg17'];
assert.match(marker??'',/^[0-9a-f]{32}$/);assert.equal(container.Name,'/bron-native-pg17-'+marker);
assert.equal(container.HostConfig.NetworkMode,'none');assert.equal(Object.keys(container.HostConfig.PortBindings??{}).length,0);
assert.ok(container.Mounts.every(m=>m.Type==='tmpfs'));

class PgPipe extends Duplex {
 constructor(){super();this.child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,'nc','127.0.0.1','5432'],{env,stdio:['pipe','pipe','pipe']});this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));this.child.stderr.resume();this.child.on('error',e=>this.destroy(e));this.child.stdin.on('error',e=>this.destroy(e));}
 connect(){queueMicrotask(()=>this.emit('connect'));return this;}
 setNoDelay(){} setKeepAlive(){} ref(){} unref(){}
 _read(){this.child.stdout.resume();}
 _write(b,e,cb){this.child.stdin.write(b,e,cb);}
 _final(cb){this.child.stdin.end(cb);}
 _destroy(err,cb){this.child.kill();cb(err);}
}


const {captureAuthRows,authRowsPlan}=await import('../../docs/runbooks/payloads/t29-auth-plan.mjs');
const clients=[];
const open=async(user,readonly)=>{const c=new pg.Client({stream:()=>new PgPipe(),user,database:'postgres',ssl:false,
 options:'-c default_transaction_read_only='+readonly,query_timeout:10000});c.on('error',()=>{});clients.push(c);await c.connect();return c;};
try{
 const reader=await open('postgres','on'),writer=await open('supabase_admin','off');
 const version=(await reader.query("SELECT current_setting('server_version') AS version")).rows[0].version;
 let checks=0;
 const verify=async db=>{const r=(await db.query("SELECT current_user AS role,current_setting('transaction_read_only') AS mode,current_setting('transaction_isolation') AS isolation,current_setting('TimeZone') AS timezone,current_setting('statement_timeout') AS deadline")).rows[0];
  assert.deepEqual(r,{role:'postgres',mode:'on',isolation:'repeatable read',timezone:'UTC',deadline:'5s'});checks++;};
 const source=await captureAuthRows(reader,verify);
 assert.equal(typeof source.rows[0].private_micros,'string');assert.ok(source.rows[0].private_other.includes('9007199254740993'));
 await writer.query("UPDATE auth.users SET updated_at='2026-11-13T12:00:00.000000Z'");
 const target=await captureAuthRows(reader,verify);
 assert.equal(BigInt(source.rows[0].private_micros)-BigInt(target.rows[0].private_micros),1n);
 const good=authRowsPlan(source.rows,target.rows);
 assert.equal(good.sourceNewerRows,1);assert.equal(good.changedUpdatedOnlyRows,1);assert.equal(good.canReconcileTimestampOnly,true);
 await writer.query(`UPDATE auth.users SET raw_user_meta_data='{"large":9007199254740992,"decimal":1.00000000000000000001}'::jsonb`);
 const changed=await captureAuthRows(reader,verify),bad=authRowsPlan(source.rows,changed.rows);
 assert.equal(bad.otherChangedRows,1);assert.equal(bad.canReconcileTimestampOnly,false);
 await writer.query(`UPDATE auth.users SET raw_user_meta_data='{"large":9007199254740993,"decimal":1.00000000000000000001}'::jsonb,updated_at='2026-11-13T12:00:00.000002Z'`);
 const newer=authRowsPlan(source.rows,(await captureAuthRows(reader,verify)).rows);
 assert.equal(newer.targetNewerRows,1);assert.equal(newer.canReconcileTimestampOnly,false);
 await writer.query('UPDATE auth.users SET updated_at=NULL');
 const nul=authRowsPlan(source.rows,(await captureAuthRows(reader,verify)).rows);
 assert.equal(nul.nullTimestampChangedRows,1);assert.equal(nul.canReconcileTimestampOnly,false);
 const printed=JSON.stringify([good,bad,newer,nul]);
 for(const forbidden of ['PRIVATE_FIXTURE_PASSWORD','9007199254740993','2026-11-13T12','00000000-0000-4000-8000-000000000001'])assert.ok(!printed.includes(forbidden));
 console.log(JSON.stringify({result:'PASS',serverVersion:version,driver:'pg8.23.1',actualReadOnlyRepeatableReadVerified:true,
  actualServerDeadlineVerified:true,microsecondDirectionExact:true,largeMetadataDifferenceDetected:true,targetNewerAndNullBlocked:true,
  noRowsCredentialsOrTimestampValuesPrinted:true,captures:checks,finalFreezeAudit:false}));
}finally{await Promise.allSettled(clients.map(c=>c.end()));}
