import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyRestoreFailure,globalsStatementClass,globalsStandardRoles,instrumentGlobals,globalsRunSummary,nativeGlobalsConfig,prepareBootstrapGlobals} from '../../docs/runbooks/payloads/t11-restore-target.mjs';

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
test('native globals markers preserve source and work inside psql restricted mode',()=>{
  const script="\\restrict private_key\nCREATE ROLE anon;\nALTER ROLE anon PASSWORD 'SCRAM-private';\n\\unrestrict private_key\n";
  const marked=instrumentGlobals(script);
  assert.equal(marked.steps.length,2);
  assert.equal(marked.sql.includes('\\echo'),false);
  assert.equal(marked.sql.split('\n').filter(l=>!/^SELECT 'BRON_GLOBAL_STEP_\d+';$/.test(l)).join('\n'),script);
  assert.deepEqual(marked.steps[1],{marker:'BRON_GLOBAL_STEP_0002',statementLine:3,
    statementClass:'ALTER_ROLE',standardRoles:['anon']});
});
test('markers are never inserted into multiline strings, comments or dollar bodies',()=>{
  const script="SET custom.value = 'private\nCREATE ROLE hidden;\n';\n/*\nALTER ROLE hidden LOGIN;\n*/\n"
    +"SELECT $$\nCREATE ROLE another_secret;\n$$;\nCREATE ROLE authenticator;\n";
  const marked=instrumentGlobals(script);
  assert.equal(marked.steps.length,2);
  assert.equal(marked.steps[1].statementClass,'CREATE_ROLE');
  assert.deepEqual(marked.steps[1].standardRoles,['authenticator']);
});
test('native failure without psql line numbers identifies last reached statement without secrets',()=>{
  const marked=instrumentGlobals("CREATE ROLE anon;\nALTER ROLE anon PASSWORD 'PRIVATE_HASH';\n");
  const summary=globalsRunSummary({status:3,stdout:'BRON_GLOBAL_STEP_0001\nBRON_GLOBAL_STEP_0002\n',
    stderr:'ERROR: 42501: permission denied to alter role\nSTATEMENT: PRIVATE_HASH'},marked.steps);
  assert.equal(summary.statementLine,2);
  assert.equal(summary.statementClass,'ALTER_ROLE');
  assert.deepEqual(summary.standardRoles,['anon']);
  assert.equal(summary.sqlstate,'42501');
  assert.equal(JSON.stringify(summary).includes('PRIVATE_HASH'),false);
});
test('native bootstrap overrides only preloads while exact final security configuration stays intact',()=>{
  const exact="shared_preload_libraries = 'pg_cron, pg_net, supautils'\nsession_preload_libraries = 'supautils'\n"
    +"cron.launch_active_jobs = off\npg_net.batch_size = 0\n";
  const effective=text=>Object.fromEntries(text.trim().split('\n').map(line=>line.split(/\s*=\s*/)));
  const before=effective(exact),native=effective(nativeGlobalsConfig(exact));
  assert.equal(native.shared_preload_libraries,"''");
  assert.equal(native.session_preload_libraries,"''");
  assert.equal(native['cron.launch_active_jobs'],'off');
  assert.equal(native['pg_net.batch_size'],'0');
  assert.equal(before.shared_preload_libraries,"'pg_cron, pg_net, supautils'");
  assert.equal(before.session_preload_libraries,"'supautils'");
});
test('original bootstrap identity omits only its already executed bare CREATE and preserves every ALTER and GRANTED BY',()=>{
  const script="CREATE ROLE anon;\nCREATE ROLE \"supabase_admin\";\n"
    +"ALTER ROLE supabase_admin WITH SUPERUSER LOGIN PASSWORD 'SCRAM-private';\n"
    +"GRANT anon TO authenticator WITH INHERIT FALSE GRANTED BY supabase_admin;\n";
  const result=prepareBootstrapGlobals(script,'supabase_admin');
  assert.equal(result.bootstrapCreateSkipped,1);
  assert.equal(result.sql,script.replace('CREATE ROLE "supabase_admin";','-- BRON_INITIAL_BOOTSTRAP_ROLE_ALREADY_EXISTS'));
  assert.equal(result.sql.includes("PASSWORD 'SCRAM-private'"),true);
  assert.equal(result.sql.includes('GRANTED BY supabase_admin;'),true);
});
test('bootstrap role matching never edits string content or similarly named roles',()=>{
  const script="CREATE ROLE supabase_admin;\nALTER ROLE supabase_admin WITH SUPERUSER;\n"
    +"CREATE ROLE supabase_admin_helper;\nALTER ROLE anon PASSWORD 'CREATE ROLE supabase_admin;';\n";
  const result=prepareBootstrapGlobals(script,'supabase_admin');
  assert.equal(result.sql.includes('CREATE ROLE supabase_admin_helper;'),true);
  assert.equal(result.sql.includes("PASSWORD 'CREATE ROLE supabase_admin;'"),true);
});
test('missing bootstrap declaration or impossible PG17 bootstrap demotion is rejected',()=>{
  assert.throws(()=>prepareBootstrapGlobals('CREATE ROLE anon;\n','supabase_admin'),/ARCHIVED_BOOTSTRAP_ROLE_INVALID/);
  assert.throws(()=>prepareBootstrapGlobals('CREATE ROLE supabase_admin;\nALTER ROLE supabase_admin WITH NOSUPERUSER;\n',
    'supabase_admin'),/BOOTSTRAP_CANNOT_BE_NONSUPERUSER/);
});
