// Сессия и профиль пользователя. Разрешения в клиенте — только подсказка интерфейсу; сервер проверяет каждый запрос (AUTH-01).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { command, from, rows, toAppError } from './backend';
import { setCurrencyMinorUnits } from './money';
import { clearUserData } from './offline';
import { setLocale, type Locale } from './i18n';
import { setRememberDevice, snapshot, supabase } from './supabase';

export interface Assignment {
  id: string;
  role: string;
  role_name: string;
  role_kind: 'staff' | 'partner';
  scope_type: 'company' | 'direction' | 'partner' | 'location';
  scope_id: string | null;
  scope_name: string;
  valid_to: string | null;
  permissions: string[];
}

export interface Me {
  user: { id: string; full_name: string; email: string; locale: Locale; status: string; is_demo: boolean };
  operator: { name: string; is_demo: boolean; sod_policy: string } | null;
  assignments: Assignment[];
}

interface SessionState {
  status: 'loading' | 'signed-out' | 'signed-in';
  me: Me | null;
  /** Выбранный рабочий контекст (назначение) или null = вся моя работа. */
  context: Assignment | null;
  setContext: (id: string | null) => void;
  can: (perm: string) => boolean;
  isStaff: boolean;
  signIn: (email: string, password: string, remember: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

/** Снимок последних ответов для мгновенного старта экранов (хранится рядом с сессией, стирается при выходе). */
export { snapshot };

const Ctx = createContext<SessionState | null>(null);
const CONTEXT_KEY = (userId: string) => `bron.context.${userId}`;

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [contextId, setContextId] = useState<string | null>(null);

  const applyMe = useCallback((data: Me) => {
    setMe(data);
    setLocale(data.user.locale === 'tr' ? 'tr' : 'ru');
    try {
      setContextId(localStorage.getItem(CONTEXT_KEY(data.user.id)));
    } catch {
      setContextId(null);
    }
    setStatus('signed-in');
  }, []);

  const loadMe = useCallback(async () => {
    const data = await command<Me>('me');
    if (!data?.user) {
      snapshot.clear();
      setMe(null);
      setStatus('signed-out');
      return;
    }
    snapshot.set('me', data);
    applyMe(data);
    rows<{ code: string; minor_unit: number }>(from('currency').select('code, minor_unit')).then((c) => {
      snapshot.set('currency', c);
      setCurrencyMinorUnits(c);
    }, () => undefined);
  }, [applyMe]);

  useEffect(() => {
    if (!supabase) {
      setStatus('signed-out');
      return;
    }
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (!data.session) {
        snapshot.clear();
        setStatus('signed-out');
        return;
      }
      // Повторный вход: кабинет открывается сразу по сохранённому профилю, а профиль с сервера обновляет его в фоне
      const cached = snapshot.get<Me>('me');
      const fresh = cached?.user?.id === data.session.user.id;
      if (fresh) {
        const cur = snapshot.get<{ code: string; minor_unit: number }[]>('currency');
        if (cur) setCurrencyMinorUnits(cur);
        applyMe(cached);
      }
      loadMe().catch((e) => {
        // Без сети остаёмся в кабинете с сохранённым профилем; выход — только если сессия недействительна
        if (!fresh || toAppError(e).code === 'unauthenticated') setStatus('signed-out');
      });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        snapshot.clear();
        setMe(null);
        setStatus('signed-out');
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadMe, applyMe]);

  const signIn = useCallback(
    async (email: string, password: string, remember: boolean) => {
      if (!supabase) throw new Error('Supabase не настроен');
      setRememberDevice(remember);
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      qc.clear();
      // Первый экран грузится параллельно с профилем, а не после него
      void qc.prefetchQuery({ queryKey: ['today', null, null], queryFn: () => command('today', { partner: null, location: null }) });
      await loadMe();
    },
    [loadMe, qc],
  );

  const signOut = useCallback(async () => {
    const uid = me?.user.id;
    if (uid) await clearUserData(uid); // черновики и очередь пользователя удаляются (PWA-05)
    qc.clear();
    snapshot.clear();
    await supabase?.auth.signOut();
    setRememberDevice(false);
    setMe(null);
    setStatus('signed-out');
  }, [me, qc]);

  const value = useMemo<SessionState>(() => {
    const perms = new Set(me?.assignments.flatMap((a) => a.permissions) ?? []);
    const context = me?.assignments.find((a) => a.id === contextId) ?? null;
    return {
      status,
      me,
      context,
      setContext: (id) => {
        setContextId(id);
        try {
          if (me) id ? localStorage.setItem(CONTEXT_KEY(me.user.id), id) : localStorage.removeItem(CONTEXT_KEY(me.user.id));
        } catch {
          /* удобство, не обязательное */
        }
      },
      can: (perm) => perms.has(perm),
      isStaff: me?.assignments.some((a) => a.role_kind === 'staff') ?? false,
      signIn,
      signOut,
      reload: loadMe,
    };
  }, [status, me, contextId, signIn, signOut, loadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider отсутствует');
  return v;
}

export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('Нет пользователя');
  return me;
}

/** Фильтр по выбранному контексту для запросов: партнёр/точка. */
export function useScopeFilter() {
  const { context } = useSession();
  return {
    partnerId: context?.scope_type === 'partner' ? context.scope_id : null,
    locationId: context?.scope_type === 'location' ? context.scope_id : null,
  };
}
