/** A pasted Instagram profile, @handle, plain handle, or a person's name. */
export function parseLeadContact(value: string): { name: string; instagram: string | null } {
  const name = value.trim();
  const profile = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})\/?(?:[?#].*)?$/i.exec(name);
  const handle = profile?.[1] ?? (name.startsWith('@') ? name.slice(1) : /^[A-Za-z0-9_][A-Za-z0-9_.]{0,29}$/.test(name) ? name : null);
  return { name: handle ? `@${handle}` : name, instagram: handle };
}

/** Mirrors the database match key. An explicitly international +8… number stays distinct. */
export function canonicalLeadPhone(value: string) {
  const digits = value.replace(/\D/g, '');
  return /^[\s()0-9.-]+$/.test(value) ? digits.replace(/^8(?=[023456789][0-9]{9}$)/, '7') : digits;
}

/** Country prefill uses exclusive +7 ranges and an explicit +90 for Türkiye. */
export function leadPhoneCountry(value: string) {
  const digits = canonicalLeadPhone(value);
  if (/^7[067][0-9]{9}$/.test(digits)) return 'KZ';
  if (/^7[23459][0-9]{9}$/.test(digits)) return 'RU';
  if (/^\s*\+/.test(value) && /^90[0-9]{10}$/.test(digits)) return 'TR';
  return undefined;
}
