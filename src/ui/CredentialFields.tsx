import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { useLocale } from '../platform/locale';
import { Button } from './index';
import './credentials.css';

const copyLabels = {
  login: { action: ['Скопировать логин', 'Giriş numarasını kopyala'] as const, success: ['Логин скопирован', 'Giriş numarası kopyalandı'] as const },
  password: { action: ['Скопировать пароль', 'Parolayı kopyala'] as const, success: ['Пароль скопирован', 'Parola kopyalandı'] as const },
  message: { action: ['Скопировать сообщение', 'Mesajı kopyala'] as const, success: ['Сообщение скопировано', 'Mesaj kopyalandı'] as const },
};

export function CopyCredential({ kind, value, compact = false, onFailure }: {
  kind: keyof typeof copyLabels; value: string; compact?: boolean; onFailure?: () => void;
}) {
  const { t } = useLocale();
  const label = copyLabels[kind];
  const [feedback, setFeedback] = useState<{ value: string; copied: boolean }>();
  const result = feedback?.value === value ? feedback : undefined;
  const Icon = result?.copied ? Check : Copy;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ value, copied: true });
    } catch {
      setFeedback({ value, copied: false });
      onFailure?.();
    }
  }

  return <>
    {compact ? <button type="button" className="credential-icon" title={t(label.action[0], label.action[1])} aria-label={t(label.action[0], label.action[1])} onClick={() => void copy()}>
      <Icon size={17} aria-hidden />
    </button> : <Button variant={kind === 'message' ? 'primary' : 'ghost'} size={kind === 'message' ? undefined : 'sm'}
      block={kind === 'message'} onClick={() => void copy()}><Icon size={17} aria-hidden />{result?.copied ? t(label.success[0], label.success[1]) : t(label.action[0], label.action[1])}</Button>}
    <small className={result?.copied === false ? 'credential-feedback' : 'sr-only'} role="status">
      {result ? result.copied ? t(label.success[0], label.success[1]) : t('Выделите значение и скопируйте вручную.', 'Değeri seçip elle kopyalayın.') : ''}
    </small>
  </>;
}

export function CredentialFields({ login, password }: { login: string; password?: string }) {
  const { t } = useLocale();
  const [revealed, setRevealed] = useState(false);
  const PasswordIcon = revealed ? EyeOff : Eye;
  const passwordAction = revealed ? t('Скрыть пароль', 'Parolayı gizle') : t('Показать пароль', 'Parolayı göster');
  return <div className="credential-fields">
    <div className="credential-field">
      <div className="credential-value"><span>{t('Логин', 'Giriş numarası')}</span><strong>{login}</strong></div>
      <CopyCredential kind="login" value={login} compact />
    </div>
    {password && <div className="credential-field">
      <div className="credential-value"><span>{t('Пароль', 'Parola')}</span><strong className="mono">{revealed ? password : <>
        <span aria-hidden>••••••••</span><span className="sr-only">{t('Пароль скрыт', 'Parola gizli')}</span>
      </>}</strong></div>
      <button type="button" className="credential-icon" title={passwordAction} aria-label={passwordAction} onClick={() => setRevealed(!revealed)}>
        <PasswordIcon size={17} aria-hidden />
      </button>
      <CopyCredential kind="password" value={password} compact onFailure={() => setRevealed(true)} />
    </div>}
  </div>;
}
