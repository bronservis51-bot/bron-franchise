import { addDays, shiftMonth } from '../../platform/dates';
import { toBigInt, type MinorInput } from '../../platform/money';

export interface PayrollPeriod {
  from: string;
  through: string;
  payOn: string;
}

export function payrollPeriods(month: string): [PayrollPeriod, PayrollPeriod] {
  const prefix = month.slice(0, 7);
  const half = `${prefix}-16`;
  const nextMonth = shiftMonth(month, 1);
  return [
    { from: `${prefix}-01`, through: `${prefix}-15`, payOn: half },
    { from: half, through: addDays(nextMonth, -1), payOn: nextMonth },
  ];
}

export function payrollDateLabel(day: string, locale = 'ru-RU') {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function payrollPeriodLabel(period: PayrollPeriod, locale = 'ru-RU') {
  return `${Number(period.from.slice(-2))}–${payrollDateLabel(period.through, locale)}`;
}

export function splitPayroll(month: string, shifts: readonly { day: string; earned_minor: MinorInput | null; status?: 'open' | 'closed' }[]) {
  const [first, second] = payrollPeriods(month);
  const totals: [bigint, bigint] = [0n, 0n];
  for (const shift of shifts) {
    if (shift.status === 'open' || shift.day < first.from || shift.day > second.through) continue;
    const half = shift.day < second.from ? 0 : 1;
    totals[half] += toBigInt(shift.earned_minor ?? 0);
  }
  return totals;
}
