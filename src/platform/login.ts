/** Public login identifiers are not credentials. Passwords are sent only to Auth. */
export const LOGIN_DOMAIN = 'access.bron.local';

/** Phone login for explicit account management; never guesses a phone from a name. */
export function phoneLoginDigits(value: string): string | null {
  const input = value.trim();
  if (!/^\+?[\d\s()-]+$/.test(input)) return null;
  let digits = input.replace(/\D/g, '');
  if (/^8\d{10}$/.test(digits)) digits = `7${digits.slice(1)}`;
  if (/^9\d{9}$/.test(digits)) digits = `7${digits}`;
  return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
}

/** Existing service identities may contain a phone; ordinary email/short login does not. */
export function phoneLoginInitial(value?: string | null): string {
  return phoneLoginDigits((value ?? '').replace(/@(?:staff|access)\.bron\.local$/i, '')) ?? '';
}

export function loginEmail(value: string): string {
  const login = value.trim().toLowerCase();
  if (login.includes('@')) return login;
  if (/^[+\d\s()-]+$/.test(login)) {
    let digits = login.replace(/\D/g, '');
    if (/^8\d{10}$/.test(digits)) digits = `7${digits.slice(1)}`;
    if (/^9\d{9}$/.test(digits)) digits = `7${digits}`;
    if (digits.length < 10 || digits.length > 15) throw new Error('Неверный логин');
    return `${digits}@staff.bron.local`;
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
