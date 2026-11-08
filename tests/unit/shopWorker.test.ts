import { describe, expect, it, vi } from 'vitest';
import { createBackend, createMsClient, dispatchJob, freeNow, makeHandler, readAll, readStock, resolvePrice, ShopError, syncShop,
  type Backend, type MsClient, type OrderJob, type PartnerConfig, type WorkerContext } from '../../supabase/functions/shop-worker/core.ts';

const id = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const ids = { product:id(1), partner:id(2), cp:id(3), currency:id(4), priceType:id(5), folder:id(6), store:id(7), org:id(8), order:id(9) };
const ref = (type:string, value:string) => ({meta:{type,href:`https://api.moysklad.ru/api/remap/1.2/${type==='pricetype'?'context/companysettings':'entity'}/${type}/${value}`}});
const partner:PartnerConfig = {partner_id:ids.partner,config_version:1,counterparty_id:ids.cp,price_type_id:ids.priceType,
  currency:'RUB',currency_id:ids.currency,currency_minor_unit:2,allowed_folder_ids:[ids.folder],allowed_product_ids:[ids.product],
  pricing_policy:'price_type_only_verified',discounts_verified_absent:true,vat_enabled:false,vat_included:true};
const context:WorkerContext = {enabled:true,settings_version:1,store_id:ids.store,organization_id:ids.org,folder_ids:[ids.folder],partners:[partner],
  catalog_products:[{product_id:ids.product,uom:'Лист',image_url:'https://static.tildacdn.com/test/film.jpg'}]};
const product = {id:ids.product,name:'Плёнка',code:'FILM',archived:false,uom:{name:'Лист'},productFolder:{...ref('productfolder',ids.folder),name:'Плёнки'},
  salePrices:[{priceType:ref('pricetype',ids.priceType),currency:ref('currency',ids.currency),value:12000}],buyPrice:{value:9999},
  images:{rows:[{href:'https://private.test/secret'}]}};
const cp={id:ids.cp,archived:false,priceType:ref('pricetype',ids.priceType),discounts:null};
const currency={id:ids.currency,isoCode:'RUB',archived:false,indirect:false,multiplicity:1,rate:1};
const fixed=Date.parse('2026-11-08T12:00:00Z');
const page=(rows:unknown[],size=rows.length,offset=0)=>({rows,meta:{size,offset}});
function makeJob():OrderJob{return {id:id(20),lease_token:id(21),sync_id:id(22),attempts:1,mode:'create',partner_id:ids.partner,request_id:id(23),
  request_version:1,config_version:1,settings_version:1,kind:'stock_checkout',quote_fetched_at:new Date(fixed).toISOString(),
  validation:{stock_required:[{product_id:ids.product,quantity:8}],expected_units:[{product_id:ids.product,uom:'Лист'}]},payload:{syncId:id(22),description:'Заявка: отправка частями.',applicable:true,
    organization:ref('organization',ids.org),agent:ref('counterparty',ids.cp),store:ref('store',ids.store),rate:{currency:ref('currency',ids.currency),value:1},
    vatEnabled:false,vatIncluded:true,positions:[{assortment:ref('product',ids.product),quantity:8,price:12000,discount:0,reserve:0,vat:0,vatEnabled:false}]}};}
