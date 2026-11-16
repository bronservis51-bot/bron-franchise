import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AUTH_DIAGNOSTIC_SCHEMA,AUTH_DIAGNOSTIC_COLUMNS,authDiagnosticSessionSql,authCatalogColumnsSql,
 authRowsSql,authColumnFingerprintsSql,validateAuthColumns,validateAuthDiagnosticFrame,captureAuthDiagnostic,
 summarizeAuthDiagnostic} from '../../docs/runbooks/payloads/t58-auth-diagnostic-core.mjs';
import {authRowsSql as reviewedRowsSql,authRowsPlan} from '../../docs/runbooks/payloads/t30-auth-compact.mjs';
import {authRowsSql as sourceRowsSql} from '../../docs/runbooks/payloads/source-https-reader/auth-rows.mjs';

const clone=structuredClone,hash=x=>createHash('sha256').update(x).digest('hex');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const stamp='2026-11-15 12:00:00.000001+00',micros='1794744000000001';
const stampBefore='2026-11-15 12:00:00+00',microsBefore='1794744000000000';
const stampAfter='2026-11-15 12:00:00.000002+00',microsAfter='1794744000000002';
const schema=()=>AUTH_DIAGNOSTIC_SCHEMA.map(x=>({...x}));
const frame=(count=16)=>({authRows:Array.from({length:count},(_,n)=>({private_id:id(n+1),private_stamp:stamp,
 private_micros:micros,private_other:hash('SYNTHETIC_AUTH_OTHER_'+n)})),
 columnFingerprints:AUTH_DIAGNOSTIC_COLUMNS.map(name=>({name,row_count:count,hash:hash('SYNTHETIC_COLUMN_'+name)}))});
function changeColumn(value,name){value.columnFingerprints.find(r=>r.name===name).hash=hash('CHANGED_SYNTHETIC_'+name);}
const summarize=(a,b)=>summarizeAuthDiagnostic(a,b,{planAuthRows:authRowsPlan});

