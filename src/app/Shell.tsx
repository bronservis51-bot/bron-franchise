import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { LogOut, User, Users, WifiOff } from 'lucide-react';
import { useSession } from '../platform/session';
import { quickLoginEnabled } from '../platform/config';
import { navFor, type NavItem } from './nav';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';

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

function UserMenu() {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const role = me?.assignments[0];
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
            <div className="faint">{me?.user.email}</div>
          </div>
          <div className="sep" />
          {quickLoginEnabled && <button role="menuitem" onClick={() => void signOut()}><Users size={16} aria-hidden />Сменить роль</button>}
          <button role="menuitem" onClick={() => void signOut()}><LogOut size={16} aria-hidden />Выйти</button>
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const { isManager, me } = useSession();
  const online = useOnline();
  const nav = navFor(isManager);
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // Фокус на основное содержимое при смене экрана — для экранных дикторов
  useEffect(() => mainRef.current?.focus({ preventScroll: true }), [loc.pathname]);

  const link = (n: NavItem) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
      <n.icon size={18} aria-hidden />{n.label}
    </NavLink>
  );

  return (
    <div className="app">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>К содержимому</a>
      <aside className="sidebar" aria-label="Основная навигация">
        <div className="brand">
          <LogoFull height={40} />
          <span className="brand-sub">{isManager ? 'Менеджер по франшизе' : 'Кабинет франчайзи'}</span>
        </div>
        <nav className="nav">{nav.map(link)}</nav>
        <div className="sidebar-foot">
          <BrandPattern rows={3} cols={6} />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="mobile-mark"><LogoMark height={28} /></span>
          <div className="grow topbar-title">{me?.assignments[0]?.scope_type === 'partner' ? me.assignments[0].scope_name : ''}</div>
          <UserMenu />
        </header>
        {!online && (
          <div className="alert tone-warning" role="status" style={{ margin: '12px 24px 0' }}>
            <WifiOff size={18} aria-hidden />
            <div className="alert-body">Нет сети. Открытые экраны можно читать; сохранить выручку получится после восстановления связи.</div>
          </div>
        )}
        <main id="main" className="content" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
          {me && !me.assignments.length ? (
            <div className="state"><h3>Доступ ещё не выдан</h3><div>Попросите менеджера по франшизе выдать доступ к вашим точкам.</div></div>
          ) : <Outlet />}
        </main>
      </div>
      <nav className={`bottom-nav cols-${nav.length}`} aria-label="Навигация">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
            <n.icon size={22} aria-hidden /><span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