function existing(job:OrderJob):Record<string,unknown>{return {...job.payload,id:ids.order,positions:page(job.payload.positions as unknown[])};}
function backend(){const rpc=vi.fn(async()=>null);return {rpc,db:{rpc} as Backend};}
function source(options:{job?:OrderJob;existing?:unknown;stock?:number|null;reserve?:number|null;unallocated?:number|null;price?:number;discount?:boolean;uom?:string;vat?:number}={}){
  const get=vi.fn(async(path:string,query:Record<string,string>={})=>{
    if(path==='entity/customerorder')return page(options.existing?[options.existing]:[]);
    if(path===`entity/counterparty/${ids.cp}`)return cp;
    if(path===`entity/currency/${ids.currency}`)return currency;
    if(path==='entity/discount')return page(options.discount?[{id:id(99),active:true}]:[]);
    if(path==='entity/product')return page([product]);
    if(path==='entity/variant')return page([]);
    if(path===`entity/product/${ids.product}`)return {...product,uom:{name:options.uom??'Лист'},...(options.vat===undefined?{}:{vat:options.vat,vatEnabled:true}),salePrices:[{...product.salePrices[0],value:options.price??12000}]};
    if(path==='report/stock/bystore/current'){
      const field=query.stockType;return [{assortmentId:ids.product,storeId:ids.store,[field]:field==='stock'?(options.stock===undefined?8:options.stock):field==='reserve'?(options.reserve===undefined?0:options.reserve):12},
        ...(field==='reserve'&&options.unallocated!==undefined?[{assortmentId:ids.product,storeId:null,reserve:options.unallocated}]:[])];
    }
    throw new Error(`Unexpected fixture path ${path}`);
  });
  const createOrder=vi.fn(async()=>existing(options.job??makeJob()));return {get,createOrder,ms:{get,createOrder} as MsClient};
}

