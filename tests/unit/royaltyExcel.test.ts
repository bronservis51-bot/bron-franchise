// Выгрузка роялти в Excel: в сводке все франчайзи, суммы — числа в основной валюте, итоги по валютам.
import { describe, expect, it, vi } from 'vitest';
import type { RoyaltySummary } from '../../src/modules/manager/api';

const calls: unknown[][] = [];
vi.mock('write-excel-file/browser', () => ({
  default: (...args: unknown[]) => { calls.push(args); return { toFile: async () => undefined, toBlob: async () => new Blob() }; },
}));

const summary: RoyaltySummary = {
  month: null, current_month: '2026-10-01', debt_rub_minor: 1000000,
  totals: [{ currency: 'RUB', accrued_minor: 700000, paid_minor: 200000, debt_minor: 500000 }],
  rows: [
    { partner_id: 'a', partner_name: 'Виктор', status: 'active', country: 'RU', currency: 'RUB', rate_bp: 700, revenue_minor: 10000000,
      accrued_minor: 700000, manual_minor: 0, paid_minor: 200000, debt_minor: 500000, is_open: false, current_revenue_minor: 0,
      current_accrual_minor: 12345, debt_months: [{ month: '2026-09-01', debt_minor: 500000 }], last_payment_on: '2026-09-05', fx_rub: 1 },
    { partner_id: 'b', partner_name: 'Без долга', status: 'active', country: 'RU', currency: 'RUB', rate_bp: 700, revenue_minor: 0,
      accrued_minor: 0, manual_minor: 0, paid_minor: 0, debt_minor: 0, is_open: false, current_revenue_minor: 0,
      current_accrual_minor: 0, debt_months: [], last_payment_on: null, fx_rub: 1 },
  ],
};

describe('выгрузка роялти в Excel', () => {
  it('два листа; в сводке все франчайзи; долг — число в рублях, не в копейках', async () => {
    const { downloadRoyaltyExcel } = await import('../../src/modules/manager/royaltyExcel');
    await downloadRoyaltyExcel(summary);
    const sheets = calls[0][0] as { sheet: string; data: unknown[][] }[];
    expect(sheets.map((s) => s.sheet)).toEqual(['Сводка', 'Долги по месяцам']);
    const rows = sheets[0].data.filter((r) => r.length && typeof r[0] === 'string');
    expect(rows.map((r) => r[0])).toEqual(['Виктор', 'Без долга']);
    expect((rows[0][8] as { value: number }).value).toBe(5000);
    expect(sheets[1].data).toHaveLength(2); // заголовок + один месяц с долгом
  });
});
