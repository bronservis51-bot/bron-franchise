import { command, from, rows, single } from '../../platform/backend';

export interface CatalogItem {
  item_id: string; sku: string; article_no: number | null; name: string; category: string; subtitle: string | null; description: string | null;
  visual: { kind?: string; colors?: string[]; tool?: string } | null; image_url: string | null;
  incoming_on: string | null; incoming_qty: string | null; is_new: boolean; arrived_at: string | null; subscribed: boolean; unit: string; pack_multiple: string; min_qty: string;
  lead_time_days: number | null; price_minor: string; currency: string; available_qty: string | null; stock_source: string | null; stock_refreshed_at: string | null;
}
export interface Order {
  id: string; number: string | null; kind: string; partner_id: string | null; location_id: string; status: string; approval_status: string; payment_status: string;
  transfer_status: string; currency: string; total_minor: string; delivery_address: string | null; contact: string | null; comment: string | null;
  submitted_at: string | null; created_by: string; created_at: string; updated_at: string; repeated_from: string | null; revision: number;
}
export interface OrderLine { id: string; item_id: string; sku: string; name: string; unit: string; price_minor: string; qty_ordered: string; qty_confirmed: string; qty_shipped: string; qty_received: string; qty_cancelled: string; line_total_minor: string }
export interface Shipment { id: string; external_ref: string; carrier: string | null; tracking: string | null; eta_from: string | null; eta_to: string | null; promised_on: string | null; status: string; created_at: string; shipment_line: { line_id: string; qty: string }[] }

export const catalog = (location: string) => command<CatalogItem[]>('catalog_for_location', { location });
export const stockSubscribe = (item: string, on: boolean) => command<boolean>('stock_subscribe', { item, on });

export interface BoardItem {
  id: string; sku: string; article_no: number | null; name: string; category: string; subtitle: string | null; unit: string; visual: { kind?: string } | null;
  published_at: string | null; available_qty: number; waiting: number; backlog_qty: number; last_arrival: string | null;
  incoming: { id: string; qty: number; expected_on: string; note: string | null }[];
}
export const stockBoard = () => command<BoardItem[]>('stock_board');
export const supplyCommands = {
  plan: (item: string, qty: number, expected_on: string, note: string | null) => command('stock_incoming_plan', { item, qty, expected_on, note }),
  arrive: (incoming: string, qty: number | null) => command('stock_incoming_arrive', { incoming, qty }),
  cancel: (incoming: string, reason: string) => command('stock_incoming_cancel', { incoming, reason }),
  announce: (item: string, message: string | null) => command('catalog_item_announce', { item, message }),
};
export const cartOpen = (location: string) => command<Order>('cart_open', { location });
export const cartLines = (order: string) => rows<OrderLine>(from('order_line').select('*').eq('order_id', order).order('name'));

export type OrderFilter = 'active' | 'approval' | 'problem' | 'done' | 'all';
export function listOrders(filter: OrderFilter, partnerId?: string | null, locationId?: string | null) {
  let q = from('sales_order').select('*').neq('status', 'draft').limit(200);
  if (filter === 'active') q = q.not('status', 'in', '(completed,cancelled)');
  if (filter === 'approval') q = q.or('approval_status.eq.pending,payment_status.in.(required,reported)').neq('status', 'cancelled');
  if (filter === 'problem') q = q.in('transfer_status', ['failed', 'needs_reconciliation']);
  if (filter === 'done') q = q.in('status', ['completed', 'cancelled']);
  if (partnerId) q = q.eq('partner_id', partnerId);
  if (locationId) q = q.eq('location_id', locationId);
  return rows<Order>(q.order('submitted_at', { ascending: false }));
}
export const getOrder = (id: string) => single<Order>(from('sales_order').select('*').eq('id', id));
export const orderShipments = (id: string) => rows<Shipment>(from('shipment').select('*, shipment_line(line_id, qty)').eq('order_id', id).order('created_at'));
export const orderEvents = (id: string) => rows<{ id: number; actor_id: string | null; action: string; detail: Record<string, unknown> | null; comment: string | null; at: string }>(
  from('order_event').select('*').eq('order_id', id).order('at'));

export const orderCommands = {
  setLine: (order: string, item: string, qty: number) => command('cart_set_line', { order, item, qty }),
  update: (order: string, address: string, contact: string, comment: string) => command<Order>('cart_update', { order, address, contact, comment }),
  submit: (order: string, key: string) => command<{ order_id: string; number: string; status: string; replayed?: boolean }>('order_submit', { order, key }),
  approve: (order: string, comment: string | null) => command<Order>('order_approve', { order, comment }),
  reject: (order: string, reason: string) => command<Order>('order_reject', { order, reason }),
  paymentConfirm: (order: string, reference: string) => command<Order>('order_payment_confirm', { order, reference }),
  cancel: (order: string, reason: string) => command<Order>('order_cancel', { order, reason }),
  repeat: (order: string) => command<Order>('order_repeat', { order }),
  receive: (order: string, lines: { line_id: string; qty_received: number; final: boolean }[], comment: string | null) =>
    command<Order>('order_receive', { order, lines, comment }),
  demoEvent: (order: string, type: string, mode: string, eventId: string | null) =>
    command<{ event_id: string; inbox: string }>('demo_warehouse_event', { order, type, mode, event_id: eventId }),
};

export const ORDER_EVENT: Record<string, string> = {
  submitted: 'Заказ отправлен', approved: 'Согласован', rejected: 'Отклонён', payment_confirmed: 'Оплата подтверждена', queued_for_warehouse: 'Ожидает передачи на склад',
  sent_to_warehouse: 'Передан на склад', transfer_failed: 'Склад недоступен', transfer_unknown: 'Результат передачи неизвестен', warehouse_accepted: 'Склад подтвердил количества',
  shipment: 'Отгрузка', shipment_delayed: 'Перенос доставки', shipment_delivered: 'Посылка доставлена', received: 'Приёмка', status: 'Статус изменён', cancelled: 'Отменён',
};
