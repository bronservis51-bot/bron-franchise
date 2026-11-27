import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CloudOff, GraduationCap, KeyRound, LogOut, Mail, Phone, Smartphone, User, Users, WifiOff } from 'lucide-react';
import { AppError, command } from '../platform/backend';
import { useSession } from '../platform/session';
import { useLocale } from '../platform/locale';
import { LanguageSelect } from '../ui/LanguageSelect';
import { config } from '../platform/config';
import { displayLogin, phoneLoginDigits } from '../platform/login';
import { changeManagerPhoneLogin } from '../platform/managerLogin';
import { dropOp, flushOutbox, notifyOutboxChange, onOutboxChange, queuedOperationState, queuedOps } from '../platform/outbox';
import { activeNavFor, navFor, workspaceAccess, workspaceRole, workspaceTitleFor, type NavItem, type WorkspaceRole } from './nav';
import { OrderTopButton } from '../modules/orders/OrderLink';
import { ownedTeamPartner } from '../modules/staff/TeamAccounts';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { Button, ConfirmDialog, Field, Input } from '../ui';
import { useToast } from '../ui/toast';
import { InstallDialog, InstallReminder, useInstallState } from './InstallApp';
import { AppUpdateBanner } from './AppUpdateBanner';
import { FirstRunGuide, hasSeenFirstRunGuide, markFirstRunGuideSeen, type FirstRunPreview } from './FirstRunGuide';
import { ManagerRecoverySettings } from './ManagerRecoverySettings';
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
  const { t } = useLocale();
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
          toast(t(`Отправлено записей, сохранённых без сети: ${result.sent}`, `Çevrimdışı kaydedilen ${result.sent} kayıt gönderildi.`));
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
  }, [userId, online, qc, toast, t]);
  const ops = queue.data ?? [];
  const waiting = ops.filter(op => queuedOperationState(op) !== 'blocked').length;
  return {
    ops, waiting, blocked: ops.length - waiting, loading: queue.isLoading, readError: queue.error, sendError, sending,
    retry: () => sendNow.current(), refresh: () => void queue.refetch(),
  };
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const { changePassword } = useSession();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const bad = pw.length < 6 || pw !== pw2;
  return (
    <ConfirmDialog open title={t('Сменить пароль', 'Parolayı değiştir')} confirmLabel={t('Сохранить пароль', 'Parolayı kaydet')} busy={busy} error={error} disabled={bad} onClose={onClose}
      onConfirm={async () => {
        setBusy(true); setError(null);
        try { await changePassword(pw); toast(t('Пароль изменён', 'Parola değiştirildi')); onClose(); } catch (e) { setError(e); } finally { setBusy(false); }
      }}>
      <Field label={t('Новый пароль', 'Yeni parola')} hint={t('Минимум 6 символов', 'En az 6 karakter')}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
      <Field label={t('Ещё раз', 'Parolayı tekrar girin')} error={pw2 && pw !== pw2 ? t('Пароли не совпадают', 'Parolalar eşleşmiyor') : null}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
    </ConfirmDialog>
  );
}

function ManagerLoginDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
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
      toast(changed ? t('Логин для входа изменён', 'Giriş numarası değiştirildi') : t('Этот номер уже используется для вашего входа', 'Zaten bu numarayla giriş yapıyorsunuz'));
      onClose();
      void reload().catch(() => toast(t('Обновите страницу, чтобы увидеть новый логин.', 'Yeni giriş numarasını görmek için sayfayı yenileyin.')));
    } catch (cause) {
      setError(cause);
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog open title={t('Сменить логин', 'Giriş numarasını değiştir')} confirmLabel={t('Сохранить логин', 'Giriş numarasını kaydet')} busy={busy} error={error}
      disabled={!digits || !password} dirty={Boolean(phone)} onClose={onClose} onConfirm={submit}>
      <p className="muted">{t('В следующий раз войдите с новым номером и текущим паролем. Другие сеансы завершатся.', 'Bir sonraki girişte yeni numarayı ve mevcut parolanızı kullanın. Diğer oturumlar kapanır.')}</p>
      <Field label={t('Номер телефона для входа', 'Giriş için telefon numarası')} required hint={t('Укажите номер с кодом страны.', 'Ülke koduyla birlikte girin.')}>{(id, describedBy) =>
        <Input id={id} aria-describedby={describedBy} type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} required />}
      </Field>
      <Field label={t('Текущий пароль', 'Mevcut parola')} required>{id =>
        <Input id={id} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />}
      </Field>
    </ConfirmDialog>
  );
}

