import { describe, expect, it } from 'vitest';
// @ts-expect-error Node importer is native ESM.
import { readDocuments, readMonthSnapshots, sourceCostCurrency, documentReader } from '../../scripts/moysklad-documents-lib.mjs';

const id = 'bbbb0000-0000-0000-0000-000000000001';
const item = { id, quantity: 2, price: 100, discount: 10, vat: 20, stock: { cost: 87 }, assortment: { id, name: 'Плёнка' } };
const doc = { id, organization:{id}, name: 'Тест 1', applicable: true, moment: '2026-10-01 12:00:00.000', updated: '2026-10-02 12:00:00.000',
  sum: 216, vatEnabled: true, vatIncluded: false, agent: { id, name: 'Тест контрагент' }, positions: {meta:{size:1}},
  rate: { currency: { isoCode: 'RUB' } } };
const page = (rows: unknown[]) => ({meta:{size:rows.length,offset:0},rows});
function read(document = doc, position: typeof item | Omit<typeof item,'stock'> = item, broken = false) {
  return readDocuments(async (path: string) => path.endsWith('positions')
    ? { ...page([position]), ...(broken && {rows:[]}) }
    : page(path === 'entity/supply' ? [] : [document]), '2026-10-01', '2026-11-01', 'RUB', id);
}
describe('MoySklad primary documents', () => {
  it('reconciles document tax and discount, keeps missing stock cost unknown', async () => {
    const docs = await read();
    expect(docs.map((d: {kind:string}) => d.kind)).toEqual(['demand','salesreturn','purchasereturn']);
    expect(docs[0].lines[0]).toMatchObject({amount_minor:216,cost_minor:87});
    const { stock, ...withoutCost } = item;
    expect((await read(doc, withoutCost))[0].lines[0].cost_minor).toBeNull();
  });
  it('rejects an incomplete page or a mismatched document total', async () => {
    await expect(read(doc,item,true)).rejects.toThrow(/page/i);
    await expect(read({...doc,sum:215})).rejects.toThrow(/total/i);
  });
});

it('reads the verified source accounting currency and keeps mixed currencies independent', async () => {
  expect(await sourceCostCurrency(async () => page([{id, default:true, isoCode:'RUB'}]))).toBe('RUB');
  await expect(sourceCostCurrency(async () => page([]))).rejects.toThrow(/currency/i);
  const [shipment] = await read({...doc,rate:{currency:{isoCode:'TRY'}}});
  expect(shipment.currency).toBe('TRY');
  expect(shipment.lines[0].cost_currency).toBe('RUB');
});
it('rejects off-origin paths and unsupported documents before a request',async()=>{
  const get = documentReader('test-only');
  await expect(get('https://example.com/private')).rejects.toThrow(/allowlist/);
  await expect(get('entity/customerorder')).rejects.toThrow(/allowlist/);
});
it('rejects a changed document revision after reading positions',async()=>{
  let called = false;
  const get = async (path:string) => {
    if (path.endsWith('positions')) return page([item]);
    if (called) return page([{...doc, updated:doc.updated + ' changed'}]);
    called = true; return page([doc]);
  };
  await expect(readDocuments(get,'2026-10-01','2026-11-01','RUB',id)).rejects.toThrow(/changed/i);
});

it('reconciles fractional source prices without binary rounding at a half-kopeck',async()=>{
  const [shipment]=await read({...doc,vatEnabled:false,sum:101},{...item,quantity:100,price:1.005,discount:0,vat:0});
  expect(shipment.lines[0].amount_minor).toBe(101);
});

it('verifies the configured legal entity even when a source ignores its filter',async()=>{
  await expect(read({...doc,organization:{id:'bbbb0000-0000-0000-0000-000000000003'}})).rejects.toThrow(/organization/i);
});

it('revalidates an earlier kind across the entire two-month window after reading later kinds', async () => {
  let moved = false;
  const get = async (path: string) => {
    if (path.endsWith('positions')) return page([item]);
    if (path === 'entity/salesreturn') moved = true;
    if (path !== 'entity/demand') return page([]);
    return page([moved ? {...doc, moment:'2026-11-02 09:00:00.000', updated:'2026-11-03 12:00:00.000'} : doc]);
  };
  await expect(readMonthSnapshots(get,['2026-10-01','2026-11-01'],'RUB',id)).rejects.toThrow(/changed/i);
});

it('refuses insecure process TLS before creating a token-backed reader', () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    expect(() => documentReader('test-only')).toThrow(/TLS/);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

it('keeps a return without stock.cost unknown even when the manual cost field exists', async () => {
  const { stock, ...withNoStock } = item;
  const manualReturn = { ...withNoStock, cost: 87 };
  const docs = await read(doc, manualReturn);
  expect(docs.find((d:{kind:string})=>d.kind==='salesreturn').lines[0].cost_minor).toBeNull();
});
