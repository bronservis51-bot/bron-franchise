// Резервные каналы закупки во время подключения единого раздела.
// Ссылка персональная (ссылка контрагента): при первом переходе франчайзи подтверждает, что не будет ею делиться.
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Lock, ShoppingCart } from 'lucide-react';
import { captureSession, command, toAppError } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { Alert, Button, ConfirmDialog, ErrorState, PageHeader } from '../../ui';
import { HelpTip } from '../../ui/HelpTip';
import { useOwnPartnerLifecycle } from '../revenue/partnerLifecycle';
import './order-link.css';

interface StoreLink {
  url: string | null;
  assignment_id: string | null;
}

async function readStoreLink(userId: string): Promise<StoreLink> {
  const actor = await captureSession(userId);
  const link = await command<StoreLink>('order_link', {}, { accessToken: actor.access_token });
  await captureSession(userId);
  return link;
}

const ackKey = (userId: string, link: StoreLink | undefined) =>
  link?.assignment_id ? `bron.order-ack-v2:${userId}:${link.assignment_id}` : null;
const acked = (key: string | null) => { try { return key !== null && localStorage.getItem(key) === '1'; } catch { return false; } };

function goToStore(tab: Window | null, url: string) {
  // The temporary tab comes from the click. Sever the opener and use a link
  // without a referrer for the actual navigation. If popups are blocked, stay
  // in the same tab, preserving the regular browser Back action.
  if (tab?.closed) return false;
  const doc = (tab ?? window).document;
  const link = doc.createElement('a');
  link.href = url;
  link.rel = 'noreferrer';
  doc.body.append(link);
  link.click();
  link.remove();
  return true;
}

function StoreLinkAction({ compact }: { compact?: boolean }) {
  const { me } = useSession();
  const userId = me?.user.id;
  return userId ? <StoreLinkActionForUser key={userId} userId={userId} compact={compact} /> : null;
}

