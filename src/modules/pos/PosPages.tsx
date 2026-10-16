// «Продажи» — CRM точки: записать продажу за 10 секунд, узнать клиента по телефону (история, гарантия),
// вернуть тех, кому пора менять плёнку. Выручка смены подставляется из записанных продаж.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, ChevronLeft, ChevronRight, CreditCard, MessageCircle, Phone, Plus, Repeat, Search, ShieldCheck, Undo2, UserRound } from 'lucide-react';
import { newOperationKey } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { addDays, formatDate, plural } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort, parseMoney } from '../../platform/money';
import { ActionError, Button, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, PageHeader, Select, Textarea } from '../../ui';
import { useToast } from '../../ui/toast';
import { useLocationsWith } from '../shared/lookups';
import { clientCard, clientSearch, comeback, PAYMENTS, phoneDigits, pos, posDay, SERVICES, serviceLabel, type Client, type PosDay, type PosSale, type Service } from './api';

const money = (v: number, c: string) => formatMoneyShort(v, c, intlLocale());
const time = (iso: string) => new Date(iso).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
const toMinor = (s: string, cur: string) => Number(parseMoney(s || '0', cur) ?? 0n);
const fromMinor = (v: number | undefined) => (v ? String(Math.round(v / 100)) : '');

function ContactButtons({ phone }: { phone: string }) {
  const d = phoneDigits(phone);
  return (
    <span className="pos-contacts">
      <a className="icon-btn" href={`tel:+${d}`} aria-label="Позвонить" onClick={(e) => e.stopPropagation()}><Phone size={16} /></a>
      <a className="icon-btn" href={`https://wa.me/${d}`} target="_blank" rel="noreferrer" aria-label="WhatsApp" onClick={(e) => e.stopPropagation()}><MessageCircle size={16} /></a>
    </span>
  );
}

