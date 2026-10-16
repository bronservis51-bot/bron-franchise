// Выгрузка сводной таблицы роялти в Excel (.xlsx) прямо в браузере: лист «Сводка» и лист «Долги по месяцам».
import { minorToDecimal } from '../../platform/money';
import { formatDate, monthLabel } from '../../platform/dates';
import type { RoyaltySummary } from './api';

const money = (minor: number, currency: string) => ({ value: Number(minorToDecimal(minor, currency)), type: Number, format: '#,##0.00' });
const head = (value: string) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC', wrap: true });

export async function downloadRoyaltyExcel(s: RoyaltySummary) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const period = s.month ? `за ${monthLabel(s.month)}` : `весь долг на ${formatDate(new Date().toISOString())}`;
  const header = ['Франчайзи', 'Страна', 'Валюта', 'Ставка, %', 'Выручка', 'Начислено', 'Прошлый долг', 'Оплачено', 'Долг',
    ...(s.month ? [] : ['Текущий месяц: начисляется', 'Месяцев с долгом']), 'Последняя оплата'].map(head);
  const rows = s.rows.map((r) => [
    r.partner_name, r.country, r.currency, { value: r.rate_bp / 100, type: Number, format: '0.0#' },
    money(r.revenue_minor, r.currency), money(r.accrued_minor, r.currency), money(r.manual_minor, r.currency),
    money(r.paid_minor, r.currency), { ...money(r.debt_minor, r.currency), fontWeight: r.debt_minor > 0 ? ('bold' as const) : undefined },
    ...(s.month ? [] : [money(r.current_accrual_minor, r.currency), { value: r.debt_months.length, type: Number }]),
    r.last_payment_on ? formatDate(r.last_payment_on) : '—',
  ]);
  const blank = (n: number) => Array.from({ length: n }, () => null);
  const totals = s.totals.map((t) => [
    { value: `Итого, ${t.currency}`, fontWeight: 'bold' as const }, null, t.currency, null, null,
    money(t.accrued_minor, t.currency), null, money(t.paid_minor, t.currency), { ...money(t.debt_minor, t.currency), fontWeight: 'bold' as const },
    ...blank(s.month ? 1 : 3),
  ]);
  const summary = [
    [{ value: `Роялти франчайзи — ${period}`, fontWeight: 'bold' as const, fontSize: 14 }],
    [],
    header,
    ...rows,
    [],
    ...totals,
    ...(s.debt_rub_minor !== null ? [[{ value: 'Весь долг в рублях (по курсу)', fontWeight: 'bold' as const }, ...blank(7), money(s.debt_rub_minor, 'RUB')]] : []),
  ];
  const byMonth = [
    ['Франчайзи', 'Валюта', 'Месяц', 'Долг'].map(head),
    ...s.rows.flatMap((r) => r.debt_months.map((d) => [r.partner_name, r.currency, monthLabel(d.month), money(d.debt_minor, r.currency)])),
  ];
  const width = [28, 9, 8, 9, 14, 14, 14, 14, 14, 16, 12, 14].map((w) => ({ width: w }));
  await writeXlsxFile([
    { data: summary, sheet: 'Сводка', columns: width, stickyRowsCount: 3 },
    { data: byMonth, sheet: 'Долги по месяцам', columns: [{ width: 28 }, { width: 9 }, { width: 16 }, { width: 14 }], stickyRowsCount: 1 },
  ]).toFile(`royalty-${s.month ? s.month.slice(0, 7) : 'dolg'}-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
