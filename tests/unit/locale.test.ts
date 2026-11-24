import { expect, it } from 'vitest';
import { navFor, workspaceTitleFor } from '../../src/app/nav';
import { dayLabel, monthLabel } from '../../src/platform/dates';
import { franchiseeLocaleScope, languageForCountry } from '../../src/platform/locale';
import { formatMoney } from '../../src/platform/money';
import type { Assignment, Me } from '../../src/platform/session';
import { errorText } from '../../src/ui';

const owner: Assignment = { id: 'grant', role: 'franchisee', role_name: 'Франчайзи', scope_type: 'partner', scope_id: 'partner-tr', scope_name: 'Test', permissions: [] };
const profile = (...assignments: Assignment[]): Me => ({ user: { id: 'user', full_name: 'Test', email: 'test@example.invalid', is_demo: true }, assignments });

it('derives the default locale only for a verified single franchisee card', () => {
  expect(franchiseeLocaleScope(profile(owner, { ...owner, id: 'regrant' }))).toBe('partner-tr');
  expect(franchiseeLocaleScope(profile(owner, { ...owner, scope_id: 'partner-other' }))).toBeNull();
  expect(franchiseeLocaleScope(profile({ ...owner, role: 'franchisee_manager' }))).toBeNull();
  expect(franchiseeLocaleScope(profile(owner, { ...owner, role: 'franchise_manager', scope_type: 'company', scope_id: null }))).toBeNull();
  expect(languageForCountry('TR')).toBe('tr');
  expect(languageForCountry('KZ')).toBe('ru');
  expect(languageForCountry(null)).toBe('ru');
});

it('translates display labels without changing routes or permission decisions', () => {
  const can = (permission: string) => permission === 'revenue.read' || permission === 'staff.manage';
  const russian = navFor('franchisee', can);
  const turkish = navFor('franchisee', can, 'tr');
  expect(turkish.map(item => item.to)).toEqual(russian.map(item => item.to));
  expect(turkish.map(item => item.label)).toEqual(['Ana sayfa', 'Çalışanlar', 'Finans', 'Bilgi bankası']);
  expect(workspaceTitleFor('franchisee', 'tr')).toBe('Franchise işletmecisi');
});

it('uses Turkish calendaring, currency and recovery messages while keeping Russian defaults', () => {
  expect(monthLabel('2026-11-01', false, 'tr-TR')).toBe('Kasım');
  expect(monthLabel('2026-11-01', false)).toBe('ноябрь');
  expect(dayLabel('2026-11-23', 'tr-TR')).toMatch(/Kas/);
  expect(formatMoney(123456, 'TRY', 'tr-TR')).toContain('1.234,56');
  const error = { message: 'version-conflict', details: 'Данные изменились. Обновите страницу.' };
  expect(errorText(error, 'tr')).toContain('Güncel bilgileri kontrol');
  expect(errorText(error)).toBe(error.details);
});