/** Новая продажа: телефон → (узнали клиента) → что оклеили → цена → оплата → «Записать». */
export function NewSaleDialog({ open, onClose, day }: { open: boolean; onClose: () => void; day: PosDay }) {
  const { t } = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const cur = day.location.currency;
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Client | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [device, setDevice] = useState('');
  const [payment, setPayment] = useState('card');
  const [card, setCard] = useState('');
  const [key, setKey] = useState(newOperationKey);
  const reset = () => { setPhone(''); setName(''); setPicked(null); setServices([]); setPrices({}); setDevice(''); setPayment('card'); setCard(''); setKey(newOperationKey()); };
  const digits = phoneDigits(phone);
  const found = useQuery({ queryKey: ['pos', 'search', day.location.id, digits], enabled: open && digits.length >= 4 && !picked,
    queryFn: () => clientSearch(day.location.id, digits), staleTime: 30_000 });
  useEffect(() => { if (!open) reset(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (s: Service) => {
    setServices((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s]));
    setPrices((p) => (p[s] !== undefined ? p : { ...p, [s]: fromMinor(day.price_hints[s]) }));
  };
  const total = services.reduce((a, s) => a + toMinor(prices[s] ?? '', cur), 0);
  const save = useMutation({
    mutationFn: () => pos.sell({ location: day.location.id, phone: phone || null, name: name || null, payment, card: payment === 'mixed' ? toMinor(card, cur) : null, comment: null, key,
      lines: services.map((s) => ({ service: s, device: device || null, qty: 1, price_minor: toMinor(prices[s] ?? '', cur) })) }),
    onSuccess: (r) => {
      toast(`${t('Продажа записана')}: ${money(r.sale.total_minor, cur)}${r.sale.warranty_until ? ` · ${t('гарантия до')} ${formatDate(r.sale.warranty_until, intlLocale())}` : ''}${r.client && r.client.visits > 1 ? ` · ${t('постоянный клиент')} 🔁` : ''}`);
      void qc.invalidateQueries({ queryKey: ['pos'] }); void qc.invalidateQueries({ queryKey: ['today'] });
      onClose();
    },
  });
  const matches = (found.data ?? []).filter((c) => phoneDigits(c.phone).includes(digits)).slice(0, 3);
  return (
    <ConfirmDialog open={open} title="Новая продажа" confirmLabel={total ? `${t('Записать')} · ${money(total, cur)}` : 'Записать'} busy={save.isPending} error={save.error}
      disabled={!services.length || total <= 0 || services.some((s) => !toMinor(prices[s] ?? '', cur))} onClose={onClose} onConfirm={() => save.mutate()}>
      <div className="sale-form">
        <Field label="Телефон клиента" hint="Чтобы найти по гарантии и позвать снова">{(id) => (
          <Input id={id} type="tel" inputMode="tel" autoFocus value={phone} placeholder="+7…" onChange={(e) => { setPhone(e.target.value); setPicked(null); }} />
        )}</Field>
        {picked ? (
          <div className="client-chip on">
            <UserRound size={16} aria-hidden />
            <span><strong>{picked.name ?? t('Клиент')}</strong> · {t('визитов')}: {picked.visits}{picked.last_device ? ` · ${picked.last_device}` : ''}
              {picked.warranty_until && picked.warranty_until >= day.today ? <> · <span className="ok">{t('гарантия до')} {formatDate(picked.warranty_until, intlLocale())}</span></> : null}</span>
          </div>
        ) : matches.map((c) => (
          <button key={c.id} type="button" className="client-chip" onClick={() => { setPicked(c); setPhone(c.phone); setName(c.name ?? ''); if (c.last_device) setDevice(c.last_device); }}>
            <Repeat size={14} aria-hidden /> {c.name ?? c.phone} · {c.phone} · {t('визитов')}: {c.visits}
          </button>
        ))}
        {!picked && <Field label="Имя">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>}
        <div className="field">
          <span className="field-label">{t('Что оклеили')}</span>
          <div className="svc-grid">{SERVICES.map((s) => <button key={s.id} type="button" className="svc" aria-pressed={services.includes(s.id)} onClick={() => toggle(s.id)}>{t(s.label)}</button>)}</div>
        </div>
        {services.length > 0 && (
          <div className="price-list">
            {services.map((s) => (
              <label key={s} className="price-row"><span>{t(serviceLabel(s))}</span>
                <Input inputMode="decimal" aria-label={`${t('Цена')}: ${t(serviceLabel(s))}`} value={prices[s] ?? ''} onChange={(e) => setPrices({ ...prices, [s]: e.target.value })} />
                <span className="faint">{cur === 'RUB' ? '₽' : cur}</span></label>
            ))}
          </div>
        )}
        <Field label="Модель устройства">{(id) => <Input id={id} list="pos-devices" value={device} onChange={(e) => setDevice(e.target.value)} placeholder="iPhone 15 Pro" />}</Field>
        <datalist id="pos-devices">{day.devices.map((d) => <option key={d} value={d} />)}</datalist>
        <div className="field">
          <span className="field-label">{t('Оплата')}</span>
          <div className="chips" role="group">{Object.entries(PAYMENTS).map(([k, v]) => <button key={k} type="button" className="chip" aria-pressed={payment === k} onClick={() => setPayment(k)}>{t(v)}</button>)}</div>
        </div>
        {payment === 'mixed' && <Field label="Из них картой">{(id) => <Input id={id} inputMode="decimal" value={card} onChange={(e) => setCard(e.target.value)} />}</Field>}
      </div>
    </ConfirmDialog>
  );
}

function SaleRow({ s, cur, showClient }: { s: PosSale; cur: string; showClient: boolean }) {
  const { t } = useT();
  const qc = useQueryClient();
  const [ret, setRet] = useState(false);
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => pos.ret(s.id, reason), onSuccess: () => { setRet(false); void qc.invalidateQueries({ queryKey: ['pos'] }); } });
  return (
    <li className={`sale-row${s.status === 'returned' ? ' returned' : ''}`}>
      <span className="sale-time">{time(s.sold_at)}</span>
      <span className="sale-main">
        <span className="sale-title">{s.lines.map((l) => t(serviceLabel(l.service))).join(' + ')}{s.lines[0]?.device ? ` · ${s.lines[0].device}` : ''}</span>
        <span className="sale-sub">
          {showClient && s.client_id ? (s.client_id ? <Link to={`/pos/clients/${s.client_id}`}>{s.client_name ?? s.client_phone}</Link> : null) : null}
          {showClient && (s.client_visits ?? 0) > 1 && <span className="repeat-badge" title={t('Постоянный клиент')}><Repeat size={11} aria-hidden /> {s.client_visits}</span>}
          <span>{s.employee_name?.split(' ')[0]}</span>
          {s.status === 'returned' && <span className="danger-text">{t('возврат')}: {s.return_reason}</span>}
        </span>
      </span>
      <span className="sale-side">
        <strong>{money(s.total_minor, cur)}</strong>
        <span className="faint">{s.payment === 'card' ? <CreditCard size={13} aria-label={t('Карта')} /> : s.payment === 'cash' ? <Banknote size={13} aria-label={t('Наличные')} /> : t(PAYMENTS[s.payment])}</span>
        {s.status === 'done' && <button type="button" className="note-act" onClick={() => setRet(true)} aria-label={t('Возврат')}><Undo2 size={13} aria-hidden /></button>}
      </span>
      <ConfirmDialog open={ret} title="Возврат продажи" confirmLabel="Оформить возврат" danger busy={m.isPending} error={m.error} disabled={!reason.trim()} onClose={() => setRet(false)} onConfirm={() => m.mutate()}>
        <Field label="Причина" required>{(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </ConfirmDialog>
    </li>
  );
}

function TodayTab({ location }: { location: string }) {
  const { t } = useT();
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const day = params.get('day');
  const q = useQuery({ queryKey: ['pos', 'day', location, day], queryFn: () => posDay(location, day) });
  const [open, setOpen] = useState(params.get('new') === '1');
  return (
    <DataState query={q}>
      {(d) => {
        const done = d.sales.filter((s) => s.status === 'done');
        const total = done.reduce((a, s) => a + Number(s.total_minor), 0);
        const card = done.reduce((a, s) => a + Number(s.card_minor), 0);
        const repeat = done.filter((s) => (s.client_visits ?? 0) > 1).length;
        const mine = done.filter((s) => s.employee_id === me?.user.id);
        const withPhone = done.filter((s) => s.client_id).length;
        const setDay = (v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set('day', v); else n.delete('day'); return n; }, { replace: true });
        return (
          <div className="stack">
            <div className="pos-day-nav">
              <button type="button" className="icon-btn" aria-label={t('Предыдущий день')} onClick={() => setDay(addDays(d.day, -1))}><ChevronLeft size={18} /></button>
              <strong>{d.day === d.today ? t('Сегодня') : formatDate(d.day, intlLocale())}</strong>
              <button type="button" className="icon-btn" aria-label={t('Следующий день')} disabled={d.day >= d.today} onClick={() => setDay(addDays(d.day, 1) >= d.today ? null : addDays(d.day, 1))}><ChevronRight size={18} /></button>
            </div>
            <div className="pos-kpis">
              <div className="pos-kpi dark"><span className="l">{t('Выручка')}</span><span className="v">{money(total, d.location.currency)}</span><span className="s">{done.length} {t(plural(done.length, 'продажа', 'продажи', 'продаж'))}{mine.length && mine.length !== done.length ? ` · ${t('мои')} ${mine.length}` : ''}</span></div>
              <div className="pos-kpi"><span className="l">{t('По карте')}</span><span className="v">{total ? Math.round((card * 100) / total) : 0}%</span><span className="s">{money(card, d.location.currency)}</span></div>
              <div className="pos-kpi"><span className="l">{t('С телефоном')}</span><span className="v">{done.length ? Math.round((withPhone * 100) / done.length) : 0}%</span><span className="s">🔁 {t('постоянных')}: {repeat}</span></div>
            </div>
            {d.can_sell && d.day === d.today && <Button variant="primary" block className="pos-new" onClick={() => setOpen(true)}><Plus size={18} aria-hidden />{t('Новая продажа')}</Button>}
            {d.sales.length ? <ul className="sale-list">{d.sales.map((s) => <SaleRow key={s.id} s={s} cur={d.location.currency} showClient />)}</ul>
              : <EmptyState title={d.day === d.today ? 'Продаж пока нет' : 'В этот день продаж не записано'} text={d.can_sell ? 'Нажмите «Новая продажа» — это займёт 10 секунд.' : undefined} />}
            {d.can_sell && <NewSaleDialog open={open} onClose={() => { setOpen(false); if (params.get('new')) setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); return n; }, { replace: true }); }} day={d} />}
          </div>
        );
      }}
    </DataState>
  );
}

