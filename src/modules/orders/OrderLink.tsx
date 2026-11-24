// Резервные каналы закупки во время подключения единого раздела.
// Ссылка персональная (ссылка контрагента): при первом переходе франчайзи подтверждает, что не будет ею делиться.
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Lock, ShoppingCart } from 'lucide-react';
import { captureSession, command, toAppError } from '../../platform/backend';
import { useLocale } from '../../platform/locale';
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
  const { t } = useLocale();
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
      tab.document.title = t('Проверяем ссылку магазина', 'Mağaza bağlantısı kontrol ediliyor');
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
    }} compact /> : query.isPending ? <p role="status">{t('Загружаем вашу ссылку…', 'Bağlantınız yükleniyor…')}</p> : query.data?.url ? (
      <>
        <Button variant={compact ? 'ghost' : 'primary'} className={compact ? 'procurement-native-link' : undefined}
          loading={checking && !prompt} disabled={checking} onClick={() => void open()}>
          {compact && <ShoppingCart size={17} aria-hidden />}
          {compact ? t('Ваш магазин МойСклад', 'MoySklad mağazanız') : t('Открыть заказ', 'Sipariş ekranını aç')}<ExternalLink size={16} aria-hidden />
        </Button>
        {!compact && <span className="order-private"><Lock size={12} aria-hidden />{t('Персональная ссылка — не пересылайте её', 'Bu bağlantı size özel. Paylaşmayın.')}</span>}
      </>
    ) : <p className="faint">{t('Персональная ссылка ещё не добавлена. Обратитесь к менеджеру по франшизе.', 'Size özel bağlantı henüz eklenmedi. Franchise yöneticinizle görüşün.')}</p>}
    {prompt && <ConfirmDialog open title={t('Ваша персональная ссылка', 'Size özel bağlantı')} confirmLabel={t('Понятно, перейти к заказу', 'Anladım, siparişe geç')} cancelLabel={t('Отмена', 'İptal')}
      busy={checking} onClose={() => setPrompt(null)} onConfirm={() => void open(true)}>
      {prompt.changed && <p role="status">{t('Ссылка изменилась. Подтвердите переход по новой ссылке.', 'Bağlantı değişti. Yeni bağlantıyı açmayı onaylayın.')}</p>}
      <div className="order-warn">
        <Lock size={20} aria-hidden />
        <div>
          <p>{t('Эта ссылка открывает МойСклад от имени ', 'Bu bağlantı MoySklad mağazasını ')}<strong>{t('вашей компании', 'şirketiniz adına')}</strong>
            {t(': всё, что по ней заказано, оформляется на вас.', ' açar. Verilen tüm siparişler şirketiniz adına kaydedilir.')}</p>
          <p><strong>{t('Не пересылайте её никому', 'Bağlantıyı kimseyle paylaşmayın')}</strong>{t(' — ни знакомым, ни другим франчайзи, не публикуйте в чатах и соцсетях.', '. Tanıdıklarınıza veya başka franchise işletmecilerine göndermeyin. Sohbetlerde ya da sosyal medyada yayımlamayın.')}</p>
          <p className="faint">{t('Если ссылка попала к посторонним, сразу сообщите менеджеру по франшизе.', 'Bağlantı başkasının eline geçtiyse franchise yöneticinize hemen bildirin.')}</p>
        </div>
      </div>
    </ConfirmDialog>}
  </>;
}

/** Кнопка в шапке — оба способа закупки с любого экрана франчайзи. */
export function OrderTopButton() {
  const { t } = useLocale();
  const { readOnly } = useOwnPartnerLifecycle();
  if (readOnly) return null;
  return (
      <NavLink className="btn btn-secondary btn-sm order-top" to="/order" aria-label={t('Заказать материалы', 'Malzeme sipariş et')} title={t('Заказ и предзаказ материалов', 'Malzeme siparişi ve ön sipariş')} data-tour-target="order">
        <ShoppingCart size={16} aria-hidden /><span className="order-top-label">{t('Заказать', 'Sipariş ver')}</span><ChevronRight size={14} aria-hidden className="order-top-chev" />
      </NavLink>
  );
}

/** Existing personal links remain visible and usable throughout the in-app store rollout. */
export function PersonalStoreLink() {
  const { readOnly } = useOwnPartnerLifecycle();
  if (readOnly) return null;
  return <div className="procurement-native-store"><StoreLinkAction compact /></div>;
}

export function OrderPage() {
  const { t } = useLocale();
  return <><PageHeader title={t('Заказать', 'Sipariş ver')} /><OrderFallback /></>;
}

export function OrderFallback() {
  const { t } = useLocale();
  const { isManager } = useSession();
  const { readOnly } = useOwnPartnerLifecycle();
  if (!isManager && readOnly) return <Alert title={t('Заказы приостановлены', 'Siparişler duraklatıldı')}>{t('История и отчёты доступны для просмотра.', 'Geçmiş kayıtları ve raporları görüntüleyebilirsiniz.')}</Alert>;
  return (
    <div>
      <div className="order-options">
        <section className="card order-option" aria-labelledby="order-stock-title">
          <div className="row order-option-title"><h2 id="order-stock-title">{t('Заказ', 'Sipariş')}</h2></div>
          <p>{t('Материалы в наличии можно заказать в персональном магазине МойСклад.', 'Stoktaki malzemeleri size özel MoySklad mağazasından sipariş edebilirsiniz.')}</p>
          {isManager ? <p className="faint">{t('Персональные ссылки доступны в карточках франчайзи.', 'Kişiye özel bağlantılar franchise işletmecilerinin kartlarında bulunur.')}</p> : <StoreLinkAction />}
        </section>
        <section className="card order-option" aria-labelledby="order-preorder-title">
          <div className="row order-option-title">
            <h2 id="order-preorder-title">{t('Предзаказ', 'Ön sipariş')}</h2>
            <HelpTip label={t('Как работает предзаказ', 'Ön sipariş nasıl çalışır?')}>{t('Уточните у менеджера возможность поставки, срок и итоговую цену.', 'Tedarik durumunu, teslim süresini ve toplam fiyatı yöneticinizle teyit edin.')}</HelpTip>
          </div>
          <p>{t('Заявка на плёнки, которых нет в наличии, — через bronserviceshop.', 'Stokta bulunmayan filmler için bronserviceshop üzerinden talep oluşturun.')}</p>
          <p className="faint">{t('Наличие на сайте и на складе может отличаться.', 'Sitede görünen stok, depodaki stoktan farklı olabilir.')}</p>
          <a className="btn btn-secondary" href="https://bronserviceshop.space/" target="_blank" rel="noopener noreferrer">
            {t('Открыть каталог', 'Kataloğu aç')}<ExternalLink size={16} aria-hidden />
          </a>
        </section>
      </div>
    </div>
  );
}
