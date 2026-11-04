import { describe, expect, it } from 'vitest';
import { COLUMNS, columnFor, groupLeads, PIPELINE, readiness } from '../../src/modules/leads/pipeline';
import type { Lead } from '../../src/modules/leads/api';

const base = { id: 'one', status: 'new', budget: 'full', place: 'has', timing: 'month', name: 'Тест', city: 'Грозный', phone: '+7 (900) 111-22-33', created_at: '2026-11-04T10:00:00Z' } as Lead;
describe('lead qualification matches the landing questionnaire', () => {
  it('partitions all 36 valid answer combinations exactly once', () => {
    const cases: Lead[] = [];
    for (const budget of ['full', 'partial', 'none'] as const)
      for (const place of ['has', 'options', 'help'] as const)
        for (const timing of ['month', 'quarter', 'half', 'research'] as const) cases.push({ ...base, id: `${budget}-${place}-${timing}`, budget, place, timing });
    const groups = groupLeads(cases, '', false);
    expect([...groups.values()].flat()).toHaveLength(36);
    expect(groups.get('111')?.map(l => l.id)).toEqual(['full-has-month']);
    expect([...new Set(cases.map(columnFor))].sort()).toEqual(PIPELINE.map(c => c.id).sort());
    expect(readiness({ budget: 'partial', place: 'options', timing: 'quarter' })).toEqual({ money: false, place: false, now: false });
  });
  it('increases readiness left to right and puts all three immediately before work', () => {
    const counts = PIPELINE.map(c => [...c.id].filter(v => v === '1').length);
    expect(counts).toEqual([...counts].sort());
    expect(COLUMNS[COLUMNS.findIndex(c => c.id === 'in_work') - 1].id).toBe('111');
    expect(COLUMNS.at(-1)?.id).toBe('lost');
  });
  it('preserves manager stages regardless of qualification', () => {
    for (const status of ['in_work', 'call_back', 'meeting'] as const) expect(columnFor({ ...base, status })).toBe('in_work');
    for (const status of ['won', 'lost'] as const) expect(columnFor({ ...base, status })).toBe(status);
    expect(columnFor({ ...base, status: 'new' })).toBe('111');
  });
  it('filters locally, normalizes phone search, and keeps newest cards first', () => {
    const old = { ...base, id: 'old', created_at: '2026-11-01T10:00:00Z' };
    expect(groupLeads([old, base], ' ГРОЗНЫЙ ', false).get('111')?.map(l => l.id)).toEqual(['one', 'old']);
    expect(groupLeads([base], '900111', false).get('111')).toHaveLength(1);
    expect([...groupLeads([base], 'Нет такого города', false).values()].flat()).toHaveLength(0);
    expect([...groupLeads([{ ...base, status: 'won' }], '', true).values()].flat()).toHaveLength(0);
  });
});
