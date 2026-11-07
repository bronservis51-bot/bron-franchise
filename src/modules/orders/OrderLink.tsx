// Два канала закупки: персональный МойСклад и заявки на предзаказ в bronserviceshop.
// Ссылка персональная (ссылка контрагента): при первом переходе франчайзи подтверждает, что не будет ею делиться.
import { useState, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Lock, Package, ShoppingCart } from 'lucide-react';
import { command } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { ConfirmDialog, ErrorState } from '../../ui';

export function useOrderLink(enabled = true) {
  const q = useQuery({ queryKey: ['order-link'], enabled, staleTime: 5 * 60_000, queryFn: () => command<{ url: string | null }>('order_link') });
  return { url: q.isError ? null : q.data?.url ?? null, loaded: q.isSuccess, pending: q.isPending, error: q.error, retry: () => { void q.refetch(); } };
}

const ackKey = (userId: string | undefined, url: string) => `bron.order-ack:${userId ?? ''}:${url}`;
const acked = (key: string) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };

/** Переход к заказу: в первый раз (и после смены ссылки) — предупреждение, что ссылка персональная. */
function useOrderOpen(url: string | null) {
  const { me } = useSession();
  const [ask, setAsk] = useState(false);
  const key = url ? ackKey(me?.user.id, url) : '';
  const onClick = (e: MouseEvent) => {
    if (!url || acked(key)) return; // уже подтверждал — обычный переход по ссылке
    e.preventDefault();
    setAsk(true);
  };
  const dialog = ask && url ? (
    <ConfirmDialog open title="Ваша персональная ссылка" confirmLabel="Понятно, перейти к заказу" cancelLabel="Отмена"
      onClose={() => setAsk(false)}
      onConfirm={() => {
        try { localStorage.setItem(key, '1'); } catch { /* удобство */ }
        setAsk(false);
        window.open(url, '_blank', 'noopener,noreferrer');
      }}>
      <div className="order-warn">
        <Lock size={20} aria-hidden />
        <div>
          <p>Эта ссылка открывает МойСклад от имени <strong>вашей компании</strong>: всё, что по ней заказано, оформляется на вас.</p>
          <p><strong>Не пересылайте её никому</strong> — ни знакомым, ни другим франчайзи, не публикуйте в чатах и соцсетях.</p>
          <p className="faint">Если ссылка попала к посторонним, сразу сообщите менеджеру по франшизе — он заменит её на новую.</p>
        </div>
      </div>
    </ConfirmDialog>
  ) : null;
  return { onClick, dialog };
}

/** Выбор закупки доступен и до назначения персональной ссылки. */
export function OrderCard() {
  return (
      <Link className="read-card order-card" to="/order">
        <span className="todo-icon"><ShoppingCart size={18} aria-hidden /></span>
        <span className="todo-main">
          <span className="todo-title">Заказать материалы</span>
          <span className="todo-meta">Заказ из наличия или предзаказ плёнок</span>
        </span>
        <ChevronRight size={16} className="todo-chevron" aria-hidden />
      </Link>
  );
}

/** Кнопка в шапке — оба способа закупки с любого экрана франчайзи. */
export function OrderTopButton() {
  return (
      <Link className="btn btn-secondary btn-sm order-top" to="/order" aria-label="Заказать материалы" title="Заказ и предзаказ материалов">
        <ShoppingCart size={16} aria-hidden /><span className="order-top-label">Заказать</span><ChevronRight size={14} aria-hidden className="order-top-chev" />
      </Link>
  );
}

export function OrderPage() {
  const { url, pending, error, retry } = useOrderLink();
  const open = useOrderOpen(url);
  return (
    <div>
      <div className="page-head"><h1>Заказать</h1></div>
      <div className="order-options">
        <section className="card order-option" aria-labelledby="order-stock-title">
          <ShoppingCart size={24} aria-hidden />
          <h2 id="order-stock-title">Заказ</h2>
          <p>Покупка из наличия на складе — через ваш персональный магазин МойСклад.</p>
          <p className="faint">Выберите доступные товары и количество. Заказ оформится на вашу компанию.</p>
          {error ? <ErrorState error={error} onRetry={retry} compact /> : pending ? <p role="status">Загружаем вашу ссылку…</p> : url ? (
            <>
              <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer" onClick={open.onClick}>
                Открыть заказ<ExternalLink size={16} aria-hidden />
              </a>
              <span className="order-private"><Lock size={12} aria-hidden />Персональная ссылка — не пересылайте её</span>
            </>
          ) : <p className="faint">Персональная ссылка ещё не добавлена. Обратитесь к менеджеру по франшизе.</p>}
        </section>
        <section className="card order-option" aria-labelledby="order-preorder-title">
          <Package size={24} aria-hidden />
          <h2 id="order-preorder-title">Предзаказ</h2>
          <p>Заявка на плёнки, которых нет в наличии, — через bronserviceshop.</p>
          <p className="faint">Каталог сайта не синхронизирован со складом. Возможность поставки, срок и итоговую стоимость нужно подтвердить у менеджера.</p>
          <a className="btn btn-secondary" href="https://bronserviceshop.space/" target="_blank" rel="noopener noreferrer">
            Открыть предзаказ<ExternalLink size={16} aria-hidden />
          </a>
        </section>
      </div>
      {open.dialog}
    </div>
  );
}
