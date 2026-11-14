// Read-only timestamp diagnosis only. No source/target apply, freeze or final audit.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const RUNTIME='/opt/bron/audit-runtime-c128f9b';
const PINS={
 'migration-audit.mjs':'a5306390fa06db03665caaaa988cadf472f17c349538712f03fa31f794d6bdea',
 'migration-source.mjs':'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
 'database-config.mjs':'1064d54299d354ec7951f40b719ce6886b78ddd00b2f2ac234c0024a8fbd55e6',
};
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function directSourceConfig(sourceConfig){
 const host='aws-1-us-west-2.pooler.supabase.com';
 if(sourceConfig?.database!=='postgres'||sourceConfig.user!=='postgres.vkkqffvmztpzgygzfxhq'||
   sourceConfig.connectionString||typeof sourceConfig.password!=='function'||
   sourceConfig.ssl?.rejectUnauthorized!==true||sourceConfig.ssl.servername!==host||!sourceConfig.ssl.ca||
   typeof sourceConfig.ssl.checkServerIdentity!=='function'||
   !((sourceConfig.host==='127.0.0.1'&&sourceConfig.port===15432)||(sourceConfig.host===host&&sourceConfig.port===5432)))
   fail('AUTH_PLAN_SOURCE_CONFIG_UNSAFE');
 const direct={...sourceConfig,host,port:6543,connectionTimeoutMillis:15000,query_timeout:20000};
 // This task never uses the Mac reverse route. The transaction pooler receives
 // explicit BEGIN READ ONLY / local settings, not startup PGOPTIONS.
 delete direct.options;return direct;
}
export const authRowsSql=`SELECT u.id::text AS private_id,u.updated_at::text AS private_stamp,
 (extract(epoch FROM u.updated_at)*1000000)::numeric(30,0)::text AS private_micros,
 encode(pg_catalog.sha256(convert_to((to_jsonb(u)-'updated_at')::text,'UTF8')),'hex') AS private_other FROM auth.users u ORDER BY u.id LIMIT 17`;
