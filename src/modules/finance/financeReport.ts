import { toBigInt, type MinorInput } from '../../platform/money';

export const FINANCE_REPORT_NOTE = 'Отчёт составлен по внесённым данным. Если выручка или расходы внесены не полностью, итог изменится после их добавления.';

interface ReportTotals {
  revenue_minor: MinorInput;
  payroll_minor: MinorInput;
  royalty_minor: MinorInput;
  expenses_minor: MinorInput;
  net_minor: MinorInput;
}

export function financeReportRows(totals: ReportTotals, expenses: readonly { category: string; amount_minor: MinorInput }[]) {
  const categories = new Map<string, bigint>();
  for (const row of expenses) {
    categories.set(row.category, (categories.get(row.category) ?? 0n) + toBigInt(row.amount_minor));
  }
  const payroll = toBigInt(totals.payroll_minor);
  const royalties = toBigInt(totals.royalty_minor);
  const recordedExpenses = toBigInt(totals.expenses_minor);
  return [
    { label: 'Выручка', minor: toBigInt(totals.revenue_minor), detail: false, total: true },
    { label: 'Начисленная зарплата', minor: -payroll, detail: false, total: false },
    { label: 'Роялти по ставке', minor: -royalties, detail: false, total: false },
    { label: 'Внесённые расходы', minor: -recordedExpenses, detail: false, total: false },
    ...[...categories].sort(([a], [b]) => a.localeCompare(b, 'ru')).map(([label, amount]) => ({ label, minor: -amount, detail: true, total: false })),
    { label: 'Всего расходов', minor: -(payroll + royalties + recordedExpenses), detail: false, total: true },
    { label: 'Остаток по внесённым данным', minor: toBigInt(totals.net_minor), detail: false, total: true },
  ];
}
