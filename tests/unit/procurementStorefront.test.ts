import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CartDraft } from '../../src/modules/orders/draft';
import type { ProcurementCatalog, ProcurementRequest } from '../../src/modules/orders/types';
import { cartPricing, lineTotal, moyskladOrderUrl, submissionFor, verifiedPrice } from '../../src/modules/orders/storefront';

const now = new Date('2026-11-08T17:00:00Z').getTime();
const at = new Date(now).toISOString();
const earlier = new Date(now - 300_001).toISOString();
const id = '00000000-0000-4000-9000-000000000001';
function catalog(): ProcurementCatalog {
  return {
    fetched_at: at, store_id: id, stale: false, incoming: [],
    shop: { enabled: true, reason: null, price_version: id, price_fetched_at: at, currency: 'RUB', currency_minor_unit: 2, worker_status: 'ok', last_heartbeat_at: at, last_success_at: at },
    items: [{ product_id: id, name: 'Тестовая плёнка', code: 'TEST', uom: 'Лист', category: 'Тест', image_url: null, stock: 11, reserve: 3, in_transit: 12, free_now: 8, confirmed_incoming_qty: 12, confirmed_eta: '2026-11-15', purchase_order_id: id, price_minor: 25000 }],
  };
}
function draft(quantity = '8'): CartDraft {
  return { operation: id, attempted: false, items: [{ product_id: id, quantity, name: 'Тестовая плёнка', uom: 'Лист' }], shipment_mode: 'partial', note: 'Просьба связаться' };
}
afterEach(() => vi.useRealTimers());

describe('storefront checkout readiness', () => {
  it('prices 8 available sheets in integer minor units without adding expected stock', () => {
    expect(cartPricing(draft(), catalog(), now)).toMatchObject({ direct: true, valid: true, total: 200000n, currency: 'RUB', needsSupply: false });
    expect(cartPricing(draft('20'), catalog(), now)).toMatchObject({ direct: false, valid: true, needsSupply: true });
  });

  it('requires both current stock and a healthy observed worker, not merely enabled configuration', () => {
    for (const patch of [ { enabled: false }, { worker_status: 'error' as const }, { last_heartbeat_at: earlier }, { last_success_at: earlier }, { last_heartbeat_at: null } ]) {
      const c = catalog(); Object.assign(c.shop!, patch);
      expect(cartPricing(draft(), c, now).direct).toBe(false);
    }
    for (const patch of [{ stale: true }, { fetched_at: earlier }, { fetched_at: null }]) {
      const c = { ...catalog(), ...patch };
      expect(cartPricing(draft(), c, now).direct).toBe(false);
    }
  });

  it('does not invent prices or currency precision, including for one unknown line in a mixed cart', () => {
    for (const patch of [{ price_fetched_at: earlier }, { price_fetched_at: null }, { price_version: null }, { currency: null }, { currency_minor_unit: null }]) {
      const c = catalog(); Object.assign(c.shop!, patch);
      expect(verifiedPrice(c.items[0], c, now)).toBe(false);
      expect(cartPricing(draft(), c, now)).toMatchObject({ direct: false, total: null });
    }
    const c = catalog(); c.items.push({ ...c.items[0], product_id: 'unknown-price', price_minor: null });
    const d = draft(); d.items.push({ ...d.items[0], product_id: 'unknown-price' });
    expect(cartPricing(d, c, now)).toMatchObject({ direct: false, fullyPriced: false, total: null });
  });

  it('rejects unknown stock, invalid quantities, empty carts and missing products', () => {
    const c = catalog(); c.items[0].free_now = null;
    expect(cartPricing(draft(), c, now)).toMatchObject({ direct: false, needsSupply: true });
    for (const q of ['0', '-1', '1e3', '1.0001', '100001', '']) expect(cartPricing(draft(q), catalog(), now).direct).toBe(false);
    expect(cartPricing({ ...draft(), items: [] }, catalog(), now)).toMatchObject({ direct: false, valid: false });
    expect(cartPricing(draft(), { ...catalog(), items: [] }, now)).toMatchObject({ direct: false, valid: false });
  });

  it('tolerates at most one minute of clock skew, and supports source fractional base units', () => {
    const c = catalog(); c.shop!.price_fetched_at = new Date(now + 60_001).toISOString();
    expect(verifiedPrice(c.items[0], c, now)).toBe(false);
    c.shop!.price_fetched_at = at;
    expect(cartPricing(draft('1,125'), c, now)).toMatchObject({ direct: true, total: 28125n });
    expect(lineTotal(101, 0.5)).toBe(51n);
    expect(lineTotal(100_000_000_000, 100000)).toBe(10_000_000_000_000_000n);
  });
});

describe('unchanged submission after an unconfirmed response', () => {
  it('captures exact prices, version, delivery and note, then keeps the same payload after refresh', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const c = catalog(); const d = draft();
    const submission = submissionFor(d, c);
    expect(submission).toMatchObject({ mode: 'checkout', price_version: id, items: [{ product_id: id, quantity: 8, price_minor: 25000 }], shipment_mode: 'partial', note: d.note });
    c.items[0].price_minor = 50000; c.shop!.price_version = 'new-version'; c.shop!.enabled = false;
    const pending = { ...d, attempted: true, submission };
    expect(submissionFor(pending, c)).toBe(submission);
    expect(submissionFor(pending, undefined)).toBe(submission);
    expect(pending.operation).toBe(id);
  });

  it('keeps an attempted legacy request as a request even when direct checkout becomes ready', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(submissionFor({ ...draft(), attempted: true }, catalog())).toMatchObject({ mode: 'request', items: [{ product_id: id, quantity: 8 }] });
  });

  it('submits all 20 sheets together for agreement instead of silently splitting into separate orders', () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const d = { ...draft('20'), shipment_mode: 'together' as const };
    expect(submissionFor(d, catalog())).toEqual({ mode: 'request', items: [{ product_id: id, quantity: 20 }], shipment_mode: 'together', note: d.note });
  });
});

it('links only validated UUIDs to the verified internal МойСклад route', () => {
  const request = (order_id: string) => ({ integration: { order_id } }) as ProcurementRequest;
  expect(moyskladOrderUrl(request(id))).toBe(`https://online.moysklad.ru/app/#customerorder/edit?id=${id}`);
  for (const value of ['javascript:alert(1)', 'https://attacker.invalid', `${id}&other=1`, '']) expect(moyskladOrderUrl(request(value))).toBeNull();
});
