import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRestoreFailure,globalsStatementClass,globalsStandardRoles} from '../../docs/runbooks/payloads/t11-restore-target.mjs';

test('diagnostics expose SQLSTATE and fixed class, never private SQL or password material',()=>{
  const secret='SCRAM-SHA-256$PRIVATE_HASH_MUST_NOT_ESCAPE';
  const raw='psql:<stdin>:18: ERROR: 42501: "supabase_auth_admin" is a reserved role, only superusers can modify it\n'
    +'STATEMENT: ALTER ROLE supabase_auth_admin PASSWORD '+secret+';';
  const result=classifyRestoreFailure(raw);
  assert.deepEqual(result,{diagnostic:'RESERVED_ROLE',sqlstate:'42501',statementLine:18});
  assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(JSON.stringify(result).includes('supabase_auth_admin'),false);
});
test('native role and parameter permissions are distinguished from reserved-role enforcement',()=>{
  assert.equal(classifyRestoreFailure('ERROR: 42501: permission denied to alter role').diagnostic,'ROLE_PERMISSION');
  assert.equal(classifyRestoreFailure('ERROR: 42501: permission denied to set parameter "secret"').diagnostic,'PARAMETER_PERMISSION');
  assert.equal(classifyRestoreFailure('ERROR: 42501: must be superuser to alter superuser roles').diagnostic,'SUPERUSER_REQUIRED');
});
test('private SQL context cannot change the error classification',()=>{
  assert.deepEqual(classifyRestoreFailure('ERROR: 42501: permission denied\nSTATEMENT: SELECT \'reserved role\';'),
    {diagnostic:'PERMISSION',sqlstate:'42501',statementLine:null});
});
test('failed globals statement classification never returns identifiers or password values',()=>{
  const script='CREATE ROLE internal_user;\nALTER ROLE internal_user PASSWORD \'private-secret\';\nSET ROLE internal_user;';
  assert.equal(globalsStatementClass(script,1),'CREATE_ROLE');
  assert.equal(globalsStatementClass(script,2),'ALTER_ROLE');
  assert.equal(globalsStatementClass(script,3),'SET_ROLE');
  assert.equal(globalsStatementClass(script,null),'UNAVAILABLE');
});
test('failed line exposes only fixed standard role tokens and ignores password string contents',()=>{
  const script='GRANT supabase_admin TO "private_customer_role" GRANTED BY postgres;\n'
    +"ALTER ROLE authenticator PASSWORD 'anon service_role PRIVATE_SECRET';";
  assert.deepEqual(globalsStandardRoles(script,1),['postgres','supabase_admin']);
  assert.deepEqual(globalsStandardRoles(script,2),['authenticator']);
  assert.deepEqual(globalsStandardRoles('ALTER ROLE private_name LOGIN;',1),['OTHER']);
});
