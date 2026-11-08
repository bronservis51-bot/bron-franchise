// Server-only integration. No credentials, private snapshots or external payloads are returned to a browser.
export type ErrorCode = 'missing-token'|'disabled'|'unauthorized'|'rate-limit'|'network'|'upstream'|'validation'|'mapping-mismatch'|'price-policy'|'price-changed'|'stock-stale'|'lease-expired'|'ambiguous'|'multiple-matches'|'payload-mismatch'|'attempts-exhausted'|'unknown';
export class ShopError extends Error {
  constructor(public code: ErrorCode, public ambiguous = false, public definitelyRejected = false) { super(code); }
}
type Obj = Record<string, unknown>;
const MS = 'https://api.moysklad.ru/api/remap/1.2/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 5 * 60_000;
function object(value: unknown): Obj { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShopError('validation'); return value as Obj; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new ShopError('validation'); return value; }
export function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw new ShopError('mapping-mismatch'); return value.toLowerCase(); }
function positive(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ShopError('validation'); return value; }
function quantity(value: unknown): number { const n = positive(value); if (n > 100000 || Math.abs(n * 1000 - Math.round(n * 1000)) > 0.00001) throw new ShopError('validation'); return n; }
function price(value: unknown): number { const n = positive(value); if (!Number.isSafeInteger(n) || n > 100000000000) throw new ShopError('price-policy'); return n; }
function cleanText(value: unknown, max: number, empty = false): string { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new ShopError('validation'); return value; }
export function metaId(value: unknown, type: string): string {
  const v = object(value), meta = object(v.meta);
  if (meta.type !== undefined && meta.type !== type) throw new ShopError('mapping-mismatch');
  let url: URL; try { url = new URL(String(meta.href)); } catch { throw new ShopError('mapping-mismatch'); }
  const prefix = type === 'pricetype' ? '/api/remap/1.2/context/companysettings/pricetype/' : `/api/remap/1.2/entity/${type}/`;
  if (url.origin !== 'https://api.moysklad.ru' || !url.pathname.startsWith(prefix) || url.search || url.hash) throw new ShopError('mapping-mismatch');
  const id = uuid(url.pathname.slice(prefix.length));
  if (v.id !== undefined && uuid(v.id) !== id) throw new ShopError('mapping-mismatch');
  return id;
}
function jsonEqual(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
export const codeOf = (error: unknown): ErrorCode => error instanceof ShopError ? error.code : 'unknown';

export interface PartnerConfig {
  partner_id: string; config_version: number; counterparty_id: string; price_type_id: string;
  currency: string; currency_id: string; currency_minor_unit: number;
  allowed_folder_ids: string[]; allowed_product_ids: string[];
  pricing_policy: string; discounts_verified_absent: boolean; vat_enabled: boolean; vat_included: boolean;
}
export interface CatalogProduct { product_id: string; entity_type?: 'product'|'variant'; image_url: string|null; uom: string; [key: string]: unknown }
export interface WorkerContext { enabled: boolean; settings_version: number; store_id: string; organization_id: string; folder_ids: string[]; catalog_products: CatalogProduct[]; partners: PartnerConfig[] }
export interface OrderJob {
  id: string; lease_token: string; sync_id: string; attempts: number; mode: 'create'|'reconcile';
  partner_id: string; request_id: string; request_version: number; config_version: number; settings_version: number;
  kind: 'stock_checkout'|'accepted_offer'; quote_fetched_at: string|null;
  validation: { stock_required: { product_id: string; quantity: number }[]; expected_units: {product_id:string;uom:string}[] }; payload: Obj;
}
export interface Backend { rpc<T = unknown>(name: string, args?: Obj): Promise<T> }
export interface MsClient { get(path: string, query?: Record<string,string>): Promise<unknown>; createOrder(payload: Obj): Promise<unknown> }

/** Caller only supplies known relative paths. Never follows external metadata links or redirects. */
export function createMsClient(token: string, opts: { fetcher?: typeof fetch; sleep?: (ms:number)=>Promise<void>; deadline?: number; now?: ()=>number } = {}): MsClient {
  if (!token || /[\r\n]/.test(token)) throw new ShopError('missing-token');
  const fetcher = opts.fetcher ?? fetch, now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve,ms)));
  let active=0;const waiting:(()=>void)[]=[];
  const acquire=async()=>{if(active<4){active++;return;}await new Promise<void>(resolve=>waiting.push(resolve));};
  const release=()=>{const next=waiting.shift();if(next)next();else active--;};
  const allowed = (path: string) => /^(entity\/(product|variant|counterparty|currency|discount|organization|store)(\/[0-9a-f-]{36})?|entity\/customerorder(\/[0-9a-f-]{36}(\/positions)?)?|report\/stock\/bystore\/current)$/.test(path);
  async function call(path: string, query: Record<string,string>, payload?: Obj): Promise<unknown> {
    if (!allowed(path) || (payload && path !== 'entity/customerorder')) throw new ShopError('validation');
    const url = new URL(path, MS); url.search = new URLSearchParams(query).toString();
    const isWrite = payload !== undefined;
    const attempts = isWrite ? 1 : 3;
    for (let attempt=0;attempt<attempts;attempt++) {
      if (opts.deadline && now() > opts.deadline - 1500) throw new ShopError('network');
      let response: Response,content:string|undefined;
      try {
        await acquire();
        try{
          if(opts.deadline&&now()>opts.deadline-1500)throw new ShopError('network');
          response = await fetcher(url,{ method:isWrite?'POST':'GET',redirect:'error',
            headers:{Authorization:`Bearer ${token}`,'Accept-Encoding':'gzip',Accept:'application/json',...(isWrite?{'Content-Type':'application/json'}:{})},
            body:isWrite?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(Math.min(12000,opts.deadline?Math.max(1,opts.deadline-now()-1000):12000)) });
          if(response.ok)content=await response.text();else await response.body?.cancel();
        }finally{release();}
      } catch(error) { if(error instanceof ShopError)throw error; if (isWrite) throw new ShopError('ambiguous',true); if(attempt+1===attempts) throw new ShopError('network'); await sleep(500*(attempt+1)); continue; }
      if (response.status===429 || response.status>=500) {
        if (isWrite) throw new ShopError(response.status===429?'rate-limit':'ambiguous',response.status!==429,response.status===429);
        if(attempt+1===attempts) throw new ShopError(response.status===429?'rate-limit':'upstream');
        const wait=Number(response.headers.get('Retry-After')); await sleep(Number.isFinite(wait)&&wait>0?Math.min(wait*1000,3000):500*(attempt+1)); continue;
      }
      if (!response.ok) throw new ShopError(response.status===401||response.status===403?'unauthorized':response.status===409?'ambiguous':'validation',isWrite&&response.status===409,isWrite&&response.status!==409);
      if(content===undefined)throw new ShopError(isWrite?'ambiguous':'network',isWrite);
      if(content.length>20_000_000) throw new ShopError(isWrite?'ambiguous':'validation',isWrite);
      try { return JSON.parse(content); } catch { throw new ShopError(isWrite?'ambiguous':'validation',isWrite); }
    }
    throw new ShopError('network');
  }
  return {get:(path,query={})=>call(path,query),createOrder:payload=>call('entity/customerorder',{},payload)};
}

