import { formatDate } from '../../platform/dates';
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
  cash_minor?: MinorInput;
  card_minor?: MinorInput;
  return_minor?: MinorInput;
  payroll_minor: MinorInput;
  payroll_halves?: readonly [MinorInput, MinorInput];
  payroll_pending?: number;
  royalty_minor: MinorInput;
  waived_royalty_minor?: MinorInput;
  royalty_holiday_until?: string | null;
  royalty_accrual_from?: string | null;
  expenses_minor: MinorInput;
  net_minor: MinorInput;
}

interface ReportExpense { category: string; amount_minor: MinorInput; recurring?: boolean }
interface ReportRow {
  id: string;
  label: string;
  minor: bigint;
  indent: 0 | 1 | 2;
  total: boolean;
  detail?: string;
}

export function payrollAccrualLabels(month: string, language: 'ru' | 'tr' = 'ru') {
  const locale = language === 'tr' ? 'tr-TR' : 'ru-RU';
  const payment = language === 'tr' ? 'ödeme' : 'выплата';
  return payrollPeriods(month).map(period => `${payrollPeriodLabel(period, locale)} · ${payment} ${payrollDateLabel(period.payOn, locale)}`);
}

export function financeExpensesMinor(totals: Pick<ReportTotals, 'expenses_minor' | 'royalty_minor'>) {
  return toBigInt(totals.expenses_minor) + toBigInt(totals.royalty_minor);
}

export function financeRevenueMethods(totals: Pick<ReportTotals, 'revenue_minor' | 'cash_minor' | 'card_minor'>) {
  const sales = toBigInt(totals.revenue_minor);
  const cash = toBigInt(totals.cash_minor);
  const card = toBigInt(totals.card_minor);
  if (cash < 0n || card < 0n || cash + card > sales) return { cash: 0n, card: 0n, unspecified: sales };
  return { cash, card, unspecified: sales - cash - card };
}

export function financeReportRows(totals: ReportTotals, expenses: readonly ReportExpense[],
  { language = 'ru' }: { language?: 'ru' | 'tr' } = {}): ReportRow[] {
  const t = (ru: string, tr: string) => language === 'tr' ? tr : ru;
  const categories = new Map<string, { minor: bigint; recurring: number; count: number }>();
  for (const expense of expenses) {
    const article = categories.get(expense.category) ?? { minor: 0n, recurring: 0, count: 0 };
    article.minor += toBigInt(expense.amount_minor);
    article.recurring += expense.recurring ? 1 : 0;
    article.count += 1;
    categories.set(expense.category, article);
  }
  const payroll = toBigInt(totals.payroll_minor);
  const royalties = toBigInt(totals.royalty_minor);
  const holidayUntil = totals.royalty_holiday_until;
  const recordedExpenses = toBigInt(totals.expenses_minor);
  const sales = toBigInt(totals.revenue_minor);
  const returns = toBigInt(totals.return_minor ?? 0);
  const { cash, card, unspecified } = financeRevenueMethods(totals);
  const halves = totals.payroll_halves;
  const pendingPayroll = totals.payroll_pending ?? 0;
  const payrollRows = totals.month && halves ? payrollAccrualLabels(totals.month, language).map((label, index): ReportRow => ({
    id: 'payroll-period-' + index, label, minor: -toBigInt(halves[index]), indent: 2, total: false,
  })) : [];
  const methods: ReportRow[] = [
    { id: 'cash', label: t('Наличные', 'Nakit'), minor: cash, indent: 1, total: false },
    { id: 'card', label: t('Карта', 'Kart'), minor: card, indent: 1, total: false },
    { id: 'unspecified', label: t('Способ оплаты не указан', 'Ödeme türü belirtilmemiş'), minor: unspecified, indent: 1, total: false },
  ];
  return [
    { id: 'revenue', label: t('Выручка', 'Satış geliri'), minor: sales, indent: 0, total: true },
    ...methods.filter(method => method.minor > 0n),
    ...(returns > 0n ? [
      { id: 'returns', label: t('Возвраты покупателям', 'Müşteri iadeleri'), minor: -returns, indent: 1, total: false },
      { id: 'revenue-after-returns', label: t('Выручка после возвратов', 'İadeler sonrası gelir'), minor: sales - returns, indent: 0, total: true },
    ] satisfies ReportRow[] : []),
    { id: 'expenses', label: t('Всего расходов', 'Toplam gider'), minor: -(payroll + financeExpensesMinor(totals)), indent: 0, total: true },
    { id: 'payroll', label: t('Начисленная зарплата', 'Tahakkuk eden maaş'), minor: -payroll, indent: 1, total: false,
      detail: pendingPayroll > 0 ? t(`Смен ждут подтверждения: ${pendingPayroll}`, `Onay bekleyen vardiya: ${pendingPayroll}`) : undefined },
    ...payrollRows,
    ...(!holidayUntil || royalties !== 0n ? [
      { id: 'royalty', label: t('Роялти по ставке', 'Orana göre royalty'), minor: -royalties, indent: 1, total: false },
    ] satisfies ReportRow[] : []),
    { id: 'recorded-expenses', label: t('Внесённые расходы', 'Kaydedilen giderler'), minor: -recordedExpenses, indent: 1, total: false },
    ...[...categories].sort(([a], [b]) => a.localeCompare(b, language)).map(([label, article]): ReportRow => ({
      id: 'article:' + label, label, minor: -article.minor, indent: 2, total: false,
      detail: !article.recurring ? undefined : article.recurring === article.count
        ? t('Регулярные', 'Düzenli') : t('Есть регулярные', 'Bazıları düzenli'),
    })),
    { id: 'result', label: pendingPayroll > 0 ? t('Предварительный остаток', 'Geçici sonuç') : t('Остаток по внесённым данным', 'Kayıtlara göre sonuç'),
      minor: toBigInt(totals.net_minor), indent: 0, total: true },
    ...(holidayUntil ? [{
      id: 'royalty-holiday', label: t('Роялти за дни каникул · справочно', 'Muafiyet günlerinin royalty tutarı · bilgi amaçlı'),
      minor: toBigInt(totals.waived_royalty_minor), indent: 0, total: false,
      detail: `${t('Начисление с', 'Tahakkuk başlangıcı')} ${formatDate(totals.royalty_accrual_from ?? holidayUntil, language === 'tr' ? 'tr-TR' : 'ru-RU')}`,
    }] satisfies ReportRow[] : []),
  ];
}
