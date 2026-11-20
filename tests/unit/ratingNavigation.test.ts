import { describe, expect, it } from 'vitest';
import { canOpenStaffDirectory, canOrderMaterials, navFor } from '../../src/app/nav';

describe('home navigation', () => {
  it.each(['manager', 'franchisee', 'staff', 'team', 'support'] as const)('puts Home first for %s', role => {
    expect(navFor(role)[0]).toMatchObject({ to: '/', label: 'Главная' });
  });

  it.each(['staff', 'team'] as const)('shows staff directory only with an effective permission for %s', role => {
    expect(navFor(role, canOpenStaffDirectory(() => false)).some(item => item.to === '/staff')).toBe(false);
    for (const permission of ['staff.manage', 'staff.view', 'staff.create']) {
      expect(navFor(role, canOpenStaffDirectory(code => code === permission)).some(item => item.to === '/staff')).toBe(true);
    }
    expect(canOrderMaterials(code => code === 'staff.view')).toBe(false);
    expect(canOrderMaterials(code => code === 'procurement.order')).toBe(true);
  });
});

describe('network ranking navigation', () => {
  it('keeps the ranking in the franchise manager menu', () => {
    expect(navFor('manager').find(item => item.to === '/rating')?.label).toBe('Рейтинг');
  });
  it.each(['franchisee', 'staff', 'team', 'support'] as const)('does not offer ranking to %s', role => {
    expect(navFor(role).some(item => item.to === '/rating')).toBe(false);
  });
});
