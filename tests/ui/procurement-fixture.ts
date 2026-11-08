// Synthetic procurement responses for the actual application UI. Never sent to a live backend.
import type { ProcurementCatalog, ProcurementLine, ProcurementRequest } from '../../src/modules/orders/types';
const id = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const at = new Date().toISOString();
const next = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const catalog: ProcurementCatalog = {
  fetched_at: at, store_id: id(9), stale: false, incoming: [],
  shop: {enabled:true,reason:null,price_version:id(60),price_fetched_at:at,currency:'RUB',currency_minor_unit:2,worker_status:'ok',last_heartbeat_at:at,last_success_at:at,error_code:null},
  items: [
    { product_id: id(1), name: 'Принтовая плёнка с очень длинным названием коллекции и текстуры', code: 'QA-001', price_minor: 25000, uom: 'Лист', category: 'Принты', image_url: null, stock: 11, reserve: 3, in_transit: 12, free_now: 8, confirmed_incoming_qty: 12, confirmed_eta: next, purchase_order_id: id(20) },
    { product_id: id(2), name: 'Матовая полиуретановая плёнка', code: 'QA-002', price_minor: 23000, uom: 'Лист', category: 'Плёнки', image_url: null, stock: 0, reserve: 0, in_transit: 0, free_now: 0, confirmed_incoming_qty: 0, confirmed_eta: null, purchase_order_id: null },
    { product_id: id(3), name: 'Текстура для корпуса', code: 'QA-003', price_minor: null, uom: 'Лист', category: 'Текстуры', image_url: null, stock: null, reserve: null, in_transit: null, free_now: null, confirmed_incoming_qty: 0, confirmed_eta: null, purchase_order_id: null },
    { product_id: id(4), name: 'Защитное стекло', code: 'QA-004', price_minor: 10000, uom: 'шт', category: 'Стёкла', image_url: null, stock: 10, reserve: 0, in_transit: 0, free_now: 10, confirmed_incoming_qty: 0, confirmed_eta: null, purchase_order_id: null },
  ],
};
const line: ProcurementLine = { ...catalog.items[0], quantity: 20, requested_now: 8, requested_later: 12, now_qty: 8, later_qty: 12, refused_qty: 0, now_price_minor: 25000, later_price_minor: 27000, eta: next, refusal_reason: '', purchased_qty: 0, reserved_qty: 0, shipped_qty: 0, received_qty: 0 };
const requests: ProcurementRequest[] = [{ id: id(10), number: 42, partner_id: 'qa-partner', partner_name: 'Вымышленный партнёр с длинным названием города', status: 'offered', version: 2, shipment_mode: 'partial', currency: 'RUB', note: 'Нужны 20 листов, можно отправить частями.', offer_note: '8 листов проверены на складе. 12 подтверждены поставщиком. Доставка оплачивается отдельно по согласованному тарифу.', created_at: at, updated_at: at, offered_at: at, accepted_at: null, valid_until: new Date(Date.now() + 3 * 86400000).toISOString(), counterparty_id: id(30), counterparties: [{ id: id(30), name: 'Проверенный тестовый контрагент' }], snapshot_at: at, items: [line], history: [{ at, actor_name: 'Вымышленный партнёр', action: 'submit', note: 'Отправка частями', data: {}, version: 1 }, { at, actor_name: 'Вымышленный менеджер', action: 'offer', note: 'Цена и срок подтверждены поставщиком', data: {}, version: 2 }] }];
const operations = new Map<string, ProcurementRequest>();
export function procurementFixture(name: string | undefined, body: Record<string, unknown>, params: URLSearchParams): Response | null {
  if (!name?.startsWith('procurement_')) return null;
  if (params.get('procurement') === 'error') return Response.json({ message: 'external-unavailable', details: 'Тестовый сбой соединения' }, { status: 503 });
  if (name === 'procurement_catalog') {
    const state = params.get('procurement');
    const manager = params.get('role') !== 'franchisee';
    const shop = { ...catalog.shop!, enabled: !manager && !['workererror','disabled','stale','pricestale'].includes(state ?? ''), reason: manager ? 'manager' : state === 'workererror' ? 'worker-unavailable' : state === 'disabled' ? 'disabled' : null, worker_status: state === 'workererror' ? 'error' : 'ok', price_fetched_at: state === 'pricestale' ? new Date(Date.now() - 3600000).toISOString() : at };
    return Response.json({ ...catalog, items: state === 'empty' ? [] : catalog.items.map(p => ({ ...p, price_minor: manager || state === 'disabled' ? null : p.price_minor })), fetched_at: state === 'empty' ? null : at, stale: state === 'stale', incoming: [], shop });
  }
  if (name === 'procurement_list') {
    const state = params.get('procurement');
    if (['queued','processing','retry','reconciling','created','blocked'].includes(state ?? '')) {
      const r = requests[0]; r.status = 'accepted'; r.source = 'checkout';
      r.integration = { status: state as NonNullable<ProcurementRequest['integration']>['status'], order_id: state === 'created' ? id(70) : null, updated_at: at, error_code: state === 'blocked' ? 'price-changed' : null };
    }
    return Response.json({ is_manager: params.get('role') !== 'franchisee', partner_id: 'qa-partner', requests: params.get('procurement') === 'empty' ? [] : requests, total: requests.length, demand: requests.some(r => r.status === 'accepted') ? [{ product_id: id(1), name: line.name, uom: 'Лист', quantity: 12, request_count: 1 }] : [] });
  }
  const operation = String(body.p_operation ?? '');
  if (operations.has(operation)) return Response.json(operations.get(operation));
  if (name === 'procurement_submit' || name === 'procurement_checkout') {
    const items = (body.p_items as { product_id: string; quantity: number }[]).map(i => { const p = catalog.items.find(p => p.product_id === i.product_id)!; return { ...p, quantity: i.quantity, requested_now: Math.min(i.quantity, p.free_now ?? 0), requested_later: Math.max(0, i.quantity - (p.free_now ?? 0)), now_qty: 0, later_qty: 0, refused_qty: 0, now_price_minor: null, later_price_minor: null, eta: null, refusal_reason: '', purchased_qty: 0, reserved_qty: 0, shipped_qty: 0, received_qty: 0 }; });
    const r: ProcurementRequest = { ...requests[0], id: id(100 + requests.length), number: 43 + requests.length, version: 1, items, status: 'submitted', currency: null, offered_at: null, accepted_at: null, valid_until: null, note: String(body.p_note), offer_note: '', shipment_mode: body.p_shipment_mode === 'together' ? 'together' : 'partial', history: [] };
    if (name === 'procurement_checkout') {
      r.source = 'checkout'; r.status = 'accepted'; r.currency = 'RUB'; r.accepted_at = at;
      r.integration = { status: 'queued', order_id: null, updated_at: at, error_code: null };
      r.items = r.items.map(i => ({...i, now_qty: i.quantity, now_price_minor: (body.p_items as { product_id: string; price_minor: number }[]).find(x => x.product_id === i.product_id)!.price_minor}));
      r.history = [{ at, actor_name: 'Вымышленный партнёр', action: 'checkout', note: 'Состав и цена подтверждены; резерв ожидает проверки', data: {}, version: 1 }];
    }
    requests.unshift(r); operations.set(operation, r); return Response.json(r);
  }
  if (name === 'procurement_action') {
    const r = requests.find(r => r.id === body.p_id)!;
    if (r.version !== body.p_expected_version) return Response.json({ message: 'version-conflict' }, { status: 409 });
    const action = String(body.p_action); const data = body.p_data as Record<string, unknown>;
    if (action === 'accept') { r.status = 'accepted'; r.accepted_at = at; }
    if (action === 'decline') r.status = 'declined';
    if (action === 'cancel') r.status = 'cancelled';
    if (action === 'offer') { Object.assign(r, { status: 'offered', currency: data.currency, valid_until: data.valid_until, offer_note: data.note, shipment_mode: data.shipment_mode, counterparty_id: data.counterparty_id, offered_at: at }); r.items = r.items.map(i => ({ ...i, ...(data.items as ProcurementLine[]).find(x => x.product_id === i.product_id) })); }
    if (['purchase', 'reserve', 'ship', 'receive'].includes(action)) for (const i of (data.items as { product_id: string; quantity: number }[])) { const l = r.items.find(x => x.product_id === i.product_id)!; const field = ({ purchase: 'purchased_qty', reserve: 'reserved_qty', ship: 'shipped_qty', receive: 'received_qty' } as const)[action as 'purchase' | 'reserve' | 'ship' | 'receive']; l[field] += i.quantity; }
    r.version += 1; r.history.push({ at: new Date().toISOString(), actor_name: 'Тест интерфейса', action, note: String(data.note ?? ''), data, version: r.version }); operations.set(operation, r); return Response.json(r);
  }
  if (name === 'procurement_incoming_set') return Response.json({ ok: true });
  return Response.json({ message: 'not-found' }, { status: 404 });
}
