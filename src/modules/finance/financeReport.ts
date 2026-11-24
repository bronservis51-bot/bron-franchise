import { toBigInt, type MinorInput } from '../../platform/money';
import { payrollDateLabel, payrollPeriodLabel, payrollPeriods } from '../staff/payrollPeriods';

export const FINANCE_REPORT_NOTE = 'Отчёт составлен по внесённым данным. Если выручка или расходы внесены не полностью, итог изменится после их добавления.';
export const FINANCE_PAYROLL_NOTE = 'Зарплата начислена по закрытым сменам. Даты выплат указаны по графику.';

export async function downloadFinanceFile(makeFile: () => Promise<File>, signal: AbortSignal) {
  const file = await makeFile();
  if (signal.aborted) return;
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ReportTotals {
  month?: string;
  revenue_minor: MinorInput;
  return_minor?: MinorInput;
  payroll_minor: MinorInput;
  payroll_halves?: readonly [MinorInput, MinorInput];
  royalty_minor: MinorInput;
  expenses_minor: MinorInput;
  net_minor: MinorInput;
}

export function payrollAccrualLabels(month: string, language: 'ru' | 'tr' = 'ru') {
  const locale = language === 'tr' ? 'tr-TR' : 'ru-RU';
  const payment = language === 'tr' ? 'ödeme' : 'выплата';
  return payrollPeriods(month).map(period => `${payrollPeriodLabel(period, locale)} · ${payment} ${payrollDateLabel(period.payOn, locale)}`);
}

export function financeExpensesMinor(totals: Pick<ReportTotals, 'expenses_minor' | 'royalty_minor'>) {
  return toBigInt(totals.expenses_minor) + toBigInt(totals.royalty_minor);
}

export function financeReportRows(totals: ReportTotals, expenses: readonly { category: string; amount_minor: MinorInput }[],
  { compact = false, language = 'ru' }: { compact?: boolean; language?: 'ru' | 'tr' } = {}) {
  const t = (ru: string, tr: string) => language === 'tr' ? tr : ru;
  const categories = new Map<string, bigint>();
  for (const row of compact ? [] : expenses) {
    categories.set(row.category, (categories.get(row.category) ?? 0n) + toBigInt(row.amount_minor));
  }
  const payroll = toBigInt(totals.payroll_minor);
  const royalties = toBigInt(totals.royalty_minor);
  const recordedExpenses = toBigInt(totals.expenses_minor);
  const sales = toBigInt(totals.revenue_minor);
  const returns = toBigInt(totals.return_minor ?? 0);
  const halves = totals.payroll_halves;
  const payrollRows = !compact && totals.month && halves ? payrollAccrualLabels(totals.month, language).map((label, index) => ({
    label, minor: -toBigInt(halves[index]), indent: 2, total: false,
  })) : [];
  return [
    { label: t('Выручка', 'Satış geliri'), minor: sales, indent: 0, total: true },
    ...(returns > 0n ? [
      { label: t('Возвраты покупателям', 'Müşteri iadeleri'), minor: -returns, indent: 1, total: false },
      ...(!compact ? [{ label: t('Выручка после возвратов', 'İadeler sonrası gelir'), minor: sales - returns, indent: 0, total: true }] : []),
    ] : []),
    ...(!compact ? [{ label: t('Всего расходов', 'Toplam gider'), minor: -(payroll + financeExpensesMinor(totals)), indent: 0, total: true }] : []),
    { label: t('Начисленная зарплата', 'Tahakkuk eden maaş'), minor: -payroll, indent: 1, total: false },
    ...payrollRows,
    { label: t('Роялти по ставке', 'Orana göre royalty'), minor: -royalties, indent: 1, total: false },
    { label: t('Внесённые расходы', 'Kaydedilen giderler'), minor: -recordedExpenses, indent: 1, total: false },
    ...[...categories].sort(([a], [b]) => a.localeCompare(b, language)).map(([label, amount]) => ({ label, minor: -amount, indent: 2, total: false })),
    { label: t('Остаток по внесённым данным', 'Kayıtlara göre sonuç'), minor: toBigInt(totals.net_minor), indent: 0, total: true },
  ];
}