export async function readAll(ms: MsClient, path: string, query: Record<string,string> = {}): Promise<Obj[]> {
  const result: Obj[]=[]; const seen=new Set<string>(); let total:number|undefined;
  const page=async(offset:number)=>{
    const response=object(await ms.get(path,{...query,limit:'100',offset:String(offset)}));
    const meta=object(response.meta), rows=array(response.rows);
    if(!Number.isSafeInteger(meta.size)||Number(meta.size)<0||Number(meta.size)>10000||rows.length>100) throw new ShopError('validation');
    if(total!==undefined && total!==meta.size) throw new ShopError('validation'); total=Number(meta.size);
    if(meta.offset!==undefined && meta.offset!==offset) throw new ShopError('validation');
    if(rows.length!==Math.min(100,total-offset))throw new ShopError('validation');
    return rows.map(object);
  };
  const first=await page(0);const pages:Obj[][]=[first];
  // Expansion is capped at 100 rows by MoySklad. Three concurrent page reads bound latency.
  for(let offset=100;offset<(total??0);offset+=300){
    const offsets=[offset,offset+100,offset+200].filter(n=>n<(total??0));
    pages.push(...await Promise.all(offsets.map(page)));
  }
  for(const rows of pages)for(const row of rows){const id=uuid(row.id);if(seen.has(id))throw new ShopError('validation');seen.add(id);result.push(row);}
  return result;
}

