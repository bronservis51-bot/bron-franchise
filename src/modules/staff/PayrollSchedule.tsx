import type { MinorInput } from '../../platform/money';
import { useLocale } from '../../platform/locale';
import { Money } from '../../ui';
import { payrollDateLabel, payrollPeriodLabel, payrollPeriods } from './payrollPeriods';
import './payroll-periods.css';

export function PayrollSchedule({ month, amounts, currency }: {
  month: string;
  amounts: readonly [MinorInput, MinorInput];
  currency: string;
}) {
  const { t, locale } = useLocale();
  return <dl className="payroll-schedule" aria-label={t('Начисления по графику выплат', 'Ödeme takvimine göre kazanç')}>
    {payrollPeriods(month).map((period, index) => (
      <div key={period.from} className="payroll-schedule-period">
        <dt>
          <strong>{payrollPeriodLabel(period, locale)}</strong>
          <span className="faint">{t('По графику', 'Ödeme tarihi')} <time dateTime={period.payOn}>{payrollDateLabel(period.payOn, locale)}</time></span>
        </dt>
        <dd><Money minor={amounts[index]} currency={currency} short strong /></dd>
      </div>
    ))}
  </dl>;
}
