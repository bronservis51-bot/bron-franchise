import { describe, expect, it } from 'vitest';
import { payrollDateLabel, payrollPeriodLabel, payrollPeriods, splitPayroll } from '../../src/modules/staff/payrollPeriods';

describe('3.7 payroll dates and accruals', () => {
  it('uses both inclusive halves and rolls the second payment into the next year', () => {
    const periods = payrollPeriods('2026-12-01');
    expect(periods).toEqual([
      { from: '2026-12-01', through: '2026-12-15', payOn: '2026-12-16' },
      { from: '2026-12-16', through: '2026-12-31', payOn: '2027-01-01' },
    ]);
    expect(payrollPeriodLabel(periods[0])).toBe('1–15 декабря');
    expect(payrollDateLabel(periods[1].payOn)).toBe('1 января');
  });

  it.each([['2027-02-01', '2027-02-28'], ['2028-02-01', '2028-02-29'], ['2026-11-01', '2026-11-30']])(
    'includes the last workday of %s', (month, last) => {
      expect(payrollPeriods(month)[1]).toMatchObject({ through: last });
    },
  );

  it('uses the business day, keeps extra-point pay, and excludes open/outside shifts', () => {
    const shifts = [
      { day: '2026-10-31', earned_minor: 1000 },
      { day: '2026-11-01', earned_minor: '101' },
      { day: '2026-11-15', earned_minor: '102' },
      { day: '2026-11-16', earned_minor: '103' },
      { day: '2026-11-16', earned_minor: '1', counts_as_exit: false },
      { day: '2026-11-17', earned_minor: 1000, status: 'open' as const },
      { day: '2026-11-30', earned_minor: '104' },
      { day: '2026-12-01', earned_minor: 1000 },
    ];
    expect(splitPayroll('2026-11-01', shifts)).toEqual([203n, 208n]);
    expect(splitPayroll('2026-11-01', [])).toEqual([0n, 0n]);
  });
});