function UserMenu({ pending, queueIssue, onLocalWork, showTeamAccess, role }: {
  pending: number; queueIssue: boolean; onLocalWork: () => void; showTeamAccess: boolean; role: WorkspaceRole;
}) {
  const { language, t } = useLocale();
  const { me, isManager, signOut } = useSession();
  const navigate = useNavigate();
  const preview = useLocation().state as FirstRunPreview | null;
  const [view, setView] = useState<'profile' | 'password' | 'login' | 'recovery' | 'install' | 'guide' | null>(null);
  const [guideSeen, setGuideSeen] = useState(() => role === 'pending' || Boolean(me?.user.id && hasSeenFirstRunGuide(me.user.id, role)));
  const installState = useInstallState();
  const profileButton = useRef<HTMLButtonElement>(null);
  const restoreProfileFocus = useRef(false);
  const guideOpen = role !== 'pending' && (!guideSeen || view === 'guide');
  const close = () => setView(null);
  useEffect(() => {
    if (guideOpen || !preview?.firstRunPreview || !preview.firstRunOrigin) return;
    const { pathname, search, hash, state } = preview.firstRunOrigin;
    void navigate({ pathname, search, hash }, { replace: true, state });
  }, [guideOpen, navigate, preview]);
  useEffect(() => {
    if (view || guideOpen || !restoreProfileFocus.current) return;
    restoreProfileFocus.current = false;
    profileButton.current?.focus({ preventScroll: true });
  }, [view, guideOpen]);
  const toast = useToast();
  const out = () => {
    close();
    if (pending) { toast(t('Есть неотправленные записи. Проверьте их в профиле перед выходом.', 'Gönderilmemiş kayıtlar var. Çıkmadan önce profilinizden kontrol edin.')); return; }
    void signOut().catch(e => toast(e instanceof Error ? e.message : t('Не удалось выйти', 'Çıkış yapılamadı')));
  };
  const closeGuide = (navigating = false) => {
    if (role !== 'pending' && me) markFirstRunGuideSeen(me.user.id, role);
    if (navigating) restoreProfileFocus.current = false;
    setGuideSeen(true);
    close();
  };
  return (
    <>
      <button ref={profileButton} className="user-btn" aria-label={t('Профиль', 'Profil')} aria-haspopup="dialog" data-tour-target="profile" onClick={() => {
        restoreProfileFocus.current = true;
        setView('profile');
      }}>
        <User size={20} aria-hidden />
      </button>
      {view === 'profile' && (
        <ConfirmDialog open title={t('Профиль', 'Profil')} cancelLabel={t('Закрыть', 'Kapat')} onClose={close} className="profile-dialog">
          <div className="profile-identity">
            <div className="profile-avatar"><User size={22} aria-hidden /></div>
            <div className="profile-name">
              <strong>{me?.user.full_name}</strong>
              <span>{workspaceTitleFor(role, language)}</span>
              <span>{displayLogin(me?.user.email)}</span>
            </div>
          </div>
          <LanguageSelect automatic />
          <div className="profile-actions">
            {(pending > 0 || queueIssue) && <button type="button" data-local-work
              aria-label={pending > 0 ? t(`Неотправленные записи: ${pending}`, `Gönderilmemiş kayıt: ${pending}`) : undefined} onClick={() => { close(); onLocalWork(); }}>
              <CloudOff size={18} aria-hidden />{t('Неотправленные записи', 'Gönderilmemiş kayıtlar')}{pending > 0 && <span className="profile-queue-count">{pending}</span>}<ChevronRight size={16} aria-hidden />
            </button>}
            <button type="button" onClick={() => setView('password')}><KeyRound size={18} aria-hidden />{t('Сменить пароль', 'Parolayı değiştir')}<ChevronRight size={16} aria-hidden /></button>
            {isManager && <button type="button" onClick={() => setView('login')}><Phone size={18} aria-hidden />{t('Сменить логин', 'Giriş numarasını değiştir')}<ChevronRight size={16} aria-hidden /></button>}
            {isManager && <button type="button" onClick={() => setView('recovery')}><Mail size={18} aria-hidden />{t('Почта для восстановления', 'Kurtarma e-postası')}<ChevronRight size={16} aria-hidden /></button>}
            {showTeamAccess && <Link to="/team-access" onClick={() => { restoreProfileFocus.current = false; close(); }}><Users size={18} aria-hidden />{t('Управляющие', 'Mağaza yöneticileri')}<ChevronRight size={16} aria-hidden /></Link>}
            {role !== 'pending' && <button type="button" onClick={() => setView('guide')}><GraduationCap size={18} aria-hidden />{t('Первые шаги', 'İlk adımlar')}<ChevronRight size={16} aria-hidden /></button>}
            {!installState.installed && <button type="button" onClick={() => setView('install')}><Smartphone size={18} aria-hidden />{t('Как установить приложение', 'Uygulamayı nasıl yüklerim?')}<ChevronRight size={16} aria-hidden /></button>}
            <button type="button" onClick={out}><LogOut size={18} aria-hidden />{t('Выйти', 'Çıkış yap')}</button>
          </div>
          {!pending && !queueIssue && <button type="button" data-local-work className="link-btn profile-recovery"
            onClick={() => { close(); onLocalWork(); }}>{t('Копия и восстановление записей', 'Kayıtları yedekle ve geri yükle')}</button>}
        </ConfirmDialog>
      )}
      {view === 'password' && <PasswordDialog onClose={close} />}
      {isManager && view === 'login' && <ManagerLoginDialog onClose={close} />}
      {isManager && view === 'recovery' && <ManagerRecoverySettings onClose={close} />}
      {view === 'install' && <InstallDialog onClose={close} />}
      {guideOpen && <FirstRunGuide role={role} replay={view === 'guide'} onClose={closeGuide} />}
    </>
  );
}