test('compact query remains byte-exact and SQL is fixed bounded Auth-only/catalog input',()=>{
 assert.equal(authRowsSql,reviewedRowsSql);assert.equal(authRowsSql,sourceRowsSql);
 assert.equal(AUTH_DIAGNOSTIC_COLUMNS.length,35);assert.equal(new Set(AUTH_DIAGNOSTIC_COLUMNS).size,35);
 assert.deepEqual(AUTH_DIAGNOSTIC_COLUMNS,[...AUTH_DIAGNOSTIC_COLUMNS].sort());
 for(const q of [authCatalogColumnsSql,authRowsSql,authColumnFingerprintsSql,authDiagnosticSessionSql]){
  assert.doesNotMatch(q,/\b(?:UPDATE|INSERT|DELETE|TRUNCATE|COPY|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i);
  assert.doesNotMatch(q,/\$[0-9]|public\.|app_private\./);
 }
 assert.match(authRowsSql,/LIMIT 17$/);assert.match(authColumnFingerprintsSql,/LIMIT 17/);
 assert.match(authColumnFingerprintsSql,/jsonb_each\(to_jsonb\(u\)\)/);
 assert.match(authColumnFingerprintsSql,/ORDER BY c\.id/);
});

test('schema whitelist rejects added, missing, renamed, duplicate or retyped columns',()=>{
 assert.equal(validateAuthColumns(schema()).length,35);
 for(const change of [s=>s.pop(),s=>s.push({name:'extra',type:'text'}),s=>s[0].name='other',
  s=>s[0].type='text',s=>s[0].raw_value='PRIVATE',s=>s[1]={...s[0]},s=>s.reverse()]){
  const value=schema();change(value);assert.throws(()=>validateAuthColumns(value),{code:'T58_AUTH_SCHEMA_CHANGED'});
 }
});

test('private frame accepts only bounded compact rows and35whole-column fingerprints',()=>{
 assert.equal(validateAuthDiagnosticFrame(frame()).authRows.length,16);
 assert.equal(validateAuthDiagnosticFrame(frame(0)).authRows.length,0);
 for(const change of [v=>v.authRows.push({...v.authRows[0],private_id:id(17)}),v=>v.extra='PRIVATE',
  v=>v.authRows[0].password='PRIVATE',v=>v.authRows[0].private_other='not_sha',
  v=>v.authRows[0].private_micros=null,v=>v.authRows[0].private_id=id(2),
  v=>v.authRows[0].private_stamp='x'.repeat(129),v=>v.authRows.reverse(),
  v=>v.columnFingerprints.pop(),v=>v.columnFingerprints[0].hash='not_sha',
  v=>v.columnFingerprints[0].raw_value='PRIVATE',v=>v.columnFingerprints[0].row_count=15,
  v=>v.columnFingerprints[0].row_count='16',v=>v.columnFingerprints[0].name='unknown',
  v=>v.columnFingerprints.reverse()]){
  const value=frame();change(value);assert.throws(()=>validateAuthDiagnosticFrame(value));
 }
});

test('safe equal summary is diagnosis only and does not expose private vectors',()=>{
 const a=frame(),out=summarize(a,clone(a));assert.equal(out.status,'DIAGNOSTIC_COMPLETE');
 assert.equal(out.sourceRows,16);assert.equal(out.changedMatchedRows,0);
 assert.equal(out.applyAuthorized,false);assert.equal(out.finalFreezeAudit,false);
 assert.equal(out.cohortCountsExpected,true);assert.equal(out.columnComparisonAvailable,true);
 assert.deepEqual(out.mismatchedColumns,[]);assert.deepEqual(out.blockers,[]);
 const raw=JSON.stringify(out);for(const r of a.authRows){assert(!raw.includes(r.private_id));assert(!raw.includes(r.private_other));assert(!raw.includes(r.private_stamp));}
 for(const r of a.columnFingerprints)assert(!raw.includes(r.hash));
 assert.doesNotMatch(raw,/private_|authRows|columnFingerprints/);
});

test('source-newer and target-newer timestamp directions remain distinguished',()=>{
 const source=frame(),target=clone(source);target.authRows[0].private_stamp=stampBefore;
 target.authRows[0].private_micros=microsBefore;changeColumn(target,'updated_at');
 let out=summarize(source,target);assert.equal(out.sourceNewerRows,1);assert.equal(out.targetNewerRows,0);
 assert.equal(out.changedUpdatedOnlyRows,1);assert.equal(out.canReconcileTimestampOnly,true);
 assert.deepEqual(out.mismatchedColumns,['updated_at']);assert.deepEqual(out.blockers,[]);
 target.authRows[0].private_stamp=stampAfter;target.authRows[0].private_micros=microsAfter;
 out=summarize(source,target);assert.equal(out.targetNewerRows,1);assert.equal(out.canReconcileTimestampOnly,false);
 assert.deepEqual(out.blockers,['TARGET_NEWER_TIMESTAMP']);
});

test('null timestamp mismatch is preserved as a separate blocker',()=>{
 const source=frame(),target=clone(source);target.authRows[0].private_stamp=null;target.authRows[0].private_micros=null;
 changeColumn(target,'updated_at');const out=summarize(source,target);
 assert.equal(out.nullTimestampChangedRows,1);assert.equal(out.sourceNewerRows,0);assert.equal(out.targetNewerRows,0);
 assert.deepEqual(out.blockers,['NULL_TIMESTAMP_DIFF']);assert.equal(out.canReconcileTimestampOnly,false);
});

test('other-field mismatch names columns without deriving per-user differences',()=>{
 const source=frame(),target=clone(source);target.authRows[0].private_other=hash('CHANGED_SYNTHETIC_OTHER');
 changeColumn(target,'encrypted_password');changeColumn(target,'last_sign_in_at');
 const out=summarize(source,target);assert.equal(out.otherChangedRows,1);assert.equal(out.changedUpdatedOnlyRows,0);
 assert.deepEqual(out.mismatchedColumns,['encrypted_password','last_sign_in_at']);
 assert.deepEqual(out.blockers,['OTHER_AUTH_FIELDS_DIFF']);assert.equal(out.canReconcileTimestampOnly,false);
 assert(!JSON.stringify(out).includes(target.authRows[0].private_other));
});

test('membership differences suppress misleading column differences and expected cohort is explicit',()=>{
 const source=frame(),target=clone(source);target.authRows[15].private_id=id(17);
 for(const c of target.columnFingerprints)changeColumn(target,c.name);
 const out=summarize(source,target);assert.equal(out.sourceOnlyRows,1);assert.equal(out.targetOnlyRows,1);
 assert.equal(out.columnComparisonAvailable,false);assert.equal(out.cohortMembershipEqual,false);
 assert.deepEqual(out.mismatchedColumns,[]);assert.deepEqual(out.blockers,['COHORT_MEMBERSHIP_DIFF']);
 const empty=summarize(frame(0),frame(0));assert.equal(empty.cohortCountsExpected,false);assert.equal(empty.expectedCohortRows,16);
});

test('inconsistent column/compact capture and malformed planner outputs are rejected',()=>{
 const a=frame(),b=clone(a);changeColumn(b,'raw_user_meta_data');
 assert.throws(()=>summarize(a,b),{code:'T58_AGGREGATE_PLAN_INCONSISTENT'});
 const c=clone(a);c.authRows[0].private_other=hash('OTHER');
 assert.throws(()=>summarize(a,c),{code:'T58_AGGREGATE_PLAN_INCONSISTENT'});
 assert.throws(()=>summarizeAuthDiagnostic(a,a),{code:'T58_REVIEWED_PLANNER_REQUIRED'});
 for(const update of [p=>p.sourceRows=17,p=>p.otherChangedRows='1',p=>p.applyAuthorized=true,
  p=>p.finalFreezeAudit=true,p=>p.canReconcileTimestampOnly='true']){
  assert.throws(()=>summarizeAuthDiagnostic(a,a,{planAuthRows:(x,y)=>{const p=authRowsPlan(x,y);update(p);return p;}}),
   {code:'T58_REVIEWED_PLANNER_RESULT_INVALID'});
 }
});

test('capture fails on non-RO session or schema drift before reading any Auth row',async()=>{
 for(const session of [{read_only:'off',isolation:'repeatable read',timezone:'UTC'},
  {read_only:'on',isolation:'read committed',timezone:'UTC'},{read_only:'on',isolation:'repeatable read',timezone:'Europe/Moscow'}]){
  const calls=[];await assert.rejects(captureAuthDiagnostic({query:async q=>{calls.push(q);return {rows:[session]};}}),
   {code:'T58_DIAGNOSTIC_READONLY_REQUIRED'});assert.deepEqual(calls,[authDiagnosticSessionSql]);
 }
 const calls=[];await assert.rejects(captureAuthDiagnostic({query:async q=>{calls.push(q);return {
  rows:q===authDiagnosticSessionSql?[{read_only:'on',isolation:'repeatable read',timezone:'UTC'}]:schema().slice(1)};}}),
  {code:'T58_AUTH_SCHEMA_CHANGED'});assert(!calls.includes(authRowsSql));
});

test('capture17rows fails before the column query',async()=>{
 const calls=[];await assert.rejects(captureAuthDiagnostic({query:async q=>{calls.push(q);return {
  rows:q===authDiagnosticSessionSql?[{read_only:'on',isolation:'repeatable read',timezone:'UTC'}]:q===authCatalogColumnsSql?
   schema():frame(17).authRows};}}),{code:'T58_AUTH_COHORT_LIMIT'});
 assert(!calls.includes(authColumnFingerprintsSql));
});

test('real PostgreSQL SQL retains null/types/order, catches columns and never returns raw values',{timeout:30000},async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE SCHEMA auth; CREATE TABLE auth.users('+AUTH_DIAGNOSTIC_SCHEMA.map(r=>'"'+r.name+'" '+r.type+(r.name==='id'?' PRIMARY KEY':'')).join(',')+')');
  const insert=async(n,raw)=>db.query(`INSERT INTO auth.users(id,updated_at,email,raw_user_meta_data,encrypted_password)
   VALUES($1::uuid,$2::timestamptz,$3,$4::jsonb,$5)`,[id(n),stamp,'synthetic'+n+'@invalid.test',JSON.stringify(raw),'SYNTHETIC_ONLY_PASSWORD_'+n]);
  await insert(2,{kind:'number',value:10,text:'line\n雪'});await insert(1,null);
  const capture=async()=>{await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL timezone='UTC';SET LOCAL search_path=pg_catalog");
   try{return clone(await captureAuthDiagnostic(db));}finally{await db.exec('ROLLBACK');}};
  const base=await capture();assert.equal(base.authRows.length,2);assert.equal(base.columnFingerprints.length,35);
  assert.equal(base.authRows[0].private_id,id(1));assert.equal(base.authRows[0].private_micros,micros);
  const raw=JSON.stringify(base);assert.doesNotMatch(raw,/SYNTHETIC_ONLY_PASSWORD|@invalid\.test|line|雪/);
  const reversed=await db.query('SELECT id FROM auth.users ORDER BY id DESC');assert.equal(reversed.rows[0].id,id(2));
  assert.deepEqual(await capture(),base);
  await db.query('UPDATE auth.users SET updated_at=$1::timestamptz WHERE id=$2::uuid',[stampBefore,id(1)]);
  let target=await capture(),out=summarize(base,target);assert.equal(out.sourceNewerRows,1);
  assert.deepEqual(out.mismatchedColumns,['updated_at']);
  await db.query('UPDATE auth.users SET raw_user_meta_data=$1::jsonb WHERE id=$2::uuid',[JSON.stringify('null'),id(1)]);
  target=await capture();out=summarize(base,target);assert.equal(out.otherChangedRows,1);
  assert.deepEqual(out.mismatchedColumns,['raw_user_meta_data','updated_at']);
  await db.query('UPDATE auth.users SET raw_user_meta_data=$1::jsonb WHERE id=$2::uuid',[JSON.stringify({kind:'number',value:'10',text:'line\n雪'}),id(2)]);
  const typed=await capture();assert.notEqual(typed.columnFingerprints.find(x=>x.name==='raw_user_meta_data').hash,
   target.columnFingerprints.find(x=>x.name==='raw_user_meta_data').hash);
  await db.exec('DELETE FROM auth.users');const empty=await capture();assert.equal(empty.authRows.length,0);
  assert.equal(empty.columnFingerprints.length,35);assert(empty.columnFingerprints.every(x=>x.row_count===0));
  assert.equal(summarize(empty,empty).cohortCountsExpected,false);
  for(let n=1;n<=17;n++)await insert(n,null);
  await assert.rejects(capture(),{code:'T58_AUTH_COHORT_LIMIT'});
  await db.exec('ALTER TABLE auth.users ADD unexpected_auth_column text');
  await assert.rejects(capture(),{code:'T58_AUTH_SCHEMA_CHANGED'});
 }finally{await db.close();}
});
