import { useState } from 'react';
import { Button } from './index';

const copyLabels = {
  login: { action: 'Скопировать логин', success: 'Логин скопирован' },
  password: { action: 'Скопировать пароль', success: 'Пароль скопирован' },
  message: { action: 'Скопировать сообщение', success: 'Сообщение скопировано' },
};

export function CopyCredential({ kind, value }: { kind: keyof typeof copyLabels; value: string }) {
  const label = copyLabels[kind];
  const [feedback, setFeedback] = useState<{ value: string; message: string }>();

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback({ value, message: label.success });
    } catch {
      setFeedback({ value, message: 'Выделите значение и скопируйте вручную.' });
    }
  }

  return <div className="credential-copy">
    <Button size="sm" variant="ghost" onClick={() => void copy()}>{label.action}</Button>
    <small className="faint" role="status">{feedback?.value === value ? feedback?.message : ''}</small>
  </div>;
}

export function CredentialFields({ login, password }: { login: string; password?: string }) {
  return <div className="login-card-data">
    <div className="credential-field">
      <div><span className="faint">Логин</span><strong>{login}</strong></div>
      <CopyCredential kind="login" value={login} />
    </div>
    {password && <div className="credential-field">
      <div><span className="faint">Пароль</span><strong className="mono">{password}</strong></div>
      <CopyCredential kind="password" value={password} />
    </div>}
  </div>;
}
