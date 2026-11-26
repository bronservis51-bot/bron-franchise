import { describe, expect, it } from 'vitest';
import { accessMessage, accessMessengerDraft, accessMessengerLinks } from '../../src/modules/staff/accessMessage';
import { randomPassword } from '../../src/modules/staff/api';

describe('new account access message', () => {
  it('labels the starting password in the forwarded message', () => {
    expect(accessMessage('https://example.invalid/app/', 'initial-test-password')).toBe(
      'https://example.invalid/app/\nТвой логин — твой номер телефона\nПароль — initial-test-password',
    );
    expect(accessMessage('https://example.invalid/app/', 'initial-test-password', 'tr').split('\n').at(-1))
      .toBe('Parola — initial-test-password');
  });

  it('generates two pronounceable groups followed by four digits', () => {
    expect(randomPassword()).toMatch(/^(?:[bcdfghjkmnprstvwz][aeiou]){3}-(?:[bcdfghjkmnprstvwz][aeiou]){3}-[2-9]{4}$/);
  });

  it.each([
    ['WhatsApp', 'whatsapp://send'],
    ['Telegram', 'tg://resolve'],
  ] as const)('opens %s for the employee number with the entire draft and no extra parameters', (name, target) => {
    const message = accessMessage('https://example.invalid/app/', 'Test&?=# %+');
    const url = new URL(accessMessengerDraft(name, '79000000000', message));
    expect(url.origin).toBe('null');
    expect(url.protocol + '//' + url.hostname).toBe(target);
    expect([...url.searchParams]).toEqual([['phone', '79000000000'], ['text', message]]);
    expect(url.hash).toBe('');
  });

  it('opens the phone chat or MAX without passing credentials to a messenger URL', () => {
    expect(accessMessengerLinks('79000000000')).toEqual([
      { name: 'WhatsApp', href: 'https://wa.me/79000000000' },
      { name: 'MAX', href: 'https://web.max.ru/' },
      { name: 'Telegram', href: 'https://t.me/+79000000000' },
    ]);
  });
});
