import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LeadsPage } from '../../src/modules/leads/LeadsPage';
import type { Lead, LeadStatus } from '../../src/modules/leads/api';

const questionnaire: Lead = {
  id: 'test-lead', name: 'Анна', city: 'Мурманск', phone: '+7 900 000-00-00',
  contact_via: 'call', budget: 'full', timing: 'month', manage: 'self',
  experience: 'some', place: 'has', score: 12, tier: 'hot', status: 'new',
  comment: null, source: null, note: null, updated_by_name: null,
  created_at: '2026-11-04T10:00:00Z', updated_at: '2026-11-04T10:00:00Z',
};

describe('CRM stage selection', () => {
  const stages: [LeadStatus, Lead['pipeline_column'], string, string][] = [
    ['new', null, '111', 'auto'],
    ['new', undefined, '111', 'auto'],
    ['new', '111', '111', '111'],
    ['new', '100', '100', '100'],
    ['call_back', null, 'in_work', 'call_back'],
    ['meeting', '100', 'in_work', 'meeting'],
    ['won', null, 'won', 'won'],
  ];

  it.each(stages)('places %s with override %s in %s and selects %s', (status, pipeline_column, column, option) => {
    const client = new QueryClient();
    client.setQueryData(['leads'], [{ ...questionnaire, status, pipeline_column }]);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><LeadsPage /></QueryClientProvider>);
    const boardColumn = html.match(new RegExp(`<section[^>]+id="lead-column-${column}"[^>]*>[\\s\\S]*?</section>`))?.[0];
    const cardSelector = boardColumn?.match(/<select[^>]+aria-label="Переместить заявку Анна"[^>]*>[\s\S]*?<\/select>/)?.[0];

    expect(cardSelector?.match(/<option value="([^"]+)" selected=""/)?.[1]).toBe(option);
  });
});