describe('shop worker outbox delivery',()=>{
  it('creates the exact frozen order with zero reserves, after current price and physical availability checks',async()=>{
    const job=makeJob(),s=source({job}),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('created');
    expect(s.get.mock.calls[0][0]).toBe('entity/customerorder');
    expect(s.createOrder).toHaveBeenCalledExactlyOnceWith(job.payload);
    expect(b.rpc).toHaveBeenLastCalledWith('shop_worker_result',{p_id:job.id,p_lease_token:job.lease_token,p_status:'created',p_data:{order_id:ids.order}});
  });
  it('reconciles an existing identical order without a second POST, even after config removal and quote expiry',async()=>{
    const job=makeJob();job.mode='reconcile';job.quote_fetched_at='2020-01-01T00:00:00Z';const s=source({existing:existing(job)}),b=backend();
    expect(await dispatchJob(s.ms,b.db,{...context,partners:[],settings_version:99},job,()=>fixed)).toBe('created');
    expect(s.createOrder).not.toHaveBeenCalled();expect(s.get).toHaveBeenCalledTimes(1);
  });
  it('records timeout as ambiguous and reconciles the same syncId on a later lease',async()=>{
    const job=makeJob(),s=source({job}),b=backend();s.createOrder.mockRejectedValueOnce(new ShopError('ambiguous',true));
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('ambiguous');
    expect(b.rpc.mock.calls.at(-1)).toMatchObject(['shop_worker_result',{p_status:'ambiguous',p_data:{error_code:'ambiguous'}}]);
    const second=source({existing:existing(job)});job.mode='reconcile';job.lease_token=id(24);
    expect(await dispatchJob(second.ms,b.db,context,job,()=>fixed)).toBe('created');expect(second.createOrder).not.toHaveBeenCalled();
  });
  it('never POSTs in reconcile mode when absent, even if stock and config remain valid',async()=>{
    const job=makeJob();job.mode='reconcile';const s=source(),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('ambiguous');expect(s.createOrder).not.toHaveBeenCalled();expect(s.get).toHaveBeenCalledTimes(1);
  });
  it('keeps reconciliation read-only after an upstream lookup failure',async()=>{
    const job=makeJob();job.mode='reconcile';const s=source(),b=backend();s.get.mockRejectedValueOnce(new ShopError('network'));
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('ambiguous');
    expect(b.rpc.mock.calls.at(-1)).toMatchObject(['shop_worker_result',{p_status:'ambiguous'}]);expect(s.createOrder).not.toHaveBeenCalled();
  });
  it.each([{stock:7},{stock:null},{stock:8,reserve:1},{stock:8,unallocated:1},{stock:8,unallocated:null}])('blocks changed or unknown physical availability %j',async options=>{
    const s=source(options),b=backend();expect(await dispatchJob(s.ms,b.db,context,makeJob(),()=>fixed)).toBe('blocked');
    expect(s.createOrder).not.toHaveBeenCalled();expect(b.rpc.mock.calls.at(-1)).toMatchObject(['shop_worker_result',{p_data:{error_code:'stock-stale'}}]);
  });
  it('blocks expired quotes, changed individual prices and active discount policies',async()=>{
    for(const scenario of ['stale','price','discount']){
      const job=makeJob();if(scenario==='stale')job.quote_fetched_at=new Date(fixed-300001).toISOString();
      const s=source({price:scenario==='price'?13000:12000,discount:scenario==='discount'}),b=backend();
      expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('blocked');expect(s.createOrder).not.toHaveBeenCalled();
    }
  });
  it('preserves accepted split quantities and separate agreed prices for 8 now plus 12 later',async()=>{
    const job=makeJob();job.kind='accepted_offer';job.quote_fetched_at=null;
    const first=(job.payload.positions as Record<string,unknown>[])[0];job.payload.positions=[first,{...first,quantity:12,price:12500}];
    job.payload.deliveryPlannedMoment='2026-12-01 12:00:00';const s=source({job,stock:0,price:14000}),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('created');expect(s.createOrder).toHaveBeenCalledExactlyOnceWith(job.payload);
    expect(s.get.mock.calls.some(([path])=>path==='report/stock/bystore/current')).toBe(false);
  });
  it('recognizes API-normalized delivery timestamps without changing the accepted date',async()=>{
    const job=makeJob();job.payload.deliveryPlannedMoment='2026-12-01 12:00:00';job.mode='reconcile';
    const s=source({existing:{...existing(job),deliveryPlannedMoment:'2026-12-01 12:00:00.000'}}),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('created');expect(s.createOrder).not.toHaveBeenCalled();
  });
  it('does not mistake an edited existing document or duplicate syncId for the expected order',async()=>{
    const job=makeJob(),s=source({existing:{...existing(job),description:'Changed terms'}}),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('blocked');expect(s.createOrder).not.toHaveBeenCalled();
    s.get.mockResolvedValueOnce(page([existing(job),existing(job)]));
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('blocked');expect(s.createOrder).not.toHaveBeenCalled();
  });
  it('rejects stock requirements that omit part of the frozen order',async()=>{
    const job=makeJob();job.validation.stock_required=[];const s=source(),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('blocked');expect(s.createOrder).not.toHaveBeenCalled();
  });
  it.each(['stock_checkout','accepted_offer'] as const)('blocks a unit change after quote for %s',async kind=>{
    const job=makeJob();job.kind=kind;const s=source({uom:'м'}),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('blocked');expect(s.createOrder).not.toHaveBeenCalled();
    expect(b.rpc.mock.calls.at(-1)).toMatchObject(['shop_worker_result',{p_data:{error_code:'mapping-mismatch'}}]);
  });
  it('requires a complete immutable unit map even if the current catalog still has units',async()=>{
    const job=makeJob();job.validation.expected_units=[];const s=source(),b=backend();
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('blocked');expect(s.createOrder).not.toHaveBeenCalled();
  });
  it('checks inherited variant units through the expanded parent before creating an accepted offer',async()=>{
    const variant=id(40),job=makeJob();job.kind='accepted_offer';job.validation.expected_units=[{product_id:variant,uom:'Лист'}];
    (job.payload.positions as Record<string,unknown>[])[0].assortment=ref('variant',variant);
    const s=source({job}),b=backend(),baseGet=s.ms.get;
    s.ms.get=vi.fn(async(path,query)=>path===`entity/variant/${variant}`?{...product,id:variant,product:{...product,...ref('product',ids.product)}}:baseGet(path,query));
    const config={...context,partners:[{...partner,allowed_product_ids:[variant]}],catalog_products:[{...context.catalog_products[0],product_id:variant,entity_type:'variant' as const}]};
    expect(await dispatchJob(s.ms,b.db,config,job,()=>fixed)).toBe('created');expect(s.createOrder).toHaveBeenCalledOnce();
  });
  it('holds changed current tax even when an accepted offer keeps its negotiated price',async()=>{
    const job=makeJob();job.kind='accepted_offer';job.payload.vatEnabled=true;
    const position=(job.payload.positions as Record<string,unknown>[])[0];position.vat=20;position.vatEnabled=true;
    const s=source({job,vat:10}),b=backend();
    expect(await dispatchJob(s.ms,b.db,{...context,partners:[{...partner,vat_enabled:true}]},job,()=>fixed)).toBe('blocked');expect(s.createOrder).not.toHaveBeenCalled();
  });
  it('keeps an unverifiable successful POST in reconciliation and treats an explicit rejection separately',async()=>{
    const job=makeJob(),s=source({job}),b=backend();s.createOrder.mockResolvedValueOnce({...existing(job),description:'Unexpected terms'});
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('ambiguous');
    s.createOrder.mockRejectedValueOnce(new ShopError('validation',false,true));
    expect(await dispatchJob(s.ms,b.db,context,job,()=>fixed)).toBe('blocked');
  });
});

