// Сессия и профиль пользователя. Разрешения в клиенте — только подсказка интерфейсу; сервер проверяет каждый запрос.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { command, from, rows, toAppError } from './backend';
import { setCurrencyMinorUnits } from './money';
import { clearUserData, PendingLocalWorkError } from './offline';
import { setRememberDevice, snapshot, supabase } from './supabase';

export interface Assignment {
  id: string;
  role: 'franchise_manager' | 'franchisee' | 'franchisee_staff' | 'franchisee_manager' | 'technical_specialist';
  role_name: string;
  scope_type: 'company' | 'partner';
  scope_id: string | null;
  scope_name: string;
  permissions: string[];
}

export interface Me {
  user: { id: string; full_name: string; email: string; is_demo: boolean };
  assignments: Assignment[];
}

interface SessionState {
  status: 'loading' | 'signed-out' | 'signed-in';
  me: Me | null;
  scopeRevision: number;
  can: (perm: string) => boolean;
  /** Менеджер по франшизе: вся сеть. */
  isManager: boolean;
  /** Сотрудник франчайзи: смены и свой заработок. */
  isStaff: boolean;
  isTechnical: boolean;
  isTeamManager: boolean;
  changePassword: (password: string) => Promise<void>;
  signIn: (email: string, password: string, remember: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
}

/** Снимок последних ответов для мгновенного старта экранов (хранится рядом с сессией, стирается при выходе). */
export { snapshot };

const Ctx = createContext<SessionState | null>(null);

function accessKey(me: Me, includePermissions = true) {
  return me.assignments.map(a => JSON.stringify([
    a.role, a.scope_type, a.scope_id, includePermissions ? [...a.permissions].sort() : null,
  ])).sort().join('\n');
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [me, setMe] = useState<Me | null>(null);
  const [scopeRevision, setScopeRevision] = useState(0);
  const profileRequest = useRef(0);
  const renderedProfile = useRef<Me | null>(null);
  const signingOut = useRef(false);

  const applyMe = useCallback((data: Me) => {
    renderedProfile.current = data;
    setMe(data);
    setStatus('signed-in');
  }, []);

  const resetSession = useCallback((next: 'loading' | 'signed-out') => {
    profileRequest.current++;
    qc.clear();
    snapshot.clear();
    renderedProfile.current = null;
    setMe(null);
    setStatus(next);
  }, [qc]);

  const loadMe = useCallback(async (knownSession?: Session) => {
    if (!supabase || signingOut.current) return;
    const request = ++profileRequest.current;
    const isCurrent = () => request === profileRequest.current;
    try {
      let session: Session | null = knownSession ?? null;
      if (!knownSession) {
        const { data, error } = await supabase.auth.getSession();
        if (error) throw error;
        session = data.session;
      }
      if (!isCurrent()) return;
      if (!session) { resetSession('signed-out'); return; }

      let cached = renderedProfile.current ?? snapshot.get<Me>('me');
      if (cached && cached.user.id !== session.user.id) {
        qc.clear();
        snapshot.clear();
        renderedProfile.current = null;
        setMe(null);
        setStatus('loading');
        cached = null;
      }
      if (cached && !renderedProfile.current) {
        const currency = snapshot.get<{ code: string; minor_unit: number }[]>('currency');
        if (currency) setCurrencyMinorUnits(currency);
        applyMe(cached);
      }
      const data = await command<Me>('me', {}, { accessToken: session.access_token });
      if (!isCurrent()) return;
      if (data?.user?.id !== session.user.id) { resetSession('signed-out'); return; }
      if (cached && accessKey(cached) !== accessKey(data)) {
        const remoteQueries = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== 'local-queue' };
        if (accessKey(cached, false) !== accessKey(data, false)) {
          qc.removeQueries(remoteQueries);
          setScopeRevision(revision => revision + 1);
        } else {
          qc.removeQueries({ ...remoteQueries, type: 'inactive' });
          void qc.invalidateQueries({ ...remoteQueries, type: 'active' });
        }
      }
      snapshot.set('me', data);
      applyMe(data);
      if (!snapshot.get('currency')) {
        rows<{ code: string; minor_unit: number }>(from('currency').select('code, minor_unit')).then((c) => {
          if (!isCurrent()) return;
          snapshot.set('currency', c);
          setCurrencyMinorUnits(c);
        }, () => undefined);
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (toAppError(error).code === 'unauthenticated' || !renderedProfile.current) resetSession('signed-out');
      throw error;
    }
  }, [applyMe, qc, resetSession]);

  useEffect(() => {
    if (!supabase) {
      setStatus('signed-out');
      return;
    }
    let active = true;
    void loadMe().catch(() => undefined);
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (signingOut.current || (event !== 'SIGNED_OUT' && event !== 'SIGNED_IN')) return;
      if (event === 'SIGNED_IN' && session?.user.id === renderedProfile.current?.user.id) return;
      // Auth broadcasts can come from a tab with an independent sessionStorage.
      const next = ++profileRequest.current;
      setTimeout(() => { if (active && next === profileRequest.current) void loadMe().catch(() => undefined); }, 0);
    });
    const refresh = () => { if (renderedProfile.current) void loadMe().catch(() => undefined); };
    const refreshVisible = () => { if (document.visibilityState === 'visible' && navigator.onLine) refresh(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refreshVisible);
    const profileTimer = window.setInterval(refreshVisible, 60_000);
    return () => {
      active = false;
      profileRequest.current++;
      sub.subscription.unsubscribe();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.clearInterval(profileTimer);
    };
  }, [loadMe]);

  const signIn = useCallback(
    async (email: string, password: string, remember: boolean) => {
      if (!supabase) throw new Error('Supabase не настроен');
      if (signingOut.current) throw new Error('Дождитесь завершения выхода.');
      setRememberDevice(remember);
      const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      qc.clear();
      await loadMe(data.session ?? undefined);
    },
    [loadMe, qc],
  );

  const signOut = useCallback(async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    try {
      if (me?.user.id) {
        try {
          await clearUserData(me.user.id);
        } catch (cause) {
          if (cause instanceof PendingLocalWorkError) throw cause;
          throw new Error('Не удалось проверить неотправленные записи на устройстве. Повторите выход позже.', { cause });
        }
      }
      resetSession('loading');
      try {
        await supabase?.auth.signOut({ scope: 'local' });
        setRememberDevice(false);
      } finally {
        setStatus('signed-out');
      }
    } finally {
      signingOut.current = false;
    }
  }, [me, resetSession]);

  const changePassword = useCallback(async (password: string) => {
    if (!supabase) throw new Error('Supabase не настроен');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  }, []);

  const value = useMemo<SessionState>(() => {
    const perms = new Set(me?.assignments.flatMap((a) => a.permissions) ?? []);
    return {
      status,
      me,
      scopeRevision,
      can: (perm) => perms.has(perm),
      isTeamManager: !!me?.assignments.some(a => a.role === 'franchisee_manager') && !me.assignments.some(a=>a.role==='franchisee' || a.role==='franchise_manager'),
      isTechnical: !!me?.assignments.some(a=>a.role==='technical_specialist') && !me.assignments.some(a=>a.role==='franchise_manager'),
      isManager: me?.assignments.some((a) => a.role === 'franchise_manager') ?? false,
      isStaff: (me?.assignments.length ?? 0) > 0 && (me?.assignments.every((a) => a.role === 'franchisee_staff') ?? false),
      changePassword,
      signIn,
      signOut,
      reload: loadMe,
    };
  }, [status, me, scopeRevision, signIn, signOut, loadMe, changePassword]);

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
