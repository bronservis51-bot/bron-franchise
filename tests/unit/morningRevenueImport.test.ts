import { describe, expect, it } from 'vitest';
// @ts-expect-error — reviewed deployment module remains dependency-free JS.
import { buildRevenueImportPlan, planSha256 } from '../../docs/runbooks/payloads/morning-revenue-import.mjs';

const locationId = '11111111-1111-4111-8111-111111111111';
const partnerId = '22222222-2222-4222-8222-222222222222';
const batchId = '33333333-3333-4333-8333-333333333333';
const input = () => ({ format: 1, batchId, locationId, currency: 'RUB', year: 2026, month: 11,
  entries: [{ day: '2026-11-02', totalMinor: '310000' }, { day: '2026-11-05', totalMinor: '0' }] });
const snapshot = () => ({ locationId, partnerId, currency: 'RUB', status: 'active', today: '2026-11-16',
  days: [{ day: '2026-11-02', version: 'empty', rowCount: 0, totalMinor: '0' },
    { day: '2026-11-05', version: 'empty', rowCount: 0, totalMinor: '0' }] });

describe('private missing-day total import', () => {
  it('plans only supplied dates, preserves explicit zero and never invents payment/staff data', () => {
    const plan = buildRevenueImportPlan(input(), snapshot());
    expect(plan.status).toBe('READY');
    expect(plan.summary).toEqual({ suppliedDays: 2, insertDays: 2, matchingDays: 0, conflictingDays: 0 });
    expect(plan.rows.map((r: { day: string }) => r.day)).toEqual(['2026-11-02', '2026-11-05']);
    expect(plan.rows[1].totalMinor).toBe('0');
    expect(JSON.stringify(plan)).not.toMatch(/cash_minor|card_minor|employee_id|earned_minor/);
    expect(plan.permittedMutation).toBe('INSERT_MISSING_DAY_TOTALS_ONLY');
  });

  it('skips matching existing revenue without changing its attribution or history', () => {
    const s = snapshot(); Object.assign(s.days[0], { version: 'a'.repeat(32), rowCount: 2, totalMinor: '310000' });
    const plan = buildRevenueImportPlan(input(), s);
    expect(plan.status).toBe('READY'); expect(plan.rows[0].disposition).toBe('KEEP_MATCHING');
    expect(plan.summary).toEqual({ suppliedDays: 2, insertDays: 1, matchingDays: 1, conflictingDays: 0 });
  });

  it('blocks the entire batch instead of replacing any different existing day', () => {
    const s = snapshot(); Object.assign(s.days[0], { version: 'b'.repeat(32), rowCount: 1, totalMinor: '309999' });
    const plan = buildRevenueImportPlan(input(), s);
    expect(plan.status).toBe('BLOCKED_CONFLICT'); expect(plan.summary.conflictingDays).toBe(1);
  });

  it('treats an existing zero day as a real conflicting record, not an empty placeholder', () => {
    const s = snapshot(); Object.assign(s.days[0], { version: 'b'.repeat(32), rowCount: 1 });
    expect(buildRevenueImportPlan(input(), s).status).toBe('BLOCKED_CONFLICT');
  });

  it('binds the exact preview including versions, amounts, target location and input batch', () => {
    const plan = buildRevenueImportPlan(input(), snapshot());
    expect(planSha256(plan)).toMatch(/^[a-f0-9]{64}$/);
    expect(planSha256(JSON.parse(JSON.stringify(plan)))).toBe(planSha256(plan));
    const s = snapshot(); Object.assign(s.days[0], { version: 'c'.repeat(32), rowCount: 1, totalMinor: '310000' });
    expect(planSha256(buildRevenueImportPlan(input(), s))).not.toBe(planSha256(plan));
    expect(buildRevenueImportPlan(input(), snapshot()).rows[0].operationId).toBe(plan.rows[0].operationId);
  });

  it.each(['-1', '1.5', '01', '', ' 100 ', '100000000001'])('rejects invalid/minor-unit amount %j', value => {
    const valueInput = input(); valueInput.entries[0].totalMinor = value;
    expect(() => buildRevenueImportPlan(valueInput, snapshot())).toThrow('IMPORT_INVALID_AMOUNT');
  });

  it('rejects missing metadata instead of assuming a day is empty', () => {
    const s = snapshot(); s.days.pop();
    expect(() => buildRevenueImportPlan(input(), s)).toThrow('IMPORT_INCOMPLETE_SNAPSHOT');
  });

  it('rejects duplicate source dates', () => {
    const valueInput = input(); valueInput.entries.push(valueInput.entries[0]);
    expect(() => buildRevenueImportPlan(valueInput, snapshot())).toThrow('IMPORT_INVALID_DAYS');
  });

  it('rejects dates outside the confirmed month/year', () => {
    const valueInput = input(); valueInput.entries[0].day = '2025-11-02';
    expect(() => buildRevenueImportPlan(valueInput, snapshot())).toThrow('IMPORT_INVALID_DAYS');
  });

  it('rejects a future date using point-local today supplied by the database', () => {
    const s = snapshot(); s.today = '2026-11-04';
    expect(() => buildRevenueImportPlan(input(), s)).toThrow('IMPORT_FUTURE_DAY');
  });

  it('does not assume a currency or choose another point', () => {
    expect(() => buildRevenueImportPlan(input(), { ...snapshot(), currency: 'TRY' })).toThrow('IMPORT_LOCATION_MISMATCH');
    expect(() => buildRevenueImportPlan(input(), { ...snapshot(), locationId: partnerId })).toThrow('IMPORT_LOCATION_MISMATCH');
    expect(() => buildRevenueImportPlan(input(), { ...snapshot(), status: 'closed' })).toThrow('IMPORT_LOCATION_MISMATCH');
  });

  it('rejects contradictory empty/version metadata', () => {
    const s = snapshot(); s.days[0].version = 'a'.repeat(32);
    expect(() => buildRevenueImportPlan(input(), s)).toThrow('IMPORT_INVALID_SNAPSHOT');
  });
});
