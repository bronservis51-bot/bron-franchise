import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb, type TestDb } from './harness';
import type { ProcurementRequest, ProcurementList, ProcurementCatalog, ProcurementOffer } from '../../src/modules/orders/types';

const MANAGER='fm@demo.example.com', OWNER='alpha.owner@demo.example.com', OTHER='beta.owner@demo.example.com', STAFF='79000000011@staff.bron.local';
const product='10000000-0000-0000-0000-000000000001', product2='10000000-0000-0000-0000-000000000002';
const store='20000000-0000-0000-0000-000000000001', counterparty='30000000-0000-0000-0000-000000000001';
let t:TestDb; let partner:string;
const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
const one=async<T>(who:string|null,sql:string,params:unknown[]=[]) => (await t.as<{j:T}>(who,sql,params))[0].j;
const catalog=()=>one<ProcurementCatalog>(OWNER,'select public.procurement_catalog() j');
const list=(who=OWNER)=>one<ProcurementList>(who,'select public.procurement_list() j');
const products=[{product_id:product,name:'Плёнка проверочная',code:'QA1',uom:'Лист',category:'Принты',stock:11,reserve:2,unallocated_reserve:1,in_transit:50},
  {product_id:product2,name:'Матовый материал',code:'QA2',uom:'шт',category:'Текстура',stock:3,reserve:0,unallocated_reserve:0,in_transit:0}];
const submit=(mode='partial',op=randomUUID(),items=[{product_id:product,quantity:20}])=>one<ProcurementRequest>(OWNER,'select public.procurement_submit($1,$2::jsonb,$3,$4) j',[op,JSON.stringify(items),mode,'Доставить на точку']);
const action=(who:string,r:ProcurementRequest,a:string,data:unknown={},op=randomUUID())=>one<ProcurementRequest>(who,'select public.procurement_action($1,$2,$3,$4::jsonb,$5) j',[r.id,r.version,a,JSON.stringify(data),op]);
const offer=(r:ProcurementRequest):ProcurementOffer=>({counterparty_id:counterparty,currency:'RUB',shipment_mode:r.shipment_mode,valid_until:new Date(Date.now()+86400000).toISOString(),note:'Склад проверен, поставщик подтвердил цену и срок',
  items:r.items.map(i=>({product_id:i.product_id,now_qty:i.product_id===product?8:3,later_qty:i.product_id===product?12:0,refused_qty:0,now_price_minor:50000,later_price_minor:52000,eta:day(14),refusal_reason:''}))});
const progress=(id:string,quantity:number)=>({items:[{product_id:id,quantity}],document_id:randomUUID(),note:'Проверено вручную в МойСклад'});

beforeAll(async()=>{
  t=await createTestDb(); partner=(await t.admin<{id:string}>("select id from public.partner where code='ALPHA'"))[0].id;
  await t.admin('insert into app_private.supply_counterparty(counterparty_id,partner_id) values($1,$2)',[counterparty,partner]);
  await t.admin('select app_private.procurement_catalog_store($1::jsonb,$2,now())',[JSON.stringify(products),store]);
},180000);
afterAll(async()=>{await t?.db.close();});

