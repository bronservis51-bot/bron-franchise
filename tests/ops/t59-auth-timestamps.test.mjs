import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {authRowsSql,validateAuthRows,authRowsPlan,guardedUpdateSql}
 from '../../docs/runbooks/payloads/t59-auth-timestamps.mjs';

const clone=structuredClone,id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const stamp='2026-11-15 12:00:00.000001+00',micros='1794744000000001';
const older='2026-11-15 12:00:00+00',olderMicros='1794744000000000';
const newer='2026-11-15 12:00:00.000002+00',newerMicros='1794744000000002';
const rows=(count=16)=>Array.from({length:count},(_,n)=>({private_id:id(n+1),private_stamp:stamp,
 private_micros:micros,private_sign_in_stamp:stamp,private_sign_in_micros:micros,
 private_other:createHash('sha256').update('SYNTHETIC_OTHER_'+n).digest('hex')}));
const setUpdated=(row,value,epoch)=>{row.private_stamp=value;row.private_micros=epoch;};
const setSignin=(row,value,epoch)=>{row.private_sign_in_stamp=value;row.private_sign_in_micros=epoch;};

test('fixed capture exposes only the two permitted timestamp values and a digest',()=>{
 assert.match(authRowsSql,/FROM auth\.users u ORDER BY u\.id LIMIT 17$/);
 assert.match(authRowsSql,/u\.last_sign_in_at::text AS private_sign_in_stamp/);
 assert.match(authRowsSql,/to_jsonb\(u\).*'updated_at'.*'last_sign_in_at'/);
 assert.doesNotMatch(authRowsSql,/SELECT\s+u\.\*|encrypted_password\s+AS|email\s+AS/i);
 assert.match(guardedUpdateSql,/UPDATE auth\.users AS u SET /);
 assert.match(guardedUpdateSql,/updated_at\s*=\s*\$1::timestamptz/);
 assert.match(guardedUpdateSql,/last_sign_in_at\s*=\s*\$2::timestamptz/);
 assert.match(guardedUpdateSql,/IS NOT DISTINCT FROM \$4::timestamptz/);
 assert.match(guardedUpdateSql,/IS NOT DISTINCT FROM \$5::timestamptz/);
 assert.doesNotMatch(guardedUpdateSql,/SET[^]*encrypted_password\s*=|DELETE|INSERT/i);
});

test('validation bounds each exact compact row, order, timestamps and digest',()=>{
 assert.equal(validateAuthRows(rows()).length,16);
 for(const change of [r=>r.push({...r[0],private_id:id(17)}),r=>r[0].raw_password='PRIVATE',
  r=>r[0].private_sign_in_micros=null,r=>r[0].private_micros='bad',r=>r[0].private_other='bad',
  r=>r[0].private_sign_in_stamp='x'.repeat(129),r=>r[1].private_id=r[0].private_id,
  r=>r.reverse(),r=>delete r[0].private_sign_in_stamp]){
  const value=rows();change(value);assert.throws(()=>validateAuthRows(value));
 }
 const nullable=rows();setUpdated(nullable[0],null,null);setSignin(nullable[1],null,null);
 assert.equal(validateAuthRows(nullable).length,16);
});

test('equal capture yields a zero-change plan with no private values',()=>{
 const source=rows(),p=authRowsPlan(source,clone(source));
 assert.equal(p.sourceRows,16);assert.equal(p.targetRows,16);assert.equal(p.changedMatchedRows,0);
 assert.equal(p.changedTimestampRows,0);assert.equal(p.updatedAtChangedRows,0);
 assert.equal(p.lastSignInChangedRows,0);assert.equal(p.otherChangedRows,0);
 assert.equal(p.canReconcileTwoTimestamps,true);
 const text=JSON.stringify(p);for(const row of source){
  assert(!text.includes(row.private_id));assert(!text.includes(row.private_other));assert(!text.includes(row.private_stamp));
 }
 assert.doesNotMatch(text,/private_|authRows/);
});

test('two timestamp differences in one row count as one bounded update',()=>{
 const source=rows(),target=clone(source);setUpdated(target[0],older,olderMicros);setSignin(target[0],newer,newerMicros);
 let p=authRowsPlan(source,target);assert.equal(p.changedMatchedRows,1);assert.equal(p.changedTimestampRows,1);
 assert.equal(p.updatedAtChangedRows,1);assert.equal(p.lastSignInChangedRows,1);assert.equal(p.otherChangedRows,0);
 assert.equal(p.canReconcileTwoTimestamps,true);
 setSignin(target[1],null,null);p=authRowsPlan(source,target);
 assert.equal(p.changedTimestampRows,2);assert.equal(p.updatedAtChangedRows,1);assert.equal(p.lastSignInChangedRows,2);
 assert.equal(p.canReconcileTwoTimestamps,true);
});

