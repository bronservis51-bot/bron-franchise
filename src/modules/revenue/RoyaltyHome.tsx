import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { command } from '../../platform/backend';
import { formatDate, monthLabel } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { formatMoneyShort, type MinorInput } from '../../platform/money';
import { ActionError, Alert, Button } from '../../ui';
import { MissingRevenue } from '../../ui/MissingRevenue';
import { financeDays } from '../finance/financeNavigation';

export interface RoyaltyHomeState {
  state: 'none' | 'missing_revenue' | 'payable' | 'overdue' | 'checking' | 'unavailable';
  month: string;
  due_on: string;
  overdue?: boolean;
  amount_minor: MinorInput;
  currency: string;
  missing: { location_id: string; location_name: string; days: string[] }[];
  checkout_url: string | null;
}

const checkoutHosts = new Set(['yoomoney.ru', 'yookassa.ru']);

export function trustedRoyaltyCheckout(link: string | null | undefined) {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || !checkoutHosts.has(url.hostname) || url.port || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function RoyaltyHomeCard({ status, busy = false, error, onAction }: {
  status: RoyaltyHomeState; busy?: boolean; error?: unknown; onAction: () => void;
}) {
  const { t, locale } = useLocale();
  if (status.state === 'none') return null;
  const period = monthLabel(status.month, true, locale);
  if (status.state === 'missing_revenue') {
    return <MissingRevenue urgent title={t(`Заполните выручку · ${period}`, `Geliri tamamlayın · ${period}`)}
      points={status.missing.map(point => ({
        id: point.location_id, name: point.location_name, count: point.days.length,
        dates: point.days.map(day => ({ label: formatDate(day, locale).slice(0, 5), to: financeDays(status.month, point.location_id, day) })),
      }))} />;
  }
  if (status.state === 'unavailable') {
    return <Alert title={t('Роялти пока не удалось проверить', 'Royalty henüz doğrulanamadı')}
      action={<Button size="sm" disabled={busy} onClick={onAction}>{t('Проверить', 'Kontrol et')}</Button>} />;
  }

  const checking = status.state === 'checking';
  const overdue = status.state === 'overdue' || status.overdue === true;
  return <section className="home-royalty-card" aria-label={t('Оплата роялти', 'Royalty ödemesi')}>
    <div className="home-royalty-card-details">
      <strong>{t(`Роялти · ${period}`, `Royalty · ${period}`)} · {formatMoneyShort(status.amount_minor, status.currency, locale)}</strong>
      <p className="faint">{t('Оплатите роялти до 5-го числа включительно.', 'Royalty ödemesini ayın 5’i dâhil yapın.')}</p>
      {overdue && <p className="danger-text">{t('Вы просрочили оплату роялти. Оплатите, чтобы избежать санкций.',
        'Royalty ödemeniz gecikti. Yaptırımları önlemek için ödeme yapın.')}</p>}
      {checking && <p className="faint">{t('Проверяем платёж.', 'Ödeme kontrol ediliyor.')}</p>}
    </div>
    <Button size="sm" variant="primary" disabled={busy} onClick={onAction}>
      {checking ? t('Проверить статус', 'Durumu kontrol et') : t('Оплатить', 'Öde')}
    </Button>
    <ActionError error={error} />
  </section>;
}

export function RoyaltyHome({ viewerId, partnerId }: { viewerId: string; partnerId: string }) {
  const { t } = useLocale();
  const qc = useQueryClient();
  const [requestedMonth, setRequestedMonth] = useState<string | null>(null);
  const queryKey = ['royalty', 'home', viewerId, partnerId] as const;
  const status = useQuery({
    queryKey,
    queryFn: () => command<RoyaltyHomeState>('royalty_home_status'),
    refetchInterval: requestedMonth ? 1_000 : 60_000,
    staleTime: 15_000,
  });
  const checkout = useMutation({
    mutationFn: () => command<RoyaltyHomeState>('royalty_checkout_request'),
    onSuccess: (result) => {
      qc.setQueryData(queryKey, result);
      if (['payable', 'overdue', 'checking'].includes(result.state)) setRequestedMonth(result.month);
    },
  });

  useEffect(() => {
    if (!requestedMonth) return;
    const timer = window.setTimeout(() => setRequestedMonth(null), 25_000);
    return () => window.clearTimeout(timer);
  }, [requestedMonth]);

  const data = status.data;
  useEffect(() => {
    if (!requestedMonth || status.isError || !data) return;
    if (data.month !== requestedMonth || !['payable', 'overdue', 'checking'].includes(data.state)) {
      setRequestedMonth(null);
      return;
    }
    if (data.state === 'checking') return;
    const link = trustedRoyaltyCheckout(data.checkout_url);
    setRequestedMonth(null);
    if (link) window.location.assign(link);
  }, [data, requestedMonth, status.isError]);

  if (status.isError) {
    return <Alert title={t('Не удалось проверить роялти', 'Royalty doğrulanamadı')}
      action={<Button size="sm" onClick={() => void status.refetch()}>{t('Повторить', 'Yeniden dene')}</Button>} />;
  }
  if (!data) return null;
  return <RoyaltyHomeCard status={data} busy={checkout.isPending || Boolean(requestedMonth) || status.isFetching}
    error={checkout.error} onAction={() => {
      if (data.state === 'checking' || data.state === 'unavailable') {
        void status.refetch();
        return;
      }
      if (data.state === 'payable' || data.state === 'overdue') checkout.mutate();
    }} />;
}
