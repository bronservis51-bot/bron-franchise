import { describe, expect, it } from 'vitest';
import { financeReportRows } from '../../src/modules/finance/financeReport';

describe('monthly operating statement', () => {
  it('groups recorded expense categories without counting them twice in total expenses', () => {
    const rows = financeReportRows({ revenue_minor: 20000, payroll_minor: 4000, royalty_minor: 1400, expenses_minor: 4500, net_minor: 10100 }, [
      { category: 'Реклама', amount_minor: 1500 },
      { category: 'Аренда', amount_minor: 1000 },
      { category: 'Аренда', amount_minor: 2000 },
    ]);
    expect(rows.map(({ label, minor }) => [label, minor])).toEqual([
      ['Выручка', 20000n],
      ['Начисленная зарплата', -4000n],
      ['Роялти по ставке', -1400n],
      ['Внесённые расходы', -4500n],
      ['Аренда', -3000n],
      ['Реклама', -1500n],
      ['Всего расходов', -9900n],
      ['Остаток по внесённым данным', 10100n],
    ]);
  });

  it('keeps a recorded loss negative without inserting blank categories', () => {
    const rows = financeReportRows({ revenue_minor: 500, payroll_minor: 1000, royalty_minor: 35, expenses_minor: 0, net_minor: -535 }, []);
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)?.minor).toBe(-535n);
  });
});
