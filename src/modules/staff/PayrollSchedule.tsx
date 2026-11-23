import type { MinorInput } from '../../platform/money';
import { Money } from '../../ui';
import { payrollDateLabel, payrollPeriodLabel, payrollPeriods } from './payrollPeriods';
import './payroll-periods.css';

export function PayrollSchedule({ month, amounts, currency }: {
  month: string;
  amounts: readonly [MinorInput, MinorInput];
  currency: string;
}) {
  return <dl className="payroll-schedule" aria-label="Начисления по графику выплат">
    {payrollPeriods(month).map((period, index) => (
      <div key={period.from} className="payroll-schedule-period">
        <dt>
          <strong>{payrollPeriodLabel(period)}</strong>
          <span className="faint">По графику <time dateTime={period.payOn}>{payrollDateLabel(period.payOn)}</time></span>
        </dt>
        <dd><Money minor={amounts[index]} currency={currency} short strong /></dd>
      </div>
    ))}
  </dl>;
}
