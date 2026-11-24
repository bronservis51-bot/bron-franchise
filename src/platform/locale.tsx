import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { from, single } from './backend';
import { snapshot, useSession, type Me } from './session';

export type Language = 'ru' | 'tr';
type Choice = Language | 'auto';
export type UiLocale = 'ru-RU' | 'tr-TR';

interface LocaleContext {
  language: Language;
  locale: UiLocale;
  choice: Choice;
  t: (russian: string, turkish: string) => string;
  setLanguage: (choice: Choice) => void;
}

const loginKey = 'bron.locale.login';
const pendingKey = 'bron.locale.pending';
const userKey = (id: string) => `bron.locale.user.${id}`;
const parseLanguage = (value: string | null): Language | null => value === 'ru' || value === 'tr' ? value : null;
const read = (key: string, session = false) => {
  try { return parseLanguage((session ? sessionStorage : localStorage).getItem(key)); }
  catch { return null; }
};
function save(key: string, value: Language | null, session = false) {
  try {
    const storage = session ? sessionStorage : localStorage;
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch { /* Manual choice remains available for this mounted session. */ }
}

export function franchiseeLocaleScope(me: Me | null) {
  if (!me || me.assignments.some(a => a.scope_type === 'company')) return null;
  const scopes = new Set(me.assignments.flatMap(a =>
    a.role === 'franchisee' && a.scope_type === 'partner' && a.scope_id ? [a.scope_id] : []));
  return scopes.size === 1 ? [...scopes][0] : null;
}

export const languageForCountry = (country: string | null | undefined): Language => country === 'TR' ? 'tr' : 'ru';
export const localized = (language: Language, russian: string, turkish: string): string => language === 'tr' ? turkish : russian;

const Locale = createContext<LocaleContext>({
  language: 'ru', locale: 'ru-RU', choice: 'auto', t: russian => russian, setLanguage: () => undefined,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const { me, status } = useSession();
  const userId = me?.user.id;
  const scope = franchiseeLocaleScope(me);
  const [guest, setGuest] = useState(() => read(loginKey));
  const [pending, setPending] = useState(() => read(pendingKey, true));
  const [manual, setManual] = useState<Record<string, Language | null>>({});
  const [readyAccount, setReadyAccount] = useState<string | null>(null);
  const savedChoice = userId ? pending ?? (Object.hasOwn(manual, userId) ? manual[userId] : read(userKey(userId))) : guest;
  const countryKey = `locale-country:${userId}:${scope}`;
  const country = useQuery({
    queryKey: ['locale-country', userId, scope],
    enabled: Boolean(userId && scope && !savedChoice),
    retry: false,
    staleTime: 60_000,
    initialData: () => snapshot.get<string>(countryKey) ?? undefined,
    queryFn: async () => {
      const data = await single<{ country: string }>(from('partner').select('country').eq('id', scope!));
      if (data?.country) snapshot.set(countryKey, data.country);
      return data?.country ?? null;
    },
  });
  const language = savedChoice ?? languageForCountry(country.data);
  const locale = language === 'tr' ? 'tr-TR' : 'ru-RU';
  const t = useCallback((ru: string, tr: string) => localized(language, ru, tr), [language]);
  const initializingAccount = status === 'signed-in' && country.isLoading && readyAccount !== userId;

  useEffect(() => {
    if (!userId || !pending) return;
    save(userKey(userId), pending);
    save(pendingKey, null, true);
    setManual(current => ({ ...current, [userId]: pending }));
    setPending(null);
  }, [userId, pending]);

  useEffect(() => {
    if (status === 'signed-out') setReadyAccount(null);
    else if (!initializingAccount && userId) setReadyAccount(userId);
  }, [initializingAccount, status, userId]);

  useEffect(() => { document.documentElement.lang = language; }, [language]);

  const setLanguage = (choice: Choice) => {
    const value = choice === 'auto' ? null : choice;
    if (userId) {
      save(userKey(userId), value);
      save(pendingKey, null, true);
      setPending(null);
      setManual(current => ({ ...current, [userId]: value }));
    } else {
      save(loginKey, value);
      save(pendingKey, value, true);
      setGuest(value);
      setPending(value);
    }
  };

  return (
    <Locale.Provider value={{ language, locale, choice: savedChoice ?? 'auto', t, setLanguage }}>
      {initializingAccount
        ? <div className="boot-screen" role="status" aria-label={t('Загрузка', 'Yükleniyor')}><div className="boot-bar" /></div>
        : children}
    </Locale.Provider>
  );
}

export const useLocale = () => useContext(Locale);
