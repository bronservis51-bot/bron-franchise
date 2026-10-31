import { describe, expect, it } from 'vitest';
import { loginEmail } from '../../src/platform/login';

describe('personal login identifiers', () => {
  it('accepts short logins, trims whitespace and ignores case', () => {
    expect(loginEmail('  Owner.One  ')).toBe('owner.one@access.bron.local');
  });
  it('keeps email sign-in available', () => {
    expect(loginEmail('  Person@Example.COM ')).toBe('person@example.com');
  });
  it('keeps existing employee phone identities unchanged', () => {
    for (const phone of ['+7 (900) 123-45-67', '8 900 123 45 67', '9001234567']) {
      expect(loginEmail(phone)).toBe('79001234567@staff.bron.local');
    }
    expect(loginEmail('+90 555 123 45 67')).toBe('905551234567@staff.bron.local');
  });
  it('rejects malformed identifiers instead of attempting another identity', () => {
    for (const login of ['', ' ', '123', 'a', 'some name', 'имя', '../manager', 'owner/name']) {
      expect(() => loginEmail(login)).toThrow('Неверный логин');
    }
  });
});
