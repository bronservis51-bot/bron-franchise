import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PartnerCardPanel } from '../../src/modules/manager/PartnerCard';
import { PartnerStatus } from '../../src/modules/manager/PartnerStatus';
import type { Location, Partner } from '../../src/modules/manager/api';

const partner: Partner = {
  id: 'partner', code: 'P-TEST', name: 'Вымышленный партнёр', country: 'RU', currency: 'RUB',
  status: 'active', preparation_stage: 'opening_preparation',
  contact_name: null, contact_phone: null, contact_email: null, order_url: null,
};
const future: Location = {
  id: 'future', code: 'FUTURE', name: 'Вторая будущая точка', partner_id: 'partner', city: 'Тестовый город',
  address: null, timezone: 'Europe/Moscow', currency: 'RUB', status: 'active', opened_on: '2099-11-23',
};
const undated: Location = { ...future, id: 'undated', opened_on: null, name: 'Точка без даты' };
const closed: Location = { ...future, id: 'closed', opened_on: '2020-10-15', name: 'Бывшая точка', status: 'closed' };

function renderCard(locations: Location[], openedOn: string | null) {
  const client = new QueryClient();
  client.setQueryData(['partner-card', partner.id], {
    partner, profile: null, documents: [],
    locations: locations.map(l => ({ ...l, first_day: null, last_day: null })),
    stats: { opened_on: openedOn, revenue_12m_minor: 0, rate_bp: 0, users: 1, staff: 0 },
  });
  return renderToStaticMarkup(<QueryClientProvider client={client}>
    <PartnerCardPanel partner={partner} locations={locations} />
  </QueryClientProvider>);
}

it('shows a scheduled opening date without claiming the point or partner has already opened', () => {
  const html = renderCard([future, undated], future.opened_on);
  expect(html).toContain('Открытие запланировано на 23.11.2099');
  expect(html).toContain('Дата открытия не указана');
  expect(html).not.toContain('Работает с');
  expect(html).not.toContain('меньше месяца');
  expect(html).not.toContain('Вход в кабинет');
});

it('retains the historic opening of a closed point and labels future points independently', () => {
  const html = renderCard([future, closed], closed.opened_on);
  expect(html).toContain('Первое открытие');
  expect(html).toContain('15.10.2020');
  expect(html).toContain('Закрыта');
  expect(html).toContain('Открытие запланировано на 23.11.2099');
});

it('uses a readable fallback for unknown commercial statuses and preparation stages', () => {
  const state = { partner_id: partner.id, working: false, owner_access: 'none' } as const;
  const unknownStatus = renderToStaticMarkup(<PartnerStatus partner={{ ...partner, status: 'future_state' }} current={state} />);
  const unknownStage = renderToStaticMarkup(<PartnerStatus partner={{ ...partner, preparation_stage: 'new_stage' }} current={state} />);
  expect(unknownStatus).toContain('Статус франчайзи неизвестен');
  expect(unknownStage).toContain('Этап подготовки неизвестен');
  expect(unknownStatus).not.toContain('future_state');
  expect(unknownStage).not.toContain('new_stage');
});