test('Source-authoritative comparison retains older, newer and null cases for explicit core consent',()=>{
 for(const [value,epoch]of [[older,olderMicros],[newer,newerMicros],[null,null]]){
  const source=rows(),target=clone(source);setUpdated(target[0],value,epoch);setSignin(source[1],value,epoch);
  const p=authRowsPlan(source,target);assert.equal(p.changedTimestampRows,2);
  assert.equal(p.canReconcileTwoTimestamps,true);assert.equal(p.otherChangedRows,0);
 }
});

test('other-field or UUID-membership differences cannot enter timestamp reconciliation',()=>{
 const source=rows(),other=clone(source);other[0].private_other='f'.repeat(64);
 let p=authRowsPlan(source,other);assert.equal(p.otherChangedRows,1);assert.equal(p.canReconcileTwoTimestamps,false);
 const membership=clone(source);membership[15].private_id=id(17);p=authRowsPlan(source,membership);
 assert.equal(p.sourceOnlyRows,1);assert.equal(p.targetOnlyRows,1);assert.equal(p.canReconcileTwoTimestamps,false);
});

test('microsecond equality cannot hide inconsistent textual encodings',()=>{
 for(const key of ['private_stamp','private_sign_in_stamp']){
  const source=rows(),target=clone(source);target[0][key]=stamp.replace('+00','+00:00');
  assert.throws(()=>authRowsPlan(source,target));
 }
});

test('actual PostgreSQL SQL preserves exact microseconds/nulls and changes only the two timestamps',
 {timeout:30000},async()=>{
 const db=new PGlite();
 try{
  await db.exec(`CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,updated_at timestamptz,
   last_sign_in_at timestamptz,email text,encrypted_password text,raw_user_meta_data jsonb)`);
  await db.query(`INSERT INTO auth.users VALUES($1::uuid,$2::timestamptz,$3::timestamptz,$4,$5,$6::jsonb)`,
   [id(1),stamp,newer,'fictional@invalid.test','FICTIONAL_PASSWORD_HASH',JSON.stringify({role:'fictional',n:10})]);
  const capture=async()=>{await db.exec("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;SET LOCAL timezone='UTC';SET LOCAL search_path=pg_catalog");
   try{return clone(validateAuthRows((await db.query(authRowsSql)).rows));}finally{await db.exec('ROLLBACK');}};
  const source=await capture();assert.equal(source[0].private_micros,micros);
  assert.equal(source[0].private_sign_in_micros,newerMicros);
  assert.doesNotMatch(JSON.stringify(source),/FICTIONAL_PASSWORD_HASH|fictional@invalid/);
  await db.query('UPDATE auth.users SET updated_at=$1::timestamptz,last_sign_in_at=NULL',[newer]);
  let target=await capture();assert.equal(target[0].private_other,source[0].private_other);
  assert.equal(target[0].private_sign_in_stamp,null);assert.equal(target[0].private_sign_in_micros,null);
  const otherBefore=await db.query('SELECT email,encrypted_password,raw_user_meta_data FROM auth.users');
  const update=async(s,t)=>db.query(guardedUpdateSql,[s.private_stamp,s.private_sign_in_stamp,s.private_id,
   t.private_stamp,t.private_sign_in_stamp,t.private_other]);
  await db.exec('BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE');
  let changed=await update(source[0],target[0]);assert.equal(changed.rows.length,1);await db.exec('COMMIT');
  assert.deepEqual(await capture(),source);
  assert.deepEqual((await db.query('SELECT email,encrypted_password,raw_user_meta_data FROM auth.users')).rows,otherBefore.rows);
  // A retry of the stale old-image predicate must affect no row.
  changed=await update(source[0],target[0]);assert.equal(changed.rows.length,0);
  // A concurrent change outside the two timestamps must fail the full-other digest guard.
  target=await capture();await db.query('UPDATE auth.users SET encrypted_password=$1',['FICTIONAL_CONCURRENT_HASH']);
  changed=await update(source[0],target[0]);assert.equal(changed.rows.length,0);
  // With freshly captured rows, copying Source NULLs is deliberate and null-safe.
  const current=await capture(),nullSource=clone(current[0]);setUpdated(nullSource,null,null);setSignin(nullSource,null,null);
  changed=await update(nullSource,current[0]);assert.equal(changed.rows.length,1);
  const nulled=await capture();assert.equal(nulled[0].private_stamp,null);assert.equal(nulled[0].private_sign_in_stamp,null);
 }finally{await db.close();}
});