function ClientsTab({ location }: { location: string }) {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const h = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(h); }, [q]);
  const res = useQuery({ queryKey: ['pos', 'clients', location, debounced], queryFn: () => clientSearch(location, debounced) });
  return (
    <div className="stack">
      <div className="net-search"><Search size={16} aria-hidden /><Input type="search" aria-label={t('Поиск клиента')} placeholder={t('Телефон или имя')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <DataState query={res}>
        {(list) => list.length ? (
          <ul className="sale-list">
            {list.map((c) => <ClientRow key={c.id} c={c} />)}
          </ul>
        ) : <EmptyState title="Никого не нашли" text="Клиент появится после первой продажи с его телефоном." />}
      </DataState>
    </div>
  );
}

function ClientRow({ c, extra }: { c: Client; extra?: string }) {
  const { t } = useT();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <li className="sale-row">
      <span className="client-avatar">{(c.name ?? '?').slice(0, 1)}</span>
      <Link to={`/pos/clients/${c.id}`} className="sale-main">
        <span className="sale-title">{c.name ?? c.phone}{c.visits > 1 && <span className="repeat-badge"><Repeat size={11} aria-hidden /> {c.visits}</span>}</span>
        <span className="sale-sub">
          <span>{c.phone}</span>
          {c.last_device && <span>{c.last_device}</span>}
          {extra ? <span>{extra}</span> : c.last_visit_at && <span>{t('был')} {formatDate(c.last_visit_at, intlLocale())}</span>}
          {!extra && c.warranty_until && c.warranty_until >= today && <span className="ok"><ShieldCheck size={12} aria-hidden /> {t('гарантия до')} {formatDate(c.warranty_until, intlLocale())}</span>}
        </span>
      </Link>
      <ContactButtons phone={c.phone} />
    </li>
  );
}

