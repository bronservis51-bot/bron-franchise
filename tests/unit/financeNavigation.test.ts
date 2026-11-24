import { expect, it } from 'vitest';
import { financeMonthLimit, financeOfficeMonth, financeSelection } from '../../src/modules/finance/financeNavigation';

const current = '2026-11-01';
const location = 'cb952096-9771-40c8-a182-0cdca77d759c';

it('opens a linked day and point without discarding the selected historical month', () => {
  expect(financeSelection(new URLSearchParams({ section: 'days', month: '2024-02-01', day: '2024-02-29', location }), current))
    .toEqual({ section: 'days', month: '2024-02-01', location, day: '2024-02-29' });
});

it('uses the point calendar at the month boundary and retains the office limit for an unknown point', () => {
  const office = financeOfficeMonth(new Date('2026-11-30T20:30:00Z'));
  expect(office).toBe('2026-11-01');
  const points = [{ location_id: location, today: '2026-12-01' }];
  expect(financeMonthLimit(office, points, null)).toBe('2026-12-01');
  expect(financeMonthLimit(office, points, 'unknown')).toBe('2026-11-01');
  expect(financeSelection(new URLSearchParams({ section: 'days', month: '2026-12-01', day: '2026-12-01', location }),
    financeMonthLimit(office, points, location))).toEqual({ section: 'days', month: '2026-12-01', day: '2026-12-01', location });
});

it('accepts an all-point day but ignores malformed dates, future months and malformed point IDs', () => {
  expect(financeSelection(new URLSearchParams({ section: 'days', month: current, day: '2026-11-12' }), current))
    .toEqual({ section: 'days', month: current, location: null, day: '2026-11-12' });
  expect(financeSelection(new URLSearchParams({ section: 'days', month: '2026-12-01', day: '2026-11-31', location: 'wrong' }), current))
    .toEqual({ section: 'days', month: current, location: null, day: null });
  expect(financeSelection(new URLSearchParams({ section: 'royalty', month: current, day: '2026-11-12', location }), current))
    .toEqual({ section: 'expenses', month: current, location, day: null });
});
