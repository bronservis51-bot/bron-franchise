import test from 'node:test';
import assert from 'node:assert/strict';
import {probeExistingSource} from '../../docs/runbooks/payloads/t26-transport-probe.mjs';
const sourceConfig={host:'127.0.0.1',port:15432,user:'postgres.vkkqffvmztpzgygzfxhq',database:'postgres',
  password:async()=> 'PRIVATE_SECRET',ssl:{ca:Buffer.from('PRIVATE_CA'),rejectUnauthorized:true,
    servername:'aws-1-us-west-2.pooler.supabase.com',checkServerIdentity:()=>{}},options:'-c default_transaction_read_only=on'};
function driver({failQuery,hangQuery,connectError,slowBulk=false,badIdentity=false}={}){
  const clients=[];let clock=0;
  class Client{
    constructor(config){this.config=config;this.queries=[];this.destroyed=false;this.connection={stream:{destroy:()=>{this.destroyed=true;}}};clients.push(this);}
    on(){} async connect(){clock+=14000;if(connectError)throw connectError;}
    async query(sql){this.queries.push(sql);clock+=1;
      if(hangQuery?.(sql))return new Promise(()=>{});
      if(failQuery?.(sql))throw new Error('PRIVATE_SERVER_DETAIL');
      if(sql.startsWith('SELECT current_database'))return {rows:[{db:'postgres',role:badIdentity?'PRIVATE_ROLE':'postgres',read_only:'on'}]};
      if(sql.startsWith('SELECT repeat')){const n=Number(sql.match(/,(\d+)\)/)[1]);if(slowBulk&&n===1048576)clock+=16000;return {rows:[{payload:'x'.repeat(n)}]};}
      return {rows:[]};}
    async end(){this.ended=true;}
  }
  return {Client,clients,now:()=>clock};
}
test('staged read-only probe excludes connect time from 1MiB bulk gate and preserves canonical TLS/callback',async()=>{
  const d=driver(),result=await probeExistingSource({sourceConfig,Client:d.Client,now:d.now});
  assert.equal(result.passed,true);assert.equal(result.bulkPass,true);assert.equal(result.failedStage,null);
  assert.deepEqual(result.stages.map(s=>s.stage),['connect','begin','serverDeadline','identity','small','bulk','rollback']);
  assert.equal(result.stages[0].elapsedMs,14000);assert.equal(result.stages[5].elapsedMs,1);assert.equal(result.stages[5].bytes,1048576);
  assert.equal(d.clients[0].config.ssl,sourceConfig.ssl);assert.equal(d.clients[0].config.password,sourceConfig.password);
  assert.equal(d.clients[0].queries[0],'BEGIN READ ONLY');assert.equal(d.clients[0].queries.at(-1),'ROLLBACK');
  assert.equal(d.clients[0].destroyed,true);assert.equal(d.clients[0].ended,true);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|payload|SELECT|password|BEGIN/);
});
test('slow bulk has a distinct throughput failure and no queued rollback',async()=>{
  const d=driver({slowBulk:true}),result=await probeExistingSource({sourceConfig,Client:d.Client,now:d.now});
  assert.equal(result.passed,false);assert.equal(result.bulkPass,false);assert.equal(result.failedStage,'bulk');assert.equal(result.code,'SOURCE_BULK_SLOW');
  assert.equal(d.clients[0].queries.includes('ROLLBACK'),false);assert.equal(d.clients[0].destroyed,true);
});
test('connection timeout and unknown errors remain fixed safe classifications',async()=>{
  const d=driver({connectError:new Error('Connection terminated due to connection timeout')}),result=await probeExistingSource({sourceConfig,Client:d.Client,now:d.now});
  assert.equal(result.failedStage,'connect');assert.equal(result.code,'PG_CONNECT_TIMEOUT');
  const other=driver({failQuery:q=>q==='BEGIN READ ONLY'}),failed=await probeExistingSource({sourceConfig,Client:other.Client,now:other.now});
  assert.equal(failed.failedStage,'begin');assert.equal(failed.code,'SOURCE_PROBE_FAILED');assert.doesNotMatch(JSON.stringify(failed),/PRIVATE/);
});
test('per-phase deadline aborts and closes without rollback behind a hung read',async()=>{
  const d=driver({hangQuery:q=>q.startsWith('SELECT repeat')}),result=await probeExistingSource({sourceConfig,Client:d.Client,now:d.now,
    deadlines:{connect:5,begin:5,serverDeadline:5,identity:5,small:5,bulk:5,rollback:5}});
  assert.equal(result.failedStage,'small');assert.equal(result.code,'SOURCE_PROBE_DEADLINE');assert.equal(result.passed,false);
  assert.equal(d.clients[0].destroyed,true);assert.equal(d.clients[0].queries.includes('ROLLBACK'),false);
});
test('identity and unsafe source/TLS fail without data or configuration disclosure',async()=>{
  const d=driver({badIdentity:true}),result=await probeExistingSource({sourceConfig,Client:d.Client,now:d.now});
  assert.equal(result.failedStage,'identity');assert.equal(result.code,'SOURCE_PROBE_IDENTITY');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  const clean=driver();
  for(const patch of [{host:'evil.invalid'},{port:6543},{ssl:{...sourceConfig.ssl,rejectUnauthorized:false}},
    {ssl:{...sourceConfig.ssl,servername:'evil.invalid'}},{connectionString:'PRIVATE_SECRET'}])
    await assert.rejects(probeExistingSource({sourceConfig:{...sourceConfig,...patch},Client:clean.Client}),{code:'SOURCE_PROBE_CONFIG_UNSAFE'});
  assert.equal(clean.clients.length,0);
});
