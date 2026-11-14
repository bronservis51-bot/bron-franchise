// Synthetic only: real TLS runs through a Duplex into an owned network-none PG17.
import fs from 'node:fs';
import pg from '../../node_modules/pg/lib/index.js';
import {spawn,execFileSync} from 'node:child_process';
import {Duplex} from 'node:stream';
import {checkServerIdentity} from 'node:tls';
import assert from 'node:assert/strict';

const [cid,conf,docker]=process.argv.slice(2);
const HOST='aws-1-us-west-2.pooler.supabase.com';
const env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',DOCKER_CONFIG:conf};
let phase='isolation';
assert.equal(process.argv.length,5);assert.match(cid,/^[0-9a-f]{64}$/);
assert.ok(['/usr/local/bin/docker','/usr/bin/docker','/bin/docker'].includes(docker));
const [container]=JSON.parse(execFileSync(docker,['--host','unix:///var/run/docker.sock','inspect',cid],
 {env,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}));
const marker=container.Config?.Labels?.['bron.test.native-pg17'];
assert.match(marker??'',/^[0-9a-f]{32}$/);assert.equal(container.Name,'/bron-native-pg17-'+marker);
assert.equal(container.HostConfig.NetworkMode,'none');assert.equal(Object.keys(container.HostConfig.PortBindings??{}).length,0);
assert.ok(container.Mounts.every(m=>m.Type==='tmpfs'));

class PgPipe extends Duplex {
 constructor(){super();this.child=spawn(docker,['--host','unix:///var/run/docker.sock','exec','-i',cid,'nc','127.0.0.1','5432'],{env,stdio:['pipe','pipe','pipe']});
  this.child.stdout.on('data',b=>{if(!this.push(b))this.child.stdout.pause();});this.child.stdout.on('end',()=>this.push(null));
  this.child.stderr.resume();this.child.on('error',e=>this.destroy(e));this.child.stdin.on('error',e=>this.destroy(e));}
 connect(){queueMicrotask(()=>this.emit('connect'));return this;}
 setNoDelay(){} setKeepAlive(){} ref(){} unref(){}
 _read(){this.child.stdout.resume();}
 _write(b,e,cb){this.child.stdin.write(b,e,cb);}
 _final(cb){this.child.stdin.end(cb);}
 _destroy(err,cb){this.child.kill();cb(err);}
}
const clients=[];
const ca=fs.readFileSync(conf+'/ca.crt'),wrongCa=fs.readFileSync(conf+'/wrong.crt');
let hostnameChecks=0;
const make=(trust=ca,name=HOST)=>{
 const client=new pg.Client({host:'127.0.0.1',port:5432,stream:()=>new PgPipe(),user:'postgres',database:'postgres',
  ssl:{ca:trust,rejectUnauthorized:true,servername:name,checkServerIdentity:(_host,certificate)=>{
   if(name===HOST)hostnameChecks++;return checkServerIdentity(name,certificate);}},
  connectionTimeoutMillis:5000,query_timeout:8000});
 client.on('error',()=>{});clients.push(client);return client;
};
const close=async client=>{client.connection?.stream?.destroy();let timer;
 try{await Promise.race([client.end(),new Promise(resolve=>{timer=setTimeout(resolve,250);})]);}catch{}finally{clearTimeout(timer);}};
try{
 phase='verified-tls';const client=make();await client.connect();
 assert.equal(client.connection.stream.authorized,true);
 assert.equal(client.connection.stream.servername,HOST);
 const protocol=client.connection.stream.getProtocol();assert.ok(['TLSv1.2','TLSv1.3'].includes(protocol));
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await client.query("SET LOCAL statement_timeout='5000'");
 await client.query("SET LOCAL idle_in_transaction_session_timeout='10000'");
 const meta=(await client.query(`SELECT current_setting('server_version') AS version,
 current_setting('transaction_read_only') AS mode,current_setting('transaction_isolation') AS isolation,
 current_setting('statement_timeout') AS deadline,current_setting('idle_in_transaction_session_timeout') AS idle,
 (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS actual_ssl`)).rows[0];
 assert.equal(meta.mode,'on');assert.equal(meta.isolation,'repeatable read');assert.equal(meta.deadline,'5s');
 assert.equal(meta.idle,'10s');assert.equal(meta.actual_ssl,true);
 for(const n of [128,512,1048576]){
  phase='dummy-'+n;const rows=(await client.query(`SELECT repeat('x',${n}) AS payload`)).rows;
  assert.equal(rows.length,1);assert.equal(Buffer.byteLength(rows[0].payload),n);assert.match(rows[0].payload,/^x+$/);
 }
 await client.query('ROLLBACK');await close(client);
 phase='wrong-ca';const badCa=make(wrongCa);await assert.rejects(badCa.connect());
 assert.equal(badCa.connection.stream.authorized,false);
 assert.ok(['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN','CERT_SIGNATURE_FAILURE'].includes(badCa.connection.stream.authorizationError));await close(badCa);
 phase='wrong-hostname';const badHost=make(ca,'wrong.invalid');await assert.rejects(badHost.connect());
 assert.equal(badHost.connection.stream.authorized,false);
 assert.equal(badHost.connection.stream.authorizationError,'ERR_TLS_CERT_ALTNAME_INVALID');await close(badHost);
 assert.ok(hostnameChecks>=1);
 console.log(JSON.stringify({status:'PASS',serverVersion:meta.version,nodeVersion:process.versions.node,driver:'pg8.23.1',actualTls:true,protocol,
  ipConnectionWithCanonicalSni:true,canonicalHostnameVerified:true,wrongCaRejected:true,wrongHostnameRejected:true,
  actualReadOnlyRepeatableRead:true,actualStatementDeadline:'5s',actualIdleDeadline:'10s',dummyBytes:[128,512,1048576],
  sourceOrVpsContact:false,hostPorts:false,realKeysOrData:false}));
}catch(error){
 console.error(JSON.stringify({status:'FAIL',phase,code:/^[A-Z0-9_]+$/.test(error?.code??'')?error.code:'NATIVE_TLS_ASSERTION'}));process.exitCode=1;
}finally{await Promise.allSettled(clients.map(close));}
