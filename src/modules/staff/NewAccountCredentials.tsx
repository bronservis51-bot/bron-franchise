import { useId, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { installationUrl } from '../../platform/install';
import { useLocale } from '../../platform/locale';
import { phoneLoginDigits } from '../../platform/login';
import { ConfirmDialog } from '../../ui';
import { CopyCredential, CredentialFields } from '../../ui/CredentialFields';
import { accessMessage, accessMessengerLinks } from './accessMessage';

export function NewAccountCredentials({ title, phone, password, onClose }: {
  title: string; phone: string; password: string; onClose: () => void;
}) {
  const { t, language } = useLocale();
  const site = installationUrl(location.origin, import.meta.env.BASE_URL);
  const message = accessMessage(site, password, language);
  const digits = phoneLoginDigits(phone);
  const sendHint = useId();
  const maxHint = useId();
  const [preview, setPreview] = useState(false);

  return <ConfirmDialog open title={title} className="account-issued" cancelLabel={t('Готово', 'Bitti')} onClose={onClose}>
    <div className="account-issued-content">
      <div className="account-share">
        <CopyCredential kind="message" value={message} onFailure={() => setPreview(true)} />
        <p className="account-issued-hint" id={sendHint}>
          {t('Откройте мессенджер, вставьте сообщение в личный чат получателя и отправьте.', 'Mesajlaşma uygulamasını açın, mesajı alıcının özel sohbetine yapıştırıp gönderin.')}
          {digits && <> <span id={maxHint}>{t('В MAX сначала выберите получателя.', 'MAX’ta önce alıcıyı seçin.')}</span></>}
        </p>
        <button type="button" className="account-preview" aria-expanded={preview} onClick={() => setPreview(!preview)}>
          {preview ? t('Скрыть сообщение', 'Mesajı gizle') : t('Посмотреть сообщение', 'Mesajı görüntüle')}
        </button>
        {preview && <pre className="access-message">{message}</pre>}
        {digits && <div className="account-messengers" role="group" aria-label={t('Мессенджеры', 'Mesajlaşma uygulamaları')} aria-describedby={sendHint}>
          {accessMessengerLinks(digits).map(({ name, href }) => <a key={name} className="btn" href={href}
            aria-describedby={name === 'MAX' ? maxHint : undefined} target="_blank" rel="noopener noreferrer">
            {t(`Открыть ${name}`, `${name} uygulamasını aç`)}<ArrowUpRight size={13} aria-hidden />
          </a>)}
        </div>}
      </div>
      <CredentialFields login={phone} password={password} />
      <p className="account-issued-hint">{t('Пароль можно посмотреть до закрытия окна.', 'Parola pencere kapanana kadar görüntülenebilir.')}</p>
    </div>
  </ConfirmDialog>;
}
