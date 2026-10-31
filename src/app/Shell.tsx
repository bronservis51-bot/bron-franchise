import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff, KeyRound, LogOut, Smartphone, User, WifiOff, X } from 'lucide-react';
import { onAvailableUpdate } from '../platform/update';
import { command, commandsInFlight } from '../platform/backend';
import { useSession } from '../platform/session';
import { dropOp, flushOutbox, onOutboxChange, queuedOps } from '../platform/outbox';
import { navFor, type NavItem } from './nav';
import { OrderTopButton } from '../modules/orders/OrderLink';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { Button, ConfirmDialog, Field, Input } from '../ui';
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
    const send = () => void flushOutbox(userId).then((r) => {
      if (r.sent) { toast(`Отправлено записей, сохранённых без сети: ${r.sent}`); void qc.invalidateQueries(); }
    }).catch(() => undefined);
    send();
    const timer = window.setInterval(send, 30000);
    window.addEventListener('focus', send);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', send); };
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
  const toast = useToast();
  const role = me?.assignments[0];
  const out = () => {
    if (pending) { toast('Сначала отправьте записи из очереди. При выходе данные не удаляются.'); return; }
    void signOut().catch(e => toast(e instanceof Error ? e.message : 'Не удалось выйти'));
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
  const { isManager, isStaff, me, can } = useSession();
  const online = useOnline();
  const loc = useLocation();
  const role = isManager ? 'manager' : isStaff ? 'staff' : 'franchisee';
  const nav = navFor(role).filter((n) => n.to !== '/rating' || can('rating.read'));
  const mainRef = useRef<HTMLElement>(null);
  const ops = useOutbox(me?.user.id, online);
  const [queueOpen, setQueueOpen] = useState(false);
  const [updateApp,setUpdateApp]=useState<(() => Promise<void>) | null>(null);
  const toast=useToast();
  useEffect(()=>onAvailableUpdate(fn=>setUpdateApp(()=>fn)),[]);
  const inbox = useQuery({ queryKey: ['kb', 'inbox'], enabled: Boolean(me?.assignments.length), refetchInterval: 120_000,
    queryFn: () => command<{ unanswered: number; new_answers: number }>('kb_inbox') });
  const kbCount = isManager ? inbox.data?.unanswered ?? 0 : inbox.data?.new_answers ?? 0;
  const leads = useQuery({ queryKey: ['leads', 'inbox'], enabled: isManager, refetchInterval: 120_000, queryFn: () => command<number>('lead_inbox') });
  const leadCount = leads.data ?? 0;
  // Фокус на основное содержимое при смене экрана — для экранных дикторов
  useEffect(() => mainRef.current?.focus({ preventScroll: true }), [loc.pathname]);

  const link = (n: NavItem, mobile = false) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
      <n.icon size={mobile ? 22 : 18} aria-hidden />{mobile ? <span className="nav-label">{n.label}</span> : n.label}
      {n.badge === 'kb' && kbCount > 0 && <span className={mobile ? 'dot' : 'count'} aria-label={`новых: ${kbCount}`}>{mobile ? '' : kbCount}</span>}
      {n.badge === 'leads' && leadCount > 0 && <span className={mobile ? 'dot' : 'count'} aria-label={`новых заявок: ${leadCount}`}>{mobile ? '' : leadCount}</span>}
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
          {role === 'franchisee' && <OrderTopButton />}
          <UserMenu pending={ops.length} />
        </header>
        {updateApp && <div className="alert tone-info" role="status" style={{margin:'12px 24px 0'}}><div className="alert-body">Доступна новая версия приложения.</div><Button size="sm" onClick={()=>{
          if (ops.length || commandsInFlight() || document.querySelector('[role="dialog"]')) { toast('Завершите ввод и отправку записей перед обновлением.'); return; }
          void updateApp();
        }}>Обновить</Button></div>}
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
            <Button size="sm" onClick={() => setQueueOpen(true)}>Посмотреть записи</Button>
          </div>
        )}
        {queueOpen && me && <QueueDialog userId={me.user.id} onClose={() => setQueueOpen(false)} />}
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

function QueueDialog({userId,onClose}:{userId:string;onClose:()=>void}) {
  const qc=useQueryClient();
  const q=useQuery({queryKey:['local-queue',userId],queryFn:()=>queuedOps(userId)});
  const [copied,setCopied]=useState(false);
  const [error,setError]=useState<unknown>(null);
  const download=()=>{
    const blob=new Blob([JSON.stringify({format:'bron-pending',exported_at:new Date().toISOString(),operations:q.data??[]},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='bron-pending-records.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); setCopied(true);
  };
  return <ConfirmDialog open title="Неотправленные записи" confirmLabel="Закрыть" onConfirm={onClose} onClose={onClose} error={error}>
    <p className="faint">При конфликте откройте день заново и сверьте суммы. Сначала сохраните копию, затем удалите обработанную запись из очереди.</p>
    <Button disabled={!q.data?.length} onClick={download}>Скачать копию записей</Button>
    {q.data?.map(o=><div key={o.clientOpId} style={{padding:'12px 0',borderBottom:'1px solid var(--border)'}}>
      <strong>{o.kind.startsWith('revenue') ? `Выручка за ${String(o.payload.day)}` : 'Закрытие смены'}</strong>
      <div className="faint">Наличные: {(Number(o.payload.cash)/100).toLocaleString('ru-RU')} · карта: {(Number(o.payload.card)/100).toLocaleString('ru-RU')}</div>
      <div className="faint">{o.lastError ?? 'Ожидает отправки'}</div>
      {o.lastError && <Button variant="ghost" size="sm" disabled={!copied} onClick={()=>{
        void dropOp(userId,o.clientOpId).then(()=>qc.invalidateQueries({queryKey:['local-queue',userId]})).catch(setError);
      }}>Копия сохранена — удалить из очереди</Button>}
    </div>)}
  </ConfirmDialog>;
}
