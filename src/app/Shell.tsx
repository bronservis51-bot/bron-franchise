import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff, KeyRound, LogOut, Smartphone, User, Users, WifiOff, X } from 'lucide-react';
import { command } from '../platform/backend';
import { useSession } from '../platform/session';
import { quickLoginEnabled } from '../platform/config';
import { flushOutbox, onOutboxChange, queuedOps } from '../platform/outbox';
import { navFor, type NavItem } from './nav';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { ConfirmDialog, Field, Input } from '../ui';
import { useToast } from '../ui/toast';

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Записи, сохранённые без сети: отправляются сами при появлении связи. */
function useOutbox(userId: string | undefined, online: boolean) {
  const qc = useQueryClient();
  const toast = useToast();
  const [ops, setOps] = useState<{ id: string; error?: string }[]>([]);
  useEffect(() => {
    if (!userId) return;
    const load = () => void queuedOps(userId).then((l) => setOps(l.map((o) => ({ id: o.clientOpId, error: o.lastError }))));
    load();
    return onOutboxChange(load);
  }, [userId]);
  useEffect(() => {
    if (!userId || !online) return;
    void flushOutbox(userId).then((r) => {
      if (r.sent) { toast(`Отправлено записей, сохранённых без сети: ${r.sent}`); void qc.invalidateQueries(); }
    });
  }, [userId, online, qc, toast]);
  return ops;
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { changePassword } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const bad = pw.length < 6 || pw !== pw2;
  return (
    <ConfirmDialog open title="Сменить пароль" confirmLabel="Сохранить пароль" busy={busy} error={error} disabled={bad} onClose={onClose}
      onConfirm={async () => {
        setBusy(true); setError(null);
        try { await changePassword(pw); toast('Пароль изменён'); onClose(); } catch (e) { setError(e); } finally { setBusy(false); }
      }}>
      <Field label="Новый пароль" hint="Минимум 6 символов">{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
      <Field label="Ещё раз" error={pw2 && pw !== pw2 ? 'Пароли не совпадают' : null}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

function UserMenu({ pending }: { pending: number }) {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const role = me?.assignments[0];
  const out = () => {
    if (pending && !window.confirm(`На устройстве есть неотправленные записи (${pending}). При выходе они пропадут. Выйти?`)) return;
    void signOut();
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="user-btn" aria-label="Профиль" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="user-name hide-mobile">{me?.user.full_name}</span><User size={20} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div style={{ padding: '8px 10px' }}>
            <div style={{ fontWeight: 650 }}>{me?.user.full_name}</div>
            <div className="faint">{role ? `${role.role_name}${role.scope_type === 'partner' ? ` · ${role.scope_name}` : ''}` : 'Нет доступа'}</div>
            <div className="faint">{me?.user.email?.endsWith('@staff.bron.local') ? `вход по телефону +${me.user.email.split('@')[0]}` : me?.user.email}</div>
          </div>
          <div className="sep" />
          <button role="menuitem" onClick={() => { setOpen(false); setPw(true); }}><KeyRound size={16} aria-hidden />Сменить пароль</button>
          {quickLoginEnabled && <button role="menuitem" onClick={out}><Users size={16} aria-hidden />Сменить роль</button>}
          <button role="menuitem" onClick={out}><LogOut size={16} aria-hidden />Выйти</button>
        </div>
      )}
      {pw && <PasswordDialog onClose={() => setPw(false)} />}
    </div>
  );
}

/** Подсказка установить на экран телефона (один раз, можно закрыть). */
function InstallHint() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('bron.install-hint') === 'off'; } catch { return false; } });
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone);
  const mobile = typeof navigator !== 'undefined' && /iphone|ipad|android/i.test(navigator.userAgent);
  if (hidden || standalone || !mobile) return null;
  const ios = /iphone|ipad/i.test(navigator.userAgent);
  return (
    <div className="install-hint" role="status">
      <Smartphone size={18} aria-hidden />
      <div className="alert-body">Добавьте кабинет на экран телефона — он будет открываться как приложение.
        <span className="faint" style={{ display: 'block' }}>{ios ? 'Safari: кнопка «Поделиться» → «На экран «Домой»».' : 'Chrome: меню ⋮ → «Добавить на главный экран».'}</span></div>
      <button type="button" className="icon-btn" aria-label="Скрыть" onClick={() => { setHidden(true); try { localStorage.setItem('bron.install-hint', 'off'); } catch { /* удобство */ } }}><X size={16} /></button>
    </div>
  );
}

