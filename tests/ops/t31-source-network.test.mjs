import test from 'node:test';
import assert from 'node:assert/strict';
import {validatedSourcePeerConfig,SOURCE_HOST,dummyStages,dummySql,runDummyProbe,eligibleForMss,planPeerRoute,routeMatches,parseTcpInfo} from '../../docs/runbooks/payloads/t31-source-network.mjs';
const ip='35.163.12.34';
const peer={canonicalHost:SOURCE_HOST,address:ip,resolvedAddresses:[ip,'44.233.12.34']};
const password=async()=> 'SECRET_PASSWORD';
const ssl={rejectUnauthorized:true,servername:SOURCE_HOST,ca:'PRIVATE_CA',checkServerIdentity:()=>{}};
const source={host:'127.0.0.1',port:15432,database:'postgres',user:'postgres.vkkqffvmztpzgygzfxhq',password,ssl,options:'PRIVATE_OPTIONS'};
test('selected DNS peer preserves canonical TLS and password callbacks; no Mac fallback or insecure override',()=>{
 const c=validatedSourcePeerConfig(source,peer);
 assert.equal(c.host,ip);assert.equal(c.port,6543);assert.equal(c.ssl,ssl);assert.equal(c.password,password);assert.equal(c.options,undefined);
 for(const p of [{...peer,address:'127.0.0.1'},{...peer,address:'1.1.1.1'},{...peer,canonicalHost:'evil.invalid'},{...peer,resolvedAddresses:[]}])
  assert.throws(()=>validatedSourcePeerConfig(source,p),{code:'T31_CANONICAL_PEER_INVALID'});
 assert.throws(()=>validatedSourcePeerConfig({...source,ssl:{...ssl,rejectUnauthorized:false}},peer));
});
const route={dst:ip,gateway:'152.228.115.1',dev:'ens3',prefsrc:'152.228.115.115',flags:[],uid:0,cache:[]};
const plan=()=>planPeerRoute({peer:ip,exactRoutes:[],routeGet:[route]});
const added=()=>({dst:ip+'/32',gateway:route.gateway,dev:route.dev,prefsrc:route.prefsrc,metric:42731,metrics:{mtu:1280,advmss:1200}});
test('route plan only adds absent single-peer host route with precise inverse and bounded MSS',()=>{
 const p=plan();assert.deepEqual(p.add,['-4','route','add',ip+'/32','via',route.gateway,'dev','ens3','src',route.prefsrc,'metric','42731','mtu','1280','advmss','1200']);
 assert.deepEqual(p.remove,['-4','route','del',ip+'/32','via',route.gateway,'dev','ens3','src',route.prefsrc,'metric','42731']);
 assert.equal(routeMatches(p,[added()]),true);assert.equal(routeMatches(p,[{...added(),metrics:[added().metrics]}]),true);
 for(const patch of [{metric:1},{gateway:'152.228.115.2'},{metrics:{mtu:1500,advmss:1200}},{metrics:{mtu:1280,advmss:1460}},{nexthops:[]}])
  assert.equal(routeMatches(p,[{...added(),...patch}]),false);
});
test('existing route and non-simple policy, VRF or multipath route cannot be replaced',()=>{
 assert.throws(()=>planPeerRoute({peer:ip,exactRoutes:[added()],routeGet:[route]}));
 for(const patch of [{dst:'default'},{gateway:undefined},{dev:'eth0;bad'},{table:100},{type:'blackhole'},{nexthops:[]},{nhid:4},{via:{family:'inet6',host:'::1'}}])
  assert.throws(()=>planPeerRoute({peer:ip,exactRoutes:[],routeGet:[{...route,...patch}]}));
});
function fixture({failure=null,corrupt=false}={}){
 const queries=[];let destroyed=false,closed=false;
 const db={on(){},connection:{stream:{destroy(){destroyed=true;}}},async connect(){},async end(){closed=true;},async query(sql){
  queries.push(sql);if(failure&&sql===dummySql(failure))throw new Error('Query read timeout');
  if(sql.startsWith('SELECT current_database'))return{rows:[{db:'postgres',role:'postgres',mode:'on'}]};
  const s=dummyStages.find(x=>dummySql(x)===sql);
  if(s)return{rows:Array.from({length:s.rows},()=>({payload:(corrupt?'y':'x').repeat(s.bytes)}))};
  return{rows:[]};
 }};return{db,queries,destroyed:()=>destroyed,closed:()=>closed};
}
test('synthetic sequence proves single, multirow and full1MiB response inside actual readonly controls',async()=>{
 const f=fixture(),r=await runDummyProbe({openClient:()=>f.db});
 assert.equal(r.status,'PASS');assert.equal(r.bulkBytes,1048576);assert.equal(f.queries[0],'BEGIN READ ONLY');
 assert.ok(f.queries.includes("SET LOCAL idle_in_transaction_session_timeout='10000'"));
 assert.deepEqual(f.queries.filter(q=>q.startsWith('SELECT repeat')),dummyStages.map(dummySql));assert.equal(f.queries.at(-1),'ROLLBACK');
 assert.equal(f.destroyed(),true);assert.equal(f.closed(),true);assert.equal(eligibleForMss(r),false);
 assert.doesNotMatch(JSON.stringify(r),/x{128}|SECRET|PRIVATE|SELECT/);
});
test('first response timeout stops sequence, closes socket without queued rollback and permits MSS only after small PASS',async()=>{
 for(const stage of dummyStages){const f=fixture({failure:stage}),r=await runDummyProbe({openClient:()=>f.db});
  assert.equal(r.status,'FAIL');assert.equal(r.phase,stage.name);assert.equal(r.code,'PG_QUERY_READ_TIMEOUT');assert.equal(f.queries.at(-1),dummySql(stage));
  assert.equal(f.queries.includes('ROLLBACK'),false);assert.equal(f.destroyed(),true);assert.equal(f.closed(),true);
  assert.equal(eligibleForMss(r),!['single128','single512'].includes(stage.name));
 }
});
test('corrupt payload is not a network-size diagnosis; rollback does not hide rejection',async()=>{
 const f=fixture({corrupt:true}),r=await runDummyProbe({openClient:()=>f.db});
 assert.equal(r.status,'FAIL');assert.equal(r.code,'T31_DUMMY_RESPONSE_INVALID');assert.equal(eligibleForMss(r),false);assert.equal(f.queries.at(-1),'ROLLBACK');
});
test('only allowlisted TCP metrics escape raw ss output',()=>{
 const r=parseTcpInfo('ESTAB PRIVATE_ENDPOINT:6543 SECRET\n cubic rto:225 rtt:10.5/4 mss:1448 rcvmss:1448 advmss:1460 bytes_received:12345 bytes_acked:321 segs_out:22 segs_in:20 unacked:0');
 assert.equal(r.status,'AVAILABLE');assert.deepEqual(r.metrics,{mss:1448,rcvmss:1448,advmss:1460,rto:225,bytes_received:12345,bytes_acked:321,segs_out:22,segs_in:20,unacked:0});
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE|SECRET|6543/);
 assert.deepEqual(parseTcpInfo(''),{status:'UNAVAILABLE',metrics:{}});
});
