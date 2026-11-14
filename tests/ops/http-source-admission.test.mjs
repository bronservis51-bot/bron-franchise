import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeHttpAdmissionPlan,validateFreshOwnerWitness} from '../../docs/runbooks/payloads/http-source-admission.mjs';

const activation={reviewed:true,actionId:'T99.http_source_admission',manifestSha256:'a'.repeat(64),
  beforeImageSha256:'b'.repeat(64),beforeImageDurableOnVps:true,providerBoundaryReviewed:true,
  independentKeyProved:true,rollbackBeforeTargetWrites:true,targetWritesStarted:false};
const role=(name,extra={})=>({name,super:false,login:false,createRole:false,createDb:false,
  replication:false,bypass:false,connect:true,ownerPath:false,...extra});
const before={db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',signal:true,
  acl:['PUBLIC','dashboard_user','postgres'].map(grantee=>({grantee,grantor:'postgres',privilege:'CONNECT',grantable:false})),
  roles:[role('postgres',{login:true,ownerPath:true}),role('dashboard_user',{ownerPath:true}),
    role('pgbouncer',{login:true}),role('authenticator',{login:true})],
  backends:[{pid:100,role:'postgres'}],lookupCriticalWrites:0,lookupSequenceWrites:0,
  lookupCriticalDefiners:0,lookupOtherSetRoles:0,prepared:0,netQueued:0,unexpectedActiveCron:0,runJobsExists:false};
const boundary={capturedMicros:'1794612345123456',ownerPids:[101]};
const witness={db:'postgres',actor:'postgres',session:'postgres',owner:'postgres',readOnly:'on',
  pid:102,backendStartMicros:'1794612345123457'};

test('refuses preparation without durable before-image, recovery permission or pre-target boundary',()=>{
  for(const change of [{reviewed:false},{beforeImageDurableOnVps:false},{independentKeyProved:false},
    {rollbackBeforeTargetWrites:false},{targetWritesStarted:true},{manifestSha256:'missing'}]){
    assert.throws(()=>makeHttpAdmissionPlan({activation:{...activation,...change},before}),{code:'HTTP_ADMISSION_DRAFT_NOT_REVIEWED'});
  }
});
test('provider lookup write capability or an owner-membership escape refuses plan creation',()=>{
  assert.throws(()=>makeHttpAdmissionPlan({activation,before:{...before,lookupCriticalDefiners:1}}),{code:'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND'});
  const escaped=structuredClone(before);escaped.roles.push(role('rogue',{login:true,ownerPath:true}));
  assert.throws(()=>makeHttpAdmissionPlan({activation,before:escaped}),{code:'HTTP_ADMISSION_ROLE_ESCAPE'});
});
test('provider lookup cannot SET another role even when NOINHERIT hides its data privileges',()=>{
  const escaped=structuredClone(before);escaped.lookupOtherSetRoles=1;
  escaped.roles.push(role('lookup_set_target',{connect:false}));
  assert.throws(()=>makeHttpAdmissionPlan({activation,before:escaped}),{code:'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND'});
  for(const lookupOtherSetRoles of [undefined,null,-1,'0',false]){
    assert.throws(()=>makeHttpAdmissionPlan({activation,before:{...before,lookupOtherSetRoles}}),
      {code:'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND'});
  }
});
test('lookup SET-role capability is checked before and after fencing and drain',()=>{
  const plan=makeHttpAdmissionPlan({activation,before});
  const check="(s->>'lookupOtherSetRoles')::bigint IS NOT DISTINCT FROM 0";
  assert.equal(plan.applySql.split(check).length-1,2);
  assert.equal(plan.drainSql.split(check).length-1,2);
  assert.equal(plan.verifyFencedSql.split(check).length-1,1);
  assert.match(plan.applySql,/GRANT CONNECT ON DATABASE postgres TO pgbouncer;/);
});
test('unreviewed original CONNECT ACL cannot be generalized by the inverse',()=>{
  const changed=structuredClone(before);changed.acl.push({grantee:'pgbouncer',grantor:'postgres',privilege:'CONNECT',grantable:false});
  assert.throws(()=>makeHttpAdmissionPlan({activation,before:changed}),{code:'HTTP_ADMISSION_BEFORE_ACL_UNEXPECTED'});
});
test('one-microsecond genuinely new physical backend is accepted without rounding',()=>{
  assert.deepEqual(validateFreshOwnerWitness({before,boundary,witness}),{
    freshOwnerReadonly:true,newPhysicalBackendAfterDrain:true,actualRouteRequiresVpsWitness:true});
});
test('a different PID on an old physical backend and a reused prior PID are rejected',()=>{
  for(const change of [{backendStartMicros:boundary.capturedMicros},{backendStartMicros:'1794612345123455'},
    {pid:100},{pid:101},{readOnly:'off'},{session:'authenticator'}]){
    assert.throws(()=>validateFreshOwnerWitness({before,boundary,witness:{...witness,...change}}),
      {code:'HTTP_ADMISSION_FRESH_PHYSICAL_BACKEND_NOT_PROVED'});
  }
});
test('missing post-drain boundary is not inferred from request start time',()=>{
  assert.throws(()=>validateFreshOwnerWitness({before,boundary:{ownerPids:[]},witness}),{code:'HTTP_ADMISSION_BOUNDARY_INVALID'});
});