export function Shell() {
  const { t, language } = useLocale();
  const session = useSession();
  const { me, can, scopeRevision } = session;
  const online = useOnline();
  const loc = useLocation();
  const role = workspaceRole(session);
  const nav = navFor(role, can, language);
  const activeNav = activeNavFor(loc.pathname, nav);
  const access = workspaceAccess(role, can);
  const mainRef = useRef<HTMLElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const outbox = useOutbox(me?.user.id, online);
  const queueIssue = outbox.readError != null || outbox.sendError != null;
  const [queueOpen, setQueueOpen] = useState(false);
  const inbox = useQuery({ queryKey: ['kb', 'inbox'], enabled: Boolean(me?.assignments.length), refetchInterval: 120_000, staleTime: 120_000,
    queryFn: () => command<{ unanswered: number; new_answers: number }>('kb_inbox') });
  const kbCount = can('kb.edit') ? inbox.data?.unanswered ?? 0 : inbox.data?.new_answers ?? 0;
  const leads = useQuery({ queryKey: ['leads', 'inbox'], enabled: access.network && loc.pathname !== '/leads', staleTime: 120_000, refetchInterval: 120_000, queryFn: () => command<number>('lead_inbox') });
  const learning = useQuery({queryKey:['learning','notice',scopeRevision],enabled:access.learning,queryFn:()=>command<{new_day:boolean}>('learning_notice'),staleTime:60_000,refetchInterval:60_000});
  const leadCount = leads.data ?? 0;
  // Фокус на основное содержимое при смене экрана — для экранных дикторов
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }, [loc.pathname]);

  useLayoutEffect(() => {
    const bar = mobileNavRef.current;
    const active = bar?.querySelector<HTMLAnchorElement>('a[aria-current]');
    if (!bar || !active) return;
    const showActive = () => {
      if (!bar.clientWidth) return;
      const left = bar.getBoundingClientRect().left + bar.clientLeft;
      const right = left + bar.clientWidth;
      const link = active.getBoundingClientRect();
      const delta = Math.min(0, link.left - left) || Math.max(0, link.right - right);
      if (delta) bar.scrollLeft += delta;
    };
    showActive();
    const resize = new ResizeObserver(showActive);
    resize.observe(bar);
    for (const item of bar.querySelectorAll('a')) resize.observe(item);
    return () => resize.disconnect();
  }, [activeNav, language, nav.length, role]);

  const link = (n: NavItem, mobile = false) => (
    <Link key={n.to} to={n.to} data-tour-target={n.to === '/' ? 'nav-home' : 'nav-' + n.to.slice(1)}
      className={activeNav === n.to ? 'active' : undefined}
      aria-current={activeNav === n.to ? (loc.pathname === n.to ? 'page' : 'location') : undefined}>
      <n.icon size={mobile ? 22 : 18} aria-hidden />{mobile ? <span className="nav-label">{n.label}</span> : n.label}
      {n.badge === 'learning' && learning.data?.new_day && <span className="learning-dot" aria-label={t('Загляните в обучение сегодня', 'Bugünkü eğitimi inceleyin')} />}
      {n.badge === 'kb' && kbCount > 0 && <span className={mobile ? 'dot' : 'count'} aria-label={t(`новых: ${kbCount}`, `Yeni: ${kbCount}`)}>{mobile ? '' : kbCount}</span>}
      {n.badge === 'leads' && leadCount > 0 && <span className={mobile ? 'dot' : 'count'} aria-label={t(`новых заявок: ${leadCount}`, `Yeni başvuru: ${leadCount}`)}>{mobile ? '' : leadCount}</span>}
    </Link>
  );

  return (
    <div className={nav.length ? 'app' : 'app access-pending'}>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>{t('К содержимому', 'İçeriğe geç')}</a>
      <aside className="sidebar" aria-label={t('Основная навигация', 'Ana menü')}>
        <div className="brand">
          <LogoFull height={40} />
        </div>
        {nav.length > 0 && <nav className="nav">{nav.map((n) => link(n))}</nav>}
        <div className="sidebar-foot">
          <BrandPattern rows={3} cols={6} />
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="mobile-mark"><LogoMark height={28} /></span>
          <div className="grow topbar-account">
            <span className="topbar-title">{me?.user.full_name}</span>
            <span className="topbar-role">{workspaceTitleFor(role, language)}{config.appEnv === 'staging' && t(' · Тест', ' · Test')}</span>
          </div>
          {access.order && <OrderTopButton />}
          <UserMenu key={`${me?.user.id}:${role}`} role={role} pending={outbox.ops.length} queueIssue={queueIssue} onLocalWork={() => setQueueOpen(true)}
            showTeamAccess={role === 'franchisee' && Boolean(ownedTeamPartner(me))} />
        </header>
        {queueOpen && me && <QueueDialog key={me.user.id} userId={me.user.id} outbox={outbox} online={online} onClose={() => setQueueOpen(false)} />}
        <main id="main" className="content" ref={mainRef} tabIndex={-1} style={{ outline: 'none' }}>
          <AppUpdateBanner hasQueuedWork={outbox.ops.length > 0 || outbox.readError != null} />
          {loc.state?.missingAccess && role !== 'pending' && (
            <p className="alert tone-info access-notice" role="status">{t('Этот раздел недоступен с вашими текущими правами.', 'Yetkileriniz bu bölümü açmaya izin vermiyor.')}</p>
          )}
          {!online && (
            <div className="alert tone-warning" role="status" style={{ marginBottom: 12 }}>
              <WifiOff size={18} aria-hidden />
              <div className="alert-body">{t('Нет сети. Выручку и закрытие смены можно сохранить — они отправятся сами, когда связь вернётся.', 'İnternet yok. Ciroyu ve vardiya kapanışını kaydedebilirsiniz. Bağlantı geri geldiğinde otomatik gönderilir.')}</div>
            </div>
          )}
          {(outbox.ops.length > 0 || queueIssue) && (
            <div className="alert tone-info" style={{ marginBottom: 12 }}>
              <CloudOff size={18} aria-hidden />
              <div className="alert-body">
                <div role="status">
                  {outbox.readError != null ? t('Не удалось проверить очередь на устройстве.', 'Cihazdaki gönderim kuyruğu kontrol edilemedi.') : <>
                    {outbox.waiting > 0 && <div>{t(`Сохранено на устройстве и ждёт отправки: ${outbox.waiting}.`, `Cihazda kaydedilen ${outbox.waiting} kayıt gönderilmeyi bekliyor.`)}</div>}
                    {outbox.blocked > 0 && <div>{t(`Требуют сверки: ${outbox.blocked}.`, `${outbox.blocked} kaydı kontrol edin.`)}</div>}
                  </>}
                  {outbox.sendError != null && <div>{t('Отправка не завершилась.', 'Gönderim tamamlanmadı.')}</div>}
                </div>
                <Button size="sm" style={{ marginTop: 8 }} onClick={() => setQueueOpen(true)}>{t('Открыть неотправленные записи', 'Gönderilmemiş kayıtları aç')}</Button>
              </div>
            </div>
          )}
          <InstallReminder />
          {role === 'pending' ? (
            <div className="state"><h1>{t('Доступ ещё не выдан', 'Erişim henüz verilmedi')}</h1><div>{t('За доступом обратитесь к франчайзи или менеджеру по франшизе.', 'Erişim için franchise işletmecinizle veya franchise yöneticisiyle görüşün.')}</div></div>
          ) : <Outlet key={scopeRevision} />}
        </main>
      </div>
      {nav.length > 0 && <nav ref={mobileNavRef} className="bottom-nav" aria-label={t('Навигация', 'Gezinme')}>
        {nav.map((n) => link(n, true))}
      </nav>}
    </div>
  );
}

