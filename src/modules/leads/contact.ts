/** A pasted Instagram profile, @handle, plain handle, or a person's name. */
export function parseLeadContact(value: string): { name: string; instagram: string | null } {
  const name = value.trim();
  const profile = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})\/?(?:[?#].*)?$/i.exec(name);
  const handle = profile?.[1] ?? (name.startsWith('@') ? name.slice(1) : /^[A-Za-z0-9_][A-Za-z0-9_.]{0,29}$/.test(name) ? name : null);
  return { name: handle ? `@${handle}` : name, instagram: handle };
}
