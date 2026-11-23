import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff, KeyRound, LogOut, Mail, Phone, Smartphone, User, Users, WifiOff, X } from 'lucide-react';
import { AppError, command } from '../platform/backend';
import { useSession } from '../platform/session';
import { phoneLoginDigits } from '../platform/login';
import { changeManagerPhoneLogin } from '../platform/managerLogin';
import { dropOp, flushOutbox, notifyOutboxChange, onOutboxChange, queuedOperationState, queuedOps } from '../platform/outbox';
import { canOpenStaffDirectory, canOrderMaterials, navFor, type NavItem } from './nav';
import { OrderTopButton } from '../modules/orders/OrderLink';
import { ownedTeamPartner } from '../modules/staff/TeamAccounts';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { Button, ConfirmDialog, Field, Input } from '../ui';
import { useToast } from '../ui/toast';
import { InstallButton, InstallDialog, useInstallState } from './InstallApp';
import { AppUpdateBanner } from './AppUpdateBanner';
import { ManagerRecoverySettings } from './ManagerRecoverySettings';
import { installDevice } from '../platform/install';
import { exportLocalRecovery, importLocalRecovery, MAX_RECOVERY_BYTES, parseLocalRecovery, type LocalRecovery } from '../platform/localRecovery';
import { sameJson, type QueuedOperation } from '../platform/offline';

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
  const queue = useQuery({
    queryKey: ['local-queue', userId],
    queryFn: () => queuedOps(userId!),
    enabled: Boolean(userId),
    networkMode: 'always',
  });
  const [sendError, setSendError] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const sendNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!userId) return;
    return onOutboxChange(() => void qc.invalidateQueries({ queryKey: ['local-queue', userId], exact: true }));
  }, [userId, qc]);
  useEffect(() => {
    setSending(false);
    setSendError(null);
    if (!userId || !online) return;
    let active = true;
    let running = false;
    const send = () => {
      if (running) return;
      running = true;
      setSending(true);
      setSendError(null);
      void flushOutbox(userId).then((result) => {
        if (active && result.sent) {
          toast(`Отправлено записей, сохранённых без сети: ${result.sent}`);
          void qc.invalidateQueries();
        }
      }).catch(e => { if (active) setSendError(e); }).finally(() => {
        running = false;
        if (active) setSending(false);
      });
    };
    sendNow.current = send;
    send();
    const timer = window.setInterval(send, 30000);
    window.addEventListener('focus', send);
    return () => {
      active = false;
      sendNow.current = () => undefined;
      window.clearInterval(timer);
      window.removeEventListener('focus', send);
    };
  }, [userId, online, qc, toast]);
  const ops = queue.data ?? [];
  const waiting = ops.filter(op => queuedOperationState(op) !== 'blocked').length;
  return {
    ops, waiting, blocked: ops.length - waiting, loading: queue.isLoading, readError: queue.error, sendError, sending,
    retry: () => sendNow.current(), refresh: () => void queue.refetch(),
  };
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

function ManagerLoginDialog({ onClose }: { onClose: () => void }) {
  const { me, reload } = useSession();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const digits = phoneLoginDigits(phone);
  const submit = async () => {
    if (!me || !digits || !password || busy) return;
    setBusy(true); setError(null);
    try {
      const changed = await changeManagerPhoneLogin(me.user, digits, password);
      toast(changed ? 'Логин для входа изменён' : 'Этот номер уже используется для вашего входа');
      onClose();
      void reload().catch(() => toast('Обновите страницу, чтобы увидеть новый логин.'));
    } catch (cause) {
      setError(cause);
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog open title="Сменить логин" confirmLabel="Сохранить логин" busy={busy} error={error}
      disabled={!digits || !password} dirty={Boolean(phone)} onClose={onClose} onConfirm={submit}>
      <p className="muted">В следующий раз войдите с новым номером и текущим паролем. Другие сеансы завершатся.</p>
      <Field label="Номер телефона для входа" required hint="Укажите номер с кодом страны.">{(id, describedBy) =>
        <Input id={id} aria-describedby={describedBy} type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} required />}
      </Field>
      <Field label="Текущий пароль" required>{id =>
        <Input id={id} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />}
      </Field>
    </ConfirmDialog>
  );
}

