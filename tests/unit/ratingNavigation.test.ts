import { describe, expect, it } from 'vitest';
import { navFor } from '../../src/app/nav';

describe('network ranking navigation', () => {
  it('keeps the ranking in the franchise manager menu', () => {
    expect(navFor('manager').find(item => item.to === '/rating')?.label).toBe('Рейтинг');
  });
  it.each(['franchisee', 'staff', 'team', 'support'] as const)('does not offer ranking to %s', role => {
    expect(navFor(role).some(item => item.to === '/rating')).toBe(false);
  });
});
