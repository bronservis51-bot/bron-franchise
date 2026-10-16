// Каталог в стиле магазина плёнок (BUY-01…03): категории, витрина с изображениями, избранное, корзина в выезжающей панели.
// Единицы и кратность, цена своего прайс-листа и остаток как проекция — проверяет сервер при каждом изменении и при отправке.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellRing, Heart, Minus, Plus, ShoppingCart, Sparkles, Trash2, X } from 'lucide-react';
import { useSession } from '../../platform/session';
import { newOperationKey, toAppError } from '../../platform/backend';
import { dueInfo } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { sumMinor, toBigInt } from '../../platform/money';
import { ActionError, Alert, Button, Card, ConfirmDialog, DataState, EmptyState, Field, Input, Money, NoResults, PageHeader, Select, Textarea } from '../../ui';
import { UNIT } from '../../ui/status';
import { useToast } from '../../ui/toast';
import { useLocationsWith } from '../shared/lookups';
import { cartLines, cartOpen, catalog, orderCommands, stockSubscribe, type CatalogItem, type OrderLine } from './api';
import { ProductMockup } from './Mockup';

function decimals(n: string | number) {
  const s = String(n);
  return s.includes('.') ? s.split('.')[1].replace(/0+$/, '').length : 0;
}
const fmtQty = (n: string | number) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

function QtyInput({ value, step, min, onChange, label }: { value: number; step: number; min: number; onChange: (v: number) => void; label: string }) {
  const round = (v: number) => Number(v.toFixed(Math.max(decimals(step), 0)));
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => { const v = Number(text.replace(',', '.')); if (!Number.isNaN(v) && v !== value) onChange(v); else setText(String(value)); };
  return (
    <div className="qty" role="group" aria-label={label}>
      <button type="button" aria-label="Меньше" onClick={() => onChange(round(value - step < min ? 0 : value - step))}><Minus size={16} /></button>
      <input inputMode="decimal" aria-label="Количество" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
      <button type="button" aria-label="Больше" onClick={() => onChange(round(value === 0 ? Math.max(min, step) : value + step))}><Plus size={16} /></button>
    </div>
  );
}

// Избранное хранится только в этом браузере, отдельно для каждого пользователя (удобство, не данные компании)
function useFavorites(userId: string | undefined) {
  const key = `bron.fav.${userId ?? 'anon'}`;
  const [fav, setFav] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try { setFav(new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as string[])); } catch { setFav(new Set()); }
  }, [key]);
  const toggle = (sku: string) => setFav((prev) => {
    const next = new Set(prev);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* приватный режим: избранное живёт до перезагрузки */ }
    return next;
  });
  return { fav, toggle };
}

function ProductCard({ it, inCart, onSet, busy, fav, onFav, onSubscribe }: { it: CatalogItem; inCart: number; onSet: (q: number) => void; busy: boolean; fav: boolean; onFav: () => void; onSubscribe: (on: boolean) => void }) {
  const { t } = useT();
  const step = Number(it.pack_multiple);
  const min = Number(it.min_qty);
  const avail = it.available_qty === null ? null : Number(it.available_qty);
  const age = it.stock_refreshed_at ? dueInfo(it.stock_refreshed_at).span : null;
  return (
    <article className="product-card">
      <div className="product-media">
        <ProductMockup visual={it.visual} seed={it.sku} />
        {(it.is_new || it.arrived_at) && <span className={`product-flag${it.arrived_at ? ' arrived' : ''}`}>{it.arrived_at ? t('Поступило') : t('Новинка')}</span>}
        <button type="button" className="fav-btn" aria-pressed={fav} aria-label={fav ? `Убрать из избранного: ${it.name}` : `В избранное: ${it.name}`} onClick={onFav}>
          <Heart size={18} fill={fav ? 'currentColor' : 'none'} aria-hidden />
        </button>
      </div>
      <h3 className="product-title">{it.name}</h3>
      <div className="product-sku">{t('Артикул')}: {it.article_no ?? it.sku}</div>
      {it.subtitle && <div className="product-sub">{t(it.subtitle)}</div>}
      <div className="product-price"><Money minor={it.price_minor} currency={it.currency} short />{it.unit !== 'sheet' && <span className="faint" style={{ fontWeight: 400 }}> / {t(UNIT[it.unit] ?? it.unit)}</span>}</div>
      <div className="product-stock" title={age ? t('обновлено {{age}} назад', { age }) : undefined}>
        {avail === null ? t('Остаток неизвестен') : avail <= 0 ? <span style={{ color: 'var(--danger)' }}>{it.incoming_on
            ? `${t('Нет в наличии · ожидается')} ${new Date(`${it.incoming_on}T12:00:00Z`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' })}`
            : `${t('Нет в наличии')}${it.lead_time_days ? ` · ~${it.lead_time_days} ${t('дн.')}` : ''}`}</span>
          : avail < 20 ? <span style={{ color: 'var(--warning)' }}>{t('Осталось ~{{n}}', { n: fmtQty(avail) })}</span> : t('В наличии')}
      </div>
      <div className="product-cta">
        {inCart > 0
          ? <QtyInput value={inCart} step={step} min={min} onChange={onSet} label={`Количество: ${it.name}`} />
          : <button type="button" className="btn-outline-pill" disabled={busy} onClick={() => onSet(Math.max(min, step))}>{busy ? t('Добавляем…') : avail !== null && avail <= 0 ? t('Заказать заранее') : t('Добавить в корзину')}</button>}
      </div>
      {avail !== null && avail <= 0 && (
        <button type="button" className={`notify-btn${it.subscribed ? ' on' : ''}`} aria-pressed={it.subscribed} onClick={() => onSubscribe(!it.subscribed)}>
          {it.subscribed ? <><BellRing size={14} aria-hidden /> {t('Сообщим о поступлении')}</> : <><Bell size={14} aria-hidden /> {t('Сообщить о поступлении')}</>}
        </button>
      )}
      {(step !== 1 || min > 1) && <div className="faint" style={{ fontSize: 'var(--fs-xs)', marginTop: 6 }}>{t('Кратность')} {fmtQty(step)} · {t('минимум')} {fmtQty(min)}</div>}
    </article>
  );
}