function UserMenu({ pending, onLocalWork, showTeamAccess }: { pending: number; onLocalWork: () => void; showTeamAccess: boolean }) {
  const { me, isManager, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const [phone, setPhone] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const installState = useInstallState();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);
  const toast = useToast();
  const out = () => {
    if (pending) { toast('Сначала отправьте записи из очереди. При выходе данные не удаляются.'); return; }
    void signOut().catch(e => toast(e instanceof Error ? e.message : 'Не удалось выйти'));
  };
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="user-btn" aria-label="Профиль" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <User size={20} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div style={{ padding: '8px 10px' }}>
            <div style={{ fontWeight: 650 }}>{me?.user.full_name}</div>
            <div className="faint">{me?.user.email?.endsWith('@staff.bron.local') ? `вход по телефону +${me.user.email.split('@')[0]}` : me?.user.email}</div>
          </div>
          <div className="sep" />
          <button role="menuitem" onClick={() => { setOpen(false); setPw(true); }}><KeyRound size={16} aria-hidden />Сменить пароль</button>
          {isManager && <button role="menuitem" onClick={() => { setOpen(false); setPhone(true); }}><Phone size={16} aria-hidden />Сменить логин</button>}
          {isManager && <button role="menuitem" onClick={() => { setOpen(false); setRecovery(true); }}><Mail size={16} aria-hidden />Почта для восстановления</button>}
          {showTeamAccess && <Link role="menuitem" to="/team-access" onClick={() => setOpen(false)}><Users size={16} aria-hidden />Управляющие</Link>}
          <button role="menuitem" onClick={() => { setOpen(false); onLocalWork(); }}><CloudOff size={16} aria-hidden />Локальные записи</button>
          {!installState.installed && <button role="menuitem" onClick={() => { setOpen(false); setInstallOpen(true); }}><Smartphone size={16} aria-hidden />Как установить приложение</button>}
          <button role="menuitem" onClick={out}><LogOut size={16} aria-hidden />Выйти</button>
        </div>
      )}
      {pw && <PasswordDialog onClose={() => setPw(false)} />}
      {isManager && phone && <ManagerLoginDialog onClose={() => setPhone(false)} />}
      {isManager && recovery && <ManagerRecoverySettings onClose={() => setRecovery(false)} />}
      {installOpen && <InstallDialog onClose={() => setInstallOpen(false)} />}
    </div>
  );
}

/** Подсказка установить на экран телефона (один раз, можно закрыть). */
function InstallHint() {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('bron.install-hint') === 'off'; } catch { return false; } });
  const state = useInstallState();
  const mobile = installDevice(navigator.userAgent, navigator.maxTouchPoints) !== 'desktop';
  if (hidden || state.installed || !mobile) return null;
  return (
    <div className="install-hint" role="status">
      <Smartphone size={18} aria-hidden />
      <div className="alert-body">Добавьте кабинет на экран телефона — он будет открываться как приложение.
        <div style={{ marginTop: 8 }}><InstallButton /></div></div>
      <button type="button" className="icon-btn" aria-label="Скрыть" onClick={() => { setHidden(true); try { localStorage.setItem('bron.install-hint', 'off'); } catch { /* удобство */ } }}><X size={16} /></button>
    </div>
  );
}

