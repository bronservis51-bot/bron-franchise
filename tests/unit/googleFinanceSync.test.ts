import { describe, expect, it } from 'vitest';
// @ts-expect-error operational JavaScript module
import { buildGoogleReports, checkReportPermissions, reportSheetRequests } from '../../scripts/google-finance-lib.mjs';

const internalId = 'internal_test_workbook_00000000';
const partnerId = 'partner_test_workbook_00000000';
const alpha = '5635029a-b443-4c5a-8b43-80127fed6e41';
const other = 'c91d188c-a62b-4034-96c4-7bf4eb7f88f2';
const permissions = [{ id: 'owner-1', role: 'owner' }, { id: 'service-1', role: 'writer' }];
const books = [{ spreadsheetId: internalId, permissions }, { spreadsheetId: partnerId, partnerId: alpha, permissions }];
const asOf = '2026-11-20T12:00:00.000Z';
const record = {
  partner_id: alpha, partner: 'Точка — партнёр', point_id: null, point: null, month: '2026-11-01', day: null,
  currency: 'RUB', minor_unit: 2, kind: 'revenue', key: 'one', category: null, amount: '15000', cash: '5000', card: '10000',
};

describe('automatic Google financial reports', () => {
  it('keeps partner routing and currencies separate, and excludes payments from operating income', () => {
    const reports = buildGoogleReports(books, [
      record,
      { ...record, key: 'two', kind: 'royalty', amount: '1050', cash: null, card: null },
      { ...record, key: 'three', kind: 'royalty_payment', amount: '1000', cash: null, card: null },
      { ...record, key: 'four', partner_id: other, partner: 'Другой партнёр', currency: 'KZT', amount: '16000' },
    ], asOf);
    expect(reports[0].sheets[0].rows[3]).toEqual(['2026-11', 'Точка — партнёр', 'RUB', null, 150, null, null, 10.5, null, 10, 139.5, null, null, null]);
    expect(reports[0].sheets[0].rows[4][2]).toBe('KZT');
    expect(reports[1].sheets[1].rows).toHaveLength(4);
    expect(JSON.stringify(reports[1])).not.toContain('Другой партнёр');
  });

  it('exports retail returns as operations and subtracts them once from the balance', () => {
    const report = buildGoogleReports([books[0]], [record,
      { ...record, key: 'refund', kind: 'return', amount: '20000', cash: null, card: null },
      { ...record, key: 'royalty', kind: 'royalty', amount: '1050', cash: null, card: null },
      { ...record, key: 'debt', kind: 'royalty_past_debt', amount: '40000', cash: null, card: null },
    ], asOf)[0];
    expect(report.sheets[0].rows[3]).toEqual(['2026-11', 'Точка — партнёр', 'RUB', null, 150, null, null, 10.5, null, null, -60.5, 200, 400, null]);
    expect(report.sheets[1].rows[2].slice(5, 8)).toEqual(['Возврат покупателю', null, 200]);
  });

  it('labels the monthly balance when some automatic shifts still need confirmation', () => {
    const [report] = buildGoogleReports([books[0]], [record, {
      ...record, key: 'payroll', kind: 'payroll', category: 'Смены на подтверждение', amount: '1200', cash: null, card: null,
    }], asOf);
    expect(report.sheets[0].rows[3][10]).toBe(138);
    expect(report.sheets[0].rows[3].at(-1)).toBe('Зарплата рассчитана частично');
  });

  it('groups debt and payments without a period separately, preserving amounts and known bank dates', () => {
    const unperiodized = { ...record, month: null, cash: null, card: null };
    const payment = { ...unperiodized, key: 'settlement', kind: 'royalty_payment',
      category: 'Оплата подтверждена без даты', amount: '13000' };
    const report = buildGoogleReports([books[0]], [
      record, { ...payment, key: 'periodized', month: record.month, amount: '2500' },
      { ...unperiodized, key: 'older-debt', kind: 'royalty_past_debt', amount: '9500' },
      payment, { ...payment, key: 'bank-payment', category: null, day: '2026-11-14', amount: '400' },
      { ...payment, key: 'other', partner: 'Другой', partner_id: other, amount: '300' },
      { ...payment, key: 'currency', currency: 'KZT', amount: '500' },
    ], asOf)[0];
    expect(report.sheets[0].rows.slice(3)).toEqual([
      ['2026-11', record.partner, 'RUB', null, 150, null, null, null, null, 25, 150, null, null, null],
      ['Без периода', record.partner, 'RUB', null, null, null, null, null, null, 134, null, null, 95, null],
      ['Без периода', 'Другой', 'RUB', null, null, null, null, null, null, 3, null, null, null, null],
      ['Без периода', record.partner, 'KZT', null, null, null, null, null, null, 5, null, null, null, null],
    ]);
    const entries = report.sheets[1].rows;
    expect(entries[2].slice(0, 2)).toEqual(['2026-11', null]);
    expect(entries[4]).toEqual(['Без периода', null, record.partner, null, 'RUB', 'Оплата роялти',
      payment.category, 130, null, null, 'settlement']);
    expect(entries[5].slice(0, 2)).toEqual(['Без периода', '2026-11-14']);
  });

  it('rejects using the same workbook for network and partner data', () => {
    expect(() => buildGoogleReports([books[0], { ...books[1], spreadsheetId: internalId }], [], asOf)).toThrow();
    expect(() => buildGoogleReports([books[0], { ...books[1], spreadsheetId: [internalId] }], [], asOf)).toThrow();
  });

  it('stops before writing if an unrelated named account can see the workbook', () => {
    const actual = permissions.map(permission => ({ ...permission, type: 'user' }));
    expect(() => checkReportPermissions(permissions, actual)).not.toThrow();
    expect(() => checkReportPermissions(permissions, [...actual, { id: 'unknown', type: 'user', role: 'reader' }])).toThrow();
    expect(() => checkReportPermissions(permissions, [actual[0], { ...actual[1], role: 'reader' }])).toThrow();
  });

  it('leaves unrelated tabs alone and rejects overwriting one with the reserved title', () => {
    const report = buildGoogleReports([books[0]], [record], asOf)[0];
    const sheet = { properties: { sheetId: 31, title: 'Выручка', gridProperties: { rowCount: 100, columnCount: 20 } } };
    const requests = reportSheetRequests(report, [sheet]);
    expect(requests.filter((x: {addSheet?: unknown}) => x.addSheet)).toHaveLength(2);
    expect(requests.some((x: {updateCells?: {range: {sheetId: number}}}) => x.updateCells?.range.sheetId === 31)).toBe(false);
    expect(() => reportSheetRequests(report, [{ ...sheet, properties: { ...sheet.properties, title: report.sheets[0].title } }])).toThrow();
  });
});
