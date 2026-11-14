// Synthetic only; never a real source connection.
import pg from '../../node_modules/pg/lib/index.js';
import {spawn,execFileSync} from 'node:child_process';
import {Duplex} from 'node:stream';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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



const {runDummyProbe}=await import('../../docs/runbooks/payloads/t31-source-network.mjs');
let verified=0,version;
const open=()=>{
 const c=new pg.Client({stream:()=>new PgPipe(),user:'postgres',database:'postgres',ssl:false,query_timeout:8000});
 const original=c.query.bind(c);
 c.query=async sql=>{
  const r=await original(sql);
  if(sql.startsWith('SELECT current_database')){
   const meta=(await original("SELECT current_setting('transaction_read_only') AS mode,current_setting('statement_timeout') AS deadline,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('server_version') AS version")).rows[0];
   assert.equal(meta.mode,'on');assert.equal(meta.deadline,'4s');assert.equal(meta.idle,'10s');version=meta.version;verified++;
  }
  return r;
 };
 return c;
};
const first=await runDummyProbe({openClient:open}),second=await runDummyProbe({openClient:open});
for(const r of [first,second]){assert.equal(r.status,'PASS');assert.equal(r.bulkBytes,1048576);assert.equal(r.steps.at(-1).step,'rollback');assert.equal(r.steps.filter(s=>s.status==='FAIL').length,0);}
assert.equal(verified,2);
assert.doesNotMatch(JSON.stringify([first,second]),/x{128}|SELECT|PRIVATE/);
console.log(JSON.stringify({status:'PASS',serverVersion:version,driver:'pg8.23.1',freshReadOnlyConnections:2,actualStatementDeadline:'4s',actualIdleDeadline:'10s',allSixDummyStagesPassedTwice:true,maximumSyntheticResponseBytes:1048576,noBusinessDataQueries:true,noRealNetworkChanges:true,tlsToCanonicalSource:'ACTUAL_ACCEPTANCE_PENDING'}));
