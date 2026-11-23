import { formatDate } from '../../platform/dates';
import { minorToDecimal } from '../../platform/money';
import type { MonthDetail } from './api';

type LocationDays = Pick<MonthDetail, 'location_name' | 'currency' | 'days' | 'days_off'>;

export function revenueMonthSheet(points: LocationDays[]) {
  const headings = ['Дата', 'Точка', 'Валюта', 'Наличные', 'Карта', 'Без разбивки', 'Итого', 'Кто работал', 'Комментарий', 'Возвраты'];
  return {
    sheet: 'Выручка по дням',
    columns: [14, 26, 12, 14, 14, 16, 14, 24, 30, 14].map((width) => ({ width })),
    data: [
      headings.map((value) => ({ value, fontWeight: 'bold' as const, backgroundColor: '#E9E9EC' })),
      ...points.flatMap((point) => {
        const days = new Map(point.days.map((day) => [day.day, day]));
        const dates = [...new Set([...days.keys(), ...(point.days_off ?? [])])].sort();
        const money = (minor: number) => ({ value: Number(minorToDecimal(minor, point.currency)), type: Number, format: '#,##0.00' });
        return dates.map((date) => {
          const label = [formatDate(date), point.location_name, point.currency];
          const day = days.get(date);
          if (!day) return [...label, null, null, null, null, null, 'Выходной', null];
          return [...label, money(day.cash_minor), money(day.card_minor), money(day.unallocated_minor ?? 0), money(day.total_minor),
            day.entries.map((entry) => entry.employee_name ?? 'франчайзи').join(', '), day.comment ?? '', money(day.return_minor ?? 0)];
        });
      }),
    ],
  };
}
