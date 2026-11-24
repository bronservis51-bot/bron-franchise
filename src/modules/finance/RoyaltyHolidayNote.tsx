import { formatDate } from '../../platform/dates';
import { useLocale } from '../../platform/locale';
import { Money } from '../../ui';

export function RoyaltyHolidayNote({ currency, waived, until, accrualFrom }: { currency: string; waived?: number; until?: string | null; accrualFrom?: string | null }) {
  const { t, locale } = useLocale();
  if (!until) return null;
  return <small className="royalty-holiday-note">
    <span>{t('Каникулы · начисление с', 'Muafiyet · tahakkuk başlangıcı')} {formatDate(accrualFrom ?? until, locale)}</span>
    {Number(waived) > 0 && <span>{t('По ставке за дни каникул', 'Muafiyet günlerinin tutarı')} <s><Money minor={waived!} currency={currency} short /></s></span>}
  </small>;
}
