import { describe, expect, it } from 'vitest';
import { loginEmail, phoneLoginDigits, phoneLoginInitial } from '../../src/platform/login';

describe('explicit phone account management', () => {
  it('uses the same canonical phone and identity as the sign-in screen', () => {
    for (const value of ['+7 (900) 123-45-67', '8 900 123 45 67', '9001234567']) {
      expect(phoneLoginDigits(value)).toBe('79001234567');
      expect(loginEmail(value)).toBe(`${phoneLoginDigits(value)}@staff.bron.local`);
    }
  });
  it('retains international numbers without forcing Russia', () => {
    expect(phoneLoginDigits('+90 555 123 45 67')).toBe('905551234567');
    expect(phoneLoginDigits('+7 701 123 45 67')).toBe('77011234567');
  });
  it('does not derive phones from a legacy short login or ordinary email', () => {
    for (const value of ['employee.one', 'employee.one@access.bron.local', 'person@example.invalid', null]) {
      expect(phoneLoginInitial(value)).toBe('');
    }
    expect(phoneLoginInitial('79001234567@staff.bron.local')).toBe('79001234567');
    expect(phoneLoginInitial('79001234567')).toBe('79001234567');
  });
  it('rejects malformed or incomplete explicit numbers', () => {
    for (const value of ['', ' ', '123', '+7 phone123456789', 'employee1234567890', '+7+9001234567', '00000000000', '+1234567890123456']) {
      expect(phoneLoginDigits(value)).toBeNull();
    }
  });
  it('keeps old email and short account sign-in available until explicitly changed', () => {
    expect(loginEmail('old.owner')).toBe('old.owner@access.bron.local');
    expect(loginEmail('PERSON@EXAMPLE.INVALID')).toBe('person@example.invalid');
  });
});
