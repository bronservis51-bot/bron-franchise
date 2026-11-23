import { afterEach, expect, it, vi } from 'vitest';
import { hasSeenFirstRunGuide, markFirstRunGuideSeen } from '../../src/app/FirstRunGuide';

afterEach(() => vi.unstubAllGlobals());

it('remembers dismissal only for the same user and role', () => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });

  expect(hasSeenFirstRunGuide('first', 'staff')).toBe(false);
  markFirstRunGuideSeen('first', 'staff');
  expect(hasSeenFirstRunGuide('first', 'staff')).toBe(true);
  expect(hasSeenFirstRunGuide('first', 'team')).toBe(false);
  expect(hasSeenFirstRunGuide('second', 'staff')).toBe(false);
});

it('keeps the guide usable if local storage is disabled', () => {
  const unavailable = () => { throw new Error('Storage disabled'); };
  vi.stubGlobal('localStorage', { getItem: unavailable, setItem: unavailable });
  expect(hasSeenFirstRunGuide('user', 'staff')).toBe(false);
  expect(() => markFirstRunGuideSeen('user', 'staff')).not.toThrow();
});
