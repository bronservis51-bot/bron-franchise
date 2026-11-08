import type { CartDraft, CartSubmission } from './draft';
import { quantityNumber } from './draft';
import type { ProcurementCatalog, ProcurementProduct, ProcurementRequest } from './types';

const MAX_AGE = 5 * 60_000;
export function verifiedPrice(product: ProcurementProduct, catalog: ProcurementCatalog, now = Date.now()) {
  const shop = catalog.shop;
  const at = shop?.price_fetched_at ? new Date(shop.price_fetched_at).getTime() : NaN;
  return !!shop?.currency && !!shop.price_version && Number.isInteger(shop.currency_minor_unit) && shop.currency_minor_unit! >= 0 && shop.currency_minor_unit! <= 4 && Number.isFinite(at) && at <= now + 60_000 && now - at <= MAX_AGE &&
    typeof product.price_minor === 'number' && Number.isSafeInteger(product.price_minor) && product.price_minor > 0;
}

/** Amounts are integral minor currency units. Round fractional unit quantities per line. */
export function lineTotal(priceMinor: number, quantity: number): bigint {
  const thousandths = BigInt(Math.round(quantity * 1000));
  return (BigInt(priceMinor) * thousandths + 500n) / 1000n;
}

export function cartPricing(draft: CartDraft, catalog?: ProcurementCatalog, now = Date.now()) {
  const stockAt = catalog?.fetched_at ? new Date(catalog.fetched_at).getTime() : NaN;
  const stockFresh = !!catalog && !catalog.stale && Number.isFinite(stockAt) && stockAt <= now + 60_000 && now - stockAt <= MAX_AGE;
  let total = 0n; let priced = 0; let needsSupply = false; let valid = draft.items.length > 0;
  for (const item of draft.items) {
    const p = catalog?.items.find(p => p.product_id === item.product_id); const q = quantityNumber(item.quantity);
    if (!p || q === null) { valid = false; continue; }
    if (catalog && verifiedPrice(p, catalog, now)) { total += lineTotal(p.price_minor!, q); priced += 1; }
    if (!stockFresh || p.free_now === null || p.free_now < q) needsSupply = true;
  }
  const fullyPriced = valid && priced === draft.items.length;
  const health = catalog?.shop;
  const heartbeat = health?.last_heartbeat_at ? new Date(health.last_heartbeat_at).getTime() : NaN;
  const success = health?.last_success_at ? new Date(health.last_success_at).getTime() : NaN;
  const workerReady = health?.worker_status === 'ok' && Number.isFinite(heartbeat) && Number.isFinite(success) && now - heartbeat <= MAX_AGE && now - success <= MAX_AGE && heartbeat <= now + 60_000 && success <= now + 60_000;
  const direct = valid && fullyPriced && !needsSupply && !!health?.enabled && workerReady;
  return { direct, valid, fullyPriced, total: fullyPriced ? total : null, currency: catalog?.shop?.currency ?? null, needsSupply, stockFresh };
}

export function submissionFor(draft: CartDraft, catalog?: ProcurementCatalog): CartSubmission {
  // Legacy attempted requests must retry as requests, even after direct checkout is enabled.
  if (draft.attempted && draft.submission) return draft.submission;
  const direct = !draft.attempted && cartPricing(draft, catalog).direct;
  return {
    mode: direct ? 'checkout' : 'request',
    items: draft.items.map(i => ({ product_id: i.product_id, quantity: quantityNumber(i.quantity)!, ...(direct ? { price_minor: catalog!.items.find(p => p.product_id === i.product_id)!.price_minor! } : {}) })),
    ...(direct ? { price_version: catalog!.shop!.price_version!, currency: catalog!.shop!.currency!, currency_minor_unit: catalog!.shop!.currency_minor_unit ?? 2 } : {}),
    shipment_mode: draft.shipment_mode,
    note: draft.note,
  };
}

/** Only canonical МойСклад document UUIDs can become links. */
export function moyskladOrderUrl(request: ProcurementRequest): string | null {
  const id = request.integration?.order_id;
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? `https://online.moysklad.ru/app/#customerorder/edit?id=${id}` : null;
}
