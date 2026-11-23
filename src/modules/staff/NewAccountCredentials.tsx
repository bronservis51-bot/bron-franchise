import { useState } from 'react';
import { ArrowUpRight, CircleCheck } from 'lucide-react';
import { phoneLoginDigits } from '../../platform/login';
import { ConfirmDialog } from '../../ui';
import { CopyCredential, CredentialFields } from '../../ui/CredentialFields';
import { accessMessage, accessMessengerLinks } from './accessMessage';

export function NewAccountCredentials({ title, phone, password, onClose }: {
  title: string; phone: string; password: string; onClose: () => void;
}) {
  const site = `${location.origin}${location.pathname}`;
  const message = accessMessage(site, password);
  const digits = phoneLoginDigits(phone);
  const [preview, setPreview] = useState(false);

  return <ConfirmDialog open title={title} className="account-issued" cancelLabel="Готово" onClose={onClose}>
    <div className="account-issued-content">
      <p className="account-issued-hint"><CircleCheck size={18} aria-hidden />Передайте данные для входа в личном чате.</p>
      <CredentialFields login={phone} password={password} />
      <div className="account-share">
        <CopyCredential kind="message" value={message} onFailure={() => setPreview(true)} />
        {digits && <div className="account-messengers" role="group" aria-label="Открыть мессенджер">
          {accessMessengerLinks(digits).map(({ name, href }) => <a key={name} className="btn" href={href}
            target="_blank" rel="noopener noreferrer">{name}<ArrowUpRight size={13} aria-hidden /></a>)}
        </div>}
        <button type="button" className="account-preview" aria-expanded={preview} onClick={() => setPreview(!preview)}>
          {preview ? 'Скрыть сообщение' : 'Посмотреть сообщение'}
        </button>
        {preview && <pre className="access-message">{message}</pre>}
      </div>
    </div>
  </ConfirmDialog>;
}
