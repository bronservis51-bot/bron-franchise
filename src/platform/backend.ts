// Адаптер backend (ADR-0004): команды — RPC, чтение — таблицы и представления под RLS.
// Ошибки приводятся к словарю API-04. Счётчик активных команд не даёт обновить PWA посреди отправки (PWA-06).
import { getLastRequestId, requireClient } from './supabase';
import { CONTRACT, type CommandName } from './contract.generated';

export type ErrorCode =
  | 'validation'
  | 'forbidden'
  | 'not-found'
  | 'version-conflict'
  | 'transition-not-allowed'
  | 'idempotency-conflict'
  | 'policy-split-required'
  | 'integration-pending'
  | 'external-unavailable'
  | 'unauthenticated'
  | 'offline'
  | 'unknown';

const KNOWN: ErrorCode[] = [
  'validation', 'forbidden', 'not-found', 'version-conflict', 'transition-not-allowed', 'idempotency-conflict',
  'policy-split-required', 'integration-pending', 'external-unavailable', 'unauthenticated',
];

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public detail: string,
    public hint: string,
    public requestId: string,
  ) {
    super(detail || code);
  }
  /** Поле формы, к которому относится ошибка валидации (сервер кладёт его в hint). */
  get field(): string | undefined {
    return this.code === 'validation' && /^[a-z_]+$/.test(this.hint) ? this.hint : undefined;
  }
}

interface PgError {
  message?: string;
  details?: string | null;
  hint?: string | null;
  code?: string;
}

export function toAppError(e: unknown): AppError {
  const requestId = getLastRequestId();
  if (e instanceof AppError) return e;
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return new AppError('offline', 'Нет связи с сервером. Данные не отправлены.', '', requestId);
  }
  const pg = e as PgError;
  if (pg && typeof pg.message === 'string') {
    if ((KNOWN as string[]).includes(pg.message)) {
      return new AppError(pg.message as ErrorCode, pg.details ?? '', pg.hint ?? '', requestId);
    }
    if (pg.code === '42501') return new AppError('forbidden', 'Недостаточно прав', '', requestId);
    if (pg.code === 'PGRST301' || /JWT/i.test(pg.message)) {
      return new AppError('unauthenticated', 'Сессия истекла. Войдите снова.', '', requestId);
    }
    if (/fetch|network|Failed to fetch/i.test(pg.message)) {
      return new AppError('external-unavailable', 'Сервер недоступен. Попробуйте ещё раз.', '', requestId);
    }
    return new AppError('unknown', 'Не удалось выполнить действие', pg.message, requestId);
  }
  return new AppError('unknown', 'Не удалось выполнить действие', String(e), requestId);
}

let inFlight = 0;
const listeners = new Set<(n: number) => void>();
export const commandsInFlight = () => inFlight;
export function onInFlightChange(fn: (n: number) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function setInFlight(delta: number) {
  inFlight += delta;
  listeners.forEach((l) => l(inFlight));
}

/**
 * Вызов команды по контракту (contract.generated.ts). Аргументы — без префикса p_: адаптер добавляет его.
 * Неизвестный аргумент — ошибка программиста, а не сервера. Однострочный результат нормализуется в объект.
 */
export async function command<T>(name: CommandName, args: Record<string, unknown> = {}): Promise<T> {
  const spec = CONTRACT[name];
  for (const k of Object.keys(args)) {
    if (!(spec.args as readonly string[]).includes(k)) throw new Error(`Команда ${name}: неизвестный аргумент «${k}»`);
  }
  const params = Object.fromEntries(Object.entries(args).map(([k, v]) => [`p_${k}`, v === undefined ? null : v]));
  setInFlight(1);
  try {
    const { data, error } = await requireClient().rpc(name, params);
    if (error) throw toAppError(error);
    if (spec.returns === 'single' && Array.isArray(data)) return (data[0] ?? null) as T;
    return data as T;
  } catch (e) {
    throw toAppError(e);
  } finally {
    setInFlight(-1);
  }
}

/** Чтение (RLS на сервере определяет, что видно). */
export function from(table: string) {
  return requireClient().from(table);
}

export async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await query;
    if (error) throw toAppError(error);
    return (data ?? []) as T[];
  } catch (e) {
    throw toAppError(e);
  }
}

export async function single<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  const r = await rows<T>(query);
  return r[0] ?? null;
}

/** Ключ идемпотентности операции (API-03): один на попытку пользователя, повтор того же действия — тот же ключ. */
export const newOperationKey = () => crypto.randomUUID();

export const storage = {
  async upload(path: string, file: Blob) {
    const { error } = await requireClient().storage.from('private-files').upload(path, file, { upsert: false, contentType: file.type });
    if (error) throw toAppError(error);
  },
  /** Короткоживущая ссылка (KB-13, SEC-05): выдаётся только при доступе по политике. */
  async signedUrl(path: string, seconds = 120) {
    const { data, error } = await requireClient().storage.from('private-files').createSignedUrl(path, seconds);
    if (error) throw toAppError(error);
    return data.signedUrl;
  },
};
