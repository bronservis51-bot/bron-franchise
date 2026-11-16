// Import-only and Deno-safe. Exact two-timestamp Auth reconciliation contract.
// Values/identifiers/digests remain in Source/VPS RAM; plans contain counters only.
export const AUTH_TIMESTAMP_COLUMNS=Object.freeze(['last_sign_in_at','updated_at']);
const fields=['private_id','private_stamp','private_micros','private_sign_in_stamp','private_sign_in_micros','private_other'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const pair=(stamp,micros)=>(stamp===null&&micros===null)||
 (typeof stamp==='string'&&stamp.length>=10&&stamp.length<=128&&typeof micros==='string'&&/^-?[0-9]{1,30}$/.test(micros));

export const authRowsSql=`SELECT u.id::text AS private_id,u.updated_at::text AS private_stamp,
 (extract(epoch FROM u.updated_at)*1000000)::numeric(30,0)::text AS private_micros,
 u.last_sign_in_at::text AS private_sign_in_stamp,
 (extract(epoch FROM u.last_sign_in_at)*1000000)::numeric(30,0)::text AS private_sign_in_micros,
 encode(pg_catalog.sha256(convert_to((to_jsonb(u)-'updated_at'-'last_sign_in_at')::text,'UTF8')),'hex') AS private_other
 FROM auth.users u ORDER BY u.id LIMIT 17`;

export const guardedUpdateSql=`UPDATE auth.users AS u SET updated_at=$1::timestamptz,last_sign_in_at=$2::timestamptz
 WHERE u.id=$3::uuid AND u.updated_at IS NOT DISTINCT FROM $4::timestamptz
 AND u.last_sign_in_at IS NOT DISTINCT FROM $5::timestamptz
 AND encode(pg_catalog.sha256(convert_to((to_jsonb(u)-'updated_at'-'last_sign_in_at')::text,'UTF8')),'hex')=$6
 RETURNING 1 AS changed`;

export function validateAuthRows(rows){
 if(!Array.isArray(rows)||rows.length>16)fail('T59_AUTH_COHORT_LIMIT');
 let last='',size=0;
 for(const r of rows){
  if(!exact(r,fields)||!uuid(r.private_id)||r.private_id<=last||!digest(r.private_other)||
   !pair(r.private_stamp,r.private_micros)||!pair(r.private_sign_in_stamp,r.private_sign_in_micros))fail('T59_AUTH_ROWS_INVALID');
  last=r.private_id;size+=JSON.stringify(r).length;
 }
 if(size>65536)fail('T59_AUTH_ROWS_BYTE_LIMIT');return rows;
}
function direction(source,target,p,prefix){
 if(source===target)return;
 if(source===null||target===null)p[prefix+'NullChangedRows']++;
 else if(BigInt(source)>BigInt(target))p[prefix+'SourceNewerRows']++;
 else p[prefix+'TargetNewerRows']++;
}

// This plan describes equality and direction only; caller must separately prove
// the fresh owner's permission to replace BOTH timestamps by Source values.
export function authRowsPlan(sourceRows,targetRows){
 validateAuthRows(sourceRows);validateAuthRows(targetRows);
 const a=new Map(sourceRows.map(r=>[r.private_id,r])),b=new Map(targetRows.map(r=>[r.private_id,r]));
 const p={diagnosticComplete:true,applyAuthorized:false,finalFreezeAudit:false,
  sourceRows:a.size,targetRows:b.size,sourceOnlyRows:0,targetOnlyRows:0,changedMatchedRows:0,
  changedTimestampRows:0,updatedAtChangedRows:0,lastSignInChangedRows:0,otherChangedRows:0,
  updatedAtSourceNewerRows:0,updatedAtTargetNewerRows:0,updatedAtNullChangedRows:0,
  lastSignInSourceNewerRows:0,lastSignInTargetNewerRows:0,lastSignInNullChangedRows:0};
 for(const[id,s]of a){
  const t=b.get(id);if(!t){p.sourceOnlyRows++;continue;}
  const updated=s.private_micros!==t.private_micros,signIn=s.private_sign_in_micros!==t.private_sign_in_micros;
  if(!updated&&s.private_stamp!==t.private_stamp||!signIn&&s.private_sign_in_stamp!==t.private_sign_in_stamp)
   fail('T59_AUTH_TIMESTAMP_ENCODING_MISMATCH');
  const other=s.private_other!==t.private_other;
  if(updated)p.updatedAtChangedRows++;if(signIn)p.lastSignInChangedRows++;
  if(updated||signIn)p.changedTimestampRows++;if(other)p.otherChangedRows++;
  if(updated||signIn||other)p.changedMatchedRows++;
  direction(s.private_micros,t.private_micros,p,'updatedAt');
  direction(s.private_sign_in_micros,t.private_sign_in_micros,p,'lastSignIn');
 }
 for(const id of b.keys())if(!a.has(id))p.targetOnlyRows++;
 p.canReconcileTwoTimestamps=p.sourceOnlyRows===0&&p.targetOnlyRows===0&&p.otherChangedRows===0;
 return p;
}
