import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {authRowsPlan,captureAuthRows,authRowsSql,directSourceConfig} from '../../docs/runbooks/payloads/t30-auth-compact.mjs';
const id=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const row=(n,micros='1794614400000001',other='{"large":9007199254740993,"private":"PRIVATE_VALUE"}')=>({private_id:id(n),private_micros:micros,private_stamp:micros===null?null:'PRIVATE_TIME_'+micros,private_other:createHash('sha256').update(other).digest('hex')});
test('source route is direct VPS-to-canonical6543, preserving TLS/callback without Mac fallback',()=>{
 const host='aws-1-us-west-2.pooler.supabase.com',password=async()=> 'PRIVATE_PASSWORD';
 const ssl={rejectUnauthorized:true,servername:host,ca:Buffer.from('PRIVATE_CA'),checkServerIdentity:()=>{}};
 const base={host:'127.0.0.1',port:15432,database:'postgres',user:'postgres.vkkqffvmztpzgygzfxhq',password,ssl,options:'PRIVATE_STARTUP_OPTIONS'};
 const direct=directSourceConfig(base);assert.equal(direct.host,host);assert.equal(direct.port,6543);
 assert.equal(direct.password,password);assert.equal(direct.ssl,ssl);assert.equal(direct.options,undefined);
 assert.equal(base.port,15432);assert.equal(direct.connectionTimeoutMillis,15000);assert.equal(direct.query_timeout,20000);
 for(const patch of [{host:'evil.invalid'},{port:6543},{connectionString:'PRIVATE_URL'},
   {ssl:{...ssl,rejectUnauthorized:false}},{ssl:{...ssl,servername:'evil.invalid'}}])
  assert.throws(()=>directSourceConfig({...base,...patch}),{code:'AUTH_PLAN_SOURCE_CONFIG_UNSAFE'});
});
test('one microsecond source-newer timestamp is classified exactly with no values or apply permission',()=>{
 const plan=authRowsPlan([row(1)],[row(1,'1794614400000000')]);
 assert.equal(plan.changedUpdatedOnlyRows,1);assert.equal(plan.sourceNewerRows,1);assert.equal(plan.targetNewerRows,0);
 assert.equal(plan.canReconcileTimestampOnly,true);assert.equal(plan.applyAuthorized,false);assert.equal(plan.finalFreezeAudit,false);
 assert.deepEqual(plan.columns,[{name:'updated_at',rows:1}]);assert.doesNotMatch(JSON.stringify(plan),/PRIVATE_|1794614|9007199|00000000-/);
});
test('target-newer/null/missing/other-field changes block timestamp-only plan losslessly',()=>{
 const examples=[[[row(1,'1794614400000000')],[row(1)],'targetNewerRows'],
  [[row(1,null)],[row(1)],'nullTimestampChangedRows'],[[row(1)],[row(2)],'sourceOnlyRows'],
  [[row(1)],[row(1,undefined,'{"large":9007199254740992,"private":"PRIVATE_VALUE"}')],'otherChangedRows']];
 for(const [a,b,field] of examples){const p=authRowsPlan(a,b);assert.equal(p[field],1);assert.equal(p.canReconcileTimestampOnly,false);}
 const p=authRowsPlan([row(1)],[row(1)]);assert.equal(p.changedMatchedRows,0);assert.equal(p.nextCondition,'NO_RECONCILIATION_NEEDED');
});
test('capture rejects duplicate/oversize/malformed records before any unsafe report',()=>{
 assert.throws(()=>authRowsPlan([row(1),row(1)],[]),{code:'AUTH_PLAN_DUPLICATE_ID'});
 assert.throws(()=>authRowsPlan(Array.from({length:65},(_,n)=>row(n)),[]),{code:'AUTH_PLAN_ROW_LIMIT'});
 assert.throws(()=>authRowsPlan([{...row(1),private_other:'x'.repeat(1048577)}],[]),{code:'AUTH_PLAN_BYTE_LIMIT'});
 assert.throws(()=>authRowsPlan([{...row(1),private_micros:1794614400000001}],[]),{code:'AUTH_PLAN_CAPTURE_INVALID'});
});
test('capture enforces actual readonly repeatable-read, SQL timestamp text and rollback',async()=>{
 const queries=[];let verified=false;
 const db={query:async q=>{queries.push(q);return {rows:q===authRowsSql?[row(1)]:[]};}};
 const result=await captureAuthRows(db,async()=>{verified=true;assert.match(queries[0],/REPEATABLE READ READ ONLY/);});
 assert.equal(verified,true);assert.equal(result.rows.length,1);assert.equal(queries.at(-1),'ROLLBACK');
 assert.match(authRowsSql,/numeric\(30,0\)::text/);assert.match(authRowsSql,/to_jsonb\(u\)-'updated_at'/);
});
test('client deadline disconnects its stream without queuing rollback',async()=>{
 const queries=[];let destroyed=false;
 const db={connection:{stream:{destroy:()=>{destroyed=true;}}},query:async q=>{queries.push(q);if(q===authRowsSql)throw new Error('Query read timeout');return{rows:[]};}};
 await assert.rejects(captureAuthRows(db));assert.equal(destroyed,true);assert.equal(queries.includes('ROLLBACK'),false);
});

test('production cohort >16 is rejected and rollback cannot mask first error',async()=>{
 let calls=0;const original=Object.assign(new Error('ORIGINAL'),{code:'AUTH_PLAN_PRIMARY'});
 const db={query:async q=>{if(q===authRowsSql)throw original;if(q==='ROLLBACK')throw new Error('SECONDARY');return {rows:[]};}};
 await assert.rejects(captureAuthRows(db),e=>e===original&&e.authStep==='authRows');
 const oversized={query:async q=>({rows:q===authRowsSql?Array.from({length:17},(_,n)=>row(n)):[]})};
 await assert.rejects(captureAuthRows(oversized),{code:'AUTH_PLAN_PRODUCTION_COHORT_LIMIT'});
 assert.match(authRowsSql,/LIMIT 17$/);assert.match(authRowsSql,/pg_catalog.sha256/);
});