type StockValue = {stock:number|null;reserve:number|null;unallocated_reserve:number|null;in_transit:number|null};
export async function readStock(ms:MsClient, storeId:string, includeTransit=true): Promise<Map<string,StockValue>> {
  const result=new Map<string,StockValue>(); uuid(storeId);
  for(const field of includeTransit?['stock','reserve','inTransit']:['stock','reserve']) {
    const rows=array(await ms.get('report/stock/bystore/current',{stockType:field,include:'zeroLines',withRecalculate:'true'}));
    const seen=new Set<string>();
    for(const raw of rows){
      const r=object(raw),id=uuid(r.assortmentId),location=r.storeId===null?null:uuid(r.storeId),value=r[field];
      if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>100000000||(field!=='stock'&&value<0)))throw new ShopError('validation');
      const key=`${id}:${location}`;if(seen.has(key))throw new ShopError('validation');seen.add(key);
      if(location!==storeId&&location!==null)continue;
      const entry=result.get(id)??{stock:null,reserve:0,unallocated_reserve:0,in_transit:null};
      if(location===null){if(field==='reserve')entry.unallocated_reserve=value as number|null;}
      else if(field==='inTransit')entry.in_transit=value as number|null;
      else entry[field as 'stock'|'reserve']=value as number|null;
      result.set(id,entry);
    }
  }
  return result;
}
export function freeNow(value: StockValue|undefined): number|null {
  return !value||value.stock===null||value.reserve===null||value.unallocated_reserve===null?null:Math.max(value.stock-value.reserve-value.unallocated_reserve,0);
}

export function validatePartner(partner:PartnerConfig, cp:Obj, discounts:Obj[]):void {
  if(uuid(cp.id)!==uuid(partner.counterparty_id)||cp.archived!==false)throw new ShopError('mapping-mismatch');
  if(partner.pricing_policy!=='price_type_only_verified'||partner.discounts_verified_absent!==true||partner.currency_minor_unit!==2
    ||typeof partner.vat_enabled!=='boolean'||typeof partner.vat_included!=='boolean'||(partner.vat_enabled&&!partner.vat_included))throw new ShopError('price-policy');
  if(metaId(cp.priceType,'pricetype')!==uuid(partner.price_type_id))throw new ShopError('price-policy');
  if(cp.discounts!==null&&cp.discounts!==undefined&&array(cp.discounts).length)throw new ShopError('price-policy');
  if(cp.bonusProgram!==null&&cp.bonusProgram!==undefined)throw new ShopError('price-policy');
  // Scope/stacking of general discounts is not reimplemented: any active discount requires review.
  if(discounts.some(d=>d.active!==false))throw new ShopError('price-policy');
}
export function resolvePrice(product:Obj, parent:Obj, partner:PartnerConfig): {product_id:string;price_minor:number|null;vat:number;vat_enabled:boolean} {
  const id=uuid(product.id),folder=metaId(parent.productFolder,'productfolder');
  if(!partner.allowed_product_ids.includes(id)||!partner.allowed_folder_ids.includes(folder)||product.archived!==false||parent.archived!==false)throw new ShopError('mapping-mismatch');
  const matches=array(product.salePrices).map(object).filter(p=>metaId(p.priceType,'pricetype')===partner.price_type_id);
  if(matches.length>1||(matches.length===1&&metaId(matches[0].currency,'currency')!==partner.currency_id))throw new ShopError('price-policy');
  const tax=resolveTax(parent,partner);
  return {product_id:id,price_minor:!matches.length||matches[0].value===0?null:price(matches[0].value),...tax};
}
function resolveTax(parent:Obj,partner:PartnerConfig):{vat:number;vat_enabled:boolean}{
  let vat=0,vatEnabled=false;
  if(partner.vat_enabled){
    if(typeof parent.vatEnabled!=='boolean'||!Number.isInteger(parent.vat)||Number(parent.vat)<0||Number(parent.vat)>30)throw new ShopError('price-policy');
    vat=Number(parent.vat);vatEnabled=parent.vatEnabled;
  }
  return {vat,vat_enabled:vatEnabled};
}
export function resolveRate(currency:Obj, partner:PartnerConfig):number {
  if(uuid(currency.id)!==partner.currency_id||currency.archived!==false||currency.isoCode!==partner.currency
    ||currency.indirect!==false||currency.multiplicity!==1)throw new ShopError('price-policy');
  return positive(currency.rate);
}

