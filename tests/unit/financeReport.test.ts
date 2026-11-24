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
  it('keeps payment methods, recorded articles and accrued payroll visible as children of totals', () => {
    const rows = financeReportRows({ month: '2026-11-01', revenue_minor: 20000, return_minor: 1000,
      cash_minor: 8000, card_minor: 7000, payroll_minor: 4000, payroll_halves: [1000, 3000],
      royalty_minor: 1400, expenses_minor: 4500, net_minor: 9100 },
    [{ category: 'Аренда', amount_minor: 3000, recurring: true },
      { category: 'Аренда', amount_minor: 1000 }, { category: 'Нестандартная статья', amount_minor: 500, recurring: true }]);
    expect(rows.map(({ label, minor, indent }) => [label, minor, indent])).toEqual([
      ['Выручка', 20000n, 0], ['Наличные', 8000n, 1], ['Карта', 7000n, 1], ['Способ оплаты не указан', 5000n, 1],
      ['Возвраты покупателям', -1000n, 1], ['Выручка после возвратов', 19000n, 0],
      ['Всего расходов', -9900n, 0], ['Начисленная зарплата', -4000n, 1],
      [expect.stringMatching(/1.*15.*ноя.*16.*ноя/i), -1000n, 2],
      [expect.stringMatching(/16.*30.*ноя.*1.*дек/i), -3000n, 2],
      ['Роялти по ставке', -1400n, 1], ['Внесённые расходы', -4500n, 1],
      ['Аренда', -4000n, 2], ['Нестандартная статья', -500n, 2],
      ['Остаток по внесённым данным', 9100n, 0],
    ]);
    expect(rows.find(row => row.label === 'Аренда')?.detail).toBe('Есть регулярные');
    expect(rows.find(row => row.label === 'Нестандартная статья')?.detail).toBe('Регулярные');
  });

  it('labels unclassified historic revenue without fabricating cash or card for inconsistent data', () => {
    const totals = { revenue_minor: 1000, payroll_minor: 0, royalty_minor: 0, expenses_minor: 0, net_minor: 1000 };
    for (const sales of [totals, { ...totals, cash_minor: 700, card_minor: 400 }]) {
      const methods = financeReportRows(sales, [], { language: 'tr' }).slice(0, 2);
      expect(methods.map(row => [row.label, row.minor])).toEqual([
        ['Satış geliri', 1000n], ['Ödeme türü belirtilmemiş', 1000n],
      ]);
    }
  });
  it('groups recorded expense categories without counting them twice in total expenses', () => {
    const rows = financeReportRows({ revenue_minor: 20000, payroll_minor: 4000, royalty_minor: 1400, expenses_minor: 4500, net_minor: 10100 }, [
      { category: 'Реклама', amount_minor: 1500 },
      { category: 'Аренда', amount_minor: 1000 },
      { category: 'Аренда', amount_minor: 2000 },
    ]);
    expect(rows.map(({ label, minor, indent }) => [label, minor, indent])).toEqual([
      ['Выручка', 20000n, 0],
      ['Способ оплаты не указан', 20000n, 1],
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
    expect(rows).toHaveLength(7);
    expect(rows.at(-1)?.minor).toBe(-535n);
  });

  it('shows the two payment periods in December without counting payroll twice', () => {
    const totals = { month: '2026-12-01', revenue_minor: 12000, payroll_minor: 5000, payroll_halves: [1800, 3200] as const,
      royalty_minor: 0, expenses_minor: 0, net_minor: 7000 };
    const rows = financeReportRows(totals, []);
    expect(rows.slice(3, 6).map(({ label, minor, indent }) => [label, minor, indent])).toEqual([
      ['Начисленная зарплата', -5000n, 1],
      [expect.stringMatching(/1.*15.*дек.*16.*дек/i), -1800n, 2],
      [expect.stringMatching(/16.*31.*дек.*1.*янв/i), -3200n, 2],
    ]);
    expect(rows[2].minor).toBe(-5000n);
    expect(rows.at(-1)?.minor).toBe(7000n);
  });

  it('shows retail returns among sales figures and keeps royalty and payroll amounts intact', () => {
    const rows = financeReportRows({ revenue_minor: 10000, return_minor: 12000, payroll_minor: 1000,
      royalty_minor: 700, expenses_minor: 0, net_minor: -3700 }, []);
    expect(rows.slice(0, 6).map(({ label, minor }) => [label, minor])).toEqual([
      ['Выручка', 10000n], ['Способ оплаты не указан', 10000n],
      ['Возвраты покупателям', -12000n], ['Выручка после возвратов', -2000n],
      ['Всего расходов', -1700n], ['Начисленная зарплата', -1000n],
    ]);
    expect(rows.at(-1)?.minor).toBe(-3700n);
  });
});

describe('daily revenue sheet', () => {
  it('keeps point, currency and payment detail and leaves amounts blank on a day off', () => {
    const sheet = revenueMonthSheet([
      { location_name: 'Первая точка', currency: 'RUB', days_off: ['2026-11-01'], days: [{
        day: '2026-11-02', cash_minor: 350, card_minor: 650, unallocated_minor: 2345,
        total_minor: 3345, return_minor: 900, comment: 'Сверено', updated_at: '2026-11-02T17:00:00Z',
        entries: [{ revision: 1, employee_id: 'qa-worker', employee_name: 'Сотрудник', cash_minor: 350, card_minor: 650, total_minor: 1000, comment: null }],
      }] },
      { location_name: 'Вторая точка', currency: 'KZT', days_off: ['2026-11-02'], days: [] },
    ]);
    const rows = sheet.data.slice(1).map((row) => row.map((cell) => typeof cell === 'object' && cell !== null ? cell.value : cell));
    expect(sheet.sheet).toBe('Выручка по дням');
    expect(rows).toEqual([
      ['01.11.2026', 'Первая точка', 'RUB', null, null, null, null, null, 'Выходной', null],
      ['02.11.2026', 'Первая точка', 'RUB', 3.5, 6.5, 23.45, 33.45, 'Сотрудник', 'Сверено', 9],
      ['02.11.2026', 'Вторая точка', 'KZT', null, null, null, null, null, 'Выходной', null],
    ]);
  });
});
