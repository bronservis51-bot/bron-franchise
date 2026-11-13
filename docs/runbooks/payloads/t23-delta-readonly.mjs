// T24 corrected read-only planner. Separate live snapshots are NOT the final freeze audit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const RUNTIME='/opt/bron/audit-runtime-c128f9b';
const PINS={
  'migration-audit.mjs':'a5306390fa06db03665caaaa988cadf472f17c349538712f03fa31f794d6bdea',
  'migration-source.mjs':'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
  'database-config.mjs':'1064d54299d354ec7951f40b719ce6886b78ddd00b2f2ac234c0024a8fbd55e6',
};
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeName=name=>/^[a-z_][a-z0-9_]{0,62}$/.test(name)?name:'OTHER';
const safeObject=name=>name.split('.').map(safeName).join('.');
const safeGroup=group=>/^(data|sequence):[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$|^schema:[a-z_][a-z0-9_]*$/.test(group)?group:'OTHER_GROUP';
const pkSql=`SELECT n.nspname AS schema,c.relname AS name,
 array_agg(a.attname::text ORDER BY k.position) AS columns
 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,position)
 JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
 WHERE i.indisprimary AND k.position<=i.indnkeyatts
 AND n.nspname IN ('public','app_private','auth','storage')
 GROUP BY n.nspname,c.relname`;

// Return fixed classifications, never the server message, detail, hint, SQL or stack.
export function safeFailure(error){
  const fixed={
    'Query read timeout':'PG_QUERY_READ_TIMEOUT',
    'Connection terminated unexpectedly':'PG_CONNECTION_TERMINATED',
    'Client has encountered a connection error and is not queryable':'PG_CONNECTION_NOT_QUERYABLE',
    'Client was closed and is not queryable':'PG_CLIENT_CLOSED',
  };
  const code=typeof error?.code==='string'?error.code:'';
  if(/^(?:[0-9A-Z]{5}|DELTA_[A-Z0-9_]{1,50}|SOURCE_[A-Z0-9_]{1,50}|MIGRATION_[A-Z0-9_]{1,50})$/.test(code))return {code};
  if(['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN'].includes(code))return {code};
  if(Object.hasOwn(fixed,error?.message??''))return {code:fixed[error.message]};
  if(/^Missing required table: (?:auth\.(?:users|identities)|public\.(?:partner|location|role_assignment|daily_revenue|franchise_lead|article_revision)|storage\.(?:buckets|objects))$/.test(error?.message??''))
    return {code:'AUDIT_REQUIRED_TABLE_MISSING',object:error.message.slice('Missing required table: '.length)};
  return {code:['TypeError','SyntaxError','RangeError'].includes(error?.name)?'JS_'+error.name.toUpperCase():'UNCLASSIFIED_FAILURE'};
}

export function observeQueries(db,side,context){
  let ordinal=0;
  return {query:async(sql,...args)=>{
    const text=typeof sql==='string'?sql:'';
    const table=text.match(/from "([a-z_][a-z0-9_]*)"\."([a-z_][a-z0-9_]*)" t order by/);
    const sequence=text.match(/^select last_value::text,is_called from "([a-z_][a-z0-9_]*)"\."([a-z_][a-z0-9_]*)"$/);
    const operation=sql===pkSql?'primary_key_metadata':table?'table_rows':sequence?'sequence_state':
      /^begin /i.test(text)?'begin_readonly':/^(?:commit|rollback)$/i.test(text)?text.toLowerCase():
      text.includes('current_database()')?'database_identity':text.includes("current_setting('transaction_read_only')")?'readonly_assertion':
      /^set local /i.test(text)?'local_settings':text.startsWith('select to_jsonb(x)')?'schema_catalog':
      text.includes('from pg_class c join pg_namespace')?'table_list':text.includes('from pg_sequences')?'sequence_list':'metadata';
    const step={side,ordinal:++ordinal,operation,...(table?{object:table[1]+'.'+table[2]}:sequence?{object:sequence[1]+'.'+sequence[2]}:{})};
    const start=Date.now();context.last=step;
    try{return await db.query(sql,...args);}
    catch(error){if(!context.failure)context.failure={...step,elapsedMs:Date.now()-start,...safeFailure(error)};throw error;}
  }};
}

export async function captureInventory(db,audit,verify=async()=>{},limits={rows:25000,totalRows:100000,bytes:64*1024*1024}){
  const tables=new Map();let keys,totalRows=0,totalBytes=0;
  const adapter={query:async(sql,...args)=>{
    const table=typeof sql==='string'&&sql.match(/^select to_jsonb\(t\)::text as value from "([a-z_][a-z0-9_]*)"\."([a-z_][a-z0-9_]*)" t order by to_jsonb\(t\)::text collate "C"$/);
    if(!table)return db.query(sql,...args);
    if(!keys){
      await verify(db);
      keys=new Map((await db.query(pkSql)).rows.map(r=>{
        if(!Array.isArray(r.columns)||r.columns.some(c=>typeof c!=='string'))fail('DELTA_PK_METADATA_TYPE');
        return [r.schema+'.'+r.name,r.columns];
      }));
    }
    const object=table[1]+'.'+table[2];if(tables.has(object))fail('DELTA_DUPLICATE_TABLE_CAPTURE');
    // PostgreSQL serializes EVERY column value to text before the outer JSON.
    // JSON.parse therefore never receives a bigint/decimal/timestamp as a JS number.
    const augmented=sql.replace('select to_jsonb(t)::text as value',`select to_jsonb(t)::text as value,
      (select jsonb_object_agg(e.key,e.value::text) from jsonb_each(to_jsonb(t)) e)::text as field_texts`)
      +' LIMIT '+(limits.rows+1);
    const result=await db.query(augmented,...args);
    totalRows+=result.rows.length;
    if(result.rows.length>limits.rows||totalRows>limits.totalRows)fail('DELTA_ROW_LIMIT');
    const rows=result.rows.map(r=>{
      if(typeof r.value!=='string'||typeof r.field_texts!=='string')fail('DELTA_COLUMN_CAPTURE_INVALID');
      totalBytes+=Buffer.byteLength(r.value)+Buffer.byteLength(r.field_texts);
      if(totalBytes>limits.bytes)fail('DELTA_BYTE_LIMIT');
      const fields=JSON.parse(r.field_texts);
      if(!fields||Array.isArray(fields)||Object.values(fields).some(v=>typeof v!=='string'))fail('DELTA_COLUMN_CAPTURE_INVALID');
      return {value:r.value,fields};
    });
    tables.set(object,{keys:keys.get(object)??[],rows});return result;
  }};
  const startedUtc=new Date().toISOString(),snapshot=await audit.snapshotDatabase(adapter);
  for(const [object,table] of tables){const expected=snapshot['data:'+object];
    if(expected?.count!==table.rows.length||expected.hash!==audit.fingerprintRows(table.rows.map(r=>r.value)))
      fail('DELTA_CAPTURE_FINGERPRINT_MISMATCH');}
  if(Object.keys(snapshot).filter(k=>k.startsWith('data:')).length!==tables.size)fail('DELTA_TABLE_CAPTURE_MISSING');
  return {snapshot,tables,startedUtc,finishedUtc:new Date().toISOString()};
}

export function diffRows(source={keys:[],rows:[]},target={keys:[],rows:[]}){
  const sameKeys=source.keys.length>0&&JSON.stringify(source.keys)===JSON.stringify(target.keys);
  const base={sourceRows:source.rows.length,targetRows:target.rows.length,primaryKeyMatch:sameKeys};
  if(!sameKeys){
    const counts=rows=>{const m=new Map();for(const r of rows)m.set(r.value,(m.get(r.value)??0)+1);return m;};
    const a=counts(source.rows),b=counts(target.rows);let sourceOnlyRows=0,targetOnlyRows=0;
    for(const value of new Set([...a.keys(),...b.keys()])){const n=(a.get(value)??0)-(b.get(value)??0);
      sourceOnlyRows+=Math.max(n,0);targetOnlyRows+=Math.max(-n,0);}
    return {...base,comparison:'row-multiset',sourceOnlyRows,targetOnlyRows,changedMatchedRows:null,columns:[]};
  }
  const index=table=>{const m=new Map();for(const row of table.rows){
    if(table.keys.some(k=>!Object.hasOwn(row.fields,k)||row.fields[k]==='null'))fail('DELTA_PRIMARY_KEY_INVALID');
    const key=JSON.stringify(table.keys.map(k=>row.fields[k]));if(m.has(key))fail('DELTA_DUPLICATE_PRIMARY_KEY');m.set(key,row);}
    return m;};
  const a=index(source),b=index(target),columns=new Map();let sourceOnlyRows=0,changedMatchedRows=0;
  for(const [key,row] of a){const other=b.get(key);if(!other){sourceOnlyRows++;continue;}
    const changed=[...new Set([...Object.keys(row.fields),...Object.keys(other.fields)])]
      .filter(k=>row.fields[k]!==other.fields[k]);
    if(changed.length)changedMatchedRows++;
    if(!changed.length&&row.value!==other.value)fail('DELTA_COLUMN_CAPTURE_INCONSISTENT');
    for(const name of changed)columns.set(safeName(name),(columns.get(safeName(name))??0)+1);
  }
  return {...base,comparison:'primary-key',sourceOnlyRows,targetOnlyRows:[...b.keys()].filter(k=>!a.has(k)).length,
    changedMatchedRows,columns:[...columns].sort(([a],[b])=>a.localeCompare(b)).map(([name,rows])=>({name,rows}))};
}

export function inventoryReport(source,target,audit){
  const mismatch=audit.compareSnapshots(source.snapshot,target.snapshot);
  return {inventoryComplete:true,finalFreezeAudit:false,strictMatch:mismatch.length===0,mismatch:mismatch.map(safeGroup),
    sourceWindow:{startedUtc:source.startedUtc,finishedUtc:source.finishedUtc},
    targetWindow:{startedUtc:target.startedUtc,finishedUtc:target.finishedUtc},
    tables:[...new Set([...source.tables.keys(),...target.tables.keys()])].sort().map(object=>({
      object:safeObject(object),strictMatch:!mismatch.includes('data:'+object),
      ...diffRows(source.tables.get(object),target.tables.get(object))})),
    schema:mismatch.filter(k=>k.startsWith('schema:')).map(group=>({group:safeGroup(group),
      sourceRows:source.snapshot[group]?.count??null,targetRows:target.snapshot[group]?.count??null})),
    sequences:[...new Set([...Object.keys(source.snapshot),...Object.keys(target.snapshot)])]
      .filter(k=>k.startsWith('sequence:')).sort().map(group=>({object:safeObject(group.slice(9)),
        sourcePresent:Object.hasOwn(source.snapshot,group),targetPresent:Object.hasOwn(target.snapshot,group),
        lastValueEqual:source.snapshot[group]?.last_value===target.snapshot[group]?.last_value,
        calledEqual:source.snapshot[group]?.is_called===target.snapshot[group]?.is_called}))};
}

async function main(){let source,target,phase='runtime';const context={};
  const deadline=setTimeout(()=>{console.error('T24_BLOCKED',JSON.stringify({phase,code:'DEADLINE_EXCEEDED',query:context.failure??context.last??null}));process.exit(2);},240000);deadline.unref();
  try{
    if(process.argv.length!==2)fail('DELTA_NO_ARGUMENTS_EXPECTED');
    execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
    for(const [name,sha] of Object.entries(PINS))if(createHash('sha256').update(fs.readFileSync(RUNTIME+'/scripts/'+name)).digest('hex')!==sha)
      fail('DELTA_RUNTIME_SHA_MISMATCH');
    if(JSON.parse(fs.readFileSync(RUNTIME+'/node_modules/pg/package.json','utf8')).version!=='8.23.1')fail('DELTA_PG_VERSION');
    const {sourceServiceConfig,assertMigrationTarget}=await import(RUNTIME+'/scripts/migration-source.mjs');
    const sourceConfig=sourceServiceConfig();
    const {databaseConfig}=await import(RUNTIME+'/scripts/database-config.mjs');
    const audit=await import(RUNTIME+'/scripts/migration-audit.mjs');
    const {default:pg}=await import(RUNTIME+'/node_modules/pg/lib/index.js');
    phase='target-config';
    const records=JSON.parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],
      {encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']}));
    const container=records[0];if(records.length!==1||container?.Name!=='/supabase-db'||!container.State?.Running)fail('DELTA_TARGET_CONTAINER');
    const values={};for(const entry of container.Config?.Env??[]){const i=entry.indexOf('='),name=entry.slice(0,i);
      if(!['POSTGRES_PASSWORD','PGPASSWORD','POSTGRES_USER','POSTGRES_DB'].includes(name))continue;
      if(Object.hasOwn(values,name))fail('DELTA_TARGET_DUPLICATE_CONFIG');values[name]=entry.slice(i+1);}
    if(!values.POSTGRES_PASSWORD||values.PGPASSWORD!==values.POSTGRES_PASSWORD||values.POSTGRES_USER!=='supabase_admin'||values.POSTGRES_DB!=='postgres')fail('DELTA_TARGET_CONFIG');
    const addresses=Object.values(container.NetworkSettings?.Networks??{}).map(n=>n.IPAddress).filter(Boolean);
    if(!addresses.length)fail('DELTA_TARGET_ADDRESS');
    const url=new URL('postgresql://supabase_admin@127.0.0.1:15433/postgres?sslmode=disable');
    url.password=encodeURIComponent(values.POSTGRES_PASSWORD);assertMigrationTarget(url.href);
    target=new pg.Client({...databaseConfig(url.href,{BRON_DB_ALLOW_LOCAL_PLAIN:'1'}),
      options:'-c default_transaction_read_only=on -c statement_timeout=30000',query_timeout:60000});
    source=new pg.Client(sourceConfig);
    // Never let an idle network error print an unredacted pg error object.
    source.on('error',()=>{});target.on('error',()=>{});
    await source.connect();await target.connect();
    const verify=side=>async db=>{const row=(await db.query(`SELECT current_database() AS db,current_user AS role,
      current_setting('transaction_read_only') AS mode,host(inet_server_addr()) AS address,
      inet_server_port() AS port`+(side==='target'?`,current_setting('cron.launch_active_jobs') AS cron,
      current_setting('pg_net.batch_size') AS net`:''))).rows[0];
      if(row.db!=='postgres'||row.role!==(side==='target'?'supabase_admin':'postgres')||row.mode!=='on')fail('DELTA_DATABASE_IDENTITY');
      if(side==='target'&&(!addresses.includes(row.address)||row.port!==5432||row.cron!=='off'||row.net!=='0'))fail('DELTA_TARGET_ISOLATION');};
    phase='source-readonly-snapshot';const a=await captureInventory(observeQueries(source,'source',context),audit,verify('source'));
    phase='target-readonly-snapshot';const b=await captureInventory(observeQueries(target,'target',context),audit,verify('target'));
    phase='safe-difference-counts';console.log('T24_DELTA_INVENTORY',JSON.stringify(inventoryReport(a,b,audit)));
  }catch(error){console.error('T24_BLOCKED',JSON.stringify({phase,...safeFailure(error),query:context.failure??context.last??null}));process.exitCode=2;}
  finally{await Promise.allSettled([source?.end(),target?.end()]);clearTimeout(deadline);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
