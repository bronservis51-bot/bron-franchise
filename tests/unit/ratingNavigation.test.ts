import { describe, expect, it } from 'vitest';
import { activeNavFor, canOrderMaterials, navFor, workspaceAccess } from '../../src/app/nav';

describe('home navigation', () => {
  it.each(['manager', 'franchisee', 'staff', 'team', 'support'] as const)('puts Home first for %s', role => {
    expect(navFor(role)[0]).toMatchObject({ to: '/', label: 'Главная' });
  });

  it.each(['staff', 'team'] as const)('shows staff directory only with an effective permission for %s', role => {
    expect(navFor(role).some(item => item.to === '/staff')).toBe(false);
    for (const permission of ['staff.manage', 'staff.view', 'staff.create']) {
      expect(navFor(role, code => code === permission).some(item => item.to === '/staff')).toBe(true);
    }
    expect(canOrderMaterials(code => code === 'staff.view')).toBe(false);
    expect(canOrderMaterials(code => code === 'procurement.order')).toBe(true);
  });

  it('keeps detail pages with their parent section and requires that section to exist', () => {
    const manager = navFor('manager', code => ['org.manage', 'royalty.manage'].includes(code));
    const franchisee = navFor('franchisee', code => code === 'staff.view');
    expect(activeNavFor('/partners/partner-id', manager)).toBe('/');
    expect(activeNavFor('/royalty/partner-id', manager)).toBe('/finance');
    expect(activeNavFor('/team-access', franchisee)).toBe('/staff');
    expect(activeNavFor('/team-access', navFor('franchisee'))).toBeUndefined();
    expect(activeNavFor('/royalty/partner-id', navFor('manager'))).toBeUndefined();
    expect(activeNavFor('/learning/lesson/lesson-id', navFor('staff'))).toBe('/learning');
    expect(activeNavFor('/kb/articles/article-id', manager)).toBe('/kb');
    expect(activeNavFor('/order', franchisee)).toBeUndefined();
  });
});

it.each(['manager', 'franchisee', 'staff', 'team', 'support'] as const)('omits ranking even with its old permission for %s', role => {
  expect(navFor(role, () => true).some(item => item.to === '/rating')).toBe(false);
});

it('keeps navigation and direct links aligned when permissions change', () => {
  expect(workspaceAccess('manager', () => false)).toMatchObject({ network: false, finance: false });
  expect(workspaceAccess('franchisee', () => false)).toMatchObject({ finance: false, staffDirectory: false, order: false });
  expect(navFor('manager', code => code === 'org.manage').map(item => item.to)).toContain('/leads');
  expect(navFor('manager', code => code === 'royalty.manage').find(item => item.to === '/finance')?.label).toBe('Роялти');
  expect(workspaceAccess('staff', code => code === 'staff.create')).toMatchObject({
    staffDirectory: true, order: false, learning: true, learningManage: false,
  });
  expect(workspaceAccess('team', code => code === 'procurement.order')).toMatchObject({
    staffDirectory: false, order: true, learning: true,
  });
  expect(workspaceAccess('support', code => code === 'kb.edit')).toMatchObject({
    staffDirectory: false, order: false, learningManage: true,
  });
  expect(workspaceAccess('pending', () => true)).toMatchObject({
    staffDirectory: false, order: false, learning: false, learningManage: false,
  });
  expect(navFor('pending')).toEqual([]);
});
