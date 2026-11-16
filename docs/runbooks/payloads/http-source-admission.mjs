// PREPARATION ONLY. Imports/CLI never load credentials or execute source SQL.
// Future activation requires an explicit pinned task and durable VPS before-image.
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stateSql} from './t26-source-admission.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const quoted=value=>"E'"+String(value).replaceAll("\\","\\\\").replaceAll("'","''")+"'";
const json=value=>quoted(JSON.stringify(value))+'::jsonb';
const protectedRoles=new Set(['postgres','supabase_admin','dashboard_user']);
const apiRoles=new Set(['anon','authenticated','service_role']);
// One database-wide key, shared even by later task IDs: an uncertain older
// operation must also exclude a newer task's inverse. No persistent SQL object.
export const advisoryKey=createHash('sha256').update('bron-source-admission:postgres:v1').digest().readBigInt64BE().toString();
const sorted=rows=>[...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const same=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
const rolesWithoutConnect=roles=>roles.map(({connect,...role})=>role).sort((a,b)=>a.name.localeCompare(b.name));
const canonical=expression=>`(SELECT coalesce(jsonb_agg(value ORDER BY value::text COLLATE "C"),'[]'::jsonb) FROM jsonb_array_elements(${expression}) AS e(value))`;
const aclMatches=(expression,acl)=>`${canonical(expression)} = ${canonical(json(acl))}`;
const readState=`PERFORM pg_stat_clear_snapshot(); SELECT state INTO s FROM (${stateSql}) AS metadata`;
const error=code=>`RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='${code}'`;
const assert=(condition,code)=>`IF NOT (${condition}) THEN ${error(code)}; END IF;`;
const identity=assert(`current_database()='postgres' AND current_user='postgres' AND session_user='postgres'
 AND (SELECT pg_get_userbyid(datdba)='postgres' FROM pg_database WHERE datname=current_database())
 AND pg_has_role(current_user,'pg_signal_backend','USAGE')`,'HTTP_ADMISSION_IDENTITY');
const locked=`${identity}
 ${assert("current_setting('transaction_isolation')='read committed'",'HTTP_ADMISSION_ISOLATION')}
 ${assert(`pg_try_advisory_xact_lock(${advisoryKey}::bigint)`,'HTTP_ADMISSION_OPERATION_IN_FLIGHT')}`;
const statement=body=>{
  const code=`DECLARE s jsonb; b record;\nBEGIN\n${locked}\n${body}\nEND`;
  let tag='$bron_http_admission$';
  while(code.includes(tag))tag=tag.slice(0,-1)+'_$';
  return `DO ${tag}\n${code}\n${tag};`;
};

// Technical metadata only. This observation is not an authorization/fence proof:
// each effect/assertion reads fresh catalog state under the common lock in DO.
export const beforeImageSql=`SELECT state || jsonb_build_object('capturedMicros',
 floor(extract(epoch FROM clock_timestamp())*1000000)::numeric::text) AS state
 FROM (${stateSql}) AS metadata`;
export const afterDrainBoundarySql=`SELECT jsonb_build_object('capturedMicros',
 floor(extract(epoch FROM clock_timestamp())*1000000)::numeric::text,
 'ownerPids',coalesce((SELECT jsonb_agg(pid ORDER BY pid) FROM pg_stat_activity
 WHERE datname=current_database() AND usename='postgres' AND backend_type='client backend'),'[]'::jsonb)) AS boundary`;
// Execute within one new VPS owner client's BEGIN READ ONLY transaction after
// the successful drain AND afterDrainBoundarySql response. No auth row data.
export const freshOwnerWitnessSql=`SELECT jsonb_build_object('db',current_database(),
 'actor',current_user,'session',session_user,'readOnly',current_setting('transaction_read_only'),
 'isolation',current_setting('transaction_isolation'),
 'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
 'pid',pg_backend_pid(),'backendStartMicros',floor(extract(epoch FROM backend_start)*1000000)::numeric::text)
 AS witness FROM pg_stat_activity WHERE pid=pg_backend_pid()`;

function validateBefore(before){
  if(before?.db!=='postgres'||before.actor!=='postgres'||before.session!=='postgres'||before.owner!=='postgres'||
    before.signal!==true||!Array.isArray(before.acl)||!Array.isArray(before.roles)||!Array.isArray(before.backends))fail('HTTP_ADMISSION_BEFORE_INVALID');
  const connect=before.acl.filter(e=>e.privilege==='CONNECT');
  if(!same(connect.map(e=>e.grantee),['PUBLIC','dashboard_user','postgres'])||connect.some(e=>e.grantor!=='postgres'||e.grantable!==false))
    fail('HTTP_ADMISSION_BEFORE_ACL_UNEXPECTED');
  if(new Set(before.acl.map(e=>JSON.stringify(e))).size!==before.acl.length)fail('HTTP_ADMISSION_BEFORE_ACL_DUPLICATE');
  const owner=before.roles.find(r=>r.name==='postgres'),lookup=before.roles.find(r=>r.name==='pgbouncer');
  if(!owner?.connect||owner.super||before.roles.find(r=>r.name==='dashboard_user')?.login!==false)
    fail('HTTP_ADMISSION_OWNER_OR_DASHBOARD');
  if(!lookup?.login||lookup.super||lookup.createRole||lookup.createDb||lookup.replication||lookup.bypass||lookup.ownerPath)
    fail('HTTP_ADMISSION_LOOKUP_ROLE_UNSAFE');
  for(const r of before.roles)if(!protectedRoles.has(r.name)&&(r.login||apiRoles.has(r.name))&&(r.super||r.ownerPath))
    fail('HTTP_ADMISSION_ROLE_ESCAPE');
  if(before.lookupOtherSetRoles!==0||[before.lookupCriticalWrites,before.lookupSequenceWrites,before.lookupCriticalDefiners,before.prepared,before.netQueued,before.unexpectedActiveCron]
    .some(n=>Number(n)!==0)||before.runJobsExists!==false)fail('HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND');
}

export function makeHttpAdmissionPlan({activation,before}){
  if(activation?.reviewed!==true||!/^T[1-9][0-9]{1,3}\.http_source_admission$/.test(activation.actionId??'')||
    !/^[a-f0-9]{64}$/.test(activation.manifestSha256??'')||!/^[a-f0-9]{64}$/.test(activation.beforeImageSha256??'')||
    activation.beforeImageDurableOnVps!==true||activation.providerBoundaryReviewed!==true||
    activation.independentKeyProved!==true||activation.rollbackBeforeTargetWrites!==true||activation.targetWritesStarted!==false)
    fail('HTTP_ADMISSION_DRAFT_NOT_REVIEWED');
  validateBefore(before);
  const original=structuredClone(before.acl);
  const fenced=[...original.filter(e=>!(e.privilege==='CONNECT'&&e.grantee==='PUBLIC')),
    {grantee:'pgbouncer',grantor:'postgres',privilege:'CONNECT',grantable:false}];
  const lookupSetDenied=assert("(s->>'lookupOtherSetRoles')::bigint IS NOT DISTINCT FROM 0",'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND');
  const common=`${readState};
 ${assert(`${canonical("(SELECT jsonb_agg(value-'connect') FROM jsonb_array_elements(s->'roles') AS roles(value))")} = ${canonical(json(rolesWithoutConnect(before.roles)))}`,'HTTP_ADMISSION_ROLE_DRIFT')}
 ${lookupSetDenied}
 ${assert("(s->>'lookupCriticalWrites')::bigint=0 AND (s->>'lookupSequenceWrites')::bigint=0 AND (s->>'lookupCriticalDefiners')::bigint=0 AND (s->>'prepared')::bigint=0 AND (s->>'netQueued')::bigint=0 AND (s->>'unexpectedActiveCron')::bigint=0 AND s->>'runJobsExists'='false'",'HTTP_ADMISSION_CAPABILITY_OR_BACKGROUND')}
 ${assert("NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'backends') AS b(value) WHERE value->>'type'='client backend' AND (value->>'super')::boolean AND ((value->>'providerAppKnown')::boolean IS DISTINCT FROM true OR (value->>'openTransaction')::boolean IS DISTINCT FROM false OR value->>'state' IS DISTINCT FROM 'idle'))",'HTTP_ADMISSION_PROVIDER_TRANSACTION')}`;
  const fencedAssertion=assert(aclMatches("s->'acl'",fenced),'HTTP_ADMISSION_FENCED_ACL_MISMATCH');
  const ordinaryDenied=assert("NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'roles') AS r(value) WHERE value->>'name' NOT IN('postgres','supabase_admin','dashboard_user','pgbouncer') AND ((value->>'login')::boolean OR value->>'name' IN('anon','authenticated','service_role')) AND (value->>'connect')::boolean)",'HTTP_ADMISSION_ORDINARY_CONNECT_REMAINS');
  const noProductClients=assert("NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'backends') AS b(value) WHERE value->>'type'='client backend' AND NOT (value->>'super')::boolean AND value->>'role' NOT IN('postgres','pgbouncer'))",'HTTP_ADMISSION_PRODUCT_CLIENT_REMAINS');
  return Object.freeze({actionId:activation.actionId,advisoryKey,originalAcl:original,fencedAcl:fenced,
    applySql:statement(`${common}\n ${assert(aclMatches("s->'acl'",original),'HTTP_ADMISSION_ORIGINAL_ACL_MISMATCH')}
 GRANT CONNECT ON DATABASE postgres TO pgbouncer;
 REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
 ${readState}; ${lookupSetDenied} ${fencedAssertion} ${ordinaryDenied}`),
    verifyFencedSql:statement(`${common}\n ${fencedAssertion} ${ordinaryDenied} ${noProductClients}`),
    drainSql:statement(`${common}\n ${fencedAssertion} ${ordinaryDenied}
 FOR b IN SELECT a.pid FROM pg_stat_activity a JOIN pg_roles r ON r.rolname=a.usename
 WHERE a.datname=current_database() AND a.backend_type='client backend' AND NOT r.rolsuper
 AND a.usename<>'pgbouncer' AND a.pid<>pg_backend_pid() LOOP
   ${assert('pg_terminate_backend(b.pid,5000)','HTTP_ADMISSION_DRAIN_NOT_CONFIRMED')}
 END LOOP;
 ${readState}; ${lookupSetDenied} ${fencedAssertion} ${ordinaryDenied} ${noProductClients}`),
    inverseSql:statement(`${readState};
 IF ${aclMatches("s->'acl'",original)} THEN RETURN; END IF;
 ${fencedAssertion}
 GRANT CONNECT ON DATABASE postgres TO PUBLIC;
 REVOKE CONNECT ON DATABASE postgres FROM pgbouncer;
 ${readState}; ${assert(aclMatches("s->'acl'",original),'HTTP_ADMISSION_INVERSE_ACL_MISMATCH')}`),
    verifyOriginalSql:statement(`${readState}; ${assert(aclMatches("s->'acl'",original),'HTTP_ADMISSION_ORIGINAL_ACL_MISMATCH')}`),
    providerSuperusersFenced:false,actualSupavisorRecovery:'NOT_TESTED'});
}

export function validateFreshOwnerWitness({before,boundary,witness}){
  if(!/^\d{12,20}$/.test(boundary?.capturedMicros??'')||!Array.isArray(boundary.ownerPids)||
    !boundary.ownerPids.every(Number.isInteger)||!Array.isArray(before?.backends))fail('HTTP_ADMISSION_BOUNDARY_INVALID');
  const oldPids=new Set([...boundary.ownerPids,...before.backends.map(b=>b.pid)]);
  if(witness?.db!=='postgres'||witness.actor!=='postgres'||witness.session!=='postgres'||witness.owner!=='postgres'||
    witness.readOnly!=='on'||!Number.isInteger(witness.pid)||oldPids.has(witness.pid)||
    !/^\d{12,20}$/.test(witness.backendStartMicros??'')||BigInt(witness.backendStartMicros)<=BigInt(boundary.capturedMicros))
    fail('HTTP_ADMISSION_FRESH_PHYSICAL_BACKEND_NOT_PROVED');
  return {freshOwnerReadonly:true,newPhysicalBackendAfterDrain:true,actualRouteRequiresVpsWitness:true};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.error('HTTP_ADMISSION_DRAFT_NOT_ACTIVATED');process.exitCode=2;
}
