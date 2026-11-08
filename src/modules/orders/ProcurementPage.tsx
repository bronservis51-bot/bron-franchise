import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Clock, Package, RefreshCw, Search, ShoppingCart, Trash2 } from 'lucide-react';
import { toAppError } from '../../platform/backend';
import { formatMoney, minorToDecimal, parseMoney } from '../../platform/money';
import { useSession } from '../../platform/session';
import { ActionError, Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tabs, Textarea, type Tone } from '../../ui';
import { useToast } from '../../ui/toast';
import { OrderFallback } from './OrderLink';
import { procurementAction, procurementCatalog, procurementIncomingSet, procurementList, procurementSubmit } from './api';
import { emptyCart, quantityNumber, readCart, saveCart, type CartDraft } from './draft';
import type { ProcurementAction, ProcurementCatalog, ProcurementDemand, ProcurementIncoming, ProcurementLine, ProcurementOffer, ProcurementProduct, ProcurementRequest, ProcurementStatus, ShipmentMode } from './types';
import './orders.css';

const STATUS: Record<ProcurementStatus, [string, Tone]> = {
  submitted: ['На проверке', 'neutral'], offered: ['Нужно согласовать', 'warning'], accepted: ['Согласовано', 'info'],
  declined: ['Отказ', 'neutral'], cancelled: ['Отменена', 'neutral'], completed: ['Получено', 'success'],
};
const ACTION: Record<string, string> = { submit: 'Запрос отправлен', submitted: 'Запрос отправлен', offer: 'Предложены условия', accept: 'Условия приняты', decline: 'Условия отклонены', cancel: 'Запрос отменён', purchase: 'Закупка подтверждена', reserve: 'Резерв подтверждён', ship: 'Передано в доставку', receive: 'Получение подтверждено' };
const date = (s: string | null, time = false) => s ? new Date(s).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) }) : 'Не подтверждён';
const qty = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
const fulfillment = (r: ProcurementRequest) => {
  if (r.status !== 'accepted') return STATUS[r.status][0];
  if (r.items.some(i => i.shipped_qty > i.received_qty)) return 'В доставке';
  if (r.items.some(i => i.reserved_qty > i.shipped_qty)) return 'В резерве';
  if (r.items.some(i => i.purchased_qty > 0)) return 'Ожидаем поступление';
  return 'Согласовано';
};

export function Availability({ product, stale }: { product: ProcurementProduct; stale: boolean }) {
  return <div className="procurement-availability">
    {!stale && product.free_now !== null ? <span className={product.free_now > 0 ? 'now' : ''}><Package size={15} aria-hidden />Свободно: {qty(product.free_now)} {product.uom}</span> : <span className="unknown"><Clock size={15} aria-hidden />Наличие нужно проверить</span>}
    {product.confirmed_incoming_qty > 0 && product.confirmed_eta ? <span className="later"><Clock size={15} aria-hidden />Ожидается всего: {qty(product.confirmed_incoming_qty)} {product.uom} к {date(product.confirmed_eta)}</span> : <span><Clock size={15} aria-hidden />Подтверждённого поступления нет</span>}
    {product.confirmed_updated_at && product.confirmed_incoming_qty > 0 && <span className="procurement-muted">Поставка подтверждена {date(product.confirmed_updated_at, true)}</span>}
  </div>;
}

