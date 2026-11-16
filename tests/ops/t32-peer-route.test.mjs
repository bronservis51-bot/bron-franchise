import test from 'node:test';
import assert from 'node:assert/strict';
import {validateT31Evidence,runPeerRouteExperiment,tcpComparison,T31_RESULT_SHA} from '../../docs/runbooks/payloads/t32-peer-route.mjs';
import {SOURCE_HOST,dummyStages,planPeerRoute} from '../../docs/runbooks/payloads/t31-source-network.mjs';
const peer='34.215.156.231';
const evidence=()=>({task:'T31',status:'BLOCKED',routeStatus:'UNCHANGED',retainedRoute:false,canonicalHost:SOURCE_HOST,
 selectedPeerIPv4:peer,resolvedAddresses:[peer],baseline:{status:'FAIL',phase:'single512',code:'PG_QUERY_READ_TIMEOUT',
 steps:[{step:'single128',status:'PASS'},{step:'single512',status:'FAIL',code:'PG_QUERY_READ_TIMEOUT'}]}});
test('distinct T32 activation requires exact reviewed T31 failure and unchanged route',()=>{
 assert.equal(T31_RESULT_SHA,'a4fa63fc4c269781c3c7062b9ba32cc67ef6174e09b4571ef104f32fcab7be99');
 assert.deepEqual(validateT31Evidence(evidence()),{canonicalHost:SOURCE_HOST,address:peer,resolvedAddresses:[peer]});
 for(const patch of [{task:'T30'},{status:'PASS'},{retainedRoute:true},{routeStatus:'ADD_INTENT'},
  {selectedPeerIPv4:'1.1.1.1'},{canonicalHost:'evil.invalid'},{resolvedAddresses:[]},{mitigated:{status:'FAIL'}},{transport:'baseline'},{routePlan:{}}])
  assert.throws(()=>validateT31Evidence({...evidence(),...patch}),{code:'T32_T31_EVIDENCE_NOT_EXACT'});
 for(const patch of [{phase:'single128'},{code:'57014'},{steps:[]},{status:'PASS'}])
  assert.throws(()=>validateT31Evidence({...evidence(),baseline:{...evidence().baseline,...patch}}),{code:'T32_T31_EVIDENCE_NOT_EXACT'});
});
const routeGet={dst:peer,gateway:'152.228.115.1',dev:'ens3',prefsrc:'152.228.115.115'};
const makePlan=()=>planPeerRoute({peer,exactRoutes:[],routeGet:[routeGet]});
const goodProbe=()=>({status:'PASS',bulkBytes:1048576,steps:[...dummyStages.map(s=>({step:s.name,status:'PASS'})),{step:'rollback',status:'PASS'}],tcpInfo:{status:'AVAILABLE',metrics:{mss:1200}}});
function harness({result=goodProbe(),addLostResponse=false,drift=false,persistFailure=null}={}){
 const plan=makePlan(),events=[];let current=[],mayExist=false;
 const item={dst:peer+'/32',gateway:plan.gateway,dev:plan.dev,prefsrc:plan.source,metric:plan.metric,metrics:{mtu:1280,advmss:1200}};
 const args={plan,observe:async()=>{events.push('observe');return current;},
  add:async()=>{events.push('add');current=[{...item}];if(addLostResponse)throw Object.assign(new Error('safe'),{code:'T32_ADD_RESPONSE_LOST'});},
  remove:async()=>{events.push('remove');current=[];},
  persist:async action=>{events.push('persist:'+action);if(action===persistFailure)throw new Error('PRIVATE_PERSIST_FAILURE');},
  onMayExist:value=>{mayExist=value;},
  probe:async()=>{events.push('probe');if(drift)current=[{...item,metric:99}];return result;}};
 return{args,events,current:()=>current,mayExist:()=>mayExist};
}
test('one full reused probe retains only the exact temporary route; before-image and inverse precede add',async()=>{
 const h=harness(),r=await runPeerRouteExperiment(h.args);
 assert.equal(r.status,'PASS');assert.equal(r.retainedRoute,true);assert.equal(h.current().length,1);assert.equal(h.mayExist(),true);
 assert.deepEqual(h.events.slice(0,3),['persist:before-image','persist:add-intent','add']);
 assert.equal(h.events.filter(e=>e==='add').length,1);assert.equal(h.events.filter(e=>e==='probe').length,1);assert.equal(h.events.includes('remove'),false);
});
test('failed or incomplete probe removes route and confirms absence; never manufactures PASS',async()=>{
 for(const result of [{status:'FAIL',phase:'single512',code:'PG_QUERY_READ_TIMEOUT',steps:[]},
  {...goodProbe(),bulkBytes:0},{...goodProbe(),steps:[]},{...goodProbe(),steps:[...goodProbe().steps,{step:'rollback',status:'FAIL'}]}]){
  const h=harness({result}),r=await runPeerRouteExperiment(h.args);
  assert.equal(r.status,'BLOCKED');assert.equal(r.retainedRoute,false);assert.deepEqual(h.current(),[]);assert.equal(h.mayExist(),false);
  assert.deepEqual(h.events.slice(-3),['remove','observe','persist:restored']);
 }
});
test('ambiguous add is reconciled and removed without repeating mutation',async()=>{
 const h=harness({addLostResponse:true});
 await assert.rejects(runPeerRouteExperiment(h.args),{code:'T32_ADD_RESPONSE_LOST'});
 assert.deepEqual(h.current(),[]);assert.equal(h.events.filter(e=>e==='add').length,1);assert.equal(h.events.includes('probe'),false);
});
test('drift prevents deleting unrelated route and leaves explicit reconciliation state',async()=>{
 const h=harness({result:{status:'FAIL',steps:[]},drift:true});
 await assert.rejects(runPeerRouteExperiment(h.args),{code:'T32_ROUTE_CHANGED_CLEANUP_REQUIRED'});
 assert.equal(h.current()[0].metric,99);assert.equal(h.events.includes('remove'),false);assert.equal(h.mayExist(),true);
});
test('passing dummy cannot retain or authorize Auth after concurrent route drift',async()=>{
 const h=harness({drift:true});
 await assert.rejects(runPeerRouteExperiment(h.args),{code:'T32_ROUTE_CHANGED_CLEANUP_REQUIRED'});
 assert.equal(h.current()[0].metric,99);assert.equal(h.events.includes('remove'),false);
 assert.equal(h.events.includes('persist:verified-improvement'),false);assert.equal(h.mayExist(),true);
});
test('before-image failure has no route effect; post-add persistence failure invokes exact inverse',async()=>{
 const before=harness({persistFailure:'before-image'});await assert.rejects(runPeerRouteExperiment(before.args));
 assert.equal(before.events.includes('add'),false);assert.deepEqual(before.current(),[]);
 const after=harness({persistFailure:'added'});await assert.rejects(runPeerRouteExperiment(after.args));
 assert.deepEqual(after.current(),[]);assert.equal(after.events.includes('probe'),false);assert.equal(after.events.includes('remove'),true);
});
test('safe TCP comparison reports changed/unchanged/unavailable numeric metrics without raw ss text',()=>{
 const r=tcpComparison({metrics:{mss:1448,rto:6656,unacked:1}},{metrics:{mss:1200,rto:200,unacked:1}});
 assert.deepEqual(r.mss,{before:1448,after:1200,change:'CHANGED'});assert.equal(r.unacked.change,'UNCHANGED');assert.equal(r.advmss.change,'UNAVAILABLE');
 assert.doesNotMatch(JSON.stringify(tcpComparison({metrics:{mss:'PRIVATE'}},{metrics:{mss:NaN}})),/PRIVATE|SELECT|AGE-/);
});