describe('catalog and personal prices',()=>{
  it('imports a complete atomic snapshot with exact units, photos and private own-price rows',async()=>{
    const s=source({stock:20,reserve:5,unallocated:3}),b=backend();expect(await syncShop(s.ms,b.db,context,()=>fixed)).toBe(1);
    expect(b.rpc).toHaveBeenCalledTimes(1);const call=b.rpc.mock.calls[0] as unknown as [string,{p_data:Record<string,unknown>}];
    expect(call[0]).toBe('shop_worker_import');expect(call[1].p_data.settings_version).toBe(1);
    const data=call[1].p_data as {catalog:{rows:Record<string,unknown>[]};prices:{rows:Record<string,unknown>[]}[]};
    expect(data.catalog.rows[0]).toMatchObject({product_id:ids.product,uom:'Лист',stock:20,reserve:5,unallocated_reserve:3,in_transit:12,confirmed_incoming_qty:0,image_url:context.catalog_products[0].image_url});
    expect(JSON.stringify(data.catalog)).not.toMatch(/salePrices|buyPrice|9999|12000|secret|private\.test/);
    expect(data.prices[0].rows[0]).toEqual({product_id:ids.product,price_minor:12000,vat:0,vat_enabled:false});
  });
  it('keeps the previous successful snapshot when any partner policy or page fails',async()=>{
    for(const reason of ['discount','page']){
      const s=source({discount:reason==='discount'}),b=backend();if(reason==='page')s.get.mockRejectedValueOnce(new ShopError('network'));
      await expect(syncShop(s.ms,b.db,context,()=>fixed)).rejects.toBeInstanceOf(ShopError);expect(b.rpc).not.toHaveBeenCalled();
    }
  });
  it('treats zero/missing sale prices as unavailable pricing and never zero-cost checkout',()=>{
    expect(resolvePrice({...product,salePrices:[]},product,partner).price_minor).toBeNull();
    expect(resolvePrice({...product,salePrices:[{...product.salePrices[0],value:0}]},product,partner).price_minor).toBeNull();
    expect(()=>resolvePrice(product,product,{...partner,vat_enabled:true})).toThrow('price-policy');
  });
  it('reads all pages and rejects duplicate UUIDs or a changing collection size',async()=>{
    const rows=Array.from({length:100},(_,n)=>({id:id(n+100)}));
    const get=vi.fn().mockResolvedValueOnce(page(rows,101)).mockResolvedValueOnce(page([{id:id(999)}],101,100));
    expect(await readAll({get,createOrder:vi.fn()},'entity/product')).toHaveLength(101);
    get.mockResolvedValueOnce(page(rows,101)).mockResolvedValueOnce(page([{id:rows[0].id}],101,100));
    await expect(readAll({get,createOrder:vi.fn()},'entity/product')).rejects.toThrow('validation');
    get.mockResolvedValueOnce(page(rows,101)).mockResolvedValueOnce(page([{id:id(999)}],102,100));
    await expect(readAll({get,createOrder:vi.fn()},'entity/product')).rejects.toThrow('validation');
  });
  it('never adds incoming quantities to availability and holds unknown unscoped reserves',async()=>{
    expect(freeNow((await readStock(source({stock:20,reserve:5,unallocated:3}).ms,ids.store)).get(ids.product))).toBe(12);
    expect(freeNow((await readStock(source({unallocated:null}).ms,ids.store)).get(ids.product))).toBeNull();
  });
});

