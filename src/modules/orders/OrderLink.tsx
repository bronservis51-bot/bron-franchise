// Заказ материалов у франчайзи: плёнки и расходники заказываются в МойСклад по ссылке, которую задаёт менеджер по франшизе.
// Ссылка персональная (ссылка контрагента): при первом переходе франчайзи подтверждает, что не будет ею делиться.
import { useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Lock, ShoppingCart } from 'lucide-react';
import { command } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { ConfirmDialog } from '../../ui';

export function useOrderLink(enabled = true) {
  const q = useQuery({ queryKey: ['order-link'], enabled, staleTime: 5 * 60_000, queryFn: () => command<{ url: string | null }>('order_link') });
  return { url: q.data?.url ?? null, loaded: q.isSuccess };
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

/** Крупная карточка на главной франчайзи. Без ссылки — подсказка, что её добавит менеджер. */
export function OrderCard() {
  const { url, loaded } = useOrderLink();
  const open = useOrderOpen(url);
  if (!loaded) return null;
  if (!url) {
    return (
      <div className="read-card order-card disabled" aria-disabled="true">
        <span className="todo-icon"><ShoppingCart size={18} aria-hidden /></span>
        <span className="todo-main">
          <span className="todo-title">Заказать материалы</span>
          <span className="todo-meta">Скоро здесь можно будет заказать плёнки и расходники — менеджер по франшизе добавит ссылку на МойСклад.</span>
        </span>
      </div>
    );
  }
  return (
    <>
      <a className="read-card order-card" href={url} target="_blank" rel="noopener noreferrer" onClick={open.onClick}>
        <span className="todo-icon"><ShoppingCart size={18} aria-hidden /></span>
        <span className="todo-main">
          <span className="todo-title">Заказать материалы</span>
          <span className="todo-meta">Плёнки, расходники и всё для продажи — откроется МойСклад</span>
          <span className="order-private"><Lock size={12} aria-hidden />Ссылка персональная — не пересылайте её никому</span>
        </span>
        <ExternalLink size={16} className="todo-chevron" aria-hidden />
      </a>
      {open.dialog}
    </>
  );
}

/** Кнопка в шапке — заказ с любого экрана. Появляется, когда менеджер добавил ссылку. */
export function OrderTopButton() {
  const { url } = useOrderLink();
  const open = useOrderOpen(url);
  if (!url) return null;
  return (
    <>
      <a className="btn btn-secondary btn-sm order-top" href={url} target="_blank" rel="noopener noreferrer" onClick={open.onClick}
        title="Заказать плёнки и расходники в МойСклад. Ссылка персональная — не пересылайте её">
        <ShoppingCart size={16} aria-hidden /><span className="order-top-label">Заказать</span><ChevronRight size={14} aria-hidden className="order-top-chev" />
      </a>
      {open.dialog}
    </>
  );
}