export function Shell() {
  const { isManager, isStaff, isTeamManager, isTechnical, me, can } = useSession();
  const online = useOnline();
  const loc = useLocation();
  const role = isManager ? 'manager' : isTechnical ? 'support' : isStaff ? 'staff' : isTeamManager ? 'team' : 'franchisee';
  const nav = navFor(role, canOpenStaffDirectory(can)).filter((n) => n.to !== '/rating' || can('rating.read'));
  const showOrder = role === 'franchisee' || ((role === 'staff' || role === 'team') && canOrderMaterials(can));
  const mainRef = useRef<HTMLElement>(null);
  const outbox = useOutbox(me?.user.id, online);
  const [queueOpen, setQueueOpen] = useState(false);
  const inbox = useQuery({ queryKey: ['kb', 'inbox'], enabled: Boolean(me?.assignments.length), refetchInterval: 120_000, staleTime: 120_000,
    queryFn: () => command<{ unanswered: number; new_answers: number }>('kb_inbox') });
  const kbCount = can('kb.edit') ? inbox.data?.unanswered ?? 0 : inbox.data?.new_answers ?? 0;
  const leads = useQuery({ queryKey: ['leads', 'inbox'], enabled: isManager && loc.pathname !== '/leads', staleTime: 120_000, refetchInterval: 120_000, queryFn: () => command<number>('lead_inbox') });
  const learning = useQuery({queryKey:['learning','notice'],queryFn:()=>command<{new_day:boolean}>('learning_notice'),staleTime:60_000,refetchInterval:60_000});
  const leadCount = leads.data ?? 0;
  // Фокус на основное содержимое при смене экрана — для экранных дикторов
  useEffect(() => mainRef.current?.focus({ preventScroll: true }), [loc.pathname]);

  const link = (n: NavItem, mobile = false) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
      <n.icon size={mobile ? 22 : 18} aria-hidden />{mobile ? <span className="nav-label">{n.label}</span> : n.label}
      {n.badge === 'learning' && learning.data?.new_day && <span className="learning-dot" aria-label="Загляните в обучение сегодня" />}
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
        </div>
        <nav className="nav">{nav.map((n) => link(n))}</nav>
        <div className="sidebar-foot">
          <BrandPattern rows={3} cols={6} />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="mobile-mark"><LogoMark height={28} /></span>
          <div className="grow topbar-title">{me?.user.full_name ?? ''}</div>
          {showOrder && <OrderTopButton />}
          <UserMenu pending={outbox.ops.length} onLocalWork={() => setQueueOpen(true)} showTeamAccess={role === 'franchisee' && Boolean(ownedTeamPartner(me))} />
        </header>
        {queueOpen && me && <QueueDialog key={me.user.id} userId={me.user.id} outbox={outbox} online={online} onClose={() => setQueueOpen(false)} />}
        <main id="main" className="content" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
          <AppUpdateBanner hasQueuedWork={outbox.ops.length > 0 || outbox.readError != null} />
          {!online && (
            <div className="alert tone-warning" role="status" style={{ marginBottom: 12 }}>
              <WifiOff size={18} aria-hidden />
              <div className="alert-body">Нет сети. Выручку и закрытие смены можно сохранить — они отправятся сами, когда связь вернётся.</div>
            </div>
          )}
          {(outbox.ops.length > 0 || outbox.readError != null || outbox.sendError != null) && (
            <div className="alert tone-info" style={{ marginBottom: 12 }}>
              <CloudOff size={18} aria-hidden />
              <div className="alert-body">
                <div role="status">
                  {outbox.readError != null ? 'Не удалось проверить очередь на устройстве.' : <>
                    {outbox.waiting > 0 && <div>Сохранено на устройстве и ждёт отправки: {outbox.waiting}.</div>}
                    {outbox.blocked > 0 && <div>Требуют сверки: {outbox.blocked}.</div>}
                  </>}
                  {outbox.sendError != null && <div>Отправка не завершилась.</div>}
                </div>
                <Button size="sm" style={{ marginTop: 8 }} onClick={() => setQueueOpen(true)}>Посмотреть записи</Button>
              </div>
            </div>
          )}
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

function QueueDialog({userId,outbox,online,onClose}:{userId:string;outbox:ReturnType<typeof useOutbox>;online:boolean;onClose:()=>void}) {
  const [copied,setCopied]=useState<Map<string,QueuedOperation>>(new Map());
  const [error,setError]=useState<unknown>(null);
  const fail=(value:unknown)=>setError(value instanceof Error ? new AppError('validation',value.message,'','') : value);
  const [busy,setBusy]=useState(false);
  const [importFile,setImportFile]=useState<{text:string;data:LocalRecovery}|null>(null);
  const [notice,setNotice]=useState('');
  const download=async()=>{
    setError(null); setBusy(true);
    try {
      const text=await exportLocalRecovery(userId);
      const saved=JSON.parse(text) as LocalRecovery;
      const blob=new Blob([text],{type:'application/json'});
      const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;
      a.download=`bron-local-records-${new Date().toISOString().slice(0,10)}.json`; a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000); setCopied(new Map(saved.operations.map(o=>[o.clientOpId,o])));
      setNotice('Копия подготовлена. Проверьте, что файл сохранился на устройстве.');
    } catch(e) {fail(e);} finally {setBusy(false);}
  };
  return <ConfirmDialog open title="Локальные записи" cancelLabel="Закрыть" onClose={onClose} busy={busy} error={error ?? outbox.readError ?? outbox.sendError}>
    <p className="faint">Копия содержит только ваши неотправленные записи и сохранённые черновики. Храните её в закрытом месте. На новом адресе войдите с прежним логином и загрузите этот файл.</p>
    <div style={{display:'flex',gap:12,flexWrap:'wrap',alignItems:'center'}}>
      <Button disabled={busy} onClick={()=>void download()}>Скачать копию записей</Button>
      <Field label="Загрузить сохранённую копию">{id=><Input id={id} type="file" accept=".json,application/json" disabled={busy} onChange={event=>{
        const file=event.target.files?.[0]; event.target.value=''; setImportFile(null); setError(null);setNotice('');
        if(!file)return;
        if(file.size>MAX_RECOVERY_BYTES){fail(new Error('Файл больше 5 МБ. Импорт отменён.'));return;}
        setBusy(true);
        void file.text().then(text=>setImportFile({text,data:parseLocalRecovery(text,userId)})).catch(fail).finally(()=>setBusy(false));
      }}/>}</Field>
    </div>
    {importFile&&<div className="alert tone-info" style={{marginTop:12,flexWrap:'wrap'}}>
      <div className="alert-body" style={{flex:'1 1 240px',overflowWrap:'anywhere'}}>В копии: записей — {importFile.data.operations.length}, черновиков — {importFile.data.drafts.length}. После добавления очередь отправится при наличии связи. Существующие записи не перезаписываются.</div>
      <Button disabled={busy} onClick={()=>{
        setBusy(true);setError(null);
        void importLocalRecovery(userId,importFile.text).then(added=>{
          setImportFile(null);setNotice(`Добавлено локальных записей: ${added}.`);notifyOutboxChange();
          if (added > 0) outbox.retry();
        }).catch(fail).finally(()=>setBusy(false));
      }}>Добавить записи из копии</Button>
    </div>}
    {notice&&<p role="status">{notice}</p>}
    {outbox.readError != null && <Button size="sm" onClick={outbox.refresh}>Проверить очередь снова</Button>}
    {(outbox.waiting > 0 || outbox.sendError != null) && <Button size="sm" disabled={!online || busy} loading={outbox.sending}
      onClick={outbox.retry}>Повторить отправку</Button>}
    {outbox.loading ? <p role="status">Проверяем очередь…</p> : !outbox.readError && outbox.ops.length === 0 && <p role="status">Неотправленных записей нет.</p>}
    {outbox.blocked > 0 && <p className="faint">При конфликте откройте день заново и сверьте суммы. Удаляйте обработанную запись только после проверки сохранённой копии.</p>}
    {outbox.ops.map(op => {
      const state = queuedOperationState(op);
      const saved = copied.get(op.clientOpId);
      const savedInCopy = saved?.kind === op.kind && sameJson(saved.payload, op.payload);
      return <div key={op.clientOpId} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
        <strong>{op.kind.startsWith('revenue') ? `Выручка за ${String(op.payload.day)}` : 'Закрытие смены'}</strong>
        <div className="faint">{op.kind === 'revenue_total_set' ? `Всего: ${(Number(op.payload.total) / 100).toLocaleString('ru-RU')}`
          : `Наличные: ${(Number(op.payload.cash) / 100).toLocaleString('ru-RU')} · карта: ${(Number(op.payload.card) / 100).toLocaleString('ru-RU')}`}</div>
        <div className="faint">{state === 'pending' ? 'Ожидает отправки' : state === 'retryable'
          ? `Отправка пока недоступна. ${op.lastError}` : `Требует сверки. ${op.lastError}`}</div>
        {state === 'blocked' && <Button variant="ghost" size="sm" disabled={busy || !savedInCopy} onClick={() => {
          setBusy(true); setError(null);
          void dropOp(userId, op.clientOpId).catch(fail).finally(() => setBusy(false));
        }}>Копия сохранена — удалить из очереди</Button>}
      </div>;
    })}
  </ConfirmDialog>;
}