describe('transport and authorization',()=>{
  it('never automatically retries an uncertain POST or forwards a private error body',async()=>{
    const fetcher=vi.fn().mockRejectedValue(new Error('token and private data'));
    const ms=createMsClient('server-test-token',{fetcher});await expect(ms.createOrder(makeJob().payload)).rejects.toMatchObject({code:'ambiguous',ambiguous:true});
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response('private body',{status:429}));
    await expect(ms.createOrder(makeJob().payload)).rejects.toMatchObject({code:'rate-limit',ambiguous:false});expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(ms.get('https://attacker.test')).rejects.toThrow('validation');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('caps GET retries and waiting on upstream rate limits',async()=>{
    const fetcher=vi.fn().mockImplementation(()=>new Response('private body',{status:429,headers:{'Retry-After':'99999'}})),sleep=vi.fn(async()=>{});
    await expect(createMsClient('test',{fetcher,sleep}).get('entity/product')).rejects.toThrow('rate-limit');expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[3000],[3000]]);
  });
  it('limits all concurrent upstream reads to four across independent catalog operations',async()=>{
    let active=0,peak=0;const fetcher=vi.fn(async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return Response.json(page([]));});
    const ms=createMsClient('test',{fetcher});await Promise.all(Array.from({length:12},()=>ms.get('entity/product')));
    expect(peak).toBe(4);expect(fetcher).toHaveBeenCalledTimes(12);
  });
  it('accepts empty successful void RPC responses but rejects empty context responses',async()=>{
    const fetcher=vi.fn().mockImplementation(()=>Promise.resolve(new Response(null,{status:204}))),db=createBackend('https://example.supabase.co','sb_secret_test',fetcher);
    expect(await db.rpc('shop_worker_heartbeat')).toBeNull();expect(await db.rpc('shop_worker_import')).toBeNull();
    await expect(db.rpc('shop_worker_context')).rejects.toThrow('upstream');
  });
  it('rejects anonymous/browser credentials before reading any privileged context',async()=>{
    const fetcher=vi.fn(),env=(name:string)=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only-test-key'}[name]);
    const response=await makeHandler(env,fetcher)(new Request('https://edge.test',{method:'POST',headers:{Authorization:'Bearer user-jwt'},body:'{}'}));
    expect(response.status).toBe(401);expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed with observable missing-token status, without reading or claiming an outbox job',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:204})),env=(name:string)=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only-test-key'}[name]);
    const response=await makeHandler(env,fetcher)(new Request('https://edge.test',{method:'POST',headers:{Authorization:'Bearer server-only-test-key'},body:'{}'}));
    expect(response.status).toBe(503);expect(await response.json()).toEqual({ok:false,error:'missing-token'});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(String(fetcher.mock.calls[0][0])).toMatch(/\/shop_worker_heartbeat$/);
  });
  it('checks a narrow cron token through the service-only RPC before any other action',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json(false)),env=(name:string)=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-only-test-key'}[name]);
    const response=await makeHandler(env,fetcher)(new Request('https://edge.test',{method:'POST',headers:{'x-shop-worker-key':'test-cron-key'},body:'{}'}));
    expect(response.status).toBe(401);expect(fetcher).toHaveBeenCalledTimes(1);expect(String(fetcher.mock.calls[0][0])).toMatch(/\/shop_worker_authorize$/);
  });
});
