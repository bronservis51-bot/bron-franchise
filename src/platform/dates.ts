// Даты: моменты времени приходят в UTC, показываются в часовом поясе пользователя или объекта (CORE-05).

export const userTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function formatDate(v: string | Date | null | undefined, locale = 'ru-RU', timeZone?: string): string {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : new Date(v);
  return d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: timeZone ?? (typeof v === 'string' && v.length === 10 ? 'UTC' : undefined) });
}

export function formatDateTime(v: string | Date | null | undefined, locale = 'ru-RU', timeZone?: string): string {
  if (!v) return '—';
  return new Date(v).toLocaleString(locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });
}

export function formatPeriod(v: string | null | undefined, locale = 'ru-RU'): string {
  if (!v) return '—';
  const d = new Date(`${v.slice(0, 10)}T12:00:00Z`);
  const s = d.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthStart(offsetMonths = 0, from = new Date()): string {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth() + offsetMonths, 1));
  return d.toISOString().slice(0, 10);
}

/** «октябрь 2026» для подписи месяца; v — 'YYYY-MM-DD' (любой день месяца). */
export function monthLabel(v: string, withYear = true): string {
  const d = new Date(`${v.slice(0, 7)}-15T12:00:00Z`);
  return d.toLocaleDateString('ru-RU', { month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).replace(' г.', '');
}

/** Сдвиг месяца: '2026-10-01' + 1 → '2026-11-01'. */
export function shiftMonth(v: string, delta: number): string {
  const [y, m] = v.slice(0, 7).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}

/** День недели и число: «пт, 17 окт.». */
export function dayLabel(v: string): string {
  return new Date(`${v}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
