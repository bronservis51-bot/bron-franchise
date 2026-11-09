// Понятная причина, почему не получилось войти, и проверка связи с сервером базы данных.
// Safari пишет о сетевой ошибке «Load failed», Chrome — «Failed to fetch», Firefox — «NetworkError»: всё это одно и то же.
import { useEffect, useState } from 'react';
import { config } from '../platform/config';
import { checkConnection, connectionSummary, type Connection } from '../platform/connection';

const NETWORK = /failed to fetch|load failed|networkerror|network request failed|fetch failed|retryablefetch|the internet connection appears to be offline/i;

export function loginErrorText(e: unknown): { text: string; detail: string } {
  const err = e as { name?: string; message?: string; status?: number };
  const detail = [err?.name, err?.message, err?.status ? `HTTP ${err.status}` : ''].filter(Boolean).join(': ');
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { text: 'Нет интернета на устройстве. Вход возможен только онлайн.', detail };
  if (err?.message === 'timeout' || err?.name === 'AbortError') return { text: 'Вход не завершён: сервер не ответил вовремя. Откройте «Помощь при сбое» и проверьте соединение.', detail: 'AUTH-TIMEOUT' };
  if (NETWORK.test(`${err?.name ?? ''} ${err?.message ?? ''}`)) return { text: 'Не удалось связаться с сервером входа. Откройте «Помощь при сбое»: там проверка связи и порядок действий.', detail: 'AUTH-NETWORK' };
  if (/invalid login credentials|Неверный логин/i.test(err?.message ?? '')) return { text: 'Неверный логин или пароль.', detail: '' };
  if (/rate limit|too many/i.test(err?.message ?? '') || err?.status === 429) return { text: 'Слишком много попыток входа подряд. Подождите пару минут и попробуйте снова.', detail };
  return { text: 'Не удалось войти.', detail };
}

export type ServerState = { state: 'checking' } | { state: 'ok'; ms: number; connection: Connection } | { state: 'down'; reason: string; connection: Connection };

/** Separate auth/data checks; abort old attempts and ignore late responses after unmount/recheck. */
export function useServerCheck(): [ServerState, () => void] {
  const [s, setS] = useState<ServerState>({ state: 'checking' });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!config.supabaseUrl) return;
    const ctrl = new AbortController(); let active = true;
    setS({ state: 'checking' });
    void checkConnection(config.supabaseUrl,config.supabaseKey,ctrl.signal).then(connection => {
      if(!active) return;
      setS(connection.auth.ok && connection.data.ok ? {state:'ok',ms:Math.max(connection.auth.ms,connection.data.ms),connection} : {state:'down',reason:connectionSummary(connection),connection});
    });
    const recheck = () => setN(x=>x+1);
    window.addEventListener('online',recheck);
    return () => { active=false; ctrl.abort(); window.removeEventListener('online',recheck); };
  }, [n]);
  return [s, () => setN((x) => x + 1)];
}
