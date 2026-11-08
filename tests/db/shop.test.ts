import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from './harness';
// @ts-expect-error shared JS backup helper
import { exportData, restoreData } from '../../scripts/backup-lib.mjs';
const OWNER='alpha.owner@demo.example.com',OTHER='beta.owner@demo.example.com',MANAGER='fm@demo.example.com';
const P='10000000-0000-0000-0000-000000000001',Q='10000000-0000-0000-0000-000000000002',UNKNOWN='10000000-0000-0000-0000-000000000003';
const STORE='20000000-0000-0000-0000-000000000001',ORG='20000000-0000-0000-0000-000000000002',FOLDER='20000000-0000-0000-0000-000000000003';
const CP='30000000-0000-0000-0000-000000000001',CP2='30000000-0000-0000-0000-000000000002',TYPE='30000000-0000-0000-0000-000000000003',CURRENCY='30000000-0000-0000-0000-000000000004';
let t:TestDb; let alpha:string,beta:string,managerId:string; let version:string;
type R={id:string;version:number;source:string;status:string;counterparty_id:string;items:any[];integration:any};
const one=async<T=any>(who:string|null,sql:string,args:unknown[]=[]) => (await t.as<{j:T}>(who,sql,args))[0].j;
const adminOne=async<T=any>(sql:string,args:unknown[]=[]) => (await t.admin<{j:T}>(sql,args))[0].j;
const service=async<T=any>(sql:string,args:unknown[]=[])=>t.db.transaction(async tx=>{
  await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'service_role'})]);
  await tx.exec('set local role service_role'); return (await tx.query<{j:T}>(sql,args)).rows[0]?.j;
});
const cat=()=>one<any>(OWNER,'select public.procurement_catalog() j');
const checkout=(items=[{product_id:P,quantity:8,price_minor:50000}],op=randomUUID(),v=version)=>one<R>(OWNER,'select public.procurement_checkout($1,$2::jsonb,$3,$4,$5) j',[op,JSON.stringify(items),v,'partial','Адрес уже известен менеджеру']);
const claim=()=>service<any>('select public.shop_worker_claim() j');
const result=(job:any,status:string,data:unknown)=>service<any>('select public.shop_worker_result($1,$2,$3,$4::jsonb) j',[job.id,job.lease_token,status,JSON.stringify(data)]);
const rows=[{product_id:P,name:'Согласованная плёнка',code:'A',uom:'Лист',category:'Принты',stock:11,reserve:2,unallocated_reserve:1,in_transit:50},
 {product_id:Q,name:'Только второй партнёр',code:'B',uom:'Лист',category:'Принты',stock:20,reserve:0,unallocated_reserve:0,in_transit:0},
 {product_id:UNKNOWN,name:'Индивидуальная поставка',code:'C',uom:'Лист',category:'Принты',stock:0,reserve:0,unallocated_reserve:0,in_transit:0}];
