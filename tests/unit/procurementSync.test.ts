import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error shared server-side JS module
import { createMoyskladReader, readSyncConfig, parseCatalogMap, readAllEntities, normalizeCatalog, collectCatalog, replaceCatalog } from '../../scripts/procurement-sync-lib.mjs';

const productId = '10000000-0000-0000-0000-000000000001';
const variantId = '10000000-0000-0000-0000-000000000002';
const storeId = '20000000-0000-0000-0000-000000000001';
const retailStoreId = '20000000-0000-0000-0000-000000000002';
const folderId = '30000000-0000-0000-0000-000000000001';
const unrelatedFolderId = '30000000-0000-0000-0000-000000000002';
const config = { storeId, folderIds: [folderId] };
const ref = (type: string, id: string) => ({ meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/${type}/${id}` } });
const product = {
  id: productId, name: 'Матовая плёнка', code: 'FILM-1', archived: false,
  uom: { name: 'Лист' }, productFolder: { ...ref('productfolder', folderId), name: 'Плёнки' },
  packs: [{ quantity: 1 / 6 }], buyPrice: { value: 12345 }, salePrices: [{ value: 22222 }],
  images: { rows: [{ meta: { href: 'https://private.example/image?token=secret' } }] },
};
const report = (field: string, value: number | null, id = productId, location: string | null = storeId) => ({
  assortmentId: id, storeId: location, [field]: value,
});
function fixture() {
  return { ...config, products: [product], variants: [],
    stock: [report('stock', 20)], reserve: [report('reserve', 5)], inTransit: [report('inTransit', 12)] };
}
const page = (rows: unknown[], size: number, offset = 0) => ({ rows, meta: { size, offset } });

describe('server-only procurement snapshot', () => {
  it('requires explicit canonical warehouse and exact category allowlist', () => {
    expect(readSyncConfig({ MOYSKLAD_PROCUREMENT_STORE_ID: storeId, MOYSKLAD_PROCUREMENT_FOLDER_IDS: ` ${folderId},${folderId} ` })).toEqual(config);
    expect(() => readSyncConfig({ MOYSKLAD_PROCUREMENT_STORE_ID: 'Main warehouse', MOYSKLAD_PROCUREMENT_FOLDER_IDS: folderId })).toThrow();
    expect(() => readSyncConfig({ MOYSKLAD_PROCUREMENT_STORE_ID: storeId })).toThrow();
  });

  it('keeps base units and physical stock separate from reservations, incoming and retail stock', () => {
    const data = fixture();
    data.stock.push(report('stock', 900, productId, retailStoreId));
    data.reserve.push(report('reserve', 3, productId, null));
    const [row] = normalizeCatalog(data);
    expect(row).toMatchObject({ product_id: productId, uom: 'Лист', stock: 20, reserve: 5, unallocated_reserve: 3, in_transit: 12 });
    expect(row.stock - row.reserve - row.unallocated_reserve).toBe(12);
    expect(row.confirmed_incoming_qty).toBe(0);
    expect(row.confirmed_eta).toBeNull();
    expect(row.purchase_order_id).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/buyPrice|salePrices|12345|22222|secret|packs|private\.example/);
    expect(row.image_url).toBeNull();
  });

  it('does not reinterpret unknown, recalculating, or missing physical stock as zero or available', () => {
    expect(normalizeCatalog({ ...fixture(), stock: [report('stock', null)] })[0].stock).toBeNull();
    expect(normalizeCatalog({ ...fixture(), stock: [] })[0].stock).toBeNull();
    const row = normalizeCatalog({ ...fixture(), reserve: [report('reserve', null, productId, null)] })[0];
    expect(row.unallocated_reserve).toBeNull();
    expect(() => normalizeCatalog({ ...fixture(), stock: [{ assortmentId: productId, storeId }] })).toThrow();
  });

  it('rejects duplicate UUIDs and retains decimal and negative source quantities without conversion', () => {
    expect(() => normalizeCatalog({ ...fixture(), products: [product, product] })).toThrow(/duplicate/);
    expect(() => normalizeCatalog({ ...fixture(), stock: [report('stock', 1), report('stock', 2)] })).toThrow(/duplicate/);
    const [row] = normalizeCatalog({ ...fixture(), products: [{ ...product, uom: { name: 'м' } }], stock: [report('stock', -0.5)] });
    expect(row.stock).toBe(-0.5);
    expect(row.uom).toBe('м');
  });

  it('does not authorize categories by title or SKU and excludes archived entries', () => {
    const excluded = { ...product, id: variantId, productFolder: { ...ref('productfolder', unrelatedFolderId), name: 'Плёнки' } };
    const result = normalizeCatalog({ ...fixture(), products: [product, excluded] });
    expect(result.map((p: { product_id: string }) => p.product_id)).toEqual([productId]);
    expect(() => normalizeCatalog({ ...fixture(), products: [{ ...product, archived: true }] })).toThrow(/no active products/);
    expect(() => normalizeCatalog({ ...fixture(), products: [{ ...product, uom: {} }] })).toThrow(/base unit/);
  });

  it('keeps a reviewed UUID/photo allowlist narrower than the category across future syncs', () => {
    const imageUrl = 'https://static.tildacdn.com/example/product.jpg';
    const catalogMap = parseCatalogMap([{ product_id: productId, image_url: imageUrl }]);
    const newProduct = { ...product, id: variantId, name: product.name, code: product.code };
    const rows = normalizeCatalog({ ...fixture(), products: [product, newProduct], catalogMap });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_id: productId, image_url: imageUrl });
    expect(() => parseCatalogMap([])).toThrow();
    expect(() => parseCatalogMap([{ product_id: productId }, { product_id: productId }])).toThrow(/duplicate/);
    expect(() => parseCatalogMap([{ product_id: productId, salePrices: [] }])).toThrow(/fields/);
    for (const image_url of ['http://static.tildacdn.com/a.jpg', 'https://static.tildacdn.com.attacker.example/a.jpg',
      'https://api.moysklad.ru/api/remap/1.2/download/secret', 'https://secret@static.tildacdn.com/a.jpg',
      'https://static.tildacdn.com/a.jpg?token=secret']) {
      expect(() => parseCatalogMap([{ product_id: productId, image_url }])).toThrow();
    }
  });

  it('uses concrete variant UUIDs and their parent unit instead of selling an aggregate parent', () => {
    const variant = { id: variantId, product: ref('product', productId), name: 'Матовая плёнка — 40 см', code: 'FILM-V1', archived: false };
    const rows = normalizeCatalog({ ...fixture(), variants: [variant], stock: [report('stock', 8, variantId)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_id: variantId, uom: 'Лист', name: variant.name, stock: 8 });
  });

  it('reads every page and refuses a changed count, missing page, or duplicate UUID', async () => {
    const reader = { get: vi.fn().mockResolvedValueOnce(page([product], 2)).mockResolvedValueOnce(page([{ ...product, id: variantId }], 2, 1)) };
    expect(await readAllEntities(reader, 'entity/product', {}, 1)).toHaveLength(2);
    expect(reader.get.mock.calls[1][1]).toMatchObject({ offset: '1', limit: '1' });
    for (const next of [page([], 2, 1), page([product], 2, 1), page([{ ...product, id: variantId }], 3, 1)]) {
      const incomplete = { get: vi.fn().mockResolvedValueOnce(page([product], 2)).mockResolvedValueOnce(next) };
      await expect(readAllEntities(incomplete, 'entity/product', {}, 1)).rejects.toThrow();
    }
  });

  it('allows only hardcoded GET endpoints and retries a bounded 429 without following redirects', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '9999999' } }))
      .mockResolvedValueOnce(new Response('[]', { status: 200 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const reader = createMoyskladReader('private-token', { fetchImpl, sleep });
    expect(await reader.get('report/stock/bystore/current')).toEqual([]);
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    await expect(reader.get('https://attacker.example')).rejects.toThrow(/allowlist/);
    await expect(reader.get('entity/customerorder')).rejects.toThrow(/allowlist/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const denied = createMoyskladReader('private-token', { fetchImpl: vi.fn().mockResolvedValue(new Response('sensitive-data', { status: 403 })) });
    await expect(denied.get('entity/product')).rejects.toThrow('MoySklad HTTP 403');
  });

  it('reads unscoped reserves, starts freshness at collection start and rejects a stale collection', async () => {
    const reader = { get: vi.fn(async (path: string, params: Record<string, string>) => {
      if (path === 'entity/product') return page([product], 1);
      if (path === 'entity/variant') return page([], 0);
      expect(params).not.toHaveProperty('filter'); // Filtering a single store would drop storeId:null.
      expect(params).toMatchObject({ include: 'zeroLines', withRecalculate: 'true' });
      return [report(params.stockType, 0)];
    }) };
    const start = new Date('2026-11-08T14:00:00Z');
    const now = vi.fn().mockReturnValueOnce(start).mockReturnValueOnce(new Date(+start + 60_000));
    const result = await collectCatalog(reader, config, { now });
    expect(result.fetchedAt).toBe(start.toISOString());
    const staleNow = vi.fn().mockReturnValueOnce(start).mockReturnValueOnce(new Date(+start + 300_001));
    await expect(collectCatalog(reader, config, { now: staleNow })).rejects.toThrow(/stale/);
  });

  it('replaces in one transaction and rolls back on failure without leaking SQL parameter values', async () => {
    const snapshot = { rows: normalizeCatalog(fixture()), storeId, fetchedAt: '2026-11-08T14:00:00Z' };
    const db = { query: vi.fn().mockResolvedValue({}) };
    await replaceCatalog(db, snapshot);
    expect(db.query.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'begin', 'select app_private.procurement_catalog_store($1::jsonb,$2::uuid,$3::timestamptz)', 'commit',
    ]);
    const badDb = { query: vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('password=secret raw-product')).mockResolvedValue({}) };
    await expect(replaceCatalog(badDb, snapshot)).rejects.toThrow('database replacement failed');
    expect(badDb.query.mock.calls.at(-1)?.[0]).toBe('rollback');
  });
});
