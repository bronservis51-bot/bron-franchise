import test from 'node:test';
import assert from 'node:assert/strict';
import {captureInventory,diffRows,inventoryReport,observeQueries,safeFailure} from '../../docs/runbooks/payloads/t23-delta-readonly.mjs';
import {fingerprintRows,compareSnapshots} from '../../scripts/migration-audit.mjs';

const sql='select to_jsonb(t)::text as value from "public"."daily_revenue" t order by to_jsonb(t)::text collate "C"';
const row=(id,amount='9007199254740993',micros='"2026-11-13T12:00:00.000001+00:00"')=>({
  value:`{"id":${id},"amount":${amount},"updated_at":${micros}}`,fields:{id,amount,updated_at:micros}});
const table=rows=>({keys:['id'],rows});
function fixture({wrongHash=false,badFields=false,pkColumns=['id'],limits}={}){
  const record=row('"00000000-0000-4000-8000-000000000001"'),queries=[];
  const db={query:async query=>{queries.push(query);
    if(query.includes('FROM pg_index'))return {rows:[{schema:'public',name:'daily_revenue',columns:pkColumns}]};
    if(query.startsWith('select to_jsonb(t)'))return {rows:[{value:record.value,
      field_texts:JSON.stringify(badFields?{...record.fields,amount:42}:record.fields)}]};
    return {rows:[]};}};
  const audit={fingerprintRows,snapshotDatabase:async adapter=>{
    await adapter.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await adapter.query(sql);
    await adapter.query('ROLLBACK');
    return {'data:public.daily_revenue':{count:result.rows.length,hash:wrongHash?'wrong':fingerprintRows(result.rows.map(r=>r.value))}};
  }};
  return {queries,record,run:verify=>captureInventory(db,audit,verify,limits)};
}

test('captures unchanged auditor values with lossless SQL field text inside its read-only transaction',async()=>{
  const f=fixture();let verified=false;
  const captured=await f.run(async()=>{verified=true;assert.match(f.queries[0],/READ ONLY/);});
  assert.equal(verified,true);assert.equal(captured.tables.get('public.daily_revenue').rows[0].fields.amount,'9007199254740993');
  assert.equal(captured.snapshot['data:public.daily_revenue'].hash,fingerprintRows([f.record.value]));
  assert.match(f.queries[2],/jsonb_object_agg\(e.key,e.value::text\)/);
  assert.match(f.queries[1],/array_agg\(a.attname::text ORDER BY k.position\)/);
  assert.match(f.queries[2],/LIMIT 25001$/);assert.equal(f.queries.at(-1),'ROLLBACK');
});

test('rejects inconsistent capture fingerprints, row/byte overflow and non-string column values',async()=>{
  await assert.rejects(fixture({wrongHash:true}).run(),{code:'DELTA_CAPTURE_FINGERPRINT_MISMATCH'});
  await assert.rejects(fixture({limits:{rows:0,totalRows:10,bytes:10000}}).run(),{code:'DELTA_ROW_LIMIT'});
  await assert.rejects(fixture({limits:{rows:10,totalRows:10,bytes:1}}).run(),{code:'DELTA_BYTE_LIMIT'});
  await assert.rejects(fixture({badFields:true}).run(),{code:'DELTA_COLUMN_CAPTURE_INVALID'});
  await assert.rejects(fixture({pkColumns:'{id}'}).run(),{code:'DELTA_PK_METADATA_TYPE'});
});

test('compares UUID composite identities, adjacent bigints, decimals and microseconds without numeric conversion',()=>{
  const id='"00000000-0000-4000-8000-000000000001"';
  const source=table([row(id),row('"source-only-private-uuid"','123.4500')]);
  const target=table([row(id,'9007199254740992','"2026-11-13T12:00:00.000002+00:00"'),row('"target-only-private-uuid"')]);
  assert.deepEqual(diffRows(source,target),{sourceRows:2,targetRows:2,primaryKeyMatch:true,comparison:'primary-key',
    sourceOnlyRows:1,targetOnlyRows:1,changedMatchedRows:1,columns:[{name:'amount',rows:1},{name:'updated_at',rows:1}]});
  const composite={keys:['id','amount'],rows:[row(id,'0.00000000000000000001')]};
  assert.equal(diffRows(composite,{...composite,rows:[row(id,'0.00000000000000000002')]}).sourceOnlyRows,1);
  assert.equal(diffRows(table([row(id,'1.01')]),table([row(id,'1.02')])).changedMatchedRows,1);
});

