import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useSession } from '../platform/session';
import { loginEmail } from '../platform/login';
import { confirmManagerRecovery, recoveryLinkKind, recoveryPasswordValid, requestManagerRecovery, resetManagerRecovery,
  type RecoveryLinkKind } from '../platform/managerRecovery';
import { Alert, Button, Field, Input, LinkButton, Skeleton } from '../ui';
import { useLocale } from '../platform/locale';
import { LanguageSelect } from '../ui/LanguageSelect';

const invalidLink = ['Ссылка просрочена или уже использована.', 'Bağlantının süresi dolmuş veya bağlantı daha önce kullanılmış.'] as const;

function RecoveryPanel({ title, children }: { title: string; children: ReactNode }) {
  return <main className="login-wrap recovery-panel">
    <section className="card login-card" aria-labelledby="recovery-heading">
      <div className="card-body">
        <header className="recovery-heading"><h1 id="recovery-heading">{title}</h1><LanguageSelect automatic /></header>
        {children}
      </div>
    </section>
  </main>;
}

export function ManagerRecoveryRequestPage() {
  const { t } = useLocale();
  const initial = useLocation().state?.login;
  const [login, setLogin] = useState(typeof initial === 'string' ? initial : '');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<'input' | 'request' | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !login.trim()) return;
    setError(null);
    let account: string;
    try { account = loginEmail(login); } catch { setError('input'); return; }
    setBusy(true);
    try {
      await requestManagerRecovery(account);
      setLogin('');
      setSent(true);
    } catch {
      setError('request');
    } finally {
      setBusy(false);
    }
  }

  return <RecoveryPanel title={t('Вернуть доступ', 'Erişimi geri al')}>
    {sent ? <>
      <p role="status">{t('Если данные совпали, письмо с логином и ссылкой придёт на подтверждённую почту.',
        'Bilgiler eşleşirse kullanıcı adınızı ve bağlantıyı doğrulanmış e-posta adresinize göndereceğiz.')}</p>
      <p className="faint">{t('Проверьте папку «Спам». Если письма нет, обратитесь к администратору системы.',
        'Spam klasörünü kontrol edin. Mesaj gelmediyse sistem yöneticisine başvurun.')}</p>
    </> : <form onSubmit={submit} noValidate>
      <Field label={t('Логин или почта восстановления', 'Kullanıcı adı veya kurtarma e-postası')}
        hint={t('Для профиля менеджера по франшизе.', 'Franchise yöneticisi hesabı için.')} required>{(id, describedBy) =>
        <Input id={id} aria-describedby={describedBy} autoComplete="username" spellCheck={false} autoCapitalize="none"
          value={login} maxLength={254} onChange={e => setLogin(e.target.value)} />}</Field>
      {error && <Alert tone="danger">{error === 'input' ? t('Проверьте логин или адрес почты.', 'Kullanıcı adını veya e-posta adresini kontrol edin.')
        : t('Не удалось отправить запрос. Повторите или обратитесь к администратору системы.', 'İstek gönderilemedi. Yeniden deneyin veya sistem yöneticisine başvurun.')}</Alert>}
      <Button type="submit" variant="primary" disabled={!login.trim()} loading={busy} block>{t('Отправить письмо', 'E-posta gönder')}</Button>
    </form>}
    <Link className="recovery-back" to="/login">{t('Вернуться ко входу', 'Girişe dön')}</Link>
  </RecoveryPanel>;
}

export function ManagerRecoveryLinkPage() {
  const { t } = useLocale();
  const { kind, token } = useParams();
  const action = recoveryLinkKind(kind, token);
  if (!action || !token) return <RecoveryPanel title={t('Сбой ссылки', 'Bağlantı hatası')}>
    <p>{t(...invalidLink)}</p>
    <LinkButton to="/recover">{t('Запросить письмо', 'Yeni e-posta iste')}</LinkButton>
  </RecoveryPanel>;
  return <RecoveryAction key={token} kind={action} token={token} />;
}

