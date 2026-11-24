import { useLocale } from '../../platform/locale';
import { formatMoneyShort } from '../../platform/money';
import type { DayRow } from './api';

export function RevenueBreakdown({ row, currency }: {
  row: Pick<DayRow, 'cash_minor' | 'card_minor' | 'unallocated_minor'>; currency: string;
}) {
  const { t, locale } = useLocale();
  const money = (minor: number) => formatMoneyShort(minor, currency, locale);
  const unknown = Number(row.unallocated_minor ?? 0);
  if (unknown > 0 && !Number(row.cash_minor) && !Number(row.card_minor)) {
    return <>{t('Без разбивки', 'Belirtilmemiş')} {money(unknown)}</>;
  }
  return <>
    {t('Наличные', 'Nakit')} {money(row.cash_minor)} · {t('Карта', 'Kart')} {money(row.card_minor)}
    {unknown > 0 && <> · {t('Без разбивки', 'Belirtilmemiş')} {money(unknown)}</>}
  </>;
}

export function hasPaymentDiscrepancy(row?: DayRow) {
  return row?.reported_cash_minor != null && row.reported_card_minor != null
    && (Number(row.cash_minor) > Number(row.reported_cash_minor) || Number(row.card_minor) > Number(row.reported_card_minor));
}