function ComebackTab({ location }: { location: string }) {
  const { t } = useT();
  const q = useQuery({ queryKey: ['pos', 'comeback', location], queryFn: () => comeback(location) });
  return (
    <DataState query={q}>
      {(d) => (
        <div className="stack">
          <section>
            <h2 className="section-title">{t('Гарантия заканчивается на этой неделе')} <span className="count-pill">{d.warranty_ending.length}</span></h2>
            <p className="faint" style={{ marginTop: 0 }}>{t('Пригласите проверить плёнку: бесплатная проверка — повод вернуться и купить ещё.')}</p>
            {d.warranty_ending.length ? <ul className="sale-list">{d.warranty_ending.map((c) => <ClientRow key={c.id + c.warranty_until} c={c} extra={`${t('гарантия до')} ${formatDate(c.warranty_until, intlLocale())}`} />)}</ul>
              : <p className="faint">{t('На этой неделе никого.')}</p>}
          </section>
          <section>
            <h2 className="section-title">{t('Давно не были')} <span className="count-pill">{d.long_ago.length}</span></h2>
            <p className="faint" style={{ marginTop: 0 }}>{t('Плёнка изнашивается примерно за полгода — предложите заменить или оклеить новый телефон.')}</p>
            {d.long_ago.length ? <ul className="sale-list">{d.long_ago.map((c) => <ClientRow key={c.id} c={c} />)}</ul> : <p className="faint">{t('Пока некого возвращать.')}</p>}
          </section>
        </div>
      )}
    </DataState>
  );
}

