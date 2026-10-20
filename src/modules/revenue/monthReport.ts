// Отчёт за месяц для своей бухгалтерии: дни (наличные, карта, итог, кто работал) и итоги — файл Excel.
import { minorToDecimal } from '../../platform/money';
import { formatDate, monthLabel } from '../../platform/dates';
import type { MonthDetail } from './api';

export async function downloadMonthReport(m: MonthDetail) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const money = (v: number) => ({ value: Number(minorToDecimal(v, m.currency)), type: Number, format: '#,##0.00' });
  const head = (value: string) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC' });
  const days = [...m.days].sort((a, b) => a.day.localeCompare(b.day));
  const data = [
    [{ value: `${m.location_name} — выручка за ${monthLabel(m.month)}`, fontWeight: 'bold' as const, fontSize: 14 }],
    [],
    ['Дата', 'Наличные', 'Карта', 'Итого', 'Кто работал', 'Комментарий'].map(head),
    ...days.map((d) => [formatDate(d.day), money(d.cash_minor), money(d.card_minor), money(d.total_minor),
      d.entries.map((e) => e.employee_name ?? 'франчайзи').join(', '), d.comment ?? '']),
    [],
    [{ value: 'Итого', fontWeight: 'bold' as const }, money(m.cash_minor), money(m.card_minor), { ...money(m.fact_minor), fontWeight: 'bold' as const }],
    ...(m.plan_minor ? [['План', null, null, money(m.plan_minor)], ['Выполнение', null, null, { value: (m.pct ?? 0) / 100, type: Number, format: '0.0%' }]] : []),
  ];
  await writeXlsxFile(data, { sheet: 'Выручка', columns: [{ width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 24 }, { width: 30 }] })
    .toFile(`vyruchka-${m.location_name.replace(/\s+/g, '-')}-${m.month.slice(0, 7)}.xlsx`);
}
