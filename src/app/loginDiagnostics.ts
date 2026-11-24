// Понятная причина, почему не получилось войти, и проверка связи с сервером базы данных.
// Safari пишет о сетевой ошибке «Load failed», Chrome — «Failed to fetch», Firefox — «NetworkError»: всё это одно и то же.
import { useEffect, useState } from 'react';
import { config } from '../platform/config';
import { checkConnection, type Connection } from '../platform/connection';

const NETWORK = /failed to fetch|load failed|networkerror|network request failed|fetch failed|retryablefetch|the internet connection appears to be offline/i;

export function loginErrorText(e: unknown, language: 'ru' | 'tr' = 'ru'): { text: string; detail: string } {
  const err = e as { name?: string; message?: string; status?: number; code?: string; error_code?: string };
  const code = typeof err?.code === 'string' ? err.code : err?.error_code ?? '';
  const message = typeof err?.message === 'string' ? err.message : '';
  const detail = [/^[a-z][a-z0-9_]{1,63}$/.test(code) ? code : '',
    Number.isInteger(err?.status) ? `HTTP ${err.status}` : ''].filter(Boolean).join(' · ');
  const t = (ru: string, tr: string) => language === 'tr' ? tr : ru;

  if (code === 'user_banned' || /^user is banned\.?$/i.test(message.trim())) return {
    text: t('Вход закрыт. Обратитесь к своему руководителю.', 'Giriş engellendi. Yöneticinizle iletişime geçin.'), detail: '',
  };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return {
    text: t('Проверьте подключение к интернету.', 'İnternet bağlantınızı kontrol edin.'), detail: 'AUTH-OFFLINE',
  };
  if (message === 'timeout' || err?.name === 'AbortError') return {
    text: t('Сервер не ответил вовремя. Откройте «Помощь при сбое».', 'Sunucu zamanında yanıt vermedi. «Bağlantı yardımı» bölümünü açın.'), detail: 'AUTH-TIMEOUT',
  };
  if (NETWORK.test(`${err?.name ?? ''} ${message}`)) return {
    text: t('Не удалось связаться с сервером входа. Откройте «Помощь при сбое».', 'Giriş sunucusuna ulaşılamadı. «Bağlantı yardımı» bölümünü açın.'), detail: 'AUTH-NETWORK',
  };
  if (code === 'invalid_credentials' || /invalid login credentials|Неверный логин/i.test(message)) return {
    text: t('Неверный логин или пароль.', 'Kullanıcı adı veya parola hatalı.'), detail: '',
  };
  if (/rate limit|too many/i.test(message) || err?.status === 429) return {
    text: t('Слишком много попыток входа. Подождите пару минут и попробуйте снова.', 'Çok fazla giriş denemesi yapıldı. Birkaç dakika sonra yeniden deneyin.'), detail,
  };
  return { text: t('Не удалось войти.', 'Giriş yapılamadı.'), detail };
}

export type ServerState = { state: 'checking' } | { state: 'ok'; ms: number; connection: Connection } | { state: 'down'; connection: Connection };

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
      setS(connection.auth.ok && connection.data.ok ? {state:'ok',ms:Math.max(connection.auth.ms,connection.data.ms),connection} : {state:'down',connection});
    });
    const recheck = () => setN(x=>x+1);
    window.addEventListener('online',recheck);
    return () => { active=false; ctrl.abort(); window.removeEventListener('online',recheck); };
  }, [n]);
  return [s, () => setN((x) => x + 1)];
}
