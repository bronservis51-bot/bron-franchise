import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { Button } from './index';
import './credentials.css';

const copyLabels = {
  login: { action: 'Скопировать логин', success: 'Логин скопирован' },
  password: { action: 'Скопировать пароль', success: 'Пароль скопирован' },
  message: { action: 'Скопировать сообщение', success: 'Сообщение скопировано' },
};

export function CopyCredential({ kind, value, compact = false, onFailure }: {
  kind: keyof typeof copyLabels; value: string; compact?: boolean; onFailure?: () => void;
}) {
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
    {compact ? <button type="button" className="credential-icon" title={label.action} aria-label={label.action} onClick={() => void copy()}>
      <Icon size={17} aria-hidden />
    </button> : <Button variant={kind === 'message' ? 'primary' : 'ghost'} size={kind === 'message' ? undefined : 'sm'}
      block={kind === 'message'} onClick={() => void copy()}><Icon size={17} aria-hidden />{result?.copied ? label.success : label.action}</Button>}
    <small className={result?.copied === false ? 'credential-feedback' : 'sr-only'} role="status">
      {result ? result.copied ? label.success : 'Выделите значение и скопируйте вручную.' : ''}
    </small>
  </>;
}

export function CredentialFields({ login, password }: { login: string; password?: string }) {
  const [revealed, setRevealed] = useState(false);
  const PasswordIcon = revealed ? EyeOff : Eye;
  const passwordAction = revealed ? 'Скрыть пароль' : 'Показать пароль';
  return <div className="credential-fields">
    <div className="credential-field">
      <div className="credential-value"><span>Логин</span><strong>{login}</strong></div>
      <CopyCredential kind="login" value={login} compact />
    </div>
    {password && <div className="credential-field">
      <div className="credential-value"><span>Пароль</span><strong className="mono">{revealed ? password : <>
        <span aria-hidden>••••••••</span><span className="sr-only">Пароль скрыт</span>
      </>}</strong></div>
      <button type="button" className="credential-icon" title={passwordAction} aria-label={passwordAction} onClick={() => setRevealed(!revealed)}>
        <PasswordIcon size={17} aria-hidden />
      </button>
      <CopyCredential kind="password" value={password} compact onFailure={() => setRevealed(true)} />
    </div>}
  </div>;
}
