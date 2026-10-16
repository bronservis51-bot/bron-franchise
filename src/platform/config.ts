// Настройки окружения (COST-14): URL и publishable-ключ — публичные значения; секретов в клиенте нет (COST-18).

export type AppEnv = 'demo' | 'staging' | 'production';

export const config = {
  supabaseUrl: (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '',
  supabaseKey: (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined)?.trim() ?? '',
  appEnv: ((import.meta.env.VITE_APP_ENV as string | undefined) ?? 'demo') as AppEnv,
  version: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.1.0',
  /**
   * Быстрый вход по ролям — ТОЛЬКО для демо-стенда с синтетическими данными (решение владельца 13.10.2026).
   * Общий демо-пароль становится публичным: включать нельзя при реальных данных.
   */
  demoQuickPassword: (import.meta.env.VITE_DEMO_QUICK_PASSWORD as string | undefined)?.trim() ?? '',
};

// http разрешён только для локального бэкенда разработки (scripts/local-backend.mjs)
const isLocalDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.supabaseUrl);
export const isConfigured =
  (config.supabaseUrl.startsWith('https://') || isLocalDev) && !config.supabaseUrl.includes('YOUR-PROJECT') && config.supabaseKey.length > 20;
export const isLocalBackend = isLocalDev;
export const quickLoginEnabled = config.appEnv === 'demo' && config.demoQuickPassword.length >= 8;

// Защита от ошибки конфигурации: секретный ключ никогда не должен попасть в сборку.
if (/^sb_secret_/.test(config.supabaseKey) || /service_role/.test(atobSafe(config.supabaseKey.split('.')[1] ?? ''))) {
  throw new Error('В сборку передан секретный ключ Supabase. Используйте publishable/anon ключ.');
}

function atobSafe(s: string): string {
  try {
    return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return '';
  }
}
