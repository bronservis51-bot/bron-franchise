// Server-side MoySklad read adapter. No prices, credentials or raw metadata enter the client snapshot.
// Reference: moysklad/api-remap-1.2-doc, md/reports/_report_stock.md (checked 2026-11-08).
const API = 'https://api.moysklad.ru/api/remap/1.2/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_PATHS = new Set(['entity/product', 'entity/variant', 'report/stock/bystore/current']);
const MAX_ROWS = 100_000;

function fail(message) { throw new Error(`Procurement sync: ${message}; previous snapshot retained`); }
function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`invalid ${label}`);
  return value.toLowerCase();
}
function text(value, label, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`invalid ${label}`);
  return value.trim();
}
function numeric(value, label, { negative = false } = {}) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e8 || (!negative && value < 0)) {
    fail(`invalid ${label}`);
  }
  return value;
}

/** Category UUIDs are exact and explicit; child categories must also be explicitly allowed. */
export function readSyncConfig(env) {
  const storeId = uuid(env.MOYSKLAD_PROCUREMENT_STORE_ID, 'store UUID');
  const folderIds = (env.MOYSKLAD_PROCUREMENT_FOLDER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!folderIds.length || folderIds.length > 100) fail('set 1–100 allowed category UUIDs');
  return { storeId, folderIds: [...new Set(folderIds.map(id => uuid(id, 'category UUID')))] };
}

/** Private, reviewed UUID allowlist. Public Tilda photos are the only supported source in this rollout. */
export function parseCatalogMap(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) fail('invalid reviewed catalog map');
  const result = new Map();
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['product_id', 'image_url'].includes(key))) fail('unexpected catalog map fields');
    const productId = uuid(row.product_id, 'mapped product UUID');
    if (result.has(productId)) fail('duplicate UUID in catalog map');
    let imageUrl = null;
    if (row.image_url !== null && row.image_url !== undefined) {
      if (typeof row.image_url !== 'string' || row.image_url.length > 2000 || /\s/.test(row.image_url)) fail('invalid public image URL');
      let url;
      try { url = new URL(row.image_url); } catch { fail('invalid public image URL'); }
      if (url.protocol !== 'https:' || url.hostname !== 'static.tildacdn.com' || url.port || url.username || url.password
        || url.search || url.hash || url.pathname === '/') fail('image URL is not an approved public Tilda asset');
      imageUrl = url.href;
    }
    result.set(productId, imageUrl);
  }
  return result;
}

function metaId(value, type) {
  if (!value || typeof value !== 'object') return null;
  if (value.id !== undefined) return uuid(value.id, `${type} UUID`);
  try {
    const url = new URL(value.meta?.href);
    const prefix = `/api/remap/1.2/entity/${type}/`;
    if (url.origin !== 'https://api.moysklad.ru' || !url.pathname.startsWith(prefix) || url.search || url.hash) return null;
    const id = url.pathname.slice(prefix.length);
    return UUID.test(id) ? id.toLowerCase() : null;
  } catch { return null; }
}

/** Only hardcoded MoySklad GET endpoints. Redirects cannot forward the token elsewhere. */
export function createMoyskladReader(token, {
  fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 30_000, maxAttempts = 3,
} = {}) {
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) fail('missing server read token');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) fail('invalid retry limit');
  async function get(path, query = {}) {
    if (!READ_PATHS.has(path)) fail('endpoint is not in the read allowlist');
    const url = new URL(path, API);
    url.search = new URLSearchParams(query).toString();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip', Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt + 1 === maxAttempts) fail('MoySklad network request failed');
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt + 1 === maxAttempts) fail(`MoySklad HTTP ${response.status}`);
        const retry = Number(response.headers.get('Retry-After'));
        await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(10_000, retry * 1000) : 2000 * (attempt + 1));
        continue;
      }
      if (!response.ok) fail(`MoySklad HTTP ${response.status}`);
      const body = await response.text();
      if (body.length > 50_000_000) fail('response exceeds safety limit');
      try { return JSON.parse(body); } catch { fail('invalid JSON response'); }
    }
    fail('MoySklad read did not complete');
  }
  return { get };
}

/** Counts, page offsets, UUID uniqueness and a stable total detect partial/changing catalog reads.
 * Keep pages <=100: MoySklad does not expand unit/category metadata for larger pages. */
export async function readAllEntities(reader, path, query = {}, pageSize = 100) {
  if (!['entity/product', 'entity/variant'].includes(path)) fail('invalid entity endpoint');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) fail('invalid page size');
  let expected = null;
  const result = [], seen = new Set();
  for (let offset = 0; offset < MAX_ROWS; offset += pageSize) {
    const page = await reader.get(path, { ...query, limit: String(pageSize), offset: String(offset) });
    const size = page.meta?.size;
    if (!Array.isArray(page.rows) || !Number.isSafeInteger(size) || size < 0 || size > MAX_ROWS) fail('incomplete catalog response');
    if (expected !== null && expected !== size) fail('catalog changed during pagination');
    if (page.meta.offset !== undefined && page.meta.offset !== offset) fail('unexpected page offset');
    expected = size;
    if (page.rows.length > pageSize) fail('oversized catalog page');
    for (const row of page.rows) {
      const id = uuid(row.id, 'product UUID');
      if (seen.has(id)) fail('duplicate UUID during pagination');
      seen.add(id);
      result.push(row);
    }
    if (result.length === size) return result;
    if (result.length > size || page.rows.length !== pageSize) fail('missing catalog page');
  }
  fail('catalog exceeds safety limit');
}

