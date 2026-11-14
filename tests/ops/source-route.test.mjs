import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSourceRoute,SOURCE_HOST} from '../../docs/runbooks/payloads/t25-source-route.mjs';
const secret=async()=> 'PRIVATE_SECRET';
const ca=Buffer.from('PRIVATE_CA');
const sourceConfig={host:'127.0.0.1',port:15432,user:'postgres.vkkqffvmztpzgygzfxhq',database:'postgres',
  password:secret,ssl:{ca,rejectUnauthorized:true,servername:SOURCE_HOST,checkServerIdentity:()=>{}},
  options:'-c default_transaction_read_only=on -c statement_timeout=30000'};
function driver(failPorts=[],hang=false){
  const clients=[];
  class Client{
    constructor(config){this.config=config;this.queries=[];this.destroyed=false;this.connection={stream:{destroy:()=>{this.destroyed=true;}}};clients.push(this);}
    on(){}
    async connect(){if(failPorts.includes(this.config.port))throw Object.assign(new Error('PRIVATE_SERVER_DETAIL'),{code:'ECONNREFUSED'});}
    async query(sql){this.queries.push(sql);if(hang)return new Promise(()=>{});
      if(sql.startsWith('SELECT current_database'))return {rows:[{db:'postgres',role:'postgres',read_only:'on'}]};
      if(sql.startsWith('SELECT repeat'))return {rows:[{payload:'x'.repeat(1048576)}]};
      return {rows:[]};}
    async end(){this.ended=true;}
  }
  return {Client,clients};
}
test('first passing canonical session route stops search and enforces actual readonly dummy transport',async()=>{
  const d=driver(),result=await chooseSourceRoute({sourceConfig,Client:d.Client});
  assert.equal(result.selectedRoute,'canonical-session');assert.equal(d.clients.length,1);
  assert.deepEqual(d.clients[0].queries.slice(0,2),['BEGIN READ ONLY',"SET LOCAL statement_timeout='5000'"]);
  assert.equal(d.clients[0].queries.at(-1),'ROLLBACK');assert.equal(result.diagnostics[0].bytes,1048576);
  assert.equal(result.config.host,SOURCE_HOST);assert.equal(result.config.port,5432);
  assert.equal(result.config.password,secret);assert.equal(result.config.ssl.ca,ca);assert.equal(d.clients[0].destroyed,true);
});
test('transaction route preserves canonical TLS and password callback while avoiding startup options',async()=>{
  const d=driver([5432]),result=await chooseSourceRoute({sourceConfig,Client:d.Client});
  assert.equal(result.selectedRoute,'canonical-transaction');assert.equal(d.clients.length,2);
  assert.equal(result.config.port,6543);assert.equal(result.config.options,undefined);
  assert.equal(result.config.ssl,sourceConfig.ssl);assert.equal(result.config.password,secret);
  assert.equal(sourceConfig.options.includes('read_only'),true);assert.equal(d.clients.every(c=>c.ended&&c.destroyed),true);
  assert.doesNotMatch(JSON.stringify(result.diagnostics),/PRIVATE_|password|payload|sql|SELECT/);
});
test('only existing protected loopback route is used as fallback; all failures remain safe',async()=>{
  const d=driver([5432,6543]),result=await chooseSourceRoute({sourceConfig,Client:d.Client});
  assert.equal(result.selectedRoute,'existing-reverse');assert.equal(result.config.host,'127.0.0.1');
  assert.equal(result.config.port,15432);assert.equal(result.diagnostics.length,3);
  const all=driver([5432,6543,15432]),failed=await chooseSourceRoute({sourceConfig,Client:all.Client});
  assert.equal(failed.config,null);assert.equal(failed.selectedRoute,null);assert.equal(failed.diagnostics.length,3);
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_|password|payload/);
});
test('unsafe source endpoints/TLS and invalid deadlines fail before client creation',async()=>{
  const d=driver();
  for(const override of [{host:'evil.invalid'},{port:6543},{ssl:{...sourceConfig.ssl,rejectUnauthorized:false}},
    {ssl:{...sourceConfig.ssl,servername:'evil.invalid'}},{connectionString:'PRIVATE_SECRET'}])
    await assert.rejects(chooseSourceRoute({sourceConfig:{...sourceConfig,...override},Client:d.Client}),{code:'SOURCE_ROUTE_CONFIG_UNSAFE'});
  await assert.rejects(chooseSourceRoute({sourceConfig,Client:d.Client,timeoutMs:10001}),{code:'SOURCE_ROUTE_CONFIG_UNSAFE'});
  assert.equal(d.clients.length,0);
});
test('route deadline closes active client without queuing rollback behind a hung query',async()=>{
  const d=driver([],true),result=await chooseSourceRoute({sourceConfig,Client:d.Client,timeoutMs:5});
  assert.equal(result.config,null);assert.equal(result.diagnostics.length,3);
  assert.equal(result.diagnostics.every(r=>r.code==='SOURCE_ROUTE_DEADLINE'),true);
  assert.equal(d.clients.every(c=>c.ended&&c.destroyed&&!c.queries.includes('ROLLBACK')),true);
});
