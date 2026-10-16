// Деньги без float (ROY-08, ADR-0009): минорные единицы как bigint/строка; форматирование строкой через Intl.

const MINOR_UNITS: Record<string, number> = { RUB: 2, KZT: 2, TRY: 2 };

export function setCurrencyMinorUnits(list: { code: string; minor_unit: number }[]) {
  for (const c of list) MINOR_UNITS[c.code] = c.minor_unit;
}

export type MinorInput = bigint | number | string | null | undefined;

export function toBigInt(v: MinorInput): bigint {
  if (v === null || v === undefined || v === '') return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('Небезопасное целое для денег');
    return BigInt(v);
  }
  if (!/^-?\d+$/.test(v.trim())) throw new Error(`Неверная сумма: ${v}`);
  return BigInt(v.trim());
}

/** Десятичная строка из минорных единиц: 1250000 RUB → "12500.00". */
export function minorToDecimal(v: MinorInput, currency: string): string {
  const units = MINOR_UNITS[currency] ?? 2;
  const n = toBigInt(v);
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(units + 1, '0');
  const int = abs.slice(0, abs.length - units) || '0';
  const frac = units ? abs.slice(abs.length - units) : '';
  return `${neg ? '-' : ''}${int}${units ? `.${frac}` : ''}`;
}

const fmtCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(v: MinorInput, currency: string, locale = 'ru-RU'): string {
  const key = `${locale}:${currency}`;
  let f = fmtCache.get(key);
  if (!f) {
    const units = MINOR_UNITS[currency] ?? 2;
    f = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: units, maximumFractionDigits: units });
    fmtCache.set(key, f);
  }
  // Строковый ввод Intl.NumberFormat сохраняет точность (без перевода в float)
  return f.format(minorToDecimal(v, currency) as unknown as number);
}

/** Короткая запись для витрины и крупных цифр: целые суммы без копеек («490 ₽»), иначе как formatMoney. */
export function formatMoneyShort(v: MinorInput, currency: string, locale = 'ru-RU'): string {
  const units = MINOR_UNITS[currency] ?? 2;
  const n = toBigInt(v);
  if (units === 0 || n % 10n ** BigInt(units) !== 0n) return formatMoney(v, currency, locale);
  const whole = n / 10n ** BigInt(units);
  return new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(whole as unknown as number);
}

/** Разбор ввода пользователя «12 500,5» → минорные единицы. Возвращает null при неверном вводе. */
export function parseMoney(input: string, currency: string): bigint | null {
  const units = MINOR_UNITS[currency] ?? 2;
  const s = input.replace(/[\s ₽₸₺]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [int, frac = ''] = s.split('.');
  if (frac.length > units) return null;
  return BigInt(int) * 10n ** BigInt(units) + BigInt((frac + '0'.repeat(units)).slice(0, units) || '0');
}

export function sumMinor(values: MinorInput[]): bigint {
  return values.reduce<bigint>((acc, v) => acc + toBigInt(v), 0n);
}

/** Суммы разных валют не складываются (ROY-08): группировка по валюте. */
export function groupByCurrency<T>(items: T[], currency: (x: T) => string, amount: (x: T) => MinorInput): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const x of items) m.set(currency(x), (m.get(currency(x)) ?? 0n) + toBigInt(amount(x)));
  return m;
}
