import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { LogoFull } from '../ui/brand';
import { useSession } from '../platform/session';
import { Button, Checkbox, Field, Input } from '../ui';
import { loginErrorText, useServerCheck } from './loginDiagnostics';
import { AppUpdateBanner } from './AppUpdateBanner';
import { loginEmail, stagingLoginEmail } from '../platform/login';
import { managerRecoveryAvailable } from '../platform/managerRecovery';
import { InstallButton } from './InstallApp';
import { config } from '../platform/config';
import { connectionSummary } from '../platform/connection';
import { useLocale } from '../platform/locale';
import { LanguageSelect } from '../ui/LanguageSelect';

export function LoginPage() {
  const { status, signIn } = useSession();
  const { language, locale, t } = useLocale();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  const [server, recheck] = useServerCheck();

  if (status === 'signed-in') return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(config.appEnv === 'staging' ? stagingLoginEmail(email) : loginEmail(email), password, remember);
      navigate('/', { replace: true });
    } catch (cause) {
      setError({ cause });
      recheck();
    } finally {
      setBusy(false);
    }
  }

  const version = new Date(import.meta.env.VITE_BUILD_TIME ?? Date.now()).toLocaleString(locale,
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  return (
    <main className="login-wrap login-entry">
      <div className="login-card">
        <header className="login-heading">
          <LogoFull height={38} />
          <LanguageSelect automatic />
        </header>
        <AppUpdateBanner />
        {config.appEnv === 'staging' && <p className="alert tone-info">
          {t('Тестовая версия · учебные профили и данные', 'Test sürümü · örnek hesaplar ve veriler')}
        </p>}
        <ServerStatus s={server} onRetry={recheck} />
        <section className="card" aria-labelledby="login-heading">
          <div className="card-body">
            <h1 id="login-heading">{t('Вход', 'Giriş')}</h1>
            <form onSubmit={submit} noValidate>
              <Field label={t('Логин', 'Kullanıcı adı')} required>
                {(id) => <Input id={id} type="text" autoCapitalize="none" spellCheck={false} autoComplete="username"
                  value={email} onChange={(e) => setEmail(e.target.value)} required />}
              </Field>
              <Field label={t('Пароль', 'Parola')} required>
                {(id) => <div className="password-field">
                  <Input id={id} type={showPassword ? 'text' : 'password'} autoComplete="current-password" autoCapitalize="none"
                    autoCorrect="off" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <button type="button" className="icon-btn password-toggle"
                    aria-label={showPassword ? t('Скрыть пароль', 'Parolayı gizle') : t('Показать пароль', 'Parolayı göster')}
                    aria-controls={id} aria-pressed={showPassword} onPointerDown={(e) => e.preventDefault()}
                    onClick={() => setShowPassword((visible) => !visible)}>
                    {showPassword ? <EyeOff size={20} aria-hidden /> : <Eye size={20} aria-hidden />}
                  </button>
                </div>}
              </Field>
              <Checkbox label={t('Запомнить это устройство', 'Bu cihazı hatırla')} checked={remember} onChange={setRemember} />
              {error && <ErrorBox e={loginErrorText(error.cause, language)} />}
              <div className="login-submit">
                <Button type="submit" variant="primary" block loading={busy} disabled={!email || !password}>{t('Войти', 'Giriş yap')}</Button>
              </div>
              <ForgotPassword login={email} />
            </form>
          </div>
        </section>
        <footer className="login-footer">
          <InstallButton compact />
          <a href={`${import.meta.env.BASE_URL}help.html${language === 'tr' ? '#tr' : ''}`} target="_blank" rel="noopener noreferrer">
            {t('Помощь при сбое', 'Bağlantı yardımı')}
          </a>
          <span className="faint login-version">{t('Версия от', 'Sürüm')} {version}</span>
        </footer>
      </div>
    </main>
  );
}

function ForgotPassword({ login }: { login: string }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const recovery = useQuery({ queryKey: ['manager-recovery-available'], queryFn: managerRecoveryAvailable,
    enabled: open && managerOpen, retry: false });
  return <details className="forgot" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{t('Забыли пароль?', 'Parolanızı mı unuttunuz?')}</summary>
    <p>{t('Сотрудники обращаются к своему руководителю, франчайзи — к менеджеру сети.',
      'Çalışanlar kendi yöneticileriyle, franchise işletmecileri ise franchise yöneticisiyle iletişime geçebilir.')}</p>
    <details className="manager-help" onToggle={e => setManagerOpen(e.currentTarget.open)}>
      <summary>{t('Для менеджеров сети', 'Franchise yöneticileri için')}</summary>
      {open && managerOpen && <>
        {recovery.data && <Link to="/recover" state={{ login }}>{t('Восстановить доступ', 'Erişimi geri al')}</Link>}
        <p>{t('За помощью можно обратиться к администратору системы.', 'Yardım için sistem yöneticisine başvurabilirsiniz.')}</p>
      </>}
    </details>
  </details>;
}

function ErrorBox({ e }: { e: { text: string; detail: string } }) {
  const { t } = useLocale();
  return (
    <div className="alert tone-danger login-error" role="alert">
      <div className="alert-body">{e.text}{e.detail && <div className="faint">{t('Код ошибки', 'Hata kodu')} {e.detail}</div>}</div>
    </div>
  );
}

function ServerStatus({ s, onRetry }: { s: ReturnType<typeof useServerCheck>[0]; onRetry: () => void }) {
  const { locale, t } = useLocale();
  if (s.state === 'checking') return null;
  if (s.state === 'ok') {
    if (s.ms <= 4000) return null;
    const seconds = (s.ms / 1000).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return <p className="faint login-server">{t(`Сервер ответил за ${seconds} с. Вход может занять больше времени.`,
      `Sunucu ${seconds} saniyede yanıt verdi. Giriş daha uzun sürebilir.`)}</p>;
  }
  return (
    <div className="alert tone-warning login-server" role="status">
      <div className="alert-body">
        <strong>{connectionSummary(s.connection, t)}</strong>
        <div className="faint">{t('Код проверки', 'Kontrol kodu')} {s.connection.auth.code} / {s.connection.data.code}</div>
      </div>
      <button type="button" className="btn btn-sm" onClick={onRetry}>{t('Проверить снова', 'Yeniden kontrol et')}</button>
    </div>
  );
}

export function SetupPage() {
  return (
    <main className="login-wrap">
      <div className="login-card card">
        <div className="card-body">
          <h1 style={{ marginBottom: 12 }}>Сборка не подключена к базе</h1>
          <p className="muted">Сообщите техническому специалисту, что в сборке отсутствуют настройки подключения.</p>
          <a href={`${import.meta.env.BASE_URL}help.html`}>Помощь при сбое</a>
        </div>
      </div>
    </main>
  );
}