function StoreLinkActionForUser({ userId, compact }: { userId: string; compact?: boolean }) {
  const { reload } = useSession();
  const query = useQuery({ queryKey: ['order-link', userId], staleTime: 5 * 60_000, queryFn: () => readStoreLink(userId) });
  const [prompt, setPrompt] = useState<{ link: StoreLink; changed: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const request = useRef<{ tab: Window | null } | null>(null);
  useEffect(() => () => {
    request.current?.tab?.close();
    request.current = null;
  }, []);

  async function open(personalConfirmation = false) {
    if (request.current) return;
    const confirmedLink = personalConfirmation ? prompt?.link : undefined;
    const tab = confirmedLink || acked(ackKey(userId, query.data)) ? window.open('', '_blank') : null;
    if (tab) {
      tab.opener = null;
      tab.document.title = 'Проверяем ссылку магазина';
    }
    const attempt = { tab };
    request.current = attempt;
    setChecking(true);
    setError(null);
    let launched = false;
    try {
      // An external address and a confirmation may already be stale. Only the
      // current server reply, under the captured account, can open the store.
      const { data: current } = await query.refetch({ throwOnError: true });
      if (request.current !== attempt) return;
      if (!current?.url) {
        setPrompt(null);
        return;
      }
      const key = ackKey(userId, current);
      const approved = confirmedLink
        ? confirmedLink.assignment_id === current.assignment_id && confirmedLink.url === current.url
        : acked(key);
      if (!approved) {
        setPrompt({ link: current, changed: Boolean(confirmedLink) });
        return;
      }
      launched = goToStore(tab, current.url);
      if (launched && confirmedLink && key) {
        try { localStorage.setItem(key, '1'); } catch { /* удобство */ }
      }
      setPrompt(null);
    } catch (cause) {
      if (request.current !== attempt) return;
      setError(cause);
      setPrompt(null);
      if (['unauthenticated', 'forbidden'].includes(toAppError(cause).code)) void reload().catch(() => undefined);
    } finally {
      if (!launched) tab?.close();
      if (request.current === attempt) {
        request.current = null;
        setChecking(false);
      }
    }
  }

  const problem = error ?? query.error;
  return <>
    {problem ? <ErrorState error={problem} onRetry={() => {
      setError(null);
      void query.refetch();
    }} compact /> : query.isPending ? <p role="status">Загружаем вашу ссылку…</p> : query.data?.url ? (
      <>
        <Button variant={compact ? 'ghost' : 'primary'} className={compact ? 'procurement-native-link' : undefined}
          loading={checking && !prompt} disabled={checking} onClick={() => void open()}>
          {compact && <ShoppingCart size={17} aria-hidden />}
          {compact ? 'Ваш магазин МойСклад' : 'Открыть заказ'}<ExternalLink size={16} aria-hidden />
        </Button>
        {!compact && <span className="order-private"><Lock size={12} aria-hidden />Персональная ссылка — не пересылайте её</span>}
      </>
    ) : <p className="faint">Персональная ссылка ещё не добавлена. Обратитесь к менеджеру по франшизе.</p>}
    {prompt && <ConfirmDialog open title="Ваша персональная ссылка" confirmLabel="Понятно, перейти к заказу" cancelLabel="Отмена"
      busy={checking} onClose={() => setPrompt(null)} onConfirm={() => void open(true)}>
      {prompt.changed && <p role="status">Ссылка изменилась. Подтвердите переход по новой ссылке.</p>}
      <div className="order-warn">
        <Lock size={20} aria-hidden />
        <div>
          <p>Эта ссылка открывает МойСклад от имени <strong>вашей компании</strong>: всё, что по ней заказано, оформляется на вас.</p>
          <p><strong>Не пересылайте её никому</strong> — ни знакомым, ни другим франчайзи, не публикуйте в чатах и соцсетях.</p>
          <p className="faint">Если ссылка попала к посторонним, сразу сообщите менеджеру по франшизе.</p>
        </div>
      </div>
    </ConfirmDialog>}
  </>;
}

/** Кнопка в шапке — оба способа закупки с любого экрана франчайзи. */
export function OrderTopButton() {
  const { readOnly } = useOwnPartnerLifecycle();
  if (readOnly) return null;
  return (
      <NavLink className="btn btn-secondary btn-sm order-top" to="/order" aria-label="Заказать материалы" title="Заказ и предзаказ материалов" data-tour-target="order">
        <ShoppingCart size={16} aria-hidden /><span className="order-top-label">Заказать</span><ChevronRight size={14} aria-hidden className="order-top-chev" />
      </NavLink>
  );
}

/** Existing personal links remain visible and usable throughout the in-app store rollout. */
export function PersonalStoreLink() {
  const { readOnly } = useOwnPartnerLifecycle();
  if (readOnly) return null;
  return <div className="procurement-native-store"><StoreLinkAction compact /></div>;
}

export function OrderPage() { return <><PageHeader title="Заказать" /><OrderFallback /></>; }

export function OrderFallback() {
  const { isManager } = useSession();
  const { readOnly } = useOwnPartnerLifecycle();
  if (!isManager && readOnly) return <Alert title="Заказы приостановлены">История и отчёты доступны для просмотра.</Alert>;
  return (
    <div>
      <div className="order-options">
        <section className="card order-option" aria-labelledby="order-stock-title">
          <div className="row order-option-title"><h2 id="order-stock-title">Заказ</h2></div>
          <p>Материалы в наличии можно заказать в персональном магазине МойСклад.</p>
          {isManager ? <p className="faint">Персональные ссылки доступны в карточках франчайзи.</p> : <StoreLinkAction />}
        </section>
        <section className="card order-option" aria-labelledby="order-preorder-title">
          <div className="row order-option-title">
            <h2 id="order-preorder-title">Предзаказ</h2>
            <HelpTip label="Как работает предзаказ">Уточните у менеджера возможность поставки, срок и итоговую цену.</HelpTip>
          </div>
          <p>Заявка на плёнки, которых нет в наличии, — через bronserviceshop.</p>
          <p className="faint">Наличие на сайте и на складе может отличаться.</p>
          <a className="btn btn-secondary" href="https://bronserviceshop.space/" target="_blank" rel="noopener noreferrer">
            Открыть каталог<ExternalLink size={16} aria-hidden />
          </a>
        </section>
      </div>
    </div>
  );
}
