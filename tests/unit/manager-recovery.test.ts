import { describe, expect, it } from 'vitest';
import { recoveryLinkKind, recoveryPasswordValid } from '../../src/platform/managerRecovery';

describe('manager recovery inputs', () => {
  it('accepts URL fragments only for the fixed actions and full opaque tokens', () => {
    const token = 'ab'.repeat(32);
    expect(recoveryLinkKind('confirm', token)).toBe('confirm');
    expect(recoveryLinkKind('reset', token)).toBe('reset');
    expect(recoveryLinkKind('other', token)).toBeNull();
    expect(recoveryLinkKind('reset', token.slice(1))).toBeNull();
    expect(recoveryLinkKind('reset', 'z'.repeat(64))).toBeNull();
  });

  it('rejects passwords outside the character minimum and bcrypt byte limit', () => {
    expect(recoveryPasswordValid('a'.repeat(11))).toBe(false);
    expect(recoveryPasswordValid('a'.repeat(12))).toBe(true);
    expect(recoveryPasswordValid('я'.repeat(36))).toBe(true);
    expect(recoveryPasswordValid('я'.repeat(37))).toBe(false);
  });
});
