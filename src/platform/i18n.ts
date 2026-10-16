// Локализация RU/TR с первого этапа (SUP-08). Ключ — русская строка; турецкий словарь переводит интерфейс.
// Договоры, ставки и реквизиты не переводятся автоматически: это данные, а не строки интерфейса.
import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import { tr } from './i18n.tr';
import { tr2 } from './i18n.tr2';

export type Locale = 'ru' | 'tr';

void i18n.use(initReactI18next).init({
  resources: { ru: { translation: {} }, tr: { translation: { ...tr2, ...tr } } },
  lng: 'ru',
  fallbackLng: 'ru',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false }, // React экранирует сам
  returnEmptyString: false,
});

export function setLocale(l: Locale) {
  void i18n.changeLanguage(l);
  document.documentElement.lang = l;
}

export const intlLocale = () => (i18n.language === 'tr' ? 'tr-TR' : 'ru-RU');

export function useT() {
  const { t, i18n: inst } = useTranslation();
  return { t: (s: string, vars?: Record<string, unknown>) => t(s, { defaultValue: s, ...vars }) as string, locale: (inst.language as Locale) ?? 'ru' };
}

// defaultValue — русская строка: интерполяция работает и без записи в словаре
export const t = (s: string, vars?: Record<string, unknown>) => i18n.t(s, { defaultValue: s, ...vars }) as string;
