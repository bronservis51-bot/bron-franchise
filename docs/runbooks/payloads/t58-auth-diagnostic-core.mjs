// Pure, import-only Auth diagnosis. Transport/custody/consent remain caller-owned.
// Private compact rows and whole-column fingerprints must stay in VPS RAM.
const schema=[
 ['aud','character varying(255)'],['banned_until','timestamp with time zone'],
 ['confirmation_sent_at','timestamp with time zone'],['confirmation_token','character varying(255)'],
 ['confirmed_at','timestamp with time zone'],['created_at','timestamp with time zone'],
 ['deleted_at','timestamp with time zone'],['email','character varying(255)'],
 ['email_change','character varying(255)'],['email_change_confirm_status','smallint'],
 ['email_change_sent_at','timestamp with time zone'],['email_change_token_current','character varying(255)'],
 ['email_change_token_new','character varying(255)'],['email_confirmed_at','timestamp with time zone'],
 ['encrypted_password','character varying(255)'],['id','uuid'],['instance_id','uuid'],
 ['invited_at','timestamp with time zone'],['is_anonymous','boolean'],['is_sso_user','boolean'],
 ['is_super_admin','boolean'],['last_sign_in_at','timestamp with time zone'],['phone','text'],
 ['phone_change','text'],['phone_change_sent_at','timestamp with time zone'],
 ['phone_change_token','character varying(255)'],['phone_confirmed_at','timestamp with time zone'],
 ['raw_app_meta_data','jsonb'],['raw_user_meta_data','jsonb'],['reauthentication_sent_at','timestamp with time zone'],
 ['reauthentication_token','character varying(255)'],['recovery_sent_at','timestamp with time zone'],
 ['recovery_token','character varying(255)'],['role','character varying(255)'],['updated_at','timestamp with time zone'],
];
export const AUTH_DIAGNOSTIC_SCHEMA=Object.freeze(schema.map(([name,type])=>Object.freeze({name,type})));
export const AUTH_DIAGNOSTIC_COLUMNS=Object.freeze(schema.map(([name])=>name));
const MAX_ROWS=16,MAX_BYTES=65536;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x);
const boundedBytes=x=>{let raw;try{raw=JSON.stringify(x);}catch{fail('T58_FRAME_INVALID');}
 if(typeof raw!=='string'||new TextEncoder().encode(raw).length>MAX_BYTES)fail('T58_FRAME_BYTE_LIMIT');};

export const authDiagnosticSessionSql=`SELECT current_setting('transaction_read_only') AS read_only,
 current_setting('transaction_isolation') AS isolation,current_setting('TimeZone') AS timezone`;
export const authCatalogColumnsSql=`SELECT a.attname::text AS name,format_type(a.atttypid,a.atttypmod) AS type
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='auth' AND c.relname='users' AND c.relkind IN('r','p') AND a.attnum>0 AND NOT a.attisdropped
 ORDER BY a.attname::text COLLATE "C"`;
// Byte-exact with the already reviewed compact SQL; covered by the test pin.
export const authRowsSql=`SELECT u.id::text AS private_id,u.updated_at::text AS private_stamp,
 (extract(epoch FROM u.updated_at)*1000000)::numeric(30,0)::text AS private_micros,
 encode(pg_catalog.sha256(convert_to((to_jsonb(u)-'updated_at')::text,'UTF8')),'hex') AS private_other FROM auth.users u ORDER BY u.id LIMIT 17`;

// A per-cell digest exists only inside PostgreSQL, never in the returned frame.
// UUID order binds each value to its row; JSONB keeps NULL/string/type distinct.
// Only the final whole-column SHA/count is returned. The fixed cohort bounds work
// independently of client input; capture rejects a 17th row before this query.
export const authColumnFingerprintsSql=`WITH cohort AS MATERIALIZED (
 SELECT u.* FROM auth.users u ORDER BY u.id LIMIT 17
), names(name) AS (VALUES ${AUTH_DIAGNOSTIC_COLUMNS.map(n=>"('"+n+"')").join(',')}), cells AS (
 SELECT u.id,e.key AS name,e.value FROM cohort u CROSS JOIN LATERAL jsonb_each(to_jsonb(u)) e
)
SELECT n.name,count(c.id)::integer AS row_count,
 encode(sha256(convert_to('BRON_AUTH_COLUMN_V1:'||n.name||':'||count(c.id)::text||':'||
 coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(c.id,c.value)::text,'UTF8')),'hex'),'' ORDER BY c.id)
 FILTER(WHERE c.id IS NOT NULL),''),'UTF8')),'hex') AS hash
 FROM names n LEFT JOIN cells c ON c.name=n.name GROUP BY n.name ORDER BY n.name COLLATE "C"`;

