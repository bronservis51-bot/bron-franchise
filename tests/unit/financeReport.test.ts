import { describe, expect, it, vi } from 'vitest';
import { downloadFinanceFile, financeReportRows } from '../../src/modules/finance/financeReport';
import { revenueMonthSheet } from '../../src/modules/revenue/monthReport';

it('не начинает скачивание, если отчёт завершился после закрытия', async () => {
  const request = new AbortController();
  const createElement = vi.fn();
  vi.stubGlobal('document', { createElement });
  try {
    let finish!: (file: File) => void;
    const pending = downloadFinanceFile(() => new Promise(resolve => { finish = resolve; }), request.signal);
    request.abort();
    finish(new File(['test'], 'finansy.xlsx'));
    await pending;
    expect(createElement).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('monthly operating statement', () => {
  it('groups recorded expense categories without counting them twice in total expenses', () => {
    const rows = financeReportRows({ revenue_minor: 20000, payroll_minor: 4000, royalty_minor: 1400, expenses_minor: 4500, net_minor: 10100 }, [
      { category: 'Реклама', amount_minor: 1500 },
      { category: 'Аренда', amount_minor: 1000 },
      { category: 'Аренда', amount_minor: 2000 },
    ]);
    expect(rows.map(({ label, minor, indent }) => [label, minor, indent])).toEqual([
      ['Выручка', 20000n, 0],
      ['Всего расходов', -9900n, 0],
      ['Начисленная зарплата', -4000n, 1],
      ['Роялти по ставке', -1400n, 1],
      ['Внесённые расходы', -4500n, 1],
      ['Аренда', -3000n, 2],
      ['Реклама', -1500n, 2],
      ['Остаток по внесённым данным', 10100n, 0],
    ]);
  });

  it('keeps a recorded loss negative without inserting blank categories', () => {
    const rows = financeReportRows({ revenue_minor: 500, payroll_minor: 1000, royalty_minor: 35, expenses_minor: 0, net_minor: -535 }, []);
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)?.minor).toBe(-535n);
  });
});

describe('daily revenue sheet', () => {
  it('keeps point, currency and payment detail and leaves amounts blank on a day off', () => {
    const sheet = revenueMonthSheet([
      { location_name: 'Первая точка', currency: 'RUB', days_off: ['2026-11-01'], days: [{
        day: '2026-11-02', cash_minor: 350, card_minor: 650, unallocated_minor: 2345,
        total_minor: 3345, comment: 'Сверено', updated_at: '2026-11-02T17:00:00Z',
        entries: [{ revision: 1, employee_id: 'qa-worker', employee_name: 'Сотрудник', cash_minor: 350, card_minor: 650, total_minor: 1000, comment: null }],
      }] },
      { location_name: 'Вторая точка', currency: 'KZT', days_off: ['2026-11-02'], days: [] },
    ]);
    const rows = sheet.data.slice(1).map((row) => row.map((cell) => typeof cell === 'object' && cell !== null ? cell.value : cell));
    expect(sheet.sheet).toBe('Выручка по дням');
    expect(rows).toEqual([
      ['01.11.2026', 'Первая точка', 'RUB', null, null, null, null, null, 'Выходной'],
      ['02.11.2026', 'Первая точка', 'RUB', 3.5, 6.5, 23.45, 33.45, 'Сотрудник', 'Сверено'],
      ['02.11.2026', 'Вторая точка', 'KZT', null, null, null, null, null, 'Выходной'],
    ]);
  });
});
