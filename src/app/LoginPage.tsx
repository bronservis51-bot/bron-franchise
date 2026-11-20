import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Eye, EyeOff } from 'lucide-react';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { useSession } from '../platform/session';
import { Button, Checkbox, Field, Input } from '../ui';
import { loginErrorText, useServerCheck } from './loginDiagnostics';
import { AppUpdateBanner } from './AppUpdateBanner';
import { loginEmail } from '../platform/login';
import { InstallButton } from './InstallApp';

export function LoginPage() {
  const { status, signIn } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
      await signIn(loginEmail(email), password, remember);
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
          <h1>Кабинет Бронь Сервис</h1>
        </div>
        <div className="faint" style={{ position: 'relative', color: '#6f7076' }}>© Бронь Сервис</div>
      </aside>
      <main className="login-panel">
        <div className="inner">
          <AppUpdateBanner />
          <ServerStatus s={server} onRetry={recheck} />
          <div className="card"><div className="card-body">{form()}</div></div>
          <div style={{ marginTop: 12 }}><InstallButton /></div>
          <p className="faint">Версия от {new Date(import.meta.env.VITE_BUILD_TIME ?? Date.now()).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
          <a href={`${import.meta.env.BASE_URL}help.html`} target="_blank" rel="noopener noreferrer">Помощь при сбое</a>
        </div>
      </main>
    </div>
  );

  function form() {
    return (
          <form onSubmit={submit} noValidate>
            <Field label="Логин" required hint="Вход по телефону доступен, если номер сохранён как логин.">
              {(id, describedBy) => <Input id={id} aria-describedby={describedBy} type="text" autoCapitalize="none" spellCheck={false} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
            <Field label="Пароль" required>
              {(id) => <div className="password-field">
                <Input id={id} type={showPassword ? 'text' : 'password'} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" className="icon-btn password-toggle" aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} aria-controls={id} aria-pressed={showPassword}
                  onPointerDown={(e) => e.preventDefault()} onClick={() => setShowPassword((visible) => !visible)}>
                  {showPassword ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
                </button>
              </div>}
            </Field>
            <Checkbox label="Запомнить это устройство" hint="Включайте только на личном устройстве. Без отметки сессия завершится при закрытии вкладки."
              checked={remember} onChange={setRemember} />
            {error && <ErrorBox e={error} />}
            <div style={{ marginTop: 16 }}>
              <Button type="submit" variant="primary" block loading={busy} disabled={!email || !password}>Войти</Button>
            </div>
            <details className="forgot"><summary>Забыли пароль?</summary>
              <p className="faint">Сотрудникам пароль меняет франчайзи в разделе «Сотрудники». Франчайзи может запросить новый пароль у менеджера по франшизе. После входа пароль можно сменить в профиле.</p>
              <p className="faint">Менеджеру по франшизе восстановить доступ поможет администратор системы после проверки личности.</p>
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
  if (s.state === 'ok') return s.ms > 4000 ? <p className="faint" style={{ marginBottom: 12 }}>Сервер ответил за {(s.ms / 1000).toFixed(1)} с. Вход может занять больше времени.</p> : null;
  if (s.state === 'checking') return null;
  return (
    <div className="alert tone-warning" role="status" style={{ marginBottom: 16 }}>
      <div className="alert-body">
        <strong>{s.reason}</strong>
        <div>Попробуйте войти. Если не получится, откройте «Помощь при сбое».</div>
        <div className="faint" style={{ marginTop: 4 }}>Код: {s.connection.auth.code} / {s.connection.data.code}</div>
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
