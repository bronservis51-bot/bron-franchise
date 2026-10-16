import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell, Check, ChevronDown, LogOut, Menu, Search, User, Users, WifiOff, X, IdCard } from 'lucide-react';
import { useSession } from '../platform/session';
import { from, rows } from '../platform/backend';
import { quickLoginEnabled } from '../platform/config';
import { useT } from '../platform/i18n';
import { GROUP_TITLE, NAV, primaryMobile, type NavItem } from './nav';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { flushQueue } from '../modules/support/offlineQueue';

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

function useUnread() {
  const { me } = useSession();
  return useQuery({
    queryKey: ['notifications', 'unread'],
    enabled: Boolean(me),
    refetchInterval: 60_000,
    queryFn: async () => (await rows<{ id: string }>(from('notification').select('id').is('read_at', null).limit(100))).length,
  });
}

function ContextSwitcher() {
  const { me, context, setContext } = useSession();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  if (!me || me.assignments.length < 1) return null;
  const label = context ? `${context.scope_name}` : me.assignments.length > 1 ? t('Вся моя работа') : me.assignments[0].scope_name;
  return (
    <div style={{ position: 'relative', minWidth: 0 }} ref={ref}>
      <button className="ctx-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Рабочий контекст: для какой точки или партнёра вы действуете">
        <span>{label}</span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ left: 0, right: 'auto' }}>
          {me.assignments.length > 1 && (
            <button role="menuitemradio" aria-checked={!context} onClick={() => { setContext(null); setOpen(false); }}>
              {!context ? <Check size={16} aria-hidden /> : <span style={{ width: 16 }} />}Вся моя работа
            </button>
          )}
          {me.assignments.map((a) => (
            <button key={a.id} role="menuitemradio" aria-checked={context?.id === a.id} onClick={() => { setContext(a.id); setOpen(false); }}>
              {context?.id === a.id ? <Check size={16} aria-hidden /> : <span style={{ width: 16 }} />}
              <span><span style={{ display: 'block', fontWeight: 600 }}>{a.scope_name}</span><span className="faint">{a.role_name}{a.valid_to ? ` · до ${new Date(a.valid_to).toLocaleDateString()}` : ''}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me, signOut } = useSession();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="icon-btn" aria-label="Профиль" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}><User size={20} /></button>
      {open && (
        <div className="menu" role="menu">
          <div style={{ padding: '8px 10px' }}>
            <div style={{ fontWeight: 650 }}>{me?.user.full_name}</div>
            <div className="faint">{me?.user.email}</div>
          </div>
          <div className="sep" />
          <Link role="menuitem" to="/my-role" className="menu-link" onClick={() => setOpen(false)}><IdCard size={16} aria-hidden />{t('Моя должность')}</Link>
          {quickLoginEnabled && <button role="menuitem" onClick={() => void signOut()}><Users size={16} aria-hidden />{t('Сменить роль')}</button>}
          <button role="menuitem" onClick={() => void signOut()}><LogOut size={16} aria-hidden />{t('Выйти и очистить данные устройства')}</button>
        </div>
      )}
    </div>
  );
}

export function Shell() {
  const { can, isStaff, me } = useSession();
  const { t } = useT();
  const online = useOnline();
  const unread = useUnread();
  const nav = NAV.filter((n) => n.visible(can, isStaff));
  const mobile = primaryMobile(nav, can);
  const [more, setMore] = useState(false);
  const loc = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => setMore(false), [loc.pathname]);
  // Фокус на основное содержимое при смене экрана — для экранных дикторов (UX-08)
  useEffect(() => mainRef.current?.focus({ preventScroll: true }), [loc.pathname]);
  // Очередь офлайн-операций отправляется при открытии и при появлении сети (PWA-04)
  useEffect(() => {
    if (online && me) void flushQueue(me.user.id);
  }, [online, me]);

  const groups = (['work', 'franchise', 'knowledge', 'control'] as const).map((g) => ({ g, items: nav.filter((n) => n.group === g) })).filter((x) => x.items.length);
  const link = (n: NavItem) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
      <n.icon size={18} aria-hidden />{t(n.label)}
    </NavLink>
  );

  return (
    <div className="app">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>{t('К содержимому')}</a>
      <aside className="sidebar" aria-label="Основная навигация">
        <div className="brand">
          <LogoFull height={40} />
          <span className="brand-sub">{t('Рабочий кабинет')}</span>
        </div>
        <nav className="nav">
          {groups.map(({ g, items }) => (
            <div key={g}>
              {g !== 'work' && <div className="nav-group">{t(GROUP_TITLE[g])}</div>}
              {items.map(link)}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <BrandPattern rows={3} cols={6} />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="grow" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span className="mobile-mark"><LogoMark height={28} /></span>
            <ContextSwitcher />
          </div>
          {can('kb.read') && (
            <button className="icon-btn" aria-label="Поиск по базе знаний" onClick={() => navigate('/kb')}><Search size={20} /></button>
          )}
          <button className="icon-btn" aria-label={`Уведомления${unread.data ? `: ${unread.data} непрочитанных` : ''}`} onClick={() => navigate('/notifications')}>
            <Bell size={20} />
            {Boolean(unread.data) && <span className="badge-dot" aria-hidden />}
          </button>
          <UserMenu />
        </header>
        {!online && (
          <div className="alert tone-warning" role="status" style={{ margin: '12px 24px 0' }}>
            <WifiOff size={18} aria-hidden />
            <div className="alert-body">{t('Нет сети. Можно читать открытые экраны и писать черновики; отправка — после восстановления связи. Финансовые операции только онлайн.')}</div>
          </div>
        )}

        <main id="main" className="content" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
          <Outlet />
        </main>
      </div>
      <nav className="bottom-nav" aria-label="Навигация">
        {mobile.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
            <n.icon size={22} aria-hidden /><span className="nav-label">{t(n.short ?? n.label)}</span>
            {n.to === '/' && Boolean(unread.data) && <span className="dot" aria-hidden />}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog"><Menu size={22} aria-hidden /><span className="nav-label">{t('Ещё')}</span></button>
      </nav>
      {more && (
        <>
          <div className="sheet-backdrop" onClick={() => setMore(false)} />
          <div className="sheet" role="dialog" aria-label="Все разделы">
            <div className="row between" style={{ marginBottom: 8 }}>
              <h2>{t('Разделы')}</h2>
              <button className="icon-btn" aria-label="Закрыть" onClick={() => setMore(false)}><X size={20} /></button>
            </div>
            <nav className="nav">{nav.map(link)}</nav>
          </div>
        </>
      )}
    </div>
  );
}