export function validateAuthColumns(rows){
 if(!Array.isArray(rows)||rows.length!==AUTH_DIAGNOSTIC_SCHEMA.length)fail('T58_AUTH_SCHEMA_CHANGED');
 for(let i=0;i<rows.length;i++)if(!exact(rows[i],['name','type'])||rows[i].name!==AUTH_DIAGNOSTIC_SCHEMA[i].name||
  rows[i].type!==AUTH_DIAGNOSTIC_SCHEMA[i].type)fail('T58_AUTH_SCHEMA_CHANGED');
 return rows;
}
function validateRows(rows){
 if(!Array.isArray(rows)||rows.length>MAX_ROWS)fail('T58_AUTH_COHORT_LIMIT');
 let previous='';
 for(const r of rows){
  if(!exact(r,['private_id','private_stamp','private_micros','private_other'])||!uuid(r.private_id)||
   !digest(r.private_other)||r.private_id<=previous||
   !((r.private_stamp===null&&r.private_micros===null)||
    (typeof r.private_stamp==='string'&&r.private_stamp.length>=10&&r.private_stamp.length<=128&&
     typeof r.private_micros==='string'&&/^-?[0-9]{1,30}$/.test(r.private_micros))))fail('T58_AUTH_ROWS_INVALID');
  previous=r.private_id;
 }
 return rows;
}
export function validateAuthDiagnosticFrame(value){
 if(!exact(value,['authRows','columnFingerprints']))fail('T58_FRAME_INVALID');
 boundedBytes(value);validateRows(value.authRows);
 if(!Array.isArray(value.columnFingerprints)||value.columnFingerprints.length!==AUTH_DIAGNOSTIC_COLUMNS.length)
  fail('T58_COLUMN_FINGERPRINTS_INVALID');
 for(let i=0;i<value.columnFingerprints.length;i++){
  const r=value.columnFingerprints[i];
  if(!exact(r,['name','row_count','hash'])||r.name!==AUTH_DIAGNOSTIC_COLUMNS[i]||!digest(r.hash)||
   !Number.isSafeInteger(r.row_count)||r.row_count!==value.authRows.length)fail('T58_COLUMN_FINGERPRINTS_INVALID');
 }
 return value;
}
export async function captureAuthDiagnostic(db){
 if(typeof db?.query!=='function')fail('T58_DIAGNOSTIC_DATABASE_REQUIRED');
 const session=(await db.query(authDiagnosticSessionSql)).rows;
 if(!Array.isArray(session)||session.length!==1||!exact(session[0],['read_only','isolation','timezone'])||
  session[0].read_only!=='on'||session[0].isolation!=='repeatable read'||session[0].timezone!=='UTC')
  fail('T58_DIAGNOSTIC_READONLY_REQUIRED');
 validateAuthColumns((await db.query(authCatalogColumnsSql)).rows);
 const authRows=validateRows((await db.query(authRowsSql)).rows);
 const columnFingerprints=(await db.query(authColumnFingerprintsSql)).rows;
 return validateAuthDiagnosticFrame({authRows,columnFingerprints});
}
const counters=['sourceRows','targetRows','sourceOnlyRows','targetOnlyRows','changedMatchedRows','changedUpdatedOnlyRows',
 'sourceNewerRows','targetNewerRows','nullTimestampChangedRows','otherChangedRows'];
export function summarizeAuthDiagnostic(source,target,{planAuthRows}={}){
 validateAuthDiagnosticFrame(source);validateAuthDiagnosticFrame(target);
 if(typeof planAuthRows!=='function')fail('T58_REVIEWED_PLANNER_REQUIRED');
 let p;try{p=planAuthRows(source.authRows,target.authRows);}catch(e){
  const upstream=/^AUTH_PLAN_[A-Z_]+$/.test(e?.code??'')?e.code:null;
  throw Object.assign(new Error('T58_REVIEWED_PLANNER_FAILED'),{code:'T58_REVIEWED_PLANNER_FAILED',...(upstream?{upstreamCode:upstream}:{})});
 }
 if(!object(p)||p.diagnosticComplete!==true||p.applyAuthorized!==false||p.finalFreezeAudit!==false||
  counters.some(k=>!Number.isSafeInteger(p[k])||p[k]<0||p[k]>MAX_ROWS)||
  p.sourceRows!==source.authRows.length||p.targetRows!==target.authRows.length||typeof p.canReconcileTimestampOnly!=='boolean')
  fail('T58_REVIEWED_PLANNER_RESULT_INVALID');
 const cohortMembershipEqual=p.sourceOnlyRows===0&&p.targetOnlyRows===0;
 const mismatchedColumns=cohortMembershipEqual?source.columnFingerprints.filter((r,i)=>r.hash!==target.columnFingerprints[i].hash).map(r=>r.name):[];
 if(cohortMembershipEqual){
  const other=mismatchedColumns.some(n=>n!=='updated_at'),stamp=mismatchedColumns.includes('updated_at');
  if(other!==(p.otherChangedRows>0)||stamp!==((p.sourceNewerRows+p.targetNewerRows+p.nullTimestampChangedRows)>0))
   fail('T58_AGGREGATE_PLAN_INCONSISTENT');
 }
 const blockers=[];
 if(!cohortMembershipEqual)blockers.push('COHORT_MEMBERSHIP_DIFF');
 if(p.otherChangedRows)blockers.push('OTHER_AUTH_FIELDS_DIFF');
 if(p.targetNewerRows)blockers.push('TARGET_NEWER_TIMESTAMP');
 if(p.nullTimestampChangedRows)blockers.push('NULL_TIMESTAMP_DIFF');
 return {format:1,task:'T58',status:'DIAGNOSTIC_COMPLETE',diagnosticComplete:true,applyAuthorized:false,finalFreezeAudit:false,
  ...Object.fromEntries(counters.map(k=>[k,p[k]])),expectedCohortRows:16,
  cohortCountsExpected:p.sourceRows===16&&p.targetRows===16,cohortMembershipEqual,
  columnComparisonAvailable:cohortMembershipEqual,mismatchedColumns,
  canReconcileTimestampOnly:p.canReconcileTimestampOnly,blockers};
}