export function CatalogView({ catalog, onAdd, cartIds, manager = false, locked = false }: { catalog: ProcurementCatalog; onAdd: (p: ProcurementProduct) => void; cartIds: Set<string>; manager?: boolean; locked?: boolean }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [availability, setAvailability] = useState('all');
  const [limit, setLimit] = useState(48);
  const categories = useMemo(() => [...new Set(catalog.items.map(i => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru')), [catalog]);
  const filtered = useMemo(() => catalog.items.filter(p => (!category || p.category === category) && (!search || `${p.name} ${p.code}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru'))) && (availability === 'all' || (availability === 'now' && !catalog.stale && (p.free_now ?? 0) > 0) || (availability === 'incoming' && p.confirmed_incoming_qty > 0 && p.confirmed_eta) || (availability === 'request' && (catalog.stale || !(p.free_now && p.free_now > 0))))), [catalog, category, search, availability]);
  useEffect(() => setLimit(48), [search, category, availability]);
  if (!catalog.items.length) return <EmptyState title="Каталог ещё не подключён" text="Заказ из наличия доступен по вашей персональной ссылке ниже. После подключения МойСклад здесь появятся товары и время проверки остатков." />;
  return <>
    <div className={`procurement-note${catalog.stale ? ' warning' : ''}`} role="status">
      {catalog.stale ? 'Остатки устарели. Можно отправить запрос; наличие, цену и срок проверит менеджер.' : 'Свободное количество — по последней проверке склада. Резерв появится после подтверждения в МойСклад.'}
      <div className="procurement-muted">Проверено: {date(catalog.fetched_at, true)}. Цена — в предложении для вашей компании.</div>
    </div>
    <div className="procurement-tools">
      <Field label="Найти товар">{id => <div className="procurement-search"><Search size={18} aria-hidden /><Input id={id} type="search" value={search} placeholder="Название или код" onChange={e => setSearch(e.target.value)} /></div>}</Field>
      <Field label="Категория">{id => <Select id={id} value={category} onChange={e => setCategory(e.target.value)}><option value="">Все категории</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</Select>}</Field>
    </div>
    <div className="chips" role="group" aria-label="Наличие">
      {[['all', 'Все'], ['now', 'Есть на складе'], ['incoming', 'В поставке'], ['request', 'Под заказ']].map(([id, label]) => <button key={id} type="button" className="chip" aria-pressed={availability === id} onClick={() => setAvailability(id)}>{label}</button>)}
    </div>
    <div className="procurement-muted">Найдено товаров: {filtered.length}. «Под заказ» — запрос возможности поставки.</div>
    {!filtered.length ? <EmptyState title="Товары не найдены" text="Измените поиск или выбранные фильтры." /> : <div className="procurement-grid">
      {filtered.slice(0, limit).map(p => <article key={p.product_id} className="card procurement-product">
        {p.image_url && /^https:\/\//.test(p.image_url) ? <img className="product-image" src={p.image_url} loading="lazy" alt="" /> : <div className="product-icon"><Package size={24} aria-hidden /></div>}
        <div><div className="product-meta">{p.category}{p.code ? ` · ${p.code}` : ''}</div><h3>{p.name}</h3></div>
        <Availability product={p} stale={catalog.stale} />
        <footer><span className="faint">Единица: {p.uom}</span>{!manager && <Button size="sm" variant={cartIds.has(p.product_id) ? 'secondary' : 'primary'} disabled={locked || cartIds.has(p.product_id)} onClick={() => onAdd(p)}>{cartIds.has(p.product_id) ? <><Check size={15} aria-hidden />В корзине</> : 'Добавить'}</Button>}</footer>
      </article>)}
    </div>}
    {filtered.length > limit && <Button className="procurement-load-more" onClick={() => setLimit(n => n + 48)}>Показать ещё</Button>}
  </>;
}

function ShipmentChoice({ value, onChange, disabled }: { value: ShipmentMode; onChange: (v: ShipmentMode) => void; disabled?: boolean }) {
  return <fieldset className="procurement-shipping" disabled={disabled}><legend>Как отправлять</legend>
    <label><input type="radio" name="shipment" value="partial" checked={value === 'partial'} onChange={() => onChange('partial')} /><span>Можно частями<small>Сначала доступное, остальное после поступления.</small></span></label>
    <label><input type="radio" name="shipment" value="together" checked={value === 'together'} onChange={() => onChange('together')} /><span>Одной поставкой<small>Отправить, когда будет собран весь согласованный заказ.</small></span></label>
  </fieldset>;
}

function CartView({ draft, catalog, partnerName, onChange, onSubmit, busy, error, saved, onNew, onRequests }: { draft: CartDraft; catalog?: ProcurementCatalog; partnerName: string; onChange: (d: CartDraft) => void; onSubmit: () => void; busy: boolean; error: unknown; saved: boolean; onNew: () => void; onRequests: () => void }) {
  const locked = busy || draft.attempted;
  const valid = draft.items.length > 0 && draft.items.every(i => quantityNumber(i.quantity) !== null);
  if (!draft.items.length) return <EmptyState title="Корзина пуста" text="Добавьте материалы из каталога и укажите нужное количество." />;
  return <div className="procurement-cart" data-unsaved="true">
    <div className="procurement-lines">{draft.items.map(i => {
      const p = catalog?.items.find(p => p.product_id === i.product_id);
      const n = quantityNumber(i.quantity);
      const available = !catalog?.stale && p?.free_now !== null && p?.free_now !== undefined ? p.free_now : null;
      const now = n !== null && available !== null ? Math.min(n, available) : null;
      return <article key={i.product_id} className="card procurement-line">
        <div className="procurement-line-head"><div><h3>{p?.name ?? i.name}</h3><span className="faint">{p?.code ?? ''} · {i.uom}</span></div><button type="button" className="icon-btn" aria-label={`Удалить ${i.name}`} disabled={locked} onClick={() => onChange({ ...draft, items: draft.items.filter(x => x.product_id !== i.product_id) })}><Trash2 size={18} /></button></div>
        <label className="procurement-quantity">Нужно <Input aria-label={`Количество: ${i.name}`} inputMode="decimal" value={i.quantity} disabled={locked} onChange={e => onChange({ ...draft, items: draft.items.map(x => x.product_id === i.product_id ? { ...x, quantity: e.target.value } : x) })} aria-invalid={n === null} />{i.uom}</label>
        {n === null ? <p className="error">Введите количество больше нуля, до трёх знаков после запятой.</p> : now !== null ? <div className="procurement-muted">По снимку: <strong>{qty(now)} из наличия</strong>{n > now && <> + <strong>{qty(n - now)} под заказ</strong></>}. Менеджер подтвердит распределение.</div> : <div className="procurement-muted">Все {qty(n)} {i.uom} — запрос на проверку наличия и поставки.</div>}
        {!p && <p className="error">Товар не найден в текущем каталоге. Удалите его и выберите актуальную позицию.</p>}
      </article>;
    })}</div>
    <section className="card procurement-summary">
      <h2>Ваш запрос</h2><div className="procurement-muted">{partnerName}. Контакты будут взяты из профиля.</div>
      <ShipmentChoice value={draft.shipment_mode} disabled={locked} onChange={shipment_mode => onChange({ ...draft, shipment_mode })} />
      <Field label="Комментарий" hint="Например, нужная дата или адрес доставки. Необязательно.">{id => <Textarea id={id} maxLength={2000} rows={3} value={draft.note} disabled={locked} onChange={e => onChange({ ...draft, note: e.target.value })} />}</Field>
      <p className="procurement-muted">Отправка запроса ещё не резервирует товар и не подтверждает цену. Условия и стоимость доставки согласуем в этой заявке.</p>
      {!saved && <p className="error">Черновик не удалось сохранить на этом устройстве. Не закрывайте страницу до отправки.</p>}
      <ActionError error={error} />
      {draft.attempted && !busy && <div className="procurement-note warning">Ответ не подтверждён. Повторная отправка использует тот же номер операции и не создаёт второй запрос. <button type="button" className="link" onClick={onRequests}>Проверить мои заявки</button></div>}
      <Button variant="primary" loading={busy} disabled={!valid || !navigator.onLine || draft.items.some(i => !catalog?.items.some(p => p.product_id === i.product_id))} onClick={onSubmit}>{draft.attempted ? 'Повторить отправку' : 'Отправить запрос'}</Button>
      {draft.attempted && !busy && <Button variant="ghost" onClick={onNew}>Заявки проверены — начать заново</Button>}
    </section>
  </div>;
}

export function RequestList({ requests, manager, onOpen }: { requests: ProcurementRequest[]; manager: boolean; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState('active');
  const filtered = requests.filter(r => filter === 'all' || !['declined', 'cancelled', 'completed'].includes(r.status));
  return <><div className="procurement-actions"><Button size="sm" variant={filter === 'active' ? 'primary' : 'secondary'} onClick={() => setFilter('active')}>В работе</Button><Button size="sm" variant={filter === 'all' ? 'primary' : 'secondary'} onClick={() => setFilter('all')}>Все заявки</Button></div>
    {filtered.length ? <div className="procurement-request-list">{filtered.map(r => <button key={r.id} type="button" className="card procurement-request-card" onClick={() => onOpen(r.id)}>
      <span className="request-row"><span className="request-title">№ {r.number}{manager ? ` · ${r.partner_name}` : ''}</span><Badge tone={STATUS[r.status][1]}>{fulfillment(r)}</Badge></span>
      <span>{r.items.slice(0, 2).map(i => `${i.name} — ${qty(i.quantity)} ${i.uom}`).join('; ')}{r.items.length > 2 ? `; ещё ${r.items.length - 2}` : ''}</span>
      <span className="procurement-muted">{date(r.created_at, true)} · {r.shipment_mode === 'partial' ? 'Можно частями' : 'Одной поставкой'}</span>
    </button>)}</div> : <EmptyState title="Заявок пока нет" text={manager ? 'Здесь появятся запросы партнёров, требующие проверки и согласования.' : 'После отправки запроса здесь можно согласовать предложение и следить за поставкой.'} />}
  </>;
}

function offerTotal(r: ProcurementRequest) {
  return r.items.reduce((sum, i) => sum + (BigInt(i.now_price_minor ?? 0) * BigInt(Math.round(i.now_qty * 1000)) + 500n) / 1000n + (BigInt(i.later_price_minor ?? 0) * BigInt(Math.round(i.later_qty * 1000)) + 500n) / 1000n, 0n);
}

function LineSummary({ line: i, currency, offered }: { line: ProcurementLine; currency: string | null; offered: boolean }) {
  return <article className="procurement-line"><div className="procurement-line-head"><div><h3>{i.name}</h3><div className="procurement-muted">Запрошено: {qty(i.quantity)} {i.uom}{i.code ? ` · ${i.code}` : ''}</div></div></div>
    {offered ? <>
      <div className="procurement-facts">
        <div className="procurement-fact"><strong>{qty(i.now_qty)} {i.uom}</strong><span>Из наличия</span>{i.now_qty > 0 && currency && i.now_price_minor !== null && <div>{formatMoney(i.now_price_minor, currency)} / {i.uom}</div>}</div>
        <div className="procurement-fact"><strong>{qty(i.later_qty)} {i.uom}</strong><span>Под заказ · {date(i.eta)}</span>{i.later_qty > 0 && currency && i.later_price_minor !== null && <div>{formatMoney(i.later_price_minor, currency)} / {i.uom}</div>}</div>
        <div className="procurement-fact"><strong>{qty(i.refused_qty)} {i.uom}</strong><span>Отказ</span>{i.refusal_reason && <div>{i.refusal_reason}</div>}</div>
      </div>
      <div className="procurement-muted" style={{ marginTop: 12 }}>Закуплено: {qty(i.purchased_qty)} · Зарезервировано: {qty(i.reserved_qty)} · Отправлено: {qty(i.shipped_qty)} · Получено: {qty(i.received_qty)} {i.uom}</div>
    </> : <div className="procurement-muted">{i.requested_now !== null ? <>При отправке: {qty(i.requested_now)} из наличия + {qty(i.requested_later ?? 0)} под заказ.</> : 'Наличие и срок ещё не проверены.'} Цена ожидает подтверждения.</div>}
  </article>;
}

type OfferDraftLine = { product_id: string; now: string; later: string; refused: string; nowPrice: string; laterPrice: string; eta: string; reason: string };
function OfferForm({ request, counterparties, busy, onOffer }: { request: ProcurementRequest; counterparties: { id: string; name: string }[]; busy: boolean; onOffer: (offer: ProcurementOffer) => Promise<void> }) {
  const [currency, setCurrency] = useState(request.currency ?? 'RUB');
  const [shipment, setShipment] = useState(request.shipment_mode);
  const [validUntil, setValidUntil] = useState('');
  const [counterparty, setCounterparty] = useState(request.counterparty_id ?? (counterparties.length === 1 ? counterparties[0].id : ''));
  const [note, setNote] = useState(request.offer_note ?? '');
  const [lines, setLines] = useState<OfferDraftLine[]>(request.items.map(i => ({ product_id: i.product_id, now: String(request.status === 'offered' ? i.now_qty : i.requested_now ?? 0), later: String(request.status === 'offered' ? i.later_qty : i.quantity - (i.requested_now ?? 0)), refused: String(i.refused_qty), nowPrice: i.now_price_minor === null ? '' : minorToDecimal(i.now_price_minor, currency), laterPrice: i.later_price_minor === null ? '' : minorToDecimal(i.later_price_minor, currency), eta: i.eta?.slice(0, 10) ?? '', reason: i.refusal_reason }))); 
  const [validation, setValidation] = useState('');
  const change = (id: string, field: keyof OfferDraftLine, value: string) => setLines(xs => xs.map(x => x.product_id === id ? { ...x, [field]: value } : x));
  const submit = async () => {
    setValidation('');
    const items = lines.map(l => ({ product_id: l.product_id, now_qty: Number(l.now.replace(',', '.')), later_qty: Number(l.later.replace(',', '.')), refused_qty: Number(l.refused.replace(',', '.')), now_price_minor: parseMoney(l.nowPrice, currency), later_price_minor: parseMoney(l.laterPrice, currency), eta: l.eta || null, refusal_reason: l.reason }));
    if (!note.trim() || !counterparty || !validUntil || !Number.isFinite(new Date(validUntil).getTime()) || new Date(validUntil).getTime() <= Date.now()) { setValidation('Выберите проверенного контрагента, дату окончания предложения и укажите основание условий.'); return; }
    if (items.some((l, index) => [l.now_qty, l.later_qty, l.refused_qty].some(n => !Number.isFinite(n) || n < 0) || Math.abs(l.now_qty + l.later_qty + l.refused_qty - request.items[index].quantity) > 0.000001 || (l.now_qty > 0 && l.now_price_minor === null) || (l.later_qty > 0 && (l.later_price_minor === null || !l.eta)) || (l.refused_qty > 0 && !l.refusal_reason.trim()))) { setValidation('Распределите всё количество между наличием, поставкой и отказом. Укажите цену, срок поставки и причину отказа там, где они нужны.'); return; }
    if (items.some(l => (l.now_price_minor !== null && l.now_price_minor > BigInt(Number.MAX_SAFE_INTEGER)) || (l.later_price_minor !== null && l.later_price_minor > BigInt(Number.MAX_SAFE_INTEGER)))) { setValidation('Сумма слишком велика.'); return; }
    await onOffer({ items: items.map(l => ({ ...l, now_price_minor: l.now_price_minor === null ? null : Number(l.now_price_minor), later_price_minor: l.later_price_minor === null ? null : Number(l.later_price_minor) })), currency, shipment_mode: shipment, valid_until: new Date(validUntil).toISOString(), note, counterparty_id: counterparty });
  };
  return <form className="card procurement-offer-form" data-unsaved="true" onSubmit={e => { e.preventDefault(); void submit(); }}>
    <h2>Предложить условия</h2><p className="procurement-muted">Проверьте индивидуальные цены, остаток и срок с поставщиком. Партнёр должен принять эти условия. Резерв в МойСклад оформляется отдельно.</p>
    <div className="procurement-form-grid">
      <Field label="Контрагент МойСклад" required>{id => <Select id={id} required value={counterparty} disabled={busy} onChange={e => setCounterparty(e.target.value)}><option value="">Выберите контрагента</option>{counterparties.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
      <Field label="Валюта" required>{id => <Select id={id} value={currency} disabled={busy} onChange={e => setCurrency(e.target.value)}>{['RUB', 'KZT', 'TRY'].map(c => <option key={c}>{c}</option>)}</Select>}</Field>
      <Field label="Предложение действует до" required>{id => <Input id={id} type="datetime-local" required value={validUntil} disabled={busy} onChange={e => setValidUntil(e.target.value)} />}</Field>
    </div>
    {!counterparties.length && <p className="error">У партнёра нет проверенной привязки к контрагенту МойСклад. Сначала проверьте и добавьте её в разделе «Экономика».</p>}
    {lines.map((l, index) => <fieldset className="procurement-line" key={l.product_id} disabled={busy}><legend>{request.items[index].name} · {qty(request.items[index].quantity)} {request.items[index].uom}</legend><div className="procurement-form-grid">
      <Field label="Из наличия">{id => <Input id={id} inputMode="decimal" value={l.now} onChange={e => change(l.product_id, 'now', e.target.value)} />}</Field>
      <Field label={`Цена из наличия, ${currency} за ${request.items[index].uom}`}>{id => <Input id={id} inputMode="decimal" value={l.nowPrice} onChange={e => change(l.product_id, 'nowPrice', e.target.value)} />}</Field>
      <Field label="Под заказ">{id => <Input id={id} inputMode="decimal" value={l.later} onChange={e => change(l.product_id, 'later', e.target.value)} />}</Field>
      <Field label={`Цена под заказ, ${currency} за ${request.items[index].uom}`}>{id => <Input id={id} inputMode="decimal" value={l.laterPrice} onChange={e => change(l.product_id, 'laterPrice', e.target.value)} />}</Field>
      <Field label="Ожидаемая дата поступления">{id => <Input id={id} type="date" value={l.eta} onChange={e => change(l.product_id, 'eta', e.target.value)} />}</Field>
      <Field label="Отказать в количестве">{id => <Input id={id} inputMode="decimal" value={l.refused} onChange={e => change(l.product_id, 'refused', e.target.value)} />}</Field>
      <div className="wide"><Field label="Причина отказа">{id => <Input id={id} maxLength={1000} value={l.reason} onChange={e => change(l.product_id, 'reason', e.target.value)} />}</Field></div>
    </div></fieldset>)}
    <ShipmentChoice value={shipment} disabled={busy} onChange={setShipment} />
    <Field label="Основание условий и доставка" required hint="Укажите источник подтверждения цены, наличия и срока, а также стоимость/порядок оплаты доставки.">{id => <Textarea id={id} rows={3} maxLength={2000} value={note} disabled={busy} onChange={e => setNote(e.target.value)} />}</Field>
    {validation && <p className="error" role="alert">{validation}</p>}
    <Button type="submit" variant="primary" loading={busy} disabled={!counterparties.length}>Отправить условия партнёру</Button>
  </form>;
}

function ProgressForm({ request, manager, busy, onProgress }: { request: ProcurementRequest; manager: boolean; busy: boolean; onProgress: (action: ProcurementAction, data: unknown) => Promise<void> }) {
  const [action, setAction] = useState<ProcurementAction>(manager ? 'purchase' : 'receive');
  const [documentId, setDocumentId] = useState('');
  const [note, setNote] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const remaining = (i: ProcurementLine) => action === 'purchase' ? i.later_qty - i.purchased_qty : action === 'reserve' ? i.now_qty + i.purchased_qty - i.reserved_qty : action === 'ship' ? i.reserved_qty - i.shipped_qty : i.shipped_qty - i.received_qty;
  const available = request.items.filter(i => remaining(i) > 0);
  return <form className="procurement-progress" data-unsaved={documentId || note || Object.values(amounts).some(Boolean) ? 'true' : undefined} onSubmit={e => {
    e.preventDefault(); setError('');
    const items = available.filter(i => amounts[i.product_id]?.trim()).map(i => ({ product_id: i.product_id, quantity: quantityNumber(amounts[i.product_id]) }));
    if (!items.length || items.some(i => i.quantity === null) || (action !== 'receive' && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(documentId.trim())) || !note.trim()) { setError('Укажите количество, комментарий и UUID документа МойСклад для закупки, резерва или отгрузки.'); return; }
    void onProgress(action, { items, document_id: documentId.trim() || undefined, note });
  }}>
    <h3>{manager ? 'Подтвердить этап' : 'Подтвердить получение'}</h3>
    {manager && <><p className="procurement-muted">Сначала выполните действие в МойСклад и проверьте контрагента, товары и количество. Здесь фиксируется ваша проверка; документы автоматически не создаются.</p>
      <Field label="Этап">{id => <Select id={id} value={action} disabled={busy} onChange={e => { setAction(e.target.value as ProcurementAction); setAmounts({}); }}><option value="purchase">Заказ поставщику подтверждён</option><option value="reserve">Товар зарезервирован в МойСклад</option><option value="ship">Отгрузка оформлена в МойСклад</option></Select>}</Field></>}
    {available.map(i => <Field key={i.product_id} label={`${i.name} · осталось ${qty(remaining(i))} ${i.uom}`} hint="Количество этой операции, не итог за всё время.">{id => <Input id={id} inputMode="decimal" value={amounts[i.product_id] ?? ''} disabled={busy} onChange={e => setAmounts({ ...amounts, [i.product_id]: e.target.value })} />}</Field>)}
    {!available.length && <p className="procurement-muted">Для этого этапа нет необработанного количества.</p>}
    {action !== 'receive' && <Field label="UUID документа МойСклад" hint="Из адреса документа: значение после id=.">{id => <Input id={id} value={documentId} disabled={busy} onChange={e => setDocumentId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />}</Field>}
    <Field label="Комментарий к подтверждению" required>{id => <Textarea id={id} value={note} rows={2} maxLength={2000} disabled={busy} onChange={e => setNote(e.target.value)} />}</Field>
    {error && <p className="error" role="alert">{error}</p>}
    <Button type="submit" loading={busy} disabled={!available.length}>Сохранить подтверждение</Button>
  </form>;
}

export function RequestDetail({ request, manager, counterparties, busy, error, onAction, onBack, onRefresh }: { request: ProcurementRequest; manager: boolean; counterparties: { id: string; name: string }[]; busy: boolean; error: unknown; onAction: (action: ProcurementAction, data: unknown) => Promise<void>; onBack: () => void; onRefresh: () => void }) {
  const [reason, setReason] = useState('');
  const [offerOpen, setOfferOpen] = useState(false);
  const offered = request.status !== 'submitted' && !!request.offered_at;
  const expired = request.valid_until !== null && new Date(request.valid_until).getTime() <= Date.now();
  return <div className="procurement-detail" data-unsaved={reason ? 'true' : undefined}>
    <div><Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft size={16} aria-hidden />К заявкам</Button></div>
    <div className="procurement-detail-head"><div><h2>Заявка № {request.number}</h2><div className="procurement-muted">{manager ? request.partner_name + ' · ' : ''}{date(request.created_at, true)} · версия {request.version}</div></div><Badge tone={STATUS[request.status][1]}>{fulfillment(request)}</Badge></div>
    <div className="procurement-note"><strong>{request.shipment_mode === 'partial' ? 'Отправка частями' : 'Отправка одной поставкой'}</strong>{request.note && <p>Комментарий партнёра: {request.note}</p>}{request.offer_note && <p>Условия менеджера: {request.offer_note}</p>}</div>
    <div className="procurement-lines">{request.items.map(i => <LineSummary key={i.product_id} line={i} currency={request.currency} offered={offered} />)}</div>
    {offered && request.currency && <div className="procurement-note"><strong>Товары: {formatMoney(offerTotal(request), request.currency)}</strong><div>Доставка — по условиям менеджера выше.</div>{request.status === 'offered' && <div>Предложение действует до {date(request.valid_until, true)}{expired ? ' — срок истёк, запросите новые условия' : ''}.</div>}</div>}
    {request.status === 'offered' && !manager && <section className="card procurement-summary" data-unsaved="true"><h3>Согласование</h3><p className="procurement-muted">Проверьте количества, индивидуальные цены, дату и доставку. Принятие фиксирует эту версию условий. Резерв подтверждается отдельным этапом.</p><Field label="Комментарий / причина отказа">{id => <Textarea id={id} value={reason} maxLength={2000} rows={2} disabled={busy} onChange={e => setReason(e.target.value)} />}</Field><div className="procurement-actions"><Button variant="primary" loading={busy} disabled={expired || request.items.every(i => i.now_qty + i.later_qty === 0)} onClick={() => void onAction('accept', { note: reason })}>Принять условия</Button><Button disabled={busy || !reason.trim()} onClick={() => void onAction('decline', { note: reason })}>Отказаться</Button></div></section>}
    {manager && ['submitted', 'offered'].includes(request.status) && <><Button onClick={() => setOfferOpen(v => !v)} disabled={busy}>{offerOpen ? 'Скрыть редактор' : request.status === 'offered' ? 'Изменить предложение' : 'Подготовить предложение'}</Button>{offerOpen && <OfferForm key={request.version} request={request} counterparties={counterparties} busy={busy} onOffer={async o => { await onAction('offer', o); }} />}</>}
    {request.status === 'accepted' && <ProgressForm key={request.version} request={request} manager={manager} busy={busy} onProgress={onAction} />}
    {['submitted', 'offered'].includes(request.status) && <details><summary>Отменить запрос</summary><Field label="Причина отмены">{id => <Input id={id} maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} />}</Field><Button variant="danger" disabled={busy || !reason.trim()} onClick={() => void onAction('cancel', { note: reason })}>Отменить запрос</Button></details>}
    <ActionError error={error} />{!!error && <div><Button onClick={onRefresh}>Обновить состояние заявки</Button></div>}
    <section><h3 style={{ marginBottom: 14 }}>История</h3><ol className="procurement-timeline">{request.history.map((event, i) => <li key={`${event.version}:${i}`}><strong>{ACTION[event.action] ?? event.action}</strong><time>{date(event.at, true)} · {event.actor_name}</time>{event.note && <p>{event.note}</p>}{typeof event.data.document_id === 'string' && <p className="procurement-muted">Документ МойСклад: {event.data.document_id}</p>}</li>)}</ol></section>
  </div>;
}

export function DemandView({ demand }: { demand: ProcurementDemand[] }) {
  return <><p className="procurement-muted">Принятые партнёрами количества под заказ, для которых ещё не подтверждён заказ поставщику. Отказы и отмены сюда не входят.</p>{demand.length ? <div className="procurement-lines">{demand.map(d => <article key={d.product_id} className="card procurement-line"><h3>{d.name}</h3><div><strong>{qty(d.quantity)} {d.uom}</strong> · заявок: {d.request_count}</div></article>)}</div> : <EmptyState title="Новой потребности в закупке нет" text="Она появится после согласования партнёрами товаров под заказ." />}</>;
}

function IncomingManager({ catalog, user, onSaved }: { catalog: ProcurementCatalog; user: string; onSaved: () => Promise<void> }) {
  const [product, setProduct] = useState('');
  const [po, setPo] = useState('');
  const [quantity, setQuantity] = useState('');
  const [eta, setEta] = useState('');
  const [note, setNote] = useState('');
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();
  const edit = (i: ProcurementIncoming) => { setProduct(i.product_id); setPo(i.purchase_order_id); setQuantity(String(i.quantity)); setEta(i.eta); setNote(i.note); setVersion(i.version); setError(null); };
  const reset = () => { setProduct(''); setPo(''); setQuantity(''); setEta(''); setNote(''); setVersion(0); setError(null); };
  return <details className="card procurement-summary"><summary>Подтверждённые поставки</summary>
    <p className="procurement-muted">Указывайте только проверенные заказы поставщикам. Ожидание не прибавляется к свободному остатку. После приёмки или отмены обновите оставшееся количество, вплоть до нуля.</p>
    {catalog.incoming?.length > 0 && <div className="procurement-lines">{catalog.incoming.map(i => <div className="procurement-line" key={`${i.product_id}:${i.purchase_order_id}`}><strong>{catalog.items.find(p => p.product_id === i.product_id)?.name ?? i.product_id}</strong><p>{qty(i.quantity)} · {date(i.eta)} · подтверждено {date(i.updated_at, true)}</p><Button size="sm" onClick={() => edit(i)}>Изменить</Button></div>)}</div>}
    <form className="procurement-offer-form" data-unsaved={product || po || note ? 'true' : undefined} onSubmit={e => {
      e.preventDefault(); setError(null);
      const n = quantity.trim() === '0' ? 0 : quantityNumber(quantity);
      if (!product || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(po) || n === null || !eta || !note.trim()) { setError(new Error('Укажите товар, UUID заказа поставщику, количество, дату и основание подтверждения.')); return; }
      setBusy(true);
      void procurementIncomingSet(user, { product_id: product, purchase_order_id: po, quantity: n, eta, note, expected_version: version }).then(async () => { reset(); toast('Подтверждение поставки сохранено'); await onSaved(); }).catch(setError).finally(() => setBusy(false));
    }}>
      <h3>{version ? 'Изменить поставку' : 'Подтвердить поставку'}</h3>
      <Field label="Товар">{id => <Select id={id} value={product} disabled={busy || version > 0} onChange={e => setProduct(e.target.value)}><option value="">Выберите товар</option>{catalog.items.map(p => <option key={p.product_id} value={p.product_id}>{p.name} · {p.code}</option>)}</Select>}</Field>
      <Field label="UUID заказа поставщику в МойСклад">{id => <Input id={id} value={po} disabled={busy || version > 0} onChange={e => setPo(e.target.value.trim())} />}</Field>
      <div className="procurement-form-grid"><Field label="Осталось получить" hint="0 — закрыть ожидание по этой поставке.">{id => <Input id={id} inputMode="decimal" value={quantity} disabled={busy} onChange={e => setQuantity(e.target.value)} />}</Field><Field label="Подтверждённая дата">{id => <Input id={id} type="date" value={eta} disabled={busy} onChange={e => setEta(e.target.value)} />}</Field></div>
      <Field label="Основание подтверждения" hint="Кто и когда подтвердил поставку; комментарий к изменению.">{id => <Textarea id={id} value={note} rows={2} maxLength={2000} disabled={busy} onChange={e => setNote(e.target.value)} />}</Field>
      <ActionError error={error} /><div className="procurement-actions"><Button type="submit" variant="primary" loading={busy}>Сохранить</Button><Button disabled={busy} onClick={reset}>Сбросить форму</Button></div>
    </form>
  </details>;
}

export function ProcurementPage() {
  const { me } = useSession();
  return <ProcurementWorkspace key={me?.user.id ?? ''} />;
}

function ProcurementWorkspace() {
  const { isManager, me } = useSession();
  const user = me?.user.id ?? '';
  const [tab, setTab] = useState<'catalog' | 'cart' | 'requests' | 'demand'>(isManager ? 'requests' : 'catalog');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<CartDraft>(() => readCart(user));
  const [saved, setSaved] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [clock, setClock] = useState(Date.now());
  const qc = useQueryClient(); const toast = useToast();
  const catalog = useQuery({ queryKey: ['procurement', 'catalog'], queryFn: procurementCatalog, staleTime: 30_000, refetchInterval: 60_000 });
  const list = useQuery({ queryKey: ['procurement', 'list'], queryFn: procurementList, staleTime: 15_000, refetchInterval: 30_000 });
  useEffect(() => { setSaved(saveCart(user, draft)); }, [draft, user]);
  useEffect(() => { const id = window.setInterval(() => setClock(Date.now()), 30_000); return () => window.clearInterval(id); }, []);
  useEffect(() => {
    if (!draft.items.length) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [draft.items.length]);
  const catalogBlocked = catalog.error && ['forbidden', 'unauthenticated'].includes(toAppError(catalog.error).code);
  const currentCatalog = catalog.data && !catalogBlocked ? { ...catalog.data, stale: catalog.data.stale || !catalog.data.fetched_at || clock - new Date(catalog.data.fetched_at).getTime() > 5 * 60_000 || !!catalog.error || !navigator.onLine } : undefined;
  const request = list.data?.requests.find(r => r.id === selected);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['procurement'] }); };
  const action = async (a: ProcurementAction, data: unknown) => {
    if (!request) return;
    setBusy(true); setError(null);
    try { const updated = await procurementAction(user, request.id, request.version, a, data); qc.setQueryData(['procurement', 'list'], (old: typeof list.data) => old ? { ...old, requests: old.requests.map(r => r.id === updated.id ? updated : r) } : old); toast('Изменение сохранено'); await refresh(); }
    catch (e) { setError(e); throw e; }
    finally { setBusy(false); }
  };
  const safeAction = async (a: ProcurementAction, data: unknown) => { try { await action(a, data); } catch { /* Error is rendered and the same receipt is retained. */ } };
  const submit = async () => {
    setBusy(true); setError(null); const locked = { ...draft, attempted: true }; setDraft(locked); saveCart(user, locked);
    try {
      const sent = await procurementSubmit(draft.operation, draft.items.map(i => ({ product_id: i.product_id, quantity: quantityNumber(i.quantity)! })), draft.shipment_mode, draft.note);
      setDraft(emptyCart()); setSelected(sent.id); setTab('requests'); toast(`Запрос № ${sent.number} отправлен менеджеру`); await refresh();
    } catch (e) { setError(e); if (['validation', 'forbidden', 'unauthenticated', 'not-found'].includes(toAppError(e).code)) setDraft(d => ({ ...d, attempted: false })); }
    finally { setBusy(false); }
  };
  const needsAttention = list.data?.requests.filter(r => isManager ? r.status === 'submitted' : r.status === 'offered').length ?? 0;
  const tabs: { id: 'catalog' | 'cart' | 'requests' | 'demand'; label: string }[] = isManager ? [{ id: 'requests', label: `Заявки${needsAttention ? ` · ${needsAttention}` : ''}` }, { id: 'demand', label: 'К закупке' }, { id: 'catalog', label: 'Каталог' }] : [{ id: 'catalog', label: 'Каталог' }, { id: 'cart', label: `Корзина${draft.items.length ? ` · ${draft.items.length}` : ''}` }, { id: 'requests', label: `Мои заявки${needsAttention ? ` · ${needsAttention}` : ''}` }];
  const blocked = list.error && ['forbidden', 'unauthenticated'].includes(toAppError(list.error).code);
  return <div className="procurement" data-unsaved={draft.items.length ? 'true' : undefined}>
    <PageHeader title={isManager ? 'Закупки партнёров' : 'Заказать материалы'} actions={<Button size="sm" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} aria-hidden />Обновить</Button>} />
    <div className="procurement-top"><Tabs tabs={tabs} value={tab} onChange={v => { setTab(v); setSelected(null); setError(null); }} label="Закупки" /></div>
    {!navigator.onLine && <div className="procurement-note warning" role="status">Нет сети. Черновик остаётся на этом устройстве; отправка и подтверждение недоступны.</div>}
    {tab === 'catalog' && (currentCatalog ? <><CatalogView catalog={currentCatalog} cartIds={new Set(draft.items.map(i => i.product_id))} manager={isManager} locked={draft.attempted} onAdd={p => { setDraft(d => ({ ...d, items: [...d.items, { product_id: p.product_id, quantity: '1', name: p.name, uom: p.uom }] })); toast('Товар добавлен в корзину'); }} />{isManager && <IncomingManager catalog={currentCatalog} user={user} onSaved={refresh} />}{!isManager && draft.items.length > 0 && <Button variant="primary" onClick={() => setTab('cart')}><ShoppingCart size={17} aria-hidden />Открыть корзину · {draft.items.length}</Button>}</> : catalog.error ? <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} /> : <Skeleton lines={6} />)}
    {tab === 'cart' && <CartView draft={draft} catalog={currentCatalog} partnerName={me?.assignments.find(a => a.role === 'franchisee')?.scope_name ?? me?.user.full_name ?? ''} onChange={setDraft} onSubmit={() => void submit()} busy={busy} error={error} saved={saved} onRequests={() => { setTab('requests'); setSelected(null); void refresh(); }} onNew={() => { setDraft(emptyCart()); setError(null); setTab('catalog'); }} />}
    {(tab === 'requests' || tab === 'demand') && (blocked || (!list.data && list.error) ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data ? <Skeleton lines={5} /> : <>
      {list.error && <div className="procurement-note warning">Не удалось обновить заявки. Показано последнее состояние.</div>}{list.data.total > list.data.requests.length && <div className="procurement-note">Показаны последние {list.data.requests.length} из {list.data.total} заявок. Более ранняя история сохранена; для её просмотра обратитесь к менеджеру.</div>}
      {tab === 'demand' ? <DemandView demand={list.data.demand} /> : request ? <RequestDetail key={request.id} request={request} manager={isManager} counterparties={request.counterparties} busy={busy || !navigator.onLine} error={error} onAction={safeAction} onBack={() => { setSelected(null); setError(null); }} onRefresh={() => void refresh()} /> : <RequestList requests={list.data.requests} manager={isManager} onOpen={id => { setSelected(id); setError(null); }} />}
    </>)}
    {!isManager && <details className="procurement-fallback"><summary>Персональный магазин и каталог плёнок</summary><p className="procurement-muted" style={{ marginTop: 12 }}>Используйте отдельный магазин для самостоятельного заказа из наличия. Не оформляйте повторно уже отправленную здесь заявку.</p><OrderFallback /></details>}
  </div>;
}