/** The current report is a single complete array, not a page. Keep unscoped reserves. */
function stockIndex(rows, field) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS * 100) fail('incomplete stock report');
  const result = new Map();
  for (const row of rows) {
    const productId = uuid(row.assortmentId, 'stock product UUID');
    const storeId = row.storeId === null ? null : uuid(row.storeId, 'stock store UUID');
    const key = `${productId}:${storeId ?? '-'}`;
    if (result.has(key)) fail('duplicate stock report row');
    result.set(key, numeric(row[field], field, { negative: field === 'stock' }));
  }
  return result;
}

/** A value absent from a complete report is never used to claim physical availability. */
export function normalizeCatalog({ products, variants = [], stock, reserve, inTransit, storeId, folderIds, catalogMap = null }) {
  storeId = uuid(storeId, 'store UUID');
  const allowed = new Set(folderIds.map(id => uuid(id, 'category UUID')));
  if (!allowed.size) fail('empty category allowlist');
  if (catalogMap !== null && (!(catalogMap instanceof Map) || !catalogMap.size)) fail('invalid reviewed catalog map');
  const stockMap = stockIndex(stock, 'stock');
  const reserveMap = stockIndex(reserve, 'reserve');
  const transitMap = stockIndex(inTransit, 'inTransit');
  const productMap = new Map(), variantParents = new Set(), ids = new Set();
  for (const product of products) {
    const id = uuid(product.id, 'product UUID');
    if (productMap.has(id)) fail('duplicate product UUID');
    productMap.set(id, product);
  }
  for (const variant of variants) {
    const parent = metaId(variant.product, 'product');
    if (!parent) fail('variant has no canonical parent UUID');
    if (!variant.archived) variantParents.add(parent);
  }
  const normalized = [];
  for (const item of [...products, ...variants]) {
    if (item.archived) continue;
    const id = uuid(item.id, 'product UUID');
    if (ids.has(id)) fail('duplicate assortment UUID');
    ids.add(id);
    if (catalogMap && !catalogMap.has(id)) continue;
    const parentId = item.product ? metaId(item.product, 'product') : null;
    const parent = parentId ? productMap.get(parentId) : item;
    if (!parent) fail('variant parent missing from full product catalog');
    if (parent.archived) continue;
    const folderId = metaId(parent.productFolder, 'productfolder');
    if (!folderId || !allowed.has(folderId)) continue;
    // A parent with variants is an aggregate. Sell only the concrete variant UUIDs.
    if (!parentId && variantParents.has(id)) continue;
    const uom = parent.uom?.name;
    const key = `${id}:${storeId}`;
    const unallocatedKey = `${id}:-`;
    const physical = stockMap.has(key) ? stockMap.get(key) : null;
    const reserved = reserveMap.has(key) ? reserveMap.get(key) : (physical === null ? null : 0);
    const unallocated = reserveMap.has(unallocatedKey) ? reserveMap.get(unallocatedKey) : 0;
    const transit = transitMap.has(key) ? transitMap.get(key) : null;
    if (item.code !== undefined && (typeof item.code !== 'string' || item.code.length > 255)) fail('invalid product code');
    normalized.push({
      product_id: id,
      entity_type: parentId ? 'variant' : 'product',
      name: text(item.name, 'product name'),
      code: item.code ?? '',
      uom: text(uom, 'base unit', 30),
      category: text(parent.productFolder?.name, 'category name'),
      // Only a separately reviewed UUID map may add public photos. Never expose authenticated API URLs.
      image_url: catalogMap?.get(id) ?? null,
      stock: physical,
      reserve: reserved,
      unallocated_reserve: unallocated,
      in_transit: transit,
      // A purchase order/inTransit alone does not establish a confirmed commercial offer.
      confirmed_incoming_qty: 0,
      confirmed_eta: null,
      purchase_order_id: null,
    });
  }
  if (!normalized.length) fail('allowlist returned no active products');
  return normalized.sort((a, b) => a.product_id.localeCompare(b.product_id));
}

/** Timestamp is the beginning of collection, never the end of a long or failed import.
 * These independent reads are indicative, not an atomic reservation check. An order is not confirmed here. */
export async function collectCatalog(reader, config, { now = () => new Date(), maxAgeMs = 5 * 60_000 } = {}) {
  const started = now();
  const products = await readAllEntities(reader, 'entity/product', { filter: 'archived=false', expand: 'uom,productFolder' });
  const variants = await readAllEntities(reader, 'entity/variant', { filter: 'archived=false' });
  const reports = {};
  for (const type of ['stock', 'reserve', 'inTransit']) {
    reports[type] = await reader.get('report/stock/bystore/current', {
      stockType: type, include: 'zeroLines', withRecalculate: 'true',
    });
  }
  const finished = now();
  if (!Number.isFinite(+started) || !Number.isFinite(+finished) || finished < started || +finished - +started > maxAgeMs) {
    fail('collection is stale');
  }
  return {
    rows: normalizeCatalog({ products, variants, ...reports, ...config }),
    storeId: config.storeId,
    fetchedAt: started.toISOString(),
  };
}

/** No writes occur until all reads and validation finish. The private RPC replaces atomically. */
export async function replaceCatalog(db, snapshot) {
  await db.query('begin');
  try {
    await db.query('select app_private.procurement_catalog_store($1::jsonb,$2::uuid,$3::timestamptz)', [
      JSON.stringify(snapshot.rows), snapshot.storeId, snapshot.fetchedAt,
    ]);
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    // Database errors can embed parameter values. The CLI must not print them.
    fail('database replacement failed');
  }
}
