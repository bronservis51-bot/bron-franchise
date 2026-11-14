import test from 'node:test';
import assert from 'node:assert/strict';
import {FAILED_PEER,T32_RESULT_SHA,validateT32Evidence,selectAlternativePeers,probeAlternativePeers} from '../../docs/runbooks/payloads/t33-source-peers.mjs';
import {SOURCE_HOST,dummyStages,dummySql} from '../../docs/runbooks/payloads/t31-source-network.mjs';
const a='44.225.139.66',b='44.252.246.120',c='44.225.139.67';
const source={host:'127.0.0.1',port:15432,user:'postgres.vkkqffvmztpzgygzfxhq',database:'postgres',password:async()=> 'PRIVATE_PASSWORD',
 ssl:{rejectUnauthorized:true,servername:SOURCE_HOST,ca:'PRIVATE_CA',checkServerIdentity:()=>{}},options:'PRIVATE_STARTUP_OPTIONS'};
const evidence=()=>({task:'T32',status:'BLOCKED',retainedRoute:false,routeStatus:'RESTORED_NO_HOST_ROUTE',selectedPeerIPv4:FAILED_PEER,canonicalHost:SOURCE_HOST});
test('new task requires pinned T32 failure with exact route restoration metadata',()=>{
 assert.equal(T32_RESULT_SHA,'6265d628f08feb0707b10f31f2575cbdf9822e7da1c217b4f00249ad0a617971');
 assert.equal(validateT32Evidence(evidence()),true);
 for(const patch of [{task:'T31'},{status:'PASS'},{retainedRoute:true},{routeStatus:'TEMPORARY_ADDED'},{selectedPeerIPv4:a},{canonicalHost:'evil.invalid'}])
  assert.throws(()=>validateT32Evidence({...evidence(),...patch}),{code:'T33_T32_RECOVERY_NOT_PROVED'});
});
test('one DNS set yields at most two unique public alternative peers, never the known failed one',()=>{
 assert.deepEqual(selectAlternativePeers([FAILED_PEER,a,a,b,c]),[a,b]);
 assert.deepEqual(selectAlternativePeers([FAILED_PEER]),[]);
 for(const addresses of [[],['127.0.0.1'],['10.0.0.1'],['169.254.1.2'],['172.20.1.2'],['192.168.1.1'],['::1'],Array(9).fill(a)])
  assert.throws(()=>selectAlternativePeers(addresses),{code:'T33_CANONICAL_DNS_INVALID'});
});
function fixture({failAt=null,corrupt=false,rollbackFail=false}={}){
 const queries=[];let destroyed=false,closed=false;
 const db={on(){},connection:{stream:{destroy(){destroyed=true;}}},async connect(){},async end(){closed=true;},async query(sql){
  queries.push(sql);
  if(failAt&&sql===dummySql(dummyStages.find(s=>s.name===failAt)))throw new Error('Query read timeout');
  if(sql==='ROLLBACK'&&rollbackFail)throw new Error('PRIVATE_RAW_ERROR');
  if(sql.startsWith('SELECT current_database'))return{rows:[{db:'postgres',role:'postgres',mode:'on'}]};
  const stage=dummyStages.find(s=>dummySql(s)===sql);
  return{rows:stage?Array.from({length:stage.rows},()=>({payload:(corrupt?'y':'x').repeat(stage.bytes)})):[]};
 }};return{db,queries,destroyed:()=>destroyed,closed:()=>closed};
}
async function run(outcomes,addresses=[FAILED_PEER,a,b,c]){
 const opened=[],events=[];
 const result=await probeAlternativePeers({sourceConfig:source,resolvedAddresses:addresses,
  openClient:(config,peer)=>{assert.equal(config.host,peer.address);assert.equal(config.port,6543);assert.equal(config.ssl,source.ssl);assert.equal(config.password,source.password);assert.equal(config.options,undefined);
   assert.equal(events.at(-1).status,'STARTED');const f=fixture(outcomes[opened.length]);opened.push({peer:peer.address,...f});return f.db;},
  onAttempt:async record=>{events.push(record);}});
 return{result,opened,events};
}
test('first full6stage1MiB and rollback PASS selects peer and prevents second connection',async()=>{
 const {result,opened,events}=await run([{},{}]);
 assert.equal(result.status,'PASS');assert.equal(result.selectedPeerIPv4,a);assert.equal(result.attempts.length,1);assert.equal(opened.length,1);
 assert.equal(opened[0].destroyed(),true);assert.equal(opened[0].closed(),true);assert.equal(events.length,2);
 assert.equal(result.attempts[0].bulkBytes,1048576);assert.equal(opened[0].queries.at(-1),'ROLLBACK');
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|x{128}|SELECT/);
});
test('failed first peer is closed before one second peer attempt; no old-peer replay or third attempt',async()=>{
 const {result,opened}=await run([{failAt:'single512'},{}]);
 assert.equal(result.status,'PASS');assert.equal(result.selectedPeerIPv4,b);assert.deepEqual(opened.map(x=>x.peer),[a,b]);
 assert.equal(opened[0].queries.includes('ROLLBACK'),false);assert.ok(opened.every(x=>x.destroyed()&&x.closed()));
});
test('both failures finish BLOCKED after exactly two attempts, with timeout cleanup and no selected peer',async()=>{
 const {result,opened,events}=await run([{failAt:'single128'},{failAt:'single512'}]);
 assert.equal(result.status,'BLOCKED');assert.equal(result.code,'T33_NO_VERIFIED_ALTERNATIVE_PEER');assert.equal(result.selectedPeerIPv4,undefined);
 assert.deepEqual(opened.map(x=>x.peer),[a,b]);assert.equal(events.length,4);assert.ok(opened.every(x=>x.destroyed()&&x.closed()));
 assert.ok(opened.every(x=>!x.queries.includes('ROLLBACK')));
});
test('only the failed current peer causes no connection and does not spend alternative budget',async()=>{
 const {result,opened}=await run([], [FAILED_PEER]);
 assert.equal(result.status,'BLOCKED');assert.equal(result.code,'T33_NO_UNTESTED_CURRENT_PEER');assert.deepEqual(opened,[]);
});
test('bad payload or failed rollback cannot claim success despite received bytes',async()=>{
 for(const first of [{corrupt:true},{rollbackFail:true}]){
  const {result,opened}=await run([first,{}]);assert.equal(result.status,'PASS');assert.equal(result.selectedPeerIPv4,b);
  assert.equal(result.attempts[0].status,'FAIL');assert.ok(opened.every(x=>x.destroyed()&&x.closed()));
 }
});
