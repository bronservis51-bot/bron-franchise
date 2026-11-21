import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useSession } from '../platform/session';
import { loginEmail } from '../platform/login';
import { confirmManagerRecovery, recoveryLinkKind, recoveryPasswordValid, requestManagerRecovery, resetManagerRecovery,
  type RecoveryLinkKind } from '../platform/managerRecovery';
import { Alert, Button, Field, Input, LinkButton, Skeleton } from '../ui';

const invalidLink = 'Ссылка просрочена или уже использована.';

function RecoveryPanel({ title, children }: { title: string; children: ReactNode }) {
  return <main className="login-wrap recovery-panel">
    <section className="card login-card" aria-labelledby="recovery-heading">
      <div className="card-body">
        <h1 id="recovery-heading">{title}</h1>
        {children}
      </div>
    </section>
  </main>;
}

export function ManagerRecoveryRequestPage() {
  const initial = useLocation().state?.login;
  const [login, setLogin] = useState(typeof initial === 'string' ? initial : '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !login.trim()) return;
    setError('');
    let account: string;
    try { account = loginEmail(login); } catch { setError('Проверьте логин или адрес почты.'); return; }
    setBusy(true);
    try {
      await requestManagerRecovery(account);
      setLogin('');
      setSent(true);
    } catch {
      setError('Не удалось отправить запрос. Повторите или обратитесь к администратору системы.');
    } finally {
      setBusy(false);
    }
  }

  return <RecoveryPanel title="Вернуть доступ">
    {sent ? <>
      <p role="status">Если данные совпали, письмо с логином и ссылкой придёт на подтверждённую почту.</p>
      <p className="faint">Проверьте папку «Спам». Если письма нет, обратитесь к администратору системы.</p>
    </> : <form onSubmit={submit} noValidate>
      <Field label="Логин или почта восстановления" hint="Для профиля менеджера по франшизе." required>{(id, describedBy) =>
        <Input id={id} aria-describedby={describedBy} autoComplete="username" spellCheck={false} autoCapitalize="none"
          value={login} maxLength={254} onChange={e => setLogin(e.target.value)} />}</Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" variant="primary" disabled={!login.trim()} loading={busy} block>Отправить письмо</Button>
    </form>}
    <Link className="recovery-back" to="/login">Вернуться ко входу</Link>
  </RecoveryPanel>;
}

export function ManagerRecoveryLinkPage() {
  const { kind, token } = useParams();
  const action = recoveryLinkKind(kind, token);
  if (!action || !token) return <RecoveryPanel title="Сбой ссылки">
    <p>{invalidLink}</p>
    <LinkButton to="/recover">Запросить письмо</LinkButton>
  </RecoveryPanel>;
  return <RecoveryAction key={token} kind={action} token={token} />;
}

function RecoveryAction({ kind, token }: { kind: RecoveryLinkKind; token: string }) {
  const { status } = useSession();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);
  const reset = kind === 'reset';
  const canReset = recoveryPasswordValid(password) && password === repeat;
  const confirmLabel = reset ? 'Сохранить новый пароль' : 'Подтвердить почту';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (reset && (status !== 'signed-out' || !canReset))) return;
    setBusy(true);
    setError('');
    const fragment = window.location.hash;
    try {
      const ok = reset ? await resetManagerRecovery(token, password) : await confirmManagerRecovery(token);
      if (window.location.hash !== fragment) return;
      if (ok) navigate('/recover/done', { replace: true, state: { kind } });
      else {
        setPassword('');
        setRepeat('');
        setInvalid(true);
      }
    } catch {
      setError(reset ? 'Сервер не подтвердил смену. Попробуйте войти с новым паролем или запросите письмо ещё раз.'
        : 'Не удалось подтвердить почту. Повторите попытку.');
    } finally {
      setBusy(false);
    }
  }

  return <RecoveryPanel title={reset ? 'Новый пароль' : 'Почта'}>
    {invalid ? <><p role="alert">{invalidLink}</p><LinkButton to={reset ? '/recover' : '/'}>{reset ? 'Запросить письмо' : 'Открыть кабинет'}</LinkButton></>
      : reset && status === 'loading' ? <Skeleton lines={2} />
      : reset && status === 'signed-in' ? <>
        <p>Вы уже вошли в кабинет. Откройте ссылку в приватном окне браузера, чтобы восстановить пароль.</p>
        <LinkButton to="/">Вернуться в кабинет</LinkButton>
      </> : <form onSubmit={submit} noValidate>
        {reset ? <>
          <p>После установки нового пароля все прежние сеансы завершатся.</p>
          <Field label="Новый пароль" hint="От 12 символов." required
            error={new TextEncoder().encode(password).length > 72 ? 'Сократите пароль.' : null}>{(id, describedBy) =>
            <Input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password"
              value={password} maxLength={72} onChange={e => setPassword(e.target.value)} />}</Field>
          <Field label="Повторите пароль" error={repeat && repeat !== password ? 'Пароли не совпадают.' : null} required>{(id, describedBy) =>
            <Input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password"
              value={repeat} maxLength={72} onChange={e => setRepeat(e.target.value)} />}</Field>
        </> : <p>Подтвердите, что хотите использовать этот почтовый ящик для восстановления доступа.</p>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" variant="primary" disabled={reset && !canReset} loading={busy} block>{confirmLabel}</Button>
      </form>}
  </RecoveryPanel>;
}

export function ManagerRecoveryDonePage() {
  const { status } = useSession();
  const kind = useLocation().state?.kind;
  const confirm = kind === 'confirm';
  const cabinet = confirm && status === 'signed-in';
  return <RecoveryPanel title={confirm ? 'Почта готова' : kind === 'reset' ? 'Пароль сменён' : 'Вход в кабинет'}>
    {confirm ? <p>Резервный адрес подтверждён. Для входа действуют прежние логин и пароль.</p>
      : kind === 'reset' && <p>Войдите с прежним логином и новым паролем.</p>}
    <LinkButton to={cabinet ? '/' : '/login'} variant="primary">{cabinet ? 'Вернуться в кабинет' : 'Перейти ко входу'}</LinkButton>
  </RecoveryPanel>;
}
