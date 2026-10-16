// Понятная причина, почему не получилось войти, и проверка связи с сервером базы данных.
// Safari пишет о сетевой ошибке «Load failed», Chrome — «Failed to fetch», Firefox — «NetworkError»: всё это одно и то же.
import { useEffect, useState } from 'react';
import { config } from '../platform/config';

const NETWORK = /failed to fetch|load failed|networkerror|network request failed|fetch failed|retryablefetch|the internet connection appears to be offline/i;

export function loginErrorText(e: unknown): { text: string; detail: string } {
  const err = e as { name?: string; message?: string; status?: number };
  const detail = [err?.name, err?.message, err?.status ? `HTTP ${err.status}` : ''].filter(Boolean).join(': ');
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { text: 'Нет интернета на устройстве. Вход возможен только онлайн.', detail };
  if (err?.message === 'timeout') return { text: 'Сервер базы данных не ответил за 40 секунд. Похоже, с этого интернета он недоступен — попробуйте другую сеть (Wi‑Fi или мобильный интернет).', detail };
  if (NETWORK.test(`${err?.name ?? ''} ${err?.message ?? ''}`)) return { text: 'Устройство не может связаться с сервером базы данных. Попробуйте другую сеть: Wi‑Fi вместо мобильного интернета или наоборот.', detail };
  if (/invalid login credentials/i.test(err?.message ?? '')) return { text: 'Неверный email или пароль. Если вы входили через демо-кнопку — обновите страницу: возможно, открыта старая версия.', detail };
  if (/rate limit|too many/i.test(err?.message ?? '') || err?.status === 429) return { text: 'Слишком много попыток входа подряд. Подождите пару минут и попробуйте снова.', detail };
  return { text: 'Не удалось войти.', detail };
}

export type ServerState = { state: 'checking' } | { state: 'ok'; ms: number } | { state: 'down'; reason: string };

/** Пинг сервера авторизации: любой HTTP-ответ — связь есть; ошибка сети или 10 секунд тишины — связи нет. */
export function useServerCheck(): [ServerState, () => void] {
  const [s, setS] = useState<ServerState>({ state: 'checking' });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!config.supabaseUrl) return;
    const ctrl = new AbortController();
    const t0 = performance.now();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    setS({ state: 'checking' });
    fetch(`${config.supabaseUrl}/auth/v1/health`, { headers: { apikey: config.supabaseKey }, signal: ctrl.signal, cache: 'no-store' })
      .then(() => setS({ state: 'ok', ms: Math.round(performance.now() - t0) }))
      .catch((e: Error) => setS({ state: 'down', reason: e.name === 'AbortError' ? 'нет ответа 10 секунд' : e.message }))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [n]);
  return [s, () => setN((x) => x + 1)];
}
