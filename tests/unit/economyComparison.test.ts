import { expect, it } from 'vitest';
import { economyComparison, networkSpreadsheetLink } from '../../src/modules/manager/economyComparison';

it('compares each franchisee once and keeps retail currencies separate', () => {
  const franchisee = { partner_id: 'alpha', partner_name: 'Альфа' };
  const [row] = economyComparison({
    points: [
      { ...franchisee, currency: 'RUB', fact_minor: 10000, missing_days: ['2026-11-01'] },
      { ...franchisee, currency: 'KZT', fact_minor: 50000, missing_days: ['2026-11-02'] },
      { ...franchisee, currency: 'RUB', fact_minor: 1500, missing_days: [] },
    ],
    salaries: [{ ...franchisee, currency: 'RUB', payroll_minor: 2000, payroll_halves: [500, 1500], closed_shifts: 2, expenses_minor: 0, expense_categories: [] }],
    royalties: [{ ...franchisee, currency: 'RUB', accrued_minor: 400, manual_minor: 25, paid_minor: 100, debt_minor: 325, is_open: false }],
    supplies: [{ ...franchisee, mapped_count: 1, counterparties: [], sales_minor: 100, cost_minor: 70, profit_minor: 30 }],
  });
  expect(row.retail).toEqual(new Map([['RUB', 11500n], ['KZT', 50000n]]));
  expect(row.missingDays).toBe(2);
  expect(row.salaries?.payroll_halves).toEqual([500, 1500]);
  expect(row.royalty?.debt_minor).toBe(325);
  expect(row.supply?.profit_minor).toBe(30);
});

it('links only to a direct Google spreadsheet document provided by the server', () => {
  const doc = 'https://docs.google.com/spreadsheets/d/synthetic_finance_sheet_test/edit';
  expect(networkSpreadsheetLink(doc)).toBe(doc);
  expect(networkSpreadsheetLink(null)).toBeNull();
  expect(networkSpreadsheetLink('https://docs.google.com.example.com/spreadsheets/d/synthetic_finance_sheet_test/edit')).toBeNull();
  expect(networkSpreadsheetLink(doc.replace('https:', 'http:'))).toBeNull();
  expect(networkSpreadsheetLink(doc + '?redirect=other')).toBeNull();
});

it('keeps finance available with no supply snapshot and distinguishes missing retail from a zero sum', () => {
  const rows = economyComparison({
    points: [{ partner_id: 'b', partner_name: 'Бета', currency: 'RUB', fact_minor: 0, missing_days: [] }],
    salaries: [{ partner_id: 'a', partner_name: 'Альфа', currency: 'RUB', payroll_minor: 0, closed_shifts: 0, expenses_minor: 0, expense_categories: [] }],
  });
  expect(rows.map(row => row.name)).toEqual(['Альфа', 'Бета']);
  expect(rows[0]).toMatchObject({ retail: new Map(), missingDays: null });
  expect(rows[0].supply).toBeUndefined();
  expect(rows[1]).toMatchObject({ retail: new Map([['RUB', 0n]]), missingDays: 0 });
});
