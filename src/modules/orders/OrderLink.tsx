// Заказ материалов у франчайзи: плёнки и расходники заказываются в МойСклад по ссылке, которую задаёт менеджер по франшизе.
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, ShoppingCart } from 'lucide-react';
import { command } from '../../platform/backend';

export function useOrderLink(enabled = true) {
  const q = useQuery({ queryKey: ['order-link'], enabled, staleTime: 5 * 60_000, queryFn: () => command<{ url: string | null }>('order_link') });
  return { url: q.data?.url ?? null, loaded: q.isSuccess };
}

/** Крупная карточка на главной франчайзи. Без ссылки — подсказка, что её добавит менеджер. */
export function OrderCard() {
  const { url, loaded } = useOrderLink();
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
    <a className="read-card order-card" href={url} target="_blank" rel="noopener noreferrer">
      <span className="todo-icon"><ShoppingCart size={18} aria-hidden /></span>
      <span className="todo-main">
        <span className="todo-title">Заказать материалы</span>
        <span className="todo-meta">Плёнки, расходники и всё для продажи — откроется МойСклад</span>
      </span>
      <ExternalLink size={16} className="todo-chevron" aria-hidden />
    </a>
  );
}

/** Кнопка в шапке — заказ с любого экрана. Появляется, когда менеджер добавил ссылку. */
export function OrderTopButton() {
  const { url } = useOrderLink();
  if (!url) return null;
  return (
    <a className="btn btn-secondary btn-sm order-top" href={url} target="_blank" rel="noopener noreferrer" title="Заказать плёнки и расходники в МойСклад">
      <ShoppingCart size={16} aria-hidden /><span className="order-top-label">Заказать</span><ChevronRight size={14} aria-hidden className="order-top-chev" />
    </a>
  );
}