test('duplicate primary keys fail, while missing or changed keys use exact duplicate-aware multisets',()=>{
  assert.throws(()=>diffRows(table([row('1'),row('1')]),table([])),{code:'DELTA_DUPLICATE_PRIMARY_KEY'});
  const result=diffRows({keys:[],rows:[row('1'),row('1')]},{keys:[],rows:[row('1')]});
  assert.equal(result.sourceOnlyRows,1);assert.equal(result.targetOnlyRows,0);
  assert.equal(result.changedMatchedRows,null);assert.equal(result.comparison,'row-multiset');
  assert.equal(diffRows({keys:['id'],rows:[row('1')]},{keys:['amount'],rows:[row('1')]}).primaryKeyMatch,false);
});

test('reports only counts, technical names and sequence equality, with no row values or fingerprints',()=>{
  const id='"PRIVATE_UUID"',a=table([row(id,'9007199254740993')]),b=table([row(id,'9007199254740992')]);
  const source={snapshot:{'data:public.daily_revenue':{count:1,hash:'PRIVATE_HASH_A'},
    'schema:columns':{count:3,hash:'PRIVATE_SCHEMA_A'},'sequence:public.counter':{last_value:'PRIVATE_SEQ_A',is_called:true}},
    tables:new Map([['public.daily_revenue',a]]),startedUtc:'2026-11-13T00:00:00Z',finishedUtc:'2026-11-13T00:00:01Z'};
  const target={...source,snapshot:{'data:public.daily_revenue':{count:1,hash:'PRIVATE_HASH_B'},
    'schema:columns':{count:4,hash:'PRIVATE_SCHEMA_B'},'sequence:public.counter':{last_value:'PRIVATE_SEQ_B',is_called:true}},
    tables:new Map([['public.daily_revenue',b]])};
  const report=inventoryReport(source,target,{compareSnapshots}),printed=JSON.stringify(report);
  assert.equal(report.inventoryComplete,true);assert.equal(report.finalFreezeAudit,false);assert.equal(report.strictMatch,false);
  assert.deepEqual(report.sequences,[{object:'public.counter',sourcePresent:true,targetPresent:true,lastValueEqual:false,calledEqual:true}]);
  assert.deepEqual(report.schema,[{group:'schema:columns',sourceRows:3,targetRows:4}]);
  assert.doesNotMatch(printed,/PRIVATE_|900719925474099[23]/);
});

test('safe failures classify real pg code-less errors without logging message, detail, SQL or stack',()=>{
  assert.deepEqual(safeFailure(new Error('Query read timeout')),{code:'PG_QUERY_READ_TIMEOUT'});
  assert.deepEqual(safeFailure(new Error('Connection terminated unexpectedly')),{code:'PG_CONNECTION_TERMINATED'});
  assert.deepEqual(safeFailure(Object.assign(new Error('PRIVATE_SQL'),{code:'42501',detail:'PRIVATE_ROW'})),{code:'42501'});
  assert.deepEqual(safeFailure(new TypeError('PRIVATE_ROW')),{code:'JS_TYPEERROR'});
  assert.deepEqual(safeFailure(new Error('PRIVATE_CREDENTIAL')),{code:'UNCLASSIFIED_FAILURE'});
  assert.deepEqual(safeFailure(new Error('Missing required table: auth.users')),{code:'AUDIT_REQUIRED_TABLE_MISSING',object:'auth.users'});
  assert.doesNotMatch(JSON.stringify(safeFailure(new Error('Missing required table: PRIVATE_CREDENTIAL'))),/PRIVATE/);
});

test('query diagnostics retain the failed operation after auditor rollback, with only safe technical context',async()=>{
  const context={},db=observeQueries({query:async query=>{
    if(query==='rollback')return {rows:[]};
    throw Object.assign(new Error('Query read timeout'),{detail:'PRIVATE_ROW',query:'PRIVATE_SQL'});
  }},'source',context);
  await assert.rejects(db.query(sql));
  await db.query('rollback');
  assert.equal(context.last.operation,'rollback');assert.equal(context.failure.operation,'table_rows');
  assert.equal(context.failure.object,'public.daily_revenue');assert.equal(context.failure.side,'source');
  assert.equal(context.failure.ordinal,1);assert.equal(context.failure.code,'PG_QUERY_READ_TIMEOUT');
  assert.equal(typeof context.failure.elapsedMs,'number');assert.doesNotMatch(JSON.stringify(context),/PRIVATE_|select|from|password/);
});
