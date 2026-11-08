/** Procurement is a request/approval workflow; stock remains authoritative in МойСклад. */
export type ShipmentMode = 'partial' | 'together';
export type ProcurementStatus = 'submitted' | 'offered' | 'accepted' | 'declined' | 'cancelled' | 'completed';
export interface ProcurementProduct {
  product_id: string; entity_type?: 'product' | 'variant'; name: string; code: string; uom: string; category: string; image_url: string | null;
  stock: number | null; reserve: number | null; in_transit: number | null; free_now: number | null;
  confirmed_incoming_qty: number; confirmed_eta: string | null; purchase_order_id: string | null; confirmed_updated_at?: string | null; incoming_lots?: { quantity: number; eta: string; updated_at: string }[];
  /** Final price for the signed-in partner; never a generic retail or cost price. */
  price_minor?: number | null;
}
export interface ProcurementShop {
  enabled: boolean; reason: string | null; price_version: string | null; price_fetched_at: string | null;
  currency: string | null; currency_minor_unit: number | null;
  worker_status?: 'unknown' | 'ok' | 'error' | 'disabled'; last_heartbeat_at?: string | null;
  last_success_at?: string | null; error_code?: string | null;
}
export interface ProcurementIncoming {
  product_id: string; purchase_order_id: string; quantity: number; eta: string; note: string; version: number; updated_at: string;
}
export interface ProcurementCatalog {
  fetched_at: string | null; store_id: string | null; stale: boolean; items: ProcurementProduct[]; incoming: ProcurementIncoming[];
  shop?: ProcurementShop;
}
export interface ProcurementLine {
  product_id: string; name: string; code: string; uom: string; quantity: number;
  requested_now: number | null; requested_later: number | null;
  now_qty: number; later_qty: number; refused_qty: number;
  now_price_minor: number | null; later_price_minor: number | null;
  eta: string | null; refusal_reason: string; purchased_qty: number; reserved_qty: number; shipped_qty: number; received_qty: number;
}
export interface ProcurementEvent {
  at: string; actor_name: string; action: string; note: string; data: Record<string, unknown>; version: number;
}
export interface ProcurementRequest {
  id: string; number: number; partner_id: string; partner_name: string; status: ProcurementStatus; version: number;
  shipment_mode: ShipmentMode; currency: string | null; note: string; offer_note: string;
  created_at: string; updated_at: string; offered_at: string | null; accepted_at: string | null; valid_until: string | null;
  counterparty_id: string | null; counterparties: { id: string; name: string }[]; snapshot_at: string | null; items: ProcurementLine[]; history: ProcurementEvent[];
  source?: 'request' | 'checkout';
  integration?: { status: 'queued' | 'processing' | 'retry' | 'reconciling' | 'created' | 'blocked'; order_id: string | null; updated_at: string; error_code: string | null } | null;
}
export interface ProcurementDemand {
  product_id: string; name: string; uom: string; quantity: number; request_count: number;
}
export interface ProcurementList {
  is_manager: boolean; partner_id: string | null; requests: ProcurementRequest[]; total: number; demand: ProcurementDemand[];
}
export interface ProcurementOfferLine {
  product_id: string; now_qty: number; later_qty: number; refused_qty: number;
  now_price_minor: number | null; later_price_minor: number | null; eta: string | null; refusal_reason: string;
}
export interface ProcurementOffer {
  items: ProcurementOfferLine[]; currency: string; shipment_mode: ShipmentMode; valid_until: string;
  note: string; counterparty_id: string;
}
export type ProcurementAction = 'offer' | 'accept' | 'decline' | 'cancel' | 'purchase' | 'reserve' | 'ship' | 'receive';
export interface ProcurementProgress {
  items: { product_id: string; quantity: number }[];
  document_id?: string; note: string;
}
// RPCs:
// procurement_catalog() -> ProcurementCatalog
// procurement_list() -> ProcurementList
// procurement_submit(operation UUID, items [{product_id,quantity}], shipment_mode, note) -> ProcurementRequest
// procurement_action(id UUID, expected_version int, action ProcurementAction, data JSON, operation UUID) -> ProcurementRequest
// offer: data ProcurementOffer. accept/decline/cancel: {note}. purchase/reserve/ship/receive: data ProcurementProgress.
// Progress quantities are increments, never cumulative totals. Server enforces accepted quantities and current version.