function indexRows(rows){
 if(!Array.isArray(rows)||rows.length>64)fail('AUTH_PLAN_ROW_LIMIT');
 const map=new Map();let bytes=0;
 for(const row of rows){
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.private_id??'')||
    typeof row.private_other!=='string'||
    !((row.private_stamp===null&&row.private_micros===null)||
      (typeof row.private_stamp==='string'&&typeof row.private_micros==='string'&&/^-?[0-9]{1,30}$/.test(row.private_micros))))
    fail('AUTH_PLAN_CAPTURE_INVALID');
  bytes+=Buffer.byteLength(row.private_id)+Buffer.byteLength(row.private_other)+Buffer.byteLength(row.private_stamp??'')+Buffer.byteLength(row.private_micros??'');
  if(bytes>1048576)fail('AUTH_PLAN_BYTE_LIMIT');
  if(map.has(row.private_id))fail('AUTH_PLAN_DUPLICATE_ID');
  map.set(row.private_id,row);
 }
 return map;
}
export function authRowsPlan(sourceRows,targetRows){
 const a=indexRows(sourceRows),b=indexRows(targetRows);
 let sourceOnlyRows=0,targetOnlyRows=0,changedMatchedRows=0,changedUpdatedOnlyRows=0,otherChangedRows=0,
   sourceNewerRows=0,targetNewerRows=0,nullTimestampChangedRows=0;
 for(const [id,row] of a){
  const other=b.get(id);if(!other){sourceOnlyRows++;continue;}
  const fieldsChanged=row.private_other!==other.private_other;
  const timestampChanged=row.private_micros!==other.private_micros;
  if(!timestampChanged&&row.private_stamp!==other.private_stamp)fail('AUTH_PLAN_TIMESTAMP_ENCODING_MISMATCH');
  if(fieldsChanged)otherChangedRows++;
  if(fieldsChanged||timestampChanged)changedMatchedRows++;
  if(timestampChanged){
   if(!fieldsChanged)changedUpdatedOnlyRows++;
   if(row.private_micros===null||other.private_micros===null)nullTimestampChangedRows++;
   else if(BigInt(row.private_micros)>BigInt(other.private_micros))sourceNewerRows++;
   else targetNewerRows++;
  }
 }
 for(const id of b.keys())if(!a.has(id))targetOnlyRows++;
 const canReconcileTimestampOnly=sourceOnlyRows===0&&targetOnlyRows===0&&otherChangedRows===0&&targetNewerRows===0&&nullTimestampChangedRows===0;
 return {diagnosticComplete:true,applyAuthorized:false,finalFreezeAudit:false,
  sourceRows:a.size,targetRows:b.size,sourceOnlyRows,targetOnlyRows,changedMatchedRows,changedUpdatedOnlyRows,
  sourceNewerRows,targetNewerRows,nullTimestampChangedRows,otherChangedRows,
  columns:changedUpdatedOnlyRows?[{name:'updated_at',rows:changedUpdatedOnlyRows}]:[],canReconcileTimestampOnly,
  nextCondition:!canReconcileTimestampOnly?'REVIEW_NON_TIMESTAMP_OR_DIRECTION_DIFF':
    changedUpdatedOnlyRows?'SOURCE_NEWER_TIMESTAMP_ONLY_RECHECK_UNDER_FREEZE':'NO_RECONCILIATION_NEEDED'};
}
export async function captureAuthRows(db,verify=async()=>{},onStep=()=>{}){
 const startedUtc=new Date().toISOString();let disconnected=false,began=false,primaryError,result;
 const step=async(name,fn)=>{const start=performance.now();try{const out=await fn();onStep({step:name,status:'PASS',elapsedMs:Math.round(performance.now()-start)});return out;}
  catch(error){if(!error.authStep){error.authStep=name;error.authElapsedMs=Math.round(performance.now()-start);}
   onStep({step:name,status:'FAIL',elapsedMs:error.authElapsedMs,code:safeError(error)});throw error;}};
 try{
  await step('begin',()=>db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));began=true;
  await step('serverDeadline',()=>db.query("SET LOCAL statement_timeout='5000'"));
  await step('timezone',()=>db.query("SET LOCAL timezone='UTC'"));
  await step('identity',()=>verify(db));
  const rows=await step('authRows',async()=>{const rows=(await db.query(authRowsSql)).rows;indexRows(rows);
   if(rows.length>16)fail('AUTH_PLAN_PRODUCTION_COHORT_LIMIT');
   if(rows.some(r=>!/^[0-9a-f]{64}$/.test(r.private_other)))fail('AUTH_PLAN_COMPACT_DIGEST_INVALID');return rows;});
  result={rows,startedUtc,finishedUtc:new Date().toISOString()};
 }catch(error){
  primaryError=error;
  if(['Query read timeout','Connection terminated unexpectedly','Client has encountered a connection error and is not queryable','Client was closed and is not queryable'].includes(error?.message)){disconnected=true;db.connection?.stream?.destroy();}
 }finally{if(began&&!disconnected){try{await step('rollback',()=>db.query('ROLLBACK'));}catch(error){primaryError??=error;}}}
 if(primaryError)throw primaryError;return result;
}

