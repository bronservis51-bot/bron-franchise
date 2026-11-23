import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { NetworkPage } from '../../src/modules/manager/NetworkPage';
import { monthStart } from '../../src/platform/dates';

function renderNetwork() {
  const client = new QueryClient();
  const month = monthStart();
  client.setQueryData(['partners'], [
    { id: 'working', code: 'WORK', name: 'Рабочая франшиза', status: 'active', preparation_stage: 'opening_preparation' },
    { id: 'planned', code: 'PLAN', name: 'Новая франшиза', status: 'active', preparation_stage: 'location_search' },
    { id: 'ended', code: 'END', name: 'Бывшая франшиза', status: 'terminated', preparation_stage: 'contract_signed' },
    { id: 'paused', code: 'PAUSE', name: 'Пауза без точки', status: 'suspended', preparation_stage: 'contract_signed' },
  ]);
  client.setQueryData(['manager-partner-status'], [
    { partner_id: 'working', working: true, owner_access: 'granted' },
    { partner_id: 'planned', working: false, owner_access: 'none' },
    { partner_id: 'ended', working: false, owner_access: 'granted' },
    { partner_id: 'paused', working: false, owner_access: 'none' },
  ]);
  client.setQueryData(['revenue', 'overview', month], { rows: [{
    partner_id: 'working', partner_name: 'Рабочая франшиза', location_id: 'point', location_name: 'Рабочая точка',
    currency: 'RUB', city: 'Москва', plan_minor: null, fact_minor: 0, pct: null, missing_days: [],
  }], fact_rub_minor: 0, plan_rub_minor: null, missing_fx: [] });
  return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><NetworkPage /></QueryClientProvider></MemoryRouter>);
}

describe('manager network and archived partners', () => {
  it('labels the current stage without retaining preparation next to a working point', () => {
    const html = renderNetwork();
    expect(html).toContain('Работает');
    expect(html).not.toContain('Подготовка к открытию');
    expect(html).toContain('Поиск локации');
  });

  it('keeps both inactive projects without points findable and shows assigned access separately', () => {
    const html = renderNetwork();
    expect(html).toContain('Поиск франчайзи');
    expect(html).toContain('href="/partners/paused"');
    expect(html).toContain('href="/partners/ended"');
    expect(html).toContain('Доступ франчайзи выдан');
  });
});
