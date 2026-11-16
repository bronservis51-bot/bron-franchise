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

const {probeExistingSource}=await import('../../docs/runbooks/payloads/t26-transport-probe.mjs');
class FixtureClient extends pg.Client {
 constructor(config){super({...config,stream:()=>new PgPipe(),user:'postgres',ssl:false});}
}
const sourceConfig={host:'127.0.0.1',port:15432,database:'postgres',user:'postgres.vkkqffvmztpzgygzfxhq',
 password:async()=> 'synthetic-only',options:'-c default_transaction_read_only=on',ssl:{ca:Buffer.from('synthetic-only'),
 rejectUnauthorized:true,servername:'aws-1-us-west-2.pooler.supabase.com',checkServerIdentity:()=>{}}};
const result=await probeExistingSource({sourceConfig,Client:FixtureClient});
assert.equal(result.passed,true);assert.equal(result.bulkPass,true);assert.equal(result.failedStage,null);
assert.deepEqual(result.stages.map(s=>s.stage),['connect','begin','serverDeadline','identity','small','bulk','rollback']);
assert.equal(result.stages.find(s=>s.stage==='bulk').bytes,1048576);
console.log(JSON.stringify({result:'PASS',engine:'native PG17.12',driver:'pg8.23.1',sourceRole:'NOSUPER postgres',
 scope:'synthetic wire protocol only, not network/TLS acceptance',stages:result.stages.map(s=>s.stage),bulkBytes:1048576}));
