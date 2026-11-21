import { describe, expect, it } from 'vitest';
import { accessMessage, accessMessengerLinks } from '../../src/modules/staff/accessMessage';

describe('new account access message', () => {
  it('contains exactly the app address, login instruction and starting password', () => {
    expect(accessMessage('https://example.invalid/app/', 'initial-test-password')).toBe(
      'https://example.invalid/app/\nТвой логин — твой номер телефона\ninitial-test-password',
    );
  });

  it('opens the phone chat or MAX without passing credentials to a messenger URL', () => {
    expect(accessMessengerLinks('79000000000')).toEqual([
      { name: 'WhatsApp', href: 'https://wa.me/79000000000' },
      { name: 'MAX', href: 'https://web.max.ru/' },
      { name: 'Telegram', href: 'https://t.me/+79000000000' },
    ]);
  });
});