async function importSnapshot(overrides:any={}) {
  const ctx=await service<any>('select public.shop_worker_context() j'); version=randomUUID();
  const data={settings_version:ctx.settings_version,catalog:{rows,store_id:STORE,fetched_at:new Date().toISOString()},prices:ctx.partners.map((p:any)=>({partner_id:p.partner_id,config_version:p.config_version,version:p.partner_id===alpha?version:randomUUID(),fetched_at:new Date().toISOString(),currency:'RUB',currency_id:CURRENCY,rate:1,
    rows:p.partner_id===alpha?[{product_id:P,price_minor:50000,vat:0,vat_enabled:false},{product_id:UNKNOWN,price_minor:null,vat:0,vat_enabled:false}]:[{product_id:Q,price_minor:65000,vat:0,vat_enabled:false}]})),...overrides};
  await service('select public.shop_worker_import($1::jsonb) j',[JSON.stringify(data)]); return data;
}
beforeAll(async()=>{
 t=await createTestDb(); alpha=(await t.admin<{id:string}>("select id from public.partner where code='ALPHA'"))[0].id; beta=(await t.admin<{id:string}>("select id from public.partner where code='BETA'"))[0].id; managerId=await t.userId(MANAGER);
 await t.admin('insert into app_private.supply_counterparty(counterparty_id,partner_id) values($1,$2),($3,$4)',[CP,alpha,CP2,beta]);
 await t.admin(`insert into app_private.procurement_shop_partner(partner_id,enabled,counterparty_id,price_type_id,currency,currency_id,allowed_folder_ids,allowed_product_ids,discounts_verified_absent,vat_enabled,vat_included,verified_by,verified_at,verification_note)
 values($1,true,$2,$3,'RUB',$4,array[$5::uuid],array[$6::uuid,$7::uuid],true,true,true,$8,now(),'Проверено на синтетическом контуре'),($9,true,$10,$3,'RUB',$4,array[$5::uuid],array[$11::uuid],true,true,true,$8,now(),'Проверено')`,[alpha,CP,TYPE,CURRENCY,FOLDER,P,UNKNOWN,managerId,beta,CP2,Q]);
},180000);
beforeEach(async()=>{
 await t.admin('truncate app_private.procurement_order_outbox,app_private.procurement_event,app_private.procurement_request,app_private.operation_receipt');
 await t.admin('update app_private.supply_counterparty set partner_id=$1 where counterparty_id=$2',[alpha,CP]);
 await t.admin("update public.app_user set status='active' where id=$1",[await t.userId(OWNER)]);
 await t.admin('update app_private.procurement_shop_partner set enabled=true,allowed_product_ids=case when partner_id=$1 then array[$2::uuid,$3::uuid] else array[$4::uuid] end',[alpha,P,UNKNOWN,Q]);
 await t.admin(`update app_private.procurement_shop_settings set enabled=true,organization_id=$1,store_id=$2,folder_ids=array[$3::uuid],verified_by=$4,verification_note='Проверено в тесте' where singleton`,[ORG,STORE,FOLDER,managerId]);
 await importSnapshot();
});
afterAll(async()=>{await t?.db.close();});