describe('procurement approval boundary',()=>{
  it('uses physical stock minus warehouse and unallocated reserves; expected inbound is separate',async()=>{
    const c=await catalog(); expect(c.stale).toBe(false); expect(c.items[0].product_id).toBe(product2);
    const p=c.items.find(i=>i.product_id===product)!; expect(p.free_now).toBe(8); expect(p.in_transit).toBe(50); expect(p.confirmed_incoming_qty).toBe(0);
    const r=await submit(); expect(r.items[0].requested_now).toBe(8); expect(r.items[0].requested_later).toBe(12);
    expect(r.status).toBe('submitted'); expect(r.counterparty_id).toBeNull(); expect(r.items[0].now_price_minor).toBeNull();
    expect((await catalog()).items.find(i=>i.product_id===product)!.free_now).toBe(8); // request never reduces a stock snapshot
  });
  it('retries return one immutable receipt and reject an edited payload',async()=>{
    const op=randomUUID(); const before=(await list()).total;
    const a=await submit('partial',op), b=await submit('partial',op); expect(b).toEqual(a); expect((await list()).total).toBe(before+1);
    await t.expectError(OWNER,'select public.procurement_submit($1,$2::jsonb,$3,$4)','idempotency-conflict',[op,JSON.stringify([{product_id:product,quantity:21}]),'partial','Доставить на точку']);
  });
  it('denies anonymous, staff, foreign partner and client private table/import access',async()=>{
    const r=await submit(); expect((await list(OTHER)).requests).toHaveLength(0);
    await expect(t.as(null,'select public.procurement_catalog()')).rejects.toThrow(/permission denied/);
    await t.expectError(STAFF,'select public.procurement_catalog()','forbidden');
    await t.expectError(OTHER,'select public.procurement_action($1,1,$2,$3::jsonb,$4)','forbidden',[r.id,'cancel',JSON.stringify({note:'x'}),randomUUID()]);
    await expect(t.as(OWNER,'select * from app_private.procurement_catalog')).rejects.toThrow(/permission denied/);
    await expect(t.as(OWNER,'select app_private.procurement_catalog_store($1::jsonb,$2,now())',[JSON.stringify(products),store])).rejects.toThrow(/permission denied/);
    await t.expectError(OWNER,'select public.procurement_action($1,1,$2,$3::jsonb,$4)','forbidden',[r.id,'offer',JSON.stringify(offer(r)),randomUUID()]);
  });
  it('requires verified counterparty and records exact offer; changed conditions need a new acceptance',async()=>{
    let r=await submit(); const invalid=offer(r); invalid.counterparty_id=randomUUID();
    await expect(action(MANAGER,r,'offer',invalid)).rejects.toThrow('validation');
    const old=r; r=await action(MANAGER,r,'offer',offer(r)); expect(r.version).toBe(2); expect(r.currency).toBe('RUB');
    expect(r.counterparties).toEqual([{id:counterparty,name:'Виктор (Волгоград)'}]);
    await expect(action(OWNER,old,'accept')).rejects.toThrow('version-conflict');
    const previous=r; const changed=offer(r); changed.items[0].later_price_minor=53000; r=await action(MANAGER,r,'offer',changed);
    await expect(action(OWNER,previous,'accept')).rejects.toThrow('version-conflict');
    r=await action(OWNER,r,'accept'); expect(r.status).toBe('accepted');
    await expect(action(MANAGER,r,'offer',offer(r))).rejects.toThrow('transition-not-allowed');
    expect(r.history.map(e=>e.action)).toEqual(['submit','offer','offer','accept']);
    const demand=(await list(MANAGER)).demand.find(d=>d.product_id===product)!; expect(demand.quantity).toBe(12);
  });
  it('works end-to-end 8 + 12 with partial dispatch, purchase demand, manual MS references and receiving',async()=>{
    let r=await submit(); r=await action(MANAGER,r,'offer',offer(r)); r=await action(OWNER,r,'accept');
    const before=(await list(MANAGER)).demand.find(d=>d.product_id===product)!.quantity;
    await expect(action(MANAGER,r,'reserve',{items:[{product_id:product,quantity:8}],note:'checked'})).rejects.toThrow('validation');
    const op=randomUUID(), previous=r, data=progress(product,8);
    r=await action(MANAGER,r,'reserve',data,op); expect(r.items[0].reserved_qty).toBe(8);
    expect(await action(MANAGER,previous,'reserve',data,op)).toEqual(r);
    await expect(action(MANAGER,r,'ship',progress(product,9))).rejects.toThrow('validation');
    r=await action(MANAGER,r,'ship',progress(product,8)); r=await action(OWNER,r,'receive',{items:[{product_id:product,quantity:8}],note:'Получены 8 листов'});
    expect(r.status).toBe('accepted'); expect(r.items[0].received_qty).toBe(8);
    r=await action(MANAGER,r,'purchase',progress(product,12));
    expect((await list(MANAGER)).demand.find(d=>d.product_id===product)?.quantity??0).toBe(before-12);
    r=await action(MANAGER,r,'reserve',progress(product,12)); r=await action(MANAGER,r,'ship',progress(product,12));
    r=await action(OWNER,r,'receive',{items:[{product_id:product,quantity:12}],note:'Получены остальные 12'});
    expect(r.status).toBe('completed'); expect(r.items[0].received_qty).toBe(20);
    expect((await catalog()).items.find(i=>i.product_id===product)!.free_now).toBe(8);
  });
  it('together mode requires all lines and quantities prepared and shipped in one event',async()=>{
    let r=await submit('together',randomUUID(),[{product_id:product,quantity:20},{product_id:product2,quantity:3}]);
    r=await action(MANAGER,r,'offer',offer(r)); r=await action(OWNER,r,'accept');
    r=await action(MANAGER,r,'reserve',progress(product,8));
    await expect(action(MANAGER,r,'ship',progress(product,8))).rejects.toThrow('policy-split-required');
    r=await action(MANAGER,r,'purchase',progress(product,12));
    r=await action(MANAGER,r,'reserve',{...progress(product,12),items:[{product_id:product,quantity:12},{product_id:product2,quantity:3}]});
    await expect(action(MANAGER,r,'ship',progress(product,20))).rejects.toThrow('policy-split-required');
    r=await action(MANAGER,r,'ship',{...progress(product,20),items:[{product_id:product,quantity:20},{product_id:product2,quantity:3}]});
    expect(r.items.map(i=>i.shipped_qty)).toEqual([20,3]);
  });
  it('refusals require reasons, do not become purchasing demand, and preserve history',async()=>{
    let r=await submit(); const data=offer(r); data.items[0]={...data.items[0],later_qty:0,refused_qty:12};
    await expect(action(MANAGER,r,'offer',data)).rejects.toThrow('validation');
    data.items[0].refusal_reason='Поставщик снял с производства'; r=await action(MANAGER,r,'offer',data); r=await action(OWNER,r,'decline',{note:'Без 12 листов заказ не нужен'});
    expect(r.status).toBe('declined'); expect(r.history.at(-1)?.note).toBe('Без 12 листов заказ не нужен');
  });
  it('stale snapshots remain visible but do not promise available or confirmed quantities',async()=>{
    await t.admin("update app_private.procurement_catalog set fetched_at=now()-interval '1 hour'");
    const c=await catalog(); expect(c.stale).toBe(true); expect(c.items.every(i=>i.free_now===null)).toBe(true);
    const r=await submit(); expect(r.items[0].requested_now).toBeNull(); expect(r.items[0].requested_later).toBeNull();
    await t.admin('select app_private.procurement_catalog_store($1::jsonb,$2,now())',[JSON.stringify(products),store]);
  });
  it('partial/invalid snapshot replaces nothing and confirmed inbound requires evidence',async()=>{
    await expect(t.admin('select app_private.procurement_catalog_store($1::jsonb,$2,now())',[JSON.stringify([{...products[0],buyPrice:1234}]),store])).rejects.toThrow('Unexpected');
    await expect(t.admin('select app_private.procurement_catalog_store($1::jsonb,$2,now())',[JSON.stringify([{...products[0],confirmed_incoming_qty:12}]),store])).rejects.toThrow('Confirmed incoming');
    expect((await catalog()).items).toHaveLength(2);
  });
  it('confirmed arrivals persist through stock sync, keep distinct delivery dates and require manager evidence',async()=>{
    const po=randomUUID(); const op=randomUUID(); const d={product_id:product,purchase_order_id:po,quantity:12,eta:day(14),note:'Поставщик подтвердил заказ; остаток проверен',expected_version:0};
    const set=(who:string,data:unknown,operation=randomUUID())=>one<{version:number}>(who,'select public.procurement_incoming_set($1::jsonb,$2) j',[JSON.stringify(data),operation]);
    await expect(set(OWNER,d)).rejects.toThrow('forbidden');
    const result=await set(MANAGER,d,op); expect(result.version).toBe(1); expect(await set(MANAGER,d,op)).toEqual(result);
    await expect(set(MANAGER,{...d,quantity:13},op)).rejects.toThrow('idempotency-conflict');
    await expect(set(MANAGER,{...d,quantity:13})).rejects.toThrow('version-conflict');
    await set(MANAGER,{...d,purchase_order_id:randomUUID(),quantity:8,eta:day(7)});
    await t.admin('select app_private.procurement_catalog_store($1::jsonb,$2,now())',[JSON.stringify(products),store]);
    let c=await catalog(); const p=c.items.find(i=>i.product_id===product)!;
    expect(p.confirmed_incoming_qty).toBe(20); expect(p.confirmed_eta).toBe(day(14));
    expect(p.incoming_lots?.map(l=>[l.quantity,l.eta])).toEqual([[8,day(7)],[12,day(14)]]);
    expect(c.incoming).toEqual([]); // supplier notes are manager-only
    await set(MANAGER,{...d,quantity:0,expected_version:1,note:'Поставка принята по документу МойСклад'});
    c=await catalog(); expect(c.items.find(i=>i.product_id===product)!.confirmed_incoming_qty).toBe(8);
    expect(c.items.find(i=>i.product_id===product)!.free_now).toBe(8); // no implicit stock movement
  });
  it('expired offers cannot be accepted and later stock cannot be reserved before purchase-order linkage',async()=>{
    let r=await submit(); r=await action(MANAGER,r,'offer',offer(r));
    await t.admin("update app_private.procurement_request set valid_until=now()-interval '1 minute' where id=$1",[r.id]);
    await expect(action(OWNER,r,'accept')).rejects.toThrow('version-conflict');
    r=await action(MANAGER,r,'offer',offer(r)); r=await action(OWNER,r,'accept');
    await expect(action(MANAGER,r,'reserve',progress(product,20))).rejects.toThrow('validation');
    expect(r.items[0].purchased_qty).toBe(0);
  });
  it('revoked sessions lose command access and landing grants remain intact',async()=>{
    const uid=await t.userId(OWNER),sid=randomUUID();
    await expect(t.db.transaction(async tx=>{
      await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:uid,role:'authenticated',session_id:sid})]);
      await tx.exec('set local role authenticated'); await tx.query('select public.procurement_list()');
    })).rejects.toThrow('unauthenticated');
    const grants=await t.admin<{lead:boolean;read:boolean}>("select has_function_privilege('anon','public.lead_submit(jsonb)','execute') lead,has_table_privilege('anon','public.franchise_lead','select') read");
    expect(grants[0]).toEqual({lead:true,read:false});
  });
});