export function Shell() {
  const { isManager, isStaff, me } = useSession();
  const online = useOnline();
  const role = isManager ? 'manager' : isStaff ? 'staff' : 'franchisee';
  const nav = navFor(role);
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const ops = useOutbox(me?.user.id, online);
  const inbox = useQuery({ queryKey: ['kb', 'inbox'], enabled: Boolean(me?.assignments.length), refetchInterval: 120_000,
    queryFn: () => command<{ unanswered: number; new_answers: number }>('kb_inbox') });
  const kbCount = isManager ? inbox.data?.unanswered ?? 0 : inbox.data?.new_answers ?? 0;
  // Фокус на основное содержимое при смене экрана — для экранных дикторов
  useEffect(() => mainRef.current?.focus({ preventScroll: true }), [loc.pathname]);

  const link = (n: NavItem, mobile = false) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
      <n.icon size={mobile ? 22 : 18} aria-hidden />{mobile ? <span className="nav-label">{n.label}</span> : n.label}
      {n.badge === 'kb' && kbCount > 0 && <span className={mobile ? 'dot' : 'count'} aria-label={`новых: ${kbCount}`}>{mobile ? '' : kbCount}</span>}
    </NavLink>
  );

  return (
    <div className="app">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>К содержимому</a>
      <aside className="sidebar" aria-label="Основная навигация">
        <div className="brand">
          <LogoFull height={40} />
          <span className="brand-sub">{isManager ? 'Менеджер по франшизе' : isStaff ? 'Кабинет сотрудника' : 'Кабинет франчайзи'}</span>
        </div>
        <nav className="nav">{nav.map((n) => link(n))}</nav>
        <div className="sidebar-foot">
          <BrandPattern rows={3} cols={6} />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="mobile-mark"><LogoMark height={28} /></span>
          <div className="grow topbar-title">{me?.assignments[0]?.scope_type === 'partner' ? me.assignments[0].scope_name : ''}</div>
          <UserMenu pending={ops.length} />
        </header>
        {!online && (
          <div className="alert tone-warning" role="status" style={{ margin: '12px 24px 0' }}>
            <WifiOff size={18} aria-hidden />
            <div className="alert-body">Нет сети. Выручку и закрытие смены можно сохранить — они отправятся сами, когда связь вернётся.</div>
          </div>
        )}
        {ops.length > 0 && (
          <div className="alert tone-info" role="status" style={{ margin: '12px 24px 0' }}>
            <CloudOff size={18} aria-hidden />
            <div className="alert-body">Сохранено на устройстве и ждёт отправки: {ops.length}.{ops.some((o) => o.error) && <span className="faint" style={{ display: 'block' }}>Сервер не принял запись: {ops.find((o) => o.error)?.error}</span>}</div>
          </div>
        )}
        <main id="main" className="content" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
          <InstallHint />
          {me && !me.assignments.length ? (
            <div className="state"><h3>Доступ ещё не выдан</h3><div>Попросите менеджера по франшизе (или своего франчайзи) выдать доступ.</div></div>
          ) : <Outlet />}
        </main>
      </div>
      <nav className={`bottom-nav cols-${nav.length}`} aria-label="Навигация">
        {nav.map((n) => link(n, true))}
      </nav>
    </div>
  );
}
