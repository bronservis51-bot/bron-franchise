import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { BrandPattern, LogoFull, LogoMark } from '../ui/brand';
import { useSession } from '../platform/session';
import { Button, Checkbox, Field, Input } from '../ui';
import { loginErrorText, useServerCheck } from './loginDiagnostics';
import { loginEmail } from '../platform/login';

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
          <h1>Кабинет франчайзи</h1>
          <p>База знаний и выручка точки: инструкции и регламенты, план на месяц и итог продаж за каждый день.</p>
        </div>
        <div className="faint" style={{ position: 'relative', color: '#6f7076' }}>© Бронь Сервис</div>
      </aside>
      <main className="login-panel">
        <div className="inner">
          <ServerStatus s={server} onRetry={recheck} />
          <div className="card"><div className="card-body">{form()}</div></div>
          <p className="faint" style={{ marginTop: 16 }}>Доступ выдаёт менеджер по франшизе. Самостоятельная регистрация отключена.</p>
          <p className="faint">Версия от {new Date(import.meta.env.VITE_BUILD_TIME ?? Date.now()).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
        </div>
      </main>
    </div>
  );

  function form() {
    return (
          <form onSubmit={submit} noValidate>
            <Field label="Логин" required hint="Ваш личный логин. Сотрудники могут входить по номеру телефона">
              {(id) => <Input id={id} type="text" autoCapitalize="none" spellCheck={false} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
            </Field>
            <Field label="Пароль" required>
              {(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}
            </Field>
            <Checkbox label="Запомнить это устройство" hint="Только на личном устройстве: на общем компьютере сессия закончится при закрытии вкладки."
              checked={remember} onChange={setRemember} />
            {error && <ErrorBox e={error} />}
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