function QueueDialog({userId,outbox,online,onClose}:{userId:string;outbox:ReturnType<typeof useOutbox>;online:boolean;onClose:()=>void}) {
  const { t, locale } = useLocale();
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
      setNotice(t('Копия подготовлена. Проверьте, что файл сохранился на устройстве.', 'Yedek hazır. Dosyanın cihazınıza kaydedildiğini kontrol edin.'));
    } catch(e) {fail(e);} finally {setBusy(false);}
  };
  const hasQueue = outbox.ops.length > 0 || outbox.readError != null || outbox.sendError != null;
  return <ConfirmDialog open title={hasQueue ? t('Неотправленные записи', 'Gönderilmemiş kayıtlar') : t('Копия и восстановление записей', 'Kayıtları yedekle ve geri yükle')} cancelLabel={t('Закрыть', 'Kapat')} onClose={onClose} busy={busy} error={error ?? outbox.readError ?? outbox.sendError}>
    {outbox.ops.length > 0 && <p>{t('Выручка и закрытые смены ждут отправки с этого устройства. При восстановлении связи кабинет повторит отправку.', 'Ciro ve kapanan vardiyalar bu cihazdan gönderilmeyi bekliyor. Bağlantı gelince gönderim yeniden denenir.')}</p>}
    <details className="queue-recovery" open={!hasQueue}>
      <summary>{t('Копия записей и черновиков', 'Kayıt ve taslak yedeği')}</summary>
      <p className="faint">{t('Чтобы восстановить записи из файла, войдите с тем же логином.', 'Kayıtları dosyadan geri yüklemek için aynı hesapla giriş yapın.')}</p>
      <Button disabled={busy} onClick={()=>void download()}>{t('Скачать копию', 'Yedeği indir')}</Button>
      <Field label={t('Загрузить сохранённую копию', 'Kaydedilen yedeği yükle')}>{id=><Input id={id} type="file" accept=".json,application/json" disabled={busy} onChange={event=>{
        const file=event.target.files?.[0]; event.target.value=''; setImportFile(null); setError(null);setNotice('');
        if(!file)return;
        if(file.size>MAX_RECOVERY_BYTES){fail(new Error(t('Файл больше 5 МБ. Импорт отменён.', 'Dosya 5 MB sınırını aşıyor. Yükleme iptal edildi.')));return;}
        setBusy(true);
        void file.text().then(text=>setImportFile({text,data:parseLocalRecovery(text,userId)})).catch(fail).finally(()=>setBusy(false));
      }}/>}</Field>
    </details>
    {importFile&&<div className="alert tone-info" style={{marginTop:12,flexWrap:'wrap'}}>
      <div className="alert-body" style={{flex:'1 1 240px',overflowWrap:'anywhere'}}>{t(`В копии: записей — ${importFile.data.operations.length}, черновиков — ${importFile.data.drafts.length}. После добавления очередь отправится при наличии связи. Существующие записи не перезаписываются.`, `Yedekte ${importFile.data.operations.length} kayıt ve ${importFile.data.drafts.length} taslak var. Bağlantı kurulunca yeni kayıtlar gönderilir. Mevcut kayıtlar korunur.`)}</div>
      <Button disabled={busy} onClick={()=>{
        setBusy(true);setError(null);
        void importLocalRecovery(userId,importFile.text).then(added=>{
          setImportFile(null);setNotice(t(`Добавлено локальных записей: ${added}.`, `${added} yerel kayıt eklendi.`));notifyOutboxChange();
          if (added > 0) outbox.retry();
        }).catch(fail).finally(()=>setBusy(false));
      }}>{t('Добавить записи из копии', 'Yedekteki kayıtları ekle')}</Button>
    </div>}
    {notice&&<p role="status">{notice}</p>}
    {outbox.readError != null && <Button size="sm" onClick={outbox.refresh}>{t('Проверить очередь снова', 'Kuyruğu yeniden kontrol et')}</Button>}
    {(outbox.waiting > 0 || outbox.sendError != null) && <Button size="sm" disabled={!online || busy} loading={outbox.sending}
      onClick={outbox.retry}>{t('Повторить отправку', 'Gönderimi yeniden dene')}</Button>}
    {outbox.loading ? <p role="status">{t('Проверяем очередь…', 'Kuyruk kontrol ediliyor…')}</p> : !outbox.readError && outbox.ops.length === 0 && <p role="status">{t('Неотправленных записей нет.', 'Gönderilmemiş kayıt yok.')}</p>}
    {outbox.blocked > 0 && <p className="faint">{t('При конфликте откройте день заново и сверьте суммы. Удаляйте обработанную запись только после проверки сохранённой копии.', 'Çakışma olursa günü yeniden açıp tutarları kontrol edin. Tamamlanan kaydı silmeden önce yedeği doğrulayın.')}</p>}
    {outbox.ops.map(op => {
      const state = queuedOperationState(op);
      const saved = copied.get(op.clientOpId);
      const savedInCopy = saved?.kind === op.kind && sameJson(saved.payload, op.payload);
      return <div key={op.clientOpId} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
        <strong>{op.kind.startsWith('revenue') ? t(`Выручка за ${String(op.payload.day)}`, `${String(op.payload.day)} cirosu`) : t('Закрытие смены', 'Vardiya kapanışı')}</strong>
        <div className="faint">{op.kind === 'revenue_total_set' ? t(`Всего: ${(Number(op.payload.total) / 100).toLocaleString(locale)}`, `Toplam: ${(Number(op.payload.total) / 100).toLocaleString(locale)}`)
          : t('Наличные', 'Nakit') + `: ${(Number(op.payload.cash) / 100).toLocaleString(locale)} · ` + t('карта', 'kart') + `: ${(Number(op.payload.card) / 100).toLocaleString(locale)}`}</div>
        {op.kind === 'shift_record_with_return' && Number(op.payload.return) > 0 &&
          <div className="faint">{t('Возврат','İade')}: {(Number(op.payload.return) / 100).toLocaleString(locale)}</div>}
        <div className="faint">{state === 'pending' ? t('Ожидает отправки', 'Gönderim bekleniyor') : state === 'retryable'
          ? t(`Отправка пока недоступна. ${op.lastError}`, 'Şu an gönderilemiyor.') : t(`Требует сверки. ${op.lastError}`, 'Kontrol edilmesi gerekiyor.')}</div>
        {state === 'blocked' && <Button variant="ghost" size="sm" disabled={busy || !savedInCopy} onClick={() => {
          setBusy(true); setError(null);
          void dropOp(userId, op.clientOpId).catch(fail).finally(() => setBusy(false));
        }}>{t('Копия сохранена — удалить из очереди', 'Yedek kaydedildi, kuyruktan sil')}</Button>}
      </div>;
    })}
  </ConfirmDialog>;
}