function imageUrl(value:unknown):string|null{
  if(value===null||value===undefined)return null;
  let url:URL;try{url=new URL(cleanText(value,2000));}catch{throw new ShopError('validation');}
  if(url.protocol!=='https:'||url.hostname!=='static.tildacdn.com'||url.port||url.username||url.password||url.search||url.hash)throw new ShopError('validation');
  return url.href;
}
type SourceCatalog={products:Map<string,Obj>;parents:Map<string,Obj>};
async function readCatalogSource(ms:MsClient):Promise<SourceCatalog>{
  const [productRows,variants]=await Promise.all([readAll(ms,'entity/product',{filter:'archived=false',expand:'uom,productFolder'}),readAll(ms,'entity/variant',{filter:'archived=false'})]);
  const parents=new Map(productRows.map(p=>[uuid(p.id),p]));
  const products=new Map(parents);
  for(const v of variants){const id=uuid(v.id);if(products.has(id))throw new ShopError('validation');products.set(id,v);}
  return{products,parents};
}
function sourcePair(source:SourceCatalog,id:string):{product:Obj;parent:Obj}{
  const product=source.products.get(id);if(!product)throw new ShopError('mapping-mismatch');
  const parent=product.product?source.parents.get(metaId(product.product,'product')):product;
  if(!parent)throw new ShopError('mapping-mismatch');return{product,parent};
}

export async function syncShop(ms:MsClient, db:Backend, context:WorkerContext, now:()=>number=Date.now):Promise<number>{
  const started=now();if(!context.enabled)throw new ShopError('disabled');
  if(!context.catalog_products.length||!context.folder_ids.length)throw new ShopError('mapping-mismatch');
  const [source,stock,discounts]=await Promise.all([readCatalogSource(ms),readStock(ms,uuid(context.store_id)),readAll(ms,'entity/discount')]);
  const catalog:Obj[]=[];const seen=new Set<string>();
  for(const known of context.catalog_products){
    const id=uuid(known.product_id);if(seen.has(id))throw new ShopError('mapping-mismatch');seen.add(id);
    // A withdrawn product is removed only after a complete catalog read; stale data is never promoted.
    if(!source.products.has(id))continue;
    const {product,parent}=sourcePair(source,id),folder=metaId(parent.productFolder,'productfolder');
    if(!context.folder_ids.includes(folder))continue;
    const unit=cleanText(object(parent.uom).name,30);if(unit!==known.uom)throw new ShopError('mapping-mismatch');
    const s=stock.get(id)??{stock:null,reserve:null,unallocated_reserve:null,in_transit:null};
    catalog.push({product_id:id,entity_type:product.product?'variant':'product',name:cleanText(product.name,500),
      code:product.code===undefined?'':cleanText(product.code,255,true),uom:unit,category:cleanText(object(parent.productFolder).name,500),image_url:imageUrl(known.image_url),
      ...s,confirmed_incoming_qty:0,confirmed_eta:null,purchase_order_id:null});
  }
  if(!catalog.length)throw new ShopError('mapping-mismatch');
  const priceSnapshots:Obj[]=[];
  const currencies=new Map<string,Promise<unknown>>();
  const partnerSnapshot=async(partner:PartnerConfig)=>{
    if(!currencies.has(partner.currency_id))currencies.set(partner.currency_id,ms.get(`entity/currency/${uuid(partner.currency_id)}`));
    const [cp,currency]=await Promise.all([ms.get(`entity/counterparty/${uuid(partner.counterparty_id)}`),currencies.get(partner.currency_id)!]);
    validatePartner(partner,object(cp),discounts);const rate=resolveRate(object(currency),partner);
    const rows:Obj[]=[];
    for(const item of catalog){const id=String(item.product_id);if(!partner.allowed_product_ids.includes(id))continue;
      const {product,parent}=sourcePair(source,id);if(!partner.allowed_folder_ids.includes(metaId(parent.productFolder,'productfolder')))continue;
      rows.push(resolvePrice(product,parent,partner));}
    if(!rows.length)throw new ShopError('price-policy');
    return {partner_id:partner.partner_id,config_version:partner.config_version,version:crypto.randomUUID(),fetched_at:new Date(started).toISOString(),currency:partner.currency,currency_id:partner.currency_id,rate,rows};
  };
  for(let offset=0;offset<context.partners.length;offset+=3)priceSnapshots.push(...await Promise.all(context.partners.slice(offset,offset+3).map(partnerSnapshot)));
  if(now()-started>MAX_AGE_MS||now()<started)throw new ShopError('stock-stale');
  await db.rpc('shop_worker_import',{p_data:{settings_version:context.settings_version,catalog:{rows:catalog,store_id:context.store_id,fetched_at:new Date(started).toISOString()},prices:priceSnapshots}});
  return catalog.length;
}