export function PosPage() {
  const { t } = useT();
  const { context } = useSession();
  const [params, setParams] = useSearchParams();
  const locs = useLocationsWith('pos.sell');
  const list = useMemo(() => locs.data.filter((l) => l.status === 'active'), [locs.data]);
  const ctx = context?.scope_type === 'location' ? context.scope_id : null;
  const location = params.get('location') ?? (ctx && list.some((l) => l.id === ctx) ? ctx : list[0]?.id ?? '');
  const tab = (params.get('tab') ?? 'today') as 'today' | 'clients' | 'comeback';
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  if (!locs.isLoading && !list.length) return <><PageHeader title={t('Продажи')} /><EmptyState title="Нет точек" text="Продажи записывают те, кто работает на точке." /></>;
  return (
    <>
      <PageHeader title={t('Продажи')} actions={list.length > 1 && (
        <Select aria-label={t('Точка')} value={location} onChange={(e) => set('location', e.target.value)} style={{ minWidth: 200 }}>
          {list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      )} />
      <div style={{ marginBottom: 14 }}>
        <Chips label="Раздел" value={tab} onChange={(v) => set('tab', v === 'today' ? null : v)}
          options={[{ id: 'today', label: 'День' }, { id: 'clients', label: 'Клиенты' }, { id: 'comeback', label: 'Вернуть клиентов' }]} />
      </div>
      {location && (tab === 'today' ? <TodayTab key={location} location={location} /> : tab === 'clients' ? <ClientsTab key={location} location={location} /> : <ComebackTab key={location} location={location} />)}
    </>
  );
}

export function ClientPage() {
  const { id = '' } = useParams();
  const { t } = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pos', 'client', id], queryFn: () => clientCard(id) });
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const save = useMutation({ mutationFn: () => pos.note(id, name, note), onSuccess: () => { setEdit(false); void qc.invalidateQueries({ queryKey: ['pos'] }); } });
  return (
    <DataState query={q}>
      {(c) => {
        const today = new Date().toISOString().slice(0, 10);
        const warranty = c.sales.filter((s) => s.status === 'done' && s.warranty_until && s.warranty_until >= today).map((s) => s.warranty_until!).sort().pop();
        const cur = c.sales[0]?.currency ?? 'RUB';
        return (
          <div className="lead-page">
            <Link to="/pos?tab=clients" className="back-link"><ArrowLeft size={16} aria-hidden /> {t('Клиенты')}</Link>
            <header className="lead-head">
              <div><h1>{c.name ?? t('Клиент')}</h1><div className="faint">{c.phone}</div></div>
              <ContactButtons phone={c.phone} />
            </header>
            <div className="pos-kpis">
              <div className="pos-kpi dark"><span className="l">{t('Визитов')}</span><span className="v">{c.visits}</span><span className="s">{c.last_visit_at ? `${t('последний')} ${formatDate(c.last_visit_at, intlLocale())}` : ''}</span></div>
              <div className="pos-kpi"><span className="l">{t('Всего потратил')}</span><span className="v">{money(c.total_minor, cur)}</span></div>
              <div className="pos-kpi"><span className="l">{t('Гарантия')}</span><span className="v" style={{ fontSize: 18 }}>{warranty ? `${t('до')} ${formatDate(warranty, intlLocale())}` : t('нет')}</span></div>
            </div>
            {edit ? (
              <section className="crm-details">
                <Field label="Имя">{(fid) => <Input id={fid} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
                <Field label="Заметка" hint="Например: любит матовые плёнки, приходит с семьёй">{(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                <div className="row" style={{ gap: 8 }}><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>{t('Сохранить')}</Button><Button size="sm" variant="ghost" onClick={() => setEdit(false)}>{t('Отмена')}</Button></div>
                <ActionError error={save.error} />
              </section>
            ) : (
              <section className="crm-details">
                {c.note ? <div>{c.note}</div> : <div className="faint">{t('Заметок нет')}</div>}
                <button type="button" className="link-btn dark" onClick={() => { setName(c.name ?? ''); setNote(c.note ?? ''); setEdit(true); }}>{t('Изменить имя или заметку')}</button>
              </section>
            )}
            <section>
              <h2 className="section-title">{t('Покупки')}</h2>
              <ul className="sale-list">
                {c.sales.map((s) => (
                  <li key={s.id} className={`sale-row${s.status === 'returned' ? ' returned' : ''}`}>
                    <span className="sale-time">{formatDate(s.sold_at, intlLocale())}</span>
                    <span className="sale-main">
                      <span className="sale-title">{s.lines.map((l) => t(serviceLabel(l.service))).join(' + ')}{s.lines[0]?.device ? ` · ${s.lines[0].device}` : ''}</span>
                      <span className="sale-sub"><span>{s.location_name}</span><span>{s.employee_name?.split(' ')[0]}</span>
                        {s.warranty_until && s.status === 'done' && <span className={s.warranty_until >= today ? 'ok' : ''}>{t('гарантия до')} {formatDate(s.warranty_until, intlLocale())}</span>}
                        {s.status === 'returned' && <span className="danger-text">{t('возврат')}</span>}</span>
                    </span>
                    <span className="sale-side"><strong>{money(s.total_minor, s.currency)}</strong></span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        );
      }}
    </DataState>
  );
}
