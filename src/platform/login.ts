/** Public login identifiers are not credentials. Passwords are sent only to Auth. */
export const LOGIN_DOMAIN = 'access.bron.local';
const PHONE_LOGIN_DOMAIN = 'staff.bron.local';
const phoneFormatting = /[\s().\p{Pd}\p{Cf}\u2212]/gu;

function normalizedPhoneDigits(input: string): string {
  const digits = input.replace(/\+/g, '');
  if (/^8\d{10}$/.test(digits)) return `7${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) return `7${digits}`;
  return digits;
}

/** Phone login for explicit account management; never guesses a phone from a name. */
export function phoneLoginDigits(value: string): string | null {
  const input = value.replace(phoneFormatting, '');
  if (!/^\+?\d+$/.test(input)) return null;
  const digits = normalizedPhoneDigits(input);
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

/** Existing service identities may contain a phone; ordinary email/short login does not. */
export function phoneLoginInitial(value?: string | null): string {
  return phoneLoginDigits((value ?? '').replace(/@(?:staff|access)\.bron\.local$/i, '')) ?? '';
}

export function displayLogin(identity?: string | null): string {
  if (!identity) return '';
  const at = identity.lastIndexOf('@');
  if (at < 0) return identity;
  const domain = identity.slice(at + 1).toLowerCase();
  if (domain === LOGIN_DOMAIN) return identity.slice(0, at);
  if (domain === PHONE_LOGIN_DOMAIN) {
    const phone = phoneLoginInitial(identity);
    if (phone) return `+${phone}`;
  }
  return identity;
}

export function loginEmail(value: string): string {
  const login = value.trim().toLowerCase();
  if (login.includes('@')) return login;
  const phone = login.replace(phoneFormatting, '');
  if (/^[+\d]+$/.test(phone)) {
    const digits = normalizedPhoneDigits(phone);
    if (digits.length < 10 || digits.length > 15) throw new Error('Неверный логин');
    return `${digits}@${PHONE_LOGIN_DOMAIN}`;
  }
  if (!/^[a-z][a-z0-9._-]{1,39}$/.test(login)) throw new Error('Неверный логин');
  return `${login}@${LOGIN_DOMAIN}`;
}

const stagingLogins: ReadonlyMap<string, string> = new Map([
  ['set', 'fm@demo.example.com'],
  ['fran', 'alpha.owner@demo.example.com'],
  ['uprav', '79000000012@staff.bron.local'],
  ['sales', '79000000011@staff.bron.local'],
  ['staz', '79000000013@staff.bron.local'],
]);

export function stagingLoginEmail(value: string): string {
  return stagingLogins.get(value.trim().toLowerCase()) ?? loginEmail(value);
}
