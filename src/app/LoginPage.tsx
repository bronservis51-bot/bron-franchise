import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ChevronRight, Store, Users, Briefcase } from 'lucide-react';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { useSession } from '../platform/session';
import { from, rows } from '../platform/backend';
import { config, quickLoginEnabled } from '../platform/config';
import { Button, Checkbox, Field, Input } from '../ui';
import demoUsers from '../../supabase/seed/demo-users.json';
import { loginErrorText, useServerCheck } from './loginDiagnostics';
import { staffEmail } from '../modules/staff/api';

interface DemoUser { email: string; name: string; group: 'manager' | 'franchisee' | 'staff'; title: string; hint: string;
  /** До запуска: новые партнёры открываются в менеджерском режиме просмотра, без выдуманных учётных записей. */
  loginAs?: string; partnerCode?: string }

const GROUPS: { id: DemoUser['group']; title: string; icon: typeof Store }[] = [
  { id: 'manager', title: 'Компания', icon: Briefcase },
  { id: 'franchisee', title: 'Франчайзи', icon: Users },
  { id: 'staff', title: 'Сотрудник франчайзи', icon: Store },
];

/** Быстрый вход по ролям для демонстрации: выбор карточки вместо логина и пароля. */
function QuickLogin({ onError }: { onError: (e: unknown) => void }) {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  async function enter(u: DemoUser) {
    setBusy(u.email);
    setSlow(false);
    const hint = setTimeout(() => setSlow(true), 5000);
    try {
      // Сервер не ответил за 40 с — показать понятную причину вместо вечной загрузки
      await Promise.race([
        signIn(u.loginAs ?? u.email, config.demoQuickPassword, false),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 40000)),
      ]);
      if (u.partnerCode) {
        // Обзор существующей карточки партнёра менеджером. Не является входом под этим франчайзи:
        // настоящие персональные аккаунты создадим только перед запуском.
        const match = await rows<{ id: string }>(from('partner').select('id').eq('code', u.partnerCode).limit(1));
        navigate(match.length ? `/partners/${match[0].id}` : '/', { replace: true });
      } else {
        navigate('/', { replace: true });
      }
    } catch (e) {
      onError(e);
    } finally {
      clearTimeout(hint);
      setBusy(null);
      setSlow(false);
    }
  }
  return (
    <div>
      <h2 style={{ fontSize: 'var(--fs-l)', marginBottom: 4 }}>Выберите роль</h2>
      <p className="muted" style={{ marginBottom: 16 }}>Режим разработки: выберите кабинет для проверки. Новые партнёры открываются в режиме просмотра менеджера. Сменить кабинет — в меню профиля.</p>
      {busy && slow && <div className="slow-hint" role="status">Входим… Ещё несколько секунд.</div>}
      {GROUPS.map((g) => (
        <section key={g.id} style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 8, color: 'var(--text-2)', fontWeight: 600 }}><g.icon size={16} aria-hidden />{g.title}</div>
          <div className="grid grid-2" style={{ gap: 8 }}>
            {(demoUsers as DemoUser[]).filter((u) => u.group === g.id).map((u) => {
              return (
              <button key={u.email} type="button" className={`role-card ${u.group === 'franchisee' ? 'partner' : ''}`} onClick={() => void enter(u)} disabled={busy !== null} aria-busy={busy === u.email}>
                <span className="role-avatar" aria-hidden>{u.group === 'franchisee' ? <LogoMark height={22} /> : u.group === 'staff' ? <Store size={20} /> : <Briefcase size={20} />}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="role-title">{u.title}</span>
                  <span className="role-hint">{u.hint}</span>
                </span>
                {busy === u.email ? <span className="spinner" aria-hidden /> : <ChevronRight size={18} aria-hidden />}
              </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export function LoginPage() {
  const { status, signIn } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; detail: string } | null>(null);
  const [server, recheck] = useServerCheck();
  const fail = (e: unknown) => { setError(loginErrorText(e)); recheck(); };

  if (status === 'signed-in') return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Сотрудник входит по телефону: без «@» — это номер
      await signIn(email.includes('@') ? email : staffEmail(email), password, remember);
      navigate('/', { replace: true });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-split">
      <aside className="login-brand">
        <BrandPattern className="p1" rows={5} cols={6} />
        <BrandPattern className="p2" rows={2} cols={6} />
        <span className="big-mark"><LogoMark height={340} /></span>
        <div style={{ position: 'relative' }}>
          <LogoFull height={52} />
          <h1>Кабинет франчайзи</h1>
          <p>База знаний и выручка точки: инструкции и регламенты, план на месяц и итог продаж за каждый день.</p>
        </div>
        <div className="faint" style={{ position: 'relative', color: '#6f7076' }}>© Бронь Сервис</div>
      </aside>
      <main className="login-panel">
        <div className="inner">
          <ServerStatus s={server} onRetry={recheck} />
          {quickLoginEnabled && <QuickLogin onError={fail} />}
          {quickLoginEnabled && error && <ErrorBox e={error} />}
          {quickLoginEnabled
            ? <details className="card" style={{ padding: '4px 16px' }}><summary className="muted" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Войти по email и паролю</summary>{form()}</details>
            : <div className="card"><div className="card-body">{form()}</div></div>}
          <p className="faint" style={{ marginTop: 16 }}>Доступ выдаёт менеджер по франшизе. Самостоятельная регистрация отключена.</p>
          <p className="faint">Версия от {new Date(import.meta.env.VITE_BUILD_TIME ?? Date.now()).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
        </div>
      </main>
    </div>
  );

  function form() {
    return (
          <form onSubmit={submit} noValidate>
            <Field label="Email или телефон" required hint="Сотрудники входят по номеру телефона">
              {(id) => <Input id={id} type="text" inputMode="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
            <Field label="Пароль" required>
              {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
            </Field>
            <Checkbox label="Запомнить это устройство" hint="Только на личном устройстве: на общем компьютере сессия закончится при закрытии вкладки."
              checked={remember} onChange={setRemember} />
            {error && !quickLoginEnabled && <ErrorBox e={error} />}
            <div style={{ marginTop: 16 }}>
              <Button type="submit" variant="primary" block loading={busy} disabled={!email || !password}>Войти</Button>
            </div>
            <details className="forgot"><summary>Забыли пароль?</summary>
              <p className="faint">Сотрудник — попросите франчайзи: он задаст новый пароль в разделе «Сотрудники». Франчайзи — напишите менеджеру по франшизе: он задаст новый пароль в вашей карточке. Сменить пароль на свой можно в профиле после входа.</p>
            </details>
          </form>
    );
  }
}

function ErrorBox({ e }: { e: { text: string; detail: string } }) {
  return (
    <div className="alert tone-danger" role="alert" style={{ margin: '12px 0' }}>
      <div className="alert-body">{e.text}{e.detail && <div className="faint" style={{ marginTop: 4, wordBreak: 'break-word' }}>Техническая причина: {e.detail}</div>}</div>
    </div>
  );
}

function ServerStatus({ s, onRetry }: { s: ReturnType<typeof useServerCheck>[0]; onRetry: () => void }) {
  if (s.state === 'ok') return s.ms > 4000 ? <p className="faint" style={{ marginBottom: 12 }}>Сервер отвечает медленно ({(s.ms / 1000).toFixed(1)} с) — вход может занять время.</p> : null;
  if (s.state === 'checking') return null;
  return (
    <div className="alert tone-warning" role="status" style={{ marginBottom: 16 }}>
      <div className="alert-body">
        <strong>Нет связи с сервером базы данных с этого устройства.</strong> Сайт открылся, но данные хранятся на другом сервере, и до него запрос не доходит. Попробуйте другую сеть (Wi‑Fi или мобильный интернет).
        <div className="faint" style={{ marginTop: 4 }}>Причина: {s.reason}</div>
      </div>
      <button type="button" className="btn btn-sm" onClick={onRetry}>Проверить снова</button>
    </div>
  );
}

export function SetupPage() {
  return (
    <div className="login-wrap">
      <div className="login-card card" style={{ width: 'min(640px, 100%)' }}>
        <div className="card-body">
          <h1 style={{ marginBottom: 12 }}>Сборка не подключена к базе</h1>
          <p className="muted">Эта сборка не содержит адреса проекта Supabase, поэтому работающих операций нет. Это не демонстрация, а признак незавершённой настройки.</p>
          <ol>
            <li>Создайте проект Supabase Free и примените миграции: <span className="mono">npm run db:apply -- --seed</span> (или SQL из <span className="mono">npm run sql:bundle</span>).</li>
            <li>Укажите <span className="mono">VITE_SUPABASE_URL</span> и <span className="mono">VITE_SUPABASE_PUBLISHABLE_KEY</span> в <span className="mono">.env.local</span>.</li>
            <li>Соберите и опубликуйте: <span className="mono">npm run deploy</span>.</li>
          </ol>
          <p className="faint">Подробно: README и docs/runbooks/deploy.md.</p>
        </div>
      </div>
    </div>
  );
}