interface NormalPosition {id:string;type:string;quantity:number;price:number;discount:number;vat:number;vatEnabled:boolean;reserve:number}
function normalizedPositions(value:unknown):NormalPosition[]{
  const rows=Array.isArray(value)?value:array(object(value).rows);
  return rows.map(raw=>{const p=object(raw),assortment=object(p.assortment),type=String(object(assortment.meta).type);
    if(!['product','variant'].includes(type))throw new ShopError('payload-mismatch');const id=metaId(assortment,type);
    if(p.discount!==0||typeof p.vatEnabled!=='boolean'||!Number.isInteger(p.vat)||Number(p.vat)<0||Number(p.vat)>30)throw new ShopError('payload-mismatch');
    return{id,type,quantity:quantity(p.quantity),price:price(p.price),discount:0,vat:Number(p.vat),vatEnabled:p.vatEnabled,reserve:typeof p.reserve==='number'?p.reserve:0};
  }).sort((a,b)=>JSON.stringify({...a,reserve:0}).localeCompare(JSON.stringify({...b,reserve:0})));
}
function validateFrozen(job:OrderJob,context:WorkerContext,partner:PartnerConfig):NormalPosition[]{
  const p=job.payload;
  if(uuid(p.syncId)!==uuid(job.sync_id)||metaId(p.agent,'counterparty')!==partner.counterparty_id
    ||metaId(p.organization,'organization')!==context.organization_id||metaId(p.store,'store')!==context.store_id
    ||metaId(object(p.rate).currency,'currency')!==partner.currency_id||p.vatEnabled!==partner.vat_enabled||p.vatIncluded!==partner.vat_included
    ||p.applicable!==true||job.config_version!==partner.config_version||job.settings_version!==context.settings_version)throw new ShopError('payload-mismatch');
  positive(object(p.rate).value);
  const positions=normalizedPositions(p.positions);
  if(!positions.length||positions.length>200||positions.some(pos=>pos.reserve!==0||!partner.allowed_product_ids.includes(pos.id)))throw new ShopError('payload-mismatch');
  const fields=new Set(['syncId','description','applicable','vatEnabled','vatIncluded','organization','agent','store','rate','positions','deliveryPlannedMoment']);
  if(Object.keys(p).some(k=>!fields.has(k)))throw new ShopError('payload-mismatch');
  cleanText(p.description,4096);
  if(p.deliveryPlannedMoment!==undefined&&(typeof p.deliveryPlannedMoment!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(p.deliveryPlannedMoment)))throw new ShopError('payload-mismatch');
  for(const raw of array(p.positions))if(Object.keys(object(raw)).some(k=>!['assortment','quantity','price','discount','vat','vatEnabled','reserve'].includes(k)))throw new ShopError('payload-mismatch');
  const units=new Map<string,string>();for(const raw of array(job.validation.expected_units)){const r=object(raw),id=uuid(r.product_id);if(units.has(id))throw new ShopError('payload-mismatch');units.set(id,cleanText(r.uom,30));}
  if(units.size!==new Set(positions.map(pos=>pos.id)).size||positions.some(pos=>!units.has(pos.id)))throw new ShopError('payload-mismatch');
  if(job.kind==='stock_checkout'){
    const totals=new Map<string,number>();for(const pos of positions)totals.set(pos.id,(totals.get(pos.id)??0)+pos.quantity);
    const required=new Map<string,number>();for(const r of job.validation.stock_required){const id=uuid(r.product_id);if(required.has(id))throw new ShopError('payload-mismatch');required.set(id,quantity(r.quantity));}
    if(totals.size!==required.size||[...totals].some(([id,n])=>Math.abs(n-(required.get(id)??-1))>0.00001))throw new ShopError('payload-mismatch');
  }
  return positions;
}
async function findExisting(ms:MsClient,syncId:string):Promise<Obj|null>{
  const result=object(await ms.get('entity/customerorder',{filter:`syncId=${uuid(syncId)}`,limit:'2',expand:'positions'}));
  const rows=array(result.rows),total=Number(object(result.meta).size);
  if(!Number.isSafeInteger(total)||rows.length!==Math.min(total,2))throw new ShopError('validation');
  if(total>1)throw new ShopError('multiple-matches');return total===1?object(rows[0]):null;
}
async function verifyExisting(ms:MsClient,order:Obj,job:OrderJob):Promise<string>{
  const expected=job.payload,id=uuid(order.id);
  // Remap serializes document moments with milliseconds even when the input omitted them.
  const moment=(value:unknown)=>typeof value==='string'?value.replace(/\.000$/,''):value??null;
  if(uuid(order.syncId)!==job.sync_id||metaId(order.agent,'counterparty')!==metaId(expected.agent,'counterparty')
    ||metaId(order.organization,'organization')!==metaId(expected.organization,'organization')||metaId(order.store,'store')!==metaId(expected.store,'store')
    ||metaId(object(order.rate).currency,'currency')!==metaId(object(expected.rate).currency,'currency')
    ||object(order.rate).value!==object(expected.rate).value||order.vatEnabled!==expected.vatEnabled||order.vatIncluded!==expected.vatIncluded
    ||order.description!==expected.description||moment(order.deliveryPlannedMoment)!==moment(expected.deliveryPlannedMoment))throw new ShopError('payload-mismatch');
  let positions=order.positions;
  const posObject=positions&&typeof positions==='object'&&!Array.isArray(positions)?positions as Obj:{};
  const posMeta=posObject.meta&&typeof posObject.meta==='object'?posObject.meta as Obj:{};
  if(!Array.isArray(posObject.rows)||Number(posMeta.size)!==posObject.rows.length){
    positions={rows:await readAll(ms,`entity/customerorder/${id}/positions`)};
  }
  // Existing orders can legitimately have been reserved by a manager after creation. Do not modify them.
  const actual=normalizedPositions(positions).map(({reserve:_,...p})=>p),wanted=normalizedPositions(expected.positions).map(({reserve:_,...p})=>p);
  if(!jsonEqual(actual,wanted))throw new ShopError('payload-mismatch');
  return id;
}

