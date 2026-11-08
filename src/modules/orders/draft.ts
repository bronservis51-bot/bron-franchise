import type { ShipmentMode } from './types';

export interface CartSubmission {
  mode: 'request' | 'checkout';
  items: { product_id: string; quantity: number; price_minor?: number }[];
  price_version?: string;
  currency?: string;
  currency_minor_unit?: number;
  shipment_mode: ShipmentMode;
  note: string;
}
export interface CartDraft {
  operation: string;
  items: { product_id: string; quantity: string; name: string; uom: string }[];
  shipment_mode: ShipmentMode;
  note: string;
  attempted: boolean;
  /** Immutable outgoing payload retained until the server outcome is known. */
  submission?: CartSubmission;
}
export const emptyCart = (): CartDraft => ({ operation: crypto.randomUUID(), items: [], shipment_mode: 'partial', note: '', attempted: false });
const key = (user: string) => `bron.procurement-draft:${user}`;

export function readCart(user: string): CartDraft {
  try {
    const d = JSON.parse(sessionStorage.getItem(key(user)) ?? 'null') as CartDraft | null;
    if (d && typeof d.operation === 'string' && Array.isArray(d.items) && d.items.every(x => typeof x.product_id === 'string' && typeof x.quantity === 'string' && typeof x.name === 'string' && typeof x.uom === 'string') && (d.shipment_mode === 'partial' || d.shipment_mode === 'together') && typeof d.note === 'string') return d;
  } catch { /* Keep working, but never claim the draft was persisted. */ }
  return emptyCart();
}
export function saveCart(user: string, draft: CartDraft) {
  try { sessionStorage.setItem(key(user), JSON.stringify(draft)); return true; } catch { return false; }
}
export function quantityNumber(value: string) {
  if (!/^\d+(?:[.,]\d{1,3})?$/.test(value.trim())) return null;
  const n = Number(value.replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 100000 ? n : null;
}