describe('personal shop and durable MS order queue',()=>{
 it('private prices and assortment are scoped; missing prices stay null',async()=>{
  const a=await cat(),b=await one<any>(OTHER,'select public.procurement_catalog() j');
  expect(a.shop.enabled).toBe(true); expect(a.items.map((x:any)=>x.product_id).sort()).toEqual([P,UNKNOWN].sort());
  expect(a.items.find((x:any)=>x.product_id===P).price_minor).toBe(50000); expect(a.items.find((x:any)=>x.product_id===UNKNOWN).price_minor).toBeNull();
  expect(b.items.map((x:any)=>x.product_id)).toEqual([Q]); expect(b.items[0].price_minor).toBe(65000);
  const m=await one<any>(MANAGER,'select public.procurement_catalog() j'); expect(m.items.every((x:any)=>x.price_minor===null)).toBe(true);
 });
 it('worker RPCs and key authorization cannot be called by clients or anon',async()=>{
  const grants=await t.admin<{name:string;client:boolean;anon:boolean;worker:boolean}>(`select p.proname name,has_function_privilege('authenticated',p.oid,'execute') client,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('service_role',p.oid,'execute') worker from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'shop_worker_%'`);
  expect(grants).toHaveLength(6); expect(grants.every(x=>!x.client&&!x.anon&&x.worker)).toBe(true);
  await expect(one(OWNER,'select public.shop_worker_claim() j')).rejects.toThrow(/permission denied/);
  await expect(t.as(OWNER,'select * from app_private.procurement_order_outbox')).rejects.toThrow(/permission denied/);
  expect(await service('select public.shop_worker_authorize($1) j',['x'.repeat(64)])).toBe(false);
  await t.admin("insert into app_private.procurement_worker_auth(key_hash) values(extensions.digest($1,'sha256')) on conflict(singleton) do update set key_hash=excluded.key_hash",['x'.repeat(64)]);
  expect(await service('select public.shop_worker_authorize($1) j',['x'.repeat(64)])).toBe(true);
  expect(await service('select public.shop_worker_authorize($1) j',['z'.repeat(64)])).toBe(false);
 });
 it('direct checkout freezes prices and one syncId, creates no reserve and replays exactly once',async()=>{
  const op=randomUUID(),r=await checkout(undefined,op),again=await checkout(undefined,op);
  expect(again).toEqual(r); expect(r.source).toBe('checkout'); expect(r.status).toBe('accepted'); expect(r.integration.status).toBe('queued');
  const out=await adminOne<any>('select to_jsonb(o) j from app_private.procurement_order_outbox o where request_id=$1',[r.id]);
  expect(out.payload.syncId).toBe(out.sync_id); expect(out.payload.positions[0]).toMatchObject({quantity:8,price:50000,reserve:0,discount:0,vat:0,vatEnabled:false});
  expect(out.payload.agent.meta.href.endsWith('/'+CP)).toBe(true); expect(out.payload.description).toContain('сейчас 8'); expect(out.payload.description).toContain('Адрес уже известен');
  expect(r.items[0].reserved_qty).toBe(0); expect((await cat()).items.find((x:any)=>x.product_id===P).free_now).toBe(8);
  await expect(checkout([{product_id:P,quantity:7,price_minor:50000}],op)).rejects.toThrow('idempotency-conflict');
  await expect(t.admin("update app_private.procurement_order_outbox set payload='{}' where id=$1",[out.id])).rejects.toThrow('Frozen');
 });
 it('rejects client price changes, unknown price, excess quantity, stale stock and stale quote',async()=>{
  await expect(checkout([{product_id:P,quantity:8,price_minor:1}])).rejects.toThrow('version-conflict');
  await expect(checkout([{product_id:UNKNOWN,quantity:1,price_minor:50000}])).rejects.toThrow('validation');
  await expect(checkout([{product_id:P,quantity:20,price_minor:50000}])).rejects.toThrow('validation');
  await expect(checkout(undefined,randomUUID(),randomUUID())).rejects.toThrow('version-conflict');
  await t.admin("update app_private.procurement_catalog set fetched_at=now()-interval '6 minutes'");
  await expect(checkout()).rejects.toThrow('external-unavailable');
  await t.admin('update app_private.procurement_catalog set fetched_at=now()');
  await t.admin("update app_private.procurement_price_snapshot set fetched_at=now()-interval '6 minutes' where partner_id=$1",[alpha]);
  await expect(checkout()).rejects.toThrow('version-conflict');
 });
 it('worker health gates checkout; disabled worker never claims new writes',async()=>{
  await service("select public.shop_worker_heartbeat('disabled','missing-token') j");
  expect((await cat()).shop).toMatchObject({enabled:false,reason:'worker-unavailable',error_code:'missing-token'});
  await expect(checkout()).rejects.toThrow('integration-pending');
  await service("select public.shop_worker_heartbeat('ok') j");
  await t.admin("update app_private.procurement_shop_settings set last_success_at=now()-interval '6 minutes'");
  await expect(checkout()).rejects.toThrow('integration-pending');
 });
 it('leases one job, rejects stale acknowledgements, and reconciles an ambiguous result with the same payload',async()=>{
  const r=await checkout(),job=await claim(); expect(job.request_id).toBe(r.id); expect(job.mode).toBe('create'); expect(await claim()).toBeNull();
  expect(await result({...job,lease_token:randomUUID()},'created',{order_id:randomUUID()})).toMatchObject({applied:false});
  const ack=await result(job,'ambiguous',{error_code:'network'}); expect(ack.status).toBe('reconciling');
  expect(await result(job,'ambiguous',{error_code:'network'})).toEqual(ack);
  expect(await claim()).toBeNull();
  await t.admin('update app_private.procurement_order_outbox set next_attempt_at=now() where id=$1',[job.id]);
  const again=await claim(); expect(again.mode).toBe('reconcile'); expect(again.sync_id).toBe(job.sync_id); expect(again.payload).toEqual(job.payload); expect(again.lease_token).not.toBe(job.lease_token);
  expect(await result(again,'retry',{error_code:'network'})).toMatchObject({status:'retry'});
  await t.admin('update app_private.procurement_order_outbox set next_attempt_at=now() where id=$1',[job.id]);
  const retryReconcile=await claim(); expect(retryReconcile.mode).toBe('reconcile');
  const id=randomUUID(); expect(await result(retryReconcile,'created',{order_id:id})).toMatchObject({applied:true,status:'created'});
  const lists=await one<any>(OWNER,'select public.procurement_list() j'); expect(lists.requests[0].integration).toMatchObject({status:'created',order_id:id});
  expect(lists.requests[0].items[0].reserved_qty).toBe(0);
 });
 it('expired lease is reconciliation-only, including after actor revocation or mapping change',async()=>{
  await checkout(); const job=await claim();
  await t.admin("update app_private.procurement_order_outbox set lease_until=now()-interval '1 second' where id=$1",[job.id]);
  await t.admin("update public.app_user set status='suspended' where id=$1",[await t.userId(OWNER)]);
  const reconcile=await claim(); expect(reconcile.mode).toBe('reconcile'); expect(reconcile.reconcile_only).toBe(true); expect(reconcile.block_reason).toBe('actor-revoked');
  expect(await result(job,'created',{order_id:randomUUID()})).toMatchObject({applied:false});
 });
 it('reconciliation remains available when an older new order is waiting for healthy sync',async()=>{
  await checkout(); const second=await checkout();
  await t.admin("update app_private.procurement_order_outbox set status='reconciling',reconciliation_required=true where request_id=$1",[second.id]);
  await service("select public.shop_worker_heartbeat('error','network') j");
  const job=await claim(); expect(job.request_id).toBe(second.id); expect(job.mode).toBe('reconcile');
  expect(await claim()).toBeNull();
 });
 it('checkout rejects anonymous, a different partner assortment and revoked users',async()=>{
  const args=[randomUUID(),JSON.stringify([{product_id:P,quantity:1,price_minor:50000}]),version,'partial',''];
  await expect(one(null,'select public.procurement_checkout($1,$2::jsonb,$3,$4,$5) j',args)).rejects.toThrow(/permission denied/);
  const other=await one<any>(OTHER,'select public.procurement_catalog() j');
  await expect(one(OTHER,'select public.procurement_checkout($1,$2::jsonb,$3,$4,$5) j',[args[0],args[1],other.shop.price_version,...args.slice(3)])).rejects.toThrow('validation');
  await t.admin("update public.app_user set status='suspended' where id=$1",[await t.userId(OWNER)]);
  await expect(checkout()).rejects.toThrow();
 });
 it('current counterparty ownership is rechecked for prices, checkout and queued writes',async()=>{
  await checkout(); await t.admin('update app_private.supply_counterparty set partner_id=$1 where counterparty_id=$2',[beta,CP]);
  const c=await cat(); expect(c.shop.enabled).toBe(false); expect(c.items.every((x:any)=>x.price_minor===null)).toBe(true);
  await expect(checkout()).rejects.toThrow('integration-pending'); expect(await claim()).toBeNull();
  const status=await adminOne<any>('select jsonb_build_object(\'status\',status,\'error\',error_code) j from app_private.procurement_order_outbox');
  expect(status).toEqual({status:'blocked',error:'mapping-mismatch'});
 });
 it('accepted negotiated 8+12 offers enqueue both prices and ETA; unknown catalog price can still be quoted',async()=>{
  const sub=await one<R>(OWNER,'select public.procurement_submit($1,$2::jsonb,$3,$4) j',[randomUUID(),JSON.stringify([{product_id:P,quantity:20},{product_id:UNKNOWN,quantity:2}]),'together','Отправить всё вместе']);
  const offer={counterparty_id:CP,currency:'RUB',shipment_mode:'together',valid_until:new Date(Date.now()+86400000).toISOString(),note:'Поставщик подтвердил условия',items:[
    {product_id:P,now_qty:8,later_qty:12,refused_qty:0,now_price_minor:49000,later_price_minor:51000,eta:new Date(Date.now()+7*86400000).toISOString().slice(0,10),refusal_reason:''},
    {product_id:UNKNOWN,now_qty:0,later_qty:2,refused_qty:0,now_price_minor:null,later_price_minor:99000,eta:new Date(Date.now()+9*86400000).toISOString().slice(0,10),refusal_reason:''}]};
  const offered=await one<R>(MANAGER,'select public.procurement_action($1,$2,$3,$4::jsonb,$5) j',[sub.id,sub.version,'offer',JSON.stringify(offer),randomUUID()]);
  const accepted=await one<R>(OWNER,"select public.procurement_action($1,$2,'accept','{}',$3) j",[offered.id,offered.version,randomUUID()]);
  expect(accepted.integration.status).toBe('queued'); const job=await claim(); expect(job.kind).toBe('accepted_offer');
  expect(job.payload.positions.map((p:any)=>[p.quantity,p.price])).toEqual([[8,49000],[12,51000],[2,99000]]);
  expect(job.validation.expected_units).toEqual([{product_id:P,uom:'Лист'},{product_id:UNKNOWN,uom:'Лист'}]);
  expect(job.payload.description).toContain('под заказ 12'); expect(job.payload.description).toContain('одной поставкой'); expect(job.payload.description).toContain('Поставщик подтвердил');
  expect(job.payload.deliveryPlannedMoment.startsWith(offer.items[1].eta)).toBe(true);
 });
 it('no backfill is performed for accepted requests while disabled and impossible VAT cannot add hidden amounts',async()=>{
  await t.admin('update app_private.procurement_shop_settings set enabled=false');
  const sub=await one<R>(OWNER,'select public.procurement_submit($1,$2::jsonb,$3,$4) j',[randomUUID(),JSON.stringify([{product_id:P,quantity:1}]),'partial','']);
  await t.admin("update app_private.procurement_request set status='accepted',accepted_at=now() where id=$1",[sub.id]);
  expect((await t.admin('select id from app_private.procurement_order_outbox')).length).toBe(0);
  await t.admin('update app_private.procurement_shop_settings set enabled=true');
  expect((await t.admin('select id from app_private.procurement_order_outbox')).length).toBe(0);
  await expect(t.admin('update app_private.procurement_shop_partner set vat_enabled=true,vat_included=false where partner_id=$1',[alpha])).rejects.toThrow(/check constraint/);
 });
 it('snapshots are atomic and backup covers outbox, price policy, configuration and hash only',async()=>{
  const data=await importSnapshot(); const oldVersion=version; data.prices[0].rows[0].buyPrice=999;
  await expect(service('select public.shop_worker_import($1::jsonb) j',[JSON.stringify(data)])).rejects.toThrow('Unexpected');
  expect((await cat()).shop.price_version).toBe(oldVersion);
  const op=randomUUID(), created=await checkout(undefined,op);
  await t.admin("insert into app_private.procurement_worker_auth(key_hash) values(extensions.digest($1,'sha256')) on conflict(singleton) do update set key_hash=excluded.key_hash",['x'.repeat(64)]);
  const dump=await exportData(t.db);
  for(const key of ['procurement_shop_settings','procurement_shop_partner','procurement_price_snapshot','procurement_order_outbox','procurement_worker_auth']) expect(key in dump.private_tables).toBe(true);
  expect(dump.private_tables.procurement_order_outbox).toHaveLength(1);
  expect(JSON.stringify(dump.private_tables.procurement_worker_auth)).not.toContain('x'.repeat(64));
  await restoreData(t.db,dump,{wipe:true});
  const restored=await exportData(t.db);
  for(const key of ['procurement_shop_settings','procurement_shop_partner','procurement_price_snapshot','procurement_order_outbox','procurement_worker_auth']) expect(restored.private_tables[key]).toEqual(dump.private_tables[key]);
  expect(await service('select public.shop_worker_authorize($1) j',['x'.repeat(64)])).toBe(true);
  expect(await checkout(undefined,op)).toEqual(created);
 });
});
