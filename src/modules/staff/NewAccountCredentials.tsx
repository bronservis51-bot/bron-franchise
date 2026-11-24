import { useState } from 'react';
import { ArrowUpRight, CircleCheck } from 'lucide-react';
import { useLocale } from '../../platform/locale';
import { phoneLoginDigits } from '../../platform/login';
import { ConfirmDialog } from '../../ui';
import { CopyCredential, CredentialFields } from '../../ui/CredentialFields';
import { accessMessage, accessMessengerLinks } from './accessMessage';

export function NewAccountCredentials({ title, phone, password, onClose }: {
  title: string; phone: string; password: string; onClose: () => void;
}) {
  const { t, language } = useLocale();
  const site = `${location.origin}${location.pathname}`;
  const message = accessMessage(site, password, language);
  const digits = phoneLoginDigits(phone);
  const [preview, setPreview] = useState(false);

  return <ConfirmDialog open title={title} className="account-issued" cancelLabel={t('Готово', 'Bitti')} onClose={onClose}>
    <div className="account-issued-content">
      <p className="account-issued-hint"><CircleCheck size={18} aria-hidden />{t('Передайте данные для входа в личном чате.', 'Giriş bilgilerini özel mesajla iletin.')}</p>
      <CredentialFields login={phone} password={password} />
      <div className="account-share">
        <CopyCredential kind="message" value={message} onFailure={() => setPreview(true)} />
        {digits && <div className="account-messengers" role="group" aria-label={t('Открыть мессенджер', 'Mesajlaşma uygulamasını aç')}>
          {accessMessengerLinks(digits).map(({ name, href }) => <a key={name} className="btn" href={href}
            target="_blank" rel="noopener noreferrer">{name}<ArrowUpRight size={13} aria-hidden /></a>)}
        </div>}
        <button type="button" className="account-preview" aria-expanded={preview} onClick={() => setPreview(!preview)}>
          {preview ? t('Скрыть сообщение', 'Mesajı gizle') : t('Посмотреть сообщение', 'Mesajı görüntüle')}
        </button>
        {preview && <pre className="access-message">{message}</pre>}
      </div>
    </div>
  </ConfirmDialog>;
}
