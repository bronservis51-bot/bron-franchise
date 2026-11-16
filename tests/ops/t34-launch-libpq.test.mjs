import test from 'node:test';
import assert from 'node:assert/strict';
import {activationFromEvidence} from '../../docs/runbooks/payloads/t34-launch-libpq.mjs';
const prior=()=>({task:'T33',status:'BLOCKED',transport:'baseline',retainedRoute:false,
 canonicalHost:'aws-1-us-west-2.pooler.supabase.com',resolvedAddresses:['34.215.156.231','44.225.139.66','44.252.246.120'],
 attempts:['44.225.139.66','44.252.246.120'].map(peerIPv4=>({peerIPv4,status:'FAIL',phase:'single512',code:'PG_QUERY_READ_TIMEOUT',steps:[{step:'single128',status:'PASS'}]}))});
const target=()=>({id:'51071996d381fbfa6a1b6c530045881a5cee6a8c82ee482d83bbf8b47ccf8117',image:'sha256:'+'a'.repeat(64),running:true});
test('fixed activation binds closed T33 evidence, existing target image and short expiry without secrets',()=>{
 const now=Date.parse('2026-11-14T02:00:00Z'),m=activationFromEvidence(prior(),target(),now);
 assert.equal(m.address,'34.215.156.231');assert.equal(m.targetImage,target().image);assert.equal(m.expiresUtc,'2026-11-14T03:00:00.000Z');
 assert.equal(m.task,'SOURCE_LIBPQ_SYNTHETIC_V1');assert.doesNotMatch(JSON.stringify(m),/password|secret|token|auth\.users/i);
 for(const patch of [{task:'T32'},{status:'PASS'},{retainedRoute:true},{transport:'temporary'},{selectedPeerIPv4:'44.225.139.66'},
  {resolvedAddresses:[]},{attempts:[]},{attempts:[prior().attempts[0],prior().attempts[0]]}])
   assert.throws(()=>activationFromEvidence({...prior(),...patch},target(),now),{code:'T34_PRIOR_EVIDENCE_MISMATCH'});
 for(const patch of [{id:'a'.repeat(64)},{image:'postgres:17'},{running:false}])
   assert.throws(()=>activationFromEvidence(prior(),{...target(),...patch},now),{code:'T34_TARGET_IMAGE_IDENTITY'});
});