export async function dispatchJob(ms:MsClient,db:Backend,context:WorkerContext,job:OrderJob,now:()=>number=Date.now):Promise<string>{
  const result=(status:string,data:Obj)=>db.rpc('shop_worker_result',{p_id:job.id,p_lease_token:job.lease_token,p_status:status,p_data:data});
  let attempted=false;
  try{
    // This is always first, even if the quote is old or the worker previously lost the POST response.
    const existing=await findExisting(ms,job.sync_id);
    if(existing){const id=await verifyExisting(ms,existing,job);await result('created',{order_id:id});return'created';}
    // A lease marked reconcile may have been revoked/reconfigured after its POST. It is read-only.
    if(job.mode==='reconcile'){await result('ambiguous',{error_code:'ambiguous'});return'ambiguous';}
    const partner=context.partners.find(p=>p.partner_id===job.partner_id);if(!partner)throw new ShopError('mapping-mismatch');
    const positions=validateFrozen(job,context,partner);
    if(job.kind==='stock_checkout'&&(!job.quote_fetched_at||!Number.isFinite(Date.parse(job.quote_fetched_at))||now()-Date.parse(job.quote_fetched_at)>MAX_AGE_MS||Date.parse(job.quote_fetched_at)>now()+30000))throw new ShopError('stock-stale');
    const cp=object(await ms.get(`entity/counterparty/${partner.counterparty_id}`));
    validatePartner(partner,cp,await readAll(ms,'entity/discount'));
    const uniquePositions=[...new Map(positions.map(pos=>[pos.id,pos])).values()];
    const currentProducts=new Map<string,{product:Obj;parent:Obj}>();
    for(let offset=0;offset<uniquePositions.length;offset+=3)await Promise.all(uniquePositions.slice(offset,offset+3).map(async pos=>{
      const product=object(await ms.get(`entity/${pos.type}/${pos.id}`,{expand:pos.type==='product'?'uom,productFolder':'product,product.uom,product.productFolder'}));
      const parent=pos.type==='variant'?object(product.product):product;
      const known=context.catalog_products.find(p=>p.product_id===pos.id);
      const frozen=job.validation.expected_units.find(p=>p.product_id===pos.id);
      if(uuid(product.id)!==pos.id||!known||!frozen||cleanText(object(parent.uom).name,30)!==known.uom||frozen.uom!==known.uom
        ||product.archived!==false||parent.archived!==false||!partner.allowed_folder_ids.includes(metaId(parent.productFolder,'productfolder')))throw new ShopError('mapping-mismatch');
      currentProducts.set(pos.id,{product,parent});
    }));
    for(const pos of positions){const tax=resolveTax(currentProducts.get(pos.id)!.parent,partner);if(tax.vat!==pos.vat||tax.vat_enabled!==pos.vatEnabled)throw new ShopError('price-changed');}
    if(job.kind==='stock_checkout'){
      const rate=resolveRate(object(await ms.get(`entity/currency/${partner.currency_id}`)),partner);
      if(rate!==object(job.payload.rate).value)throw new ShopError('price-changed');
      for(const pos of positions){
        const {product,parent}=currentProducts.get(pos.id)!;
        const current=resolvePrice(product,parent,partner);
        if(current.price_minor!==pos.price||current.vat!==pos.vat||current.vat_enabled!==pos.vatEnabled)throw new ShopError('price-changed');
      }
      const stock=await readStock(ms,context.store_id,false);
      for(const requirement of job.validation.stock_required){const free=freeNow(stock.get(uuid(requirement.product_id)));if(free===null||free<quantity(requirement.quantity))throw new ShopError('stock-stale');}
    }
    // Accepted negotiated offers intentionally preserve their accepted prices. No automatic reservation occurs.
    attempted=true;
    const response=object(await ms.createOrder(job.payload));
    const id=await verifyExisting(ms,response,job);await result('created',{order_id:id});return'created';
  }catch(error){
    const code=codeOf(error);
    const ambiguous=(job.mode==='reconcile'&&['network','upstream','rate-limit','ambiguous','unknown'].includes(code))
      ||(attempted&&!(error instanceof ShopError&&error.definitelyRejected));
    const status=ambiguous?'ambiguous':['network','upstream','rate-limit'].includes(code)?'retry':'blocked';
    await result(status,{error_code:ambiguous?'ambiguous':code});return status;
  }
}