function RecoveryAction({ kind, token }: { kind: RecoveryLinkKind; token: string }) {
  const { status } = useSession();
  const { t } = useLocale();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const reset = kind === 'reset';
  const canReset = recoveryPasswordValid(password) && password === repeat;
  const confirmLabel = reset ? t('Сохранить новый пароль', 'Yeni parolayı kaydet') : t('Подтвердить почту', 'E-postayı doğrula');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (reset && (status !== 'signed-out' || !canReset))) return;
    setBusy(true);
    setError(false);
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
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return <RecoveryPanel title={reset ? t('Новый пароль', 'Yeni parola') : t('Почта', 'E-posta')}>
    {invalid ? <><p role="alert">{t(...invalidLink)}</p><LinkButton to={reset ? '/recover' : '/'}>
      {reset ? t('Запросить письмо', 'Yeni e-posta iste') : t('Открыть кабинет', 'Paneli aç')}
    </LinkButton></>
      : reset && status === 'loading' ? <Skeleton lines={2} />
      : reset && status === 'signed-in' ? <>
        <p>{t('Вы уже вошли в кабинет. Откройте ссылку в приватном окне браузера, чтобы восстановить пароль.',
          'Zaten giriş yaptınız. Parolayı sıfırlamak için bağlantıyı gizli tarayıcı penceresinde açın.')}</p>
        <LinkButton to="/">{t('Вернуться в кабинет', 'Panele dön')}</LinkButton>
      </> : <form onSubmit={submit} noValidate>
        {reset ? <>
          <p>{t('После установки нового пароля все прежние сеансы завершатся.', 'Yeni parola kaydedilince önceki oturumlar kapatılır.')}</p>
          <Field label={t('Новый пароль', 'Yeni parola')} hint={t('От 12 символов.', 'En az 12 karakter.')} required
            error={new TextEncoder().encode(password).length > 72 ? t('Сократите пароль.', 'Parolayı kısaltın.') : null}>{(id, describedBy) =>
            <Input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password"
              value={password} maxLength={72} onChange={e => setPassword(e.target.value)} />}</Field>
          <Field label={t('Повторите пароль', 'Parolayı tekrar yazın')}
            error={repeat && repeat !== password ? t('Пароли не совпадают.', 'Parolalar eşleşmiyor.') : null} required>{(id, describedBy) =>
            <Input id={id} aria-describedby={describedBy} type="password" autoComplete="new-password"
              value={repeat} maxLength={72} onChange={e => setRepeat(e.target.value)} />}</Field>
        </> : <p>{t('Подтвердите, что хотите использовать этот почтовый ящик для восстановления доступа.',
          'Bu e-posta adresini hesap kurtarma için kullanmak istediğinizi doğrulayın.')}</p>}
        {error && <Alert tone="danger">{reset ? t('Сервер не подтвердил смену. Попробуйте войти с новым паролем или запросите письмо ещё раз.',
          'Sunucu değişikliği doğrulayamadı. Yeni parolayla giriş yapmayı deneyin veya yeniden e-posta isteyin.')
          : t('Не удалось подтвердить почту. Повторите попытку.', 'E-posta doğrulanamadı. Yeniden deneyin.')}</Alert>}
        <Button type="submit" variant="primary" disabled={reset && !canReset} loading={busy} block>{confirmLabel}</Button>
      </form>}
  </RecoveryPanel>;
}

export function ManagerRecoveryDonePage() {
  const { status } = useSession();
  const { t } = useLocale();
  const kind = useLocation().state?.kind;
  const confirm = kind === 'confirm';
  const cabinet = confirm && status === 'signed-in';
  return <RecoveryPanel title={confirm ? t('Почта готова', 'E-posta doğrulandı') : kind === 'reset' ? t('Пароль сменён', 'Parola değiştirildi') : t('Вход в кабинет', 'Panele giriş')}>
    {confirm ? <p>{t('Резервный адрес подтверждён. Для входа действуют прежние логин и пароль.',
      'Kurtarma adresi doğrulandı. Mevcut kullanıcı adınız ve parolanızla giriş yapabilirsiniz.')}</p>
      : kind === 'reset' && <p>{t('Войдите с прежним логином и новым паролем.', 'Mevcut kullanıcı adınız ve yeni parolanızla giriş yapın.')}</p>}
    <LinkButton to={cabinet ? '/' : '/login'} variant="primary">
      {cabinet ? t('Вернуться в кабинет', 'Panele dön') : t('Перейти ко входу', 'Girişe git')}
    </LinkButton>
  </RecoveryPanel>;
}