function safeError(error){
 if(/^(?:AUTH_PLAN_|SOURCE_|MIGRATION_)[A-Z0-9_]+$/.test(error?.code??''))return error.code;
 if(/^[0-9A-Z]{5}$/.test(error?.code??''))return error.code;
 if(error?.message==='Query read timeout')return 'PG_QUERY_READ_TIMEOUT';
 if(error?.message==='Connection terminated due to connection timeout')return 'PG_CONNECT_TIMEOUT';
 if(['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN'].includes(error?.code))return error.code;
 return 'AUTH_PLAN_FAILED';
}
async function main(){let source,target,phase='runtime';
 const timer=setTimeout(()=>{console.error('T30_AUTH_BLOCKED',phase,'DEADLINE_EXCEEDED');process.exit(2);},90000);timer.unref();
 try{
  if(process.argv.length!==2)fail('AUTH_PLAN_NO_ARGUMENTS');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  for(const [name,digest] of Object.entries(PINS))if(createHash('sha256').update(fs.readFileSync(RUNTIME+'/scripts/'+name)).digest('hex')!==digest)fail('AUTH_PLAN_RUNTIME_SHA');
  if(JSON.parse(fs.readFileSync(RUNTIME+'/node_modules/pg/package.json','utf8')).version!=='8.23.1')fail('AUTH_PLAN_DRIVER_VERSION');
  const {sourceServiceConfig,assertMigrationTarget}=await import(RUNTIME+'/scripts/migration-source.mjs');
  const {databaseConfig}=await import(RUNTIME+'/scripts/database-config.mjs');
  const {default:pg}=await import(RUNTIME+'/node_modules/pg/lib/index.js');
  phase='target-config';
  const records=JSON.parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],{encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
  const container=records[0];if(records.length!==1||container?.Name!=='/supabase-db'||!container.State?.Running)fail('AUTH_PLAN_TARGET_CONTAINER');
  const values={};for(const entry of container.Config?.Env??[]){const i=entry.indexOf('='),name=entry.slice(0,i);
   if(!['POSTGRES_PASSWORD','PGPASSWORD','POSTGRES_USER','POSTGRES_DB'].includes(name))continue;
   if(Object.hasOwn(values,name))fail('AUTH_PLAN_TARGET_DUPLICATE_CONFIG');values[name]=entry.slice(i+1);}
  if(!values.POSTGRES_PASSWORD||values.PGPASSWORD!==values.POSTGRES_PASSWORD||values.POSTGRES_USER!=='supabase_admin'||values.POSTGRES_DB!=='postgres')fail('AUTH_PLAN_TARGET_CONFIG');
  const addresses=Object.values(container.NetworkSettings?.Networks??{}).map(n=>n.IPAddress).filter(Boolean);
  if(!addresses.length)fail('AUTH_PLAN_TARGET_ADDRESS');
  const url=new URL('postgresql://supabase_admin@127.0.0.1:15433/postgres?sslmode=disable');url.password=encodeURIComponent(values.POSTGRES_PASSWORD);assertMigrationTarget(url.href);
  source=new pg.Client(directSourceConfig(sourceServiceConfig()));target=new pg.Client({...databaseConfig(url.href,{BRON_DB_ALLOW_LOCAL_PLAIN:'1'}),options:'-c default_transaction_read_only=on',query_timeout:20000});
  for(const client of [source,target])client.on('error',()=>{});
  console.log('T30_SOURCE_ROUTE',JSON.stringify({route:'canonical-transaction',macDataTransit:false,status:'ATTEMPTING'}));
  phase='connect';await source.connect();await target.connect();
  const verify=side=>async db=>{
   const r=(await db.query(`SELECT current_database() AS db,current_user AS role,current_setting('transaction_read_only') AS mode,
    current_setting('transaction_isolation') AS isolation,host(inet_server_addr()) AS address,inet_server_port() AS port`+
    (side==='target'?`,current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net`:''))).rows[0];
   if(r.db!=='postgres'||r.role!==(side==='source'?'postgres':'supabase_admin')||r.mode!=='on'||r.isolation!=='repeatable read')fail('AUTH_PLAN_DATABASE_IDENTITY');
   if(side==='target'&&(!addresses.includes(r.address)||r.port!==5432||r.cron!=='off'||r.net!=='0'))fail('AUTH_PLAN_TARGET_ISOLATION');
  };
  phase='source-readonly';const a=await captureAuthRows(source,verify('source'),step=>console.log('T30_AUTH_STEP',JSON.stringify({side:'source',...step})));
  phase='target-readonly';const b=await captureAuthRows(target,verify('target'),step=>console.log('T30_AUTH_STEP',JSON.stringify({side:'target',...step})));
  phase='safe-plan';console.log('T30_AUTH_PLAN',JSON.stringify({...authRowsPlan(a.rows,b.rows),sourceWindow:{startedUtc:a.startedUtc,finishedUtc:a.finishedUtc},targetWindow:{startedUtc:b.startedUtc,finishedUtc:b.finishedUtc}}));
 }catch(error){console.error('T30_AUTH_BLOCKED',JSON.stringify({phase,code:safeError(error),step:error.authStep??null,elapsedMs:error.authElapsedMs??null}));process.exitCode=2;}
 finally{for(const client of [source,target])client?.connection?.stream?.destroy();await Promise.allSettled([source?.end(),target?.end()]);clearTimeout(timer);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