export function createBackend(url:string,key:string,fetcher:typeof fetch=fetch,deadline?:number):Backend{
  const base=new URL(url);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new ShopError('validation');
  const names=new Set(['shop_worker_context','shop_worker_import','shop_worker_claim','shop_worker_result','shop_worker_heartbeat','shop_worker_authorize']);
  return{async rpc<T>(name:string,args:Obj={}):Promise<T>{
    if(!names.has(name))throw new ShopError('validation');let response:Response;
    const remaining=deadline===undefined?10000:deadline-Date.now();if(remaining<100)throw new ShopError('network');
    try{response=await fetcher(new URL(`/rest/v1/rpc/${name}`,base),{method:'POST',redirect:'error',headers:{apikey:key,...(key.startsWith('eyJ')?{Authorization:`Bearer ${key}`}:{ }),'Content-Type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(Math.min(10000,remaining))});}catch{throw new ShopError('network');}
    if(!response.ok)throw new ShopError(response.status===401||response.status===403?'unauthorized':'upstream');
    try{
      const content=await response.text();
      if(!content&&['shop_worker_import','shop_worker_result','shop_worker_heartbeat'].includes(name))return null as T;
      return JSON.parse(content) as T;
    }catch{throw new ShopError('upstream');}
  }};
}

export async function runWorker(db:Backend,ms:MsClient,action:'sync'|'dispatch'|'run',now:()=>number=Date.now):Promise<Obj>{
  const context=await db.rpc<WorkerContext>('shop_worker_context');
  if(!context.enabled){await db.rpc('shop_worker_heartbeat',{p_status:'disabled',p_error_code:'disabled'});return{ok:false,status:'disabled'};}
  let synced=0,dispatched=0;
  try{
    if(action==='dispatch'||action==='run'){
      // One claim per request bounds the lease and Edge execution time. Cron can invoke dispatch more often.
      const job=await db.rpc<OrderJob|null>('shop_worker_claim');
      if(job){await dispatchJob(ms,db,context,job,now);dispatched=1;}
    }
    if(action==='sync'||action==='run')synced=await syncShop(ms,db,context,now);
    await db.rpc('shop_worker_heartbeat',{p_status:'ok',p_error_code:null});return{ok:true,synced,dispatched};
  }catch(error){const code=codeOf(error);await db.rpc('shop_worker_heartbeat',{p_status:'error',p_error_code:code});throw new ShopError(code);}
}

export async function equalSecret(a:string,b:string):Promise<boolean>{
  if(!a||!b)return false;const encode=new TextEncoder();
  const [x,y]=await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(a)),crypto.subtle.digest('SHA-256',encode.encode(b))]);
  const aa=new Uint8Array(x),bb=new Uint8Array(y);let difference=0;for(let i=0;i<aa.length;i++)difference|=aa[i]^bb[i];return difference===0;
}
export function serverKey(env:(name:string)=>string|undefined):string{
  const named=env('SUPABASE_SECRET_KEYS');
  if(named){try{const keys=object(JSON.parse(named));const selected=keys.shop_worker??keys.default;if(typeof selected==='string'&&selected.startsWith('sb_secret_'))return selected;}catch{/* Legacy fallback is explicit. */}}
  const key=env('SUPABASE_SERVICE_ROLE_KEY')??env('SUPABASE_SECRET_KEY');if(!key)throw new ShopError('unauthorized');return key;
}

export function makeHandler(env:(name:string)=>string|undefined,fetcher:typeof fetch=fetch){
  return async(request:Request):Promise<Response>=>{
    const started=Date.now();
    const json=(data:Obj,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
    if(request.method!=='POST')return json({ok:false,error:'method-not-allowed'},405);
    let db:Backend;
    try{
      const key=serverKey(env),url=env('SUPABASE_URL');if(!url)return json({ok:false,error:'disabled'},503);
      db=createBackend(url,key,fetcher,started+47000);
      const credential=key.startsWith('sb_secret_')?(request.headers.get('apikey')??''):(request.headers.get('Authorization')??'').replace(/^Bearer /,'');
      let authorized=await equalSecret(credential,key);
      const cronKey=request.headers.get('x-shop-worker-key');
      if(!authorized&&cronKey&&cronKey.length<=256){try{authorized=await db.rpc<boolean>('shop_worker_authorize',{p_key:cronKey})===true;}catch{authorized=false;}}
      if(!authorized)return json({ok:false,error:'unauthorized'},401);
      const text=await request.text();if(text.length>1000)return json({ok:false,error:'validation'},400);
      let input:Obj;try{input=object(JSON.parse(text||'{}'));}catch{return json({ok:false,error:'validation'},400);}
      if(Object.keys(input).some(k=>k!=='action'))return json({ok:false,error:'validation'},400);
      const action=input.action??'run';if(!['sync','dispatch','run'].includes(String(action)))return json({ok:false,error:'validation'},400);
      const token=env('MOYSKLAD_TOKEN');
      if(!token){await db.rpc('shop_worker_heartbeat',{p_status:'disabled',p_error_code:'missing-token'});return json({ok:false,error:'missing-token'},503);}
      const result=await runWorker(db,createMsClient(token,{fetcher,deadline:started+42000}),action as 'sync'|'dispatch'|'run');
      return json(result,result.ok?200:503);
    }catch(error){return json({ok:false,error:codeOf(error)},503);}
  };
}
