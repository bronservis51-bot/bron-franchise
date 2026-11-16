import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedNetworkResult} from '../../docs/runbooks/payloads/t32-auth-verified-peer.mjs';

const now=Date.parse('2026-11-14T01:00:00Z');
const good=()=>({task:'T32',status:'PASS',canonicalHost:'aws-1-us-west-2.pooler.supabase.com',
 resolvedAddresses:['44.231.9.24'],selectedPeerIPv4:'44.231.9.24',
 startedUtc:'2026-11-14T00:59:20Z',finishedUtc:'2026-11-14T00:59:40Z',transport:'baseline',retainedRoute:false});

test('only this task fresh full synthetic PASS admits Auth continuation',()=>{
 assert.deepEqual(verifiedNetworkResult(good(),now),good());
 assert.equal(verifiedNetworkResult({...good(),transport:'temporary-mtu1280-advmss1200',retainedRoute:true},now).retainedRoute,true);
 for(const patch of [{task:'T30'},{status:'FAIL'},{status:'RUNNING'},{canonicalHost:'example.com'},
  {resolvedAddresses:[]},{selectedPeerIPv4:'44.231.9.25'},{transport:'reverse'},
  {retainedRoute:true},{transport:'temporary-mtu1280-advmss1200',retainedRoute:false},
  {startedUtc:'invalid'},{finishedUtc:'2026-11-14T01:00:10Z'},
  {finishedUtc:'2026-11-14T00:40:00Z'},{startedUtc:'2026-11-14T00:59:50Z'}])
   assert.throws(()=>verifiedNetworkResult({...good(),...patch},now),{code:'T32_AUTH_NETWORK_PASS_REQUIRED'});
});