function CartLine({ l, it, currency, error, onSet }: { l: OrderLine; it?: CatalogItem; currency: string; error?: string; onSet: (q: number) => void }) {
  const { t } = useT();
  return (
    <li className="cart-line">
      <ProductMockup visual={it?.visual} seed={l.sku} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{l.name}</div>
            <div className="faint">{it?.subtitle ? t(it.subtitle) : t(UNIT[l.unit] ?? l.unit)} · <Money minor={l.price_minor} currency={currency} short /></div>
          </div>
          <button className="icon-btn" aria-label={`Удалить ${l.name}`} onClick={() => onSet(0)}><Trash2 size={16} /></button>
        </div>
        <div className="row between" style={{ marginTop: 8 }}>
          <QtyInput value={Number(l.qty_ordered)} step={Number(it?.pack_multiple ?? 1)} min={Number(it?.min_qty ?? 1)} onChange={onSet} label={`Количество: ${l.name}`} />
          <Money minor={l.line_total_minor} currency={currency} strong short />
        </div>
        {error && <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-s)', marginTop: 4 }} role="alert">{error}</div>}
      </div>
    </li>
  );
}

type Sort = 'default' | 'cheap' | 'expensive' | 'name';

export function CatalogPage() {
  const { context, me } = useSession();
  const { t } = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const locs = useLocationsWith('order.create');
  const [location, setLocation] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('');
  const [sort, setSort] = useState<Sort>('default');
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [opKey, setOpKey] = useState(newOperationKey);
  const { fav, toggle } = useFavorites(me?.user.id);

  useEffect(() => {
    if (location || !locs.data.length) return;
    const ctx = context?.scope_type === 'location' ? context.scope_id : null;
    setLocation(ctx && locs.data.some((l) => l.id === ctx) ? ctx : (locs.data.find((l) => l.status === 'active') ?? locs.data[0]).id);
  }, [locs.data, context, location]);

  const items = useQuery({ queryKey: ['catalog', location], enabled: Boolean(location), queryFn: () => catalog(location) });
  const cart = useQuery({ queryKey: ['cart', location], enabled: Boolean(location), queryFn: () => cartOpen(location) });
  const lines = useQuery({ queryKey: ['cart', location, 'lines', cart.data?.id], enabled: Boolean(cart.data?.id), queryFn: () => cartLines(cart.data!.id) });
  const [address, setAddress] = useState('');
  const [contact, setContact] = useState('');
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (cart.data) { setAddress(cart.data.delivery_address ?? ''); setContact(cart.data.contact ?? ''); setComment(cart.data.comment ?? ''); }
  }, [cart.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const [busyItem, setBusyItem] = useState<string | null>(null);
  const setLine = useMutation({
    mutationFn: async ({ item, qty }: { item: string; qty: number }) => { setBusyItem(item); await orderCommands.setLine(cart.data!.id, item, qty); },
    onSettled: () => { setBusyItem(null); void qc.invalidateQueries({ queryKey: ['cart', location] }); },
  });
  const subscribe = useMutation({
    mutationFn: ({ item, on }: { item: string; on: boolean }) => stockSubscribe(item, on),
    onSuccess: (on) => { toast(on ? 'Сообщим, как только товар поступит на склад' : 'Подписка отменена'); void qc.invalidateQueries({ queryKey: ['catalog', location] }); },
  });
  const submit = useMutation({
    mutationFn: async () => {
      await orderCommands.update(cart.data!.id, address, contact, comment);
      return orderCommands.submit(cart.data!.id, opKey);
    },
    onSuccess: (r) => {
      toast(`Заказ ${r.number} отправлен. Цены и количества проверены сервером.`);
      setConfirm(false);
      setOpen(false);
      setOpKey(newOperationKey());
      void qc.invalidateQueries({ queryKey: ['cart'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      navigate(`/orders/${r.order_id}`);
    },
  });

  const subErr = submit.error ? toAppError(submit.error) : null;
  const lineErrors = useMemo(() => {
    if (!subErr?.hint?.startsWith('[')) return new Map<string, string>();
    try {
      return new Map((JSON.parse(subErr.hint) as { sku: string; error: string }[]).map((e) => [e.sku, e.error]));
    } catch {
      return new Map<string, string>();
    }
  }, [subErr]);
  useEffect(() => { if (lineErrors.size) { setConfirm(false); setOpen(true); } }, [lineErrors]);

  const all = items.data ?? [];
  const categories = useMemo(() => [...new Set(all.map((i) => i.category))], [all]);
  const q = search.trim().toLowerCase();
  const filtered = all
    .filter((i) => category === '♥' ? fav.has(i.sku) : category === '★' ? i.is_new || Boolean(i.arrived_at) : !category || i.category === category)
    .filter((i) => !q || `${i.name} ${i.sku} ${i.article_no ?? ''} ${i.category} ${i.subtitle ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => sort === 'cheap' ? Number(toBigInt(a.price_minor) - toBigInt(b.price_minor))
      : sort === 'expensive' ? Number(toBigInt(b.price_minor) - toBigInt(a.price_minor))
      : sort === 'name' ? a.name.localeCompare(b.name, 'ru') : 0);
  const total = sumMinor((lines.data ?? []).map((l) => l.line_total_minor));
  const currency = cart.data?.currency ?? items.data?.[0]?.currency ?? 'RUB';
  const locName = locs.data.find((l) => l.id === location)?.name;
  const isOwn = locs.data.find((l) => l.id === location)?.kind === 'own';
  const count = lines.data?.length ?? 0;
  const byId = new Map(all.map((i) => [i.item_id, i]));

  if (!locs.isLoading && !locs.data.length) return <><PageHeader title={t('Магазин')} /><Card><EmptyState title="Нет точек для заказа" text="У вас нет права оформлять заказы ни для одной точки." /></Card></>;

  return (
    <>
      <PageHeader title={t('Магазин')} sub={isOwn ? 'Заявка собственной точки на снабжение' : 'Коммерческий заказ партнёра: цены вашего прайс-листа'}
        actions={<Field label="Точка доставки">{(id) => (
          <Select id={id} value={location} onChange={(e) => setLocation(e.target.value)} style={{ minWidth: 220 }}>
            {locs.data.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}</Field>} />
      {params.get('order') && cart.data && params.get('order') !== cart.data.id && <div style={{ marginBottom: 16 }}><Alert tone="info">Открыта корзина выбранной точки.</Alert></div>}

      {(() => {
        const fresh = all.filter((i) => i.arrived_at || i.is_new);
        return fresh.length > 0 && category !== '★' ? (
          <button type="button" className="shop-news" onClick={() => setCategory('★')}>
            <Sparkles size={18} aria-hidden />
            <span><strong>{t('Новое в магазине')}:</strong> {fresh.slice(0, 4).map((i) => i.name).join(', ')}{fresh.length > 4 ? '…' : ''}</span>
          </button>
        ) : null;
      })()}
      <nav className="shop-cats" aria-label={t('Категории')}>
        <button type="button" aria-pressed={!category} onClick={() => setCategory('')}>{t('Все')}</button>
        {all.some((i) => i.is_new || i.arrived_at) && <button type="button" aria-pressed={category === '★'} onClick={() => setCategory('★')}><Sparkles size={15} aria-hidden style={{ verticalAlign: '-2px' }} /> {t('Новинки и поступления')}</button>}
        {categories.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>{t(c)}</button>)}
        <button type="button" aria-pressed={category === '♥'} onClick={() => setCategory('♥')}><Heart size={15} aria-hidden style={{ verticalAlign: '-2px' }} /> {t('Избранное')}{fav.size ? ` (${fav.size})` : ''}</button>
      </nav>

      <div className="shop-bar">
        <div style={{ flex: '1 1 260px', maxWidth: 420 }}>
          <label htmlFor="cat-search" className="sr-only">{t('Поиск')}</label>
          <Input id="cat-search" type="search" placeholder="Название, артикул или категория" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div>
          <label htmlFor="cat-sort" className="sr-only">{t('Сортировка')}</label>
          <Select id="cat-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="default">{t('По умолчанию')}</option>
            <option value="cheap">{t('Сначала дешевле')}</option>
            <option value="expensive">{t('Сначала дороже')}</option>
            <option value="name">{t('По названию')}</option>
          </Select>
        </div>
      </div>

      <DataState query={items} skeleton={6} empty={() => (filtered.length ? null : search ? <NoResults query={search} />
        : category === '♥' ? <EmptyState title="В избранном пусто" text="Нажмите на сердечко у товара, чтобы быстро находить его здесь." />
        : <EmptyState title="Каталог пуст" text="Для точки не назначен прайс-лист." />)}>
        {() => (
          <div className="products">
            {filtered.map((it) => {
              const inCart = Number(lines.data?.find((l) => l.item_id === it.item_id)?.qty_ordered ?? 0);
              return <ProductCard key={it.item_id} it={it} inCart={inCart} busy={busyItem === it.item_id} fav={fav.has(it.sku)} onFav={() => toggle(it.sku)}
                onSubscribe={(on) => subscribe.mutate({ item: it.item_id, on })}
                onSet={(qty) => setLine.mutate({ item: it.item_id, qty })} />;
            })}
          </div>
        )}
      </DataState>
      <ActionError error={setLine.error} />
      <div style={{ marginTop: 24 }} className="faint">{t('Остатки обновляются со склада; резерв подтверждает склад после передачи заказа.')}</div>

      <button type="button" className="cart-fab" aria-label={`${t('Корзина')}: ${count}`} onClick={() => setOpen(true)}>
        <ShoppingCart size={26} aria-hidden />
        {count > 0 && <span className="count">{count}</span>}
      </button>

      {open && <>
        <div className="drawer-backdrop" onClick={() => setOpen(false)} />
        <aside className="drawer" role="dialog" aria-modal="true" aria-label={t('Корзина')}>
          <div className="drawer-head">
            <div>
              <h2 style={{ margin: 0, fontSize: 20 }}>{t('Корзина')}</h2>
              <div className="faint">{locName}</div>
            </div>
            <button className="icon-btn" aria-label="Закрыть" onClick={() => setOpen(false)}><X size={20} /></button>
          </div>
          <div className="drawer-body">
            {!count ? <EmptyState title="Корзина пуста" text="Добавьте товары из каталога. Корзина сохраняется на сервере." /> : (
              <>
                <ul className="list">
                  {lines.data!.map((l) => <CartLine key={l.id} l={l} it={byId.get(l.item_id)} currency={currency} error={lineErrors.get(l.sku)}
                    onSet={(qty) => setLine.mutate({ item: l.item_id, qty })} />)}
                </ul>
                <ActionError error={setLine.error} />
                <div style={{ marginTop: 16 }}>
                  <Field label={t('Адрес доставки')}>{(id) => <Input id={id} value={address} onChange={(e) => setAddress(e.target.value)} />}</Field>
                  <Field label={t('Контакт получателя')}>{(id) => <Input id={id} value={contact} onChange={(e) => setContact(e.target.value)} />}</Field>
                  <Field label={t('Комментарий')}>{(id) => <Textarea id={id} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
                </div>
              </>
            )}
          </div>
          {count > 0 && (
            <div className="drawer-foot">
              <div className="row between"><span>{t('Итого предварительно')}</span><span style={{ fontSize: 20 }}><Money minor={total} currency={currency} strong short /></span></div>
              <div className="faint" style={{ margin: '4px 0 12px' }}>{t('Итог, цены и кратность проверит сервер при отправке.')}</div>
              <Button variant="primary" block onClick={() => { submit.reset(); setConfirm(true); }}>{t('Оформить заказ')}</Button>
            </div>
          )}
        </aside>
      </>}

      <ConfirmDialog
        open={confirm}
        title="Отправить заказ?"
        confirmLabel="Отправить заказ"
        busy={submit.isPending}
        error={submit.error && !lineErrors.size ? submit.error : null}
        onClose={() => setConfirm(false)}
        onConfirm={() => submit.mutate()}
        summary={[
          ['Точка', locName ?? ''], ['Позиций', String(count)],
          ['Сумма (предварительно)', <Money key="m" minor={total} currency={currency} />],
          ['Порядок', isOwn ? 'Согласование при превышении порога' : 'Передача на склад после подтверждения оплаты снабжением'],
        ]}
      >
        <p className="faint">{t('Повторное нажатие не создаст второй заказ.')}</p>
      </ConfirmDialog>
    </>
  );
}
