import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Building2, ChevronRight, Store, Users, Crown, Landmark, Package, Headset, PenTool, BookOpen, ShieldCheck, Wrench, UserCog, Rocket, UserRound } from 'lucide-react';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { useSession } from '../platform/session';
import { config, quickLoginEnabled } from '../platform/config';
import { Button, Checkbox, Field, Input } from '../ui';
import demoUsers from '../../supabase/seed/demo-users.json';

interface DemoUser { email: string; name: string; group: 'company' | 'own' | 'partner'; title: string; scope: string; hint: string; hidden?: boolean }

const ROLE_ICON: Record<string, typeof Building2> = {
  'founder@demo.example.com': Crown, 'fm@demo.example.com': Rocket,
  'finance1@demo.example.com': Landmark, 'supply@demo.example.com': Package, 'tech@demo.example.com': Wrench, 'designer@demo.example.com': PenTool,
  'hr@demo.example.com': UserCog, 'editor@demo.example.com': BookOpen, 'sysadmin@demo.example.com': ShieldCheck,
  'manager.north@demo.example.com': Store, 'staff.north@demo.example.com': UserRound, 'alpha.staff@demo.example.com': UserRound,
};

const GROUPS: { id: DemoUser['group']; title: string; icon: typeof Building2 }[] = [
  { id: 'company', title: 'Сотрудники компании', icon: Building2 },
  { id: 'own', title: 'Собственная точка', icon: Store },
  { id: 'partner', title: 'Франчайзи и менеджеры продаж', icon: Users },
];

/** Быстрый вход по ролям для демонстрации: выбор карточки вместо логина и пароля. */
function QuickLogin({ onError }: { onError: (msg: string) => void }) {
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
        signIn(u.email, config.demoQuickPassword, false),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 40000)),
      ]);
      navigate('/', { replace: true });
    } catch (e) {
      onError(!navigator.onLine ? 'Нет сети. Вход возможен только онлайн.'
        : (e as Error).message === 'timeout' || (e as Error).message?.includes('fetch')
          ? 'Сервер не отвечает. Проверьте интернет и попробуйте ещё раз.'
          : 'Не удалось войти. Попробуйте ещё раз.');
    } finally {
      clearTimeout(hint);
      setBusy(null);
      setSlow(false);
    }
  }
  return (
    <div>
      <h2 style={{ fontSize: 'var(--fs-l)', marginBottom: 4 }}>Выберите роль</h2>
      <p className="muted" style={{ marginBottom: 16 }}>Нажмите на должность, чтобы войти. Сменить роль можно в профиле.</p>
      {busy && slow && <div className="slow-hint" role="status">Входим… Ещё несколько секунд.</div>}
      {GROUPS.map((g) => (
        <section key={g.id} style={{ marginBottom: 20 }}>
          <div className="row" style={{ marginBottom: 8, color: 'var(--text-2)', fontWeight: 600 }}><g.icon size={16} aria-hidden />{g.title}</div>
          <div className="grid grid-2" style={{ gap: 8 }}>
            {(demoUsers as DemoUser[]).filter((u) => u.group === g.id && !u.hidden).map((u) => {
              const Icon = ROLE_ICON[u.email] ?? Headset;
              return (
              <button key={u.email} type="button" className={`role-card ${u.group}`} onClick={() => void enter(u)} disabled={busy !== null} aria-busy={busy === u.email}>
                <span className="role-avatar" aria-hidden>{u.group === 'partner' && !ROLE_ICON[u.email] ? <LogoMark height={22} /> : <Icon size={20} />}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="role-title">{u.title}</span>
                  <span className="role-scope">{u.scope}</span>
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
  const [error, setError] = useState<string | null>(null);

  if (status === 'signed-in') return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password, remember);
      navigate('/', { replace: true });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      setError(/invalid/i.test(msg) ? 'Неверный email или пароль' : !navigator.onLine ? 'Нет сети. Вход возможен только онлайн.' : 'Не удалось войти. Попробуйте ещё раз.');
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
          <h1>Рабочий кабинет сотрудников и партнёров</h1>
          <p>Задачи на сегодня, открытие точек, заказ плёнки, выручка и роялти, база знаний — в одном месте.</p>
        </div>
        <div className="faint" style={{ position: 'relative', color: '#6f7076' }}>© Бронь Сервис</div>
      </aside>
      <main className="login-panel">
        <div className="inner">
          {quickLoginEnabled && <QuickLogin onError={setError} />}
          {quickLoginEnabled && error && <div className="alert tone-danger" role="alert" style={{ marginBottom: 12 }}><div className="alert-body">{error}</div></div>}
          {quickLoginEnabled
            ? <details className="card" style={{ padding: '4px 16px' }}><summary className="muted" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Войти по email и паролю</summary>{form()}</details>
            : <div className="card"><div className="card-body">{form()}</div></div>}
          <p className="faint" style={{ marginTop: 16 }}>Учётные записи выдаёт администратор компании. Самостоятельная регистрация отключена.</p>
        </div>
      </main>
    </div>
  );

  function form() {
    return (
          <form onSubmit={submit} noValidate>
            <Field label="Email" required>
              {(id) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
            <Field label="Пароль" required>
              {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
            </Field>
            <Checkbox label="Запомнить это устройство" hint="Только на личном устройстве. На общем планшете точки не отмечайте: сессия закончится при закрытии вкладки."
              checked={remember} onChange={setRemember} />
            {error && <div className="alert tone-danger" role="alert" style={{ marginTop: 12 }}><div className="alert-body">{error}</div></div>}
            <div style={{ marginTop: 16 }}>
              <Button type="submit" variant="primary" block loading={busy} disabled={!email || !password}>Войти</Button>
            </div>
          </form>
    );
  }
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
